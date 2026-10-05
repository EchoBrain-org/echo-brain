import { abortableProviderOperationV1, BoundedJsonResponseErrorV1, disposeProviderResponseV1, readBoundedJsonResponseV1 } from '@echo-brain/provider-runtime/bounded-json-response-v1';

/**
 * Provider-neutral transport shared by every Slack setup client that needs a
 * bounded, timed-out JSON fetch: `redirect: "error"`, a combined timeout +
 * caller signal, a response-size cap enforced both from the declared
 * `content-length` and while streaming, and strict JSON parsing. HTTP status
 * comes first: a non-2xx response is returned without reading its body, so a
 * caller classifies a 401 or a 404 whatever the body holds. It never inspects
 * or interprets the parsed body — callers own their own success/error
 * vocabulary (e.g. Slack's `ok`/`error` fields) — and it never includes
 * request or response content in a thrown message, since callers may be
 * carrying secrets (tokens) in the request or sensitive detail in the
 * response.
 */

export type BoundedJsonFetchErrorCodeV1 =
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

/**
 * Fetches `input.url`, enforcing `redirect: "error"`, a timeout of
 * `input.timeoutMs` combined with an optional caller `input.signal` through
 * `AbortSignal.any`, and a `input.maxBytes` response cap. A non-2xx response
 * resolves at once with `json: undefined`, its body cancelled unread; a 2xx
 * response resolves with its parsed JSON body, or `json: undefined` when the
 * body is null or empty. Throws `BoundedJsonFetchErrorV1` for every
 * transport-level failure (never for a well-formed JSON body that the
 * caller's own protocol considers an error).
 */
export async function boundedJsonFetchV1(
  input: BoundedJsonFetchInputV1,
): Promise<BoundedJsonFetchResultV1> {
  const deadline = AbortSignal.timeout(input.timeoutMs);
  const combined =
    input.signal === undefined
      ? deadline
      : AbortSignal.any([input.signal, deadline]);
  let response: Response | undefined;
  try {
    response = await abortableProviderOperationV1(() => input.fetch(input.url, {
      ...input.init,
      redirect: "error",
      signal: combined,
    }), combined, disposeProviderResponseV1);
    if (!response.ok) {
      return Object.freeze({ status: response.status, ok: false, headers: response.headers, json: undefined });
    }
    const json = await readBoundedJsonResponseV1(response, { maxBytes: input.maxBytes, signal: combined, emptyBody: 'undefined' });
    return Object.freeze({ status: response.status, ok: true, headers: response.headers, json });
  } catch (error) {
    if (error instanceof BoundedJsonResponseErrorV1) {
      throw new BoundedJsonFetchErrorV1(error.code, error.message);
    }
    throw new BoundedJsonFetchErrorV1("transport", "The request is unavailable");
  } finally {
    disposeProviderResponseV1(response);
  }
}
