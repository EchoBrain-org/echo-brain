import { randomUUID } from "node:crypto";

/**
 * Content-free, provider-neutral telemetry for an Authority business journey.
 * This contract never admits arbitrary metadata, prompts, answers, meeting
 * content, person or Slack identifiers, Authority IDs, errors, or credentials.
 */
export const JOURNEY_TELEMETRY_SCHEMA_VERSION_V1 = 1 as const;
export const JOURNEY_TELEMETRY_KIND_V1 = "echo-authority-journey-stage-v1" as const;

export const JOURNEY_ENVIRONMENTS_V1 = [
  "development",
  "test",
  "staging",
  "production",
] as const;
export type JourneyEnvironmentV1 = (typeof JOURNEY_ENVIRONMENTS_V1)[number];

export const JOURNEY_WORKFLOWS_V1 = ["ask", "meeting_approval"] as const;
export type JourneyWorkflowV1 = (typeof JOURNEY_WORKFLOWS_V1)[number];

export const JOURNEY_STAGES_V1 = [
  "ask_validation",
  "ask_authorization",
  "ask_planner",
  "ask_retrieval",
  "ask_context",
  "ask_answer",
  "ask_revalidation",
  "ask_audit",
  "ask_response",
  "meeting_source_intake",
  "meeting_extraction",
  "meeting_candidate_persist",
  "meeting_approval_staging",
  "meeting_approval_action_verify",
  "meeting_approval_action_queue",
  "meeting_terminal_persist",
  "meeting_record_append",
  "meeting_search_publication",
] as const;
export type JourneyStageV1 = (typeof JOURNEY_STAGES_V1)[number];

export const JOURNEY_EVENTS_V1 = ["started", "succeeded", "failed", "skipped"] as const;
export type JourneyEventV1 = (typeof JOURNEY_EVENTS_V1)[number];

export const JOURNEY_OUTCOMES_V1 = [
  "completed",
  "answered",
  "insufficient_evidence",
  "authorship_unsupported",
  "actionable",
  "no_signals",
  "coalesced",
  "staged",
  "delivery_pending",
  "quarantined",
  "approved",
  "rejected",
  "denied",
  "current",
  "published",
  "superseded",
  "skipped",
] as const;
export type JourneyOutcomeV1 = (typeof JOURNEY_OUTCOMES_V1)[number];

export const JOURNEY_FAILURE_CLASSES_V1 = [
  "authorization",
  "invalid_request",
  "invalid_contract",
  "rate_limited",
  "timeout",
  "unavailable",
  "cancelled",
  "provider_rejected",
  "unknown",
] as const;
export type JourneyFailureClassV1 = (typeof JOURNEY_FAILURE_CLASSES_V1)[number];

export const JOURNEY_LLM_PROVIDERS_V1 = [
  "anthropic",
  "openai",
  "openrouter",
  "ollama",
  "other",
] as const;
export type JourneyLlmProviderV1 = (typeof JOURNEY_LLM_PROVIDERS_V1)[number];

/** Finite configuration-derived model identities admitted by telemetry V1. */
export const JOURNEY_LLM_MODELS_V1 = [
  "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-v3.2",
] as const;
export type JourneyLlmModelV1 = (typeof JOURNEY_LLM_MODELS_V1)[number];

export const JOURNEY_LLM_FINISH_REASONS_V1 = [
  "completed",
  "length",
  "stop",
  "content_filter",
  "tool_call",
  "unknown",
] as const;
export type JourneyLlmFinishReasonV1 =
  (typeof JOURNEY_LLM_FINISH_REASONS_V1)[number];

export const JOURNEY_LLM_USAGE_STATUSES_V1 = ["reported", "unavailable"] as const;
export type JourneyLlmUsageStatusV1 =
  (typeof JOURNEY_LLM_USAGE_STATUSES_V1)[number];

