import { RetrievalGroundedAnswerCompositionError } from "../answer-composition/retrieval-grounded-answer-composition.js";
import type {
  AnswerCompositionGenerationObservationV1,
  AnswerCompositionStageObservationV1,
} from "../answer-composition/retrieval-grounded-answer-composition.js";
import { AuthorityOperationError } from "../domain/errors.js";
import {
  createJourneyTelemetryV1,
  JOURNEY_LLM_MODELS_V1,
  type JourneyFailureClassV1,
  type JourneyLlmFinishReasonV1,
  type JourneyLlmModelV1,
  type JourneyLlmProviderV1,
  type JourneyLlmUsageInputV1,
  type JourneyOutcomeV1,
  type JourneyRetrievalCountersInputV1,
  type JourneyStageEventInputV1,
  type JourneyStageV1,
  type JourneyTelemetryDependenciesV1,
  type JourneyTelemetryObserverV1,
} from "../shared/journey-telemetry-v1.js";

type AskJourneyStageV1 = Extract<JourneyStageV1, `ask_${string}`>;
type AskJourneyOutcomeV1 = Extract<
  JourneyOutcomeV1,
  | "answered"
  | "insufficient_evidence"
  | "authorship_unsupported"
  | "completed"
>;

const ASK_STAGES_V1: readonly AskJourneyStageV1[] = Object.freeze([
  "ask_validation",
  "ask_authorization",
  "ask_planner",
  "ask_retrieval",
  "ask_context",
  "ask_answer",
  "ask_revalidation",
  "ask_audit",
  "ask_response",
]);

export interface AskJourneyFailureV1 {
  readonly failure_class: JourneyFailureClassV1;
  readonly retryable: boolean;
}

export interface AskJourneyTelemetryFactoryV1 {
  start(): AskJourneyTelemetryRecorderV1;
}

