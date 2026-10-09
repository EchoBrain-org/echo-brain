import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPrivateSlackApprovalInteractionHandlerV1,
  type PrivateSlackApprovalInteractionHandlerInputV1,
} from "../../src/private-approval/private-slack-approval-interaction-handler-v1.js";
import { createPrivateSlackApprovalHttpAdapterV1 } from "../../src/private-approval/private-slack-approval-http-adapter-v1.js";
import { slackApprovalActionIdV4 } from "../../src/private-approval/slack-approval-card-v4.js";

const SECRET = "not-a-real-signing-secret",
  NOW = 1_800_000_000,
  APPROVAL = "apr_00000000-0000-4000-8000-000000000001",
  SNAPSHOT = `sha256:${"a".repeat(64)}`;
function body(response_url?: string) {
  const id = (
    name:
      "audience-select" | "projects-select" | "transcript-checkbox" | "approve",
  ) => slackApprovalActionIdV4(APPROVAL, name);
  const payload = {
    type: "block_actions",
    user: { id: "U012ABCDEF", team_id: "T012ABCDEF" },
    api_app_id: "A012ABCDEF",
    trigger_id: "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD",
    container: {
      type: "message",
      channel_id: "D012ABCDEF",
      message_ts: "1712345678.123456",
    },
    team: { id: "T012ABCDEF" },
    channel: { id: "D012ABCDEF" },
    message: {
      type: "message",
      user: "U098BOTAPP",
      ts: "1712345678.123456",
      app_id: "A012ABCDEF",
      bot_id: "B012ABCDEF",
    },
    state: {
      values: {
        audience: {
          [id("audience-select")]: {
            type: "static_select",
            selected_option: {
              text: { type: "plain_text", text: "Only me" },
              value: "only-me",
            },
          },
        },
        projects: {
          [id("projects-select")]: {
            type: "multi_static_select",
            selected_options: [],
          },
        },
        transcript: {
          [id("transcript-checkbox")]: {
            type: "checkboxes",
            selected_options: [],
          },
        },
      },
    },
    ...(response_url === undefined ? {} : { response_url }),
    actions: [
      {
        type: "button",
        action_id: id("approve"),
        text: { type: "plain_text", text: "Approve", emoji: false },
        value: JSON.stringify({
          schema_version: 2,
          approval_id: APPROVAL,
          snapshot_sha256: SNAPSHOT,
        }),
        action_ts: "1712345680.123456",
      },
    ],
  };
  return new TextEncoder().encode(
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
  );
}
function request(raw_body: Uint8Array) {
  return {
    raw_body,
    content_type: "application/x-www-form-urlencoded",
    slack_request_timestamp: String(NOW),
    slack_signature: `v0=${createHmac("sha256", SECRET).update(`v0:${NOW}:`).update(raw_body).digest("hex")}`,
  };
}

function handlerWith(
  overrides: Omit<PrivateSlackApprovalInteractionHandlerInputV1, "signing_secret"> &
    Partial<PrivateSlackApprovalInteractionHandlerInputV1>,
) {
  return createPrivateSlackApprovalInteractionHandlerV1({
    signing_secret: () => SECRET,
    now_unix_seconds: () => NOW,
    ...overrides,
  });
}

describe("private Slack interaction handler", () => {
  it("waits for a parsed durable click before sending an empty HTTP acknowledgement", async () => {
    const click = vi.fn(() => ({ outcome: "decided" as const }));
    const handler = handlerWith({ click });
    const signed = request(body());
    await expect(
      createPrivateSlackApprovalHttpAdapterV1(handler).accept({
        route_id: "private-approval-interaction",
        method: "POST",
        path: "/v2/integrations/slack/interactions",
        raw_body: signed.raw_body,
        content_type: signed.content_type,
        headers: {
          "x-slack-request-timestamp": signed.slack_request_timestamp,
          "x-slack-signature": signed.slack_signature,
        },
      }),
    ).resolves.toEqual({ status: 200, raw_body: new Uint8Array() });
    expect(click).toHaveBeenCalledTimes(1);
  });
  it("sends stale feedback only to a verified, narrowly valid Slack response URL", async () => {
    const feedback = vi.fn(async () => {}),
      handler = handlerWith({ click: () => ({ outcome: "stale" }), feedback });
    await handler.accept(
      request(body("https://hooks.slack.com/actions/T000/B000/fake")),
    );
    expect(feedback).toHaveBeenCalledWith(
      expect.objectContaining({
        response_url: "https://hooks.slack.com/actions/T000/B000/fake",
      }),
    );
    await handler.accept(request(body("https://example.test/actions/nope")));
    expect(feedback).toHaveBeenCalledTimes(1);
  });
  it("acknowledges after a durable outcome when provider feedback fails or times out", async () => {
    const signed = request(
      body("https://hooks.slack.com/actions/T000/B000/fake"),
    );
    const failure = handlerWith({
      click: () => ({ outcome: "refused" }),
      feedback: async () => {
        throw new Error("transport failed");
      },
    });
    await expect(failure.accept(signed)).resolves.toEqual({
      kind: "acknowledged",
    });
    const timeout = handlerWith({
      click: () => ({ outcome: "refused" }),
      feedback: async () => new Promise<void>(() => {}),
      feedback_timeout_ms: 1,
    });
    await expect(timeout.accept(signed)).resolves.toEqual({
      kind: "acknowledged",
    });
  });
  it("never calls the decision or feedback transport for an invalid HMAC", async () => {
    const click = vi.fn(),
      feedback = vi.fn(),
      handler = handlerWith({ click, feedback });
    await expect(
      handler.accept({
        ...request(body("https://hooks.slack.com/actions/T/B/fake")),
        slack_signature: "v0=00".padEnd(67, "0"),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(click).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
  });
  it("refuses safely when no active Slack connection can supply a signing secret", async () => {
    const click = vi.fn();
    const handler = handlerWith({
      signing_secret: () => {
        throw new Error("inactive");
      },
      click,
    });
    await expect(handler.accept(request(body()))).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(click).not.toHaveBeenCalled();
  });
});
