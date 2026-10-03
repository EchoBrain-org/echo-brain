import { describe, expect, it, vi } from "vitest";
import {
  BoundedJsonFetchErrorV1,
  boundedJsonFetchV1,
} from "../../src/shared/bounded-json-fetch-v1.js";

const URL_UNDER_TEST = "https://example.test/api/method";
const MAX_BYTES = 16;

function jsonResponse(value: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("boundedJsonFetchV1", () => {
  it("sends redirect: error and a combined signal, and returns status/ok/headers/json", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: true }));

    const result = await boundedJsonFetchV1({
      url: URL_UNDER_TEST,
      init: { method: "POST", headers: { accept: "application/json" }, body: "x=1" },
      fetch,
      timeoutMs: 5_000,
      maxBytes: 1024,
    });

    expect(result).toEqual({
      status: 200,
      ok: true,
      headers: expect.any(Headers),
      json: { ok: true },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_UNDER_TEST);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects oversized responses declared via content-length, without reading the body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ padding: "x".repeat(64) }, { "content-length": "9999" }),
    );

    const failure = await caught(
      boundedJsonFetchV1({
        url: URL_UNDER_TEST,
        init: { method: "GET" },
        fetch,
        timeoutMs: 5_000,
        maxBytes: MAX_BYTES,
      }),
    );

    expect(failure).toBeInstanceOf(BoundedJsonFetchErrorV1);
    expect((failure as BoundedJsonFetchErrorV1).code).toBe("oversized");
  });

  it("rejects oversized responses discovered while streaming the body", async () => {
    // No content-length header, so only the streamed running total can catch this.
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(64) })));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });

    const failure = await caught(
      boundedJsonFetchV1({
        url: URL_UNDER_TEST,
        init: { method: "GET" },
        fetch,
        timeoutMs: 5_000,
        maxBytes: MAX_BYTES,
      }),
    );

    expect(failure).toBeInstanceOf(BoundedJsonFetchErrorV1);
    expect((failure as BoundedJsonFetchErrorV1).code).toBe("oversized");
  });

  it("rejects a body that is not valid JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("not json", { status: 200 }),
    );

    const failure = await caught(
      boundedJsonFetchV1({
        url: URL_UNDER_TEST,
        init: { method: "GET" },
        fetch,
        timeoutMs: 5_000,
        maxBytes: 1024,
      }),
    );

    expect(failure).toBeInstanceOf(BoundedJsonFetchErrorV1);
    expect((failure as BoundedJsonFetchErrorV1).code).toBe("invalid_json");
  });

  it.each([
    ["a null body (e.g. a 204)", () => new Response(null, { status: 204 })],
    ["a zero-byte streamed body", () => new Response("", { status: 200 })],
  ])("resolves with json: undefined for %s", async (_label, makeResponse) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => makeResponse());

    const result = await boundedJsonFetchV1({
      url: URL_UNDER_TEST,
      init: { method: "DELETE" },
      fetch,
      timeoutMs: 5_000,
      maxBytes: 1024,
    });

    expect(result.json).toBeUndefined();
    expect(result.status).toBeGreaterThanOrEqual(200);
  });

  it("returns a non-2xx status without reading the body", async () => {
    // Over the cap and not JSON: reading it would throw.
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("<html>not json, and longer than the cap</html>", { status: 404 }),
    );

    const result = await boundedJsonFetchV1({
      url: URL_UNDER_TEST,
      init: { method: "GET" },
      fetch,
      timeoutMs: 5_000,
      maxBytes: MAX_BYTES,
    });

    expect(result).toEqual({ status: 404, ok: false, headers: expect.any(Headers), json: undefined });
  });

  it("maps a failed request to transport without its detail", async () => {
    const networkFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("private network detail");
    });

    const transportFailure = await caught(
      boundedJsonFetchV1({
        url: URL_UNDER_TEST,
        init: { method: "GET" },
        fetch: networkFetch,
        timeoutMs: 5_000,
        maxBytes: 1024,
      }),
    );

    expect(transportFailure).toBeInstanceOf(BoundedJsonFetchErrorV1);
    const transportError = transportFailure as BoundedJsonFetchErrorV1;
    expect(transportError.code).toBe("transport");
    expect(transportError.message).not.toContain("private network detail");
  });
});
