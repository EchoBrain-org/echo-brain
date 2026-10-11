import { createTelemetryVocabularyV1, EMPTY_TELEMETRY_VOCABULARY_V1, telemetryLabelV1, type TelemetryVocabularyV1 } from "./telemetry-vocabulary-v1.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { emitCoreRuntimeDiagnosticV1, type CoreRuntimeDiagnosticEventV1, type CoreRuntimeDiagnosticObserverV1 } from './core-runtime-diagnostics-v1.js';
export { coreRuntimeDiagnosticErrorKindV1, type CoreRuntimeDiagnosticErrorKindV1, type CoreRuntimeDiagnosticEventV1, type CoreRuntimeDiagnosticObservationV1, type CoreRuntimeDiagnosticObserverV1 } from './core-runtime-diagnostics-v1.js';

/** Fixed core-runtime boundaries carried by the existing journey transport. */
export const CORE_RUNTIME_PHASES_V1 = [
  "person_tools_status", "person_tool_delivery", "person_tool_completion",
  "worker_request", "worker_gate", "worker_execution", "worker_timer", "source_poll", "source_cursor",
  "source_intake", "extraction", "candidate_persist", "approval_staging", "recovery",
  "approval_delivery", "approval_review", "approval_observation", "record_append", "approval_action", "approval_terminal_update",
  "search_reconciliation", "search_snapshot", "search_enrichment", "search_build",
  "search_validation", "search_publication", "related_projection", "model_call",
  "model_parse", "model_schema", "model_grounding", "ask_request", "http_request", "ask_planner", "ask_answer",
  // A research trigger renderer's model call (research trigger contract v1), such as the impact card's.
  "research_render", "research_run", "research_brief", "research_starting_read", "research_preload", "research_loop", "research_output", "research_output_view", "research_revalidation", "research_audit", "research_release",
  // One evidence-desk call each (search, open, list, revalidate), from Ask or the evidence doors.
  "evidence_search", "evidence_open", "evidence_list", "evidence_revalidate", "evidence_connection",
] as const;
export type CoreRuntimePhaseV1 = (typeof CORE_RUNTIME_PHASES_V1)[number];
export const CORE_RUNTIME_COUNT_KEYS_V1 = [
  "event_loop_delay_max_us", "active_models", "gate_wait_ms", "pending_depth", "oldest_age_ms", "scheduled_delay_ms", "wake_lateness_ms",
  "unchanged_group_count", "changed_group_count", "newly_observed_group_count", "input_bytes", "output_bytes", "record_count", "atom_count", "visibility_groups",
  "included_count", "excluded_count", "recomputed_count", "reused_count",
  "captured_head", "current_head", "published_head", "http_status", "active_http",
  "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "reasoning_tokens", "provider_latency_ms",
  // One terminal research-run summary, shared by every trigger and output type.
  "planned_query_count", "query_hit_count", "released_atom_count", "context_atom_count", "citation_count",
  "rss_bytes", "heap_used_bytes", "cpu_user_us", "cpu_system_us", "fs_read_count", "fs_write_count",
  // Items an evidence call returned, by source; transcript_items is the shared-transcript subset of document_items.
  "meeting_items", "document_items", "transcript_items", "slack_items",
  "ticket_retrieved_items", "ticket_context_items", "ticket_citations",
  // Bounded rate-limit hints copied from an upstream response, never response headers or text.
  "upstream_retry_after_seconds", "upstream_rate_limit", "upstream_rate_remaining", "upstream_rate_reset_unix_seconds",
] as const;
export type CoreRuntimeCountsV1 = Partial<Record<(typeof CORE_RUNTIME_COUNT_KEYS_V1)[number], number | null>>;
export const CORE_RUNTIME_RESULTS_V1 = ["held", "unrepresentable", "current", "published", "superseded", "done", "uncertain", "failed", "cancelled", "periodic", "cycle_failure", "provider_failure", "invalid_output", "invalid_request", "unavailable", "completed", "competing_action", "coalesced", "advanced", "retry_pending", "rate_limited", "timeout", "authorization", "parse_failure", "schema_failure", "grounding_failure", "verified", "unlinked", "not_configured", "out_of_scope", "empty", "returned", "answered", "partial", "not_found", "off_scope"] as const;
export const CORE_RUNTIME_GROUNDING_STAGES_V1 = ["evidence_id", "evidence_duplicate", "evidence_quote", "due_before_meeting", "decided_question_only", "rationale_supports"] as const;
export const CORE_RUNTIME_UPSTREAM_SERVICES_V1 = ["nango", "jira", "confluence", "granola", "other"] as const;
export const CORE_RUNTIME_UPSTREAM_OPERATIONS_V1 = ["connection_read", "connection_list", "connect_session", "connection_delete", "provider_read"] as const;
export const CORE_RUNTIME_UPSTREAM_RATE_LIMIT_REASONS_V1 = ["burst", "global_quota", "tenant_quota", "per_issue_write", "other"] as const;
export const CORE_RUNTIME_RESEARCH_STOP_REASONS_V1 = Object.freeze(['finished', 'empty_catalog', 'no_progress', 'step_limit', 'budget', 'unusable_step'] as const);
export const CORE_RUNTIME_RESEARCH_ADMISSIONS_V1 = Object.freeze(['post_revalidation_no_time'] as const);
/** Only registered labels and explicit opaque hashes may correlate business entities in metadata. */
export interface CoreRuntimeCorrelationV1 {
  readonly meeting_id?: string;
  readonly approval_id?: string;
  readonly trigger?: string;
  readonly run_id?: string;
  readonly event_id?: string;
  readonly output_id?: string;
  readonly attempt_id?: string;
  readonly attempt?: number;
}
export interface CoreRuntimeDetailV1 extends CoreRuntimeCorrelationV1 {
  readonly operation_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  /** An independent background root may link to the operation that scheduled it. */
  readonly parent_operation_id?: string;
  readonly phase: CoreRuntimePhaseV1;
  readonly root: boolean;
  readonly purpose: CoreRuntimePhaseV1;
  readonly linked_journey_ids: readonly string[];
  readonly counts: CoreRuntimeCountsV1;
  readonly result: (typeof CORE_RUNTIME_RESULTS_V1)[number] | null;
  readonly research_stop_reason?: (typeof CORE_RUNTIME_RESEARCH_STOP_REASONS_V1)[number];
  readonly research_admission?: (typeof CORE_RUNTIME_RESEARCH_ADMISSIONS_V1)[number];
  readonly grounding_stage?: (typeof CORE_RUNTIME_GROUNDING_STAGES_V1)[number];
  readonly approval_surface?: "desktop" | "slack";
  readonly delivery_step?: "open_dm" | "post_marker" | "reconcile_marker" | "publish_card";
  readonly evidence_source?: "ticket" | "slack" | "page";
  /** Optional finite attribution for an upstream connector request. */
  readonly upstream_service?: (typeof CORE_RUNTIME_UPSTREAM_SERVICES_V1)[number];
  readonly upstream_operation?: (typeof CORE_RUNTIME_UPSTREAM_OPERATIONS_V1)[number];
  readonly upstream_rate_limit_reason?: (typeof CORE_RUNTIME_UPSTREAM_RATE_LIMIT_REASONS_V1)[number];
  readonly generation: string | null;
  readonly source_revision: string | null;
  readonly cursor: string | null;
  readonly action: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly finish_reason: "stop" | "length" | "content_filter" | "completed" | "other" | null;
  readonly provider_request: string | null;
  /** Process-wide counters can overlap other spans; they are not exclusive cost. */
  readonly resource_scope: "process_overlap";
  readonly sqlite_lock_time: "unavailable";
  readonly disk_io_latency: "unavailable";
  readonly event_loop_delay: "unavailable" | "process_sample";
}
export interface CoreRuntimeObservationV1 extends CoreRuntimeDetailV1 {
  readonly stage: CoreRuntimePhaseV1;
  readonly event: "started" | "succeeded" | "failed";
  readonly observed_at: string;
  readonly elapsed_ms: number;
}
export type CoreRuntimeObserverV1 = (event: CoreRuntimeObservationV1) => void | Promise<void>;
export interface CoreRuntimeContentV1 {
  readonly operation_id: string;
  readonly span_id: string;
  readonly content_kind: "meeting_input" | "model_request" | "model_response" | "validation_error";
  readonly content: unknown;
}
export interface CoreRuntimeObservationScopeV1 {
  readonly vocabulary?: TelemetryVocabularyV1;
  readonly observer?: CoreRuntimeObserverV1;
  readonly content_observer?: (event: CoreRuntimeContentV1) => void | Promise<void>;
  /** Explicit private payload selection. It is never forwarded to the metadata observer. */
  readonly diagnostic_observer?: CoreRuntimeDiagnosticObserverV1;
  /** Runtime-selected diagnostic destination, independent of a person's one-use capture.
   * The sink owns operation selection and bounded delivery; never forwarded to metadata. */
  readonly diagnostic_exporter?: (operation_id: string) => CoreRuntimeDiagnosticObserverV1 | undefined;
  readonly correlation?: CoreRuntimeCorrelationV1;
  readonly parent_operation_id?: string;
}
interface Context extends CoreRuntimeObservationScopeV1 {
  readonly diagnostic_tool?: { readonly tool_call_id: number; readonly round: number };
  /** Selection can be attached before the first observed operation begins. */
  readonly detail?: CoreRuntimeDetailV1;
}
const context = new AsyncLocalStorage<Context>();
let activeModels = 0;
export function coreRuntimeIdentityV1(domain: string, value: string): string {
  return createHash("sha256").update(`echo-core-observation-v1:${domain}\0${value}`).digest("hex");
}
function safe(action: () => void | Promise<void>): void {
  try { void Promise.resolve(action()).catch(() => undefined); } catch { /* observation only */ }
}
/** Classify source-owned error categories without preserving their messages. */
function failureResult(error: unknown, detail: CoreRuntimeDetailV1): CoreRuntimeDetailV1["result"] {
  try {
    const value = typeof error === "object" && error !== null ? error as { code?: unknown; diagnostic?: { failure_class?: unknown; http_status?: unknown } } : undefined;
    const name = error instanceof Error ? error.name : null;
    const code = value?.code;
    const diagnostic = value?.diagnostic;
    const failure = diagnostic?.failure_class;
    const status = detail.counts.http_status ?? diagnostic?.http_status;
    if (name === "AbortError" || failure === "cancelled") return "cancelled";
    if (name === "AgenticAskDeadlineErrorV1" || name === "TimeoutError" || code === "timeout" || failure === "adapter_timeout" || status === 408) return "timeout";
    if (code === "unauthorized" || code === "stale_access_state" || status === 401 || status === 403) return "authorization";
    if (code === "rate_limited" || status === 429) return "rate_limited";
    if (code === "unavailable" || failure === "adapter_transport" || failure === "audit_failure" || (typeof status === "number" && status >= 500 && status <= 599)) return "unavailable";
    if (code === "invalid_request") return "invalid_request";
    if (detail.phase === "model_parse") return "parse_failure";
    if (detail.phase === "model_schema") return "schema_failure";
    if (detail.phase === "model_grounding") return "grounding_failure";
    if (code === "invalid_output" || name === "AgenticAskOutputErrorV1" || (typeof failure === "string" && ["adapter_response", "adapter_json", "core_validation"].includes(failure))) return "invalid_output";
    if (detail.phase === "model_call" || (typeof failure === "string" && ["adapter_http", "adapter_provider_error", "adapter_finish", "adapter_refusal"].includes(failure))) return "provider_failure";
  } catch { /* A hostile error must not suppress the terminal observation. */ }
  return detail.result ?? "failed";
}
export function annotateCoreRuntimeV1(input: { counts?: CoreRuntimeCountsV1; result?: CoreRuntimeDetailV1["result"]; generation?: string; linked_journey_ids?: readonly string[] } & CoreRuntimeCorrelationV1 & Partial<Pick<CoreRuntimeDetailV1, "grounding_stage" | "approval_surface" | "delivery_step" | "source_revision" | "cursor" | "action" | "provider" | "model" | "finish_reason" | "provider_request" | "evidence_source" | "upstream_service" | "upstream_operation" | "upstream_rate_limit_reason" | "research_stop_reason" | "research_admission">>): void {
  const current = context.getStore();
  const detail = current?.detail;
  if (!detail) return;
  safe(() => {
    Object.assign(detail.counts, input.counts);
    for (const key of ["grounding_stage", "approval_surface", "delivery_step", "source_revision", "cursor", "action", "provider", "model", "finish_reason", "provider_request", "evidence_source", "upstream_service", "upstream_operation", "upstream_rate_limit_reason", "research_stop_reason", "research_admission"] as const) { if (input[key] !== undefined) Object.assign(detail, { [key]: input[key] }); }
    Object.assign(detail, correlation(input, current?.vocabulary));
    if (input.result !== undefined) Object.assign(detail, { result: input.result });
    if (input.generation !== undefined) Object.assign(detail, { generation: input.generation });
    if (input.linked_journey_ids !== undefined) Object.assign(detail, { linked_journey_ids: [...new Set([...detail.linked_journey_ids, ...input.linked_journey_ids])] });
  });
}
export function captureCoreRuntimeContentV1(content_kind: CoreRuntimeContentV1["content_kind"], content: unknown): void {
  const current = context.getStore();
  if (current?.content_observer && current.detail) safe(() => current.content_observer!({ operation_id: current.detail!.operation_id, span_id: current.detail!.span_id, content_kind, content }));
}
/** Attach a selected sink without creating another span or changing sync/async return behavior. */
export function withCoreRuntimeDiagnosticsV1<T>(observer: CoreRuntimeDiagnosticObserverV1 | undefined, operation: () => T): T {
  const { diagnostic_observer: _previous, ...parent } = context.getStore() ?? {};
  return context.run({ ...parent, ...(observer === undefined ? {} : { diagnostic_observer: observer }) }, operation);
}
/** Correlate nested connector diagnostics without adding operational log entries. */
export function withCoreRuntimeDiagnosticToolV1<T>(identity: { readonly tool_call_id: number; readonly round: number }, operation: () => T): T {
  const current = context.getStore();
  return current === undefined ? operation() : context.run({ ...current,
    diagnostic_tool: { tool_call_id: identity.tool_call_id, round: identity.round } }, operation);
}
/** Exact payloads go only to the selected diagnostic destinations. */
export function observeCoreRuntimeDiagnosticV1(event: CoreRuntimeDiagnosticEventV1): void {
  const current = context.getStore();
  if (current?.detail === undefined) return;
  let exporter: CoreRuntimeDiagnosticObserverV1 | undefined;
  safe(() => { exporter = current.diagnostic_exporter?.(current.detail!.operation_id); });
  for (const observer of new Set([current.diagnostic_observer, exporter])) {
    if (observer !== undefined) safe(() => emitCoreRuntimeDiagnosticV1(observer, { ...event,
      operation_id: current.detail!.operation_id, span_id: current.detail!.span_id, parent_span_id: current.detail!.parent_span_id,
      ...(current.diagnostic_tool === undefined ? {} : { tool_context: current.diagnostic_tool }) }));
  }
}
/** Keep operational timings while excluding pending-custody payloads from content telemetry. */
export function withoutCoreRuntimeContentV1<T>(operation: () => T): T {
  const current = context.getStore();
  if (current === undefined) return operation();
  const { content_observer: _contentObserver, ...contentFree } = current;
  return context.run(contentFree, operation);
}
function begin(phase: CoreRuntimePhaseV1, scope?: CoreRuntimeObservationScopeV1): { current: Context; finish: (event: "succeeded" | "failed", error?: unknown) => void } | null {
  const parent = context.getStore();
  const observer = scope?.observer ?? parent?.observer;
  const diagnosticObserver = scope?.diagnostic_observer ?? parent?.diagnostic_observer;
  const diagnosticExporter = scope?.diagnostic_exporter ?? parent?.diagnostic_exporter;
  if (!observer && !diagnosticObserver && !diagnosticExporter) return null;
  try {
    const started = performance.now();
    const usage = process.resourceUsage();
    const vocabulary = createTelemetryVocabularyV1(scope?.vocabulary ?? parent?.vocabulary ?? EMPTY_TELEMETRY_VOCABULARY_V1);
    const parentDetail = parent?.detail;
    const operation_id = parentDetail?.operation_id ?? randomUUID();
    const parentOperationId = scope?.parent_operation_id ?? parentDetail?.parent_operation_id;
    const detail: CoreRuntimeDetailV1 = { operation_id, span_id: randomUUID(), parent_span_id: parentDetail?.span_id ?? null,
      ...(parentOperationId === undefined ? {} : { parent_operation_id: parentOperationId }),
      ...correlation(parentDetail ?? parent?.correlation ?? {}, vocabulary), ...correlation(scope?.correlation ?? {}, vocabulary),
      phase, purpose: phase === "model_call" ? parentDetail?.phase ?? phase : phase, root: parentDetail === undefined, linked_journey_ids: parentDetail?.linked_journey_ids ?? (parentOperationId === undefined ? [] : [parentOperationId]), counts: {}, result: null, generation: null, source_revision: parentDetail?.source_revision ?? null, cursor: parentDetail?.cursor ?? null, action: parentDetail?.action ?? null, provider: null, model: null, finish_reason: null, provider_request: null,
      resource_scope: "process_overlap", sqlite_lock_time: "unavailable", disk_io_latency: "unavailable", event_loop_delay: "unavailable" };
    const current: Context = { ...(observer === undefined ? {} : { observer }), vocabulary,
      ...(diagnosticObserver === undefined ? {} : { diagnostic_observer: diagnosticObserver }),
      ...(diagnosticExporter === undefined ? {} : { diagnostic_exporter: diagnosticExporter }),
      ...(parent?.diagnostic_tool === undefined ? {} : { diagnostic_tool: parent.diagnostic_tool }),
      ...(scope?.content_observer ?? parent?.content_observer ? { content_observer: scope?.content_observer ?? parent?.content_observer } : {}), detail };
    const emit = (event: CoreRuntimeObservationV1["event"]) => { if (observer !== undefined) safe(() => observer({ ...normalizeCoreRuntimeDetailV1(detail, vocabulary), stage: phase, event, observed_at: new Date().toISOString(), elapsed_ms: event === "started" ? 0 : Math.max(0, Math.floor(performance.now() - started)) })); };
    if (phase === "model_call") { activeModels += 1; Object.assign(detail.counts, { active_models: activeModels }); }
    emit("started");
    return { current, finish(event, error) {
      if (phase === "model_call") activeModels -= 1;
      safe(() => {
        const end = process.resourceUsage();
        const memory = process.memoryUsage();
        Object.assign(detail.counts, { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed,
          cpu_user_us: Math.max(0, end.userCPUTime - usage.userCPUTime), cpu_system_us: Math.max(0, end.systemCPUTime - usage.systemCPUTime),
          fs_read_count: Math.max(0, end.fsRead - usage.fsRead), fs_write_count: Math.max(0, end.fsWrite - usage.fsWrite) });
        if (error !== undefined) {
          captureCoreRuntimeContentV1("validation_error", error instanceof Error ? { name: error.name, message: error.message } : { message: "non-Error failure" });
          Object.assign(detail, { result: failureResult(error, detail) });
        }
        emit(event);
      });
    } };
  } catch { return null; }
}
/** Synchronous boundaries remain synchronous; observers never control the result. */
export function observeCoreRuntimeSyncV1<T>(phase: CoreRuntimePhaseV1, operation: () => T, scope?: CoreRuntimeObservationScopeV1): T {
  const span = begin(phase, scope);
  if (!span) return operation();
  return context.run(span.current, () => {
    try { const value = operation(); span.finish("succeeded"); return value; }
    catch (error) { span.finish("failed", error); throw error; }
  });
}
export async function observeCoreRuntimeV1<T>(phase: CoreRuntimePhaseV1, operation: () => Promise<T>, scope?: CoreRuntimeObservationScopeV1): Promise<T> {
  const span = begin(phase, scope);
  if (!span) return operation();
  return context.run(span.current, async () => {
    try { const value = await operation(); span.finish("succeeded"); return value; }
    catch (error) { span.finish("failed", error); throw error; }
  });
}

