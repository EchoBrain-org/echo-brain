import { readFileSync } from "node:fs";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  agenticAskContextBudgetBytesV1,
  createAgenticAskV1,
  createAgenticAskV2,
  createAgenticAskV3,
  createAgenticResearchV1,
  type AgenticAskAuditEntryV1,
  type AgenticBriefV1,
} from "../../../src/answer-composition/agentic-ask-v1.js";
import { answerSchema, ANSWER_PROMPT } from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleItemV1, AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1, createAgenticModelGateV1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { createAskRendererV1 } from "../../../src/answer-composition/renderers/ask-renderer-v1.js";
import type { StructuredGenerationInput } from "../../../src/answer-composition/structured-generation-v1.js";
import type { EvidenceDeskItemV1, EvidenceDeskPortV1, EvidenceDeskResultV1 } from "../../../src/shared/evidence-desk-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../../src/shared/evidence-desk-v2.js";

/**
 * The Ask renderer must write exactly what the inline writer wrote. The
 * baseline was recorded from the untouched inline writer at 2000b5f (research
 * trigger contract v1, Task 3.1); never regenerate it from the code being
 * verified. Three golden scenarios, copied verbatim from
 * agentic-ask-golden.test.ts and replayed with the same harness (scripted
 * replies, a clock that moves only on model calls), cover a V4, a V5 and a V6
 * response.
 */
const BASELINE = new URL("./__snapshots__/ask-renderer-v1.writer.json", import.meta.url);
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
const checked = { checked_at: "2026-10-06T00:00:00.000Z" };

