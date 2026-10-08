import { asEnumerableRecord, asRecord, assertExactKeys, assertString, assertTimestamp, fail, utf8ByteLength } from './validation.js';

/** Explicit, actor-bound captures of an ordinary product request. Capture ids are correlation, never authorization. */
export const PERSON_DIAGNOSTICS_PATH_V1 = '/v1/person/diagnostics';
export type PersonDiagnosticCaptureIdV1 = `cap_${string}`;
export type PersonDiagnosticTargetV1 = { readonly kind: 'ask' } | { readonly kind: 'trigger_run'; readonly run_id: string };
export interface PersonDiagnosticPrepareRequestV1 { readonly schema_version: 1; readonly operation: 'prepare'; readonly target: PersonDiagnosticTargetV1 }
export interface PersonDiagnosticReadRequestV1 { readonly schema_version: 1; readonly operation: 'read'; readonly capture_id: PersonDiagnosticCaptureIdV1 }
export type PersonDiagnosticsRequestV1 = PersonDiagnosticPrepareRequestV1 | PersonDiagnosticReadRequestV1;
export interface PersonDiagnosticPrepareResponseV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-diagnostic-capture-v1';
  readonly capture_id: PersonDiagnosticCaptureIdV1;
  readonly status: 'prepared';
  readonly expires_at: string;
}
export interface PersonDiagnosticTraceV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-agentic-research-trace-v1';
  readonly complete: boolean;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly dropped_events: number;
}
export interface PersonDiagnosticReadResponseV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-diagnostic-result-v1';
  readonly capture_id: PersonDiagnosticCaptureIdV1;
  readonly status: 'prepared' | 'running' | 'completed' | 'failed';
  readonly expires_at: string;
  /** Released only for a terminal run, after its source-access fence. */
  readonly trace?: PersonDiagnosticTraceV1;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface PersonDiagnosticsResultsV1 { readonly prepare: PersonDiagnosticPrepareResponseV1; readonly read: PersonDiagnosticReadResponseV1 }
export type PersonDiagnosticsResponseV1 = PersonDiagnosticsResultsV1[keyof PersonDiagnosticsResultsV1];
export const PERSON_DIAGNOSTICS_MAX_RESPONSE_BYTES_V1 = 16 * 1024 * 1024;
export const PERSON_DIAGNOSTICS_MAX_TRACE_BYTES_V1 = 8 * 1024 * 1024;
export const PERSON_DIAGNOSTICS_MAX_TRACE_EVENTS_V1 = 512;
/** Includes the envelope itself; nested model JSON schemas need a larger allowance than request inputs. */
export const PERSON_DIAGNOSTICS_MAX_TRACE_DEPTH_V1 = 48;
const CAPTURE_ID = /^cap_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Same durable-run id contract as person-runs-v1; captures do not create or approve a run.
const RUN_ID = /^run_[A-Za-z0-9-]{4,60}$/;
const TRACE_EVENT_KINDS = new Set(['model_request', 'model_response', 'model_error', 'tool_request', 'tool_response', 'tool_error', 'lifecycle']);
const LIFECYCLE_STAGES = new Set(['run', 'trigger', 'application', 'brief', 'starting_read', 'preload', 'research', 'renderer', 'revalidation', 'audit', 'persistence', 'release', 'output_view']);
const LIFECYCLE_EVENTS = new Set(['started', 'succeeded', 'failed', 'skipped']);
const LIFECYCLE_ERROR_KINDS = new Set(['aborted', 'deadline', 'invalid_output', 'unavailable', 'unauthorized', 'not_found', 'stale_access_state', 'rate_limited', 'other']);
const ERROR_CODES = new Set(['conflict', 'invalid_request', 'invalid_output', 'not_found', 'stale_access_state', 'unauthorized', 'rate_limited', 'quota_exceeded', 'unavailable', 'timed_out']);

