import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createCleanPersonHttpServer } from "../../src/presentation/clean-person-http-server.js";
import {
  PRIVATE_APPROVAL_SLACK_INTERACTIONS_PATH_V1,
  type PrivateApprovalSlackInteractionsHttpApplicationV1,
} from "../../src/presentation/private-approval-slack-interactions-http-application-v1.js";

async function start(
  application?: PrivateApprovalSlackInteractionsHttpApplicationV1,
) {
  const server = createCleanPersonHttpServer({
    descriptor: {} as never,
    sessions: {} as never,
    oidc_provider: {} as never,
    expected_issuer: "https://issuer.example",
    ...(application === undefined
      ? {}
      : { private_slack_approval_interactions: application }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("clean HTTP server did not bind TCP");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}

describe("private Slack approval interactions HTTP mount V1", () => {
  it("passes the exact unparsed bytes and Slack headers to the signed application", async () => {
    const accept = vi.fn(
      async (
        _request: Parameters<
          PrivateApprovalSlackInteractionsHttpApplicationV1["accept"]
        >[0],
      ) => "accepted" as const,
    );
    const server = await start({ accept });
    const raw = "payload=%7B%22exact%22%3A%22a%2Bb%2520c%22%7D";
    try {
      const response = await fetch(
        `${server.url}${PRIVATE_APPROVAL_SLACK_INTERACTIONS_PATH_V1}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": "1800000000",
            "x-slack-signature": `v0=${"a".repeat(64)}`,
          },
          body: raw,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(accept).toHaveBeenCalledOnce();
      const accepted = accept.mock.calls[0]![0];
      expect(Buffer.from(accepted.raw_body).toString("utf8")).toBe(raw);
      expect(accepted).toMatchObject({
        content_type: "application/x-www-form-urlencoded",
        slack_request_timestamp: "1800000000",
        slack_signature: `v0=${"a".repeat(64)}`,
      });
    } finally {
      await server.close();
    }
  });

  it("returns a sanitized unavailable response when the signed application is absent", async () => {
    const server = await start();
    try {
      const response = await fetch(
        `${server.url}${PRIVATE_APPROVAL_SLACK_INTERACTIONS_PATH_V1}`,
        { method: "POST", body: "payload=%7B%7D" },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "unavailable", message: "request failed" },
      });
    } finally {
      await server.close();
    }
  });

  it("rejects an oversized provider body before calling the application", async () => {
    const accept = vi.fn(
      async (
        _request: Parameters<
          PrivateApprovalSlackInteractionsHttpApplicationV1["accept"]
        >[0],
      ) => "accepted" as const,
    );
    const server = await start({ accept });
    try {
      const response = await fetch(
        `${server.url}${PRIVATE_APPROVAL_SLACK_INTERACTIONS_PATH_V1}`,
        {
          method: "POST",
          body: `payload=${"a".repeat(64 * 1024)}`,
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: "request failed" },
      });
      expect(accept).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
