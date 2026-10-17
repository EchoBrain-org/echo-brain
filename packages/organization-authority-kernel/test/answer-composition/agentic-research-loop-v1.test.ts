import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import { SWEEP_APPROVED_DECISION_V1 } from "../../src/answer-composition/renderers/sweep-renderer-v1.js";
import type { PersonSweepResultV1 } from "@echo-brain/organization-api";
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskOpenCitationInputV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { SEARCH_ONLY_STEP_PROMPT, STEP_PROMPT, TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";
import { listed, need, part, record, researchHarness as harness, result, step } from "./fixtures/agentic-scenarios.js";
import { deferred } from "./fixtures/deferred.js";

/**
 * The research loop's own rules, through the research core: when a finish is
 * accepted, what list and open answer, what counts as progress, and how
 * starting evidence is read.
 */

const JIRA: NonNullable<EvidenceDeskPortV2["live_sources"]>[number] = { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" };
/** A live ticket as a list row (metadata only) or opened (with its body). */
function ticket(key: string, text?: string): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `ticket_${key}`, source_id: "jira", kind: "ticket",
    citation: { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-one", ticket_id: key.replace(/\D/gu, ""), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest(text ?? "") },
    label: `${key}: Unrelated work`, ...(text === undefined ? {} : { text }), visibility: "only_me", occurred_at: "2026-10-06", date_kind: "created",
    attributes: { status: "Open" }, receipt_sha256: canonicalSha256({ key, text: text ?? null }),
  } satisfies EvidenceDeskItemV2);
}
/** One newest-first ticket page of 20 metadata rows, and a cursor while pages remain. */
const ticketPage = (page: number, pages: number) => result(Array.from({ length: 20 }, (_, index) => ticket(`ECHO-${page * 20 + index + 1}`)), page + 1 < pages ? { next_cursor: `page-${page + 2}` } : {});
const pageOf = (input: EvidenceDeskListInputV2) => input.cursor === undefined ? 0 : Number(input.cursor.slice(5)) - 1;

const brief = (task: string, starting: readonly unknown[], options: Partial<AgenticBriefV1["options"]> = {}, ifUnreadable: "fail" | "report" = "fail"): AgenticBriefV1 => ({
  goal: { kind: "task", task }, starting: starting.map(citation => ({ citation, if_unreadable: ifUnreadable })),
  budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false, ...options },
});
const affects = (status: string) => step([part("What does E1 affect?", [need("tickets the record affects", status)])], status === "open" ? [] : [{ tool: "finish", args: {} }]);
const reads = (status: string, actions: readonly { tool: string; args: Record<string, string> }[]) => ({ ...affects(status), actions });
/** A finish that cites what research read in full. */
const found = (...evidence: readonly string[]) => step([part("Recheck", [need("current state", "found", evidence)])], [{ tool: "finish", args: {} }]);

describe("research loop: finishing with nothing found", () => {
  const approved = record("canary", "Approved: staging must verify owner approval of a staged meeting.");

  it("accepts not_found after searches while a metadata-only, newest-first ticket inventory has unread pages (c813591c)", async () => {
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => ticketPage(pageOf(input), 5));
    const h = harness([
      reads("open", [
        { tool: "search", args: { query: "staged meeting approval" } }, { tool: "list", args: { source: "tickets" } },
        { tool: "search", args: { source: "tickets", query: "canary" } },
      ]),
      affects("not_found"),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    // The first finish is accepted: no repair, and no further ticket page is read.
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(view.rounds.map(round => round.rejected)).toEqual([[], []]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    // Coverage still says the inventory was not read to its end.
    expect(view.coverage.inventories).toEqual([expect.objectContaining({ source: "tickets", shown_count: 20, more: true })]);
  });

  it("still asks for a search of a metadata-only source it listed but never searched", async () => {
    const h = harness([
      reads("open", [
        { tool: "search", args: { source: "meetings", query: "staged meeting approval" } }, { tool: "search", args: { source: "meetings", query: "canary" } },
        { tool: "list", args: { source: "tickets" } },
      ]),
      affects("not_found"),
      reads("open", [{ tool: "search", args: { source: "tickets", query: "canary" } }]),
      affects("not_found"),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list: async input => ticketPage(pageOf(input), 5) });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining('listed inventory still has unread pages; repeat list with {"source":"tickets"}, or search tickets for the fact')]);
    expect(h.prompt(2).validation_error).toContain("or search tickets for the fact");
    // Once tickets were searched, the same finish is accepted.
    expect(view.stop).toEqual({ reason: "finished", completed: true });
  });

  it("keeps a listed source's unread pages blocking when its search did not complete", async () => {
    const search = vi.fn(async (input: Parameters<EvidenceDeskPortV2["search"]>[0]) => result([], input.source === "jira" ? { notice: "Tickets are temporarily unavailable." } : {}));
    const h = harness([
      reads("open", [
        { tool: "list", args: { source: "tickets" } }, { tool: "search", args: { source: "tickets", query: "canary" } },
        { tool: "search", args: { source: "meetings", query: "staged meeting approval" } }, { tool: "search", args: { source: "meetings", query: "canary" } },
      ]),
      affects("not_found"), affects("not_found"),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list: async input => ticketPage(pageOf(input), 5), search });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    // A search that returned a notice shows nothing about the source, so its unread pages still block absence.
    expect(view.rounds[1]!.rejected).toEqual([
      expect.stringContaining('listed inventory still has unread pages; repeat list with {"source":"tickets"}, or search tickets for the fact'),
      expect.stringContaining("listed inventory still has unread pages"),
    ]);
    expect(view.stop).toEqual({ reason: "unusable_step", completed: false });
  });

  it("treats a filtered inventory as read when the same source's unfiltered inventory is complete", async () => {
    const action = record("action", "Mara will publish the dashboard.", { kind: "action", attributes: { owner: "Mara Quinn" } });
    const h = harness([
      reads("open", [{ tool: "list", args: { source: "meetings", kind: "action" } }, { tool: "list", args: { source: "meetings" } }]),
      affects("not_found"),
    ], {
      openCitation: async () => result([approved]),
      list: async input => input.kinds === undefined ? result([action]) : result([action], { next_cursor: "page-2" }),
    });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
  });
});

