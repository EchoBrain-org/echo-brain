import {
  assertCanonicalDecisionSet,
  assertCanonicalMeetingBatch,
  assertCanonicalMeetingDocument,
  type DecisionProcessorAdapter,
  type DecisionSet,
  type MeetingDocument,
  type MeetingSourceAdapter,
} from "../core/index.js";
import type {
  MeetingProcessingWorkerPhaseRunnerV1,
  MeetingProcessingWorkerPhaseV1,
} from "./meeting-processing-worker-lifecycle.js";
import type {
  MeetingApprovalJourneyRefV1,
  MeetingApprovalJourneyStageAttemptV1,
  MeetingApprovalJourneyTelemetryPortV1,
} from "./meeting-approval-journey-telemetry-port-v1.js";
import type { DecisionExtractionGenerationObservation } from "../core/contracts/decision.js";
import type { AdmittedMeetingSourceCursorPolicyV1 } from "./admitted-meeting-source-cursor-policy-v1.js";
import {
  reviewInputSha256V1,
  reviewLineageIdV1,
  legacyRestrictedReviewerReviewPolicySnapshotV1,
  type ReviewPolicySnapshotV1,
} from "./review-lineage-semantics.js";

const MAXIMUM_PULL_LIMIT = 1;

export const APPROVAL_DELIVERY_QUARANTINE_REASON_V1 =
  "approval_package_unrepresentable" as const;

export type ApprovalDeliveryQuarantineReasonV1 =
  typeof APPROVAL_DELIVERY_QUARANTINE_REASON_V1;

export interface AdmittedMeetingProcessingAdmissionV1 {
  readonly source: {
    readonly adapter_id: string;
    readonly instance_id: string;
    readonly version: string;
    /** The current cursor, initially the admitted source cutoff cursor. */
    readonly cursor: string;
    /** The immutable stopped-time boundary, retained after cursor advances. */
    readonly cutoff_at: string;
  };
  readonly processor: {
    readonly adapter_id: string;
    readonly instance_id: string;
    readonly version: string;
    readonly configuration_sha256: string;
  };
}

/**
 * The Authority-owned persistence boundary. `advanceCursor` must compare the
 * supplied cursor with the durable current cursor, so a stale runner can never
 * overwrite a newer checkpoint.
 */
