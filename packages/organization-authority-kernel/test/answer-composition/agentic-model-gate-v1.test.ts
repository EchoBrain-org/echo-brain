import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { AGENTIC_REVALIDATION_RETRY_DELAY_MS_V1, AgenticAskPostRevalidationNoTimeErrorV1, createAgenticModelGateV1, raceAbort } from "../../src/answer-composition/agentic-model-gate-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { observeCoreRuntimeV1, withCoreRuntimeDiagnosticsV1, type CoreRuntimeDiagnosticObservationV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";
import { AgenticAskOutputErrorV1, repairInstruction } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { StructuredGenerationInput, StructuredGenerationJsonSchema } from "../../src/answer-composition/structured-generation-v1.js";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
const schema = { type: "object" } as unknown as StructuredGenerationJsonSchema;
/** Ask's two calls: the role the audit records and the runtime span each runs in. */
const STEP = { role: "step", span: "ask_planner" } as const;
const ANSWER = { role: "answer", span: "ask_answer" } as const;

function harness(options: {
  readonly replies?: readonly (unknown | Error)[];
  readonly max_model_calls?: number;
  readonly desk_revalidate?: () => Promise<{ readonly checked_at: string }>;
  readonly modes?: string[];
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly model?: Parameters<typeof createAgenticModelGateV1>[0]["model"];
} = {}) {
  const trace: string[] = [];
  const inputs: StructuredGenerationInput[] = [];
  const replies = [...(options.replies ?? [])];
  const checked: string[] = [];
  const gate = createAgenticModelGateV1({
    generation,
    model: options.model ?? {
      async generate(input) {
        trace.push(`generate:${inputs.length}`); inputs.push(input);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    desk_revalidate: async ({ mode }) => {
      trace.push("revalidate"); options.modes?.push(mode);
      return options.desk_revalidate?.() ?? { checked_at: `2026-10-06T00:00:0${checked.length}.000Z` };
    },
    on_checked: at => { checked.push(at); },
    budget: { max_model_calls: options.max_model_calls ?? 24 },
    now: () => 0,
    deadline: options.deadline ?? 90_000,
    signal: options.signal ?? new AbortController().signal,
    is_deadline_expired: () => false,
  });
  return { gate, trace, inputs, checked };
}

describe("agentic model gate", () => {
  it("revalidates the desk once before every model call and reports the check time", async () => {
    const { gate, trace, checked } = harness({ replies: [{ a: 1 }, { b: 2 }] });
    await gate.call(STEP, "system", { q: 1 }, schema, () => 20_000);
    await gate.call(ANSWER, "system", { q: 2 }, schema, () => 20_000);
    expect(trace).toEqual(["revalidate", "generate:0", "revalidate", "generate:1"]);
    expect(checked).toEqual(["2026-10-06T00:00:00.000Z", "2026-10-06T00:00:01.000Z"]);
    expect(gate.stats().calls).toBe(2);
  });

  it("asks for an incremental check before every call, repairs included", async () => {
    const modes: string[] = [];
    const { gate, trace } = harness({ replies: [{ bad: true }, { good: true }, { c: 3 }], modes });
    await gate.withRepair(STEP, "system", {}, schema, () => 20_000, reply => {
      if ((reply as { bad?: boolean }).bad) throw new AgenticAskOutputErrorV1("needs are missing");
      return reply;
    });
    await gate.call(ANSWER, "system", {}, schema, () => 20_000);
    expect(trace).toEqual(["revalidate", "generate:0", "revalidate", "generate:1", "revalidate", "generate:2"]);
    expect(modes).toEqual(["incremental", "incremental", "incremental"]);
  });

  it.each(["unavailable", "rate_limited"] as const)("retries a %s pre-call check once after a short pause", async code => {
    let checks = 0;
    const { gate, trace, checked } = harness({ replies: [{ a: 1 }], desk_revalidate: async () => {
      if (++checks === 1) throw new AuthorityOperationError(code, "Live evidence operation could not be completed");
      return { checked_at: "2026-10-06T00:00:01.000Z" };
    } });
    const started = Date.now();
    await expect(gate.call(STEP, "system", {}, schema, () => 20_000)).resolves.toEqual({ a: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(AGENTIC_REVALIDATION_RETRY_DELAY_MS_V1 - 50);
    expect(trace).toEqual(["revalidate", "revalidate", "generate:0"]);
    expect(checked).toEqual(["2026-10-06T00:00:01.000Z"]);
  });

  it("fails the call when the retried pre-call check fails again", async () => {
    const { gate, trace } = harness({ desk_revalidate: async () => { throw new AuthorityOperationError("unavailable", "Live evidence operation could not be completed"); } });
    await expect(gate.call(STEP, "system", {}, schema, () => 20_000)).rejects.toMatchObject({ code: "unavailable" });
    expect(trace).toEqual(["revalidate", "revalidate"]);
    expect(gate.stats().calls).toBe(0);
  });

  it.each(["unauthorized", "stale_access_state", "not_found", "invalid_output"] as const)("never retries a %s pre-call check", async code => {
    const { gate, trace } = harness({ desk_revalidate: async () => { throw new AuthorityOperationError(code, "Live evidence operation could not be completed"); } });
    await expect(gate.call(STEP, "system", {}, schema, () => 20_000)).rejects.toMatchObject({ code });
    expect(trace).toEqual(["revalidate"]);
  });

  it("does not retry a transient pre-call check without time for the pause, or once the request stops", async () => {
    const late = harness({ deadline: AGENTIC_REVALIDATION_RETRY_DELAY_MS_V1, desk_revalidate: async () => { throw new AuthorityOperationError("unavailable", "Live evidence operation could not be completed"); } });
    await expect(late.gate.call(STEP, "system", {}, schema, () => 20_000)).rejects.toMatchObject({ code: "unavailable" });
    expect(late.trace).toEqual(["revalidate"]);
    const controller = new AbortController();
    const stopped = harness({ signal: controller.signal, desk_revalidate: async () => {
      setTimeout(() => controller.abort(), 10);
      throw new AuthorityOperationError("unavailable", "Live evidence operation could not be completed");
    } });
    await expect(stopped.gate.call(STEP, "system", {}, schema, () => 20_000)).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.trace).toEqual(["revalidate"]);
  });

  it("enforces the request's call budget before revalidating", async () => {
    const { gate, trace } = harness({ replies: [{ a: 1 }], max_model_calls: 1 });
    await gate.call(STEP, "system", {}, schema, () => 20_000);
    await expect(gate.call(STEP, "system", {}, schema, () => 20_000)).rejects.toThrow("call budget exhausted");
    expect(trace).toEqual(["revalidate", "generate:0"]);
    expect(gate.stats()).toMatchObject({ calls: 1, stopped: false });
  });

  it("reports a content-free admission failure when revalidation leaves too little time for a step", async () => {
    let available = 20_000;
    const { gate, trace } = harness({ desk_revalidate: async () => {
      available = 3_999;
      return { checked_at: "2026-10-06T00:00:00.000Z" };
    } });

    await expect(gate.call(STEP, "system", {}, schema, () => available))
      .rejects.toBeInstanceOf(AgenticAskPostRevalidationNoTimeErrorV1);
    expect(trace).toEqual(["revalidate"]);
    expect(gate.stats()).toMatchObject({ calls: 0, repairs: 0, generations: [] });
  });

  it("preserves the post-revalidation admission reason on a repair attempt", async () => {
    let available = 20_000;
    let checks = 0;
    const { gate, trace } = harness({
      replies: [{ invalid: true }],
      desk_revalidate: async () => {
        checks += 1;
        if (checks === 2) available = 3_999;
        return { checked_at: `2026-10-06T00:00:0${checks}.000Z` };
      },
    });

    await expect(gate.withRepair(STEP, "system", {}, schema, () => available, reply => {
      if ((reply as { readonly invalid?: boolean }).invalid === true) {
        throw new AgenticAskOutputErrorV1("parts are invalid");
      }
      return reply;
    })).rejects.toBeInstanceOf(AgenticAskPostRevalidationNoTimeErrorV1);
    expect(trace).toEqual(["revalidate", "generate:0", "revalidate"]);
    expect(gate.stats()).toMatchObject({ calls: 1, repairs: 0, generations: [{ role: "step" }] });
  });

  it("stops after a permanent provider failure and still records the call", async () => {
    const permanent = Object.assign(new Error("denied"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } });
    const { gate } = harness({ replies: [permanent] });
    await expect(gate.call(ANSWER, "system", {}, schema, () => 20_000)).rejects.toBeInstanceOf(AgenticAskOutputErrorV1);
    expect(gate.stats()).toMatchObject({ calls: 1, stopped: true, generations: [{ role: "answer", finish_reason: null, usage: null }] });
  });

  it.each(['length', 'content_filter'] as const)('captures one terminal response for a %s finish while preserving repair or fallback', async finish_reason => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const replies = [{ partial: true }, { good: true }];
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: null, reasoning_tokens: null };
    let calls = 0;
    const { gate } = harness({
      model: {
        generate: async () => { throw new Error('value-only method must not be used'); },
        generate_with_observation: async () => ({ value: replies[calls++], usage, provider_latency_ms: 1, finish_reason: calls === 1 ? finish_reason : 'stop' }),
      },
      desk_revalidate: async () => ({ checked_at: '2026-10-06T00:00:00.000Z' }),
    });
    const pending = withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => gate.withRepair(STEP, 'system', {}, schema, () => 20_000, value => value));
    if (finish_reason === 'length') await expect(pending).resolves.toEqual({ good: true });
    else await expect(pending).rejects.toMatchObject({ recovery: 'fallback' });
    const requests = events.filter(event => event.kind === 'model_request');
    const terminals = events.filter(event => event.kind === 'model_response' || event.kind === 'model_error');
    expect(requests).toHaveLength(finish_reason === 'length' ? 2 : 1);
    // The exporter pairs each admitted call with exactly one terminal event.
    for (const request of requests) {
      expect(terminals.filter(event => event.call_id === request.call_id)).toEqual([
        expect.objectContaining({ kind: 'model_response', span_id: request.span_id, value: replies[request.call_id - 1], usage }),
      ]);
    }
    expect(terminals[0]).toMatchObject({ finish_reason });
    expect(gate.stats()).toMatchObject({ calls: requests.length, repairs: finish_reason === 'length' ? 1 : 0, stopped: finish_reason === 'content_filter' });
  });

  it('puts the serving host and generation id an adapter reports on the call\'s terminal event, served or failed', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: null, reasoning_tokens: null };
    const served = { upstream_provider: 'DeepInfra', generation_id: 'gen-1760650000-AbCdEfGh12345678' };
    const timeout = Object.assign(new Error('private provider text'), {
      diagnostic: { failure_class: 'adapter_timeout', http_status: null, finish_reason: null },
      generation_observation: { usage, provider_latency_ms: 7_000, upstream_provider: 'Friendli', generation_id: 'gen-1760650001-ZyXwVuTs98765432' },
    });
    let calls = 0;
    const { gate } = harness({
      model: {
        generate: async () => { throw new Error('value-only method must not be used'); },
        generate_with_observation: async () => {
          if (calls++ === 0) return { value: { a: 1 }, usage, provider_latency_ms: 1, finish_reason: 'stop', ...served };
          throw timeout;
        },
      },
    });
    await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, async () => {
      await gate.call(STEP, 'system', {}, schema, () => 20_000);
      await expect(gate.call(STEP, 'system', {}, schema, () => 20_000)).rejects.toMatchObject({ recovery: 'retry' });
    });
    expect(events.filter(event => event.kind === 'model_response' || event.kind === 'model_error')).toEqual([
      expect.objectContaining({ kind: 'model_response', call_id: 1, ...served }),
      expect.objectContaining({ kind: 'model_error', call_id: 2, error_kind: 'adapter_timeout', upstream_provider: 'Friendli', generation_id: 'gen-1760650001-ZyXwVuTs98765432' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private provider text');
  });

  it("repairs once with the validation error and the rejected reply", async () => {
    const { gate, inputs } = harness({ replies: [{ bad: true }, { good: true }] });
    const rejections: string[] = [];
    const value = await gate.withRepair(STEP, "system", { question: "q" }, schema, () => 20_000, reply => {
      if ((reply as { bad?: boolean }).bad) throw new AgenticAskOutputErrorV1("needs are missing");
      return reply;
    }, reason => rejections.push(reason));
    expect(value).toEqual({ good: true });
    expect(rejections).toEqual(["needs are missing"]);
    // The system prompt and the rejected call's user prompt are the repair's prefix; the reason goes last.
    expect(inputs[1]!.system_prompt).toBe("system");
    expect(inputs[1]!.user_prompt.startsWith(inputs[0]!.user_prompt.slice(0, -1))).toBe(true);
    expect(inputs[1]!.user_prompt).toBe(JSON.stringify({ question: "q", rejected_response: JSON.stringify({ bad: true }), validation_error: repairInstruction("needs are missing") }));
    expect(repairInstruction("needs are missing")).toBe("Your previous reply could not be used: needs are missing. Reply again with only the JSON object, in exactly the shape your instructions show.");
    expect(gate.stats()).toMatchObject({ calls: 2, repairs: 1, stopped: false });
  });

  it("fingerprints every admitted call exactly as the Ask audit does", async () => {
    const { gate, inputs } = harness({ replies: [{ a: 1 }] });
    await gate.call(STEP, "system", { q: 1 }, schema, () => 20_000);
    const input = inputs[0]!;
    expect(input.max_output_tokens).toBe(1_500);
    expect(gate.stats().invocation_digests).toEqual([canonicalSha256({
      role: "step", model: input.model, system_prompt: input.system_prompt, user_prompt: input.user_prompt,
      schema: input.schema, max_output_tokens: input.max_output_tokens, timeout_ms: input.timeout_ms,
    })]);
  });

  it("runs each call in the span its caller names, while the audit records the role", async () => {
    const { gate } = harness({ replies: [{ a: 1 }, { b: 2 }] });
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1("ask_request", async () => {
      await gate.call({ role: "step", span: "ask_answer" }, "system", {}, schema, () => 20_000);
      await gate.call({ role: "answer", span: "ask_planner" }, "system", {}, schema, () => 20_000);
    }, { observer: event => { events.push(event); } });
    expect(events.filter(event => !event.root && event.event === "started").map(event => event.stage)).toEqual(["research_revalidation", "ask_answer", "research_revalidation", "ask_planner"]);
    expect(gate.stats().generations.map(entry => entry.role)).toEqual(["step", "answer"]);
  });

  it("refuses an operation started after the abort without leaving its rejection unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.once("unhandledRejection", record);
    try {
      const controller = new AbortController();
      controller.abort();
      let reject!: (reason: Error) => void;
      const late = new Promise<never>((_resolve, rejectLate) => { reject = rejectLate; });
      await expect(raceAbort(controller.signal, late)).rejects.toMatchObject({ name: "AbortError" });
      reject(new Error("late desk failure"));
      // Give an unhandled rejection a macrotask to surface.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", record); }
  });
});
