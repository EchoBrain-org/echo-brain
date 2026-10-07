import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { PersonAnswerResponseV4 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import type { AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import type { AgenticModelGateStatsV1 } from "../../src/answer-composition/agentic-model-gate-v1.js";
import { auditAgenticTerminalV1, releaseAgenticResultV1 } from "../../src/answer-composition/agentic-release-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import type { EvidenceDeskPortV2 } from "../../src/shared/evidence-desk-v2.js";
import { need, part, replay, researchHarness, SCENARIOS, step } from "./fixtures/agentic-scenarios.js";

/** The release step on its own: a scripted desk and audit port, one trace of both. */
function release(options: { readonly fence_after_audit: boolean; readonly on_append?: () => void; readonly fence?: (index: number) => Promise<{ readonly checked_at: string }> }) {
  const trace: string[] = [];
  const entries: AgenticAskAuditEntryV1[] = [];
  const checked: string[] = [];
  const controller = new AbortController();
  let audited = 0; let fences = 0;
  const stats: AgenticModelGateStatsV1 = {
    calls: 2, repairs: 1, stopped: false, invocation_digests: [canonicalSha256({ call: 1 }), canonicalSha256({ call: 2 })],
    generations: [{ role: "step", finish_reason: "stop", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cached_input_tokens: null, reasoning_tokens: null } }, { role: "answer", finish_reason: "length", usage: null }],
  };
  const context = {
    audit: { append: (entry: AgenticAskAuditEntryV1) => { trace.push("append"); entries.push(entry); options.on_append?.(); } },
    generation_adapter_id: "fixture", gate_stats: () => stats, background: false, receipts: [canonicalSha256({ receipt: 1 })], rounds: 3, fallbacks: 1,
  };
  const response: PersonAnswerResponseV4 = { schema_version: 4, kind: "echo-clean-person-answer-v4", scope: { kind: "global" }, outcome: "answered", parts: [{ question: "Q", status: "answered", statements: [] }], citations: [] };
  const run = () => releaseAgenticResultV1({
    ...context,
    desk: { revalidate: () => { trace.push("revalidate"); fences += 1; return options.fence?.(fences) ?? Promise.resolve({ checked_at: `2026-10-06T00:00:0${fences}.000Z` }); } },
    outcome: "answered", citation_count: 2, result: response, answer_sha256: canonicalSha256({ answer: "fixture" }),
    fence_after_audit: options.fence_after_audit, signal: controller.signal,
    assert_live: () => { if (controller.signal.aborted) throw new DOMException("Ask cancelled", "AbortError"); },
    on_checked: at => { checked.push(at); }, on_audited: () => { audited += 1; }, now: () => 0,
  });
  return { run, trace, entries, checked, controller, context, response, audited: () => audited };
}

describe("release step", () => {
  it("checks access, audits once and checks again before handing over when the fence after the audit is on", async () => {
    const r = release({ fence_after_audit: true });
    await expect(r.run()).resolves.toBe(r.response);
    expect(r.trace).toEqual(["revalidate", "append", "revalidate"]);
    expect(r.checked).toEqual(["2026-10-06T00:00:01.000Z", "2026-10-06T00:00:02.000Z"]);
    // The audit binds the check before it, never the one after.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.checked_at).toBe("2026-10-06T00:00:01.000Z");
    expect(r.audited()).toBe(1);
  });

  it("checks access and audits, with no second check, when the fence after the audit is off", async () => {
    const r = release({ fence_after_audit: false });
    await expect(r.run()).resolves.toBe(r.response);
    expect(r.trace).toEqual(["revalidate", "append"]);
    expect(r.checked).toEqual(["2026-10-06T00:00:01.000Z"]);
  });

  it.each([true, false])("releases nothing when the request is cancelled during the append (fence after audit: %s)", async fence_after_audit => {
    const r = release({ fence_after_audit, on_append: () => r.controller.abort() });
    await expect(r.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(r.trace).toEqual(["revalidate", "append"]);
    // The completed audit stays; the caller must not write a second witness.
    expect(r.audited()).toBe(1);
  });

  it("releases nothing and writes no audit when the final access check refuses", async () => {
    const refusal = new Error("membership revoked");
    const r = release({ fence_after_audit: true, fence: () => Promise.reject(refusal) });
    await expect(r.run()).rejects.toBe(refusal);
    expect(r.trace).toEqual(["revalidate"]);
    expect(r.audited()).toBe(0);
  });

  it("audits the fingerprint of the result it hands over and of its answer", async () => {
    const r = release({ fence_after_audit: false });
    await r.run();
    expect(r.entries[0]).toMatchObject({
      outcome: "answered", citation_count: 2, rounds: 3, model_calls: 2, repairs: 1, fallbacks: 1,
      prompt_sha256: canonicalSha256({ generation: "fixture", invocations: [canonicalSha256({ call: 1 }), canonicalSha256({ call: 2 })] }),
      answer_sha256: canonicalSha256({ answer: "fixture" }), response_sha256: canonicalSha256(r.response),
      generation_usage: { input_tokens: null, output_tokens: null, total_tokens: null }, finish_reason_counts: { stop: 1, length: 1 },
    });
    expect("trigger" in r.entries[0]! || "budget" in r.entries[0]!).toBe(false);
  });

  it.each(["timed_out", "cancelled"] as const)("writes a %s witness with no prompt, answer or response digest", async kind => {
    const r = release({ fence_after_audit: true });
    await auditAgenticTerminalV1(kind, { ...r.context, trigger: "sweep", background: true, checked_at: null });
    expect(r.trace).toEqual(["append"]);
    expect(r.entries[0]).toMatchObject({
      kind: "echo-agentic-ask-audit-v1", trigger: "sweep", budget: "background", outcome: kind, citation_count: 0, checked_at: null,
      prompt_sha256: null, answer_sha256: null, response_sha256: null, model_calls: 2, repairs: 1, fallbacks: 1, rounds: 3,
    });
  });
});

describe("release step: request terminals", () => {
  it("writes a timed_out witness naming the trigger and its background budget when research outlives the deadline", async () => {
    let clock = 0;
    // The first step's reply lands after the five-minute background deadline.
    const h = researchHarness(() => { clock += 301_000; return step([part("Dashboard", [need("dashboard published", "open")])], [{ tool: "search", args: { query: "dashboard" } }]); }, {}, { now_ms: () => clock });
    const brief = { goal: { kind: "task" as const, task: "Recheck the dashboard." }, starting: [], budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false } };
    await expect(h.research.research({ trigger: "sweep", brief })).rejects.toMatchObject({ name: "AgenticAskDeadlineErrorV1" });
    expect(h.audit).toEqual([expect.objectContaining({ trigger: "sweep", budget: "background", outcome: "timed_out", model_calls: 1, prompt_sha256: null, answer_sha256: null, response_sha256: null })]);
  });

  it("writes no second witness and checks access no more when Ask is cancelled during its audit write", async () => {
    const controller = new AbortController();
    const trace: string[] = [];
    const scenario = SCENARIOS.live_ticket_and_page!;
    const desk = scenario.desk() as EvidenceDeskPortV2;
    const traced = { ...scenario, desk: () => ({ ...desk, revalidate: (input: { readonly signal: AbortSignal }) => { trace.push("revalidate"); return desk.revalidate(input); } }) };
    const on_append = (entry: AgenticAskAuditEntryV1) => { trace.push(`append:${entry.outcome}`); controller.abort(); };
    await expect(replay("cancelled_during_append", traced, { signal: controller.signal, on_append })).rejects.toMatchObject({ name: "AbortError" });
    expect(trace.filter(event => event.startsWith("append"))).toEqual(["append:answered"]);
    expect(trace.at(-1)).toBe("append:answered");
  });
});