describe("research loop: list", () => {
  const approved = record("display", "Approved: the display shows two decimals.");

  it("says an empty page with more to read was empty, never that nothing more is left", async () => {
    // A date filter applied after each newest-first page can leave a page empty while older pages remain.
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => result([], input.cursor === undefined ? { next_cursor: "page-2" } : {}));
    const h = harness([
      reads("open", [{ tool: "list", args: { source: "tickets", since: "2026-10-13" } }]),
      reads("open", [{ tool: "list", args: { source: "tickets", since: "2026-10-13" } }]),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(h.prompt(1).last_results).toEqual([expect.objectContaining({ tool: "list", items: [], more: true, note: "this page was empty (for example because of a date filter); more pages remain" })]);
    expect(view.rounds[1]!.actions[0]!.result).toMatchObject({ items: [], more: false, note: "nothing more to list" });
  });

  it("answers a repeat list of an inventory read to its end without a desk call or progress", async () => {
    const action = record("action", "Mara will publish the dashboard.", { kind: "action", attributes: { owner: "Mara Quinn" } });
    const list = vi.fn(async () => result([action]));
    const again = reads("open", [{ tool: "list", args: { source: "meetings" } }]);
    const h = harness([again, again, again, affects("not_found")], { openCitation: async () => result([approved]), list });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(list).toHaveBeenCalledTimes(1);
    expect(h.prompt(2).last_results).toEqual([expect.objectContaining({ tool: "list", items: [], more: false, note: "already listed in full; nothing more to list" })]);
    // Two repeat lists add nothing, so research stops before a fourth step.
    expect(h.generate).toHaveBeenCalledTimes(3);
    expect(view.stop).toEqual({ reason: "no_progress", completed: false });
  });

  it("never calls a repeat of an unavailable or cut-short inventory listed in full", async () => {
    const action = record("action", "Mara will publish the dashboard.", { kind: "action", attributes: { owner: "Mara Quinn" } });
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => input.source === "jira" ? result([], { notice: "Tickets are temporarily unavailable." }) : result([action], { truncated: true }));
    const again = reads("open", [{ tool: "list", args: { source: "tickets" } }, { tool: "list", args: { source: "meetings" } }]);
    const h = harness([again, again, again], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list });
    await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(list).toHaveBeenCalledTimes(2);
    expect(h.prompt(2).last_results).toEqual([
      expect.objectContaining({ tool: "list", items: [], more: false, note: "already listed; this source was unavailable, so its list is incomplete; use search" }),
      expect.objectContaining({ tool: "list", items: [], more: false, note: "already listed; nothing more to list; more items exist than list can show; use search" }),
    ]);
  });
});

describe("research loop: search", () => {
  it("runs one repeat of a search that came back with an availability notice again, and no further repeat", async () => {
    const approved = record("canary", "Approved: staging must verify owner approval of a staged meeting.");
    // Jira answered 429 to the first search with no source chosen: local hits came back with a notice.
    const search = vi.fn()
      .mockResolvedValueOnce(result([record("local", "THERM-50 waits on the firmware build.")], { notice: "Live tickets could not be searched just now." }))
      .mockResolvedValueOnce(result([ticket("THERM-50", "THERM-50: firmware build is green.")], { notice: "Live pages could not be searched just now." }));
    const again = reads("open", [{ tool: "search", args: { query: "THERM-50 status" } }]);
    const h = harness([again, again, again, step([part("What does E1 affect?", [need("tickets the record affects", "found", ["E3"])])], [{ tool: "finish", args: {} }])], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), search });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    // The repeat read the desk again; its own notice buys no third read.
    expect(search).toHaveBeenCalledTimes(2);
    expect(h.prompt(2).last_results).toEqual([expect.objectContaining({ results: ["E3"], notice: "Live pages could not be searched just now." })]);
    expect(h.prompt(3).last_results).toEqual([expect.objectContaining({ tool: "search", note: "already searched; results are in your scratchpad" })]);
    // The planner is told of the search once.
    expect(h.prompt(3).searches_done).toEqual([{ query: "THERM-50 status", time_zone: "UTC" }]);
  });
});

describe("research loop: open", () => {
  it("answers an open of an item already open in full in the scratchpad without a desk call or progress (4d69130a)", async () => {
    const therm = ticket("THERM-48", "THERM-48: firmware formats one decimal.");
    const open = vi.fn(async () => result([therm]));
    const reopen = reads("open", [{ tool: "open", args: { id: "E1" } }]);
    const h = harness([reopen, reopen, affects("found")], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([therm]), open });
    const view = await h.research.research({ trigger: "sweep", brief: brief(`Recheck ${agenticStartingSlotV1(1)}.`, [therm.citation], {}, "report") });
    expect(open).not.toHaveBeenCalled();
    expect(h.prompt(0).opened).toEqual([expect.objectContaining({ id: "E1", text: therm.text })]);
    expect(h.prompt(1).last_results).toEqual([{ tool: "open", args: { id: "E1" }, note: "already open; its full text is in your scratchpad" }]);
    // Re-opening adds nothing, so two such steps stop research.
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(view.stop).toEqual({ reason: "no_progress", completed: false });
  });

  it("still opens a discovered item once, then answers a repeat from the scratchpad", async () => {
    const approved = record("display", "Approved: the display shows two decimals.");
    const listedRow = ticket("THERM-46");
    const body = ticket("THERM-46", "THERM-46: firmware formats one decimal.");
    const open = vi.fn(async () => result([body]));
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "display decimals" } }]),
      reads("open", [{ tool: "open", args: { id: "E2" } }]),
      reads("open", [{ tool: "open", args: { id: "E2" } }]),
      step([part("What does E1 affect?", [need("tickets the record affects", "found", ["E2"])])], [{ tool: "finish", args: {} }]),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), search: async () => result([listedRow]), open });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.prompt(2).last_results).toEqual([{ tool: "open", args: { id: "E2" }, opened: ["E2"] }]);
    expect(h.prompt(3).last_results).toEqual([{ tool: "open", args: { id: "E2" }, note: "already open; its full text is in your scratchpad" }]);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
  });
});

