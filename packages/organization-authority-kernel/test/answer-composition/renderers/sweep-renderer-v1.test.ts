import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonSweepResultV1 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import { describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 } from "../../../src/answer-composition/agentic-research-v1.js";
import { SWEEP_PROMPT, SWEEP_RENDERER_V1, type SweepTriggerInputV1 } from "../../../src/answer-composition/renderers/sweep-renderer-v1.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../src/shared/core-runtime-observation-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { EMPTY_BUNDLE, scriptedGate } from "../fixtures/agentic-scenarios.js";

/**
 * The sweep renderer on its own (open items and Home v1, section 6): a
 * hand-built bundle, a gate over scripted replies, and no desk. One model
 * call judges each finding research could read; code reports the ones it
 * could not, and lays the result out.
 */
const RECORD = canonicalSha256({ record: "display-review" });
const DECISION = { kind: "approved_record" as const, atom_id: canonicalSha256({ atom: "decision" }), record_sha256: RECORD, policy_id: "organization-member-readable-person-v2" as const };
const ticketCitation = (key: string, text: string) => ({
  kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(text),
});
const pageCitation = (version: string, text: string) => ({
  kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: "1441793", section_id: "s1", version, permalink: "https://knowledge.example.test/wiki/pages/1441793", text_sha256: sha256Digest(text),
});

/** The items as the findings cited them then. */
const TICKET_46 = ticketCitation("THERM-46", "THERM-46: the firmware formats one decimal.");
const TICKET_47 = ticketCitation("THERM-47", "THERM-47: trace the display requirement.");
const PRD = pageCitation("3", "Display: the reading shows one decimal.");

