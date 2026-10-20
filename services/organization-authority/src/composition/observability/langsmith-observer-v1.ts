import { randomUUID } from 'node:crypto';
import {
  CORE_RUNTIME_MODEL_CORRECTIONS_V1,
  type CoreRuntimeDiagnosticObservationV1, type CoreRuntimeModelCorrectionV1, type CoreRuntimeObservationScopeV1, type CoreRuntimeObservationV1,
} from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { createPersonDiagnosticTraceV1, type PersonDiagnosticTraceCollectorV1 } from '../person-diagnostic-trace-v1.js';

type ExportFailureKind = 'http' | 'timeout' | 'cancelled' | 'network' | 'serialization' | 'projection' | 'shutdown' | 'unknown';
interface ExportFailure { readonly kind: ExportFailureKind; readonly http_status: number | null }

/** Only a finite category and numeric status may cross into operational telemetry. */
export class LangSmithExportErrorV1 extends Error {
  readonly failure: ExportFailure;
  constructor(kind: ExportFailureKind, httpStatus: number | null = null) {
    super('LangSmith trace export failed');
    this.failure = Object.freeze({ kind, http_status: kind === 'http' && typeof httpStatus === 'number' &&
      Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null });
  }
}

/** Provider-shaped output only at this composition boundary. No SDK in the core. */
export interface LangSmithRunV1 {
  id: string;
  name: string;
  run_type: 'chain' | 'llm' | 'tool';
  trace_id: string;
  dotted_order: string;
  parent_run_id?: string;
  session_name: string;
  start_time: string;
  end_time?: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  extra: { metadata: Record<string, unknown> };
  events?: Record<string, unknown>[];
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
/** One runtime span of a captured run, from its start and end observations. */
interface Span {
  readonly phase: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly started_at: string;
  end?: CoreRuntimeObservationV1;
}
interface Capture {
  start: CoreRuntimeObservationV1;
  collector: PersonDiagnosticTraceCollectorV1;
  spans: Map<string, Span>;
  dropped_spans: number;
  /** Corrections of model output the run's spans made, summed by name as each span ends. */
  corrections: Partial<Record<CoreRuntimeModelCorrectionV1, number>>;
}
type Recorded = CoreRuntimeDiagnosticObservationV1 & { observed_at: string; sequence: number };
// Millisecond timestamps plus the capture sequence give stable sibling ordering
// when multiple model/tool calls start in the same millisecond.
const order = (time: string, id: string, sequence = 0) => `${time.replace(/[-:.]/g, '').replace('Z', `${String(sequence).padStart(3, '0')}Z`)}${id}`;
/**
 * Runtime spans a trace shows beside its diagnostic events: a model call's
 * provider leg (on its model run), and the desk's live-source binding and
 * per-source access checks (as their own runs). Tool reads are not: their
 * tool runs already show them.
 */
const SPAN_PHASES: ReadonlySet<string> = new Set(['model_call', 'evidence_connection', 'evidence_revalidate']);
/** Runtime spans one capture keeps; more are counted, not kept. */
const MAX_SPANS = 512;
/**
 * The serving host and generation id the model gate copied onto a call's
 * terminal event from the adapter's result or failure, when it reported them.
 */
type ModelRouting = Pick<Extract<CoreRuntimeDiagnosticObservationV1, { readonly kind: 'model_response' }>, 'upstream_provider' | 'generation_id'>;
function modelRouting(event: ModelRouting): ModelRouting {
  return { ...(event.upstream_provider === undefined ? {} : { upstream_provider: event.upstream_provider }),
    ...(event.generation_id === undefined ? {} : { generation_id: event.generation_id }) };
}
/** What a model call's provider span adds to its model run: provider time and status, and how long it queued before the provider. */
function providerLeg(span: Span, run: LangSmithRunV1): Record<string, unknown> {
  const done = span.end!;
  const queued = Date.parse(span.started_at) - Date.parse(run.start_time);
  return { provider_latency_ms: done.counts.provider_latency_ms ?? null, http_status: done.counts.http_status ?? null,
    active_models: done.counts.active_models ?? null, provider: done.provider, provider_result: done.result,
    // The runtime's opaque identity of the provider's request id, as operational telemetry records it.
    provider_request: done.provider_request, ...(Number.isFinite(queued) ? { queue_ms: Math.max(0, queued) } : {}) };
}

function project(capture: Capture, end: CoreRuntimeObservationV1, projectName: string, release: string, interrupted: boolean): LangSmithRunV1[] {
  const snapshot = capture.collector.snapshot();
  const events = snapshot.events as unknown as readonly Recorded[];
  const rootId = capture.start.span_id;
  // Index lag is a wait for the search index, not the outage its `unavailable` code would say.
  const lagged = events.some(event => event.kind === 'lifecycle' && event.stage === 'application' && event.event === 'failed' && event.error_kind === 'index_lag');
  const result = lagged ? 'index_lag' : end.result;
  const corrected = CORE_RUNTIME_MODEL_CORRECTIONS_V1.filter(name => capture.corrections[name] !== undefined);
  const root: LangSmithRunV1 = {
    id: rootId, name: `ECHO ${capture.start.trigger ?? 'research'}`, run_type: 'chain', trace_id: rootId,
    dotted_order: order(capture.start.observed_at, rootId), session_name: projectName,
    start_time: capture.start.observed_at, end_time: end.observed_at, inputs: {},
    extra: { metadata: { echo_operation_id: end.operation_id, echo_span_id: rootId, release_sha: release,
      echo_run_id: end.run_id ?? null, echo_event_id: end.event_id ?? null, echo_attempt_id: end.attempt_id ?? null,
      trigger: capture.start.trigger ?? 'research', complete: snapshot.complete && !interrupted, dropped_events: snapshot.dropped_events,
      // `counts` CPU, memory and file-system figures are process-wide deltas: concurrent work shares them.
      result, research_stop_reason: end.research_stop_reason ?? null, counts: end.counts, resource_scope: 'process',
      ...(capture.dropped_spans === 0 ? {} : { dropped_spans: capture.dropped_spans }),
      // Code's corrections of model output across every span of the run, by name (RB-OPERATIONS-001).
      ...(corrected.length === 0 ? {} : { model_corrections: Object.fromEntries(corrected.map(name => [name, capture.corrections[name]])) }),
      ...(end.parent_operation_id === undefined ? {} : { parent_operation_id: end.parent_operation_id }),
    } }, events: [],
    ...(end.event === 'failed' ? { error: result ?? 'failed' } : {}),
  };
  const runs = [root];
  // Each exported stage's run by the runtime span it shows, and each span's parent: a run goes under its nearest exported ancestor.
  const bySpan = new Map<string, LangSmithRunV1>([[rootId, root]]);
  const parents = new Map<string, string | null>();
  for (const event of events) if (!parents.has(event.span_id)) parents.set(event.span_id, event.parent_span_id);
  for (const span of capture.spans.values()) if (!parents.has(span.span_id)) parents.set(span.span_id, span.parent_span_id);
  const under = (spanId: string | null): LangSmithRunV1 => {
    for (let id = spanId, hops = 0; id !== null && hops < 64; id = parents.get(id) ?? null, hops++) {
      const run = bySpan.get(id);
      if (run !== undefined) return run;
    }
    return root;
  };
  const child = (parent: LangSmithRunV1, run: Pick<LangSmithRunV1, 'name' | 'run_type' | 'start_time' | 'inputs' | 'extra'>, sequence: number): LangSmithRunV1 => {
    const id = randomUUID();
    const created: LangSmithRunV1 = { id, trace_id: rootId, parent_run_id: parent.id, dotted_order: `${parent.dotted_order}.${order(run.start_time, id, sequence)}`,
      session_name: projectName, ...run };
    runs.push(created);
    return created;
  };
  const pending = new Map<string, LangSmithRunV1>();
  const tools = new Map<number, LangSmithRunV1>();
  /** Each model call's run by the call's own span, where its provider span reports. */
  const models = new Map<string, LangSmithRunV1>();
  for (const event of events) {
    const model = event.kind === 'model_request' || event.kind === 'model_response' || event.kind === 'model_error';
    const tool = event.kind === 'tool_request' || event.kind === 'tool_response' || event.kind === 'tool_error';
    if (model || tool) {
      const key = `${event.span_id}:${model ? `model:${event.call_id}` : `tool:${event.tool_call_id}`}`;
      if (event.kind === 'model_request' || event.kind === 'tool_request') {
        if (pending.has(key)) root.extra.metadata.complete = false;
        const run = child(under(event.span_id), { name: event.kind === 'model_request' ? `model.${event.role}` : event.tool,
          run_type: model ? 'llm' : 'tool', start_time: event.observed_at, inputs: event.kind === 'model_request' ? { ...event.input } : { ...event.args },
          extra: { metadata: { echo_operation_id: event.operation_id, echo_span_id: event.span_id, echo_sequence: event.sequence,
            ...(event.kind === 'model_request' ? { call_id: event.call_id, model: event.input.model, recovery: event.recovery, timeout_ms: event.input.timeout_ms }
              : { tool_call_id: event.tool_call_id, round: event.round }),
          } },
        }, event.sequence);
        pending.set(key, run);
        if (event.kind === 'tool_request') tools.set(event.tool_call_id, run);
        else models.set(event.span_id, run);
      } else {
        const run = pending.get(key);
        if (run === undefined) { root.extra.metadata.complete = false; continue; }
        pending.delete(key); run.end_time = event.observed_at;
        if (event.kind === 'model_response') {
          run.outputs = { value: event.value };
          if (event.usage !== undefined) {
            run.extra.metadata.usage = event.usage;
            if (event.usage.input_tokens !== null) run.prompt_tokens = event.usage.input_tokens;
            if (event.usage.output_tokens !== null) run.completion_tokens = event.usage.output_tokens;
            if (event.usage.total_tokens !== null) run.total_tokens = event.usage.total_tokens;
          }
          run.extra.metadata.finish_reason = event.finish_reason ?? null;
          Object.assign(run.extra.metadata, modelRouting(event));
        } else if (event.kind === 'tool_response') run.outputs = { ...event.result };
        else {
          run.error = event.error_kind;
          if (event.kind === 'model_error') Object.assign(run.extra.metadata, { error_kind: event.error_kind }, modelRouting(event));
        }
      }
    } else if (event.kind === 'provider_query') {
      const parent = event.tool_context === undefined ? root : tools.get(event.tool_context.tool_call_id);
      if (parent === undefined) { root.extra.metadata.complete = false; continue; }
      // LangSmith keeps an event's name, time and kwargs only.
      (parent.events ??= []).push({ name: `${event.provider}.${event.operation}`, time: event.observed_at,
        kwargs: { query: event.query, max_results: event.max_results, echo_span_id: event.span_id } });
    } else if (event.kind === 'lifecycle') {
      if (event.stage === 'brief' && event.event === 'succeeded') root.inputs = { brief: event.data?.brief };
      if (event.stage === 'run' && event.event === 'succeeded') root.outputs = { ...event.data };
      // A stage that runs in its own runtime span is its own run, so the time it takes (an access check above all) is not a
      // gap. Its started and succeeded data are that run's inputs and outputs, and are not repeated on the root's event.
      const key = `${event.span_id}:stage:${event.stage}`;
      let spanned = false;
      if (event.event === 'started' && !bySpan.has(event.span_id)) {
        const run = child(under(event.parent_span_id), { name: event.stage === 'revalidation' ? 'access_check' : event.stage, run_type: 'chain',
          start_time: event.observed_at, inputs: { ...event.data },
          extra: { metadata: { echo_operation_id: event.operation_id, echo_span_id: event.span_id, echo_sequence: event.sequence, stage: event.stage } } }, event.sequence);
        bySpan.set(event.span_id, run); pending.set(key, run); spanned = true;
      } else if (event.event === 'succeeded' || event.event === 'failed') {
        const run = pending.get(key);
        if (run !== undefined) {
          pending.delete(key); run.end_time = event.observed_at; spanned = true;
          if (event.event === 'succeeded') run.outputs = { ...event.data };
          else run.error = event.error_kind ?? 'failed';
        }
      }
      // LangSmith keeps an event's name, time and kwargs only.
      const kwargs = { ...(spanned || event.data === undefined ? {} : { data: event.data }), ...(event.error_kind === undefined ? {} : { error_kind: event.error_kind }) };
      root.events!.push({ name: `${event.stage}.${event.event}`, time: event.observed_at, ...(Object.keys(kwargs).length === 0 ? {} : { kwargs }) });
    }
  }
  for (const span of capture.spans.values()) {
    const done = span.end;
    if (done === undefined) continue;
    if (span.phase === 'model_call') {
      const run = span.parent_span_id === null ? undefined : models.get(span.parent_span_id);
      // What the model event itself says wins over the runtime span's copy.
      if (run !== undefined) run.extra.metadata = { ...providerLeg(span, run), ...run.extra.metadata };
      continue;
    }
    const source = done.evidence_source ?? null;
    const run = child(under(span.parent_span_id), { name: span.phase === 'evidence_connection' ? `bind.${source ?? 'source'}` : `access_check.${source ?? 'echo'}`,
      run_type: 'chain', start_time: span.started_at, inputs: {},
      extra: { metadata: { echo_operation_id: done.operation_id, echo_span_id: span.span_id, phase: span.phase, evidence_source: source } } }, 0);
    run.end_time = done.observed_at; run.outputs = { result: done.result };
    if (done.event === 'failed') run.error = done.result ?? 'failed';
  }
  if (pending.size > 0) {
    root.extra.metadata.complete = false;
    for (const run of pending.values()) { run.end_time = end.observed_at; run.extra.metadata.incomplete = true; }
  }
  if (interrupted) root.extra.metadata.collection_interrupted = true;
  return runs;
}

/** Full diagnostics for selected research operations; unrelated HTTP/worker activity is not exported. */
export function createLangSmithObserverV1(options: {
  project: string;
  release_sha: string;
  send: (runs: LangSmithRunV1[], signal: AbortSignal) => Promise<void>;
  now?: () => number;
  max_active?: number;
  max_pending?: number;
  max_age_ms?: number;
  /** Stop admitting new runs when the explicit staging capture window expires. */
  expires_at?: number;
}) {
  const now = options.now ?? Date.now;
  const active = new Map<string, Capture>();
  const pending: LangSmithRunV1[][] = [];
  const abort = new AbortController();
  const counts = { exported: 0, failed: 0, dropped: 0, incomplete: 0 };
  let lastFailure: ExportFailure | null = null;
  const failed = (error: unknown) => {
    counts.failed++;
    lastFailure = error instanceof LangSmithExportErrorV1 ? error.failure : { kind: 'unknown', http_status: null };
  };
  let sending: Promise<void> | undefined;
  let delivery = 0;
  let closed = false;
  const pump = () => {
    if (sending !== undefined || pending.length === 0 || abort.signal.aborted) return;
    const runs = pending.shift()!;
    const attempt = ++delivery;
    sending = Promise.resolve().then(() => options.send(runs, abort.signal))
      .then(() => { if (attempt === delivery) counts.exported++; }, error => { if (attempt === delivery) failed(error); })
      .finally(() => { sending = undefined; pump(); });
  };
  const finish = (capture: Capture, end: CoreRuntimeObservationV1, interrupted = false) => {
    active.delete(capture.start.operation_id);
    capture.collector.seal();
    try {
      if (pending.length + Number(sending !== undefined) >= (options.max_pending ?? 4)) { counts.dropped++; return; }
      const runs = project(capture, end, options.project, options.release_sha, interrupted);
      if (runs[0]!.extra.metadata.complete !== true) counts.incomplete++;
      pending.push(runs); pump();
    } catch { failed(new LangSmithExportErrorV1('projection')); } finally { capture.collector.close(); }
  };
  const expire = () => {
    for (const capture of active.values()) {
      if (now() - Date.parse(capture.start.observed_at) >= (options.max_age_ms ?? 15 * 60_000)) {
        finish(capture, { ...capture.start, event: 'failed', result: 'timeout', observed_at: new Date(now()).toISOString() }, true);
      }
    }
  };
  const timer = setInterval(expire, 30_000); timer.unref();
  const recordSpan = (capture: Capture, event: CoreRuntimeObservationV1) => {
    if (event.event !== 'started') {
      const span = capture.spans.get(event.span_id);
      if (span !== undefined) span.end = event;
    } else if (capture.spans.size >= MAX_SPANS) capture.dropped_spans++;
    else capture.spans.set(event.span_id, { phase: event.phase, span_id: event.span_id, parent_span_id: event.parent_span_id, started_at: event.observed_at });
  };
  const scope: CoreRuntimeObservationScopeV1 = {
    observer(event) {
      if (closed) return;
      const capture = active.get(event.operation_id);
      if (capture !== undefined && event.event !== 'started') {
        for (const [name, count] of Object.entries(event.model_corrections ?? {}) as [CoreRuntimeModelCorrectionV1, number][]) {
          capture.corrections[name] = (capture.corrections[name] ?? 0) + count;
        }
      }
      if (event.phase !== 'research_run') {
        if (capture !== undefined && SPAN_PHASES.has(event.phase)) recordSpan(capture, event);
        return;
      }
      if (event.event === 'started') {
        if (options.expires_at !== undefined && now() >= options.expires_at) return;
        if (capture !== undefined) return;
        if (active.size >= (options.max_active ?? 4)) { counts.dropped++; return; }
        active.set(event.operation_id, { start: event, collector: createPersonDiagnosticTraceV1(now), spans: new Map(), dropped_spans: 0, corrections: {} });
      } else if (capture?.start.span_id === event.span_id) finish(capture, event);
    },
    diagnostic_exporter(operationId) {
      return closed ? undefined : active.get(operationId)?.collector.record;
    },
  };
  const flush = async () => { while (sending !== undefined) await sending; };
  return Object.freeze({
    scope, flush,
    status: () => ({ ...counts, active: active.size, pending: pending.length + Number(sending !== undefined),
      last_failure: lastFailure === null ? null : { ...lastFailure } }),
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer);
      for (const capture of active.values()) finish(capture, { ...capture.start, event: 'failed', result: 'cancelled', observed_at: new Date(now()).toISOString() }, true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([flush(), new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); })]);
      clearTimeout(timeout); abort.abort(); counts.dropped += pending.length; pending.length = 0;
      // A shutdown deadline leaves delivery unconfirmed. Count it once, even
      // if a late transport completion arrives after the final status report.
      if (sending !== undefined) { failed(new LangSmithExportErrorV1('shutdown')); delivery++; sending = undefined; }
    },
  });
}
