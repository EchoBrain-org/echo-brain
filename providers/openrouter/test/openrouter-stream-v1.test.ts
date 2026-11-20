import { describe, expect, it } from "vitest";
import { createOpenRouterStructuredGenerationAdapter } from "../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import { OpenRouterClient } from "../src/llm/openrouter-client.js";

const request = { model: "anthropic/claude-sonnet-5.5", system_prompt: "system", user_prompt: "user", schema: { type: "object" }, max_output_tokens: 1, timeout_ms: 1_000 } as const;
const extraction = { model: "provider-model", systemPrompt: "system", userPrompt: "user", schema: { type: "object" }, maxOutputTokens: 1 };

/** A stream of `pieces`, each `gap` ms after the last; it ends after the last piece and errors when the caller aborts. */
function stream(pieces: () => Iterable<string>, gap: number): typeof fetch {
  return (async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({ async start(controller) {
    let open = true;
    init.signal?.addEventListener("abort", () => { open = false; controller.error(init.signal!.reason); });
    for (const piece of pieces()) {
      if (!open) return;
      if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap));
      if (!open) return;
      controller.enqueue(new TextEncoder().encode(piece));
    }
    if (open) controller.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}

/** Keep-alive comments every 10 ms for `ms`, then a whole reply. */
function keepAlivesThenReply(ms: number): typeof fetch {
  return stream(function* () {
    for (let at = 0; at < ms; at += 10) yield ": OPENROUTER PROCESSING\n\n";
    yield 'data: {"id":"gen-1","choices":[{"delta":{"content":"{\\"signals\\":[]}"},"finish_reason":"stop"}]}\n\n';
    yield "data: [DONE]\n\n";
  }, 10);
}

/** The kept-text capacity of a one-token output allowance: (1 + 256) × 4096 bytes. */
const ONE_TOKEN_CAPACITY = 257 * 4096;

/** Reply text past what a one-token model output can carry, sent as fast as it is read. */
function oversized(): typeof fetch {
  const piece = "x".repeat(64 * 1024);
  return stream(function* () {
    for (let index = 0; index < 20; index += 1) yield `data: {"choices":[{"delta":{"content":"${piece}"}}]}\n\n`;
    yield 'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n';
  }, 0);
}

describe("OpenRouter reply capacity measures what is kept", () => {
  it("discards comments and repeated routing metadata as read: they never count against the capacity", async () => {
    const comment = `: ${"x".repeat(64 * 1024)}\n\n`;
    const metadata = JSON.stringify({ provider: "Anthropic", model: "anthropic/claude-sonnet-5.5", openrouter_metadata: { padding: "m".repeat(32 * 1024) } }).slice(1, -1);
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: stream(function* () {
      for (let index = 0; index < 64; index += 1) {
        yield comment;
        yield `data: {${metadata},"choices":[{"delta":{"reasoning":"r"}}]}\n\n`;
      }
      yield 'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}]}\n\n';
    }, 0) });
    await expect(adapter.generate(request)).resolves.toEqual({ ok: true });
  });

  it("fits a legitimate reply at the capacity whose text arrives escaped", async () => {
    // Each "é" is two kept bytes and six wire bytes (\u00e9): about 0.86 of the capacity kept, 2.6 times it on the wire.
    const chars = Math.floor(ONE_TOKEN_CAPACITY * 0.43);
    const per = 10_000;
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: stream(function* () {
      yield 'data: {"choices":[{"delta":{"content":"{\\"a\\":\\""}}]}\n\n';
      for (let sent = 0; sent < chars; sent += per) yield `data: {"choices":[{"delta":{"content":"${"\\u00e9".repeat(Math.min(per, chars - sent))}"}}]}\n\n`;
      yield 'data: {"choices":[{"delta":{"content":"\\"}"},"finish_reason":"stop"}]}\n\n';
    }, 0) });
    await expect(adapter.generate(request)).resolves.toEqual({ a: "é".repeat(chars) });
  });
});

