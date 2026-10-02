import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV4, validatePersonAnswerResponseV5 } from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { createAgenticAskV2, type AgenticAskAuditEntryV1 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { StructuredGenerationInput } from '../../src/answer-composition/structured-generation-v1.js';
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from '../../src/shared/evidence-desk-v2.js';
import { captureCoreRuntimeContentV1, observeCoreRuntimeV1 } from '../../src/shared/core-runtime-observation-v1.js';

const checked = { checked_at: '2026-10-01T00:00:00.000Z' };
const body = 'ECHO-1: Launch is Tuesday.';
const citation = (id: string, text: string) => ({ kind: 'ticket' as const, tool_id: 'jira', external_scope_id: '11111111-1111-4111-8111-111111111111', ticket_id: id, permalink: `https://fixture.atlassian.net/browse/ECHO-${id === '10001' ? 1 : 2}`, text_sha256: sha256Digest(text) });
const metadata: EvidenceDeskItemV2 = Object.freeze({ id: 'request-private-ticket-1', kind: 'ticket', citation: citation('10001', ''), label: 'ECHO-1: Launch', visibility: 'only_me', attributes: { status: 'Open' }, receipt_sha256: canonicalSha256('inventory-1') });
const uncitedMetadata: EvidenceDeskItemV2 = Object.freeze({ id: 'request-private-ticket-2', kind: 'ticket', citation: citation('10002', ''), label: 'ECHO-2: Uncited ticket', visibility: 'only_me', receipt_sha256: canonicalSha256('inventory-2') });
const opened: EvidenceDeskItemV2 = Object.freeze({ ...metadata, citation: citation('10001', body), text: body, receipt_sha256: canonicalSha256('open-1') });
const need = (status: string, evidence: string[]) => [{ question: 'When is launch?', notes: '', needs: [{ need: 'ticket launch date', status, evidence }] }];
const replies = [
  { parts: need('open', []), actions: [{ tool: 'list', args: { source: 'tickets' } }] },
  { parts: need('open', []), actions: [{ tool: 'open', args: { id: 'E1' } }] },
  { parts: need('found', ['E1']), actions: [{ tool: 'finish', args: {} }] },
  { sentences: [{ text: 'The ticket reports launch is Tuesday.', evidence: ['E1'] }], not_found: [] },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: {
  readonly fence?: (number: number, released: readonly EvidenceDeskItemV2[]) => Promise<typeof checked>;
  readonly append?: (entry: AgenticAskAuditEntryV1) => Promise<unknown> | unknown;
} = {}) {
  const allReleased: EvidenceDeskItemV2[] = [];
  const fenceSnapshots: EvidenceDeskItemV2[][] = [];
  const release = (items: readonly EvidenceDeskItemV2[]): EvidenceDeskResultV2 => {
    allReleased.push(...items);
    return { items, truncated: false, receipt_digests: items.map(item => item.receipt_sha256) };
  };
  const desk: EvidenceDeskPortV2 = {
    scope: { kind: 'global' },
    search: vi.fn(async () => { throw new Error('unexpected search'); }),
    list: vi.fn(async () => release([metadata, uncitedMetadata])),
    open: vi.fn(async input => {
      expect(input.item).toBe(metadata.id);
      return release([opened]);
    }),
    revalidate: vi.fn(async () => {
      const snapshot = [...allReleased];
      fenceSnapshots.push(snapshot);
      return options.fence?.(fenceSnapshots.length, snapshot) ?? checked;
    }),
  };
  const inputs: StructuredGenerationInput[] = [];
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const index = inputs.length;
    inputs.push(input);
    captureCoreRuntimeContentV1('model_request', input.user_prompt);
    if (replies[index] === undefined) throw new Error('unexpected model retry');
    return replies[index];
  });
  const auditEntries: AgenticAskAuditEntryV1[] = [];
  const append = vi.fn(async (entry: AgenticAskAuditEntryV1) => {
    auditEntries.push(entry);
    return options.append?.(entry);
  });
  const ask = createAgenticAskV2({ desk, model: { generate }, audit: { append }, generation: { generation_adapter_id: 'fixture', planner_model: 'ignored', answer_model: 'fixture', timeout_ms: 30_000 } });
  return { desk, inputs, fenceSnapshots, auditEntries, append, generate, run: (signal?: AbortSignal) => ask.answer({ question: 'When is launch?', signal }) };
}