export interface AuthorityMeetingProcessingStateV1 {
  readAdmission(): Promise<AdmittedMeetingProcessingAdmissionV1>;
  /** Returns the original frozen snapshot for an admitted source revision. */
  readFrozenCandidateForSourceRevision(input: {
    readonly external_id: string;
    readonly canonical_revision: string;
  }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined>;
  /** Finds a prior frozen extraction whose bounded review input is identical. */
  readFrozenCandidateForReviewInput(input: {
    readonly review_lineage_id: string;
    readonly review_input_sha256: string;
  }): Promise<FrozenMeetingProcessingCandidateSnapshotV1 | undefined>;
  stageCandidate(
    input: MeetingProcessingCandidateSnapshotInputV1,
  ): Promise<MeetingProcessingCandidateV1>;
  advanceCursor(input: {
    readonly expected_cursor: string;
    readonly next_cursor: string;
  }): Promise<"advanced" | "state_drift" | "revoked">;
}

export interface MeetingProcessingCandidateSnapshotInputV1 {
  readonly admission: AdmittedMeetingProcessingAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly review_policy: ReviewPolicySnapshotV1;
}

interface MeetingProcessingCandidateBaseV1 {
  readonly candidate_id: string;
  readonly candidate_semantic_sha256: string;
  readonly review_lineage_id: string;
  readonly review_input_sha256: string;
  readonly review_semantic_sha256: string;
  readonly review_policy_id: ReviewPolicySnapshotV1["policy_id"];
  readonly review_policy_contract_sha256: ReviewPolicySnapshotV1["policy_contract_sha256"];
  readonly review_policy_consequence_text: string;
  readonly review_policy_consequence_sha256: ReviewPolicySnapshotV1["policy_consequence_sha256"];
}

/** A durable Authority candidate with a deterministic D2 handoff. */
export interface ActionableMeetingProcessingCandidateV1
  extends MeetingProcessingCandidateBaseV1 {
  readonly disposition: "actionable";
  readonly approval_id: string;
  readonly stage_command_id: string;
  readonly state: "queued" | "posting" | "posted" | "staged" | "superseded";
}

/** An immutable source revision that intentionally creates no approval card. */
export interface NonActionableMeetingProcessingCandidateV1
  extends MeetingProcessingCandidateBaseV1 {
  readonly disposition: "coalesced" | "no_signals";
  readonly approval_id: null;
  readonly stage_command_id: null;
  readonly state: "coalesced" | "no_signals";
}

export type MeetingProcessingCandidateV1 =
  | ActionableMeetingProcessingCandidateV1
  | NonActionableMeetingProcessingCandidateV1;

/** The immutable Authority snapshot associated with a durable candidate. */
export type FrozenMeetingProcessingCandidateSnapshotV1 = MeetingProcessingCandidateV1 & {
  readonly admission: AdmittedMeetingProcessingAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
};

export interface ApprovalWorkflowStageInputV1 {
  readonly admission: AdmittedMeetingProcessingAdmissionV1;
  readonly candidate: ActionableMeetingProcessingCandidateV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
}

export type ApprovalWorkflowStageResultV1 =
  | { readonly kind: "staged"; readonly stage_id: string }
  | { readonly kind: "delivery_pending" }
  | {
      readonly kind: "quarantined";
      readonly reason_code: ApprovalDeliveryQuarantineReasonV1;
    }
  | { readonly kind: "revoked" }
  | { readonly kind: "state_drift" };

type DurableApprovalDeliveryOutcomeV1 = Extract<
  ApprovalWorkflowStageResultV1,
  { readonly kind: "delivery_pending" | "quarantined" }
>;

/**
 * This is deliberately a narrow handoff. The eventual control-plane adapter
 * owns the durable approval card and returns `staged` only once it is
 * committed. A known revoked or drifted control-plane state is a safe no-op.
 */
export interface ApprovalWorkflowStagerV1 {
  stage(
    input: ApprovalWorkflowStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<ApprovalWorkflowStageResultV1>;
  /**
   * Reconciles durable approval delivery work independently of source intake.
   * A provider-ambiguous post remains frozen and is never blindly repeated.
   */
  reconcilePendingDeliveries(
    context?: { readonly signal: AbortSignal },
  ): Promise<void>;
  /** Reconciles every durable obsolete provider presentation. */
  reconcileSuperseded(
    context?: { readonly signal: AbortSignal },
  ): Promise<void>;
}

export type AdmittedMeetingProcessingCycleResultV1 =
  | {
      readonly kind: "empty";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "empty_cursor_advanced";
      readonly cursor_advanced: true;
    }
  | {
      readonly kind: "empty_cursor_not_advanced";
      readonly reason: "revoked" | "state_drift";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "no_signals";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "no_signals_cursor_advanced";
      readonly cursor_advanced: true;
    }
  | {
      readonly kind: "no_signals_cursor_not_advanced";
      readonly reason: "revoked" | "state_drift";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "staged";
      readonly stage_id: string;
      readonly cursor_advanced: boolean;
    }
  | {
      readonly kind: "delivery_pending";
      readonly cursor_advanced: boolean;
    }
  | {
      readonly kind: "delivery_pending_cursor_not_advanced";
      readonly reason: "revoked" | "state_drift";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "quarantined";
      readonly reason_code: ApprovalDeliveryQuarantineReasonV1;
      readonly cursor_advanced: boolean;
    }
  | {
      readonly kind: "quarantined_cursor_not_advanced";
      readonly reason_code: ApprovalDeliveryQuarantineReasonV1;
      readonly reason: "revoked" | "state_drift";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "not_staged";
      readonly reason: "revoked" | "state_drift";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "staged_cursor_not_advanced";
      readonly stage_id: string;
      readonly reason: "revoked" | "state_drift";
      readonly cursor_advanced: false;
    }
  | {
      readonly kind: "already_processed";
      readonly cursor_advanced: boolean;
    }
  | {
      readonly kind: "already_processed_cursor_not_advanced";
      readonly reason: "revoked" | "state_drift";
      readonly cursor_advanced: false;
    };

export interface AdmittedMeetingProcessingCycleV1Options {
  readonly source: MeetingSourceAdapter;
  readonly processor: DecisionProcessorAdapter;
  readonly state: AuthorityMeetingProcessingStateV1;
  readonly stager: ApprovalWorkflowStagerV1;
  /** Provider-owned cursor and source-metadata validation. */
  readonly source_cursor_policy: AdmittedMeetingSourceCursorPolicyV1;
  /** Optional, staging-owned journey detail. It must never affect processing. */
  readonly journey_telemetry?: MeetingApprovalJourneyTelemetryPortV1;
}

function assertAdmissionMatchesAdapters(
  admission: AdmittedMeetingProcessingAdmissionV1,
  source: MeetingSourceAdapter,
  processor: DecisionProcessorAdapter,
  sourceCursorPolicy: AdmittedMeetingSourceCursorPolicyV1,
): void {
  if (
    source.identity.adapter_id !== admission.source.adapter_id ||
    source.identity.instance_id !== admission.source.instance_id ||
    source.identity.version !== admission.source.version
  ) {
    throw new Error(
      "admitted meeting source adapter differs from the admitted source",
    );
  }
  if (
    processor.identity.adapter_id !== admission.processor.adapter_id ||
    processor.identity.instance_id !== admission.processor.instance_id ||
    processor.identity.version !== admission.processor.version
  ) {
    throw new Error(
      "admitted decision processor adapter differs from the admitted decision processor",
    );
  }
  if (
    new Date(admission.source.cutoff_at).toISOString() !==
      admission.source.cutoff_at
  ) {
    throw new Error("admitted meeting-processing admission has an invalid source cutoff");
  }
  sourceCursorPolicy.assert_live_cursor(admission.source.cursor);
}

function inputFingerprint(
  meeting: MeetingDocument,
  processor: DecisionProcessorAdapter,
): string {
  return `clean-live-v1:${JSON.stringify([
    meeting.provenance.source.adapter_id,
    meeting.provenance.source.instance_id,
    meeting.provenance.source.version,
    meeting.provenance.external_id,
    meeting.provenance.canonical_revision,
    meeting.provenance.normalizer_version,
    processor.identity.instance_id,
    processor.identity.version,
  ])}`;
}

function rebindDecisionsToRevision(
  frozen: DecisionSet,
  frozenMeeting: MeetingDocument,
  meeting: MeetingDocument,
): DecisionSet {
  const frozenPromptBlocks = frozenMeeting.content.filter(
    (block) => block.text.trim().length > 0,
  );
  const currentPromptBlocks = meeting.content.filter(
    (block) => block.text.trim().length > 0,
  );
  if (frozenPromptBlocks.length !== currentPromptBlocks.length) {
    throw new Error("reused decision input no longer matches the meeting");
  }
  const contentByFrozenId = new Map(
    frozenPromptBlocks.map((block, index) => {
      const current = currentPromptBlocks[index];
      if (
        current === undefined ||
        current.kind !== block.kind ||
        current.text !== block.text
      ) {
        throw new Error("reused decision input no longer matches the meeting");
      }
      return [block.id, current] as const;
    }),
  );
  return {
    ...frozen,
    meeting_id: meeting.id,
    meeting_revision: meeting.provenance.canonical_revision,
    signals: frozen.signals.map((signal) => ({
      // Signal IDs identify the original extraction result. Keeping them also
      // preserves rationale links; the artifact's meeting_revision records
      // the provider revision to which that extraction was safely rebound.
      ...signal,
      evidence: signal.evidence.map((evidence) => {
        const block = contentByFrozenId.get(evidence.block_id);
        if (block === undefined) {
          throw new Error("reused decision evidence does not resolve to the meeting");
        }
        const {
          started_at: _previousStartedAt,
          ended_at: _previousEndedAt,
          ...stableEvidence
        } = evidence;
        return {
          ...stableEvidence,
          meeting_id: meeting.id,
          block_id: block.id,
          ...(block.started_at === undefined
            ? {}
            : { started_at: block.started_at }),
          ...(block.ended_at === undefined ? {} : { ended_at: block.ended_at }),
        };
      }),
    })),
  };
}

/**
 * Performs exactly one serialized source poll. It never imports history: its
 * only cursor comes from a previously admitted source, and
 * it advances that cursor only after either a verified empty provider page or
 * the candidate and approval outbox are durably recorded for independent
 * delivery.
 */
export class AdmittedMeetingProcessingCycleV1 {
  private running: Promise<AdmittedMeetingProcessingCycleResultV1> | undefined;
  private workerLifecycle: MeetingProcessingWorkerPhaseRunnerV1 | undefined;

