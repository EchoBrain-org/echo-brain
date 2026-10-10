import { randomUUID } from 'node:crypto';
import type { CoreRuntimeDiagnosticObservationV1, CoreRuntimeObservationScopeV1, CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { createPersonDiagnosticTraceV1, type PersonDiagnosticTraceCollectorV1 } from '../person-diagnostic-trace-v1.js';

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
interface Capture {
  start: CoreRuntimeObservationV1;
  collector: PersonDiagnosticTraceCollectorV1;
}
type Recorded = CoreRuntimeDiagnosticObservationV1 & { observed_at: string; sequence: number };
// Millisecond timestamps plus the capture sequence give stable sibling ordering
// when multiple model/tool calls start in the same millisecond.
const order = (time: string, id: string, sequence = 0) => `${time.replace(/[-:.]/g, '').replace('Z', `${String(sequence).padStart(3, '0')}Z`)}${id}`;

function project(capture: Capture, end: CoreRuntimeObservationV1, projectName: string, release: string, interrupted: boolean): LangSmithRunV1[] {
  const snapshot = capture.collector.snapshot();
  const rootId = capture.start.span_id;
  const root: LangSmithRunV1 = {
    id: rootId, name: `ECHO ${capture.start.trigger ?? 'research'}`, run_type: 'chain', trace_id: rootId,
    dotted_order: order(capture.start.observed_at, rootId), session_name: projectName,
    start_time: capture.start.observed_at, end_time: end.observed_at, inputs: {},
    extra: { metadata: { echo_operation_id: end.operation_id, echo_span_id: rootId, release_sha: release,
      echo_run_id: end.run_id ?? null, echo_event_id: end.event_id ?? null, echo_attempt_id: end.attempt_id ?? null,
      trigger: capture.start.trigger ?? 'research', complete: snapshot.complete && !interrupted, dropped_events: snapshot.dropped_events,
      result: end.result, research_stop_reason: end.research_stop_reason ?? null, counts: end.counts,
      ...(end.parent_operation_id === undefined ? {} : { parent_operation_id: end.parent_operation_id }),
    } }, events: [],
    ...(end.event === 'failed' ? { error: end.result ?? 'failed' } : {}),
  };
  const runs = [root];
  const pending = new Map<string, LangSmithRunV1>();
  const tools = new Map<number, LangSmithRunV1>();
  for (const raw of snapshot.events) {
    const event = raw as unknown as Recorded;
    const model = event.kind === 'model_request' || event.kind === 'model_response' || event.kind === 'model_error';
    const tool = event.kind === 'tool_request' || event.kind === 'tool_response' || event.kind === 'tool_error';
    if (model || tool) {
      const key = `${event.span_id}:${model ? `model:${event.call_id}` : `tool:${event.tool_call_id}`}`;
      if (event.kind === 'model_request' || event.kind === 'tool_request') {
        if (pending.has(key)) root.extra.metadata.complete = false;
        const id = randomUUID();
        const run: LangSmithRunV1 = { id, name: event.kind === 'model_request' ? `model.${event.role}` : event.tool,
          run_type: model ? 'llm' : 'tool', trace_id: rootId, parent_run_id: rootId,
          dotted_order: `${root.dotted_order}.${order(event.observed_at, id, event.sequence)}`, session_name: projectName,
          start_time: event.observed_at, inputs: event.kind === 'model_request' ? { ...event.input } : { ...event.args },
          extra: { metadata: { echo_operation_id: event.operation_id, echo_span_id: event.span_id, echo_sequence: event.sequence,
            ...(event.kind === 'model_request' ? { call_id: event.call_id, model: event.input.model, recovery: event.recovery }
              : { tool_call_id: event.tool_call_id, round: event.round }),
          } },
        };
        pending.set(key, run); runs.push(run);
        if (event.kind === 'tool_request') tools.set(event.tool_call_id, run);
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
        } else if (event.kind === 'tool_response') run.outputs = { ...event.result };
        else run.error = event.error_kind;
      }
    } else if (event.kind === 'provider_query') {
      const parent = event.tool_context === undefined ? root : tools.get(event.tool_context.tool_call_id);
      if (parent === undefined) { root.extra.metadata.complete = false; continue; }
      (parent.events ??= []).push({ name: `${event.provider}.${event.operation}`, time: event.observed_at,
        query: event.query, max_results: event.max_results, echo_span_id: event.span_id });
    } else if (event.kind === 'lifecycle') {
      root.events!.push({ name: `${event.stage}.${event.event}`, time: event.observed_at,
        ...(event.data === undefined ? {} : { data: event.data }),
        ...(event.error_kind === undefined ? {} : { error_kind: event.error_kind }) });
      if (event.stage === 'brief' && event.event === 'succeeded') root.inputs = { brief: event.data?.brief };
      if (event.stage === 'run' && event.event === 'succeeded') root.outputs = { ...event.data };
    }
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
  let sending: Promise<void> | undefined;
  let delivery = 0;
  let closed = false;
  const pump = () => {
    if (sending !== undefined || pending.length === 0 || abort.signal.aborted) return;
    const runs = pending.shift()!;
    const attempt = ++delivery;
    sending = Promise.resolve().then(() => options.send(runs, abort.signal))
      .then(() => { if (attempt === delivery) counts.exported++; }, () => { if (attempt === delivery) counts.failed++; })
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
    } catch { counts.failed++; } finally { capture.collector.close(); }
  };
  const expire = () => {
    for (const capture of active.values()) {
      if (now() - Date.parse(capture.start.observed_at) >= (options.max_age_ms ?? 15 * 60_000)) {
        finish(capture, { ...capture.start, event: 'failed', result: 'timeout', observed_at: new Date(now()).toISOString() }, true);
      }
    }
  };
  const timer = setInterval(expire, 30_000); timer.unref();
  const scope: CoreRuntimeObservationScopeV1 = {
    observer(event) {
      if (closed || event.phase !== 'research_run') return;
      const capture = active.get(event.operation_id);
      if (event.event === 'started') {
        if (options.expires_at !== undefined && now() >= options.expires_at) return;
        if (capture !== undefined) return;
        if (active.size >= (options.max_active ?? 4)) { counts.dropped++; return; }
        active.set(event.operation_id, { start: event, collector: createPersonDiagnosticTraceV1(now) });
      } else if (capture?.start.span_id === event.span_id) finish(capture, event);
    },
    diagnostic_exporter(operationId) {
      return closed ? undefined : active.get(operationId)?.collector.record;
    },
  };
  const flush = async () => { while (sending !== undefined) await sending; };
  return Object.freeze({
    scope, flush,
    status: () => ({ ...counts, active: active.size, pending: pending.length + Number(sending !== undefined) }),
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer);
      for (const capture of active.values()) finish(capture, { ...capture.start, event: 'failed', result: 'cancelled', observed_at: new Date(now()).toISOString() }, true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([flush(), new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); })]);
      clearTimeout(timeout); abort.abort(); counts.dropped += pending.length; pending.length = 0;
      // A shutdown deadline leaves delivery unconfirmed. Count it once, even
      // if a late transport completion arrives after the final status report.
      if (sending !== undefined) { counts.failed++; delivery++; sending = undefined; }
    },
  });
}
