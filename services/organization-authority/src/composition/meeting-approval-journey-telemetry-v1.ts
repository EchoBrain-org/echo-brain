import { join } from "node:path";
import type { AdapterError } from "../processing/core/contracts/adapter.js";
import { AdapterError as AdapterFailure } from "../processing/core/contracts/adapter.js";
import type { DecisionExtractionGenerationObservation } from "../processing/core/contracts/decision.js";
import { AuthorityOperationError } from "../domain/errors.js";
import {
  createJourneyTelemetryEventV1,
  observeJourneyTelemetryBestEffortV1,
  type JourneyFailureClassV1,
  type JourneyLlmModelV1,
  type JourneyLlmProviderV1,
  type JourneyLlmUsageInputV1,
  type JourneyOutcomeV1,
  type JourneyTelemetryObserverV1,
} from "../shared/journey-telemetry-v1.js";
import {
  openMeetingApprovalJourneyStateV1,
  type MeetingApprovalJourneyStateV1,
} from "./meeting-approval-journey-state-v1.js";
import type {
  MeetingApprovalJourneyClockV1,
  MeetingApprovalJourneyRefV1,
  MeetingApprovalJourneyStageAttemptV1,
  MeetingApprovalJourneyStageFailureV1,
  MeetingApprovalJourneyStageSuccessV1,
  MeetingApprovalJourneyStageV1,
  MeetingApprovalJourneyTelemetryPortV1,
} from "../processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.js";

export const STAGING_MEETING_APPROVAL_JOURNEY_STATE_FILE_V1 =
  "staging-meeting-approval-journeys-v1.sqlite" as const;

const MAX_MACHINE_DURATION_MS = 31 * 24 * 60 * 60 * 1_000;

export interface MeetingApprovalJourneyTelemetryConfigV1 {
  readonly state_directory: string;
  readonly observer: JourneyTelemetryObserverV1;
  readonly release_sha: string;
  readonly build_number: number;
  readonly extraction_provider: JourneyLlmProviderV1;
  readonly extraction_model: JourneyLlmModelV1;
}

export interface MeetingApprovalJourneyTelemetryDependenciesV1 {
  readonly state?: MeetingApprovalJourneyStateV1;
  readonly now?: () => string;
  readonly now_ms?: () => number;
  readonly create_uuid?: () => string;
}

function machineElapsed(started: number, ended: number): number {
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0;
  const value = Math.max(0, Math.floor(ended - started));
  return Number.isSafeInteger(value) && value <= MAX_MACHINE_DURATION_MS
    ? value
    : 0;
}

