import {
  assertCanonicalDecisionSet,
  assertCanonicalMeetingBatch,
  assertCanonicalMeetingDocument,
  type DecisionProcessorAdapter,
  type DecisionSet,
  type MeetingDocument,
  type MeetingSourceAdapter,
} from "../core/index.js";
import { granolaCursorPhase } from "../adapters/meeting-sources/granola/index.js";
import {
  cleanReviewInputSha256V1,
  cleanReviewLineageIdV1,
  type CleanReviewPolicySnapshotV1,
} from "./review-lineage-semantics.js";

const MAXIMUM_PULL_LIMIT = 1;

export interface CleanGranolaSourceAdmissionV1 {
  readonly source: {
    readonly adapter_id: "granola";
    readonly instance_id: string;
    readonly version: string;
    /** The current cursor, initially the admitted live-only cutoff cursor. */
    readonly cursor: string;
    /** The immutable stopped-time boundary, retained after cursor advances. */
    readonly cutoff_at: string;
  };
  readonly processor: {
    readonly adapter_id: "llm";
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
export interface CleanLiveOnlySourceStateV1 {
  readAdmission(): Promise<CleanGranolaSourceAdmissionV1>;
  /** Returns the original frozen snapshot for an admitted source revision. */
  readFrozenCandidateForSourceRevision(input: {
    readonly external_id: string;
    readonly canonical_revision: string;
  }): Promise<CleanFrozenCandidateSnapshotV1 | undefined>;
  /** Finds a prior frozen extraction whose bounded review input is identical. */
  readFrozenCandidateForReviewInput(input: {
    readonly review_lineage_id: string;
    readonly review_input_sha256: string;
  }): Promise<CleanFrozenCandidateSnapshotV1 | undefined>;
  stageCandidate(
    input: CleanLiveCandidateSnapshotInputV1,
  ): Promise<CleanLiveCandidateV1>;
  advanceCursor(input: {
    readonly expected_cursor: string;
    readonly next_cursor: string;
  }): Promise<"advanced" | "state_drift" | "revoked">;
}

export interface CleanLiveCandidateSnapshotInputV1 {
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
  readonly review_policy: CleanReviewPolicySnapshotV1;
}

interface CleanLiveCandidateBaseV1 {
  readonly candidate_id: string;
  readonly candidate_semantic_sha256: string;
  readonly review_lineage_id: string;
  readonly review_input_sha256: string;
  readonly review_semantic_sha256: string;
  readonly review_policy_id: CleanReviewPolicySnapshotV1["policy_id"];
  readonly review_policy_contract_sha256: CleanReviewPolicySnapshotV1["policy_contract_sha256"];
  readonly review_policy_consequence_text: string;
  readonly review_policy_consequence_sha256: CleanReviewPolicySnapshotV1["policy_consequence_sha256"];
}

/** A durable Authority candidate with a deterministic D2 handoff. */
export interface CleanActionableLiveCandidateV1
  extends CleanLiveCandidateBaseV1 {
  readonly disposition: "actionable";
  readonly approval_id: string;
  readonly stage_command_id: string;
  readonly state: "queued" | "posting" | "posted" | "staged" | "superseded";
}

/** An immutable source revision that intentionally creates no approval card. */
export interface CleanNonActionableLiveCandidateV1
  extends CleanLiveCandidateBaseV1 {
  readonly disposition: "coalesced" | "no_signals";
  readonly approval_id: null;
  readonly stage_command_id: null;
  readonly state: "coalesced" | "no_signals";
}

export type CleanLiveCandidateV1 =
  | CleanActionableLiveCandidateV1
  | CleanNonActionableLiveCandidateV1;

/** The immutable Authority snapshot associated with a durable candidate. */
export type CleanFrozenCandidateSnapshotV1 = CleanLiveCandidateV1 & {
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
};

export interface CleanApprovalStageInputV1 {
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly candidate: CleanActionableLiveCandidateV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
}

/**
 * This is deliberately a narrow handoff. The eventual control-plane adapter
 * owns the durable approval card and returns `staged` only once it is
 * committed. A known revoked or drifted control-plane state is a safe no-op.
 */
export interface CleanApprovalStagerV1 {
  stage(
    input: CleanApprovalStageInputV1,
    context?: { readonly signal: AbortSignal },
  ): Promise<
    | { readonly kind: "staged"; readonly stage_id: string }
    | { readonly kind: "delivery_pending" }
    | { readonly kind: "revoked" }
    | { readonly kind: "state_drift" }
  >;
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

export type CleanLiveOnlySourceCycleResultV1 =
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

export interface CleanLiveOnlySourceCycleV1Options {
  readonly source: MeetingSourceAdapter;
  readonly processor: DecisionProcessorAdapter;
  readonly state: CleanLiveOnlySourceStateV1;
  readonly stager: CleanApprovalStagerV1;
  /** Reduces adapter-specific metadata to the policy a reviewer authorizes. */
  readonly review_policy: (
    meeting: MeetingDocument,
  ) => CleanReviewPolicySnapshotV1;
}

function assertAdmissionMatchesAdapters(
  admission: CleanGranolaSourceAdmissionV1,
  source: MeetingSourceAdapter,
  processor: DecisionProcessorAdapter,
): void {
  if (
    source.identity.adapter_id !== admission.source.adapter_id ||
    source.identity.instance_id !== admission.source.instance_id ||
    source.identity.version !== admission.source.version
  ) {
    throw new Error(
      "clean source adapter differs from the admitted Granola source",
    );
  }
  if (
    processor.identity.adapter_id !== admission.processor.adapter_id ||
    processor.identity.instance_id !== admission.processor.instance_id ||
    processor.identity.version !== admission.processor.version
  ) {
    throw new Error(
      "clean processor adapter differs from the admitted fixed LLM processor",
    );
  }
  if (
    !admission.source.cursor.startsWith("granola:v1:") ||
    granolaCursorPhase(admission.source.cursor) !== "live" ||
    new Date(admission.source.cutoff_at).toISOString() !==
      admission.source.cutoff_at
  ) {
    throw new Error("clean source admission is not a live-only Granola state");
  }
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
 * only cursor comes from a previously admitted live-only Granola source, and
 * it advances that cursor only after either a verified empty provider page or
 * the downstream staging port reports a durable acknowledgement.
 */
export class CleanLiveOnlySourceCycleV1 {
  private running: Promise<CleanLiveOnlySourceCycleResultV1> | undefined;

  constructor(private readonly options: CleanLiveOnlySourceCycleV1Options) {}

  runOnce(signal?: AbortSignal): Promise<CleanLiveOnlySourceCycleResultV1> {
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
  ): Promise<CleanLiveOnlySourceCycleResultV1> {
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("clean live-only source cycle was cancelled");
    }
    const admission = await this.options.state.readAdmission();
    assertAdmissionMatchesAdapters(
      admission,
      this.options.source,
      this.options.processor,
    );
    // Approval delivery is a durable outbox, not the source checkpoint. Drain
    // prior work first, but never let one provider-ambiguous card prevent the
    // source adapter from admitting an unrelated meeting.
    await this.options.stager.reconcilePendingDeliveries(
      signal === undefined ? undefined : { signal },
    );
    const batch = await this.options.source.pull(
      { cursor: admission.source.cursor, limit: MAXIMUM_PULL_LIMIT },
      signal === undefined ? undefined : { signal },
    );
    assertCanonicalMeetingBatch(batch);
    if (batch.meetings.length > MAXIMUM_PULL_LIMIT) {
      throw new Error(
        "clean live-only source cycle accepts at most one meeting per poll",
      );
    }
    const meeting = batch.meetings[0];
    if (meeting === undefined) {
      if (
        batch.next_cursor === undefined ||
        batch.next_cursor === admission.source.cursor
      ) {
        return { kind: "empty", cursor_advanced: false };
      }
      const advanced = await this.options.state.advanceCursor({
        expected_cursor: admission.source.cursor,
        next_cursor: batch.next_cursor,
      });
      if (advanced === "advanced") {
        return { kind: "empty_cursor_advanced", cursor_advanced: true };
      }
      return {
        kind: "empty_cursor_not_advanced",
        reason: advanced,
        cursor_advanced: false,
      };
    }

    assertCanonicalMeetingDocument(meeting, this.options.source.identity);
    const reviewPolicy = this.options.review_policy(meeting);
    const frozen = await this.options.state.readFrozenCandidateForSourceRevision(
      {
        external_id: meeting.provenance.external_id,
        canonical_revision: meeting.provenance.canonical_revision,
      },
    );
    if (frozen !== undefined) {
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
    }

    const reviewInputSha256 = cleanReviewInputSha256V1({
      meeting,
      processor: {
        adapter_id: admission.processor.adapter_id,
        instance_id: admission.processor.instance_id,
        version: admission.processor.version,
        configuration_sha256: admission.processor.configuration_sha256,
      },
    });
    const reviewLineageId = cleanReviewLineageIdV1({
      adapter_id: meeting.provenance.source.adapter_id,
      instance_id: meeting.provenance.source.instance_id,
      external_id: meeting.provenance.external_id,
    });
    const reusable =
      await this.options.state.readFrozenCandidateForReviewInput({
        review_lineage_id: reviewLineageId,
        review_input_sha256: reviewInputSha256,
      });
    const decisions =
      reusable === undefined
        ? await this.options.processor.extract(
            meeting,
            {
              processor_version: this.options.processor.identity.version,
              input_fingerprint: inputFingerprint(
                meeting,
                this.options.processor,
              ),
            },
            signal === undefined ? undefined : { signal },
          )
        : rebindDecisionsToRevision(
            reusable.decisions,
            reusable.meeting,
            meeting,
          );
    assertCanonicalDecisionSet(
      decisions,
      meeting,
      this.options.processor.identity,
    );
    const candidate = await this.options.state.stageCandidate({
      admission,
      meeting,
      decisions,
      review_policy: reviewPolicy,
    });
    if (candidate.disposition !== "actionable") {
      await this.options.stager.reconcileSuperseded(
        signal === undefined ? undefined : { signal },
      );
      return candidate.disposition === "no_signals"
        ? this.finishWithoutStage("no_signals", admission, batch.next_cursor)
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
  }

  private async stageAndAdvance(
    candidate: CleanActionableLiveCandidateV1,
    admission: CleanGranolaSourceAdmissionV1,
    meeting: MeetingDocument,
    decisions: DecisionSet,
    nextCursor: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CleanLiveOnlySourceCycleResultV1> {
    const staged = await this.options.stager.stage(
      { admission, candidate, meeting, decisions },
      signal === undefined ? undefined : { signal },
    );
    if (staged.kind === "delivery_pending") {
      return this.advanceAfterPendingDelivery(admission, nextCursor);
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

  private async advanceAfterPendingDelivery(
    admission: CleanGranolaSourceAdmissionV1,
    nextCursor: string | undefined,
  ): Promise<CleanLiveOnlySourceCycleResultV1> {
    if (nextCursor === undefined || nextCursor === admission.source.cursor) {
      return { kind: "delivery_pending", cursor_advanced: false };
    }
    const advanced = await this.options.state.advanceCursor({
      expected_cursor: admission.source.cursor,
      next_cursor: nextCursor,
    });
    return advanced === "advanced"
      ? { kind: "delivery_pending", cursor_advanced: true }
      : {
          kind: "delivery_pending_cursor_not_advanced",
          reason: advanced,
          cursor_advanced: false,
        };
  }

  private async finishWithoutStage(
    kind: "no_signals" | "already_processed",
    admission: CleanGranolaSourceAdmissionV1,
    nextCursor: string | undefined,
  ): Promise<CleanLiveOnlySourceCycleResultV1> {
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
}