function record(id: string, text: string | undefined = `Approved record ${id}: the review decided ${id}.`, options: Partial<EvidenceDeskItemV1> = {}): EvidenceDeskItemV1 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === undefined ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    occurred_at: "2026-10-01", receipt_sha256: canonicalSha256({ receipt: id }), ...options,
  });
}
function ticket(key: string, body: string | undefined, status: string): EvidenceDeskItemV2 {
  const citation = { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(body ?? "") };
  return Object.freeze({
    id: `ticket_${key}_${body === undefined ? "listed" : "open"}`, citation, kind: "ticket" as const, label: `${key}: Fixture work item`,
    ...(body === undefined ? {} : { text: body }), visibility: "only_me" as const, attributes: { status, owner: "Mara Quinn" },
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
const result = <T extends EvidenceDeskItemV1 | EvidenceDeskItemV2>(items: readonly T[], extra: Partial<EvidenceDeskResultV1> = {}) =>
  ({ items, truncated: false, receipt_digests: [canonicalSha256({ desk: items.map(item => item.id) })], ...extra });

type Scenario = {
  readonly version: 4 | 5 | 6;
  readonly question: string;
  readonly desk: () => EvidenceDeskPortV1 | EvidenceDeskPortV2;
  readonly replies: readonly unknown[];
  readonly model_call_ms?: number;
  readonly asker?: string;
};
const need = (text: string, status: string, evidence: readonly string[] = []) => ({ need: text, status, evidence });
const part = (question: string, needs: readonly ReturnType<typeof need>[], notes = "") => ({ question, needs, notes });
const step = (parts: readonly ReturnType<typeof part>[], actions: readonly { tool: string; args: Record<string, string> }[]) => ({ parts, actions });

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  // Research stops on its time budget: an incomplete answer with a cited sentence, a missing fact and an unread search hit.
  budget_stop_with_slow_clock: {
    version: 4, question: "Is the DVT build on track?",
    model_call_ms: 20_000,
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async (input: { readonly query?: string }) => result([record(`hit-${input.query ?? "none"}`)]),
      open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("On track?", [need("DVT status", "open")])], [{ tool: "search", args: { query: "DVT status" } }]),
      step([part("On track?", [need("DVT status", "open")])], [{ tool: "search", args: { query: "DVT schedule" } }]),
      step([part("On track?", [need("DVT status", "open")])], [{ tool: "search", args: { query: "DVT risk" } }]),
      { sentences: [{ text: "The review decided hit-DVT status.", evidence: ["E1"] }], not_found: ["whether DVT is on track"] },
    ],
  },
  // The writer fails twice: the response falls back to research-read records. The golden replay runs it as V4; here it is V5.
  writer_fallback_to_records: {
    version: 5, question: "What did the review decide about calibration?",
    desk: () => ({
      scope: { kind: "global" }, live_sources: [],
      search: async () => result([record("calibration", "Approved: calibrate every unit on the line at 37 °C.")]),
      open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
    }),
    replies: [
      step([part("Calibration decision?", [need("calibration decision", "open")])], [{ tool: "search", args: { query: "calibration" } }]),
      step([part("Calibration decision?", [need("calibration decision", "found", ["E1"])])], [{ tool: "finish", args: {} }]),
      { wrong: true },
      { still: "wrong" },
    ],
  },
  // Live ticket and page: private items, a V6 page citation and the live source guidance.
  live_ticket_and_page: {
    version: 6, question: "Why is the DVT gate on hold?",
    desk: () => {
      const listedTicket = ticket("THERM-46", undefined, "In Progress");
      const openTicket = ticket("THERM-46", "THERM-46: BUG-412 observed 39.0 °C versus 37.2 °C expected under load.", "In Progress");
      const listedPage = page("1441793", undefined);
      const openPage = page("1441793", "DVT review: HOLD until TC-D-03 and BUG-412 are resolved.");
      const desk: EvidenceDeskPortV2 = {
        scope: { kind: "global" }, ticket_available: true,
        live_sources: [
          { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" },
          { source_id: "confluence", kind: "page", selector: "pages", description: "Live knowledge pages.", metadata_only_list: true, tool_id: "confluence" },
        ],
        search: async () => result([listedPage]) as EvidenceDeskResultV2,
        list: async () => result([listedTicket]) as EvidenceDeskResultV2,
        open: async (input) => result([input.item === listedTicket.id ? openTicket : openPage]) as EvidenceDeskResultV2,
        revalidate: async () => checked,
      };
      return desk;
    },
    replies: [
      step([part("Why on hold?", [need("reason for DVT hold", "open")])], [{ tool: "list", args: { source: "tickets" } }, { tool: "search", args: { source: "pages", query: "DVT review hold" } }]),
      step([part("Why on hold?", [need("reason for DVT hold", "open")])], [{ tool: "open", args: { id: "E1" } }, { tool: "open", args: { id: "E2" } }]),
      step([part("Why on hold?", [need("reason for DVT hold", "found", ["E3", "E4"])])], [{ tool: "finish", args: {} }]),
      { sentences: [{ text: "DVT is on hold until TC-D-03 and BUG-412 are resolved; BUG-412 observed 39.0 °C versus 37.2 °C under load.", evidence: ["E3", "E4"] }], not_found: [] },
    ],
  },
};

/** The golden replay's harness: scripted replies in order, and a clock that advances only when the model is called. */
function harness(name: string, scenario: Scenario) {
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  let offset = 0;
  let time = 0;
  const model = {
    generate: async (input: StructuredGenerationInput) => {
      inputs.push(input);
      time += scenario.model_call_ms ?? 0;
      const reply = scenario.replies[offset++];
      if (reply === undefined) throw new Error(`${name}: unscripted model call ${offset}`);
      return reply;
    },
  };
  const options = {
    desk: scenario.desk(), model, generation, audit: { append: (entry: AgenticAskAuditEntryV1) => { audit.push(entry); } },
    now_ms: () => time, today: () => "2026-10-06",
    ...(scenario.asker === undefined ? {} : { asker: { display_name: scenario.asker } }),
  };
  return { options: options as Parameters<typeof createAgenticAskV3>[0], inputs, audit };
}