/** A queued worker operation outlives its HTTP caller and owns an independent trace. */
export function observeCoreRuntimeRootV1<T>(phase: CoreRuntimePhaseV1, operation: () => Promise<T>, scope?: CoreRuntimeObservationScopeV1): Promise<T> {
  const parent = context.getStore();
  // Copy only operational observation and safe correlation. Payload capture is
  // selected separately for the background run, never inherited from its caller.
  const observer = scope?.observer ?? parent?.observer;
  const vocabulary = scope?.vocabulary ?? parent?.vocabulary;
  const parentOperationId = scope?.parent_operation_id ?? parent?.detail?.operation_id;
  const detached: CoreRuntimeObservationScopeV1 = {
    ...(observer === undefined ? {} : { observer }), ...(vocabulary === undefined ? {} : { vocabulary }),
    ...(parent?.diagnostic_exporter === undefined ? {} : { diagnostic_exporter: parent.diagnostic_exporter }),
    ...(parentOperationId === undefined ? {} : { parent_operation_id: parentOperationId }),
    ...scope,
  };
  return context.exit(() => observeCoreRuntimeV1(phase, operation, detached));
}

/** Rebuild the finite metadata contract; never admit raw IDs, errors, or content. */
export function normalizeCoreRuntimeDetailV1(input: CoreRuntimeDetailV1, vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1): CoreRuntimeDetailV1 {
  const admitted = createTelemetryVocabularyV1(vocabulary);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuid.test(input.operation_id) || !uuid.test(input.span_id) || (input.parent_span_id !== null && !uuid.test(input.parent_span_id)) ||
      (input.parent_operation_id !== undefined && !uuid.test(input.parent_operation_id)) ||
      !CORE_RUNTIME_PHASES_V1.includes(input.phase) || !CORE_RUNTIME_PHASES_V1.includes(input.purpose) || typeof input.root !== "boolean" ||
      !Array.isArray(input.linked_journey_ids) || input.linked_journey_ids.length > 1000 || input.linked_journey_ids.some((id) => !uuid.test(id)) ||
      (input.result !== null && !CORE_RUNTIME_RESULTS_V1.includes(input.result)) ||
      (input.research_stop_reason !== undefined && !CORE_RUNTIME_RESEARCH_STOP_REASONS_V1.includes(input.research_stop_reason)) ||
      (input.research_admission !== undefined && !CORE_RUNTIME_RESEARCH_ADMISSIONS_V1.includes(input.research_admission)) ||
      (input.grounding_stage !== undefined && !CORE_RUNTIME_GROUNDING_STAGES_V1.includes(input.grounding_stage)) ||
      (input.approval_surface !== undefined && !["desktop", "slack"].includes(input.approval_surface)) ||
      (input.delivery_step !== undefined && !["open_dm", "post_marker", "reconcile_marker", "publish_card"].includes(input.delivery_step)) ||
      (input.evidence_source !== undefined && input.evidence_source !== "ticket" && input.evidence_source !== "slack" && input.evidence_source !== "page") ||
      (input.upstream_service !== undefined && !CORE_RUNTIME_UPSTREAM_SERVICES_V1.includes(input.upstream_service)) ||
      (input.upstream_operation !== undefined && !CORE_RUNTIME_UPSTREAM_OPERATIONS_V1.includes(input.upstream_operation)) ||
      (input.upstream_rate_limit_reason !== undefined && !CORE_RUNTIME_UPSTREAM_RATE_LIMIT_REASONS_V1.includes(input.upstream_rate_limit_reason)) ||
      (input.generation !== null && !/^sha256:[0-9a-f]{64}$/.test(input.generation))) throw new TypeError("invalid core runtime observation");
  const counts: CoreRuntimeCountsV1 = {};
  for (const key of CORE_RUNTIME_COUNT_KEYS_V1) {
    const value = input.counts[key];
    if (value === undefined) continue;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError("invalid core runtime count");
    counts[key] = value;
  }
  return Object.freeze({ operation_id: input.operation_id, span_id: input.span_id, parent_span_id: input.parent_span_id,
    ...(input.parent_operation_id === undefined ? {} : { parent_operation_id: input.parent_operation_id }),
    ...correlation(input, admitted),
    phase: input.phase, purpose: input.purpose, root: input.root, linked_journey_ids: Object.freeze([...input.linked_journey_ids]), counts: Object.freeze(counts),
    result: input.result, generation: input.generation,
    ...(input.research_stop_reason === undefined ? {} : { research_stop_reason: input.research_stop_reason }),
    ...(input.research_admission === undefined ? {} : { research_admission: input.research_admission }),
    ...(input.grounding_stage === undefined ? {} : { grounding_stage: input.grounding_stage }),
    ...(input.approval_surface === undefined ? {} : { approval_surface: input.approval_surface }),
    ...(input.delivery_step === undefined ? {} : { delivery_step: input.delivery_step }),
    ...(input.evidence_source === undefined ? {} : { evidence_source: input.evidence_source }),
    ...(input.upstream_service === undefined ? {} : { upstream_service: input.upstream_service }),
    ...(input.upstream_operation === undefined ? {} : { upstream_operation: input.upstream_operation }),
    ...(input.upstream_rate_limit_reason === undefined ? {} : { upstream_rate_limit_reason: input.upstream_rate_limit_reason }),
    source_revision: opaque(input.source_revision), cursor: opaque(input.cursor), action: opaque(input.action), provider_request: opaque(input.provider_request),
    provider: finite(input.provider, admitted.providers), model: finite(input.model, admitted.models),
    finish_reason: finite(input.finish_reason, ["stop", "length", "content_filter", "completed", "other"]), resource_scope: "process_overlap", sqlite_lock_time: "unavailable", disk_io_latency: "unavailable", event_loop_delay: input.event_loop_delay === "process_sample" ? "process_sample" : "unavailable" });
}

