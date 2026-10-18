import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonFollowUpEvidenceV1 } from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import { askQuestionCompletionProblemsV1, askResearchCompletionProblemsV1, type AskResearchListV1 } from "../../src/answer-composition/agentic-ask-research-state-v1.js";
import { createAgenticAskV4 } from "../../src/answer-composition/agentic-ask-v1.js";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1, followUpDeskFieldsV1 } from "../../src/shared/follow-up-evidence-v1.js";
import { checked, generation, LIST_READ_AT, listed, record, researchHarness as harness, result } from "./fixtures/agentic-scenarios.js";

/**
 * Ask's lists as evidence of which items exist (ADR-0041): a list read to its
 * end lets research finish without opening its members; an unfinished one
 * asks for its next page; an exactly full last page is never trusted as the
 * end; a filter a source cannot apply is said, never silently widened; and
 * the access check before every model call still covers a list's members.
 * The same path serves pages, tickets, meetings and follow-ups. A task goal
 * keeps the rules before ADR-0041.
 */

const CONFLUENCE: NonNullable<EvidenceDeskPortV2["live_sources"]>[number] = { source_id: "confluence", kind: "page", selector: "pages", description: "Live knowledge pages.", metadata_only_list: true, tool_id: "confluence" };
const JIRA: NonNullable<EvidenceDeskPortV2["live_sources"]>[number] = { source_id: "jira", kind: "ticket", selector: "tickets", description: "Live work items.", metadata_only_list: true, tool_id: "jira" };

/** The 8 pages the October 4 list returned on staging (trace ee2f0973, release c15cd0f): id, title, created, updated, version. */
const OCTOBER_4: readonly (readonly [string, string, string, string, string])[] = [
  ["589865", "ECHO Product Pipeline — Start Here", "2026-10-04T08:24:06.602Z", "2026-10-05T22:11:30.875Z", "3"],
  ["1474561", "Assumptions and decisions — source facts versus proposals", "2026-10-04T23:20:34.011Z", "2026-10-04T23:38:56.950Z", "3"],
  ["1441793", "Gate reviews — EVT pass, DVT hold, PVT pending", "2026-10-04T23:20:32.966Z", "2026-10-04T23:38:56.091Z", "3"],
  ["1409042", "Traceability — requirement threads and BUG-412 walkthrough", "2026-10-04T23:20:33.469Z", "2026-10-04T23:38:56.546Z", "3"],
  ["1409025", "PRD — System and acceptance requirements", "2026-10-04T23:12:35.624Z", "2026-10-04T23:38:55.130Z", "3"],
  ["1212607", "Verification plan — EVT, DVT and PVT mock results", "2026-10-04T23:15:15.480Z", "2026-10-04T23:38:55.604Z", "3"],
  ["1212589", "MRD — Mock Digital Thermometer", "2026-10-04T23:12:34.763Z", "2026-10-04T23:38:19.907Z", "3"],
  ["1015989", "Mock Digital Thermometer Home", "2026-10-04T23:06:19.406Z", "2026-10-04T23:38:54.598Z", "5"],
];
/** A page as a list row: title, dates and status, no text (the reader cites the empty inventory section). */
function pageRow([id, title, created, updated, version]: readonly [string, string, string, string, string]): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `page_${id}_inventory`, source_id: "confluence", kind: "page" as const, label: title, visibility: "only_me" as const,
    citation: { kind: "page" as const, tool_id: "confluence", external_scope_id: "site-one", page_id: id, section_id: "inventory", version, permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: sha256Digest("") },
    dates: { created, updated }, occurred_at: updated.slice(0, 10), date_kind: "version_created" as const, attributes: { status: "current" }, receipt_sha256: canonicalSha256({ page: id }),
  } satisfies EvidenceDeskItemV2);
}
const PAGES = OCTOBER_4.map(pageRow);
const MEMBERS = PAGES.map((_, index) => `E${index + 1}`);
/** What opening a page row released on staging: one of its sections, a new item with its own id. */
const section = (row: EvidenceDeskItemV2, body: string): EvidenceDeskItemV2 => Object.freeze({
  ...row, id: row.id.replace("inventory", "s1"), text: body,
  citation: { ...(row.citation as Extract<EvidenceDeskItemV2["citation"], { kind: "page" }>), section_id: "s1", text_sha256: sha256Digest(body) },
});

/** A ticket as a list row: key and summary, status and assignee, no text. */
function ticketRow(n: number, owner = "Dana Lee", status = "In Progress"): EvidenceDeskItemV2 {
  const key = `THERM-${n}`;
  return Object.freeze({
    id: `ticket_${key}`, source_id: "jira", kind: "ticket" as const, label: `${key}: Fixture work ${n}`, visibility: "only_me" as const,
    citation: { kind: "ticket" as const, tool_id: "jira", external_scope_id: "cloud-one", ticket_id: String(10_000 + n), permalink: `https://tickets.example.test/browse/${key}`, text_sha256: sha256Digest("") },
    dates: { created: "2026-10-04T18:00:00.000Z" }, occurred_at: "2026-10-04", date_kind: "created" as const, attributes: { status, owner }, receipt_sha256: canonicalSha256({ ticket: key }),
  } satisfies EvidenceDeskItemV2);
}
const tickets = (from: number, count: number) => Array.from({ length: count }, (_, index) => ticketRow(from + index));
/** A ticket as an open returns it: its body, under the row's own id. */
function ticketBody(n: number, text: string): EvidenceDeskItemV2 {
  return Object.freeze({ ...ticketRow(n), text, citation: { ...(ticketRow(n).citation as Extract<EvidenceDeskItemV2["citation"], { kind: "ticket" }>), text_sha256: sha256Digest(text) } });
}

/** A follow-up as the desk releases it: its row carries its text (ADR-0040). */
function followUpItem(n: number): EvidenceDeskItemV2 {
  const decision = { title: "THERM DVT recovery sync", first_line: "Ship fan curve v2 before DVT.", ref: `meeting:sha256:${"a".repeat(64)}` } as const;
  const fields = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: `itm_6b0f8a52-55a4-4f6e-9a39-${String(n).padStart(12, "0")}`, kind: "ticket", title: `THERM-${40 + n} follow-up`, owner: "Mara Lind", status: "open", decision }));
  return Object.freeze({ id: `follow-up-${n}`, ...fields, visibility: "team" as const, receipt_sha256: canonicalSha256(`follow-up-${n}`) });
}

const question = (text: string): AgenticBriefV1 => ({ goal: { kind: "question", question: text }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: false } });
/** One step with one need; `kind` is the need's declared kind (ADR-0041), content when left out. */
const ask = (text: string, need: string, status: "open" | "found" | "not_found", evidence: readonly string[], actions: readonly unknown[], id?: string, kind?: string) =>
  ({ parts: [{ question: text, needs: [{ ...(id === undefined ? {} : { id }), need, ...(kind === undefined ? {} : { kind }), status, evidence }], notes: "" }], actions });
/** Which items exist in a set picked by list facts: a list answers it. */
const WI = "which_items";
/** Which members of such a set say something: it cites the list it checks. */
const WS = "which_say";
const finish = { tool: "finish", args: {} } as const;
/** The writer uses list L1: code names its members (ADR-0041). */
const useL1 = { lists: [{ id: "L1" }], sentences: [], not_found: [] } as const;

const OCT4 = "Which Confluence pages were created on October 4, 2026?";
const OCT4_NEED = "list of Confluence pages created on 2026-10-04";
const OCT4_LIST = { tool: "list", args: { date_field: "created", since: "2026-10-04", source: "pages", until: "2026-10-04" } } as const;
/** The live desk of the failing run: its Confluence list returned the 8 rows, read to their end. */
const october4Desk = (extra: Partial<EvidenceDeskPortV2> = {}): Partial<EvidenceDeskPortV2> => ({
  live_sources: [CONFLUENCE], list: vi.fn(async (input: EvidenceDeskListInputV2) => result(input.source === "confluence" ? PAGES : []) as EvidenceDeskResultV2), ...extra,
});

describe("Ask research: the October 4 Confluence list (trace ee2f0973)", () => {
  it("finishes on the complete list in two steps, without opening a page", async () => {
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], october4Desk());
    const view = await h.research.research({ trigger: "ask", brief: question(OCT4) });
    // Two research calls, then the writer, which sees the list's rows although they have no text.
    expect(h.generate).toHaveBeenCalledTimes(3);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.rounds.map(round => round.rejected)).toEqual([[], []]);
    expect(view.rounds.flatMap(round => round.actions.map(action => action.tool))).toEqual(["list", "finish"]);
    expect(view.plan[0]!.needs).toEqual([{ need: OCT4_NEED, kind: "which_items", status: "found", evidence: ["L1"] }]);
    expect(view.lists).toEqual([{
      id: "L1", source: "pages", filter: { since: "2026-10-04", until: "2026-10-04", date_field: "created", time_zone: "UTC" },
      filter_applied: { since: "applied", until: "applied", date_field: "applied" }, members: MEMBERS, shown: 8,
      ended: true, unverified_end: false, available: true, truncated: false, read_at: LIST_READ_AT, complete: true,
    }]);
    expect(h.port.list).toHaveBeenCalledOnce();
    expect(h.port.list).toHaveBeenCalledWith(expect.objectContaining({ source: "confluence", date_field: "created", since: "2026-10-04", until: "2026-10-04", limit: 50 }));
    // The second step saw the list by id, with every member, and no inventories.
    const second = h.prompt(1);
    expect(second).not.toHaveProperty("inventories");
    expect(second.lists).toEqual([{
      id: "L1", args: { date_field: "created", source: "pages", since: "2026-10-04", until: "2026-10-04" }, members: MEMBERS, shown_count: 8,
      more: false, complete: true, available: true, truncated: false, unverified_end: false,
    }]);
    expect(second.last_results).toEqual([{ tool: "list", args: OCT4_LIST.args, list: "L1", items: MEMBERS, more: false }]);
    // The task-era coverage view is unchanged: the impact card renderer reads it.
    expect(view.coverage.inventories).toEqual([{ source: "pages", shown_count: 8, more: false, available: true, truncated: false }]);
  });

  it("answers the run's own second step, which cited the 8 rows, by asking for the list's id once", async () => {
    // Round 2 of the trace cited E1 to E8 and was refused; round 3 then cited 19 ids, cut to 12, and named 4 pages.
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
      ask(OCT4, OCT4_NEED, "found", MEMBERS, [finish], "N1", WI),
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], october4Desk());
    const view = await h.research.research({ trigger: "ask", brief: question(OCT4) });
    // A which_items need cites its list by id; the refusal names the list that holds the rows. L1 ended, so nothing asks to read on.
    expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining('need N1 "list of Confluence pages created on 2026-10-04" cites no list: cite the id of the list that holds its items (L1). ')]);
    expect(view.rounds[1]!.rejected[0]).not.toContain("keep reading");
    expect(h.prompt(2).validation_error).toContain("cite the id of the list that holds its items (L1)");
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.rounds).toHaveLength(2);
    expect(view.lists![0]).toMatchObject({ id: "L1", members: MEMBERS, complete: true });
  });

  it("stops at the next access check when a list member's access is revoked mid-request", async () => {
    let checks = 0;
    const revalidate = vi.fn(async () => {
      checks += 1;
      if (checks === 2) throw new AuthorityOperationError("unauthorized", "A listed page is no longer readable");
      return checked;
    });
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI),
    ], october4Desk({ revalidate }));
    await expect(h.research.research({ trigger: "ask", brief: question(OCT4) })).rejects.toMatchObject({ code: "unauthorized" });
    // The check before the second research call covers the rows the list released; no model sees them again.
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(h.audit).toEqual([]);
  });
});

