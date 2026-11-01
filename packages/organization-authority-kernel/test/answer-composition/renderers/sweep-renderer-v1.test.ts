import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonSweepResultV1 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import { describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1, AgenticAskDeadlineErrorV1, createAgenticModelGateV1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 } from "../../../src/answer-composition/agentic-research-v1.js";
import { SWEEP_APPROVED_DECISION_V1, SWEEP_PROMPT, SWEEP_RENDERER_V1, type SweepTriggerInputV1 } from "../../../src/answer-composition/renderers/sweep-renderer-v1.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../src/shared/core-runtime-observation-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { EMPTY_BUNDLE, checked, generation, scriptedGate } from "../fixtures/agentic-scenarios.js";

/**
 * The sweep renderer on its own (open items and Home v1, section 6): a
 * hand-built bundle, a gate over scripted replies, and no desk. One model
 * call judges each finding research could read and could fit with its own
 * item; code reports the rest, and lays the result out.
 */
const RECORD = canonicalSha256({ record: "display-review" });
const DECISION = { kind: "approved_record" as const, atom_id: canonicalSha256({ atom: "decision" }), record_sha256: RECORD, policy_id: "project-members-readable-person-v1" as const };
const ticketCitation = (key: string, text: string) => ({
  kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(text),
});
const pageCitation = (section: string, version: string, text: string) => ({
  kind: "page" as const, tool_id: "knowledge", external_scope_id: "site-one", page_id: "1441793", section_id: section, version,
  permalink: "https://knowledge.example.test/wiki/pages/1441793", text_sha256: sha256Digest(text),
});

const PRD_DISPLAY = "Display: the reading shows one decimal.";
const PRD_SCOPE = "Scope: the display module ships with DVT.";
/** The items as the findings cited them then: THERM-46 before it changed, the PRD's display section as it still reads, and THERM-47. */
const TICKET_46 = ticketCitation("THERM-46", "THERM-46: the firmware formats one decimal.");
const TICKET_47 = ticketCitation("THERM-47", "THERM-47: trace the display requirement.");
const PRD_DISPLAY_SECTION = pageCitation("s1", "4", PRD_DISPLAY);

