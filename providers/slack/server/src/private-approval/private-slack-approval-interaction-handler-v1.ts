import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type {
  PrivateSlackApprovalInteractionHttpPortV1,
  PrivateSlackApprovalInteractionReplyV1,
} from "../presentation/private-slack-approval-interaction-http-port-v1.js";
import { PrivateSlackApprovalInteractionError, parseVerifiedPrivateSlackApprovalInteractionV1, type PrivateSlackApprovalInteractionRejectionStageV1, verifyPrivateSlackApprovalRequestV1 } from "./private-slack-approval-interaction-protocol-v1.js";

/**
 * Slack approvals are paused: an Approve or Reject click is verified and
 * parsed, changes nothing, and gets this reply until clicks decide through
 * the approval core.
 */
export const PRIVATE_SLACK_APPROVAL_INACTIVE_CARD_TEXT_V1 =
  "This card is no longer active. Open the ECHO desktop app to review it.";

const ACKNOWLEDGED: PrivateSlackApprovalInteractionReplyV1 = Object.freeze({ kind: "acknowledged" });
const INACTIVE_CARD: PrivateSlackApprovalInteractionReplyV1 = Object.freeze({
  kind: "ephemeral",
  text: PRIVATE_SLACK_APPROVAL_INACTIVE_CARD_TEXT_V1,
});

export interface PrivateSlackApprovalInteractionHandlerInputV1 {
  /**
   * Private runtime input. It must never be logged or persisted. It is read
   * per request, so the active connection's app secret applies at once.
   */
  readonly signing_secret: () => string;
  /** Clock for request freshness. */
  readonly now_unix_seconds?: () => number;
  /**
   * Observational only. Receives no provider data and is invoked only after a
   * successfully HMAC-verified request fails the parser boundary.
   */
  readonly on_rejection?: (event: {
    readonly stage: PrivateSlackApprovalInteractionRejectionStageV1;
  }) => void;
}

function reportRejection(
  input: PrivateSlackApprovalInteractionHandlerInputV1,
  stage: PrivateSlackApprovalInteractionRejectionStageV1,
): void {
  try {
    input.on_rejection?.(Object.freeze({ stage }));
  } catch {
    // Diagnostics must never change the provider acknowledgement path.
  }
}

function isSlackFormContentType(value: string | undefined): boolean {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

/**
 * Verifies and normalizes one Slack interaction and writes nothing. Signed
 * selector and input changes are acknowledged as presentation-only no-ops;
 * terminal buttons get the fixed inactive-card reply.
 */
export function createPrivateSlackApprovalInteractionHandlerV1(
  input: PrivateSlackApprovalInteractionHandlerInputV1,
): PrivateSlackApprovalInteractionHttpPortV1 {
  return Object.freeze({
    async accept(
      request: Parameters<
        PrivateSlackApprovalInteractionHttpPortV1["accept"]
      >[0],
    ): Promise<PrivateSlackApprovalInteractionReplyV1> {
      if (!isSlackFormContentType(request.content_type)) {
        throw new AuthorityOperationError(
          "invalid_request",
          "Slack interaction content type is invalid",
        );
      }
      let signingSecret: string;
      try {
        signingSecret = input.signing_secret();
      } catch {
        throw new AuthorityOperationError(
          "unavailable",
          "Slack interaction verification is unavailable",
        );
      }
      let verified;
      try {
        verified = verifyPrivateSlackApprovalRequestV1({
          raw_body: request.raw_body,
          signing_secret: signingSecret,
          headers: {
            "x-slack-request-timestamp": request.slack_request_timestamp,
            "x-slack-signature": request.slack_signature,
          },
          now_unix_seconds:
            input.now_unix_seconds?.() ?? Math.floor(Date.now() / 1_000),
        });
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError) {
          throw new AuthorityOperationError(
            "unauthorized",
            "Slack interaction authentication failed",
          );
        }
        throw error;
      }

      let interaction;
      try {
        interaction = parseVerifiedPrivateSlackApprovalInteractionV1(verified);
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError) {
          reportRejection(input, error.rejection_stage);
          throw new AuthorityOperationError(
            "invalid_request",
            "Slack interaction payload is invalid",
          );
        }
        throw error;
      }
      if (interaction.disposition === "presentation_change") return ACKNOWLEDGED;
      return INACTIVE_CARD;
    },
  });
}
