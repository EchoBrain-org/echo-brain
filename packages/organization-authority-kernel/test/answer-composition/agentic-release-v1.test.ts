import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonAnswerResponseV4 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createAgenticAskV1, createAgenticAskV3, createAgenticResearchV1, type AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import type { AgenticModelGateStatsV1 } from "../../src/answer-composition/agentic-model-gate-v1.js";
import { auditAgenticTerminalV1, releaseAgenticResultV1 } from "../../src/answer-composition/agentic-release-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import type { AnswerCompositionStageObservationV1 } from "../../src/answer-composition/structured-generation-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";

/**
 * The release step must append exactly the audit entry today's inline
 * `audit()` appended, at the same point in the desk call order. The baseline
 * was recorded from the untouched implementation at 98d6def (research trigger
 * contract v1, Task 2.1); never regenerate it from the code being verified.
 * Task 4 re-recorded only the two Sweep entries, whose task text (and so their
 * prompt fingerprints) changed; every Ask entry is unchanged.
 */
const BASELINE = "./__snapshots__/agentic-release-v1.audit.json";
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
const project = { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" } as EvidenceDeskPortV2["scope"];

function record(id: string, text: string | undefined = `Approved: ${id} was decided.`, extra: Partial<EvidenceDeskItemV2> = {}): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === undefined ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    occurred_at: "2026-10-05", receipt_sha256: canonicalSha256({ receipt: id }), ...extra,
  });
}
function ticket(key: string, body: string | undefined): EvidenceDeskItemV2 {
  const citation = { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(body ?? "") };
  return Object.freeze({
    id: `ticket_${key}_${body === undefined ? "listed" : "open"}`, citation, kind: "ticket" as const, label: `${key}: Fixture work item`,
    ...(body === undefined ? {} : { text: body }), visibility: "only_me" as const, attributes: { status: "In Progress", owner: "Mara Quinn" },
    occurred_at: "2026-09-30", date_kind: "created" as const, receipt_sha256: canonicalSha256({ ticket: key, body: body ?? null }),
  });
}
function page(id: string, body: string | undefined): EvidenceDeskItemV2 {
  const citation = { kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: id, section_id: "s1", version: "3", permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: sha256Digest(body ?? "") };
  return Object.freeze({
    id: `page_${id}_${body === undefined ? "listed" : "open"}`, citation, kind: "page" as const, label: `Gate review ${id}`,
    ...(body === undefined ? {} : { text: body }), visibility: "only_me" as const, occurred_at: "2026-10-04", date_kind: "version_created" as const,
    receipt_sha256: canonicalSha256({ page: id, body: body ?? null }),
  });
}
const result = (items: readonly EvidenceDeskItemV2[], extra: Partial<EvidenceDeskResultV2> = {}): EvidenceDeskResultV2 =>
  ({ items, truncated: false, receipt_digests: [canonicalSha256({ desk: items.map(item => item.id) })], ...extra });
const step = (needs: readonly { need: string; status: string; evidence?: readonly string[] }[], actions: readonly { tool: string; args?: Record<string, string> }[], question = "Part") =>
  ({ parts: [{ question, notes: "", needs: needs.map(need => ({ evidence: [], ...need })) }], actions: actions.map(action => ({ args: {}, ...action })) });

type Kind = "ask_v4" | "ask_v6" | "research";
/**
 * A pinned clock (model calls 1 s, desk reads 7 ms) and one trace of every
 * desk call, model call, audit append and stage event, in order. Each
 * revalidation returns a distinct time so the trace shows which check the
 * audit binds.
 */