describe("Ask research: reading a list to its end", () => {
  const TICKETS = "Which Jira tickets were created on October 4, 2026?";
  const TICKETS_NEED = "tickets created on 2026-10-04";
  const LIST = { tool: "list", args: { source: "tickets", date_field: "created", since: "2026-10-04", until: "2026-10-04" } } as const;

  it("refuses a finish on an unfinished list with \"keep reading the list\", then accepts it once read to its end", async () => {
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined
      ? result(tickets(1, 25), { next_cursor: "page-2", truncated: true, page_full: false })
      : result(tickets(26, 5), { page_full: false })) as EvidenceDeskResultV2);
    const h = harness([
      ask(TICKETS, TICKETS_NEED, "open", [], [LIST]),
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI),
      ask(TICKETS, TICKETS_NEED, "open", [], [LIST], "N1"),
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { live_sources: [JIRA], ticket_available: true, list });
    const view = await h.research.research({ trigger: "ask", brief: question(TICKETS) });
    expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining(
      'need N1 "tickets created on 2026-10-04": list L1 is unfinished: keep reading the list (repeat list with {"date_field":"created","source":"tickets","since":"2026-10-04","until":"2026-10-04"})')]);
    expect(h.prompt(1).lists).toEqual([expect.objectContaining({ id: "L1", members: tickets(1, 25).map((_, index) => `E${index + 1}`), more: true, complete: false, truncated: true })]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]![0]).toMatchObject({ cursor: "page-2" });
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", members: Array.from({ length: 30 }, (_, index) => `E${index + 1}`), shown: 30, ended: true, truncated: false, complete: true })]);
  });

  it("never trusts an exactly full last page: the list is cited for \"at least\" its count", async () => {
    const list = vi.fn(async () => result(tickets(1, 25), { page_full: true }) as EvidenceDeskResultV2);
    const h = harness([
      ask(TICKETS, TICKETS_NEED, "open", [], [LIST]),
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { live_sources: [JIRA], ticket_available: true, list });
    const view = await h.research.research({ trigger: "ask", brief: question(TICKETS) });
    // It cannot be read further, so the finish is accepted; it is not complete, so the answer can only say "at least 25".
    expect(h.generate).toHaveBeenCalledTimes(3);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(h.prompt(1).last_results).toEqual([expect.objectContaining({ list: "L1", more: false, note: "its last page was exactly full, so more items may exist than list can show; use search" })]);
    expect(h.prompt(1).lists).toEqual([expect.objectContaining({ id: "L1", more: false, complete: false, unverified_end: true })]);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", shown: 25, ended: true, unverified_end: true, complete: false })]);
  });

  it("counts only items no list had shown as progress, so re-listing the same tickets under new filters stops as no_progress", async () => {
    const launch = record("launch", "Approved: the THERM tickets track DVT.");
    const need = "every THERM ticket";
    const relist = (args: Record<string, string>) => ask("Which tickets track DVT?", need, "open", [], [{ tool: "list", args: { source: "tickets", ...args } }], "N1");
    const steps = [
      ask("Which tickets track DVT?", need, "open", [], [{ tool: "search", args: { query: "THERM DVT" } }]),
      relist({ date_field: "created", since: "2026-10-01" }), relist({ date_field: "updated", since: "2026-10-01" }),
      relist({ date_field: "created", since: "2026-09-01" }), relist({ date_field: "updated", since: "2026-09-01" }),
      ask("Which tickets track DVT?", need, "found", ["L1"], [finish], "N1", WI),
    ];
    const h = harness(input => input.system_prompt.startsWith("You write") ? useL1 : steps.shift(), {
      live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 3)) as EvidenceDeskResultV2), search: vi.fn(async () => result([launch])),
    });
    const view = await h.research.research({ trigger: "ask", brief: question("Which tickets track DVT?") });
    // The first list found three tickets; the next two lists found only those again, so research stopped.
    expect(view.stop).toEqual({ reason: "no_progress", completed: false });
    expect(view.rounds).toHaveLength(4);
    expect(view.lists!.map(list => list.members)).toEqual([["E2", "E3", "E4"], ["E2", "E3", "E4"], ["E2", "E3", "E4"]]);
  });

  it("never takes a list whose end is unverified as a completed list for not_found (addition 1)", async () => {
    const need = "a ticket about the fixture vendor";
    const run = async (page_full: boolean) => {
      // Research reads the list, opens one row, then says the fact is absent.
      const steps = [
        ask(TICKETS, need, "open", [], [LIST]), ask(TICKETS, need, "open", [], [{ tool: "open", args: { id: "E1" } }], "N1"),
        ask(TICKETS, need, "not_found", [], [finish], "N1"), ask(TICKETS, need, "not_found", [], [finish], "N1"),
      ];
      const open = vi.fn(async () => result([{ ...ticketRow(1), text: "THERM-1: Fixture work 1. Calibrate the probe." }]) as EvidenceDeskResultV2);
      const h = harness(input => input.system_prompt.startsWith("You write") ? { lists: [], sentences: [], not_found: [need] } : steps.shift(),
        { live_sources: [JIRA], ticket_available: true, open, list: vi.fn(async () => result(tickets(1, 25), { page_full }) as EvidenceDeskResultV2) });
      return h.research.research({ trigger: "ask", brief: question(TICKETS) });
    };
    // A list read to a confirmed end shows absence; an exactly full last page does not.
    expect((await run(false)).stop).toEqual({ reason: "finished", completed: true });
    const unverified = await run(true);
    expect(unverified.rounds[2]!.rejected).toEqual([expect.stringContaining(`need N1 "${need}" is not_found after fewer than two completed searches or a completed list`), expect.stringContaining("is not_found after fewer than two completed searches or a completed list")]);
    expect(unverified.stop).toEqual({ reason: "unusable_step", completed: false });
  });

  it("treats a page with as many rows as research asked for as full when the desk does not say", async () => {
    const meetings = Array.from({ length: 50 }, (_, index) => record(`action-${index + 1}`, `Action ${index + 1}.`, { kind: "action", attributes: { owner: "Dana Lee" } }));
    const list = vi.fn(async () => result(meetings) as EvidenceDeskResultV2);
    const h = harness([
      ask("Which actions does Dana own?", "actions owned by Dana", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Dana" } }]),
      ask("Which actions does Dana own?", "actions owned by Dana", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Dana" } }], "N1"),
      ask("Which actions does Dana own?", "actions owned by Dana", "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { list });
    const view = await h.research.research({ trigger: "ask", brief: question("Which actions does Dana own?") });
    expect(list).toHaveBeenCalledOnce();
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", source: "meetings", filter: { kind: "action", owner: "Dana", time_zone: "UTC" }, filter_applied: { owner: "applied" }, shown: 50, unverified_end: true, complete: false })]);
  });

  it("counts list pages as progress after text was read, so a long list is read to its end", async () => {
    const launch = record("launch", "Approved: the THERM tickets track DVT.");
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined
      ? result(tickets(1, 50), { next_cursor: "page-2", truncated: true, page_full: false })
      : result(tickets(51, 50), { page_full: false })) as EvidenceDeskResultV2);
    const LIST_ALL = { tool: "list", args: { source: "tickets" } } as const;
    const need = "every THERM ticket";
    const h = harness([
      ask("Which tickets track DVT?", need, "open", [], [{ tool: "search", args: { query: "THERM DVT" } }]),
      ...Array.from({ length: 4 }, () => ask("Which tickets track DVT?", need, "open", [], [LIST_ALL], "N1")),
      ask("Which tickets track DVT?", need, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { live_sources: [JIRA], ticket_available: true, list, search: vi.fn(async () => result([launch])) });
    const view = await h.research.research({ trigger: "ask", brief: question("Which tickets track DVT?") });
    // Before ADR-0041 the third list-only step after a read text stopped research as no_progress.
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.rounds).toHaveLength(6);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", shown: 100, ended: true, complete: true })]);
  });
});

describe("Ask research: filters are applied, refused or said, never silently widened", () => {
  it("records an owner filter tickets cannot apply as ignored, and tells the person", async () => {
    const list = vi.fn(async (_input: EvidenceDeskListInputV2) => result(tickets(1, 3)) as EvidenceDeskResultV2);
    const text = "Which tickets does Dana own?";
    const h = harness([
      ask(text, "Dana's tickets", "open", [], [{ tool: "list", args: { source: "tickets", owner: "Dana" } }]),
      ask(text, "Dana's tickets", "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { live_sources: [JIRA], ticket_available: true, list });
    const view = await h.research.research({ trigger: "ask", brief: question(text) });
    expect(list.mock.calls[0]![0]).not.toHaveProperty("owner");
    expect(h.prompt(1).last_results).toEqual([expect.objectContaining({ list: "L1", note: "owner applies to meeting actions only; ignored" })]);
    expect(h.prompt(1).lists).toEqual([expect.objectContaining({ id: "L1", notes: ["owner applies to meeting actions only; ignored"] })]);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter: { time_zone: "UTC" }, filter_applied: { owner: "ignored" }, complete: true })]);
    expect(view.coverage.notices).toEqual(["Jira tickets could not be filtered by owner, so this list is not limited to that owner."]);
  });

  it("says when meeting actions were filtered by status only where they record one", async () => {
    const actions = [
      record("a1", "Dana will publish the dashboard.", { kind: "action", attributes: { owner: "Dana Lee", status: "open" } }),
      record("a2", "Dana will order samples.", { kind: "action", attributes: { owner: "Dana Lee" } }),
      record("a3", "Dana closed the vendor review.", { kind: "action", attributes: { owner: "Dana Lee", status: "done" } }),
    ];
    const text = "Which actions are still open?";
    const h = harness([
      ask(text, "open actions", "open", [], [{ tool: "list", args: { source: "meetings", status: "open" } }]),
      ask(text, "open actions", "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { list: vi.fn(async () => result(actions) as EvidenceDeskResultV2) });
    const view = await h.research.research({ trigger: "ask", brief: question(text) });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter: { kind: "action", status: "open", time_zone: "UTC" }, filter_applied: { status: "partial" }, members: ["E1", "E2"], complete: true })]);
    expect(view.coverage.notices).toEqual(["Actions were filtered by status only where they record one, so this list also includes items that record none."]);
  });

  it("names no filter a found need does not rest on", async () => {
    const launch = record("launch", "Launch is Tuesday.");
    const h = harness([
      ask("When is launch?", "launch date", "open", [], [{ tool: "list", args: { source: "tickets", owner: "Dana" } }, { tool: "search", args: { query: "launch" } }]),
      ask("When is launch?", "launch date", "found", ["E4"], [finish], "N1"),
      { sentences: [{ text: "Launch is Tuesday.", evidence: ["E4"] }], not_found: [] },
    ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 3)) as EvidenceDeskResultV2), search: vi.fn(async () => result([launch])) });
    const view = await h.research.research({ trigger: "ask", brief: question("When is launch?") });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter_applied: { owner: "ignored" } })]);
    expect(view.coverage.notices).toEqual([]);
  });

  it("gives a list the source refused no id, and keeps the refusal for research to disclose", async () => {
    const list = vi.fn(async () => { throw new AuthorityOperationError("invalid_request", "This source supports date_field: created, updated"); });
    const text = "Which pages were due on October 4?";
    const h = harness([
      ask(text, "pages due on 2026-10-04", "open", [], [{ tool: "list", args: { source: "pages", date_field: "due", since: "2026-10-04", until: "2026-10-04" } }]),
      ask(text, "pages due on 2026-10-04", "not_found", [], [{ tool: "search", args: { source: "pages", query: "due" } }], "N1"),
      ask(text, "pages due on 2026-10-04", "not_found", [], [{ tool: "search", args: { source: "pages", query: "deadline" } }], "N1"),
      ask(text, "pages due on 2026-10-04", "not_found", [], [finish], "N1"),
    ], { live_sources: [CONFLUENCE], list });
    const view = await h.research.research({ trigger: "ask", brief: question(text) });
    expect(h.prompt(1).last_results).toEqual([expect.objectContaining({ tool: "list", error: "This source supports date_field: created, updated" })]);
    expect(h.prompt(1).lists).toEqual([]);
    expect(view.lists).toEqual([]);
  });
});