declare const journeyIdV1Brand: unique symbol;
/** A canonical UUID v4 generated only for telemetry correlation. */
export type JourneyIdV1 = string & {
  readonly [journeyIdV1Brand]: "JourneyIdV1";
};

export interface JourneyLlmUsageV1 {
  readonly usage_status: JourneyLlmUsageStatusV1;
  readonly provider: JourneyLlmProviderV1;
  readonly model: JourneyLlmModelV1;
  /** Provider round-trip duration, distinct from enclosing stage latency. */
  readonly provider_latency_ms: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  /** Provider total when supplied, otherwise normalized input plus output. */
  readonly total_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly finish_reason: JourneyLlmFinishReasonV1;
}

export interface JourneyLlmUsageInputV1 {
  readonly usage_status?: JourneyLlmUsageStatusV1;
  readonly provider: JourneyLlmProviderV1;
  readonly model: JourneyLlmModelV1;
  readonly provider_latency_ms: number;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly total_tokens?: number | null;
  readonly cached_input_tokens?: number | null;
  readonly reasoning_tokens?: number | null;
  readonly finish_reason: JourneyLlmFinishReasonV1;
}

export interface JourneyRetrievalCountersV1 {
  readonly planned_query_count: number | null;
  readonly query_hit_count: number | null;
  readonly released_atom_count: number | null;
  readonly context_atom_count: number | null;
  readonly citation_count: number | null;
}

export interface JourneyRetrievalCountersInputV1 {
  readonly planned_query_count?: number | null;
  readonly query_hit_count?: number | null;
  readonly released_atom_count?: number | null;
  readonly context_atom_count?: number | null;
  readonly citation_count?: number | null;
}

/** Immutable context supplied by trusted composition once for the whole journey. */
export interface JourneyTelemetryContextInputV1 {
  readonly environment: JourneyEnvironmentV1;
  readonly workflow: JourneyWorkflowV1;
  /** Deploy artifact identity, never a business or Authority release ID. */
  readonly release_sha?: string | null;
  readonly build_number?: number | null;
}

export interface JourneyTelemetryContextV1 {
  readonly environment: JourneyEnvironmentV1;
  readonly workflow: JourneyWorkflowV1;
  readonly release_sha: string | null;
  readonly build_number: number | null;
}

/** Only stage-local fields are accepted after a journey has started. */
export interface JourneyStageEventInputV1 {
  readonly stage: JourneyStageV1;
  readonly event: JourneyEventV1;
  readonly outcome?: JourneyOutcomeV1 | null;
  readonly failure_class?: JourneyFailureClassV1 | null;
  readonly retryable?: boolean | null;
  readonly attempt?: number;
  readonly elapsed_ms: number;
  readonly queue_age_ms?: number | null;
  readonly retrieval?: JourneyRetrievalCountersInputV1 | null;
  readonly llm_usage?: JourneyLlmUsageInputV1 | null;
}

export interface JourneyTelemetryEventV1 extends JourneyTelemetryContextV1 {
  readonly schema_version: typeof JOURNEY_TELEMETRY_SCHEMA_VERSION_V1;
  readonly kind: typeof JOURNEY_TELEMETRY_KIND_V1;
  readonly observed_at: string;
  readonly journey_id: JourneyIdV1;
  /** Monotonic within an emitter; callers provide the prior value when resuming. */
  readonly sequence: number;
  readonly stage: JourneyStageV1;
  readonly event: JourneyEventV1;
  readonly outcome: JourneyOutcomeV1 | null;
  readonly failure_class: JourneyFailureClassV1 | null;
  readonly retryable: boolean | null;
  readonly attempt: number;
  readonly elapsed_ms: number;
  readonly queue_age_ms: number | null;
  readonly retrieval: JourneyRetrievalCountersV1 | null;
  readonly llm_usage: JourneyLlmUsageV1 | null;
}

export type JourneyTelemetryObserverV1 = (
  event: JourneyTelemetryEventV1,
) => void | Promise<void>;

