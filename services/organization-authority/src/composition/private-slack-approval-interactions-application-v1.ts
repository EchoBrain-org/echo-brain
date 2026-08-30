import { AuthorityOperationError } from "../domain/errors.js";
import type {
  EnqueuePrivateApprovalInteractionResultV1,
  PrivateApprovalSignedTerminalActionV1,
} from "@echo-brain/organization-control-plane/slack-approval-runtime-v1";
import type { PrivateSlackApprovalInteractionsHttpApplicationV1 } from "../presentation/private-slack-approval-interactions-http-application-v1.js";
import {
  PrivateSlackApprovalInteractionError,
  parseVerifiedPrivateSlackApprovalInteractionV1,
  type PrivateSlackApprovalInteractionRejectionStageV1,
  verifyPrivateSlackApprovalRequestV1,
} from "./private-slack-approval-interaction-v1.js";

/**
 * The one durable operation this ingress needs. Keeping this narrow avoids a
 * second queue adapter whose only job was to copy the verified intent into
 * this receipt shape.
 */
export interface PrivateSlackApprovalResolutionPersistenceV1 {
  enqueue(input: {
    readonly disposition: "resolution";
    readonly receipt: PrivateApprovalSignedTerminalActionV1;
  }):
    | EnqueuePrivateApprovalInteractionResultV1
    | Promise<EnqueuePrivateApprovalInteractionResultV1>;
}

export interface PrivateSlackApprovalInteractionsApplicationInputV1 {
  /** Private runtime input. It must never be logged or persisted. */
  readonly signing_secret: string;
  readonly persistence: PrivateSlackApprovalResolutionPersistenceV1;
  /** Clock for request freshness and durable receipt timestamps. */
  readonly now_unix_seconds?: () => number;
  readonly now?: () => string;
  /**
   * Observational only. Receives no provider data and is invoked only after a
   * successfully HMAC-verified request fails the parser boundary.
   */
  readonly on_rejection?: (event: {
    readonly stage: PrivateSlackApprovalInteractionRejectionStageV1;
  }) => void;
}

function reportRejection(
  input: PrivateSlackApprovalInteractionsApplicationInputV1,
  stage: PrivateSlackApprovalInteractionRejectionStageV1,
): void {
  try {
    input.on_rejection?.(Object.freeze({ stage }));
  } catch {
    // Diagnostics must never change the provider acknowledgement path.
  }
}

function canonicalNow(now: () => string): string {
  const value = now();
  let canonical: string | undefined;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    canonical = undefined;
  }
  if (canonical !== value) {
    throw new Error("private approval Slack receipt time must be UTC milliseconds");
  }
  return value;
}

function isSlackFormContentType(value: string | undefined): boolean {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

/**
 * Verifies and normalizes one Slack interaction before any durable call.
 * Signed policy/comment change events are acknowledged as presentation-only
 * no-ops. Terminal buttons must first be durably queued (or proven an exact
 * replay/denial) before the HTTP layer returns its 200 acknowledgement.
 */
export function createPrivateSlackApprovalInteractionsApplicationV1(
  input: PrivateSlackApprovalInteractionsApplicationInputV1,
): PrivateSlackApprovalInteractionsHttpApplicationV1 {
  const now = input.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async accept(
      request: Parameters<
        PrivateSlackApprovalInteractionsHttpApplicationV1["accept"]
      >[0],
    ): Promise<"accepted"> {
      if (!isSlackFormContentType(request.content_type)) {
        throw new AuthorityOperationError(
          "invalid_request",
          "Slack interaction content type is invalid",
        );
      }
      let verified;
      try {
        verified = verifyPrivateSlackApprovalRequestV1({
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
      if (interaction.disposition === "presentation_change") return "accepted";

      try {
        const observedAt = canonicalNow(now);
        const result = await input.persistence.enqueue({
          disposition: "resolution",
          receipt: Object.freeze({
            schema_version: 1,
            kind: "echo-private-approval-signed-block-action-receipt-v1",
            provider_action_key_sha256: interaction.provider_action_key_sha256,
            request: interaction.request,
            approval_id: interaction.approval_id,
            action_id: interaction.action_id,
            action: interaction.action,
            selected_policy_id: interaction.selected_policy_id,
            comment: interaction.comment,
            lookup: interaction.lookup,
            received_at: observedAt,
            verified_at: observedAt,
          }),
        });
        if (result.disposition !== "resolution") {
          throw new Error("private approval terminal receipt was not queued");
        }
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
