import { canonicalJsonBytes, canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { PERSON_ANSWER_RESPONSE_MAX_BYTES_V4, PERSON_ANSWER_STATEMENT_MAX_BYTES_V4, PERSON_EVIDENCE_TEXT_MAX_BYTES_V1, validatePersonAnswerBlocksV2 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import {
  ANSWER_BLOCK_CATALOG, ANSWER_BLOCKS_PROMPT, ANSWER_PROMPT, ANSWER_SINCE_PROMPT, answerBlocksSchema, answerBlocksSinceSchema,
} from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { createAgenticListEvidenceV1, type AgenticListEvidenceV1 } from "../../../src/answer-composition/agentic-list-evidence-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { AGENTIC_RESEARCH_NOTES_ABOUT_V1 } from "../../../src/answer-composition/agentic-research-notes-v1.js";
import { createAskRendererV1 } from "../../../src/answer-composition/renderers/ask-renderer-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../src/shared/core-runtime-observation-v1.js";
import { ids } from "../fixtures/agentic-lists.js";
import { EMPTY_BUNDLE, LIST_READ_AT, listed, record, scriptedGate, writerReply } from "../fixtures/agentic-scenarios.js";

/** Ask's renderer on its own: a hand-built bundle, a gate over scripted writer replies, and no desk. */
function alone(input: {
  readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly remaining?: number;
  /** An Ask again (ADR-0047): the earlier answer, and the question the answer names, as Ask passes them together. */
  readonly earlier?: Parameters<typeof createAskRendererV1>[0]["earlier"]; readonly answers?: string;
}) {
  const trace: string[] = [];
  const { gate, inputs } = scriptedGate(input.replies, input.bundle.budget, trace);
  const renderer = createAskRendererV1({
    answer_prompt: ANSWER_PROMPT, source_catalog: [], scope: "everything the asker can read",
    context: { today: "2026-10-06" }, desk_scope: input.bundle.gathered_for.scope,
    ...(input.earlier === undefined ? {} : { earlier: input.earlier }), ...(input.answers === undefined ? {} : { answers: input.answers }),
  });
  const render = (question: string) => renderer.render({
    bundle: input.bundle, trigger_input: { question }, gate, remaining: () => input.remaining ?? 30_000, signal: new AbortController().signal,
    prompt_budget: (system, output = AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer) => agenticAskContextBudgetBytesV1(undefined, system, output),
    on_context: selected => { trace.push(`context:${selected.join(",")}`); },
  });
  return { render, trace, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, any>, input: (index: number) => inputs[index]! };
}

type Rendering = Awaited<ReturnType<ReturnType<typeof alone>["render"]>>;
/** A render in its output span, and the corrections of model output that span counted (an empty object for none). */
async function observed(render: () => Promise<Rendering>): Promise<{ readonly rendered: Rendering; readonly corrections: Readonly<Record<string, number>> }> {
  const events: CoreRuntimeObservationV1[] = [];
  const rendered = await observeCoreRuntimeV1("research_output", render, { observer: event => { events.push(event); } });
  return { rendered, corrections: events.find(event => event.phase === "research_output" && event.event !== "started")!.model_corrections ?? {} };
}

/** A released v2 part's blocks, checked against the contract. */
function blocksOf(rendered: Rendering) {
  const part = rendered.result.response.parts[0]!;
  expect(validatePersonAnswerBlocksV2(part.blocks, part.statements, rendered.result.response.citations.length)).toEqual(part.blocks);
  return part.blocks!;
}

/** Items in short-id order, the plan citing `cited`. */
function bundle(entries: readonly { readonly item: EvidenceDeskItemV2; readonly full: boolean; readonly touched: number }[], cited: readonly string[], completed = true): AgenticEvidenceBundleV1 {
  return Object.freeze({
    ...EMPTY_BUNDLE,
    plan: [{ part: 1, question: "What was decided?", notes: "", needs: [{ need: "the decision", status: cited.length > 0 ? "found" as const : "open" as const, evidence: cited }] }],
    items: entries.map((entry, index) => Object.freeze({
      short: `E${index + 1}`, source: "meetings", item: entry.item, full: entry.full, opened: false, preloaded: false, touched: entry.touched, cited_by_plan: cited.includes(`E${index + 1}`),
    })),
    stop: { reason: completed ? "finished" as const : "budget" as const, completed },
  });
}
/** Approved records E1..En, each read in full and cited by the plan. */
const records = (count: number, options: Parameters<typeof record>[2] = {}) => bundle(Array.from({ length: count }, (_, index) => ({ item: record(`r${index + 1}`, `Approved record ${index + 1}.`, options), full: true, touched: index + 1 })), Array.from({ length: count }, (_, index) => `E${index + 1}`));

describe("Ask renderer", () => {
  it("keeps the read-only explanation when a writer supplies a long missing-fact gap", async () => {
    const run = alone({ bundle: { ...records(1), stop: { reason: "finished", completed: true, unsupported_action: true } },
      replies: [writerReply([{ text: "The rule applies.", evidence: ["E1"] }], { not_found: ["Missing detail. ".repeat(40)] })] });
    const rendered = await run.render("What is the rule? Change the status.");
    expect(rendered.result.response.parts[0]!.gap).toMatch(/^Ask can read your sources, but it can't make changes or send messages\. Nothing was changed or sent\./u);
    expect(rendered.result.response.parts[0]!.gap!.length).toBeLessThanOrEqual(600);
    expect(rendered.result.response.parts[0]!.gap_details).toMatchObject({ unsupported_action: true, not_found: expect.stringMatching(/^Not found:/u) });
  });

  it("explains unfinished factual research beside an unsupported action and usable evidence", async () => {
    const run = alone({ bundle: { ...records(1), stop: { reason: "finished", completed: false, unsupported_action: true } },
      replies: [writerReply([{ text: "The rule applies.", evidence: ["E1"] }])] });
    const rendered = await run.render("What are all the rules? Change the status.");
    expect(rendered.result.response.parts[0]!.gap).toContain("Nothing was changed or sent.");
    expect(rendered.result.response.parts[0]!.gap).toContain("Research stopped before it finished");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]!.gap_details).toEqual({ unsupported_action: true, interrupted: true });
  });

  it("keeps genuine unfinished research typed even beside useful facts", async () => {
    const rendered = await alone({ bundle: { ...records(1), stop: { reason: "budget", completed: false } }, replies: [writerReply([{ text: "The rule applies.", evidence: ["E1"] }])] }).render("What are all the rules?");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "partial", gap_details: { interrupted: true } });
  });

  it.each([false, true])("types only the retry reason when interrupted research leaves a writer's missing fact (with facts: %s)", async withFacts => {
    const rendered = await alone({ bundle: { ...records(1), stop: { reason: "budget", completed: false } }, replies: [writerReply(withFacts ? [{ text: "The rule applies.", evidence: ["E1"] }] : [], { not_found: ["the Harbor owner"] })] }).render("Who owns Harbor, and what is the rule?");
    const part = rendered.result.response.parts[0]!;
    expect(rendered.outcome).toBe("partial");
    expect(part.gap).toBe("I couldn't complete the search. Please try again. Missing context: the Harbor owner.");
    expect(part.gap_details).toEqual({ interrupted: true });
  });

  it.each([false, true])("keeps both project leads beside the list the writer places when both needs are which_items (extra person citation: %s)", async extraPerson => {
    const question = "What are the active projects, and who leads them?";
    const projects: EvidenceDeskItemV2[] = ["Alpha", "Beta"].map((label, index) => ({
      id: `project-${index + 1}`, kind: "project", label, visibility: "project",
      citation: { kind: "project", project_id: `prj_00000000-0000-4000-8000-00000000000${index + 1}` },
      attributes: { status: "active", leads: index === 0 ? "Casey" : "Morgan" },
      text: `${label} is active. Lead: ${index === 0 ? "Casey" : "Morgan"}.`, receipt_sha256: canonicalSha256(label),
    }));
    const person: EvidenceDeskItemV2 = {
      id: "person-casey", kind: "person", label: "Casey", visibility: "team",
      citation: { kind: "person", membership_id: "mem_00000000-0000-4000-8000-000000000001" },
      text: "Casey leads Alpha.", receipt_sha256: canonicalSha256("Casey"),
    };
    const research: AgenticEvidenceBundleV1 = {
      ...EMPTY_BUNDLE,
      plan: [{ part: 1, question, notes: "", needs: ["active projects", "project leads"].map(need => ({ need, kind: "which_items", status: "found", evidence: ["L1"] })) }],
      lists: [createAgenticListEvidenceV1({
        id: "L1", source: "projects", filter: { status: "active" }, filter_applied: { status: "applied" },
        members: ["E1", "E2"], shown: 2, ended: true, unverified_end: false, available: true, truncated: false, read_at: LIST_READ_AT,
      })],
      items: [...projects, ...(extraPerson ? [person] : [])].map((item, index) => ({
        short: `E${index + 1}`, source: index < 2 ? "projects" : "people", item,
        full: true, opened: true, preloaded: false, touched: index + 1, cited_by_plan: false,
      })),
    };
    // The writer places the list both needs cite (ADR-0054); code fills it where the writer put it.
    const run = alone({ bundle: research, replies: [writerReply([
        { text: "Casey leads Alpha.", evidence: extraPerson ? ["E1", "E3"] : ["E1"] },
        { text: "Morgan leads Beta.", evidence: ["E2"] },
      ], { lists: [{ id: "L1" }] })] });
    const rendered = await run.render(question);
    const statements = rendered.result.response.parts[0]!.statements;
    // The writer's answer leads, then the list it placed, then the rest of the writer's items (ADR-0051, ADR-0054).
    expect(statements.map(statement => statement.text)).toEqual(["Casey leads Alpha.", expect.stringMatching(/2 projects.*Alpha.*Beta/u), "Morgan leads Beta."]);
    expect([statements[0]!.citation_indexes, statements[2]!.citation_indexes]).toEqual(extraPerson ? [[0, 1], [2]] : [[0], [1]]);
    expect(rendered.result.response.citations).toHaveLength(extraPerson ? 3 : 2);
    expect(rendered.outcome).toBe("answered");
  });

  it("removes only exact repeats with the same cited objects, independent of citation order", async () => {
    const first = record("first", "Casey owns the pilot. The pilot is due Friday.");
    const second = record("second", "Casey owns the pilot.", { visibility: "only_me" });
    const run = alone({
      bundle: bundle([{ item: first, full: true, touched: 1 }, { item: second, full: true, touched: 2 }], ["E1", "E2"]),
      replies: [writerReply([
        { text: "Casey owns the pilot.", evidence: ["E1", "E2"] },
        { text: "Casey owns the pilot.", evidence: ["E2", "E1", "E1"] },
        { text: "Casey owns the pilot.", evidence: ["E1"] },
        { text: "Casey owns the pilot.", evidence: ["E2"] },
        { text: "The pilot is due Friday.", evidence: ["E1"] },
        { text: "The pilot belongs to Casey.", evidence: ["E1"] },
      ])],
    });
    const { rendered, corrections } = await observed(() => run.render("Who owns the pilot and when is it due?"));
    expect(rendered.result.response.parts[0]!.statements).toEqual([
      { text: "Casey owns the pilot.", citation_indexes: [0, 1], private: true },
      { text: "Casey owns the pilot.", citation_indexes: [0], private: false },
      { text: "Casey owns the pilot.", citation_indexes: [1], private: true },
      { text: "The pilot is due Friday.", citation_indexes: [0], private: false },
      { text: "The pilot belongs to Casey.", citation_indexes: [0], private: false },
    ]);
    expect(rendered.result.response.citations.map(value => value.citation)).toEqual([first.citation, second.citation]);
    // The one exact repeat, and the second sentence's repeated E1.
    expect(corrections).toEqual({ writer_repeat_dropped: 1, model_repeat_dropped: 1 });
  });

  it("cites only the evidence the writer was given, in first-citation order", async () => {
    const first = record("first", "Approved: ship the enclosure in October.");
    const second = record("second", "Approved: Mara owns the launch.");
    const run = alone({
      bundle: bundle([{ item: first, full: true, touched: 1 }, { item: second, full: true, touched: 2 }, { item: listed("unread"), full: false, touched: 3 }], ["E1"]),
      replies: [writerReply([{ text: "Mara owns the October launch.", evidence: ["E2", "E1", "E9"] }, { text: "An unread item says so.", evidence: ["E3"] }])],
    });
    const { rendered, corrections } = await observed(() => run.render("What was decided?"));
    expect(run.trace).toEqual(["context:E1,E2", "revalidate", "generate"]);
    expect(rendered.result.response.parts[0]!.statements).toEqual([{ text: "Mara owns the October launch.", citation_indexes: [0, 1], private: false }]);
    expect(rendered.result.response.citations.map(value => value.citation)).toEqual([second.citation, first.citation]);
    expect(rendered).toMatchObject({ cited: ["E2", "E1"], outcome: "answered", fallbacks: 0, result: { writer_evidence: ["E1", "E2"] } });
    // E9, which the writer was never shown, and the sentence that cites no text it read.
    expect(corrections).toEqual({ writer_unknown_id_dropped: 1, writer_uncited_sentence_dropped: 1 });
  });

  // agentic-diagnostics-v1.test.ts replays this fallback too, end to end.
  it("falls back only to items research read in full when the writer fails", async () => {
    const read = record("read", "Approved: ship the enclosure in October.");
    const previewed = record("previewed", "Approved: the enclosure vendor changed.");
    const run = alone({
      bundle: bundle([{ item: read, full: true, touched: 1 }, { item: previewed, full: false, touched: 3 }, { item: listed("listed"), full: false, touched: 2 }], ["E1"]),
      replies: [{ wrong: true }, { still: "wrong" }],
    });
    const { rendered, corrections } = await observed(() => run.render("What was decided?"));
    // The writer reads the previewed passage too, but a failed writer's records stay limited to what research read.
    expect(rendered.result.writer_evidence).toEqual(["E1", "E2"]);
    expect(rendered.result.response).toMatchObject({ schema_version: 8, kind: "echo-clean-person-answer-v8", outcome: "partial", parts: [{ status: "records_only", records: [{ text: read.text, citation_indexes: [0] }] }], citations: [{ citation: read.citation }] });
    expect(rendered).toMatchObject({ cited: ["E1"], outcome: "partial", fallbacks: 1 });
    expect(run.trace).toEqual(["context:E1,E2", "revalidate", "generate", "revalidate", "generate"]);
    expect(corrections).toEqual({ model_repair_rejected: 1, writer_fallback: 1 });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap_details");
  });

  it("cuts a long record in the fallback to the response's bound for a record's text", async () => {
    const long = record("long", `Approved: ${"the enclosure ships in October. ".repeat(200)}`);
    expect(Buffer.byteLength(long.text!, "utf8")).toBeGreaterThan(PERSON_EVIDENCE_TEXT_MAX_BYTES_V1);
    const rendered = await alone({ bundle: bundle([{ item: long, full: true, touched: 1 }], ["E1"]), replies: [{ wrong: true }, { still: "wrong" }] }).render("What was decided?");
    const [shown] = rendered.result.response.parts[0]!.records!;
    expect(rendered.result.response.parts[0]!.status).toBe("records_only");
    expect(Buffer.byteLength(shown!.text, "utf8")).toBeLessThanOrEqual(PERSON_EVIDENCE_TEXT_MAX_BYTES_V1);
    expect(shown!.text.endsWith("…")).toBe(true);
  });

  it("makes no model call without readable evidence and still ends with an honest result", async () => {
    for (const completed of [true, false]) {
      const run = alone({ bundle: bundle([{ item: listed("listed"), full: false, touched: 1 }], [], completed), replies: [] });
      const rendered = await run.render("What was decided?");
      expect(run.trace).toEqual(["context:"]);
      expect(rendered).toMatchObject({ cited: [], fallbacks: 0, outcome: completed ? "not_found" : "partial", result: { writer_evidence: [] } });
      expect(rendered.result.response.parts[0]).toMatchObject({ status: "not_found", gap: completed ? "I couldn't find this in the sources you can access." : "I couldn't complete the search. Please try again.",
        gap_details: completed ? { not_found: "I couldn't find this in the sources you can access." } : { interrupted: true } });
    }
  });

  const LIMITED_COVERAGE = "Some source coverage was incomplete, so relevant context may be missing.";
  const gate = () => record("gate", "Approved: the pilot may proceed after the gate.");
  const contextThenBody = () => bundle([{ item: record("context", "Related context."), full: false, touched: 1 }, { item: record("body", "Approved: the pilot may proceed after the gate."), full: true, touched: 2 }], ["E2"]);
  it.each<{ readonly name: string; readonly research: AgenticEvidenceBundleV1; readonly text: string; readonly cited: string; readonly notice: string | null; readonly interrupted?: true }>([
    {
      name: "keeps a full cited Jira anchor answered while neutrally noting omitted links",
      research: {
        ...bundle([{ item: record("jira-anchor", "THERMO-17 reports that the pilot may proceed after the gate."), full: true, touched: 1 }], ["E1"]),
        rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E1"], truncated: true } }] }],
        coverage: { reads: [{ tool: "open" as const, source: "tickets", returned_items: 1, truncated: true, notice: false, unavailable: false }], inventories: [], notices: [] },
      },
      text: "THERMO-17 reports that the pilot may proceed after the gate.", cited: "E1", notice: LIMITED_COVERAGE,
    },
    {
      name: "notes a limited open when it returns a different cited body id",
      research: {
        ...contextThenBody(),
        rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"], truncated: true } }] }],
        coverage: { reads: [{ tool: "open" as const, source: "pages", returned_items: 1, truncated: true, notice: false, unavailable: false }], inventories: [], notices: [] },
      },
      text: "The pilot may proceed after the gate.", cited: "E2", notice: LIMITED_COVERAGE,
    },
    {
      name: "keeps facts from stopped research with a typed interruption", interrupted: true,
      research: bundle([{ item: gate(), full: true, touched: 1 }], ["E1"], false),
      text: "The pilot may proceed after the gate.", cited: "E1", notice: "Research stopped before it finished, so relevant context may be missing.",
    },
    {
      name: "keeps a completed answer answered when an unrelated source was truncated",
      research: {
        ...bundle([{ item: gate(), full: true, touched: 1 }], ["E1"]),
        rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "search", args: { query: "unrelated history" }, result: { items: ["E2"], opened: [], truncated: true } }] }],
        coverage: { reads: [{ tool: "search" as const, source: "documents", returned_items: 1, truncated: true, notice: false, unavailable: false }], inventories: [{ source: "documents", truncated: true }], notices: ["An unrelated document search was cut short."] },
      },
      text: "The pilot may proceed after the gate.", cited: "E1", notice: "An unrelated document search was cut short.",
    },
    {
      name: "keeps a fully opened cited record answered after a limited inventory",
      research: {
        ...bundle([{ item: gate(), full: true, touched: 1 }], ["E1"]),
        rounds: [
          { round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "list", args: { source: "meetings" }, result: { items: ["E1"], opened: [], more: true } }] },
          { round: 2, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E1"] } }] },
        ],
        coverage: { reads: [{ tool: "list" as const, source: "meetings", returned_items: 1, truncated: false, notice: false, unavailable: false }], inventories: [{ source: "meetings", more: true }], notices: [] },
      },
      text: "The pilot may proceed after the gate.", cited: "E1", notice: null,
    },
    {
      name: "clears a limited returned body notice after a later clean open of that body",
      research: {
        ...contextThenBody(),
        rounds: [
          { round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"], truncated: true } }] },
          { round: 2, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"] } }] },
        ],
        coverage: { reads: [], inventories: [], notices: [] },
      },
      text: "The pilot may proceed after the gate.", cited: "E2", notice: null,
    },
    {
      name: "does not turn an unfulfilled planner need into a missing user requirement",
      research: {
        ...bundle([{ item: gate(), full: true, touched: 1 }], ["E1"]),
        plan: [{ part: 1, question: "Can the pilot proceed?", notes: "", needs: [
          { need: "pilot decision", status: "found" as const, evidence: ["E1"] },
          { need: "an unrelated optional context item", status: "not_found" as const, evidence: [] },
        ] }],
      },
      text: "The pilot may proceed after the gate.", cited: "E1", notice: null,
    },
  ])("$name", async ({ research, text, cited, notice, interrupted }) => {
    const rendered = await alone({ bundle: research, replies: [writerReply([{ text, evidence: [cited] }])] }).render("Can the pilot proceed?");
    expect(rendered.outcome).toBe(interrupted ? "partial" : "answered");
    expect(rendered.result.response.parts[0]).toMatchObject({ status: interrupted ? "partial" : "answered", ...(interrupted ? { gap_details: { interrupted: true } } : {}) });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap");
    if (notice === null) expect(rendered.result.response).not.toHaveProperty("notice");
    else expect(rendered.result.response.notice).toBe(notice);
  });

  it("writes only when the time the runner leaves it covers a writer call", async () => {
    const entries = [{ item: record("read", "Approved: ship the enclosure in October."), full: true, touched: 1 }];
    const reply = writerReply([{ text: "The enclosure ships in October.", evidence: ["E1"] }]);
    const enough = alone({ bundle: bundle(entries, ["E1"]), replies: [reply], remaining: 3_000 });
    expect(await enough.render("What was decided?")).toMatchObject({ outcome: "answered", cited: ["E1"] });
    const short = alone({ bundle: bundle(entries, ["E1"]), replies: [reply], remaining: 2_999 });
    const fallback = await short.render("What was decided?");
    expect(short.trace).toEqual(["context:E1"]);
    expect(fallback).toMatchObject({ outcome: "partial", cited: ["E1"], fallbacks: 0, result: { writer_evidence: [] } });
    expect(fallback.result.response.parts[0]).toMatchObject({ status: "records_only", gap: "I found these records, but could not write a verified summary." });
  });
});