  constructor(private readonly options: AdmittedMeetingProcessingCycleV1Options) {}

  setWorkerLifecycle(lifecycle: MeetingProcessingWorkerPhaseRunnerV1): void {
    this.workerLifecycle = lifecycle;
  }

  runOnce(signal?: AbortSignal): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (this.running !== undefined) return this.running;
    const run = this.run(signal);
    this.running = run;
    void run.then(
      () => {
        if (this.running === run) this.running = undefined;
      },
      () => {
        if (this.running === run) this.running = undefined;
      },
    );
    return run;
  }

  private async run(
    signal: AbortSignal | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    const result = await this.processSource(signal);
    // Delivery recovery is deliberately after source work. A broken or
    // provider-ambiguous older card can fail visibly, but it cannot prevent
    // this cycle from durably admitting the next unrelated meeting first.
    await this.phase(
      "approval_staging",
      () =>
        this.options.stager.reconcilePendingDeliveries(
          signal === undefined ? undefined : { signal },
        ),
      signal,
    );
    return result;
  }

  private async processSource(
    signal: AbortSignal | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("admitted meeting-processing cycle was cancelled");
    }
    // The source-stage clock deliberately starts before admission and pull,
    // but a durable journey is created only after a canonical source identity
    // and revision are available.
    const sourceStarted = this.captureTelemetryClock();
    const intake = await this.phase("source_intake", async () => {
      const admission = await this.options.state.readAdmission();
      assertAdmissionMatchesAdapters(
        admission,
        this.options.source,
        this.options.processor,
        this.options.source_cursor_policy,
      );
      const batch = await this.options.source.pull(
        { cursor: admission.source.cursor, limit: MAXIMUM_PULL_LIMIT },
        signal === undefined ? undefined : { signal },
      );
      assertCanonicalMeetingBatch(batch);
      if (batch.meetings.length > MAXIMUM_PULL_LIMIT) {
        throw new Error(
          "admitted meeting-processing cycle accepts at most one meeting per poll",
        );
      }
      const meeting = batch.meetings[0];
      if (meeting === undefined) {
        if (
          batch.next_cursor === undefined ||
          batch.next_cursor === admission.source.cursor
        ) {
          return {
            kind: "complete" as const,
            result: { kind: "empty" as const, cursor_advanced: false as const },
          };
        }
        const advanced = await this.options.state.advanceCursor({
          expected_cursor: admission.source.cursor,
          next_cursor: batch.next_cursor,
        });
        return advanced === "advanced"
          ? {
              kind: "complete" as const,
              result: {
                kind: "empty_cursor_advanced" as const,
                cursor_advanced: true as const,
              },
            }
          : {
              kind: "complete" as const,
              result: {
                kind: "empty_cursor_not_advanced" as const,
                reason: advanced,
                cursor_advanced: false as const,
              },
            };
      }
      assertCanonicalMeetingDocument(meeting, this.options.source.identity);
      const reviewPolicy = legacyRestrictedReviewerReviewPolicySnapshotV1;
      const sourceAttempt = this.safely(
        () =>
          this.options.journey_telemetry?.beginOrResumeSource(
            {
              source_adapter_id: meeting.provenance.source.adapter_id,
              source_instance_id: meeting.provenance.source.instance_id,
              external_id: meeting.provenance.external_id,
              canonical_revision: meeting.provenance.canonical_revision,
            },
            sourceStarted,
          ) ?? null,
        null,
      ) ?? null;
      try {
        const frozen =
          await this.options.state.readFrozenCandidateForSourceRevision({
          external_id: meeting.provenance.external_id,
          canonical_revision: meeting.provenance.canonical_revision,
          });
        this.safely(() => {
          this.options.journey_telemetry?.succeedStage(sourceAttempt);
        });
        return {
          kind: "meeting" as const,
          admission,
          batch,
          meeting,
          reviewPolicy,
          frozen,
          journey: sourceAttempt,
        };
      } catch (error) {
        this.safely(() => {
          this.options.journey_telemetry?.failStage(sourceAttempt, error);
        });
        throw error;
      }
    }, signal);
    if (intake.kind === "complete") return intake.result;
    const { admission, batch, meeting, reviewPolicy, frozen, journey } = intake;
    if (frozen !== undefined) {
      this.bindCandidate(journey, frozen);
      this.skipHistoricalFrozenStages(journey);
      if (frozen.disposition !== "actionable") {
        this.skipApprovalStages(journey);
      }
      return this.phase(
        "approval_staging",
        async () => {
          if (
            frozen.disposition === "actionable" &&
            (frozen.state === "queued" ||
              frozen.state === "posting" ||
              frozen.state === "posted")
          ) {
            return this.stageAndAdvance(
              frozen,
              frozen.admission,
              frozen.meeting,
              frozen.decisions,
              batch.next_cursor,
              signal,
            );
          }
          if (frozen.disposition === "no_signals") {
            await this.options.stager.reconcileSuperseded(
              signal === undefined ? undefined : { signal },
            );
          }
          return this.finishWithoutStage(
            "already_processed",
            admission,
            batch.next_cursor,
          );
        },
        signal,
      );
    }
    const decisions = await this.phase("extraction", async () => {
      const reviewInputSha256 = reviewInputSha256V1({
        meeting,
        processor: {
          adapter_id: admission.processor.adapter_id,
          instance_id: admission.processor.instance_id,
          version: admission.processor.version,
          configuration_sha256: admission.processor.configuration_sha256,
        },
      });
      const reviewLineageId = reviewLineageIdV1({
        adapter_id: meeting.provenance.source.adapter_id,
        instance_id: meeting.provenance.source.instance_id,
        external_id: meeting.provenance.external_id,
      });
      const reusable =
        await this.options.state.readFrozenCandidateForReviewInput({
          review_lineage_id: reviewLineageId,
          review_input_sha256: reviewInputSha256,
        });
      if (reusable !== undefined) {
        this.skipStageIfMissing(journey, "meeting_extraction");
        const rebound = rebindDecisionsToRevision(
          reusable.decisions,
          reusable.meeting,
          meeting,
        );
        assertCanonicalDecisionSet(
          rebound,
          meeting,
          this.options.processor.identity,
        );
        return rebound;
      }

      const extractionAttempt = this.beginStage(journey, "meeting_extraction");
      const extractionStartedAt = Date.now();
      let observation: DecisionExtractionGenerationObservation | null = null;
      try {
        const extracted = await this.options.processor.extract(
          meeting,
          {
            processor_version: this.options.processor.identity.version,
            input_fingerprint: inputFingerprint(meeting, this.options.processor),
            on_generation: (event) => {
              observation = event;
            },
          },
          signal === undefined ? undefined : { signal },
        );
        assertCanonicalDecisionSet(
          extracted,
          meeting,
          this.options.processor.identity,
        );
        this.closeExtractionSuccess(
          extractionAttempt,
          observation,
          extractionStartedAt,
        );
        return extracted;
      } catch (error) {
        this.closeExtractionFailure(
          extractionAttempt,
          error,
          observation,
          extractionStartedAt,
        );
        throw error;
      }
    }, signal);
    return this.phase(
      "approval_staging",
      async () => {
        const candidateAttempt = this.beginStage(
          journey,
          "meeting_candidate_persist",
        );
        let candidate: MeetingProcessingCandidateV1;
        try {
          candidate = await this.options.state.stageCandidate({
            admission,
            meeting,
            decisions,
            review_policy: reviewPolicy,
          });
          this.safely(() => {
            this.options.journey_telemetry?.succeedStage(candidateAttempt, {
              outcome: candidate.disposition,
            });
          });
        } catch (error) {
          this.safely(() => {
            this.options.journey_telemetry?.failStage(candidateAttempt, error);
          });
          throw error;
        }
        this.bindCandidate(journey, candidate);
        if (candidate.disposition !== "actionable") {
          this.skipApprovalStages(journey);
          await this.options.stager.reconcileSuperseded(
            signal === undefined ? undefined : { signal },
          );
          return candidate.disposition === "no_signals"
            ? this.finishWithoutStage(
                "no_signals",
                admission,
                batch.next_cursor,
              )
            : this.finishWithoutStage(
                "already_processed",
                admission,
                batch.next_cursor,
              );
        }
        return this.stageAndAdvance(
          candidate,
          admission,
          meeting,
          decisions,
          batch.next_cursor,
          signal,
        );
      },
      signal,
    );
  }