describe("Ask research: the same path for meetings and follow-ups", () => {
  it("finishes on a complete list of meeting actions", async () => {
    const actions = [
      record("a1", "Mara will publish the dashboard.", { kind: "action", attributes: { owner: "Mara Quinn", due_at: "2026-10-09" } }),
      record("a2", "Mara will review the PRD.", { kind: "action", attributes: { owner: "Mara Quinn" } }),
    ];
    const text = "Which actions does Mara own?";
    const h = harness([
      ask(text, "actions owned by Mara", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]),
      ask(text, "actions owned by Mara", "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { list: vi.fn(async () => result(actions) as EvidenceDeskResultV2) });
    const view = await h.research.research({ trigger: "ask", brief: question(text) });
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.rounds.map(round => round.rejected)).toEqual([[], []]);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", source: "meetings", members: ["E1", "E2"], filter_applied: { owner: "applied" }, complete: true })]);
  });

  it("finishes on a complete list of follow-ups the desk filtered by owner and status", async () => {
    const decision = { title: "THERM DVT recovery sync", first_line: "Ship fan curve v2 before DVT.", ref: `meeting:sha256:${"a".repeat(64)}` } as const;
    const followUp = (n: number): EvidenceDeskItemV2 => {
      const fields = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: `itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a1${n}`, kind: "ticket", title: `THERM-4${n} follow-up`, owner: "Mara Lind", status: "open", decision }));
      return Object.freeze({ id: `follow-up-${n}`, ...fields, visibility: "team" as const, receipt_sha256: canonicalSha256(`follow-up-${n}`) });
    };
    const items = [followUp(1), followUp(2)];
    const desk = {
      scope: { kind: "global" as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1],
      search: vi.fn(async () => result([]) as EvidenceDeskResultV2),
      list: vi.fn(async () => ({ ...result(items), page_full: false }) as EvidenceDeskResultV2),
      open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked),
    } satisfies EvidenceDeskPortV2;
    const inputs: StructuredGenerationInput[] = [];
    const text = "What are my open tasks?";
    const replies: unknown[] = [
      ask(text, "my open follow-ups", "open", [], [{ tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } }]),
      ask(text, "my open follow-ups", "found", ["L1"], [finish], "N1", WI),
      { lists: [{ id: "L1" }], sentences: [{ text: "Both are open.", evidence: ["E1", "E2"] }], not_found: [] },
    ];
    const response = await createAgenticAskV4({
      desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(LIST_READ_AT),
      model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift(); } },
    }).answer({ question: text });
    // Code names the list first; the writer's own sentence follows (ADR-0041).
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual(["2 follow-ups with owner Mara Lind and status open: THERM-41 follow-up; THERM-42 follow-up.", "Both are open."]);
    expect(response.citations.map(citation => citation.kind)).toEqual(["follow_up", "follow_up"]);
    expect(desk.list).toHaveBeenCalledWith(expect.objectContaining({ source: "follow_ups", owner: "Mara Lind", status: "open" }));
    const steps = inputs.filter(input => input.system_prompt.startsWith("You are Echo's research agent"));
    expect(steps).toHaveLength(2);
    expect(JSON.parse(steps[1]!.user_prompt).lists).toEqual([{
      id: "L1", args: { source: "follow_ups", status: "open", owner: "Mara Lind" }, members: ["E1", "E2"], shown_count: 2, more: false, complete: true,
      available: true, truncated: false, unverified_end: false,
    }]);
    expect(replies).toEqual([]);
  });

  it("asks a which_items need citing ten follow-up rows to cite their list and keep reading it, then names all 12", async () => {
    // A follow-up row always carries its text, so research reads it in full; the desk pages 10 at a time.
    const items = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1));
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined
      ? { ...result(items.slice(0, 10)), next_cursor: "page-2", page_full: false }
      : { ...result(items.slice(10)), page_full: false }) as EvidenceDeskResultV2);
    const desk = {
      scope: { kind: "global" as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1], list,
      search: vi.fn(async () => result([]) as EvidenceDeskResultV2), open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked),
    } satisfies EvidenceDeskPortV2;
    const inputs: StructuredGenerationInput[] = [];
    const text = "What are my open follow-ups?";
    const need = "my open follow-ups";
    const LIST = { tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } } as const;
    const replies: unknown[] = [
      ask(text, need, "open", [], [LIST]),
      ask(text, need, "found", Array.from({ length: 10 }, (_, index) => `E${index + 1}`), [finish], "N1", WI),
      ask(text, need, "open", [], [LIST], "N1"),
      ask(text, need, "found", ["L1"], [finish], "N1", WI),
      { lists: [], sentences: [{ text: "You have 12 open follow-ups.", evidence: Array.from({ length: 12 }, (_, index) => `E${index + 1}`) }], not_found: [] },
      { lists: [{ id: "L1" }], sentences: [], not_found: [] },
    ];
    const response = await createAgenticAskV4({
      desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(LIST_READ_AT),
      model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift(); } },
    }).answer({ question: text });
    const steps = inputs.filter(input => input.system_prompt.startsWith("You are Echo's research agent"));
    // One refusal says both: cite the list that holds the rows, and read it on, since it has a next page.
    expect(JSON.parse(steps[2]!.user_prompt).validation_error).toContain('need N1 "my open follow-ups" cites no list: cite the id of the list that holds its items (L1); part 1 need N1 "my open follow-ups": list L1 is unfinished: keep reading the list (repeat list with {"source":"follow_ups","status":"open","owner":"Mara Lind"})');
    expect(list).toHaveBeenCalledTimes(2);
    // The plan rests on the list, so the writer's count without it is sent back once.
    const writers = inputs.filter(input => input.system_prompt.startsWith("You write"));
    expect(writers).toHaveLength(2);
    expect(JSON.parse(writers[0]!.user_prompt).lists[0]).toMatchObject({ id: "L1", complete: true, count: 12, cited_by_plan: true });
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      `12 follow-ups with owner Mara Lind and status open: ${items.map(item => item.label).join("; ")}.`,
    ]);
    expect(replies).toEqual([]);
  });

  it("never takes the list's id beside its own follow-ups as using it: \"you have 10\" is sent back, then code names all 12", async () => {
    // A follow-up's row carries its text, so the writer has it; it is still one of the list's own rows, not content across it.
    const items = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1));
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined
      ? { ...result(items.slice(0, 10)), next_cursor: "page-2", page_full: false }
      : { ...result(items.slice(10)), page_full: false }) as EvidenceDeskResultV2);
    const desk = {
      scope: { kind: "global" as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1], list,
      search: vi.fn(async () => result([]) as EvidenceDeskResultV2), open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked),
    } satisfies EvidenceDeskPortV2;
    const inputs: StructuredGenerationInput[] = [];
    const text = "What are my open follow-ups?";
    const need = "my open follow-ups";
    const LIST = { tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } } as const;
    const count = { lists: [], sentences: [{ text: "You have 10 open follow-ups.", evidence: ["L1", ...Array.from({ length: 10 }, (_, index) => `E${index + 1}`)] }], not_found: [] };
    const replies: unknown[] = [ask(text, need, "open", [], [LIST]), ask(text, need, "open", [], [LIST], "N1"), ask(text, need, "found", ["L1"], [finish], "N1", WI), count, count];
    const response = await createAgenticAskV4({
      desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(LIST_READ_AT),
      model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift(); } },
    }).answer({ question: text });
    const writers = inputs.filter(input => input.system_prompt.startsWith("You write"));
    expect(writers).toHaveLength(2);
    expect(JSON.parse(writers[1]!.user_prompt).validation_error).toContain('research found this answer in list L1, which the answer does not use');
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      `12 follow-ups with owner Mara Lind and status open: ${items.map(item => item.label).join("; ")}.`,
    ]);
    expect(replies).toEqual([]);
  });
});

