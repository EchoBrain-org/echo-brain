/** Payloads are delivered only to a selected run's private sink, never to operational metadata. */
export type CoreRuntimeDiagnosticErrorKindV1 = 'aborted' | 'deadline' | 'invalid_output' | 'unavailable' | 'unauthorized' | 'not_found' | 'stale_access_state' | 'rate_limited' | 'other';
type ModelIdentity = { readonly call_id: number; readonly role: 'step' | 'answer' | 'extraction' };
type ToolIdentity = { readonly tool_call_id: number; readonly round: number; readonly tool: 'search' | 'open' | 'list' | 'finish' };
/** Shared diagnostic projections remain independent of any particular model port or workflow. */
export interface CoreRuntimeDiagnosticModelInputV1 {
  readonly model: string;
  readonly system_prompt: string;
  readonly user_prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly max_output_tokens: number;
  readonly timeout_ms: number;
}
export interface CoreRuntimeDiagnosticUsageV1 {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly reasoning_tokens: number | null;
}

/** Exact model-port and model-facing tool projections. No HTTP state, credentials or desk receipts. */
export type CoreRuntimeDiagnosticEventV1 =
  | (ModelIdentity & { readonly kind: 'model_request'; readonly recovery: boolean; readonly input: CoreRuntimeDiagnosticModelInputV1 })
  | (ModelIdentity & { readonly kind: 'model_response'; readonly value: unknown; readonly usage?: CoreRuntimeDiagnosticUsageV1; readonly finish_reason?: 'stop' | 'length' | 'content_filter' | 'error' | 'other' | null })
  | (ModelIdentity & { readonly kind: 'model_error'; readonly error_kind: CoreRuntimeDiagnosticErrorKindV1 })
  | (ToolIdentity & { readonly kind: 'tool_request'; readonly args: Readonly<Record<string, string>> })
  | (ToolIdentity & { readonly kind: 'tool_response'; readonly result: Readonly<Record<string, unknown>> })
  | (ToolIdentity & { readonly kind: 'tool_error'; readonly error_kind: CoreRuntimeDiagnosticErrorKindV1 })
  | { readonly kind: 'lifecycle'; readonly stage: 'trigger' | 'application' | 'persistence' | 'output_view' | 'run' | 'brief' | 'starting_read' | 'preload' | 'research' | 'renderer' | 'revalidation' | 'audit' | 'release' | 'extraction' | 'grounding'; readonly event: 'started' | 'succeeded' | 'failed' | 'skipped'; readonly data?: Readonly<Record<string, unknown>>; readonly error_kind?: CoreRuntimeDiagnosticErrorKindV1 }
  | { readonly kind: 'capture_error'; readonly error_kind: 'snapshot_failed' };

/** The shared async scope supplies correlation, so every sink uses the same operation/span identity. */
export type CoreRuntimeDiagnosticObservationV1 = CoreRuntimeDiagnosticEventV1 & {
  readonly operation_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
};
export type CoreRuntimeDiagnosticObserverV1 = (event: CoreRuntimeDiagnosticObservationV1) => void | Promise<void>;

/** Reject values JSON export would silently omit or change; missing capture must be explicit. */
function jsonSnapshot(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(descriptors, index)) return false;
    delete descriptors.length;
  }
  seen.add(value);
  try {
    return Object.values(descriptors).every(descriptor => 'value' in descriptor && descriptor.enumerable && jsonSnapshot(descriptor.value, seen));
  } finally { seen.delete(value); }
}

/** Snapshot before delivery. Observer mutation, failure and rejected promises cannot alter work. */
export function emitCoreRuntimeDiagnosticV1(observer: CoreRuntimeDiagnosticObserverV1 | undefined, event: CoreRuntimeDiagnosticObservationV1): void {
  if (observer === undefined) return;
  let snapshot: CoreRuntimeDiagnosticObservationV1;
  try {
    if (!jsonSnapshot(event)) throw new TypeError('invalid diagnostic snapshot');
    snapshot = structuredClone(event);
  } catch {
    snapshot = { kind: 'capture_error', error_kind: 'snapshot_failed', operation_id: event.operation_id, span_id: event.span_id, parent_span_id: event.parent_span_id };
  }
  try { void Promise.resolve(observer(snapshot)).catch(() => undefined); }
  catch { /* Diagnostics cannot affect the operation. */ }
}

/** Closed labels only: exception text, stacks and provider payloads are not operational metadata. */
export function coreRuntimeDiagnosticErrorKindV1(error: unknown): CoreRuntimeDiagnosticErrorKindV1 {
  try {
    if (error instanceof Error && error.name === 'AbortError') return 'aborted';
    if (error instanceof Error && error.name === 'AgenticAskDeadlineErrorV1') return 'deadline';
    const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined;
    if (code === 'invalid_output' || code === 'unavailable' || code === 'unauthorized' || code === 'not_found' || code === 'stale_access_state' || code === 'rate_limited') return code;
  } catch { /* Exotic thrown values are not allowed to alter the failure path. */ }
  return 'other';
}
