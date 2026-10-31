import { describe, expect, it, vi } from 'vitest';
import {
  annotateCoreRuntimeV1, coreRuntimeDiagnosticErrorKindV1, coreRuntimeIdentityV1, observeCoreModelCorrectionV1, observeCoreRuntimeDiagnosticV1, observeCoreRuntimeRootV1,
  observeCoreRuntimeSyncV1, observeCoreRuntimeV1, withCoreRuntimeDiagnosticToolV1, type CoreRuntimeDiagnosticEventV1, type CoreRuntimePhaseV1,
} from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { observePersonResearchV1 } from '../../src/composition/person-research-observation-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../../src/composition/person-record-search-route.js';
import { createLangSmithObserverV1, type LangSmithRunV1 } from '../../src/composition/observability/langsmith-observer-v1.js';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { createAgenticAskV5 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { EvidenceDeskItemV1, EvidenceDeskPortV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import { createOpenRouterStructuredGenerationAdapter } from '../../../../providers/openrouter/src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js';

const modelInput = { model: 'fixture-model', system_prompt: 'Use the supplied sources.', user_prompt: 'What blocks THERM?', schema: { type: 'object' }, max_output_tokens: 100, timeout_ms: 1000 };
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
type Stage = Extract<CoreRuntimeDiagnosticEventV1, { readonly kind: 'lifecycle' }>['stage'];
/** A stage as the research lifecycle runs one: its own runtime span, with its started and succeeded or failed events inside. */
async function stage<T>(name: Stage, phase: CoreRuntimePhaseV1, data: Readonly<Record<string, unknown>>, operation: () => Promise<T>, done: (value: T) => Readonly<Record<string, unknown>> = () => ({})): Promise<T> {
  return observeCoreRuntimeV1(phase, async () => {
    observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: name, event: 'started', data });
    try {
      const value = await operation();
      observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: name, event: 'succeeded', data: done(value) });
      return value;
    } catch (error) {
      observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: name, event: 'failed', error_kind: coreRuntimeDiagnosticErrorKindV1(error) });
      throw error;
    }
  });
}
/** One detached research run exported through a fresh observer: its runs, root first. */
async function exported(operation: () => Promise<unknown>): Promise<LangSmithRunV1[]> {
  const send = vi.fn(async (_runs: LangSmithRunV1[]) => {});
  const observer = createLangSmithObserverV1({ project: 'fixture', release_sha: 'a'.repeat(40), send });
  await observeCoreRuntimeV1('http_request', () => observePersonResearchV1({ trigger: 'approved_record', run_id: 'run-fixture', detached: true }, operation), observer.scope).catch(() => undefined);
  await observer.flush(); await observer.close();
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0]![0];
}

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
        // The research loop's compact read result, as the next step's last_results shows it: ids only, details live in seen.
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: id, round: 1, tool: 'search', result: { tool: 'search', args: { query: id === 1 ? 'DVT' : 'BUG-412' }, results: id === 1 ? ['E1', 'E2'] : [] } });
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
    // A tool run's outputs are exactly what the planner saw of that read, and nothing the next step's seen holds.
    for (const search of searches) expect(search.outputs).toEqual({ tool: 'search', args: search.inputs, results: search.inputs.query === 'DVT' ? ['E1', 'E2'] : [] });
    // LangSmith keeps an event's name, time and kwargs only: the payload is under kwargs.
    expect(searches.find(search => search.inputs.query === 'BUG-412')?.events).toEqual([
      { name: 'jira.search', time: expect.any(String), kwargs: { query: 'key = "BUG-412"', max_results: 5, echo_span_id: expect.any(String) } },
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

  it('exports stages, live-source binding and per-source access checks as nested runs, with each model call\'s provider leg', async () => {
    const fence = (data: Readonly<Record<string, unknown>>, failure?: Error) => stage('revalidation', 'research_revalidation', data, async () => {
      await observeCoreRuntimeV1('evidence_revalidate', async () => undefined);
      await observeCoreRuntimeV1('evidence_revalidate', async () => { annotateCoreRuntimeV1({ evidence_source: 'ticket' }); if (failure !== undefined) throw failure; });
      return { checked_at: '2026-10-16T21:16:42.000Z' };
    }, value => value);
    const runs = await exported(async () => {
      await observeCoreRuntimeV1('evidence_connection', async () => { annotateCoreRuntimeV1({ evidence_source: 'ticket', result: 'verified' }); });
      await stage('starting_read', 'research_starting_read', { index: 1 }, async () => undefined);
      await stage('research', 'research_loop', {}, async () => {
        await fence({ purpose: 'model', role: 'step', next_call_id: 1 });
        await observeCoreRuntimeV1('ask_planner', async () => {
          observeCoreRuntimeDiagnosticV1({ kind: 'model_request', call_id: 1, role: 'step', recovery: false, input: modelInput });
          await pause();
          await observeCoreRuntimeV1('model_call', async () => {
            annotateCoreRuntimeV1({ counts: { provider_latency_ms: 812, http_status: 200 }, provider_request: coreRuntimeIdentityV1('provider_request', 'gen-1') });
          });
          // The serving host and generation id the model gate copies from the adapter's result onto the call's terminal event.
          observeCoreRuntimeDiagnosticV1({ kind: 'model_response', call_id: 1, role: 'step', value: { actions: [] }, finish_reason: 'stop',
            upstream_provider: 'DeepInfra', generation_id: 'gen-1760650000-AbCdEfGh12345678' });
        });
        await withCoreRuntimeDiagnosticToolV1({ tool_call_id: 1, round: 1 }, async () => {
          observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: 1, round: 1, tool: 'search', args: { query: 'DVT' } });
          observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: 1, round: 1, tool: 'search', result: { tool: 'search', args: { query: 'DVT' }, results: [] } });
        });
      });
      await stage('release', 'research_release', { outcome: 'answered' }, () => fence({ purpose: 'before_audit' }, new AuthorityOperationError('unavailable', 'private Jira outage')));
    });
    const byId = new Map(runs.map(run => [run.id, run]));
    const named = (name: string) => runs.filter(run => run.name === name);
    const parentOf = (run: LangSmithRunV1) => byId.get(run.parent_run_id!)!;
    const [root] = runs;
    expect(root!.extra.metadata).toMatchObject({ complete: true, resource_scope: 'process', result: 'unavailable' });
    expect(named('bind.ticket')).toEqual([expect.objectContaining({ parent_run_id: root!.id, outputs: { result: 'verified' }, end_time: expect.any(String) })]);
    expect(named('starting_read')).toEqual([expect.objectContaining({ parent_run_id: root!.id, inputs: { index: 1 }, end_time: expect.any(String) })]);
    const [research] = named('research');
    const [checked, failed] = named('access_check');
    // An access check is a run of its own, inside the stage that asked for it, and so is each source it checked.
    expect(checked).toMatchObject({ parent_run_id: research!.id, inputs: { purpose: 'model', role: 'step', next_call_id: 1 }, outputs: { checked_at: '2026-10-16T21:16:42.000Z' } });
    expect(named('access_check.echo').map(run => parentOf(run).id)).toEqual([checked!.id, failed!.id]);
    expect(named('access_check.ticket').map(run => [parentOf(run).id, run.error])).toEqual([[checked!.id, undefined], [failed!.id, 'unavailable']]);
    const [model] = named('model.step');
    expect(model!.parent_run_id).toBe(research!.id);
    expect(model!.extra.metadata).toMatchObject({ timeout_ms: 1000, provider_latency_ms: 812, http_status: 200, provider_result: null,
      provider_request: coreRuntimeIdentityV1('provider_request', 'gen-1'), upstream_provider: 'DeepInfra', generation_id: 'gen-1760650000-AbCdEfGh12345678', queue_ms: expect.any(Number) });
    expect(named('search')[0]!.parent_run_id).toBe(research!.id);
    // A failed check fails its run, under the release that asked for it, with the finite error kind only.
    expect(failed).toMatchObject({ parent_run_id: named('release')[0]!.id, inputs: { purpose: 'before_audit' }, error: 'unavailable' });
    expect(named('release')[0]).toMatchObject({ parent_run_id: root!.id, error: 'unavailable' });
    expect(root!.events).toContainEqual({ name: 'revalidation.failed', time: expect.any(String), kwargs: { error_kind: 'unavailable' } });
    // A stage's data is its run's inputs and outputs; an event of no stage run keeps its data under kwargs.
    expect(root!.events).toContainEqual({ name: 'starting_read.started', time: expect.any(String) });
    expect(root!.events).toContainEqual({ name: 'trigger.started', time: expect.any(String), kwargs: { data: { trigger: 'approved_record', run_id: 'run-fixture' } } });
    // Every child sorts under its parent, nothing is left open, and no model or tool call is exported twice.
    for (const run of runs.slice(1)) expect(run.dotted_order.startsWith(`${parentOf(run).dotted_order}.`)).toBe(true);
    expect(runs.every(run => run.end_time !== undefined && run.extra.metadata.incomplete === undefined)).toBe(true);
    expect([runs.filter(run => run.run_type === 'llm').length, runs.filter(run => run.run_type === 'tool').length]).toEqual([1, 1]);
    expect(JSON.stringify(runs)).not.toContain('private Jira outage');
  });

  it('names a model timeout and a run held by index lag for what they are', async () => {
    const timeout = Object.assign(new Error('private provider text'), { diagnostic: { failure_class: 'adapter_timeout', http_status: null, finish_reason: null } });
    const runs = await exported(async () => {
      await observeCoreRuntimeV1('ask_planner', async () => {
        observeCoreRuntimeDiagnosticV1({ kind: 'model_request', call_id: 1, role: 'step', recovery: false, input: { ...modelInput, timeout_ms: 7540 } });
        try { await observeCoreRuntimeV1('model_call', async () => { throw timeout; }); }
        catch (error) { observeCoreRuntimeDiagnosticV1({ kind: 'model_error', call_id: 1, role: 'step', error_kind: coreRuntimeDiagnosticErrorKindV1(error), upstream_provider: 'Friendli', generation_id: 'gen-1760650001-ZyXwVuTs98765432' }); }
      });
      throw new PersonRecordSearchIndexLagV1();
    });
    const [root, model] = runs;
    expect(model).toMatchObject({ name: 'model.step', error: 'adapter_timeout', extra: { metadata: { timeout_ms: 7540, error_kind: 'adapter_timeout', provider_result: 'timeout',
      upstream_provider: 'Friendli', generation_id: 'gen-1760650001-ZyXwVuTs98765432' } } });
    expect(root).toMatchObject({ error: 'index_lag', extra: { metadata: { result: 'index_lag' } } });
    expect(root!.events).toContainEqual({ name: 'application.failed', time: expect.any(String), kwargs: { error_kind: 'index_lag' } });
    expect(JSON.stringify(runs)).not.toContain('private provider text');
  });

  it('carries the serving host and generation id from the real OpenRouter adapter through the model gate onto each model run', async () => {
    const item: EvidenceDeskItemV1 = Object.freeze({ id: 'desk_launch', kind: 'decision' as const, text: 'Launch is Tuesday.', label: 'Launch decision', visibility: 'team' as const,
      citation: Object.freeze({ kind: 'approved_record' as const, atom_id: canonicalSha256({ atom: 'launch' }), record_sha256: canonicalSha256({ record: 'launch' }), policy_id: 'project-members-readable-person-v1' as const }),
      receipt_sha256: canonicalSha256({ receipt: 'launch' }) });
    const found = Object.freeze({ items: Object.freeze([item]), truncated: false, receipt_digests: Object.freeze([canonicalSha256({ receipt: 1 })]) });
    const desk: EvidenceDeskPortV1 = Object.freeze({ scope: Object.freeze({ kind: 'global' as const }), search: async () => found, open: async () => found,
      list: async () => Object.freeze({ items: Object.freeze([]), truncated: false, receipt_digests: Object.freeze([canonicalSha256({ receipt: 0 })]) }),
      revalidate: async () => Object.freeze({ checked_at: '2026-10-16T21:16:42.000Z' }) });
    const need = (status: string, evidence: readonly string[]) => [{ question: 'When is launch?', notes: '', needs: [{ need: 'launch date', status, evidence }] }];
    // Wire responses as OpenRouter sends them: a reply that is not JSON (served by Friendli), then a planner search routed by the
    // opted-in metadata, a finish from a host the adapter does not list, and the answer.
    const replies: { readonly content: string; readonly body?: Record<string, unknown>; readonly header?: string }[] = [
      { content: 'not json', body: { id: 'gen-1790820122-fbcrJhMV9hV6DelT6StD', provider: 'Friendli' } },
      { content: JSON.stringify({ parts: need('open', []), actions: [{ tool: 'search', args: { query: 'launch' } }] }), header: 'gen-1790820123-AbCdEfGhIjKlMnOpQrSt',
        body: { provider: 'Ignored', openrouter_metadata: { endpoints: { available: [{ provider: 'Mara', selected: false }, { provider: 'DeepInfra', selected: true }] } } } },
      { content: JSON.stringify({ parts: need('found', ['E1']), actions: [{ tool: 'finish', args: {} }] }), body: { id: 'gen-1790820124-UvWxYz0123456789AbCd', provider: 'Brand New Host' } },
      { content: JSON.stringify({ sentences: [{ text: 'Launch is Tuesday.', evidence: ['E1'] }], not_found: [] }), body: { id: 'not-a-generation-id', provider: 'DeepSeek' } },
    ];
    let index = 0;
    const model = createOpenRouterStructuredGenerationAdapter({ credential_ref: 'fixture', credential_resolver: () => 'fixture-credential', fetch_impl: async () => {
      const reply = replies[index++]!;
      return new Response(JSON.stringify({ ...reply.body, choices: [{ finish_reason: 'stop', message: { content: reply.content } }] }),
        { status: 200, headers: { 'content-type': 'application/json', ...(reply.header === undefined ? {} : { 'x-generation-id': reply.header }) } });
    } });
    let answer: unknown;
    const runs = await exported(async () => {
      answer = await createAgenticAskV5({ desk, model, audit: { append: () => {} }, today: () => '2026-10-16',
        generation: { generation_adapter_id: 'openrouter', planner_model: 'deepseek/deepseek-v3.2', answer_model: 'deepseek/deepseek-v3.2', timeout_ms: 30_000 } })
        .answer({ question: 'When is launch?' });
    });
    expect(answer).toMatchObject({ outcome: 'answered' });
    expect(index).toBe(4);
    const models = runs.filter(run => run.run_type === 'llm');
    expect(models.map(run => [run.name, run.error ?? null, run.extra.metadata.upstream_provider ?? null, run.extra.metadata.generation_id ?? null])).toEqual([
      // A failed call keeps the host and generation id its failure observation reported.
      ['model.step', 'adapter_json', 'Friendli', 'gen-1790820122-fbcrJhMV9hV6DelT6StD'],
      // The selected endpoint wins over the top-level name; the header id wins over the body.
      ['model.step', null, 'DeepInfra', 'gen-1790820123-AbCdEfGhIjKlMnOpQrSt'],
      // An unlisted host is recorded as "other", never as the provider's own text.
      ['model.step', null, 'other', 'gen-1790820124-UvWxYz0123456789AbCd'],
      // An id that is not a generation id is not recorded.
      ['model.answer', null, 'DeepSeek', null],
    ]);
    expect(models[0]!.extra.metadata.error_kind).toBe('adapter_json');
    expect(JSON.stringify(runs)).not.toContain('Brand New Host');
    expect(JSON.stringify(runs)).not.toContain('fixture-credential');
  });

  it('sums the corrections of model output every span of a run made onto its root, by name only', async () => {
    const runs = await exported(async () => {
      observeCoreModelCorrectionV1('research_no_progress_stop');
      await stage('research', 'research_loop', {}, async () => {
        observeCoreModelCorrectionV1('step_title_as_id', 2);
        await observeCoreRuntimeV1('ask_planner', () => observeCoreRuntimeV1('model_call', async () => {
          observeCoreRuntimeSyncV1('model_parse', () => observeCoreModelCorrectionV1('model_json_fence_stripped'));
        }));
      });
      await stage('renderer', 'research_output', {}, async () => { observeCoreModelCorrectionV1('step_title_as_id'); observeCoreModelCorrectionV1('writer_fallback'); });
    });
    expect(runs[0]!.extra.metadata.model_corrections).toEqual({ step_title_as_id: 3, research_no_progress_stop: 1, model_json_fence_stripped: 1, writer_fallback: 1 });
    // Another operation's corrections never reach the run, and a run that made none has no field.
    const quiet = await exported(() => observeCoreRuntimeRootV1('worker_execution', async () => { observeCoreModelCorrectionV1('extraction_repeat_dropped'); }));
    expect(quiet[0]!.extra.metadata).not.toHaveProperty('model_corrections');
  });

  it('keeps at most 512 runtime spans a run, and counts the rest', async () => {
    const runs = await exported(async () => {
      for (let index = 0; index < 515; index++) await observeCoreRuntimeV1('evidence_revalidate', async () => undefined);
      // Spans of other phases are neither kept nor counted.
      await observeCoreRuntimeV1('evidence_search', async () => undefined);
    });
    expect(runs.filter(run => run.name === 'access_check.echo')).toHaveLength(512);
    expect(runs[0]!.extra.metadata).toMatchObject({ dropped_spans: 3, complete: true });
  });

  it('reports export failure without blocking or failing the research result', async () => {
    let rejectSend!: (error: Error) => void;
    const send = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const observer = createLangSmithObserverV1({ project: 'echo-staging', release_sha: 'a'.repeat(40), send });
    await expect(observeCoreRuntimeV1('research_run', async () => 42, observer.scope)).resolves.toBe(42);
    await pause();
    rejectSend(new Error('private transport error'));
    await observer.flush();
    expect(observer.status()).toMatchObject({ failed: 1, pending: 0,
      last_failure: { kind: 'unknown', http_status: null } });
    expect(JSON.stringify(observer.status())).not.toContain('private transport error');
    send.mockResolvedValueOnce(undefined);
    await observeCoreRuntimeV1('research_run', async () => 42, observer.scope);
    await observer.flush();
    expect(observer.status()).toMatchObject({ exported: 1, failed: 1,
      last_failure: { kind: 'unknown', http_status: null } });
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
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: 1, round: 1, tool: 'finish', result: { tool: 'finish' } });
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
      expect(observer.status()).toMatchObject({ active: 0, pending: 0, failed: 1, incomplete: 1,
        last_failure: { kind: 'shutdown', http_status: null } });
      finish(); await work;
      expect(send).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
