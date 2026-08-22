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
}

/** A durable Authority candidate and its deterministic D2 handoff. */
export interface CleanLiveCandidateV1 {
  readonly candidate_id: string;
  readonly candidate_semantic_sha256: string;
  readonly approval_id: string;
  readonly stage_command_id: string;
  readonly state: "queued" | "posted" | "staged";
}

/** The immutable Authority snapshot associated with a durable candidate. */
export interface CleanFrozenCandidateSnapshotV1 extends CleanLiveCandidateV1 {
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly meeting: MeetingDocument;
  readonly decisions: DecisionSet;
}

export interface CleanApprovalStageInputV1 {
  readonly admission: CleanGranolaSourceAdmissionV1;
  readonly candidate: CleanLiveCandidateV1;
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
    | { readonly kind: "revoked" }
    | { readonly kind: "state_drift" }
  >;
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
    const frozen = await this.options.state.readFrozenCandidateForSourceRevision(
      {
        external_id: meeting.provenance.external_id,
        canonical_revision: meeting.provenance.canonical_revision,
      },
    );
    if (frozen !== undefined) {
      if (frozen.state !== "staged") {
        const staged = await this.options.stager.stage(
          {
            admission: frozen.admission,
            candidate: frozen,
            meeting: frozen.meeting,
            decisions: frozen.decisions,
          },
          signal === undefined ? undefined : { signal },
        );
        if (staged.kind !== "staged") {
          return {
            kind: "not_staged",
            reason: staged.kind,
            cursor_advanced: false,
          };
        }
        if (
          batch.next_cursor === undefined ||
          batch.next_cursor === admission.source.cursor
        ) {
          return {
            kind: "staged",
            stage_id: staged.stage_id,
            cursor_advanced: false,
          };
        }
        const advanced = await this.options.state.advanceCursor({
          expected_cursor: admission.source.cursor,
          next_cursor: batch.next_cursor,
        });
        if (advanced !== "advanced") {
          return {
            kind: "staged_cursor_not_advanced",
            stage_id: staged.stage_id,
            reason: advanced,
            cursor_advanced: false,
          };
        }
        return {
          kind: "staged",
          stage_id: staged.stage_id,
          cursor_advanced: true,
        };
      }
      if (
        batch.next_cursor === undefined ||
        batch.next_cursor === admission.source.cursor
      ) {
        return { kind: "already_processed", cursor_advanced: false };
      }
      const advanced = await this.options.state.advanceCursor({
        expected_cursor: admission.source.cursor,
        next_cursor: batch.next_cursor,
      });
      if (advanced === "advanced") {
        return { kind: "already_processed", cursor_advanced: true };
      }
      return {
        kind: "already_processed_cursor_not_advanced",
        reason: advanced,
        cursor_advanced: false,
      };
    }
    const decisions = await this.options.processor.extract(
      meeting,
      {
        processor_version: this.options.processor.identity.version,
        input_fingerprint: inputFingerprint(meeting, this.options.processor),
      },
      signal === undefined ? undefined : { signal },
    );
    assertCanonicalDecisionSet(
      decisions,
      meeting,
      this.options.processor.identity,
    );
    if (decisions.signals.length === 0) {
      if (
        batch.next_cursor === undefined ||
        batch.next_cursor === admission.source.cursor
      ) {
        return { kind: "no_signals", cursor_advanced: false };
      }
      const advanced = await this.options.state.advanceCursor({
        expected_cursor: admission.source.cursor,
        next_cursor: batch.next_cursor,
      });
      if (advanced === "advanced") {
        return { kind: "no_signals_cursor_advanced", cursor_advanced: true };
      }
      return {
        kind: "no_signals_cursor_not_advanced",
        reason: advanced,
        cursor_advanced: false,
      };
    }
    const candidate = await this.options.state.stageCandidate({
      admission,
      meeting,
      decisions,
    });
    const staged = await this.options.stager.stage(
      { admission, candidate, meeting, decisions },
      signal === undefined ? undefined : { signal },
    );
    if (staged.kind !== "staged") {
      return {
        kind: "not_staged",
        reason: staged.kind,
        cursor_advanced: false,
      };
    }
    if (
      batch.next_cursor === undefined ||
      batch.next_cursor === admission.source.cursor
    ) {
      return {
        kind: "staged",
        stage_id: staged.stage_id,
        cursor_advanced: false,
      };
    }
    const advanced = await this.options.state.advanceCursor({
      expected_cursor: admission.source.cursor,
      next_cursor: batch.next_cursor,
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
}