function item(citation: EvidenceDeskItemV2["citation"], kind: EvidenceDeskItemV2["kind"], label: string, text: string | undefined, extra: Partial<EvidenceDeskItemV2> = {}): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${label.replace(/\W/gu, "")}`, citation, kind, label, ...(text === undefined ? {} : { text }), visibility: "only_me" as const,
    occurred_at: "2026-10-06", receipt_sha256: canonicalSha256({ receipt: label }), ...extra,
  });
}
/**
 * What research read now: E1 THERM-46 at a later text, E2 the approved
 * decision, E3 the PRD's display section as cited, E4 the PRD's scope section
 * read with it (E1-E4 the starting reads), E5 a newer ticket research cited,
 * E6 one it only saw listed.
 */
const ITEMS: readonly EvidenceDeskItemV2[] = [
  item(ticketCitation("THERM-46", "THERM-46: the firmware formats two decimals (0.01 °C)."), "ticket", "THERM-46: Display precision", "THERM-46: the firmware formats two decimals (0.01 °C).",
    { attributes: { status: "Done", owner: "Tobias Lund" } }),
  item(DECISION, "decision", "Display review", "Approved: show two decimals (0.01 °C) on the display from DVT.", { visibility: "team" }),
  item(PRD_DISPLAY_SECTION, "page", "PRD: Display", PRD_DISPLAY),
  item(pageCitation("s2", "4", PRD_SCOPE), "page", "PRD: Scope", PRD_SCOPE),
  item(ticketCitation("THERM-52", "THERM-52: the release notes say the display shows two decimals."), "ticket", "THERM-52: Release notes", "THERM-52: the release notes say the display shows two decimals."),
  item(ticketCitation("THERM-60", ""), "ticket", "THERM-60: Display tests", undefined, { attributes: { status: "To Do" } }),
];

/** THERM-46 against its decision, the PRD's display section, and THERM-47, which research could not read. */
const FINDINGS: SweepTriggerInputV1["findings"] = [
  { finding: "THERM-46 formats one decimal; the decision asks for two.", expected: "two decimals from DVT", citations: [TICKET_46, DECISION] },
  { finding: "The PRD display section specifies one decimal.", expected: "the PRD specifies two decimals", citations: [PRD_DISPLAY_SECTION] },
  { finding: "THERM-47 does not trace the display requirement.", expected: "the trace names the display requirement", citations: [TICKET_47] },
];

function bundle(options: { readonly unreadable?: readonly unknown[]; readonly items?: readonly EvidenceDeskItemV2[] } = {}): AgenticEvidenceBundleV1 {
  const items: AgenticEvidenceBundleItemV1[] = (options.items ?? ITEMS).map((value, index) => Object.freeze({
    short: `E${index + 1}`, source: value.kind === "ticket" ? "tickets" : value.kind === "page" ? "pages" : "meetings", item: value,
    full: value.text !== undefined, opened: value.text !== undefined, preloaded: index < 4, touched: index + 1, cited_by_plan: index === 4,
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

/** A render in its output span, and the corrections of model output that span counted (an empty object for none). */
async function observed<T>(render: () => Promise<T>): Promise<{ readonly rendered: T; readonly corrections: Readonly<Record<string, number>> }> {
  const events: CoreRuntimeObservationV1[] = [];
  const rendered = await observeCoreRuntimeV1("research_output", render, { observer: event => { events.push(event); } });
  return { rendered, corrections: events.find(event => event.phase === "research_output" && event.event !== "started")!.model_corrections ?? {} };
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
const notAssessed = (finding_index: number) => ({ finding_index, verdict: null, line: "Not assessed.", citation_indexes: [] });
const citation = (short: string) => {
  const value = ITEMS[Number(short.slice(1)) - 1]!;
  return { citation: value.citation, kind: value.kind, label: value.label, visibility: value.visibility };
};
/** The reply with its first verdict changed. */
const firstVerdict = (entry: Record<string, unknown>) => ({ findings: [{ ...REPLY.findings[0]!, ...entry }, REPLY.findings[1]!] });
/** How the model sees an item, and what it costs in the prompt with its comma. */
const view = (entry: AgenticEvidenceBundleItemV1) => ({ ...describeAgenticEvidenceItemV1(entry), ...(entry.item.text === undefined ? {} : { text: entry.item.text }) });
const cost = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
const EMPTY_PROMPT = Buffer.byteLength(JSON.stringify({ findings: [], items: [] }), "utf8");

describe("sweep renderer", () => {
  it("makes one model call, role answer in the research_render span, over the findings research could read, each with the item it is about", async () => {
    const run = alone({ replies: [REPLY] });
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1("ask_request", () => run.render(), { observer: event => { events.push(event); } });
    // Each finding's own item first, then the other sections of its page and the first finding's decision; nothing else research came across.
    expect(run.trace).toEqual(["context:E1,E3,E4,E2", "revalidate", "generate"]);
    expect(events.filter(event => !event.root && event.event === "started").map(event => event.stage)).toEqual(["research_revalidation", "research_render"]);
    expect(run.gate.stats().generations.map(entry => entry.role)).toEqual(["answer"]);
    expect(run.inputs[0]!.system_prompt).toBe(SWEEP_PROMPT);
    const user = run.prompt(0);
    // The finding research could not read is never put to the model; each other finding names the item it is about, as it reads now.
    expect(user.findings).toEqual([
      { index: 0, finding: FINDINGS[0]!.finding, expected: "two decimals from DVT", about: ["E1"] },
      { index: 1, finding: FINDINGS[1]!.finding, expected: "the PRD specifies two decimals", about: ["E3"] },
    ]);
    expect((user.items as { id: string }[]).map(value => value.id)).toEqual(["E1", "E3", "E4", "E2"]);
    expect((user.items as Record<string, unknown>[])[0]).toEqual({
      id: "E1", source: "tickets", kind: "ticket", title: "THERM-46: Display precision", provenance: { kind: "ticket" }, date: "2026-10-06", date_kind: "unspecified",
      attributes: { status: "Done", owner: "Tobias Lund" }, text: "THERM-46: the firmware formats two decimals (0.01 °C).",
    });
    const serialized = run.inputs[0]!.user_prompt;
    for (const value of ITEMS) {
      expect(serialized).not.toContain(value.id);
      expect(serialized).not.toContain(value.receipt_sha256);
    }
    expect(serialized).not.toContain(RECORD);
    expect(serialized).not.toContain("THERM-47");
  });

  it("sends a schema in the impact card's keywords: no numeric bounds", async () => {
    // The index is still checked by the parser (see the replies sent back below).
    const run = alone({ replies: [REPLY] });
    await run.render();
    const schema = JSON.stringify(run.inputs[0]!.schema);
    expect(schema).not.toMatch(/"(?:minimum|maximum|exclusiveMinimum|exclusiveMaximum|minItems|minLength|pattern)"/u);
    expect((run.inputs[0]!.schema as { properties: { findings: { items: { properties: { index: unknown } } } } }).properties.findings.items.properties.index).toEqual({ type: "integer" });
  });

  // A finding's own item is the item it cited, by identity: edits change a citation's text digest, version and link, and edited items are what a sweep checks (R42).
  it("takes a ticket edited since it was cited as its finding's own item, and judges it", async () => {
    // THERM-46 was cited at an earlier text; research re-read it at a new one.
    expect(canonicalSha256(TICKET_46)).not.toBe(canonicalSha256(ITEMS[0]!.citation));
    const run = alone({ findings: [FINDINGS[0]!], bundle: bundle({ unreadable: [] }), replies: [{ findings: [REPLY.findings[0]] }] });
    const rendered = await run.render();
    expect((run.prompt(0).findings as { about: string[] }[])[0]!.about).toEqual(["E1"]);
    expect(rendered.result.findings).toEqual([{ finding_index: 0, verdict: "landed", line: "THERM-46 now formats two decimals.", citation_indexes: [0] }]);
  });

  it("takes only the cited section of a page edited since it was cited, at its new version and text, and judges it without the page's other sections", async () => {
    const edited = { ...FINDINGS[1]!, citations: [pageCitation("s1", "3", "Display: the reading shows one decimal (0.1 °C).")] };
    // Room for the finding and the display section it cited, and not for the page's scope section.
    const asked = { index: 0, finding: edited.finding, expected: edited.expected, about: ["E3"] };
    const tight = EMPTY_PROMPT + cost(asked) + cost(view(bundle().items[2]!));
    const run = alone({ findings: [edited], bundle: bundle({ unreadable: [] }), prompt_budget: tight,
      replies: [{ findings: [{ index: 0, verdict: "still_open", line: "The PRD still specifies one decimal.", cites: ["E3"] }] }] });
    const rendered = await run.render();
    expect(run.trace[0]).toBe("context:E3");
    expect(run.prompt(0).findings).toEqual([asked]);
    expect(rendered.result).toMatchObject({ status: "assessed", findings: [{ finding_index: 0, verdict: "still_open", line: "The PRD still specifies one decimal.", citation_indexes: [0] }] });
  });

  it("takes a page's other sections when the section it cited is gone", async () => {
    const moved = { ...FINDINGS[1]!, citations: [pageCitation("s9", "3", "Display limits: the reading shows one decimal.")] };
    const run = alone({ findings: [moved], bundle: bundle({ unreadable: [] }), replies: [{ findings: [{ index: 0, verdict: "still_open", line: "The PRD still specifies one decimal.", cites: ["E3"] }] }] });
    await run.render();
    expect((run.prompt(0).findings as { about: string[] }[])[0]!.about).toEqual(["E3", "E4"]);
  });

  // A finding's own items are its first citation and every further outside item it cites; a further ECHO record, such as the decision, is context (R45).
  it("takes every outside item a finding cites as its own, and sends the finding only when all of them fit", async () => {
    const three = { finding: "BUG-412 stays open until its fix and the display tests land.", expected: "BUG-412 closed with passing display tests",
      citations: [TICKET_46, ticketCitation("THERM-52", "THERM-52: release notes, draft."), ticketCitation("THERM-60", "THERM-60: display tests, planned.")] };
    const asked = { index: 0, finding: three.finding, expected: three.expected, about: ["E1", "E5", "E6"] };
    const run = alone({ findings: [three], bundle: bundle({ unreadable: [] }),
      replies: [{ findings: [{ index: 0, verdict: "still_open", line: "THERM-46 is done; the display tests are still to do.", cites: ["E1", "E6"] }] }] });
    const rendered = await run.render();
    expect(run.prompt(0).findings).toEqual([asked]);
    expect(rendered.result.findings).toEqual([{ finding_index: 0, verdict: "still_open", line: "THERM-46 is done; the display tests are still to do.", citation_indexes: [0, 1] }]);
    // Room for the finding and THERM-46 alone: the other two tickets do not fit, so it is not sent and not judged.
    const one = alone({ findings: [three], bundle: bundle({ unreadable: [] }), replies: [], prompt_budget: EMPTY_PROMPT + cost(asked) + cost(view(bundle().items[0]!)) });
    const unjudged = await one.render();
    expect(one.trace).toEqual(["context:"]);
    expect(unjudged.result).toEqual({ findings: [notAssessed(0)], status: "not_assessed", citations: [] });
  });

  it("judges a finding whose decision could not be read from its own item, and reports it unreadable only when one of its own items could not be read", async () => {
    // The decision is context: research could not read it, so it is not shown, and THERM-46 is still judged.
    const withoutDecision = bundle({ unreadable: [DECISION], items: [ITEMS[0]!] });
    const run = alone({ findings: [FINDINGS[0]!], bundle: withoutDecision, replies: [{ findings: [REPLY.findings[0]] }] });
    const rendered = await run.render();
    expect(run.prompt(0).findings).toEqual([{ index: 0, finding: FINDINGS[0]!.finding, expected: FINDINGS[0]!.expected, about: ["E1"] }]);
    expect(rendered.result).toEqual({ findings: [{ finding_index: 0, verdict: "landed", line: "THERM-46 now formats two decimals.", citation_indexes: [0] }], status: "assessed", citations: [citation("E1")] });
    // A second ticket is the finding's own item: when it could not be read, the finding is unreadable, and no model is asked.
    const pair = alone({ findings: [{ ...FINDINGS[0]!, citations: [TICKET_46, TICKET_47] }], replies: [] });
    const unreadable = await pair.render();
    expect(pair.trace).toEqual(["context:"]);
    expect(unreadable.result).toEqual({ findings: [{ ...UNREADABLE, finding_index: 0 }], status: "assessed", citations: [] });
  });

  it("takes an ECHO record cited first as the finding's own item, and a page cited later as its own item too", async () => {
    // The first citation is always the finding's own item, whatever its kind; a further page is an outside item, never context.
    const recordFirst = { ...FINDINGS[0]!, citations: [DECISION, TICKET_46] };
    const pageLater = { ...FINDINGS[1]!, citations: [TICKET_46, PRD_DISPLAY_SECTION] };
    const run = alone({ findings: [recordFirst, pageLater], bundle: bundle({ unreadable: [] }), replies: [{ findings: [
      { index: 0, verdict: "landed", line: "The decision and THERM-46 both say two decimals.", cites: ["E2", "E1"] },
      { index: 1, verdict: "still_open", line: "THERM-46 changed, but the PRD still specifies one decimal.", cites: ["E1", "E3"] },
    ] }] });
    const rendered = await run.render();
    expect((run.prompt(0).findings as { about: string[] }[]).map(value => value.about)).toEqual([["E2", "E1"], ["E1", "E3"]]);
    expect(rendered.result.findings.map(value => value.verdict)).toEqual(["landed", "still_open"]);
  });

  it("never sends a finding with no own item, even one that cites nothing at all", async () => {
    // Its citations match nothing in the bundle: two tickets research holds in no form, or no citation at all.
    const nowhere = finding(ticketCitation("THERM-98", "THERM-98: a ticket research never read."));
    const findings = [FINDINGS[0]!, { ...nowhere, citations: [ticketCitation("THERM-98", "THERM-98."), ticketCitation("THERM-99", "THERM-99.")] }, { ...nowhere, citations: [] }];
    const run = alone({ findings, bundle: bundle({ unreadable: [] }), replies: [{ findings: [REPLY.findings[0]] }] });
    const rendered = await run.render();
    expect((run.prompt(0).findings as { index: number }[]).map(value => value.index)).toEqual([0]);
    expect(rendered.result.findings).toEqual([
      { finding_index: 0, verdict: "landed", line: "THERM-46 now formats two decimals.", citation_indexes: [0] }, notAssessed(1), notAssessed(2),
    ]);
  });

  it("asks for a landed verdict only when the current items show the whole expected change", () => {
    // A finding may be about several items: one of three moving is not the change landing.
    expect(SWEEP_PROMPT).toContain("about: the ids of the items it is about, as they read now.");
    expect(SWEEP_PROMPT).toContain("\"landed\" only when the current items show the whole expected change;");
    expect(SWEEP_PROMPT).not.toContain("the ids of the item it is about");
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

  it("never judges a finding the model was not shown: a finding goes to the model only with all of its own items", async () => {
    const first = { index: 0, finding: FINDINGS[0]!.finding, expected: FINDINGS[0]!.expected, about: ["E1"] };
    // Room for the first finding and THERM-46 as it reads now, and nothing more: not the PRD finding's section, nor the decision.
    const tight = EMPTY_PROMPT + cost(first) + cost(view(bundle().items[0]!));
    const run = alone({ replies: [{ findings: [REPLY.findings[0]] }], prompt_budget: tight });
    const rendered = await run.render();
    expect(run.trace[0]).toBe("context:E1");
    // The PRD finding is not sent: its index is not in the prompt, and it is left as it was, not assessed.
    expect((run.prompt(0).findings as { index: number }[]).map(value => value.index)).toEqual([0]);
    expect(Buffer.byteLength(run.inputs[0]!.user_prompt, "utf8")).toBeLessThanOrEqual(tight);
    expect(rendered.result).toEqual({
      findings: [{ finding_index: 0, verdict: "landed", line: "THERM-46 now formats two decimals.", citation_indexes: [0] }, notAssessed(1), UNREADABLE],
      status: "assessed", citations: [citation("E1")],
    });
    // A finding needs only its own item to be judged: the decision it also cited did not fit.
    expect(rendered).toMatchObject({ outcome: "partial", fallbacks: 0 });
    expect(validatePersonSweepResultV1(rendered.result, FINDINGS.length)).toEqual(rendered.result);
    // A finding whose item research holds in no form is not sent either.
    const missing = alone({ findings: [FINDINGS[0]!, finding(ticketCitation("THERM-99", "THERM-99: a ticket research never read."))], bundle: bundle({ unreadable: [] }), replies: [{ findings: [REPLY.findings[0]] }] });
    expect((await missing.render()).result.findings.map(value => [value.verdict, value.line])).toEqual([["landed", "THERM-46 now formats two decimals."], [null, "Not assessed."]]);
    expect((missing.prompt(0).findings as { index: number }[]).map(value => value.index)).toEqual([0]);
    // Room for no finding at all: no model call, and nothing judged.
    const none = alone({ replies: [], prompt_budget: EMPTY_PROMPT + 10 });
    const unjudged = await none.render();
    expect(none.trace).toEqual(["context:"]);
    expect(unjudged).toMatchObject({ outcome: "partial", fallbacks: 0, result: { status: "not_assessed", findings: [notAssessed(0), notAssessed(1), UNREADABLE], citations: [] } });
  });

  it("leaves verdicts empty when the model gives no usable reply", async () => {
    const result = await renderSweep({ findings: [finding(TICKET_46)], reply: "garbage" });
    expect(result).toMatchObject({ status: "not_assessed", findings: [{ verdict: null }] });
  });

  it("falls back without a model: no verdict for what it could read, the unreadable still reported, one fallback", async () => {
    const run = alone({ replies: [{ wrong: true }, { still: "wrong" }] });
    const { rendered, corrections } = await observed(() => run.render());
    expect(corrections).toEqual({ model_repair_rejected: 1, sweep_fallback: 1 });
    expect(run.trace.filter(event => event === "generate")).toHaveLength(2);
    expect(rendered.result).toEqual({ findings: [notAssessed(0), notAssessed(1), UNREADABLE], status: "not_assessed", citations: [] });
    expect(rendered).toMatchObject({ cited: [], outcome: "partial", fallbacks: 1 });
    expect(validatePersonSweepResultV1(rendered.result, FINDINGS.length)).toEqual(rendered.result);
    // A provider that refuses is not asked again; the result is the same.
    const refused = alone({ replies: [Object.assign(new Error("provider detail must stay private"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } })] });
    const { rendered: fallback, corrections: refusal } = await observed(() => refused.render());
    expect(refused.inputs).toHaveLength(1);
    expect(fallback).toMatchObject({ fallbacks: 1, result: rendered.result });
    expect(refusal).toEqual({ sweep_fallback: 1 });
  });

  it("makes no model call when the time left cannot cover one, and still reports each finding", async () => {
    const run = alone({ replies: [REPLY], remaining: 2_999 });
    const rendered = await run.render();
    expect(run.trace).toEqual(["context:E1,E3,E4,E2"]);
    expect(rendered).toMatchObject({ outcome: "partial", fallbacks: 0, result: { status: "not_assessed", findings: [{ verdict: null }, { verdict: null }, { verdict: "unreadable" }] } });
  });

  it.each(["cancelled", "timed_out"] as const)("still throws when its model call is %s, and never falls back to not assessed", async outcome => {
    // The request's signal joins the caller's cancel and the deadline, as the runner's does; the model never replies.
    const caller = new AbortController();
    const terminal = new AbortController();
    const signal = AbortSignal.any([caller.signal, terminal.signal]);
    let expired = false;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const budget = AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1;
    const gate = createAgenticModelGateV1({
      generation, model: { generate: async () => { entered(); return new Promise<never>(() => undefined); } },
      desk_revalidate: async () => checked, on_checked: () => undefined, budget, now: () => 0, deadline: budget.deadline_ms,
      signal, input_signal: caller.signal, is_deadline_expired: () => expired,
    });
    const pending = SWEEP_RENDERER_V1.render({
      bundle: bundle(), trigger_input: { findings: FINDINGS }, gate, remaining: () => 30_000, signal,
      prompt_budget: system => agenticAskContextBudgetBytesV1(undefined, system, AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer),
    });
    await started;
    const rejected = expect(pending).rejects.toMatchObject({ name: outcome === "timed_out" ? "AgenticAskDeadlineErrorV1" : "AbortError" });
    if (outcome === "timed_out") { expired = true; terminal.abort(new AgenticAskDeadlineErrorV1()); } else caller.abort();
    await rejected;
  });

  // A line is never stored: one that fails a screen is withheld and its verdict stands (ruling R39), with no repair spent on it.
  it.each([
    ["an instruction", "Update THERM-46 to two decimals"],
    ["a suggested edit naming the tool", "The PRD needs to be updated in Confluence to two decimals."],
    ["a line that says an item was reassigned", "THERM-46 was reassigned to the firmware team and formats two decimals."],
  ] as const)("withholds %s with no repair, and keeps its verdict", async (_label, text) => {
    const screened = firstVerdict({ line: text });
    const run = alone({ replies: [screened] });
    const { rendered, corrections } = await observed(() => run.render());
    expect(corrections).toEqual({ sweep_line_withheld: 1 });
    expect(run.inputs).toHaveLength(1);
    expect(rendered.result).toMatchObject({ status: "assessed", findings: [
      { finding_index: 0, verdict: "landed", line: "ECHO withheld this line.", citation_indexes: [0] },
      { finding_index: 1, verdict: "still_open", line: "The PRD display section still specifies one decimal.", citation_indexes: [1, 2] },
      UNREADABLE,
    ] });
    expect(rendered).toMatchObject({ fallbacks: 0, outcome: "partial" });
    expect(JSON.stringify(rendered.result)).not.toContain(text);
  });

  it.each([
    ["a reply that needs nothing", REPLY, {}],
    ["a verdict in another spelling", firstVerdict({ verdict: "Landed" }), { model_enum_respelled: 1 }],
    ["cites respelled or repeated", firstVerdict({ cites: ["e1", "E1"] }), { model_id_respelled: 1, model_repeat_dropped: 1 }],
    ["an evidence id written into a line", firstVerdict({ line: "THERM-46 now formats two decimals (E1)." }), { model_inline_ids_stripped: 1 }],
    ["a line past its cap", firstVerdict({ line: `THERM-46 now formats two decimals ${"and more ".repeat(40)}` }), { model_text_truncated: 1 }],
  ])("counts %s, and nothing else", async (_name, reply, expected) => {
    expect((await observed(() => alone({ replies: [reply] }).render())).corrections).toEqual(expected);
  });

  it("keeps a line that quotes the item it cites, and withholds one whose claim no cited item makes", async () => {
    const fixOwner = item(ticketCitation("THERM-47", "THERM-47: Confirm BUG-412 requirement and fix-owner links"), "ticket", "THERM-47: Confirm BUG-412 requirement and fix-owner links",
      "THERM-47: Confirm BUG-412 requirement and fix-owner links", { attributes: { status: "To Do" } });
    const quoting = bundle({ unreadable: [], items: [...ITEMS, fixOwner] });
    const findings = [{ finding: "THERM-47 does not trace the requirement.", expected: "the requirement and fix-owner confirmation recorded", citations: [TICKET_47] }];
    const judged = (line: string) => alone({ findings, bundle: quoting, replies: [{ findings: [{ index: 0, verdict: "still_open", line, cites: ["E7"] }] }] });
    const quoted = judged("THERM-47 is still To Do and asks for fix-owner links.");
    expect((await quoted.render()).result.findings[0]!.line).toBe("THERM-47 is still To Do and asks for fix-owner links.");
    const claimed = judged("THERM-47 is owned by Tobias Lund and still To Do.");
    expect((await claimed.render()).result.findings[0]).toMatchObject({ verdict: "still_open", line: "ECHO withheld this line." });
    expect(claimed.inputs).toHaveLength(1);
  });

  // A change that landed, or went another way, shows in the finding's own items: a verdict judged from its decision alone is not usable.
  it.each([
    ["landed", { verdict: "landed", line: "The decision says two decimals.", cites: ["E2"] }],
    ["changed", { verdict: "changed", line: "The release notes say something else.", cites: ["E2", "E3"] }],
  ] as const)("sends back a %s verdict that cites none of the finding's own items once, and leaves the findings not assessed if it comes back", async (_label, entry) => {
    const ungrounded = firstVerdict(entry);
    const run = alone({ replies: [ungrounded, REPLY] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(2);
    expect(JSON.parse(run.inputs[1]!.user_prompt).validation_error).toContain(`finding 0 is "${entry.verdict}" but cites none of the items it is about (E1)`);
    expect(rendered.result).toEqual((await alone({ replies: [REPLY] }).render()).result);
    const twice = await alone({ replies: [ungrounded, ungrounded] }).render();
    expect(twice).toMatchObject({ fallbacks: 1, result: { status: "not_assessed", citations: [] } });
    expect(SWEEP_PROMPT).toContain("A \"landed\" or \"changed\" verdict cites at least one of the finding's about items.");
  });

  it("takes still open from a finding's decision alone, in one call", async () => {
    const run = alone({ replies: [{ findings: [{ ...REPLY.findings[0]!, verdict: "still_open", cites: ["E2"] }, REPLY.findings[1]!] }] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(1);
    expect(rendered.result.findings[0]).toMatchObject({ verdict: "still_open", citation_indexes: [0] });
  });

  it("shows the model only each finding's own items, its decision and what research cited for it", async () => {
    // A plan part cites THERM-46 (finding 0's own item) with THERM-52; another cites only THERM-60, about no finding.
    const planned: AgenticEvidenceBundleV1 = { ...bundle({ unreadable: [] }), plan: [
      { part: 1, question: "THERM-46", notes: "", needs: [{ need: "current state", status: "found", evidence: ["E1", "E5"] }] },
      { part: 2, question: "Display tests", notes: "", needs: [{ need: "test plan", status: "found", evidence: ["E6"] }] },
    ] };
    const run = alone({ findings: FINDINGS.slice(0, 2), bundle: planned, replies: [REPLY] });
    await run.render();
    expect(run.trace[0]).toBe("context:E1,E3,E4,E2,E5");
    // Without the plan: the decision and the page's other section only; nothing research only came across.
    const unplanned = alone({ findings: [FINDINGS[0]!], bundle: bundle({ unreadable: [] }), replies: [{ findings: [REPLY.findings[0]] }] });
    await unplanned.render();
    expect(unplanned.trace[0]).toBe("context:E1,E2");
  });

  it("tells the judge what was expected: the decision's own words, as research read them now, in place of the placeholder", async () => {
    expect(SWEEP_APPROVED_DECISION_V1).toBe("the approved decision");
    const placeholder = { ...FINDINGS[0]!, expected: SWEEP_APPROVED_DECISION_V1 };
    const expectedOf = async (finding: SweepTriggerInputV1["findings"][number], value: AgenticEvidenceBundleV1) => {
      const run = alone({ findings: [finding], bundle: value, replies: [{ findings: [REPLY.findings[0]] }] });
      await run.render();
      return (run.prompt(0).findings as { expected: string }[])[0]!.expected;
    };
    expect(await expectedOf(placeholder, bundle({ unreadable: [] }))).toBe("Approved: show two decimals (0.01 °C) on the display from DVT.");
    // A finding's own phrase is kept as it is.
    expect(await expectedOf(FINDINGS[0]!, bundle({ unreadable: [] }))).toBe("two decimals from DVT");
    // A decision research could not read, or a caller not shown it (no decision citation): the placeholder stays.
    expect(await expectedOf(placeholder, bundle({ unreadable: [DECISION], items: [ITEMS[0]!] }))).toBe(SWEEP_APPROVED_DECISION_V1);
    expect(await expectedOf({ ...placeholder, citations: [TICKET_46] }, bundle({ unreadable: [] }))).toBe(SWEEP_APPROVED_DECISION_V1);
  });

  // A reply is usable only whole: every finding it was given judged once, from items it was shown.
  it.each([
    ["a reply that misses a finding", { findings: [REPLY.findings[0]] }, "one entry for each finding"],
    ["a reply that repeats a finding", { findings: [...REPLY.findings, REPLY.findings[0]] }, "one entry for each finding"],
    ["a verdict on the finding it was not given", { findings: [...REPLY.findings, { index: 2, verdict: "still_open", line: "THERM-47 is unchanged.", cites: ["E1"] }] }, "findings given"],
    ["an index no finding has", firstVerdict({ index: 7 }), "findings given"],
    ["a verdict it may not give", firstVerdict({ verdict: "unreadable" }), "verdict"],
    ["an empty line", firstVerdict({ line: " " }), "line"],
    ["a verdict that cites nothing", firstVerdict({ cites: [] }), "each verdict must cite the items it was judged from"],
    ["an item it was not shown", firstVerdict({ cites: ["E9"] }), "cite only"],
    ["cites that are not a list", firstVerdict({ cites: "E1" }), "cites"],
    ["a reply that is not an object", ["landed"], "JSON object"],
  ] as const)("sends back %s once, and leaves the findings not assessed if it comes back", async (_label, reply, reason) => {
    const run = alone({ replies: [reply, REPLY] });
    const rendered = await run.render();
    expect(run.inputs).toHaveLength(2);
    expect(JSON.parse(run.inputs[1]!.user_prompt).validation_error).toContain(reason);
    expect(rendered.result).toEqual((await alone({ replies: [REPLY] }).render()).result);
    const twice = await alone({ replies: [reply, reply] }).render();
    expect(twice).toMatchObject({ fallbacks: 1, result: { status: "not_assessed", citations: [] } });
  });
});
