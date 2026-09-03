/**
 * Private Block Kit D2-to-D3 worker.
 *
 * A Slack click is first durably queued and then finalized in Control Plane
 * under the stable Authority fence. This coordinator deliberately does not
 * inspect Slack payloads or derive policy: it only completes durable work.
 *
 * The order is important:
 *   queued signed action -> fenced CP terminal -> V4 only for approval
 *   -> Authority terminal receipt -> inert terminal DM card.
 *
 * Every boundary below is idempotent. In particular, a terminal that was
 * committed just before source supersession remains recoverable from its
 * frozen Authority tuple; no new terminal can be created after supersession.
 */
import {
  PrivateApprovalFinalizationConflictError,
  PrivateApprovalFinalizationDeniedError,
  type ApprovalContractSha256,
  type DurablePrivateApprovalTerminalV1,
  type PrivateApprovalDeniedReceiptReasonV1,
  type QueuedPrivateApprovalSignedActionV1,
} from "@echo-brain/organization-control-plane/slack-approval-integration-v1";
import type {
  CanonicalPrivateApprovalV4ReceiptV1,
  PrivateApprovalPresentationRecoveryV1,
  PrivateApprovalTerminalReceiptV1,
  RecordPrivateApprovalTerminalReceiptInputV1,
} from "./sqlite-private-slack-approval-assignment-state-v1.js";
import type {
  FrozenPrivateSlackApprovalCandidateV1,
  PrivateSlackBlockApprovalTerminalV1,
  PrivateSlackBlockV4RecordWriterV1,
} from "../../../../processing/adapters/approval-resolution/slack/private-slack-block-v4-record-writer-v1.js";
import type { PrivateSlackApprovalCardPosterV1 } from "../../../../processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";
import type {
  MeetingApprovalJourneyStageAttemptV1,
  MeetingApprovalJourneyTelemetryPortV1,
} from "../../../../processing/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.js";

type Awaitable<T> = T | Promise<T>;

/** The strictly minimal durable Control Plane worker port. */
export interface PrivateSlackApprovalTerminalControlPlaneV1 {
  listQueued(): readonly QueuedPrivateApprovalSignedActionV1[];
  listTerminals(): readonly DurablePrivateApprovalTerminalV1[];
  finalize(
    providerActionKeySha256: ApprovalContractSha256,
  ): Promise<DurablePrivateApprovalTerminalV1>;
  recordDenied(
    providerActionKeySha256: ApprovalContractSha256,
    reasonCode: PrivateApprovalDeniedReceiptReasonV1,
  ): unknown;
}

/** The V4 writer needs the frozen content; Authority additionally owns its ID. */
export interface PrivateSlackApprovalTerminalFrozenCandidateV1
  extends FrozenPrivateSlackApprovalCandidateV1 {
  readonly candidate_id: string;
}

/**
 * Authority owns frozen source joins and the one-way receipt/card projection.
 * `readFrozenCandidateForApproval` may return a superseded frozen tuple only
 * for an already finalized terminal. It must never be used for new ingress.
 */
export interface PrivateSlackApprovalTerminalAuthorityV1 {
  readFrozenCandidateForApproval(
    approvalId: string,
  ): Awaitable<PrivateSlackApprovalTerminalFrozenCandidateV1 | undefined>;
  readTerminal(
    approvalId: string,
  ): Awaitable<PrivateApprovalTerminalReceiptV1 | undefined>;
  recordTerminal(
    input: RecordPrivateApprovalTerminalReceiptInputV1,
  ): Awaitable<PrivateApprovalTerminalReceiptV1>;
  readForPresentation(
    approvalId: string,
  ): Awaitable<PrivateApprovalPresentationRecoveryV1 | undefined>;
  markTerminalCardRendered(
    approvalId: string,
  ): Awaitable<PrivateApprovalTerminalReceiptV1 | undefined>;
}

export interface PrivateSlackApprovalTerminalCoordinatorV1Options {
  readonly control_plane: PrivateSlackApprovalTerminalControlPlaneV1;
  readonly authority: PrivateSlackApprovalTerminalAuthorityV1;
  readonly record_writer: Pick<
    PrivateSlackBlockV4RecordWriterV1,
    "appendApproved"
  >;
  readonly poster: Pick<PrivateSlackApprovalCardPosterV1, "renderTerminal">;
  /** Optional staging telemetry. It is deliberately fail-open. */
  readonly journey_telemetry?: MeetingApprovalJourneyTelemetryPortV1;
}

/**
 * Strictly serial use is supplied by the processing worker. The operations remain
 * replay-safe across process crashes and a second runner nonetheless: V4 has
 * its semantic idempotency key, Authority terminal receipts are immutable,
 * and Slack terminal rendering is a replacement update.
 */
export class PrivateSlackApprovalTerminalCoordinatorV1 {
  constructor(
    private readonly options: PrivateSlackApprovalTerminalCoordinatorV1Options,
  ) {}

