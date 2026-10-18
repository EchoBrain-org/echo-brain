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

/** A follow-up as the desk releases it: its row carries its text (ADR-0040), and its due date when it has one. */
function followUpItem(n: number, due_at?: string): EvidenceDeskItemV2 {
  const decision = { title: "THERM DVT recovery sync", first_line: "Ship fan curve v2 before DVT.", ref: `meeting:sha256:${"a".repeat(64)}` } as const;
  const fields = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: `itm_6b0f8a52-55a4-4f6e-9a39-${String(n).padStart(12, "0")}`, kind: "ticket", title: `THERM-${40 + n} follow-up`, owner: "Mara Lind", status: "open", ...(due_at === undefined ? {} : { due_at }), decision }));
  return Object.freeze({ id: `follow-up-${n}`, ...fields, visibility: "team" as const, receipt_sha256: canonicalSha256(`follow-up-${n}`) });
}
/** A global desk over `items` of live sources, listed `size` a page (ECHO's follow-ups page 10 at a time). */
function pagedDesk(items: readonly EvidenceDeskItemV2[], extra: Partial<EvidenceDeskPortV2> & { readonly size?: number } = {}) {
  const { size = 10, ...rest } = extra;
  return {
    scope: { kind: "global" as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1],
    list: vi.fn(async (input: EvidenceDeskListInputV2) => {
      const start = input.cursor === undefined ? 0 : Number(input.cursor);
      return { ...result(items.slice(start, start + size)), ...(start + size < items.length ? { next_cursor: String(start + size) } : {}), page_full: false } as EvidenceDeskResultV2;
    }),
    search: vi.fn(async () => result([]) as EvidenceDeskResultV2), open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked), ...rest,
  } satisfies EvidenceDeskPortV2;
}
/** Ask's V4 core (whose V7 answers cite follow-ups) with scripted replies in order: its answer, and what each step and the writer were shown. */
async function askV4(desk: EvidenceDeskPortV2, text: string, replies: unknown[], context: { readonly now?: string; readonly time_zone?: string } = {}) {
  const inputs: StructuredGenerationInput[] = [];
  const now = context.now ?? LIST_READ_AT;
  const response = await createAgenticAskV4({
    desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(now),
    ...(context.time_zone === undefined ? {} : { time_context: { now, time_zone: context.time_zone } }),
    model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift(); } },
  }).answer({ question: text });
  const prompts = (writer: boolean) => inputs.filter(input => input.system_prompt.startsWith("You write") === writer).map(input => JSON.parse(input.user_prompt) as Record<string, any>);
  return { response, steps: prompts(false), writers: prompts(true), left: replies, systems: inputs.map(input => input.system_prompt) };
}

const question = (text: string): AgenticBriefV1 => ({ goal: { kind: "question", question: text }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: false } });
/** One step with one need; `kind` is the need's declared kind (ADR-0041), content when left out. */
const ask = (text: string, need: string, status: "open" | "found" | "not_found", evidence: readonly string[], actions: readonly unknown[], id?: string, kind?: string) =>
  ({ parts: [{ question: text, needs: [{ ...(id === undefined ? {} : { id }), need, ...(kind === undefined ? {} : { kind }), status, evidence }], notes: "" }], actions });
/** One step whose one part has several needs, each [need, status, evidence, kind?, id?]. */
const askAll = (text: string, needs: readonly (readonly [string, "open" | "found" | "not_found", readonly string[], string?, string?])[], actions: readonly unknown[]) =>
  ({ parts: [{ question: text, needs: needs.map(([need, status, evidence, kind, id]) => ({ ...(id === undefined ? {} : { id }), need, ...(kind === undefined ? {} : { kind }), status, evidence })), notes: "" }], actions });