describe("Ask's answer: code names a list's members (ADR-0041)", () => {
  const OCT4_NAMES = OCTOBER_4.map(([, title]) => title);
  const writerInputs = (h: ReturnType<typeof harness>) => h.inputs.filter(input => input.system_prompt.startsWith("You write"));
  const writerPrompt = (h: ReturnType<typeof harness>, index = 0) => JSON.parse(writerInputs(h)[index]!.user_prompt) as Record<string, any>;
  const research = (writer: readonly unknown[], desk: Partial<EvidenceDeskPortV2> = october4Desk()) =>
    harness([ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]), ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI), ...writer], desk);
  const fullStatement = `8 Confluence pages created on October 4, 2026: ${OCT4_NAMES.join("; ")}.`;

  it("names all 8 October 4 pages, each citing its own row, from rows the writer saw without their text", async () => {
    const h = research([useL1]);
    const { response, writer_evidence } = await h.research.answerWithResearch({ question: OCT4 });
    expect(response).toMatchObject({ outcome: "answered", parts: [{ question: OCT4, status: "answered", statements: [{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }] }] });
    expect(response.parts[0]).not.toHaveProperty("gap");
    expect(response.citations.map(citation => citation.citation)).toEqual(PAGES.map(page => page.citation));
    expect(response).not.toHaveProperty("notice");
    // Two research steps and one writer call; the writer saw the list's rows and no text.
    expect(h.generate).toHaveBeenCalledTimes(3);
    const prompt = writerPrompt(h);
    expect(prompt.evidence).toEqual([]);
    expect(prompt.research).not.toHaveProperty("inventories");
    expect(prompt.lists).toEqual([{
      id: "L1", source: "pages", filter: { since: "2026-10-04", until: "2026-10-04", date_field: "created", time_zone: "UTC" }, filter_applied: { since: "applied", until: "applied", date_field: "applied" },
      complete: true, count: 8, checked: 0, read_at: LIST_READ_AT, cited_by_plan: true,
      members: MEMBERS.map((id, index) => ({ id, kind: "page", title: OCT4_NAMES[index], dates: PAGES[index]!.dates, date: PAGES[index]!.occurred_at, date_kind: "version_created", status: "current", checked: false })),
    }]);
    for (const page of PAGES) for (const hidden of [page.id, page.receipt_sha256, (page.citation as { permalink: string }).permalink]) expect(writerInputs(h)[0]!.user_prompt).not.toContain(hidden);
    expect(writer_evidence).toEqual(MEMBERS);
  });

  it("sends an answer that names 4 of the 8 pages back once, then writes the full list itself", async () => {
    const subset = { lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence: ["E1", "E2", "E3", "E4"] }], not_found: [] };
    const h = research([subset, subset]);
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(writerInputs(h)).toHaveLength(2);
    const repair = writerPrompt(h, 1);
    expect(repair.validation_error).toContain('research found this answer in list L1, which the answer does not use: put {"id": "L1"} in "lists" so code names its 8 members');
    expect(repair.rejected_response).toContain("The pages created on October 4 are");
    // The repaired reply still names 4: code writes all 8 and drops the sentence that restated part of the list.
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements).toEqual([{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }]);
  });

  it("sends back 4 rows cited beside the list's id and one opened section, then writes the full list itself", async () => {
    // Research opened E1 (its section is E9); the sentence still names E2 to E4 by their rows alone.
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "Start here.")]) as EvidenceDeskResultV2);
    const subset = { lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence: ["L1", "E1", "E2", "E3", "E4", "E9"] }], not_found: [] };
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
      ask(OCT4, OCT4_NEED, "open", [], [{ tool: "open", args: { id: "E1" } }], "N1"),
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI),
      subset, subset,
    ], october4Desk({ open }));
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(writerInputs(h)).toHaveLength(2);
    expect(writerPrompt(h, 1).validation_error).toContain('research found this answer in list L1, which the answer does not use: put {"id": "L1"} in "lists" so code names its 8 members');
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements).toEqual([{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }]);
  });

  it("accepts the repaired answer that uses the list", async () => {
    const subset = { sentences: [{ text: "Four pages were created.", evidence: ["E1", "E2", "E3", "E4"] }], not_found: [] };
    const h = research([subset, useL1]);
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(h.generate).toHaveBeenCalledTimes(4);
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement]);
  });

  it("never answers what a listed page says from its row: \"Is DVT on hold?\" ends partial or not found, never answered", async () => {
    // E3's title reads "Gate reviews — EVT pass, DVT hold, PVT pending", but research never opened it.
    const text = "Is DVT on hold?";
    const need = "whether DVT is on hold";
    const claim = (evidence: readonly string[], lists: readonly unknown[] = []) => ({ lists, sentences: [{ text: "Yes, DVT is on hold, and EVT passed.", evidence }], not_found: [] });
    const run = async (replies: readonly unknown[]) => {
      const h = harness([ask(text, need, "open", [], [OCT4_LIST]), ask(text, need, "found", ["L1"], [finish], "N1", WI), ...replies], october4Desk());
      return { h, ...(await h.research.answerWithResearch({ question: text })) };
    };
    // With the list in "lists"; citing the row beside the list's id; and a repair that moves the list into "lists".
    for (const replies of [
      [claim(["E3"], [{ id: "L1" }]), claim(["E3"], [{ id: "L1" }])],
      [claim(["E3", "L1"]), claim(["E3", "L1"])],
      [claim(["E3"]), claim(["E3"], [{ id: "L1" }])],
    ]) {
      const { h, response } = await run(replies);
      expect(writerInputs(h)).toHaveLength(2);
      expect(writerPrompt(h, 1).validation_error).toContain('a sentence cites only list rows or list ids, never text');
      // The claim is left out; code's list is all that stands, and the part says what was not found.
      expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Not found: what the listed items say, since they were listed but not opened." }] });
      expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement]);
    }
    // A writer that says it found nothing goes back once, since research found the need on the list; repeated, it is
    // honored, and code names no list it did not use.
    const nothing = { lists: [], sentences: [], not_found: ["whether DVT is on hold"] };
    const { h, response } = await run([nothing, nothing]);
    expect(writerInputs(h)).toHaveLength(2);
    expect(writerPrompt(h, 1).validation_error).toContain('research found this answer in list L1, which the answer does not use: put {"id": "L1"} in "lists" so code names its 8 members; keep "not_found" only if that list does not answer the question');
    expect(response).toMatchObject({ outcome: "not_found", citations: [], parts: [{ status: "not_found", statements: [], gap: "Not found: whether DVT is on hold." }] });
  });

  it("sends a reply that found nothing back once when research found the answer in a list: the October 4 question gets its list", async () => {
    const nothing = { lists: [], sentences: [], not_found: ["Confluence pages created on October 4, 2026"] };
    const repaired = research([nothing, useL1]);
    const { response } = await repaired.research.answerWithResearch({ question: OCT4 });
    expect(writerInputs(repaired)).toHaveLength(2);
    expect(writerPrompt(repaired, 1).validation_error).toContain('put {"id": "L1"} in "lists" so code names its 8 members; keep "not_found" only if that list does not answer the question');
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7] }] }] });
    // A writer that repeats it after the repair is honored.
    const repeated = research([nothing, nothing]);
    expect((await repeated.research.answerWithResearch({ question: OCT4 })).response).toMatchObject({ outcome: "not_found", parts: [{ status: "not_found", statements: [] }] });
    expect(writerInputs(repeated)).toHaveLength(2);
  });

  it("writes a list in full beside a selection of its members by id, in either order, and never takes part of it selected by id for the list", async () => {
    const text = "Which Confluence pages were created on October 4, 2026, and when was the PRD last updated?";
    const run = (writer: readonly unknown[]) => harness([ask(text, OCT4_NEED, "open", [], [OCT4_LIST]), ask(text, OCT4_NEED, "found", ["L1"], [finish], "N1", WI), ...writer], october4Desk());
    const facts = (title: string, updated = "October 4, 2026") => `${title} (status current, created October 4, 2026, updated ${updated})`;
    const prd = `1 of the 8 Confluence pages created on October 4, 2026: ${facts(OCT4_NAMES[4]!)}.`;
    for (const [lists, said] of [
      [[{ id: "L1", members: ["E5"] }, { id: "L1" }], [prd, fullStatement]],
      [[{ id: "L1" }, { id: "L1", members: ["E5"] }], [fullStatement, prd]],
    ] as const) {
      const h = run([{ lists, sentences: [], not_found: [] }]);
      const { response } = await h.research.answerWithResearch({ question: text });
      expect(writerInputs(h)).toHaveLength(1);
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
      expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual(said);
      // The PRD's row is cited once, by both statements.
      expect(response.citations).toHaveLength(8);
    }
    // Four pages selected by id answer "which" with part of the list: sent back once, then code writes the list before them.
    const four = { lists: [{ id: "L1", members: ["E1", "E2", "E3", "E4"] }], sentences: [], not_found: [] };
    const h = run([four, four]);
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(writerInputs(h)).toHaveLength(2);
    expect(writerPrompt(h, 1).validation_error).toContain('research found this answer in list L1, which the answer uses only to select some of its members by id: put {"id": "L1"} in "lists" too so code names its 8 members');
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      fullStatement, `4 of the 8 Confluence pages created on October 4, 2026: ${[facts(OCT4_NAMES[0]!, "October 5, 2026"), ...OCT4_NAMES.slice(1, 4).map(title => facts(title))].join("; ")}.`,
    ]);
  });

  it("leaves out a sentence citing only the id of a list code names, with no repair and no not-found phrase", async () => {
    // Its filter and count are what code's own statement says, and it cites no member's row, which might read like content.
    const summary = { text: "All eight pages were created on October 4, 2026.", evidence: ["L1"] };
    const used = research([{ lists: [{ id: "L1" }], sentences: [summary], not_found: [] }]);
    const { response } = await used.research.answerWithResearch({ question: OCT4 });
    expect(writerInputs(used)).toHaveLength(1);
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: fullStatement }] }] });
    expect(response.parts[0]).not.toHaveProperty("gap");
    expect(response.parts[0]!.statements).toHaveLength(1);
    // Without the list in "lists", only the list goes back; then code writes it, and the sentence is left out the same way.
    const unused = { lists: [], sentences: [summary], not_found: [] };
    const forced = research([unused, unused]);
    const written = (await forced.research.answerWithResearch({ question: OCT4 })).response;
    expect(writerInputs(forced)).toHaveLength(2);
    expect(writerPrompt(forced, 1).validation_error).toContain("research found this answer in list L1, which the answer does not use");
    expect(writerPrompt(forced, 1).validation_error).not.toContain("a sentence cites only list rows or list ids");
    expect(written).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: fullStatement }] }] });
    expect(written.parts[0]).not.toHaveProperty("gap");
  });

  it("writes the list itself when the writer gives no usable reply", async () => {
    const h = research([{ wrong: true }, { still: "wrong" }]);
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: fullStatement }], gap: "I found these items, but could not write the rest of the answer." }] });
    expect(response.parts[0]).not.toHaveProperty("records");
  });

  const TICKETS = "Which Jira tickets were created on October 4, 2026?";
  const TICKETS_NEED = "tickets created on 2026-10-04";
  const TICKETS_LIST = { tool: "list", args: { source: "tickets", date_field: "created", since: "2026-10-04", until: "2026-10-04" } } as const;
  const ticketNames = (from: number, count: number) => tickets(from, count).map(item => item.label);

  it("names 25 of a 60-ticket list and says 'and 35 more', the count from ECHO's own list", async () => {
    const list = vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined
      ? result(tickets(1, 50), { next_cursor: "page-2", page_full: false })
      : result(tickets(51, 10), { page_full: false })) as EvidenceDeskResultV2);
    const h = harness([
      ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST]),
      ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST], "N1"),
      ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST], "N1"),
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { live_sources: [JIRA], ticket_available: true, list });
    const { response, research: view } = await h.research.answerWithResearch({ question: TICKETS });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", members: Array.from({ length: 60 }, (_, index) => `E${index + 1}`), complete: true })]);
    expect(writerPrompt(h).lists[0]).toMatchObject({ count: 60, complete: true });
    expect(writerPrompt(h).lists[0].members).toHaveLength(60);
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements).toEqual([{
      text: `60 Jira tickets created on October 4, 2026: ${ticketNames(1, 25).join("; ")}; and 35 more.`, citation_indexes: Array.from({ length: 25 }, (_, index) => index), private: true,
    }]);
    expect(response.citations.map(citation => citation.label)).toEqual(ticketNames(1, 25));
  });

  it("says 'at least' for a list whose end could not be confirmed, and marks the part partial", async () => {
    const h = harness([
      ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST]),
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 25), { page_full: true }) as EvidenceDeskResultV2) });
    const { response } = await h.research.answerWithResearch({ question: TICKETS });
    expect(writerPrompt(h).lists[0]).toMatchObject({ complete: false, count: 25 });
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "The list of Jira tickets could not be read to its end, so more may exist." }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([`At least 25 Jira tickets created on October 4, 2026: ${ticketNames(1, 25).join("; ")}.`]);
  });

  it("answers 'which are assigned to me' with only the members that owner records, and none as not found", async () => {
    const assigned = [ticketRow(1, "Zhen Ye"), ticketRow(2, "Dana Lee", "Done"), ticketRow(3, "zhen ye"), ticketRow(4, "Tobias Lund")];
    const text = "Which of the Jira tickets created on October 4, 2026 are assigned to Zhen Ye?";
    const run = async (value: string) => {
      const h = harness([
        ask(text, TICKETS_NEED, "open", [], [TICKETS_LIST]),
        ask(text, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI),
        { lists: [{ id: "L1", where: { field: "owner", value } }], sentences: [], not_found: [] },
      ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(assigned) as EvidenceDeskResultV2) });
      return (await h.research.answerWithResearch({ question: text })).response;
    };
    const mine = await run("ZHEN YE");
    expect(mine.outcome).toBe("answered");
    expect(mine.parts[0]!.statements).toEqual([{ text: "2 of the 4 Jira tickets created on October 4, 2026 have owner Zhen Ye: THERM-1: Fixture work 1; THERM-3: Fixture work 3.", citation_indexes: [0, 1], private: true }]);
    expect(mine.citations.map(citation => citation.label)).toEqual(["THERM-1: Fixture work 1", "THERM-3: Fixture work 3"]);
    const nobody = await run("Mara Quinn");
    expect(nobody).toMatchObject({ outcome: "not_found", citations: [], parts: [{ status: "not_found", statements: [], gap: "Not found: Jira tickets created on October 4, 2026 that have owner Mara Quinn." }] });
  });

  it("checks an answer that names 4 pages by their opened sections, not their rows: code names all 8", async () => {
    // The sections are new items, so before this the plan and the writer could cite them as if they were no member.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, `${row.label}: created October 4.`)]) as EvidenceDeskResultV2;
    });
    const sections = ["E9", "E10", "E11", "E12"];
    const subset = { lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence: sections }], not_found: [] };
    for (const plan of [sections, ["L1", ...sections]]) {
      // A which_items finish on the sections alone is refused once, naming the list whose members they belong to.
      const h = harness([
        ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
        ask(OCT4, OCT4_NEED, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
        ask(OCT4, OCT4_NEED, "found", plan, [finish], "N1", WI),
        ...(plan[0] === "L1" ? [] : [ask(OCT4, OCT4_NEED, "found", ["L1", ...sections], [finish], "N1", WI)]),
        subset, subset,
      ], october4Desk({ open }));
      const { response, research: view } = await h.research.answerWithResearch({ question: OCT4 });
      expect(view.rounds.at(-1)!.rejected).toEqual(plan[0] === "L1" ? [] : [expect.stringContaining("cites no list: cite the id of the list that holds its items (L1). ")]);
      expect(writerInputs(h)).toHaveLength(2);
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 4, cited_by_plan: true });
      // A which_items need claims nothing about what its members say, so the repair offers no way to say it.
      expect(writerPrompt(h, 1).validation_error).toContain('research found this answer in list L1, which the answer does not use: put {"id": "L1"} in "lists" so code names its 8 members');
      expect(writerPrompt(h, 1).validation_error).not.toContain("for what its members say");
      // Code names all 8. The sentence cites only members, four by their sections, and not the list's id, so it restated
      // part of the list: it is dropped, and the list answers which pages exist in full.
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
      expect(response.parts[0]!.statements).toEqual([{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }]);
    }
  });

  it("never takes the list's id beside four opened sections as using a list research found which pages exist in", async () => {
    // The plan found the need on L1 alone, so nothing claims content across it: only "lists" uses it, however many
    // pages research opened on the way.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, `${row.label}: created October 4.`)]) as EvidenceDeskResultV2;
    });
    const subset = { lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence: ["L1", "E9", "E10", "E11", "E12"] }], not_found: [] };
    for (const opened of [MEMBERS.slice(0, 4), MEMBERS]) {
      const rounds = [opened.slice(0, 4), opened.slice(4)].filter(ids => ids.length > 0);
      const h = harness([
        ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
        ...rounds.map(ids => ask(OCT4, OCT4_NEED, "open", [], ids.map(id => ({ tool: "open", args: { id } })), "N1")),
        ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI),
        subset, subset,
      ], october4Desk({ open }));
      const { response } = await h.research.answerWithResearch({ question: OCT4 });
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: opened.length, cited_by_plan: true });
      expect(writerInputs(h)).toHaveLength(2);
      expect(writerPrompt(h, 1).validation_error).toContain('research found this answer in list L1, which the answer does not use: put {"id": "L1"} in "lists" so code names its 8 members');
      // Code names all 8, and the sentence that named 4 of them is dropped.
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
      expect(response.parts[0]!.statements).toEqual([{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }]);
    }
  });

  it("checks the held trace's own finish on rows and sections the same way for tickets, which keep their row ids when opened", async () => {
    // Round 4 of trace ee2f0973 cited the rows and the opened bodies; a Jira open returns the body under the row's id.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const n = Number(/THERM-(\d+)/u.exec(input.item)![1]);
      return result([ticketBody(n, `THERM-${n}: created October 4 for fixture work.`)]) as EvidenceDeskResultV2;
    });
    const subset = { lists: [], sentences: [{ text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["E1", "E2", "E3", "E4"] }], not_found: [] };
    const h = harness([
      ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST]),
      ask(TICKETS, TICKETS_NEED, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
      ask(TICKETS, TICKETS_NEED, "found", Array.from({ length: 12 }, (_, index) => `E${index + 1}`), [finish], "N1", WI),
      ask(TICKETS, TICKETS_NEED, "found", ["L1", ...Array.from({ length: 12 }, (_, index) => `E${index + 1}`)], [finish], "N1", WI),
      subset, subset,
    ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 12), { page_full: false }) as EvidenceDeskResultV2), open });
    const { response, research: view } = await h.research.answerWithResearch({ question: TICKETS });
    // The finish on rows and bodies alone is refused once, naming their list; the repair cites it.
    expect(view.rounds.at(-1)!.rejected).toEqual([expect.stringContaining("cites no list: cite the id of the list that holds its items (L1). ")]);
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 12, checked: 4, complete: true, cited_by_plan: true });
    expect(writerInputs(h)).toHaveLength(2);
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([`12 Jira tickets created on October 4, 2026: ${ticketNames(1, 12).join("; ")}.`]);
  });

  it("answers what one listed page says from its row and opened section: no list is forced in", async () => {
    // Research cites the gate review's row beside the section its clean open returned: content about that page.
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "DVT is on hold pending fixture rework.")]) as EvidenceDeskResultV2);
    const text = "What does the gate review page created on October 4 say about DVT?";
    const need = "what the gate review page says about DVT";
    const reply = { lists: [], sentences: [{ text: "The gate review says DVT is on hold pending fixture rework.", evidence: ["E9"] }], not_found: [] };
    const h = harness([
      ask(text, need, "open", [], [OCT4_LIST]),
      ask(text, need, "open", [], [{ tool: "open", args: { id: "E3" } }], "N1"),
      ask(text, need, "found", ["E3", "E9"], [finish], "N1"),
      reply,
    ], october4Desk({ open }));
    const { response, research: view } = await h.research.answerWithResearch({ question: text });
    expect(view.rounds.map(round => round.rejected)).toEqual([[], [], []]);
    expect(writerInputs(h)).toHaveLength(1);
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", cited_by_plan: false, checked: 1 });
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: "The gate review says DVT is on hold pending fixture rework.", citation_indexes: [0] }] }] });
  });

  it("accepts a finish on an opened page's row and section while that page's list is unfinished", async () => {
    // The list has a next page; opening the PRD's row (E5) returned two sections as new items.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, "Readings within 0.1 C."), { ...section(row, "Probe at 37 C."), id: row.id.replace("inventory", "s2"), citation: { ...(section(row, "x").citation as object), section_id: "s2", text_sha256: sha256Digest("Probe at 37 C.") } } as EvidenceDeskItemV2]) as EvidenceDeskResultV2;
    });
    const list = vi.fn(async () => result(PAGES, { next_cursor: "page-2", page_full: false }) as EvidenceDeskResultV2);
    const text = "What accuracy does the PRD require?";
    const need = "the PRD's accuracy requirement";
    const h = harness([
      ask(text, need, "open", [], [{ tool: "list", args: { source: "pages" } }]),
      ask(text, need, "open", [], [{ tool: "open", args: { id: "E5" } }], "N1"),
      ask(text, need, "found", ["E5", "E9"], [finish], "N1"),
      { lists: [], sentences: [{ text: "The PRD requires readings within 0.1 C.", evidence: ["E9"] }], not_found: [] },
    ], { live_sources: [CONFLUENCE], list, open });
    const { response, research: view } = await h.research.answerWithResearch({ question: text });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", ended: false })]);
    expect(view.rounds.map(round => round.rejected)).toEqual([[], [], []]);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(list).toHaveBeenCalledOnce();
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual(["The PRD requires readings within 0.1 C."]);
  });

  it("asks the October 4 shape for its list once: four opened rows and their sections beside four rows never opened", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, `${row.label}: created October 4.`)]) as EvidenceDeskResultV2;
    });
    const subset = { lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence: ["E1", "E2", "E3", "E4"] }], not_found: [] };
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
      ask(OCT4, OCT4_NEED, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
      ask(OCT4, OCT4_NEED, "found", Array.from({ length: 12 }, (_, index) => `E${index + 1}`), [finish], "N1", WI),
      ask(OCT4, OCT4_NEED, "found", ["L1", ...Array.from({ length: 12 }, (_, index) => `E${index + 1}`)], [finish], "N1", WI),
      subset, subset,
    ], october4Desk({ open }));
    const { response, research: view } = await h.research.answerWithResearch({ question: OCT4 });
    expect(view.rounds.at(-1)!.rejected).toEqual([expect.stringContaining("cites no list: cite the id of the list that holds its items (L1). ")]);
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", cited_by_plan: true, checked: 4 });
    expect(writerInputs(h)).toHaveLength(2);
    expect(response.parts[0]!.statements).toEqual([{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }]);
  });

  it("says how many members were checked when a sentence claims content across a list (addition 4)", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, row.label.startsWith("Traceability") ? "BUG-412 is traced to TC-D-03." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages created on October 4, 2026 mention BUG-412?";
    const need = "pages created on 2026-10-04 that mention BUG-412";
    const h = harness([
      ask(text, need, "open", [], [OCT4_LIST]),
      ask(text, need, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
      ask(text, need, "found", ["L1", "E12"], [finish], "N1", WS),
      { lists: [], sentences: [{ text: "Traceability — requirement threads and BUG-412 walkthrough mentions BUG-412.", evidence: ["L1", "E12"] }], not_found: [] },
    ], october4Desk({ open }));
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(open).toHaveBeenCalledTimes(4);
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 4, cited_by_plan: true });
    expect(writerPrompt(h).lists[0].members.map((member: { checked: boolean }) => member.checked)).toEqual([true, true, true, true, false, false, false, false]);
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Not every listed item was checked, so others may also match." }] });
    expect(response.parts[0]!.statements).toEqual([{ text: "Traceability — requirement threads and BUG-412 walkthrough mentions BUG-412 (4 of 8 checked so far).", citation_indexes: [0], private: true }]);
    expect(response.citations.map(citation => (citation.citation as { section_id: string }).section_id)).toEqual(["s1"]);
  });

  it("says how many were checked whenever a sentence answers across a list, however the list reaches the answer (addition 4)", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, /^(Traceability|Gate reviews)/u.test(row.label) ? "BUG-412 is traced to TC-D-03." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages created on October 4, 2026 mention BUG-412?";
    const need = "pages created on 2026-10-04 that mention BUG-412";
    const one = "Traceability — requirement threads and BUG-412 walkthrough mentions BUG-412.";
    const two = "Gate reviews and Traceability mention BUG-412.";
    const four = "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.";
    const say = (sentence: string, evidence: readonly string[], lists: readonly unknown[] = []) => ({ lists, sentences: [{ text: sentence, evidence }], not_found: [] });
    const noted = (sentence: string) => sentence.replace(/\.$/u, " (4 of 8 checked so far).");
    const cases: readonly { readonly plan: readonly string[]; readonly replies: readonly unknown[]; readonly calls: number; readonly said: string }[] = [
      // The repair moves the list into "lists", or no repair helps and code writes it; the sentence cites only a section.
      { plan: ["L1", "E12"], replies: [say(one, ["E12"]), say(one, ["E12"], [{ id: "L1" }])], calls: 2, said: one },
      { plan: ["L1", "E12"], replies: [say(one, ["E12"]), say(one, ["E12"])], calls: 2, said: one },
      // A section beside its own page's row, with the list in "lists".
      { plan: ["L1", "E12"], replies: [say(one, ["E12", "E4"], [{ id: "L1" }])], calls: 1, said: one },
      { plan: ["L1", "E9", "E10", "E11", "E12"], replies: [say(two, ["E11", "E12"], [{ id: "L1" }])], calls: 1, said: two },
      // The October 4 subset beside the list it names: code cannot tell it from content, so it is noted, never answered.
      { plan: ["L1", "E9", "E10", "E11", "E12"], replies: [say(four, ["E9", "E10", "E11", "E12"], [{ id: "L1" }])], calls: 1, said: four },
    ];
    for (const { plan, replies, calls, said } of cases) {
      const h = harness([
        ask(text, need, "open", [], [OCT4_LIST]),
        ask(text, need, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
        ask(text, need, "found", plan, [finish], "N1", WS),
        ...replies,
      ], october4Desk({ open }));
      const { response } = await h.research.answerWithResearch({ question: text });
      expect(writerInputs(h)).toHaveLength(calls);
      if (calls === 2) expect(writerPrompt(h, 1).validation_error).toContain('put {"id": "L1"} in "lists" so code names its 8 members; for what its members say, cite L1 beside their evidence');
      expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Not every listed item was checked, so others may also match." }] });
      expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement, noted(said)]);
    }
    // Two pages' sections, with the plan on the list or on those sections only. Without the list's id the sentence
    // cites only members, which code cannot tell from a restated subset: the repair asks for the id, and a writer that
    // gives it says what those two say, noted. One that never does has its sentence replaced by code's list.
    // A which_say finish on those sections alone is refused once, naming their list; its repair cites it.
    for (const plan of [["L1", "E11", "E12"], ["E11", "E12"]]) {
      const run = async (replies: readonly unknown[]) => {
        const h = harness([
          ask(text, need, "open", [], [OCT4_LIST]),
          ask(text, need, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
          ask(text, need, "found", plan, [finish], "N1", WS),
          ...(plan[0] === "L1" ? [] : [ask(text, need, "found", ["L1", ...plan], [finish], "N1", WS)]),
          ...replies,
        ], october4Desk({ open }));
        return { h, response: (await h.research.answerWithResearch({ question: text })).response };
      };
      const cited = await run([say(two, ["E11", "E12"]), say(two, ["L1", "E11", "E12"])]);
      expect(writerInputs(cited.h)).toHaveLength(2);
      expect(writerPrompt(cited.h, 1).validation_error).toContain("for what its members say, cite L1 beside their evidence");
      expect(cited.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Not every listed item was checked, so others may also match." }] });
      expect(cited.response.parts[0]!.statements.map(statement => statement.text)).toEqual([noted(two)]);
      const ignored = await run([say(two, ["E11", "E12"]), say(two, ["E11", "E12"])]);
      expect(ignored.response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement]);
    }
    // One page's section, on a plan that rests on it alone, is content about that page: no list, no note.
    const single = harness([
      ask(text, need, "open", [], [OCT4_LIST]),
      ask(text, need, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
      ask(text, need, "found", ["E12"], [finish], "N1"),
      say(one, ["E12"]),
    ], october4Desk({ open }));
    const { response } = await single.research.answerWithResearch({ question: text });
    expect(writerInputs(single)).toHaveLength(1);
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: one }] }] });
  });

  it("names only items released to the asker, counts ECHO's own list, and stops when access is revoked before the writer", async () => {
    // A vendor's total is never read: the count is the members the desk released to this person.
    const released = [ticketRow(1), { ...ticketRow(2), visibility: "team" as const }, ticketRow(3)];
    const list = vi.fn(async () => ({ ...result(released), total: 500 }) as unknown as EvidenceDeskResultV2);
    const replies = [ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST]), ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI), useL1];
    const h = harness(replies, { live_sources: [JIRA], ticket_available: true, list });
    const { response } = await h.research.answerWithResearch({ question: TICKETS });
    expect(response.parts[0]!.statements).toEqual([{ text: `3 Jira tickets created on October 4, 2026: ${released.map(item => item.label).join("; ")}.`, citation_indexes: [0, 1, 2], private: true }]);
    expect(response.citations.map(citation => citation.visibility)).toEqual(["only_me", "team", "only_me"]);
    expect(writerInputs(h)[0]!.user_prompt).not.toContain("500");
    let checks = 0;
    const revalidate = vi.fn(async () => {
      checks += 1;
      if (checks === 3) throw new AuthorityOperationError("unauthorized", "A listed ticket is no longer readable");
      return checked;
    });
    const revoked = harness(replies, { live_sources: [JIRA], ticket_available: true, list, revalidate });
    await expect(revoked.research.answerWithResearch({ question: TICKETS })).rejects.toMatchObject({ code: "unauthorized" });
    // The check before the writer covers the rows the list released: no writer call names them.
    expect(revoked.generate).toHaveBeenCalledTimes(2);
  });

  it("checks a meeting-action list whose members research opened and cited: code names all 8, not the 4 opened", async () => {
    // A list row has no text; opening it returns the same item with its text, so research reads the member in full.
    const action = { kind: "action" as const, attributes: { owner: "Mara Quinn" } };
    const rows = Array.from({ length: 8 }, (_, index) => listed(`a${index + 1}`, action));
    const bodies = new Map(rows.map((row, index) => [row.id, record(`a${index + 1}`, `Mara will do task ${index + 1}.`, action)]));
    const open = vi.fn(async (input: { readonly item: string }) => result([bodies.get(input.item)!]) as EvidenceDeskResultV2);
    const opened = ["E1", "E2", "E3", "E4"];
    // Research declares what the question asks: which actions Mara owns (a list answers it), or which of them say something.
    const run = async (text: string, kind: string, plan: readonly string[], evidence: readonly string[]) => {
      const subset = { lists: [], sentences: [{ text: "Mara owns tasks 1, 2, 3 and 4.", evidence }], not_found: [] };
      const h = harness([
        ask(text, "actions owned by Mara", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]),
        ask(text, "actions owned by Mara", "open", [], opened.map(id => ({ tool: "open", args: { id } })), "N1"),
        ask(text, "actions owned by Mara", "found", plan, [finish], "N1", kind),
        subset, subset,
      ], { list: vi.fn(async () => result(rows) as EvidenceDeskResultV2), open });
      const { response, research: view } = await h.research.answerWithResearch({ question: text });
      expect(view.items.filter(item => item.read_in_full).map(item => item.id)).toEqual(opened);
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", complete: true, count: 8, checked: 4, cited_by_plan: true });
      return { h, response };
    };
    // An opened meeting record keeps its row's id: four of them without the list name 4 of 8.
    const { h, response } = await run("Which actions does Mara own?", WI, ["L1"], opened);
    expect(writerInputs(h)).toHaveLength(2);
    // Code names all 8, and the sentence that restated 4 of them is dropped.
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([`8 actions with owner Mara: ${rows.map(row => row.label).join("; ")}.`]);
    // A which_say need checks the list, so the list's id beside their text says what those 4 say: it uses the list, as
    // an opened page's sections would, and the note keeps it from reading as complete.
    const across = await run("Which of Mara's actions name a numbered task?", WS, ["L1", ...opened], ["L1", ...opened]);
    expect(writerInputs(across.h)).toHaveLength(1);
    expect(across.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Not every listed item was checked, so others may also match." }] });
    expect(across.response.parts[0]!.statements.map(statement => statement.text)).toEqual(["Mara owns tasks 1, 2, 3 and 4 (4 of 8 checked so far)."]);
  });

  it("answers which pages mention BUG-412 once every page was checked: the sentence stands, with no note and no list", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, /^(Traceability|Gate reviews)/u.test(row.label) ? "BUG-412 is traced to TC-D-03." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages created on October 4, 2026 mention BUG-412?";
    const need = "pages created on 2026-10-04 that mention BUG-412";
    const two = "Gate reviews and Traceability mention BUG-412.";
    const say = (evidence: readonly string[]) => ({ lists: [], sentences: [{ text: two, evidence }], not_found: [] });
    // Opening E1..E8 releases sections E9..E16: Gate reviews is E11, Traceability E12.
    for (const [plan, replies, calls] of [
      [["L1", "E11", "E12"], [say(["L1", "E11", "E12"])], 1],
      [["L1", "E11", "E12"], [say(["E11", "E12"]), say(["L1", "E11", "E12"])], 2],
      [["E11", "E12"], [say(["E11", "E12"]), say(["L1", "E11", "E12"])], 2],
    ] as const) {
      // A which_say need cites the list it checks; the same sections declared content give the same answer.
      const kind = plan[0] === "L1" ? WS : "content";
      const h = harness([
        ask(text, need, "open", [], [OCT4_LIST]),
        ask(text, need, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
        ask(text, need, "open", [], ["E5", "E6", "E7", "E8"].map(id => ({ tool: "open", args: { id } })), "N1"),
        ask(text, need, "found", plan, [finish], "N1", kind),
        ...replies,
      ], october4Desk({ open }));
      const { response } = await h.research.answerWithResearch({ question: text });
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 8, complete: true, cited_by_plan: kind === WS });
      expect(writerInputs(h)).toHaveLength(calls);
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: two, citation_indexes: [0, 1] }] }] });
      expect(response.parts[0]!.statements).toHaveLength(1);
    }
  });

  it("keeps a sentence citing the list's id beside what its members say when another sentence makes code write the list", async () => {
    // Every page opened; the second sentence names two pages by their rows alone, so code writes the list.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, /^(Traceability|Gate reviews)/u.test(row.label) ? "BUG-412 is traced to TC-D-03." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages created on October 4, 2026 mention BUG-412?";
    const need = "pages created on 2026-10-04 that mention BUG-412";
    const reply = { lists: [], sentences: [
      { text: "Gate reviews and Traceability mention BUG-412.", evidence: ["L1", "E11", "E12"] },
      { text: "The PRD and the verification plan were also created that day.", evidence: ["E5", "E6"] },
    ], not_found: [] };
    const h = harness([
      ask(text, need, "open", [], [OCT4_LIST]),
      ask(text, need, "open", [], ["E1", "E2", "E3", "E4"].map(id => ({ tool: "open", args: { id } })), "N1"),
      ask(text, need, "open", [], ["E5", "E6", "E7", "E8"].map(id => ({ tool: "open", args: { id } })), "N1"),
      ask(text, need, "found", ["L1", "E11", "E12"], [finish], "N1", WS),
      reply, reply,
    ], october4Desk({ open }));
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 8, cited_by_plan: true });
    expect(writerInputs(h)).toHaveLength(2);
    // Every member was checked, so the content needs no note; the rows sentence is replaced by code's list.
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement, "Gate reviews and Traceability mention BUG-412."]);
  });

  it("reads a content need's list id as nothing: a one-ticket answer beside its list adds no note", async () => {
    // "When is THERM-3 due?" is a fact about one item: content, whose list ids carry no meaning (round-2 finding 11).
    // Only a which_say need's list gets the checked note.
    const open = vi.fn(async () => result([ticketBody(3, "THERM-3 is due October 9, 2026.")]) as EvidenceDeskResultV2);
    const text = "When is THERM-3 due?";
    const need = "THERM-3 due date";
    const due = { lists: [], sentences: [{ text: "THERM-3 is due October 9, 2026.", evidence: ["E3"] }], not_found: [] };
    const run = async (plan: readonly string[]) => {
      const h = harness([
        ask(text, need, "open", [], [TICKETS_LIST]), ask(text, need, "open", [], [{ tool: "open", args: { id: "E3" } }], "N1"), ask(text, need, "found", plan, [finish], "N1"), due, due,
      ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 8)) as EvidenceDeskResultV2), open });
      return { h, response: (await h.research.answerWithResearch({ question: text })).response };
    };
    const alone = await run(["E3"]);
    expect(writerInputs(alone.h)).toHaveLength(1);
    expect(alone.response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: "THERM-3 is due October 9, 2026." }] }] });
    const beside = await run(["L1", "E3"]);
    expect(writerInputs(beside.h)).toHaveLength(1);
    expect(beside.response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: "THERM-3 is due October 9, 2026." }] }] });
    expect(beside.response.parts[0]!.statements).toHaveLength(1);
  });

  it("takes the list's id beside opened members that keep their row ids as content across the list: tickets, actions and follow-ups alike", async () => {
    // A Jira open returns the ticket's body under the row's own id, as a meeting open does; a follow-up's row carries its text.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const n = Number(/THERM-(\d+)/u.exec(input.item)![1]);
      return result([ticketBody(n, n === 3 || n === 5 ? "Repro steps reference BUG-412." : "No defects referenced.")]) as EvidenceDeskResultV2;
    });
    const jira = { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 8)) as EvidenceDeskResultV2), open };
    const text = "Which Jira tickets created on October 4, 2026 mention BUG-412?";
    const need = "tickets created on 2026-10-04 that mention BUG-412";
    const opens = (ids: readonly string[]) => ids.map(id => ({ tool: "open", args: { id } }));
    const say = (sentence: string, evidence: readonly string[]) => ({ lists: [], sentences: [{ text: sentence, evidence }], not_found: [] });
    // Every ticket opened: the answer is complete, and the list's id beside the two that match uses the list.
    const all = harness([
      ask(text, need, "open", [], [TICKETS_LIST]), ask(text, need, "open", [], opens(["E1", "E2", "E3", "E4"]), "N1"), ask(text, need, "open", [], opens(["E5", "E6", "E7", "E8"]), "N1"),
      ask(text, need, "found", ["L1", "E3", "E5"], [finish], "N1", WS), say("THERM-3 and THERM-5 mention BUG-412.", ["L1", "E3", "E5"]),
    ], jira);
    const done = (await all.research.answerWithResearch({ question: text })).response;
    expect(writerInputs(all)).toHaveLength(1);
    expect(writerPrompt(all).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 8, cited_by_plan: true });
    expect(done).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: "THERM-3 and THERM-5 mention BUG-412." }] }] });
    expect(done.parts[0]!.statements).toHaveLength(1);
    // Four opened: the same form is noted, never forced into a list nobody asked for.
    const half = harness([
      ask(text, need, "open", [], [TICKETS_LIST]), ask(text, need, "open", [], opens(["E1", "E2", "E3", "E4"]), "N1"),
      ask(text, need, "found", ["L1", "E3"], [finish], "N1", WS), say("THERM-3 mentions BUG-412.", ["L1", "E3"]),
    ], jira);
    const noted = (await half.research.answerWithResearch({ question: text })).response;
    expect(writerInputs(half)).toHaveLength(1);
    expect(noted).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Not every listed item was checked, so others may also match.", statements: [{ text: "THERM-3 mentions BUG-412 (4 of 8 checked so far)." }] }] });
    expect(noted.parts[0]!.statements).toHaveLength(1);

    // Mara's 8 actions, every one opened.
    const action = { kind: "action" as const, attributes: { owner: "Mara Quinn" } };
    const rows = Array.from({ length: 8 }, (_, index) => listed(`a${index + 1}`, action));
    const bodies = new Map(rows.map((row, index) => [row.id, record(`a${index + 1}`, index === 1 || index === 4 ? `Mara will chase the vendor about fixture ${index + 1}.` : `Mara will do task ${index + 1}.`, action)]));
    const q = "Which of Mara's actions mention the vendor?";
    const n = "Mara's actions that mention the vendor";
    const vendor = say("Two of Mara's actions mention the vendor: fixtures 2 and 5.", ["L1", "E2", "E5"]);
    const meetings = harness([
      ask(q, n, "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]), ask(q, n, "open", [], opens(["E1", "E2", "E3", "E4"]), "N1"), ask(q, n, "open", [], opens(["E5", "E6", "E7", "E8"]), "N1"),
      ask(q, n, "found", ["L1", "E2", "E5"], [finish], "N1", WS), vendor,
    ], { list: vi.fn(async () => result(rows) as EvidenceDeskResultV2), open: vi.fn(async (input: { readonly item: string }) => result([bodies.get(input.item)!]) as EvidenceDeskResultV2) });
    const owned = (await meetings.research.answerWithResearch({ question: q })).response;
    expect(writerInputs(meetings)).toHaveLength(1);
    expect(owned).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: vendor.sentences[0]!.text }] }] });
    expect(owned.parts[0]!.statements).toHaveLength(1);

    // Follow-ups: the rows carry their text, so research reads them in full.
    const items = Array.from({ length: 4 }, (_, index) => followUpItem(index + 1));
    const desk = {
      scope: { kind: "global" as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1], list: vi.fn(async () => ({ ...result(items), page_full: false }) as EvidenceDeskResultV2),
      search: vi.fn(async () => result([]) as EvidenceDeskResultV2), open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked),
    } satisfies EvidenceDeskPortV2;
    const inputs: StructuredGenerationInput[] = [];
    const fan = "Which of my open follow-ups are about the fan curve?";
    const fanNeed = "my open follow-ups about the fan curve";
    const curve = say("THERM-42 follow-up and THERM-44 follow-up say to ship fan curve v2 before DVT.", ["L1", "E2", "E4"]);
    const replies: unknown[] = [ask(fan, fanNeed, "open", [], [{ tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } }]), ask(fan, fanNeed, "found", ["L1", "E2", "E4"], [finish], "N1", WS), curve];
    const followed = await createAgenticAskV4({
      desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(LIST_READ_AT),
      model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift(); } },
    }).answer({ question: fan });
    expect(inputs.filter(input => input.system_prompt.startsWith("You write"))).toHaveLength(1);
    expect(followed).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: curve.sentences[0]!.text }] }] });
    expect(followed.parts[0]!.statements).toHaveLength(1);
    expect(replies).toEqual([]);
  });

  it("names a meeting and each of its records once, the records by their own lines, never as that many meetings", async () => {
    // Production rows: every record of a meeting carries the meeting's title and date as its label, and a list label
    // of its own line (ADR-0041); the meeting itself is named by its label.
    const label = "THERM DVT sync (2026-10-04)";
    const day = { occurred_at: "2026-10-04", label };
    const line = (text: string) => ({ list_label: `${text} (THERM DVT sync, 2026-10-04)` });
    const items = [
      listed("meeting", { ...day, kind: "imported_meeting" }), listed("d1", { ...day, ...line("Keep the DVT gate on hold"), kind: "decision" }),
      listed("a1", { ...day, ...line("Send fixture drawings to vendor"), kind: "action", attributes: { owner: "Dana Lee" } }), listed("r1", { ...day, ...line("Accuracy fails at 42 °C"), kind: "rationale" }),
    ];
    const text = "Which meetings did I have on October 4, 2026?";
    const need = "meetings on 2026-10-04";
    const h = harness([
      ask(text, need, "open", [], [{ tool: "list", args: { source: "meetings", since: "2026-10-04", until: "2026-10-04" } }]),
      ask(text, need, "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { list: vi.fn(async () => result(items) as EvidenceDeskResultV2) });
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(response.outcome).toBe("answered");
    // Each name says what its record is; the action records an owner the others do not, so its name says it.
    expect(response.parts[0]!.statements).toEqual([{ text: "4 items from meetings dated on October 4, 2026: THERM DVT sync (2026-10-04) (1 meeting); Keep the DVT gate on hold (THERM DVT sync, 2026-10-04) (1 decision); Send fixture drawings to vendor (THERM DVT sync, 2026-10-04) (1 action, owner Dana Lee); Accuracy fails at 42 °C (THERM DVT sync, 2026-10-04) (1 rationale).", citation_indexes: [0, 1, 2, 3], private: false }]);
  });

  it("names one meeting's actions by their own lines, each with its own due date, though they share the meeting's label", async () => {
    // Production list rows: no text; every action of the meeting carries its label (deskLabel) and its own line (deskListLabel).
    const label = "DVT review (2026-10-01)";
    const lines = ["Publish the DVT dashboard (DVT review, 2026-10-01)", "Order fixture spares (DVT review, 2026-10-01)", "Confirm the trace plan (DVT review, 2026-10-01)"];
    const action = (index: number, due_at?: string) => listed(`a${index + 1}`, { kind: "action", label, list_label: lines[index]!, attributes: { owner: "Mara Quinn", ...(due_at === undefined ? {} : { due_at }) } });
    const text = "Which actions does Mara own?";
    const h = harness([
      ask(text, "actions owned by Mara", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]),
      ask(text, "actions owned by Mara", "found", ["L1"], [finish], "N1", WI),
      useL1,
    ], { list: vi.fn(async () => result([action(0, "2026-10-09"), action(1, "2026-10-12"), action(2)]) as EvidenceDeskResultV2) });
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements).toEqual([
      { text: `3 actions with owner Mara: ${lines[0]} (due October 9, 2026); ${lines[1]} (due October 12, 2026); ${lines[2]}.`, citation_indexes: [0, 1, 2], private: false },
    ]);
    // Only Ask's list rows read the line: research steps and citations keep the label.
    expect(writerPrompt(h).lists[0].members.map((member: { title: string }) => member.title)).toEqual(lines);
    for (const input of h.inputs.filter(value => value.system_prompt.startsWith("You are Echo's research agent"))) for (const value of lines) expect(input.user_prompt).not.toContain(value);
    expect(response.citations.map(citation => citation.label)).toEqual([label, label, label]);
  });

  it("gives a task goal over the same meeting rows the same model inputs, with or without their list labels", async () => {
    // An impact card reads each row's label; a list label changes none of its research or renderer inputs (ADR-0041).
    const lines = ["Publish the DVT dashboard", "Order fixture spares"];
    const rows = (labelled: boolean) => lines.map((value, index) => listed(`a${index + 1}`, { kind: "action", label: "DVT review (2026-10-01)", ...(labelled ? { list_label: `${value} (DVT review, 2026-10-01)` } : {}), attributes: { owner: "Mara Quinn" } }));
    const approved = record("approved", "Approved: Mara publishes the DVT dashboard.");
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "approved_record")!;
    const event = definition.parseEvent({ record: approved.citation });
    const card = async (labelled: boolean) => {
      const h = harness([
        ask("What does E1 affect?", "work the record affects", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]),
        ask("What does E1 affect?", "work the record affects", "found", ["E1"], [finish], "N1"),
        { decided: [{ id: "E1", text: "Mara publishes the DVT dashboard." }], affected: [] },
      ], { openCitation: async () => result([approved]), list: vi.fn(async () => result(rows(labelled)) as EvidenceDeskResultV2) });
      await h.research.renderWithResearch({ trigger: "approved_record", brief: definition.brief(event, h.port.scope), renderer: definition.renderer!, trigger_input: event });
      return h.inputs.map(({ signal: _signal, ...input }) => input);
    };
    const labelled = await card(true);
    expect(labelled).toHaveLength(3);
    expect(labelled).toEqual(await card(false));
    for (const input of labelled) for (const value of lines) expect(input.user_prompt).not.toContain(value);
  });
});