describe("research loop: open walks a document", () => {
  /** Passage `n` of one document, as the desk releases it: a search hit without text, or opened with its text. */
  const passage = (n: number, text?: string): EvidenceDeskItemV2 => Object.freeze({
    id: `passage_${n}`, kind: "document_passage", label: "PRD: thermal display",
    citation: {
      kind: "source_revision", source_id: `source:${canonicalSha256({ prd: true }).slice(7)}`, revision_id: "revision-1", document_id: "doc_prd",
      source_sha256: canonicalSha256({ prd: "source" }), representation_sha256: canonicalSha256({ prd: "representation" }), anchor_sha256: canonicalSha256({ prd: n }),
    },
    ...(text === undefined ? {} : { text }), visibility: "team", receipt_sha256: canonicalSha256({ passage: n, text: text ?? null }),
  } satisfies EvidenceDeskItemV2);
  const body = (n: number) => passage(n, `Passage ${n} of the thermal display PRD.`);
  /** The desk opens a passage with the passage before and after it. */
  const around = (input: { readonly item: string }) => {
    const n = Number(input.item.slice(8));
    return result([body(n), ...[n - 1, n + 1].filter(value => value > 0).map(body)]);
  };
  const approved = record("display", "Approved: the display shows two decimals.");

  it("opens a neighbour an earlier open admitted, to read the passage beyond it", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => around(input));
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "display decimals" } }]),
      reads("open", [{ tool: "open", args: { id: "E2" } }]), // passage 5, with 4 and 6 as E3 and E4
      reads("open", [{ tool: "open", args: { id: "E4" } }]), // passage 6, to reach 7
      reads("open", [{ tool: "open", args: { id: "E2" } }]), // passage 5 again: answered from the scratchpad
      step([part("What does E1 affect?", [need("tickets the record affects", "found", ["E5"])])], [{ tool: "finish", args: {} }]),
    ], { openCitation: async () => result([approved]), search: async () => result([passage(5)]), open });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(open.mock.calls.map(([input]) => input.item)).toEqual(["passage_5", "passage_6"]);
    expect(view.rounds.slice(1, 4).map(round => round.actions[0]!.result)).toEqual([
      expect.objectContaining({ opened: ["E2", "E3", "E4"] }), expect.objectContaining({ opened: ["E4", "E2", "E5"] }),
      expect.objectContaining({ opened: [], note: "already open; its full text is in your scratchpad" }),
    ]);
    expect(view.items.find(item => item.id === "E5")).toMatchObject({ text: "Passage 7 of the thermal display PRD.", cited_by_plan: true });
    expect(view.stop).toEqual({ reason: "finished", completed: true });
  });

  it("opens a starting passage, which a starting read reads without its neighbours", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => around(input));
    const h = harness([
      reads("open", [{ tool: "open", args: { id: "E1" } }]),
      step([part("What does E1 affect?", [need("tickets the record affects", "found", ["E2"])])], [{ tool: "finish", args: {} }]),
    ], { openCitation: async () => result([body(5)]), open });
    await h.research.research({ trigger: "approved_record", brief: brief(`Recheck ${agenticStartingSlotV1(1)}.`, [passage(5).citation]) });
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.prompt(1).last_results).toEqual([{ tool: "open", args: { id: "E1" }, opened: ["E1", "E2", "E3"] }]);
  });
});

describe("research loop: open after a limited open", () => {
  it("still re-reads an item whose open was truncated or carried a notice, so a clean open can resolve it", async () => {
    const approved = record("display", "Approved: the display shows two decimals.");
    const body = ticket("THERM-46", "THERM-46: firmware formats one decimal.");
    const open = vi.fn(async () => result([body], open.mock.calls.length === 1 ? { truncated: true } : {}));
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "display decimals" } }]),
      reads("open", [{ tool: "open", args: { id: "E2" } }]),
      reads("open", [{ tool: "open", args: { id: "E2" } }]),
      reads("open", [{ tool: "open", args: { id: "E2" } }]),
      step([part("What does E1 affect?", [need("tickets the record affects", "found", ["E2"])])], [{ tool: "finish", args: {} }]),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), search: async () => result([ticket("THERM-46")]), open });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    // The truncated open is read again; once a clean open has returned it, a repeat is answered from the scratchpad.
    expect(open).toHaveBeenCalledTimes(2);
    expect(view.rounds.slice(1).map(round => round.actions[0]!.result)).toEqual([
      expect.objectContaining({ opened: ["E2"], truncated: true }), expect.objectContaining({ opened: ["E2"] }),
      expect.objectContaining({ opened: [], note: "already open; its full text is in your scratchpad" }),
    ]);
  });
});

describe("research loop: progress", () => {
  it("counts new full text and text upgrades as progress, never new metadata rows or related references (35130ae1)", async () => {
    const approved = record("display", "Approved: the display shows two decimals.");
    const body = ticket("ECHO-1", "ECHO-1: unrelated dashboard work.");
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => ticketPage(pageOf(input), 10));
    // ECHO-1 opens to its text and a related reference; ECHO-21 opens to a related reference only.
    const open = vi.fn(async (input: { readonly item: string }) => input.item === body.id ? result([body, ticket("BUG-412")]) : result([ticket("BUG-413")]));
    const listTickets = reads("open", [{ tool: "list", args: { source: "tickets" } }]);
    const h = harness([
      listTickets,                                           // 20 new rows: idle, and the planner may open what it found
      reads("open", [{ tool: "open", args: { id: "E2" } }]),  // ECHO-1's text arrives: progress
      listTickets,                                           // 20 more rows: idle
      reads("open", [{ tool: "open", args: { id: "E23" } }]), // only a related reference: still idle
      listTickets,                                           // 20 more rows: research stops
      listTickets,
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list, open });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(open).toHaveBeenCalledTimes(2);
    expect(view.rounds[3]!.actions[0]!.result).toMatchObject({ opened: [], items: ["E43"], note: "no readable text" });
    expect(h.generate).toHaveBeenCalledTimes(5);
    expect(list).toHaveBeenCalledTimes(3);
    expect(view.stop).toEqual({ reason: "no_progress", completed: false });
  });

  it("keeps the extra idle round a discovery earned through a later empty search, so a not_found finish is still accepted", async () => {
    const approved = record("canary", "Approved: staging must verify owner approval of a staged meeting.");
    const hits = ["ECHO-7", "ECHO-8", "ECHO-9"].map(key => ticket(key));
    const search = vi.fn(async (input: Parameters<EvidenceDeskPortV2["search"]>[0]) => result(input.query === "canary" ? hits : []));
    const h = harness([
      reads("open", [{ tool: "search", args: { source: "tickets", query: "canary" } }]),         // 3 new metadata-only hits: idle
      reads("open", [{ tool: "search", args: { source: "tickets", query: "staged meeting" } }]), // nothing: still idle
      affects("not_found"),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), search });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(search).toHaveBeenCalledTimes(2);
    expect(h.generate).toHaveBeenCalledTimes(3);
    expect(view.rounds.map(round => round.rejected)).toEqual([[], [], []]);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
  });

  it("stops after two idle rounds that discover nothing new", async () => {
    const approved = record("display", "Approved: the display shows two decimals.");
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "display" } }]), reads("open", [{ tool: "search", args: { query: "decimals" } }]),
      affects("not_found"),
    ], { openCitation: async () => result([approved]) });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(view.stop).toEqual({ reason: "no_progress", completed: false });
  });
});

