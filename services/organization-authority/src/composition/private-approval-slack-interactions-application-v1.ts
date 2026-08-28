import { AuthorityOperationError } from "../domain/errors.js";
import type { PrivateApprovalSlackInteractionsHttpApplicationV1 } from "../presentation/private-approval-slack-interactions-http-application-v1.js";
import {
  PrivateApprovalSlackInteractionError,
  parseVerifiedPrivateApprovalSlackInteractionV1,
  verifyPrivateApprovalSlackRequestV1,
  type PrivateApprovalSlackResolutionIntentV1,
} from "./private-approval-slack-interaction-v1.js";

export interface PrivateApprovalSlackResolutionIntentQueueV1 {
  enqueue(
    intent: PrivateApprovalSlackResolutionIntentV1,
  ): Promise<
    | { readonly kind: "queued" }
    | { readonly kind: "replay" }
    | { readonly kind: "ignored" }
  >;
}

export interface PrivateApprovalSlackInteractionsApplicationInputV1 {
  /** Private runtime input. It must never be logged or persisted. */
  readonly signing_secret: string;
  readonly queue: PrivateApprovalSlackResolutionIntentQueueV1;
  readonly now_unix_seconds?: () => number;
}

/**
 * Verifies and normalizes one Slack interaction before any durable call.
 * Signed policy/comment change events are acknowledged as presentation-only
 * no-ops. Terminal buttons must first be durably queued (or proven an exact
 * replay/denial) before the HTTP layer returns its 200 acknowledgement.
 */
export function createPrivateApprovalSlackInteractionsApplicationV1(
  input: PrivateApprovalSlackInteractionsApplicationInputV1,
): PrivateApprovalSlackInteractionsHttpApplicationV1 {
  return Object.freeze({
    async accept(
      request: Parameters<
        PrivateApprovalSlackInteractionsHttpApplicationV1["accept"]
      >[0],
    ): Promise<"accepted"> {
      if (request.content_type !== "application/x-www-form-urlencoded") {
        throw new AuthorityOperationError(
          "invalid_request",
          "Slack interaction content type is invalid",
        );
      }
      let verified;
      try {
        verified = verifyPrivateApprovalSlackRequestV1({
          raw_body: request.raw_body,
          signing_secret: input.signing_secret,
          headers: {
            "x-slack-request-timestamp": request.slack_request_timestamp,
            "x-slack-signature": request.slack_signature,
          },
          now_unix_seconds:
            input.now_unix_seconds?.() ?? Math.floor(Date.now() / 1_000),
        });
      } catch (error) {
        if (error instanceof PrivateApprovalSlackInteractionError) {
          throw new AuthorityOperationError(
            "unauthorized",
            "Slack interaction authentication failed",
          );
        }
        throw error;
      }

      let interaction;
      try {
        interaction = parseVerifiedPrivateApprovalSlackInteractionV1(verified);
      } catch (error) {
        if (error instanceof PrivateApprovalSlackInteractionError) {
          throw new AuthorityOperationError(
            "invalid_request",
            "Slack interaction payload is invalid",
          );
        }
        throw error;
      }
      if (interaction.disposition === "presentation_change") return "accepted";

      try {
        await input.queue.enqueue(interaction);
        return "accepted";
      } catch (error) {
        if (error instanceof AuthorityOperationError) throw error;
        throw new AuthorityOperationError(
          "unavailable",
          "Slack interaction could not be durably queued",
        );
      }
    },
  });
}