describe("Ask research: the finish check follows each need's declared kind (ADR-0041)", () => {
  const followUps = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1));
  const FOLLOW_UPS = { tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } } as const;
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `E${index + 1}`);
  /** Scripted research steps in order, and one writer reply for whatever the answer is. */
  const scripted = (steps: unknown[], writer: unknown = { lists: [], sentences: [], not_found: ["the requested fact"] }) =>
    (input: StructuredGenerationInput) => input.system_prompt.startsWith("You write") ? writer : steps.shift();
  /** Ask over ECHO's follow-ups, 10 a page (the V4 core, whose V7 answers cite them): what each step and the writer were shown. */
  const followUpAsk = async (text: string, steps: unknown[]) => {
    const desk = {
      scope: { kind: "global" as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1],
      list: vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined
        ? { ...result(followUps.slice(0, 10)), next_cursor: "page-2", page_full: false }
        : { ...result(followUps.slice(10)), page_full: false }) as EvidenceDeskResultV2),
      search: vi.fn(async () => result([]) as EvidenceDeskResultV2), open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked),
    } satisfies EvidenceDeskPortV2;
    const inputs: StructuredGenerationInput[] = [];
    const reply = scripted(steps);
    await createAgenticAskV4({
      desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(LIST_READ_AT),
      model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return reply(input); } },
    }).answer({ question: text });
    const prompts = (writer: boolean) => inputs.filter(input => input.system_prompt.startsWith("You write") === writer).map(input => JSON.parse(input.user_prompt) as Record<string, any>);
    return { desk, steps: prompts(false), writer: prompts(true)[0]!, left: steps };
  };

  it("refuses a which_items finish on ten follow-up rows once, naming their list and asking to read it on", async () => {
    // A repair that only cites L1 is refused again, since L1 has a next page: research stops with the need still open.
    const text = "What are my open follow-ups?";
    const need = "my open follow-ups";
    const { desk, steps, writer, left } = await followUpAsk(text, [ask(text, need, "open", [], [FOLLOW_UPS], undefined, WI), ask(text, need, "found", ids(10), [finish], "N1", WI), ask(text, need, "found", ["L1"], [finish], "N1", WI)]);
    const reading = `list L1 is unfinished: keep reading the list (repeat list with {"source":"follow_ups","status":"open","owner":"Mara Lind"})`;
    expect(steps).toHaveLength(3);
    expect(steps[2]!.validation_error).toContain(`need N1 "${need}" cites no list: cite the id of the list that holds its items (L1); part 1 need N1 "${need}": ${reading}`);
    expect(desk.list).toHaveBeenCalledOnce();
    expect(writer.research).toMatchObject({ completed: false, stop_reason: "unusable_step" });
    expect(left).toEqual([]);
  });

  it("follows a content declaration on ten follow-up rows: it finishes without reading on, on no list (Known limits)", async () => {
    // A which-question declared content gets content's rules: the declaration decides, and nothing checks it.
    const text = "What are my open follow-ups?";
    const need = "my open follow-ups";
    const { desk, steps, writer } = await followUpAsk(text, [ask(text, need, "open", [], [FOLLOW_UPS]), ask(text, need, "found", ids(10), [finish], "N1", "content")]);
    expect(steps).toHaveLength(2);
    expect(desk.list).toHaveBeenCalledOnce();
    expect(writer.research).toMatchObject({ completed: true, stop_reason: "finished" });
    expect(writer.lists).toEqual([expect.objectContaining({ id: "L1", complete: false, count: 10, cited_by_plan: false })]);
  });

  it("never waits for the end of a which_say list, and refuses a not_found one until absence is shown", async () => {
    // Every follow-up row carries its text and is read in full once shown.
    const fan = "Which of my open follow-ups are about the fan curve?";
    const fanNeed = "my open follow-ups about the fan curve";
    const found = await followUpAsk(fan, [ask(fan, fanNeed, "open", [], [FOLLOW_UPS], undefined, WS), ask(fan, fanNeed, "found", ["L1", "E2", "E4"], [finish], "N1", WS)]);
    expect(found.steps).toHaveLength(2);
    expect(found.desk.list).toHaveBeenCalledOnce();
    expect(found.writer.research).toMatchObject({ completed: true, stop_reason: "finished" });
    // None of the first ten is about the oven, and the list has a next page: absence waits for its end, as for every kind.
    const oven = "Which of my open follow-ups are about the oven?";
    const ovenNeed = "my open follow-ups about the oven";
    const absent = await followUpAsk(oven, [
      ask(oven, ovenNeed, "open", [], [FOLLOW_UPS], undefined, WS), ask(oven, ovenNeed, "not_found", ["L1"], [finish], "N1", WS),
      ask(oven, ovenNeed, "open", [], [FOLLOW_UPS], "N1", WS), ask(oven, ovenNeed, "not_found", ["L1"], [finish], "N1", WS),
    ]);
    expect(absent.steps).toHaveLength(4);
    expect(absent.steps[2]!.validation_error).toContain(`need N1 "${ovenNeed}" is not_found after fewer than two completed searches or a completed list`);
    expect(absent.steps[2]!.validation_error).not.toContain("cites no list");
    expect(absent.desk.list).toHaveBeenCalledTimes(2);
    expect(absent.writer.research).toMatchObject({ completed: true, stop_reason: "finished" });
    expect(absent.writer.lists).toEqual([expect.objectContaining({ id: "L1", complete: true, count: 12, checked: 12 })]);
  });

  it("asks a not_found which_say finish that cites no list for the list it checked, once", async () => {
    const text = "Which pages created on October 4, 2026 mention BUG-999?";
    const need = "pages created on 2026-10-04 that mention BUG-999";
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "No defects are discussed.")]) as EvidenceDeskResultV2);
    const run = (finishes: readonly unknown[]) => harness(scripted([
      ask(text, need, "open", [], [OCT4_LIST], undefined, WS), ask(text, need, "open", [], MEMBERS.slice(0, 4).map(id => ({ tool: "open", args: { id } })), "N1", WS), ...finishes,
    ]), october4Desk({ open })).research.research({ trigger: "ask", brief: question(text) });
    const unlisted = `need N1 "${need}" cites no list: cite the id of the list that holds its items`;
    // The repair cites the list it checked: "none of them" is qualified by how many were read, as "these" is.
    const repaired = await run([ask(text, need, "not_found", [], [finish], "N1", WS), ask(text, need, "not_found", ["L1"], [finish], "N1", WS)]);
    expect(repaired.rounds.at(-1)!.rejected).toEqual([expect.stringContaining(`${unlisted} (from lists), or list them first. `)]);
    expect(repaired.stop).toEqual({ reason: "finished", completed: true });
    expect(repaired.plan[0]!.needs).toEqual([{ need, kind: "which_say", status: "not_found", evidence: ["L1"] }]);
    // Citing the pages it opened instead, the refusal names their list.
    const opened = await run([ask(text, need, "not_found", MEMBERS.slice(0, 4), [finish], "N1", WS), ask(text, need, "not_found", ["L1"], [finish], "N1", WS)]);
    expect(opened.rounds.at(-1)!.rejected).toEqual([expect.stringContaining(`${unlisted} (L1). `)]);
    // A repair that repeats the shape ends research; the plan keeps the last accepted step's need, which cites no list.
    const repeated = await run([ask(text, need, "not_found", [], [finish], "N1", WS), ask(text, need, "not_found", [], [finish], "N1", WS)]);
    expect(repeated.stop).toEqual({ reason: "unusable_step", completed: false });
    expect(repeated.plan[0]!.needs).toEqual([{ need, kind: "which_say", status: "open", evidence: [] }]);
  });
});

