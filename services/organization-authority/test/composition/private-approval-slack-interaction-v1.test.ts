import { createHash, createHmac } from "node:crypto";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import { describe, expect, it } from "vitest";
import {
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1,
  privateApprovalBlockKitActionIdV1,
} from "../../src/composition/private-approval-block-kit-card-v1.js";
import {
  PRIVATE_APPROVAL_SLACK_INTERACTION_MAX_AGE_SECONDS,
  PrivateApprovalSlackInteractionError,
  parseVerifiedPrivateApprovalSlackInteractionV1,
  verifyPrivateApprovalSlackRequestV1,
} from "../../src/composition/private-approval-slack-interaction-v1.js";

const SECRET = "not-a-real-signing-secret";
const NOW = 1_800_000_000;
const CARD = Object.freeze({
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
});
const POLICY_ACTION_ID = privateApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy,
);
const COMMENT_ACTION_ID = privateApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment,
);
const APPROVE_ACTION_ID = privateApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve,
);
const REJECT_ACTION_ID = privateApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.reject,
);
const TRIGGER_ID = "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD";
const ACTION_TS = "1712345680.123456";

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function payload(input?: {
  readonly action_id?: string;
  readonly action_type?: string;
  readonly action_value?: string;
  readonly selected_policy_id?: string;
  readonly comment?: string | null;
  readonly state?: unknown;
}): Record<string, unknown> {
  const actionId = input?.action_id ?? APPROVE_ACTION_ID;
  const state =
    input?.state ??
    {
      "policy-block": {
        [POLICY_ACTION_ID]: {
          type: "radio_buttons",
          selected_option: {
            text: { type: "plain_text", text: "Team", emoji: false },
            value:
              input?.selected_policy_id ??
              ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          },
        },
      },
      "comment-block": {
        [COMMENT_ACTION_ID]: {
          type: "plain_text_input",
          value:
            input !== undefined && Object.hasOwn(input, "comment")
              ? input.comment
              : "A clear decision rationale.",
        },
      },
    };
  const defaultActionType =
    actionId === POLICY_ACTION_ID
      ? "radio_buttons"
      : actionId === COMMENT_ACTION_ID
        ? "plain_text_input"
        : "button";
  return {
    type: "block_actions",
    user: { id: "U012ABCDEF", team_id: "T012ABCDEF" },
    api_app_id: "A012ABCDEF",
    trigger_id: TRIGGER_ID,
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
    state: { values: state },
    actions: [
      {
        type: input?.action_type ?? defaultActionType,
        action_id: actionId,
        block_id: "actions-block",
        value:
          input?.action_value ??
          JSON.stringify({ schema_version: 1, ...CARD }),
        action_ts: ACTION_TS,
      },
    ],
  };
}

function form(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    new URLSearchParams({ payload: JSON.stringify(value) }).toString(),
  );
}

function verify(body: Uint8Array, timestamp = String(NOW)) {
  const digest = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:`)
    .update(body)
    .digest("hex");
  return verifyPrivateApprovalSlackRequestV1({
    raw_body: body,
    signing_secret: SECRET,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${digest}`,
    },
    now_unix_seconds: NOW,
  });
}

function parse(value: unknown) {
  return parseVerifiedPrivateApprovalSlackInteractionV1(verify(form(value)));
}

