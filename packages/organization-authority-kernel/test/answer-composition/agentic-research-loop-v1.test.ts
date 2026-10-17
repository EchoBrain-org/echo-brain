import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskPortV2 } from "../../src/shared/evidence-desk-v2.js";
import { need, part, record, researchHarness as harness, result, step } from "./fixtures/agentic-scenarios.js";

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

describe("research loop: finishing with nothing found", () => {
  const approved = record("canary", "Approved: staging must verify owner approval of a staged meeting.");

  it("accepts not_found after searches while a metadata-only, newest-first ticket inventory has unread pages (c813591c)", async () => {
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => ticketPage(pageOf(input), 5));
    const h = harness([
      reads("open", [{ tool: "search", args: { query: "staged meeting approval" } }, { tool: "list", args: { source: "tickets" } }]),
      reads("open", [{ tool: "search", args: { source: "tickets", query: "canary" } }]),
      affects("not_found"),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    // The first finish is accepted: no repair, and no further ticket page is read.
    expect(h.generate).toHaveBeenCalledTimes(3);
    expect(view.rounds.map(round => round.rejected)).toEqual([[], [], []]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    // Coverage still says the inventory was not read to its end.
    expect(view.coverage.inventories).toEqual([expect.objectContaining({ source: "tickets", shown_count: 20, more: true })]);
  });

  it("still asks for a search of a metadata-only source it listed but never searched", async () => {
    const h = harness([
      reads("open", [{ tool: "search", args: { source: "meetings", query: "staged meeting approval" } }, { tool: "list", args: { source: "tickets" } }]),
      reads("open", [{ tool: "search", args: { source: "meetings", query: "canary" } }]),
      affects("not_found"),
      reads("open", [{ tool: "search", args: { source: "tickets", query: "canary" } }]),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list: async input => ticketPage(pageOf(input), 5) });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(view.rounds[2]!.rejected).toEqual([expect.stringContaining('listed inventory still has unread pages; repeat list with {"source":"tickets"}, or search tickets for the fact')]);
    expect(h.prompt(3).validation_error).toContain("or search tickets for the fact");
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
    expect(h.prompt(1).last_results).toEqual([{ tool: "open", id: "E1", note: "already open; its full text is in your scratchpad" }]);
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
    expect(h.prompt(2).last_results).toEqual([expect.objectContaining({ tool: "open", id: "E2", opened: ["E2"] })]);
    expect(h.prompt(3).last_results).toEqual([{ tool: "open", id: "E2", note: "already open; its full text is in your scratchpad" }]);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
  });
});
