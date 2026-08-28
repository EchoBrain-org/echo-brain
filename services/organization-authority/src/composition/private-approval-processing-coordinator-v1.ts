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
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type {
  CanonicalPrivateApprovalV4ReceiptV1,
  PrivateApprovalPresentationRecoveryV1,
  PrivateApprovalTerminalReceiptV1,
  RecordPrivateApprovalTerminalReceiptInputV1,
} from "./sqlite-private-approval-assignment-state-v1.js";
import type {
  FrozenPrivateSlackApprovalCandidateV1,
  PrivateSlackBlockApprovalTerminalV1,
  PrivateSlackBlockV4RecordWriterV1,
} from "../processing/clean-v1-record/private-slack-block-v4-record-writer-v1.js";
import type { PrivateSlackApprovalCardPosterV1 } from "../processing/clean-v1/private-slack-approval-card-poster-v1.js";

type Awaitable<T> = T | Promise<T>;

/** The strictly minimal durable Control Plane worker port. */
export interface PrivateApprovalProcessingControlPlaneV1 {
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
export interface PrivateApprovalProcessingFrozenCandidateV1
  extends FrozenPrivateSlackApprovalCandidateV1 {
  readonly candidate_id: string;
}

/**
 * Authority owns frozen source joins and the one-way receipt/card projection.
 * `readFrozenCandidateForApproval` may return a superseded frozen tuple only
 * for an already finalized terminal. It must never be used for new ingress.
 */
export interface PrivateApprovalProcessingAuthorityV1 {
  readFrozenCandidateForApproval(
    approvalId: string,
  ): Awaitable<PrivateApprovalProcessingFrozenCandidateV1 | undefined>;
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

export interface PrivateApprovalProcessingCoordinatorV1Options {
  readonly control_plane: PrivateApprovalProcessingControlPlaneV1;
  readonly authority: PrivateApprovalProcessingAuthorityV1;
  readonly record_writer: Pick<
    PrivateSlackBlockV4RecordWriterV1,
    "appendApproved"
  >;
  readonly poster: Pick<PrivateSlackApprovalCardPosterV1, "renderTerminal">;
}

/**
 * Strictly serial use is supplied by the live worker. The operations remain
 * replay-safe across process crashes and a second runner nonetheless: V4 has
 * its semantic idempotency key, Authority terminal receipts are immutable,
 * and Slack terminal rendering is a replacement update.
 */
export class PrivateApprovalProcessingCoordinatorV1 {
  constructor(
    private readonly options: PrivateApprovalProcessingCoordinatorV1Options,
  ) {}

  /** Complete previously finalized terminals before accepting new work. */
  async recoverV4Appends(signal: AbortSignal): Promise<void> {
    await this.materializeDurableTerminals(signal);
  }

  /** Drain signed actions, terminalizing non-retryable denials durably. */
  async observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void> {
    for (const queued of this.options.control_plane.listQueued()) {
      signal.throwIfAborted();
      try {
        await this.options.control_plane.finalize(
          queued.receipt.provider_action_key_sha256,
        );
      } catch (error) {
        if (error instanceof PrivateApprovalFinalizationDeniedError) {
          this.options.control_plane.recordDenied(
            queued.receipt.provider_action_key_sha256,
            error.reason_code,
          );
          continue;
        }
        // A competing terminal click cannot become the decision terminal.
        // Persist it as state drift so this second receipt cannot spin forever.
        if (error instanceof PrivateApprovalFinalizationConflictError) {
          this.options.control_plane.recordDenied(
            queued.receipt.provider_action_key_sha256,
            "state_drift",
          );
          continue;
        }
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
    if (existing !== undefined) return existing;

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
      return this.options.authority.recordTerminal({
        candidate_id: candidate.candidate_id,
        resolution: terminal.resolution,
      });
    }

    const appended = await this.options.record_writer.appendApproved(
      terminal as PrivateSlackBlockApprovalTerminalV1,
      candidate,
    );
    return this.options.authority.recordTerminal({
      candidate_id: candidate.candidate_id,
      resolution: terminal.resolution,
      // `recordTerminal` validates the complete signed Receipt V2 wrapper
      // before it makes the V4 receipt durable.
      v4_receipt: appended.receipt as unknown as CanonicalPrivateApprovalV4ReceiptV1,
    });
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