describe("OpenRouter reply reading", () => {
  it("does not count keep-alive comments as progress: a stream of only keep-alives is stalled (answer adapter)", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: keepAlivesThenReply(400) });
    await expect(adapter.generate({ ...request, timeout_ms: 80 })).rejects.toMatchObject({ diagnostic: { failure_class: "adapter_timeout" } });
  });

  it("does not count keep-alive comments as progress: a stream of only keep-alives is stalled (extraction)", async () => {
    const client = new OpenRouterClient({ credentialRef: "openrouter", credentialResolver: () => "secret", requestTimeoutMs: 80, fetchImpl: keepAlivesThenReply(400) });
    await expect(client.generateStructured(extraction)).rejects.toMatchObject({ code: "timeout" });
  });

  it("holds the answer adapter's reply to its transport capacity while reading", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: oversized() });
    await expect(adapter.generate(request)).rejects.toMatchObject({ diagnostic: { failure_class: "adapter_response", http_status: 200 } });
  });

  it("holds an extraction reply to its transport capacity while reading", async () => {
    const client = new OpenRouterClient({ credentialRef: "openrouter", credentialResolver: () => "secret", fetchImpl: oversized() });
    await expect(client.generateStructured(extraction)).rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringContaining("transport capacity") });
  });

  it("parses events as they arrive: content that keeps coming is progress, however long the stream runs", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: stream(function* () {
      yield 'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n';
      for (let index = 0; index < 8; index += 1) yield `data: {"choices":[{"delta":{"content":"${index === 0 ? "{\\\"n\\\":" : ""}${index === 0 ? "" : "1"}"}}]}\n\n`;
      yield 'data: {"choices":[{"delta":{"content":"}"},"finish_reason":"stop"}]}\n\n';
    }, 30) });
    await expect(adapter.generate({ ...request, max_output_tokens: 100, timeout_ms: 80 })).resolves.toEqual({ n: 1111111 });
  });
});

describe("OpenRouter progress inside one event", () => {
  /** One tool-argument event split into fragments 40 ms apart, longer in all than the 80 ms silence period, then the finish. */
  function fragmented(): typeof fetch {
    const event = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"StructuredOutput","arguments":"{\\"f0\\":\\"${"x".repeat(60)}\\"}"}}]}}]}\n\n`;
    const pieces = Array.from({ length: 6 }, (_, index) => event.slice(Math.floor(index * event.length / 6), Math.floor((index + 1) * event.length / 6)));
    return stream(function* () { yield* pieces; yield 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'; }, 40);
  }
  const schema = { type: "object", additionalProperties: false, required: ["f0"], properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}`, { type: "string" }])) };

  it("counts the bytes of a real event as they arrive, so a healthy event arriving in fragments is never stalled", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: fragmented() });
    await expect(adapter.generate({ ...request, schema, max_output_tokens: 100, timeout_ms: 80 })).resolves.toEqual({ f0: "x".repeat(60) });
  });

  it("still does not count a keep-alive comment arriving in fragments", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: stream(function* () {
      for (let index = 0; index < 20; index += 1) yield ": OPENROUTER";
      yield " PROCESSING\n\n";
    }, 10) });
    await expect(adapter.generate({ ...request, timeout_ms: 80 })).rejects.toMatchObject({ diagnostic: { failure_class: "adapter_timeout" } });
  });
});

describe("OpenRouter stream ending", () => {
  // A complete, schema-valid value, then the connection closes before the provider's terminal outcome.
  const truncated = () => stream(function* () { yield 'data: {"id":"gen-1","choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n'; }, 0);

  it("fails an answer whose stream ended without a finish reason, never a short success", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: truncated() });
    await expect(adapter.generate(request)).rejects.toMatchObject({ diagnostic: { failure_class: "adapter_transport", finish_reason: null } });
  });

  // A complete delta, then the connection closes cleanly halfway through the next event's JSON.
  const cutMidEvent = () => stream(function* () {
    yield 'data: {"id":"gen-1","choices":[{"delta":{"content":"{\\"signals\\":"}}]}\n\n';
    yield 'data: {"id":"gen-1","choices":[{"delta":{"cont';
  }, 0);

  it("fails an answer cut in the middle of an event as a transport loss with unknown billing, never a malformed reply to repair", async () => {
    const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: cutMidEvent() });
    const failure = await adapter.generate(request).catch((error: unknown) => error as { diagnostic: Record<string, unknown> });
    expect(failure.diagnostic).toMatchObject({ failure_class: "adapter_transport" });
    expect(failure.diagnostic).not.toHaveProperty("unbilled");
  });

  it("fails an extraction cut in the middle of an event as a possibly billed transport loss", async () => {
    const client = new OpenRouterClient({ credentialRef: "openrouter", credentialResolver: () => "secret", fetchImpl: cutMidEvent() });
    await expect(client.generateStructured(extraction)).rejects.toMatchObject({ code: "temporarily_unavailable", retryable: true, unbilled: false,
      message: expect.stringContaining("middle of an event") });
  });

  it("fails an extraction whose stream ended without a finish reason, as possibly billed", async () => {
    const client = new OpenRouterClient({ credentialRef: "openrouter", credentialResolver: () => "secret", fetchImpl: truncated() });
    await expect(client.generateStructured(extraction)).rejects.toMatchObject({ code: "temporarily_unavailable", retryable: true, unbilled: false, message: expect.stringContaining("before it finished") });
  });
});
