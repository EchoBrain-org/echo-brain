import { coreRuntimeIdentityV1, annotateCoreRuntimeV1, observeCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  AdapterError,
  assertCanonicalDecisionSet,
  assertCanonicalMeetingDocument,
  MeetingSourceBridgeV1,
  meetingFromSourceEnvelopeV1,
  pullAndAdmitSourceBatchV1,
  type DecisionProcessorAdapter,
  type DecisionSet,
  type MeetingDocument,
  type MeetingSourceAdapter,
  type MeetingSourceContentV1,
  type SourceAdmissionBindingV1,
  type SourceAdmissionScopeV1,
} from "../core/index.js";
import type {
  MeetingProcessingWorkerPhaseRunnerV1,
  MeetingProcessingWorkerPhaseV1,
} from "./meeting-processing-worker-lifecycle.js";
import type { AdmittedMeetingSourceCursorPolicyV1 } from "./admitted-meeting-source-cursor-policy-v1.js";
import type { ExtractionAttemptKeyV1, ExtractionAttemptReservationV1, ExtractionAttemptStoreV1 } from "./extraction-attempt-store-v1.js";
import { classifyExtractionFailureStageV1, type ExtractionFailureStageV1 } from "./extraction-failure-stage-v1.js";
import {
  reviewInputSha256V1,
  reviewLineageIdV1,
  legacyRestrictedReviewerReviewPolicySnapshotV1,
  type ReviewPolicySnapshotV1,
} from "./review-lineage-semantics.js";

const MAXIMUM_PULL_LIMIT = 1;
/**
 * A pending attempt younger than this may still be running elsewhere; it outlasts the 600 s extraction timeout.
 * It assumes the model-call limiter's queue wait, which that timeout does not count, fits in the margin. A longer
 * wait during a two-process overlap can park a live extraction as interrupted: never a second spend, but its late
 * result may not stage.
 */
const EXTRACTION_IN_FLIGHT_MS = 660_000;

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
 * overwrite a newer checkpoint. Staging, parking and advancing may accept a
 * checkpoint whose queue changed since the pull only by other imports, while
 * the pulled one is still queued; the advance keeps those changes.
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
  /**
   * Durably parks a retained revision whose extraction failed, under its exact
   * attempt-ledger key, and returns the stage it holds: the stored stage is kept
   * while the key and attempt are unchanged. Never moves the cursor; parks
   * nothing when the pull no longer applies (its import was cancelled).
   */
  holdExtraction(input: HoldExtractionInputV1): Promise<ExtractionFailureStageV1>;
  /** This source's parked revisions, oldest first. */
  listHeldExtractions(): Promise<readonly HeldExtractionV1[]>;
  /** Rebuilds a parked revision from retained source custody, digests verified. */
  readHeldMeeting(held: HeldExtractionV1): Promise<MeetingDocument>;
  /** Drops a parked revision whose exact revision already has a frozen candidate. */
  releaseHeldExtraction(held: HeldExtractionV1): Promise<void>;
}

export interface HoldExtractionInputV1 {
  readonly meeting: MeetingDocument;
  readonly key: ExtractionAttemptKeyV1;
  readonly attempt: number;
  readonly failure_stage: ExtractionFailureStageV1;
  /** The cursor the revision was pulled at and the pull's next one; nothing is parked once that pull no longer applies. */
  readonly expected_cursor?: string;
  readonly next_cursor?: string;
}

/** A parked revision: identifiers and an allowlisted stage only, never meeting text. */
export interface HeldExtractionV1 {
  readonly external_id: string;
  readonly source_id: string;
  readonly revision_id: string;
  readonly key: ExtractionAttemptKeyV1;
  readonly attempt: number;
  readonly failure_stage: ExtractionFailureStageV1;
  readonly held_at: string;
}