  private async stageAndAdvance(
    candidate: ActionableMeetingProcessingCandidateV1,
    admission: AdmittedMeetingProcessingAdmissionV1,
    meeting: MeetingDocument,
    decisions: DecisionSet,
    nextCursor: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    let staged: Awaited<ReturnType<ApprovalWorkflowStagerV1["stage"]>>;
    try {
      staged = await this.options.stager.stage(
        { admission, candidate, meeting, decisions },
        signal === undefined ? undefined : { signal },
      );
    } catch (error) {
      // The candidate/outbox is already durable. Preserve a visible delivery
      // failure, but release source intake so one presentation defect cannot
      // cork every later meeting.
      if (signal?.aborted !== true) {
        await this.advanceAfterDurableDelivery(admission, nextCursor, {
          kind: "delivery_pending",
        });
      }
      throw error;
    }
    if (staged.kind === "delivery_pending") {
      return this.advanceAfterDurableDelivery(admission, nextCursor, staged);
    }
    if (staged.kind === "quarantined") {
      return this.advanceAfterDurableDelivery(admission, nextCursor, staged);
    }
    if (staged.kind !== "staged") {
      return {
        kind: "not_staged",
        reason: staged.kind,
        cursor_advanced: false,
      };
    }
    if (
      nextCursor === undefined ||
      nextCursor === admission.source.cursor
    ) {
      return {
        kind: "staged",
        stage_id: staged.stage_id,
        cursor_advanced: false,
      };
    }
    const advanced = await this.options.state.advanceCursor({
      expected_cursor: admission.source.cursor,
      next_cursor: nextCursor,
    });
    if (advanced !== "advanced") {
      return {
        kind: "staged_cursor_not_advanced",
        stage_id: staged.stage_id,
        reason: advanced,
        cursor_advanced: false,
      };
    }
    return { kind: "staged", stage_id: staged.stage_id, cursor_advanced: true };
  }

