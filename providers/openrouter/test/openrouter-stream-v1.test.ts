import { describe, expect, it, vi } from "vitest";
import { createOpenRouterStructuredGenerationAdapter } from "../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import { OpenRouterClient } from "../src/llm/openrouter-client.js";

// Both OpenRouter callers share one call (src/openrouter-stream-v1.ts): its behaviour is proven through the answer
// adapter, and the extraction client's own mapping of each failure once.
const request = { model: "anthropic/claude-sonnet-5.5", system_prompt: "system", user_prompt: "user", schema: { type: "object" }, max_output_tokens: 1, timeout_ms: 1_000 } as const;
const extraction = { model: "provider-model", systemPrompt: "system", userPrompt: "user", schema: { type: "object" }, maxOutputTokens: 1 };
const toolSchema = { type: "object", additionalProperties: false, required: ["f0"], properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}`, { type: "string" }])) };
const adapter = (fetchImpl: typeof fetch) => createOpenRouterStructuredGenerationAdapter({ credential_ref: "fixture", credential_resolver: () => "SECRET", fetch_impl: fetchImpl });
const client = (fetchImpl: typeof fetch, requestTimeoutMs?: number) => new OpenRouterClient({ credentialRef: "openrouter", credentialResolver: () => "secret", fetchImpl, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) });
const diagnostic = (promise: Promise<unknown>) => promise.then(() => { throw new Error("the call succeeded"); }, (error: { diagnostic: Record<string, unknown> }) => error.diagnostic);

/** A stream of `pieces`, each `gap` ms after the last; it ends after the last piece and errors when the caller aborts. */
function stream(pieces: Iterable<string>, gap = 0): typeof fetch {
  return (async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({ async start(controller) {
    let open = true;
    init.signal?.addEventListener("abort", () => { open = false; controller.error(init.signal!.reason); });
    for (const piece of pieces) {
      if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap));
      if (!open) return;
      controller.enqueue(new TextEncoder().encode(piece));
    }
    if (open) controller.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}
const repeat = (count: number, ...pieces: string[]) => Array.from({ length: count }, () => pieces).flat();
const done = 'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n';

describe("OpenRouter liveness", () => {
  // Drive the stream and its silence timer on the same clock, independent of runner load.
  async function withStreamClock(check: () => Promise<unknown>) {
    vi.useFakeTimers();
    try { await Promise.all([check(), vi.runAllTimersAsync()]); }
    finally { vi.useRealTimers(); }
  }

  it("reports only model output as progress, and a reply that keeps producing runs past the silence period", async () => {
    let progress = 0;
    const events = [": OPENROUTER PROCESSING\n\n", 'data: {"choices":[{"delta":{"reasoning":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n', ": OPENROUTER PROCESSING\n\n", 'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"];
    // 180 ms in all, events 30 ms apart, under an 80 ms silence period.
    await withStreamClock(() => expect(adapter(stream(events, 30)).generate({ ...request, max_output_tokens: 100, timeout_ms: 80, on_progress: () => { progress += 1; } })).resolves.toEqual({ ok: true }));
    expect(progress).toBe(3);
  });

  it("never stalls one long event that arrives in fragments", async () => {
    const event = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"StructuredOutput","arguments":"{\\"f0\\":\\"${"x".repeat(60)}\\"}"}}]}}]}\n\n`;
    const pieces = Array.from({ length: 6 }, (_, index) => event.slice(Math.floor(index * event.length / 6), Math.floor((index + 1) * event.length / 6)));
    await withStreamClock(() => expect(adapter(stream([...pieces, 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'], 40))
      .generate({ ...request, schema: toolSchema, max_output_tokens: 100, timeout_ms: 80 })).resolves.toEqual({ f0: "x".repeat(60) }));
  });

  it.each([
    ["keep-alive comments", repeat(40, ": OPENROUTER PROCESSING\n\n")],
    ["a keep-alive comment arriving in fragments", repeat(40, ": OPENROUTER")],
    ["control fields split across pieces", repeat(20, "event: pi", "ng\n\n")],
    ["usage-only events", repeat(40, 'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":1}}\n\n')],
    ["usage-only events split across pieces", repeat(20, 'data: {"id":"gen-1","choices":[],"usa', 'ge":{"prompt_tokens":1}}\n\n')],
    ["usage-only events where one piece ends an event and begins the next", ['data: {"choices":[],"usa', ...repeat(40, 'ge":{"prompt_tokens":1}}\n\ndata: {"choices":[],"usa')]],
  ])("stalls on silence from the model: %s are not progress", async (_name, pieces) => {
    await withStreamClock(() => expect(diagnostic(adapter(stream([...pieces, done], 10)).generate({ ...request, timeout_ms: 80 }))).resolves.toMatchObject({ failure_class: "adapter_timeout" }));
  });
});

