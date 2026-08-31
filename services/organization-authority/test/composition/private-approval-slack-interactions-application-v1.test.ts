import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
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

function raw(input?: {
  readonly action_id?: string;
  readonly selected_option?: unknown;
  readonly comment?: string;
  readonly hash?: string;
  readonly state?: unknown;
}): Uint8Array {
  const actionId = input?.action_id ?? APPROVE_ID;
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
    ...(input?.hash === undefined ? {} : { hash: input.hash }),
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
      values:
        input?.state ??
        {
          policy: {
            [POLICY_ID]: {
              type: "radio_buttons",
              selected_option:
                input !== undefined && Object.hasOwn(input, "selected_option")
                  ? input.selected_option
                  : {
                      text: { type: "plain_text", text: "Team", emoji: false },
                      value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
                    },
            },
          },
          comment: {
            [COMMENT_ID]: {
              type: "plain_text_input",
              value: input?.comment ?? "Ship it.",
            },
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
  it("durably writes a digest-only verified terminal receipt before accepting it", async () => {
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "resolution",
        receipt: expect.objectContaining({
          action: "approve",
          action_id: APPROVE_ID,
          approval_id: CARD.approval_id,
          selected_policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          comment: "Ship it.",
          received_at: "2026-08-28T22:00:00.000Z",
          verified_at: "2026-08-28T22:00:00.000Z",
        }),
      }),
    );
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("response_url");
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("trigger_id");
  });

  it("acknowledges a verified selector event without persisting it", async () => {
    const enqueue = vi.fn();
    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
    });

    await expect(
      application.accept(request(raw({ action_id: POLICY_ID }))),
    ).resolves.toBe(
      "accepted",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("uses the narrow card default for untouched radio state and accepts media-type parameters", async () => {
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
    });
    const body = raw({
      selected_option: null,
      comment: "testing",
      hash: "1787980217.abcdef0123456789",
    });

    await expect(
      application.accept({
        ...request(body),
        content_type: "Application/X-Www-Form-Urlencoded; charset=utf-8",
      }),
    ).resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: expect.objectContaining({
          selected_policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          comment: "testing",
        }),
      }),
    );
  });

  it("separates authentication failures, malformed media, and durable queue failure", async () => {
    const queueFailure = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      persistence: {
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
      persistence: {
        enqueue: () => ({
          disposition: "resolution" as const,
          receipt: {} as never,
          receipt_sha256: `sha256:${"d".repeat(64)}` as const,
          idempotent: false,
        }),
      },
      now_unix_seconds: () => NOW,
    });
    await expect(
      application.accept({ ...request(raw()), content_type: "application/json" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(application.accept(request(raw(), "wrong-secret"))).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("reports only verified parser rejection stages without changing failures", async () => {
    const onRejection = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      persistence: { enqueue: vi.fn() },
      now_unix_seconds: () => NOW,
      on_rejection: onRejection,
    });

    await expect(
      application.accept(request(raw({ state: {} }))),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(onRejection).toHaveBeenCalledExactlyOnceWith({ stage: "state" });
    expect(JSON.stringify(onRejection.mock.calls)).toBe('[[{"stage":"state"}]]');

    await expect(
      application.accept(request(raw(), "wrong-secret")),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(onRejection).toHaveBeenCalledTimes(1);
  });

  it("does not persist when its durable receipt clock is non-canonical", async () => {
    const enqueue = vi.fn();
    const application = createPrivateApprovalSlackInteractionsApplicationV1({
      signing_secret: SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "not-a-time",
    });

    await expect(application.accept(request(raw()))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