  private async advanceAfterDurableDelivery(
    admission: AdmittedMeetingProcessingAdmissionV1,
    nextCursor: string | undefined,
    outcome: DurableApprovalDeliveryOutcomeV1,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (nextCursor === undefined || nextCursor === admission.source.cursor) {
      return { ...outcome, cursor_advanced: false };
    }
    const advanced = await this.options.state.advanceCursor({
      expected_cursor: admission.source.cursor,
      next_cursor: nextCursor,
    });
    if (advanced === "advanced") {
      return { ...outcome, cursor_advanced: true };
    }
    return outcome.kind === "delivery_pending"
      ? {
          kind: "delivery_pending_cursor_not_advanced",
          reason: advanced,
          cursor_advanced: false,
        }
      : {
          kind: "quarantined_cursor_not_advanced",
          reason_code: outcome.reason_code,
          reason: advanced,
          cursor_advanced: false,
        };
  }

  private async finishWithoutStage(
    kind: "no_signals" | "already_processed",
    admission: AdmittedMeetingProcessingAdmissionV1,
    nextCursor: string | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (nextCursor === undefined || nextCursor === admission.source.cursor) {
      return { kind, cursor_advanced: false };
    }
    const advanced = await this.options.state.advanceCursor({
      expected_cursor: admission.source.cursor,
      next_cursor: nextCursor,
    });
    if (advanced === "advanced") {
      return kind === "no_signals"
        ? { kind: "no_signals_cursor_advanced", cursor_advanced: true }
        : { kind: "already_processed", cursor_advanced: true };
    }
    return kind === "no_signals"
      ? {
          kind: "no_signals_cursor_not_advanced",
          reason: advanced,
          cursor_advanced: false,
        }
      : {
          kind: "already_processed_cursor_not_advanced",
          reason: advanced,
          cursor_advanced: false,
        };
  }

