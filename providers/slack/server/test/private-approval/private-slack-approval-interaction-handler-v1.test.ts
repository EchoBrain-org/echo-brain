import { createHmac } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID } from "../../src/organization-control-plane/slack-approval-integration-v1.js";
import { PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1, privateSlackApprovalBlockKitActionIdV1 } from "../../src/private-approval/private-slack-approval-block-kit-card-v1.js";
import { privateSlackApprovalBlockKitActionIdV2, privateSlackApprovalBlockKitOwnerActionIdV3 } from "../../src/private-approval/private-slack-approval-block-kit-card-v2.js";
import { createPrivateSlackApprovalInteractionHandlerV1, PRIVATE_SLACK_APPROVAL_INACTIVE_CARD_TEXT_V1 } from "../../src/private-approval/private-slack-approval-interaction-handler-v1.js";
import { createPrivateSlackApprovalHttpAdapterV1 } from "../../src/private-approval/private-slack-approval-http-adapter-v1.js";
import { createOrganizationAuthorityHttpServer } from "../../../../../services/organization-authority/src/presentation/organization-authority-http-server.js";

const SECRET = "not-a-real-signing-secret";
const NOW = 1_800_000_000;
const CARD = {
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
};
const POLICY_ID = privateSlackApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy,
);
const COMMENT_ID = privateSlackApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment,
);
const APPROVE_ID = privateSlackApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve,
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

