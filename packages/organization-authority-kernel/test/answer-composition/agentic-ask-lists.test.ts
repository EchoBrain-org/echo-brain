import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonFollowUpEvidenceV1 } from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import { askQuestionCompletionProblemsV1, type AskResearchListV1 } from "../../src/answer-composition/agentic-ask-research-state-v1.js";
import { createAgenticAskV4 } from "../../src/answer-composition/agentic-ask-v1.js";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1, followUpDeskFieldsV1 } from "../../src/shared/follow-up-evidence-v1.js";
import { checked, generation, LIST_READ_AT, record, researchHarness as harness, result } from "./fixtures/agentic-scenarios.js";

/**
 * Ask's lists as evidence of which items exist (ADR-0041): a list read to its
 * end lets research finish without opening its members; an unfinished one
 * asks for its next page; an exactly full last page is never trusted as the
 * end; a filter a source cannot apply is recorded, never silently widened; and
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

const question = (text: string): AgenticBriefV1 => ({ goal: { kind: "question", question: text }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: false } });
const ask = (text: string, need: string, status: "open" | "found" | "not_found", evidence: readonly string[], actions: readonly unknown[], id?: string) =>
  ({ parts: [{ question: text, needs: [{ ...(id === undefined ? {} : { id }), need, status, evidence }], notes: "" }], actions });
const finish = { tool: "finish", args: {} } as const;

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
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1"),
    ], october4Desk());
    const view = await h.research.research({ trigger: "ask", brief: question(OCT4) });
    // Two research calls; the rows have no text, so no writer call runs yet.
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.rounds.map(round => round.rejected)).toEqual([[], []]);
    expect(view.rounds.flatMap(round => round.actions.map(action => action.tool))).toEqual(["list", "finish"]);
    expect(view.plan[0]!.needs).toEqual([{ need: OCT4_NEED, status: "found", evidence: ["L1"] }]);
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
      ask(OCT4, OCT4_NEED, "found", MEMBERS, [finish], "N1"),
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1"),
    ], october4Desk());
    const view = await h.research.research({ trigger: "ask", brief: question(OCT4) });
    expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining('need N1 "list of Confluence pages created on 2026-10-04" is found but cites no item whose full text you have read: cite L1 for which items exist, or open the items for what they say')]);
    expect(h.prompt(2).validation_error).toContain("cite L1 for which items exist");
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
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1"),
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
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1"),
      ask(TICKETS, TICKETS_NEED, "open", [], [LIST], "N1"),
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1"),
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
      ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1"),
    ], { live_sources: [JIRA], ticket_available: true, list });
    const view = await h.research.research({ trigger: "ask", brief: question(TICKETS) });
    // It cannot be read further, so the finish is accepted; it is not complete, so the answer can only say "at least 25".
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(h.prompt(1).last_results).toEqual([expect.objectContaining({ list: "L1", more: false, note: "its last page was exactly full, so more items may exist than list can show; use search" })]);
    expect(h.prompt(1).lists).toEqual([expect.objectContaining({ id: "L1", more: false, complete: false, unverified_end: true })]);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", shown: 25, ended: true, unverified_end: true, complete: false })]);
  });

  it("treats a page with as many rows as research asked for as full when the desk does not say", async () => {
    const meetings = Array.from({ length: 50 }, (_, index) => record(`action-${index + 1}`, `Action ${index + 1}.`, { kind: "action", attributes: { owner: "Dana Lee" } }));
    const list = vi.fn(async () => result(meetings) as EvidenceDeskResultV2);
    const h = harness([
      ask("Which actions does Dana own?", "actions owned by Dana", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Dana" } }]),
      ask("Which actions does Dana own?", "actions owned by Dana", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Dana" } }], "N1"),
      ask("Which actions does Dana own?", "actions owned by Dana", "found", ["L1"], [finish], "N1"),
      { sentences: [], not_found: ["actions owned by Dana"] },
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
      ask("Which tickets track DVT?", need, "found", ["L1"], [finish], "N1"),
      { sentences: [], not_found: [need] },
    ], { live_sources: [JIRA], ticket_available: true, list, search: vi.fn(async () => result([launch])) });
    const view = await h.research.research({ trigger: "ask", brief: question("Which tickets track DVT?") });
    // Before ADR-0041 the third list-only step after a read text stopped research as no_progress.
    expect(view.stop).toEqual({ reason: "finished", completed: true });
    expect(view.rounds).toHaveLength(6);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", shown: 100, ended: true, complete: true })]);
  });
});

describe("Ask research: filters are applied or refused, never silently widened", () => {
  it("records an owner filter tickets cannot apply as ignored", async () => {
    const list = vi.fn(async (_input: EvidenceDeskListInputV2) => result(tickets(1, 3)) as EvidenceDeskResultV2);
    const text = "Which tickets does Dana own?";
    const h = harness([
      ask(text, "Dana's tickets", "open", [], [{ tool: "list", args: { source: "tickets", owner: "Dana" } }]),
      ask(text, "Dana's tickets", "found", ["L1"], [finish], "N1"),
    ], { live_sources: [JIRA], ticket_available: true, list });
    const view = await h.research.research({ trigger: "ask", brief: question(text) });
    expect(list.mock.calls[0]![0]).not.toHaveProperty("owner");
    expect(h.prompt(1).last_results).toEqual([expect.objectContaining({ list: "L1", note: "owner applies to meeting actions only; ignored" })]);
    expect(h.prompt(1).lists).toEqual([expect.objectContaining({ id: "L1", notes: ["owner applies to meeting actions only; ignored"] })]);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter: { time_zone: "UTC" }, filter_applied: { owner: "ignored" }, complete: true })]);
  });

  it("records a status filter meeting actions apply only where they record one", async () => {
    const actions = [
      record("a1", "Dana will publish the dashboard.", { kind: "action", attributes: { owner: "Dana Lee", status: "open" } }),
      record("a2", "Dana will order samples.", { kind: "action", attributes: { owner: "Dana Lee" } }),
      record("a3", "Dana closed the vendor review.", { kind: "action", attributes: { owner: "Dana Lee", status: "done" } }),
    ];
    const text = "Which actions are still open?";
    const h = harness([
      ask(text, "open actions", "open", [], [{ tool: "list", args: { source: "meetings", status: "open" } }]),
      ask(text, "open actions", "found", ["L1"], [finish], "N1"),
      { sentences: [], not_found: ["open actions"] },
    ], { list: vi.fn(async () => result(actions) as EvidenceDeskResultV2) });
    const view = await h.research.research({ trigger: "ask", brief: question(text) });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter: { kind: "action", status: "open", time_zone: "UTC" }, filter_applied: { status: "partial" }, members: ["E1", "E2"], complete: true })]);
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
      ask(text, "actions owned by Mara", "found", ["L1"], [finish], "N1"),
      { sentences: [{ text: "Mara owns publishing the dashboard and reviewing the PRD.", evidence: ["E1", "E2"] }], not_found: [] },
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
      ask(text, "my open follow-ups", "found", ["L1"], [finish], "N1"),
      { sentences: [{ text: "You own two open follow-ups.", evidence: ["E1", "E2"] }], not_found: [] },
    ];
    await createAgenticAskV4({
      desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(LIST_READ_AT),
      model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift(); } },
    }).answer({ question: text });
    expect(desk.list).toHaveBeenCalledWith(expect.objectContaining({ source: "follow_ups", owner: "Mara Lind", status: "open" }));
    const steps = inputs.filter(input => input.system_prompt.startsWith("You are Echo's research agent"));
    expect(steps).toHaveLength(2);
    expect(JSON.parse(steps[1]!.user_prompt).lists).toEqual([{
      id: "L1", args: { source: "follow_ups", status: "open", owner: "Mara Lind" }, members: ["E1", "E2"], shown_count: 2, more: false, complete: true,
      available: true, truncated: false, unverified_end: false,
    }]);
    expect(replies).toEqual([]);
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
  const found = (evidence: readonly string[]) => [{ needs: [{ id: "N1", need: "which items", status: "found" as const, evidence, observations_before: 0 }] }];
  const problems = (evidence: readonly string[]) => askQuestionCompletionProblemsV1(found(evidence), [], lists, full);

  it("accepts a need on a list read to its end, with or without its members", () => {
    expect(problems(["L1"])).toEqual([]);
    expect(problems(["L1", "E1", "E2"])).toEqual([]);
  });

  it("refuses a need on a list that can still be read further", () => {
    expect(problems(["L2"])).toEqual(['part 1 need N1 "which items": list L2 is unfinished: keep reading the list (repeat list with {"source":"tickets"})']);
    // A member row of an unfinished list, cited beside a read text, still rests on that list.
    expect(problems(["E9", "E5"])).toEqual(['part 1 need N1 "which items": list L2 is unfinished: keep reading the list (repeat list with {"source":"tickets"})']);
  });

  it("keeps \"one cited item read in full\" for content, and asks for the list's id beside rows alone", () => {
    expect(problems(["E9"])).toEqual([]);
    // E4 is a member read in full: content, so its unfinished list is not what the need rests on.
    expect(problems(["E4"])).toEqual([]);
    expect(problems(["E1", "E2"])).toEqual(['part 1 need N1 "which items" is found but cites no item whose full text you have read: cite L1 for which items exist, or open the items for what they say']);
    expect(problems(["E7", "L9"])).toEqual(['part 1 need N1 "which items" is found but cites no item whose full text you have read']);
  });

  it("keeps the not_found and open rules", () => {
    expect(askQuestionCompletionProblemsV1([{ needs: [{ need: "x", status: "not_found", evidence: [], observations_before: 0 }] }], [{ operation: "list", fingerprint: "k", complete: true }], lists, full)).toEqual([]);
    expect(askQuestionCompletionProblemsV1([{ needs: [{ need: "x", status: "not_found", evidence: [], observations_before: 0 }] }], [], lists, full, false)).toEqual(['part 1 need "x" is not_found after fewer than two completed searches']);
    expect(askQuestionCompletionProblemsV1([{ needs: [{ need: "x", status: "open", evidence: [], observations_before: 0 }] }], [], lists, full)).toEqual(['part 1 need "x" is still open']);
    expect(askQuestionCompletionProblemsV1([], [], lists, full)).toEqual(["no parts were written"]);
  });
});