export function validatePersonDiagnosticCaptureIdV1(value: unknown): PersonDiagnosticCaptureIdV1 {
  if (typeof value !== 'string' || !CAPTURE_ID.test(value)) fail('Diagnostic capture id is invalid');
  return value as PersonDiagnosticCaptureIdV1;
}

/** Inspect descriptors before values; reject non-JSON without normalizing exact source/model payloads. */
function traceJson(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  const prototype = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (depth >= PERSON_DIAGNOSTICS_MAX_TRACE_DEPTH_V1 || !(Array.isArray(value) || prototype === Object.prototype || prototype === null)) fail('Diagnostic trace is invalid');
  const object = value as object;
  if (ancestors.has(object) || Object.getOwnPropertySymbols(object).length !== 0) fail('Diagnostic trace is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) fail('Diagnostic trace is invalid');
    for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(descriptors, index)) fail('Diagnostic trace is invalid');
    delete descriptors.length;
  }
  ancestors.add(object);
  try {
    for (const descriptor of Object.values(descriptors)) {
      if (!('value' in descriptor) || descriptor.enumerable !== true) fail('Diagnostic trace is invalid');
      traceJson(descriptor.value, depth + 1, ancestors);
    }
  } finally { ancestors.delete(object); }
}

export function validatePersonDiagnosticTraceV1(value: unknown): PersonDiagnosticTraceV1 {
  traceJson(value);
  const trace = asRecord(value, 'Diagnostic trace');
  assertExactKeys(trace, ['schema_version', 'kind', 'complete', 'events', 'dropped_events'], 'Diagnostic trace');
  if (trace.schema_version !== 1 || trace.kind !== 'echo-agentic-research-trace-v1' || typeof trace.complete !== 'boolean' ||
      !Number.isSafeInteger(trace.dropped_events) || (trace.dropped_events as number) < 0 || trace.complete !== (trace.dropped_events === 0) ||
      !Array.isArray(trace.events) || trace.events.length > PERSON_DIAGNOSTICS_MAX_TRACE_EVENTS_V1) fail('Diagnostic trace is invalid');
  const events = trace.events.map((value, index) => {
    const event = asRecord(value, 'Diagnostic trace event');
    if (typeof event.kind !== 'string' || !TRACE_EVENT_KINDS.has(event.kind) || event.sequence !== index + 1) fail('Diagnostic trace event is invalid');
    if (event.kind === 'lifecycle') {
      if (typeof event.stage !== 'string' || !LIFECYCLE_STAGES.has(event.stage) || typeof event.event !== 'string' || !LIFECYCLE_EVENTS.has(event.event)) fail('Diagnostic trace lifecycle event is invalid');
      if (Object.hasOwn(event, 'data')) asRecord(event.data, 'Diagnostic trace lifecycle data');
      if (Object.hasOwn(event, 'error_kind') && (typeof event.error_kind !== 'string' || !LIFECYCLE_ERROR_KINDS.has(event.error_kind))) fail('Diagnostic trace lifecycle error kind is invalid');
    }
    return Object.freeze({ ...event });
  });
  if (utf8ByteLength(JSON.stringify(trace)) > PERSON_DIAGNOSTICS_MAX_TRACE_BYTES_V1) fail('Diagnostic trace is too large');
  return Object.freeze({ schema_version: 1, kind: 'echo-agentic-research-trace-v1', complete: trace.complete, events: Object.freeze(events), dropped_events: trace.dropped_events as number });
}