function rawV2(input?: {
  readonly reject?: boolean;
  readonly projects?: readonly unknown[];
  readonly policy_id?: "project-members-readable-person-v1" | "organization-member-readable-person-v2" | "restricted-reviewer-person-v2";
  /** A V3 card: its owner fields by action place, as the approver left them. */
  readonly owners?: Readonly<Record<string, string | null>>;
  readonly owner_approval_id?: string;
  readonly button_version?: 2 | 3;
}): Uint8Array {
  const policy = privateSlackApprovalBlockKitActionIdV2(CARD, "policy");
  const projects = privateSlackApprovalBlockKitActionIdV2(CARD, "projects");
  const transcript = privateSlackApprovalBlockKitActionIdV2(CARD, "share-transcript");
  const comment = privateSlackApprovalBlockKitActionIdV2(CARD, "comment");
  const terminal = privateSlackApprovalBlockKitActionIdV2(CARD, input?.reject === true ? "reject" : "approve");
  const policyId = input?.policy_id ?? "project-members-readable-person-v1";
  const policyText = policyId === "project-members-readable-person-v1"
    ? "Projects"
    : policyId === "organization-member-readable-person-v2"
      ? "Team"
      : "Only me";
  const payload = {
    type: "block_actions", user: { id: "U012ABCDEF", team_id: "T012ABCDEF" }, api_app_id: "A012ABCDEF",
    trigger_id: "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD",
    container: { type: "message", channel_id: "D012ABCDEF", message_ts: "1712345678.123456", is_ephemeral: false },
    team: { id: "T012ABCDEF", domain: "echo" }, enterprise: null, is_enterprise_install: false,
    channel: { id: "D012ABCDEF", name: "directmessage" },
    message: { type: "message", user: "U098BOTAPP", ts: "1712345678.123456", app_id: "A012ABCDEF", bot_id: "B012ABCDEF", blocks: [] },
    state: { values: {
      policy: { [policy]: { type: "static_select", selected_option: { text: { type: "plain_text", text: policyText, emoji: false }, value: policyId } } },
      projects: { [projects]: { type: "multi_static_select", selected_options: input?.projects ?? [{ text: { type: "plain_text", text: "Launch", emoji: false }, value: "prj_11111111-1111-4111-8111-111111111111" }] } },
      transcript: { [transcript]: { type: "checkboxes", selected_options: [{ text: { type: "plain_text", text: "Share", emoji: false }, value: "share-transcript-v1" }] } },
      comment: { [comment]: { type: "plain_text_input", value: "Project release." } },
      ...Object.fromEntries(Object.entries(input?.owners ?? {}).map(([index, value]) => [`owner-${index}`, { [privateSlackApprovalBlockKitOwnerActionIdV3({ approval_id: input?.owner_approval_id ?? CARD.approval_id }, Number(index))]: { type: "plain_text_input", value } }])),
    } },
    actions: [{ type: "button", action_id: terminal, block_id: "actions", value: JSON.stringify({ schema_version: input?.button_version ?? (input?.owners === undefined ? 2 : 3), ...CARD }), action_ts: "1712345680.123456" }],
  };
  return new TextEncoder().encode(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
}

const INACTIVE = Object.freeze({
  kind: "ephemeral",
  text: "This card is no longer active. Open the ECHO desktop app to review it.",
});

function handler(overrides: Partial<Parameters<typeof createPrivateSlackApprovalInteractionHandlerV1>[0]> = {}) {
  return createPrivateSlackApprovalInteractionHandlerV1({
    signing_secret: () => SECRET,
    now_unix_seconds: () => NOW,
    ...overrides,
  });
}

describe("private Slack interactions application V1", () => {
  it("names the fixed inactive-card reply", () => {
    expect(PRIVATE_SLACK_APPROVAL_INACTIVE_CARD_TEXT_V1).toBe(INACTIVE.text);
  });

  it.each([
    ["a V1 approval", () => raw()],
    ["a V2 project approval", () => rawV2()],
    ["a V2 rejection", () => rawV2({ reject: true })],
    ["a rejection after choosing Projects without a project", () => rawV2({ reject: true, projects: [] })],
    ["a V3 approval with owner fields", () => rawV2({ owners: { 3: "  Priya   Shah ", 0: "Jules", 7: null } })],
    ["a V3 rejection", () => rawV2({ reject: true, owners: { 0: "Jules" } })],
  ] as const)("answers %s with the inactive-card reply and changes nothing", async (_label, body) => {
    const onRejection = vi.fn();
    await expect(handler({ on_rejection: onRejection }).accept(request(body()))).resolves.toEqual(INACTIVE);
    expect(onRejection).not.toHaveBeenCalled();
  });

  it.each([
    ["an owner field of another approval", { owners: { 0: "Jules" }, owner_approval_id: "apr_00000000-0000-4000-8000-000000000009" }],
    ["an owner with a control character", { owners: { 0: "Jules\u0007" } }],
    ["an owner longer than 120 characters", { owners: { 0: "J".repeat(121) } }],
    ["owner fields on a V2 card", { owners: { 0: "Jules" }, button_version: 2 }],
    ["a V3 card without owner fields", { button_version: 3 }],
    ["a Projects approval without a selected project", { projects: [] }],
  ] as const)("still refuses %s at the parser", async (_label, variant) => {
    await expect(handler().accept(request(rawV2(variant)))).rejects.toMatchObject({ code: "invalid_request" });
  });

  it.each([
    "organization-member-readable-person-v2",
    "restricted-reviewer-person-v2",
  ] as const)("refuses to approve %s with projects chosen, never dropping them silently", async (policy_id) => {
    const rejections: string[] = [];
    const application = handler({ on_rejection: ({ stage }) => { rejections.push(stage); } });
    await expect(application.accept(request(rawV2({ policy_id })))).rejects.toMatchObject({ code: "invalid_request" });
    expect(rejections).toEqual(["state"]);
  });

  it("acknowledges a verified selector event with an empty reply", async () => {
    await expect(handler().accept(request(raw({ action_id: POLICY_ID })))).resolves.toEqual({ kind: "acknowledged" });
  });

  it("reads a signing secret getter on every request and fails closed without one", async () => {
    let secret = SECRET;
    const signingSecret = vi.fn(() => secret);
    const application = handler({ signing_secret: signingSecret });
    const selector = raw({ action_id: POLICY_ID });
    await expect(application.accept(request(selector))).resolves.toEqual({ kind: "acknowledged" });
    secret = "rotated-signing-secret";
    await expect(application.accept(request(selector))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(application.accept(request(selector, "rotated-signing-secret"))).resolves.toEqual({ kind: "acknowledged" });
    signingSecret.mockImplementationOnce(() => { throw new Error(`bundle unreadable ${SECRET}`); });
    const failure = await application.accept(request(selector)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(String(failure)).not.toContain(SECRET);
    expect(signingSecret).toHaveBeenCalledTimes(4);
  });

  it("accepts media-type parameters and an untouched radio state", async () => {
    const body = raw({ selected_option: null, comment: "testing", hash: "1787980217.abcdef0123456789" });
    await expect(handler().accept({
      ...request(body),
      content_type: "Application/X-Www-Form-Urlencoded; charset=utf-8",
    })).resolves.toEqual(INACTIVE);
  });

  it("separates authentication failures from malformed media", async () => {
    const application = handler();
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
    const application = handler({ on_rejection: onRejection });

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

  it("returns the ephemeral reply as JSON and a selector change as an empty 200 over HTTP", async () => {
    const ingress = createPrivateSlackApprovalHttpAdapterV1(handler());
    const server = createOrganizationAuthorityHttpServer({
      is_closing: () => false,
      descriptor: {} as never,
      sessions: {} as never,
      oidc_provider: {} as never,
      expected_issuer: "https://issuer.example",
      private_approval_interaction_ingress: ingress,
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test HTTP server did not bind TCP");
      }
      const post = (body: Uint8Array) => {
        const signed = request(body);
        return fetch(`http://127.0.0.1:${address.port}${ingress.routes[0]!.path}`, {
          method: "POST",
          headers: {
            "content-type": signed.content_type,
            "x-slack-request-timestamp": signed.slack_request_timestamp,
            "x-slack-signature": signed.slack_signature,
          },
          body: Buffer.from(signed.raw_body),
        });
      };
      const click = await post(raw());
      expect(click.status).toBe(200);
      expect(click.headers.get("content-type")).toMatch(/^application\/json/);
      expect(await click.json()).toEqual({ response_type: "ephemeral", replace_original: false, text: INACTIVE.text });
      const selector = await post(raw({ action_id: POLICY_ID }));
      expect(selector.status).toBe(200);
      expect(await selector.text()).toBe("");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
