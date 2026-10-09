import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createAgenticAskV1 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { StructuredGenerationInput, StructuredGenerationPort } from '../../src/answer-composition/structured-generation-v1.js';
import type { EvidenceDeskItemV1, EvidenceDeskPortV1, EvidenceDeskResultV1 } from '../../src/shared/evidence-desk-v1.js';
import { withCoreRuntimeDiagnosticsV1, type CoreRuntimeDiagnosticObservationV1 } from '../../src/shared/core-runtime-observation-v1.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function item(id: string, text = `Evidence ${id}.`): EvidenceDeskItemV1 {
  return {
    id: `desk_${id}`,
    citation: { kind: 'approved_record', atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: 'organization-member-readable-person-v2' },
    kind: 'decision', text, label: id, visibility: 'team', receipt_sha256: canonicalSha256({ receipt: id }),
  };
}
const result = (items: readonly EvidenceDeskItemV1[]): EvidenceDeskResultV1 => ({ items, truncated: false, receipt_digests: [] });

describe('agentic Ask concurrent reads', () => {
  it('starts distinct searches together, deduplicates a same-round repeat, and admits results in plan order', async () => {
    const alpha = deferred<EvidenceDeskResultV1>();
    const beta = deferred<EvidenceDeskResultV1>();
    const bothEntered = deferred<void>();
    const entered: string[] = [];
    let clock = 0;
    const observations: CoreRuntimeDiagnosticObservationV1[] = [];
    const search = vi.fn((input: { query?: string }) => {
      entered.push(input.query!);
      if (entered.length === 2) bothEntered.resolve();
      return input.query === 'alpha' ? alpha.promise : beta.promise;
    });
    const desk: EvidenceDeskPortV1 = {
      scope: { kind: 'global' }, live_sources: [], search: search as never,
      open: vi.fn(), list: vi.fn(), revalidate: vi.fn(async () => ({ checked_at: '2026-10-05T00:00:00.000Z' })),
    };
    const inputs: StructuredGenerationInput[] = [];
    const model: StructuredGenerationPort = {
      generate: vi.fn(async input => {
        inputs.push(input);
        if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) return { sentences: [{ text: 'Both found.', evidence: ['E1', 'E2'] }], not_found: [] };
        if (inputs.length === 1) return {
          parts: [{ question: 'Which?', needs: [{ need: 'both', status: 'open', evidence: [] }], notes: '' }],
          actions: [
            { tool: 'search', args: { query: 'alpha' } },
            { tool: 'search', args: { query: 'alpha' } },
            { tool: 'search', args: { query: 'beta' } },
          ],
        };
        return { parts: [{ question: 'Which?', needs: [{ need: 'both', status: 'found', evidence: ['E1', 'E2'] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
      }),
    };
    const pending = withCoreRuntimeDiagnosticsV1(event => { observations.push(event); }, () => createAgenticAskV1({
      desk, model, audit: { append: () => undefined },
      generation: { generation_adapter_id: 'fixture', planner_model: 'ignored', answer_model: 'fixture', timeout_ms: 30_000 },
      now_ms: () => clock,
    }).answer({ question: 'Which?' }));

    await bothEntered.promise;
    expect(entered).toEqual(['alpha', 'beta']);
    clock = 50;
    beta.resolve(result([item('beta')]));
    await Promise.resolve();
    alpha.resolve(result([item('alpha')]));
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' });

    expect(search).toHaveBeenCalledTimes(2);
    const next = JSON.parse(inputs[1]!.user_prompt) as { last_results: { query?: string; note?: string; results?: { id: string }[] }[] };
    expect(next.last_results.map(value => value.query)).toEqual(['alpha', 'alpha', 'beta']);
    expect(next.last_results[1]!.note).toContain('already searched');
    expect(next.last_results[0]!.results![0]!.id).toBe('E1');
    expect(next.last_results[2]!.results![0]!.id).toBe('E2');
    expect(observations).toContainEqual(expect.objectContaining({ kind: 'lifecycle', stage: 'research', event: 'succeeded', data: expect.objectContaining({ research: expect.objectContaining({ cost: expect.objectContaining({ desk_ms: 50 }) }) }) }));
  });

  it('cancels every in-flight independent read and writes the cancelled terminal audit', async () => {
    const bothEntered = deferred<void>();
    const signals: AbortSignal[] = [];
    const audit: unknown[] = [];
    const desk: EvidenceDeskPortV1 = {
      scope: { kind: 'global' }, live_sources: [],
      search: vi.fn((input: { signal?: AbortSignal }) => new Promise<EvidenceDeskResultV1>((_resolve, reject) => {
        signals.push(input.signal!);
        if (signals.length === 2) bothEntered.resolve();
        input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
      })) as never,
      open: vi.fn(), list: vi.fn(), revalidate: vi.fn(async () => ({ checked_at: '2026-10-05T00:00:00.000Z' })),
    };
    const model: StructuredGenerationPort = { generate: vi.fn(async () => ({
      parts: [{ question: 'Which?', needs: [{ need: 'both', status: 'open', evidence: [] }], notes: '' }],
      actions: [{ tool: 'search', args: { query: 'alpha' } }, { tool: 'search', args: { query: 'beta' } }],
    })) };
    const controller = new AbortController();
    const pending = createAgenticAskV1({ desk, model, audit: { append: entry => { audit.push(entry); } }, generation: { generation_adapter_id: 'fixture', planner_model: 'ignored', answer_model: 'fixture', timeout_ms: 30_000 } }).answer({ question: 'Which?', signal: controller.signal });
    await bothEntered.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(audit).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
  });

  it('keeps a later terminal desk failure when an earlier read loses the abort race', async () => {
    const bothEntered = deferred<void>();
    const denied = Object.assign(new Error('membership revoked'), { name: 'AuthorityOperationError' });
    let calls = 0;
    const desk: EvidenceDeskPortV1 = {
      scope: { kind: 'global' }, live_sources: [],
      search: vi.fn(() => {
        calls += 1;
        if (calls === 2) { bothEntered.resolve(); throw denied; }
        // Deliberately ignore input.signal: raceAbort must still stop this read.
        return new Promise<EvidenceDeskResultV1>(() => undefined);
      }) as never,
      open: vi.fn(), list: vi.fn(), revalidate: vi.fn(async () => ({ checked_at: '2026-10-05T00:00:00.000Z' })),
    };
    const model: StructuredGenerationPort = { generate: vi.fn(async () => ({
      parts: [{ question: 'Which?', needs: [{ need: 'both', status: 'open', evidence: [] }], notes: '' }],
      actions: [{ tool: 'search', args: { query: 'alpha' } }, { tool: 'search', args: { query: 'beta' } }],
    })) };
    const pending = createAgenticAskV1({ desk, model, audit: { append: () => undefined }, generation: { generation_adapter_id: 'fixture', planner_model: 'ignored', answer_model: 'fixture', timeout_ms: 30_000 } }).answer({ question: 'Which?' });
    await bothEntered.promise;
    await expect(pending).rejects.toBe(denied);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it('starts opens of two already discovered items together', async () => {
    const first = item('first', 'First '.repeat(800));
    const second = item('second', 'Second '.repeat(800));
    const bothOpened = deferred<void>();
    const firstOpen = deferred<EvidenceDeskResultV1>();
    const secondOpen = deferred<EvidenceDeskResultV1>();
    const opened: string[] = [];
    const desk: EvidenceDeskPortV1 = {
      scope: { kind: 'global' }, live_sources: [],
      search: vi.fn(async () => result([first, second])) as never,
      open: vi.fn((input: { item: string }) => {
        opened.push(input.item);
        if (opened.length === 2) bothOpened.resolve();
        return input.item === first.id ? firstOpen.promise : secondOpen.promise;
      }) as never,
      list: vi.fn(), revalidate: vi.fn(async () => ({ checked_at: '2026-10-05T00:00:00.000Z' })),
    };
    let steps = 0;
    const model: StructuredGenerationPort = { generate: vi.fn(async input => {
      if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) return { sentences: [{ text: 'Both found.', evidence: ['E1', 'E2'] }], not_found: [] };
      steps += 1;
      if (steps === 1) return { parts: [{ question: 'Which?', needs: [{ need: 'both', status: 'open', evidence: [] }], notes: '' }], actions: [{ tool: 'search', args: { query: 'both' } }] };
      if (steps === 2) return { parts: [{ question: 'Which?', needs: [{ need: 'both', status: 'open', evidence: [] }], notes: '' }], actions: [{ tool: 'open', args: { id: 'E1' } }, { tool: 'open', args: { id: 'E2' } }] };
      return { parts: [{ question: 'Which?', needs: [{ need: 'both', status: 'found', evidence: ['E1', 'E2'] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    }) };
    const pending = createAgenticAskV1({ desk, model, audit: { append: () => undefined }, generation: { generation_adapter_id: 'fixture', planner_model: 'ignored', answer_model: 'fixture', timeout_ms: 30_000 } }).answer({ question: 'Which?' });
    await bothOpened.promise;
    expect(opened).toEqual([first.id, second.id]);
    secondOpen.resolve(result([second]));
    firstOpen.resolve(result([first]));
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' });
  });
});