describe("Ask renderer: lists (ADR-0041)", () => {
  /** A ticket as a list row: key and summary, status and assignee, no text. */
  const ticketRow = (n: number, body?: string) => Object.freeze({
    id: `ticket_THERM-${n}_${body === undefined ? "listed" : "open"}`, source_id: "jira", kind: "ticket" as const, label: `THERM-${n}: Fixture work ${n}`, visibility: "only_me" as const,
    ...(body === undefined ? {} : { text: body }),
    citation: { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: String(10_000 + n), permalink: `https://tickets.example.test/browse/THERM-${n}`, text_sha256: sha256Digest(body ?? "") },
    occurred_at: "2026-10-04", date_kind: "created" as const, attributes: { status: "In Progress", owner: "Dana Lee" }, receipt_sha256: canonicalSha256({ ticket: n, body: body ?? null }),
  } satisfies EvidenceDeskItemV2);
  const list = (id: `L${number}`, members: readonly string[], extra: Partial<AgenticListEvidenceV1> = {}) => createAgenticListEvidenceV1({
    id, source: "tickets", filter: { date_field: "created", since: "2026-10-04", until: "2026-10-04", time_zone: "UTC" }, filter_applied: { date_field: "applied", since: "applied", until: "applied" },
    members, shown: members.length, ended: true, unverified_end: false, available: true, truncated: false, read_at: LIST_READ_AT, ...extra,
  });
  type Need = { readonly kind?: "which_items" | "which_say"; readonly evidence: readonly string[] };
  /** Needs as research declared them (ADR-0041): which_items, which_say, or content (no kind). */
  const WI = (evidence: readonly string[]): Need => ({ kind: "which_items", evidence });
  const WS = (evidence: readonly string[]): Need => ({ kind: "which_say", evidence });
  const C = (evidence: readonly string[]): Need => ({ evidence });
  const planOf = (needs: readonly Need[]) => [{ part: 1, question: "Which tickets?", notes: "", needs: needs.map((value, index) => ({ need: `need ${index + 1}`, ...value, status: "found" as const })) }];
  /** Rows E1..En, then text records; the plan's needs as declared. */
  const listBundle = (rows: number, texts: number, lists: readonly AgenticListEvidenceV1[], needs: readonly Need[], budget = EMPTY_BUNDLE.budget): AgenticEvidenceBundleV1 => {
    const items = [...Array.from({ length: rows }, (_, index) => ({ item: ticketRow(index + 1), full: false })), ...Array.from({ length: texts }, (_, index) => ({ item: record(`text-${index + 1}`, `Approved record ${index + 1}.`), full: true }))];
    const cited = needs.flatMap(need => need.evidence);
    return Object.freeze({
      ...EMPTY_BUNDLE, budget, lists, plan: planOf(needs),
      items: items.map((entry, index) => Object.freeze({ short: `E${index + 1}`, source: entry.full ? "meetings" : "tickets", item: entry.item, full: entry.full, opened: false, preloaded: false, touched: index + 1, cited_by_plan: entry.full && cited.includes(`E${index + 1}`) })),
    });
  };
  /** Eight rows and one record, L1 holding the rows. */
  const eightAnd1 = (needs: readonly Need[], budget?: AgenticEvidenceBundleV1["budget"]) => listBundle(8, 1, [list("L1", ids(1, 8))], needs, budget);
  /** The research with every row team-visible but those in `kept`, which stay only_me. */
  const teamRows = (research: AgenticEvidenceBundleV1, kept: readonly string[] = []): AgenticEvidenceBundleV1 => Object.freeze({
    ...research, items: research.items.map(entry => entry.full || kept.includes(entry.short) ? entry : Object.freeze({ ...entry, item: Object.freeze({ ...entry.item, visibility: "team" as const }) })),
  });
  /** 25 rows of a list cut short, then `texts` records. */
  const cut = (texts: number, needs: readonly Need[]) => listBundle(25, texts, [list("L1", ids(1, 25), { ended: false, truncated: true })], needs);
  /** The same with no record, the first five rows in review. */
  const reviewed = (research = cut(0, [WI(["L1"])])): AgenticEvidenceBundleV1 =>
    Object.freeze({ ...research, items: research.items.map((entry, index) => index < 5 ? Object.freeze({ ...entry, item: { ...entry.item, attributes: { status: "In Review", owner: "Dana Lee" } } }) : entry) });
  const names = (from: number, count: number) => Array.from({ length: count }, (_, index) => `THERM-${from + index}: Fixture work ${from + index}`).join("; ");
  const facts = (from: number, count = 1) => Array.from({ length: count }, (_, index) => `THERM-${from + index}: Fixture work ${from + index} (status In Progress, owner Dana Lee, created October 4, 2026)`).join("; ");
  const st = (text: string, indexes: number | readonly number[], shared = false) => ({ text, citation_indexes: typeof indexes === "number" ? Array.from({ length: indexes }, (_, index) => index) : indexes, private: !shared });
  const say = (...sentences: readonly { readonly text: string; readonly evidence: readonly string[] }[]) => (writerReply(sentences));
  const use = (...lists: readonly unknown[]) => (writerReply([], { lists }));
  /** The writer's sentences beside the whole of L1, placed as a list block right after its answer (ADR-0054). */
  const sayWithL1 = (...sentences: readonly { readonly text: string; readonly evidence: readonly string[] }[]) => writerReply(sentences, { lists: [{ id: "L1" }] });
  const EIGHT = `8 tickets created on October 4, 2026: ${names(1, 8)}.`;
  const FOUR = { text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["L1", ...ids(1, 4)] };
  const REVIEW = { text: "The review approved the fixture work.", evidence: ["E9"] };
  const ON_THEM = { text: "The review approved fixture work on them.", evidence: ["L1", "E9"] };
  const WAITS = "THERM-2 (Fixture work 2, owner Dana Lee) waits on the approved record.";
  const ROWS_REASON = "a sentence cites list rows or list ids but no evidence text: place a \"list\" block to show which items exist and members' title, dates, status and owner (whole, with \"where\" or with \"members\"); what no evidence text says belongs in \"not_found\"";
  const UNSUPPORTED = "Part of the answer was left out because no item's text supports it.";
  const RECORDS = "I found these records, but could not write a verified summary.";
  const FIT = "Some evidence could not fit in this response.";
  const LEG = "The list of tickets could not be read to its end, so more may exist.";
  const visibility = (...expected: readonly (readonly [string, string])[]) => (rendered: Rendered) => expect(rendered.result.response.citations.map(value => [value.kind, value.visibility])).toEqual(expected);
  it.each(["complete", "truncated", "unverified", "unchecked", "missing fact"] as const)("types a selected no-match only after verified complete coverage: %s", async state => {
    const extra = state === "truncated" ? { ended: false, truncated: true } : state === "unverified" ? { unverified_end: true }
      : state === "unchecked" ? { unchecked: { count: 1, dates: ["created" as const] } } : {};
    const base = listBundle(2, 0, [list("L1", ids(1, 2), extra)], [WI(["L1"])]);
    const research = state !== "missing fact" ? base : { ...base, items: base.items.map(entry => ({ ...entry, item: { ...entry.item, attributes: { owner: "Dana Lee" } } })) };
    const rendered = await alone({ bundle: research, replies: [{ ...use({ id: "L1", where: { field: "status", value: "Blocked" } }), not_found: ["the requested blocked item"] }] }).render("Which tickets are blocked?");
    expect(rendered.outcome).toBe(state === "complete" ? "not_found" : "partial");
    if (state === "complete") expect(rendered.result.response.parts[0]!.gap_details?.not_found).toContain("Blocked");
    else expect(rendered.result.response.parts[0]).not.toHaveProperty("gap_details");
  });

  // A list block hand-picking no member is the writer saying none answers (ADR-0054): a selection that matched nothing,
  // whose absence is typed only over a list read to its end.
  it.each([
    ["complete", {}], ["truncated", { ended: false, truncated: true }], ["unverified end", { unverified_end: true }], ["notice", { available: false }],
    ["unshown members", { shown: 40 }], ["untested dates", { unchecked: { count: 2, dates: ["updated" as const] } }],
  ] as const)("types an explicit none's absence like a no-match selection's, only over a complete list: %s", async (state, extra) => {
    const rendered = await alone({ bundle: listBundle(50, 0, [list("L1", ids(1, 50), extra)], [WI(["L1"])]), replies: [{ ...use({ id: "L1", members: [] }), not_found: ["tickets assigned to Casey"] }] })
      .render("Which tickets are assigned to Casey?");
    expect(rendered.outcome).toBe(state === "complete" ? "not_found" : "partial");
    if (state === "complete") expect(rendered.result.response.parts[0]!.gap_details).toEqual({ not_found: "Not found: tickets assigned to Casey." });
    else expect(rendered.result.response.parts[0]).not.toHaveProperty("gap_details");
  });
  // A reply whose only content is that none is the writer's reply (ADR-0054): the fallback never states the list it said
  // none of, and the answer says what a selection that matched nothing says, its absence typed only over a complete list.
  it.each([["complete", {}], ["truncated", { ended: false, truncated: true }], ["untested dates", { unchecked: { count: 2, dates: ["updated" as const] } }]] as const)(
    "keeps an explicit none with nothing else as the writer's reply, never stating the list: %s", async (state, extra) => {
      const rendered = await alone({ bundle: listBundle(50, 0, [list("L1", ids(1, 50), extra)], [WI(["L1"])]), replies: [use({ id: "L1", members: [] })] })
        .render("Which tickets are assigned to Casey?");
      const part = rendered.result.response.parts[0]!;
      expect([part.statements, part.blocks, rendered.result.response.citations, rendered.fallbacks]).toEqual([[], undefined, [], 0]);
      expect(rendered.outcome).toBe(state === "complete" ? "not_found" : "partial");
      if (state === "complete") expect(part).toMatchObject({ status: "not_found", gap: "I couldn't find this in the sources you can access.", gap_details: { not_found: "I couldn't find this in the sources you can access." } });
      else expect(part).not.toHaveProperty("gap_details");
      if (state === "truncated") expect(part.gap).toContain(LEG);
    });
  it("ignores a list block's title and never releases it: a list block has none (ADR-0054)", async () => {
    const title = "Tickets mentioning the recall";
    const reply = writerReply([REVIEW]);
    const rendered = await alone({ bundle: eightAnd1([C(["E9"])]), replies: [{ ...reply, blocks: [...reply.blocks, { block: "list", list: "L1", members: ["E1", "E2"], title }] }] }).render("Which tickets mention the recall?");
    const part = rendered.result.response.parts[0]!;
    expect(part.statements.map(statement => statement.text)).toEqual([REVIEW.text, `2 of the 8 tickets created on October 4, 2026: ${facts(1)}; ${facts(2)}.`]);
    expect(blocksOf(rendered).map(block => "title" in block)).toEqual([false, false]);
    expect(JSON.stringify(rendered.result.response)).not.toMatch(/mentioning/iu);
  });
  it("leaves an explicit none's absence untyped over an incomplete list no which_items need cites", async () => {
    const research = listBundle(50, 1, [list("L1", ids(1, 50), { unverified_end: true })], [C(["E51"])]);
    const rendered = await alone({ bundle: research, replies: [writerReply([{ text: "The review approved the plan.", evidence: ["E51"] }], { lists: [{ id: "L1", members: [] }], not_found: ["tickets assigned to Casey"] })] })
      .render("What did the review approve, and which tickets are Casey's?");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual(["The review approved the plan."]);
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap_details");
  });

  it("keeps a selected no-match over a list read to its end typed beside the retry line when research stopped", async () => {
    const research: AgenticEvidenceBundleV1 = { ...listBundle(2, 0, [list("L1", ids(1, 2))], [WI(["L1"])]), stop: { reason: "budget", completed: false } };
    const rendered = await alone({ bundle: research, replies: [{ ...use({ id: "L1", where: { field: "status", value: "Blocked" } }), not_found: ["the Harbor owner"] }] })
      .render("Which tickets are blocked, and who owns Harbor?");
    const part = rendered.result.response.parts[0]!;
    expect(rendered.outcome).toBe("partial");
    expect(part.gap).toMatch(/^I couldn't complete the search\. Please try again\./u);
    // Code checked the selection against every row of a list read to its end; only the writer's own absence waits for research.
    expect(part.gap_details).toEqual({ interrupted: true, not_found: "Not found: tickets created on October 4, 2026 that have status Blocked." });
  });

  it("types writer absence beside a which_say list the answer does not use: a need's kind decides nothing (ADR-0054)", async () => {
    const rendered = await alone({ bundle: eightAnd1([WS(["L1", "E9"])]), replies: [writerReply([], { not_found: ["the requested topic"] })] }).render("Which tickets mention the topic?");
    expect(rendered.outcome).toBe("not_found");
    // Code says nothing about how many of the list's members research read (ADR-0054).
    expect(rendered.result.response.parts[0]!.gap).toBe("Not found: the requested topic.");
    expect(rendered.result.response.parts[0]!.gap_details).toEqual({ not_found: "Not found: the requested topic." });
  });

  // The writer's free text says what a where selection would: over a list not read to its end, or one whose filter could
  // not test every item, it is no more a confirmed absence.
  it.each(["complete", "truncated", "unverified", "unchecked"] as const)("types a writer's no-match beside a list it places only after verified complete coverage: %s", async state => {
    const extra = state === "truncated" ? { ended: false, truncated: true } : state === "unverified" ? { unverified_end: true }
      : state === "unchecked" ? { unchecked: { count: 1, dates: ["created" as const] } } : {};
    const research: AgenticEvidenceBundleV1 = { ...listBundle(25, 0, [list("L1", ids(1, 25), extra)], []),
      plan: [{ part: 1, question: "Which tickets are blocked?", notes: "", needs: [{ need: "blocked tickets", kind: "which_items", status: "not_found", evidence: ["L1"] }] }] };
    // The list the writer places, not the need's status, decides: its coverage leaves the absence unproven (ADR-0054).
    const rendered = await alone({ bundle: research, replies: [writerReply([], { lists: [{ id: "L1" }], not_found: ["blocked tickets"] })] }).render("Which tickets are blocked?");
    expect(rendered.outcome).toBe("partial");
    if (state === "complete") expect(rendered.result.response.parts[0]!.gap_details).toEqual({ not_found: "Not found: blocked tickets." });
    else expect(rendered.result.response.parts[0]).not.toHaveProperty("gap_details");
  });

  // A not_found which_items need that cites no list says nothing of the writer's absence (ADR-0054): only a list the
  // answer uses can leave it unconfirmed.
  it.each(["complete", "truncated"] as const)("types a writer's no-match beside a which_items need citing no list, whatever the lists research read: %s", async state => {
    const research: AgenticEvidenceBundleV1 = { ...listBundle(25, 0, [list("L1", ids(1, 25), state === "truncated" ? { ended: false, truncated: true } : {})], []),
      plan: [{ part: 1, question: "Which tickets are blocked?", notes: "", needs: [{ need: "blocked tickets", kind: "which_items", status: "not_found", evidence: [] }] }] };
    const rendered = await alone({ bundle: research, replies: [writerReply([], { not_found: ["blocked tickets"] })] }).render("Which tickets are blocked?");
    expect(rendered.outcome).toBe("not_found");
    expect(rendered.result.response.parts[0]!.gap_details).toEqual({ not_found: "Not found: blocked tickets." });
  });

  it("leaves a missing fact untyped beside a placed list that was not read to its end (ADR-0054)", async () => {
    // The writer's not_found says nothing of which list it is about, so a list the answer uses that was cut short leaves it unproven.
    const research: AgenticEvidenceBundleV1 = { ...listBundle(25, 0, [list("L1", ids(1, 25), { ended: false, truncated: true })], []),
      plan: [{ part: 1, question: "Which tickets were created on October 4, and who owns Harbor?", notes: "", needs: [
        { need: "tickets created on October 4", kind: "which_items", status: "found", evidence: ["L1"] },
        { need: "the Harbor owner", status: "not_found", evidence: [] },
      ] }] };
    const rendered = await alone({ bundle: research, replies: [writerReply([], { lists: [{ id: "L1" }], not_found: ["the Harbor owner"] })] })
      .render("Which tickets were created on October 4, and who owns Harbor?");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]!.statements[0]!.text).toMatch(/^At least 25 tickets created on October 4, 2026/u);
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap_details");
  });

  it("gives the writer final list coverage instead of superseded page truncation", async () => {
    const complete = list("L1", ids(1, 4));
    const incomplete = list("L2", ids(5, 4), { filter: { status: "open" }, filter_applied: { status: "applied" }, ended: false });
    const research = listBundle(8, 0, [complete, incomplete], [WI(["L1", "L2"])]);
    const failed = { tool: "list", source: "pages", returned_items: 0, truncated: false, notice: false, unavailable: true };
    const limitedOpen = { tool: "open", source: "tickets", returned_items: 1, truncated: true, notice: true, unavailable: false };
    const run = alone({
      bundle: { ...research, coverage: { reads: [
        { tool: "list", source: "tickets", returned_items: 2, truncated: true, notice: false, unavailable: false },
        { tool: "list", source: "tickets", returned_items: 2, truncated: false, notice: false, unavailable: false },
        failed, limitedOpen,
      ], inventories: [], notices: ["A ticket body was incomplete."] } },
      replies: [use({ id: "L1" }, { id: "L2" })],
    });
    await run.render("Which tickets are open?");
    const coverage = run.prompt(0).research;
    expect(coverage.reads).toEqual([
      failed, limitedOpen,
      expect.objectContaining({ tool: "list", list: "L1", source: "tickets", filter: complete.filter, returned_items: 4, complete: true, truncated: false, unavailable: false }),
      expect.objectContaining({ tool: "list", list: "L2", source: "tickets", filter: incomplete.filter, returned_items: 4, complete: false, truncated: false, unavailable: false }),
    ]);
    expect(coverage.notices).toEqual(["A ticket body was incomplete."]);
    expect(run.prompt(0).lists).toEqual([
      expect.objectContaining({ id: "L1", count: 4, complete: true }),
      expect.objectContaining({ id: "L2", count: 4, complete: false }),
    ]);
  });
  it("removes repeats before the statement bound and keeps coverage for the last retained detail", async () => {
    const research = listBundle(1, 9, [list("L1", ["E1"])], [WI(["L1"])]);
    const run = alone({
      bundle: { ...research, rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [
        { tool: "open", args: { id: "E10" }, result: { items: [], opened: ["E10"], truncated: true } },
      ] }] },
      replies: [say(
        { text: "Record 1 applies.", evidence: ["E2"] },
        ...Array.from({ length: 9 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${index + 2}`] })),
      )],
    });
    const rendered = await run.render("Which tickets and what applies?");
    // Nine distinct sentences: the writer placed no list, so code states none (ADR-0054).
    expect(rendered.result.response.parts[0]!.statements).toHaveLength(9);
    expect(rendered.result.response.parts[0]!.statements.at(-1)!.text).toBe("Record 9 applies.");
    expect(rendered.result.response.parts[0]!.gap).toBeUndefined();
    expect(rendered.result.response.notice).toBe("Some source coverage was incomplete, so relevant context may be missing.");
    expect(rendered.outcome).toBe("answered");
  });
  it("counts a list the writer was not shown, and a member not in the list it names, as ids dropped", async () => {
    const run = alone({ bundle: eightAnd1([C(["E9"])]), replies: [writerReply([REVIEW], { lists: [{ id: "L2" }, { id: "L1", members: ["E1", "E10"] }] })] });
    const { rendered, corrections } = await observed(() => run.render("Which tickets?"));
    // L2 names nothing; L1's use keeps only E1, its member.
    expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([REVIEW.text, expect.stringContaining(facts(1))]);
    expect(rendered.result.response.citations).toHaveLength(2);
    expect(corrections).toEqual({ writer_unknown_id_dropped: 2 });
  });
  it("leaves out whole a sentence citing more items than a sentence may, never releasing it without its private citation", async () => {
    // 41 readable records, only E41 private: cut to its first 12 ids, the sentence would be released public.
    const research = records(41);
    const bundle41: AgenticEvidenceBundleV1 = { ...research, items: research.items.map(entry => entry.short === "E41" ? { ...entry, item: { ...entry.item, visibility: "only_me" as const } } : entry) };
    const run = alone({ bundle: bundle41, replies: [writerReply([{ text: "The reviews approved all forty-one.", evidence: ids(1, 41) }, { text: "The review approved record 1.", evidence: ["E1"] }])] });
    const { rendered, corrections } = await observed(() => run.render("What did the reviews approve?"));
    expect(rendered.result.response.parts[0]!.statements).toEqual([{ text: "The review approved record 1.", citation_indexes: [0], private: false }]);
    expect(rendered.cited).toEqual(["E1"]);
    expect(corrections).toMatchObject({ model_entry_dropped: 1 });
    expect(corrections).not.toHaveProperty("model_items_capped");
  });
  it("separates a missing fact from output-fit diagnostics", async () => {
    // A sentence whose list id brings 45 private rows would cite past a statement's 40: it is left out, and says so.
    const rendered = await alone({ bundle: listBundle(45, 2, [list("L1", ids(1, 45))], [C(["E46", "E47"])]), replies: [writerReply([
      { text: REVIEW.text, evidence: ["E46"] }, { text: "The fixture work waits on the review.", evidence: ["L1", "E47"] },
    ], { not_found: ["the approver"] })] }).render("What did the review approve, and who approved it?");
    const part = rendered.result.response.parts[0]!;
    expect(part.gap_details).toEqual({ not_found: "Not found: the approver." });
    expect(part.gap).toBe(`Not found: the approver. ${FIT}`);
    expect(part.gap).not.toBe(part.gap_details!.not_found);
  });
  type Rendered = Awaited<ReturnType<ReturnType<typeof alone>["render"]>>;
  interface Row {
    readonly id: string; readonly name: string; readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly q?: string;
    readonly status: string; readonly says?: readonly unknown[]; readonly gap?: string; readonly calls?: number; readonly repaired?: true;
    readonly cited?: readonly string[]; readonly citations?: number; readonly check?: (rendered: Rendered, run: ReturnType<typeof alone>) => void;
  }
  /** One row: the bundle research gave, the writer's replies, and the part, its outcome, the writer calls and what it cites. */
  const rows = (values: readonly Row[]) => { for (const row of values) it(`${row.id}: ${row.name}`, async () => {
    const run = alone({ bundle: row.bundle, replies: row.replies });
    const rendered = await run.render(row.q ?? "Which tickets were created on October 4?");
    const part = rendered.result.response.parts[0]!;
    expect({ outcome: rendered.outcome, status: part.status, gap: part.gap, calls: run.trace.filter(step => step === "generate").length })
      .toEqual({ outcome: row.status === "answered" ? "answered" : "partial", status: row.status, gap: row.gap, calls: row.calls ?? 1 });
    if (row.says !== undefined) expect(part.statements.map((value, index) => typeof row.says![index] === "object" && row.says![index] !== null && "text" in row.says![index] ? value : value.text)).toEqual(row.says);
    if (row.repaired) expect(run.prompt(1).validation_error).toContain(ROWS_REASON);
    if (row.cited !== undefined) expect(rendered.cited).toEqual(row.cited);
    if (row.citations !== undefined) expect(rendered.result.response.citations).toHaveLength(row.citations);
    row.check?.(rendered, run);
  }); };

  rows([
    { id: "W1, W3", name: "leaves out a sentence naming some of a list's rows after its one repair, keeps the others, and states no list for a content plan", bundle: eightAnd1([C(["E9"])]),
      replies: Array.from({ length: 2 }, () => say({ text: "THERM-1, THERM-2 and THERM-3 are in progress.", evidence: ids(1, 3) }, REVIEW)), calls: 2, status: "partial", gap: UNSUPPORTED, says: [st(REVIEW.text, 1, true)], cited: ["E9"],
      check: (rendered, run) => {
        expect(run.trace).toEqual([`context:E9,${ids(1, 8).join(",")}`, "revalidate", "generate", "revalidate", "generate"]);
        expect(run.prompt(0).lists[0]).toMatchObject({ id: "L1", count: 8 });
        expect(run.prompt(1).validation_error).toBe(`Your previous reply could not be used: ${ROWS_REASON}. Reply again with only the JSON object, in exactly the shape your instructions show.`);
        expect(rendered.result.writer_evidence).toEqual(["E9", ...ids(1, 8)]); } },
    { id: "CF2", name: "leaves out a repeated rows sentence beside the list the writer places", bundle: eightAnd1([WI(["L1", "E9"])]), replies: [sayWithL1(FOUR), sayWithL1(FOUR)], calls: 2, repaired: true, status: "partial", gap: UNSUPPORTED, says: [EIGHT] },
    // E9 is text the writer read, outside the list: the sentence stands on it (W1). The rows it cites beside it are cited
    // too, since it may carry their facts (W6); its list id supports nothing and brings the list's private rows the writer saw.
    { id: "W1, W6", name: "stands a sentence on the text it cites beside the list the writer places, and cites after it the rows it names and its list's private rows", bundle: eightAnd1([WI(["L1"])]), replies: [sayWithL1({ ...FOUR, evidence: [...FOUR.evidence, "E9"] })], status: "answered", says: [st(FOUR.text, 9), st(EIGHT, [1, 2, 3, 4, 5, 6, 7, 8])] },
    { id: "W1, W6", name: "cites every private row its list id brings, for a content plan", bundle: eightAnd1([C(["E9"])]), replies: [say({ ...FOUR, evidence: [...FOUR.evidence, "E9"] })], status: "answered", says: [st(FOUR.text, 9)] },
    { id: "W1, W6", name: "cites only the list's private rows: E9, then THERM-1 to THERM-4 by id with THERM-2 the one only_me row", bundle: teamRows(eightAnd1([C(["E9"])]), ["E2"]), replies: [say({ ...FOUR, evidence: [...FOUR.evidence, "E9"] })], status: "answered", says: [st(FOUR.text, 5)], cited: ["E9", "E2", "E1", "E3", "E4"] },
    ...[["E2", "E9"], ["L1", "E9"], ["E9", "L1"]].map((evidence): Row => ({
      id: "X35a", name: `makes a sentence citing ${evidence.join(" and ")} private beside team text, citing the private row the person can open`, bundle: teamRows(eightAnd1([C(["E9"])]), ["E2"]), replies: [say({ text: WAITS, evidence })],
      q: "What waits on the approved record?", status: "answered", says: [st(WAITS, 2)], cited: ["E9", "E2"], check: visibility(["decision", "team"], ["ticket", "only_me"]),
    })),
    { id: "X35b", name: "cites its text alone through a list with no private row the writer saw", bundle: teamRows(eightAnd1([C(["E9"])])), replies: [say({ text: WAITS, evidence: ["L1", "E9"] })], q: "What waits on the approved record?", status: "answered", says: [st(WAITS, 1, true)], cited: ["E9"] },
    { id: "X35e", name: "brings nothing through the id of a list the writer was not shown", bundle: eightAnd1([C(["E9"])]), replies: [say({ ...REVIEW, evidence: ["L7", "E9"] })], q: "What did the review approve?", status: "answered", says: [st(REVIEW.text, 1, true)] },
    ...[false, true].map((team): Row => {
      // 45 only_me rows: a sentence citing L1 beside team text would cite 46 items, past the answer's 40. The rows a list id
      // brings take no slot of the writer's 12 ids; it is kept whole or left out with every one after it, never cut to fit.
      const research = listBundle(45, 2, [list("L1", ids(1, 45))], [C(["E46", "E47"])]);
      return {
        id: "X35e", name: team ? "keeps all three sentences over team rows" : "leaves out a sentence whose list id would pass a statement's 40 citations, and keeps the ones after it", bundle: team ? teamRows(research) : research,
        replies: [say({ text: REVIEW.text, evidence: ["E46"] }, { text: "The fixture work waits on the review.", evidence: ["L1", "E47"] }, { text: "The review closed.", evidence: ["E46"] })],
        q: "What did the review approve?", ...(team
          ? { status: "answered", check: (rendered: Rendered) => expect(rendered.result.response.parts[0]!.statements.map(value => value.citation_indexes)).toEqual([[0], [1], [0]]) }
          : { status: "partial", gap: FIT, says: [st(REVIEW.text, 1, true), st("The review closed.", 1, true)], check: (_: Rendered, run: ReturnType<typeof alone>) => expect(run.prompt(0).lists[0].members).toHaveLength(45) }),
      };
    }),
    // Eleven team records (E9..E19) and one only_me row (E1, of L2), with L1 (seven team rows) before, among or after them:
    // thirteen ids, over the schema's 12. A list id takes no item's slot, so the row stays and the sentence is private.
    ...[[...ids(9, 11), "E1", "L1"], ["L1", ...ids(9, 11), "E1"], [...ids(9, 5), "L1", ...ids(14, 6), "E1"]].map((evidence, index): Row => ({
      id: "rev 13", name: `keeps a sentence's first 12 item ids past the cap with its list id ${["after", "before", "among"][index]} them, so a list id never takes a private row's place`,
      bundle: teamRows(listBundle(8, 11, [list("L1", ids(2, 7)), list("L2", ["E1"])], [C(ids(9, 11))]), ["E1"]), replies: [say({ text: "THERM-1 waits on the approved records.", evidence })],
      q: "What waits on the approved records?", status: "answered", says: [st("THERM-1 waits on the approved records.", 12)], cited: [...ids(9, 11), "E1"],
    })),
    { id: "W1, W5", name: "leaves out a rows sentence beside a content sentence after one repair, the kept one citing L1's rows after its text", bundle: eightAnd1([WI(["L1"])]), replies: [sayWithL1(FOUR, ON_THEM), sayWithL1(FOUR, ON_THEM)], calls: 2, repaired: true, q: "Which tickets were created on October 4, and what did the review approve?", status: "partial", gap: UNSUPPORTED, says: [EIGHT, st(ON_THEM.text, [8, 0, 1, 2, 3, 4, 5, 6, 7])] },
    { id: "W1, W5", name: "adds no gap for a which_say need, and notes no sentence (ADR-0054)", bundle: eightAnd1([WI(["L1"]), WS(["L1", "E9"])]), replies: [sayWithL1(FOUR, ON_THEM), sayWithL1(FOUR, ON_THEM)], calls: 2, q: "Which tickets were created on October 4, and what did the review approve?", status: "partial", gap: UNSUPPORTED, says: [EIGHT, st(ON_THEM.text, [8, 0, 1, 2, 3, 4, 5, 6, 7])] },
    { id: "CF5b", name: "says 'at least' for a list not read to a confirmed end, and leaves out a count resting on one row and the list's id", bundle: listBundle(25, 0, [list("L1", ids(1, 25), { unverified_end: true })], [WI(["L1"])]),
      replies: Array.from({ length: 2 }, () => sayWithL1({ text: "25 tickets were created on October 4, 2026.", evidence: ["L1", "E1"] })), calls: 2, status: "partial", gap: `${LEG} ${UNSUPPORTED}`, says: [st(`At least 25 tickets created on October 4, 2026: ${names(1, 25)}.`, 25)] },
    // Opened ticket rows carry their text: citing it is citing text, whatever it says.
    ...([[[C(["E1"])], ["THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]], [[WI(["L1"])], ["THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]], [[WI(["L1"]), C(["E1"])], ["THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]]] as const)
      .map(([needs, says]): Row => ({
        id: "W4", name: `${needs.length === 2 ? "keeps sentences on what a content need asks about, stating no list the writer did not place" : needs[0]!.kind === undefined ? "states no list for a content need: both sentences stand on their text" : "keeps distinct text as written regardless of planner kind (ADR-0054)"}`,
        bundle: Object.freeze({ ...EMPTY_BUNDLE, lists: [list("L1", ids(1, 5))], plan: planOf(needs), items: Array.from({ length: 5 }, (_, index) => ({ short: `E${index + 1}`, source: "tickets", item: ticketRow(index + 1, `THERM-${index + 1}: work ${index + 1} is in progress.`), full: true, opened: true, preloaded: false, touched: index + 1, cited_by_plan: needs.some(need => need.evidence.includes(`E${index + 1}`)) })) }),
        replies: [say({ text: "THERM-1 and THERM-2 were created on October 4.", evidence: ["E1", "E2"] }, { text: "THERM-1 is in progress.", evidence: ["E1"] })], status: "answered", says,
      })),
    // Members by id are named with their row facts (W2); every member by id is the whole list, so it says which items exist (ADR-0054).
    ...([[ids(1, 3), `3 tickets created on October 4, 2026: ${facts(1, 3)}.`, 3], [["E2", "E9"], `1 of the 3 tickets created on October 4, 2026: ${facts(2)}.`, 1]] as const).map(([members, text, count]): Row => ({
      id: "W2", name: `states the row facts of ${count === 3 ? "every member" : "one member"} the writer selects by id, from their own rows`, bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]),
      replies: [use({ id: "L1", members })], q: "Which tickets are in progress?", status: "answered", says: [st(text, count)],
    })),
    { id: "C4", name: "states one member's facts on a list not read to a confirmed end, the lead saying 'at least', and the list-end gap of a list it uses", bundle: listBundle(25, 1, [list("L1", ids(1, 25), { unverified_end: true })], [C(["E26"])]), replies: [use({ id: "L1", members: ["E2"] })], q: "Who owns THERM-2?", status: "partial", gap: LEG, says: [st(`1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`, 1)] },
    { id: "C4b (misdeclared)", name: "keeps the explicit member selection and its incomplete-list gap", bundle: listBundle(25, 1, [list("L1", ids(1, 25), { unverified_end: true })], [WI(["L1"])]), replies: [use({ id: "L1", members: ["E2"] })], q: "Who owns THERM-2?", status: "partial", gap: LEG, says: [`1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`], citations: 1 },
    // A list cut short: a use in full or by where says which items exist, with the list-end gap; a selection by id alone never does.
    { id: "R9 (iii)", name: "states an explicit selection covering the whole declared list with its full lead and gap", bundle: cut(1, [WI(["L1"])]), replies: [use({ id: "L1", members: ids(1, 25) })], status: "partial", gap: LEG, says: [`At least 25 tickets created on October 4, 2026: ${facts(1, 25)}.`] },
    { id: "R9 (iv)", name: "names only the ten selected members with their facts and incomplete-list gap", bundle: cut(1, [WI(["L1"])]), replies: [use({ id: "L1", members: ids(1, 10) })], q: "Which tickets created on October 4 are in review or blocked?", status: "partial", gap: LEG, says: [`10 of at least 25 tickets created on October 4, 2026: ${facts(1, 10)}.`], citations: 10 },
    ...([[10, "R9 (v)"], [25, "R9 (vi)"]] as const).map(([count, id]): Row => ({
      id, name: `states only the facts of ${count} members by id beside a content need, with the list-end gap of a list it uses`, bundle: cut(1, [C(["E26"])]),
      replies: [use({ id: "L1", members: ids(1, count) })], q: "Which tickets created on October 4 are in review or blocked?", status: "partial", gap: LEG,
      // Every member by id is the whole list, which says which items exist (ADR-0054).
      says: [st(`${count === 25 ? "At least 25" : `${count} of at least 25`} tickets created on October 4, 2026: ${facts(1, count)}.`, count)],
    })),
    { id: "R9 (i)", name: "says 'at least' with the list-end gap for a stated list in full", bundle: reviewed(), replies: [use({ id: "L1" })], status: "partial", gap: LEG, says: [`At least 25 tickets created on October 4, 2026: ${[...names(1, 5).split("; ").map(name => `${name} (In Review)`), ...names(6, 20).split("; ").map(name => `${name} (In Progress)`)].join("; ")}.`] },
    { id: "R9 (ii)", name: "says how many were listed for a where selection", bundle: reviewed(), replies: [use({ id: "L1", where: { field: "status", value: "in review" } })], q: "Which tickets created on October 4 are in review?", status: "partial", gap: LEG, says: [`At least 5 tickets created on October 4, 2026 have status In Review (25 listed so far): ${names(1, 5)}.`] },
    { id: "X24c", name: "leaves out a sentence resting on rows alone after its repair: nothing survives, and the fallback shows the record research read", bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]),
      replies: Array.from({ length: 2 }, () => say({ text: "THERM-2 is in progress.", evidence: ["E2"] })), calls: 2, repaired: true, q: "Is THERM-2 in progress?", status: "records_only", says: [], gap: RECORDS,
      check: rendered => expect(rendered.result.response.parts[0]!.records).toEqual([expect.objectContaining({ text: "Approved record 1.", citation_indexes: [0] })]) },
    { id: "X24c", name: "answers the repair's selection by id", bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]), replies: [say({ text: "THERM-2 is in progress.", evidence: ["E2"] }), use({ id: "L1", members: ["E2"] })], calls: 2, q: "Is THERM-2 in progress?", status: "answered", says: [`1 of the 3 tickets created on October 4, 2026: ${facts(2)}.`] },
    ...([["X24a", WS(["L1", "E9"]), undefined], ["X24b", WI(ids(1, 8)), "I could not confirm the full list of items asked for."]] as const).map(([id, need, gap]): Row => ({
      id, name: `gives the records a failed writer falls back to ${id === "X24a" ? "with no gap for a which_say list (ADR-0054)" : "the gap of a which_items need left on rows"}`, bundle: eightAnd1([need]), replies: [{ wrong: true }, { still: "wrong" }], calls: 2,
      q: "Which tickets created on October 4 mention BUG-412?", status: "records_only", gap: gap === undefined ? RECORDS : `${RECORDS} ${gap}`, check: rendered => expect(rendered.result.response.parts[0]!.records).toEqual([expect.objectContaining({ text: "Approved record 1." })]),
    })),
    ...[[REVIEW], [REVIEW, { text: "THERM-2 is in progress.", evidence: ["E2"] }]].map((sentences): Row => ({
      id: "W1", name: sentences.length === 1 ? "keeps the writer's sentence as written with no model call left for a repair" : "leaves out a rows sentence it cannot send back, and says so",
      bundle: eightAnd1([WI(["L1"]), C(["E9"])], { ...EMPTY_BUNDLE.budget, max_model_calls: 1 }), replies: [writerReply(sentences)], says: [REVIEW.text],
      ...(sentences.length === 1 ? { status: "answered", check: (rendered: Rendered) => expect(rendered.fallbacks).toBe(0) } : { status: "partial", gap: UNSUPPORTED }),
    })),
    { id: "W6", name: "names every member of two lists: no share of names, a list past 40 members in more statements", bundle: listBundle(68, 0, [list("L1", ids(1, 8)), list("L2", ids(9, 60))], [WI(["L1", "L2"])]), replies: [use({ id: "L1" }, { id: "L2" })], status: "answered",
      says: [EIGHT, `60 tickets created on October 4, 2026: ${names(9, 40)}.`, `60 tickets created on October 4, 2026: ${names(49, 20)}.`], citations: 68 },
    {
      // E1, E2 and E8 share a title and row facts, so they are one name; E2 alone is private. Every member a name covers is cited.
      id: "X25", name: "cites every member a merged name covers, so it never covers a private member uncited (W6)", replies: [use({ id: "L1" }, { id: "L1", members: ids(3, 25) })], status: "answered",
      bundle: (research => Object.freeze({ ...research, items: research.items.map((entry, index) => Object.freeze({ ...entry, item: { ...entry.item, visibility: index === 1 ? "only_me" as const : "team" as const, ...(index < 2 ? { label: "THERM-8: Fixture work 8" } : {}) } })) }))(listBundle(27, 0, [list("L1", ids(1, 27))], [WI(["L1"])])),
      says: [st(`27 tickets created on October 4, 2026: THERM-8: Fixture work 8 (3 tickets); ${names(3, 5)}; ${names(9, 19)}.`, 27), { text: expect.stringMatching(/^25 of the 27 tickets created on October 4, 2026: THERM-3: /u), citation_indexes: expect.any(Array), private: false }],
      cited: ids(1, 27) },
    { id: "W6", name: "keeps every statement past ADR-0041's 40 citations: an answer has no count of its own", bundle: listBundle(60, 20, [list("L1", ids(1, 60))], [WI(["L1"])]), q: "Which tickets were created on October 4, and what applies?",
      replies: [writerReply(Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${61 + 2 * index}`, `E${62 + 2 * index}`] })), { lists: [{ id: "L1" }] })],
      // The answer, the list's 60 rows in two statements, then the other nine sentences of two citations each: 80 in all.
      status: "answered", citations: 80, cited: [...ids(61, 2), ...ids(1, 60), ...ids(63, 18)],
      check: rendered => expect(rendered.result.response.parts[0]!.statements.map(value => value.text)).toEqual(["Record 1 applies.", expect.stringMatching(/^60 tickets /u), expect.stringMatching(/^60 tickets /u), ...Array.from({ length: 9 }, (_, index) => `Record ${index + 2} applies.`)]) },
    { id: "W6", name: "keeps every statement past ADR-0041's ten", bundle: listBundle(63, 10, [list("L1", ids(1, 60)), list("L2", ids(61, 3))], [WI(["L1", "L2"])]), q: "Which tickets?", status: "answered",
      replies: [writerReply(Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${64 + index}`] })), { lists: [{ id: "L1" }, { id: "L2" }] })],
      check: rendered => expect(rendered.result.response.parts[0]!.statements.map(value => value.text).slice(4)).toEqual(Array.from({ length: 9 }, (_, index) => `Record ${index + 2} applies.`)) },
    { id: "W6", name: "gives a listed ticket's row and its opened body one citation", q: "Which tickets were created on October 4, and why is DVT blocked?", status: "answered", citations: 1,
      bundle: Object.freeze({
        ...EMPTY_BUNDLE, lists: [list("L1", ["E1"])], plan: planOf([WI(["L1"]), C(["E2"])]),
        // Research opened the row, and the open returned its body: the list's one member was checked.
        rounds: [{ round: 1, elapsed_ms: 0, plan: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"] } }], rejected: [] }],
        items: [
          { short: "E1", source: "tickets", item: ticketRow(46), full: false, opened: false, preloaded: false, touched: 1, cited_by_plan: false },
          { short: "E2", source: "tickets", item: ticketRow(46, "THERM-46: BUG-412 blocks DVT."), full: true, opened: true, preloaded: false, touched: 2, cited_by_plan: true },
        ],
      }),
      replies: [writerReply([{ text: "THERM-46 is blocked by BUG-412.", evidence: ["E2"] }], { lists: [{ id: "L1" }] })],
      says: [st("THERM-46 is blocked by BUG-412.", 1), st("1 ticket created on October 4, 2026: THERM-46: Fixture work 46.", 1)] },
  ]);

  describe("as tables among blocks (answer layout v2, ADR-0051)", () => {
    const arranged = async (research: AgenticEvidenceBundleV1, reply: unknown) => {
      const rendered = await alone({ bundle: research, replies: [reply] }).render("Which tickets were created on October 4?");
      blocksOf(rendered);
      return rendered.result.response.parts[0]!;
    };
    /** Source notes with distinct identities, whose short display names need not repeat their source titles. */
    const document = (n: number): EvidenceDeskItemV2 => ({
      id: `document-${n}`, kind: "document_passage", label: `LIVE-QA-20261104-A Atlas ledger ${n}`, text: `Ledger ${n}: owner Casey; status open.`, visibility: "only_me",
      citation: { kind: "source_revision", source_id: `source:${canonicalSha256(n).slice(7)}`, revision_id: "revision-1", document_id: `doc_${canonicalSha256(n).slice(7)}`,
        source_sha256: canonicalSha256(`source-${n}`), representation_sha256: canonicalSha256(`text-${n}`), anchor_sha256: canonicalSha256(`anchor-${n}`) },
      receipt_sha256: canonicalSha256(`receipt-${n}`),
    });
    const fullListBundle = (source: string, items: readonly EvidenceDeskItemV2[], selected: readonly string[]): AgenticEvidenceBundleV1 => ({
      ...EMPTY_BUNDLE, lists: [list("L1", ids(1, items.length), { source })], plan: planOf([WI(["L1", ...selected])]),
      items: items.map((item, index) => ({ short: `E${index + 1}`, source, item, full: true, opened: true, preloaded: false, touched: index + 1, cited_by_plan: selected.includes(`E${index + 1}`) })),
    });
    it("keeps a selection of 43 whole, in statements of at most 40 citations", async () => {
      const selected = ids(5, 43);
      const rendered = await alone({ bundle: listBundle(100, 1, [list("L1", ids(1, 100))], [C(["E101"])]), replies: [writerReply([], { lists: [{ id: "L1", members: selected }] })] }).render("Which THERM tickets are To Do or In Progress?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([expect.stringMatching(/^43 of the 100 tickets/u), expect.stringMatching(/^43 of the 100 tickets/u)]);
      expect(rendered.cited).toEqual(selected);
    });
    it.each([false, true])("keeps all 43 selected tickets from a 100-ticket inventory without adding the inventory (split: %s)", async split => {
      const selected = ids(5, 43);
      const original = listBundle(100, 0, [list("L1", ids(1, 100))], [WI(["L1", ...selected])]);
      const research = { ...original, items: original.items.map((entry, index) => ({ ...entry, item: { ...entry.item, attributes: {
        ...entry.item.attributes, status: selected.includes(entry.short) ? index % 2 === 0 ? "To Do" : "In Progress" : "Done",
        ...(entry.short === selected.at(-1) ? { due_at: "2026-11-06" } : {}),
      } } })) };
      const groups = split ? [selected.slice(0, 25), selected.slice(25)] : [selected];
      // Each group is a list block of its own (ADR-0054): two blocks are two tables, each saying how many of the 100 it shows.
      const rendered = await alone({ bundle: research, replies: [{
        blocks: groups.map(members => ({ block: "list", list: "L1", members })), not_found: [],
      }] }).render("Which THERM tickets are To Do or In Progress? Show status, owner, due date.");
      const part = rendered.result.response.parts[0]!;
      const blocks = blocksOf(rendered);
      expect(part.status).toBe("answered");
      expect(part).not.toHaveProperty("gap");
      expect(blocks.map(block => block.kind === "table" ? block.caption : block.kind)).toEqual(groups.map(members => `${members.length} of the 100 tickets created on October 4, 2026`));
      const rows = blocks.flatMap(block => block.kind === "table" ? block.rows : []);
      const columns = blocks.at(-1)!.kind === "table" ? (blocks.at(-1) as Extract<(typeof blocks)[number], { kind: "table" }>).columns : [];
      expect(rows.map(row => row.cells[0])).toEqual(Array.from({ length: 43 }, (_, index) => `THERM-${index + 5}: Fixture work ${index + 5}`));
      expect(rows.at(-1)!.cells[columns.indexOf("Due")]).toBe("2026-11-06");
      expect(blocks.every(block => block.kind === "table" && block.rows.every(row => row.cells.length === block.columns.length))).toBe(true);
      expect(rendered.cited).toEqual(selected);
      expect(part.statements.every(statement => Buffer.byteLength(statement.text, "utf8") <= PERSON_ANSWER_STATEMENT_MAX_BYTES_V4 && statement.citation_indexes.length <= 40)).toBe(true);
      expect(part.statements.map(statement => statement.text).join(" ")).not.toContain("and 99 more");
    });
    it("reads a member selected by its opened body as that body's listed row", async () => {
      const research = listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"])]);
      const opened = { ...research, items: [...research.items, { short: "E4", source: "tickets", item: ticketRow(2, "THERM-2: the fixture passed."), full: true, opened: true, preloaded: false, touched: 4, cited_by_plan: false }] };
      const { rendered, corrections } = await observed(() => alone({ bundle: opened, replies: [{ blocks: [{ block: "list", list: "L1", members: ["E4"] }], not_found: [] }] }).render("Which ticket passed?"));
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E2"]);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`1 of the 3 tickets created on October 4, 2026: ${facts(2)}.`]);
      expect(corrections).not.toHaveProperty("writer_unknown_id_dropped");
    });
    it("keeps incomplete-list coverage for a list the writer places beside its points", async () => {
      const research = fullListBundle("documents", [document(1), document(2)], ["E1", "E2"]);
      const rendered = await alone({ bundle: { ...research, lists: [list("L1", ["E1", "E2"], { source: "documents", unverified_end: true })] }, replies: [{
        not_found: [], blocks: [{ block: "points", ordered: false, items: [1, 2].map(n => ({ text: `LIVE-QA-20261104-A Atlas ledger ${n} is open.`, evidence: [`E${n}`] })) }, { block: "list", list: "L1" }],
      }] }).render("Which ledger entries are open?");
      expect(rendered.outcome).toBe("partial");
      expect(rendered.cited).toEqual(["E1", "E2"]);
      expect(rendered.result.response.parts[0]!.gap).toContain("more may exist");
      // Two documents with nothing beside their titles read as the list's prose statement.
      expect(blocksOf(rendered).map(block => block.kind)).toEqual(["points", "text"]);
    });
    it("keeps a no-match filter empty", async () => {
      const rendered = await alone({ bundle: listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"])]), replies: [{
        blocks: [{ block: "list", list: "L1", where: { field: "status", value: "Done" } }], not_found: [],
      }] }).render("Which tickets are Done?");
      const part = rendered.result.response.parts[0]!;
      expect(part.status).toBe("not_found");
      expect(part.statements).toEqual([]);
    });
    it("does not append a research inventory the completed writer did not use", async () => {
      const part = await arranged(listBundle(3, 1, [list("L1", ids(1, 3))], [C(["L1", "E4"])]), {
        lists: [], not_found: [], blocks: [{ block: "answer", sentences: [{ ...REVIEW, evidence: ["E4"] }] }],
      });
      expect(part.statements.map(statement => statement.text)).toEqual([REVIEW.text]);
      expect(part.blocks).toEqual([{ kind: "answer", statements: [0] }]);
    });
    it("cuts a selection too large for the answer's bytes from its end, in its table, and marks it partial", async () => {
      const members = ids(1, 180);
      const rendered = await alone({ bundle: listBundle(180, 0, [list("L1", members)], [WI(["L1"])]), replies: [{
        blocks: [{ block: "list", list: "L1" }], not_found: [],
      }] }).render("Show every ticket with its owner and status.");
      const part = rendered.result.response.parts[0]!;
      expect(part).toMatchObject({ status: "partial", gap: FIT });
      expect(blocksOf(rendered).map(block => block.kind)).toEqual(["table"]);
      expect(rendered.cited).toEqual(members.slice(0, rendered.cited.length));
      expect(rendered.cited.length).toBeLessThan(members.length);
      expect(canonicalJsonBytes(rendered.result.response).byteLength).toBeLessThanOrEqual(PERSON_ANSWER_RESPONSE_MAX_BYTES_V4);
    });
    it("tabulates members selected by id with the dates they state, and keeps a list that names one member as text", async () => {
      const byId = await arranged(listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]), { not_found: [], blocks: [
        { block: "answer", sentences: [{ ...REVIEW, evidence: ["E4"] }] }, { block: "list", list: "L1", members: ["E1", "E2"] },
      ] });
      expect(byId.blocks![1]).toEqual({ kind: "table", statements: [1], columns: ["Item", "Status", "Owner", "Created"], caption: "2 of the 3 tickets created on October 4, 2026",
        rows: [1, 2].map(n => ({ cells: [`THERM-${n}: Fixture work ${n}`, "In Progress", "Dana Lee", "2026-10-04"], citation_indexes: [n] })) });
      const one = await arranged(listBundle(1, 1, [list("L1", ["E1"])], [WI(["L1"])]), { not_found: [], blocks: [
        { block: "answer", sentences: [{ ...REVIEW, evidence: ["E2"] }] }, { block: "list", list: "L1" },
      ] });
      expect(one.blocks).toEqual([{ kind: "answer", statements: [0] }, { kind: "text", statements: [1] }]);
    });
    // 45 only_me rows: an item citing L1 beside text would cite 46 items, past the 40 one statement may cite in blocks too.
    const pastOne = () => listBundle(45, 2, [list("L1", ids(1, 45))], [C(["E46", "E47"])]);
    const WAITS_ON = { text: "The fixture work waits on the review.", evidence: ["L1", "E47"] };
    it("leaves out whole an item whose list id would cite more than a statement's 40 items, and keeps the items after it (W6)", async () => {
      const part = await arranged(pastOne(), { lists: [], not_found: [], blocks: [
        { block: "answer", sentences: [{ ...REVIEW, evidence: ["E46"] }] },
        { block: "points", ordered: false, items: [WAITS_ON, { text: "The review closed.", evidence: ["E46"] }] },
      ] });
      expect(part.statements.map(value => value.text)).toEqual([REVIEW.text, "The review closed."]);
      expect(part).toMatchObject({ status: "partial", gap: FIT });
      expect(part.blocks).toEqual([{ kind: "answer", statements: [0] }, { kind: "text", statements: [1] }]);
    });
    it("leaves out whole an Ask again's since whose list id would cite more than a statement's 40 items", async () => {
      const rendered = await alone({
        bundle: pastOne(), replies: [{ lists: [], not_found: [], blocks: [{ block: "answer", sentences: [{ ...REVIEW, evidence: ["E46"] }] }], since: [WAITS_ON] }],
        earlier: { asked_on: "2026-10-05", statements: [{ text: "The review had not met.", sources: ["Approved record 1"] }] }, answers: "What did the review approve?",
      }).render("What did the review approve?");
      expect(rendered.result.response).not.toHaveProperty("since");
      expect(rendered.result.response.parts[0]!.statements.map(value => value.text)).toEqual([REVIEW.text]);
    });
  });

  describe("Ask renderer: a list the writer places (ADR-0054)", () => {
    const LIST_DROPPED = "A list was left out because its selection could not be read.";
    const UNRECORDED = "Some list items do not record the fact used to select them.";
    /** A reply whose answer is REVIEW, citing the record `on`, followed by the blocks given. */
    const placedOn = (on: string, ...blocks: readonly object[]) => ({ blocks: [{ block: "answer", sentences: [{ ...REVIEW, evidence: [on] }] }, ...blocks], not_found: [] });
    const placing = (...blocks: readonly object[]) => placedOn("E9", ...blocks);
    const statementsOf = (rendered: Rendered) => rendered.result.response.parts[0]!.statements.map(statement => statement.text);
    /** Eight rows and one record, the first three rows in review. */
    const threeInReview = (): AgenticEvidenceBundleV1 => {
      const research = eightAnd1([C(["E9"])]);
      return Object.freeze({ ...research, items: research.items.map((entry, index) => index < 3 ? Object.freeze({ ...entry, item: { ...entry.item, attributes: { status: "In Review", owner: "Dana Lee" } } }) : entry) });
    };

    it("fills a whole list from the desk, past the rows the writer was shown", async () => {
      // 80 rows whose long participant lists, which no statement names, fill the writer's half of the prompt: it is shown
      // only the first of them.
      const research = listBundle(80, 1, [list("L1", ids(1, 80))], [C(["E81"])]);
      const long = Object.freeze({ ...research, items: research.items.map(entry => entry.full ? entry : Object.freeze({ ...entry, item: { ...entry.item, attributes: { ...entry.item.attributes, participants: Array.from({ length: 40 }, (_, at) => `Person ${at + 1}`).join(", ") } } })) });
      const run = alone({ bundle: long, replies: [placedOn("E81", { block: "list", list: "L1" })] });
      const rendered = await run.render("Which tickets were created on October 4?");
      expect(run.prompt(0).lists[0].members_omitted).toBeGreaterThan(0);
      const table = blocksOf(rendered).find(block => block.kind === "table")!;
      if (table.kind !== "table") throw new Error("Expected the list as a table");
      expect([table.caption, table.rows.length]).toEqual(["80 tickets created on October 4, 2026", 80]);
      expect(rendered.result.response.citations).toHaveLength(81);
    });
    it("fills a list narrowed by one row fact and says shown of total", async () => {
      const rendered = await alone({ bundle: threeInReview(), replies: [placing({ block: "list", list: "L1", where: { field: "status", value: "in review" } })] }).render("Which tickets are in review?");
      const table = blocksOf(rendered).find(block => block.kind === "table")!;
      if (table.kind !== "table") throw new Error("Expected the selection as a table");
      expect([table.caption, table.rows.length]).toEqual(["3 of the 8 tickets created on October 4, 2026 have status In Review", 3]);
      expect(rendered.outcome).toBe("answered");
    });
    it("fills a hand-picked list only from rows the writer was shown", async () => {
      const research = listBundle(400, 1, [list("L1", ids(1, 400))], [C(["E401"])]);
      const run = alone({ bundle: research, replies: [placedOn("E401", { block: "list", list: "L1", members: ["E2", "E400"] })] });
      const { rendered, corrections } = await observed(() => run.render("Who owns THERM-2 and THERM-400?"));
      expect(run.prompt(0).lists[0].members.map((member: { id: string }) => member.id)).not.toContain("E400");
      expect(statementsOf(rendered)).toEqual([REVIEW.text, `1 of the 400 tickets created on October 4, 2026: ${facts(2)}.`]);
      expect(corrections).toMatchObject({ writer_unknown_id_dropped: 1 });
      const alonePast = await alone({ bundle: research, replies: [placedOn("E401", { block: "list", list: "L1", members: ["E400"] })] }).render("Who owns THERM-400?");
      expect(statementsOf(alonePast)).toEqual([REVIEW.text]);
      expect(alonePast.result.response.parts[0]).toMatchObject({ status: "partial", gap: LIST_DROPPED });
    });
    it("hand-picks a member by its opened text when its row is past the writer's window", async () => {
      // 80 rows whose long participant lists keep THERM-80's row past the writer's window; research opened its body as E81.
      const research = listBundle(80, 0, [list("L1", ids(1, 80))], [C(["E81"])]);
      const opened = Object.freeze({ ...research, items: [
        ...research.items.map(entry => Object.freeze({ ...entry, item: { ...entry.item, attributes: { ...entry.item.attributes, participants: Array.from({ length: 40 }, (_, at) => `Person ${at + 1}`).join(", ") } } })),
        Object.freeze({ short: "E81", source: "tickets", item: ticketRow(80, "THERM-80: BUG-412 blocks DVT."), full: true, opened: true, preloaded: false, touched: 81, cited_by_plan: true }),
      ] });
      const run = alone({ bundle: opened, replies: [placedOn("E81", { block: "list", list: "L1", members: ["E81"] })] });
      const rendered = await run.render("Who owns THERM-80?");
      expect(run.prompt(0).lists[0].members.map((member: { id: string }) => member.id)).not.toContain("E80");
      expect(statementsOf(rendered)).toEqual([REVIEW.text, `1 of the 80 tickets created on October 4, 2026: ${facts(80)}.`]);
      expect(rendered.result.response.parts[0]!.gap).toBeUndefined();
    });
    it("reports the limits only of lists the answer still uses after fitting", async () => {
      // A complete 180-row L1 placed first, then a sentence citing the cut-short L2: fitting leaves that sentence out.
      const research = listBundle(182, 1, [list("L1", ids(1, 180)), list("L2", ids(181, 2), { ended: false, truncated: true })], [C(["E183"])]);
      const rendered = await alone({ bundle: research, replies: [{ blocks: [
        { block: "answer", sentences: [{ ...REVIEW, evidence: ["E183"] }] }, { block: "list", list: "L1" },
        { block: "text", sentences: [{ text: "The review also covers the open work.", evidence: ["L2", "E183"] }] },
      ], not_found: ["the Harbor owner"] }] }).render("Which tickets were created on October 4, and who owns Harbor?");
      const part = rendered.result.response.parts[0]!;
      expect(statementsOf(rendered)).not.toContain("The review also covers the open work.");
      expect(part.gap).toContain(FIT);
      expect(part.gap).not.toContain(LEG);
      expect(part.gap_details).toEqual({ not_found: "Not found: the Harbor owner." });
    });
    it("counts no fallback when it releases the writer's first reply after a malformed repair", async () => {
      const run = alone({ bundle: eightAnd1([C(["E9"])]), replies: [writerReply([REVIEW, { text: "THERM-2 is in progress.", evidence: ["E2"] }], { lists: [{ id: "L1" }] }), { wrong: true }] });
      const { rendered, corrections } = await observed(() => run.render(Q));
      expect(run.trace.filter(step => step === "generate")).toHaveLength(2);
      expect(statementsOf(rendered)).toEqual([REVIEW.text, EIGHT]);
      expect(rendered.fallbacks).toBe(0);
      expect(corrections).not.toHaveProperty("writer_fallback");
    });
    it("drops a list block whose narrowing could not be read and says so", async () => {
      const rendered = await alone({ bundle: eightAnd1([C(["E9"])]), replies: [placing({ block: "list", list: "L1", members: "E5" })] }).render("Which tickets?");
      expect(statementsOf(rendered)).toEqual([REVIEW.text]);
      expect(rendered.result.response.parts[0]).toMatchObject({ status: "partial", gap: LIST_DROPPED });
      expect(rendered.result.response.citations).toHaveLength(1);
    });
    it("releases a placed list where the writer put it", async () => {
      const again = { block: "text", sentences: [{ text: "The review closed the fixture work.", evidence: ["E9"] }] };
      const after = await alone({ bundle: eightAnd1([C(["E9"])]), replies: [placing(again, { block: "list", list: "L1" })] }).render("Which tickets?");
      expect(blocksOf(after).map(block => block.kind)).toEqual(["answer", "text", "table"]);
      const before = await alone({ bundle: eightAnd1([C(["E9"])]), replies: [placing({ block: "list", list: "L1" }, again)] }).render("Which tickets?");
      expect(blocksOf(before).map(block => block.kind)).toEqual(["answer", "table", "text"]);
    });
    it("says none matched through the list's own not-found phrase, confirmed only for a complete list that records the fact", async () => {
      const NOBODY = "Not found: tickets created on October 4, 2026 that have owner Nobody.";
      const reply = placing({ block: "list", list: "L1", where: { field: "owner", value: "Nobody" } });
      const confirmed = await alone({ bundle: eightAnd1([C(["E9"])]), replies: [reply] }).render("Which tickets does Nobody own?");
      expect(blocksOf(confirmed).map(block => block.kind)).toEqual(["answer"]);
      expect(confirmed.result.response.parts[0]).toMatchObject({ gap: NOBODY, gap_details: { not_found: NOBODY } });
      const research = eightAnd1([C(["E9"])]);
      const unrecorded = { ...research, items: research.items.map((entry, index) => index === 0 ? { ...entry, item: { ...entry.item, attributes: { status: "In Progress" } } } : entry) };
      const untested = await alone({ bundle: unrecorded, replies: [reply] }).render("Which tickets does Nobody own?");
      expect(untested.result.response.parts[0]!.gap).toBe(`${NOBODY} ${UNRECORDED}`);
      expect(untested.result.response.parts[0]).not.toHaveProperty("gap_details");
    });
    it("says how many rows are shown when fitting cuts a placed list", async () => {
      const members = ids(1, 180);
      const rendered = await alone({ bundle: listBundle(180, 0, [list("L1", members)], [C([])]), replies: [{ blocks: [{ block: "list", list: "L1" }], not_found: [] }] })
        .render("Show every ticket with its owner and status.");
      const part = rendered.result.response.parts[0]!;
      const table = blocksOf(rendered).find(block => block.kind === "table")!;
      if (table.kind !== "table") throw new Error("Expected the list as a table");
      expect(table.rows.length).toBeLessThan(members.length);
      expect(table.caption).toMatch(new RegExp(`\\(first ${table.rows.length} shown\\)$`, "u"));
      expect(part.statements[table.statements[0]!]!.text).toMatch(/\(first \d+ shown\)\.$/u);
      expect(part.gap).toContain(FIT);
      expect(canonicalJsonBytes(rendered.result.response).byteLength).toBeLessThanOrEqual(PERSON_ANSWER_RESPONSE_MAX_BYTES_V4);
    });
    it("keeps a since sentence that cites a placed list private when a row the writer saw is", async () => {
      const rendered = await alone({
        bundle: eightAnd1([C(["E9"])]), replies: [{ ...placing({ block: "list", list: "L1" }), since: [{ text: "The review now covers the fixture work.", evidence: ["L1", "E9"] }] }],
        earlier: { asked_on: "2026-10-05", statements: [{ text: "The review had not met.", sources: ["Approved record 1"] }] }, answers: "Which tickets?",
      }).render("Which tickets?");
      expect(rendered.result.response.since!.statements[0]!.private).toBe(true);
    });
    it("keeps a sentence and a since sentence citing a placed list private when the block shows a private row the writer never saw", async () => {
      // 80 team rows whose long participant lists fill the writer's half of the prompt, the last approver-only and past the
      // writer's window, and the team record E81. The placed block shows every row, E80 among them.
      const research = teamRows(listBundle(80, 1, [list("L1", ids(1, 80))], [C(["E81"])]));
      const long = Object.freeze({ ...research, items: research.items.map(entry => entry.full ? entry : Object.freeze({ ...entry, item: { ...entry.item,
        ...(entry.short === "E80" ? { visibility: "approver_only" as const } : {}),
        attributes: { ...entry.item.attributes, participants: Array.from({ length: 40 }, (_, at) => `Person ${at + 1}`).join(", ") } } })) });
      const leans = { text: "The review covers the fixture work.", evidence: ["E81", "L1"] };
      const run = alone({
        bundle: long, replies: [{ blocks: [{ block: "answer", sentences: [leans] }, { block: "list", list: "L1" }], not_found: [], since: [leans] }],
        earlier: { asked_on: "2026-10-05", statements: [{ text: "The review had not met.", sources: ["Approved record 1"] }] }, answers: Q,
      });
      const rendered = await run.render(Q);
      expect(run.prompt(0).lists[0].members.map((member: { id: string }) => member.id)).not.toContain("E80");
      const part = rendered.result.response.parts[0]!;
      expect(part.statements[0]).toMatchObject({ text: leans.text, private: true });
      expect(rendered.result.response.since!.statements[0]!.private).toBe(true);
    });

    const LIST_FALLBACK = "I found these items, but could not write the rest of the answer.";
    const Q = "Which tickets were created on October 4?";
    it("takes the fallback only when nothing of the reply survives", async () => {
      const research = eightAnd1([WI(["L1"])]);
      const empty = await alone({ bundle: research, replies: [{ blocks: [], not_found: [] }] }).render(Q);
      expect([empty.fallbacks, statementsOf(empty), empty.result.response.parts[0]!.gap]).toEqual([1, [EIGHT], LIST_FALLBACK]);
      const missing = await alone({ bundle: research, replies: [{ blocks: [], not_found: ["tickets created on October 4"] }] }).render(Q);
      expect([missing.fallbacks, missing.result.response.parts[0]!.statements, missing.outcome]).toEqual([0, [], "not_found"]);
      // Something that survives makes a reply usable: one placed list alone, or one sentence alone.
      const listOnly = await alone({ bundle: research, replies: [{ blocks: [{ block: "list", list: "L1", members: ["E2"] }], not_found: [] }] }).render(Q);
      expect([listOnly.fallbacks, statementsOf(listOnly)]).toEqual([0, [`1 of the 8 tickets created on October 4, 2026: ${facts(2)}.`]]);
      // A sentence code leaves out (it cites no text) does not survive.
      const uncited = await alone({ bundle: research, replies: [{ blocks: [{ block: "answer", sentences: [{ text: "Nothing to see.", evidence: [] }] }], not_found: [] }] }).render(Q);
      expect([uncited.fallbacks, statementsOf(uncited)]).toEqual([1, [EIGHT]]);
    });
    it("never has the fallback state a list whose placement was dropped, and says something was left out", async () => {
      // The reply's only content is a block narrowing L1 code cannot read: nothing survives, and the fallback runs.
      const dropped = { blocks: [{ block: "list", list: "L1", members: "E2" }], not_found: [] };
      const alone1 = await alone({ bundle: eightAnd1([WI(["L1"])]), replies: [dropped] }).render(Q);
      const part = alone1.result.response.parts[0]!;
      expect([alone1.fallbacks, statementsOf(alone1), part.status, part.records?.map(value => value.text)]).toEqual([1, [], "records_only", ["Approved record 1."]]);
      expect(part.gap).toBe(`${RECORDS} ${LIST_DROPPED}`);
      // The fallback still states every other list the plan's which_items needs cite.
      const two = await alone({ bundle: listBundle(16, 0, [list("L1", ids(1, 8)), list("L2", ids(9, 8))], [WI(["L1", "L2"])]), replies: [dropped] }).render(Q);
      expect([statementsOf(two), two.result.response.parts[0]!.gap]).toEqual([[`8 tickets created on October 4, 2026: ${names(9, 8)}.`], `${LIST_FALLBACK} ${LIST_DROPPED}`]);
    });
    it("releases an answer with no list as written, though a which_items need cites one", async () => {
      const rendered = await alone({ bundle: eightAnd1([WI(["L1"]), C(["E9"])]), replies: [placing()] }).render(Q);
      expect([statementsOf(rendered), rendered.result.response.parts[0]!.status, rendered.result.response.parts[0]!.gap, rendered.fallbacks]).toEqual([[REVIEW.text], "answered", undefined, 0]);
    });
    it("never adds members research requested to the writer's own selection", async () => {
      const rendered = await alone({ bundle: eightAnd1([WI(["L1", "E1", "E2", "E3"]), C(["E9"])]), replies: [placing({ block: "list", list: "L1", members: ["E2"] })] }).render(Q);
      expect(statementsOf(rendered)).toEqual([REVIEW.text, `1 of the 8 tickets created on October 4, 2026: ${facts(2)}.`]);
      expect(rendered.cited).toEqual(["E9", "E2"]);
    });
    it("adds no gap for a which_items need that cites no list", async () => {
      const rendered = await alone({ bundle: eightAnd1([WI([]), C(["E9"])]), replies: [placing()] }).render(Q);
      expect(rendered.result.response.parts[0]).toMatchObject({ status: "answered", statements: [expect.objectContaining({ text: REVIEW.text })] });
      expect(rendered.result.response.parts[0]!.gap).toBeUndefined();
    });
    it("types the writer's not_found from run status, never from a need's status", async () => {
      const openNeed = (research: AgenticEvidenceBundleV1): AgenticEvidenceBundleV1 => ({ ...research,
        plan: [{ part: 1, question: Q, notes: "", needs: [{ need: "x", kind: "which_items", status: "open", evidence: ["L1"] }, { need: "the review", status: "found", evidence: ["E9"] }] }] });
      const notFound = (...blocks: readonly object[]) => ({ ...placing(...blocks), not_found: ["x"] });
      const unused = await alone({ bundle: openNeed(eightAnd1([])), replies: [notFound()] }).render(Q);
      expect(unused.result.response.parts[0]!.gap_details).toEqual({ not_found: "Not found: x." });
      const cutShort = openNeed(listBundle(8, 1, [list("L1", ids(1, 8), { ended: false, truncated: true })], []));
      const placed = await alone({ bundle: cutShort, replies: [notFound({ block: "list", list: "L1" })] }).render(Q);
      expect(placed.result.response.parts[0]).not.toHaveProperty("gap_details");
      expect(placed.result.response.parts[0]!.gap).toContain(LEG);
    });

    it("hands the writer research's notes, and no stated or requested_members marker", async () => {
      const run = alone({ bundle: eightAnd1([WI(["L1", "E1"]), C(["E9"])]), replies: [placing({ block: "list", list: "L1" })] });
      await run.render(Q);
      expect(run.prompt(0).research_notes).toEqual({ about: AGENTIC_RESEARCH_NOTES_ABOUT_V1, lists: [{ list: "L1", read: 0, count: 8 }], not_shown: { lists: 0, list_rows: 0 }, needs: [
        { part: 1, need: "need 1", kind: "which_items", status: "found", on_desk: ["L1", "E1"] }, { part: 1, need: "need 2", kind: "content", status: "found", on_desk: ["E9"] }] });
      expect(run.prompt(0).lists[0]).not.toHaveProperty("stated"); expect(run.prompt(0).lists[0]).not.toHaveProperty("requested_members");
    });
    it("tells the writer how many members of each list research read in full", async () => {
      // Research opened E1 and E2 in full: the writer is told 2 of the 8, so it can say an answer rests on only some of them.
      const research = eightAnd1([C(["E9"])]);
      const opened: AgenticEvidenceBundleV1 = { ...research, items: research.items.map(entry => ["E1", "E2"].includes(entry.short)
        ? Object.freeze({ ...entry, full: true, item: ticketRow(Number(entry.short.slice(1)), `THERM-${entry.short.slice(1)}: body.`) }) : entry) };
      const run = alone({ bundle: opened, replies: [placing()] });
      await run.render(Q);
      expect(run.prompt(0).research_notes.lists).toEqual([{ list: "L1", read: 2, count: 8 }]);
    });
    it("tells the writer and the notice how many lists and rows it was not shown, and lets it place only the five", async () => {
      const research = listBundle(48, 1, Array.from({ length: 6 }, (_, at) => list(`L${at + 1}`, ids(at * 8 + 1, 8))), [C(["E49"])]);
      const run = alone({ bundle: research, replies: [placedOn("E49", { block: "list", list: "L6" }, { block: "list", list: "L1" })] });
      const { rendered, corrections } = await observed(() => run.render(Q));
      // The sixth list's eight rows were not shown either.
      expect(run.prompt(0).research_notes.not_shown).toEqual({ lists: 1, list_rows: 8 });
      expect(rendered.result.response.notice).toContain("1 list research read was not shown to the answer's writer. 8 list rows were not shown to the answer's writer.");
      expect(blocksOf(rendered).filter(block => block.kind === "table").map(block => block.kind === "table" ? block.rows.length : 0)).toEqual([8]);
      expect(rendered.cited).toEqual(["E49", ...ids(1, 8)]);
      expect(corrections).toMatchObject({ writer_unknown_id_dropped: 1 });
    });
    it("bounds the response's notice to its 2 KiB, keeping whole notices in order while they fit", async () => {
      // Two 1,000-byte coverage notices, and the notice of a sixth list the writer was not shown.
      const research = listBundle(48, 1, Array.from({ length: 6 }, (_, at) => list(`L${at + 1}`, ids(at * 8 + 1, 8))), [C(["E49"])]);
      const long = (n: number) => `Coverage note ${n}: ${"x".repeat(1_000 - `Coverage note ${n}: `.length)}`;
      const rendered = await alone({ bundle: { ...research, coverage: { reads: [], inventories: [], notices: [long(1), long(2)] } }, replies: [placedOn("E49")] }).render(Q);
      const notice = rendered.result.response.notice!;
      expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(2 * 1024);
      expect(notice.startsWith(`${long(1)} ${long(2)} `)).toBe(true);
    });
    it("writes from notes that say nothing: an interrupted Claude account run's one synthetic open need", async () => {
      const research: AgenticEvidenceBundleV1 = { ...records(1), plan: [{ part: 1, question: Q, notes: "", needs: [{ need: Q, kind: "content", status: "open", evidence: [] }] }], stop: { reason: "budget", completed: false } };
      const run = alone({ bundle: research, replies: [writerReply([{ text: "Approved record 1 says so.", evidence: ["E1"] }])] });
      const rendered = await run.render(Q);
      expect(run.prompt(0).research_notes.needs).toEqual([{ part: 1, need: Q, kind: "content", status: "open", on_desk: [] }]);
      expect([statementsOf(rendered), rendered.result.response.parts[0]!.gap_details, rendered.outcome]).toEqual([["Approved record 1 says so."], { interrupted: true }, "partial"]);
    });
    /** Eight rows with E1 opened in full (its text read), and the record E9; the plan's needs as given. */
    const firstOpened = (needs: readonly Need[], extra: Partial<AgenticListEvidenceV1> = {}): AgenticEvidenceBundleV1 => {
      const research = listBundle(8, 1, [list("L1", ids(1, 8), extra)], needs);
      return { ...research, items: research.items.map(entry => entry.short === "E1" ? Object.freeze({ ...entry, full: true, opened: true, item: ticketRow(1, "THERM-1: BUG-412 blocks DVT.") }) : entry) };
    };
    it("says nothing in a sentence or the gap about how many members of a list research read (ADR-0054)", async () => {
      const mentions = { text: "THERM-1 mentions BUG-412.", evidence: ["L1", "E1"] };
      const rendered = await alone({ bundle: firstOpened([WS(["L1", "E1"])]), replies: [writerReply([mentions])] }).render("Which tickets mention BUG-412?");
      const part = rendered.result.response.parts[0]!;
      expect([statementsOf(rendered), part.status, part.gap, rendered.outcome]).toEqual([[mentions.text], "answered", undefined, "answered"]);
      expect(JSON.stringify(rendered.result.response)).not.toMatch(/checked so far|Not every listed item was checked/u);
    });
    it("reports a list's filter, cut-off and unrecorded facts for a list the answer uses, placed or cited, and for no other", async () => {
      const limits = { ended: false, truncated: true, filter_applied: { date_field: "applied", since: "applied", until: "applied", owner: "ignored" }, unchecked: { count: 1, dates: ["updated" as const] } } as Partial<AgenticListEvidenceV1>;
      const research = firstOpened([WS(["L1", "E9"])], limits);
      const UNRECORDED_DATE = "1 ticket has no created date, so it was not checked against these dates.";
      const FILTER = "Tickets could not be filtered by owner, so this list is not limited to that owner.";
      const reported = async (reply: unknown) => {
        const rendered = await alone({ bundle: research, replies: [reply] }).render("Which tickets mention BUG-412?");
        const part = rendered.result.response.parts[0]!;
        return [part.gap?.includes(LEG) ?? false, part.gap?.includes(UNRECORDED_DATE) ?? false, rendered.result.response.notice?.includes(FILTER) ?? false];
      };
      const used = [true, true, true], unused = [false, false, false];
      // (a) placed; (b) cited by a kept sentence through the list's id, or through a row the writer saw as a row only.
      expect(await reported(placing({ block: "list", list: "L1" }))).toEqual(used);
      expect(await reported(writerReply([{ ...REVIEW, evidence: ["L1", "E9"] }]))).toEqual(used);
      expect(await reported(writerReply([{ ...REVIEW, evidence: ["E2", "E9"] }]))).toEqual(used);
      // Neither placed nor cited, though a which_say need cites it; and a sentence citing one member's text alone.
      expect(await reported(writerReply([REVIEW]))).toEqual(unused);
      expect(await reported(writerReply([{ text: "THERM-1 mentions BUG-412.", evidence: ["E1"] }]))).toEqual(unused);
    });
    it("shows the writer the lists the plan cites first, whatever kind of need cites them", async () => {
      const research = listBundle(14, 1, Array.from({ length: 7 }, (_, at) => list(`L${at + 1}`, ids(at * 2 + 1, 2))), [C(["L7", "E15"])]);
      const run = alone({ bundle: research, replies: [placedOn("E15")] });
      await run.render(Q);
      expect(run.prompt(0).lists.map((value: { id: string }) => value.id)).toEqual(["L7", "L1", "L2", "L3", "L4"]);
    });
    it("gives evidence the whole room before the notes, which give way need by need and then entirely", async () => {
      // One passage, cited by a 30-need plan, and no list: the writer runs only when the passage is admitted.
      const plan = [{ part: 1, question: Q, notes: "", needs: Array.from({ length: 30 }, (_, at) => ({ need: `need ${at + 1} ${"x".repeat(200)}`, status: "found" as const, evidence: ["E1"] })) }];
      const sole = (size: number) => alone({ bundle: { ...bundle([{ item: record("r1", "y".repeat(size)), full: true, touched: 1 }], ["E1"]), plan }, replies: [writerReply([{ text: "Approved record 1 says so.", evidence: ["E1"] }])] });
      const runs = async (size: number) => { const run = sole(size); await run.render(Q); return run.trace.includes("generate") ? run : undefined; };
      // The largest passage the writer is given: it fits the room with fewer bytes to spare than the notes' frame takes.
      let low = 0, high = 4_000_000;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (await runs(mid) !== undefined) low = mid; else high = mid - 1; }
      const edge = (await runs(low))!;
      expect(edge.prompt(0).evidence).toHaveLength(1);
      expect(edge.prompt(0)).not.toHaveProperty("research_notes");
      // With a little more room the notes come back, their needs left out from the end.
      const roomier = (await runs(low - 2_000))!;
      expect(roomier.prompt(0).research_notes.needs_omitted).toBeGreaterThan(0);
    });
  });
});

describe("Ask renderer: answer layout v2 (ADR-0051)", () => {
  /** THERM's evidence: the PVT review's decision, the soak's days, THERM-48 and the steps before PVT, each read in full and cited. */
  const THERM_ITEMS = [
    record("pvt", "The Oct 23 PVT review decided: start PVT once the 72-hour soak passes.", { label: "PVT review", occurred_at: "2026-10-23" }),
    record("soak", "Noor Haddad started the 72-hour soak on 2026-10-20, and it passed on Oct 23.", { label: "Soak log", occurred_at: "2026-10-24" }),
    record("therm-48", "THERM-48 is in review, and Tomas Okafor owns it.", { label: "THERM-48 status" }),
    record("steps", "Before PVT: freeze the firmware, then ship the build to the line.", { label: "PVT plan" }),
  ];
  const therm = () => bundle(THERM_ITEMS.map((item, index) => ({ item, full: true, touched: index + 1 })), ["E1", "E2", "E3", "E4"]);
  const ANSWER = { block: "answer", sentences: [{ text: "PVT can start: the soak passed on Oct 23.", evidence: ["E1", "E2"] }] };
  const TIMELINE = { block: "timeline", title: "The soak", events: [
    { date: "2026-10-23", text: "The soak passed.", evidence: ["E2"] }, { date: "2026-10-20", text: "Started the 72-hour soak.", who: "Noor Haddad", evidence: ["E2"] },
  ] };
  const CARD = { block: "card", title: "THERM-48", kind: "ticket", facts: [{ label: "Status", value: "In review", evidence: ["E3"] }, { label: "Owner", value: "Tomas Okafor", evidence: ["E3"] }] };
  const STEPS = { block: "points", title: "Before PVT", ordered: true, items: [{ text: "Freeze the firmware.", evidence: ["E4"] }, { text: "Ship the build to the line.", evidence: ["E4"] }] };
  const QUOTE = { block: "quote", text: "start PVT once the 72-hour soak passes", from: "PVT review, Oct 23", evidence: ["E1"] };
  const reply = (...blocks: readonly unknown[]) => ({ lists: [], not_found: [], blocks });
  const part = (rendered: Rendering) => rendered.result.response.parts[0]!;

  it("gives every Ask's writer the block catalog beside the source catalog, its layout part and its schema, with a laid-out reply's allowance", async () => {
    const run = alone({ bundle: therm(), replies: [reply(ANSWER)] });
    await run.render("Can PVT start?");
    expect(run.input(0)).toMatchObject({ system_prompt: `${ANSWER_PROMPT}\n\n${ANSWER_BLOCKS_PROMPT}`, schema: answerBlocksSchema, max_output_tokens: 2_000 });
    const keys = Object.keys(run.prompt(0));
    expect(keys.slice(keys.indexOf("source_catalog"), keys.indexOf("source_catalog") + 2)).toEqual(["source_catalog", "block_catalog"]);
    expect(run.prompt(0).block_catalog).toEqual(ANSWER_BLOCK_CATALOG);
    // An Ask that did not ask for blocks gives its writer the same input: only what is released differs.
    const plain = alone({ bundle: therm(), replies: [reply(ANSWER)] });
    await plain.render("Can PVT start?");
    const { signal: _plain, ...withoutBlocks } = plain.input(0);
    const { signal: _run, ...inBlocks } = run.input(0);
    expect(withoutBlocks).toEqual(inBlocks);
    const again = alone({ bundle: therm(), replies: [{ ...reply(ANSWER), since: [] }], earlier: { asked_on: "2026-10-05", statements: [{ text: "PVT waits on the soak.", sources: ["Soak log"] }] }, answers: "Can PVT start?" });
    await again.render("Can PVT start?");
    expect(again.input(0)).toMatchObject({ system_prompt: `${ANSWER_PROMPT}\n\n${ANSWER_BLOCKS_PROMPT}\n\n${ANSWER_SINCE_PROMPT}`, schema: answerBlocksSinceSchema, max_output_tokens: 2_500 });
  });

  it("arranges THERM's answer: the answer, a timeline oldest first, a card, numbered steps and a quote, each item a statement code wrote", async () => {
    const rendered = await alone({ bundle: therm(), replies: [reply(ANSWER, TIMELINE, CARD, STEPS, QUOTE)] }).render("Can PVT start?");
    expect(part(rendered).statements.map(value => [value.text, value.citation_indexes])).toEqual([
      ["PVT can start: the soak passed on Oct 23.", [0, 1]],
      ["2026-10-20, Noor Haddad: Started the 72-hour soak.", [1]], ["2026-10-23: The soak passed.", [1]],
      ["Ticket: THERM-48; Status: In review.", [2]], ["Ticket: THERM-48; Owner: Tomas Okafor.", [2]],
      ["Freeze the firmware.", [3]], ["Ship the build to the line.", [3]],
      ["PVT review, Oct 23: “start PVT once the 72-hour soak passes”", [0]],
    ]);
    expect(blocksOf(rendered)).toEqual([
      { kind: "answer", statements: [0] },
      { kind: "timeline", title: "The soak", statements: [1, 2], events: [{ date: "2026-10-20", text: "Started the 72-hour soak.", who: "Noor Haddad" }, { date: "2026-10-23", text: "The soak passed." }] },
      { kind: "card", title: "THERM-48", entity: "ticket", statements: [3, 4], facts: [{ label: "Status", value: "In review" }, { label: "Owner", value: "Tomas Okafor" }] },
      { kind: "points", title: "Before PVT", ordered: true, statements: [5, 6] },
      { kind: "quote", statements: [7], text: "start PVT once the 72-hour soak passes", from: "PVT review, Oct 23" },
    ]);
    expect(rendered.outcome).toBe("answered");
  });

  it("reads a quote that is not word for word in what it cites as text, and an event on a day no cited item has as text after its timeline", async () => {
    const paraphrase = { ...QUOTE, text: "PVT starts when the soak is done" };
    const undated = { ...TIMELINE, events: [...TIMELINE.events, { date: "2026-10-22", text: "The soak hit 60 hours.", evidence: ["E2"] }] };
    const { rendered, corrections } = await observed(() => alone({ bundle: therm(), replies: [reply(ANSWER, undated, paraphrase)] }).render("Can PVT start?"));
    expect(part(rendered).statements.map(value => value.text)).toEqual([
      "PVT can start: the soak passed on Oct 23.", "2026-10-20, Noor Haddad: Started the 72-hour soak.", "2026-10-23: The soak passed.", "The soak hit 60 hours.",
      "PVT review, Oct 23: PVT starts when the soak is done.",
    ]);
    expect(blocksOf(rendered).map(block => [block.kind, block.statements])).toEqual([["answer", [0]], ["timeline", [1, 2]], ["text", [3, 4]]]);
    expect(corrections).toMatchObject({ writer_quote_unquoted: 1, writer_event_undated: 1 });
  });

  it("leaves out an item that cites no text it read (W1), reading a block left with one item as text and no answer it was not given", async () => {
    const steps = { ...STEPS, items: [STEPS.items[0], { text: "Book the line.", evidence: ["E9"] }] };
    const unread = { block: "answer", sentences: [{ text: "PVT can start.", evidence: ["E9"] }] };
    const rendered = await alone({ bundle: therm(), replies: [reply(unread, steps, CARD)] }).render("Can PVT start?");
    expect(part(rendered).statements.map(value => value.text)).toEqual(["Freeze the firmware.", "Ticket: THERM-48; Status: In review.", "Ticket: THERM-48; Owner: Tomas Okafor."]);
    expect(blocksOf(rendered)).toEqual([{ kind: "text", title: "Before PVT", statements: [0] }, { kind: "card", title: "THERM-48", entity: "ticket", statements: [1, 2], facts: [{ label: "Status", value: "In review" }, { label: "Owner", value: "Tomas Okafor" }] }]);
    // A writer that gave no answer block has its first item read as the answer, when it is untitled text.
    const untitled = await alone({ bundle: therm(), replies: [reply({ block: "text", sentences: ANSWER.sentences }, STEPS)] }).render("Can PVT start?");
    expect(blocksOf(untitled).map(block => block.kind)).toEqual(["answer", "points"]);
  });

  it("keeps every card fact a whole claim: a fact left out takes no other's name, and two cards' like facts are not one", async () => {
    const card = (title: string, facts: readonly (readonly [string, string, string])[]) => ({ block: "card", title, kind: "ticket", facts: facts.map(([label, value, cited]) => ({ label, value, evidence: [cited] })) });
    const rendered = await alone({ bundle: therm(), replies: [reply(ANSWER,
      card("THERM-48", [["Status", "In review", "E9"], ["Owner", "Tomas Okafor", "E3"], ["Due", "2026-11-03", "E3"]]),
      card("THERM-49", [["Owner", "Tomas Okafor", "E3"], ["Due", "2026-11-03", "E3"]]),
    )] }).render("What are THERM-48 and THERM-49?");
    expect(part(rendered).statements.slice(1).map(value => value.text)).toEqual([
      "Ticket: THERM-48; Owner: Tomas Okafor.", "Ticket: THERM-48; Due: 2026-11-03.", "Ticket: THERM-49; Owner: Tomas Okafor.", "Ticket: THERM-49; Due: 2026-11-03.",
    ]);
    expect(blocksOf(rendered).map(block => [block.kind, block.statements])).toEqual([["answer", [0]], ["card", [1, 2]], ["card", [3, 4]]]);
  });

  it("checks a timeline day a cited item writes without a year against the days it records, not today's year", async () => {
    // Asked on 2026-10-06 about a note of 2025-10-27 that says "ship by Nov 3": that is 2025-11-03, never 2026-11-03.
    const note = record("note", "Approved: ship by Nov 3, after the review on Oct 30.", { label: "Release note", occurred_at: "2025-10-27" });
    const research = bundle([{ item: note, full: true, touched: 1 }], ["E1"]);
    const events = (year: string) => ({ block: "timeline", events: [{ date: `${year}-10-30`, text: "The review met.", evidence: ["E1"] }, { date: `${year}-11-03`, text: "It ships.", evidence: ["E1"] }] });
    const right = await alone({ bundle: research, replies: [reply({ block: "answer", sentences: [{ text: "It ships Nov 3.", evidence: ["E1"] }] }, events("2025"))] }).render("When does it ship?");
    expect(blocksOf(right).map(block => block.kind)).toEqual(["answer", "timeline"]);
    const wrong = await alone({ bundle: research, replies: [reply({ block: "answer", sentences: [{ text: "It ships Nov 3.", evidence: ["E1"] }] }, events("2026"))] }).render("When does it ship?");
    expect(blocksOf(wrong).map(block => block.kind)).toEqual(["answer", "text"]);
  });

  it("reads an answer block the writer put after another block as the answer, the context before it as text", async () => {
    const rendered = await alone({ bundle: therm(), replies: [reply({ block: "text", sentences: [{ text: "The soak started on 2026-10-20.", evidence: ["E2"] }] }, ANSWER)] }).render("Can PVT start?");
    expect(part(rendered).statements.map(value => value.text)).toEqual(["PVT can start: the soak passed on Oct 23.", "The soak started on 2026-10-20."]);
    expect(blocksOf(rendered).map(block => block.kind)).toEqual(["answer", "text"]);
  });

  it("keeps every item of an answer in blocks: no count of statements or citations cuts it (ADR-0051, past ADR-0041's W6)", async () => {
    const steps = { block: "points", title: "Before PVT", ordered: true, items: Array.from({ length: 12 }, (_, at) => ({ text: `Step ${at + 1} of the plan.`, evidence: ["E4"] })) };
    const rendered = await alone({ bundle: therm(), replies: [reply(ANSWER, steps)] }).render("What happens before PVT?");
    expect(part(rendered).statements.map(value => value.text)).toEqual(["PVT can start: the soak passed on Oct 23.", ...Array.from({ length: 12 }, (_, at) => `Step ${at + 1} of the plan.`)]);
    expect(part(rendered)).toMatchObject({ status: "answered" });
    expect(part(rendered)).not.toHaveProperty("gap");
    expect(blocksOf(rendered).map(block => [block.kind, block.statements.length])).toEqual([["answer", 1], ["points", 12]]);
    // 45 records, each an item of its own: every one is cited, past ADR-0041's 40.
    const research = bundle(Array.from({ length: 45 }, (_, at) => ({ item: record(`many-${at + 1}`, `Record ${at + 1} applies.`), full: true, touched: at + 1 })), Array.from({ length: 45 }, (_, at) => `E${at + 1}`));
    const wide = await alone({ bundle: research, replies: [reply({ block: "answer", sentences: [{ text: "All 45 apply.", evidence: ["E1"] }] },
      { block: "points", ordered: false, items: Array.from({ length: 45 }, (_, at) => ({ text: `Record ${at + 1} applies.`, evidence: [`E${at + 1}`] })) })] }).render("Which records apply?");
    expect([wide.result.response.citations.length, part(wide).statements.length, part(wide).status]).toEqual([45, 46, "answered"]);
  });

  it("keeps two rows that cite the same item and differ only at the end of their last cell", async () => {
    const columns = ["One", "Two", "Three", "Four", "Five", "Six"];
    const row = (last: string) => ({ cells: [...columns.slice(0, 5).map(() => "x".repeat(120)), last], evidence: ["E1"] });
    const rendered = await alone({ bundle: records(1), replies: [reply({ block: "answer", sentences: [{ text: "Two rules apply.", evidence: ["E1"] }] },
      { block: "table", title: "Rules", columns, rows: [row(`${"y".repeat(114)} ALLOW`), row(`${"y".repeat(115)} DENY`)] })] }).render("Which rules apply?");
    expect(part(rendered)).toMatchObject({ status: "answered" });
    const texts = part(rendered).statements.map(value => value.text);
    expect([texts.length, texts[1]!.endsWith(" ALLOW."), texts[2]!.endsWith(" DENY.")]).toEqual([3, true, true]);
    const table = blocksOf(rendered).find(block => block.kind === "table");
    expect(table?.kind === "table" && table.rows.map(value => value.cells[5]!.slice(-5))).toEqual(["ALLOW", " DENY"]);
  });

  it("cuts an answer too large for its byte bound from its end, keeping its blocks: a row still its cells' claim", async () => {
    // Forty records with long labels, a long answer and nine rows of six long cells each citing four records: past 64 KiB,
    // so the rows that cannot fit are left out from the end, and the answer says some evidence could not fit.
    const research = records(40, { label: "𝔸".repeat(250) });
    const columns = ["One", "Two", "Three", "Four", "Five", "Six"];
    const big = reply(
      { block: "answer", sentences: [{ text: `${"𝔹".repeat(690)} 0.`, evidence: ["E1", "E2", "E3", "E4"] }] },
      { block: "table", columns, rows: Array.from({ length: 9 }, (_, index) => ({ cells: columns.map(column => `${column} ${"𝔸".repeat(70)} ${index + 1}`), evidence: [1, 2, 3, 4].map(n => `E${4 * (index + 1) + n}`) })) },
    );
    const on = await alone({ bundle: research, replies: [big] }).render("What applies?");
    const released = part(on);
    expect(released).not.toHaveProperty("gap_details");
    expect(released).toMatchObject({ status: "partial", gap: "Some evidence could not fit in this response." });
    expect(released.statements.length).toBeLessThan(10);
    expect(released.statements.slice(1).map(value => value.text.startsWith(`One: One ${"𝔸".repeat(70)} `))).toEqual(released.statements.slice(1).map(() => true));
    expect(blocksOf(on).map(block => block.kind)).toEqual(["answer", "table"]);
    expect(canonicalJsonBytes(on.result.response).byteLength).toBeLessThanOrEqual(PERSON_ANSWER_RESPONSE_MAX_BYTES_V4);
  });
});
