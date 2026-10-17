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
  /** Rows E1..En, then text records; the plan's one need cites `evidence`. */
  const listBundle = (rows: number, texts: number, lists: readonly AgenticListEvidenceV1[], evidence: readonly string[], budget = EMPTY_BUNDLE.budget): AgenticEvidenceBundleV1 => {
    const items = [
      ...Array.from({ length: rows }, (_, index) => ({ item: ticketRow(index + 1), full: false })),
      ...Array.from({ length: texts }, (_, index) => ({ item: record(`text-${index + 1}`, `Approved record ${index + 1}.`), full: true })),
    ];
    return Object.freeze({
      ...EMPTY_BUNDLE, budget, lists,
      plan: [{ part: 1, question: "Which tickets?", notes: "", needs: [{ need: "the tickets", status: "found" as const, evidence }] }],
      items: items.map((entry, index) => Object.freeze({ short: `E${index + 1}`, source: entry.full ? "meetings" : "tickets", item: entry.item, full: entry.full, opened: false, preloaded: false, touched: index + 1, cited_by_plan: entry.full && evidence.includes(`E${index + 1}`) })),
    });
  };
  const names = (from: number, count: number) => Array.from({ length: count }, (_, index) => `THERM-${from + index}: Fixture work ${from + index}`);
  const eight = `8 tickets created on October 4, 2026: ${names(1, 8).join("; ")}.`;
  const ids = (from: number, count: number) => Array.from({ length: count }, (_, index) => `E${from + index}`);

  it("sends back an answer that names some of a list's rows without the list, then writes the list and keeps its other sentences", async () => {
    // The plan rests on text (E9), so only the subset check applies to L1.
    const reply = { sentences: [{ text: "THERM-1, THERM-2 and THERM-3 are in progress.", evidence: ["E1", "E2", "E3"] }, { text: "The review approved the fixture work.", evidence: ["E9"] }], not_found: [] };
    const run = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], ["E9"]), replies: [reply, reply], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(run.trace).toEqual([`context:E9,${ids(1, 8).join(",")}`, "revalidate", "generate", "revalidate", "generate"]);
    expect(run.prompt(0).lists[0]).toMatchObject({ id: "L1", cited_by_plan: false, count: 8 });
    expect(run.prompt(1).validation_error).toContain('the answer cites 3 of the 8 members of list L1 without the list: put {"id": "L1"} in "lists"');
    expect(rendered.result.response.parts[0]!.statements).toEqual([
      { text: eight, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true },
      { text: "The review approved the fixture work.", citation_indexes: [8], private: false },
    ]);
    expect(rendered).toMatchObject({ outcome: "answered", cited: ids(1, 9), result: { writer_evidence: ["E9", ...ids(1, 8)] } });
  });

  it("accepts a list's rows cited in full or by one, without the list", async () => {
    for (const evidence of [ids(1, 3), ["E2"]]) {
      const run = alone({ bundle: listBundle(3, 1, [list("L1", ids(1, 3))], ["E4"]), replies: [{ sentences: [{ text: "Those are in progress.", evidence }], not_found: [] }], version: 6 });
      const rendered = await run.render("Which tickets are in progress?");
      expect(run.trace.filter(step => step === "generate")).toHaveLength(1);
      expect(rendered.result.response.parts[0]!.statements).toEqual([{ text: "Those are in progress.", citation_indexes: evidence.map((_, index) => index), private: true }]);
    }
  });

  it("writes the list without a repair when no model call is left", async () => {
    const budget = { ...EMPTY_BUNDLE.budget, max_model_calls: 1 };
    const reply = { sentences: [{ text: "The review approved the fixture work.", evidence: ["E9"] }], not_found: [] };
    const run = alone({ bundle: listBundle(8, 1, [list("L1", ids(1, 8))], ["L1", "E9"], budget), replies: [reply], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(run.trace.filter(step => step === "generate")).toHaveLength(1);
    expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([eight, "The review approved the fixture work."]);
    expect(rendered).toMatchObject({ outcome: "answered", fallbacks: 0 });
  });

  it("shares 25 names across the lists an answer uses, each ending with 'and N more' from its own list", async () => {
    const run = alone({
      bundle: listBundle(68, 0, [list("L1", ids(1, 8)), list("L2", ids(9, 60))], ["L1", "L2"]),
      replies: [{ lists: [{ id: "L1" }, { id: "L2" }], sentences: [], not_found: [] }], version: 6,
    });
    const rendered = await run.render("Which tickets were created on October 4?");
    expect(rendered.result.response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      eight, `60 tickets created on October 4, 2026: ${names(9, 17).join("; ")}; and 43 more.`,
    ]);
    expect(rendered.result.response.citations).toHaveLength(25);
  });

  it("keeps the 40-citation and ten-statement bounds: list statements first, the writer's sentences dropped from the end", async () => {
    const pairs = Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${61 + 2 * index}`, `E${62 + 2 * index}`] }));
    const run = alone({ bundle: listBundle(60, 20, [list("L1", ids(1, 60))], ["L1"]), replies: [{ lists: [{ id: "L1" }], sentences: pairs, not_found: [] }], version: 6 });
    const rendered = await run.render("Which tickets were created on October 4, and what applies?");
    const part = rendered.result.response.parts[0]!;
    // 25 named rows, then seven sentences of two citations each: the eighth would make 41.
    expect(rendered.result.response.citations).toHaveLength(39);
    expect(part.statements).toHaveLength(8);
    expect(part.statements[0]!.text.endsWith("; and 35 more.")).toBe(true);
    expect(part).toMatchObject({ status: "partial", gap: "Some evidence could not fit in this response." });
    expect(rendered.cited).toEqual([...ids(1, 25), ...ids(61, 14)]);

    const singles = Array.from({ length: 10 }, (_, index) => ({ text: `Record ${index + 1} applies.`, evidence: [`E${64 + index}`] }));
    const many = alone({ bundle: listBundle(63, 10, [list("L1", ids(1, 60)), list("L2", ids(61, 3))], ["L1", "L2"]), replies: [{ lists: [{ id: "L1" }, { id: "L2" }], sentences: singles, not_found: [] }], version: 6 });
    const bounded = (await many.render("Which tickets?")).result.response.parts[0]!;
    expect(bounded.statements).toHaveLength(10);
    expect(bounded.statements.slice(2).map(statement => statement.text)).toEqual(singles.slice(0, 8).map(sentence => sentence.text));
  });

  it("gives a listed ticket's row and its opened body one citation", async () => {
    const rowItem = ticketRow(46);
    const body = ticketRow(46, "THERM-46: BUG-412 blocks DVT.");
    const research: AgenticEvidenceBundleV1 = Object.freeze({
      ...EMPTY_BUNDLE, lists: [list("L1", ["E1"])],
      plan: [{ part: 1, question: "Which tickets?", notes: "", needs: [{ need: "tickets", status: "found" as const, evidence: ["L1", "E2"] }] }],
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