describe("a task goal keeps the rules before ADR-0041", () => {
  it("sees inventories, never lists, cites no list id and records none", async () => {
    const approved = record("approved", "Approved: ship the DVT fixture.");
    const task: AgenticBriefV1 = {
      goal: { kind: "task", task: `Find what ${agenticStartingSlotV1(1)} affects.` }, starting: [{ citation: approved.citation, if_unreadable: "fail" }],
      budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false },
    };
    const affects = (status: "open" | "found", evidence: readonly string[], actions: readonly unknown[]) => ask("What does E1 affect?", "tickets the record affects", status, evidence, actions);
    const h = harness([
      affects("open", [], [{ tool: "list", args: { source: "tickets" } }]),
      affects("found", ["L1", "E2"], [finish]),
      affects("found", ["L1", "E2"], [finish]),
    ], { live_sources: [JIRA], ticket_available: true, openCitation: async () => result([approved]), list: vi.fn(async () => result(tickets(1, 3)) as EvidenceDeskResultV2) });
    const view = await h.research.research({ trigger: "approved_record", brief: task });
    expect(h.prompt(1)).not.toHaveProperty("lists");
    expect(h.prompt(1).inventories).toEqual([{ args: { source: "tickets" }, shown_count: 3, more: false, available: true, truncated: false }]);
    expect(h.prompt(1).last_results).toEqual([{ tool: "list", args: { source: "tickets" }, items: ["E2", "E3", "E4"], more: false }]);
    // A task's need still needs an item read in full; L1 is no id there, so it is dropped.
    expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining("is found but cites no item whose full text you have read"), expect.stringContaining("is found but cites no item whose full text you have read")]);
    expect(view.stop).toEqual({ reason: "unusable_step", completed: false });
    expect(view.plan[0]!.needs[0]!.evidence).toEqual([]);
    expect(view).not.toHaveProperty("lists");
  });
});