export interface AskJourneyTelemetryRecorderV1 {
  readonly journey_id: string | null;
  startTimer(): number;
  succeed(
    stage: Exclude<AskJourneyStageV1, "ask_response">,
    started_at_ms: number,
    retrieval?: JourneyRetrievalCountersInputV1,
  ): void;
  fail(
    stage: Exclude<AskJourneyStageV1, "ask_response">,
    started_at_ms: number,
    failure: AskJourneyFailureV1,
  ): void;
  skip(stage: Exclude<AskJourneyStageV1, "ask_response">): void;
  observeComposition(event: AnswerCompositionStageObservationV1): void;
  complete(
    outcome: AskJourneyOutcomeV1,
    started_at_ms: number,
  ): void;
  terminate(error: unknown, started_at_ms: number): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusFailure(status: number | null): AskJourneyFailureV1 {
  if (status === 408) return { failure_class: "timeout", retryable: true };
  if (status === 429)
    return { failure_class: "rate_limited", retryable: true };
  if (status !== null && status >= 500)
    return { failure_class: "unavailable", retryable: true };
  return { failure_class: "provider_rejected", retryable: false };
}

function compositionFailure(
  event: AnswerCompositionStageObservationV1,
): AskJourneyFailureV1 {
  switch (event.failure_class) {
    case "adapter_timeout":
      return { failure_class: "timeout", retryable: true };
    case "adapter_transport":
      return { failure_class: "unavailable", retryable: true };
    case "adapter_http":
    case "adapter_provider_error":
      return statusFailure(event.http_status);
    case "adapter_finish":
    case "adapter_refusal":
      return { failure_class: "provider_rejected", retryable: false };
    case "adapter_response":
    case "adapter_json":
    case "core_validation":
      return { failure_class: "invalid_contract", retryable: false };
    case "audit_failure":
      return { failure_class: "unavailable", retryable: true };
    case "cancelled":
      return { failure_class: "cancelled", retryable: false };
    case null:
      return { failure_class: "unknown", retryable: false };
  }
}

export function classifyAskJourneyFailureV1(
  error: unknown,
): AskJourneyFailureV1 {
  if (error instanceof RetrievalGroundedAnswerCompositionError) {
    return { failure_class: "invalid_contract", retryable: false };
  }
  if (error instanceof AuthorityOperationError) {
    switch (error.code) {
      case "invalid_request":
        return { failure_class: "invalid_request", retryable: false };
      case "unauthorized":
      case "stale_access_state":
        return { failure_class: "authorization", retryable: false };
      case "rate_limited":
        return { failure_class: "rate_limited", retryable: true };
      case "unavailable":
        return { failure_class: "unavailable", retryable: true };
      case "conflict":
      case "not_found":
        return { failure_class: "unknown", retryable: false };
    }
  }
  try {
    const diagnostic = record(record(error)?.diagnostic);
    const failureClass = diagnostic?.failure_class;
    const httpStatus = diagnostic?.http_status;
    if (failureClass === "adapter_timeout")
      return { failure_class: "timeout", retryable: true };
    if (failureClass === "adapter_transport")
      return { failure_class: "unavailable", retryable: true };
    if (
      failureClass === "adapter_http" ||
      failureClass === "adapter_provider_error"
    ) {
      return statusFailure(
        typeof httpStatus === "number" && Number.isSafeInteger(httpStatus)
          ? httpStatus
          : null,
      );
    }
    if (failureClass === "adapter_finish" || failureClass === "adapter_refusal")
      return { failure_class: "provider_rejected", retryable: false };
    if (
      failureClass === "adapter_response" ||
      failureClass === "adapter_json" ||
      failureClass === "core_validation"
    ) {
      return { failure_class: "invalid_contract", retryable: false };
    }
    if (error instanceof Error && error.name === "AbortError")
      return { failure_class: "cancelled", retryable: false };
    if (error instanceof Error && error.name === "TimeoutError")
      return { failure_class: "timeout", retryable: true };
  } catch {
    // Untrusted error properties never enter telemetry control flow.
  }
  return { failure_class: "unknown", retryable: false };
}

function provider(value: string): JourneyLlmProviderV1 {
  switch (value) {
    case "openrouter":
    case "openai":
    case "anthropic":
    case "ollama":
      return value;
    default:
      return "other";
  }
}

function requiredModel(value: JourneyLlmModelV1): JourneyLlmModelV1 {
  if (!JOURNEY_LLM_MODELS_V1.includes(value)) {
    throw new TypeError("Ask journey telemetry model is not allowlisted");
  }
  return value;
}

function finishReason(
  value: AnswerCompositionGenerationObservationV1["finish_reason"],
): JourneyLlmFinishReasonV1 {
  switch (value) {
    case "stop":
    case "length":
    case "content_filter":
      return value;
    default:
      return "unknown";
  }
}

function llmUsage(
  value: AnswerCompositionGenerationObservationV1 | null,
  configuredModel: JourneyLlmModelV1,
  elapsedMs: number,
): JourneyLlmUsageInputV1 {
  const matchingValue = value?.model === configuredModel ? value : null;
  const reported = [
    matchingValue?.input_tokens ?? null,
    matchingValue?.output_tokens ?? null,
    matchingValue?.total_tokens ?? null,
    matchingValue?.cached_input_tokens ?? null,
    matchingValue?.reasoning_tokens ?? null,
  ].some((part) => part !== null);
  return Object.freeze({
    usage_status: reported ? "reported" : "unavailable",
    provider: provider(matchingValue?.adapter_id ?? "other"),
    model: configuredModel,
    provider_latency_ms: matchingValue?.provider_latency_ms ?? elapsedMs,
    input_tokens: matchingValue?.input_tokens ?? null,
    output_tokens: matchingValue?.output_tokens ?? null,
    total_tokens: matchingValue?.total_tokens ?? null,
    cached_input_tokens: matchingValue?.cached_input_tokens ?? null,
    reasoning_tokens: matchingValue?.reasoning_tokens ?? null,
    finish_reason: finishReason(matchingValue?.finish_reason ?? null),
  });
}

/** Creates staging-only request-local recorders over the Phase 0 contract. */
export function createAskJourneyTelemetryFactoryV1(input: {
  readonly observer: JourneyTelemetryObserverV1;
  readonly release_sha: string;
  readonly build_number: number;
  readonly planner_model: JourneyLlmModelV1;
  readonly answer_model: JourneyLlmModelV1;
  readonly clock?: JourneyTelemetryDependenciesV1;
  readonly now_ms?: () => number;
}): AskJourneyTelemetryFactoryV1 {
  const telemetry = createJourneyTelemetryV1(input.observer, input.clock);
  const nowMs = input.now_ms ?? (() => performance.now());
  const plannerModel = requiredModel(input.planner_model);
  const answerModel = requiredModel(input.answer_model);

  return Object.freeze({
    start(): AskJourneyTelemetryRecorderV1 {
      const journey = telemetry.startJourney({
        environment: "staging",
        workflow: "ask",
        release_sha: input.release_sha,
        build_number: input.build_number,
      });
      const closed = new Set<AskJourneyStageV1>();
      let lastFailure: AskJourneyFailureV1 | null = null;
      const counters: Partial<
        Record<keyof JourneyRetrievalCountersInputV1, number>
      > = {};

      function safeNow(): number {
        try {
          const value = nowMs();
          return Number.isFinite(value) ? value : 0;
        } catch {
          return 0;
        }
      }

      function elapsed(startedAt: number): number {
        return Math.max(0, Math.round(safeNow() - startedAt));
      }

      function rememberCounters(
        value: JourneyRetrievalCountersInputV1 | null | undefined,
      ): void {
        if (value === undefined || value === null) return;
        for (const key of [
          "planned_query_count",
          "query_hit_count",
          "released_atom_count",
          "context_atom_count",
          "citation_count",
        ] as const) {
          const count = value[key];
          if (typeof count === "number") counters[key] = count;
        }
      }

      function emit(
        stage: AskJourneyStageV1,
        event: Omit<JourneyStageEventInputV1, "stage">,
      ): void {
        if (closed.has(stage)) return;
        closed.add(stage);
        try {
          journey?.emit({ stage, ...event });
        } catch {
          // The shared emitter is fail-open; this guard protects foreign mocks.
        }
      }

      function skipMissing(): void {
        for (const stage of ASK_STAGES_V1) {
          if (stage === "ask_response" || closed.has(stage)) continue;
          emit(stage, {
            event: "skipped",
            outcome: "skipped",
            elapsed_ms: 0,
          });
        }
      }

      const recorder: AskJourneyTelemetryRecorderV1 = {
        journey_id: journey?.journey_id ?? null,
        startTimer: safeNow,
        succeed(stage, startedAt, retrieval) {
          rememberCounters(retrieval);
          emit(stage, {
            event: "succeeded",
            elapsed_ms: elapsed(startedAt),
            ...(retrieval === undefined ? {} : { retrieval }),
          });
        },
        fail(stage, startedAt, failure) {
          lastFailure = failure;
          emit(stage, {
            event: "failed",
            failure_class: failure.failure_class,
            retryable: failure.retryable,
            elapsed_ms: elapsed(startedAt),
          });
        },
        skip(stage) {
          emit(stage, {
            event: "skipped",
            outcome: "skipped",
            elapsed_ms: 0,
          });
        },
        observeComposition(event) {
          const stage = `ask_${event.stage}` as Exclude<
            AskJourneyStageV1,
            "ask_response"
          >;
          if (event.event === "skipped") {
            recorder.skip(stage);
            return;
          }
          if (event.event === "failed") {
            const failure = compositionFailure(event);
            lastFailure = failure;
            const observedLlmUsage =
              event.stage === "planner"
                ? llmUsage(
                    event.generation_usage,
                    plannerModel,
                    event.elapsed_ms,
                  )
                : event.stage === "answer"
                  ? llmUsage(
                      event.generation_usage,
                      answerModel,
                      event.elapsed_ms,
                    )
                  : null;
            emit(stage, {
              event: "failed",
              failure_class: failure.failure_class,
              retryable: failure.retryable,
              elapsed_ms: event.elapsed_ms,
              ...(observedLlmUsage === null
                ? {}
                : { llm_usage: observedLlmUsage }),
            });
            return;
          }
          rememberCounters(event.retrieval);
          const observedLlmUsage =
            event.stage === "planner"
              ? llmUsage(
                  event.generation_usage,
                  plannerModel,
                  event.elapsed_ms,
                )
              : event.stage === "answer"
                ? llmUsage(
                    event.generation_usage,
                    answerModel,
                    event.elapsed_ms,
                  )
                : null;
          emit(stage, {
            event: "succeeded",
            elapsed_ms: event.elapsed_ms,
            ...(event.retrieval === null
              ? {}
              : { retrieval: event.retrieval }),
            ...(observedLlmUsage === null
              ? {}
              : { llm_usage: observedLlmUsage }),
          });
        },
        complete(outcome, startedAt) {
          skipMissing();
          emit("ask_response", {
            event: "succeeded",
            outcome,
            elapsed_ms: elapsed(startedAt),
            retrieval: Object.freeze({ ...counters }),
          });
        },
        terminate(error, startedAt) {
          skipMissing();
          const failure = lastFailure ?? classifyAskJourneyFailureV1(error);
          emit("ask_response", {
            event: "failed",
            failure_class: failure.failure_class,
            retryable: failure.retryable,
            elapsed_ms: elapsed(startedAt),
          });
        },
      };
      return Object.freeze(recorder);
    },
  });
}
