import type { StructuredGenerationInput, StructuredGenerationFinishReasonV1, StructuredGenerationUsageV1 } from './structured-generation-v1.js';

/** Request-owned diagnostics, delivered only to an explicitly supplied observer; never runtime telemetry. */
export type AgenticResearchTraceErrorKindV1 = 'aborted' | 'deadline' | 'invalid_output' | 'unavailable' | 'unauthorized' | 'not_found' | 'stale_access_state' | 'rate_limited' | 'other';
type ModelIdentity = { readonly call_id: number; readonly role: 'step' | 'answer' };
type ToolIdentity = { readonly tool_call_id: number; readonly round: number; readonly tool: 'search' | 'open' | 'list' | 'finish' };

/** Model input/output and the read tools' model-facing payloads, with no transport state or desk receipts. */
export type AgenticResearchTraceEventV1 =
  | (ModelIdentity & { readonly kind: 'model_request'; readonly recovery: boolean; readonly input: Omit<StructuredGenerationInput, 'signal'> })
  | (ModelIdentity & { readonly kind: 'model_response'; readonly value: unknown; readonly usage?: StructuredGenerationUsageV1; readonly finish_reason?: StructuredGenerationFinishReasonV1 | null })
  | (ModelIdentity & { readonly kind: 'model_error'; readonly error_kind: AgenticResearchTraceErrorKindV1 })
  | (ToolIdentity & { readonly kind: 'tool_request'; readonly args: Readonly<Record<string, string>> })
  | (ToolIdentity & { readonly kind: 'tool_response'; readonly result: Readonly<Record<string, unknown>> })
  | (ToolIdentity & { readonly kind: 'tool_error'; readonly error_kind: AgenticResearchTraceErrorKindV1 })
  | { readonly kind: 'capture_error'; readonly error_kind: 'snapshot_failed' };

export type AgenticResearchTraceObserverV1 = (event: AgenticResearchTraceEventV1) => void;

/** Reject values JSON export would silently omit or change; a partial trace must say that it is partial. */
function jsonSnapshot(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return false;
      for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index) || !jsonSnapshot(value[index], seen)) return false;
      return true;
    }
    return Object.values(value).every(child => jsonSnapshot(child, seen));
  } finally { seen.delete(value); }
}

/** Give an observer an isolated snapshot. Neither mutation nor observer failure may change research. */
export function observeAgenticResearchTraceV1(observer: AgenticResearchTraceObserverV1 | undefined, event: AgenticResearchTraceEventV1): void {
  if (observer === undefined) return;
  let snapshot: AgenticResearchTraceEventV1;
  try {
    snapshot = structuredClone(event);
    if (!jsonSnapshot(snapshot)) snapshot = { kind: 'capture_error', error_kind: 'snapshot_failed' };
  }
  catch { snapshot = { kind: 'capture_error', error_kind: 'snapshot_failed' }; }
  try { void Promise.resolve(observer(snapshot)).catch(() => undefined); }
  catch { /* Diagnostics cannot affect the operation. */ }
}

/** A closed error label: exception messages, stacks and provider payloads are never diagnostic content. */
export function agenticResearchTraceErrorKindV1(error: unknown): AgenticResearchTraceErrorKindV1 {
  try {
    if (error instanceof Error && error.name === 'AbortError') return 'aborted';
    if (error instanceof Error && error.name === 'AgenticAskDeadlineErrorV1') return 'deadline';
    const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined;
    if (code === 'invalid_output' || code === 'unavailable' || code === 'unauthorized' || code === 'not_found' || code === 'stale_access_state' || code === 'rate_limited') return code;
  } catch { /* Even exotic thrown values must not affect the failure path. */ }
  return 'other';
}