function correlation(input: CoreRuntimeCorrelationV1, vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1): CoreRuntimeCorrelationV1 {
  const value: { meeting_id?: string; approval_id?: string; trigger?: string; run_id?: string; event_id?: string; output_id?: string; attempt_id?: string; attempt?: number } = {};
  if (input.trigger !== undefined) value.trigger = telemetryLabelV1(input.trigger, vocabulary.triggers ?? ['other']);
  for (const key of ['meeting_id', 'approval_id', 'run_id', 'event_id', 'output_id', 'attempt_id'] as const) {
    if (input[key] !== undefined) {
      const id = opaque(input[key]);
      if (id === null) throw new TypeError('invalid core runtime correlation');
      value[key] = id;
    }
  }
  if (input.attempt !== undefined) {
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 1_000_000) throw new TypeError('invalid core runtime attempt');
    value.attempt = input.attempt;
  }
  return value;
}

function opaque(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError("invalid opaque observation identity");
  return value;
}
function finite<T extends string>(value: T | null, allowed: readonly T[]): T | null {
  if (value === null || value === undefined) return null;
  if (!allowed.includes(value)) throw new TypeError("invalid observation category");
  return value;
}
export function observeCoreModelMetadataV1(input: { provider: string; model: string; request_id?: string; finish_reason?: string }): void {
  const vocabulary = context.getStore()?.vocabulary ?? EMPTY_TELEMETRY_VOCABULARY_V1;
  annotateCoreRuntimeV1({ provider: telemetryLabelV1(input.provider, vocabulary.providers),
    model: telemetryLabelV1(input.model, vocabulary.models),
    ...(input.request_id === undefined ? {} : { provider_request: coreRuntimeIdentityV1("provider_request", input.request_id) }),
    ...(input.finish_reason === undefined ? {} : { finish_reason: ["stop", "length", "content_filter", "completed"].includes(input.finish_reason) ? input.finish_reason as NonNullable<CoreRuntimeDetailV1["finish_reason"]> : "other" }) });
}

export function currentCoreRuntimeDetailV1(): CoreRuntimeDetailV1 | null {
  try { const value = context.getStore()?.detail; return value ? normalizeCoreRuntimeDetailV1({ ...value, root: false }, context.getStore()?.vocabulary) : null; }
  catch { return null; }
}