describe("research loop: starting evidence", () => {
  const items = ["THERM-48", "THERM-46", "THERM-47"].map(key => ticket(key, `${key}: firmware formats one decimal.`));
  const keyOf = (input: EvidenceDeskOpenCitationInputV2) => (input.citation as { readonly ticket_id: string }).ticket_id;

  it("opens starting items together and registers them in brief order, whatever order they arrive in", async () => {
    const pending = new Map(items.map(item => [(item.citation as { readonly ticket_id: string }).ticket_id, deferred<EvidenceDeskResultV2>()]));
    const openCitation = vi.fn((input: EvidenceDeskOpenCitationInputV2) => pending.get(keyOf(input))!.promise);
    const h = harness([found("E1", "E2", "E3")], { live_sources: [JIRA], ticket_available: true, openCitation });
    const run = h.research.research({ trigger: "sweep", brief: brief(`Recheck ${agenticStartingSlotV1(1)}, ${agenticStartingSlotV1(2)} and ${agenticStartingSlotV1(3)}.`, items.map(item => item.citation), {}, "report") });
    await vi.waitFor(() => expect(openCitation).toHaveBeenCalledTimes(3));
    for (const item of [...items].reverse()) pending.get((item.citation as { readonly ticket_id: string }).ticket_id)!.resolve(result([item]));
    const view = await run;
    expect(h.prompt(0).task).toBe("Recheck E1, E2 and E3.");
    expect(view.items.map(item => [item.id, item.title])).toEqual([["E1", items[0]!.label], ["E2", items[1]!.label], ["E3", items[2]!.label]]);
  });

  it("keeps at most four starting reads in flight, as one planner step does", async () => {
    const many = Array.from({ length: 6 }, (_, index) => ticket(`THERM-${60 + index}`, `THERM-${60 + index}: body.`));
    const pending = many.map(() => deferred<EvidenceDeskResultV2>());
    const openCitation = vi.fn((input: EvidenceDeskOpenCitationInputV2) => pending[Number(keyOf(input)) - 60]!.promise);
    const h = harness([found("E1")], { live_sources: [JIRA], ticket_available: true, openCitation });
    const run = h.research.research({ trigger: "sweep", brief: brief(many.map((_, index) => agenticStartingSlotV1(index + 1)).join(" "), many.map(item => item.citation), {}, "report") });
    await vi.waitFor(() => expect(openCitation).toHaveBeenCalledTimes(4));
    pending[2]!.resolve(result([many[2]!]));
    await vi.waitFor(() => expect(openCitation).toHaveBeenCalledTimes(5));
    for (const [index, item] of many.entries()) pending[index]!.resolve(result([item]));
    const view = await run;
    expect(openCitation).toHaveBeenCalledTimes(6);
    expect(h.prompt(0).task).toBe("E1 E2 E3 E4 E5 E6");
    expect(view.items.map(item => item.title)).toEqual(many.map(item => item.label));
  });

  it("gives each starting item its own context budget", async () => {
    const context = (key: string, index: number) => ticket(`${key}-CTX-${index}`, `${key} context ${index}: ${"x".repeat(10 * 1024)}`);
    const openCitation = vi.fn(async (input: EvidenceDeskOpenCitationInputV2) => {
      const anchor = items.find(item => (item.citation as { readonly ticket_id: string }).ticket_id === keyOf(input))!;
      return result([anchor, ...[1, 2, 3].map(index => context(anchor.label.slice(0, 8), index))]);
    });
    const h = harness([found("E1", "E4")], { live_sources: [JIRA], ticket_available: true, openCitation });
    const view = await h.research.research({ trigger: "sweep", brief: brief(`Recheck ${agenticStartingSlotV1(1)} and ${agenticStartingSlotV1(2)}.`, items.slice(0, 2).map(item => item.citation), {}, "report") });
    // An anchor and the two 10 KB passages that fit its 24 KB, for each item; the third passage of each is left out.
    expect(h.prompt(0).task).toBe("Recheck E1 and E4.");
    expect(view.items.map(item => item.title)).toEqual([items[0]!.label, "THERM-48-CTX-1: Unrelated work", "THERM-48-CTX-2: Unrelated work", items[1]!.label, "THERM-46-CTX-1: Unrelated work", "THERM-46-CTX-2: Unrelated work"]);
  });

  it("stops the reads after a starting read that fails in a way that cannot be reported, and research with it", async () => {
    const signals = new Map<string, AbortSignal>();
    let whenFirstReturned: readonly boolean[] = [];
    const openCitation = vi.fn(async (input: EvidenceDeskOpenCitationInputV2) => {
      signals.set(keyOf(input), input.signal!);
      // The item before the failure is still read, as it would be one at a time; the one after it is stopped.
      if (keyOf(input) === "48") {
        await new Promise(resolve => setTimeout(resolve, 5));
        whenFirstReturned = [input.signal!.aborted, signals.get("47")!.aborted];
        return result([items[0]!]);
      }
      if (keyOf(input) === "46") throw new AuthorityOperationError("unavailable", "Source is down");
      return new Promise<EvidenceDeskResultV2>(() => undefined);
    });
    const h = harness([], { live_sources: [JIRA], ticket_available: true, openCitation });
    await expect(h.research.research({ trigger: "sweep", brief: brief(`Recheck ${agenticStartingSlotV1(1)}, ${agenticStartingSlotV1(2)} and ${agenticStartingSlotV1(3)}.`, items.map(item => item.citation), {}, "report") }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(openCitation).toHaveBeenCalledTimes(3);
    expect(whenFirstReturned).toEqual([false, true]);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("binds the receipts of starting reads the desk released when the caller cancels a later one", async () => {
    const stop = new AbortController();
    const openCitation = vi.fn(async (input: EvidenceDeskOpenCitationInputV2) => {
      // The third read hangs until the caller cancels.
      if (keyOf(input) === "47") return new Promise<EvidenceDeskResultV2>(() => undefined);
      return result([items.find(item => (item.citation as { readonly ticket_id: string }).ticket_id === keyOf(input))!]);
    });
    const h = harness([], { live_sources: [JIRA], ticket_available: true, openCitation });
    const run = h.research.research({ trigger: "sweep", brief: brief(`Recheck ${agenticStartingSlotV1(1)}, ${agenticStartingSlotV1(2)} and ${agenticStartingSlotV1(3)}.`, items.map(item => item.citation), { planner: false }, "report"), signal: stop.signal });
    await vi.waitFor(() => expect(openCitation).toHaveBeenCalledTimes(3));
    stop.abort();
    await expect(run).rejects.toThrow();
    const released = items.slice(0, 2).flatMap(item => [item.receipt_sha256, canonicalSha256({ desk: [item.id] })]);
    expect(h.audit).toEqual([expect.objectContaining({ trigger: "sweep", outcome: "cancelled", receipt_digests: released })]);
  });

  it("fails with the first failure in brief order, as reading one at a time would", async () => {
    const openCitation = vi.fn(async (input: EvidenceDeskOpenCitationInputV2) => {
      if (keyOf(input) === "48") { await new Promise(resolve => setTimeout(resolve, 5)); throw new AuthorityOperationError("not_found", "Evidence item is not available"); }
      throw new AuthorityOperationError("unavailable", "Source is down");
    });
    const h = harness([], { live_sources: [JIRA], ticket_available: true, openCitation });
    // The first item fails after the second, and its brief asked to fail on it.
    await expect(h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} and ${agenticStartingSlotV1(2)} affect.`, items.slice(0, 2).map(item => item.citation)) }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe("research loop: no planner (sweeps)", () => {
  const therm = ticket("THERM-48", "THERM-48: firmware now formats two decimals.");
  const gone = ticket("THERM-49");
  const openCitation = async (input: EvidenceDeskOpenCitationInputV2) => {
    if ((input.citation as { readonly ticket_id: string }).ticket_id === "49") throw new AuthorityOperationError("not_found", "Evidence item is not available");
    return result([therm]);
  };

  it("reads the starting evidence and stops as finished, with no planner call; what it read in full counts as read", async () => {
    const h = harness([], { live_sources: [JIRA], ticket_available: true, openCitation });
    const view = await h.research.research({ trigger: "sweep", brief: brief(`Recheck ${agenticStartingSlotV1(1)} and ${agenticStartingSlotV1(2)}.`, [therm.citation, gone.citation], { planner: false }, "report") });
    expect(h.generate).not.toHaveBeenCalled();
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view).toMatchObject({ goal: { kind: "task", task: "Recheck E1 and an item that could not be read." }, plan: [], rounds: [], unreadable_starting: [gone.citation] });
    expect(view.items).toEqual([expect.objectContaining({ id: "E1", text: therm.text, read_in_full: true, opened: true, preloaded: true, cited_by_plan: false })]);
    expect(view.cost).toMatchObject({ rounds: 0, model_calls: 0, repairs: 0, fallbacks: 0 });
    expect(h.audit).toEqual([expect.objectContaining({ trigger: "sweep", rounds: 0, model_calls: 0 })]);
  });

  it("lets the sweep's one judge call cite the starting items it read", async () => {
    const sweep = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "sweep")!;
    const event = sweep.parseEvent({ findings: [
      { finding: "Firmware shows one decimal", expected: "two decimals", citations: [therm.citation] },
      { finding: "Test case expects one decimal", expected: "two decimals", citations: [gone.citation] },
    ] });
    const h = harness([{ findings: [{ index: 0, verdict: "landed", line: "THERM-48 now formats two decimals.", cites: ["E1"] }] }], { live_sources: [JIRA], ticket_available: true, openCitation });
    const output = await h.research.renderWithResearch({ trigger: sweep.name, brief: sweep.brief(event, { kind: "global" }), renderer: sweep.renderer!, trigger_input: event });
    // One model call, and it is the judge's.
    expect(h.inputs.map(input => input.system_prompt.slice(0, 22))).toEqual(["You recheck open items"]);
    expect(JSON.parse(h.inputs[0]!.user_prompt)).toMatchObject({ findings: [{ index: 0, about: ["E1"] }], items: [expect.objectContaining({ id: "E1", text: therm.text })] });
    expect(output.rendered as PersonSweepResultV1).toMatchObject({
      findings: [
        { finding_index: 0, verdict: "landed", line: "THERM-48 now formats two decimals.", citation_indexes: [0] },
        { finding_index: 1, verdict: "unreadable", citation_indexes: [] },
      ],
      citations: [expect.objectContaining({ citation: therm.citation })],
    });
    expect(output.research).toMatchObject({ trigger: "sweep", stop: { reason: "finished", completed: true }, rounds: [] });
    expect(h.audit).toEqual([expect.objectContaining({ trigger: "sweep", outcome: "partial", rounds: 0, model_calls: 1, citation_count: 1 })]);
  });

  // Across workstreams: the planner-less read must open the finding's decision for the judge's placeholder expectation, and the
  // judge's own-item rule still holds when nothing but the starting items was read.
  it("shows the judge the decision it re-read for a placeholder expectation, and sends back a landed verdict grounded only in it", async () => {
    const sweep = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "sweep")!;
    const decision = record("display", "Approved: show two decimals (0.01 °C) on the display from DVT.");
    const event = sweep.parseEvent({ findings: [
      { finding: "Outdated Jira ticket from Display review", expected: SWEEP_APPROVED_DECISION_V1, citations: [therm.citation, decision.citation] },
    ] });
    const h = harness([
      { findings: [{ index: 0, verdict: "landed", line: "The decision asks for two decimals.", cites: ["E2"] }] },
      { findings: [{ index: 0, verdict: "landed", line: "THERM-48 now formats two decimals.", cites: ["E1", "E2"] }] },
    ], { live_sources: [JIRA], ticket_available: true,
      openCitation: async input => result([(input.citation as { readonly kind: string }).kind === "approved_record" ? decision : therm]) });
    const output = await h.research.renderWithResearch({ trigger: sweep.name, brief: sweep.brief(event, { kind: "global" }), renderer: sweep.renderer!, trigger_input: event });
    // No planner call: both calls are the judge's, the second its one repair.
    expect(h.inputs.map(input => input.system_prompt.slice(0, 22))).toEqual(["You recheck open items", "You recheck open items"]);
    expect(JSON.parse(h.inputs[0]!.user_prompt)).toMatchObject({ findings: [{ index: 0, expected: decision.text, about: ["E1"] }] });
    expect(JSON.parse(h.inputs[1]!.user_prompt).validation_error).toContain('finding 0 is "landed" but cites none of the items it is about (E1)');
    expect(output.rendered as PersonSweepResultV1).toMatchObject({ status: "assessed", findings: [{ finding_index: 0, verdict: "landed", line: "THERM-48 now formats two decimals." }] });
    expect(output.research).toMatchObject({ plan: [], rounds: [], stop: { reason: "finished", completed: true } });
  });

  it("refuses a brief with no planner and nothing to read before any read", async () => {
    const h = harness([], { openCitation: vi.fn(async () => result([therm])) });
    await expect(h.research.research({ trigger: "sweep", brief: brief("Recheck.", [], { planner: false }) })).rejects.toThrow("research goal is invalid");
    await expect(h.research.research({ trigger: "ask", brief: { goal: { kind: "question", question: "What changed?" }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: true, planner: false } } }))
      .rejects.toThrow("question is invalid");
    await expect(h.research.research({ trigger: "sweep", brief: brief(`Recheck ${agenticStartingSlotV1(1)}.`, [therm.citation], { planner: "no" as never }) })).rejects.toThrow("research goal is invalid");
    expect(h.port.openCitation).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe("research loop: search only (a record in no project)", () => {
  const approved = record("canary", "Approved: staging must verify owner approval of a staged meeting.");
  const tools = (index: number, h: ReturnType<typeof harness>) => (((h.inputs[index]!.schema as { properties: { actions: { items: { anyOf: { properties: { tool: { enum: string[] } } }[] } } } }).properties.actions.items.anyOf).map(variant => variant.properties.tool.enum[0]));

  it("offers no list tool, refuses a proposed list, and finishes with nothing affected after searching", async () => {
    const list = vi.fn(async () => result([]));
    const h = harness([
      reads("open", [{ tool: "list", args: { source: "tickets" } }]),
      reads("open", [{ tool: "search", args: { query: "staged meeting approval" } }, { tool: "search", args: { query: "canary" } }]),
      affects("not_found"),
    ], { scope: { kind: "global" }, live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation], { list: false }) });
    expect(h.inputs[0]!.system_prompt).toBe(`${SEARCH_ONLY_STEP_PROMPT}\n\nLive sources report current tool context under the asker's connection. They are not approved meeting records. Use each source's selector and capabilities from source_catalog. Metadata-only search discovers items; open their request-owned ids before relying on their bodies. The server already applies scope and permissions. Never choose a tenant, account, connection or project mapping.\n\n${TASK_RULE_PROMPT}`);
    expect(tools(0, h)).toEqual(["search", "open", "finish"]);
    // The catalog keeps each source's description but drops what only list uses.
    const catalog = h.prompt(0).source_catalog as readonly Record<string, unknown>[];
    expect(catalog.map(entry => entry.source)).toEqual(["meetings", "documents", "tickets"]);
    expect(catalog[2]).toMatchObject({ description: "Live work items.", tool_id: "jira" });
    expect(catalog[2]).not.toHaveProperty("metadata_only_list");
    expect(h.prompt(1).validation_error).toContain("list is unavailable in this run; use search and open");
    expect(list).not.toHaveBeenCalled();
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.coverage.inventories).toEqual([]);
  });

  it("never tells a search-only planner to list, even when it refuses a finish", async () => {
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "canary" } }]),
      affects("not_found"), affects("not_found"),
    ], { openCitation: async () => result([approved]) });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation], { list: false }) });
    // One search is not enough to conclude absence; the refusal says what to do without naming list.
    expect(view.rounds[1]!.rejected).toEqual([
      expect.stringContaining("Search or open more, or correct the need status and evidence."), expect.stringContaining("Search or open more"),
    ]);
    expect(view.rounds.flatMap(round => round.rejected).join(" ")).not.toMatch(/\blist\b/u);
  });

  it("keeps the full prompt and the list tool when the brief allows list", async () => {
    const h = harness([affects("not_found"), affects("not_found")], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]) });
    await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(h.inputs[0]!.system_prompt.startsWith(`${STEP_PROMPT}\n\n`)).toBe(true);
    expect(tools(0, h)).toEqual(["search", "open", "list", "finish"]);
    expect(h.prompt(0).source_catalog).toEqual(expect.arrayContaining([expect.objectContaining({ source: "tickets", metadata_only_list: true })]));
  });

  it("runs the approved record at global scope search-only, from its definition", async () => {
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "approved_record")!;
    const event = definition.parseEvent({ record: approved.citation });
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "staged meeting approval" } }, { tool: "search", args: { query: "canary" } }]),
      affects("not_found"),
      { decided: [{ id: "E1", text: "Staging verifies approval of a staged meeting." }], affected: [] },
    ], { scope: { kind: "global" }, live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]) });
    const output = await h.research.renderWithResearch({ trigger: definition.name, brief: definition.brief(event, { kind: "global" }), renderer: definition.renderer!, trigger_input: event });
    expect(tools(0, h)).toEqual(["search", "open", "finish"]);
    expect(h.prompt(0).task).not.toContain("in this project");
    expect(output.research.stop).toEqual({ reason: "finished", completed: true });
  });

  it("refuses a brief whose list option is not a boolean", async () => {
    const h = harness([], { openCitation: vi.fn(async () => result([approved])) });
    await expect(h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation], { list: "no" as never }) })).rejects.toThrow("research goal is invalid");
    expect(h.port.openCitation).not.toHaveBeenCalled();
  });
});

describe("research loop: prompt layout", () => {
  const first = record("first", "Approved: the display shows two decimals.");
  const second = record("second", "Approved: the firmware formats the reading.");
  const openCitation = async (input: EvidenceDeskOpenCitationInputV2) => result([input.citation === first.citation ? first : second]);
  const task = brief(`Find what ${agenticStartingSlotV1(1)} and ${agenticStartingSlotV1(2)} affect.`, [first.citation, second.citation]);

  it("sends a stable head, then the evidence, then what changes every step", async () => {
    const h = harness([reads("open", [{ tool: "search", args: { query: "display" } }]), affects("not_found"), affects("not_found")], { openCitation });
    await h.research.research({ trigger: "approved_record", brief: task });
    expect(Object.keys(h.prompt(0))).toEqual(["task", "today", "time_zone", "time_reference", "scope", "source_catalog", "opened", "seen", "step", "steps_left", "plan", "inventories", "last_results", "searches_done"]);
  });

  it("repeats each step's head and evidence as the next step's prefix, never re-sorting what it read (F5)", async () => {
    // Step 1 cites E1 and its search re-finds E2: the opened bodies used to be re-sorted cited-then-recent.
    const h = harness([
      step([part("What do E1 and E2 affect?", [need("what E1 affects", "found", ["E1"]), need("what E2 affects", "open")])], [{ tool: "search", args: { query: "display" } }]),
      step([part("What do E1 and E2 affect?", [need("what E2 affects", "open")])], [{ tool: "search", args: { query: "firmware" } }]),
      step([part("What do E1 and E2 affect?", [need("what E2 affects", "found", ["E3"])])], [{ tool: "finish", args: {} }]),
    ], {
      openCitation,
      search: async input => result(input.query === "display" ? [second, record("panel", "The panel spec shows one decimal.")] : [record("driver", "The driver rounds to one decimal.")]),
    });
    await h.research.research({ trigger: "approved_record", brief: task });
    // Everything up to the end of a step's seen entries.
    const evidence = (index: number) => { const prompt = h.inputs[index]!.user_prompt; return prompt.slice(0, prompt.indexOf('],"', prompt.indexOf('"seen":['))); };
    for (const index of [0, 1, 2]) expect(h.prompt(index).opened).toEqual([expect.objectContaining({ id: "E1" }), expect.objectContaining({ id: "E2" })]);
    expect(h.inputs[1]!.user_prompt.startsWith(evidence(0))).toBe(true);
    expect(h.inputs[2]!.user_prompt.startsWith(evidence(1))).toBe(true);
    expect((h.prompt(2).seen as readonly { readonly id: string }[]).map(entry => entry.id)).toEqual(["E3", "E4"]);
  });

  it("names what each read returned by id in rank order, with item details only in opened and seen (F6)", async () => {
    const panel = record("panel", "The panel spec shows one decimal.");
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "display" } }, { tool: "open", args: { id: "E2" } }]),
      affects("not_found"), affects("not_found"),
    ], { openCitation, search: async () => result([panel, second], { truncated: true }) });
    await h.research.research({ trigger: "approved_record", brief: task });
    expect(h.prompt(1).last_results).toEqual([
      { tool: "search", args: { query: "display" }, results: ["E3", "E2"], truncated: true },
      { tool: "open", args: { id: "E2" }, note: "already open; its full text is in your scratchpad" },
    ]);
    expect(h.prompt(1).seen).toEqual([expect.objectContaining({ id: "E3", title: panel.label, text: panel.text, full: true })]);
  });

  it("keeps what the latest reads returned when the scratchpad is full, and leaves out the newest others", async () => {
    const many = Array.from({ length: 310 }, (_, index) => listed(`row-${index}`));
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "rows" } }]),
      reads("open", [{ tool: "search", args: { query: "more rows" } }]),
      affects("not_found"),
    ], { openCitation: async () => result([first]), search: async input => result(input.query === "rows" ? many : [listed("late-1"), listed("late-2")]) });
    await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [first.citation]) });
    const ids = (index: number) => (h.prompt(index).seen as readonly { readonly id: string }[]).map(entry => entry.id);
    // At most 300 entries: the first search's newest rows are left out, then the second search's two rows are kept.
    expect(ids(1)).toEqual(Array.from({ length: 300 }, (_, index) => `E${index + 2}`));
    expect(ids(2)).toEqual([...Array.from({ length: 298 }, (_, index) => `E${index + 2}`), "E312", "E313"]);
    expect(h.prompt(2).last_results).toEqual([{ tool: "search", args: { query: "more rows" }, results: ["E312", "E313"] }]);
  });
});

describe("research loop: need ids", () => {
  /** A proposed need that names the plan's id for it. */
  const withId = (id: string, value: ReturnType<typeof need>) => ({ id, ...value });
  const release = "clean-v1-20261015-follow-ups-25bff4b-r2";
  const question = `What was decided about synthetic staging release ${release}?`;
  const planned = `any decision about synthetic staging release ${release}`;
  const search = async () => result([
    record("decision", `Approved: synthetic staging release ${release} must verify owner approval of a staged meeting.`),
    record("action", `Verify owner approval for release ${release} before sign-off.`, { kind: "action" }),
    record("rationale", `Release ${release} is a canary for the approval path.`, { kind: "rationale" }),
  ]);
  const first = step([part(question, [need(planned, "open")])], [{ tool: "search", args: { query: release } }]);
  /** 005d7876 step 2: a correct finish that rewords the planned need and adds two more. */
  const reworded = (id?: string) => step([part(question, [
    id === undefined ? need(`approved decision about release ${release}`, "found", ["E1"]) : withId(id, need(`approved decision about release ${release}`, "found", ["E1"])),
    need("any associated action", "found", ["E2"]), need("rationale for the decision", "found", ["E3"]),
  ])], [{ tool: "finish", args: {} }]);
  const answer = { sentences: [{ text: "The release must verify owner approval of a staged meeting.", evidence: ["E1"] }], not_found: [] };
  const settled = [
    { need: planned, status: "found", evidence: ["E1"] },
    { need: "any associated action", status: "found", evidence: ["E2"] }, { need: "rationale for the decision", status: "found", evidence: ["E3"] },
  ];

  it("accepts a finish that rewords a need but keeps its id (005d7876)", async () => {
    const h = harness([first, reworded("N1"), answer], { search });
    const { research } = await h.research.answerWithResearch({ question });
    // The planner sees each need's id; the first finish is accepted, with no repair.
    expect(h.prompt(1).plan).toEqual([{ part: 1, question, notes: "", needs: [{ id: "N1", need: planned, status: "open", evidence: [] }] }]);
    expect(h.generate).toHaveBeenCalledTimes(3);
    expect(research.rounds.map(round => round.rejected)).toEqual([[], []]);
    expect(research.stop).toEqual({ reason: "finished", completed: true });
    // A need keeps the wording first planned, and the bundle's plan carries no ids.
    expect(research.plan[0]!.needs).toEqual(settled);
  });

  it("names the need a reworded finish left open by its id, so the repair can settle it", async () => {
    const h = harness([first, reworded(), reworded("n1"), answer], { search });
    const { research } = await h.research.answerWithResearch({ question });
    expect(h.prompt(2).validation_error).toContain(`part 1 need N1 "${planned}" is still open`);
    expect(research.stop).toEqual({ reason: "finished", completed: true });
    expect(research.plan[0]!.needs).toEqual(settled);
  });

  it("settles a need by its id in any part, and gives each new need the next id", async () => {
    const h = harness([
      step([part("When is launch?", [need("launch date", "open")]), part("Who owns it?", [need("launch owner", "open")])], [{ tool: "search", args: { query: "launch" } }]),
      // Parts reordered: the ids still name the right needs.
      step([
        part("Who owns it?", [withId("N2", need("owner of the launch", "found", ["E2"])), need("owner's team", "open")]),
        part("When is launch?", [withId("N1", need("approved launch date", "found", ["E1"]))]),
      ], [{ tool: "search", args: { query: "launch team" } }]),
      step([part("When is launch?", [])], [{ tool: "finish", args: {} }]),
      step([part("When is launch?", [])], [{ tool: "finish", args: {} }]),
    ], { search: async () => result([record("date", "Launch is approved for Tuesday."), record("owner", "Mara owns the launch.")]) });
    const view = await h.research.research({ trigger: "approved_record", brief: brief("Find the launch date and owner.", []) });
    expect(h.prompt(2).plan).toEqual([
      { part: 1, question: "When is launch?", notes: "", needs: [{ id: "N1", need: "launch date", status: "found", evidence: ["E1"] }, { id: "N3", need: "owner's team", status: "open", evidence: [] }] },
      { part: 2, question: "Who owns it?", notes: "", needs: [{ id: "N2", need: "launch owner", status: "found", evidence: ["E2"] }] },
    ]);
    // A finish that leaves N3 open is refused by its id.
    expect(view.rounds[2]!.rejected[0]).toContain('part 1 need N3 "owner\'s team" is still open');
  });

  it("shows the need id in the reply shape both step prompts call exact, as rule 1 and the example do", () => {
    for (const prompt of [STEP_PROMPT, SEARCH_ONLY_STEP_PROMPT]) {
      const lines = prompt.split("\n");
      const shape = JSON.parse(lines[lines.indexOf("Reply with ONLY a JSON object in exactly this shape:") + 1]!) as { parts: { needs: unknown[] }[] };
      expect(shape.parts[0]!.needs[0]).toEqual({ id: "N1", need: "<a fact needed>", status: "open", evidence: [] });
      expect(prompt).toContain("A need's \"id\" is its id from plan; leave it out in step 1 and for a new need.");
    }
  });

  it("settles a need its id names in a part the step adds, where it was planned, and adds only the new needs", async () => {
    const h = harness([
      step([part("When and who?", [need("launch date", "open"), need("launch owner", "open")])], [{ tool: "search", args: { query: "launch" } }]),
      // A new second part carries N2, planned in part 1, and one need that is new.
      step([
        part("When and who?", [withId("N1", need("launch date", "found", ["E1"]))]),
        part("Who owns launch?", [withId("N2", need("launch owner", "found", ["E2"])), need("owner's team", "open")]),
      ], [{ tool: "search", args: { query: "launch team" } }]),
      // A part made only of planned needs adds no part: the finish is accepted.
      step([part("When and who?", []), part("Who owns launch?", [withId("N3", need("owner's team", "found", ["E2"]))]), part("Owner?", [withId("N2", need("launch owner", "found", ["E2"]))])],
        [{ tool: "finish", args: {} }]),
    ], { search: async () => result([record("date", "Launch is approved for Tuesday."), record("owner", "Mara owns the launch for the platform team.")]) });
    const view = await h.research.research({ trigger: "approved_record", brief: brief("Find the launch date and owner.", []) });
    expect(h.prompt(2).plan).toEqual([
      { part: 1, question: "When and who?", notes: "", needs: [{ id: "N1", need: "launch date", status: "found", evidence: ["E1"] }, { id: "N2", need: "launch owner", status: "found", evidence: ["E2"] }] },
      { part: 2, question: "Who owns launch?", notes: "", needs: [{ id: "N3", need: "owner's team", status: "open", evidence: [] }] },
    ]);
    expect(view.rounds.map(round => round.rejected)).toEqual([[], [], []]);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.plan.map(value => value.question)).toEqual(["When and who?", "Who owns launch?"]);
  });
});

describe("research loop: step time", () => {
  /** Ask's 90 s deadline with room for 20 rounds, so only time stops research. */
  const timed: AgenticBriefV1 = { ...brief("Find what changed.", []), budget: { deadline_ms: 90_000, max_rounds: 20, max_model_calls: 48, writer_reserve_ms: 25_000 } };
  const searching = (index: number) => reads("open", [{ tool: "search", args: { query: `term ${index}` } }]);
  const search = async (input: { readonly query?: string }) => result([record(`hit-${input.query ?? ""}`)]);

  it("does not start a step with less than 1.25 times the longest step call so far, and stops for budget (2233bad1)", async () => {
    let time = 0;
    // Each step call takes 8 s of the request's time: the eighth would start with 7 s, where it used to start (and time out).
    const h = harness((_input, index) => { time += 8_000; return searching(index); }, { search }, { now_ms: () => time });
    const view = await h.research.research({ trigger: "approved_record", brief: timed });
    expect(h.inputs.map(input => input.timeout_ms)).toEqual([25_000, 25_000, 25_000, 25_000, 25_000, 23_000, 15_000]);
    expect(view.stop).toEqual({ reason: "budget", completed: false });
    expect(view.cost).toMatchObject({ rounds: 7, fallbacks: 0 });
  });

  it("still starts a step that has a whole step's time after a slower step", async () => {
    let time = 0;
    const h = harness((_input, index) => { time += 22_000; return searching(index); }, { search }, { now_ms: () => time });
    const view = await h.research.research({ trigger: "approved_record", brief: timed });
    // 1.25 times 22 s is more than a whole step: the second step starts with its whole 25 s; the third, with 19 s, does not.
    expect(h.inputs.map(input => input.timeout_ms)).toEqual([25_000, 25_000]);
    expect(view.stop).toEqual({ reason: "budget", completed: false });
  });

  it("stops for budget, not with an unusable step, when a retried access check leaves a step less than it needs", async () => {
    let time = 0; let checks = 0;
    const h = harness((_input, index) => { time += 8_000; return searching(index); }, {
      search,
      revalidate: async () => {
        checks += 1;
        // The seventh step starts with 15 s, over its 10 s need. Its check fails after 3 s, and the retry takes 2.5 s more: 9.5 s.
        if (checks === 7) { time += 3_000; throw new AuthorityOperationError("unavailable", "Jira briefly unavailable"); }
        if (checks === 8) time += 2_500;
        return { checked_at: "2026-10-06T00:00:00.000Z" };
      },
    }, { now_ms: () => time });
    const view = await h.research.research({ trigger: "approved_record", brief: timed });
    // No seventh model call goes out with 9.5 s, where one as slow as the others would time out and leave no time to repair.
    expect(h.inputs.map(input => input.timeout_ms)).toEqual([25_000, 25_000, 25_000, 25_000, 25_000, 23_000]);
    expect(view.stop).toEqual({ reason: "budget", completed: false, admission: "post_revalidation_no_time" });
    expect(view.cost).toMatchObject({ fallbacks: 0 });
  });
});

describe("research core: what a task trigger's renderer was shown and cited", () => {
  const decision = record("two-decimals", "Approved on Oct 8: show 0.01 °C on the display for MRD-02.");
  const therm = ticket("THERM-46", "THERM-46: the firmware formats one decimal.");

  it.each(["approved_record", "sweep"] as const)("counts the tickets the %s renderer was shown and cited", async trigger => {
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === trigger)!;
    const replies = trigger === "approved_record" ? [
      reads("open", [{ tool: "search", args: { query: "display decimals" } }]),
      step([part("What does E1 affect?", [need("tickets the record affects", "found", ["E2"])])], [{ tool: "finish", args: {} }]),
      { decided: [{ id: "E1", text: "Show two decimals on the display." }], affected: [{ id: "E2", says_now: "The firmware formats one decimal.", relation: "conflicts", date_at_risk: "", milestone: "" }] },
    ] : [{ findings: [{ index: 0, verdict: "still_open", line: "THERM-46 still formats one decimal.", cites: ["E1"] }] }];
    const h = harness(replies, {
      live_sources: [JIRA], ticket_available: true, search: async () => result([therm]),
      openCitation: async input => result([(input.citation as { readonly kind: string }).kind === "ticket" ? therm : decision]),
    });
    const event = trigger === "approved_record" ? definition.parseEvent({ record: decision.citation })
      : definition.parseEvent({ findings: [{ finding: "Firmware shows one decimal", expected: "two decimals", citations: [therm.citation, decision.citation] }] });
    const metadata: CoreRuntimeObservationV1[] = [];
    const output = await observeCoreRuntimeV1("research_run", () => h.research.renderWithResearch({ trigger, brief: definition.brief(event, h.port.scope), renderer: definition.renderer!, trigger_input: event }),
      { observer: value => { metadata.push(value); } });
    expect(JSON.stringify(output.rendered)).toContain((therm.citation as { readonly permalink: string }).permalink);
    expect(metadata.filter(value => value.phase === "research_run" && value.event === "succeeded")).toEqual([
      expect.objectContaining({ counts: expect.objectContaining({ ticket_retrieved_items: 1, ticket_context_items: 1, ticket_citations: 1 }) }),
    ]);
  });
});
