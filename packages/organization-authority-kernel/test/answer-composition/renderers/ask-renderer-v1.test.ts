import { describe, expect, it } from "vitest";
import { agenticAskContextBudgetBytesV1 } from "../../../src/answer-composition/agentic-ask-v1.js";
import { ANSWER_PROMPT } from "../../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import type { AgenticEvidenceBundleV1 } from "../../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { AGENTIC_MODEL_OUTPUT_TOKENS_V1 } from "../../../src/answer-composition/agentic-model-gate-v1.js";
import { createAskRendererV1 } from "../../../src/answer-composition/renderers/ask-renderer-v1.js";
import type { EvidenceDeskItemV2 } from "../../../src/shared/evidence-desk-v2.js";
import { EMPTY_BUNDLE, listed, record, scriptedGate } from "../fixtures/agentic-scenarios.js";

/** Ask's renderer on its own: a hand-built bundle, a gate over scripted writer replies, and no desk. */
function alone(input: { readonly bundle: AgenticEvidenceBundleV1; readonly replies: readonly unknown[]; readonly version: 4 | 5 | 6; readonly remaining?: number }) {
  const trace: string[] = [];
  const { gate } = scriptedGate(input.replies, input.bundle.budget, trace);
  const renderer = createAskRendererV1({
    response_version: input.version, answer_prompt: ANSWER_PROMPT, source_catalog: [], scope: "everything the asker can read",
    context: { today: "2026-10-06" }, desk_scope: input.bundle.gathered_for.scope,
  });
  const render = (question: string) => renderer.render({
    bundle: input.bundle, trigger_input: { question }, gate, remaining: () => input.remaining ?? 30_000, signal: new AbortController().signal,
    prompt_budget: system => agenticAskContextBudgetBytesV1(undefined, system, AGENTIC_MODEL_OUTPUT_TOKENS_V1.answer),
    on_context: selected => { trace.push(`context:${selected.join(",")}`); },
  });
  return { render, trace };
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
    expect(rendered.result.response.citations).toHaveLength(1);
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

  it("keeps a full cited Jira anchor answered while neutrally noting omitted links", async () => {
    const item = record("jira-anchor", "THERMO-17 reports that the pilot may proceed after the gate.");
    const limited = {
      ...bundle([{ item, full: true, touched: 1 }], ["E1"]),
      rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E1"], truncated: true } }] }],
      coverage: { reads: [{ tool: "open" as const, source: "tickets", returned_items: 1, truncated: true, notice: false, unavailable: false }], inventories: [], notices: [] },
    };
    const rendered = await alone({
      bundle: limited,
      replies: [{ sentences: [{ text: "THERMO-17 reports that the pilot may proceed after the gate.", evidence: ["E1"] }], not_found: [] }], version: 6,
    }).render("Can the pilot proceed?");
    expect(rendered.outcome).toBe("answered");
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "answered" });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap");
    expect(rendered.result.response.notice).toBe("Some source coverage was incomplete, so relevant context may be missing.");
  });

  it("notes a limited open when it returns a different cited body id", async () => {
    const context = record("context", "Related context.");
    const body = record("body", "Approved: the pilot may proceed after the gate.");
    const limited = {
      ...bundle([{ item: context, full: false, touched: 1 }, { item: body, full: true, touched: 2 }], ["E2"]),
      rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"], truncated: true } }] }],
      coverage: { reads: [{ tool: "open" as const, source: "pages", returned_items: 1, truncated: true, notice: false, unavailable: false }], inventories: [], notices: [] },
    };
    const rendered = await alone({
      bundle: limited,
      replies: [{ sentences: [{ text: "The pilot may proceed after the gate.", evidence: ["E2"] }], not_found: [] }], version: 6,
    }).render("Can the pilot proceed?");
    expect(rendered).toMatchObject({ outcome: "answered", result: { response: { notice: "Some source coverage was incomplete, so relevant context may be missing." } } });
  });

  it("adds a search-completion caveat when research stopped before the writer answer", async () => {
    const item = record("gate", "Approved: the pilot may proceed after the gate.");
    const stopped = bundle([{ item, full: true, touched: 1 }], ["E1"], false);
    const rendered = await alone({
      bundle: stopped,
      replies: [{ sentences: [{ text: "The pilot may proceed after the gate.", evidence: ["E1"] }], not_found: [] }], version: 6,
    }).render("Can the pilot proceed?");
    expect(rendered.outcome).toBe("partial");
    expect(rendered.result.response.parts[0]).toMatchObject({
      status: "partial",
      gap: "I couldn't complete the search. Please try again.",
    });
  });

  it("keeps a completed answer answered when an unrelated source was truncated", async () => {
    const item = record("gate", "Approved: the pilot may proceed after the gate.");
    const unrelated = {
      ...bundle([{ item, full: true, touched: 1 }], ["E1"]),
      rounds: [{ round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "search", args: { query: "unrelated history" }, result: { items: ["E2"], opened: [], truncated: true } }] }],
      coverage: { reads: [{ tool: "search" as const, source: "documents", returned_items: 1, truncated: true, notice: false, unavailable: false }], inventories: [{ source: "documents", truncated: true }], notices: ["An unrelated document search was cut short."] },
    };
    const rendered = await alone({
      bundle: unrelated,
      replies: [{ sentences: [{ text: "The pilot may proceed after the gate.", evidence: ["E1"] }], not_found: [] }], version: 6,
    }).render("Can the pilot proceed?");
    expect(rendered).toMatchObject({ outcome: "answered" });
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "answered" });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap");
  });

  it("keeps a fully opened cited record answered after a limited inventory", async () => {
    const item = record("gate", "Approved: the pilot may proceed after the gate.");
    const openedAfterList = {
      ...bundle([{ item, full: true, touched: 1 }], ["E1"]),
      rounds: [
        { round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "list", args: { source: "meetings" }, result: { items: ["E1"], opened: [], more: true } }] },
        { round: 2, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E1"] } }] },
      ],
      coverage: { reads: [{ tool: "list" as const, source: "meetings", returned_items: 1, truncated: false, notice: false, unavailable: false }], inventories: [{ source: "meetings", more: true }], notices: [] },
    };
    const rendered = await alone({
      bundle: openedAfterList,
      replies: [{ sentences: [{ text: "The pilot may proceed after the gate.", evidence: ["E1"] }], not_found: [] }], version: 6,
    }).render("Can the pilot proceed?");
    expect(rendered).toMatchObject({ outcome: "answered" });
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "answered" });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap");
  });

  it("clears a limited returned body notice after a later clean open of that body", async () => {
    const context = record("context", "Related context.");
    const body = record("body", "Approved: the pilot may proceed after the gate.");
    const reopened = {
      ...bundle([{ item: context, full: false, touched: 1 }, { item: body, full: true, touched: 2 }], ["E2"]),
      rounds: [
        { round: 1, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"], truncated: true } }] },
        { round: 2, elapsed_ms: 0, plan: [], rejected: [], actions: [{ tool: "open", args: { id: "E1" }, result: { items: [], opened: ["E2"] } }] },
      ],
      coverage: { reads: [], inventories: [], notices: [] },
    };
    const rendered = await alone({
      bundle: reopened,
      replies: [{ sentences: [{ text: "The pilot may proceed after the gate.", evidence: ["E2"] }], not_found: [] }], version: 6,
    }).render("Can the pilot proceed?");
    expect(rendered).toMatchObject({ outcome: "answered" });
    expect(rendered.result.response).not.toHaveProperty("notice");
  });

  it("does not turn an unfulfilled planner need into a missing user requirement", async () => {
    const item = record("gate", "Approved: the pilot may proceed after the gate.");
    const plannerExtra = {
      ...bundle([{ item, full: true, touched: 1 }], ["E1"]),
      plan: [{ part: 1, question: "Can the pilot proceed?", notes: "", needs: [
        { need: "pilot decision", status: "found" as const, evidence: ["E1"] },
        { need: "an unrelated optional context item", status: "not_found" as const, evidence: [] },
      ] }],
    };
    const rendered = await alone({
      bundle: plannerExtra,
      replies: [{ sentences: [{ text: "The pilot may proceed after the gate.", evidence: ["E1"] }], not_found: [] }], version: 6,
    }).render("Can the pilot proceed?");
    expect(rendered).toMatchObject({ outcome: "answered" });
    expect(rendered.result.response.parts[0]).toMatchObject({ status: "answered" });
    expect(rendered.result.response.parts[0]).not.toHaveProperty("gap");
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
