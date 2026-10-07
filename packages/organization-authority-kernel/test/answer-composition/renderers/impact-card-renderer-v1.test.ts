import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonImpactCardV1 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import type { AgenticEvidenceBundleItemV1, AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1, createAgenticModelGateV1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { IMPACT_CARD_PROMPT, IMPACT_CARD_RENDERER_V1 } from "../../../src/answer-composition/renderers/impact-card-renderer-v1.js";
import type { StructuredGenerationInput } from "../../../src/answer-composition/structured-generation-v1.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../src/shared/core-runtime-observation-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";

/**
 * The impact card renderer on its own (research trigger contract v1, section
 * 5): a hand-built bundle, a gate over scripted replies, and no desk. One
 * model call writes the summaries and relations; code builds the rest.
 */
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
const checked = { checked_at: "2026-10-06T00:00:00.000Z" };
const RECORD = canonicalSha256({ record: "gate-review" });
const recordCitation = { kind: "approved_record" as const, atom_id: canonicalSha256({ atom: "decision" }), record_sha256: RECORD, policy_id: "organization-member-readable-person-v2" as const };

function recordItem(id: string, text: string, options: Partial<EvidenceDeskItemV2> = {}, record = RECORD): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${id}`, citation: { ...recordCitation, atom_id: canonicalSha256({ atom: id }), record_sha256: record },
    kind: "decision" as const, text, label: `Gate review ${id}`, visibility: "team" as const, occurred_at: "2026-10-05", receipt_sha256: canonicalSha256({ receipt: id }), ...options,
  });
}
function ticket(key: string, text: string | undefined, attributes: EvidenceDeskItemV2["attributes"]): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `ticket_${key}`, citation: { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(text ?? "") },
    kind: "ticket" as const, label: `${key}: Display precision`, ...(text === undefined ? {} : { text }), visibility: "only_me" as const, ...(attributes === undefined ? {} : { attributes }),
    occurred_at: "2026-09-30", date_kind: "created" as const, receipt_sha256: canonicalSha256({ ticket: key }),
  });
}
function page(id: string, label: string, text: string | undefined): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `page_${id}`, citation: { kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: id, section_id: "s1", version: "3", permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: sha256Digest(text ?? "") },
    kind: "page" as const, label, ...(text === undefined ? {} : { text }), visibility: "only_me" as const, occurred_at: "2026-10-04", date_kind: "version_created" as const,
    receipt_sha256: canonicalSha256({ page: id }),
  });
}

/** E1-E2 the approved record, E3-E8 what research gathered around it. */
const ITEMS: readonly EvidenceDeskItemV2[] = [
  recordItem("decision", "Approved: show two decimals (0.01 °C) on the display from DVT."),
  recordItem("action", "Mara will update the PRD display section by Oct 10.", { kind: "action", attributes: { owner: "Mara Quinn", due_at: "2026-10-10" } }),
  ticket("THERM-46", "THERM-46: the firmware formats one decimal.", { status: "In Progress", owner: "Tobias Lund", due_at: "2026-10-15" }),
  page("1441793", "PRD: Display", "Display: the reading shows one decimal."),
  ticket("THERM-47", undefined, { status: "To Do", owner: "Tobias Lund" }),
  recordItem("other-action", "Send the display plan to Zhen.", { kind: "action", label: "Planning sync action" }, canonicalSha256({ record: "planning-sync" })),
  page("99", "Gate review 99", undefined),
  page("2001", "Test plan", "TC-D-06 expects one decimal."),
];

function bundle(options: { readonly cited?: readonly string[]; readonly completed?: boolean; readonly items?: readonly EvidenceDeskItemV2[] } = {}): AgenticEvidenceBundleV1 {
  const cited = options.cited ?? ["E1", "E3", "E4", "E6"];
  const items: AgenticEvidenceBundleItemV1[] = (options.items ?? ITEMS).map((item, index) => Object.freeze({
    short: `E${index + 1}`, source: item.kind === "ticket" ? "tickets" : item.kind === "page" ? "pages" : "meetings", item,
    full: item.text !== undefined, opened: item.text !== undefined, preloaded: index < 2, touched: index + 1, cited_by_plan: cited.includes(`E${index + 1}`),
  }));
  const value: AgenticEvidenceBundleV1 = {
    schema_version: 1, kind: "echo-agentic-evidence-bundle-v1", trigger: "approved_record",
    goal: { kind: "task", task: "A PM just approved record E1. Find every ticket, PRD section and document in this project that it confirms, conflicts with or changes. For each, record what it says now, who owns it, and any date it affects." },
    budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
    plan: [{ part: 1, question: "What does E1 affect?", notes: "", needs: [
      { need: "THERM-46 state", status: "found", evidence: ["E3"] }, { need: "PRD display section", status: "found", evidence: ["E4"] },
      { need: "owner of the display spec", status: "not_found", evidence: [] }, { need: "the display plan action", status: "found", evidence: ["E6", "E1"] },
    ] }],
    items, unreadable_starting: [],
    rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [
      { tool: "open", args: { id: "E7" }, result: { items: [], opened: [], error: "that item is not available" } },
      { tool: "open", args: { id: "E77" }, result: { items: [], opened: [], error: "unknown id; pass an id such as E4 from your scratchpad" } },
    ] }],
    coverage: {
      reads: [{ tool: "list", source: "tickets", returned_items: 25, truncated: false, notice: false, unavailable: false }, { tool: "search", source: "documents", returned_items: 0, truncated: false, notice: false, unavailable: true }],
      inventories: [{ source: "tickets", shown_count: 25, more: true, available: true, truncated: false }, { source: "meetings", shown_count: 3, more: false, available: true, truncated: false }],
      notices: ["Knowledge search returns at most 50 pages."],
    },
    stop: { reason: options.completed === false ? "budget" : "finished", completed: options.completed !== false },
    cost: { rounds: 4, model_calls: 4, repairs: 0, fallbacks: 0, input_tokens: null, output_tokens: null, total_tokens: null, model_ms: 0, desk_ms: 0, elapsed_ms: 0 },
    gathered_for: { scope: { kind: "global" }, checked_at: null }, server: { receipts: [], invocation_digests: [], generations: [] },
  };
  return Object.freeze(value);
}

/** The renderer alone: a bundle, a gate over scripted replies, and the approved-record event. */
function alone(input: { readonly bundle?: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly remaining?: number; readonly prompt_budget?: number }) {
  const trace: string[] = [];
  const inputs: StructuredGenerationInput[] = [];
  const value = input.bundle ?? bundle();
  const gate = createAgenticModelGateV1({
    generation,
    model: {
      generate: async (model: StructuredGenerationInput) => {
        trace.push("generate"); inputs.push(model);
        const reply = input.replies[inputs.length - 1];
        if (reply === undefined) throw new Error(`unscripted call ${inputs.length}`);
        return reply;
      },
    },
    desk_revalidate: async () => { trace.push("revalidate"); return checked; }, on_checked: () => undefined,
    budget: value.budget, now: () => 0, deadline: value.budget.deadline_ms,
    signal: new AbortController().signal, is_deadline_expired: () => false, content_sensitive: () => false,
  });
  const render = () => IMPACT_CARD_RENDERER_V1.render({
    bundle: value, trigger_input: { record: recordCitation }, gate, remaining: () => input.remaining ?? 30_000, signal: new AbortController().signal,
    prompt_budget: system => input.prompt_budget ?? agenticAskContextBudgetBytesV1(undefined, system, AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer),
    on_context: selected => { trace.push(`context:${selected.join(",")}`); },
  });
  return { render, trace, inputs, gate, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, unknown> };
}

const affected = (id: string, says_now: string, relation: string, date_at_risk = "", milestone = "") => ({ id, says_now, relation, date_at_risk, milestone });
const REPLY = {
  decided: [
    { id: "E1", text: "Show two decimals on the display from DVT." }, { id: "E2", text: "Mara updates the PRD display section by Oct 10." },
    { id: "E3", text: "Not a record item." }, { id: "E99", text: "An invented item." },
  ],
  affected: [
    affected("E4", "The PRD display section specifies one decimal.", "needs_updating"),
    affected("E3", "THERM-46 formats one decimal; Zhen Ye said he owns it.", "conflicts", "2026-10-15", "DVT gate"),
    affected("E5", "THERM-47 is still to do.", "confirms"),
    affected("E6", "The planning sync asks for the display plan to go to Zhen.", "confirms"),
    affected("E1", "The record itself.", "confirms"), affected("E42", "An invented ticket.", "conflicts"), affected("E3", "A repeat.", "confirms"),
  ],
};
const NOTES = [
  "owner of the display spec",
  "The tickets list was cut short at 25 items.",
  "Gate review 99 could not be read.",
  "The documents source could not be read.",
  "Knowledge search returns at most 50 pages.",
];
const citation = (short: string) => {
  const item = ITEMS[Number(short.slice(1)) - 1]!;
  return { citation: item.citation, kind: item.kind, label: item.label, visibility: item.visibility };
};

describe("impact card renderer", () => {
  it("makes one model call, role answer in the research_render span, over the record and the items research gathered", async () => {
    const run = alone({ replies: [REPLY] });
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1("ask_request", () => run.render(), { observer: event => { events.push(event); } });
    expect(run.trace).toEqual(["context:E1,E2,E3,E4,E6,E8,E7,E5", "revalidate", "generate"]);
    expect(events.filter(event => !event.root && event.event === "started").map(event => event.stage)).toEqual(["research_render"]);
    expect(run.gate.stats().generations.map(entry => entry.role)).toEqual(["answer"]);
    expect(run.inputs[0]!.system_prompt).toBe(IMPACT_CARD_PROMPT);
    const user = run.prompt(0);
    expect(user.task).toBe(bundle().goal.kind === "task" ? (bundle().goal as { task: string }).task : "");
    expect((user.record as { id: string }[]).map(value => value.id)).toEqual(["E1", "E2"]);
    // Cited items first, then what research read by recency, then items it only saw listed: their details prove themselves.
    expect((user.items as { id: string }[]).map(value => value.id)).toEqual(["E3", "E4", "E6", "E8", "E7", "E5"]);
    expect((user.items as Record<string, unknown>[])[0]).toEqual({
      id: "E3", source: "tickets", kind: "ticket", title: "THERM-46: Display precision", provenance: { kind: "ticket" }, date: "2026-09-30", date_kind: "created",
      attributes: { status: "In Progress", owner: "Tobias Lund", due_at: "2026-10-15" }, text: "THERM-46: the firmware formats one decimal.",
    });
    expect((user.items as Record<string, unknown>[]).find(value => value.id === "E5")).not.toHaveProperty("text");
    // A meeting action with no recorded owner says so, so the model never fills one in.
    expect((user.items as Record<string, unknown>[]).find(value => value.id === "E6")).toMatchObject({ attributes: { owner: "none recorded" } });
    const serialized = run.inputs[0]!.user_prompt;
    for (const item of ITEMS) {
      expect(serialized).not.toContain(item.id);
      expect(serialized).not.toContain(item.receipt_sha256);
    }
    expect(serialized).not.toContain(RECORD);
  });

  it("keeps only bundle items, takes owners and people from item details alone, and lays the card out in code", async () => {
    const rendered = await alone({ replies: [REPLY] }).render();
    const card = rendered.result;
    expect(card).toEqual({
      status: "assessed",
      decided: [{ text: "Show two decimals on the display from DVT.", citation_index: 0 }, { text: "Mara updates the PRD display section by Oct 10.", citation_index: 1 }],
      affected: [
        { citation_index: 2, says_now: "THERM-46 formats one decimal; Zhen Ye said he owns it.", relation: "conflicts", owner: "Tobias Lund", date_at_risk: { date: "2026-10-15", milestone: "DVT gate" } },
        { citation_index: 3, says_now: "The PRD display section specifies one decimal.", relation: "needs_updating" },
        { citation_index: 4, says_now: "THERM-47 is still to do.", relation: "confirms", owner: "Tobias Lund" },
        { citation_index: 5, says_now: "The planning sync asks for the display plan to go to Zhen.", relation: "confirms" },
      ],
      unconfirmed: NOTES,
      // Each owner once; never a name the model wrote, never "none recorded", never the record's own action owner.
      people: [{ name: "Tobias Lund", items: [2, 4] }],
      citations: ["E1", "E2", "E3", "E4", "E5", "E6"].map(citation),
    });
    expect(validatePersonImpactCardV1(card)).toEqual(card);
    expect(rendered).toMatchObject({ cited: ["E1", "E2", "E3", "E4", "E5", "E6"], outcome: "partial", fallbacks: 0 });
    expect(rendered.digests).toEqual({ answer_sha256: canonicalSha256({ decided: card.decided, affected: card.affected }), response_sha256: canonicalSha256(card) });
  });

  it("is answered only when research finished and nothing is left unconfirmed", async () => {
    const quiet: AgenticEvidenceBundleV1 = { ...bundle(), plan: [], rounds: [], coverage: { reads: [], inventories: [], notices: [] } };
    const rendered = await alone({ bundle: quiet, replies: [REPLY] }).render();
    expect(rendered.result.unconfirmed).toEqual([]);
    expect(rendered.outcome).toBe("answered");
    const stopped = await alone({ bundle: { ...quiet, stop: { reason: "budget", completed: false } }, replies: [REPLY] }).render();
    expect(stopped.result.unconfirmed).toEqual(["Research stopped before it finished, so other items may be affected too."]);
    expect(stopped.outcome).toBe("partial");
  });

  it("falls back without a model: the cited items with their details and owners, not yet assessed, plus the notes", async () => {
    const run = alone({ replies: [{ wrong: true }, { still: "wrong" }] });
    const rendered = await run.render();
    expect(run.trace.filter(event => event === "generate")).toHaveLength(2);
    expect(rendered.result).toEqual({
      status: "not_assessed", decided: [],
      // The record's own items are what was decided, never possibly affected.
      affected: [
        { citation_index: 0, says_now: "THERM-46: Display precision; status In Progress; due 2026-10-15", owner: "Tobias Lund" },
        { citation_index: 1, says_now: "PRD: Display" },
        { citation_index: 2, says_now: "Planning sync action" },
      ],
      unconfirmed: NOTES, people: [{ name: "Tobias Lund", items: [0] }],
      citations: ["E3", "E4", "E6"].map(citation),
    });
    expect(rendered).toMatchObject({ cited: ["E3", "E4", "E6"], outcome: "partial", fallbacks: 1 });
    expect(validatePersonImpactCardV1(rendered.result)).toEqual(rendered.result);
  });

  it("makes no model call when the time left cannot cover one, and still ends with an honest card", async () => {
    const run = alone({ replies: [REPLY], remaining: 2_999 });
    const rendered = await run.render();
    expect(run.trace).toEqual(["context:E1,E2,E3,E4,E6,E8,E7,E5"]);
    expect(rendered).toMatchObject({ outcome: "partial", fallbacks: 0, result: { status: "not_assessed", unconfirmed: NOTES } });
    const nothing = await alone({ bundle: bundle({ cited: [] }), replies: [], remaining: 0 }).render();
    expect(nothing).toMatchObject({ cited: [], outcome: "partial", result: { status: "not_assessed", affected: [], people: [], citations: [] } });
  });

  it("asks once more when a line tells someone to edit a tool, and never releases it", async () => {
    const edit = { ...REPLY, affected: [affected("E3", "Change the display precision in Jira to two decimals.", "needs_updating")] };
    const run = alone({ replies: [edit, REPLY] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(2);
    expect(run.inputs[1]!.system_prompt).toContain("says what the item says now, never what to change");
    expect(rendered.result.status).toBe("assessed");
    expect(JSON.stringify(rendered.result)).not.toContain("in Jira");
    const twice = await alone({ replies: [edit, edit] }).render();
    expect(twice).toMatchObject({ fallbacks: 1, result: { status: "not_assessed" } });
  });

  it("shows the model only what fits its prompt budget, and cites nothing it did not show", async () => {
    const tight = Buffer.byteLength(JSON.stringify({ task: (bundle().goal as { task: string }).task, record: [], items: [] }), "utf8") + 900;
    const run = alone({ replies: [REPLY], prompt_budget: tight });
    const rendered = await run.render();
    const shown = [...(run.prompt(0).record as { id: string }[]), ...(run.prompt(0).items as { id: string }[])].map(value => value.id);
    expect(shown.slice(0, 2)).toEqual(["E1", "E2"]);
    expect(shown.length).toBeLessThan(ITEMS.length);
    expect(Buffer.byteLength(run.inputs[0]!.user_prompt, "utf8")).toBeLessThanOrEqual(tight);
    expect(rendered.cited.every(short => shown.includes(short))).toBe(true);
  });
});