function item(citation: EvidenceDeskItemV2["citation"], kind: EvidenceDeskItemV2["kind"], label: string, text: string | undefined, extra: Partial<EvidenceDeskItemV2> = {}): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${label.replace(/\W/gu, "")}`, citation, kind, label, ...(text === undefined ? {} : { text }), visibility: "only_me" as const,
    occurred_at: "2026-10-06", receipt_sha256: canonicalSha256({ receipt: label }), ...extra,
  });
}
/**
 * What research read now: E1 THERM-46 at a later text, E2 the approved
 * decision, E3 the PRD at a later version (E1-E3 the starting reads), E4 a
 * newer ticket research found, E5 one it only saw listed.
 */
const ITEMS: readonly EvidenceDeskItemV2[] = [
  item(ticketCitation("THERM-46", "THERM-46: the firmware formats two decimals (0.01 °C)."), "ticket", "THERM-46: Display precision", "THERM-46: the firmware formats two decimals (0.01 °C).",
    { attributes: { status: "Done", owner: "Tobias Lund" } }),
  item(DECISION, "decision", "Display review", "Approved: show two decimals (0.01 °C) on the display from DVT.", { visibility: "team" }),
  item(pageCitation("4", "Display: the reading shows one decimal."), "page", "PRD: Display", "Display: the reading shows one decimal."),
  item(ticketCitation("THERM-52", "THERM-52: the release notes say the display shows two decimals."), "ticket", "THERM-52: Release notes", "THERM-52: the release notes say the display shows two decimals."),
  item(ticketCitation("THERM-60", ""), "ticket", "THERM-60: Display tests", undefined, { attributes: { status: "To Do" } }),
];

/** THERM-46 against the decision, the PRD, and THERM-47, which research could not read. */
const FINDINGS: SweepTriggerInputV1["findings"] = [
  { finding: "THERM-46 formats one decimal; the decision asks for two.", expected: "two decimals from DVT", citations: [TICKET_46, DECISION] },
  { finding: "The PRD display section specifies one decimal.", expected: "the PRD specifies two decimals", citations: [PRD] },
  { finding: "THERM-47 does not trace the display requirement.", expected: "the trace names the display requirement", citations: [TICKET_47] },
];

function bundle(options: { readonly unreadable?: readonly unknown[]; readonly items?: readonly EvidenceDeskItemV2[] } = {}): AgenticEvidenceBundleV1 {
  const items: AgenticEvidenceBundleItemV1[] = (options.items ?? ITEMS).map((value, index) => Object.freeze({
    short: `E${index + 1}`, source: value.kind === "ticket" ? "tickets" : value.kind === "page" ? "pages" : "meetings", item: value,
    full: value.text !== undefined, opened: value.text !== undefined, preloaded: index < 3, touched: index + 1, cited_by_plan: index === 3,
  }));
  return Object.freeze({
    ...EMPTY_BUNDLE, trigger: "sweep", goal: { kind: "task" as const, task: "Recheck the earlier findings below." }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
    items, unreadable_starting: options.unreadable ?? [TICKET_47],
  });
}

/** The renderer alone: a bundle, a gate over scripted replies, and the sweep's findings. */
function alone(input: { readonly findings?: SweepTriggerInputV1["findings"]; readonly bundle?: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly remaining?: number; readonly prompt_budget?: number }) {
  const trace: string[] = [];
  const value = input.bundle ?? bundle();
  const { gate, inputs } = scriptedGate(input.replies, value.budget, trace);
  const render = () => SWEEP_RENDERER_V1.render({
    bundle: value, trigger_input: { findings: input.findings ?? FINDINGS }, gate, remaining: () => input.remaining ?? 30_000, signal: new AbortController().signal,
    prompt_budget: system => input.prompt_budget ?? agenticAskContextBudgetBytesV1(undefined, system, AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer),
    on_context: selected => { trace.push(`context:${selected.join(",")}`); },
  });
  return { render, trace, inputs, gate, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, unknown> };
}

/** One finding about one item. */
const finding = (citation: unknown) => ({ finding: "The firmware formats one decimal; the decision asks for two.", expected: "two decimals from DVT", citations: [citation] });
/** The renderer over `findings`, with `reply` (a list of verdicts, or any other value as is) as the model's answer to every call. */
async function renderSweep(input: { readonly findings: SweepTriggerInputV1["findings"]; readonly unreadable?: readonly unknown[]; readonly reply: unknown }) {
  const reply = Array.isArray(input.reply) ? { findings: input.reply } : input.reply;
  return (await alone({ findings: input.findings, bundle: bundle({ unreadable: input.unreadable ?? [] }), replies: [reply, reply] }).render()).result;
}

const REPLY = { findings: [
  { index: 0, verdict: "landed", line: "THERM-46 now formats two decimals.", cites: ["E1"] },
  { index: 1, verdict: "still_open", line: "The PRD display section still specifies one decimal.", cites: ["E3", "E2"] },
] };
const UNREADABLE = { finding_index: 2, verdict: "unreadable", line: "ECHO could not read this item.", citation_indexes: [] };
const citation = (short: string) => {
  const value = ITEMS[Number(short.slice(1)) - 1]!;
  return { citation: value.citation, kind: value.kind, label: value.label, visibility: value.visibility };
};
/** The reply with its first verdict changed. */
const firstVerdict = (entry: Record<string, unknown>) => ({ findings: [{ ...REPLY.findings[0]!, ...entry }, REPLY.findings[1]!] });

describe("sweep renderer", () => {
  it("makes one model call, role answer in the research_render span, over the findings research could read and the items it gathered", async () => {
    const run = alone({ replies: [REPLY] });
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1("ask_request", () => run.render(), { observer: event => { events.push(event); } });
    // Each finding's own items as they read now first, then what research cited, read, and only saw listed.
    expect(run.trace).toEqual(["context:E1,E2,E3,E4,E5", "revalidate", "generate"]);
    expect(events.filter(event => !event.root && event.event === "started").map(event => event.stage)).toEqual(["research_revalidation", "research_render"]);
    expect(run.gate.stats().generations.map(entry => entry.role)).toEqual(["answer"]);
    expect(run.inputs[0]!.system_prompt).toBe(SWEEP_PROMPT);
    const user = run.prompt(0);
    // The finding research could not read is never put to the model; each other finding names the items it cited, as they read now.
    expect(user.findings).toEqual([
      { index: 0, finding: FINDINGS[0]!.finding, expected: "two decimals from DVT", cited: ["E1", "E2"] },
      { index: 1, finding: FINDINGS[1]!.finding, expected: "the PRD specifies two decimals", cited: ["E3"] },
    ]);
    expect((user.items as { id: string }[]).map(value => value.id)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    expect((user.items as Record<string, unknown>[])[0]).toEqual({
      id: "E1", source: "tickets", kind: "ticket", title: "THERM-46: Display precision", provenance: { kind: "ticket" }, date: "2026-10-06", date_kind: "unspecified",
      attributes: { status: "Done", owner: "Tobias Lund" }, text: "THERM-46: the firmware formats two decimals (0.01 °C).",
    });
    expect((user.items as Record<string, unknown>[]).find(value => value.id === "E5")).not.toHaveProperty("text");
    const serialized = run.inputs[0]!.user_prompt;
    for (const value of ITEMS) {
      expect(serialized).not.toContain(value.id);
      expect(serialized).not.toContain(value.receipt_sha256);
    }
    expect(serialized).not.toContain(RECORD);
    expect(serialized).not.toContain("THERM-47");
  });

  it("lays the result out in code: one finding per input finding, in input order, citing what each verdict cites", async () => {
    const rendered = await alone({ replies: [REPLY] }).render();
    expect(rendered.result).toEqual({
      findings: [
        { finding_index: 0, verdict: "landed", line: "THERM-46 now formats two decimals.", citation_indexes: [0] },
        { finding_index: 1, verdict: "still_open", line: "The PRD display section still specifies one decimal.", citation_indexes: [1, 2] },
        UNREADABLE,
      ],
      status: "assessed", citations: ["E1", "E3", "E2"].map(citation),
    });
    expect(validatePersonSweepResultV1(rendered.result, FINDINGS.length)).toEqual(rendered.result);
    // An unreadable finding makes the result partial.
    expect(rendered).toMatchObject({ cited: ["E1", "E3", "E2"], outcome: "partial", fallbacks: 0 });
    expect(rendered.answer_sha256).toBe(canonicalSha256({ findings: rendered.result.findings }));
  });

  it("is answered when it judged every finding", async () => {
    const rendered = await alone({ findings: FINDINGS.slice(0, 2), bundle: bundle({ unreadable: [] }), replies: [REPLY] }).render();
    expect(rendered.result.findings.map(value => value.verdict)).toEqual(["landed", "still_open"]);
    expect(rendered).toMatchObject({ outcome: "answered", result: { status: "assessed" } });
  });

  it("reports an unreadable starting item without asking the model about it", async () => {
    const result = await renderSweep({ findings: [finding(TICKET_46), finding(TICKET_47)], unreadable: [TICKET_47], reply: [{ index: 0, verdict: "landed", line: "THERM-46 now says two decimals.", cites: ["E1"] }] });
    expect(result.findings.map(value => value.verdict)).toEqual(["landed", "unreadable"]);
    expect(result.findings[1]!.line).toBe("ECHO could not read this item.");
  });

  it("makes no model call when it could read no finding: every one unreadable, assessed and partial", async () => {
    const run = alone({ findings: [finding(TICKET_47), FINDINGS[2]!], replies: [] });
    const rendered = await run.render();
    expect(run.trace).toEqual(["context:"]);
    expect(rendered.result).toEqual({ findings: [{ ...UNREADABLE, finding_index: 0 }, { ...UNREADABLE, finding_index: 1 }], status: "assessed", citations: [] });
    expect(rendered).toMatchObject({ cited: [], outcome: "partial", fallbacks: 0 });
  });

  it("leaves verdicts empty when the model gives no usable reply", async () => {
    const result = await renderSweep({ findings: [finding(TICKET_46)], reply: "garbage" });
    expect(result).toMatchObject({ status: "not_assessed", findings: [{ verdict: null }] });
  });

  it("falls back without a model: no verdict for what it could read, the unreadable still reported, one fallback", async () => {
    const run = alone({ replies: [{ wrong: true }, { still: "wrong" }] });
    const rendered = await run.render();
    expect(run.trace.filter(event => event === "generate")).toHaveLength(2);
    const notAssessed = (finding_index: number) => ({ finding_index, verdict: null, line: "Not assessed.", citation_indexes: [] });
    expect(rendered.result).toEqual({ findings: [notAssessed(0), notAssessed(1), UNREADABLE], status: "not_assessed", citations: [] });
    expect(rendered).toMatchObject({ cited: [], outcome: "partial", fallbacks: 1 });
    expect(validatePersonSweepResultV1(rendered.result, FINDINGS.length)).toEqual(rendered.result);
    // A provider that refuses is not asked again; the result is the same.
    const refused = alone({ replies: [Object.assign(new Error("provider detail must stay private"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } })] });
    const fallback = await refused.render();
    expect(refused.inputs).toHaveLength(1);
    expect(fallback).toMatchObject({ fallbacks: 1, result: rendered.result });
  });

  it("makes no model call when the time left cannot cover one, and still reports each finding", async () => {
    const run = alone({ replies: [REPLY], remaining: 2_999 });
    const rendered = await run.render();
    expect(run.trace).toEqual(["context:E1,E2,E3,E4,E5"]);
    expect(rendered).toMatchObject({ outcome: "partial", fallbacks: 0, result: { status: "not_assessed", findings: [{ verdict: null }, { verdict: null }, { verdict: "unreadable" }] } });
  });

  it("sends an instruction back for one repair", async () => {
    const edit = firstVerdict({ line: "Update THERM-46 to two decimals" });
    const run = alone({ replies: [edit, REPLY] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(2);
    expect(run.inputs[1]!.system_prompt).toContain("never what to change");
    expect(rendered.result.status).toBe("assessed");
    expect(JSON.stringify(rendered.result)).not.toContain("Update THERM-46");
    const twice = await alone({ replies: [edit, edit] }).render();
    expect(twice).toMatchObject({ fallbacks: 1, result: { status: "not_assessed" } });
    expect(JSON.stringify(twice.result)).not.toContain("Update THERM-46");
  });

  // A reply is usable only whole: every finding judged once, from items the model was shown, in the card's screens.
  it.each([
    ["a suggested edit naming the tool", firstVerdict({ line: "The PRD needs to be updated in Confluence to two decimals." }), "never what to change"],
    ["a line that says who owns an item", firstVerdict({ line: "THERM-46 is now assigned to Tobias Lund." }), "never say who owns"],
    ["a reply that misses a finding", { findings: [REPLY.findings[0]] }, "one entry for each finding"],
    ["a reply that repeats a finding", { findings: [...REPLY.findings, REPLY.findings[0]] }, "one entry for each finding"],
    ["a verdict on the finding it was not given", { findings: [...REPLY.findings, { index: 2, verdict: "still_open", line: "THERM-47 is unchanged.", cites: [] }] }, "findings given"],
    ["an index no finding has", firstVerdict({ index: 7 }), "findings given"],
    ["a verdict it may not give", firstVerdict({ verdict: "unreadable" }), "verdict"],
    ["an empty line", firstVerdict({ line: " " }), "line"],
    ["an item it was not shown", firstVerdict({ cites: ["E9"] }), "cite only"],
    ["cites that are not a list", firstVerdict({ cites: "E1" }), "cites"],
    ["a reply that is not an object", ["landed"], "JSON object"],
  ] as const)("sends back %s once, and never releases it", async (_label, reply, reason) => {
    const run = alone({ replies: [reply, REPLY] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(2);
    expect(run.inputs[1]!.system_prompt).toContain(reason);
    expect(rendered.result).toEqual((await alone({ replies: [REPLY] }).render()).result);
    const twice = await alone({ replies: [reply, reply] }).render();
    expect(twice).toMatchObject({ fallbacks: 1, result: { status: "not_assessed", citations: [] } });
  });

  it("shows the model only what fits its prompt budget, each finding's own items first, and cites nothing it did not show", async () => {
    const view = (entry: AgenticEvidenceBundleItemV1) => ({ ...describeAgenticEvidenceItemV1(entry), ...(entry.item.text === undefined ? {} : { text: entry.item.text }) });
    const entries = bundle().items;
    const cost = (index: number) => Buffer.byteLength(JSON.stringify(view(entries[index]!)), "utf8") + 1;
    const findings = [
      { index: 0, finding: FINDINGS[0]!.finding, expected: FINDINGS[0]!.expected, cited: ["E1", "E2"] },
      { index: 1, finding: FINDINGS[1]!.finding, expected: FINDINGS[1]!.expected, cited: ["E3"] },
    ];
    // Room for E1 and E2 beside the findings, and not for the PRD.
    const tight = Buffer.byteLength(JSON.stringify({ findings, items: [] }), "utf8") + cost(0) + cost(1);
    const reply = { findings: [REPLY.findings[0], { index: 1, verdict: "still_open", line: "Nothing shows the PRD changed.", cites: [] }] };
    const run = alone({ replies: [reply], prompt_budget: tight });
    const rendered = await run.render();
    expect(run.trace[0]).toBe("context:E1,E2");
    // A finding names only the items the model can see.
    expect((run.prompt(0).findings as { cited: string[] }[]).map(value => value.cited)).toEqual([["E1", "E2"], []]);
    expect(Buffer.byteLength(run.inputs[0]!.user_prompt, "utf8")).toBeLessThanOrEqual(tight);
    expect(rendered.cited).toEqual(["E1"]);
    // The PRD as it reads now was never shown, so citing it is sent back.
    const unseen = alone({ replies: [REPLY, reply], prompt_budget: tight });
    await unseen.render();
    expect(unseen.inputs).toHaveLength(2);
  });
});