  private phase<T>(
    phase: MeetingProcessingWorkerPhaseV1,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.workerLifecycle?.runPhase(phase, operation, signal) ?? operation();
  }

  private safely<T>(operation: () => T, fallback?: T): T | undefined {
    try {
      return operation();
    } catch {
      return fallback;
    }
  }

  private captureTelemetryClock() {
    return this.safely(
      () => this.options.journey_telemetry?.captureClock(),
    );
  }

  private beginStage(
    journey: MeetingApprovalJourneyRefV1 | null,
    stage: "meeting_extraction" | "meeting_candidate_persist",
  ): MeetingApprovalJourneyStageAttemptV1 | null {
    if (journey === null) return null;
    return this.safely(
      () => this.options.journey_telemetry?.beginStage(journey, stage) ?? null,
      null,
    ) ?? null;
  }

  private closeExtractionSuccess(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    observation: DecisionExtractionGenerationObservation | null,
    startedAt: number,
  ): void {
    this.safely(() => {
      const telemetry = this.options.journey_telemetry;
      if (telemetry === undefined) return;
      telemetry.succeedExtractionStage(
        attempt,
        observation,
        Math.max(0, Date.now() - startedAt),
      );
    });
  }

  private closeExtractionFailure(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    error: unknown,
    observation: DecisionExtractionGenerationObservation | null,
    startedAt: number,
  ): void {
    this.safely(() => {
      const telemetry = this.options.journey_telemetry;
      if (telemetry === undefined) return;
      telemetry.failExtractionStage(
        attempt,
        error,
        observation,
        Math.max(0, Date.now() - startedAt),
      );
    });
  }

