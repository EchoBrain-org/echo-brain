import type { DecisionExtractionGenerationObservation } from "../core/contracts/decision.js";

export type MeetingApprovalJourneyStageV1 =
  | "meeting_source_intake"
  | "meeting_extraction"
  | "meeting_candidate_persist"
  | "meeting_approval_staging"
  | "meeting_approval_action_verify"
  | "meeting_approval_action_queue"
  | "meeting_terminal_persist"
  | "meeting_record_append"
  | "meeting_search_publication";

export type MeetingApprovalJourneyOutcomeV1 =
  | "actionable"
  | "no_signals"
  | "coalesced"
  | "staged"
  | "delivery_pending"
  | "quarantined"
  | "approved"
  | "rejected"
  | "denied"
  | "current"
  | "published"
  | "superseded";

export type MeetingApprovalJourneyFailureClassV1 =
  | "authorization"
  | "invalid_request"
  | "invalid_contract"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "cancelled"
  | "provider_rejected"
  | "unknown";

/** Opaque correlation handle. It contains no meeting or approval identifier. */
export interface MeetingApprovalJourneyRefV1 {
  readonly journey_id: string;
}

/** Captured before work whose durable journey is not known until later. */
export interface MeetingApprovalJourneyClockV1 {
  readonly observed_at: string;
  readonly monotonic_ms: number;
}

/** In-process token for exactly one machine-stage attempt. */
export interface MeetingApprovalJourneyStageAttemptV1
  extends MeetingApprovalJourneyRefV1 {
  readonly stage: MeetingApprovalJourneyStageV1;
  readonly attempt: number;
  readonly started: MeetingApprovalJourneyClockV1;
}

export interface MeetingApprovalJourneyStageSuccessV1 {
  readonly outcome?: MeetingApprovalJourneyOutcomeV1;
  readonly queue_age_ms?: number | null;
}

export interface MeetingApprovalJourneyStageFailureV1 {
  /** Closed override for state transitions that return a result, not an Error. */
  readonly failure_class?: MeetingApprovalJourneyFailureClassV1;
  readonly retryable?: boolean;
}

/**
 * Staging-only, fail-open port shared by the meeting processor and approval
 * adapters. Implementations must digest every business join key before it is
 * persisted and must never add those keys to emitted telemetry.
 */
export interface MeetingApprovalJourneyTelemetryPortV1 {
  captureClock(): MeetingApprovalJourneyClockV1;

  beginOrResumeSource(
    input: {
      readonly source_adapter_id: string;
      readonly source_instance_id: string;
      readonly external_id: string;
      readonly canonical_revision: string;
    },
    started?: MeetingApprovalJourneyClockV1,
  ): MeetingApprovalJourneyStageAttemptV1 | null;

  bindCandidate(
    journey: MeetingApprovalJourneyRefV1,
    input: {
      readonly candidate_id: string;
      readonly approval_id: string | null;
    },
  ): void;

  readForApproval(approval_id: string): MeetingApprovalJourneyRefV1 | null;

  beginStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
    started?: MeetingApprovalJourneyClockV1,
  ): MeetingApprovalJourneyStageAttemptV1 | null;

  beginStageForApproval(
    approval_id: string,
    stage: MeetingApprovalJourneyStageV1,
    started?: MeetingApprovalJourneyClockV1,
  ): MeetingApprovalJourneyStageAttemptV1 | null;

  succeedStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    input?: MeetingApprovalJourneyStageSuccessV1,
  ): void;

  failStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    error: unknown,
    input?: MeetingApprovalJourneyStageFailureV1,
  ): void;

  succeedExtractionStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    observation: DecisionExtractionGenerationObservation | null,
    fallback_provider_latency_ms: number,
  ): void;

  failExtractionStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    error: unknown,
    observation: DecisionExtractionGenerationObservation | null,
    fallback_provider_latency_ms: number,
  ): void;

  skipStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): void;

  skipStageForApproval(
    approval_id: string,
    stage: MeetingApprovalJourneyStageV1,
  ): void;

  hasTerminalStage(
    approval_id: string,
    stage: MeetingApprovalJourneyStageV1,
  ): boolean;

  hasTerminalJourneyStage(
    journey: MeetingApprovalJourneyRefV1,
    stage: MeetingApprovalJourneyStageV1,
  ): boolean;

  markCardStaged(approval_id: string): void;
  queueAgeMs(approval_id: string, observed_at: string): number | null;

  markAwaitingSearch(approval_id: string): void;
  /**
   * Starts one search-publication span per record that was approved before
   * this reconciliation pass. The returned tokens must be used to close this
   * exact pass, rather than re-querying pending records after work finishes.
   */
  beginAwaitingSearch(): readonly MeetingApprovalJourneyStageAttemptV1[];
  completeAwaitingSearch(
    attempts: readonly MeetingApprovalJourneyStageAttemptV1[],
    outcome: "current" | "published" | "superseded",
  ): void;
  failAwaitingSearch(
    attempts: readonly MeetingApprovalJourneyStageAttemptV1[],
    error: unknown,
  ): void;

  close(): void;
}