function classifyFailure(
  error: unknown,
  override: MeetingApprovalJourneyStageFailureV1 = {},
): { readonly failure_class: JourneyFailureClassV1; readonly retryable: boolean } {
  if (
    override.failure_class !== undefined &&
    override.retryable !== undefined
  ) {
    return {
      failure_class: override.failure_class,
      retryable: override.retryable,
    };
  }
  if (error instanceof AdapterFailure) {
    const failure_class = {
      invalid_config: "invalid_contract",
      unauthorized: "authorization",
      rate_limited: "rate_limited",
      temporarily_unavailable: "unavailable",
      permanently_rejected: "provider_rejected",
      timeout: "timeout",
      unknown_outcome: "unknown",
    } as const satisfies Record<
      AdapterError["code"],
      JourneyFailureClassV1
    >;
    return {
      failure_class: failure_class[error.code],
      retryable: error.retryable,
    };
  }
  if (error instanceof AuthorityOperationError) {
    switch (error.code) {
      case "unauthorized":
        return { failure_class: "authorization", retryable: false };
      case "rate_limited":
        return { failure_class: "rate_limited", retryable: true };
      case "unavailable":
        return { failure_class: "unavailable", retryable: true };
      case "invalid_request":
        return { failure_class: "invalid_request", retryable: false };
      case "conflict":
      case "not_found":
      case "stale_access_state":
        return { failure_class: "invalid_contract", retryable: false };
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { failure_class: "cancelled", retryable: false };
  }
  return {
    failure_class: override.failure_class ?? "unknown",
    retryable: override.retryable ?? true,
  };
}

/**
 * Persists only opaque correlation state in a disposable staging sidecar and
 * emits the already-validated shared journey contract. Every public method is
 * fail-open so this object can never become approval control flow.
 */
class MeetingApprovalJourneyTelemetryV1
  implements MeetingApprovalJourneyTelemetryPortV1
{
  private readonly now: () => string;
  private readonly nowMs: () => number;
  /**
   * A reconciliation outcome applies to the exact durable backlog snapshot
   * observed before readable-search work starts. Entries without a span are
   * retained here so an exhausted telemetry attempt budget cannot strand a
   * durable marker forever.
   */
  private readonly awaitingSearchBatches = new WeakMap<
    readonly MeetingApprovalJourneyStageAttemptV1[],
    readonly MeetingApprovalJourneyRefV1[]
  >();

  constructor(
    private readonly config: MeetingApprovalJourneyTelemetryConfigV1,
    private readonly state: MeetingApprovalJourneyStateV1,
    dependencies: Pick<
      MeetingApprovalJourneyTelemetryDependenciesV1,
      "now" | "now_ms"
    > = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.nowMs = dependencies.now_ms ?? (() => performance.now());
    this.recoverInterruptedStages();
  }

  /**
   * The old process cannot tell us whether its in-flight work completed. Close
   * every durable open reservation as an unknown, retryable failure before new
   * work begins. This preserves the event sequence and permits the next
   * invocation to reserve a new attempt.
   */
  private recoverInterruptedStages(): void {
    try {
      for (const open of this.state.listOpenStages()) {
        try {
          const recovered = this.captureClock();
          const observed_at = new Date(
            Math.max(Date.parse(open.started_at), Date.parse(recovered.observed_at)),
          ).toISOString();
          const reserved = this.state.reserveStageClose(
            open.journey_id,
            open.stage,
            open.attempt,
            "failed",
            observed_at,
          );
          this.emit(open.journey_id, reserved.sequence, observed_at, {
            // State admission has already restricted this row to MEETING_STAGES.
            stage: open.stage as MeetingApprovalJourneyStageV1,
            event: "failed",
            attempt: open.attempt,
            elapsed_ms: 0,
            failure_class: "unknown",
            retryable: true,
            ...(open.stage === "meeting_extraction"
              ? { llm_usage: this.extractionUsage(null, 0) }
              : {}),
          });
        } catch {
          // Continue reconciling independent journeys if one sidecar row is bad.
        }
      }
    } catch {
      // Recovery is telemetry-only and must never prevent service startup.
    }
  }

  captureClock(): MeetingApprovalJourneyClockV1 {
    try {
      const observed_at = this.now();
      const monotonic_ms = this.nowMs();
      if (
        new Date(observed_at).toISOString() !== observed_at ||
        !Number.isFinite(monotonic_ms)
      ) {
        throw new TypeError("invalid journey telemetry clock");
      }
      return Object.freeze({ observed_at, monotonic_ms });
    } catch {
      return Object.freeze({
        observed_at: new Date().toISOString(),
        monotonic_ms: performance.now(),
      });
    }
  }

  beginOrResumeSource(
    input: {
      readonly source_adapter_id: string;
      readonly source_instance_id: string;
      readonly external_id: string;
      readonly canonical_revision: string;
    },
    started: MeetingApprovalJourneyClockV1 = this.captureClock(),
  ): MeetingApprovalJourneyStageAttemptV1 | null {
    try {
      const resumed = this.state.beginOrResumeSource({
        source_identity: JSON.stringify([
          input.source_adapter_id,
          input.source_instance_id,
        ]),
        source_revision: JSON.stringify([
          input.external_id,
          input.canonical_revision,
        ]),
      });
      return this.beginStage(
        { journey_id: resumed.journey_id },
        "meeting_source_intake",
        started,
      );
    } catch {
      return null;
    }
  }

  bindCandidate(
    journey: MeetingApprovalJourneyRefV1,
    input: { readonly candidate_id: string; readonly approval_id: string | null },
  ): void {
    try {
      this.state.bindCandidate(
        journey.journey_id,
        input.candidate_id,
        input.approval_id,
      );
    } catch {
      // Correlation is optional and never weakens candidate persistence.
    }
  }

  readForApproval(approval_id: string): MeetingApprovalJourneyRefV1 | null {
    try {
      const stored = this.state.readForApproval(approval_id);
      return stored === null
        ? null
        : Object.freeze({ journey_id: stored.journey_id });
    } catch {
      return null;
    }
  }

  beginStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
    started: MeetingApprovalJourneyClockV1 = this.captureClock(),
  ): MeetingApprovalJourneyStageAttemptV1 | null {
    try {
      const reserved = this.state.reserveStageStart(
        journey.journey_id,
        stage,
        started.observed_at,
      );
      this.emit(journey.journey_id, reserved.sequence, started.observed_at, {
        stage,
        event: "started",
        attempt: reserved.attempt,
        elapsed_ms: 0,
      });
      return Object.freeze({
        journey_id: journey.journey_id,
        stage,
        attempt: reserved.attempt,
        started,
      });
    } catch {
      return null;
    }
  }

  beginStageForApproval(
    approval_id: string,
    stage: MeetingApprovalJourneyStageV1,
    started?: MeetingApprovalJourneyClockV1,
  ): MeetingApprovalJourneyStageAttemptV1 | null {
    const journey = this.readForApproval(approval_id);
    return journey === null ? null : this.beginStage(journey, stage, started);
  }

  succeedStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    input: MeetingApprovalJourneyStageSuccessV1 = {},
  ): void {
    this.closeSucceededStage(attempt, input);
  }

  succeedExtractionStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    observation: DecisionExtractionGenerationObservation | null,
    fallback_provider_latency_ms: number,
  ): void {
    this.closeSucceededStage(attempt, {
      llm_usage: this.extractionUsage(
        observation,
        fallback_provider_latency_ms,
      ),
    });
  }

  private closeSucceededStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    input: MeetingApprovalJourneyStageSuccessV1 & {
      readonly llm_usage?: JourneyLlmUsageInputV1;
    },
  ): void {
    if (attempt === null) return;
    try {
      const ended = this.captureClock();
      const reserved = this.state.reserveStageClose(
        attempt.journey_id,
        attempt.stage,
        attempt.attempt,
        "succeeded",
        ended.observed_at,
      );
      this.emit(attempt.journey_id, reserved.sequence, ended.observed_at, {
        stage: attempt.stage,
        event: "succeeded",
        attempt: attempt.attempt,
        elapsed_ms: machineElapsed(
          attempt.started.monotonic_ms,
          ended.monotonic_ms,
        ),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.queue_age_ms === undefined
          ? {}
          : { queue_age_ms: input.queue_age_ms }),
        ...(input.llm_usage === undefined
          ? {}
          : { llm_usage: input.llm_usage }),
      });
    } catch {
      // Telemetry closure is best effort.
    }
  }

  failStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    error: unknown,
    input: MeetingApprovalJourneyStageFailureV1 = {},
  ): void {
    this.closeFailedStage(attempt, error, input);
  }

  failExtractionStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    error: unknown,
    observation: DecisionExtractionGenerationObservation | null,
    fallback_provider_latency_ms: number,
  ): void {
    this.closeFailedStage(attempt, error, {
      llm_usage: this.extractionUsage(
        observation,
        fallback_provider_latency_ms,
      ),
    });
  }

  private closeFailedStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    error: unknown,
    input: MeetingApprovalJourneyStageFailureV1 & {
      readonly llm_usage?: JourneyLlmUsageInputV1;
    },
  ): void {
    if (attempt === null) return;
    try {
      const ended = this.captureClock();
      const reserved = this.state.reserveStageClose(
        attempt.journey_id,
        attempt.stage,
        attempt.attempt,
        "failed",
        ended.observed_at,
      );
      const failure = classifyFailure(error, input);
      this.emit(attempt.journey_id, reserved.sequence, ended.observed_at, {
        stage: attempt.stage,
        event: "failed",
        attempt: attempt.attempt,
        elapsed_ms: machineElapsed(
          attempt.started.monotonic_ms,
          ended.monotonic_ms,
        ),
        ...failure,
        ...(input.llm_usage === undefined
          ? {}
          : { llm_usage: input.llm_usage }),
      });
    } catch {
      // Telemetry closure is best effort.
    }
  }

  skipStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): void {
    try {
      if (this.hasTerminalJourneyStage(journey, stage)) return;
      const observed = this.captureClock();
      const reserved = this.state.reserveStageSkip(
        journey.journey_id,
        stage,
        observed.observed_at,
      );
      this.emit(journey.journey_id, reserved.sequence, observed.observed_at, {
        stage,
        event: "skipped",
        outcome: "skipped",
        attempt: reserved.attempt,
        elapsed_ms: 0,
      });
    } catch {
      // Telemetry skipping is best effort.
    }
  }

  skipStageForApproval(
    approval_id: string,
    stage: MeetingApprovalJourneyStageV1,
  ): void {
    const journey = this.readForApproval(approval_id);
    if (journey !== null) this.skipStage(journey, stage);
  }

  hasTerminalStage(
    approval_id: string,
    stage: MeetingApprovalJourneyStageV1,
  ): boolean {
    const journey = this.readForApproval(approval_id);
    return journey !== null && this.hasTerminalJourneyStage(journey, stage);
  }

  hasTerminalJourneyStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): boolean {
    try {
      const latest = this.state.readLatestStage(journey.journey_id, stage);
      return (
        latest !== null &&
        (latest.status === "skipped" ||
          (latest.status === "closed" && latest.result === "succeeded"))
      );
    } catch {
      return false;
    }
  }

  extractionUsage(
    observation: DecisionExtractionGenerationObservation | null,
    fallback_provider_latency_ms: number,
  ): JourneyLlmUsageInputV1 {
    const matchesConfiguration =
      observation?.provider === this.config.extraction_provider &&
      observation.model === this.config.extraction_model;
    const providerLatency = matchesConfiguration
      ? observation.provider_latency_ms
      : Math.max(0, Math.floor(fallback_provider_latency_ms));
    const finish_reason =
      matchesConfiguration && observation.finish_reason === "stop"
        ? "stop"
        : matchesConfiguration && observation.finish_reason === "length"
          ? "length"
          : matchesConfiguration && observation.finish_reason === "content_filter"
            ? "content_filter"
            : "unknown";
    const hasUsage =
      matchesConfiguration &&
      (observation.input_tokens !== null ||
        observation.output_tokens !== null ||
        observation.total_tokens !== null ||
        observation.cached_input_tokens !== null ||
        observation.reasoning_tokens !== null);
    return Object.freeze({
      usage_status: hasUsage ? "reported" : "unavailable",
      provider: this.config.extraction_provider,
      model: this.config.extraction_model,
      provider_latency_ms:
        Number.isSafeInteger(providerLatency) && providerLatency >= 0
          ? providerLatency
          : 0,
      input_tokens: hasUsage ? observation.input_tokens : null,
      output_tokens: hasUsage ? observation.output_tokens : null,
      total_tokens: hasUsage ? observation.total_tokens : null,
      cached_input_tokens: hasUsage ? observation.cached_input_tokens : null,
      reasoning_tokens: hasUsage ? observation.reasoning_tokens : null,
      finish_reason,
    });
  }

  markCardStaged(approval_id: string): void {
    try {
      const journey = this.state.readForApproval(approval_id);
      if (journey !== null) {
        this.state.markCardStaged(
          journey.journey_id,
          this.captureClock().observed_at,
        );
      }
    } catch {
      // Human-wait timing is optional telemetry state.
    }
  }

  queueAgeMs(approval_id: string, observed_at: string): number | null {
    try {
      const journey = this.state.readForApproval(approval_id);
      if (journey?.card_staged_at === null || journey === null) return null;
      const age = Date.parse(observed_at) - Date.parse(journey.card_staged_at);
      return Number.isSafeInteger(age) && age >= 0 ? age : null;
    } catch {
      return null;
    }
  }

  markAwaitingSearch(approval_id: string): void {
    try {
      const journey = this.state.readForApproval(approval_id);
      if (journey !== null) {
        this.state.markApprovedRecordAwaitingSearch(
          journey.journey_id,
          this.captureClock().observed_at,
        );
      }
    } catch {
      // Search correlation is optional telemetry state.
    }
  }

  beginAwaitingSearch(): readonly MeetingApprovalJourneyStageAttemptV1[] {
    try {
      const pending = this.state.listApprovedRecordsAwaitingSearch();
      const attempts: MeetingApprovalJourneyStageAttemptV1[] = [];
      for (const item of pending) {
        const attempt = this.beginStage(
          { journey_id: item.journey_id },
          "meeting_search_publication",
        );
        if (attempt !== null) attempts.push(attempt);
      }
      const batch = Object.freeze(attempts);
      this.awaitingSearchBatches.set(
        batch,
        Object.freeze(
          pending.map((item) => Object.freeze({ journey_id: item.journey_id })),
        ),
      );
      return batch;
    } catch {
      // Global search reconciliation must never depend on run-detail telemetry.
      return Object.freeze([]);
    }
  }

  completeAwaitingSearch(
    attempts: readonly MeetingApprovalJourneyStageAttemptV1[],
    outcome: "current" | "published" | "superseded",
  ): void {
    try {
      const journeys = this.awaitingSearchBatches.get(attempts) ?? Object.freeze(
        attempts.map((attempt) => Object.freeze({ journey_id: attempt.journey_id })),
      );
      for (const attempt of attempts) {
        this.succeedStage(attempt, { outcome });
      }
      if (outcome !== "superseded") {
        for (const journey of journeys) {
          this.state.completeApprovedRecordSearch(
            journey.journey_id,
            this.captureClock().observed_at,
          );
        }
      }
      this.awaitingSearchBatches.delete(attempts);
    } catch {
      // Global search reconciliation must never depend on run-detail telemetry.
    }
  }

  failAwaitingSearch(
    attempts: readonly MeetingApprovalJourneyStageAttemptV1[],
    error: unknown,
  ): void {
    try {
      for (const attempt of attempts) {
        this.failStage(attempt, error);
      }
      this.awaitingSearchBatches.delete(attempts);
    } catch {
      // Global search reconciliation must never depend on run-detail telemetry.
    }
  }

  close(): void {
    try {
      this.state.close();
    } catch {
      // Closing telemetry cannot hide service shutdown completion.
    }
  }

  private emit(
    journey_id: string,
    sequence: number,
    observed_at: string,
    event: {
      readonly stage: MeetingApprovalJourneyStageV1;
      readonly event: "started" | "succeeded" | "failed" | "skipped";
      readonly attempt: number;
      readonly elapsed_ms: number;
      readonly outcome?: JourneyOutcomeV1;
      readonly failure_class?: JourneyFailureClassV1;
      readonly retryable?: boolean;
      readonly queue_age_ms?: number | null;
      readonly llm_usage?: JourneyLlmUsageInputV1;
    },
  ): void {
    const normalized = createJourneyTelemetryEventV1({
      journey_id,
      sequence,
      observed_at,
      context: {
        environment: "staging",
        workflow: "meeting_approval",
        release_sha: this.config.release_sha,
        build_number: this.config.build_number,
      },
      event,
    });
    observeJourneyTelemetryBestEffortV1(this.config.observer, normalized);
  }
}

/** Opens no state unless trusted composition explicitly supplies staging telemetry. */
export function openMeetingApprovalJourneyTelemetryV1(
  config: MeetingApprovalJourneyTelemetryConfigV1,
  dependencies: MeetingApprovalJourneyTelemetryDependenciesV1 = {},
): MeetingApprovalJourneyTelemetryPortV1 {
  const state =
    dependencies.state ??
    openMeetingApprovalJourneyStateV1(
      join(config.state_directory, STAGING_MEETING_APPROVAL_JOURNEY_STATE_FILE_V1),
      dependencies.create_uuid === undefined
        ? {}
        : { create_uuid: dependencies.create_uuid },
    );
  return new MeetingApprovalJourneyTelemetryV1(config, state, dependencies);
}