/** What the writer was given and what Ask returned, for one scenario. */
async function observe(name: string, scenario: Scenario) {
  const ask = harness(name, scenario);
  const response = scenario.version === 4 ? await createAgenticAskV1(ask.options as unknown as Parameters<typeof createAgenticAskV1>[0]).answer({ question: scenario.question })
    : scenario.version === 5 ? await createAgenticAskV2(ask.options).answer({ question: scenario.question })
    : await createAgenticAskV3(ask.options).answer({ question: scenario.question });
  const entry = ask.audit.at(-1)!;
  // The research core exposes the full bundle and the writer's evidence. With no
  // version-gated live source, research is the same for every response version.
  const brief: AgenticBriefV1 = { goal: { kind: "question", question: scenario.question }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: true } };
  const bundle = await createAgenticResearchV1(harness(name, scenario).options).researchBundle({ trigger: "ask", brief });
  const { writer_evidence } = await createAgenticResearchV1(harness(name, scenario).options).answerWithResearch({ question: scenario.question });
  return {
    version: scenario.version,
    bundle,
    writer_evidence,
    writer_calls: ask.inputs.filter(input => input.schema === answerSchema).map(input => ({ system_prompt: input.system_prompt, user_prompt: input.user_prompt })),
    response,
    audit: { outcome: entry.outcome, citation_count: entry.citation_count, fallbacks: entry.fallbacks, answer_sha256: entry.answer_sha256, response_sha256: entry.response_sha256 },
  };
}
async function observeAll() {
  const observed: Record<string, Awaited<ReturnType<typeof observe>>> = {};
  for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await observe(name, scenario);
  return observed;
}

describe("Ask renderer: today's writer", () => {
  it("gives the writer the same prompt and returns the same response, end to end", async () => {
    const serialized = `${JSON.stringify(await observeAll(), null, 2)}\n`;
    // Compared, never written: an update run must not re-record the baseline from new code.
    expect(serialized).toBe(readFileSync(BASELINE, "utf8"));
  });
});

type Recorded = Omit<Awaited<ReturnType<typeof observe>>, "bundle"> & { readonly bundle: AgenticEvidenceBundleV1 };
const recorded = (): Readonly<Record<string, Recorded>> => JSON.parse(readFileSync(BASELINE, "utf8")) as Readonly<Record<string, Recorded>>;
type Header = { readonly scope: string; readonly source_catalog: readonly Readonly<Record<string, unknown>>[]; readonly asked_by?: string; readonly today: string };

/** Ask's renderer on its own: a bundle, a gate over scripted writer replies, and no desk. */
function alone(input: { readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly version: 4 | 5 | 6; readonly answer_prompt: string; readonly header: Header; readonly remaining?: number }) {
  const trace: string[] = [];
  const inputs: StructuredGenerationInput[] = [];
  const gate = createAgenticModelGateV1({
    generation,
    model: {
      generate: async (model: StructuredGenerationInput) => {
        trace.push("generate"); inputs.push(model);
        const reply = input.replies[inputs.length - 1];
        if (reply === undefined) throw new Error(`unscripted writer call ${inputs.length}`);
        return reply;
      },
    },
    desk_revalidate: async () => { trace.push("revalidate"); return checked; }, on_checked: () => undefined,
    budget: input.bundle.budget, now: () => 0, deadline: input.bundle.budget.deadline_ms,
    signal: new AbortController().signal, is_deadline_expired: () => false, content_sensitive: () => false,
  });
  const renderer = createAskRendererV1({
    response_version: input.version, answer_prompt: input.answer_prompt,
    source_catalog: input.header.source_catalog, scope: input.header.scope,
    context: { ...(input.header.asked_by === undefined ? {} : { asked_by: input.header.asked_by }), today: input.header.today },
    desk_scope: input.bundle.gathered_for.scope,
  });
  const render = (question: string) => renderer.render({
    bundle: input.bundle, trigger_input: { question }, gate, remaining: () => input.remaining ?? 30_000, signal: new AbortController().signal,
    prompt_budget: system => agenticAskContextBudgetBytesV1(undefined, system, AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer),
    on_context: selected => { trace.push(`context:${selected.join(",")}`); },
  });
  return { render, trace, inputs };
}

