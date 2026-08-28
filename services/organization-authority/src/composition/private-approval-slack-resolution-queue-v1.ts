import type {
  EnqueuePrivateApprovalInteractionResultV1,
  PrivateApprovalSignedTerminalActionV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type { PrivateApprovalSlackResolutionIntentQueueV1 } from "./private-approval-slack-interactions-application-v1.js";
import type { PrivateApprovalSlackResolutionIntentV1 } from "./private-approval-slack-interaction-v1.js";

export interface PrivateApprovalSlackResolutionPersistenceV1 {
  enqueue(input: {
    readonly disposition: "resolution";
    readonly receipt: PrivateApprovalSignedTerminalActionV1;
  }): EnqueuePrivateApprovalInteractionResultV1;
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
    throw new Error("private approval Slack queue time must be UTC milliseconds");
  }
  return value;
}

/**
 * Converts the already signature-verified presentation intent into the exact
 * digest-only durable Control Plane receipt. Raw request bytes, Slack's
 * response URL and trigger token never cross this boundary.
 */
export function createPrivateApprovalSlackResolutionIntentQueueV1(input: {
  readonly persistence: PrivateApprovalSlackResolutionPersistenceV1;
  readonly now?: () => string;
}): PrivateApprovalSlackResolutionIntentQueueV1 {
  const now = input.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async enqueue(
      intent: PrivateApprovalSlackResolutionIntentV1,
    ): Promise<{ readonly kind: "queued" } | { readonly kind: "replay" }> {
      const observedAt = canonicalNow(now);
      const result = input.persistence.enqueue({
        disposition: "resolution",
        receipt: Object.freeze({
          schema_version: 1,
          kind: "echo-private-approval-signed-block-action-receipt-v1",
          provider_action_key_sha256: intent.provider_action_key_sha256,
          request: intent.request,
          approval_id: intent.approval_id,
          assignment_version: intent.assignment_version,
          action_id: intent.action_id,
          action: intent.action,
          selected_policy_id: intent.selected_policy_id,
          comment: intent.comment,
          lookup: intent.lookup,
          received_at: observedAt,
          verified_at: observedAt,
        }),
      });
      if (result.disposition !== "resolution") {
        throw new Error("private approval terminal receipt was not queued");
      }
      return Object.freeze({ kind: result.idempotent ? "replay" : "queued" });
    },
  });
}
