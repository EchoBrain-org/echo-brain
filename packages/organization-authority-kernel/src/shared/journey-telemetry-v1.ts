import { normalizeCoreRuntimeDetailV1, type CoreRuntimeDetailV1 } from "./core-runtime-observation-v1.js";
import {
  createTelemetryVocabularyV1,
  EMPTY_TELEMETRY_VOCABULARY_V1,
  type TelemetryVocabularyV1,
} from "./telemetry-vocabulary-v1.js";

/** Content-free operational event emitted by the sole live Authority producer. */
export const JOURNEY_TELEMETRY_SCHEMA_VERSION_V1 = 2 as const;
export const JOURNEY_TELEMETRY_KIND_V1 = "echo-authority-journey-stage-v1" as const;

export const JOURNEY_ENVIRONMENTS_V1 = Object.freeze(["staging", "production"] as const);
export type JourneyEnvironmentV1 = (typeof JOURNEY_ENVIRONMENTS_V1)[number];
export const JOURNEY_WORKFLOWS_V1 = Object.freeze(["core_runtime"] as const);
export type JourneyWorkflowV1 = (typeof JOURNEY_WORKFLOWS_V1)[number];
export const JOURNEY_STAGES_V1 = Object.freeze(["core_operation"] as const);
export type JourneyStageV1 = (typeof JOURNEY_STAGES_V1)[number];
export const JOURNEY_EVENTS_V1 = Object.freeze(["started", "succeeded", "failed"] as const);
export type JourneyEventV1 = (typeof JOURNEY_EVENTS_V1)[number];
export const JOURNEY_FAILURE_CLASSES_V1 = Object.freeze([
  "authorization",
  "invalid_request",
  "invalid_contract",
  "rate_limited",
  "timeout",
  "unavailable",
  "cancelled",
  "provider_rejected",
  "unknown",
] as const);
export type JourneyFailureClassV1 = (typeof JOURNEY_FAILURE_CLASSES_V1)[number];

declare const journeyIdV1Brand: unique symbol;
export type JourneyIdV1 = string & { readonly [journeyIdV1Brand]: "JourneyIdV1" };

export interface JourneyTelemetryContextInputV1 {
  readonly environment: JourneyEnvironmentV1;
  readonly workflow: JourneyWorkflowV1;
  readonly release_sha: string;
  readonly build_number: number;
}

export type JourneyTelemetryContextV1 = JourneyTelemetryContextInputV1;

export interface JourneyStageEventInputV1 {
  readonly stage: JourneyStageV1;
  readonly event: JourneyEventV1;
  readonly elapsed_ms: number;
  readonly diagnostic: CoreRuntimeDetailV1;
  readonly failure_class?: JourneyFailureClassV1 | null;
  readonly retryable?: boolean | null;
}

export interface JourneyTelemetryEventV1 extends JourneyTelemetryContextV1 {
  readonly schema_version: typeof JOURNEY_TELEMETRY_SCHEMA_VERSION_V1;
  readonly kind: typeof JOURNEY_TELEMETRY_KIND_V1;
  readonly observed_at: string;
  readonly journey_id: JourneyIdV1;
  readonly sequence: number;
  readonly stage: JourneyStageV1;
  readonly event: JourneyEventV1;
  /** Preserved null fields keep the live core record shape compatible with existing queries. */
  readonly outcome: null;
  readonly failure_class: JourneyFailureClassV1 | null;
  readonly retryable: boolean | null;
  readonly attempt: 1;
  readonly elapsed_ms: number;
  readonly queue_age_ms: null;
  readonly retrieval: null;
  readonly llm_usage: null;
  readonly diagnostic: CoreRuntimeDetailV1;
}

export type JourneyTelemetryObserverV1 = (event: JourneyTelemetryEventV1) => void | Promise<void>;

export interface JourneyTelemetryDependenciesV1 {
  readonly now?: () => string;
}

export interface JourneyTelemetryJourneyV1 {
  readonly journey_id: JourneyIdV1;
  emit(input: JourneyStageEventInputV1): JourneyTelemetryEventV1 | null;
}

export interface JourneyTelemetryV1 {
  resumeJourney(input: JourneyTelemetryContextInputV1 & {
    readonly journey_id: string;
    readonly previous_sequence: number;
  }): JourneyTelemetryJourneyV1 | null;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_MACHINE_DURATION_MS = 31 * 24 * 60 * 60 * 1_000;

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function invalid(message: string): never {
  throw new TypeError(`invalid journey telemetry: ${message}`);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") invalid("observed_at is invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid("observed_at is not canonical ISO UTC");
  }
  return value;
}

