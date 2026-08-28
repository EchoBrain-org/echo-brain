import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1,
  privateApprovalBlockKitActionIdV1,
} from "../../src/composition/private-approval-block-kit-card-v1.js";
import { createPrivateApprovalSlackInteractionsApplicationV1 } from "../../src/composition/private-approval-slack-interactions-application-v1.js";

const SECRET = "not-a-real-signing-secret";
const NOW = 1_800_000_000;
const CARD = {
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
  assignment_version: 1,
};
const POLICY_ID = privateApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy,
);
const COMMENT_ID = privateApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment,
);
const APPROVE_ID = privateApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve,
);

function raw(actionId = APPROVE_ID): Uint8Array {
  const payload = {
    type: "block_actions",
    user: { id: "U012ABCDEF", team_id: "T012ABCDEF" },
    api_app_id: "A012ABCDEF",
    trigger_id: "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD",
    container: {
      type: "message",
      channel_id: "D012ABCDEF",
      message_ts: "1712345678.123456",
      is_ephemeral: false,
    },
    team: { id: "T012ABCDEF", domain: "echo" },
    enterprise: null,
    is_enterprise_install: false,
    channel: { id: "D012ABCDEF", name: "directmessage" },
    message: {
      type: "message",
      user: "U098BOTAPP",
      ts: "1712345678.123456",
      app_id: "A012ABCDEF",
      bot_id: "B012ABCDEF",
      blocks: [],
    },
    state: {
      values: {
        policy: {
          [POLICY_ID]: {
            type: "radio_buttons",
            selected_option: {
              text: { type: "plain_text", text: "Team", emoji: false },
              value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
            },
          },
        },
        comment: {
          [COMMENT_ID]: { type: "plain_text_input", value: "Ship it." },
        },
      },
    },
    actions: [
      {
        type: actionId === POLICY_ID ? "radio_buttons" : "button",
        action_id: actionId,
        block_id: "actions",
        value: JSON.stringify({ schema_version: 1, ...CARD }),
        action_ts: "1712345680.123456",
      },
    ],
  };
  return new TextEncoder().encode(
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
  );
}

function request(body: Uint8Array, secret = SECRET) {
  const signature = createHmac("sha256", secret)
    .update(`v0:${NOW}:`)
    .update(body)
    .digest("hex");
  return {
    raw_body: body,
    content_type: "application/x-www-form-urlencoded",
    slack_request_timestamp: String(NOW),
    slack_signature: `v0=${signature}`,
  };
}

describe("private Slack interactions application V1", () => {
  it("durably queues a verified terminal intent before accepting it", async () => {
    const enqueue = vi.fn(async () => ({ kind: "queued" as const }));
    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      queue: { enqueue },
      now_unix_seconds: () => NOW,
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "resolution",
        action: "approve",
        action_id: APPROVE_ID,
        approval_id: CARD.approval_id,
        selected_policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        comment: "Ship it.",
      }),
    );
  });

  it("acknowledges a verified selector event without persisting it", async () => {
    const enqueue = vi.fn();
    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      queue: { enqueue },
      now_unix_seconds: () => NOW,
    });

    await expect(application.accept(request(raw(POLICY_ID)))).resolves.toBe(
      "accepted",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("separates authentication failures, malformed media, and durable queue failure", async () => {
    const queueFailure = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      queue: {
        enqueue: async () => {
          throw new Error("database busy");
        },
      },
      now_unix_seconds: () => NOW,
    });
    await expect(queueFailure.accept(request(raw()))).rejects.toMatchObject({
      code: "unavailable",
    });

    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      queue: { enqueue: async () => ({ kind: "queued" }) },
      now_unix_seconds: () => NOW,
    });
    await expect(
      application.accept({ ...request(raw()), content_type: "application/json" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(application.accept(request(raw(), "wrong-secret"))).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});
