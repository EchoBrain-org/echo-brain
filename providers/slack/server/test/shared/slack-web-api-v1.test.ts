import { describe, expect, it, vi } from "vitest";
import { callSlackWebApiV1, SlackWebApiTransportErrorV1, slackOAuthScopesV1, type SlackWebApiCallV1 } from "../../src/shared/slack-web-api-v1.js";

const TOKEN = "xoxb-test-token-12345678";

function call(fetch: typeof globalThis.fetch, overrides: Partial<SlackWebApiCallV1> = {}) {
  return callSlackWebApiV1({ token: TOKEN, method: "conversations.open", parameters: { users: "U123", return_im: true }, encoding: "json", timeout_ms: 5_000, fetch, ...overrides });
}
const caught = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe("the one Slack Web API client", () => {
  it.each([
    ["json", "https://slack.com/api/conversations.open", "POST", { authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" }, '{"users":"U123","return_im":true}'],
    ["query", "https://slack.com/api/conversations.open?users=U123&return_im=true", "GET", { authorization: `Bearer ${TOKEN}` }, undefined],
    ["form", "https://slack.com/api/conversations.open", "POST", { accept: "application/json", authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, "users=U123&return_im=true"],
  ] as const)("sends the %s encoding to slack.com only, refusing redirects", async (encoding, url, method, headers, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    await expect(call(fetch, { encoding })).resolves.toMatchObject({ kind: "ok", body: { ok: true } });
    const [sentUrl, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(sentUrl).toBe(url);
    expect(init).toMatchObject({ method, headers, redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body === undefined ? undefined : String(init.body)).toBe(body);
  });

  it.each([
    ["a non-2xx status, unread", () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }), { kind: "http_error", status: 429 }],
    ["an empty 2xx", () => new Response(null, { status: 200 }), { kind: "empty" }],
    ["a 2xx array", () => Response.json([]), { kind: "not_object" }],
    ["Slack's refusal", () => Response.json({ ok: false, error: "invalid_auth" }), { kind: "slack_error", error: "invalid_auth" }],
  ] as const)("answers %s in the order a call checks it", async (_label, respond, expected) => {
    await expect(call(vi.fn<typeof globalThis.fetch>(async () => respond()))).resolves.toMatchObject(expected);
  });

  it("tells a failed request (with its cause) from an unreadable, oversized or non-JSON body", async () => {
    const request = await caught(call(async () => { throw new Error("network down"); }));
    expect(request).toBeInstanceOf(SlackWebApiTransportErrorV1);
    expect(request).toMatchObject({ stage: "request", code: "transport", message: "network down" });
    const broken = () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("stream broke")); } }));
    for (const [respond, code] of [
      [broken, "transport"],
      [() => new Response("{}", { headers: { "content-length": String(512 * 1024 + 1) } }), "oversized"],
      [() => new Response("not json"), "invalid_json"],
    ] as const) {
      await expect(caught(call(async () => respond()))).resolves.toMatchObject({ stage: "body", code });
    }
  });

  it("aborts at the deadline with the method's own reason, even when fetch ignores cancellation", async () => {
    const failure = await caught(call(() => new Promise<Response>(() => {}), { timeout_ms: 10 }));
    expect(failure).toMatchObject({ stage: "request", code: "transport", message: "Slack conversations.open timed out" });
  });

  it("parses the distinct granted scopes, refusing an empty or invalid header", () => {
    expect(slackOAuthScopesV1(" users:read ,chat:write,users:read")).toEqual(["chat:write", "users:read"]);
    for (const header of ["", " , ", "users:read,BAD SCOPE"]) expect(slackOAuthScopesV1(header)).toBeUndefined();
  });
});