export interface MeetingProcessingCandidateSnapshotInputV1 {
  readonly admission: AdmittedMeetingProcessingAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly review_policy: ReviewPolicySnapshotV1;
  /** The pull's next cursor; with it, a queue changed since the pull only by other imports still stages. */
  readonly next_cursor?: string;
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
  readonly state: "queued" | "staged" | "superseded";
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
  /** The proposal is frozen; `stage_id` is its approval_id. */
  | { readonly kind: "staged"; readonly stage_id: string }
  | { readonly kind: "revoked" }
  | { readonly kind: "state_drift" };

/**
 * This is deliberately a narrow handoff. `staged` means the approval proposal
 * is frozen and committed. A known revoked or drifted state is a safe no-op.
 * `stage` runs after the candidate commits and before the cursor advance, so a
 * stager must not rely on rows that advance writes.
 */
export interface ApprovalWorkflowStagerV1 {
  stage(
    input: ApprovalWorkflowStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<ApprovalWorkflowStageResultV1>;
  /**
   * Freezes queued proposals independently of source intake. It may resolve
   * true when it froze one or read a full page, so more may be left now.
   */
  reconcilePendingDeliveries(
    context?: { readonly signal: AbortSignal },
  ): Promise<boolean | void>;
  /** Reconciles obsolete presentations; may be a no-op when presenters redraw from the proposal. */
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
    }
  | {
      /** The revision is durably parked; later meetings no longer wait behind it. */
      readonly kind: "held";
      readonly stage: ExtractionFailureStageV1;
      readonly cursor_advanced: boolean;
    }
  | {
      /** Another runner's attempt on this revision is still within its lease: nothing parks or moves. */
      readonly kind: "in_flight";
      readonly cursor_advanced: false;
    };

export interface AdmittedMeetingProcessingCycleV1Options {
  readonly source: MeetingSourceAdapter;
  /** Production binds the common durable source store before decision work. */
  readonly source_ingestion?: SourceAdmissionBindingV1<MeetingSourceContentV1>;
  readonly processor: DecisionProcessorAdapter;
  readonly state: AuthorityMeetingProcessingStateV1;
  readonly stager: ApprovalWorkflowStagerV1;
  /** Provider-owned cursor and source-metadata validation. */
  readonly source_cursor_policy: AdmittedMeetingSourceCursorPolicyV1;
  /** Live composition supplies the durable, one-attempt automatic spend guard. */
  readonly extraction_attempts?: ExtractionAttemptStoreV1;
}

function automaticMeetingSourceAdmission(
  binding: SourceAdmissionBindingV1<MeetingSourceContentV1> | undefined,
): SourceAdmissionBindingV1<MeetingSourceContentV1> | undefined {
  if (binding === undefined) return undefined;
  const requireAutomatic = (scope: SourceAdmissionScopeV1): SourceAdmissionScopeV1 => {
    if (scope.analysis_policy !== "automatic") throw new Error("automatic meeting processing requires automatic source analysis policy");
    return scope;
  };
  const scope = binding.scope;
  return {
    store: binding.store,
    scope: typeof scope === "function" ? (source) => requireAutomatic(scope(source)) : requireAutomatic(scope),
  };
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

/** The attempt-ledger key: one paid attempt per admitted source/processor and bounded review input. */
function extractionAttemptKeyV1(
  admission: AdmittedMeetingProcessingAdmissionV1,
  meeting: MeetingDocument,
): ExtractionAttemptKeyV1 {
  return {
    admission_sha256: canonicalSha256({
      schema_version: 1,
      kind: "echo-meeting-extraction-admission-v1",
      source: {
        adapter_id: admission.source.adapter_id,
        instance_id: admission.source.instance_id,
        version: admission.source.version,
        cutoff_at: admission.source.cutoff_at,
      },
      processor: { ...admission.processor },
    }),
    review_lineage_id: reviewLineageIdV1({
      adapter_id: meeting.provenance.source.adapter_id,
      instance_id: meeting.provenance.source.instance_id,
      external_id: meeting.provenance.external_id,
    }),
    review_input_sha256: reviewInputSha256V1({
      meeting,
      processor: {
        adapter_id: admission.processor.adapter_id,
        instance_id: admission.processor.instance_id,
        version: admission.processor.version,
        configuration_sha256: admission.processor.configuration_sha256,
      },
    }),
  };
}

/**
 * The stage a blocked reservation parks with when no held row already names one.
 * A pending reservation reaches here only once it is older than the in-flight
 * lease (the blocked branch returns in_flight first), so it parks as interrupted.
 */
function blockedExtractionStageV1(
  blocked: Extract<ExtractionAttemptReservationV1, { readonly status: "blocked" }>,
): ExtractionFailureStageV1 {
  if (blocked.outcome === "pending") return "interrupted";
  if (blocked.outcome === "succeeded") return "output_not_saved";
  return blocked.failure_code === "cancelled" ? "cancelled" : "not_recorded";
}

function operationContext(
  signal: AbortSignal | undefined,
): { readonly signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal };
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
 * it advances that cursor only after a verified empty provider page, after
 * the candidate and approval outbox are durably recorded for independent
 * delivery, or after a revision whose extraction failed is durably parked
 * (only with an attempt ledger). An aborted run parks nothing itself; the next
 * poll parks its revision as `cancelled`. A parked
 * revision stays in source custody for an operator-authorized retry
 * (`retryHeldOnce`). A revision whose pending attempt is still within its lease
 * is left in place (`in_flight`) for a later poll. Advancing past a queued
 * import consumes it, so its "Save to" projects are recorded as suggestions
 * whether its revision was staged or parked.
 */
export class AdmittedMeetingProcessingCycleV1 {
  private running: Promise<AdmittedMeetingProcessingCycleResultV1> | undefined;
  private workerLifecycle: MeetingProcessingWorkerPhaseRunnerV1 | undefined;

  constructor(private readonly options: AdmittedMeetingProcessingCycleV1Options) {}

  setWorkerLifecycle(lifecycle: MeetingProcessingWorkerPhaseRunnerV1): void {
    this.workerLifecycle = lifecycle;
  }

  runOnce(signal?: AbortSignal): Promise<AdmittedMeetingProcessingCycleResultV1> {
    return this.once(() => this.run(() => this.processSource(signal), signal));
  }

  /**
   * Re-runs the oldest parked revision whose exact attempt key an operator
   * authorized, from source custody. It never pulls from the provider and
   * never moves the cursor; the reservation consumes the grant, and without
   * one it blocks before any model call. Shares runOnce's single flight.
   */
  retryHeldOnce(signal?: AbortSignal): Promise<AdmittedMeetingProcessingCycleResultV1> {
    return this.once(() => this.run(() => this.retryHeld(signal), signal));
  }

  private once(
    start: () => Promise<AdmittedMeetingProcessingCycleResultV1>,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (this.running !== undefined) return this.running;
    const run = start();
    this.running = run;
    const release = (): void => {
      if (this.running === run) this.running = undefined;
    };
    void run.then(release, release);
    return run;
  }

  private async run(
    work: () => Promise<AdmittedMeetingProcessingCycleResultV1>,
    signal: AbortSignal | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    let result: AdmittedMeetingProcessingCycleResultV1;
    try { result = await work(); }
    catch (error) {
      if (error instanceof AdapterError && signal?.aborted !== true) {
        await this.options.stager.reconcilePendingDeliveries(operationContext(signal));
      }
      throw error;
    }
    // Delivery recovery is deliberately after source work. A broken or
    // provider-ambiguous older card can fail visibly, but it cannot prevent
    // this cycle from durably admitting the next unrelated meeting first.
    await this.phase(
      "approval_staging",
      () => this.options.stager.reconcilePendingDeliveries(operationContext(signal)),
      signal,
    );
    return result;
  }

  private async retryHeld(
    signal: AbortSignal | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    signal?.throwIfAborted();
    const admission = await this.options.state.readAdmission();
    assertAdmissionMatchesAdapters(
      admission,
      this.options.source,
      this.options.processor,
      this.options.source_cursor_policy,
    );
    const attempts = this.options.extraction_attempts;
    const held = attempts === undefined ? undefined
      : (await this.options.state.listHeldExtractions()).find((row) => attempts.inspect(row.key)?.retry_authorized === true);
    if (held === undefined) return { kind: "empty", cursor_advanced: false };
    const meeting = await this.options.state.readHeldMeeting(held);
    assertCanonicalMeetingDocument(meeting, this.options.source.identity);
    const key = extractionAttemptKeyV1(admission, meeting);
    if (
      key.admission_sha256 !== held.key.admission_sha256 ||
      key.review_lineage_id !== held.key.review_lineage_id ||
      key.review_input_sha256 !== held.key.review_input_sha256
    ) {
      throw new Error("held extraction key differs from its custody");
    }
    const frozen = await this.options.state.readFrozenCandidateForSourceRevision({
      external_id: meeting.provenance.external_id,
      canonical_revision: meeting.provenance.canonical_revision,
    });
    // Already processed: the revision is no longer held, and its grant is never spent.
    if (frozen !== undefined) await this.options.state.releaseHeldExtraction(held);
    // No next cursor: a retry from custody never advances intake.
    return this.processMeeting(admission, meeting, frozen, undefined, signal, true);
  }

  private async processSource(
    signal: AbortSignal | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("admitted meeting-processing cycle was cancelled");
    }
    const intake = await this.phase("source_intake", async () => {
      const admission = await this.options.state.readAdmission();
      assertAdmissionMatchesAdapters(
        admission,
        this.options.source,
        this.options.processor,
        this.options.source_cursor_policy,
      );
      annotateCoreRuntimeV1({ cursor: coreRuntimeIdentityV1("source_cursor", admission.source.cursor) });
      const sourceBatch = await observeCoreRuntimeV1("source_poll", () => pullAndAdmitSourceBatchV1({
        source: new MeetingSourceBridgeV1(this.options.source),
        request: { cursor: admission.source.cursor, limit: MAXIMUM_PULL_LIMIT },
        admission: automaticMeetingSourceAdmission(this.options.source_ingestion),
        context: operationContext(signal),
      }));
      const batch = { meetings: sourceBatch.sources.map(meetingFromSourceEnvelopeV1), next_cursor: sourceBatch.next_cursor };
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
        const advanced = await this.advanceCursor({
          expected_cursor: admission.source.cursor,
          next_cursor: batch.next_cursor!,
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
      const frozen =
        await this.options.state.readFrozenCandidateForSourceRevision({
        external_id: meeting.provenance.external_id,
        canonical_revision: meeting.provenance.canonical_revision,
        });
      return {
        kind: "meeting" as const,
        admission,
        batch,
        meeting,
        frozen,
      };
    }, signal);
    if (intake.kind === "complete") return intake.result;
    const { admission, batch, meeting, frozen } = intake;
    return this.processMeeting(admission, meeting, frozen, batch.next_cursor, signal);
  }

  /**
   * One admitted revision: frozen-result reuse, at most one reserved
   * extraction, then the candidate and its proposal. `fromCustody` marks an
   * operator retry, which stages against the current admission because it
   * never moves the cursor.
   */
  private async processMeeting(
    admission: AdmittedMeetingProcessingAdmissionV1,
    meeting: MeetingDocument,
    frozen: FrozenMeetingProcessingCandidateSnapshotV1 | undefined,
    nextCursor: string | undefined,
    signal: AbortSignal | undefined,
    fromCustody = false,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    const reviewPolicy = legacyRestrictedReviewerReviewPolicySnapshotV1;
    annotateCoreRuntimeV1({ source_revision: coreRuntimeIdentityV1("source_revision", JSON.stringify([meeting.provenance.external_id, meeting.provenance.canonical_revision])) });
    if (frozen !== undefined) {
      return this.phase(
        "approval_staging",
        async () => {
          if (
            frozen.disposition === "actionable" &&
            frozen.state === "queued"
          ) {
            // Advance from this poll's cursor, the one its next cursor was
            // computed from; the snapshot's own cursor may be older.
            return this.stageAndAdvance(
              frozen,
              admission,
              frozen.meeting,
              frozen.decisions,
              nextCursor,
              signal,
            );
          }
          if (frozen.disposition === "no_signals") {
            await this.options.stager.reconcileSuperseded(operationContext(signal));
          }
          return this.finishWithoutStage(
            "already_processed",
            admission,
            nextCursor,
          );
        },
        signal,
      );
    }
    const extraction = await this.phase("extraction", async (): Promise<
      { readonly decisions: DecisionSet } | { readonly done: AdmittedMeetingProcessingCycleResultV1 }
    > => {
      const extractionKey = extractionAttemptKeyV1(admission, meeting);
      const reusable =
        await this.options.state.readFrozenCandidateForReviewInput({
          review_lineage_id: extractionKey.review_lineage_id,
          review_input_sha256: extractionKey.review_input_sha256,
        });
      if (reusable !== undefined) {
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
        return { decisions: rebound };
      }

      signal?.throwIfAborted();
      // Provider revisions, observation times and moving cursors cannot grant
      // another paid attempt for the same actual review input. Reserve only
      // after source custody and both frozen-result reuse paths have run.
      const attempts = this.options.extraction_attempts;
      // A retry from custody parks whatever the cursor did, since it never moves it.
      const pulled = fromCustody ? {} : { expected_cursor: admission.source.cursor, next_cursor: nextCursor };
      const claim = attempts?.reserve(extractionKey);
      if (claim?.status === "blocked") {
        // A fresh pending attempt may still be running in another process: no
        // error, no park, no cursor move, so its paid result is never raced.
        if (claim.outcome === "pending" && Date.now() - Date.parse(claim.reserved_at) < EXTRACTION_IN_FLIGHT_MS) {
          return { done: { kind: "in_flight", cursor_advanced: false } };
        }
        // No model call: a crash or failure after an earlier attempt converges
        // here and parks the revision again; a poll also moves intake past it.
        const stage = await this.options.state.holdExtraction({
          meeting, key: extractionKey, attempt: claim.attempt, failure_stage: blockedExtractionStageV1(claim), ...pulled,
        });
        return { done: await this.finishHeld(stage, admission, nextCursor) };
      }
      let receivedOutput = false;
      let extracted: DecisionSet;
      try {
        extracted = await this.options.processor.extract(
          meeting,
          {
            processor_version: this.options.processor.identity.version,
            input_fingerprint: inputFingerprint(meeting, this.options.processor),
          },
          operationContext(signal),
        );
        receivedOutput = true;
        assertCanonicalDecisionSet(
          extracted,
          meeting,
          this.options.processor.identity,
        );
      } catch (error) {
        if (claim === undefined) throw error;
        const aborted = signal?.aborted === true;
        const complete = () => attempts!.complete({
          key: extractionKey,
          attempt: claim.attempt,
          claim_id: claim.claim_id,
          outcome: "failed",
          failure_code: aborted ? "cancelled"
            : receivedOutput ? "invalid_output"
            : error instanceof AdapterError ? error.code : "unknown",
        });
        if (aborted) { complete(); throw error; }
        // Park before closing the attempt, so every crash window leaves a
        // blocked reservation that parks again without a model call.
        let stage: ExtractionFailureStageV1;
        try {
          stage = await this.options.state.holdExtraction({
            meeting, key: extractionKey, attempt: claim.attempt, ...pulled,
            failure_stage: classifyExtractionFailureStageV1(error, { aborted, received_output: receivedOutput }),
          });
        } catch { complete(); throw error; }
        complete();
        return { done: await this.finishHeld(stage, admission, nextCursor) };
      }
      // A failure after this point (including candidate persistence) must not
      // make the successful provider call eligible for automatic repetition.
      if (claim !== undefined) attempts!.complete({
        key: extractionKey,
        attempt: claim.attempt,
        claim_id: claim.claim_id,
        outcome: "succeeded",
      });
      return { decisions: extracted };
    }, signal);
    if ("done" in extraction) return extraction.done;
    const { decisions } = extraction;
    return this.phase(
      "approval_staging",
      async () => {
        const candidate: MeetingProcessingCandidateV1 = await this.options.state.stageCandidate({
          // A retry never moves the cursor, so an import queued during its extraction must not discard the paid result.
          admission: fromCustody ? await this.options.state.readAdmission() : admission,
          meeting,
          decisions,
          review_policy: reviewPolicy,
          next_cursor: nextCursor,
        });
        if (candidate.disposition !== "actionable") {
          await this.options.stager.reconcileSuperseded(operationContext(signal));
          return candidate.disposition === "no_signals"
            ? this.finishWithoutStage(
                "no_signals",
                admission,
                nextCursor,
              )
            : this.finishWithoutStage(
                "already_processed",
                admission,
                nextCursor,
              );
        }
        return this.stageAndAdvance(
          candidate,
          admission,
          meeting,
          decisions,
          nextCursor,
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
        operationContext(signal),
      );
    } catch (error) {
      // The candidate/outbox is already durable and stays queued. Preserve a
      // visible failure, but release source intake so one proposal defect
      // cannot cork every later meeting; reconcile retries the freeze.
      // A failed advance leaves the import queued for the next cycle; the
      // freeze failure stays the error this cycle reports.
      if (signal?.aborted !== true) {
        await this.advanceAfterStageFailure(admission, nextCursor).catch(() => undefined);
      }
      throw error;
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
    const advanced = await this.advanceCursor({
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

  private async advanceAfterStageFailure(
    admission: AdmittedMeetingProcessingAdmissionV1,
    nextCursor: string | undefined,
  ): Promise<void> {
    if (nextCursor === undefined || nextCursor === admission.source.cursor) return;
    await this.advanceCursor({
      expected_cursor: admission.source.cursor,
      next_cursor: nextCursor,
    });
  }

  private async finishHeld(
    stage: ExtractionFailureStageV1,
    admission: AdmittedMeetingProcessingAdmissionV1,
    nextCursor: string | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (nextCursor === undefined || nextCursor === admission.source.cursor) {
      return { kind: "held", stage, cursor_advanced: false };
    }
    // The advance keeps other imports queued or cancelled during extraction.
    // It refuses when this revision's import was cancelled (the hold parked
    // nothing, or the cancel removed the row) or access was revoked.
    const advanced = await this.advanceCursor({
      expected_cursor: admission.source.cursor,
      next_cursor: nextCursor,
    });
    return { kind: "held", stage, cursor_advanced: advanced === "advanced" };
  }

  private async finishWithoutStage(
    kind: "no_signals" | "already_processed",
    admission: AdmittedMeetingProcessingAdmissionV1,
    nextCursor: string | undefined,
  ): Promise<AdmittedMeetingProcessingCycleResultV1> {
    if (nextCursor === undefined || nextCursor === admission.source.cursor) {
      return { kind, cursor_advanced: false };
    }
    const advanced = await this.advanceCursor({
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

  private advanceCursor(
    input: Parameters<AuthorityMeetingProcessingStateV1["advanceCursor"]>[0],
  ): ReturnType<AuthorityMeetingProcessingStateV1["advanceCursor"]> {
    return observeCoreRuntimeV1("source_cursor", async () => {
      const advanced = await this.options.state.advanceCursor(input);
      annotateCoreRuntimeV1({ result: advanced ? "advanced" : "retry_pending" });
      return advanced;
    });
  }

  private phase<T>(
    phase: MeetingProcessingWorkerPhaseV1,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.workerLifecycle?.runPhase(phase, operation, signal) ?? operation();
  }
}