  private bindCandidate(
    journey: MeetingApprovalJourneyRefV1 | null,
    candidate: MeetingProcessingCandidateV1,
  ): void {
    if (journey === null) return;
    this.safely(() => {
      this.options.journey_telemetry?.bindCandidate(journey, {
        candidate_id: candidate.candidate_id,
        approval_id: candidate.approval_id,
      });
    });
  }

  private skipHistoricalFrozenStages(
    journey: MeetingApprovalJourneyRefV1 | null,
  ): void {
    this.skipStageIfMissing(journey, "meeting_extraction");
    this.skipStageIfMissing(journey, "meeting_candidate_persist");
  }

  private skipApprovalStages(
    journey: MeetingApprovalJourneyRefV1 | null,
  ): void {
    for (const stage of [
      "meeting_approval_staging",
      "meeting_approval_action_verify",
      "meeting_approval_action_queue",
      "meeting_terminal_persist",
      "meeting_record_append",
      "meeting_search_publication",
    ] as const) {
      this.skipStageIfMissing(journey, stage);
    }
  }

  private skipStageIfMissing(
    journey: MeetingApprovalJourneyRefV1 | null,
    stage:
      | "meeting_extraction"
      | "meeting_candidate_persist"
      | "meeting_approval_staging"
      | "meeting_approval_action_verify"
      | "meeting_approval_action_queue"
      | "meeting_terminal_persist"
      | "meeting_record_append"
      | "meeting_search_publication",
  ): void {
    if (journey === null) return;
    this.safely(() => {
      const telemetry = this.options.journey_telemetry;
      if (
        telemetry !== undefined &&
        !telemetry.hasTerminalJourneyStage(journey, stage)
      ) {
        telemetry.skipStage(journey, stage);
      }
    });
  }
}