  /** Complete previously finalized terminals before accepting new work. */
  async recoverV4Appends(signal: AbortSignal): Promise<void> {
    await this.materializeDurableTerminals(signal);
  }

  /** Drain signed actions, terminalizing non-retryable denials durably. */
  async observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void> {
    for (const queued of this.options.control_plane.listQueued()) {
      signal.throwIfAborted();
      const approvalId = queued.receipt.approval_id;
      const terminalAttempt = this.beginTerminalStage(approvalId);
      try {
        const terminal = await this.options.control_plane.finalize(
          queued.receipt.provider_action_key_sha256,
        );
        this.succeedStage(terminalAttempt, { outcome: terminal.outcome });
        if (terminal.outcome === "rejected") {
          this.skipRejectedOrDeniedDownstreamStages(approvalId);
        }
      } catch (error) {
        if (error instanceof PrivateApprovalFinalizationDeniedError) {
          try {
            this.options.control_plane.recordDenied(
              queued.receipt.provider_action_key_sha256,
              error.reason_code,
            );
          } catch (recordError) {
            this.failStage(terminalAttempt, recordError);
            throw recordError;
          }
          this.succeedStage(terminalAttempt, { outcome: "denied" });
          this.skipRejectedOrDeniedDownstreamStages(approvalId);
          continue;
        }
        // A competing terminal click cannot become the decision terminal.
        // Persist it as state drift so this second receipt cannot spin forever.
        if (error instanceof PrivateApprovalFinalizationConflictError) {
          try {
            this.options.control_plane.recordDenied(
              queued.receipt.provider_action_key_sha256,
              "state_drift",
            );
          } catch (recordError) {
            this.failStage(terminalAttempt, recordError);
            throw recordError;
          }
          this.succeedStage(terminalAttempt, { outcome: "denied" });
          this.skipRejectedOrDeniedDownstreamStages(approvalId);
          continue;
        }
        this.failStage(terminalAttempt, error);
        throw error;
      }
    }
  }

  /** Append only approved terminals, then finish their private DM projection. */
  async appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void> {
    await this.materializeDurableTerminals(signal);
  }

  private async materializeDurableTerminals(signal: AbortSignal): Promise<void> {
    for (const terminal of this.options.control_plane.listTerminals()) {
      signal.throwIfAborted();
      this.synthesizeTerminalSuccessIfMissing(terminal);
      const authorityTerminal = await this.materializeTerminal(terminal);
      signal.throwIfAborted();
      await this.reconcileTerminalCard(authorityTerminal);
    }
  }

  private async materializeTerminal(
    terminal: DurablePrivateApprovalTerminalV1,
  ): Promise<PrivateApprovalTerminalReceiptV1> {
    const approvalId = terminal.resolution.approval_id;
    const existing = await this.options.authority.readTerminal(approvalId);
    if (existing !== undefined) {
      if (existing.outcome === "rejected") {
        this.skipRejectedOrDeniedDownstreamStages(approvalId);
      } else if (existing.v4_receipt !== null) {
        // A prior worker may have committed the Authority receipt before this
        // optional sidecar existed. Preserve that completed append as an
        // instantaneous observation so search publication can resume.
        this.synthesizeRecordAppendSuccessIfMissing(approvalId);
      }
      return existing;
    }

    const candidate = await this.options.authority.readFrozenCandidateForApproval(
      approvalId,
    );
    if (candidate === undefined) {
      throw new Error("private terminal has no frozen Authority candidate");
    }
    if (candidate.approval_id !== approvalId) {
      throw new Error("private terminal Authority candidate has another approval ID");
    }

    if (terminal.outcome === "rejected") {
      // Rejection is a durable terminal and private card update only. It never
      // reaches V4 and therefore never releases a readable policy fact.
      const recorded = await this.options.authority.recordTerminal({
        candidate_id: candidate.candidate_id,
        resolution: terminal.resolution,
      });
      this.skipRejectedOrDeniedDownstreamStages(approvalId);
      return recorded;
    }

    const appendAttempt = this.beginStageForApproval(approvalId, "meeting_record_append");
    let appended: Awaited<ReturnType<PrivateSlackBlockV4RecordWriterV1["appendApproved"]>>;
    try {
      appended = await this.options.record_writer.appendApproved(
        terminal as PrivateSlackBlockApprovalTerminalV1,
        candidate,
      );
    } catch (error) {
      this.failStage(appendAttempt, error);
      throw error;
    }
    this.succeedStage(appendAttempt);
    this.markAwaitingSearch(approvalId);
    return this.options.authority.recordTerminal({
      candidate_id: candidate.candidate_id,
      resolution: terminal.resolution,
      // `recordTerminal` validates the complete signed Receipt V2 wrapper
      // before it makes the V4 receipt durable.
      v4_receipt: appended.receipt as unknown as CanonicalPrivateApprovalV4ReceiptV1,
    });
  }

