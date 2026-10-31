import { abortableProviderOperationV1, BoundedJsonResponseErrorV1, disposeProviderResponseV1, readBoundedJsonResponseV1 } from "@echo-brain/provider-runtime/bounded-json-response-v1";

/**
 * The one Slack Web API client. The approval-delivery client and the identity
 * provider call `auth.test`, `bots.info`, `conversations.open` and
 * `chat.postMessage` with the same bot token through it; each keeps its own
 * request encoding, deadline and outcome vocabulary.
 *
 * Every call goes to `https://slack.com/api/<method>` with the bot token as a
 * bearer credential and refuses redirects, so the credential cannot follow one
 * to another endpoint. It aborts at the caller's signal or the deadline, even
 * when a fetch implementation ignores cancellation, and keeps both connected
 * until the whole body is read. HTTP status comes first: a non-2xx body is
 * discarded unread. A 2xx body is bounded to 512 KiB from its declared length
 * and while streaming, then parsed and its `ok` envelope checked. Errors never
 * carry request or response content.
 */
const SLACK_WEB_API = "https://slack.com/api";
const MAXIMUM_RESPONSE_BYTES = 512 * 1024;
const SLACK_SCOPE = /^[a-z][a-z0-9:_-]{0,127}$/;

export interface SlackWebApiCallV1 {
  readonly token: string;
  readonly method: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * `json`: POST with a JSON body, for write methods; `query`: GET with a
   * query string, for read methods that ignore a JSON body; `form`: POST with
   * form fields and `accept: application/json`.
   */
  readonly encoding: "json" | "query" | "form";
  readonly timeout_ms: number;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal | undefined;
}

/** What Slack answered, in the order a call checks it. */
export type SlackWebApiAnswerV1 =
  /** A non-2xx status; its body was discarded unread. */
  | { readonly kind: "http_error"; readonly status: number; readonly headers: Headers }
  /** A 2xx with no body. */
  | { readonly kind: "empty" }
  /** A 2xx JSON body that is not an object. */
  | { readonly kind: "not_object" }
  /** Slack's refusal: an object whose `ok` is not true, with its `error` as sent. */
  | { readonly kind: "slack_error"; readonly error: unknown }
  | { readonly kind: "ok"; readonly body: Record<string, unknown>; readonly headers: Headers };

/**
 * A call that got no answer. `request`: the request itself failed (network,
 * cancellation or the deadline); the message is the cause's own. `body`: a 2xx
 * body could not be read (`transport`), exceeded the bound (`oversized`) or is
 * not JSON (`invalid_json`).
 */
export class SlackWebApiTransportErrorV1 extends Error {
  constructor(
    readonly stage: "request" | "body",
    readonly code: "transport" | "oversized" | "invalid_json",
    message: string,
  ) {
    super(message);
    this.name = "SlackWebApiTransportErrorV1";
  }
}

function request(call: SlackWebApiCallV1): { readonly url: string; readonly init: RequestInit } {
  const url = `${SLACK_WEB_API}/${call.method}`;
  const authorization = `Bearer ${call.token}`;
  const fields = () => new URLSearchParams(Object.entries(call.parameters).map(([key, value]): [string, string] => [key, String(value)]));
  switch (call.encoding) {
    case "json":
      return { url, init: { method: "POST", headers: { authorization, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(call.parameters) } };
    case "query":
      return { url: `${url}?${fields().toString()}`, init: { method: "GET", headers: { authorization } } };
    case "form":
      return { url, init: { method: "POST", headers: { accept: "application/json", authorization, "content-type": "application/x-www-form-urlencoded" }, body: fields() } };
  }
}

export async function callSlackWebApiV1(call: SlackWebApiCallV1): Promise<SlackWebApiAnswerV1> {
  const { url, init } = request(call);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`Slack ${call.method} timed out`)), call.timeout_ms);
  const signal = call.signal === undefined ? deadline.signal : AbortSignal.any([call.signal, deadline.signal]);
  let response: Response | undefined;
  try {
    try {
      response = await abortableProviderOperationV1(() => call.fetch(url, { ...init, redirect: "error", signal }), signal, disposeProviderResponseV1);
    } catch (error) {
      throw new SlackWebApiTransportErrorV1("request", "transport", String((error as Error | undefined)?.message));
    }
    if (!response.ok) return Object.freeze({ kind: "http_error", status: response.status, headers: response.headers });
    let json: unknown;
    try {
      json = await readBoundedJsonResponseV1(response, { maxBytes: MAXIMUM_RESPONSE_BYTES, signal, emptyBody: "undefined" });
    } catch (error) {
      const failure = error instanceof BoundedJsonResponseErrorV1 ? error : new BoundedJsonResponseErrorV1("transport");
      throw new SlackWebApiTransportErrorV1("body", failure.code, failure.message);
    }
    if (json === undefined) return Object.freeze({ kind: "empty" });
    if (json === null || typeof json !== "object" || Array.isArray(json)) return Object.freeze({ kind: "not_object" });
    const body = json as Record<string, unknown>;
    if (body.ok !== true) return Object.freeze({ kind: "slack_error", error: body.error });
    return Object.freeze({ kind: "ok", body, headers: response.headers });
  } finally {
    clearTimeout(timer);
    disposeProviderResponseV1(response);
  }
}

/** The distinct OAuth scopes in Slack's `x-oauth-scopes` header, sorted; undefined when it names none or an invalid one. */
export function slackOAuthScopesV1(header: string): readonly string[] | undefined {
  const scopes = [...new Set(header.split(",").map((scope) => scope.trim()))].filter((scope) => scope.length > 0).sort();
  return scopes.length === 0 || scopes.some((scope) => !SLACK_SCOPE.test(scope)) ? undefined : Object.freeze(scopes);
}
