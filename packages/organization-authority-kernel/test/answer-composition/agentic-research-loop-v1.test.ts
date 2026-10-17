import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { PersonSweepResultV1 } from "@echo-brain/organization-api";
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskOpenCitationInputV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { SEARCH_ONLY_STEP_PROMPT, STEP_PROMPT, TASK_RULE_PROMPT } from "../../src/answer-composition/agentic-ask-v1-model-protocol.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";
import { need, part, record, researchHarness as harness, result, step } from "./fixtures/agentic-scenarios.js";
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
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list: async input => ticketPage(pageOf(input), 5) });
    const view = await h.research.research({ trigger: "approved_record", brief: brief(`Find what ${agenticStartingSlotV1(1)} affects.`, [approved.citation]) });
    expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining('listed inventory still has unread pages; repeat list with {"source":"tickets"}, or search tickets for the fact')]);
    expect(h.prompt(2).validation_error).toContain("or search tickets for the fact");
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
