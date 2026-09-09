import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

/** Fixed core-runtime boundaries carried by the existing journey transport. */
export const CORE_RUNTIME_PHASES_V1 = [
  "worker_request", "worker_gate", "worker_execution", "worker_timer", "source_poll", "source_cursor",
  "source_intake", "extraction", "candidate_persist", "approval_staging", "recovery",
  "approval_observation", "record_append", "approval_action", "slack_terminal_update",
  "search_reconciliation", "search_snapshot", "search_enrichment", "search_build",
  "search_validation", "search_publication", "related_projection", "model_call",
  "model_parse", "model_schema", "model_grounding", "ask_request", "http_request", "ask_planner", "ask_answer",
] as const;
export type CoreRuntimePhaseV1 = (typeof CORE_RUNTIME_PHASES_V1)[number];
export const CORE_RUNTIME_COUNT_KEYS_V1 = [
  "event_loop_delay_max_us", "active_models", "gate_wait_ms", "pending_depth", "oldest_age_ms", "scheduled_delay_ms", "wake_lateness_ms",
  "unchanged_group_count", "changed_group_count", "newly_observed_group_count", "input_bytes", "output_bytes", "record_count", "atom_count", "visibility_groups",
  "included_count", "excluded_count", "recomputed_count", "reused_count",
  "captured_head", "current_head", "published_head", "http_status", "active_http",
  "input_tokens", "output_tokens", "total_tokens", "provider_latency_ms",
  "rss_bytes", "heap_used_bytes", "cpu_user_us", "cpu_system_us", "fs_read_count", "fs_write_count",
] as const;
export type CoreRuntimeCountsV1 = Partial<Record<(typeof CORE_RUNTIME_COUNT_KEYS_V1)[number], number | null>>;
export const CORE_RUNTIME_RESULTS_V1 = ["current", "published", "superseded", "done", "uncertain", "failed", "cancelled", "periodic", "cycle_failure", "provider_failure", "invalid_output", "unavailable", "completed", "competing_action", "coalesced", "advanced", "retry_pending", "rate_limited", "timeout", "authorization", "parse_failure", "schema_failure", "grounding_failure"] as const;
export interface CoreRuntimeDetailV1 {
  readonly operation_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly phase: CoreRuntimePhaseV1;
  readonly root: boolean;
  readonly purpose: CoreRuntimePhaseV1;
  readonly linked_journey_ids: readonly string[];
  readonly counts: CoreRuntimeCountsV1;
  readonly result: (typeof CORE_RUNTIME_RESULTS_V1)[number] | null;
  readonly generation: string | null;
  readonly source_revision: string | null;
  readonly cursor: string | null;
  readonly action: string | null;
  readonly provider: "openrouter" | "openai" | "anthropic" | "ollama" | "other" | null;
  readonly model: "anthropic/claude-sonnet-4.6" | "deepseek/deepseek-v3.2" | "other" | null;
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
  readonly observer?: CoreRuntimeObserverV1;
  readonly content_observer?: (event: CoreRuntimeContentV1) => void | Promise<void>;
}
interface Context extends CoreRuntimeObservationScopeV1 {
  readonly detail: CoreRuntimeDetailV1;
}
const context = new AsyncLocalStorage<Context>();
let activeModels = 0;
export function coreRuntimeIdentityV1(domain: string, value: string): string {
  return createHash("sha256").update(`echo-core-observation-v1:${domain}\0${value}`).digest("hex");
}
function safe(action: () => void | Promise<void>): void {
  try { void Promise.resolve(action()).catch(() => undefined); } catch { /* observation only */ }
}
export function annotateCoreRuntimeV1(input: { counts?: CoreRuntimeCountsV1; result?: CoreRuntimeDetailV1["result"]; generation?: string; linked_journey_ids?: readonly string[] } & Partial<Pick<CoreRuntimeDetailV1, "source_revision" | "cursor" | "action" | "provider" | "model" | "finish_reason" | "provider_request">>): void {
  const current = context.getStore();
  if (!current) return;
  safe(() => {
    Object.assign(current.detail.counts, input.counts);
    for (const key of ["source_revision", "cursor", "action", "provider", "model", "finish_reason", "provider_request"] as const) { if (input[key] !== undefined) Object.assign(current.detail, { [key]: input[key] }); }
    if (input.result !== undefined) Object.assign(current.detail, { result: input.result });
    if (input.generation !== undefined) Object.assign(current.detail, { generation: input.generation });
    if (input.linked_journey_ids !== undefined) Object.assign(current.detail, { linked_journey_ids: [...new Set([...current.detail.linked_journey_ids, ...input.linked_journey_ids])] });
  });
}
export function captureCoreRuntimeContentV1(content_kind: CoreRuntimeContentV1["content_kind"], content: unknown): void {
  const current = context.getStore();
  if (current?.content_observer) safe(() => current.content_observer!({ operation_id: current.detail.operation_id, span_id: current.detail.span_id, content_kind, content }));
}
function begin(phase: CoreRuntimePhaseV1, scope?: CoreRuntimeObservationScopeV1): { current: Context; finish: (event: "succeeded" | "failed", error?: unknown) => void } | null {
  const parent = context.getStore();
  const observer = scope?.observer ?? parent?.observer;
  if (!observer) return null;
  try {
    const started = performance.now();
    const usage = process.resourceUsage();
    const operation_id = parent?.detail.operation_id ?? randomUUID();
    const detail: CoreRuntimeDetailV1 = { operation_id, span_id: randomUUID(), parent_span_id: parent?.detail.span_id ?? null,
      phase, purpose: phase === "model_call" ? parent?.detail.phase ?? phase : phase, root: !parent, linked_journey_ids: parent?.detail.linked_journey_ids ?? [], counts: {}, result: null, generation: null, source_revision: parent?.detail.source_revision ?? null, cursor: parent?.detail.cursor ?? null, action: parent?.detail.action ?? null, provider: null, model: null, finish_reason: null, provider_request: null,
      resource_scope: "process_overlap", sqlite_lock_time: "unavailable", disk_io_latency: "unavailable", event_loop_delay: "unavailable" };
    const current: Context = { observer, ...(scope?.content_observer ?? parent?.content_observer ? { content_observer: scope?.content_observer ?? parent?.content_observer } : {}), detail };
    const emit = (event: CoreRuntimeObservationV1["event"]) => safe(() => observer({ ...detail, counts: { ...detail.counts }, stage: phase, event, observed_at: new Date().toISOString(), elapsed_ms: event === "started" ? 0 : Math.max(0, Math.floor(performance.now() - started)) }));
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
          const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
          const result = error instanceof Error && error.name === "AbortError" ? "cancelled" :
            detail.phase === "model_parse" ? "parse_failure" : detail.phase === "model_schema" ? "schema_failure" : detail.phase === "model_grounding" ? "grounding_failure" :
            detail.counts.http_status === 429 || code === "rate_limited" ? "rate_limited" : code === "timeout" ? "timeout" : code === "unauthorized" ? "authorization" : detail.phase === "model_call" ? "provider_failure" : detail.result;
          Object.assign(detail, { result: detail.result ?? result });
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
  return context.exit(() => observeCoreRuntimeV1(phase, operation, scope));
}

/** Rebuild the finite metadata contract; never admit raw IDs, errors, or content. */
export function normalizeCoreRuntimeDetailV1(input: CoreRuntimeDetailV1): CoreRuntimeDetailV1 {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuid.test(input.operation_id) || !uuid.test(input.span_id) || (input.parent_span_id !== null && !uuid.test(input.parent_span_id)) ||
      !CORE_RUNTIME_PHASES_V1.includes(input.phase) || !CORE_RUNTIME_PHASES_V1.includes(input.purpose) || typeof input.root !== "boolean" ||
      !Array.isArray(input.linked_journey_ids) || input.linked_journey_ids.length > 1000 || input.linked_journey_ids.some((id) => !uuid.test(id)) ||
      (input.result !== null && !CORE_RUNTIME_RESULTS_V1.includes(input.result)) ||
      (input.generation !== null && !/^sha256:[0-9a-f]{64}$/.test(input.generation))) throw new TypeError("invalid core runtime observation");
  const counts: CoreRuntimeCountsV1 = {};
  for (const key of CORE_RUNTIME_COUNT_KEYS_V1) {
    const value = input.counts[key];
    if (value === undefined) continue;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError("invalid core runtime count");
    counts[key] = value;
  }
  return Object.freeze({ operation_id: input.operation_id, span_id: input.span_id, parent_span_id: input.parent_span_id,
    phase: input.phase, purpose: input.purpose, root: input.root, linked_journey_ids: Object.freeze([...input.linked_journey_ids]), counts: Object.freeze(counts),
    result: input.result, generation: input.generation,
    source_revision: opaque(input.source_revision), cursor: opaque(input.cursor), action: opaque(input.action), provider_request: opaque(input.provider_request),
    provider: finite(input.provider, ["openrouter", "openai", "anthropic", "ollama", "other"]), model: finite(input.model, ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-v3.2", "other"]),
    finish_reason: finite(input.finish_reason, ["stop", "length", "content_filter", "completed", "other"]), resource_scope: "process_overlap", sqlite_lock_time: "unavailable", disk_io_latency: "unavailable", event_loop_delay: input.event_loop_delay === "process_sample" ? "process_sample" : "unavailable" });
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
  annotateCoreRuntimeV1({ provider: ["openrouter", "openai", "anthropic", "ollama"].includes(input.provider) ? input.provider as NonNullable<CoreRuntimeDetailV1["provider"]> : "other",
    model: ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-v3.2"].includes(input.model) ? input.model as NonNullable<CoreRuntimeDetailV1["model"]> : "other",
    ...(input.request_id === undefined ? {} : { provider_request: coreRuntimeIdentityV1("provider_request", input.request_id) }),
    ...(input.finish_reason === undefined ? {} : { finish_reason: ["stop", "length", "content_filter", "completed"].includes(input.finish_reason) ? input.finish_reason as NonNullable<CoreRuntimeDetailV1["finish_reason"]> : "other" }) });
}

export function currentCoreRuntimeDetailV1(): CoreRuntimeDetailV1 | null {
  try { const value = context.getStore()?.detail; return value ? normalizeCoreRuntimeDetailV1({ ...value, root: false }) : null; }
  catch { return null; }
}

/** Nullable provider usage, observed before adapter validation can reject output. */
export function observeCoreModelUsageV1(payload: unknown): void {
  try {
    if (typeof payload !== "object" || payload === null) return;
    const usage = (payload as { usage?: Record<string, unknown> }).usage;
    if (typeof usage !== "object" || usage === null) return;
    const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    annotateCoreRuntimeV1({ counts: { input_tokens: count(usage.prompt_tokens ?? usage.input_tokens), output_tokens: count(usage.completion_tokens ?? usage.output_tokens), total_tokens: count(usage.total_tokens) } });
  } catch { /* provider usage is not a business input */ }
}
