import type { ReadableStreamReadResult } from "node:stream/web";

/**
 * Provider-neutral transport shared by every Slack setup client that needs a
 * bounded, timed-out JSON fetch: `redirect: "error"`, a combined timeout +
 * caller signal, a response-size cap enforced both from the declared
 * `content-length` and while streaming, and strict JSON parsing. It never
 * inspects or interprets the parsed body — callers own their own
 * success/error vocabulary (e.g. Slack's `ok`/`error` fields) — and it never
 * includes request or response content in a thrown message, since callers
 * may be carrying secrets (tokens) in the request or sensitive detail in the
 * response.
 *
 * `SlackWebIdentityProviderV1` (slack-web-identity-provider-v1.ts) still has
 * its own, separate copy of this logic; it is intentionally out of scope for
 * this extraction and migrates to this module in a later task.
 */

export type BoundedJsonFetchErrorCodeV1 =
  | "timeout"
  | "transport"
  | "oversized"
  | "invalid_json";

/** Fixed messages only: never the request URL, body, or response content. */
export class BoundedJsonFetchErrorV1 extends Error {
  constructor(
    readonly code: BoundedJsonFetchErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "BoundedJsonFetchErrorV1";
  }
}

export interface BoundedJsonFetchResultV1 {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly json: unknown;
}

export interface BoundedJsonFetchInputV1 {
  readonly url: string;
  readonly init: Pick<RequestInit, "method" | "headers" | "body">;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxBytes: number;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) {
    throw new BoundedJsonFetchErrorV1("transport", "The response body is empty");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch {
        throw new BoundedJsonFetchErrorV1("transport", "The response stream failed");
      }
      if (read.done) break;
      totalBytes += read.value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw new BoundedJsonFetchErrorV1("oversized", "The response is oversized");
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new BoundedJsonFetchErrorV1("transport", "The response body is empty");
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetches `input.url`, enforcing `redirect: "error"`, a timeout of
 * `input.timeoutMs` combined with an optional caller `input.signal` through
 * `AbortSignal.any`, and a `input.maxBytes` response cap. Returns the parsed
 * JSON body alongside the raw HTTP status/ok/headers so a caller can apply
 * its own protocol-specific error mapping; throws `BoundedJsonFetchErrorV1`
 * for every transport-level failure (never for a well-formed JSON body that
 * the caller's own protocol considers an error).
 */
export async function boundedJsonFetchV1(
  input: BoundedJsonFetchInputV1,
): Promise<BoundedJsonFetchResultV1> {
  const deadline = AbortSignal.timeout(input.timeoutMs);
  const combined =
    input.signal === undefined
      ? deadline
      : AbortSignal.any([input.signal, deadline]);
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      ...input.init,
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new BoundedJsonFetchErrorV1("timeout", "The request timed out");
    }
    throw new BoundedJsonFetchErrorV1("transport", "The request is unavailable");
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > input.maxBytes)
  ) {
    throw new BoundedJsonFetchErrorV1("oversized", "The response is oversized");
  }
  const bytes = await readBoundedBytes(response, input.maxBytes);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new BoundedJsonFetchErrorV1("invalid_json", "The response is not valid JSON");
  }
  return Object.freeze({
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    json,
  });
}