describe("Ask renderer: the bundle alone", () => {
  it.each(Object.keys(SCENARIOS))("writes today's prompt, evidence and response from the recorded bundle: %s", async name => {
    const scenario = SCENARIOS[name]!;
    const baseline = recorded()[name]!;
    // Pass-through options (scope text, source catalog, asker, day) are the
    // runner's, read from the recorded writer prompt. Everything the renderer
    // builds from the bundle (research coverage, evidence choice and order,
    // the layout) is compared byte for byte.
    const { question: _question, research: _research, evidence: _evidence, ...header } = JSON.parse(baseline.writer_calls[0]!.user_prompt) as Header & Record<string, unknown>;
    const run = alone({ bundle: baseline.bundle, replies: scenario.replies.slice(baseline.bundle.cost.model_calls), version: scenario.version, answer_prompt: baseline.writer_calls[0]!.system_prompt, header });
    const rendered = await run.render(scenario.question);
    expect(run.inputs.map(input => ({ system_prompt: input.system_prompt, user_prompt: input.user_prompt }))).toEqual(baseline.writer_calls);
    expect(run.inputs.every(input => input.schema === answerSchema)).toBe(true);
    expect(rendered.result.writer_evidence).toEqual(baseline.writer_evidence);
    expect(JSON.stringify(rendered.result.response)).toBe(JSON.stringify(baseline.response));
    expect(canonicalSha256(rendered.result.response)).toBe(baseline.audit.response_sha256);
    // The fingerprints the release step audits.
    expect(rendered.digests).toEqual({ answer_sha256: baseline.audit.answer_sha256, response_sha256: baseline.audit.response_sha256 });
    expect(rendered.outcome).toBe(baseline.audit.outcome);
    // Cited items are the response's citations, in order.
    expect(rendered.cited).toHaveLength(baseline.audit.citation_count);
    expect(rendered.cited.map(short => baseline.bundle.items.find(item => item.short === short)!.item.citation)).toEqual(rendered.result.response.citations.map(value => value.citation));
    // The audit counts research's fallbacks and the writer's.
    expect(rendered.fallbacks).toBe(baseline.audit.fallbacks - baseline.bundle.cost.fallbacks);
    // The context stage is reported once, before the first writer call's access check.
    expect(run.trace[0]).toBe(`context:${baseline.writer_evidence.join(",")}`);
    expect(run.trace.filter(event => event.startsWith("context:"))).toHaveLength(1);
  });

  const header: Header = { scope: "everything the asker can read", source_catalog: [], today: "2026-10-06" };
  const listedItem = (id: string) => { const { text: _text, ...item } = record(id); return Object.freeze(item) as EvidenceDeskItemV2; };
  /** A hand-built bundle: items in short-id order, the plan citing `cited`. */
  function bundle(entries: readonly { readonly item: EvidenceDeskItemV2; readonly full: boolean; readonly touched: number }[], cited: readonly string[], completed = true): AgenticEvidenceBundleV1 {
    const items: AgenticEvidenceBundleItemV1[] = entries.map((entry, index) => Object.freeze({
      short: `E${index + 1}`, source: "meetings", item: entry.item, full: entry.full, opened: false, preloaded: false, touched: entry.touched, cited_by_plan: cited.includes(`E${index + 1}`),
    }));
    const value: AgenticEvidenceBundleV1 = {
      schema_version: 1, kind: "echo-agentic-evidence-bundle-v1", trigger: "ask", goal: { kind: "question", question: "What was decided?" }, budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1,
      plan: [{ part: 1, question: "What was decided?", notes: "", needs: [{ need: "the decision", status: cited.length > 0 ? "found" : "open", evidence: cited }] }],
      items, unreadable_starting: [], rounds: [], coverage: { reads: [], inventories: [], notices: [] },
      stop: { reason: completed ? "finished" : "budget", completed },
      cost: { rounds: 1, model_calls: 1, repairs: 0, fallbacks: 0, input_tokens: null, output_tokens: null, total_tokens: null, model_ms: 0, desk_ms: 0, elapsed_ms: 0 },
      gathered_for: { scope: { kind: "global" }, checked_at: null }, server: { receipts: [], invocation_digests: [], generations: [] },
    };
    return Object.freeze(value);
  }

  it("falls back only to items research read in full when the writer fails", async () => {
    const read = record("read", "Approved: ship the enclosure in October.");
    const previewed = record("previewed", "Approved: the enclosure vendor changed.");
    const run = alone({
      bundle: bundle([{ item: read, full: true, touched: 1 }, { item: previewed, full: false, touched: 3 }, { item: listedItem("listed"), full: false, touched: 2 }], ["E1"]),
      replies: [{ wrong: true }, { still: "wrong" }], version: 4, answer_prompt: ANSWER_PROMPT, header,
    });
    const rendered = await run.render("What was decided?");
    // The writer reads the previewed passage too, but a failed writer's records stay limited to what research read.
    expect(rendered.result.writer_evidence).toEqual(["E1", "E2"]);
    expect(rendered.result.response).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", records: [{ text: read.text, citation_indexes: [0] }] }], citations: [{ citation: read.citation }] });
    expect(rendered.result.response.citations).toHaveLength(1);
    expect(rendered).toMatchObject({ cited: ["E1"], outcome: "partial", fallbacks: 1 });
    expect(run.trace).toEqual(["context:E1,E2", "revalidate", "generate", "revalidate", "generate"]);
  });

  it("makes no model call without readable evidence and still ends with an honest result", async () => {
    for (const completed of [true, false]) {
      const run = alone({ bundle: bundle([{ item: listedItem("listed"), full: false, touched: 1 }], [], completed), replies: [], version: 6, answer_prompt: ANSWER_PROMPT, header });
      const rendered = await run.render("What was decided?");
      expect(run.trace).toEqual(["context:"]);
      expect(rendered).toMatchObject({ cited: [], fallbacks: 0, outcome: completed ? "not_found" : "partial", result: { writer_evidence: [] } });
      expect(rendered.result.response.parts[0]).toMatchObject({ status: "not_found", gap: completed ? "I couldn't find this in the sources you can access." : "I couldn't complete the search. Please try again." });
    }
  });

  it("writes only when the time the runner leaves it covers a writer call", async () => {
    const entries = [{ item: record("read", "Approved: ship the enclosure in October."), full: true, touched: 1 }];
    const reply = { sentences: [{ text: "The enclosure ships in October.", evidence: ["E1"] }], not_found: [] };
    const enough = alone({ bundle: bundle(entries, ["E1"]), replies: [reply], version: 4, answer_prompt: ANSWER_PROMPT, header, remaining: 3_000 });
    expect(await enough.render("What was decided?")).toMatchObject({ outcome: "answered", cited: ["E1"] });
    const short = alone({ bundle: bundle(entries, ["E1"]), replies: [reply], version: 4, answer_prompt: ANSWER_PROMPT, header, remaining: 2_999 });
    const fallback = await short.render("What was decided?");
    expect(short.trace).toEqual(["context:E1"]);
    expect(fallback).toMatchObject({ outcome: "partial", cited: ["E1"], fallbacks: 0, result: { writer_evidence: [] } });
    expect(fallback.result.response.parts[0]).toMatchObject({ status: "records_only", gap: "I found these records, but could not write a verified summary." });
  });
});
