import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PrivateSlackApprovalInteractionHttpPortV1, PrivateSlackApprovalInteractionReplyV1 } from "../presentation/private-slack-approval-interaction-http-port-v1.js";
import {
  PrivateSlackApprovalInteractionError,
  parseVerifiedPrivateSlackApprovalInteractionV1,
  verifiedSlackResponseUrlV1,
  verifyPrivateSlackApprovalRequestV1,
  type VerifiedSlackApprovalClickV1,
} from "./private-slack-approval-interaction-protocol-v1.js";

const ACKNOWLEDGED: PrivateSlackApprovalInteractionReplyV1 = Object.freeze({ kind: "acknowledged" });
type ClickOutcomeV1 = "decided" | "already_decided" | "stale" | "refused";
/** What the clicker is told, privately, after a click that decided nothing. */
const FEEDBACK = new Map<Exclude<ClickOutcomeV1, "decided">, string>([
  ["stale", "This approval has changed. Open the ECHO desktop app to review it."],
  ["already_decided", "This decision was already made. The card will refresh."],
  ["refused", "This approval is no longer available. Open the ECHO desktop app to review it."],
]);
export interface PrivateSlackApprovalInteractionHandlerInputV1 {
  readonly signing_secret: () => string;
  readonly click: (click: VerifiedSlackApprovalClickV1) => { readonly outcome: ClickOutcomeV1 } | Promise<{ readonly outcome: ClickOutcomeV1 }>;
  /** Never awaited and never changes an already durable decision; the transport bounds its own POST. */
  readonly feedback?: (input: { readonly response_url: string; readonly text: string }) => Promise<void>;
  readonly now_unix_seconds?: () => number;
}
async function sendFeedbackBestEffort(
  feedback: NonNullable<PrivateSlackApprovalInteractionHandlerInputV1["feedback"]>,
  value: { readonly response_url: string; readonly text: string },
): Promise<void> {
  try {
    await feedback(value);
  } catch {
    // Slack feedback is best effort after the core's durable outcome.
  }
}
/** Posts Slack's ephemeral reply to a verified response URL, bounded to four seconds and refusing redirects. */
export async function sendSlackResponseUrlFeedbackV1(input: { readonly response_url: string; readonly text: string }): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(input.response_url, {
      method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: input.text }),
    });
    if (!response.ok) throw new Error("Slack approval feedback was rejected");
  } finally {
    clearTimeout(timeout);
  }
}
/** Verifies, parses and durably decides before acknowledgement. Provider feedback only uses a validated response URL and never delays the acknowledgement. */
export function createPrivateSlackApprovalInteractionHandlerV1(input: PrivateSlackApprovalInteractionHandlerInputV1): PrivateSlackApprovalInteractionHttpPortV1 {
  return Object.freeze({
    async accept(request: Parameters<PrivateSlackApprovalInteractionHttpPortV1["accept"]>[0]) {
      if (request.content_type?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
        throw new AuthorityOperationError("invalid_request", "Slack interaction content type is invalid");
      }
      const unauthorized = () => new AuthorityOperationError("unauthorized", "Slack interaction authentication failed");
      let signing_secret: string;
      try {
        signing_secret = input.signing_secret();
      } catch {
        throw unauthorized();
      }
      let verified;
      try {
        verified = verifyPrivateSlackApprovalRequestV1({
          raw_body: request.raw_body,
          signing_secret,
          headers: { "x-slack-request-timestamp": request.slack_request_timestamp, "x-slack-signature": request.slack_signature },
          now_unix_seconds: input.now_unix_seconds?.() ?? Math.floor(Date.now() / 1000),
        });
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError) throw unauthorized();
        throw error;
      }
      const response_url = verifiedSlackResponseUrlV1(verified);
      let interaction;
      try {
        interaction = parseVerifiedPrivateSlackApprovalInteractionV1(verified);
      } catch (error) {
        if (error instanceof PrivateSlackApprovalInteractionError) throw new AuthorityOperationError("invalid_request", "Slack interaction payload is invalid");
        throw error;
      }
      if (interaction.disposition === "presentation_change") return ACKNOWLEDGED;
      const outcome = (await input.click(interaction)).outcome;
      const text = outcome === "decided" ? undefined : FEEDBACK.get(outcome);
      if (text !== undefined && response_url !== undefined && input.feedback !== undefined) void sendFeedbackBestEffort(input.feedback, { response_url, text });
      return ACKNOWLEDGED;
    },
  });
}