export interface JourneyTelemetryDependenciesV1 {
  readonly now?: () => string;
  readonly create_uuid?: () => string;
}

export interface JourneyTelemetryJourneyV1 {
  readonly journey_id: JourneyIdV1;
  /** Fail-open production API. Invalid telemetry returns null. */
  emit(input: JourneyStageEventInputV1): JourneyTelemetryEventV1 | null;
}

export interface JourneyTelemetryV1 {
  startJourney(context: JourneyTelemetryContextInputV1): JourneyTelemetryJourneyV1 | null;
  resumeJourney(input: JourneyTelemetryContextInputV1 & {
    readonly journey_id: string;
    readonly previous_sequence: number;
  }): JourneyTelemetryJourneyV1 | null;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_DURATION_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_ATTEMPT = 100;
const LLM_STAGES = new Set<JourneyStageV1>([
  "ask_planner",
  "ask_answer",
  "meeting_extraction",
]);
const ASK_COUNT_STAGES = new Set<JourneyStageV1>([
  "ask_planner",
  "ask_retrieval",
  "ask_context",
  "ask_answer",
  "ask_audit",
  "ask_response",
]);
const STAGES_BY_WORKFLOW = Object.freeze({
    ask: Object.freeze([
      "ask_validation",
      "ask_authorization",
      "ask_planner",
      "ask_retrieval",
      "ask_context",
      "ask_answer",
      "ask_revalidation",
      "ask_audit",
      "ask_response",
    ] as const),
    meeting_approval: Object.freeze([
      "meeting_source_intake",
      "meeting_extraction",
      "meeting_candidate_persist",
      "meeting_approval_staging",
      "meeting_approval_action_verify",
      "meeting_approval_action_queue",
      "meeting_terminal_persist",
      "meeting_record_append",
      "meeting_search_publication",
    ] as const),
  } satisfies Readonly<Record<JourneyWorkflowV1, readonly JourneyStageV1[]>>);
const TERMINAL_OUTCOMES = Object.freeze({
    ask_response: Object.freeze([
      "answered",
      "insufficient_evidence",
      "authorship_unsupported",
      "completed",
    ] as const),
    meeting_candidate_persist: Object.freeze(["actionable", "no_signals", "coalesced"] as const),
    meeting_approval_staging: Object.freeze([
      "staged",
      "delivery_pending",
      "quarantined",
    ] as const),
    meeting_terminal_persist: Object.freeze(["approved", "rejected", "denied"] as const),
    meeting_search_publication: Object.freeze(["current", "published", "superseded"] as const),
  } satisfies Readonly<Partial<Record<JourneyStageV1, readonly JourneyOutcomeV1[]>>>);

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function invalid(message: string): never {
  throw new TypeError(`invalid journey telemetry: ${message}`);
}

function nullableReleaseSha(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !GIT_COMMIT_SHA.test(value)) {
    invalid("release_sha is not a canonical Git commit SHA");
  }
  return value;
}

function nullableCount(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function nullableDuration(value: unknown, name: string): number | null {
  const normalized = nullableCount(value, name);
  if (normalized !== null && normalized > MAX_DURATION_MS) invalid(`${name} is invalid`);
  return normalized;
}

function nullableBuildNumber(value: unknown): number | null {
  const normalized = nullableCount(value, "build_number");
  if (normalized === 0) invalid("build_number is invalid");
  return normalized;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") invalid("observed_at is invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid("observed_at is not canonical ISO UTC");
  }
  return value;
}

