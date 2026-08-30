import { Buffer } from "node:buffer";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { describe, expect, it } from "vitest";
import { startPersonLoopbackHandoff } from "../../src/product/person-client/browser-login-handoff.js";

async function settlesPromptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("local handoff connection did not close promptly")),
          500,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("Person loopback browser handoff", () => {
  it("closes a successful browser connection before the receiver is closed", async () => {
    const handoff = await startPersonLoopbackHandoff({});
    const agent = new Agent({ keepAlive: true });
    try {
      const session = { session_family_id: "psf_test" };
      const body = new URLSearchParams({
        token: handoff.token,
        session: Buffer.from(JSON.stringify(session), "utf8").toString("base64url"),
      }).toString();
      const result = await new Promise<{
        readonly response_headers: import("node:http").IncomingHttpHeaders;
        readonly connection_closed: Promise<unknown>;
      }>((resolve, reject) => {
        const posted = request(
          handoff.url,
          {
            method: "POST",
            agent,
            headers: {
              connection: "keep-alive",
              "content-type": "application/x-www-form-urlencoded",
              "content-length": String(Buffer.byteLength(body)),
            },
          },
          (response) => {
            const socket = response.socket;
            const connectionClosed = once(socket, "close");
            response.once("error", reject);
            response.resume();
            response.once("end", () =>
              resolve({
                response_headers: response.headers,
                connection_closed: connectionClosed,
              }),
            );
          },
        );
        posted.once("error", reject);
        posted.end(body);
      });

      expect(result.response_headers.connection).toBe("close");
      await expect(handoff.wait()).resolves.toEqual({
        kind: "session",
        session,
      });
      await settlesPromptly(result.connection_closed);
      await handoff.close();
    } finally {
      agent.destroy();
      await handoff.close();
    }
  });
  it("accepts the Authority's token-authenticated identity-not-bound terminal handoff", async () => {
    const handoff = await startPersonLoopbackHandoff({});
    try {
      const response = await fetch(handoff.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: handoff.token,
          error: "identity_not_bound",
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Sign-in could not be completed");
      await expect(handoff.wait()).resolves.toEqual({
        kind: "error",
        code: "identity_not_bound",
      });
    } finally {
      await handoff.close();
    }
  });
  it("accepts the Authority's token-authenticated retryable terminal handoff", async () => {
    const handoff = await startPersonLoopbackHandoff({});
    try {
      const response = await fetch(handoff.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: handoff.token, error: "retryable" }),
      });

      expect(response.status).toBe(400);
      await expect(handoff.wait()).resolves.toEqual({
        kind: "error",
        code: "retryable",
      });
    } finally {
      await handoff.close();
    }
  });
});