function positiveInteger(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function duration(value: unknown, name: string): number {
  const normalized = positiveInteger(value, name, 0);
  if (normalized > MAX_MACHINE_DURATION_MS) invalid(`${name} is invalid`);
  return normalized;
}

function normalizeContext(input: JourneyTelemetryContextInputV1): JourneyTelemetryContextV1 {
  if (!includes(JOURNEY_ENVIRONMENTS_V1, input.environment)) invalid("environment is invalid");
  if (input.workflow !== "core_runtime") invalid("workflow is invalid");
  if (typeof input.release_sha !== "string" || !GIT_COMMIT_SHA.test(input.release_sha)) {
    invalid("release_sha is invalid");
  }
  if (typeof input.build_number !== "number" || !Number.isSafeInteger(input.build_number) || input.build_number < 1) {
    invalid("build_number is invalid");
  }
  return Object.freeze({
    environment: input.environment,
    workflow: "core_runtime",
    release_sha: input.release_sha,
    build_number: input.build_number,
  });
}

export function parseJourneyIdV1(value: string): JourneyIdV1 | null {
  return typeof value === "string" && UUID_V4.test(value) ? value as JourneyIdV1 : null;
}

/** Rebuilds one exact live core event, dropping unknown fields before it reaches a log writer. */
export function createJourneyTelemetryEventV1(
  input: {
    readonly journey_id: string;
    readonly sequence: number;
    readonly observed_at: string;
    readonly context: JourneyTelemetryContextInputV1;
    readonly event: JourneyStageEventInputV1;
  },
  vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1,
): JourneyTelemetryEventV1 {
  const journeyId = parseJourneyIdV1(input.journey_id);
  if (journeyId === null) invalid("journey_id is not a UUID v4");
  const context = normalizeContext(input.context);
  if (input.event.stage !== "core_operation") invalid("stage is invalid");
  if (!includes(JOURNEY_EVENTS_V1, input.event.event)) invalid("event is invalid");

  const event = input.event.event;
  const failureClass = input.event.failure_class ?? null;
  const retryable = input.event.retryable ?? null;
  if (event === "failed") {
    if (!includes(JOURNEY_FAILURE_CLASSES_V1, failureClass) || typeof retryable !== "boolean") {
      invalid("failed failure fields are invalid");
    }
  } else if (failureClass !== null || retryable !== null) {
    invalid("non-failed failure fields must be null");
  }

  const elapsed = duration(input.event.elapsed_ms, "elapsed_ms");
  if (event === "started" && elapsed !== 0) invalid("elapsed_ms is invalid for event");

  return Object.freeze({
    schema_version: JOURNEY_TELEMETRY_SCHEMA_VERSION_V1,
    kind: JOURNEY_TELEMETRY_KIND_V1,
    observed_at: timestamp(input.observed_at),
    journey_id: journeyId,
    sequence: positiveInteger(input.sequence, "sequence", 1),
    ...context,
    stage: "core_operation",
    event,
    outcome: null,
    failure_class: failureClass,
    retryable,
    attempt: 1,
    elapsed_ms: elapsed,
    queue_age_ms: null,
    retrieval: null,
    llm_usage: null,
    diagnostic: normalizeCoreRuntimeDetailV1(
      input.event.diagnostic,
      createTelemetryVocabularyV1(vocabulary),
    ),
  });
}

export function recanonicalizeJourneyTelemetryEventV1(
  event: JourneyTelemetryEventV1,
  vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1,
): JourneyTelemetryEventV1 {
  return createJourneyTelemetryEventV1({
    journey_id: event.journey_id,
    sequence: event.sequence,
    observed_at: event.observed_at,
    context: event,
    event: {
      stage: event.stage,
      event: event.event,
      elapsed_ms: event.elapsed_ms,
      diagnostic: event.diagnostic,
      ...(event.failure_class === null ? {} : { failure_class: event.failure_class }),
      ...(event.retryable === null ? {} : { retryable: event.retryable }),
    },
  }, vocabulary);
}

export function observeJourneyTelemetryBestEffortV1(
  observer: JourneyTelemetryObserverV1 | undefined,
  event: JourneyTelemetryEventV1,
  vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1,
): void {
  if (observer === undefined) return;
  void Promise.resolve()
    .then(() => observer(recanonicalizeJourneyTelemetryEventV1(event, vocabulary)))
    .catch(() => undefined);
}

function createJourneyEmitter(
  journeyId: JourneyIdV1,
  previousSequence: number,
  context: JourneyTelemetryContextV1,
  now: () => string,
  observer: JourneyTelemetryObserverV1 | undefined,
  vocabulary: TelemetryVocabularyV1,
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
        }, vocabulary);
        currentSequence = event.sequence;
        observeJourneyTelemetryBestEffortV1(observer, event, vocabulary);
        return event;
      } catch {
        return null;
      }
    },
  });
}

/** Creates fail-open, per-operation emitters for the sole live core-runtime log producer. */
export function createJourneyTelemetryV1(
  observer: JourneyTelemetryObserverV1 | undefined,
  dependencies: JourneyTelemetryDependenciesV1 = {},
  vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1,
): JourneyTelemetryV1 {
  const admitted = createTelemetryVocabularyV1(vocabulary);
  const now = dependencies.now ?? (() => new Date().toISOString());
  return Object.freeze({
    resumeJourney(input: JourneyTelemetryContextInputV1 & {
      readonly journey_id: string;
      readonly previous_sequence: number;
    }): JourneyTelemetryJourneyV1 | null {
      try {
        const journeyId = parseJourneyIdV1(input.journey_id);
        if (journeyId === null) invalid("journey_id is not a UUID v4");
        return createJourneyEmitter(
          journeyId,
          positiveInteger(input.previous_sequence, "previous_sequence", 0),
          normalizeContext(input),
          now,
          observer,
          admitted,
        );
      } catch {
        return null;
      }
    },
  });
}