describe("OpenRouter reply capacity", () => {
  // A one-token allowance holds (1 + 256) × 4 KiB of kept text: about a megabyte.
  const big = (fill: string) => fill.repeat(64 * 1024);
  it.each([
    ["content", Array.from({ length: 20 }, () => `data: {"choices":[{"delta":{"content":"${big("x")}"}}]}\n\n`)],
    ["distinct top-level fields", Array.from({ length: 20 }, (_, index) => `data: {"field_${index}":"${big("m")}","choices":[]}\n\n`)],
    ["long top-level field names", Array.from({ length: 20 }, (_, index) => `data: {"${big("k")}${index}":0,"choices":[]}\n\n`)],
    ["tool-call ids", Array.from({ length: 20 }, (_, index) => `data: {"choices":[{"delta":{"tool_calls":[{"index":${index},"id":"${big("i")}${index}"}]}}]}\n\n`)],
  ])("refuses a reply that retains more than the model's maximum output can produce: %s", async (_name, events) => {
    await expect(diagnostic(adapter(stream([...events, done])).generate(request))).resolves.toMatchObject({ failure_class: "adapter_response", http_status: 200 });
  });

  it("counts only what is retained: comments, reasoning and a repeated field are discarded, and escaped text counts as decoded", async () => {
    const discarded = [...repeat(20, `: ${big("c")}\n\n`, `data: {"provider":"${big("p")}","choices":[{"delta":{"reasoning":"${big("r")}"}}]}\n\n`),
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}]}\n\n'];
    await expect(adapter(stream(discarded)).generate(request)).resolves.toEqual({ ok: true });
    // Each "é" is two kept bytes and six wire bytes (\u00e9): about 0.86 of the capacity kept, 2.6 times it on the wire.
    const chars = Math.floor(257 * 4096 * 0.43);
    const escaped = ['data: {"choices":[{"delta":{"content":"{\\"a\\":\\""}}]}\n\n',
      ...Array.from({ length: Math.ceil(chars / 10_000) }, (_, index) => `data: {"choices":[{"delta":{"content":"${"\\u00e9".repeat(Math.min(10_000, chars - index * 10_000))}"}}]}\n\n`),
      'data: {"choices":[{"delta":{"content":"\\"}"},"finish_reason":"stop"}]}\n\n'];
    await expect(adapter(stream(escaped)).generate(request)).resolves.toEqual({ a: "é".repeat(chars) });
  });
});

describe("OpenRouter call failures", () => {
  const cutMidEvent = stream(['data: {"choices":[{"delta":{"content":"{\\"signals\\":"}}]}\n\n', 'data: {"choices":[{"delta":{"cont']);
  const noFinish = stream(['data: {"id":"gen-1","choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n']);
  const redirected = (seen: RequestInit[]) => (async (_url: string, init: RequestInit) => {
    seen.push(init);
    return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/api/v1/chat/completions" } });
  }) as unknown as typeof fetch;
  const failedToConnect = (code: string) => (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("synthetic"), { code }) }); }) as unknown as typeof fetch;
  const status = (value: number) => (async () => new Response(`{"error":{"message":"synthetic","code":${value}}}`, { status: value, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("never re-sends a request by redirect, and fails it with billing unknown", async () => {
    const seen: RequestInit[] = [];
    const failure = await diagnostic(adapter(redirected(seen)).generate(request));
    expect(failure).toMatchObject({ failure_class: "adapter_transport" });
    expect(failure).not.toHaveProperty("unbilled");
    expect(seen.map(init => init.redirect)).toEqual(["error"]);
  });

  it.each([["cut in the middle of an event", cutMidEvent], ["ended without a finish reason", noFinish]])(
    "fails a stream %s as a transport loss with billing unknown, never a reply to repair", async (_name, fetchImpl) => {
      const failure = await diagnostic(adapter(fetchImpl).generate(request));
      expect(failure).toMatchObject({ failure_class: "adapter_transport" });
      expect(failure).not.toHaveProperty("unbilled");
    });

  it("refuses tool-call indexes out of sequence, at once, and keeps a consecutive one", async () => {
    const calls = (...indexes: number[]) => adapter(stream([...indexes.map(index =>
      `data: {"choices":[{"delta":{"tool_calls":[{"index":${index},"function":{"name":"StructuredOutput","arguments":"{\\"f0\\":\\"x\\"}"}}]}}]}\n\n`),
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'])).generate({ ...request, schema: toolSchema });
    for (const indexes of [[4294967294], [1], [-1], [0, 1]]) await expect(diagnostic(calls(...indexes))).resolves.toMatchObject({ failure_class: "adapter_response" });
    await expect(calls(0)).resolves.toEqual({ f0: "x" });
  });

  it("marks unbilled only a request never sent and a refusal documented as made before generation", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]) await expect(diagnostic(adapter(failedToConnect(code)).generate(request))).resolves.toMatchObject({ unbilled: true });
    for (const value of [429, 503, 529]) await expect(diagnostic(adapter(status(value)).generate(request))).resolves.toMatchObject({ http_status: value, unbilled: true });
    for (const fetchImpl of [failedToConnect("ECONNRESET"), status(400), status(402), status(500), status(502), status(504), cutMidEvent]) {
      expect(await diagnostic(adapter(fetchImpl).generate(request))).not.toHaveProperty("unbilled");
    }
  });

  it("maps each failure for extraction: a stall times out, every loss after sending is retryable and never unbilled", async () => {
    await expect(client(stream(repeat(40, ": OPENROUTER PROCESSING\n\n"), 10), 80).generateStructured(extraction)).rejects.toMatchObject({ code: "timeout" });
    await expect(client(stream(Array.from({ length: 20 }, () => `data: {"choices":[{"delta":{"content":"${"x".repeat(64 * 1024)}"}}]}\n\n`))).generateStructured(extraction))
      .rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringContaining("transport capacity") });
    for (const [fetchImpl, message] of [[cutMidEvent, "middle of an event"], [noFinish, "before it finished"]] as const) {
      await expect(client(fetchImpl).generateStructured(extraction)).rejects.toMatchObject({ code: "temporarily_unavailable", retryable: true, unbilled: false, message: expect.stringContaining(message) });
    }
    const seen: RequestInit[] = [];
    await expect(client(redirected(seen)).generateStructured(extraction)).rejects.toMatchObject({ unbilled: false, message: expect.stringContaining("redirect") });
    expect(seen.map(init => init.redirect)).toEqual(["error"]);
  });
});
