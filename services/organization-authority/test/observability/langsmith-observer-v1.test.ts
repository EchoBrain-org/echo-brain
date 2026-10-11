import { describe, expect, it, vi } from 'vitest';
import { observeCoreRuntimeDiagnosticV1, observeCoreRuntimeV1, withCoreRuntimeDiagnosticToolV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { observePersonResearchV1 } from '../../src/composition/person-research-observation-v1.js';
import { createLangSmithObserverV1, type LangSmithRunV1 } from '../../src/composition/observability/langsmith-observer-v1.js';

const modelInput = { model: 'fixture-model', system_prompt: 'Use the supplied sources.', user_prompt: 'What blocks THERM?', schema: { type: 'object' }, max_output_tokens: 100, timeout_ms: 1000 };
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

describe('LangSmith projection of the shared observer', () => {
  it('exports exact parallel tool calls and model context alongside an independent private capture', async () => {
    const batches: LangSmithRunV1[][] = [];
    const send = vi.fn(async (runs: LangSmithRunV1[]) => { batches.push(runs); });
    const observer = createLangSmithObserverV1({ project: 'echo-staging', release_sha: 'a'.repeat(40), send });
    const privateEvents: unknown[] = [];
    const capture = { record: (event: unknown) => { privateEvents.push(event); }, complete() {}, fail() {} };
    await observeCoreRuntimeV1('http_request', () => observePersonResearchV1({ trigger: 'ask', run_id: 'ask-fixture', capture }, async () => {
      await observeCoreRuntimeV1('ask_planner', async () => {
        observeCoreRuntimeDiagnosticV1({ kind: 'model_request', call_id: 1, role: 'step', recovery: false, input: modelInput });
        observeCoreRuntimeDiagnosticV1({ kind: 'model_response', call_id: 1, role: 'step', value: { actions: [{ tool: 'search', args: { query: 'DVT' } }] } });
      });
      await Promise.all([1, 2].map(id => withCoreRuntimeDiagnosticToolV1({ tool_call_id: id, round: 1 }, async () => {
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: id, round: 1, tool: 'search', args: { query: id === 1 ? 'DVT' : 'BUG-412' } });
        if (id === 1) await pause();
        await observeCoreRuntimeV1('evidence_search', async () => {
          observeCoreRuntimeDiagnosticV1({ kind: 'provider_query', provider: 'jira', operation: 'search', query: id === 1 ? 'text ~ "DVT"' : 'key = "BUG-412"', max_results: 5 });
        });
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: id, round: 1, tool: 'search', result: { items: [], query: id === 1 ? 'DVT' : 'BUG-412' } });
      })));
      return 'unchanged answer';
    }), observer.scope);
    await observer.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const runs = batches[0]!;
    const root = runs.find(run => run.parent_run_id === undefined)!;
    expect(root.extra?.metadata).toMatchObject({ complete: true, release_sha: 'a'.repeat(40) });
    const searches = runs.filter(run => run.run_type === 'tool');
    expect(searches).toHaveLength(2);
    for (const search of searches) expect(search.outputs?.query).toBe(search.inputs.query);
    expect(searches.find(search => search.inputs.query === 'BUG-412')?.events).toEqual([
      expect.objectContaining({ name: 'jira.search', query: 'key = "BUG-412"' }),
    ]);
    expect(runs.find(run => run.run_type === 'llm')?.inputs).toEqual(modelInput);
    expect(privateEvents).toContainEqual(expect.objectContaining({ kind: 'tool_request', args: { query: 'BUG-412' } }));
    await observer.close();
  });

  it('selects detached research independently and exports failed calls without changing the product error', async () => {
    const send = vi.fn(async (_runs: LangSmithRunV1[]) => {});
    const observer = createLangSmithObserverV1({ project: 'echo-staging', release_sha: 'a'.repeat(40), send });
    const failure = new Error('private provider error never exported');
    await expect(observeCoreRuntimeV1('http_request', () => observePersonResearchV1({ trigger: 'approved_record', run_id: 'run-fixture', detached: true }, async () => {
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: 1, round: 1, tool: 'open', args: { id: 'E1' } });
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_error', tool_call_id: 1, round: 1, tool: 'open', error_kind: 'unavailable' });
      throw failure;
    }), observer.scope)).rejects.toBe(failure);
    await observer.flush();
    const runs = send.mock.calls[0]![0];
    expect(runs.find(run => run.run_type === 'tool')?.error).toBe('unavailable');
    expect(JSON.stringify(runs)).not.toContain(failure.message);
    expect(observer.status().exported).toBe(1);
    await observer.close();
  });

  it('reports export failure without blocking or failing the research result', async () => {
    let rejectSend!: (error: Error) => void;
    const send = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const observer = createLangSmithObserverV1({ project: 'echo-staging', release_sha: 'a'.repeat(40), send });
    await expect(observeCoreRuntimeV1('research_run', async () => 42, observer.scope)).resolves.toBe(42);
    await pause();
    rejectSend(new Error('private transport error'));
    await observer.flush();
    expect(observer.status()).toMatchObject({ failed: 1, pending: 0 });
    await observer.close();
  });

  it('bounds active runs and upload backlog and never captures unrelated operations', async () => {
    let finishWork!: () => void;
    let finishUpload!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finishUpload = resolve; }));
    const observer = createLangSmithObserverV1({ project: 'fixture', release_sha: 'a'.repeat(40), send, max_active: 1, max_pending: 1 });
    const first = observeCoreRuntimeV1('research_run', () => new Promise<void>(resolve => { finishWork = resolve; }), observer.scope);
    await observeCoreRuntimeV1('research_run', async () => 42, observer.scope);
    expect(observer.status()).toMatchObject({ active: 1, dropped: 1 });
    finishWork(); await first; await pause();
    await observeCoreRuntimeV1('research_run', async () => 42, observer.scope);
    await observeCoreRuntimeV1('worker_request', async () => {
      observeCoreRuntimeDiagnosticV1({ kind: 'model_request', call_id: 1, role: 'extraction', recovery: false, input: modelInput });
    }, observer.scope);
    expect(observer.status()).toMatchObject({ active: 0, dropped: 2, pending: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    finishUpload(); await observer.close();
  });

  it('marks an exact prefix incomplete when payload capture fills or a request never receives a result', async () => {
    const send = vi.fn(async (_runs: LangSmithRunV1[]) => {});
    const observer = createLangSmithObserverV1({ project: 'fixture', release_sha: 'a'.repeat(40), send });
    await observeCoreRuntimeV1('research_run', async () => {
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: 1, round: 1, tool: 'open', args: { id: 'E1' } });
      for (let index = 0; index < 512; index++) observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'research', event: 'started' });
    }, observer.scope);
    await observer.flush();
    const runs = send.mock.calls[0]![0];
    expect(runs[0]!.extra.metadata).toMatchObject({ complete: false, dropped_events: 1 });
    expect(runs[1]!.extra.metadata.incomplete).toBe(true);
    expect(observer.status().incomplete).toBe(1);
    await observer.close();
  });

  it('lets an admitted run finish after selection expires and stops capturing later runs', async () => {
    let now = Date.now();
    const send = vi.fn(async (_runs: LangSmithRunV1[]) => {});
    const observer = createLangSmithObserverV1({ project: 'fixture', release_sha: 'a'.repeat(40), send, now: () => now, expires_at: now + 100 });
    await observeCoreRuntimeV1('research_run', async () => {
      now += 101;
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: 1, round: 1, tool: 'finish', args: {} });
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: 1, round: 1, tool: 'finish', result: { accepted: true } });
    }, observer.scope);
    await observeCoreRuntimeV1('research_run', async () => 42, observer.scope);
    await observer.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0][0]!.extra.metadata.complete).toBe(true);
    await observer.close();
  });

  it('expires interrupted collection and bounds shutdown even when the uploader never settles', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async (_runs: LangSmithRunV1[], _signal: AbortSignal) => new Promise<void>(() => {}));
      const observer = createLangSmithObserverV1({ project: 'fixture', release_sha: 'a'.repeat(40), send, max_age_ms: 30_000 });
      let finish!: () => void;
      const work = observeCoreRuntimeV1('research_run', () => new Promise<void>(resolve => { finish = resolve; }), observer.scope);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send.mock.calls[0]![0][0]!.extra.metadata).toMatchObject({ complete: false, collection_interrupted: true });
      const closing = observer.close();
      await vi.advanceTimersByTimeAsync(5000);
      await closing;
      expect(send.mock.calls[0]![1].aborted).toBe(true);
      expect(observer.status()).toMatchObject({ active: 0, pending: 0, failed: 1, incomplete: 1 });
      finish(); await work;
      expect(send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