  private beginTerminalStage(
    approvalId: string,
  ): MeetingApprovalJourneyStageAttemptV1 | null {
    if (this.hasTerminalStage(approvalId, "meeting_terminal_persist")) return null;
    return this.beginStageForApproval(approvalId, "meeting_terminal_persist");
  }

  private synthesizeTerminalSuccessIfMissing(
    terminal: DurablePrivateApprovalTerminalV1,
  ): void {
    const approvalId = terminal.resolution.approval_id;
    if (this.hasTerminalStage(approvalId, "meeting_terminal_persist")) return;
    const attempt = this.beginStageForApproval(approvalId, "meeting_terminal_persist");
    this.succeedStage(attempt, { outcome: terminal.outcome });
  }

  private synthesizeRecordAppendSuccessIfMissing(approvalId: string): void {
    if (!this.hasTerminalStage(approvalId, "meeting_record_append")) {
      const attempt = this.beginStageForApproval(approvalId, "meeting_record_append");
      this.succeedStage(attempt);
    }
    // Re-mark independently of the stage event. A crash or disposable-sidecar
    // failure can happen after the V4 append was observed but before its search
    // correlation row was written; the durable Authority receipt lets a later
    // pass repair that optional marker without appending again.
    this.markAwaitingSearch(approvalId);
  }

  private skipRejectedOrDeniedDownstreamStages(approvalId: string): void {
    this.skipStageForApproval(approvalId, "meeting_record_append");
    this.skipStageForApproval(approvalId, "meeting_search_publication");
  }

  private hasTerminalStage(
    approvalId: string,
    stage: "meeting_terminal_persist" | "meeting_record_append" | "meeting_search_publication",
  ): boolean {
    try {
      return this.options.journey_telemetry?.hasTerminalStage(approvalId, stage) ?? false;
    } catch {
      return false;
    }
  }

  private beginStageForApproval(
    approvalId: string,
    stage: "meeting_terminal_persist" | "meeting_record_append",
  ): MeetingApprovalJourneyStageAttemptV1 | null {
    try {
      return this.options.journey_telemetry?.beginStageForApproval(approvalId, stage) ?? null;
    } catch {
      return null;
    }
  }

  private succeedStage(
    attempt: MeetingApprovalJourneyStageAttemptV1 | null,
    input?: { readonly outcome?: "approved" | "rejected" | "denied" },
  ): void {
    try {
      this.options.journey_telemetry?.succeedStage(attempt, input);
    } catch {
      // Observability cannot alter a durable approval decision.
    }
  }

  private failStage(attempt: MeetingApprovalJourneyStageAttemptV1 | null, error: unknown): void {
    try {
      this.options.journey_telemetry?.failStage(attempt, error);
    } catch {
      // Observability cannot mask the original failure.
    }
  }

  private skipStageForApproval(
    approvalId: string,
    stage: "meeting_record_append" | "meeting_search_publication",
  ): void {
    if (this.hasTerminalStage(approvalId, stage)) return;
    try {
      this.options.journey_telemetry?.skipStageForApproval(approvalId, stage);
    } catch {
      // A telemetry sidecar is never a prerequisite for an approval action.
    }
  }

  private markAwaitingSearch(approvalId: string): void {
    try {
      this.options.journey_telemetry?.markAwaitingSearch(approvalId);
    } catch {
      // The durable V4 receipt remains authoritative when the sidecar fails.
    }
  }

  private async reconcileTerminalCard(
    terminal: PrivateApprovalTerminalReceiptV1,
  ): Promise<void> {
    if (terminal.card_render_state === "rendered") return;
    const presentation = await this.options.authority.readForPresentation(
      terminal.approval_id,
    );
    if (presentation === undefined) {
      throw new Error("private terminal has no frozen Slack card presentation");
    }
    const outcome = await this.options.poster.renderTerminal({
      approval_id: terminal.approval_id,
      outcome: terminal.outcome,
      policy_label:
        terminal.outcome === "approved"
          ? policyLabelFromResolution(terminal)
          : null,
      dm_channel_id: presentation.assignment.dm_channel.channel_id,
      provider_message_ts: presentation.provider_message_ts,
    });
    if (outcome.kind === "done") {
      await this.options.authority.markTerminalCardRendered(
        terminal.approval_id,
      );
    }
  }
}

function policyLabelFromResolution(
  terminal: PrivateApprovalTerminalReceiptV1,
): "Only me" | "Team" {
  const policy = terminal.resolution.canonical_record_policy;
  if (policy === null) {
    throw new Error("approved Authority terminal has no policy binding");
  }
  if (policy.policy_id === "restricted-reviewer-person-v2") return "Only me";
  if (policy.policy_id === "organization-member-readable-person-v2") return "Team";
  throw new Error("approved Authority terminal has an unsupported policy");
}