describe('Agentic Ask V2 ticket release', () => {
  it('lists ticket metadata, opens its request-owned item, and returns a strict V5 citation', async () => {
    const f = fixture();
    const answer = await f.run();
    expect(validatePersonAnswerResponseV5(answer)).toEqual(answer);
    expect(() => validatePersonAnswerResponseV4(answer)).toThrow();
    expect(answer).toMatchObject({ schema_version: 5, outcome: 'answered', citations: [{ citation: opened.citation, kind: 'ticket', label: opened.label, visibility: 'only_me' }] });
    expect(answer.parts[0]?.statements[0]).toMatchObject({ citation_indexes: [0], private: true });
    expect(f.desk.list).toHaveBeenCalledWith(expect.objectContaining({ source: 'ticket', limit: 50 }));
    const metadataPrompt = JSON.parse(f.inputs[1]!.user_prompt);
    expect(metadataPrompt.last_results[0].items).toEqual([expect.objectContaining({ id: 'E1', source: 'ticket', title: metadata.label }), expect.objectContaining({ id: 'E2', source: 'ticket', title: uncitedMetadata.label })]);
    for (const input of f.inputs) {
      expect(input.user_prompt).not.toContain('request-private-ticket');
      expect(input.user_prompt).not.toContain('atlassian.net');
      expect(input.user_prompt).not.toContain('10001');
      expect(input.system_prompt).toContain('"source": "tickets"');
      expect(input.system_prompt).toContain('project and mine exclude them');
    }
    expect(f.auditEntries[0]).toMatchObject({ outcome: 'answered', model_calls: 4, citation_count: 1, receipt_digests: [metadata.receipt_sha256, uncitedMetadata.receipt_sha256, opened.receipt_sha256], response_sha256: canonicalSha256(answer) });
    expect(JSON.stringify(f.auditEntries)).not.toContain(body);
    expect(JSON.stringify(f.auditEntries)).not.toContain('atlassian.net');
  });

  it('cumulatively revalidates all released inventory and text before every later model call and after the terminal audit', async () => {
    const f = fixture();
    await f.run();
    expect(f.fenceSnapshots).toHaveLength(6);
    expect(f.fenceSnapshots[0]).toEqual([]);
    expect(f.fenceSnapshots[1]).toEqual([metadata, uncitedMetadata]);
    for (const snapshot of f.fenceSnapshots.slice(2)) expect(snapshot).toEqual([metadata, uncitedMetadata, opened]);
    expect(f.desk.revalidate).toHaveBeenCalledTimes(f.inputs.length + 2);
  });

  it('suppresses runtime model content capture as soon as ticket metadata enters a prompt', async () => {
    const f = fixture();
    const capture = vi.fn();
    await observeCoreRuntimeV1('ask_request', () => f.run(), { observer: () => undefined, content_observer: capture });
    // The initial planner call contains only the user's question. All later
    // calls contain live metadata or text and keep operational timings only.
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0].content).not.toContain(metadata.label);
  });

  it('refuses a later model call after inventory-only permission revocation', async () => {
    const refusal = new Error('membership revoked');
    const f = fixture({ fence: async number => { if (number === 2) throw refusal; return checked; } });
    await expect(f.run()).rejects.toBe(refusal);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.desk.open).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });

  it('refuses publication when the terminal audit fails', async () => {
    const failure = new Error('audit unavailable');
    const f = fixture({ append: async () => { throw failure; } });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(f.fenceSnapshots).toHaveLength(5);
  });

  it('refuses publication after a disconnect during the terminal audit', async () => {
    let revoked = false;
    const refusal = new Error('connection disconnected');
    const f = fixture({ append: () => { revoked = true; }, fence: async () => { if (revoked) throw refusal; return checked; } });
    await expect(f.run()).rejects.toBe(refusal);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.auditEntries[0]).toMatchObject({ outcome: 'answered' });
    expect(f.fenceSnapshots).toHaveLength(6);
  });

  it('cancels a pending post-audit fence and ignores its late successful result', async () => {
    const entered = deferred<void>();
    const released = deferred<typeof checked>();
    const controller = new AbortController();
    const f = fixture({ fence: async number => { if (number === 6) { entered.resolve(); return released.promise; } return checked; } });
    const pending = f.run(controller.signal);
    await entered.promise;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    released.resolve(checked);
    await Promise.resolve();
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.generate).toHaveBeenCalledTimes(4);
  });
});