function validSequence(value: unknown, name: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function normalizeContext(input: JourneyTelemetryContextInputV1): JourneyTelemetryContextV1 {
  if (!includes(JOURNEY_ENVIRONMENTS_V1, input.environment)) invalid("environment is invalid");
  if (!includes(JOURNEY_WORKFLOWS_V1, input.workflow)) invalid("workflow is invalid");
  return Object.freeze({
    environment: input.environment,
    workflow: input.workflow,
    release_sha: nullableReleaseSha(input.release_sha),
    build_number: nullableBuildNumber(input.build_number),
  });
}

function normalizeRetrieval(
  input: JourneyRetrievalCountersInputV1 | null | undefined,
): JourneyRetrievalCountersV1 | null {
  if (input === undefined || input === null) return null;
  return Object.freeze({
    planned_query_count: nullableCount(input.planned_query_count, "planned_query_count"),
    query_hit_count: nullableCount(input.query_hit_count, "query_hit_count"),
    released_atom_count: nullableCount(input.released_atom_count, "released_atom_count"),
    context_atom_count: nullableCount(input.context_atom_count, "context_atom_count"),
    citation_count: nullableCount(input.citation_count, "citation_count"),
  });
}

/** Returns null rather than exposing malformed or non-telemetry IDs. */
export function parseJourneyIdV1(value: string): JourneyIdV1 | null {
  return typeof value === "string" && UUID_V4.test(value) ? (value as JourneyIdV1) : null;
}

/** Strict constructor. The fail-open API below catches its errors for product code. */
export function createJourneyIdV1(createUuid: () => string = randomUUID): JourneyIdV1 {
  const journeyId = parseJourneyIdV1(createUuid());
  if (journeyId === null) invalid("create_uuid did not return a UUID v4");
  return journeyId;
}

function normalizeLlmUsage(input: JourneyLlmUsageInputV1): JourneyLlmUsageV1 {
  const provider = input.provider;
  const model = input.model;
  const finishReason = input.finish_reason;
  const providerLatency = nullableDuration(
    input.provider_latency_ms,
    "llm provider_latency_ms",
  );
  const inputTokens = nullableCount(input.input_tokens, "llm input_tokens");
  const outputTokens = nullableCount(input.output_tokens, "llm output_tokens");
  const reportedTotal = nullableCount(input.total_tokens, "llm total_tokens");
  const cachedInputTokens = nullableCount(input.cached_input_tokens, "llm cached_input_tokens");
  const reasoningTokens = nullableCount(input.reasoning_tokens, "llm reasoning_tokens");
  const hasReportedUsage =
    inputTokens !== null ||
    outputTokens !== null ||
    reportedTotal !== null ||
    cachedInputTokens !== null ||
    reasoningTokens !== null;
  const usageStatus = input.usage_status ?? (hasReportedUsage ? "reported" : "unavailable");
  if (!includes(JOURNEY_LLM_PROVIDERS_V1, provider)) {
    invalid("llm provider is invalid");
  }
  if (!includes(JOURNEY_LLM_MODELS_V1, model)) {
    invalid("llm model is invalid");
  }
  if (!includes(JOURNEY_LLM_FINISH_REASONS_V1, finishReason)) {
    invalid("llm finish_reason is invalid");
  }
  if (providerLatency === null) invalid("llm provider_latency_ms is required");
  if (!includes(JOURNEY_LLM_USAGE_STATUSES_V1, usageStatus)) invalid("llm usage_status is invalid");
  if (usageStatus === "unavailable" && hasReportedUsage) {
    invalid("unavailable llm usage cannot include token counts");
  }
  if (usageStatus === "reported" && !hasReportedUsage) {
    invalid("reported llm usage requires at least one token count");
  }
  const totalTokens =
    reportedTotal ??
    (inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens);
  if (totalTokens !== null && !Number.isSafeInteger(totalTokens)) invalid("llm total_tokens is invalid");
  return Object.freeze({
    usage_status: usageStatus,
    provider,
    model,
    provider_latency_ms: providerLatency,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedInputTokens,
    reasoning_tokens: reasoningTokens,
    finish_reason: finishReason,
  });
}

function normalizeOutcome(
  stage: JourneyStageV1,
  event: JourneyEventV1,
  outcome: JourneyOutcomeV1 | null,
): JourneyOutcomeV1 | null {
  if (outcome !== null && !includes(JOURNEY_OUTCOMES_V1, outcome)) invalid("outcome is invalid");
  if (event === "skipped") {
    if (outcome !== "skipped") invalid("skipped outcome is invalid");
    return outcome;
  }
  if (event !== "succeeded") {
    if (outcome !== null) invalid("non-succeeded outcome must be null");
    return null;
  }
  const allowed = (
    TERMINAL_OUTCOMES as Readonly<
      Partial<Record<JourneyStageV1, readonly JourneyOutcomeV1[]>>
    >
  )[stage];
  if (allowed === undefined) {
    if (outcome !== null) invalid("intermediate outcome must be null");
    return null;
  }
  if (outcome === null || !allowed.includes(outcome)) invalid("stage outcome is invalid");
  return outcome;
}

/**
 * Strict constructor for contract tests and adapters. It reconstructs an exact
 * allowlisted object, dropping unknown fields at every level.
 */
export function createJourneyTelemetryEventV1(input: {
  readonly journey_id: string;
  readonly sequence: number;
  readonly observed_at: string;
  readonly context: JourneyTelemetryContextInputV1;
  readonly event: JourneyStageEventInputV1;
}): JourneyTelemetryEventV1 {
  const journeyId = parseJourneyIdV1(input.journey_id);
  if (journeyId === null) invalid("journey_id is not a UUID v4");
  const context = normalizeContext(input.context);
  const stage = input.event.stage;
  if (!includes(JOURNEY_STAGES_V1, stage)) invalid("stage is invalid");
  const workflowStages = STAGES_BY_WORKFLOW[
    context.workflow
  ] as readonly JourneyStageV1[];
  if (!workflowStages.includes(stage)) {
    invalid("stage does not belong to workflow");
  }
  if (!includes(JOURNEY_EVENTS_V1, input.event.event)) invalid("event is invalid");
  const event = input.event.event;
  const outcome = normalizeOutcome(stage, event, input.event.outcome ?? null);
  const failureClass = input.event.failure_class ?? null;
  const retryable = input.event.retryable ?? null;
  if (event === "failed") {
    if (!includes(JOURNEY_FAILURE_CLASSES_V1, failureClass)) invalid("failed failure_class is invalid");
    if (typeof retryable !== "boolean") invalid("failed retryable is invalid");
  } else if (failureClass !== null || retryable !== null) {
    invalid("non-failed failure fields must be null");
  }
  const isLlmStage = LLM_STAGES.has(stage);
  const hasLlmUsage = input.event.llm_usage !== undefined && input.event.llm_usage !== null;
  if (isLlmStage && (event === "succeeded" || event === "failed") && !hasLlmUsage) {
    invalid("llm_usage is required for a closed LLM stage");
  }
  if ((!isLlmStage || event === "started" || event === "skipped") && hasLlmUsage) {
    invalid("llm_usage is not allowed for this stage event");
  }
  const llmUsage = hasLlmUsage ? normalizeLlmUsage(input.event.llm_usage!) : null;
  const retrieval = normalizeRetrieval(input.event.retrieval);
  if (retrieval !== null && (!ASK_COUNT_STAGES.has(stage) || event !== "succeeded")) {
    invalid("Ask counters are not allowed for this stage event");
  }
  const elapsed = nullableDuration(input.event.elapsed_ms, "elapsed_ms");
  if (elapsed === null || ((event === "started" || event === "skipped") && elapsed !== 0)) {
    invalid("elapsed_ms is invalid for event");
  }
  return Object.freeze({
    schema_version: JOURNEY_TELEMETRY_SCHEMA_VERSION_V1,
    kind: JOURNEY_TELEMETRY_KIND_V1,
    observed_at: timestamp(input.observed_at),
    journey_id: journeyId,
    sequence: validSequence(input.sequence, "sequence", 1),
    ...context,
    stage,
    event,
    outcome,
    failure_class: failureClass,
    retryable,
    attempt: (() => {
      const value = validSequence(input.event.attempt ?? 1, "attempt", 1);
      if (value > MAX_ATTEMPT) invalid("attempt is invalid");
      return value;
    })(),
    elapsed_ms: elapsed,
    queue_age_ms: nullableDuration(input.event.queue_age_ms, "queue_age_ms"),
    retrieval,
    llm_usage: llmUsage,
  });
}

function recanonicalizeJourneyTelemetryEventV1(event: JourneyTelemetryEventV1): JourneyTelemetryEventV1 {
  return createJourneyTelemetryEventV1({
    journey_id: event.journey_id,
    sequence: event.sequence,
    observed_at: event.observed_at,
    context: {
      environment: event.environment,
      workflow: event.workflow,
      release_sha: event.release_sha,
      build_number: event.build_number,
    },
    event: {
      stage: event.stage,
      event: event.event,
      outcome: event.outcome,
      failure_class: event.failure_class,
      retryable: event.retryable,
      attempt: event.attempt,
      elapsed_ms: event.elapsed_ms,
      queue_age_ms: event.queue_age_ms,
      retrieval: event.retrieval,
      llm_usage: event.llm_usage,
    },
  });
}

/** Observer delivery is deliberately outside application control flow. */
export function observeJourneyTelemetryBestEffortV1(
  observer: JourneyTelemetryObserverV1 | undefined,
  event: JourneyTelemetryEventV1,
): void {
  if (observer === undefined) return;
  void Promise.resolve()
    .then(() => observer(recanonicalizeJourneyTelemetryEventV1(event)))
    .catch(() => undefined);
}

function createJourneyEmitter(
  journeyId: JourneyIdV1,
  previousSequence: number,
  context: JourneyTelemetryContextV1,
  now: () => string,
  observer: JourneyTelemetryObserverV1 | undefined,
): JourneyTelemetryJourneyV1 {
  let currentSequence = previousSequence;
  return Object.freeze({
    journey_id: journeyId,
    emit(input: JourneyStageEventInputV1): JourneyTelemetryEventV1 | null {
      try {
        if (currentSequence >= Number.MAX_SAFE_INTEGER) invalid("sequence exhausted");
        const event = createJourneyTelemetryEventV1({
          journey_id: journeyId,
          sequence: currentSequence + 1,
          observed_at: now(),
          context,
          event: input,
        });
        currentSequence = event.sequence;
        observeJourneyTelemetryBestEffortV1(observer, event);
        return event;
      } catch {
        return null;
      }
    },
  });
}

/**
 * Creates request-local, fail-open emitters. It has no durable state: an async
 * journey resumes with the prior sequence supplied by its durable caller.
 */
export function createJourneyTelemetryV1(
  observer: JourneyTelemetryObserverV1 | undefined,
  dependencies: JourneyTelemetryDependenciesV1 = {},
): JourneyTelemetryV1 {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const createUuid = dependencies.create_uuid ?? randomUUID;
  return Object.freeze({
    startJourney(context: JourneyTelemetryContextInputV1): JourneyTelemetryJourneyV1 | null {
      try {
        return createJourneyEmitter(createJourneyIdV1(createUuid), 0, normalizeContext(context), now, observer);
      } catch {
        return null;
      }
    },
    resumeJourney(input: JourneyTelemetryContextInputV1 & {
      readonly journey_id: string;
      readonly previous_sequence: number;
    }): JourneyTelemetryJourneyV1 | null {
      try {
        const journeyId = parseJourneyIdV1(input.journey_id);
        if (journeyId === null) invalid("journey_id is not a UUID v4");
        const previousSequence = validSequence(input.previous_sequence, "previous_sequence", 0);
        return createJourneyEmitter(journeyId, previousSequence, normalizeContext(input), now, observer);
      } catch {
        return null;
      }
    },
  });
}
