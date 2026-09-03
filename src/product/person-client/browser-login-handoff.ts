import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { TextDecoder } from "node:util";

const MAXIMUM_BODY_BYTES = 64 * 1024;
const MAXIMUM_SESSION_BYTES = 48 * 1024;

export interface PersonLoopbackHandoff {
  readonly url: string;
  readonly token: string;
  wait(): Promise<PersonLoopbackHandoffResult>;
  close(): Promise<void>;
}

export type PersonLoopbackHandoffErrorCode =
  | "identity_not_bound"
  | "retryable";

export type PersonLoopbackHandoffResult =
  | { readonly kind: "session"; readonly session: unknown }
  | {
      readonly kind: "error";
      readonly code: PersonLoopbackHandoffErrorCode;
    };

function randomSecret(randomBytes: (size: number) => Uint8Array): string {
  const value = randomBytes(32);
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("Person client random source returned invalid bytes");
  }
  return Buffer.from(value).toString("base64url");
}

async function readForm(request: IncomingMessage): Promise<{
  token: string;
  result: PersonLoopbackHandoffResult;
}> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(
      contentType,
    )
  ) {
    throw new Error("invalid local handoff form");
  }
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAXIMUM_BODY_BYTES)
  ) {
    throw new Error("local handoff form is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAXIMUM_BODY_BYTES) {
      throw new Error("local handoff form is too large");
    }
    chunks.push(bytes);
  }
  const form = new URLSearchParams(Buffer.concat(chunks, size).toString("utf8"));
  const keys = [...form.keys()].sort().join(",");
  if (form.getAll("token").length !== 1) {
    throw new Error("invalid local handoff form");
  }
  const token = form.get("token")!;
  if (keys === "error,token") {
    if (
      form.getAll("error").length !== 1 ||
      (form.get("error") !== "identity_not_bound" &&
        form.get("error") !== "retryable")
    ) {
      throw new Error("invalid local handoff error");
    }
    return {
      token,
      result: {
        kind: "error",
        code: form.get("error") as PersonLoopbackHandoffErrorCode,
      },
    };
  }
  if (keys !== "session,token" || form.getAll("session").length !== 1) {
    throw new Error("invalid local handoff form");
  }
  const encoded = form.get("session")!;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("invalid local handoff session");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_SESSION_BYTES ||
    bytes.toString("base64url") !== encoded
  ) {
    throw new Error("invalid local handoff session");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid local handoff session");
  }
  try {
    return { token, result: { kind: "session", session: JSON.parse(text) as unknown } };
  } catch {
    throw new Error("invalid local handoff session");
  }
}

/**
 * The browser tab is the only surface most people look at, so it has to say
 * what went wrong and what to do. Terminal stderr already carried this; the
 * page did not, which is how a wrong-account denial read as an unexplained
 * dead end.
 */
function failureHtml(
  code: PersonLoopbackHandoffErrorCode | undefined,
): string {
  if (code === "identity_not_bound") {
    return (
      "<!doctype html><title>Echo sign-in</title>" +
      "<p>Sign-in did not use the account named in the private invitation.</p>" +
      "<p>Ask the ECHO owner to reissue the invitation, then start sign-in again and pick that account in the Google chooser.</p>" +
      "<p>Return to your terminal for next steps.</p>"
    );
  }
  if (code === "retryable") {
    return (
      "<!doctype html><title>Echo sign-in</title>" +
      "<p>Sign-in can be retried.</p>" +
      "<p>The invitation remains usable. Run the same command again in your terminal before it expires and choose the account named in the private invitation.</p>"
    );
  }
  return (
    "<!doctype html><title>Echo sign-in</title>" +
    "<p>Sign-in could not be completed.</p>" +
    "<p>Return to your terminal for details.</p>"
  );
}

function noStoreHtml(
  response: import("node:http").ServerResponse,
  status: number,
  failure?: {
    readonly code?: PersonLoopbackHandoffErrorCode;
  },
): void {
  const bytes = Buffer.from(
    status === 200
      ? "<!doctype html><title>Echo sign-in complete</title><p>Sign-in complete. You can close this tab.</p>"
      : failureHtml(failure?.code),
    "utf8",
  );
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store",
    // The CLI closes the receiver immediately after the successful handoff.
    // Do not leave a browser's HTTP/1.1 keep-alive socket for server.close()
    // to drain on its own timeout.
    connection: "close",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

/**
 * A private, one-use receiver held only for the lifetime of one CLI command.
 * The route and token are both independently random; the receiver is bound to
 * numeric loopback before its URL is sent to the Authority.
 */
export async function startPersonLoopbackHandoff(input: {
  random_bytes?: (size: number) => Uint8Array;
  timeout_ms?: number;
}): Promise<PersonLoopbackHandoff> {
  const random = input.random_bytes ?? randomBytes;
  const path = `/${randomSecret(random)}`;
  const token = randomSecret(random);
  let settled = false;
  let resolveWait: ((value: PersonLoopbackHandoffResult) => void) | undefined;
  let rejectWait: ((reason: Error) => void) | undefined;
  const received = new Promise<PersonLoopbackHandoffResult>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const server: Server = createServer(async (request, response) => {
    const remote = request.socket.remoteAddress;
    if (
      request.method !== "POST" ||
      request.url !== path ||
      (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1")
    ) {
      noStoreHtml(response, 404);
      return;
    }
    try {
      const form = await readForm(request);
      if (settled || form.token !== token) {
        noStoreHtml(response, 400);
        return;
      }
      settled = true;
      noStoreHtml(
        response,
        form.result.kind === "session" ? 200 : 400,
        form.result.kind === "session"
          ? undefined
          : {
              code: form.result.code,
            },
      );
      resolveWait!(form.result);
    } catch {
      noStoreHtml(response, 400);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Person local handoff did not bind numeric loopback");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const close = async (): Promise<void> => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectWait!(new Error("Person browser sign-in timed out"));
      void close();
    }
  }, input.timeout_ms ?? 10 * 60 * 1000);
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}${path}`,
    token,
    wait: () => received,
    close,
  });
}
