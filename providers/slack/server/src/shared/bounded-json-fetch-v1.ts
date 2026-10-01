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
 * `SlackWebIdentityProviderV1` (slack-web-identity-provider-v1.ts) keeps its
 * own copy on purpose: it classifies Slack's HTTP status before reading any
 * body (a 401 is a rejected token whatever the body holds), and it gives a
 * failed request and an empty body different codes, which this helper's
 * single `transport` code merges.
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
  /**
   * When true, a null or zero-byte response body is not an error: it
   * resolves with `json: undefined` instead of throwing
   * `BoundedJsonFetchErrorV1("transport", …)`. Defaults to false, which
   * keeps today's behaviour (every existing caller, e.g. the Slack manifest
   * provider, always expects a JSON body). Callers whose protocol is
   * expressed through HTTP status rather than a body on every response
   * (e.g. a 204 delete, or an empty-bodied error response) should pass
   * `true` and classify by `status`/`ok` first.
   */
  readonly allowEmptyBody?: boolean;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  allowEmptyBody: boolean,
): Promise<Uint8Array> {
  if (response.body === null) {
    if (allowEmptyBody) return new Uint8Array(0);
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
    if (allowEmptyBody) return new Uint8Array(0);
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
 * the caller's own protocol considers an error). A null or zero-byte body is
 * a transport failure (`"transport"`, unchanged default behaviour) unless
 * `input.allowEmptyBody` is true, in which case it resolves normally with
 * `json: undefined`.
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
  const bytes = await readBoundedBytes(response, input.maxBytes, input.allowEmptyBody ?? false);
  let json: unknown;
  if (bytes.byteLength === 0) {
    // Only reachable when allowEmptyBody is true; readBoundedBytes throws
    // otherwise. An empty body has no JSON to parse.
    json = undefined;
  } else {
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new BoundedJsonFetchErrorV1("invalid_json", "The response is not valid JSON");
    }
  }
  return Object.freeze({
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    json,
  });
}
