import { canonicalJsonBytes, canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { PERSON_ANSWER_RESPONSE_MAX_BYTES_V4, PERSON_ANSWER_STATEMENT_MAX_BYTES_V4, validatePersonAnswerBlocksV2, validatePersonAnswerLayoutV1, type PersonAnswerResponseV8 } from "@echo-brain/organization-api";
import { describe, expect, it } from "vitest";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import {
  ANSWER_BLOCK_CATALOG, ANSWER_BLOCKS_PROMPT, ANSWER_LAYOUT_PROMPT, ANSWER_PROMPT, ANSWER_SINCE_PROMPT, answerBlocksSchema, answerBlocksSinceSchema, answerLayoutSchema, answerSchema,
} from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { createAgenticListEvidenceV1, type AgenticListEvidenceV1 } from "../../../src/answer-composition/agentic-list-evidence-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { createAskRendererV1 } from "../../../src/answer-composition/renderers/ask-renderer-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../src/shared/core-runtime-observation-v1.js";
import { followUpItem, ids, pageRow, section } from "../fixtures/agentic-lists.js";
import { EMPTY_BUNDLE, LIST_READ_AT, listed, record, scriptedGate } from "../fixtures/agentic-scenarios.js";

/** Ask's renderer on its own: a hand-built bundle, a gate over scripted writer replies, and no desk. */
function alone(input: {
  readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly remaining?: number; readonly layout?: 1 | 2; readonly typed_gaps?: boolean;
  /** An Ask again (ADR-0047): the earlier answer, and the question the answer names, as Ask passes them together. */
  readonly earlier?: Parameters<typeof createAskRendererV1>[0]["earlier"]; readonly answers?: string;
}) {
  const trace: string[] = [];
  const { gate, inputs } = scriptedGate(input.replies, input.bundle.budget, trace);
  const renderer = createAskRendererV1({
    answer_prompt: ANSWER_PROMPT, source_catalog: [], ...(input.typed_gaps === false ? {} : { include_gap_details: true }), scope: "everything the asker can read",
    context: { today: "2026-10-06" }, desk_scope: input.bundle.gathered_for.scope, ...(input.layout === undefined ? {} : { layout: input.layout }),
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

/** A released v2 part's blocks, checked against the contract; a v2 part never carries layout v1's. */
function blocksOf(rendered: Rendering) {
  const part = rendered.result.response.parts[0]!;
  expect(validatePersonAnswerBlocksV2(part.blocks, part.statements, rendered.result.response.citations.length)).toEqual(part.blocks);
  expect(part).not.toHaveProperty("layout");
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
  it("keeps the exact older part field set unless the client opts into typed explanations", async () => {
    const research: AgenticEvidenceBundleV1 = { ...records(1), stop: { reason: "finished", completed: true, unsupported_action: true } };
    const replies = [{ sentences: [{ text: "The rule applies.", evidence: ["E1"] }], lists: [], not_found: ["the approver"] }];
    const old = await alone({ bundle: research, replies, typed_gaps: false }).render("What is the rule? Change the status.");
    const current = await alone({ bundle: research, replies }).render("What is the rule? Change the status.");
    expect(Object.keys(old.result.response.parts[0]!).sort()).toEqual(["gap", "question", "statements", "status"]);
    const { gap_details, ...plain } = current.result.response.parts[0]!;
    expect(gap_details).toEqual({ unsupported_action: true, not_found: "Not found: the approver." });
    expect(plain).toEqual(old.result.response.parts[0]);
  });

  it("keeps the read-only explanation when a writer supplies a long missing-fact gap", async () => {
    const run = alone({ bundle: { ...records(1), stop: { reason: "finished", completed: true, unsupported_action: true } },
      replies: [{ sentences: [{ text: "The rule applies.", evidence: ["E1"] }], lists: [], not_found: ["Missing detail. ".repeat(40)] }] });
    const rendered = await run.render("What is the rule? Change the status.");
    expect(rendered.result.response.parts[0]!.gap).toMatch(/^Ask can read your sources, but it can't make changes or send messages\. Nothing was changed or sent\./u);
    expect(rendered.result.response.parts[0]!.gap!.length).toBeLessThanOrEqual(600);
    expect(rendered.result.response.parts[0]!.gap_details).toMatchObject({ unsupported_action: true, not_found: expect.stringMatching(/^Not found:/u) });
  });

  it("explains unfinished factual research beside an unsupported action and usable evidence", async () => {
    const run = alone({ bundle: { ...records(1), stop: { reason: "finished", completed: false, unsupported_action: true } },
      replies: [{ sentences: [{ text: "The rule applies.", evidence: ["E1"] }], lists: [], not_found: [] }] });
    const rendered = await run.render("What are all the rules? Change the status.");
    expect(rendered.result.response.parts[0]!.gap).toContain("Nothing was changed or sent.");
    expect(rendered.result.response.parts[0]!.gap).toContain("Research stopped before it finished");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]!.gap_details).toEqual({ unsupported_action: true, interrupted: true });
  });

  it("separates a missing fact from output-fit diagnostics", async () => {
    const rendered = await alone({ bundle: records(41), replies: [{ lists: [], sentences: Array.from({ length: 5 }, (_, at) => ({
      text: `Rule ${at + 1} applies.`, evidence: Array.from({ length: at === 4 ? 1 : 10 }, (_, index) => `E${at * 10 + index + 1}`),
    })), not_found: ["the approver"] }] }).render("What are the rules and who approved them?");
    const part = rendered.result.response.parts[0]!;
    expect(part.gap_details).toEqual({ not_found: "Not found: the approver." });
    expect(part.gap).toContain("Not found: the approver.");
    expect(part.gap).not.toBe(part.gap_details!.not_found);
  });

  it("keeps genuine unfinished research typed even beside useful facts", async () => {
    const rendered = await alone({ bundle: { ...records(1), stop: { reason: "budget", completed: false } }, replies: [{ lists: [],
      sentences: [{ text: "The rule applies.", evidence: ["E1"] }], not_found: [] }] }).render("What are all the rules?");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "partial", gap_details: { interrupted: true } });
  });

  it.each([false, true])("keeps both project leads when both needs are which_items (extra person citation: %s)", async extraPerson => {
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
    const run = alone({ bundle: research, replies: [{
      sentences: [
        { text: "Casey leads Alpha.", evidence: extraPerson ? ["E1", "E3"] : ["E1"] },
        { text: "Morgan leads Beta.", evidence: ["E2"] },
      ], not_found: [],
    }] });
    const rendered = await run.render(question);
    const statements = rendered.result.response.parts[0]!.statements;
    expect(statements[0]!.text).toMatch(/2 projects.*Alpha.*Beta/u);
    expect(statements.slice(1).map(statement => statement.text)).toEqual(["Casey leads Alpha.", "Morgan leads Beta."]);
    expect(statements.slice(1).map(statement => statement.citation_indexes)).toEqual(extraPerson ? [[0, 2], [1]] : [[0], [1]]);
    expect(rendered.result.response.citations).toHaveLength(extraPerson ? 3 : 2);
    expect(rendered.outcome).toBe("answered");
  });

  it("removes only exact repeats with the same cited objects, independent of citation order", async () => {
    const first = record("first", "Casey owns the pilot. The pilot is due Friday.");
    const second = record("second", "Casey owns the pilot.", { visibility: "only_me" });
    const run = alone({
      bundle: bundle([{ item: first, full: true, touched: 1 }, { item: second, full: true, touched: 2 }], ["E1", "E2"]),
      replies: [{ sentences: [
        { text: "Casey owns the pilot.", evidence: ["E1", "E2"] },
        { text: "Casey owns the pilot.", evidence: ["E2", "E1", "E1"] },
        { text: "Casey owns the pilot.", evidence: ["E1"] },
        { text: "Casey owns the pilot.", evidence: ["E2"] },
        { text: "The pilot is due Friday.", evidence: ["E1"] },
        { text: "The pilot belongs to Casey.", evidence: ["E1"] },
      ], not_found: [] }],
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
      replies: [{ sentences: [{ text: "Mara owns the October launch.", evidence: ["E2", "E1", "E9"] }, { text: "An unread item says so.", evidence: ["E3"] }], not_found: [] }],
    });
    const { rendered, corrections } = await observed(() => run.render("What was decided?"));
    expect(run.trace).toEqual(["context:E1,E2", "revalidate", "generate"]);
    expect(rendered.result.response.parts[0]!.statements).toEqual([{ text: "Mara owns the October launch.", citation_indexes: [0, 1], private: false }]);
    expect(rendered.result.response.citations.map(value => value.citation)).toEqual([second.citation, first.citation]);
    expect(rendered).toMatchObject({ cited: ["E2", "E1"], outcome: "answered", fallbacks: 0, result: { writer_evidence: ["E1", "E2"] } });
    // E9, which the writer was never shown, and the sentence that cites no text it read.
    expect(corrections).toEqual({ writer_unknown_id_dropped: 1, writer_uncited_sentence_dropped: 1 });
  });

  // The Ask golden replays this fallback too, end to end.
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
    const rendered = await alone({ bundle: research, replies: [{ sentences: [{ text, evidence: [cited] }], not_found: [] }] }).render("Can the pilot proceed?");
    expect(rendered.outcome).toBe(interrupted ? "partial" : "answered");
    expect(rendered.result.response.parts[0]).toMatchObject({ status: interrupted ? "partial" : "answered", ...(interrupted ? { gap_details: { interrupted: true } } : {}) });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap");
    if (notice === null) expect(rendered.result.response).not.toHaveProperty("notice");
    else expect(rendered.result.response.notice).toBe(notice);
  });

  it("writes only when the time the runner leaves it covers a writer call", async () => {
    const entries = [{ item: record("read", "Approved: ship the enclosure in October."), full: true, touched: 1 }];
    const reply = { sentences: [{ text: "The enclosure ships in October.", evidence: ["E1"] }], not_found: [] };
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
  const say = (...sentences: readonly { readonly text: string; readonly evidence: readonly string[] }[]) => ({ lists: [], sentences, not_found: [] });
  const use = (...lists: readonly unknown[]) => ({ lists, sentences: [], not_found: [] });
  const EIGHT = `8 tickets created on October 4, 2026: ${names(1, 8)}.`;
  const FOUR = { text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["L1", ...ids(1, 4)] };
  const REVIEW = { text: "The review approved the fixture work.", evidence: ["E9"] };
  const ON_THEM = { text: "The review approved fixture work on them.", evidence: ["L1", "E9"] };
  const WAITS = "THERM-2 (Fixture work 2, owner Dana Lee) waits on the approved record.";
  const ROWS_REASON = "a sentence cites list rows or list ids but no evidence text: code states which items exist, and members' title, dates, status and owner, through \"lists\" (with \"where\" or \"members\"); what no evidence text says belongs in \"not_found\"";
  const UNSUPPORTED = "Part of the answer was left out because no item's text supports it.";
  const UNCHECKED = "Not every listed item was checked, so others may also match.";
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

  it("withholds writer absence for a declared text list whose members were not all checked", async () => {
    const rendered = await alone({ bundle: eightAnd1([WS(["L1", "E9"])]), replies: [{ lists: [], sentences: [], not_found: ["the requested topic"] }] }).render("Which tickets mention the topic?");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]!.gap).toContain("Not every listed item was checked");
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
    expect(rendered.result.response.parts[0]!.statements).toHaveLength(10);
    expect(rendered.result.response.parts[0]!.statements.at(-1)!.text).toBe("Record 9 applies.");
    expect(rendered.result.response.parts[0]!.gap).toBeUndefined();
    expect(rendered.result.response.notice).toBe("Some source coverage was incomplete, so relevant context may be missing.");
    expect(rendered.outcome).toBe("answered");
  });
  it("counts a list the writer was not shown, and a member not in the list it names, as ids dropped", async () => {
    const run = alone({ bundle: eightAnd1([C(["E9"])]), replies: [{ lists: [{ id: "L2" }, { id: "L1", members: ["E1", "E10"] }], sentences: [REVIEW], not_found: [] }] });
    const { rendered, corrections } = await observed(() => run.render("Which tickets?"));
    // L2 names nothing; L1's use keeps only E1, its member.
    expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([expect.stringContaining(facts(1)), REVIEW.text]);
    expect(rendered.result.response.citations).toHaveLength(2);
    expect(corrections).toEqual({ writer_unknown_id_dropped: 2 });
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
        expect(run.prompt(0).lists[0]).toMatchObject({ id: "L1", stated: false, count: 8 });
        expect(run.prompt(1).validation_error).toBe(`Your previous reply could not be used: ${ROWS_REASON}. Reply again with only the JSON object, in exactly the shape your instructions show.`);
        expect(rendered.result.writer_evidence).toEqual(["E9", ...ids(1, 8)]); } },
    { id: "CF2", name: "leaves out a repeated rows sentence beside a stated list whose need also cites text", bundle: eightAnd1([WI(["L1", "E9"])]), replies: [say(FOUR), say(FOUR)], calls: 2, repaired: true, status: "partial", gap: UNSUPPORTED, says: [EIGHT] },
    // E9 is text the writer read, outside the list: the sentence stands on it (W1). The rows it cites beside it are cited
    // too, since it may carry their facts (W6); its list id supports nothing and brings the list's private rows the writer saw.
    { id: "W1, W6", name: "stands a sentence on the text it cites beside a stated list, and cites after it the rows it names and its list's private rows", bundle: eightAnd1([WI(["L1"])]), replies: [say({ ...FOUR, evidence: [...FOUR.evidence, "E9"] })], status: "answered", says: [st(EIGHT, 8), st(FOUR.text, [8, 0, 1, 2, 3, 4, 5, 6, 7])] },
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
        id: "X35e", name: team ? "keeps all three sentences over team rows" : "leaves a sentence whose list id would pass 40 citations out with every one after it", bundle: team ? teamRows(research) : research,
        replies: [say({ text: REVIEW.text, evidence: ["E46"] }, { text: "The fixture work waits on the review.", evidence: ["L1", "E47"] }, { text: "The review closed.", evidence: ["E46"] })],
        q: "What did the review approve?", ...(team
          ? { status: "answered", check: (rendered: Rendered) => expect(rendered.result.response.parts[0]!.statements.map(value => value.citation_indexes)).toEqual([[0], [1], [0]]) }
          : { status: "partial", gap: FIT, says: [st(REVIEW.text, 1, true)], check: (_: Rendered, run: ReturnType<typeof alone>) => expect(run.prompt(0).lists[0].members).toHaveLength(45) }),
      };
    }),
    // Eleven team records (E9..E19) and one only_me row (E1, of L2), with L1 (seven team rows) before, among or after them:
    // thirteen ids, over the schema's 12. A list id takes no item's slot, so the row stays and the sentence is private.
    ...[[...ids(9, 11), "E1", "L1"], ["L1", ...ids(9, 11), "E1"], [...ids(9, 5), "L1", ...ids(14, 6), "E1"]].map((evidence, index): Row => ({
      id: "rev 13", name: `keeps a sentence's first 12 item ids past the cap with its list id ${["after", "before", "among"][index]} them, so a list id never takes a private row's place`,
      bundle: teamRows(listBundle(8, 11, [list("L1", ids(2, 7)), list("L2", ["E1"])], [C(ids(9, 11))]), ["E1"]), replies: [say({ text: "THERM-1 waits on the approved records.", evidence })],
      q: "What waits on the approved records?", status: "answered", says: [st("THERM-1 waits on the approved records.", 12)], cited: [...ids(9, 11), "E1"],
    })),
    { id: "W1, W5", name: "leaves out a rows sentence beside a content sentence after one repair, the kept one citing L1's rows after its text", bundle: eightAnd1([WI(["L1"])]), replies: [say(FOUR, ON_THEM), say(FOUR, ON_THEM)], calls: 2, repaired: true, q: "Which tickets were created on October 4, and what did the review approve?", status: "partial", gap: UNSUPPORTED, says: [EIGHT, st(ON_THEM.text, [8, 0, 1, 2, 3, 4, 5, 6, 7])] },
    { id: "W1, W5", name: "adds a which_say need's unchecked gap and notes no sentence citing no member's text", bundle: eightAnd1([WI(["L1"]), WS(["L1", "E9"])]), replies: [say(FOUR, ON_THEM), say(FOUR, ON_THEM)], calls: 2, q: "Which tickets were created on October 4, and what did the review approve?", status: "partial", gap: `${UNCHECKED} ${UNSUPPORTED}`, says: [EIGHT, st(ON_THEM.text, [8, 0, 1, 2, 3, 4, 5, 6, 7])] },
    { id: "CF5b", name: "says 'at least' for a list not read to a confirmed end, and leaves out a count resting on one row and the list's id", bundle: listBundle(25, 0, [list("L1", ids(1, 25), { unverified_end: true })], [WI(["L1"])]),
      replies: Array.from({ length: 2 }, () => say({ text: "25 tickets were created on October 4, 2026.", evidence: ["L1", "E1"] })), calls: 2, status: "partial", gap: `${LEG} ${UNSUPPORTED}`, says: [st(`At least 25 tickets created on October 4, 2026: ${names(1, 25)}.`, 25)] },
    // Opened ticket rows carry their text: citing it is citing text, whatever it says.
    ...([[[C(["E1"])], ["THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]], [[WI(["L1"])], [`5 tickets created on October 4, 2026: ${names(1, 5)}.`, "THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]], [[WI(["L1"]), C(["E1"])], [`5 tickets created on October 4, 2026: ${names(1, 5)}.`, "THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]]] as const)
      .map(([needs, says]): Row => ({
        id: "W4", name: `${needs.length === 2 ? "keeps sentences on what a content need asks about beside the stated list" : needs[0]!.kind === undefined ? "states no list for a content need: both sentences stand on their text" : "keeps distinct text beside a stated list regardless of planner kind"}`,
        bundle: Object.freeze({ ...EMPTY_BUNDLE, lists: [list("L1", ids(1, 5))], plan: planOf(needs), items: Array.from({ length: 5 }, (_, index) => ({ short: `E${index + 1}`, source: "tickets", item: ticketRow(index + 1, `THERM-${index + 1}: work ${index + 1} is in progress.`), full: true, opened: true, preloaded: false, touched: index + 1, cited_by_plan: needs.some(need => need.evidence.includes(`E${index + 1}`)) })) }),
        replies: [say({ text: "THERM-1 and THERM-2 were created on October 4.", evidence: ["E1", "E2"] }, { text: "THERM-1 is in progress.", evidence: ["E1"] })], status: "answered", says,
      })),
    // Every member by id is still a selection by id: their row facts, never which items exist (W2).
    ...([[ids(1, 3), `3 of the 3 tickets created on October 4, 2026: ${facts(1, 3)}.`, 3], [["E2", "E9"], `1 of the 3 tickets created on October 4, 2026: ${facts(2)}.`, 1]] as const).map(([members, text, count]): Row => ({
      id: "W2", name: `states the row facts of ${count === 3 ? "every member" : "one member"} the writer selects by id, from their own rows`, bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]),
      replies: [use({ id: "L1", members })], q: "Which tickets are in progress?", status: "answered", says: [st(text, count)],
    })),
    { id: "C4", name: "states one member's facts on a list not read to a confirmed end, the lead saying 'at least'", bundle: listBundle(25, 1, [list("L1", ids(1, 25), { unverified_end: true })], [C(["E26"])]), replies: [use({ id: "L1", members: ["E2"] })], q: "Who owns THERM-2?", status: "answered", says: [st(`1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`, 1)] },
    { id: "C4b (misdeclared)", name: "keeps the explicit member selection and its incomplete-list gap", bundle: listBundle(25, 1, [list("L1", ids(1, 25), { unverified_end: true })], [WI(["L1"])]), replies: [use({ id: "L1", members: ["E2"] })], q: "Who owns THERM-2?", status: "partial", gap: LEG, says: [`1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`], citations: 1 },
    // A list cut short: a use in full or by where says which items exist, with the list-end gap; a selection by id alone never does.
    { id: "R9 (iii)", name: "states an explicit selection covering the whole declared list with its full lead and gap", bundle: cut(1, [WI(["L1"])]), replies: [use({ id: "L1", members: ids(1, 25) })], status: "partial", gap: LEG, says: [`At least 25 tickets created on October 4, 2026: ${facts(1, 25)}.`] },
    { id: "R9 (iv)", name: "names only the ten selected members with their facts and incomplete-list gap", bundle: cut(1, [WI(["L1"])]), replies: [use({ id: "L1", members: ids(1, 10) })], q: "Which tickets created on October 4 are in review or blocked?", status: "partial", gap: LEG, says: [`10 of at least 25 tickets created on October 4, 2026: ${facts(1, 10)}.`], citations: 10 },
    ...([[10, "R9 (v)"], [25, "R9 (vi)"]] as const).map(([count, id]): Row => ({
      id, name: `states only the facts of ${count} members by id beside a content need, answered: no which_items need`, bundle: cut(1, [C(["E26"])]),
      replies: [use({ id: "L1", members: ids(1, count) })], q: "Which tickets created on October 4 are in review or blocked?", status: "answered", says: [st(`${count} of at least 25 tickets created on October 4, 2026: ${facts(1, count)}.`, count)],
    })),
    { id: "R9 (i)", name: "says 'at least' with the list-end gap for a stated list in full", bundle: reviewed(), replies: [use({ id: "L1" })], status: "partial", gap: LEG, says: [`At least 25 tickets created on October 4, 2026: ${[...names(1, 5).split("; ").map(name => `${name} (In Review)`), ...names(6, 20).split("; ").map(name => `${name} (In Progress)`)].join("; ")}.`] },
    { id: "R9 (ii)", name: "says how many were listed for a where selection", bundle: reviewed(), replies: [use({ id: "L1", where: { field: "status", value: "in review" } })], q: "Which tickets created on October 4 are in review?", status: "partial", gap: LEG, says: [`At least 5 tickets created on October 4, 2026 have status In Review (25 listed so far): ${names(1, 5)}.`] },
    { id: "X24c", name: "leaves out a sentence resting on rows alone after its repair, and falls back to the record a content need read", bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]),
      replies: Array.from({ length: 2 }, () => say({ text: "THERM-2 is in progress.", evidence: ["E2"] })), calls: 2, repaired: true, q: "Is THERM-2 in progress?", status: "records_only", says: [], gap: `${RECORDS} ${UNSUPPORTED}`,
      check: rendered => expect(rendered.result.response.parts[0]!.records).toEqual([expect.objectContaining({ text: "Approved record 1.", citation_indexes: [0] })]) },
    { id: "X24c", name: "answers the repair's selection by id", bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]), replies: [say({ text: "THERM-2 is in progress.", evidence: ["E2"] }), use({ id: "L1", members: ["E2"] })], calls: 2, q: "Is THERM-2 in progress?", status: "answered", says: [`1 of the 3 tickets created on October 4, 2026: ${facts(2)}.`] },
    ...([["X24a", WS(["L1", "E9"]), UNCHECKED], ["X24b", WI(ids(1, 8)), "I could not confirm the full list of items asked for."]] as const).map(([id, need, gap]): Row => ({
      id, name: `gives the records a failed writer falls back to ${id === "X24a" ? "a which_say list's unchecked gap" : "the gap of a which_items need left on rows"}`, bundle: eightAnd1([need]), replies: [{ wrong: true }, { still: "wrong" }], calls: 2,
      q: "Which tickets created on October 4 mention BUG-412?", status: "records_only", gap: `${RECORDS} ${gap}`, check: rendered => expect(rendered.result.response.parts[0]!.records).toEqual([expect.objectContaining({ text: "Approved record 1." })]),
    })),
    ...[[REVIEW], [REVIEW, { text: "THERM-2 is in progress.", evidence: ["E2"] }]].map((sentences): Row => ({
      id: "W1", name: sentences.length === 1 ? "states the list beside the writer's sentence with no model call left for a repair" : "leaves out a rows sentence it cannot send back, and says so",
      bundle: eightAnd1([WI(["L1"]), C(["E9"])], { ...EMPTY_BUNDLE.budget, max_model_calls: 1 }), replies: [{ sentences, not_found: [] }], says: [EIGHT, REVIEW.text],
      ...(sentences.length === 1 ? { status: "answered", check: (rendered: Rendered) => expect(rendered.fallbacks).toBe(0) } : { status: "partial", gap: UNSUPPORTED }),
    })),
    { id: "W6", name: "shares 25 names across legacy lists and marks the omitted members partial", bundle: listBundle(68, 0, [list("L1", ids(1, 8)), list("L2", ids(9, 60))], [WI(["L1", "L2"])]), replies: [use({ id: "L1" }, { id: "L2" })], status: "partial", gap: FIT, says: [EIGHT, `60 tickets created on October 4, 2026: ${names(9, 17)}; and 43 more.`], citations: 25 },
    {
      // E1, E2 and E8 share a title and row facts, so they are one name; E2 alone is private. The by-id statement takes the answer's 25 names.
      id: "X25", name: "names no member a statement does not cite, so a merged name never covers a private member uncited (W6)", replies: [use({ id: "L1" }, { id: "L1", members: ids(3, 25) })], status: "partial", gap: FIT,
      bundle: (research => Object.freeze({ ...research, items: research.items.map((entry, index) => Object.freeze({ ...entry, item: { ...entry.item, visibility: index === 1 ? "only_me" as const : "team" as const, ...(index < 2 ? { label: "THERM-8: Fixture work 8" } : {}) } })) }))(listBundle(27, 0, [list("L1", ids(1, 27))], [WI(["L1"])])),
      says: [st(`27 tickets created on October 4, 2026: THERM-8: Fixture work 8 (2 tickets); ${names(3, 5)}; ${names(9, 19)}; and 1 more.`, 26, true), { text: expect.stringMatching(/^25 of the 27 tickets created on October 4, 2026: THERM-3: /u), citation_indexes: expect.any(Array), private: false }],
      cited: ["E1", ...ids(3, 25)] },
    { id: "W6", name: "keeps the 40-citation bound: list statements first, the writer's sentences dropped from the end", bundle: listBundle(60, 20, [list("L1", ids(1, 60))], [WI(["L1"])]), q: "Which tickets were created on October 4, and what applies?",
      replies: [{ lists: [{ id: "L1" }], sentences: Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${61 + 2 * index}`, `E${62 + 2 * index}`] })), not_found: [] }],
      // 25 named rows, then seven sentences of two citations each: the eighth would make 41.
      status: "partial", gap: FIT, citations: 39, cited: [...ids(1, 25), ...ids(61, 14)],
      check: rendered => expect(rendered.result.response.parts[0]!.statements.map(value => value.text)).toEqual([expect.stringMatching(/; and 35 more\.$/u), ...Array.from({ length: 7 }, (_, index) => `Record ${index + 1} applies.`)]) },
    { id: "W6", name: "keeps the ten-statement bound", bundle: listBundle(63, 10, [list("L1", ids(1, 60)), list("L2", ids(61, 3))], [WI(["L1", "L2"])]), q: "Which tickets?", status: "partial", gap: FIT,
      replies: [{ lists: [{ id: "L1" }, { id: "L2" }], sentences: Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${64 + index}`] })), not_found: [] }],
      check: rendered => expect(rendered.result.response.parts[0]!.statements.map(value => value.text).slice(2)).toEqual(Array.from({ length: 8 }, (_, index) => `Record ${index + 1} applies.`)) },
    {
      // E9 is a record outside L1: the sentence cites no member's text, so it carries no note; none of the 8 was checked.
      id: "CF5c", name: "adds the unchecked gap for a which_say list even when no sentence cites its members, and notes no sentence", bundle: eightAnd1([WS(["L1", "E9"])]), replies: [say({ text: "THERM-1 mentions BUG-412.", evidence: ["L1", "E9"] })],
      q: "Which tickets created on October 4 mention BUG-412?", status: "partial", gap: UNCHECKED, says: [st("THERM-1 mentions BUG-412.", 9)], cited: ["E9", ...ids(1, 8)],
      check: (_, run) => expect(run.prompt(0).lists[0]).toMatchObject({ id: "L1", stated: false, checked: 0 }) },
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
      replies: [{ lists: [{ id: "L1" }], sentences: [{ text: "THERM-46 is blocked by BUG-412.", evidence: ["E2"] }], not_found: [] }],
      says: [st("1 ticket created on October 4, 2026: THERM-46: Fixture work 46.", 1), st("THERM-46 is blocked by BUG-412.", 1)] },
  ]);

  describe("as tables (answer layout v1, ADR-0045)", () => {
    const laid = async (research: AgenticEvidenceBundleV1, reply: unknown) => {
      const rendered = await alone({ bundle: research, replies: [reply], layout: 1 }).render("Which tickets were created on October 4?");
      const part = rendered.result.response.parts[0]!;
      expect(validatePersonAnswerLayoutV1(part.layout, part.statements, rendered.result.response.citations.length)).toEqual(part.layout);
      return part;
    };
    const lead = (evidence: string) => ({ ...REVIEW, evidence: [evidence], form: "lead" });
    it("tabulates a list of three tickets after the lead: a row per ticket citing its own, the count phrase its caption", async () => {
      const part = await laid(listBundle(3, 1, [list("L1", ids(1, 3))], [WI(["L1"])]), { lists: [{ id: "L1" }], sentences: [lead("E4")], not_found: [] });
      expect(part.statements.map(value => [value.text, value.citation_indexes])).toEqual([[REVIEW.text, [0]], [`3 tickets created on October 4, 2026: ${names(1, 3)}.`, [1, 2, 3]]]);
      expect(part.layout).toEqual([
        { kind: "lead", statements: [0] },
        { kind: "table", statements: [1], columns: ["Item", "Status", "Owner"], caption: "3 tickets created on October 4, 2026", rows: [1, 2, 3].map(n => ({ cells: [`THERM-${n}: Fixture work ${n}`, "In Progress", "Dana Lee"], citation_indexes: [n] })) },
      ]);
    });
    it("decides what fits before it reads lead first, so two long leads never crowd out a stated list (W3)", async () => {
      // 25 rows stated by code, then two leads citing twelve records each: the second lead is past 40 citations, not the list.
      const twelve = (from: number) => Array.from({ length: 12 }, (_, index) => `E${from + index}`);
      const part = await laid(listBundle(25, 24, [list("L1", ids(1, 25))], [WI(["L1"])]), { lists: [{ id: "L1" }], not_found: [], sentences: [
        { text: "The first review approved the fixture work.", evidence: twelve(26), form: "lead" },
        { text: "The second review confirmed it.", evidence: twelve(38), form: "lead" },
      ] });
      expect(part.statements.map(value => value.text)).toEqual(["The first review approved the fixture work.", expect.stringMatching(/^25 tickets created on October 4, 2026: /u)]);
      expect(part.layout!.map(block => block.kind)).toEqual(["lead", "table"]);
      expect(part.gap).toContain("Some evidence could not fit in this response.");
    });
    it("captions what its names leave out, and cites every member a merged name covers", async () => {
      // E1, E2 and E8 share THERM-8's title and row facts: one name, one row citing all three.
      const research = listBundle(30, 0, [list("L1", ids(1, 30))], [WI(["L1"])]);
      const part = await laid(Object.freeze({ ...research, items: research.items.map((entry, index) => index < 2 ? Object.freeze({ ...entry, item: { ...entry.item, label: "THERM-8: Fixture work 8" } }) : entry) }), use({ id: "L1" }));
      expect(part.statements[0]!.text).toMatch(/; and 5 more\.$/u);
      const [table] = part.layout!;
      expect(table).toMatchObject({ kind: "table", statements: [0], columns: ["Item", "Status", "Owner"], caption: "30 tickets created on October 4, 2026; and 5 more" });
      expect(table!.kind === "table" && [table.rows.length, table.rows[0]]).toEqual([23, { cells: ["THERM-8: Fixture work 8 (3 tickets)", "In Progress", "Dana Lee"], citation_indexes: [0, 1, 7] }]);
    });
    it("tabulates members selected by id with the dates they state, and keeps a list that names one member as prose", async () => {
      const byId = await laid(listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]), { lists: [{ id: "L1", members: ["E1", "E2"] }], sentences: [lead("E4")], not_found: [] });
      expect(byId.layout![1]).toEqual({ kind: "table", statements: [1], columns: ["Item", "Status", "Owner", "Created"], caption: "2 of the 3 tickets created on October 4, 2026",
        rows: [1, 2].map(n => ({ cells: [`THERM-${n}: Fixture work ${n}`, "In Progress", "Dana Lee", "2026-10-04"], citation_indexes: [n] })) });
      const one = await laid(listBundle(1, 1, [list("L1", ["E1"])], [WI(["L1"])]), { lists: [{ id: "L1" }], sentences: [lead("E2")], not_found: [] });
      expect(one.layout).toEqual([{ kind: "lead", statements: [0] }, { kind: "paragraph", statements: [1] }]);
    });
    it("reads a row whose sentence carries code's checked note as prose, so the note shows (W5)", async () => {
      const research: AgenticEvidenceBundleV1 = Object.freeze({
        ...EMPTY_BUNDLE, lists: [list("L1", ["E1", "E2"])], plan: planOf([WS(["L1", "E1"])]),
        items: [
          { short: "E1", source: "tickets", item: ticketRow(1, "THERM-1: BUG-412 blocks DVT."), full: true, opened: true, preloaded: false, touched: 1, cited_by_plan: true },
          { short: "E2", source: "tickets", item: ticketRow(2), full: false, opened: false, preloaded: false, touched: 2, cited_by_plan: false },
        ],
      });
      const part = await laid(research, { lists: [], tables: [{ section: "Blocked", columns: ["Ticket", "Blocker"] }], not_found: [], sentences: [
        { text: "THERM-1 is blocked by BUG-412.", evidence: ["E1"], form: "row", section: "Blocked", cells: ["THERM-1", "BUG-412"] },
      ] });
      expect(part.statements[0]!.text).toBe("Ticket: THERM-1; Blocker: BUG-412 (1 of 2 checked so far).");
      expect(part.layout).toEqual([{ kind: "heading", text: "Blocked" }, { kind: "paragraph", statements: [0] }]);
    });
  });

  describe("as tables among blocks (answer layout v2, ADR-0051)", () => {
    const arranged = async (research: AgenticEvidenceBundleV1, reply: unknown) => {
      const rendered = await alone({ bundle: research, replies: [reply], layout: 2 }).render("Which tickets were created on October 4?");
      blocksOf(rendered);
      return rendered.result.response.parts[0]!;
    };
    it.each([false, true])("states the declared inventory when research found it and the writer omitted selection (incomplete: %s)", async incomplete => {
      const rendered = await alone({ bundle: listBundle(12, 0, [list("L1", ids(1, 12), incomplete ? { unverified_end: true } : {})], [WI(["L1"])]), layout: 2, replies: [{
        lists: [], blocks: [{ block: "answer", sentences: [{ text: "Here are the open tickets.", evidence: [] }] }], not_found: [],
      }] }).render("Which tickets are open?");
      expect(rendered.outcome).toBe(incomplete ? "partial" : "answered");
      expect(rendered.cited).toEqual(ids(1, 12));
      expect(blocksOf(rendered)).toMatchObject([{ kind: "table", caption: `${incomplete ? "At least " : ""}12 tickets created on October 4, 2026`, rows: Array.from({ length: 12 }, () => expect.any(Object)) }]);
    });
    it("adds research's requested members to a writer selection that leaves some out", async () => {
      const requested = ids(5, 43);
      const rendered = await alone({ bundle: listBundle(100, 0, [list("L1", ids(1, 100))], [WI(["L1", ...requested])]), layout: 2, replies: [{
        lists: [{ id: "L1", members: requested.slice(0, 25) }], blocks: [], not_found: [],
      }] }).render("Which THERM tickets are To Do or In Progress?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(requested);
      expect(blocksOf(rendered)).toMatchObject([{ kind: "table", caption: "43 of the 100 tickets created on October 4, 2026", rows: Array.from({ length: 43 }, () => expect.any(Object)) }]);
    });
    it.each([
      { evidence: ["L1"], caption: "12 tickets created on October 4, 2026", cited: ids(1, 12) },
      { evidence: ["L1", "E2", "E3"], caption: "2 of the 12 tickets created on October 4, 2026", cited: ["E2", "E3"] },
    ])("states the list of a which_items need still open when research stopped, and stays partial ($evidence)", async ({ evidence, caption, cited }) => {
      const found = listBundle(12, 0, [list("L1", ids(1, 12))], [WI(evidence)]);
      const stopped: AgenticEvidenceBundleV1 = { ...found, stop: { reason: "budget", completed: false },
        plan: [{ part: 1, question: "Which tickets are open?", notes: "", needs: [{ need: "open tickets", kind: "which_items", status: "open", evidence }] }] };
      const rendered = await alone({ bundle: stopped, layout: 2, replies: [{
        lists: [], blocks: [{ block: "answer", sentences: [{ text: "Here are the open tickets.", evidence: [] }] }], not_found: [],
      }] }).render("Which tickets are open?");
      expect(rendered.outcome).toBe("partial");
      expect(rendered.cited).toEqual(cited);
      expect(blocksOf(rendered)).toMatchObject([{ kind: "table", caption }]);
    });
    it("keeps the precise members research found when the writer omits its list selection", async () => {
      const selected = ids(5, 43);
      const rendered = await alone({ bundle: listBundle(100, 0, [list("L1", ids(1, 100))], [WI(["L1", ...selected])]), layout: 2, replies: [{
        lists: [], blocks: [{ block: "answer", sentences: [{ text: "Here are the open tickets.", evidence: [] }] }], not_found: [],
      }] }).render("Which THERM tickets are To Do or In Progress?");
      expect(rendered.cited).toEqual(selected);
      expect(blocksOf(rendered)).toMatchObject([{ kind: "table", caption: "43 of the 100 tickets created on October 4, 2026", rows: Array.from({ length: 43 }, () => expect.any(Object)) }]);
    });
    it.each([undefined, 1, 2] as const)("preserves each found need's fallback when an L-only need shares an inventory with a precise selection (layout: %s)", async layout => {
      const selected = ["E2"];
      const research = listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"]), WI(["L1", ...selected])]);
      const rendered = await alone({ bundle: research, ...(layout === undefined ? {} : { layout }), replies: [layout === 2
        ? { lists: [], blocks: [], not_found: [] } : { lists: [], sentences: [], not_found: [] }] }).render("Which tickets exist, and which one is assigned to Casey?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(ids(1, 3));
      expect(rendered.result.response.parts[0]!.statements).toHaveLength(1);
      expect(rendered.result.response.parts[0]!.statements[0]!.text).toMatch(/^3 tickets/u);
    });
    it.each([undefined, 2] as const)("states only the members a need cites by id, never the whole of another list it cites (layout: %s)", async layout => {
      // E2 and E3 are members of L1 only: the need requests them, and L2's ten tickets are no answer.
      const research = listBundle(13, 0, [list("L1", ids(1, 3)), list("L2", ids(4, 10), { filter: { status: "open" }, filter_applied: { status: "applied" } })], [WI(["L1", "L2", "E2", "E3"])]);
      const rendered = await alone({ bundle: research, ...(layout === undefined ? {} : { layout }), replies: [layout === 2
        ? { lists: [], blocks: [], not_found: [] } : { lists: [], sentences: [], not_found: [] }] }).render("Which of the tickets are open?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E2", "E3"]);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([expect.stringMatching(/^2 of the 3 tickets created on October 4, 2026: /u)]);
    });
    it.each([{ members: [], cited: ids(1, 3) }, { members: ["E3"], cited: ["E2", "E3"] }])("states the writer's selection with research's requested members, or the declared list when the writer selects none, for a list an L-only need and a precise need share ($members)", async ({ members, cited }) => {
      const research = listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"]), WI(["L1", "E2"])]);
      const rendered = await alone({ bundle: research, layout: 2, replies: [{ lists: [{ id: "L1", members }], blocks: [], not_found: [] }] }).render("Which tickets exist, and which one is assigned to Casey?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(cited);
    });
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
    it("preserves an L-only fallback beside another need's grounded member without duplicating that presentation", async () => {
      const original = fullListBundle("documents", [document(1), document(2), document(3)], ["E2"]);
      const rendered = await alone({ bundle: { ...original, plan: planOf([WI(["L1"]), WI(["L1", "E2"])]) }, layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "points", ordered: false, items: [{ text: "LIVE-QA-20261104-A Atlas ledger 2 is open.", member: "E2", evidence: ["E2"] }] }],
      }] }).render("Which ledger entries exist, and which one is open?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E1", "E3", "E2"]);
      expect(rendered.result.response.parts[0]!.statements).toHaveLength(2);
      expect(rendered.result.response.parts[0]!.statements[0]!.text).not.toContain("ledger 2");
    });
    it("states the rest of a declared list beside members bound to rows, whether a need requests them or not", async () => {
      // E2 answers the precise need and no need requests E1: bindings never narrow the declared list, so code states E3.
      const original = fullListBundle("documents", [document(1), document(2), document(3)], ["E2"]);
      const rendered = await alone({ bundle: { ...original, plan: planOf([WI(["L1"]), WI(["L1", "E2"])]) }, layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "points", ordered: false, items: [
          { text: "LIVE-QA-20261104-A Atlas ledger 1 is closed.", member: "E1", evidence: ["E1"] }, { text: "LIVE-QA-20261104-A Atlas ledger 2 is open.", member: "E2", evidence: ["E2"] },
        ] }],
      }] }).render("Which ledger entries exist, and which one is open?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E3", "E1", "E2"]);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([
        expect.stringMatching(/^1 of the 3 documents created on October 4, 2026: LIVE-QA-20261104-A Atlas ledger 3/u), "LIVE-QA-20261104-A Atlas ledger 1 is closed.", "LIVE-QA-20261104-A Atlas ledger 2 is open.",
      ]);
    });
    it("states the rest of a declared list beside a point bound to one member that a content need cites", async () => {
      const original = fullListBundle("documents", Array.from({ length: 5 }, (_, index) => document(index + 1)), []);
      const rendered = await alone({ bundle: { ...original, plan: planOf([WI(["L1"]), C(["E3"])]) }, layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "points", ordered: false, items: [{ text: "LIVE-QA-20261104-A Atlas ledger 3 is open.", member: "E3", evidence: ["E3"] }] }],
      }] }).render("Which ledger entries exist, and is ledger 3 open?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E1", "E2", "E4", "E5", "E3"]);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([expect.stringMatching(/^4 of the 5 documents created on October 4, 2026: /u), "LIVE-QA-20261104-A Atlas ledger 3 is open."]);
    });
    describe("27 documents, 22 of them ledger entries, each bound to a row of the writer's table", () => {
      // List-only research: E3 to E24 are ledger entries; the other five are checklists.
      const ledger = ids(3, 22);
      const items = Array.from({ length: 27 }, (_, index) => ledger.includes(`E${index + 1}`) ? document(index + 1)
        : { ...document(index + 1), label: `LIVE-QA-20261104-A Atlas checklist ${index + 1}`, text: `Checklist ${index + 1}: release steps.` });
      const table = { block: "table", title: "Open ledger", columns: ["Entry", "Owner"], rows: ledger.map(id => ({ member: id, cells: [`LIVE-QA-20261104-A Atlas ledger ${id.slice(1)}`, "Casey"], evidence: [id] })) };
      it("states the five other documents when the writer selects none of the list", async () => {
        const rendered = await alone({ bundle: fullListBundle("documents", items, []), layout: 2, replies: [{ lists: [], not_found: [], blocks: [table] }] }).render("Show every open Atlas ledger entry and its owner.");
        expect(rendered.outcome).toBe("answered");
        expect(rendered.cited).toEqual([...["E1", "E2", "E25", "E26", "E27"], ...ledger]);
        expect(rendered.result.response.parts[0]!.statements[0]!.text).toMatch(/^5 of the 27 documents created on October 4, 2026: LIVE-QA-20261104-A Atlas checklist 1/u);
        expect(blocksOf(rendered)).toMatchObject([{ kind: "text", statements: [0] }, { kind: "table", title: "Open ledger", rows: Array.from({ length: 22 }, () => expect.any(Object)) }]);
      });
      it("states nothing more when the writer selects the 22 entries in lists", async () => {
        const rendered = await alone({ bundle: fullListBundle("documents", items, []), layout: 2, replies: [{ lists: [{ id: "L1", members: ledger }], not_found: [], blocks: [table] }] }).render("Show every open Atlas ledger entry and its owner.");
        expect(rendered.outcome).toBe("answered");
        expect(rendered.cited).toEqual(ledger);
        expect(blocksOf(rendered)).toMatchObject([{ kind: "table", title: "Open ledger", rows: Array.from({ length: 22 }, () => expect.any(Object)) }]);
        expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text).join(" ")).not.toMatch(/documents|checklist/u);
      });
    });
    it("keeps the precise 22 ledger rows through explicit member bindings without adding the 27-document inventory", async () => {
      const selected = ids(3, 22);
      const run = alone({ bundle: fullListBundle("documents", Array.from({ length: 27 }, (_, index) => document(index + 1)), selected), layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "table", title: "Open ledger", columns: ["Entry", "Owner"], rows: selected.map(id => ({ member: id, cells: [`LIVE-QA-20261104-A Atlas ledger ${id.slice(1)}`, "Casey"], evidence: [id] })) }],
      }] });
      const rendered = await run.render("Show every open Atlas ledger entry and its owner.");
      expect(rendered.outcome).toBe("answered");
      expect(run.prompt(0).lists[0].requested_members).toEqual(selected);
      const blocks = blocksOf(rendered);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: "table", rows: Array.from({ length: 22 }, () => expect.any(Object)) });
      expect(rendered.cited).toEqual(selected);
      expect(rendered.result.response.parts[0]!.statements.every(statement => statement.citation_indexes.length === 1)).toBe(true);
    });
    it.each([
      { name: "a citation without a member declaration", member: undefined, evidence: ["E1"], cells: ["Unrelated conclusion", "Casey"] },
      { name: "an unknown member", member: "E999", evidence: ["E1"], cells: ["Ledger", "Casey"] },
      { name: "a mismatched member citation", member: "E1", evidence: ["E2"], cells: ["Ledger", "Casey"] },
      { name: "a row downgraded to prose", member: "E1", evidence: ["E1"], cells: ["Ledger"] },
    ])("does not let $name suppress a research member", async ({ member, evidence, cells }) => {
      const rendered = await alone({ bundle: fullListBundle("documents", [document(1), document(2)], ["E1"]), layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "table", columns: ["Entry", "Owner"], rows: [{ ...(member === undefined ? {} : { member }), evidence, cells }] }],
      }] }).render("Which ledger entry is open?");
      expect(rendered.result.response.parts[0]!.statements.some(statement => statement.text.startsWith("1 of the 2") && statement.text.includes("LIVE-QA-20261104-A Atlas ledger 1"))).toBe(true);
      expect(rendered.cited).toContain("E1");
    });
    it.each([
      { name: "a row bound to one member whose cells and citations are another's too", selected: "E2", block: { block: "table", columns: ["Entry", "Owner"], rows: [{ member: "E2", evidence: ["E1", "E2"], cells: ["Ledger 1", "Casey"] }] } },
      { name: "an aggregate point bound to one member that cites another member too", selected: "E1", block: { block: "points", ordered: false, items: [{ text: "Several ledger entries are open.", member: "E1", evidence: ["E1", "E2"] }] } },
    ])("does not let $name present it: code still states the member", async ({ selected, block }) => {
      const rendered = await alone({ bundle: fullListBundle("documents", [document(1), document(2)], [selected]), layout: 2, replies: [{ lists: [], not_found: [], blocks: [block] }] }).render("Which ledger entry is open?");
      expect(rendered.result.response.parts[0]!.statements.some(statement => statement.text.startsWith("1 of the 2") && statement.text.includes(`LIVE-QA-20261104-A Atlas ledger ${selected.slice(1)}`))).toBe(true);
      expect(rendered.cited).toContain(selected);
    });
    it("lets a comparison row that names its member also cite another member", async () => {
      const rendered = await alone({ bundle: fullListBundle("documents", [document(1), document(2)], ["E1"]), layout: 2, replies: [{ lists: [], not_found: [], blocks: [{
        block: "table", columns: ["Entry", "Versus ledger 2"], rows: [{ member: "E1", evidence: ["E1", "E2"], cells: ["LIVE-QA-20261104-A Atlas ledger 1", "Opened the same day"] }],
      }] }] }).render("How does ledger 1 compare with ledger 2?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual(["Entry: LIVE-QA-20261104-A Atlas ledger 1; Versus ledger 2: Opened the same day."]);
      expect(rendered.cited).toEqual(["E1", "E2"]);
    });
    it("lets a dependency table present each entry it names, each row citing the entry it depends on too", async () => {
      const rows = [[1, 2], [2, 3], [3, 1]].map(([n, on]) => ({ member: `E${n}`, evidence: [`E${n}`, `E${on}`], cells: [`LIVE-QA-20261104-A Atlas ledger ${n}`, `Ledger ${on}`] }));
      const rendered = await alone({ bundle: fullListBundle("documents", [document(1), document(2), document(3)], []), layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "table", title: "Dependencies", columns: ["Entry", "Depends on"], rows }],
      }] }).render("Which ledger entries exist, and what does each depend on?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([1, 2, 3].map(n => `Entry: LIVE-QA-20261104-A Atlas ledger ${n}; Depends on: Ledger ${[2, 3, 1][n - 1]}.`));
      expect(blocksOf(rendered)).toMatchObject([{ kind: "table", title: "Dependencies" }]);
    });
    it("lets 22 bound ledger rows that also cite a checklist present their entries, restating none", async () => {
      // E1 is a checklist among the 27 documents; each ledger row cites it beside its own entry.
      const selected = ids(3, 22);
      const items = Array.from({ length: 27 }, (_, index) => selected.includes(`E${index + 1}`) ? document(index + 1)
        : { ...document(index + 1), label: `LIVE-QA-20261104-A Atlas checklist ${index + 1}`, text: `Checklist ${index + 1}: release steps.` });
      const rendered = await alone({ bundle: fullListBundle("documents", items, selected), layout: 2, replies: [{ lists: [], not_found: [], blocks: [{
        block: "table", title: "Open ledger", columns: ["Entry", "Owner"], rows: selected.map(id => ({ member: id, cells: [`LIVE-QA-20261104-A Atlas ledger ${id.slice(1)}`, "Casey"], evidence: [id, "E1"] })),
      }] }] }).render("Show every open Atlas ledger entry and its owner.");
      expect(rendered.outcome).toBe("answered");
      expect(blocksOf(rendered)).toMatchObject([{ kind: "table", title: "Open ledger", rows: Array.from({ length: 22 }, () => expect.any(Object)) }]);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text).join(" ")).not.toMatch(/documents/u);
    });
    it("reads a member declared by its opened body as that body's listed row, so code does not restate it", async () => {
      const research = listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1", "E2"])]);
      const opened = { ...research, items: [...research.items, { short: "E4", source: "tickets", item: ticketRow(2, "THERM-2: the fixture is late."), full: true, opened: true, preloaded: false, touched: 4, cited_by_plan: false }] };
      const rendered = await alone({ bundle: opened, layout: 2, replies: [{ lists: [], not_found: [], blocks: [{ block: "points", ordered: false, items: [{ text: "THERM-2 waits on the fixture.", member: "E4", evidence: ["E4"] }] }] }] }).render("Which ticket waits on the fixture?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual(["THERM-2 waits on the fixture."]);
      expect(rendered.cited).toEqual(["E4"]);
    });
    it("lets a bound row cite a source outside its list beside its member's own text", async () => {
      const research = fullListBundle("documents", [document(1), document(2)], ["E1"]);
      const supported = { ...research, items: [...research.items, { short: "E3", source: "meetings", item: record("ledger-note", "Casey owns ledger 1."), full: true, opened: true, preloaded: false, touched: 3, cited_by_plan: false }] };
      const rendered = await alone({ bundle: supported, layout: 2, replies: [{ lists: [], not_found: [], blocks: [{ block: "table", columns: ["Entry", "Owner"], rows: [{ member: "E1", evidence: ["E1", "E3"], cells: ["LIVE-QA-20261104-A Atlas ledger 1", "Casey"] }] }] }] }).render("Which ledger entry is open, and who owns it?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual(["Entry: LIVE-QA-20261104-A Atlas ledger 1; Owner: Casey."]);
      expect(rendered.cited).toEqual(["E1", "E3"]);
    });
    it("does not let a bound row dropped by the final citation limit suppress a research member", async () => {
      const rendered = await alone({ bundle: fullListBundle("documents", Array.from({ length: 45 }, (_, index) => document(index + 1)), ["E1"]), layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "table", columns: ["Entry", "Owner"], rows: [{ member: "E1", evidence: ["E1", "L1"], cells: ["LIVE-QA-20261104-A Atlas ledger 1", "Casey"] }] }],
      }] }).render("Which ledger entry is open?");
      expect(rendered.outcome).toBe("partial");
      expect(rendered.cited).toEqual(["E1"]);
      expect(rendered.result.response.parts[0]!.statements).toHaveLength(1);
      expect(rendered.result.response.parts[0]!.statements[0]!.text).toContain("LIVE-QA-20261104-A Atlas ledger 1");
    });
    it("restores research members before the plain fallback applies its presentation bounds", async () => {
      const selected = ids(1, 80);
      const rendered = await alone({ bundle: fullListBundle("documents", Array.from({ length: 80 }, (_, index) => document(index + 1)), selected), layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "table", columns: Array.from({ length: 8 }, (_, index) => `Detail ${index + 1}`), rows: selected.map(member => ({
          member, evidence: [member], cells: Array.from({ length: 8 }, (_, index) => `Ledger ${member.slice(1)} detail ${index + 1} ${"x".repeat(100)}`),
        })) }],
      }] }).render("Show every ledger entry with its details.");
      const part = rendered.result.response.parts[0]!;
      expect(part).not.toHaveProperty("blocks");
      expect(part).toMatchObject({ status: "partial", gap: FIT });
      expect(part.statements[0]!.text).toMatch(/^80 documents/u);
      expect(part.statements[0]!.text).toContain("and 55 more");
      expect(rendered.cited.slice(0, 25)).toEqual(ids(1, 25));
    });
    it.each([
      { source: "tickets", name: "THERM-2", items: [ticketRow(1, "Ticket one is open."), ticketRow(2, "Ticket two is open.")] },
      { source: "follow_ups", name: "THERM-42 follow-up", items: [followUpItem(1), followUpItem(2)] },
      { source: "projects", name: "Project 2", items: [1, 2].map(n => ({ id: `project-${n}`, kind: "project", label: `Project ${n}`, text: `Project ${n} is active.`, visibility: "project", citation: { kind: "project", project_id: `prj_00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, receipt_sha256: canonicalSha256(n) } satisfies EvidenceDeskItemV2)) },
      { source: "meetings", name: "Meeting two", items: [record("one", "Action one.", { kind: "action" }), record("two", "Action two.", { kind: "action" })] },
      { source: "documents", name: "LIVE-QA-20261104-A Atlas ledger 2", items: [document(1), document(2)] },
    ])("accepts a grounded point binding for $source without repeating the selected member", async ({ source, name, items }) => {
      const rendered = await alone({ bundle: fullListBundle(source, items, ["E2"]), layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "points", ordered: false, items: [{ text: `${name} is open.`, member: "E2", evidence: ["E2"] }] }],
      }] }).render("Which item is open?");
      expect(rendered.outcome).toBe("answered");
      expect(blocksOf(rendered)).toEqual([{ kind: "text", statements: [0] }]);
      expect(rendered.cited).toEqual(["E2"]);
    });
    it("maps an opened page section to the inventory member for selection and point binding", async () => {
      const row = pageRow(["123", "Full page title", "2026-10-04T18:00:00.000Z", "2026-10-04T18:00:00.000Z", "3"]);
      const research = fullListBundle("pages", [row, section(row, "The page is current.")], ["E2"]);
      const rendered = await alone({ bundle: { ...research, lists: [list("L1", ["E1"], { source: "pages" })], items: research.items.map((entry, index) => ({ ...entry, full: index === 1 })) }, layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "points", ordered: false, items: [{ text: "Full page title is current.", member: "E1", evidence: ["E2"] }] }],
      }] }).render("Which page is current?");
      expect(rendered.outcome).toBe("answered");
      expect(blocksOf(rendered)).toEqual([{ kind: "text", statements: [0] }]);
      expect(rendered.cited).toEqual(["E2"]);
    });
    it.each([undefined, 1] as const)("preserves a split selection before legacy presentation bounds (layout: %s)", async layout => {
      const selected = ids(5, 43);
      const rendered = await alone({ bundle: listBundle(100, 1, [list("L1", ids(1, 100))], [C(["E101"])]), ...(layout === undefined ? {} : { layout }), replies: [{
        lists: [{ id: "L1", members: selected.slice(0, 25) }, { id: "L1", members: selected.slice(25) }], sentences: [], not_found: [],
      }] }).render("Which THERM tickets are To Do or In Progress?");
      expect(rendered.outcome).toBe("partial");
      expect(rendered.result.response.parts[0]).toMatchObject({ status: "partial", gap: FIT });
      expect(rendered.result.response.parts[0]!.statements[0]!.text).toMatch(/^43 of the 100 tickets/u);
      expect(rendered.result.response.parts[0]!.statements[0]!.text).toContain("and 18 more");
      expect(rendered.cited).toEqual(selected.slice(0, 25));
    });
    it.each([false, true])("keeps all 43 selected tickets from a 100-ticket inventory without adding the inventory (split: %s)", async split => {
      const selected = ids(5, 43);
      const original = listBundle(100, 0, [list("L1", ids(1, 100))], [WI(["L1", ...selected])]);
      const research = { ...original, items: original.items.map((entry, index) => ({ ...entry, item: { ...entry.item, attributes: {
        ...entry.item.attributes, status: selected.includes(entry.short) ? index % 2 === 0 ? "To Do" : "In Progress" : "Done",
        ...(entry.short === selected.at(-1) ? { due_at: "2026-11-06" } : {}),
      } } })) };
      const groups = split ? [selected.slice(0, 25), selected.slice(25)] : [selected];
      const rendered = await alone({ bundle: research, layout: 2, replies: [{
        lists: groups.map(members => ({ id: "L1", members })), blocks: [], not_found: [],
      }] }).render("Which THERM tickets are To Do or In Progress? Show status, owner, due date.");
      const part = rendered.result.response.parts[0]!;
      const blocks = blocksOf(rendered);
      expect(part.status).toBe("answered");
      expect(part).not.toHaveProperty("gap");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: "table", caption: "43 of the 100 tickets created on October 4, 2026" });
      const table = blocks[0]!;
      if (table.kind !== "table") throw new Error("Expected selected tickets as one table");
      expect(table.rows.map(row => row.cells[0])).toEqual(Array.from({ length: 43 }, (_, index) => `THERM-${index + 5}: Fixture work ${index + 5}`));
      expect(table.rows.at(-1)!.cells[table.columns.indexOf("Due")]).toBe("2026-11-06");
      expect(table.rows.every(row => row.cells.length === table.columns.length)).toBe(true);
      expect(rendered.cited).toEqual(selected);
      expect(part.statements.every(statement => Buffer.byteLength(statement.text, "utf8") <= PERSON_ANSWER_STATEMENT_MAX_BYTES_V4 && statement.citation_indexes.length <= 40)).toBe(true);
      expect(part.statements.map(statement => statement.text).join(" ")).not.toContain("and 99 more");
    });
    it.each([{ members: [] }, { members: ["E999"] }])("states the declared inventory when a selection is empty or names no member of it ($members)", async ({ members }) => {
      // The writer reports absence through not_found; a selection that names no member is no selection.
      const rendered = await alone({ bundle: listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"])]), layout: 2, replies: [{ lists: [{ id: "L1", members }], blocks: [], not_found: [] }] }).render("Which tickets match?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(ids(1, 3));
      expect(blocksOf(rendered)).toMatchObject([{ kind: "table", caption: "3 tickets created on October 4, 2026" }]);
    });
    it("reads a member selected by its opened body as that body's listed row", async () => {
      const research = listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"])]);
      const opened = { ...research, items: [...research.items, { short: "E4", source: "tickets", item: ticketRow(2, "THERM-2: the fixture passed."), full: true, opened: true, preloaded: false, touched: 4, cited_by_plan: false }] };
      const { rendered, corrections } = await observed(() => alone({ bundle: opened, layout: 2, replies: [{ lists: [{ id: "L1", members: ["E4"] }], blocks: [], not_found: [] }] }).render("Which ticket passed?"));
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E2"]);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`1 of the 3 tickets created on October 4, 2026: ${facts(2)}.`]);
      expect(corrections).not.toHaveProperty("writer_unknown_id_dropped");
    });
    it.each([{ members: [] }, { members: ["E999"] }])("selects by a where the writer gave beside members that name none of the list ($members)", async ({ members }) => {
      const research = listBundle(5, 0, [list("L1", ids(1, 5))], [WI(["L1"])]);
      const mixed = { ...research, items: research.items.map((entry, index) => index % 2 === 0 ? entry : { ...entry, item: { ...entry.item, attributes: { status: "Done", owner: "Dana Lee" } } }) };
      const rendered = await alone({ bundle: mixed, layout: 2, replies: [{ lists: [{ id: "L1", where: { field: "status", value: "In Progress" }, members }], blocks: [], not_found: [] }] }).render("Which tickets are in progress?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E1", "E3", "E5"]);
      expect(rendered.result.response.parts[0]!.statements[0]!.text).toMatch(/^3 of the 5 tickets created on October 4, 2026 have status In Progress: /u);
    });
    it("states nothing of a declared list the writer selects explicitly empty beside not_found, and says what was not found", async () => {
      const rendered = await alone({ bundle: listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"])]), layout: 2, replies: [{
        lists: [{ id: "L1", members: [] }], blocks: [], not_found: ["tickets assigned to Casey"],
      }] }).render("Which tickets are assigned to Casey?");
      expect(rendered.outcome).toBe("not_found");
      expect(rendered.cited).toEqual([]);
      expect(rendered.result.response.parts[0]).toMatchObject({ status: "not_found", statements: [], gap: "Not found: tickets assigned to Casey." });
    });
    it("still states the members research requested when the writer selects their list explicitly empty beside not_found", async () => {
      const rendered = await alone({ bundle: listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1", "E2"])]), layout: 2, replies: [{
        lists: [{ id: "L1", members: [] }], blocks: [], not_found: ["tickets assigned to Casey"],
      }] }).render("Which tickets are assigned to Casey?");
      expect(rendered.cited).toEqual(["E2"]);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([expect.stringMatching(/^1 of the 3 tickets created on October 4, 2026: THERM-2: /u)]);
    });
    it.each([{ members: [] }, { members: ["E999"] }])("restores precise research members despite an empty or invalid writer selection ($members)", async ({ members }) => {
      const rendered = await alone({ bundle: listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1", "E2"])]), layout: 2, replies: [{ lists: [{ id: "L1", members }], blocks: [], not_found: [] }] }).render("Which tickets match?");
      expect(rendered.outcome).toBe("answered");
      expect(rendered.cited).toEqual(["E2"]);
      expect(rendered.result.response.parts[0]!.statements[0]!.text).toMatch(/^1 of the 3 tickets/u);
    });
    it("keeps incomplete-list coverage when bound points present all known selected members", async () => {
      const research = fullListBundle("documents", [document(1), document(2)], ["E1", "E2"]);
      const rendered = await alone({ bundle: { ...research, lists: [list("L1", ["E1", "E2"], { source: "documents", unverified_end: true })] }, layout: 2, replies: [{
        lists: [], not_found: [], blocks: [{ block: "points", ordered: false, items: [1, 2].map(n => ({ text: `LIVE-QA-20261104-A Atlas ledger ${n} is open.`, member: `E${n}`, evidence: [`E${n}`] })) }],
      }] }).render("Which ledger entries are open?");
      expect(rendered.outcome).toBe("partial");
      expect(rendered.cited).toEqual(["E1", "E2"]);
      expect(rendered.result.response.parts[0]!.gap).toContain("more may exist");
      expect(blocksOf(rendered)).toEqual([{ kind: "points", ordered: false, statements: [0, 1] }]);
    });
    it("keeps a no-match filter empty beside an empty explicit member group", async () => {
      const rendered = await alone({ bundle: listBundle(3, 0, [list("L1", ids(1, 3))], [WI(["L1"])]), layout: 2, replies: [{
        lists: [{ id: "L1", where: { field: "status", value: "Done" } }, { id: "L1", members: [] }], blocks: [], not_found: [],
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
    it("marks a selection partial if the answer byte bound requires a bounded plain response", async () => {
      const members = ids(1, 180);
      const rendered = await alone({ bundle: listBundle(180, 0, [list("L1", members)], [WI(["L1"])]), layout: 2, replies: [{
        lists: [{ id: "L1", members }], blocks: [], not_found: [],
      }] }).render("Show every ticket with its owner and status.");
      const part = rendered.result.response.parts[0]!;
      expect(part).not.toHaveProperty("blocks");
      expect(part).toMatchObject({ status: "partial", gap: FIT });
      expect(rendered.cited.length).toBeLessThan(members.length);
    });
    it("states a list's members as code's table right after the answer, then the writer's other blocks", async () => {
      const part = await arranged(listBundle(3, 1, [list("L1", ids(1, 3))], [WI(["L1"])]), { lists: [{ id: "L1" }], not_found: [], blocks: [
        { block: "answer", sentences: [{ ...REVIEW, evidence: ["E4"] }] }, { block: "text", title: "Why", sentences: [{ text: "The fixture work passed its review.", evidence: ["E4"] }] },
      ] });
      expect(part.statements.map(value => value.text)).toEqual([REVIEW.text, `3 tickets created on October 4, 2026: ${names(1, 3)}.`, "The fixture work passed its review."]);
      expect(part.blocks).toEqual([
        { kind: "answer", statements: [0] },
        { kind: "table", statements: [1], columns: ["Item", "Status", "Owner"], caption: "3 tickets created on October 4, 2026", rows: [1, 2, 3].map(n => ({ cells: [`THERM-${n}: Fixture work ${n}`, "In Progress", "Dana Lee"], citation_indexes: [n] })) },
        { kind: "text", title: "Why", statements: [2] },
      ]);
    });
    it("reads events whose sentences carry code's checked note as text, so the note shows (W5)", async () => {
      const research: AgenticEvidenceBundleV1 = Object.freeze({
        ...EMPTY_BUNDLE, lists: [list("L1", ["E1", "E2"])], plan: planOf([WS(["L1", "E1"])]),
        items: [
          { short: "E1", source: "tickets", item: ticketRow(1, "THERM-1: BUG-412 blocks DVT."), full: true, opened: true, preloaded: false, touched: 1, cited_by_plan: true },
          { short: "E2", source: "tickets", item: ticketRow(2), full: false, opened: false, preloaded: false, touched: 2, cited_by_plan: false },
        ],
      });
      const part = await arranged(research, { lists: [], not_found: [], blocks: [{ block: "timeline", title: "Blocked", events: [
        { date: "2026-10-04", text: "THERM-1 was created.", evidence: ["E1"] }, { date: "2026-10-04", text: "BUG-412 blocked it.", evidence: ["E1"] },
      ] }] });
      expect(part.statements.map(value => value.text)).toEqual(["2026-10-04: THERM-1 was created (1 of 2 checked so far).", "2026-10-04: BUG-412 blocked it (1 of 2 checked so far)."]);
      expect(part.blocks).toEqual([{ kind: "text", title: "Blocked", statements: [0, 1] }]);
    });
    it("keeps a wide row's statement within 4 KiB with code's checked note, the row cut and never the note (W5)", async () => {
      const research: AgenticEvidenceBundleV1 = Object.freeze({
        ...EMPTY_BUNDLE, lists: [list("L1", ["E1", "E2"])], plan: planOf([WS(["L1", "E1"])]),
        items: [
          { short: "E1", source: "tickets", item: ticketRow(1, "THERM-1: BUG-412 blocks DVT."), full: true, opened: true, preloaded: false, touched: 1, cited_by_plan: true },
          { short: "E2", source: "tickets", item: ticketRow(2), full: false, opened: false, preloaded: false, touched: 2, cited_by_plan: false },
        ],
      });
      const columns = (count: number) => Array.from({ length: count }, (_, at) => `C${String(at + 1).padStart(2, "0")}`);
      // Forty cells of 100 characters are too wide for a statement, so the row reads as text cut to 4 KiB; 37 of them and one
      // of 120 are a row of 4,085 bytes, which its note would take past 4 KiB.
      const wide = { block: "table", title: "Fixture", columns: columns(40), rows: [{ cells: columns(40).map(() => "x".repeat(100)), evidence: ["E1"] }] };
      const near = { block: "table", title: "Fixture", columns: columns(38), rows: [{ cells: columns(38).map((_, at) => "y".repeat(at === 37 ? 120 : 100)), evidence: ["E1"] }] };
      for (const table of [wide, near]) {
        const { rendered, corrections } = await observed(() => alone({ bundle: research, replies: [{ lists: [], not_found: [], blocks: [table] }], layout: 2 }).render("Which tickets were created on October 4?"));
        const part = rendered.result.response.parts[0]!;
        expect(Buffer.byteLength(part.statements[0]!.text, "utf8")).toBeLessThanOrEqual(PERSON_ANSWER_STATEMENT_MAX_BYTES_V4);
        expect(part.statements[0]!.text).toMatch(/^C01: [xy]+.*… \(1 of 2 checked so far\)$/u);
        expect(blocksOf(rendered)).toEqual([{ kind: "text", title: "Fixture", statements: [0] }]);
        // The reader counts its cut of the row too wide for a statement; the renderer counts its own, for the note.
        expect(corrections.model_text_truncated).toBe(table === wide ? 2 : 1);
      }
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
        bundle: pastOne(), layout: 2, replies: [{ lists: [], not_found: [], blocks: [{ block: "answer", sentences: [{ ...REVIEW, evidence: ["E46"] }] }], since: [WAITS_ON] }],
        earlier: { asked_on: "2026-10-05", statements: [{ text: "The review had not met.", sources: ["Approved record 1"] }] }, answers: "What did the review approve?",
      }).render("What did the review approve?");
      expect(rendered.result.response).not.toHaveProperty("since");
      expect(rendered.result.response.parts[0]!.statements.map(value => value.text)).toEqual([REVIEW.text]);
    });
  });
});

describe("Ask renderer: answer layout v1 (ADR-0045)", () => {
  const NEXT = "What has to happen first";
  /** The THERM answer as the writer marks it: a bullet before its lead, two decisions, and two actions as rows of a declared table. */
  const THERM = {
    lists: [], not_found: [], tables: [{ section: NEXT, columns: ["Action", "Owner", "Due"] }],
    sentences: [
      { text: "DVT-R2 retests TC-D-03 and TC-D-01.", evidence: ["E2"], form: "bullet", section: "Decisions" },
      { text: "The reduced test scope was rejected.", evidence: ["E1"], form: "lead" },
      { text: "Hardware owns the BUG-412 fix.", evidence: ["E3"], form: "bullet", section: "Decisions" },
      { text: "Rafael sends the regression-scope proposal by October 9.", evidence: ["E4"], form: "row", section: NEXT, cells: ["Send the regression-scope proposal", "Rafael Moreno", "2026-10-09"] },
      { text: "Tomas fixes BUG-412 by October 28.", evidence: ["E3"], form: "row", section: NEXT, cells: ["Fix BUG-412", "Tomas Okafor", "2026-10-28"] },
    ],
  };
  /** The same reply with no form, section, cell or table: the reply before ADR-0045. */
  const plain = (reply: typeof THERM) => ({ lists: reply.lists, not_found: reply.not_found, sentences: reply.sentences.map(({ text, evidence }) => ({ text, evidence })) });
  const part = (rendered: Rendering) => rendered.result.response.parts[0]!;
  /** The part's layout, checked against the contract. */
  const layoutOf = (rendered: Rendering) => {
    const value = part(rendered).layout!;
    expect(validatePersonAnswerLayoutV1(value, part(rendered).statements, rendered.result.response.citations.length)).toEqual(value);
    return value;
  };

  it("lays the THERM answer out lead first: the conclusion, its decisions as bullets, and what has to happen first as a table", async () => {
    const rendered = await alone({ bundle: records(4), replies: [THERM], layout: 1 }).render("Can DVT-R2 run on the reduced test scope?");
    // A row's statement is code's, from its cells, so what audits and the judge read is what the table shows.
    expect(part(rendered).statements.map(value => [value.text, value.citation_indexes])).toEqual([
      ["The reduced test scope was rejected.", [0]], ["DVT-R2 retests TC-D-03 and TC-D-01.", [1]], ["Hardware owns the BUG-412 fix.", [2]],
      ["Action: Send the regression-scope proposal; Owner: Rafael Moreno; Due: 2026-10-09.", [3]], ["Action: Fix BUG-412; Owner: Tomas Okafor; Due: 2026-10-28.", [2]],
    ]);
    expect(layoutOf(rendered)).toEqual([
      { kind: "lead", statements: [0] }, { kind: "heading", text: "Decisions" }, { kind: "bullets", statements: [1, 2] }, { kind: "heading", text: NEXT },
      { kind: "table", statements: [3, 4], columns: ["Action", "Owner", "Due"], rows: [
        { cells: ["Send the regression-scope proposal", "Rafael Moreno", "2026-10-09"], citation_indexes: [3] }, { cells: ["Fix BUG-412", "Tomas Okafor", "2026-10-28"], citation_indexes: [2] },
      ] },
    ]);
    expect(rendered.outcome).toBe("answered");
  });

  it("keeps today's response without layout: no layout or blocks, and the statements of the same reply without forms", async () => {
    const today = await alone({ bundle: records(4), replies: [plain(THERM)] }).render("Can DVT-R2 run on the reduced test scope?");
    const rendered = await alone({ bundle: records(4), replies: [THERM] }).render("Can DVT-R2 run on the reduced test scope?");
    expect(part(rendered)).not.toHaveProperty("layout");
    expect(part(rendered)).not.toHaveProperty("blocks");
    expect(part(rendered).statements).toEqual(part(today).statements);
  });

  it("gives only a laid-out Ask's writer the layout prompt, the layout schema and a longer reply's allowance, and never the block catalog", async () => {
    for (const layout of [undefined, 1] as const) {
      const run = alone({ bundle: records(4), replies: [THERM], ...(layout === undefined ? {} : { layout }) });
      await run.render("Can DVT-R2 run on the reduced test scope?");
      expect(run.input(0)).toMatchObject(layout
        ? { system_prompt: `${ANSWER_PROMPT}\n\n${ANSWER_LAYOUT_PROMPT}`, schema: answerLayoutSchema, max_output_tokens: 2_000 }
        : { system_prompt: ANSWER_PROMPT, schema: answerSchema, max_output_tokens: AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer });
      expect(run.prompt(0)).not.toHaveProperty("block_catalog");
    }
  });

  it("lays out only the statements kept (W1, repeat), with no lead when the one the writer marked was left out", async () => {
    const sentences = [
      { text: "An unread item says so.", evidence: ["E9"], form: "lead" },
      { text: "Approved: one.", evidence: ["E1"], form: "bullet", section: "Decisions" },
      { text: "Approved: one.", evidence: ["E1"], form: "bullet", section: "Decisions" },
      { text: "Approved: two.", evidence: ["E2"], form: "bullet", section: "Decisions" },
      { text: "Record three applies.", evidence: ["E3"] },
    ];
    const rendered = await alone({ bundle: records(3), layout: 1, replies: [{ lists: [], not_found: [], sentences }] }).render("What was decided?");
    expect(part(rendered).statements.map(value => value.text)).toEqual(["Record three applies.", "Approved: one.", "Approved: two."]);
    expect(layoutOf(rendered)).toEqual([{ kind: "paragraph", statements: [0] }, { kind: "heading", text: "Decisions" }, { kind: "bullets", statements: [1, 2] }]);
    // A writer that marked no lead has its first sentence read as one, when that is prose with no section.
    const unmarked = await alone({ bundle: records(3), layout: 1, replies: [{ lists: [], not_found: [], sentences: [sentences[4]!, ...sentences.slice(1, 4)] }] }).render("What was decided?");
    expect(layoutOf(unmarked)).toEqual([{ kind: "lead", statements: [0] }, { kind: "heading", text: "Decisions" }, { kind: "bullets", statements: [1, 2] }]);
  });

  it("lays out only the statements that fit the 40-citation bound", async () => {
    // Twelve citations each: the fourth sentence would cite a 41st item, so it is dropped with every one after it.
    const twelve = (from: number) => Array.from({ length: 12 }, (_, index) => `E${((from + index - 1) % 41) + 1}`);
    const rendered = await alone({ bundle: records(41), layout: 1, replies: [{ lists: [], not_found: [], sentences: [
      { text: "The records apply.", evidence: twelve(1), form: "lead" },
      ...[13, 25, 37].map((from, index) => ({ text: `Records ${index + 1} apply.`, evidence: twelve(from), form: "bullet", section: "Records" })),
      { text: "Record 1 applies.", evidence: ["E1"], form: "bullet", section: "Records" },
    ] }] }).render("What applies?");
    expect(part(rendered)).toMatchObject({ status: "partial", gap: "Some evidence could not fit in this response." });
    expect(part(rendered).statements.map(value => value.text)).toEqual(["The records apply.", "Records 1 apply.", "Records 2 apply."]);
    expect(layoutOf(rendered)).toEqual([{ kind: "lead", statements: [0] }, { kind: "heading", text: "Records" }, { kind: "bullets", statements: [1, 2] }]);
  });

  it("releases the laid-out answer's own statements without layout when it would pass its byte bound, and says what did not fit", async () => {
    // Forty records with long labels, a lead and nine rows of six long cells and no text of their own, each citing four
    // records: past 64 KiB laid out, so released without layout, every row still its cells' claim until what cannot fit.
    const research = records(40, { label: "𝔸".repeat(250) });
    const columns = ["One", "Two", "Three", "Four", "Five", "Six"];
    const reply = { lists: [], not_found: [], tables: [{ section: "Rows", columns }], sentences: Array.from({ length: 10 }, (_, index) => ({
      text: index === 0 ? `${"𝔹".repeat(690)} ${index}.` : "", evidence: [1, 2, 3, 4].map(n => `E${4 * index + n}`),
      ...(index === 0 ? { form: "lead" } : { form: "row", section: "Rows", cells: columns.map(column => `${column} ${"𝔸".repeat(70)} ${index}`) }),
    })) };
    const on = await alone({ bundle: research, replies: [reply], layout: 1 }).render("What applies?");
    const released = part(on);
    expect(released).not.toHaveProperty("layout");
    expect(released).not.toHaveProperty("gap_details");
    expect(released.statements.length).toBeGreaterThan(1);
    expect(released.statements.slice(1).map(value => value.text.startsWith(`One: One ${"𝔸".repeat(70)} `))).toEqual(released.statements.slice(1).map(() => true));
    // Rows that did not fit are said to be missing, never silently gone.
    expect(released.statements.length === 10 || released.gap === "Some evidence could not fit in this response.").toBe(true);
    expect(released.status === "answered").toBe(released.statements.length === 10);
    expect(canonicalJsonBytes(on.result.response).byteLength).toBeLessThanOrEqual(PERSON_ANSWER_RESPONSE_MAX_BYTES_V4);
    expect((on.result.response as PersonAnswerResponseV8).schema_version).toBe(8);
  });

  it("keeps two rows that cite the same item and differ only at the end of their last cell", async () => {
    const columns = ["One", "Two", "Three", "Four", "Five", "Six"];
    const row = (last: string) => ({ text: "", evidence: ["E1"], form: "row", section: "Rules", cells: [...columns.slice(0, 5).map(() => "x".repeat(120)), last] });
    const rendered = await alone({ bundle: records(1), layout: 1, replies: [{ lists: [], not_found: [], tables: [{ section: "Rules", columns }], sentences: [
      { text: "Two rules apply.", evidence: ["E1"], form: "lead" }, row(`${"y".repeat(114)} ALLOW`), row(`${"y".repeat(115)} DENY`),
    ] }] }).render("Which rules apply?");
    expect(part(rendered)).toMatchObject({ status: "answered" });
    const texts = part(rendered).statements.map(value => value.text);
    expect([texts.length, texts[1]!.endsWith(" ALLOW."), texts[2]!.endsWith(" DENY.")]).toEqual([3, true, true]);
    const table = layoutOf(rendered).find(block => block.kind === "table");
    expect(table?.kind === "table" && table.rows.map(value => value.cells[5]!.slice(-5))).toEqual(["ALLOW", " DENY"]);
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

  it("gives only a v2 Ask's writer the block catalog beside the source catalog, its layout part and its schema, with a laid-out reply's allowance", async () => {
    const run = alone({ bundle: therm(), replies: [reply(ANSWER)], layout: 2 });
    await run.render("Can PVT start?");
    expect(run.input(0)).toMatchObject({ system_prompt: `${ANSWER_PROMPT}\n\n${ANSWER_BLOCKS_PROMPT}`, schema: answerBlocksSchema, max_output_tokens: 2_000 });
    const keys = Object.keys(run.prompt(0));
    expect(keys.slice(keys.indexOf("source_catalog"), keys.indexOf("source_catalog") + 2)).toEqual(["source_catalog", "block_catalog"]);
    expect(run.prompt(0).block_catalog).toEqual(ANSWER_BLOCK_CATALOG);
    const again = alone({ bundle: therm(), replies: [{ ...reply(ANSWER), since: [] }], layout: 2, earlier: { asked_on: "2026-10-05", statements: [{ text: "PVT waits on the soak.", sources: ["Soak log"] }] }, answers: "Can PVT start?" });
    await again.render("Can PVT start?");
    expect(again.input(0)).toMatchObject({ system_prompt: `${ANSWER_PROMPT}\n\n${ANSWER_BLOCKS_PROMPT}\n\n${ANSWER_SINCE_PROMPT}`, schema: answerBlocksSinceSchema, max_output_tokens: 2_500 });
  });

  it("arranges THERM's answer: the answer, a timeline oldest first, a card, numbered steps and a quote, each item a statement code wrote", async () => {
    const rendered = await alone({ bundle: therm(), replies: [reply(ANSWER, TIMELINE, CARD, STEPS, QUOTE)], layout: 2 }).render("Can PVT start?");
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
    const { rendered, corrections } = await observed(() => alone({ bundle: therm(), replies: [reply(ANSWER, undated, paraphrase)], layout: 2 }).render("Can PVT start?"));
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
    const rendered = await alone({ bundle: therm(), replies: [reply(unread, steps, CARD)], layout: 2 }).render("Can PVT start?");
    expect(part(rendered).statements.map(value => value.text)).toEqual(["Freeze the firmware.", "Ticket: THERM-48; Status: In review.", "Ticket: THERM-48; Owner: Tomas Okafor."]);
    expect(blocksOf(rendered)).toEqual([{ kind: "text", title: "Before PVT", statements: [0] }, { kind: "card", title: "THERM-48", entity: "ticket", statements: [1, 2], facts: [{ label: "Status", value: "In review" }, { label: "Owner", value: "Tomas Okafor" }] }]);
    // A writer that gave no answer block has its first item read as the answer, when it is untitled text.
    const untitled = await alone({ bundle: therm(), replies: [reply({ block: "text", sentences: ANSWER.sentences }, STEPS)], layout: 2 }).render("Can PVT start?");
    expect(blocksOf(untitled).map(block => block.kind)).toEqual(["answer", "points"]);
  });

  it("keeps every card fact a whole claim: a fact left out takes no other's name, and two cards' like facts are not one", async () => {
    const card = (title: string, facts: readonly (readonly [string, string, string])[]) => ({ block: "card", title, kind: "ticket", facts: facts.map(([label, value, cited]) => ({ label, value, evidence: [cited] })) });
    const rendered = await alone({ bundle: therm(), replies: [reply(ANSWER,
      card("THERM-48", [["Status", "In review", "E9"], ["Owner", "Tomas Okafor", "E3"], ["Due", "2026-11-03", "E3"]]),
      card("THERM-49", [["Owner", "Tomas Okafor", "E3"], ["Due", "2026-11-03", "E3"]]),
    )], layout: 2 }).render("What are THERM-48 and THERM-49?");
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
    const right = await alone({ bundle: research, replies: [reply({ block: "answer", sentences: [{ text: "It ships Nov 3.", evidence: ["E1"] }] }, events("2025"))], layout: 2 }).render("When does it ship?");
    expect(blocksOf(right).map(block => block.kind)).toEqual(["answer", "timeline"]);
    const wrong = await alone({ bundle: research, replies: [reply({ block: "answer", sentences: [{ text: "It ships Nov 3.", evidence: ["E1"] }] }, events("2026"))], layout: 2 }).render("When does it ship?");
    expect(blocksOf(wrong).map(block => block.kind)).toEqual(["answer", "text"]);
  });

  it("reads an answer block the writer put after another block as the answer, the context before it as text", async () => {
    const rendered = await alone({ bundle: therm(), replies: [reply({ block: "text", sentences: [{ text: "The soak started on 2026-10-20.", evidence: ["E2"] }] }, ANSWER)], layout: 2 }).render("Can PVT start?");
    expect(part(rendered).statements.map(value => value.text)).toEqual(["PVT can start: the soak passed on Oct 23.", "The soak started on 2026-10-20."]);
    expect(blocksOf(rendered).map(block => block.kind)).toEqual(["answer", "text"]);
  });

  it("keeps every item of an answer in blocks: no count of statements or citations cuts it (ADR-0051, past ADR-0041's W6)", async () => {
    const steps = { block: "points", title: "Before PVT", ordered: true, items: Array.from({ length: 12 }, (_, at) => ({ text: `Step ${at + 1} of the plan.`, evidence: ["E4"] })) };
    const rendered = await alone({ bundle: therm(), replies: [reply(ANSWER, steps)], layout: 2 }).render("What happens before PVT?");
    expect(part(rendered).statements.map(value => value.text)).toEqual(["PVT can start: the soak passed on Oct 23.", ...Array.from({ length: 12 }, (_, at) => `Step ${at + 1} of the plan.`)]);
    expect(part(rendered)).toMatchObject({ status: "answered" });
    expect(part(rendered)).not.toHaveProperty("gap");
    expect(blocksOf(rendered).map(block => [block.kind, block.statements.length])).toEqual([["answer", 1], ["points", 12]]);
    // 45 records, each an item of its own: every one is cited, past ADR-0041's 40.
    const research = bundle(Array.from({ length: 45 }, (_, at) => ({ item: record(`many-${at + 1}`, `Record ${at + 1} applies.`), full: true, touched: at + 1 })), Array.from({ length: 45 }, (_, at) => `E${at + 1}`));
    const wide = await alone({ bundle: research, replies: [reply({ block: "answer", sentences: [{ text: "All 45 apply.", evidence: ["E1"] }] },
      { block: "points", ordered: false, items: Array.from({ length: 45 }, (_, at) => ({ text: `Record ${at + 1} applies.`, evidence: [`E${at + 1}`] })) })], layout: 2 }).render("Which records apply?");
    expect([wide.result.response.citations.length, part(wide).statements.length, part(wide).status]).toEqual([45, 46, "answered"]);
    // Layout v1's writer keeps its ten sentences, as its reader and the part's bound always have.
    const v1 = await alone({ bundle: research, replies: [{ lists: [], not_found: [], sentences: Array.from({ length: 12 }, (_, at) => ({ text: `Record ${at + 1} applies.`, evidence: [`E${at + 1}`], form: "bullet" })) }], layout: 1 }).render("Which records apply?");
    expect(part(v1).statements).toHaveLength(10);
  });

  it("gives a layout v1 Ask no blocks, and states its lead as v2 states the answer block", async () => {
    const laid = await alone({ bundle: therm(), replies: [reply(ANSWER, TIMELINE, CARD, STEPS, QUOTE)], layout: 2 }).render("Can PVT start?");
    const v1 = await alone({ bundle: therm(), replies: [{ lists: [], not_found: [], sentences: [{ text: "PVT can start: the soak passed on Oct 23.", evidence: ["E1", "E2"], form: "lead" }] }], layout: 1 }).render("Can PVT start?");
    expect(part(v1)).not.toHaveProperty("blocks");
    expect(part(laid).statements[0]).toEqual(part(v1).statements[0]);
  });

  it("releases a v2 answer too large for its byte bound without blocks: the same claims, a row still its cells' claim", async () => {
    // As layout v1's test: forty records with long labels, and nine rows of six long cells each citing four records.
    const research = records(40, { label: "𝔸".repeat(250) });
    const columns = ["One", "Two", "Three", "Four", "Five", "Six"];
    const big = reply(
      { block: "answer", sentences: [{ text: `${"𝔹".repeat(690)} 0.`, evidence: ["E1", "E2", "E3", "E4"] }] },
      { block: "table", columns, rows: Array.from({ length: 9 }, (_, index) => ({ cells: columns.map(column => `${column} ${"𝔸".repeat(70)} ${index + 1}`), evidence: [1, 2, 3, 4].map(n => `E${4 * (index + 1) + n}`) })) },
    );
    const on = await alone({ bundle: research, replies: [big], layout: 2 }).render("What applies?");
    const released = part(on);
    expect(released).not.toHaveProperty("blocks");
    expect(released).not.toHaveProperty("layout");
    expect(released.statements.slice(1).map(value => value.text.startsWith(`One: One ${"𝔸".repeat(70)} `))).toEqual(released.statements.slice(1).map(() => true));
    expect(released.statements.length === 10 || released.gap === "Some evidence could not fit in this response.").toBe(true);
    expect(canonicalJsonBytes(on.result.response).byteLength).toBeLessThanOrEqual(PERSON_ANSWER_RESPONSE_MAX_BYTES_V4);
  });
});