export function validatePersonDiagnosticsRequestV1(value: unknown): PersonDiagnosticsRequestV1 {
  const request = asEnumerableRecord(value, 'Diagnostics request');
  if (request.schema_version !== 1) fail('Diagnostics request version is invalid');
  if (request.operation === 'read') {
    assertExactKeys(request, ['schema_version', 'operation', 'capture_id'], 'Diagnostics read request');
    return Object.freeze({ schema_version: 1, operation: 'read', capture_id: validatePersonDiagnosticCaptureIdV1(request.capture_id) });
  }
  if (request.operation !== 'prepare') fail('Diagnostics request operation is invalid');
  assertExactKeys(request, ['schema_version', 'operation', 'target'], 'Diagnostics prepare request');
  const target = asEnumerableRecord(request.target, 'Diagnostics target');
  if (target.kind === 'ask') {
    assertExactKeys(target, ['kind'], 'Diagnostics Ask target');
    return Object.freeze({ schema_version: 1, operation: 'prepare', target: Object.freeze({ kind: 'ask' }) });
  }
  if (target.kind !== 'trigger_run' || typeof target.run_id !== 'string' || !RUN_ID.test(target.run_id)) fail('Diagnostics target is invalid');
  assertExactKeys(target, ['kind', 'run_id'], 'Diagnostics run target');
  return Object.freeze({ schema_version: 1, operation: 'prepare', target: Object.freeze({ kind: 'trigger_run', run_id: target.run_id }) });
}

export function validatePersonDiagnosticsResponseV1(value: unknown): PersonDiagnosticsResponseV1 {
  const input = asRecord(value, 'Diagnostics response');
  // Bound the trace before recursive checks on the envelope.
  const trace = Object.hasOwn(input, 'trace') ? validatePersonDiagnosticTraceV1(input.trace) : undefined;
  asEnumerableRecord(input, 'Diagnostics response');
  if (input.schema_version !== 1) fail('Diagnostics response version is invalid');
  const capture_id = validatePersonDiagnosticCaptureIdV1(input.capture_id);
  assertTimestamp(input.expires_at, 'Diagnostics response expires_at');
  const expires_at = input.expires_at;
  if (input.kind === 'echo-person-diagnostic-capture-v1') {
    assertExactKeys(input, ['schema_version', 'kind', 'capture_id', 'status', 'expires_at'], 'Diagnostics prepare response');
    if (input.status !== 'prepared') fail('Diagnostics prepare status is invalid');
    return Object.freeze({ schema_version: 1, kind: 'echo-person-diagnostic-capture-v1', capture_id, status: 'prepared', expires_at });
  }
  if (input.kind !== 'echo-person-diagnostic-result-v1') fail('Diagnostics response kind is invalid');
  assertExactKeys(input, ['schema_version', 'kind', 'capture_id', 'status', 'expires_at', ...(Object.hasOwn(input, 'trace') ? ['trace'] : []), ...(Object.hasOwn(input, 'error') ? ['error'] : [])], 'Diagnostics read response');
  const status = input.status;
  if (status !== 'prepared' && status !== 'running' && status !== 'completed' && status !== 'failed') fail('Diagnostics status is invalid');
  if ((status === 'failed') !== Object.hasOwn(input, 'error') || (trace !== undefined && status !== 'completed' && status !== 'failed')) fail('Diagnostics response does not match its status');
  let error: PersonDiagnosticReadResponseV1['error'];
  if (Object.hasOwn(input, 'error')) {
    const value = asEnumerableRecord(input.error, 'Diagnostics error');
    assertExactKeys(value, ['code', 'message'], 'Diagnostics error');
    if (typeof value.code !== 'string' || !ERROR_CODES.has(value.code)) fail('Diagnostics error code is invalid');
    assertString(value.message, 'Diagnostics error message', 300);
    error = Object.freeze({ code: value.code, message: value.message });
  }
  return Object.freeze({ schema_version: 1, kind: 'echo-person-diagnostic-result-v1', capture_id, status, expires_at,
    ...(trace === undefined ? {} : { trace }), ...(error === undefined ? {} : { error }) });
}

export function validatePersonDiagnosticsResultV1<K extends keyof PersonDiagnosticsResultsV1>(operation: K, value: unknown): PersonDiagnosticsResultsV1[K] {
  const result = validatePersonDiagnosticsResponseV1(value);
  if ((operation !== 'prepare' && operation !== 'read') || result.kind !== (operation === 'prepare' ? 'echo-person-diagnostic-capture-v1' : 'echo-person-diagnostic-result-v1')) fail('Diagnostics response does not match its operation');
  return result as PersonDiagnosticsResultsV1[K];
}