describe("the finish check for a question goal (ADR-0041)", () => {
  const lists: readonly AskResearchListV1[] = [
    { id: "L1", ended: true, args: { source: "pages" }, members: ["E1", "E2", "E3"] },
    { id: "L2", ended: false, args: { source: "tickets" }, members: ["E4", "E5"] },
  ];
  const full = (id: string) => id === "E9" || id === "E4";
  const settled = (kind: string | undefined, status: "found" | "not_found", evidence: readonly string[]) =>
    [{ needs: [{ id: "N1", need: "the need", ...(kind === undefined ? {} : { kind: kind as "which_items" }), status, evidence, observations_before: 0 }] }];
  const problems = (kind: string | undefined, evidence: readonly string[], options: { readonly lists?: readonly AskResearchListV1[]; readonly list?: boolean; readonly member_in?: (list: `L${number}`, id: string) => string | undefined } = {}) =>
    askQuestionCompletionProblemsV1(settled(kind, "found", evidence), [], options.lists ?? lists, full, options.list ?? true, ...(options.member_in === undefined ? [] : [options.member_in]));
  const label = 'part 1 need N1 "the need"';
  const unlisted = (holders?: string) => `${label} cites no list: cite the id of the list that holds its items${holders === undefined ? " (from lists), or list them first" : ` (${holders})`}`;
  const unfinished = (id: string, source: string) => `${label}: list ${id} is unfinished: keep reading the list (repeat list with {"source":"${source}"})`;
  const unread = `${label} is found but cites no item whose full text you have read: a list shows which items exist and each member's title, dates, status and owner, never what an item says; open the items for what they say`;

  it("accepts a which_items need on a list read to its end, waits for one that is not, and asks for a list it does not cite", () => {
    expect(problems(WI, ["L1"])).toEqual([]);
    expect(problems(WI, ["L1", "E1", "E9"])).toEqual([]);
    expect(problems(WI, ["L2"])).toEqual([unfinished("L2", "tickets")]);
    // Rows alone: the refusal names the list that holds them, and asks to read it on when it has not ended.
    expect(problems(WI, ["E1", "E2"])).toEqual([unlisted("L1")]);
    expect(problems(WI, ["E1", "E2"], { lists: [{ ...lists[0]!, ended: false }, lists[1]!] })).toEqual([unlisted("L1"), unfinished("L1", "pages")]);
    expect(problems(WI, ["E1", "E4"])).toEqual([unlisted("L1 or L2"), unfinished("L2", "tickets")]);
    expect(problems(WI, ["L9"])).toEqual([unlisted()]);
    expect(problems(WI, ["E9"])).toEqual([unlisted()]);
  });

  it("asks a which_say need for the list it checks, never waits for that list's end, and needs text read in full", () => {
    expect(problems(WS, ["L1", "E9"])).toEqual([]);
    expect(problems(WS, ["L2", "E9"])).toEqual([]);
    // E9 is part of L2's member E5, as an opened page's section is its page: the refusal names L2, and never asks to read on.
    const section = (list: `L${number}`, id: string) => list === "L2" && id === "E9" ? "E5" : lists.find(value => value.id === list)?.members.includes(id) === true ? id : undefined;
    expect(problems(WS, ["E9"], { member_in: section })).toEqual([unlisted("L2")]);
    expect(problems(WS, ["E9"])).toEqual([unlisted()]);
    expect(problems(WS, ["L1"])).toEqual([unread]);
  });

  it("keeps \"one cited item read in full\" for content, whose list ids carry no meaning", () => {
    expect(problems(undefined, ["E9"])).toEqual([]);
    expect(problems("content", ["E9"])).toEqual([]);
    // A row of the unfinished L2 beside a read text, or L2 itself, neither refuses nor makes it wait.
    expect(problems("content", ["E5", "E9"])).toEqual([]);
    expect(problems("content", ["L2", "E9"])).toEqual([]);
    expect(problems("content", ["E4"])).toEqual([]);
    // Rows or a list alone: the refusal says what each kind of support is, never which kind the need should be.
    for (const evidence of [["L1"], ["E1", "E2"], []]) expect(problems("content", evidence)).toEqual([unread]);
    for (const word of ["which_items", "which_say", "kind"]) expect(unread).not.toContain(word);
    expect(problems("content", ["L1"], { list: false })).toEqual([`${label} is found but cites no item whose full text you have read`]);
  });

  it("asks a not_found which_say need for its list, and keeps the not-found rules for every kind", () => {
    const afterList = [{ operation: "list" as const, fingerprint: "k", complete: true }];
    const notFound = (kind: string | undefined, evidence: readonly string[], observations: readonly { readonly operation: "list" | "search"; readonly fingerprint: string; readonly complete: boolean }[] = afterList) =>
      askQuestionCompletionProblemsV1(settled(kind, "not_found", evidence), observations, lists, full);
    expect(notFound(WS, [])).toEqual([unlisted()]);
    expect(notFound(WS, ["E1", "E2"])).toEqual([unlisted("L1")]);
    expect(notFound(WS, ["L1"])).toEqual([]);
    // Absence is never read from an unfinished page, whatever the kind; the need cites its list, so only that is said.
    expect(notFound(WS, ["L2"], [])).toEqual([`${label} is not_found after fewer than two completed searches or a completed list`]);
    expect(notFound(WI, [])).toEqual([]);
    expect(notFound(WI, ["E1"])).toEqual([]);
    expect(notFound("content", [])).toEqual([]);
    expect(notFound(undefined, [], [])).toEqual([`${label} is not_found after fewer than two completed searches or a completed list`]);
  });

  it("keeps the not_found and open rules", () => {
    expect(askQuestionCompletionProblemsV1([{ needs: [{ need: "x", status: "not_found", evidence: [], observations_before: 0 }] }], [{ operation: "list", fingerprint: "k", complete: true }], lists, full)).toEqual([]);
    expect(askQuestionCompletionProblemsV1([{ needs: [{ need: "x", status: "not_found", evidence: [], observations_before: 0 }] }], [], lists, full, false)).toEqual(['part 1 need "x" is not_found after fewer than two completed searches']);
    expect(askQuestionCompletionProblemsV1([{ needs: [{ need: "x", status: "open", evidence: [], observations_before: 0 }] }], [], lists, full)).toEqual(['part 1 need "x" is still open']);
    expect(askQuestionCompletionProblemsV1([{ needs: [{ need: "x", kind: "which_items", status: "open", evidence: [], observations_before: 0 }] }], [], lists, full)).toEqual(['part 1 need "x" is still open']);
    expect(askQuestionCompletionProblemsV1([], [], lists, full)).toEqual(["no parts were written"]);
  });

  it("keeps a task goal's rule for every need, whatever kind it names", () => {
    const searches = [{ operation: "search" as const, fingerprint: "a", complete: true }, { operation: "search" as const, fingerprint: "b", complete: true }];
    expect(askResearchCompletionProblemsV1(settled(undefined, "found", ["E5", "E9"]), [], full)).toEqual([]);
    expect(askResearchCompletionProblemsV1(settled(undefined, "found", ["E1"]), [], full)).toEqual([`${label} is found but cites no item whose full text you have read`]);
    expect(askResearchCompletionProblemsV1(settled(WI, "found", ["L1"]), [], full)).toEqual([`${label} is found but cites no item whose full text you have read`]);
    expect(askResearchCompletionProblemsV1(settled(undefined, "not_found", []), searches, full)).toEqual([]);
    expect(askResearchCompletionProblemsV1(settled(undefined, "not_found", ["E1"]), searches.slice(0, 1), full, false)).toEqual([`${label} is not_found after fewer than two completed searches`]);
  });
});