/** Which items exist in a set picked by list facts: a list answers it. */
const WI = "which_items";
/** Which members of such a set say something: it cites the list it checks. */
const WS = "which_say";
const finish = { tool: "finish", args: {} } as const;
/** The writer uses list L1: code names its members (ADR-0041). */
const useL1 = { lists: [{ id: "L1" }], sentences: [], not_found: [] } as const;
/** The writer's one repair for a sentence resting on list rows or list ids alone (W1). */
const ROWS_REASON = 'a sentence cites list rows or list ids but no evidence text: code states which items exist, and members\' title, dates, status and owner, through "lists" (with "where" or "members"); what no evidence text says belongs in "not_found"';
const UNSUPPORTED = "Part of the answer was left out because no item's text supports it.";
const UNCHECKED = "Not every listed item was checked, so others may also match.";
const WHICH = "I could not confirm the full list of items asked for.";
const opens = (ids: readonly string[]) => ids.map(id => ({ tool: "open", args: { id } }));

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
    const { response, research: view } = await h.research.answerWithResearch({ question: text });
    expect(list.mock.calls[0]![0]).not.toHaveProperty("owner");
    expect(h.prompt(1).last_results).toEqual([expect.objectContaining({ list: "L1", note: "owner applies to meeting actions only; ignored" })]);
    expect(h.prompt(1).lists).toEqual([expect.objectContaining({ id: "L1", notes: ["owner applies to meeting actions only; ignored"] })]);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter: { time_zone: "UTC" }, filter_applied: { owner: "ignored" }, complete: true })]);
    // Research builds no filter notice; the answer that states the list tells the person (W7).
    expect(view.coverage.notices).toEqual([]);
    expect(response.notice).toBe("Jira tickets could not be filtered by owner, so this list is not limited to that owner.");
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
    const { response, research: view } = await h.research.answerWithResearch({ question: text });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter: { kind: "action", status: "open", time_zone: "UTC" }, filter_applied: { status: "partial" }, members: ["E1", "E2"], complete: true })]);
    expect(view.coverage.notices).toEqual([]);
    expect(response.notice).toBe("Actions were filtered by status only where they record one, so this list also includes items that record none.");
  });

  it("tells the person the filter of a list a which_say need checks, and never of one a content need cites", async () => {
    // A content need's list ids carry no meaning (ADR-0041); no statement names the list, so only a which_say need's adds a notice (W7).
    const text = "Which of Dana's tickets mention the vendor?";
    const need = "Dana's tickets that mention the vendor";
    const run = async (kind: string) => {
      const h = harness([
        ask(text, need, "open", [], [{ tool: "list", args: { source: "tickets", owner: "Dana" } }], undefined, kind),
        ask(text, need, "open", [], [{ tool: "open", args: { id: "E2" } }], "N1", kind),
        ask(text, need, "found", ["L1", "E2"], [finish], "N1", kind),
        { lists: [], sentences: [{ text: "THERM-2 mentions the vendor.", evidence: ["L1", "E2"] }], not_found: [] },
      ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 3)) as EvidenceDeskResultV2), open: vi.fn(async () => result([ticketBody(2, "THERM-2: the vendor slipped the fixture.")]) as EvidenceDeskResultV2) });
      return h.research.answerWithResearch({ question: text });
    };
    const checked = await run(WS);
    expect(checked.research.stop).toEqual({ reason: "finished", completed: true });
    expect(checked.research.coverage.notices).toEqual([]);
    expect(checked.response.notice).toBe("Jira tickets could not be filtered by owner, so this list is not limited to that owner.");
    // It answers what one of three tickets says, so the part says the other two were not checked.
    expect(checked.response.parts[0]).toMatchObject({ status: "partial", statements: [{ text: "THERM-2 mentions the vendor (1 of 3 checked so far)." }], gap: "Not every listed item was checked, so others may also match." });
    const content = await run("content");
    expect(content.response).not.toHaveProperty("notice");
    expect(content.response.parts[0]).toEqual({ question: text, status: "answered", statements: [{ text: "THERM-2 mentions the vendor.", citation_indexes: [0], private: true }] });
  });

  it("names no filter of a list no statement names and no which_say need checks", async () => {
    const launch = record("launch", "Launch is Tuesday.");
    const h = harness([
      ask("When is launch?", "launch date", "open", [], [{ tool: "list", args: { source: "tickets", owner: "Dana" } }, { tool: "search", args: { query: "launch" } }]),
      ask("When is launch?", "launch date", "found", ["E4"], [finish], "N1"),
      { sentences: [{ text: "Launch is Tuesday.", evidence: ["E4"] }], not_found: [] },
    ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 3)) as EvidenceDeskResultV2), search: vi.fn(async () => result([launch])) });
    const { response, research: view } = await h.research.answerWithResearch({ question: "When is launch?" });
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", filter_applied: { owner: "ignored" } })]);
    expect(view.coverage.notices).toEqual([]);
    expect(response).not.toHaveProperty("notice");
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
    // Code names the list; the writer's sentence cites only its members' text, which no other need asks about, so it only
    // restates the list and is left out (W4).
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual(["2 follow-ups with owner Mara Lind and status open: THERM-41 follow-up; THERM-42 follow-up."]);
    expect(response.outcome).toBe("answered");
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

  it("asks a which_items need to keep reading a follow-up list, then states all 12; the writer's count is left out (C5, X8)", async () => {
    // A follow-up row always carries its text, so research reads it in full; the desk pages 10 at a time.
    const items = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1));
    const desk = () => ({
      scope: { kind: "global" as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1],
      list: vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined
        ? { ...result(items.slice(0, 10)), next_cursor: "page-2", page_full: false }
        : { ...result(items.slice(10)), page_full: false }) as EvidenceDeskResultV2),
      search: vi.fn(async () => result([]) as EvidenceDeskResultV2), open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked),
    } satisfies EvidenceDeskPortV2);
    const text = "What are my open follow-ups?";
    const need = "my open follow-ups";
    const LIST = { tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } } as const;
    const count = { lists: [], sentences: [{ text: "You have 10 open follow-ups.", evidence: ["L1", ...Array.from({ length: 10 }, (_, index) => `E${index + 1}`)] }], not_found: [] };
    const run = async (replies: unknown[]) => {
      const inputs: StructuredGenerationInput[] = [];
      const port = desk();
      const response = await createAgenticAskV4({
        desk: port, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(LIST_READ_AT),
        model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift(); } },
      }).answer({ question: text });
      const prompts = (writer: boolean) => inputs.filter(input => input.system_prompt.startsWith("You write") === writer).map(input => JSON.parse(input.user_prompt) as Record<string, any>);
      return { response, port, steps: prompts(false), writers: prompts(true), replies };
    };
    // The finish on the first page's list is refused: L1 has a next page. Once read, code states all 12, and the writer's
    // count, citing only members' text, restates the list: it is left out, with no repair (W4).
    const read = await run([ask(text, need, "open", [], [LIST], undefined, WI), ask(text, need, "found", ["L1"], [finish], "N1", WI), ask(text, need, "open", [], [LIST], "N1", WI), ask(text, need, "found", ["L1"], [finish], "N1", WI), count]);
    expect(read.steps[2]!.validation_error).toContain('need N1 "my open follow-ups": list L1 is unfinished: keep reading the list (repeat list with {"source":"follow_ups","status":"open","owner":"Mara Lind"})');
    expect(read.port.list).toHaveBeenCalledTimes(2);
    expect(read.writers).toHaveLength(1);
    expect(read.writers[0]!.lists[0]).toMatchObject({ id: "L1", complete: true, count: 12, stated: true });
    expect(read.response.outcome).toBe("answered");
    expect(read.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`12 follow-ups with owner Mara Lind and status open: ${items.map(item => item.label).join("; ")}.`]);
    expect(read.replies).toEqual([]);
    // Declared content instead (misdeclared), the same finish on the ten rows is accepted without reading on, and no list
    // is stated: the held shape for follow-ups, a Known limit.
    const content = await run([ask(text, need, "open", [], [LIST]), ask(text, need, "found", Array.from({ length: 10 }, (_, index) => `E${index + 1}`), [finish], "N1", "content"), count]);
    expect(content.port.list).toHaveBeenCalledOnce();
    expect(content.writers[0]!.lists[0]).toMatchObject({ id: "L1", complete: false, count: 10, stated: false });
    expect(content.response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: "You have 10 open follow-ups." }] }] });
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
      complete: true, count: 8, checked: 0, read_at: LIST_READ_AT, stated: true,
      members: MEMBERS.map((id, index) => ({ id, kind: "page", title: OCT4_NAMES[index], dates: PAGES[index]!.dates, date: PAGES[index]!.occurred_at, date_kind: "version_created", status: "current", checked: false })),
    }]);
    for (const page of PAGES) for (const hidden of [page.id, page.receipt_sha256, (page.citation as { permalink: string }).permalink]) expect(writerInputs(h)[0]!.user_prompt).not.toContain(hidden);
    expect(writer_evidence).toEqual(MEMBERS);
  });

  it("sends a sentence naming 4 of the 8 pages by their rows back once; repeated, code still states all 8 and says a claim was left out (CF5a)", async () => {
    const subset = { lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence: ["E1", "E2", "E3", "E4"] }], not_found: [] };
    const h = research([subset, subset]);
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(writerInputs(h)).toHaveLength(2);
    const repair = writerPrompt(h, 1);
    expect(repair.validation_error).toContain(ROWS_REASON);
    expect(repair.rejected_response).toContain("The pages created on October 4 are");
    // The repaired reply still rests on rows: code states all 8, leaves the sentence out, and the part is partial.
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNSUPPORTED }] });
    expect(response.parts[0]!.statements).toEqual([{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }]);
    // A writer that drops it after the repair gives the list alone, answered.
    const dropped = research([subset, { lists: [], sentences: [], not_found: [] }]);
    expect((await dropped.research.answerWithResearch({ question: OCT4 })).response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: fullStatement }] }] });
  });

  it("leaves out, with no repair, a sentence citing 4 rows and the list's id beside one opened section: it restates the list", async () => {
    // Research opened E1 (its section is E9). Rows and the list's id are no citations, so the sentence stands on E9 alone,
    // a part of a member of the stated list that no other need asks about (W1, W4).
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "Start here.")]) as EvidenceDeskResultV2);
    const subset = { lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence: ["L1", "E1", "E2", "E3", "E4", "E9"] }], not_found: [] };
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
      ask(OCT4, OCT4_NEED, "open", [], [{ tool: "open", args: { id: "E1" } }], "N1"),
      ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI),
      subset,
    ], october4Desk({ open }));
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(writerInputs(h)).toHaveLength(1);
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

  it("never answers what a listed page says from its row: \"Is DVT on hold?\" ends partial or not found, never answered (CF8)", async () => {
    // E3's title reads "Gate reviews — EVT pass, DVT hold, PVT pending".
    const text = "Is DVT on hold?";
    const need = "whether DVT is on hold";
    // (a) Declared content, a finish on the list is refused with what each kind of support is, never a change of kind;
    // research opens the page and answers from its text.
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "DVT is on hold pending fixture rework.")]) as EvidenceDeskResultV2);
    const read = harness([
      ask(text, need, "open", [], [OCT4_LIST], undefined, "content"), ask(text, need, "found", ["L1"], [finish], "N1", "content"),
      ask(text, need, "open", [], [{ tool: "open", args: { id: "E3" } }], "N1", "content"), ask(text, need, "found", ["E9"], [finish], "N1", "content"),
      { lists: [], sentences: [{ text: "DVT is on hold pending fixture rework.", evidence: ["E9"] }], not_found: [] },
    ], october4Desk({ open }));
    const answered = await read.research.answerWithResearch({ question: text });
    const hint = 'is found but cites no item whose full text you have read: a list shows which items exist and each member\'s title, dates, status and owner, never what an item says; open the items for what they say';
    expect(answered.research.rounds[1]!.rejected).toEqual([expect.stringContaining(`need N1 "${need}" ${hint}`)]);
    for (const word of ["which_items", "which_say", "kind"]) expect(answered.research.rounds[1]!.rejected[0]).not.toContain(word);
    expect(answered.response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: "DVT is on hold pending fixture rework." }] }] });
    expect(answered.response.parts[0]!.statements).toHaveLength(1);
    // (b) Declared which_items (misdeclared): code states L1, and a claim resting on the row goes back once.
    const claim = (evidence: readonly string[], lists: readonly unknown[] = []) => ({ lists, sentences: [{ text: "Yes, DVT is on hold, and EVT passed.", evidence }], not_found: [] });
    const nothing = { lists: [], sentences: [], not_found: ["whether DVT is on hold"] };
    const run = async (replies: readonly unknown[]) => {
      const h = harness([ask(text, need, "open", [], [OCT4_LIST]), ask(text, need, "found", ["L1"], [finish], "N1", WI), ...replies], october4Desk());
      return { h, ...(await h.research.answerWithResearch({ question: text })) };
    };
    for (const [replies, gap] of [
      // A repair that says it is not found: the list, and its gap.
      [[claim(["E3"], [{ id: "L1" }]), nothing], "Not found: whether DVT is on hold."],
      // A repeated claim, with the list in "lists" or its id beside the row: left out, and the part says so.
      [[claim(["E3"], [{ id: "L1" }]), claim(["E3"], [{ id: "L1" }])], UNSUPPORTED],
      [[claim(["E3", "L1"]), claim(["E3", "L1"])], UNSUPPORTED],
    ] as const) {
      const { h, response } = await run(replies);
      expect(writerInputs(h)).toHaveLength(2);
      expect(writerPrompt(h, 1).validation_error).toContain(ROWS_REASON);
      expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap }] });
      expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement]);
    }
    // A writer that says it found nothing, at once: one call, the list, and its gap.
    const { h, response } = await run([nothing]);
    expect(writerInputs(h)).toHaveLength(1);
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: fullStatement }], gap: "Not found: whether DVT is on hold." }] });
    // (c) Declared content and not found after the complete list, the opened page saying nothing of DVT: a claim resting on
    // the row, repeated, is left out, and the part names nothing; its gap makes the answer partial, never not found (W1, X28).
    const table = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "Gate reviews: the gate summary table.")]) as EvidenceDeskResultV2);
    for (const [repeated, gap] of [
      [claim(["E3"]), `I couldn't find this in the sources you can access. ${UNSUPPORTED}`],
      [{ ...claim(["E3"]), not_found: ["whether DVT is on hold"] }, `Not found: whether DVT is on hold. ${UNSUPPORTED}`],
    ] as const) {
      const absent = harness([
        ask(text, need, "open", [], [OCT4_LIST], undefined, "content"), ask(text, need, "open", [], opens(["E3"]), "N1", "content"),
        ask(text, need, "not_found", [], [finish], "N1", "content"), repeated, repeated,
      ], october4Desk({ open: table }));
      const left = await absent.research.answerWithResearch({ question: text });
      expect(left.research.stop).toEqual({ reason: "finished", completed: true });
      expect(writerInputs(absent)).toHaveLength(2);
      expect(left.response).toMatchObject({ outcome: "partial", citations: [], parts: [{ status: "not_found", statements: [], gap }] });
    }
  });

  it("states the plan's list beside a reply that found nothing, with no repair: the October 4 question gets its list (C6, R1, R8)", async () => {
    const nothing = { lists: [], sentences: [], not_found: ["Confluence pages created on October 4, 2026"] };
    const h = research([nothing]);
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(writerInputs(h)).toHaveLength(1);
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7] }], gap: "Not found: Confluence pages created on October 4, 2026." }] });
  });

  it("states a list in full and then a selection of its members by id, in either order, each member one name, beside a content sentence (R4, X2)", async () => {
    const text = "Which Confluence pages were created on October 4, 2026, and when was the PRD last updated?";
    // Part 1 asks which pages exist; part 2 one fact about the PRD, read from its section (E9), a content need.
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "PRD last updated October 4, 2026.")]) as EvidenceDeskResultV2);
    const needs = [[OCT4_NEED, "found", ["L1"], WI, "N1"], ["when the PRD was last updated", "found", ["E9"], "content", "N2"]] as const;
    const run = (writer: unknown) => harness([
      askAll(text, [[OCT4_NEED, "open", [], WI], ["when the PRD was last updated", "open", [], "content"]], [OCT4_LIST]),
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], ["when the PRD was last updated", "open", [], "content", "N2"]], [{ tool: "open", args: { id: "E5" } }]),
      askAll(text, needs, [finish]), writer,
    ], october4Desk({ open }));
    const facts = (title: string, updated = "October 4, 2026") => `${title} (status current, created October 4, 2026, updated ${updated})`;
    const prd = `1 of the 8 Confluence pages created on October 4, 2026: ${facts(OCT4_NAMES[4]!)}.`;
    const updated = { text: "The PRD was last updated on October 4, 2026.", evidence: ["E9"] };
    for (const lists of [[{ id: "L1", members: ["E5"] }, { id: "L1" }], [{ id: "L1" }, { id: "L1", members: ["E5"] }]]) {
      const h = run({ lists, sentences: [updated], not_found: [] });
      const { response } = await h.research.answerWithResearch({ question: text });
      expect(writerInputs(h)).toHaveLength(1);
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
      // The PRD's row is cited once, by both statements; part 2's need cites its section, so the writer's sentence stays (W4).
      expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement, prd, updated.text]);
      expect(response.citations).toHaveLength(9);
    }
    // Four pages selected by id beside the stated list: code states the list first, then their facts; 8 members named.
    const h = run({ lists: [{ id: "L1", members: ["E1", "E2", "E3", "E4"] }], sentences: [], not_found: [] });
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(writerInputs(h)).toHaveLength(1);
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      fullStatement, `4 of the 8 Confluence pages created on October 4, 2026: ${[facts(OCT4_NAMES[0]!, "October 5, 2026"), ...OCT4_NAMES.slice(1, 4).map(title => facts(title))].join("; ")}.`,
    ]);
    expect(response.citations).toHaveLength(8);
  });

  it("leaves out a sentence citing only a list's id after one repair, and says a claim was left out (R6, R10)", async () => {
    for (const text of ["All eight are current pages.", "All eight pages were created on October 4, 2026."]) {
      const summary = { text, evidence: ["L1"] };
      const repeated = research([{ lists: [{ id: "L1" }], sentences: [summary], not_found: [] }, { lists: [{ id: "L1" }], sentences: [summary], not_found: [] }]);
      const { response } = await repeated.research.answerWithResearch({ question: OCT4 });
      expect(writerInputs(repeated)).toHaveLength(2);
      expect(writerPrompt(repeated, 1).validation_error).toContain(ROWS_REASON);
      expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: fullStatement }], gap: UNSUPPORTED }] });
      expect(response.parts[0]!.statements).toHaveLength(1);
      // A writer that drops it after the repair: the list alone, answered.
      const dropped = research([{ lists: [], sentences: [summary], not_found: [] }, useL1]);
      const answered = (await dropped.research.answerWithResearch({ question: OCT4 })).response;
      expect(writerInputs(dropped)).toHaveLength(2);
      expect(answered).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: fullStatement }] }] });
      expect(answered.parts[0]).not.toHaveProperty("gap");
    }
  });

  it("writes the list itself when the writer gives no usable reply (X3)", async () => {
    const h = research([{ wrong: true }, { still: "wrong" }]);
    const { response } = await h.research.answerWithResearch({ question: OCT4 });
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: fullStatement }], gap: "I found these items, but could not write the rest of the answer." }] });
    expect(response.parts[0]).not.toHaveProperty("records");
  });

  const TICKETS = "Which Jira tickets were created on October 4, 2026?";
  const TICKETS_NEED = "tickets created on 2026-10-04";
  const TICKETS_LIST = { tool: "list", args: { source: "tickets", date_field: "created", since: "2026-10-04", until: "2026-10-04" } } as const;
  const ticketNames = (from: number, count: number) => tickets(from, count).map(item => item.label);

  it("names 25 of a 60-ticket list and says 'and 35 more', the count from ECHO's own list (X4)", async () => {
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

  it("states a which_items need's list with no members by its completeness: one not read to its end is never absence (W2, W3)", async () => {
    const text = "Which actions does Mara own?";
    const need = "actions owned by Mara";
    const run = (page: EvidenceDeskResultV2) => harness([
      ask(text, need, "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]),
      ask(text, need, "found", ["L1"], [finish], "N1", WI),
    ], { list: vi.fn(async () => page) }).research.answerWithResearch({ question: text });
    // The desk released 50 actions and cut the rest; none records Mara, so the list research read has no member and no end.
    const others = Array.from({ length: 50 }, (_, index) => listed(`x${index + 1}`, { kind: "action", attributes: { owner: "Dana Lee" } }));
    const cut = await run(result(others, { truncated: true }) as EvidenceDeskResultV2);
    expect(cut.research.stop).toEqual({ reason: "finished", completed: true });
    expect(cut.research.lists).toEqual([expect.objectContaining({ id: "L1", members: [], ended: true, truncated: true, complete: false })]);
    expect(cut.response).toMatchObject({ outcome: "partial", citations: [], parts: [{ status: "not_found", statements: [], gap: "I couldn't find this in the sources you can access. The list of meetings could not be read to its end, so more may exist." }] });
    // A source that could not serve the page: no rows, and a notice, so the list is not complete either.
    const down = await run(result([], { notice: "Meetings are temporarily unavailable." }) as EvidenceDeskResultV2);
    expect(down.research.lists).toEqual([expect.objectContaining({ id: "L1", members: [], available: false, complete: false })]);
    expect(down.response).toMatchObject({ outcome: "partial", parts: [{ status: "not_found", gap: "I couldn't find this in the sources you can access. The list of meetings could not be read to its end, so more may exist." }] });
    // A complete list with no member keeps the plain not-found answer.
    const none = await run(result([]) as EvidenceDeskResultV2);
    expect(none.research.lists).toEqual([expect.objectContaining({ id: "L1", members: [], complete: true })]);
    expect(none.response).toMatchObject({ outcome: "not_found", parts: [{ status: "not_found", gap: "I couldn't find this in the sources you can access." }] });
  });

  it("states, notes and filters every list the plan's kinds read, past the writer's five, within the response's bounds (X26)", async () => {
    // One list of Confluence pages a day, each its own: the writer sees five lists, and code reads every one.
    const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
    const page = (n: number) => pageRow([String(2_000_000 + n), `Day ${n} plan`, `${day(n)}T18:00:00.000Z`, `${day(n)}T18:00:00.000Z`, "1"]);
    const text = "Which Confluence pages were created on each day of October 2026 so far?";
    const need = "pages created on each day of October 2026";
    /** Lists days 1 to `days`, four a step, the `owner` day with an owner filter pages cannot apply; then opens `opened` and finishes on every list and `cited`. */
    const run = async (days: number, kind: string, writer: unknown, extra: { readonly owner?: number; readonly pages?: (n: number) => readonly EvidenceDeskItemV2[]; readonly opened?: readonly string[]; readonly cited?: readonly string[] } = {}) => {
      const ids = Array.from({ length: days }, (_, index) => `L${index + 1}`);
      const reads = Array.from({ length: Math.ceil(days / 4) }, (_, step) => Array.from({ length: Math.min(4, days - step * 4) }, (_, index) => step * 4 + index + 1)
        .map(n => ({ tool: "list", args: { source: "pages", date_field: "created", since: day(n), until: day(n), ...(n === extra.owner ? { owner: "Dana" } : {}) } })));
      const h = harness([
        ...reads.map((actions, step) => ask(text, need, "open", [], actions, step === 0 ? undefined : "N1", kind)),
        ...(extra.opened === undefined ? [] : [ask(text, need, "open", ids, opens(extra.opened), "N1", kind)]),
        ask(text, need, "found", [...ids, ...(extra.cited ?? [])], [finish], "N1", kind), writer,
      ], {
        live_sources: [CONFLUENCE], list: vi.fn(async (input: EvidenceDeskListInputV2) => result((extra.pages ?? (n => [page(n)]))(Number(String(input.since).slice(8, 10)))) as EvidenceDeskResultV2),
        open: vi.fn(async (input: { readonly item: string }) => result([section(page(Number(/\d+/u.exec(input.item)![0]) - 2_000_000), "It traces BUG-412 to TC-D-03.")]) as EvidenceDeskResultV2),
      });
      const { response, research: view } = await h.research.answerWithResearch({ question: text });
      expect(view.stop).toEqual({ reason: "finished", completed: true });
      expect(view.lists).toHaveLength(days);
      expect(writerPrompt(h).lists.map((list: { id: string }) => list.id)).toEqual(ids.slice(0, 5));
      return response;
    };
    const statementOf = (n: number) => `1 Confluence page created on October ${n}, 2026: Day ${n} plan.`;
    // A which_items need on six lists: six statements, the sixth list's filter notice too, whatever the writer saw.
    const six = await run(6, WI, { lists: [], sentences: [], not_found: [] }, { owner: 6 });
    expect(six).toMatchObject({ outcome: "answered", notice: "Confluence pages could not be filtered by owner, so this list is not limited to that owner." });
    expect(six.parts[0]!.statements.map(statement => statement.text)).toEqual([1, 2, 3, 4, 5, 6].map(statementOf));
    // On eleven lists, the response's ten statements hold the first ten, and the part says what did not fit.
    const eleven = await run(11, WI, { lists: [], sentences: [], not_found: [] });
    expect(eleven).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: "Some evidence could not fit in this response." }] });
    expect(eleven.parts[0]!.statements.map(statement => statement.text)).toEqual(Array.from({ length: 10 }, (_, index) => statementOf(index + 1)));
    // A which_say need checks six lists; the sixth has two pages, one opened (E6 releases E8): its note and gap.
    const checking = await run(6, WS, { lists: [], sentences: [{ text: "Day 6 plan traces BUG-412 to TC-D-03.", evidence: ["E8"] }], not_found: [] }, { pages: n => n === 6 ? [page(6), page(7)] : [page(n)], opened: ["E6"], cited: ["E8"] });
    expect(checking).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: "Day 6 plan traces BUG-412 to TC-D-03 (1 of 2 checked so far)." }], gap: UNCHECKED }] });
  });

  it("answers 'which are assigned to me' with only the members that owner records, and none as not found (X1)", async () => {
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

  it("keeps the list-end gap and the filter notice of a where selection that names nothing (W2, W7)", async () => {
    // 25 tickets of a list cut short, listed with an owner filter Jira cannot apply; the writer selects the blocked ones, of which there are none.
    const text = "Which of Dana's Jira tickets created on October 4, 2026 are blocked?";
    const run = async (truncated: boolean) => {
      const h = harness([
        ask(text, TICKETS_NEED, "open", [], [{ tool: "list", args: { ...TICKETS_LIST.args, owner: "Dana" } }]),
        ask(text, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI),
        { lists: [{ id: "L1", where: { field: "status", value: "Blocked" } }], sentences: [], not_found: [] },
      ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 25), { truncated }) as EvidenceDeskResultV2) });
      return (await h.research.answerWithResearch({ question: text })).response;
    };
    const notice = "Jira tickets could not be filtered by owner, so this list is not limited to that owner.";
    // A list not read to its end is never evidence of absence: the part names nothing, and the answer is partial.
    const cut = await run(true);
    expect(cut).toMatchObject({ outcome: "partial", citations: [], notice, parts: [{ status: "not_found", statements: [], gap: "Not found: Jira tickets created on October 4, 2026 that have status Blocked. The list of Jira tickets could not be read to its end, so more may exist." }] });
    // A complete list: the plain not-found answer, with the same notice.
    expect(await run(false)).toMatchObject({ outcome: "not_found", citations: [], notice, parts: [{ status: "not_found", statements: [], gap: "Not found: Jira tickets created on October 4, 2026 that have status Blocked." }] });
  });

  it("states a which_items need's list, and leaves out a sentence naming members from their opened text (CF7, CF9a, CF12c, R3, R5)", async () => {
    // Opening a page row releases its section as a new item: E1..E4 give E9..E12, E5..E8 give E13..E16.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, `${row.label}: created October 4.`)]) as EvidenceDeskResultV2;
    });
    const sections = ["E9", "E10", "E11", "E12"];
    const named = (evidence: readonly string[]) => ({ lists: [], sentences: [{ text: "The pages created on October 4 are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.", evidence }], not_found: [] });
    const cases: readonly { readonly opened: readonly string[]; readonly plans: readonly (readonly string[])[]; readonly writer: readonly string[] }[] = [
      // CF9a: a finish on the sections alone is refused once, naming the list their pages belong to; the repair cites it.
      { opened: MEMBERS.slice(0, 4), plans: [sections, ["L1", ...sections]], writer: sections },
      // R5 and CF7: four or all eight opened, the plan on L1 alone, the sentence citing the list's id beside four sections.
      { opened: MEMBERS.slice(0, 4), plans: [["L1"]], writer: ["L1", ...sections] },
      { opened: MEMBERS, plans: [["L1"]], writer: ["L1", ...sections] },
      // R3: the held trace's own finish, rows and sections cut to 12 ids, refused once, then with L1.
      { opened: MEMBERS.slice(0, 4), plans: [Array.from({ length: 12 }, (_, index) => `E${index + 1}`), ["L1", ...Array.from({ length: 12 }, (_, index) => `E${index + 1}`)]], writer: sections },
    ];
    for (const { opened, plans, writer } of cases) {
      const rounds = [opened.slice(0, 4), opened.slice(4)].filter(ids => ids.length > 0);
      const h = harness([
        ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]),
        ...rounds.map(ids => ask(OCT4, OCT4_NEED, "open", [], opens(ids), "N1")),
        ...plans.map(plan => ask(OCT4, OCT4_NEED, "found", plan, [finish], "N1", WI)),
        named(writer),
      ], october4Desk({ open }));
      const { response, research: view } = await h.research.answerWithResearch({ question: OCT4 });
      expect(view.rounds.at(-1)!.rejected).toEqual(plans.length === 1 ? [] : [expect.stringContaining("cites no list: cite the id of the list that holds its items (L1). ")]);
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: opened.length, stated: true });
      // One call: code states all 8, and the sentence cites only members' text no other need asks about (W4).
      expect(writerInputs(h)).toHaveLength(1);
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
      expect(response.parts[0]!.statements).toEqual([{ text: fullStatement, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7], private: true }]);
    }
    // R3's Jira shape: a ticket's open returns its body under the row's own id, so the sentence cites four members' text.
    const ticketOpen = vi.fn(async (input: { readonly item: string }) => {
      const n = Number(/THERM-(\d+)/u.exec(input.item)![1]);
      return result([ticketBody(n, `THERM-${n}: created October 4 for fixture work.`)]) as EvidenceDeskResultV2;
    });
    const twelve = Array.from({ length: 12 }, (_, index) => `E${index + 1}`);
    const h = harness([
      ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST]), ask(TICKETS, TICKETS_NEED, "open", [], opens(["E1", "E2", "E3", "E4"]), "N1"),
      ask(TICKETS, TICKETS_NEED, "found", twelve, [finish], "N1", WI), ask(TICKETS, TICKETS_NEED, "found", ["L1", ...twelve], [finish], "N1", WI),
      { lists: [], sentences: [{ text: "The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", evidence: ["E1", "E2", "E3", "E4"] }], not_found: [] },
    ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(1, 12), { page_full: false }) as EvidenceDeskResultV2), open: ticketOpen });
    const { response, research: view } = await h.research.answerWithResearch({ question: TICKETS });
    expect(view.rounds.at(-1)!.rejected).toEqual([expect.stringContaining("cites no list: cite the id of the list that holds its items (L1). ")]);
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 12, checked: 4, complete: true, stated: true });
    expect(writerInputs(h)).toHaveLength(1);
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([`12 Jira tickets created on October 4, 2026: ${ticketNames(1, 12).join("; ")}.`]);
  });

  it("answers what one listed page says from its row and opened section: a content need states no list (CF10)", async () => {
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
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", stated: false, checked: 1 });
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: "The gate review says DVT is on hold pending fixture rework.", citation_indexes: [0] }] }] });
  });

  it("accepts a finish on an opened page's row and section while that page's list is unfinished (CF12a)", async () => {
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

  it("says how many members were checked when a which_say need checks a list, whether or not the writer cites it (C2, CF4)", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, row.label.startsWith("Traceability") ? "BUG-412 is traced to TC-D-03." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages created on October 4, 2026 mention BUG-412?";
    const need = "pages created on 2026-10-04 that mention BUG-412";
    const sentence = "Traceability — requirement threads and BUG-412 walkthrough mentions BUG-412.";
    for (const evidence of [["L1", "E12"], ["E12"]]) {
      const h = harness([
        ask(text, need, "open", [], [OCT4_LIST]),
        ask(text, need, "open", [], opens(["E1", "E2", "E3", "E4"]), "N1"),
        ask(text, need, "found", ["L1", "E12"], [finish], "N1", WS),
        { lists: [], sentences: [{ text: sentence, evidence }], not_found: [] },
      ], october4Desk({ open }));
      const { response } = await h.research.answerWithResearch({ question: text });
      expect(open).toHaveBeenCalledTimes(4);
      expect(writerInputs(h)).toHaveLength(1);
      // A which_say need's list is checked, not stated: the writer sees it as not stated.
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 4, stated: false });
      expect(writerPrompt(h).lists[0].members.map((member: { checked: boolean }) => member.checked)).toEqual([true, true, true, true, false, false, false, false]);
      expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED }] });
      expect(response.parts[0]!.statements).toEqual([{ text: "Traceability — requirement threads and BUG-412 walkthrough mentions BUG-412 (4 of 8 checked so far).", citation_indexes: [0], private: true }]);
      expect(response.citations.map(citation => (citation.citation as { section_id: string }).section_id)).toEqual(["s1"]);
      open.mockClear();
    }
  });

  it("notes every sentence citing a which_say list's members' text, and states the list only when the writer uses it (C2, CF4)", async () => {
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
    const run = async (kind: string, plans: readonly (readonly string[])[], reply: unknown) => {
      const h = harness([
        ask(text, need, "open", [], [OCT4_LIST]), ask(text, need, "open", [], opens(["E1", "E2", "E3", "E4"]), "N1"),
        ...plans.map(plan => ask(text, need, "found", plan, [finish], "N1", kind)), reply,
      ], october4Desk({ open }));
      const { response, research: view } = await h.research.answerWithResearch({ question: text });
      expect(writerInputs(h)).toHaveLength(1);
      return { response, view };
    };
    const cases: readonly { readonly plan: readonly string[]; readonly reply: unknown; readonly said: readonly string[] }[] = [
      // The note follows the declaration: with no list use, only the noted sentence; with the list in "lists", code states it too.
      { plan: ["L1", "E12"], reply: say(one, ["E12"]), said: [noted(one)] },
      { plan: ["L1", "E12"], reply: say(one, ["E12"], [{ id: "L1" }]), said: [fullStatement, noted(one)] },
      // A section beside its own page's row: the row is no citation.
      { plan: ["L1", "E12"], reply: say(one, ["E12", "E4"], [{ id: "L1" }]), said: [fullStatement, noted(one)] },
      { plan: ["L1", "E9", "E10", "E11", "E12"], reply: say(two, ["E11", "E12"], [{ id: "L1" }]), said: [fullStatement, noted(two)] },
      // The October 4 subset beside the list it names: a which_say list's members' text is never a restatement, so it is noted (Known limit).
      { plan: ["L1", "E9", "E10", "E11", "E12"], reply: say(four, ["E9", "E10", "E11", "E12"], [{ id: "L1" }]), said: [fullStatement, noted(four)] },
      { plan: ["L1", "E11", "E12"], reply: say(two, ["E11", "E12"]), said: [noted(two)] },
    ];
    for (const { plan, reply, said } of cases) {
      const { response } = await run(WS, [plan], reply);
      expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED }] });
      expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual(said);
    }
    // A which_say finish on the sections alone is refused once, naming their list (F1); its repair cites it.
    const refused = await run(WS, [["E11", "E12"], ["L1", "E11", "E12"]], say(two, ["E11", "E12"]));
    expect(refused.view.rounds.at(-1)!.rejected).toEqual([expect.stringContaining(`need N1 "${need}" cites no list: cite the id of the list that holds its items (L1). `)]);
    expect(refused.response.parts[0]!.statements.map(statement => statement.text)).toEqual([noted(two)]);
    // Declared content (misdeclared), the same sections give an answered sentence with no note: a Known limit.
    for (const plan of [["E11", "E12"], ["E12"]]) {
      const { response } = await run("content", [plan], say(two, ["E11", "E12"]));
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: two }] }] });
      expect(response.parts[0]!.statements).toHaveLength(1);
    }
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

  it("states a meeting-action list by its own lines and leaves out the opened subset, or notes it for a which_say need (C7b, C7d, CF9d)", async () => {
    // A list row has no text; opening it returns the same item with its text, so research reads the member in full.
    const action = (index: number) => ({ kind: "action" as const, list_label: `Task ${index} (DVT review, 2026-10-01)`, attributes: { owner: "Mara Quinn" } });
    const rows = Array.from({ length: 8 }, (_, index) => listed(`a${index + 1}`, action(index + 1)));
    const bodies = new Map(rows.map((row, index) => [row.id, record(`a${index + 1}`, `Mara will do task ${index + 1}.`, action(index + 1))]));
    const open = vi.fn(async (input: { readonly item: string }) => result([bodies.get(input.item)!]) as EvidenceDeskResultV2);
    const opened = ["E1", "E2", "E3", "E4"];
    // Research declares what the question asks: which actions Mara owns (a list answers it), or which of them say something.
    const run = async (text: string, kind: string, plan: readonly string[]) => {
      const h = harness([
        ask(text, "actions owned by Mara", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]),
        ask(text, "actions owned by Mara", "open", [], opens(opened), "N1"),
        ask(text, "actions owned by Mara", "found", plan, [finish], "N1", kind),
        { lists: [], sentences: [{ text: "Mara owns tasks 1, 2, 3 and 4.", evidence: ["L1", ...opened] }], not_found: [] },
      ], { list: vi.fn(async () => result(rows) as EvidenceDeskResultV2), open });
      const { response, research: view } = await h.research.answerWithResearch({ question: text });
      expect(view.items.filter(item => item.read_in_full).map(item => item.id)).toEqual(opened);
      expect(writerInputs(h)).toHaveLength(1);
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", complete: true, count: 8, checked: 4, stated: kind === WI });
      return response;
    };
    // An opened meeting record keeps its row's id: the sentence cites four members' text, which only restates the list.
    const owned = await run("Which actions does Mara own?", WI, ["L1"]);
    expect(owned).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(owned.parts[0]!.statements.map(statement => statement.text)).toEqual([`8 actions with owner Mara: ${rows.map((_, index) => `Task ${index + 1} (DVT review, 2026-10-01)`).join("; ")}.`]);
    // A which_say need checks the list: the same sentence says what those 4 say, and the note keeps it from reading as complete.
    const across = await run("Which of Mara's actions name a numbered task?", WS, ["L1", ...opened]);
    expect(across).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED }] });
    expect(across.parts[0]!.statements.map(statement => statement.text)).toEqual(["Mara owns tasks 1, 2, 3 and 4 (4 of 8 checked so far)."]);
  });

  it("answers which pages mention BUG-412 once every page was checked: the sentence stands, with no note and no list (C2b, R2)", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, /^(Traceability|Gate reviews)/u.test(row.label) ? "BUG-412 is traced to TC-D-03." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages created on October 4, 2026 mention BUG-412?";
    const need = "pages created on 2026-10-04 that mention BUG-412";
    const two = "Gate reviews and Traceability mention BUG-412.";
    // Opening E1..E8 releases sections E9..E16: Gate reviews is E11, Traceability E12. Declared content, the same answer.
    for (const [kind, plan, evidence] of [[WS, ["L1", "E11", "E12"], ["L1", "E11", "E12"]], [WS, ["L1", "E11", "E12"], ["E11", "E12"]], ["content", ["E11", "E12"], ["E11", "E12"]]] as const) {
      const h = harness([
        ask(text, need, "open", [], [OCT4_LIST]),
        ask(text, need, "open", [], opens(MEMBERS.slice(0, 4)), "N1"),
        ask(text, need, "open", [], opens(MEMBERS.slice(4)), "N1"),
        ask(text, need, "found", plan, [finish], "N1", kind),
        { lists: [], sentences: [{ text: two, evidence }], not_found: [] },
      ], october4Desk({ open }));
      const { response } = await h.research.answerWithResearch({ question: text });
      expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 8, complete: true, stated: false });
      expect(writerInputs(h)).toHaveLength(1);
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: two, citation_indexes: [0, 1] }] }] });
      expect(response.parts[0]!.statements).toHaveLength(1);
    }
    // A model may open a page by its title: each open counts for the page it resolved to, so all eight are checked.
    const byTitle = (rows: readonly EvidenceDeskItemV2[]) => rows.map(row => ({ tool: "open", args: { id: row.label } }));
    const titled = harness([
      ask(text, need, "open", [], [OCT4_LIST]), ask(text, need, "open", [], byTitle(PAGES.slice(0, 4)), "N1"), ask(text, need, "open", [], byTitle(PAGES.slice(4)), "N1"),
      ask(text, need, "found", ["L1", "E11", "E12"], [finish], "N1", WS), { lists: [], sentences: [{ text: two, evidence: ["E11", "E12"] }], not_found: [] },
    ], october4Desk({ open }));
    const { response, research: view } = await titled.research.answerWithResearch({ question: text });
    expect(view.rounds[1]!.actions.map(action => [action.args.id, action.result.id])).toEqual(PAGES.slice(0, 4).map((row, index) => [row.label, MEMBERS[index]]));
    expect(writerPrompt(titled).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 8 });
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: two }] }] });
    expect(response.parts[0]!.statements).toHaveLength(1);
  });

  it("keeps a sentence about what a which_say list's members say beside the list a which_items need states, and repairs a rows sentence (W4, W1)", async () => {
    // Every page opened; one need asks which pages exist, one which of them mention BUG-412.
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, /^(Traceability|Gate reviews)/u.test(row.label) ? "BUG-412 is traced to TC-D-03." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages were created on October 4, 2026, and which of them mention BUG-412?";
    const content = { text: "Gate reviews and Traceability mention BUG-412.", evidence: ["L1", "E11", "E12"] };
    const rows = { text: "The PRD and the verification plan were also created that day.", evidence: ["E5", "E6"] };
    const run = (repaired: unknown) => {
      const needs = [[OCT4_NEED, "found", ["L1"], WI, "N1"], ["pages created on 2026-10-04 that mention BUG-412", "found", ["L1", "E11", "E12"], WS, "N2"]] as const;
      return harness([
        askAll(text, [[OCT4_NEED, "open", [], WI], ["pages created on 2026-10-04 that mention BUG-412", "open", [], WS]], [OCT4_LIST]),
        askAll(text, needs.map(([need, , , kind, id]) => [need, "open", [], kind, id] as const), opens(MEMBERS.slice(0, 4))),
        askAll(text, needs.map(([need, , , kind, id]) => [need, "open", [], kind, id] as const), opens(MEMBERS.slice(4))),
        askAll(text, needs, [finish]),
        { lists: [], sentences: [content, rows], not_found: [] }, repaired,
      ], october4Desk({ open }));
    };
    const h = run({ lists: [], sentences: [content], not_found: [] });
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(writerPrompt(h).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 8, stated: true });
    expect(writerInputs(h)).toHaveLength(2);
    expect(writerPrompt(h, 1).validation_error).toContain(ROWS_REASON);
    // L1 is a list a which_say need checks, so the sentence citing its members' text is no restatement (W4); every member
    // was checked, so it carries no note.
    expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement, content.text]);
    // A repeated rows sentence is left out, and the part says so.
    const repeated = (await run({ lists: [], sentences: [content, rows], not_found: [] }).research.answerWithResearch({ question: text })).response;
    expect(repeated).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNSUPPORTED }] });
    expect(repeated.parts[0]!.statements.map(statement => statement.text)).toEqual([fullStatement, content.text]);
  });

  it("reads a content need's list id as nothing: a one-ticket answer beside its list adds no note (R11)", async () => {
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

  it("notes a which_say list's members that keep their row ids when opened, until all are checked: tickets, actions and follow-ups alike (C7c, R2, R7)", async () => {
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
    expect(writerPrompt(all).lists[0]).toMatchObject({ id: "L1", count: 8, checked: 8, stated: false });
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

  it("names a meeting and each of its records once, the records by their own lines, never as that many meetings (CF3)", async () => {
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

  it("names one meeting's actions by their own lines, each with its own due date, though they share the meeting's label (C7a, CF6, X12)", async () => {
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

  it("gives a task goal over the same meeting rows the same model inputs, with or without their list labels (X12)", async () => {
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
    expect(writer.lists).toEqual([expect.objectContaining({ id: "L1", complete: false, count: 10, stated: false })]);
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

describe("Ask's declared kinds: the restructure's scenario corpus (ADR-0041)", () => {
  // Each test names the scenarios of the restructure design's table it pins; the rest are pinned above.
  const OCT4_NAMES = OCTOBER_4.map(([, title]) => title);
  const FULL8 = `8 Confluence pages created on October 4, 2026: ${OCT4_NAMES.join("; ")}.`;
  const writersOf = (h: ReturnType<typeof harness>) => h.inputs.filter(input => input.system_prompt.startsWith("You write"));
  /** Opening a page row releases one section, which mentions BUG-412 when the page's title matches `mentions`. */
  const pageOpen = (mentions: RegExp) => vi.fn(async (input: { readonly item: string }) => {
    const row = PAGES.find(page => page.id === input.item)!;
    return result([section(row, mentions.test(row.label) ? `${row.label}: BUG-412 is traced to TC-D-03.` : `${row.label}: no defects are discussed.`)]) as EvidenceDeskResultV2;
  });
  const NOBODY = /^$/u;
  const BUG = "Which pages created on October 4, 2026 mention BUG-412?";
  const BUG_NEED = "pages created on 2026-10-04 that mention BUG-412";
  const TRACE = "Traceability — requirement threads and BUG-412 walkthrough mentions BUG-412.";
  const FOUR = "The pages are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.";
  const SECTIONS = ["E9", "E10", "E11", "E12"];
  const say = (text: string, evidence: readonly string[], lists: readonly unknown[] = []) => ({ lists, sentences: [{ text, evidence }], not_found: [] });
  const noted = (text: string, note: string) => text.replace(/\.$/u, ` ${note}.`);
  /** An unusable step and an unusable repair: research stops, its plan the last accepted step's. */
  const UNUSABLE = [{ wrong: true }, { still: "wrong" }] as const;
  const TICKETS = "Which Jira tickets were created on October 4, 2026?";
  const TICKETS_NEED = "tickets created on 2026-10-04";
  const TICKETS_LIST = { tool: "list", args: { source: "tickets", date_field: "created", since: "2026-10-04", until: "2026-10-04" } } as const;
  const FOLLOW_UPS = { tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } } as const;
  /** Follow-ups with due dates: THERM-41 is overdue on October 18, THERM-43 and THERM-47 are due that week. */
  const DUES: Readonly<Record<number, readonly [string, string]>> = { 1: ["2026-10-09", "October 9, 2026"], 2: ["2026-10-30", "October 30, 2026"], 3: ["2026-10-20", "October 20, 2026"], 7: ["2026-10-22", "October 22, 2026"], 9: ["2026-11-02", "November 2, 2026"] };
  const dueItems = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1, DUES[index + 1]?.[0]));
  const FULL12 = `12 follow-ups with owner Mara Lind and status open: ${dueItems.map((item, index) => DUES[index + 1] === undefined ? item.label : `${item.label} (due ${DUES[index + 1]![1]})`).join("; ")}.`;
  const followUpFacts = (n: number) => `THERM-${40 + n} follow-up (status open, owner Mara Lind, due ${DUES[n]![1]})`;

  it("C1: states all 8 October 4 pages after the trace's own step 2 is refused once, whatever lists the writer gives", async () => {
    for (const writer of [{ lists: [], sentences: [], not_found: [] }, useL1]) {
      const h = harness([ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST]), ask(OCT4, OCT4_NEED, "found", MEMBERS, [finish], "N1", WI), ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WI), writer], october4Desk());
      const { response, research: view } = await h.research.answerWithResearch({ question: OCT4 });
      expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining("cites no list: cite the id of the list that holds its items (L1). ")]);
      expect(view.rounds[1]!.rejected[0]).not.toContain("keep reading");
      expect(writersOf(h)).toHaveLength(1);
      expect(response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: FULL8, citation_indexes: [0, 1, 2, 3, 4, 5, 6, 7] }] }] });
      expect(response.parts[0]!.statements).toHaveLength(1);
    }
  });

  it("C2: answers a which-say question declared content with no note, its list id carrying no meaning (misdeclared, a Known limit)", async () => {
    const h = harness([
      ask(BUG, BUG_NEED, "open", [], [OCT4_LIST]), ask(BUG, BUG_NEED, "open", [], opens(MEMBERS.slice(0, 4)), "N1"),
      ask(BUG, BUG_NEED, "found", ["L1", "E12"], [finish], "N1", "content"), say(TRACE, ["L1", "E12"]),
    ], october4Desk({ open: pageOpen(/^Traceability/u) }));
    const { response } = await h.research.answerWithResearch({ question: BUG });
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]).toEqual({ question: BUG, status: "answered", statements: [{ text: TRACE, citation_indexes: [0], private: true }] });
  });

  it("C3, C3b: answers one follow-up's due date from its text on the list's first page, stating no list, whether or not the need cites it", async () => {
    const text = "When is THERM-41 due?";
    const need = "THERM-41's due date";
    for (const evidence of [["E1"], ["L1", "E1"]]) {
      const desk = pagedDesk(dueItems);
      const { response, steps, writers, left } = await askV4(desk, text, [ask(text, need, "open", [], [FOLLOW_UPS], undefined, "content"), ask(text, need, "found", evidence, [finish], "N1", "content"), say("THERM-41 follow-up is due October 9, 2026.", ["E1"])]);
      // A content need never waits for a list's end: the finish is accepted on the first page.
      expect(steps).toHaveLength(2);
      expect(desk.list).toHaveBeenCalledOnce();
      expect(writers[0]!.lists[0]).toMatchObject({ id: "L1", complete: false, count: 10, stated: false });
      expect(response.parts[0]).toEqual({ question: text, status: "answered", statements: [{ text: "THERM-41 follow-up is due October 9, 2026.", citation_indexes: [0], private: false }] });
      expect(left).toEqual([]);
    }
  });

  it("C3c: states all 12 follow-ups for a due-date question declared which_items, and the member's facts by id; the writer's sentence restates the list (misdeclared)", async () => {
    const text = "When is THERM-41 due?";
    const need = "THERM-41's due date";
    const desk = pagedDesk(dueItems);
    const { response, steps } = await askV4(desk, text, [
      ask(text, need, "open", [], [FOLLOW_UPS], undefined, WI), ask(text, need, "found", ["L1"], [finish], "N1", WI),
      ask(text, need, "open", [], [FOLLOW_UPS], "N1", WI), ask(text, need, "found", ["L1"], [finish], "N1", WI),
      { lists: [{ id: "L1", members: ["E1"] }], sentences: [{ text: "THERM-41 follow-up is due October 9, 2026.", evidence: ["E1"] }], not_found: [] },
    ]);
    expect(steps[2]!.validation_error).toContain("list L1 is unfinished: keep reading the list");
    expect(desk.list).toHaveBeenCalledTimes(2);
    expect(response.outcome).toBe("answered");
    // A name shows its due date where members' due dates differ; THERM-41 costs one name.
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([FULL12, `1 of the 12 follow-ups with owner Mara Lind and status open: ${followUpFacts(1)}.`]);
    expect(response.citations).toHaveLength(12);
  });

  it("C4: opens one ticket for who owns it, a content need, and answers from its text or from its row facts selected by id", async () => {
    const text = "Who owns THERM-46?";
    const need = "THERM-46's owner";
    const open = vi.fn(async () => result([ticketBody(46, "THERM-46: fixture work, assigned to Dana Lee.")]) as EvidenceDeskResultV2);
    const run = async (writer: unknown) => {
      const h = harness([
        ask(text, need, "open", [], [{ tool: "list", args: { source: "tickets" } }], undefined, "content"), ask(text, need, "found", ["E6"], [finish], "N1", "content"),
        ask(text, need, "open", [], [{ tool: "open", args: { id: "E6" } }], "N1", "content"), ask(text, need, "found", ["E6"], [finish], "N1", "content"), writer,
      ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(41, 10)) as EvidenceDeskResultV2), open });
      return { h, ...(await h.research.answerWithResearch({ question: text })) };
    };
    const owned = await run(say("THERM-46 is owned by Dana Lee.", ["E6"]));
    // Its row alone is refused with what each kind of support is; opening it returns its body under the row's own id.
    expect(owned.research.rounds[1]!.rejected).toEqual([expect.stringContaining('need N1 "THERM-46\'s owner" is found but cites no item whose full text you have read: a list shows which items exist')]);
    expect(writersOf(owned.h)).toHaveLength(1);
    expect(owned.response.parts[0]).toEqual({ question: text, status: "answered", statements: [{ text: "THERM-46 is owned by Dana Lee.", citation_indexes: [0], private: true }] });
    const facts = await run({ lists: [{ id: "L1", members: ["E6"] }], sentences: [], not_found: [] });
    expect(facts.response.parts[0]).toEqual({ question: text, status: "answered", statements: [{ text: "1 of the 10 Jira tickets: THERM-46: Fixture work 46 (status In Progress, owner Dana Lee, created October 4, 2026).", citation_indexes: [0], private: true }] });
  });

  it("C4b: states the whole list for a one-ticket question declared which_items, the ticket named once (misdeclared)", async () => {
    const text = "Who owns THERM-46?";
    const need = "THERM-46's owner";
    const h = harness([
      ask(text, need, "open", [], [{ tool: "list", args: { source: "tickets" } }], undefined, WI), ask(text, need, "found", ["L1"], [finish], "N1", WI),
      { lists: [{ id: "L1", members: ["E6"] }], sentences: [], not_found: [] },
    ], { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result(tickets(41, 10)) as EvidenceDeskResultV2) });
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([
      `10 Jira tickets: ${tickets(41, 10).map(item => item.label).join("; ")}.`, "1 of the 10 Jira tickets: THERM-46: Fixture work 46 (status In Progress, owner Dana Lee, created October 4, 2026).",
    ]);
    expect(response.citations).toHaveLength(10);
  });

  it("CF1: states a Jira list read to its end in full, with no 'at least', though one summary was cut to its label bound", async () => {
    // The reader's side, a cut summary never marking the page truncated, is pinned in the Jira reader's own tests.
    const cut = Object.freeze({ ...ticketRow(1), label: `THERM-1: ${"温度计固件校准流程".repeat(9)}…` });
    const h = harness([ask(TICKETS, TICKETS_NEED, "open", [], [TICKETS_LIST]), ask(TICKETS, TICKETS_NEED, "found", ["L1"], [finish], "N1", WI), useL1],
      { live_sources: [JIRA], ticket_available: true, list: vi.fn(async () => result([cut, ...tickets(2, 5)], { page_full: false }) as EvidenceDeskResultV2) });
    const { response } = await h.research.answerWithResearch({ question: TICKETS });
    expect(response.outcome).toBe("answered");
    expect(response.parts[0]).not.toHaveProperty("gap");
    expect(response.parts[0]!.statements[0]!.text).toBe(`6 Jira tickets created on October 4, 2026: ${cut.label}; ${tickets(2, 5).map(item => item.label).join("; ")}.`);
  });

  it("CF8c, CF8d: follows a list kind on a one-page question: the list alone for which_items, the checked note for which_say (misdeclared, Known limits)", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "DVT is on hold pending fixture rework.")]) as EvidenceDeskResultV2);
    const hold = say("DVT is on hold pending fixture rework.", ["E9"]);
    // (c) "What does the gate review page say?" declared which_items beside the section: code states L1, and the section's
    // sentence restates one of its members, so the content is lost.
    const text = "What does the gate review page say about DVT?";
    const need = "what the gate review page says about DVT";
    const stated = harness([ask(text, need, "open", [], [OCT4_LIST], undefined, WI), ask(text, need, "open", [], opens(["E3"]), "N1", WI), ask(text, need, "found", ["L1", "E9"], [finish], "N1", WI), hold], october4Desk({ open }));
    const c = (await stated.research.answerWithResearch({ question: text })).response;
    expect(writersOf(stated)).toHaveLength(1);
    expect(c).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: FULL8 }] }] });
    expect(c.parts[0]!.statements).toHaveLength(1);
    // (d) "Is DVT on hold?" declared which_say: refused until a page is read, then noted and partial.
    const question2 = "Is DVT on hold?";
    const need2 = "whether DVT is on hold";
    const checking = harness([
      ask(question2, need2, "open", [], [OCT4_LIST], undefined, WS), ask(question2, need2, "found", ["L1"], [finish], "N1", WS),
      ask(question2, need2, "open", [], opens(["E3"]), "N1", WS), ask(question2, need2, "found", ["L1", "E9"], [finish], "N1", WS), hold,
    ], october4Desk({ open }));
    const d = await checking.research.answerWithResearch({ question: question2 });
    expect(d.research.rounds[1]!.rejected).toEqual([expect.stringContaining("is found but cites no item whose full text you have read: a list shows which items exist")]);
    expect(d.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED, statements: [{ text: "DVT is on hold pending fixture rework (1 of 8 checked so far)." }] }] });
  });

  it("CF9b, CF9c: follows a content declaration on the October 4 shape: the 4-name sentence is answered, the list stated only when the writer uses it (Known limit)", async () => {
    for (const plan of [SECTIONS, ["L1", ...SECTIONS]]) for (const lists of [[], [{ id: "L1" }]]) {
      const h = harness([
        ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST], undefined, "content"), ask(OCT4, OCT4_NEED, "open", [], opens(MEMBERS.slice(0, 4)), "N1", "content"),
        ask(OCT4, OCT4_NEED, "found", plan, [finish], "N1", "content"), say(FOUR, SECTIONS, lists),
      ], october4Desk({ open: pageOpen(NOBODY) }));
      const { response } = await h.research.answerWithResearch({ question: OCT4 });
      expect(writersOf(h)).toHaveLength(1);
      expect(response.outcome).toBe("answered");
      expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual(lists.length === 0 ? [FOUR] : [FULL8, FOUR]);
    }
  });

  it("CF10b, CF12b: answers what one page says from its section when the content need also cites the list or the page's row: no list, no note", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => result([section(PAGES.find(page => page.id === input.item)!, "DVT is on hold pending fixture rework.")]) as EvidenceDeskResultV2);
    const text = "What does the gate review page created on October 4 say about DVT?";
    const need = "what the gate review page says about DVT";
    const sentence = "The gate review says DVT is on hold pending fixture rework.";
    for (const plan of [["L1", "E9"], ["E3", "E9"]]) {
      const h = harness([ask(text, need, "open", [], [OCT4_LIST]), ask(text, need, "open", [], opens(["E3"]), "N1"), ask(text, need, "found", plan, [finish], "N1", "content"), say(sentence, ["E9"])], october4Desk({ open }));
      const { response, research: view } = await h.research.answerWithResearch({ question: text });
      expect(view.rounds.map(round => round.rejected)).toEqual([[], [], []]);
      expect(response.parts[0]).toEqual({ question: text, status: "answered", statements: [{ text: sentence, citation_indexes: [0], private: true }] });
    }
  });

  it("CF11: refuses a which_items finish on ten follow-up rows once; reading page 2 gets all 12 stated, a repair on L1 alone leaves the part partial", async () => {
    const items = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1));
    const twelve = `12 follow-ups with owner Mara Lind and status open: ${items.map(item => item.label).join("; ")}.`;
    const text = "What are my open follow-ups?";
    const need = "my open follow-ups";
    const ten = Array.from({ length: 10 }, (_, index) => `E${index + 1}`);
    // (i) and (iii): the repair reads page 2; the writer's two names cite members' text, which only restates the list.
    const read = await askV4(pagedDesk(items), text, [
      ask(text, need, "open", [], [FOLLOW_UPS], undefined, WI), ask(text, need, "found", ten, [finish], "N1", WI),
      ask(text, need, "open", [], [FOLLOW_UPS], "N1", WI), ask(text, need, "found", ["L1"], [finish], "N1", WI), say("Your open follow-ups are THERM-41 and THERM-42.", ["E1", "E2"]),
    ]);
    expect(read.steps[2]!.validation_error).toContain(`need N1 "${need}" cites no list: cite the id of the list that holds its items (L1); part 1 need N1 "${need}": list L1 is unfinished: keep reading the list`);
    expect(read.response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(read.response.parts[0]!.statements.map(statement => statement.text)).toEqual([twelve]);
    // (ii): a repair that only cites L1 is refused again; research stops with step 1's plan, whose need cites no list.
    const repaired = await askV4(pagedDesk(items), text, [
      ask(text, need, "open", [], [FOLLOW_UPS], undefined, WI), ask(text, need, "found", ten, [finish], "N1", WI), ask(text, need, "found", ["L1"], [finish], "N1", WI),
      say("You have 10 open follow-ups.", ten),
    ]);
    expect(repaired.writers[0]!.research).toMatchObject({ completed: false, stop_reason: "unusable_step" });
    expect(repaired.writers[0]!.lists[0]).toMatchObject({ id: "L1", stated: false });
    expect(repaired.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: "You have 10 open follow-ups." }], gap: WHICH }] });
  });

  it("X5: makes a which_items need research left on rows, or open, partial when it stops: the writer's sentence stays, and no list is stated", async () => {
    // A read step proposes the need found on the rows while opening four pages; research then stops before any finish.
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST], undefined, WI), ask(OCT4, OCT4_NEED, "found", MEMBERS, opens(MEMBERS.slice(0, 4)), "N1", WI), ...UNUSABLE, say(FOUR, SECTIONS),
    ], october4Desk({ open: pageOpen(NOBODY) }));
    const { response, research: view } = await h.research.answerWithResearch({ question: OCT4 });
    expect(view.stop).toEqual({ reason: "unusable_step", completed: false });
    expect(view.plan[0]!.needs).toEqual([{ need: OCT4_NEED, kind: "which_items", status: "found", evidence: MEMBERS }]);
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: FOUR }], gap: WHICH }] });
    expect(response.parts[0]!.statements).toHaveLength(1);
    // Left open when research stops for no progress (relisting finds nothing new), the need cites no list: partial too.
    const relist = (date_field: string) => ask(OCT4, OCT4_NEED, "open", [], [{ tool: "list", args: { ...OCT4_LIST.args, date_field } }], "N1", WI);
    const idle = harness([ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST], undefined, WI), relist("updated"), relist("created"), relist("updated"), { lists: [], sentences: [], not_found: ["Confluence pages created on October 4, 2026"] }], october4Desk());
    const stopped = await idle.research.answerWithResearch({ question: OCT4 });
    expect(stopped.research.stop).toEqual({ reason: "no_progress", completed: false });
    expect(stopped.response.outcome).toBe("partial");
    expect(stopped.response.parts[0]!.gap).toContain(WHICH);
  });

  it("X6: tells the person a list's filter when the writer chooses to state it, and never for a list nothing names", async () => {
    const actions = [
      record("a1", "Dana will publish the dashboard.", { kind: "action", attributes: { owner: "Dana Lee", status: "open" } }),
      record("a2", "Dana will order samples.", { kind: "action", attributes: { owner: "Dana Lee" } }),
    ];
    const text = "Who publishes the dashboard, and which actions are still open?";
    const need = "who publishes the dashboard";
    const run = async (lists: readonly unknown[]) => {
      const h = harness([
        ask(text, need, "open", [], [{ tool: "list", args: { source: "meetings", status: "open" } }], undefined, "content"), ask(text, need, "found", ["E1"], [finish], "N1", "content"),
        say("Dana will publish the dashboard.", ["E1"], lists),
      ], { list: vi.fn(async () => result(actions) as EvidenceDeskResultV2) });
      return (await h.research.answerWithResearch({ question: text })).response;
    };
    const chosen = await run([{ id: "L1" }]);
    expect(chosen.parts[0]!.statements.map(statement => statement.text)).toEqual(["2 actions with status open: Meeting a1 (open); Meeting a2.", "Dana will publish the dashboard."]);
    expect(chosen.notice).toBe("Actions were filtered by status only where they record one, so this list also includes items that record none.");
    expect(await run([])).not.toHaveProperty("notice");
  });

  it("X7: refuses a which_say finish before any page was read, offering no change of kind; declared which_items, the content is left out (Known limit)", async () => {
    const open = pageOpen(/^Traceability/u);
    // (a) The refusal says what each kind of support is, never which kind the need should be.
    const early = harness([ask(BUG, BUG_NEED, "open", [], [OCT4_LIST], undefined, WS), ask(BUG, BUG_NEED, "found", ["L1"], [finish], "N1", WS), UNUSABLE[0], { lists: [], sentences: [], not_found: [BUG_NEED] }], october4Desk({ open }));
    const a = await early.research.answerWithResearch({ question: BUG });
    expect(a.research.rounds[1]!.rejected[0]).toContain("is found but cites no item whose full text you have read: a list shows which items exist and each member's title, dates, status and owner, never what an item says; open the items for what they say");
    for (const word of ["which_items", "which_say", "kind"]) expect(a.research.rounds[1]!.rejected[0]).not.toContain(word);
    expect(a.research.stop).toEqual({ reason: "unusable_step", completed: false });
    expect(open).not.toHaveBeenCalled();
    // (b) Declared which_items beside the Traceability section: code states the list, and the section's sentence restates one member.
    const stated = harness([ask(BUG, BUG_NEED, "open", [], [OCT4_LIST], undefined, WI), ask(BUG, BUG_NEED, "open", [], opens(MEMBERS.slice(0, 4)), "N1", WI), ask(BUG, BUG_NEED, "found", ["L1", "E12"], [finish], "N1", WI), say(TRACE, ["E12"])], october4Desk({ open }));
    const b = (await stated.research.answerWithResearch({ question: BUG })).response;
    expect(writersOf(stated)).toHaveLength(1);
    expect(b).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: FULL8 }] }] });
    expect(b.parts[0]!.statements).toHaveLength(1);
  });

  it("X9, X9b: answers a not_found which_say need over the list it checked with the unchecked gap, after one refusal when it cites no list", async () => {
    const text = "Which pages created on October 4, 2026 mention BUG-999?";
    const need = "pages created on 2026-10-04 that mention BUG-999";
    const nothing = { lists: [], sentences: [], not_found: ["pages created on October 4 that mention BUG-999"] };
    const run = (finishes: readonly unknown[]) => harness([ask(text, need, "open", [], [OCT4_LIST], undefined, WS), ask(text, need, "open", [], opens(MEMBERS.slice(0, 4)), "N1", WS), ...finishes, nothing], october4Desk({ open: pageOpen(NOBODY) }));
    for (const finishes of [[ask(text, need, "not_found", ["L1"], [finish], "N1", WS)], [ask(text, need, "not_found", [], [finish], "N1", WS), ask(text, need, "not_found", ["L1"], [finish], "N1", WS)]]) {
      const h = run(finishes);
      const { response, research: view } = await h.research.answerWithResearch({ question: text });
      expect(view.stop).toEqual({ reason: "finished", completed: true });
      expect(view.rounds.at(-1)!.rejected).toHaveLength(finishes.length - 1);
      expect(writersOf(h)).toHaveLength(1);
      expect(response).toMatchObject({ outcome: "not_found", citations: [], parts: [{ status: "not_found", statements: [], gap: `Not found: pages created on October 4 that mention BUG-999. ${UNCHECKED}` }] });
    }
    // A repair that repeats the shape ends research; its plan's which_say need cites no list: partial, never an unqualified not_found.
    const repeated = run([ask(text, need, "not_found", [], [finish], "N1", WS), ask(text, need, "not_found", [], [finish], "N1", WS)]);
    const { response, research: view } = await repeated.research.answerWithResearch({ question: text });
    expect(view.stop).toEqual({ reason: "unusable_step", completed: false });
    expect(response.outcome).toBe("partial");
    expect(response.parts[0]!.gap).toContain("Missing context: pages created on October 4 that mention BUG-999.");
    expect(response.parts[0]!.gap).toContain(WHICH);
  });

  it("X9c, X10: makes a which_say need that research left without its list partial when it stops: not found, or a sentence with no note", async () => {
    const open = pageOpen(/^Traceability/u);
    // X9c: a read step proposes not_found, citing nothing; research stops before any finish.
    const absent = harness([
      ask(BUG, BUG_NEED, "open", [], [OCT4_LIST], undefined, WS), ask(BUG, BUG_NEED, "not_found", [], opens(MEMBERS.slice(0, 4)), "N1", WS), ...UNUSABLE,
      { lists: [], sentences: [], not_found: ["pages created on October 4 that mention BUG-412"] },
    ], october4Desk({ open }));
    const notFound = await absent.research.answerWithResearch({ question: BUG });
    expect(notFound.research.plan[0]!.needs).toEqual([{ need: BUG_NEED, kind: "which_say", status: "not_found", evidence: [] }]);
    expect(notFound.response.outcome).toBe("partial");
    expect(notFound.response.parts[0]!.gap).toContain(WHICH);
    // X10: left open, citing no list; the writer's sentence about Traceability stays, with no note, since no list is checked.
    const open10 = harness([
      ask(BUG, BUG_NEED, "open", [], [OCT4_LIST], undefined, WS), ask(BUG, BUG_NEED, "open", [], opens(MEMBERS.slice(0, 4)), "N1", WS), ...UNUSABLE, say(TRACE, ["E12"]),
    ], october4Desk({ open }));
    const kept = (await open10.research.answerWithResearch({ question: BUG })).response;
    expect(kept).toMatchObject({ outcome: "partial", parts: [{ status: "partial", statements: [{ text: TRACE }], gap: WHICH }] });
  });

  it("X11, X11b: never waits for the end of a which_say follow-up list and notes it; its absence still waits for the end", async () => {
    const items = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1));
    const fan = "Which of my open follow-ups are about the fan curve?";
    const fanNeed = "my open follow-ups about the fan curve";
    const curve = "THERM-42 follow-up and THERM-44 follow-up say to ship fan curve v2 before DVT.";
    const found = await askV4(pagedDesk(items), fan, [ask(fan, fanNeed, "open", [], [FOLLOW_UPS], undefined, WS), ask(fan, fanNeed, "found", ["L1", "E2", "E4"], [finish], "N1", WS), say(curve, ["E2", "E4"])]);
    expect(found.steps).toHaveLength(2);
    // Every shown follow-up row was read in full, so all 10 were checked, of a list with a next page.
    expect(found.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED, statements: [{ text: noted(curve, "(10 of at least 10 checked so far)") }] }] });
    const oven = "Which of my open follow-ups are about the oven?";
    const ovenNeed = "my open follow-ups about the oven";
    const absent = await askV4(pagedDesk(items), oven, [
      ask(oven, ovenNeed, "open", [], [FOLLOW_UPS], undefined, WS), ask(oven, ovenNeed, "not_found", ["L1"], [finish], "N1", WS),
      ask(oven, ovenNeed, "open", [], [FOLLOW_UPS], "N1", WS), ask(oven, ovenNeed, "not_found", ["L1"], [finish], "N1", WS),
      { lists: [], sentences: [], not_found: ["open follow-ups about the oven"] },
    ]);
    expect(absent.steps[2]!.validation_error).toContain("is not_found after fewer than two completed searches or a completed list");
    // All 12 rows were shown, so all were checked: no note and no gap of its own.
    expect(absent.response).toMatchObject({ outcome: "not_found", parts: [{ status: "not_found", statements: [], gap: "Not found: open follow-ups about the oven." }] });
  });

  it("X12: makes a list statement private when one member it names is", async () => {
    const rows = [
      listed("a1", { kind: "action", list_label: "Publish the DVT dashboard (DVT review, 2026-10-01)", attributes: { owner: "Mara Quinn" } }),
      listed("a2", { kind: "action", visibility: "approver_only", list_label: "Order fixture spares (DVT review, 2026-10-01)", attributes: { owner: "Mara Quinn" } }),
    ];
    const text = "Which actions does Mara own?";
    const h = harness([ask(text, "actions owned by Mara", "open", [], [{ tool: "list", args: { source: "meetings", owner: "Mara" } }]), ask(text, "actions owned by Mara", "found", ["L1"], [finish], "N1", WI), useL1], { list: vi.fn(async () => result(rows) as EvidenceDeskResultV2) });
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(response.parts[0]!.statements).toEqual([{ text: "2 actions with owner Mara: Publish the DVT dashboard (DVT review, 2026-10-01); Order fixture spares (DVT review, 2026-10-01).", citation_indexes: [0, 1], private: true }]);
  });

  it("X13: notes a content sentence about a member of a which_say list too (Known limit)", async () => {
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, row.label.startsWith("Traceability") ? "BUG-412 is traced to TC-D-03." : row.label.startsWith("PRD") ? "Readings within 0.1 C." : "No defects are discussed.")]) as EvidenceDeskResultV2;
    });
    const text = "Which pages created on October 4, 2026 mention BUG-412, and what does the PRD require?";
    const prdNeed = "what the PRD requires";
    const h = harness([
      askAll(text, [[BUG_NEED, "open", [], WS], [prdNeed, "open", [], "content"]], [OCT4_LIST]),
      askAll(text, [[BUG_NEED, "open", [], WS, "N1"], [prdNeed, "open", [], "content", "N2"]], opens(MEMBERS.slice(0, 4))),
      askAll(text, [[BUG_NEED, "open", [], WS, "N1"], [prdNeed, "open", [], "content", "N2"]], opens(["E5"])),
      askAll(text, [[BUG_NEED, "found", ["L1", "E12"], WS, "N1"], [prdNeed, "found", ["E13"], "content", "N2"]], [finish]),
      { lists: [], sentences: [{ text: TRACE, evidence: ["E12"] }, { text: "The PRD requires readings within 0.1 C.", evidence: ["E13"] }], not_found: [] },
    ], october4Desk({ open }));
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([noted(TRACE, "(5 of 8 checked so far)"), "The PRD requires readings within 0.1 C (5 of 8 checked so far)."]);
  });

  it("X14: notes the October 4 subset for a which-items question declared which_say, and states no list unless the writer uses it (Known limit)", async () => {
    const h = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST], undefined, WS), ask(OCT4, OCT4_NEED, "found", ["L1"], [finish], "N1", WS),
      ask(OCT4, OCT4_NEED, "open", ["L1"], opens(MEMBERS.slice(0, 4)), "N1", WS), ask(OCT4, OCT4_NEED, "found", ["L1", ...SECTIONS], [finish], "N1", WS), say(FOUR, SECTIONS),
    ], october4Desk({ open: pageOpen(NOBODY) }));
    const { response, research: view } = await h.research.answerWithResearch({ question: OCT4 });
    expect(view.rounds[1]!.rejected).toEqual([expect.stringContaining("is found but cites no item whose full text you have read")]);
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([noted(FOUR, "(4 of 8 checked so far)")]);
    // Once all 8 were opened, as the stop rule asks, there is no note and no gap: the 4-name sentence is answered (Known limit).
    const all = harness([
      ask(OCT4, OCT4_NEED, "open", [], [OCT4_LIST], undefined, WS), ask(OCT4, OCT4_NEED, "open", ["L1"], opens(MEMBERS.slice(0, 4)), "N1", WS),
      ask(OCT4, OCT4_NEED, "open", ["L1"], opens(MEMBERS.slice(4)), "N1", WS), ask(OCT4, OCT4_NEED, "found", ["L1", ...SECTIONS], [finish], "N1", WS), say(FOUR, SECTIONS),
    ], october4Desk({ open: pageOpen(NOBODY) }));
    const checked = (await all.research.answerWithResearch({ question: OCT4 })).response;
    expect(checked.parts[0]).toEqual({ question: OCT4, status: "answered", statements: [{ text: FOUR, citation_indexes: [0, 1, 2, 3], private: true }] });
    expect(checked.outcome).toBe("answered");
  });

  it("X15: keeps both sentences, noted, when a which_items and a which_say need share a list (Known limit)", async () => {
    const text = "Which pages were created on October 4, 2026, and which of them mention BUG-412?";
    const h = harness([
      askAll(text, [[OCT4_NEED, "open", [], WI], [BUG_NEED, "open", [], WS]], [OCT4_LIST]),
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [BUG_NEED, "open", [], WS, "N2"]], opens(MEMBERS.slice(0, 4))),
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [BUG_NEED, "found", ["L1", "E12"], WS, "N2"]], [finish]),
      { lists: [], sentences: [{ text: TRACE, evidence: ["E12"] }, { text: FOUR, evidence: SECTIONS }], not_found: [] },
    ], october4Desk({ open: pageOpen(/^Traceability/u) }));
    const { response } = await h.research.answerWithResearch({ question: text });
    expect(response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED }] });
    expect(response.parts[0]!.statements.map(statement => statement.text)).toEqual([FULL8, noted(TRACE, "(4 of 8 checked so far)"), noted(FOUR, "(4 of 8 checked so far)")]);
    // Once all 8 were opened, neither carries a note: the restated subset stands unqualified beside the 8 names (Known limit).
    const all = harness([
      askAll(text, [[OCT4_NEED, "open", [], WI], [BUG_NEED, "open", [], WS]], [OCT4_LIST]),
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [BUG_NEED, "open", [], WS, "N2"]], opens(MEMBERS.slice(0, 4))),
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [BUG_NEED, "open", [], WS, "N2"]], opens(MEMBERS.slice(4))),
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [BUG_NEED, "found", ["L1", "E12"], WS, "N2"]], [finish]),
      { lists: [], sentences: [{ text: TRACE, evidence: ["E12"] }, { text: FOUR, evidence: SECTIONS }], not_found: [] },
    ], october4Desk({ open: pageOpen(/^Traceability/u) }));
    const checked = (await all.research.answerWithResearch({ question: text })).response;
    expect(checked).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(checked.parts[0]!.statements.map(statement => statement.text)).toEqual([FULL8, TRACE, FOUR]);
  });

  it("X17: states a where date range with its condition; a selection by id of the same members states their facts, never the condition", async () => {
    const text = "Which of my open tasks are due this week?";
    const need = "my open follow-ups due from 2026-10-18 to 2026-10-24";
    const week = { text: "THERM-43 follow-up and THERM-47 follow-up are due this week.", evidence: ["E3", "E7"] };
    // Follow-ups take no date filter: research reads the whole list, and the writer selects by due date.
    const run = (lists: readonly unknown[], sentences: readonly unknown[] = [week]) => askV4(pagedDesk(dueItems), text, [
      ask(text, need, "open", [], [FOLLOW_UPS], undefined, WI), ask(text, need, "open", [], [FOLLOW_UPS], "N1", WI), ask(text, need, "found", ["L1"], [finish], "N1", WI),
      { lists, sentences, not_found: [] },
    ], { now: "2026-10-18T17:00:00.000Z" });
    const lead = "of the 12 follow-ups with owner Mara Lind and status open";
    // (a) The writer's sentence only restates members of the stated list, so it is left out.
    const a = await run([{ id: "L1", where: { field: "due", since: "2026-10-18", until: "2026-10-24" } }]);
    expect(a.writers[0]).toMatchObject({ today: "2026-10-18" });
    expect(a.response).toMatchObject({ outcome: "answered", parts: [{ status: "answered" }] });
    expect(a.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`2 ${lead} are due from October 18 to October 24, 2026: THERM-43 follow-up (due October 20, 2026); THERM-47 follow-up (due October 22, 2026).`]);
    // (b) The same members by id: the list in full, then their facts; the condition is not said (Known limit).
    const b = await run([{ id: "L1", members: ["E3", "E7"] }]);
    expect(b.response.outcome).toBe("answered");
    expect(b.response.parts[0]!.statements.map(statement => statement.text)).toEqual([FULL12, `2 ${lead}: ${followUpFacts(3)}; ${followUpFacts(7)}.`]);
    // (c) A range no member's due date falls in: no statement, and the selection's not-found phrase.
    const c = await run([{ id: "L1", where: { field: "due", since: "2026-10-23", until: "2026-10-29" } }], []);
    expect(c.response).toMatchObject({ outcome: "not_found", citations: [], parts: [{ status: "not_found", statements: [], gap: "Not found: follow-ups with owner Mara Lind and status open due from October 23 to October 29, 2026." }] });
    // (d) "Which are overdue?": an open range through yesterday.
    const d = await run([{ id: "L1", where: { field: "due", until: "2026-10-17" } }], []);
    expect(d.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`1 ${lead} is due through October 17, 2026: THERM-41 follow-up.`]);
  });

  it("X18: selects pages by an updated date on a list read by creation date, each day the list's time zone's", async () => {
    // Late on Oct 10 in UTC (Oct 11 in Tokyo), early on Oct 11 in UTC (Oct 10 in Los Angeles), Oct 12, and one page with no updated date.
    const updates = ["2026-10-10T23:30:00.000Z", "2026-10-11T03:00:00.000Z", "2026-10-12T09:00:00.000Z"];
    const rows = PAGES.map((row, index) => {
      const { updated: _updated, ...created } = row.dates!;
      return Object.freeze({ ...row, dates: index === 3 ? created : updates[index] === undefined ? row.dates : { ...row.dates, updated: updates[index] } });
    });
    const desk = () => pagedDesk(rows, { live_sources: [CONFLUENCE], size: 50 });
    const text = "Which of the Confluence pages created on October 4, 2026 were updated after October 10?";
    const need = "pages created on 2026-10-04";
    const run = (time_zone: string, writer: unknown, repair?: unknown) => askV4(desk(), text, [
      ask(text, need, "open", [], [OCT4_LIST], undefined, WI), ask(text, need, "found", ["L1"], [finish], "N1", WI), writer, ...(repair === undefined ? [] : [repair]),
    ], { now: "2026-10-18T01:00:00.000Z", time_zone });
    const since = { lists: [{ id: "L1", where: { field: "updated", since: "2026-10-11" } }], sentences: [], not_found: [] };
    const tokyo = await run("Asia/Tokyo", since);
    expect(tokyo.response.outcome).toBe("answered");
    expect(tokyo.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`3 of the 8 Confluence pages created on October 4, 2026 were updated since October 11, 2026: ${OCT4_NAMES.slice(0, 3).join("; ")}.`]);
    const angeles = await run("America/Los_Angeles", since);
    expect(angeles.response.parts[0]!.statements.map(statement => statement.text)).toEqual([`1 of the 8 Confluence pages created on October 4, 2026 was updated since October 11, 2026: ${OCT4_NAMES[2]}.`]);
    // (b) A sentence on a row's date alone goes back once, the reason naming where; repeated, the list stands and the part is partial.
    const claim = { lists: [], sentences: [{ text: "The PRD was updated after October 10.", evidence: ["E5"] }], not_found: [] };
    const repeated = await run("UTC", claim, claim);
    expect(repeated.writers[1]!.validation_error).toContain('through "lists" (with "where" or "members")');
    expect(repeated.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNSUPPORTED }] });
    expect(repeated.response.parts[0]!.statements.map(statement => statement.text)).toEqual([FULL8]);
  });

  it("X19: answers which Jira tickets mention BUG-412 from search as content; declared a list kind, it follows the declaration (Known limits)", async () => {
    const hits = [1, 4, 9, 12, 38, 46, 47, 48, 50];
    const all = Array.from({ length: 60 }, (_, index) => ticketRow(index + 1));
    const desk = () => ({
      live_sources: [JIRA], ticket_available: true,
      search: vi.fn(async () => result(hits.map(n => ticketBody(n, `THERM-${n}: references BUG-412.`))) as EvidenceDeskResultV2),
      list: vi.fn(async (input: EvidenceDeskListInputV2) => (input.cursor === undefined ? result(all.slice(0, 50), { next_cursor: "page-2", page_full: false }) : result(all.slice(50), { page_full: false })) as EvidenceDeskResultV2),
    });
    const text = "Which Jira tickets mention BUG-412?";
    const need = "Jira tickets that mention BUG-412";
    const SEARCH = { tool: "search", args: { query: "BUG-412", source: "tickets" } } as const;
    const LIST = { tool: "list", args: { source: "tickets" } } as const;
    const found = hits.map((_, index) => `E${index + 1}`);
    const named = say(`${hits.map(n => `THERM-${n}`).join(", ")} mention BUG-412.`, found);
    // (a) Content: search finds the hits, which are read in full; the writer names them. No list, no note.
    const content = harness([ask(text, need, "open", [], [SEARCH], undefined, "content"), ask(text, need, "found", found, [finish], "N1", "content"), named], desk());
    const a = (await content.research.answerWithResearch({ question: text })).response;
    expect(a.parts[0]).toEqual({ question: text, status: "answered", statements: [{ text: named.sentences[0]!.text, citation_indexes: found.map((_, index) => index), private: true }] });
    // (b) which_say: refused until it cites a list; research lists the source's first page (25 rows shown, of which 4 are
    // hits), and the note measures little.
    const say412 = harness([
      ask(text, need, "open", [], [SEARCH], undefined, WS), ask(text, need, "found", found, [finish], "N1", WS), ask(text, need, "open", found, [LIST], "N1", WS),
      ask(text, need, "found", ["L1", ...found], [finish], "N1", WS), named,
    ], desk());
    const b = await say412.research.answerWithResearch({ question: text });
    expect(b.research.rounds[1]!.rejected).toEqual([expect.stringContaining("cites no list: cite the id of the list that holds its items (from lists), or list them first")]);
    expect(b.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: UNCHECKED, statements: [{ text: noted(named.sentences[0]!.text, "(4 of at least 25 checked so far)") }] }] });
    // (c) which_items: research reads the whole source, code states it, and the sentence naming the hits restates its members.
    const read = ask(text, need, "open", [], [LIST], "N1", WI);
    const onList = ask(text, need, "found", ["L1"], [finish], "N1", WI);
    const items412 = harness([ask(text, need, "open", [], [SEARCH], undefined, WI), ask(text, need, "found", found, [finish], "N1", WI), read, onList, read, onList, read, onList, named], desk());
    const { response: c, research: view } = await items412.research.answerWithResearch({ question: text });
    // Each finish before the list's end is refused with "keep reading"; research shows 25 rows a page, so 60 take three reads.
    expect(view.rounds.flatMap(round => round.rejected).filter(reason => reason.includes("keep reading the list"))).toHaveLength(2);
    expect(view.lists).toEqual([expect.objectContaining({ id: "L1", shown: 60, ended: true, complete: true })]);
    expect(c.outcome).toBe("answered");
    expect(c.parts[0]!.statements.map(statement => statement.text)).toEqual([`60 Jira tickets: ${all.slice(0, 25).map(item => item.label).join("; ")}; and 35 more.`]);
  });

  it("X20: asks research to read every listed page for a which_say need, and answers with no note once it has", async () => {
    // Seven of the eight pages mention BUG-412 in the export; ECHO Product Pipeline — Start Here (E1, section E9) does not.
    const h = harness([
      ask(BUG, BUG_NEED, "open", [], [OCT4_LIST], undefined, WS), ask(BUG, BUG_NEED, "open", ["L1"], opens(MEMBERS.slice(0, 4)), "N1", WS),
      ask(BUG, BUG_NEED, "open", ["L1"], opens(MEMBERS.slice(4)), "N1", WS), ask(BUG, BUG_NEED, "found", ["L1", "E10", "E11", "E12", "E13", "E14", "E15", "E16"], [finish], "N1", WS),
      say("Seven of the eight pages mention BUG-412: every page but ECHO Product Pipeline — Start Here.", ["E10", "E11", "E12", "E13", "E14", "E15", "E16"]),
    ], october4Desk({ open: pageOpen(/^(?!ECHO Product Pipeline)/u) }));
    const { response } = await h.research.answerWithResearch({ question: BUG });
    // The stop rule asks research on a which_say need to read every member its list has shown, without waiting for its end.
    expect(h.inputs[0]!.system_prompt).toContain("for a which_say need, once you have seen the full text of every member its list has shown, or no other member can be opened.");
    expect(response.parts[0]).toEqual({ question: BUG, status: "answered", statements: [{ text: "Seven of the eight pages mention BUG-412: every page but ECHO Product Pipeline — Start Here.", citation_indexes: [0, 1, 2, 3, 4, 5, 6], private: true }] });
  });

  it("X27: keeps a sentence on a stated list member's text while a need research left declares nothing it asks about (W4)", async () => {
    const text = "Which Confluence pages were created on October 4, 2026, and is the DVT gate on hold?";
    const DVT_NEED = "whether the DVT gate is on hold";
    const DVT = "The Gate reviews page says the DVT gate is on hold pending fixture rework.";
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, /^Gate reviews/u.test(row.label) ? `${row.label}: the DVT gate is on hold pending fixture rework.` : `${row.label}: BUG-412 is traced to TC-D-03.`)]) as EvidenceDeskResultV2;
    });
    const run = async (steps: readonly unknown[], writer: unknown) => {
      const h = harness([askAll(text, [[OCT4_NEED, "open", [], WI], [DVT_NEED, "open", []]], [OCT4_LIST]), ...steps, writer], october4Desk({ open }));
      return h.research.answerWithResearch({ question: text });
    };
    // Research stops with the content need open: it cites nothing, so code cannot tell the Gate reviews sentence restates the list.
    const stopped = await run([askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [DVT_NEED, "open", [], "content", "N2"]], opens(["E3"])), ...UNUSABLE], say(DVT, ["E9"]));
    expect(stopped.research.stop).toEqual({ reason: "unusable_step", completed: false });
    expect(stopped.response).toMatchObject({ outcome: "answered", notice: "Research stopped before it finished, so relevant context may be missing." });
    expect(stopped.response.parts[0]!.statements.map(statement => statement.text)).toEqual([FULL8, DVT]);
    // So too a which_say need research left without its list: the sentence stays, and the part says the list was not confirmed.
    const unlisted = await run([askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [BUG_NEED, "open", [], WS, "N2"]], opens(["E4"])), ...UNUSABLE], say(TRACE, ["E9"]));
    expect(unlisted.response).toMatchObject({ outcome: "partial", parts: [{ status: "partial", gap: WHICH }] });
    expect(unlisted.response.parts[0]!.statements.map(statement => statement.text)).toEqual([FULL8, TRACE]);
    // Once every need declares, a content need found on another item asks nothing of Gate reviews: its sentence restates the list (Known limit).
    const found = await run([
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [DVT_NEED, "open", [], "content", "N2"]], opens(["E3", "E4"])),
      askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [DVT_NEED, "found", ["E10"], "content", "N2"]], [finish]),
    ], say(DVT, ["E9"]));
    expect(found.research.stop).toEqual({ reason: "finished", completed: true });
    expect(found.response).toMatchObject({ outcome: "answered", parts: [{ status: "answered", statements: [{ text: FULL8 }] }] });
    expect(found.response.parts[0]!.statements).toHaveLength(1);
  });

  it("X27d, X27e: reads what a content need declares from the items it cites, whatever its status (W4)", async () => {
    const text = "Which Confluence pages were created on October 4, 2026, and is the DVT gate on hold?";
    const DVT_NEED = "whether the DVT gate is on hold";
    const DVT = "The Gate reviews page says the DVT gate is on hold pending fixture rework.";
    const RESTATE = "Traceability — requirement threads and BUG-412 walkthrough was created on October 4, 2026.";
    const open = vi.fn(async (input: { readonly item: string }) => {
      const row = PAGES.find(page => page.id === input.item)!;
      return result([section(row, /^Gate reviews/u.test(row.label) ? `${row.label}: the DVT gate is on hold pending fixture rework.` : `${row.label}: created for the October 4 document set.`)]) as EvidenceDeskResultV2;
    });
    // A read step opens Gate reviews (E3, its section E9) and Traceability (E4, E10) with the content need as given; research then stops.
    const run = async (status: "open" | "found", evidence: readonly string[]) => {
      const h = harness([
        askAll(text, [[OCT4_NEED, "open", [], WI], [DVT_NEED, "open", []]], [OCT4_LIST]),
        askAll(text, [[OCT4_NEED, "found", ["L1"], WI, "N1"], [DVT_NEED, status, evidence, "content", "N2"]], opens(["E3", "E4"])), ...UNUSABLE,
        { lists: [], sentences: [{ text: DVT, evidence: ["E9"] }, { text: RESTATE, evidence: ["E10"] }], not_found: [] },
      ], october4Desk({ open }));
      const { response, research } = await h.research.answerWithResearch({ question: text });
      expect(research.stop).toEqual({ reason: "unusable_step", completed: false });
      return response.parts[0]!.statements.map(statement => statement.text);
    };
    // Left open on the section it found the answer in, the need declares Gate reviews, as it does once found: the
    // restatement of Traceability is left out and the DVT sentence stays.
    expect(await run("open", ["E9"])).toEqual([FULL8, DVT]);
    expect(await run("found", ["E9"])).toEqual([FULL8, DVT]);
    // A content need's list ids carry no meaning: citing only L1 it declares nothing, like one citing nothing, so no
    // sentence is left out as a restatement.
    expect(await run("found", ["L1"])).toEqual([FULL8, DVT, RESTATE]);
    expect(await run("open", [])).toEqual([FULL8, DVT, RESTATE]);
  });

  it("X30: names a page two stated lists hold once against the answer's 25 names, whatever each list's use (W6)", async () => {
    const text = "Which Confluence pages were created from October 1 to 7, 2026, and which were updated that week?";
    const WEEK = Array.from({ length: 20 }, (_, index) => pageRow([String(600_000 + index), `Page ${String(index + 1).padStart(2, "0")}`, "2026-10-02T12:00:00.000Z", "2026-10-03T12:00:00.000Z", "1"]));
    const ids = WEEK.map((_, index) => `E${index + 1}`);
    const list = (date_field: string) => ({ tool: "list", args: { source: "pages", date_field, since: "2026-10-01", until: "2026-10-07" } });
    const names = async (lists: readonly unknown[]) => {
      const h = harness([
        askAll(text, [["pages created that week", "open", [], WI], ["pages updated that week", "open", [], WI]], [list("created"), list("updated")]),
        askAll(text, [["pages created that week", "found", ["L1"], WI, "N1"], ["pages updated that week", "found", ["L2"], WI, "N2"]], [finish]),
        { lists, sentences: [], not_found: [] },
      ], { live_sources: [CONFLUENCE], list: vi.fn(async () => result(WEEK) as EvidenceDeskResultV2) });
      const { response, research } = await h.research.answerWithResearch({ question: text });
      expect(research.lists!.map(value => value.members)).toEqual([ids, ids]);
      expect(response.outcome).toBe("answered");
      return response.parts[0]!.statements.map(statement => (statement.text.match(/Page \d\d/gu) ?? []).length);
    };
    // Both lists hold the same 20 pages, so each statement names all 20: 20 distinct names, within the answer's 25.
    expect(await names([])).toEqual([20, 20]);
    expect(await names([{ id: "L1", where: { field: "status", value: "current" } }, { id: "L2", where: { field: "status", value: "current" } }])).toEqual([20, 20]);
    // Selected by id, each list's use merges with its use in full (W2); its pages still cost one name each.
    expect(await names([{ id: "L1", members: ids }, { id: "L2", members: ids }])).toEqual([20, 20]);
  });
});

describe("a task goal keeps the rules before ADR-0041", () => {
  it("sees inventories, never lists, cites no list id and records none (X16)", async () => {
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
    // Its step schema and plan declare no kind (ADR-0041).
    const needSchema = (h.inputs[0]!.schema as { properties: { parts: { items: { properties: { needs: { items: { required: readonly string[]; properties: object } } } } } } }).properties.parts.items.properties.needs.items;
    expect(needSchema.required).toEqual(["need", "status", "evidence"]);
    expect(needSchema.properties).not.toHaveProperty("kind");
    expect((h.prompt(1).plan as { needs: object[] }[])[0]!.needs[0]).not.toHaveProperty("kind");
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