function harness(kind: Kind, replies: readonly unknown[], desk: Partial<EvidenceDeskPortV2>, hooks: {
  readonly model_ms?: number;
  readonly on_append?: (entry: AgenticAskAuditEntryV1) => Promise<void> | void;
  readonly on_desk?: (name: string) => void;
} = {}) {
  let clock = 0; let checks = 0;
  const trace: string[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  const traced = <A extends unknown[], R>(name: string, operation: (...args: A) => Promise<R>) => async (...args: A) => {
    clock += 7; trace.push(name); hooks.on_desk?.(name); return operation(...args);
  };
  const base: EvidenceDeskPortV2 = {
    scope: project, live_sources: [],
    search: async () => result([]), open: async () => result([]), list: async () => result([]), ...desk,
    revalidate: async () => { checks += 1; return { checked_at: `2026-10-06T00:00:${String(checks).padStart(2, "0")}.000Z` }; },
  };
  const port: EvidenceDeskPortV2 = {
    ...base, search: traced("search", base.search), open: traced("open", base.open), list: traced("list", base.list),
    revalidate: async input => { const value = await base.revalidate(input); trace.push(`revalidate:${value.checked_at}`); return value; },
    ...(base.openCitation === undefined ? {} : { openCitation: traced("openCitation", base.openCitation) }),
  };
  let calls = 0;
  const options = {
    desk: port, generation, today: () => "2026-10-06", now_ms: () => clock,
    audit: { append: async (entry: AgenticAskAuditEntryV1) => { trace.push(`append:${entry.outcome}`); audit.push(entry); await hooks.on_append?.(entry); } },
    on_stage: (event: AnswerCompositionStageObservationV1) => { trace.push(`stage:${event.stage}:${event.event}:${event.elapsed_ms}`); },
    model: {
      async generate() { throw new Error("the gate prefers generate_with_observation"); },
      async generate_with_observation(_input: StructuredGenerationInput) {
        calls += 1; trace.push(`generate:${calls}`);
        const reply = replies[calls - 1];
        if (reply === undefined) throw new Error(`unscripted call ${calls}`);
        clock += hooks.model_ms ?? 1_000;
        return { value: reply, finish_reason: "stop" as const, provider_latency_ms: 1_000, usage: { input_tokens: 100 * calls, output_tokens: 10, total_tokens: 100 * calls + 10, cached_input_tokens: null, reasoning_tokens: null } };
      },
    },
  };
  const create = () => kind === "ask_v4" ? createAgenticAskV1(options as unknown as Parameters<typeof createAgenticAskV1>[0])
    : kind === "ask_v6" ? createAgenticAskV3(options) : createAgenticResearchV1(options);
  return { create, trace, audit };
}

const dashboard = record("dashboard", "Approved: publish the dashboard by September 11.");
const owner = record("owner", "Approved: Jules owns the dashboard.");
const sweepTrigger = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "sweep")!;
const sweep = { trigger: "sweep", brief: sweepTrigger.brief(sweepTrigger.parseEvent({ findings: [
  { finding: "Dashboard published", expected: "Published by September 11", citations: [dashboard.citation, owner.citation] },
] })) };
const sweepReplies = [
  step([{ need: "dashboard published", status: "open" }], [{ tool: "search", args: { query: "dashboard published" } }], "Dashboard"),
  step([{ need: "dashboard published", status: "found", evidence: ["E1", "E3"] }], [{ tool: "finish" }], "Dashboard"),
];
const sweepDesk: Partial<EvidenceDeskPortV2> = {
  openCitation: async input => result([JSON.stringify(input.citation) === JSON.stringify(dashboard.citation) ? dashboard : owner]),
  search: async () => result([record("published", "Approved: the dashboard was published on September 10.")], { notice: "Some meetings are still importing." }),
};
const liveDesk = (): Partial<EvidenceDeskPortV2> => {
  const listedTicket = ticket("THERM-46", undefined);
  const openTicket = ticket("THERM-46", "THERM-46: BUG-412 observed 39.0 °C versus 37.2 °C expected under load.");
  const listedPage = page("1441793", undefined);
  const openPage = page("1441793", "DVT review: HOLD until TC-D-03 and BUG-412 are resolved.");
  return {
    scope: { kind: "global" }, ticket_available: true,
    live_sources: [
      { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" },
      { source_id: "confluence", kind: "page", selector: "pages", description: "Live knowledge pages.", metadata_only_list: true, tool_id: "confluence" },
    ],
    search: async () => result([listedPage]), list: async () => result([listedTicket]),
    open: async input => result([input.item === listedTicket.id ? openTicket : openPage]),
  };
};
const liveReplies = [
  step([{ need: "reason for DVT hold", status: "open" }], [{ tool: "list", args: { source: "tickets" } }, { tool: "search", args: { source: "pages", query: "DVT review hold" } }], "Why on hold?"),
  step([{ need: "reason for DVT hold", status: "open" }], [{ tool: "open", args: { id: "E1" } }, { tool: "open", args: { id: "E2" } }], "Why on hold?"),
  step([{ need: "reason for DVT hold", status: "found", evidence: ["E3", "E4"] }], [{ tool: "finish" }], "Why on hold?"),
  { sentences: [{ text: "DVT is on hold until TC-D-03 and BUG-412 are resolved.", evidence: ["E3", "E4"] }], not_found: [] },
];
const askReplies = [
  step([{ need: "dashboard date", status: "open" }], [{ tool: "search", args: { query: "dashboard" } }]),
  step([{ need: "dashboard date", status: "found", evidence: ["E1"] }], [{ tool: "finish" }]),
  { sentences: [{ text: "The dashboard is due September 11.", evidence: ["E1"] }], not_found: [] },
];

async function settle(run: () => Promise<unknown>): Promise<string> {
  try { const value = await run() as { readonly outcome?: string; readonly kind?: string }; return `released:${value.outcome ?? value.kind}`; }
  catch (error) { return `rejected:${(error as Error).name}`; }
}

/** Every path that writes an audit today: both release tails, and the timed-out and cancelled terminals. */
async function observeAll() {
  const observed: Record<string, { readonly ending: string; readonly trace: readonly string[]; readonly audit: readonly AgenticAskAuditEntryV1[] }> = {};
  {
    const h = harness("ask_v6", liveReplies, liveDesk());
    const ending = await settle(() => (h.create() as ReturnType<typeof createAgenticAskV3>).answer({ question: "Why is the DVT gate on hold?" }));
    observed.ask_v6 = { ending, trace: h.trace, audit: h.audit };
  }
  {
    const h = harness("ask_v4", askReplies, { search: async () => result([dashboard]) });
    const ending = await settle(() => (h.create() as ReturnType<typeof createAgenticAskV1>).answer({ question: "When is the dashboard due?" }));
    observed.ask_v4 = { ending, trace: h.trace, audit: h.audit };
  }
  {
    const h = harness("research", sweepReplies, sweepDesk);
    const ending = await settle(() => (h.create() as ReturnType<typeof createAgenticResearchV1>).research(sweep));
    observed.sweep = { ending, trace: h.trace, audit: h.audit };
  }
  {
    // The first step's reply lands after the five-minute background deadline.
    const h = harness("research", sweepReplies, sweepDesk, { model_ms: 301_000 });
    const ending = await settle(() => (h.create() as ReturnType<typeof createAgenticResearchV1>).research(sweep));
    observed.sweep_timed_out = { ending, trace: h.trace, audit: h.audit };
  }
  {
    const controller = new AbortController();
    const h = harness("ask_v6", askReplies, { search: async () => result([dashboard]) }, { on_desk: name => { if (name === "search") controller.abort(); } });
    const ending = await settle(() => (h.create() as ReturnType<typeof createAgenticAskV3>).answer({ question: "When is the dashboard due?", signal: controller.signal }));
    observed.ask_cancelled_in_research = { ending, trace: h.trace, audit: h.audit };
  }
  {
    const controller = new AbortController();
    const h = harness("ask_v6", liveReplies, liveDesk(), { on_append: () => { controller.abort(); } });
    const ending = await settle(() => (h.create() as ReturnType<typeof createAgenticAskV3>).answer({ question: "Why is the DVT gate on hold?", signal: controller.signal }));
    observed.ask_v6_cancelled_during_append = { ending, trace: h.trace, audit: h.audit };
  }
  return observed;
}

describe("release step: today's audit entries", () => {
  it("appends byte-identical entries at the same points for Ask V4, Ask V6, Sweep and both terminals", async () => {
    const serialized = `${JSON.stringify(await observeAll(), null, 2)}\n`;
    // Compared, never written: an update run must not re-record the baseline from new code.
    expect(serialized).toBe(readFileSync(new URL(BASELINE, import.meta.url), "utf8"));
  });
});

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
  const digests = { answer_sha256: canonicalSha256({ answer: "fixture" }), response_sha256: canonicalSha256({ response: "fixture" }) };
  const run = () => releaseAgenticResultV1({
    ...context,
    desk: { revalidate: () => { trace.push("revalidate"); fences += 1; return options.fence?.(fences) ?? Promise.resolve({ checked_at: `2026-10-06T00:00:0${fences}.000Z` }); } },
    outcome: "answered", citation_count: 2, result: response, digests,
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

  it("audits the fingerprints of the result it is given", async () => {
    const r = release({ fence_after_audit: false });
    await r.run();
    expect(r.entries[0]).toMatchObject({
      outcome: "answered", citation_count: 2, rounds: 3, model_calls: 2, repairs: 1, fallbacks: 1,
      prompt_sha256: canonicalSha256({ generation: "fixture", invocations: [canonicalSha256({ call: 1 }), canonicalSha256({ call: 2 })] }),
      answer_sha256: canonicalSha256({ answer: "fixture" }), response_sha256: canonicalSha256({ response: "fixture" }),
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
