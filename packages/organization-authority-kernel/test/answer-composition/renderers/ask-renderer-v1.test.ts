import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import { ANSWER_PROMPT } from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { createAgenticListEvidenceV1, type AgenticListEvidenceV1 } from "../../../src/answer-composition/agentic-list-evidence-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { createAskRendererV1 } from "../../../src/answer-composition/renderers/ask-renderer-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { ids } from "../fixtures/agentic-lists.js";
import { EMPTY_BUNDLE, LIST_READ_AT, listed, record, scriptedGate } from "../fixtures/agentic-scenarios.js";

/** Ask's renderer on its own: a hand-built bundle, a gate over scripted writer replies, and no desk. */
function alone(input: { readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly version: 4 | 5 | 6 | 8; readonly remaining?: number }) {
  const trace: string[] = [];
  const { gate, inputs } = scriptedGate(input.replies, input.bundle.budget, trace);
  const renderer = createAskRendererV1({
    response_version: input.version, answer_prompt: ANSWER_PROMPT, source_catalog: [], scope: "everything the asker can read",
    context: { today: "2026-10-06" }, desk_scope: input.bundle.gathered_for.scope,
  });
  const render = (question: string) => renderer.render({
    bundle: input.bundle, trigger_input: { question }, gate, remaining: () => input.remaining ?? 30_000, signal: new AbortController().signal,
    prompt_budget: system => agenticAskContextBudgetBytesV1(undefined, system, AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer),
    on_context: selected => { trace.push(`context:${selected.join(",")}`); },
  });
  return { render, trace, prompt: (index: number) => JSON.parse(inputs[index]!.user_prompt) as Record<string, any> };
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

describe("Ask renderer", () => {
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
    const run = alone({ bundle: research, version: 8, replies: [{
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
      bundle: bundle([{ item: first, full: true, touched: 1 }, { item: second, full: true, touched: 2 }], ["E1", "E2"]), version: 6,
      replies: [{ sentences: [
        { text: "Casey owns the pilot.", evidence: ["E1", "E2"] },
        { text: "Casey owns the pilot.", evidence: ["E2", "E1", "E1"] },
        { text: "Casey owns the pilot.", evidence: ["E1"] },
        { text: "Casey owns the pilot.", evidence: ["E2"] },
        { text: "The pilot is due Friday.", evidence: ["E1"] },
        { text: "The pilot belongs to Casey.", evidence: ["E1"] },
      ], not_found: [] }],
    });
    const rendered = await run.render("Who owns the pilot and when is it due?");
    expect(rendered.result.response.parts[0]!.statements).toEqual([
      { text: "Casey owns the pilot.", citation_indexes: [0, 1], private: true },
      { text: "Casey owns the pilot.", citation_indexes: [0], private: false },
      { text: "Casey owns the pilot.", citation_indexes: [1], private: true },
      { text: "The pilot is due Friday.", citation_indexes: [0], private: false },
      { text: "The pilot belongs to Casey.", citation_indexes: [0], private: false },
    ]);
    expect(rendered.result.response.citations.map(value => value.citation)).toEqual([first.citation, second.citation]);
  });

  it("cites only the evidence the writer was given, in first-citation order", async () => {
    const first = record("first", "Approved: ship the enclosure in October.");
    const second = record("second", "Approved: Mara owns the launch.");
    const run = alone({
      bundle: bundle([{ item: first, full: true, touched: 1 }, { item: second, full: true, touched: 2 }, { item: listed("unread"), full: false, touched: 3 }], ["E1"]),
      replies: [{ sentences: [{ text: "Mara owns the October launch.", evidence: ["E2", "E1", "E9"] }, { text: "An unread item says so.", evidence: ["E3"] }], not_found: [] }], version: 6,
    });
    const rendered = await run.render("What was decided?");
    expect(run.trace).toEqual(["context:E1,E2", "revalidate", "generate"]);
    expect(rendered.result.response.parts[0]!.statements).toEqual([{ text: "Mara owns the October launch.", citation_indexes: [0, 1], private: false }]);
    expect(rendered.result.response.citations.map(value => value.citation)).toEqual([second.citation, first.citation]);
    expect(rendered).toMatchObject({ cited: ["E2", "E1"], outcome: "answered", fallbacks: 0, result: { writer_evidence: ["E1", "E2"] } });
  });

  // The Ask golden replays this fallback as V4; here it is the V5 response.
  it("falls back only to items research read in full when the writer fails", async () => {
    const read = record("read", "Approved: ship the enclosure in October.");
    const previewed = record("previewed", "Approved: the enclosure vendor changed.");
    const run = alone({
      bundle: bundle([{ item: read, full: true, touched: 1 }, { item: previewed, full: false, touched: 3 }, { item: listed("listed"), full: false, touched: 2 }], ["E1"]),
      replies: [{ wrong: true }, { still: "wrong" }], version: 5,
    });
    const rendered = await run.render("What was decided?");
    // The writer reads the previewed passage too, but a failed writer's records stay limited to what research read.
    expect(rendered.result.writer_evidence).toEqual(["E1", "E2"]);
    expect(rendered.result.response).toMatchObject({ schema_version: 5, kind: "echo-clean-person-answer-v5", outcome: "partial", parts: [{ status: "records_only", records: [{ text: read.text, citation_indexes: [0] }] }], citations: [{ citation: read.citation }] });
    expect(rendered).toMatchObject({ cited: ["E1"], outcome: "partial", fallbacks: 1 });
    expect(run.trace).toEqual(["context:E1,E2", "revalidate", "generate", "revalidate", "generate"]);
  });

  it("makes no model call without readable evidence and still ends with an honest result", async () => {
    for (const completed of [true, false]) {
      const run = alone({ bundle: bundle([{ item: listed("listed"), full: false, touched: 1 }], [], completed), replies: [], version: 6 });
      const rendered = await run.render("What was decided?");
      expect(run.trace).toEqual(["context:"]);
      expect(rendered).toMatchObject({ cited: [], fallbacks: 0, outcome: completed ? "not_found" : "partial", result: { writer_evidence: [] } });
      expect(rendered.result.response.parts[0]).toMatchObject({ status: "not_found", gap: completed ? "I couldn't find this in the sources you can access." : "I couldn't complete the search. Please try again." });
    }
  });

  const LIMITED_COVERAGE = "Some source coverage was incomplete, so relevant context may be missing.";
  const gate = () => record("gate", "Approved: the pilot may proceed after the gate.");
  const contextThenBody = () => bundle([{ item: record("context", "Related context."), full: false, touched: 1 }, { item: record("body", "Approved: the pilot may proceed after the gate."), full: true, touched: 2 }], ["E2"]);
  it.each<{ readonly name: string; readonly research: AgenticEvidenceBundleV1; readonly text: string; readonly cited: string; readonly notice: string | null }>([
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
      name: "keeps a fully supported stopped-research answer answered with a neutral notice",
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
  ])("$name", async ({ research, text, cited, notice }) => {
    const rendered = await alone({ bundle: research, replies: [{ sentences: [{ text, evidence: [cited] }], not_found: [] }], version: 6 }).render("Can the pilot proceed?");
    expect(rendered.outcome).toBe("answered");
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "answered" });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap");
    if (notice === null) expect(rendered.result.response).not.toHaveProperty("notice");
    else expect(rendered.result.response.notice).toBe(notice);
  });

  it("writes only when the time the runner leaves it covers a writer call", async () => {
    const entries = [{ item: record("read", "Approved: ship the enclosure in October."), full: true, touched: 1 }];
    const reply = { sentences: [{ text: "The enclosure ships in October.", evidence: ["E1"] }], not_found: [] };
    const enough = alone({ bundle: bundle(entries, ["E1"]), replies: [reply], version: 4, remaining: 3_000 });
    expect(await enough.render("What was decided?")).toMatchObject({ outcome: "answered", cited: ["E1"] });
    const short = alone({ bundle: bundle(entries, ["E1"]), replies: [reply], version: 4, remaining: 2_999 });
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
  it("removes repeats before the statement bound and keeps coverage for the last retained detail", async () => {
    const research = listBundle(1, 9, [list("L1", ["E1"])], [WI(["L1"])]);
    const run = alone({
      bundle: { ...research, rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [
        { tool: "open", args: { id: "E10" }, result: { items: [], opened: ["E10"], truncated: true } },
      ] }] }, version: 6,
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
  type Rendered = Awaited<ReturnType<ReturnType<typeof alone>["render"]>>;
  interface Row {
    readonly id: string; readonly name: string; readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly q?: string;
    readonly status: string; readonly says?: readonly unknown[]; readonly gap?: string; readonly calls?: number; readonly repaired?: true;
    readonly cited?: readonly string[]; readonly citations?: number; readonly check?: (rendered: Rendered, run: ReturnType<typeof alone>) => void;
  }
  /** One row: the bundle research gave, the writer's replies, and the part, its outcome, the writer calls and what it cites. */
  const rows = (values: readonly Row[]) => { for (const row of values) it(`${row.id}: ${row.name}`, async () => {
    const run = alone({ bundle: row.bundle, replies: row.replies, version: 6 });
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
    { id: "C4b (misdeclared)", name: "states the list too, and its end gap, declared which_items; the member costs one name", bundle: listBundle(25, 1, [list("L1", ids(1, 25), { unverified_end: true })], [WI(["L1"])]), replies: [use({ id: "L1", members: ["E2"] })], q: "Who owns THERM-2?", status: "partial", gap: LEG, says: [`At least 25 tickets created on October 4, 2026: ${names(1, 25)}.`, `1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`], citations: 25 },
    // A list cut short: a use in full or by where says which items exist, with the list-end gap; a selection by id alone never does.
    { id: "R9 (iii)", name: "states every member by id of a stated list as one statement with the full use code adds, its lead and its gap", bundle: cut(1, [WI(["L1"])]), replies: [use({ id: "L1", members: ids(1, 25) })], status: "partial", gap: LEG, says: [`At least 25 tickets created on October 4, 2026: ${facts(1, 25)}.`] },
    { id: "R9 (iv)", name: "names all 25 in full, the ten by id costing no share, then the ten's facts", bundle: cut(1, [WI(["L1"])]), replies: [use({ id: "L1", members: ids(1, 10) })], q: "Which tickets created on October 4 are in review or blocked?", status: "partial", gap: LEG, says: [`At least 25 tickets created on October 4, 2026: ${names(1, 25)}.`, `10 of at least 25 tickets created on October 4, 2026: ${facts(1, 10)}.`], citations: 25 },
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
    { id: "W6", name: "shares 25 names across the lists an answer uses, each ending with 'and N more' from its own list", bundle: listBundle(68, 0, [list("L1", ids(1, 8)), list("L2", ids(9, 60))], [WI(["L1", "L2"])]), replies: [use({ id: "L1" }, { id: "L2" })], status: "answered", says: [EIGHT, `60 tickets created on October 4, 2026: ${names(9, 17)}; and 43 more.`], citations: 25 },
    {
      // E1, E2 and E8 share a title and row facts, so they are one name; E2 alone is private. The by-id statement takes the answer's 25 names.
      id: "X25", name: "names no member a statement does not cite, so a merged name never covers a private member uncited (W6)", replies: [use({ id: "L1" }, { id: "L1", members: ids(3, 25) })], status: "answered",
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
});