describe("private approval Slack interaction v1", () => {
  it("verifies the original bytes and returns a bounded resolution intent without provider authority", () => {
    const value = payload({ comment: "  Capture this as the owner decision.  " });
    const raw = form(value);
    const providedSignature = `v0=${createHmac("sha256", SECRET)
      .update(`v0:${NOW}:`)
      .update(raw)
      .digest("hex")}`;
    const result = parseVerifiedPrivateApprovalSlackInteractionV1(verify(raw));

    expect(result).toEqual({
      schema_version: 1,
      kind: "echo-private-approval-slack-interaction-v1",
      disposition: "resolution",
      action: "approve",
      action_id: APPROVE_ACTION_ID,
      approval_id: CARD.approval_id,
      selected_policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      comment: "Capture this as the owner decision.",
      provider_action_key_sha256: sha256(
        [
          "echo-private-slack-provider-action-key-v1",
          "A012ABCDEF",
          "T012ABCDEF",
          "U012ABCDEF",
          "D012ABCDEF",
          "1712345678.123456",
          TRIGGER_ID,
          ACTION_TS,
          APPROVE_ACTION_ID,
        ].join("\u0000"),
      ),
      request: {
        request_timestamp: String(NOW),
        signature_version: "v0",
        signature_sha256: sha256(providedSignature),
        raw_body_sha256: sha256(raw),
      },
      lookup: {
        api_app_id: "A012ABCDEF",
        workspace_id: "T012ABCDEF",
        enterprise_id: null,
        slack_user_id: "U012ABCDEF",
        channel_id: "D012ABCDEF",
        message_ts: "1712345678.123456",
        message_user_id: "U098BOTAPP",
        message_app_id: "A012ABCDEF",
        message_bot_id: "B012ABCDEF",
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("response_url");
  });

  it("requires the complete selector and comment state for either resolving button", () => {
    const result = parse(
      payload({
        action_id: REJECT_ACTION_ID,
        selected_policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        comment: " \t\n ",
      }),
    );
    expect(result).toMatchObject({
      disposition: "resolution",
      action: "reject",
      selected_policy_id: null,
      comment: null,
    });

    const incomplete = payload({
      state: {
        "policy-block": {
          [POLICY_ACTION_ID]: {
            type: "radio_buttons",
            selected_option: {
              text: { type: "plain_text", text: "Only me", emoji: false },
              value: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
            },
          },
        },
      },
    });
    expect(() => parse(incomplete)).toThrow(PrivateApprovalSlackInteractionError);
  });

  it("accepts Slack's null untouched comment and omitted workspace-only hints", () => {
    const value = payload({ comment: null });
    delete value.enterprise;
    delete value.is_enterprise_install;

    expect(parse(value)).toMatchObject({
      disposition: "resolution",
      action: "approve",
      selected_policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      comment: null,
      lookup: { enterprise_id: null },
    });
  });

  it("accepts signed input events as presentation-only no-ops", () => {
    const policyChange = parse(
      payload({
        action_id: POLICY_ACTION_ID,
        action_type: "radio_buttons",
        state: {},
      }),
    );
    expect(policyChange).toMatchObject({
      disposition: "presentation_change",
      action: "policy",
      lookup: { slack_user_id: "U012ABCDEF" },
    });
    expect(
      parse(
        payload({
          action_id: COMMENT_ACTION_ID,
          action_type: "plain_text_input",
          state: {},
        }),
      ),
    ).toMatchObject({ disposition: "presentation_change", action: "comment" });
  });

  it("retains the bound message bot ID and refuses an unbound message shape", () => {
    const parsed = parse(payload());
    expect(parsed).toMatchObject({
      lookup: { message_bot_id: "B012ABCDEF" },
    });
    const missingBot = payload();
    delete (missingBot.message as Record<string, unknown>).bot_id;
    expect(() => parse(missingBot)).toThrow(PrivateApprovalSlackInteractionError);
  });

  it("rejects tampering, missing/old/future signatures, and does not expose request bytes", () => {
    const body = form(payload());
    const verified = verify(body);
    body[0] = body[0] === 0 ? 1 : 0;
    expect(parseVerifiedPrivateApprovalSlackInteractionV1(verified)).toMatchObject({
      disposition: "resolution",
    });

    const digest = createHmac("sha256", SECRET)
      .update(`v0:${NOW}:`)
      .update(form(payload()))
      .digest("hex");
    expect(() =>
      verifyPrivateApprovalSlackRequestV1({
        raw_body: form(payload()),
        signing_secret: SECRET,
        headers: {
          "x-slack-request-timestamp": String(NOW),
          "x-slack-signature": `v0=${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`,
        },
        now_unix_seconds: NOW,
      }),
    ).toThrow(PrivateApprovalSlackInteractionError);
    for (const timestamp of [
      String(NOW - PRIVATE_APPROVAL_SLACK_INTERACTION_MAX_AGE_SECONDS - 1),
      String(NOW + PRIVATE_APPROVAL_SLACK_INTERACTION_MAX_AGE_SECONDS + 1),
    ]) {
      expect(() => verify(form(payload()), timestamp)).toThrow(
        PrivateApprovalSlackInteractionError,
      );
    }
    expect(() =>
      parseVerifiedPrivateApprovalSlackInteractionV1(
        {} as never,
      ),
    ).toThrow(PrivateApprovalSlackInteractionError);
  });

  it("fails closed on noncanonical form, payload, action, policy, and comment shapes", () => {
    const body = new TextEncoder().encode(
      new URLSearchParams({ payload: JSON.stringify(payload()), extra: "1" }).toString(),
    );
    expect(() => parseVerifiedPrivateApprovalSlackInteractionV1(verify(body))).toThrow(
      PrivateApprovalSlackInteractionError,
    );
    expect(() =>
      parse(
        payload({
          action_id: "echo-private-approval-v1-00000000000000000000000000000000-approve-v1",
        }),
      ),
    ).toThrow(PrivateApprovalSlackInteractionError);
    expect(() =>
      parse(
        payload({
          action_id: "echo-private-approval-v1-0123456789abcdef0123456789abcdef-delegate-v1",
        }),
      ),
    ).toThrow(PrivateApprovalSlackInteractionError);
    expect(() =>
      parse(
        payload({
          selected_policy_id: "not-an-available-policy",
        }),
      ),
    ).toThrow(PrivateApprovalSlackInteractionError);
    expect(() => parse(payload({ comment: "bad\rcomment" }))).toThrow(
      PrivateApprovalSlackInteractionError,
    );
    const enterpriseInstall = payload();
    enterpriseInstall.is_enterprise_install = true;
    expect(() => parse(enterpriseInstall)).toThrow(PrivateApprovalSlackInteractionError);
    const expanded = payload();
    (expanded as Record<string, unknown>).unexpected = true;
    expect(() => parse(expanded)).toThrow(PrivateApprovalSlackInteractionError);
  });
});
