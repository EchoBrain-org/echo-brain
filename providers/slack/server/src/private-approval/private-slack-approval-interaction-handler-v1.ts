import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type {
  PrivateSlackApprovalInteractionHttpPortV1,
  PrivateSlackApprovalInteractionReplyV1,
} from "../presentation/private-slack-approval-interaction-http-port-v1.js";
import {
  PrivateSlackApprovalInteractionError,
  parseVerifiedPrivateSlackApprovalInteractionV1,
  verifiedSlackResponseUrlV1,
  verifyPrivateSlackApprovalRequestV1,
  type PrivateSlackApprovalInteractionRejectionStageV1,
  type VerifiedSlackApprovalClickV1,
} from "./private-slack-approval-interaction-protocol-v1.js";

const ACKNOWLEDGED: PrivateSlackApprovalInteractionReplyV1 = Object.freeze({
  kind: "acknowledged",
});
function formContentType(value: string | undefined): boolean {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}
export interface PrivateSlackApprovalInteractionHandlerInputV1 {
  readonly signing_secret: () => string;
  readonly click: (click: VerifiedSlackApprovalClickV1) =>
    | { readonly outcome: "decided" | "already_decided" | "stale" | "refused" }
    | Promise<{
        readonly outcome: "decided" | "already_decided" | "stale" | "refused";
      }>;
  readonly feedback?: (input: {
    readonly response_url: string;
    readonly text: string;
  }) => Promise<void>;
  /** Bounded provider feedback never changes an already durable decision. */
  readonly feedback_timeout_ms?: number;
  readonly now_unix_seconds?: () => number;
  readonly on_rejection?: (event: {
    readonly stage: PrivateSlackApprovalInteractionRejectionStageV1;
  }) => void;
}
async function sendFeedbackBestEffort(input: {
  readonly feedback: (value: {
    readonly response_url: string;
    readonly text: string;
  }) => Promise<void>;
  readonly value: { readonly response_url: string; readonly text: string };
  readonly timeout_ms: number;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      input.feedback(input.value),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, input.timeout_ms);
      }),
    ]);
  } catch {
    // Slack feedback is best effort after the core's durable outcome.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** Verifies, parses and durably decides before acknowledgement. Provider feedback only uses a validated response URL. */
export function createPrivateSlackApprovalInteractionHandlerV1(
  input: PrivateSlackApprovalInteractionHandlerInputV1,
): PrivateSlackApprovalInteractionHttpPortV1 {
  return Object.freeze({
    async accept(
      request: Parameters<
        PrivateSlackApprovalInteractionHttpPortV1["accept"]
      >[0],
    ) {
      if (!formContentType(request.content_type))
        throw new AuthorityOperationError(
          "invalid_request",
          "Slack interaction content type is invalid",
        );
      let signing_secret: string;
      try {
        signing_secret = input.signing_secret();
      } catch {
        throw new AuthorityOperationError(
          "unauthorized",
          "Slack interaction authentication failed",
        );
      }
      let verified;
      try {
        verified = verifyPrivateSlackApprovalRequestV1({
          raw_body: request.raw_body,
          signing_secret,
          headers: {
            "x-slack-request-timestamp": request.slack_request_timestamp,
            "x-slack-signature": request.slack_signature,
          },
          now_unix_seconds:
            input.now_unix_seconds?.() ?? Math.floor(Date.now() / 1000),
        });
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError)
          throw new AuthorityOperationError(
            "unauthorized",
            "Slack interaction authentication failed",
          );
        throw error;
      }
      const verified_response_url = verifiedSlackResponseUrlV1(verified);
      let interaction;
      try {
        interaction = parseVerifiedPrivateSlackApprovalInteractionV1(verified);
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError) {
          try {
            input.on_rejection?.({ stage: error.rejection_stage });
          } catch {}
          throw new AuthorityOperationError(
            "invalid_request",
            "Slack interaction payload is invalid",
          );
        }
        throw error;
      }
      if (interaction.disposition === "presentation_change")
        return ACKNOWLEDGED;
      const outcome = (await input.click(interaction)).outcome;
      const text =
        outcome === "stale"
          ? "This approval has changed. Open the ECHO desktop app to review it."
          : outcome === "already_decided"
            ? "This decision was already made. The card will refresh."
            : outcome === "refused"
              ? "This approval is no longer available. Open the ECHO desktop app to review it."
              : undefined;
      const response_url =
        text === undefined ? undefined : verified_response_url;
      if (
        text !== undefined &&
        response_url !== undefined &&
        input.feedback !== undefined
      ) {
        await sendFeedbackBestEffort({
          feedback: input.feedback,
          value: { response_url, text },
          timeout_ms: input.feedback_timeout_ms ?? 5_000,
        });
      }
      return ACKNOWLEDGED;
    },
  });
}
