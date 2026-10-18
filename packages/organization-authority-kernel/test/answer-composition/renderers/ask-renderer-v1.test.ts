import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { MISSING_EVENT_DATE_NOTICE_V1 } from "../../../src/shared/temporal-query-v1.js";
import { describe, expect, it } from "vitest";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import { ANSWER_PROMPT } from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { createAgenticListEvidenceV1, type AgenticListEvidenceV1 } from "../../../src/answer-composition/agentic-list-evidence-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { createAskRendererV1 } from "../../../src/answer-composition/renderers/ask-renderer-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { EMPTY_BUNDLE, LIST_READ_AT, listed, record, scriptedGate } from "../fixtures/agentic-scenarios.js";

/** Ask's renderer on its own: a hand-built bundle, a gate over scripted writer replies, and no desk. */
function alone(input: { readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly version: 4 | 5 | 6; readonly remaining?: number }) {
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

  it('explains stable missing event dates instead of telling the person to retry', async () => {
    const research = { ...bundle([], [], false), coverage: { ...EMPTY_BUNDLE.coverage, notices: [MISSING_EVENT_DATE_NOTICE_V1] } };
    const run = alone({ bundle: research, replies: [], version: 6 });
    const rendered = await run.render('What meetings did I have on October 16?');
    expect(rendered.result.response.parts[0]?.gap).toContain('no recorded event date');
    expect(rendered.result.response.parts[0]?.gap).not.toContain('try again');
    expect(rendered.result.response.notice).toContain(MISSING_EVENT_DATE_NOTICE_V1);
    expect(rendered.result.response.citations).toEqual([]);
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
  /** A need research declared which_items (ADR-0041): a list answers it. */
  const WI = (evidence: readonly string[]): Need => ({ kind: "which_items", evidence });
  /** A need research declared which_say: it cites the list it checks. */
  const WS = (evidence: readonly string[]): Need => ({ kind: "which_say", evidence });
  /** A content need: no kind. */
  const C = (evidence: readonly string[]): Need => ({ evidence });
  /** The plan's found needs, as research declared them. */
  const planOf = (needs: readonly Need[]) => [{ part: 1, question: "Which tickets?", notes: "", needs: needs.map((value, index) => ({ need: `need ${index + 1}`, ...value, status: "found" as const })) }];
  /** Rows E1..En, then text records; the plan's needs as declared. */
  const listBundle = (rows: number, texts: number, lists: readonly AgenticListEvidenceV1[], needs: readonly Need[], budget = EMPTY_BUNDLE.budget): AgenticEvidenceBundleV1 => {
    const items = [
      ...Array.from({ length: rows }, (_, index) => ({ item: ticketRow(index + 1), full: false })),
      ...Array.from({ length: texts }, (_, index) => ({ item: record(`text-${index + 1}`, `Approved record ${index + 1}.`), full: true })),
    ];
    const cited = needs.flatMap(need => need.evidence);
    return Object.freeze({
      ...EMPTY_BUNDLE, budget, lists, plan: planOf(needs),
      items: items.map((entry, index) => Object.freeze({ short: `E${index + 1}`, source: entry.full ? "meetings" : "tickets", item: entry.item, full: entry.full, opened: false, preloaded: false, touched: index + 1, cited_by_plan: entry.full && cited.includes(`E${index + 1}`) })),
    });
  };
  const names = (from: number, count: number) => Array.from({ length: count }, (_, index) => `THERM-${from + index}: Fixture work ${from + index}`);
  const eight = `8 tickets created on October 4, 2026: ${names(1, 8).join("; ")}.`;
  const ids = (from: number, count: number) => Array.from({ length: count }, (_, index) => `E${from + index}`);
  const ROWS_REASON = "a sentence cites list rows or list ids but no evidence text: code states which items exist, and members' title, dates, status and owner, through \"lists\" (with \"where\" or \"members\"); what no evidence text says belongs in \"not_found\"";
  const UNSUPPORTED = "Part of the answer was left out because no item's text supports it.";
  const UNCHECKED = "Not every listed item was checked, so others may also match.";
  const generations = (run: ReturnType<typeof alone>) => run.trace.filter(step => step === "generate").length;

  it("leaves out a sentence naming some of a list's rows after its one repair, keeps the others, and states no list for a content plan", async () => {
    // The plan rests on text (E9): no need declares a list kind, so no list is stated (W3) and no subset repair exists.
    const reply = { sentences: [{ text: "THERM-1, THERM-2 and THERM-3 are in progress.", evidence: ["E1", "E2", "E3"] }, { text: "The review approved the fixture work.", evidence: ["E9"] }], not_found: [] };
    const run = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [C(["E9"])]), replies: [reply, reply], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(run.trace).toEqual([`context:E9,${ids(1, 8).join(",")}`, "revalidate", "generate", "revalidate", "generate"]);
    expect(run.prompt(0).lists[0]).toMatchObject({ id: "L1", stated: false, count: 8 });
    expect(run.prompt(1).validation_error).toBe(`Your previous reply could not be used: ${ROWS_REASON}. Reply again with only the JSON object, in exactly the shape your instructions show.`);
    // The rows sentence goes; the part says a claim was left out, never what it claimed.
    expect(rendered.result.response.parts[0]).toEqual({ question: "Which tickets were created on October 4?", status: "partial", statements: [{ text: "The review approved the fixture work.", citation_indexes: [0], private: false }], gap: UNSUPPORTED });
    expect(rendered).toMatchObject({ outcome: "partial", cited: ["E9"], result: { writer_evidence: ["E9", ...ids(1, 8)] } });
  });

  it("states a which_items list, and leaves out a subset named by rows beside the list's id after one repair", async () => {
    // The October 4 replay's hole: the writer names 4 of 8 and cites the list id beside their rows.
    const subset = { lists: [], sentences: [{ text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["L1", ...ids(1, 4)] }], not_found: [] };
    const run = alone({ bundle: listBundle(8, 0, [list("L1", ids(1, 8))], [WI(["L1"])]), replies: [subset, subset], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(generations(run)).toBe(2);
    expect(run.prompt(1).validation_error).toContain(ROWS_REASON);
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "partial", statements: [{ text: eight, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }], gap: UNSUPPORTED });
    expect(rendered).toMatchObject({ outcome: "partial", cited: ids(1, 8) });
    // A writer that drops it after the repair gives the list alone, answered.
    const dropped = alone({ bundle: listBundle(8, 0, [list("L1", ids(1, 8))], [WI(["L1"])]), replies: [subset, { lists: [], sentences: [], not_found: [] }], version: 6 });
    expect((await dropped.render("Which tickets were created on October 4?")).result.response.parts[0]).toEqual({ question: "Which tickets were created on October 4?", status: "answered", statements: [{ text: eight, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }] });
  });

  it("stands a sentence on the text it cites, also cites the rows it names beside it, and counts no list id", async () => {
    // E9 is text the writer read, outside the list: the sentence stands on it (W1). The rows it cites beside it are cited
    // too, since it may carry their facts, so their only_me visibility makes it private (W6); the list's id cites nothing.
    const sentence = { text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["L1", ...ids(1, 4), "E9"] };
    for (const [needs, statements] of [
      [[WI(["L1"])], [{ text: eight, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }, { text: sentence.text, citation_indexes: [8, 0, 1, 2, 3], private: true }]],
      [[C(["E9"])], [{ text: sentence.text, citation_indexes: [0, 1, 2, 3, 4], private: true }]],
    ] as const) {
      const run = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], needs), replies: [{ lists: [], sentences: [sentence], not_found: [] }], version: 6 });
      const rendered = await run.render("Which tickets were created on October 4?");
      expect(generations(run)).toBe(1);
      expect(rendered.result.response.parts[0]).toEqual({ question: "Which tickets were created on October 4?", status: "answered", statements });
    }
  });

  it("makes a sentence private when it cites a private row beside team text, citing the row the person can open", async () => {
    // E9 is team text; E2 an only_me ticket row the writer saw. The sentence may carry the row's facts, so it cites the row
    // and is private (W1, W6); before, it cited E9 alone and looked shareable. A list id names no item and cites none, so
    // what a sentence carries from rows it cites only by their list's id is not locked (a Known limit).
    const sentence = (evidence: readonly string[]) => ({ lists: [], sentences: [{ text: "THERM-2 (Fixture work 2, owner Dana Lee) waits on the approved record.", evidence }], not_found: [] });
    const row = await alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [C(["E9"])]), replies: [sentence(["E2", "E9"])], version: 6 }).render("What waits on the approved record?");
    expect(row.result.response.parts[0]!.statements).toEqual([{ text: "THERM-2 (Fixture work 2, owner Dana Lee) waits on the approved record.", citation_indexes: [0, 1], private: true }]);
    expect(row.result.response.citations.map(value => [value.kind, value.visibility])).toEqual([["decision", "team"], ["ticket", "only_me"]]);
    expect(row).toMatchObject({ outcome: "answered", cited: ["E9", "E2"] });
    const listId = await alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [C(["E9"])]), replies: [sentence(["L1", "E9"])], version: 6 }).render("What waits on the approved record?");
    expect(listId.result.response.parts[0]!.statements).toEqual([{ text: "THERM-2 (Fixture work 2, owner Dana Lee) waits on the approved record.", citation_indexes: [0], private: false }]);
  });

  it("keeps a sentence's first 12 ids past the cap, so a list id never takes the place of a private row it cites", async () => {
    // Eleven team records (E9..E19) and one only_me row (E1), then L1: thirteen ids, over the schema's 12. A list id
    // cites nothing in a sentence (W1), so the row it cites stays and the sentence is private (W6).
    const sentence = { text: "THERM-1 waits on the approved records.", evidence: [...ids(9, 11), "E1", "L1"] };
    const rendered = await alone({ bundle: listBundle(8, 11, [list("L1", ids(1, 8))], [C(ids(9, 11))]), replies: [{ lists: [], sentences: [sentence], not_found: [] }], version: 6 }).render("What waits on the approved records?");
    expect(rendered.result.response.parts[0]!.statements).toEqual([{ text: sentence.text, citation_indexes: Array.from({ length: 12 }, (_, index) => index), private: true }]);
    expect(rendered.cited).toEqual([...ids(9, 11), "E1"]);
  });

  it("leaves out a rows sentence beside a content sentence after one repair, and notes only a which_say list's members", async () => {
    const reply = { lists: [], sentences: [
      { text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["L1", ...ids(1, 4)] },
      { text: "The review approved fixture work on them.", evidence: ["L1", "E9"] },
    ], not_found: [] };
    const question = "Which tickets were created on October 4, and what did the review approve?";
    const stated = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [WI(["L1"])]), replies: [reply, reply], version: 6 });
    const rendered = await stated.render(question);
    expect(generations(stated)).toBe(2);
    expect(stated.prompt(1).validation_error).toContain(ROWS_REASON);
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "partial", gap: UNSUPPORTED, statements: [{ text: eight }, { text: "The review approved fixture work on them.", citation_indexes: [8] }] });
    // A which_say need checking L1 adds its gap; E9 is no member of L1, so its sentence carries no note (W5).
    const checking = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [WI(["L1"]), WS(["L1", "E9"])]), replies: [reply, reply], version: 6 });
    expect((await checking.render(question)).result.response.parts[0]).toMatchObject({
      status: "partial", gap: `${UNCHECKED} ${UNSUPPORTED}`, statements: [{ text: eight }, { text: "The review approved fixture work on them.", citation_indexes: [8] }],
    });
  });

  it("says 'at least' for a list not read to a confirmed end, and leaves out a count resting on one row and the list's id (CF5b)", async () => {
    const count = { lists: [], sentences: [{ text: "25 tickets were created on October 4, 2026.", evidence: ["L1", "E1"] }], not_found: [] };
    const run = alone({ bundle: listBundle(25, 0, [list("L1", ids(1, 25), { unverified_end: true })], [WI(["L1"])]), replies: [count, count], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(generations(run)).toBe(2);
    expect(rendered.result.response.parts[0]).toEqual({
      question: "Which tickets were created on October 4?", status: "partial",
      statements: [{ text: `At least 25 tickets created on October 4, 2026: ${names(1, 25).join("; ")}.`, citation_indexes: Array.from({ length: 25 }, (_, index) => index), private: true }],
      gap: `The list of tickets could not be read to its end, so more may exist. ${UNSUPPORTED}`,
    });
    expect(rendered.outcome).toBe("partial");
  });

  it("leaves out a sentence that only restates a stated list's members, and keeps what a content need asks about", async () => {
    // Opened ticket and meeting rows, and follow-ups, carry their text: citing it is citing text, whatever it says.
    const read = (n: number) => ({ item: ticketRow(n, `THERM-${n}: work ${n} is in progress.`), full: true });
    const research = (needs: readonly Need[]): AgenticEvidenceBundleV1 => Object.freeze({
      ...EMPTY_BUNDLE, lists: [list("L1", ids(1, 5))], plan: planOf(needs),
      items: Array.from({ length: 5 }, (_, index) => ({ ...read(index + 1), short: `E${index + 1}`, source: "tickets", opened: true, preloaded: false, touched: index + 1, cited_by_plan: needs.some(need => need.evidence.includes(`E${index + 1}`)) })),
    });
    const reply = { lists: [], sentences: [{ text: "THERM-1 and THERM-2 were created on October 4.", evidence: ["E1", "E2"] }, { text: "THERM-1 is in progress.", evidence: ["E1"] }], not_found: [] };
    const five = `5 tickets created on October 4, 2026: ${names(1, 5).join("; ")}.`;
    for (const [needs, said] of [
      // A content need states no list: both sentences stand on their text.
      [[C(["E1"])], ["THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]],
      // A which_items need's list is stated; each sentence cites only its members' text, which no other need asks about.
      [[WI(["L1"])], [five]],
      // Beside a content need about THERM-1, both cite E1, which that need asks about.
      [[WI(["L1"]), C(["E1"])], [five, "THERM-1 and THERM-2 were created on October 4.", "THERM-1 is in progress."]],
    ] as const) {
      const run = alone({ bundle: research(needs), replies: [reply], version: 6 });
      const rendered = await run.render("Which tickets were created on October 4?");
      expect(generations(run)).toBe(1);
      expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual(said);
      expect(rendered.outcome).toBe("answered");
    }
  });

  it("states the row facts of members the writer selects by id, all of them or one, from their own rows", async () => {
    const facts = (n: number) => `THERM-${n}: Fixture work ${n} (status In Progress, owner Dana Lee, created October 4, 2026)`;
    for (const [members, text] of [
      // Every member by id is still a selection by id: their row facts, never which items exist (W2).
      [ids(1, 3), `3 of the 3 tickets created on October 4, 2026: ${[1, 2, 3].map(facts).join("; ")}.`],
      [["E2", "E9"], `1 of the 3 tickets created on October 4, 2026: ${facts(2)}.`],
    ] as const) {
      const run = alone({ bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]), replies: [{ lists: [{ id: "L1", members }], sentences: [], not_found: [] }], version: 6 });
      const rendered = await run.render("Which tickets are in progress?");
      expect(generations(run)).toBe(1);
      expect(rendered.result.response.parts[0]!.statements).toEqual([{ text, citation_indexes: members.filter(id => id !== "E9").map((_, index) => index), private: true }]);
      expect(rendered.outcome).toBe("answered");
    }
    // One item's row facts are content (C4): on a list not read to a confirmed end, the member's facts stand, and the lead says "at least".
    const owner = (needs: readonly Need[]) => alone({ bundle: listBundle(25, 1, [list("L1", ids(1, 25), { unverified_end: true })], needs), replies: [{ lists: [{ id: "L1", members: ["E2"] }], sentences: [], not_found: [] }], version: 6 });
    expect((await owner([C(["E26"])]).render("Who owns THERM-2?")).result.response.parts[0]).toEqual({ question: "Who owns THERM-2?", status: "answered", statements: [{ text: `1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`, citation_indexes: [0], private: true }] });
    // Declared which_items instead (C4b, misdeclared), code states the list too, and its end gap; the member costs one name.
    const stated = (await owner([WI(["L1"])]).render("Who owns THERM-2?")).result.response;
    expect(stated.parts[0]).toMatchObject({ status: "partial", gap: "The list of tickets could not be read to its end, so more may exist." });
    expect(stated.parts[0]!.statements.map(statement => statement.text)).toEqual([`At least 25 tickets created on October 4, 2026: ${names(1, 25).join("; ")}.`, `1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`]);
    expect(stated.citations).toHaveLength(25);
  });

  it("says which items exist, with the list-end gap, only for a use in full or by where, never for a selection by id alone (R9 iii to v)", async () => {
    const facts = (n: number) => `THERM-${n}: Fixture work ${n} (status In Progress, owner Dana Lee, created October 4, 2026)`;
    const gap = "The list of tickets could not be read to its end, so more may exist.";
    const open = (members: readonly string[], needs: readonly Need[]) => alone({
      bundle: listBundle(25, 1, [list("L1", ids(1, 25), { ended: false, truncated: true })], needs), replies: [{ lists: [{ id: "L1", members }], sentences: [], not_found: [] }], version: 6,
    });
    // Every member by id of a stated list is one statement with the list's full use code adds (W3), its lead and its gap.
    const every = await open(ids(1, 25), [WI(["L1"])]).render("Which tickets were created on October 4?");
    expect(every.result.response.parts[0]).toMatchObject({ status: "partial", gap, statements: [{ text: `At least 25 tickets created on October 4, 2026: ${Array.from({ length: 25 }, (_, index) => facts(index + 1)).join("; ")}.` }] });
    expect(every.result.response.parts[0]!.statements).toHaveLength(1);
    // Ten by id on a stated list: code states the list in full, naming all 25 (the ten named by id cost no share), then the ten.
    const ten = await open(ids(1, 10), [WI(["L1"])]).render("Which tickets created on October 4 are in review or blocked?");
    expect(ten.result.response.parts[0]).toMatchObject({ status: "partial", gap });
    expect(ten.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      `At least 25 tickets created on October 4, 2026: ${names(1, 25).join("; ")}.`, `10 of at least 25 tickets created on October 4, 2026: ${Array.from({ length: 10 }, (_, index) => facts(index + 1)).join("; ")}.`,
    ]);
    expect(ten.result.response.citations).toHaveLength(25);
    // Ten, or one, by id beside a content need: their row facts only, which say nothing of which items exist, so no gap.
    const facts10 = await open(ids(1, 10), [C(["E26"])]).render("Which tickets created on October 4 are in review or blocked?");
    expect(facts10.result.response.parts[0]).toEqual({ question: "Which tickets created on October 4 are in review or blocked?", status: "answered", statements: [{ text: `10 of at least 25 tickets created on October 4, 2026: ${Array.from({ length: 10 }, (_, index) => facts(index + 1)).join("; ")}.`, citation_indexes: ids(1, 10).map((_, index) => index), private: true }] });
    // Every member by id beside a content need is a selection by id too: their row facts, answered, whatever its size.
    const all25 = await open(ids(1, 25), [C(["E26"])]).render("Which tickets created on October 4 are in review or blocked?");
    expect(all25.result.response.parts[0]).toEqual({ question: "Which tickets created on October 4 are in review or blocked?", status: "answered", statements: [{ text: `25 of at least 25 tickets created on October 4, 2026: ${Array.from({ length: 25 }, (_, index) => facts(index + 1)).join("; ")}.`, citation_indexes: ids(1, 25).map((_, index) => index), private: true }] });
    const one = await open(["E2"], [C(["E26"])]).render("Who owns THERM-2?");
    expect(one.result.response.parts[0]).toEqual({ question: "Who owns THERM-2?", status: "answered", statements: [{ text: `1 of at least 25 tickets created on October 4, 2026: ${facts(2)}.`, citation_indexes: [0], private: true }] });
  });

  it("leaves out a sentence resting on rows alone after its repair, and falls back to the record a content need read", async () => {
    const rows = { lists: [], sentences: [{ text: "THERM-2 is in progress.", evidence: ["E2"] }], not_found: [] };
    const left = alone({ bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]), replies: [rows, rows], version: 6 });
    const rendered = await left.render("Is THERM-2 in progress?");
    expect(generations(left)).toBe(2);
    expect(left.prompt(1).validation_error).toContain(ROWS_REASON);
    // No statement is left: the record research read stands, as before ADR-0041, and the part says a claim was left out (W1).
    expect(rendered.result.response).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", statements: [], records: [{ text: "Approved record 1.", citation_indexes: [0] }], gap: `I found these records, but could not write a verified summary. ${UNSUPPORTED}` }] });
    const fixed = alone({ bundle: listBundle(3, 1, [list("L1", ids(1, 3))], [C(["E4"])]), replies: [rows, { lists: [{ id: "L1", members: ["E2"] }], sentences: [], not_found: [] }], version: 6 });
    expect((await fixed.render("Is THERM-2 in progress?")).result.response.parts[0]).toMatchObject({ status: "answered", statements: [{ text: "1 of the 3 tickets created on October 4, 2026: THERM-2: Fixture work 2 (status In Progress, owner Dana Lee, created October 4, 2026)." }] });
  });

  it("gives the records a failed writer falls back to the list gaps the part has (W3, W5)", async () => {
    const failed = (needs: readonly Need[]) => alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], needs), replies: [{ wrong: true }, { still: "wrong" }], version: 6 });
    const records = "I found these records, but could not write a verified summary.";
    // A which_say need checked none of the list's 8 members; the record research read stands beside that gap.
    const checking = await failed([WS(["L1", "E9"])]).render("Which tickets created on October 4 mention BUG-412?");
    expect(checking.result.response).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", records: [{ text: "Approved record 1." }], gap: `${records} ${UNCHECKED}` }] });
    // A which_items need research left on rows, citing no list: the part says the full list was not confirmed.
    const rows = await failed([WI(ids(1, 8))]).render("Which tickets were created on October 4?");
    expect(rows.result.response).toMatchObject({ outcome: "partial", parts: [{ status: "records_only", records: [{ text: "Approved record 1." }], gap: `${records} I could not confirm the full list of items asked for.` }] });
  });

  it("states the list and leaves out a rows sentence without a repair when no model call is left", async () => {
    const budget = { ...EMPTY_BUNDLE.budget, max_model_calls: 1 };
    const review = { text: "The review approved the fixture work.", evidence: ["E9"] };
    const run = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [WI(["L1"]), C(["E9"])], budget), replies: [{ sentences: [review], not_found: [] }], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(generations(run)).toBe(1);
    expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([eight, review.text]);
    expect(rendered).toMatchObject({ outcome: "answered", fallbacks: 0 });
    // A rows sentence in that reply cannot go back: it is left out, and the part says so.
    const rows = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [WI(["L1"]), C(["E9"])], budget), replies: [{ sentences: [review, { text: "THERM-2 is in progress.", evidence: ["E2"] }], not_found: [] }], version: 6 });
    const left = await rows.render("Which tickets were created on October 4?");
    expect(generations(rows)).toBe(1);
    expect(left.result.response.parts[0]).toMatchObject({ status: "partial", gap: UNSUPPORTED, statements: [{ text: eight }, { text: review.text }] });
  });

  it("states a which_items list whatever the reply: a reply that found nothing keeps its gap beside the list", async () => {
    const budget = { ...EMPTY_BUNDLE.budget, max_model_calls: 1 };
    const nothing = { lists: [], sentences: [], not_found: ["tickets created on October 4"] };
    const run = alone({ bundle: listBundle(8, 0, [list("L1", ids(1, 8))], [WI(["L1"])], budget), replies: [nothing], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(generations(run)).toBe(1);
    expect(rendered.result.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: eight }], gap: "Not found: tickets created on October 4." }] });
  });

  it("shares 25 names across the lists an answer uses, each ending with 'and N more' from its own list", async () => {
    const run = alone({
      bundle: listBundle(68, 0, [list("L1", ids(1, 8)), list("L2", ids(9, 60))], [WI(["L1", "L2"])]),
      replies: [{ lists: [{ id: "L1" }, { id: "L2" }], sentences: [], not_found: [] }], version: 6,
    });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      eight, `60 tickets created on October 4, 2026: ${names(9, 17).join("; ")}; and 43 more.`,
    ]);
    expect(rendered.result.response.citations).toHaveLength(25);
  });

  it("names no member a statement does not cite, so a merged name never covers a private member uncited (W6)", async () => {
    // E1, E2 and E8 share a title and row facts, so they are one name; E2 alone is private. The writer selects E3..E27 by
    // id, which takes the answer's 25 names, so the full statement may name only one member that by-id statement did not.
    const research = listBundle(27, 0, [list("L1", ids(1, 27))], [WI(["L1"])]);
    const shared: AgenticEvidenceBundleV1 = Object.freeze({ ...research, items: research.items.map((entry, index) => Object.freeze({
      ...entry, item: { ...entry.item, visibility: index === 1 ? "only_me" as const : "team" as const, ...(index < 2 ? { label: "THERM-8: Fixture work 8" } : {}) },
    })) });
    const run = alone({ bundle: shared, replies: [{ lists: [{ id: "L1" }, { id: "L1", members: ids(3, 25) }], sentences: [], not_found: [] }], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    const [full, byId] = rendered.result.response.parts[0]!.statements;
    // The shared name covers E1, which it cites, and E8, which the by-id statement named; E2 is one of the "1 more".
    expect(full).toEqual({ text: `27 tickets created on October 4, 2026: THERM-8: Fixture work 8 (2 tickets); ${[...names(3, 5), ...names(9, 19)].join("; ")}; and 1 more.`, citation_indexes: Array.from({ length: 26 }, (_, index) => index), private: false });
    expect(byId).toMatchObject({ text: expect.stringMatching(/^25 of the 27 tickets created on October 4, 2026: THERM-3: /u), private: false });
    expect(rendered.cited).toEqual(["E1", ...ids(3, 25)]);
  });

  it("names no 26th member for a statement whose first member another statement already names (W6)", async () => {
    // The writer selects the first 25 of 30 by id, which takes the answer's 25 names; the full statement W3 adds names
    // them free, its first member among them, so it names no member past them.
    const run = alone({ bundle: listBundle(30, 0, [list("L1", ids(1, 30))], [WI(["L1"])]), replies: [{ lists: [{ id: "L1", members: ids(1, 25) }], sentences: [], not_found: [] }], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    const [full, byId] = rendered.result.response.parts[0]!.statements;
    expect(full!.text).toBe(`30 tickets created on October 4, 2026: ${names(1, 25).join("; ")}; and 5 more.`);
    expect(byId!.text).toMatch(/^25 of the 30 tickets created on October 4, 2026: THERM-1: /u);
    expect(rendered.cited).toEqual(ids(1, 25));
  });

  it("keeps the 40-citation and ten-statement bounds: list statements first, the writer's sentences dropped from the end", async () => {
    const pairs = Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${61 + 2 * index}`, `E${62 + 2 * index}`] }));
    const run = alone({ bundle: listBundle(60, 20, [list("L1", ids(1, 60))], [WI(["L1"])]), replies: [{ lists: [{ id: "L1" }], sentences: pairs, not_found: [] }], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4, and what applies?");
    const part = rendered.result.response.parts[0]!;
    // 25 named rows, then seven sentences of two citations each: the eighth would make 41.
    expect(rendered.result.response.citations).toHaveLength(39);
    expect(part.statements).toHaveLength(8);
    expect(part.statements[0]!.text.endsWith("; and 35 more.")).toBe(true);
    expect(part).toMatchObject({ status: "partial", gap: "Some evidence could not fit in this response." });
    expect(rendered.cited).toEqual([...ids(1, 25), ...ids(61, 14)]);

    const singles = Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${64 + index}`] }));
    const many = alone({ bundle: listBundle(63, 10, [list("L1", ids(1, 60)), list("L2", ids(61, 3))], [WI(["L1", "L2"])]), replies: [{ lists: [{ id: "L1" }, { id: "L2" }], sentences: singles, not_found: [] }], version: 6 });
    const bounded = (await many.render("Which tickets?")).result.response.parts[0]!;
    expect(bounded.statements).toHaveLength(10);
    expect(bounded.statements.slice(2).map(statement => statement.text)).toEqual(singles.slice(0, 8).map(sentence => sentence.text));
  });

  it("CF2: leaves out a repeated rows sentence beside a stated list whether or not the need also cites text", async () => {
    const subset = { lists: [], sentences: [{ text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["L1", ...ids(1, 4)] }], not_found: [] };
    const run = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [WI(["L1", "E9"])]), replies: [subset, subset], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(generations(run)).toBe(2);
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "partial", statements: [{ text: eight }], gap: UNSUPPORTED });
    expect(rendered.result.response.parts[0]!.statements).toHaveLength(1);
  });

  it("CF5c: adds the unchecked gap for a which_say list even when no sentence cites its members, and notes no sentence", async () => {
    // E9 is a record outside L1: the sentence cites no member's text, so it carries no note; none of the 8 was checked.
    const reply = { lists: [], sentences: [{ text: "THERM-1 mentions BUG-412.", evidence: ["L1", "E9"] }], not_found: [] };
    const run = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], [WS(["L1", "E9"])]), replies: [reply], version: 6 });
    const rendered = await run.render("Which tickets created on October 4 mention BUG-412?");
    expect(generations(run)).toBe(1);
    expect(run.prompt(0).lists[0]).toMatchObject({ id: "L1", stated: false, checked: 0 });
    expect(rendered.result.response.parts[0]).toEqual({ question: "Which tickets created on October 4 mention BUG-412?", status: "partial", statements: [{ text: "THERM-1 mentions BUG-412.", citation_indexes: [0], private: false }], gap: UNCHECKED });
  });

  it("R9: says 'at least' with the list-end gap for a stated list in full or by where, and for a where selection says how many were listed", async () => {
    // 25 rows of a list that was cut short; the first five are in review.
    const research = listBundle(25, 0, [list("L1", ids(1, 25), { ended: false, truncated: true })], [WI(["L1"])]);
    const reviewed: AgenticEvidenceBundleV1 = Object.freeze({ ...research, items: research.items.map((entry, index) => index < 5 ? Object.freeze({ ...entry, item: { ...entry.item, attributes: { status: "In Review", owner: "Dana Lee" } } }) : entry) });
    const gap = "The list of tickets could not be read to its end, so more may exist.";
    const full = await alone({ bundle: reviewed, replies: [{ lists: [{ id: "L1" }], sentences: [], not_found: [] }], version: 6 }).render("Which tickets were created on October 4?");
    expect(full.result.response.parts[0]).toMatchObject({ status: "partial", gap });
    expect(full.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`At least 25 tickets created on October 4, 2026: ${[...names(1, 5).map(name => `${name} (In Review)`), ...names(6, 20).map(name => `${name} (In Progress)`)].join("; ")}.`]);
    const where = await alone({ bundle: reviewed, replies: [{ lists: [{ id: "L1", where: { field: "status", value: "in review" } }], sentences: [], not_found: [] }], version: 6 }).render("Which tickets created on October 4 are in review?");
    expect(where.result.response.parts[0]).toMatchObject({ status: "partial", gap });
    expect(where.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`At least 5 tickets created on October 4, 2026 have status In Review (25 listed so far): ${names(1, 5).join("; ")}.`]);
  });

  it("gives a listed ticket's row and its opened body one citation", async () => {
    const rowItem = ticketRow(46);
    const body = ticketRow(46, "THERM-46: BUG-412 blocks DVT.");
    const research: AgenticEvidenceBundleV1 = Object.freeze({
      ...EMPTY_BUNDLE, lists: [list("L1", ["E1"])], plan: planOf([WI(["L1"]), C(["E2"])]),
      // Research opened the row, and the open returned its body: the list's one member was checked.
      rounds: [{ round: 1, elapsed_ms: 0, plan: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"] } }], rejected: [] }],
      items: [
        { short: "E1", source: "tickets", item: rowItem, full: false, opened: false, preloaded: false, touched: 1, cited_by_plan: false },
        { short: "E2", source: "tickets", item: body, full: true, opened: true, preloaded: false, touched: 2, cited_by_plan: true },
      ],
    });
    const run = alone({ bundle: research, replies: [{ lists: [{ id: "L1" }], sentences: [{ text: "THERM-46 is blocked by BUG-412.", evidence: ["E2"] }], not_found: [] }], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4, and why is DVT blocked?");
    expect(rendered.result.response.citations).toHaveLength(1);
    expect(rendered.result.response.parts[0]!.statements).toEqual([
      { text: "1 ticket created on October 4, 2026: THERM-46: Fixture work 46.", citation_indexes: [0], private: true },
      { text: "THERM-46 is blocked by BUG-412.", citation_indexes: [0], private: true },
    ]);
  });
});
