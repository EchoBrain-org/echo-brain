import { describe, expect, it, vi } from "vitest";
import { createPrivateApprovalSlackResolutionIntentQueueV1 } from "../../src/composition/private-approval-slack-resolution-queue-v1.js";
import type { PrivateApprovalSlackResolutionIntentV1 } from "../../src/composition/private-approval-slack-interaction-v1.js";

const NOW = "2026-08-28T22:00:00.000Z";
const INTENT: PrivateApprovalSlackResolutionIntentV1 = Object.freeze({
  schema_version: 1,
  kind: "echo-private-approval-slack-interaction-v1",
  disposition: "resolution",
  action: "approve",
  action_id: "echo-private-approval-v1-0123456789abcdef0123456789abcdef-approve-v1",
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
  assignment_version: 1,
  selected_policy_id: "restricted-reviewer-person-v2",
  comment: "Looks right.",
  provider_action_key_sha256: `sha256:${"a".repeat(64)}`,
  request: Object.freeze({
    request_timestamp: "1787979600",
    signature_version: "v0",
    signature_sha256: `sha256:${"b".repeat(64)}`,
    raw_body_sha256: `sha256:${"c".repeat(64)}`,
  }),
  lookup: Object.freeze({
    api_app_id: "A01",
    workspace_id: "T01",
    enterprise_id: null,
    slack_user_id: "U01",
    channel_id: "D01",
    message_ts: "1787979600.000001",
    message_user_id: "U02",
    message_bot_id: "B01",
    message_app_id: "A01",
  }),
});

describe("private approval Slack resolution queue V1", () => {
  it.each([
    [false, "queued"],
    [true, "replay"],
  ] as const)("persists a digest-only receipt (idempotent=%s)", async (idempotent, kind) => {
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent,
    }));
    const queue = createPrivateApprovalSlackResolutionIntentQueueV1({
      persistence: { enqueue },
      now: () => NOW,
    });

    await expect(queue.enqueue(INTENT)).resolves.toEqual({ kind });
    expect(enqueue).toHaveBeenCalledWith({
      disposition: "resolution",
      receipt: {
        schema_version: 1,
        kind: "echo-private-approval-signed-block-action-receipt-v1",
        provider_action_key_sha256: INTENT.provider_action_key_sha256,
        request: INTENT.request,
        approval_id: INTENT.approval_id,
        assignment_version: INTENT.assignment_version,
        action_id: INTENT.action_id,
        action: INTENT.action,
        selected_policy_id: INTENT.selected_policy_id,
        comment: INTENT.comment,
        lookup: INTENT.lookup,
        received_at: NOW,
        verified_at: NOW,
      },
    });
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("response_url");
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("trigger_id");
  });

  it("rejects a non-canonical persistence timestamp", async () => {
    const queue = createPrivateApprovalSlackResolutionIntentQueueV1({
      persistence: { enqueue: vi.fn() },
      now: () => "not-a-time",
    });
    await expect(queue.enqueue(INTENT)).rejects.toThrow("UTC milliseconds");
  });
});
