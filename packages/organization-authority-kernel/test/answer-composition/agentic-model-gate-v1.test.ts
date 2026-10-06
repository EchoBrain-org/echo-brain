import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { createAgenticModelGateV1 } from "../../src/answer-composition/agentic-model-gate-v1.js";
import { AgenticAskOutputErrorV1, repairPrompt } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { StructuredGenerationInput, StructuredGenerationJsonSchema } from "../../src/answer-composition/structured-generation-v1.js";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
const schema = { type: "object" } as unknown as StructuredGenerationJsonSchema;

function harness(options: { readonly replies?: readonly (unknown | Error)[]; readonly max_model_calls?: number } = {}) {
  const trace: string[] = [];
  const inputs: StructuredGenerationInput[] = [];
  const replies = [...(options.replies ?? [])];
  const checked: string[] = [];
  const gate = createAgenticModelGateV1({
    generation,
    model: {
      async generate(input) {
        trace.push(`generate:${inputs.length}`); inputs.push(input);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    desk_revalidate: async () => { trace.push("revalidate"); return { checked_at: `2026-10-06T00:00:0${checked.length}.000Z` }; },
    on_checked: at => { checked.push(at); },
    budget: { max_model_calls: options.max_model_calls ?? 24 },
    now: () => 0,
    deadline: 90_000,
    signal: new AbortController().signal,
    is_deadline_expired: () => false,
    content_sensitive: () => false,
  });
  return { gate, trace, inputs, checked };
}

describe("agentic model gate", () => {
  it("revalidates the desk once before every model call and reports the check time", async () => {
    const { gate, trace, checked } = harness({ replies: [{ a: 1 }, { b: 2 }] });
    await gate.call("step", "system", { q: 1 }, schema, () => 20_000);
    await gate.call("answer", "system", { q: 2 }, schema, () => 20_000);
    expect(trace).toEqual(["revalidate", "generate:0", "revalidate", "generate:1"]);
    expect(checked).toEqual(["2026-10-06T00:00:00.000Z", "2026-10-06T00:00:01.000Z"]);
    expect(gate.stats().calls).toBe(2);
  });

  it("enforces the request's call budget before revalidating", async () => {
    const { gate, trace } = harness({ replies: [{ a: 1 }], max_model_calls: 1 });
    await gate.call("step", "system", {}, schema, () => 20_000);
    await expect(gate.call("step", "system", {}, schema, () => 20_000)).rejects.toThrow("call budget exhausted");
    expect(trace).toEqual(["revalidate", "generate:0"]);
    expect(gate.stats()).toMatchObject({ calls: 1, stopped: false });
  });

  it("stops after a permanent provider failure and still records the call", async () => {
    const permanent = Object.assign(new Error("denied"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } });
    const { gate } = harness({ replies: [permanent] });
    await expect(gate.call("answer", "system", {}, schema, () => 20_000)).rejects.toBeInstanceOf(AgenticAskOutputErrorV1);
    expect(gate.stats()).toMatchObject({ calls: 1, stopped: true, generations: [{ role: "answer", finish_reason: null, usage: null }] });
  });

  it("repairs once with the validation error and the rejected reply", async () => {
    const { gate, inputs } = harness({ replies: [{ bad: true }, { good: true }] });
    const rejections: string[] = [];
    const value = await gate.withRepair("step", "system", { question: "q" }, schema, () => 20_000, reply => {
      if ((reply as { bad?: boolean }).bad) throw new AgenticAskOutputErrorV1("needs are missing");
      return reply;
    }, reason => rejections.push(reason));
    expect(value).toEqual({ good: true });
    expect(rejections).toEqual(["needs are missing"]);
    expect(inputs[1]!.system_prompt).toBe(repairPrompt("system", "needs are missing"));
    expect(JSON.parse(inputs[1]!.user_prompt)).toEqual({ question: "q", validation_error: "needs are missing", rejected_response: JSON.stringify({ bad: true }) });
    expect(gate.stats()).toMatchObject({ calls: 2, repairs: 1, stopped: false });
  });

  it("fingerprints every admitted call exactly as the Ask audit does", async () => {
    const { gate, inputs } = harness({ replies: [{ a: 1 }] });
    await gate.call("step", "system", { q: 1 }, schema, () => 20_000);
    const input = inputs[0]!;
    expect(input.max_output_tokens).toBe(1_500);
    expect(gate.stats().invocation_digests).toEqual([canonicalSha256({
      role: "step", model: input.model, system_prompt: input.system_prompt, user_prompt: input.user_prompt,
      schema: input.schema, max_output_tokens: input.max_output_tokens, timeout_ms: input.timeout_ms,
    })]);
  });
});
