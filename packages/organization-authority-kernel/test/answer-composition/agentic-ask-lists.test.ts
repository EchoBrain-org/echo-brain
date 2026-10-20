import { describe, expect, it, vi } from "vitest";
import { askQuestionCompletionProblemsV1, askResearchCompletionProblemsV1, type AskResearchListV1 } from "../../src/answer-composition/agentic-ask-research-state-v1.js";
import { createAgenticAskV4, type createAgenticResearchV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { agenticStartingSlotV1, type AgenticBriefV1 } from "../../src/answer-composition/agentic-brief-v1.js";
import { agenticListMembershipV1 } from "../../src/answer-composition/agentic-list-evidence-v1.js";
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import { AuthorityOperationError } from "../../src/domain/errors.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1 } from "../../src/shared/follow-up-evidence-v1.js";
import { CONFLUENCE, followUpItem, ids, JIRA, OCT4_TITLES, pageRow, PAGES, pager, section, ticketBody, ticketRow, tickets } from "./fixtures/agentic-lists.js";
import { checked, generation, LIST_READ_AT, listed, record, researchHarness as harness, result } from "./fixtures/agentic-scenarios.js";

/**
 * Ask's lists as evidence of which items exist (ADR-0041), as scenario rows: a question, a desk, research's scripted
 * steps and the writer's replies, and the answer's outcome, statements, notes and gaps. Each row's id is its rule or
 * its row of the restructure design's scenario table (C, CF, R, X). The runner also requires every scripted reply
 * to be used and no other model call, so a row pins how many steps and writer calls it takes. A task goal keeps the
 * rules before ADR-0041.
 */

type Kind = "which_items" | "which_say" | "content";
type NeedState = readonly [status: "open" | "found" | "not_found", evidence: readonly string[], kind?: Kind, need?: string];
type Step = { readonly actions: readonly unknown[]; readonly needs: readonly NeedState[] } | Readonly<Record<string, unknown>>;
type Prompt = Record<string, any>;
interface Run {
  readonly h: { readonly inputs: readonly StructuredGenerationInput[]; readonly port: any }; readonly response: any; readonly research: any; readonly writer_evidence: unknown;
  readonly part: any; readonly steps: readonly Prompt[]; readonly writer: readonly Prompt[];
}
interface Row {
  readonly id: string; readonly name: string; readonly q: string; readonly need?: string; readonly needs?: readonly string[];
  readonly desk: () => Partial<EvidenceDeskPortV2>; readonly v4?: { readonly now?: string; readonly time_zone?: string };
  readonly steps: readonly Step[]; readonly w: readonly unknown[];
  readonly out: string; readonly status?: string; readonly says?: readonly unknown[]; readonly gap?: string; readonly notice?: string;
  readonly stop?: string; readonly rejected?: readonly string[]; readonly repaired?: true; readonly citations?: number; readonly listed?: number;
  readonly wl?: object; readonly step?: readonly [number, object]; readonly lists?: readonly object[]; readonly check?: (run: Run) => void;
}

const WI = "which_items", WS = "which_say", C = "content";
const FINISH = { tool: "finish", args: {} } as const;
/** A research step: its actions, and each need's state in the row's need order. */
const step = (actions: readonly unknown[], ...needs: NeedState[]): Step => ({ actions, needs });
const read = (actions: readonly unknown[], kind?: Kind, status: NeedState[0] = "open", evidence: readonly string[] = []) => step(actions, [status, evidence, kind]);
const fin = (kind: Kind | undefined, ...evidence: string[]) => step([FINISH], ["found", evidence, kind]);
const none = (kind?: Kind, ...evidence: string[]) => step([FINISH], ["not_found", evidence, kind]);
const opens = (values: readonly string[]) => values.map(id => ({ tool: "open", args: { id } }));
/** An unusable step and an unusable repair: research stops, its plan the last accepted step's. */
const UNUSABLE = [{ wrong: true }, { still: "wrong" }];
const BAD = ['"parts" must be an array (got keys "wrong")', '"parts" must be an array (got keys "still")'];
const use = (...lists: readonly unknown[]) => ({ lists, sentences: [], not_found: [] });
const say = (text: string, evidence: readonly string[], lists: readonly unknown[] = []) => ({ lists, sentences: [{ text, evidence }], not_found: [] });
const sayAll = (sentences: readonly (readonly [string, readonly string[]])[]) => ({ lists: [], sentences: sentences.map(([text, evidence]) => ({ text, evidence })), not_found: [] });
const nothing = (...not_found: string[]) => ({ lists: [], sentences: [], not_found });
const EMPTY = use();
const useL1 = use({ id: "L1" });
const cite = (text: string, count: number, shared = false) => ({ text, citation_indexes: Array.from({ length: count }, (_, index) => index), private: !shared });
const noted = (text: string, note: string) => text.replace(/\.$/u, ` ${note}.`);
const of8 = (count: number) => `(${count} of 8 checked so far)`;

const ROWS_REASON = 'a sentence cites list rows or list ids but no evidence text: code states which items exist, and members\' title, dates, status and owner, through "lists" (with "where" or "members"); what no evidence text says belongs in "not_found"';
const UNSUPPORTED = "Part of the answer was left out because no item's text supports it.";
const UNCHECKED = "Not every listed item was checked, so others may also match.";
const WHICH = "I could not confirm the full list of items asked for.";
const MISSING = "I couldn't find this in the sources you can access.";
const FIT = "Some evidence could not fit in this response.";
const STOPPED = "Research stopped before it finished, so relevant context may be missing.";
const COVERAGE = "Some source coverage was incomplete, so relevant context may be missing.";
const INCOMPLETE = "I couldn't complete the search. Please try again.";
const UNLISTED = "cites no list: cite the id of the list that holds its items";
const HINT = 'is found but cites no item whose full text you have read: a list shows which items exist and each member\'s title, dates, status and owner, never what an item says; open the items for what they say';
const ABSENT = "is not_found after fewer than two completed searches or a completed list";
const leg = (noun: string) => `The list of ${noun} could not be read to its end, so more may exist.`;
const ownerNotice = (noun: string) => `${noun} could not be filtered by owner, so this list is not limited to that owner.`;
const partialNotice = (noun: string) => `${noun} were filtered by status only where they record one the filter can match, so this list also includes items it could not filter.`;

// ---- desks ----------------------------------------------------------------------------------------------------

/** The October 4 desk: its Confluence list returns the 8 rows, read to their end; opening a row releases one section. */
function oct4({ team = false, more = false, ...desk }: { readonly team?: boolean; readonly more?: boolean } & Partial<EvidenceDeskPortV2> = {}): Partial<EvidenceDeskPortV2> {
  const rows = team ? PAGES.map(page => Object.freeze({ ...page, visibility: "team" as const })) : PAGES;
  return {
    live_sources: [CONFLUENCE], list: vi.fn(async input => result(input.source === "confluence" ? rows : [], more ? { next_cursor: "page-2", page_full: false } : {}) as EvidenceDeskResultV2),
    open: vi.fn(async input => { const row = rows.find(page => page.id === input.item)!; return result([section(row, `${row.label}: its first section.`)]) as EvidenceDeskResultV2; }), ...desk,
  };
}
/** Jira over `rows`, `size` a page; with `body`, opening a ticket returns its body under the row's own id. */
function jira(rows: readonly EvidenceDeskItemV2[], { size = 50, more = {}, last = {}, body, ...desk }: { readonly size?: number; readonly more?: object; readonly last?: object; readonly body?: (n: number) => string } & Partial<EvidenceDeskPortV2> = {}): Partial<EvidenceDeskPortV2> {
  return {
    live_sources: [JIRA], ticket_available: true, list: pager(rows, size, more, last),
    ...(body === undefined ? {} : { open: vi.fn(async (input: { readonly item: string }) => { const n = Number(/THERM-(\d+)/u.exec(input.item)![1]); return result([ticketBody(n, body(n))]) as EvidenceDeskResultV2; }) }), ...desk,
  };
}
const bodyText = (n: number) => `THERM-${n}: Fixture work ${n}\n\n${n === 3 || n === 5 ? "Repro steps reference BUG-412." : "No defects referenced."}`;
/** Meeting records listed as rows; with `bodies`, opening one returns its own text under the row's id. */
const meetings = (rows: readonly EvidenceDeskItemV2[], bodies?: (index: number) => EvidenceDeskItemV2, desk: Partial<EvidenceDeskPortV2> = {}): Partial<EvidenceDeskPortV2> => ({
  list: vi.fn(async () => result(rows) as EvidenceDeskResultV2),
  ...(bodies === undefined ? {} : { open: vi.fn(async (input: { readonly item: string }) => result([bodies(rows.findIndex(row => row.id === input.item))]) as EvidenceDeskResultV2) }), ...desk,
});
/** ECHO's follow-ups over a global desk, listed `size` a page (as ECHO pages them, 10 at a time). */
const followUps = (items: readonly EvidenceDeskItemV2[], size = 10, desk: Partial<EvidenceDeskPortV2> = {}): Partial<EvidenceDeskPortV2> => ({
  scope: { kind: "global" }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1], list: pager(items, size, { page_full: false }, { page_full: false }),
  search: vi.fn(async () => result([]) as EvidenceDeskResultV2), open: vi.fn(async () => result([]) as EvidenceDeskResultV2), revalidate: vi.fn(async () => checked), ...desk,
});
/** Ask's V4 core (V7 answers, the first that cite follow-ups), asked by Mara Lind. */
function askV4(replies: (input: StructuredGenerationInput) => unknown, desk: EvidenceDeskPortV2, { now = LIST_READ_AT, time_zone }: NonNullable<Row["v4"]>) {
  const inputs: StructuredGenerationInput[] = [];
  const research = createAgenticAskV4({
    desk, generation, audit: { append: () => undefined }, asker: { display_name: "Mara Lind" }, wall_ms: () => Date.parse(now), ...(time_zone === undefined ? {} : { time_context: { now, time_zone } }),
    model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); const reply = replies(input); if (reply === undefined) throw new Error("unscripted call"); return reply; } },
  }) as unknown as ReturnType<typeof createAgenticResearchV1>;
  return { research, inputs, port: desk };
}

// ---- the runner ---------------------------------------------------------------------------------------------

const prompts = (inputs: readonly StructuredGenerationInput[], writer: boolean) =>
  inputs.filter(input => input.system_prompt.startsWith("You write") === writer).map(input => JSON.parse(input.user_prompt) as Prompt);
/** Scripted replies: research's steps in order, with the question and need texts filled in, and the writer's replies in order. */
function script(q: string, needs: readonly string[], steps: readonly Step[], writes: readonly unknown[]) {
  const queue = steps.map((value, index) => !("needs" in value) ? value : {
    parts: [{ question: q, needs: (value.needs as readonly NeedState[]).map(([status, evidence, kind, need], n) => ({ ...(index === 0 ? {} : { id: `N${n + 1}` }), need: need ?? needs[n], ...(kind === undefined ? {} : { kind }), status, evidence })), notes: "" }],
    actions: value.actions,
  });
  const written = [...writes];
  return { replies: (input: StructuredGenerationInput) => (input.system_prompt.startsWith("You write") ? written : queue).shift(), left: () => ({ steps: queue, writes: written }) };
}
async function run(row: Row) {
  const { replies, left } = script(row.q, row.needs ?? [row.need!], row.steps, row.w);
  const h = row.v4 === undefined ? harness(replies, row.desk()) : askV4(replies, row.desk() as EvidenceDeskPortV2, row.v4);
  const { response, research, writer_evidence } = await h.research.answerWithResearch({ question: row.q }) as { response: any; research: any; writer_evidence: unknown };
  const part = response.parts[0];
  const ran: Run = { h, response, research, writer_evidence, part, steps: prompts(h.inputs, false), writer: prompts(h.inputs, true) };
  expect(left()).toEqual({ steps: [], writes: [] });
  expect({ outcome: response.outcome, status: part.status, gap: part.gap, notice: response.notice, rejected: research.rounds.flatMap((round: any) => round.rejected) })
    .toEqual({ outcome: row.out, status: row.status ?? row.out, gap: row.gap, notice: row.notice, rejected: (row.rejected ?? []).map(text => expect.stringContaining(text)) });
  if (row.says !== undefined) expect(part.statements.map((value: any, index: number) => typeof row.says![index] === "object" && row.says![index] !== null && "text" in row.says![index] ? value : value.text)).toEqual(row.says);
  if (row.stop !== undefined) expect(research.stop.reason).toBe(row.stop);
  if (row.repaired) expect(ran.writer[1]!.validation_error).toContain(ROWS_REASON);
  if (row.citations !== undefined) expect(response.citations).toHaveLength(row.citations);
  if (row.listed !== undefined) expect(h.port.list).toHaveBeenCalledTimes(row.listed);
  if (row.wl !== undefined) expect(ran.writer[0]!.lists[0]).toMatchObject(row.wl);
  if (row.step !== undefined) expect(ran.steps[row.step[0]]).toMatchObject(row.step[1]);
  if (row.lists !== undefined) expect(research.lists).toEqual(row.lists.map(value => expect.objectContaining(value)));
  row.check?.(ran);
}

/** One test per row, named by its id. */
const scenarios = (rows: readonly Row[]) => { for (const row of rows) it(`${row.id}: ${row.name}`, () => run(row)); };

// ---- shared scenario facts ----------------------------------------------------------------------------------

const OCT4 = "Which Confluence pages were created on October 4, 2026?";
const OCT4_NEED = "list of Confluence pages created on 2026-10-04";
const OCT4_LIST = { tool: "list", args: { date_field: "created", since: "2026-10-04", source: "pages", until: "2026-10-04" } } as const;
const FULL8 = `8 Confluence pages created on October 4, 2026: ${OCT4_TITLES.join("; ")}.`;
const O4 = { q: OCT4, need: OCT4_NEED, desk: () => oct4() };
const READ4 = [read([OCT4_LIST]), read(opens(ids(1, 4)))];
const READ8 = [...READ4, read(opens(ids(5, 4)))];
const BUG_NEED = "pages created on 2026-10-04 that mention BUG-412";
const B4 = { q: "Which pages created on October 4, 2026 mention BUG-412?", need: BUG_NEED, desk: () => oct4() };
const TRACE = "Traceability — requirement threads and BUG-412 walkthrough mentions BUG-412.";
const TWO = "Gate reviews and Traceability mention BUG-412.";
const FOUR = "The pages are ECHO Product Pipeline, Assumptions and decisions, Gate reviews and Traceability.";
const SECTIONS = ids(9, 4);
const TICKETS_LIST = { tool: "list", args: { source: "tickets", date_field: "created", since: "2026-10-04", until: "2026-10-04" } } as const;
const TIX = { q: "Which Jira tickets were created on October 4, 2026?", need: "tickets created on 2026-10-04" };
const names = (from: number, count: number) => tickets(from, count).map(item => item.label).join("; ");
const FOLLOW_UPS = { tool: "list", args: { source: "follow_ups", owner: "Mara Lind", status: "open" } } as const;
const KEEP_FOLLOW_UPS = 'list L1 is unfinished: keep reading the list (repeat list with {"source":"follow_ups","status":"open","owner":"Mara Lind"})';
const TWELVE = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1));
const FU = { q: "What are my open follow-ups?", need: "my open follow-ups", v4: {}, desk: () => followUps(TWELVE) };
const FU12 = `12 follow-ups with owner Mara Lind and status open: ${TWELVE.map(item => item.label).join("; ")}.`;
/** Follow-ups with due dates: THERM-41 is overdue on October 18, THERM-43 and THERM-47 are due that week. */
const DUES: Readonly<Record<number, readonly [string, string]>> = { 1: ["2026-10-09", "October 9, 2026"], 2: ["2026-10-30", "October 30, 2026"], 3: ["2026-10-20", "October 20, 2026"], 7: ["2026-10-22", "October 22, 2026"], 9: ["2026-11-02", "November 2, 2026"] };
const DUE_ITEMS = Array.from({ length: 12 }, (_, index) => followUpItem(index + 1, DUES[index + 1]?.[0]));
const FULL12 = `12 follow-ups with owner Mara Lind and status open: ${DUE_ITEMS.map((item, index) => DUES[index + 1] === undefined ? item.label : `${item.label} (due ${DUES[index + 1]![1]})`).join("; ")}.`;
const dueFacts = (n: number) => `THERM-${40 + n} follow-up (status open, owner Mara Lind, due ${DUES[n]![1]})`;
const LEAD12 = "of the 12 follow-ups with owner Mara Lind and status open";
const MARA = { q: "Which actions does Mara own?", need: "actions owned by Mara" };
const MARA_LIST = { tool: "list", args: { source: "meetings", owner: "Mara" } } as const;
const VENDOR_ACTIONS = { q: "Which of Mara's actions mention the vendor?", need: "Mara's actions that mention the vendor" };
const DVT = { q: "Is DVT on hold?", need: "whether DVT is on hold" };
const HOLD = "DVT is on hold pending fixture rework.";
const claim = (evidence: readonly string[], lists: readonly unknown[] = []) => say("Yes, DVT is on hold, and EVT passed.", evidence, lists);
const pageFacts = (title: string, updated = "October 4, 2026") => `${title} (status current, created October 4, 2026, updated ${updated})`;
const launch = () => vi.fn(async () => result([record("launch", "Approved: the THERM tickets track DVT.")]) as EvidenceDeskResultV2);
const meetingAction = (id: string, options: Parameters<typeof listed>[1] & { readonly owner?: string; readonly status?: string; readonly due_at?: string } = {}) => {
  const { owner = "Mara Quinn", status, due_at, ...rest } = options;
  return listed(id, { kind: "action", attributes: { owner, ...(status === undefined ? {} : { status }), ...(due_at === undefined ? {} : { due_at }) }, ...rest });
};

describe("Ask research reads a list to its end, says its filters, and gives no id to a refused one (ADR-0041)", () => {
  scenarios([
    { id: "F2", name: "refuses a finish on an unfinished list with \"keep reading the list\", then accepts it read to its end", ...TIX,
      desk: () => jira(tickets(1, 30), { size: 25, more: { truncated: true, page_full: false }, last: { page_full: false } }), steps: [read([TICKETS_LIST]), fin(WI, "L1"), read([TICKETS_LIST]), fin(WI, "L1")], w: [useL1],
      rejected: ['need N1 "tickets created on 2026-10-04": list L1 is unfinished: keep reading the list (repeat list with {"date_field":"created","source":"tickets","since":"2026-10-04","until":"2026-10-04"})'],
      out: "answered", says: [`30 Jira tickets created on October 4, 2026: ${names(1, 25)}; and 5 more.`], listed: 2,
      step: [1, { lists: [{ id: "L1", members: ids(1, 25), more: true, complete: false, truncated: true }] }], lists: [{ id: "L1", members: ids(1, 30), shown: 30, ended: true, truncated: false, complete: true }] },
    { id: "addition 1", name: "never trusts an exactly full last page: the list is cited, and stated, for \"at least\" its count", ...TIX, desk: () => jira(tickets(1, 25), { last: { page_full: true } }),
      steps: [read([TICKETS_LIST]), fin(WI, "L1")], w: [useL1], out: "partial", says: [`At least 25 Jira tickets created on October 4, 2026: ${names(1, 25)}.`], gap: leg("Jira tickets"), wl: { complete: false, count: 25 },
      step: [1, { last_results: [{ list: "L1", more: false, note: "its last page was exactly full, so more items may exist than list can show; use search" }], lists: [{ id: "L1", more: false, complete: false, unverified_end: true }] }],
      lists: [{ id: "L1", shown: 25, ended: true, unverified_end: true, complete: false }] },
    { id: "addition 1", name: "treats a page with as many rows as research asked for as full when the desk does not say", q: "Which actions does Dana own?", need: "actions owned by Dana",
      desk: () => meetings(Array.from({ length: 50 }, (_, index) => record(`action-${index + 1}`, `Action ${index + 1}.`, { kind: "action", attributes: { owner: "Dana Lee" } }))),
      steps: [read([{ tool: "list", args: { source: "meetings", owner: "Dana" } }]), read([{ tool: "list", args: { source: "meetings", owner: "Dana" } }]), fin(WI, "L1")], w: [useL1],
      out: "partial", says: [expect.stringMatching(/^At least 50 actions with owner Dana: Meeting action-1; .*; and 25 more\.$/u)], gap: leg("actions"), listed: 1,
      lists: [{ id: "L1", source: "meetings", filter: { kind: "action", owner: "Dana", time_zone: "UTC" }, filter_applied: { owner: "applied" }, shown: 50, unverified_end: true, complete: false }] },
    { id: "F4", name: "shows absence with a list read to a confirmed end", ...TIX, need: "a ticket about the fixture vendor", desk: () => jira(tickets(1, 25), { last: { page_full: false }, body: bodyText }),
      steps: [read([TICKETS_LIST]), read(opens(["E1"])), none()], w: [nothing("a ticket about the fixture vendor")], out: "not_found", says: [], gap: "Not found: a ticket about the fixture vendor.", stop: "finished" },
    { id: "F4", name: "never takes a list whose end is unverified as a completed list for not_found (addition 1)", ...TIX, need: "a ticket about the fixture vendor", desk: () => jira(tickets(1, 25), { last: { page_full: true }, body: bodyText }),
      steps: [read([TICKETS_LIST]), read(opens(["E1"])), none(), none()], w: [nothing("a ticket about the fixture vendor")], rejected: [`need N1 "a ticket about the fixture vendor" ${ABSENT}`, ABSENT],
      stop: "unusable_step", out: "partial", status: "not_found", gap: `${INCOMPLETE} Missing context: a ticket about the fixture vendor.` },
    { id: "progress", name: "counts only items no list had shown as progress, so relisting the same tickets under new filters stops as no_progress", q: "Which tickets track DVT?", need: "every THERM ticket",
      desk: () => jira(tickets(1, 3), { search: launch() }),
      steps: [read([{ tool: "search", args: { query: "THERM DVT" } }]), ...([["created", "2026-10-01"], ["updated", "2026-10-01"], ["created", "2026-09-01"]] as const).map(([date_field, since]) => read([{ tool: "list", args: { source: "tickets", date_field, since } }]))],
      w: [useL1], stop: "no_progress", out: "answered", notice: STOPPED, says: [`3 Jira tickets created since October 1, 2026: ${names(1, 3)}.`], lists: [{ members: ids(2, 3) }, { members: ids(2, 3) }, { members: ids(2, 3) }] },
    { id: "progress", name: "counts list pages as progress after text was read, so a long list is read to its end", q: "Which tickets track DVT?", need: "every THERM ticket",
      desk: () => jira(tickets(1, 100), { more: { truncated: true, page_full: false }, last: { page_full: false }, search: launch() }),
      steps: [read([{ tool: "search", args: { query: "THERM DVT" } }]), ...Array.from({ length: 4 }, () => read([{ tool: "list", args: { source: "tickets" } }])), fin(WI, "L1")], w: [useL1],
      stop: "finished", out: "answered", says: [expect.stringMatching(/^100 Jira tickets: THERM-1: Fixture work 1; .*; and 75 more\.$/u)], lists: [{ id: "L1", shown: 100, ended: true, complete: true }] },
    { id: "W7", name: "records an owner filter tickets cannot apply as ignored, and the answer that states the list tells the person", q: "Which tickets does Dana own?", need: "Dana's tickets", desk: () => jira(tickets(1, 3)),
      steps: [read([{ tool: "list", args: { source: "tickets", owner: "Dana" } }]), fin(WI, "L1")], w: [useL1], out: "answered", says: [`3 Jira tickets: ${names(1, 3)}.`], notice: ownerNotice("Jira tickets"),
      step: [1, { last_results: [{ list: "L1", note: "owner applies to meeting actions only; ignored" }], lists: [{ id: "L1", notes: ["owner applies to meeting actions only; ignored"] }] }],
      lists: [{ id: "L1", filter: { time_zone: "UTC" }, filter_applied: { owner: "ignored" }, complete: true }],
      // Research builds no filter notice; the answer that states the list tells the person.
      check: ({ h, research }) => { expect(h.port.list.mock.calls[0]![0]).not.toHaveProperty("owner"); expect(research.coverage.notices).toEqual([]); } },
    ...([[WS, "partial"], [C, "answered"]] as const).map(([kind, out]): Row => ({
      id: "W7", name: `${kind === WS ? "tells the person the filter of a list a which_say need checks" : "names no filter of a list only a content need cites, its list id carrying no meaning"}`,
      q: "Which of Dana's tickets mention the vendor?", need: "Dana's tickets that mention the vendor", desk: () => jira(tickets(1, 3), { body: n => `THERM-${n}: the vendor slipped the fixture.` }),
      steps: [read([{ tool: "list", args: { source: "tickets", owner: "Dana" } }], kind), read(opens(["E2"]), kind), fin(kind, "L1", "E2")], w: [say("THERM-2 mentions the vendor.", ["L1", "E2"])], out,
      // The content sentence stands on THERM-2's body; its list id brings the list's other only_me rows after it (W1).
      ...(kind === WS ? { says: ["THERM-2 mentions the vendor (1 of 3 checked so far)."], gap: UNCHECKED, notice: ownerNotice("Jira tickets") } : { says: [cite("THERM-2 mentions the vendor.", 3)] }),
    })),
    { id: "list ids", name: "gives a list the source refused no id, and keeps the refusal for research to disclose", q: "Which pages were due on October 4?", need: "pages due on 2026-10-04",
      desk: () => ({ live_sources: [CONFLUENCE], list: vi.fn(async () => { throw new AuthorityOperationError("invalid_request", "This source supports date_field: created, updated"); }) }),
      steps: [read([{ tool: "list", args: { source: "pages", date_field: "due", since: "2026-10-04", until: "2026-10-04" } }]), ...["due", "deadline"].map(query => read([{ tool: "search", args: { source: "pages", query } }], undefined, "not_found")), none()],
      w: [], out: "not_found", says: [], gap: MISSING, lists: [],
      step: [1, { last_results: [{ tool: "list", error: "This source supports date_field: created, updated" }], lists: [] }] },
    { id: "W4", name: "states a complete follow-up list the desk filtered by owner and status, and leaves out a sentence restating it", ...FU, q: "What are my open tasks?", desk: () => followUps(TWELVE.slice(0, 2)),
      steps: [read([FOLLOW_UPS]), fin(WI, "L1")], w: [say("Both are open.", ["E1", "E2"], [{ id: "L1" }])], out: "answered", says: ["2 follow-ups with owner Mara Lind and status open: THERM-41 follow-up; THERM-42 follow-up."],
      step: [1, { lists: [{ id: "L1", args: { source: "follow_ups", status: "open", owner: "Mara Lind" }, members: ["E1", "E2"], shown_count: 2, more: false, complete: true, available: true, truncated: false, unverified_end: false }] }],
      check: ({ h, response }) => {
        expect(response.citations.map((citation: { kind: string }) => citation.kind)).toEqual(["follow_up", "follow_up"]);
        expect(h.port.list).toHaveBeenCalledWith(expect.objectContaining({ source: "follow_ups", owner: "Mara Lind", status: "open" })); } },
  ]);
});

const OPEN_ACTIONS = [
  record("a1", "Dana will publish the dashboard.", { kind: "action", attributes: { owner: "Dana Lee", status: "open" } }),
  record("a2", "Dana will order samples.", { kind: "action", attributes: { owner: "Dana Lee" } }),
  record("a3", "Dana closed the vendor review.", { kind: "action", attributes: { owner: "Dana Lee", status: "done" } }),
];
const X6 = { q: "Who publishes the dashboard, and which actions are still open?", need: "who publishes the dashboard", desk: () => meetings(OPEN_ACTIONS), steps: [read([{ tool: "list", args: { source: "meetings", status: "open" } }], C), fin(C, "E1")] };
const TASK = (n: number) => ({ kind: "action" as const, list_label: `Task ${n} (DVT review, 2026-10-01)`, attributes: { owner: "Mara Quinn" } });
const TASK_ROWS = Array.from({ length: 8 }, (_, index) => listed(`a${index + 1}`, TASK(index + 1)));
const tasks = () => meetings(TASK_ROWS, index => record(`a${index + 1}`, `Mara will do task ${index + 1}.`, TASK(index + 1)));
const VENDOR_ROWS = Array.from({ length: 8 }, (_, index) => meetingAction(`a${index + 1}`));
const vendorBodies = (index: number) => record(`a${index + 1}`, index === 1 || index === 4 ? `Mara will chase the vendor about fixture ${index + 1}.` : `Mara will do task ${index + 1}.`, { kind: "action", attributes: { owner: "Mara Quinn" } });
const LINES = ["Publish the DVT dashboard (DVT review, 2026-10-01)", "Order fixture spares (DVT review, 2026-10-01)", "Confirm the trace plan (DVT review, 2026-10-01)"];
const R4 = { q: "Which Confluence pages were created on October 4, 2026, and when was the PRD last updated?", needs: [OCT4_NEED, "when the PRD was last updated"], desk: () => oct4(), steps: [
  step([OCT4_LIST], ["open", [], WI], ["open", [], C]), step(opens(["E5"]), ["found", ["L1"], WI], ["open", [], C]), step([FINISH], ["found", ["L1"], WI], ["found", ["E9"], C]),
] };
const PRD_FACTS = `1 of the 8 Confluence pages created on October 4, 2026: ${pageFacts(OCT4_TITLES[4]!)}.`;
const UPDATED = "The PRD was last updated on October 4, 2026.";
const X15 = { q: "Which pages were created on October 4, 2026, and which of them mention BUG-412?", needs: [OCT4_NEED, BUG_NEED], desk: () => oct4() };
const bothOpen = (actions: readonly unknown[], items: boolean) => step(actions, items ? ["found", ["L1"], WI] : ["open", [], WI], ["open", [], WS]);
const X27 = { q: "Which Confluence pages were created on October 4, 2026, and is the DVT gate on hold?", needs: [OCT4_NEED, "whether the DVT gate is on hold"], desk: () => oct4() };
const X27_LIST = step([OCT4_LIST], ["open", [], WI], ["open", []]);
const DVT_GATE = "The Gate reviews page says the DVT gate is on hold pending fixture rework.";
const RESTATE = "Traceability — requirement threads and BUG-412 walkthrough was created on October 4, 2026.";
const WEEK = { q: "Which of my open tasks are due this week?", need: "my open follow-ups due from 2026-10-18 to 2026-10-24", v4: { now: "2026-10-18T17:00:00.000Z", time_zone: "UTC" }, desk: () => followUps(DUE_ITEMS), steps: [read([FOLLOW_UPS], WI), read([FOLLOW_UPS], WI), fin(WI, "L1")] };
const due = (since: string | undefined, until: string) => ({ id: "L1", where: { field: "due", ...(since === undefined ? {} : { since }), until } });
const THIS_WEEK = `2 ${LEAD12} are due from October 18 to October 24, 2026: THERM-43 follow-up (due October 20, 2026); THERM-47 follow-up (due October 22, 2026).`;
const NOT_DUE = "Not found: follow-ups with owner Mara Lind and status open due from October 23 to October 29, 2026.";
const UNSELECTED = "THERM-41 follow-up is on the decision to ship fan curve v2 before DVT.";
const HITS = [1, 4, 9, 12, 38, 46, 47, 48, 50];
const X19 = { q: "Which Jira tickets mention BUG-412?", need: "Jira tickets that mention BUG-412", desk: () => jira(tickets(1, 60), { more: { page_full: false }, last: { page_full: false }, search: vi.fn(async () => result(HITS.map(n => ticketBody(n, `THERM-${n}: references BUG-412.`))) as EvidenceDeskResultV2) }) };
const SEARCH_412 = { tool: "search", args: { query: "BUG-412", source: "tickets" } } as const;
const ALL_TICKETS = { tool: "list", args: { source: "tickets" } } as const;
const HIT_NAMES = `${HITS.map(n => `THERM-${n}`).join(", ")} mention BUG-412.`;
const WEEK20 = Array.from({ length: 20 }, (_, index) => pageRow([String(600_000 + index), `Page ${String(index + 1).padStart(2, "0")}`, "2026-10-02T12:00:00.000Z", "2026-10-03T12:00:00.000Z", "1"]));
const week20 = (date_field: string) => ({ tool: "list", args: { source: "pages", date_field, since: "2026-10-01", until: "2026-10-07" } });
const X30 = {
  q: "Which Confluence pages were created from October 1 to 7, 2026, and which were updated that week?", needs: ["pages created that week", "pages updated that week"],
  desk: () => ({ live_sources: [CONFLUENCE], list: vi.fn(async () => result(WEEK20) as EvidenceDeskResultV2) }),
  steps: [step([week20("created"), week20("updated")], ["open", [], WI], ["open", [], WI]), step([FINISH], ["found", ["L1"], WI], ["found", ["L2"], WI])],
  // Both lists hold the same 20 pages, so each statement names all 20: 20 distinct names, within the answer's 25.
  out: "answered", lists: [{ members: ids(1, 20) }, { members: ids(1, 20) }], check: ({ part }: Run) => expect(part.statements.map((value: { text: string }) => (value.text.match(/Page \d\d/gu) ?? []).length)).toEqual([20, 20]),
};
/** One list of Confluence pages a day: research lists days 1 to `days`, four a step, the `owner` day with an owner filter pages cannot apply. */
function daily(days: number, kind: Kind, writer: unknown, { owner, pages = n => [dayPage(n)], opened, cited = [] }: { readonly owner?: number; readonly pages?: (n: number) => readonly EvidenceDeskItemV2[]; readonly opened?: readonly string[]; readonly cited?: readonly string[] } = {}) {
  const lists = Array.from({ length: days }, (_, index) => `L${index + 1}`);
  const reads = Array.from({ length: Math.ceil(days / 4) }, (_, at) => Array.from({ length: Math.min(4, days - at * 4) }, (_, index) => at * 4 + index + 1)
    .map(n => ({ tool: "list", args: { source: "pages", date_field: "created", since: day(n), until: day(n), ...(n === owner ? { owner: "Dana" } : {}) } })));
  return {
    q: "Which Confluence pages were created on each day of October 2026 so far?", need: "pages created on each day of October 2026", w: [writer], stop: "finished",
    desk: () => ({
      live_sources: [CONFLUENCE], list: vi.fn(async (input: { readonly since?: string }) => result(pages(Number(String(input.since).slice(8, 10)))) as EvidenceDeskResultV2),
      open: vi.fn(async (input: { readonly item: string }) => result([section(dayPage(Number(/\d+/u.exec(input.item)![0]) - 2_000_000), "It traces BUG-412 to TC-D-03.")]) as EvidenceDeskResultV2),
    }),
    steps: [...reads.map(actions => read(actions, kind)), ...(opened === undefined ? [] : [read(opens(opened), kind, "open", lists)]), fin(kind, ...lists, ...cited)],
    // The writer sees five lists; code reads every one.
    check: ({ research, writer }: Run) => { expect(research.lists).toHaveLength(days); expect(writer[0]!.lists.map((list: { id: string }) => list.id)).toEqual(lists.slice(0, 5)); },
  };
}
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
const dayPage = (n: number) => pageRow([String(2_000_000 + n), `Day ${n} plan`, `${day(n)}T18:00:00.000Z`, `${day(n)}T18:00:00.000Z`, "1"]);
const dayStatement = (n: number) => `1 Confluence page created on October ${n}, 2026: Day ${n} plan.`;
/** Gate reviews (E3) opens to ten sections of 3,000 bytes, not truncated, the tenth naming `defect`; the loop admits eight. */
const gateOpen = (defect: string) => vi.fn(async (input: { readonly item: string }) => {
  const row = PAGES.find(page => page.id === input.item)!;
  if (!row.label.startsWith("Gate reviews")) return result([section(row, "No defects are discussed.")]) as EvidenceDeskResultV2;
  return result(Array.from({ length: 10 }, (_, index) => section(row, `Section ${index + 1}. ${"Gate review narrative. ".repeat(130).slice(0, 2960)}${index === 9 ? ` ${defect} holds the DVT gate.` : ""}`, index + 1))) as EvidenceDeskResultV2;
});
const GATE_CUT = { opened: ids(11, 8), truncated: true };
/** THERM-3 links four tickets: its open returns its whole text and the linked rows, truncated, and says whether its own text was cut. */
const anchorJira = (own: { readonly anchor_truncated?: boolean }) => jira(tickets(1, 4), { open: vi.fn(async (input: { readonly item: string }) => {
  const n = Number(/THERM-(\d+)/u.exec(input.item)![1]);
  return (n === 3 ? result([ticketBody(3, bodyText(3)), ...tickets(11, 4)], { truncated: true, ...own }) : result([ticketBody(n, bodyText(n))])) as EvidenceDeskResultV2;
}) });
const A4 = { q: "Which Jira tickets created on October 4, 2026 mention BUG-412?", need: "tickets created on 2026-10-04 that mention BUG-412", w: [say("THERM-3 mentions BUG-412.", ["E3"])],
  steps: [read([TICKETS_LIST], WS), read(opens(ids(1, 4)), WS, "open", ["L1"]), fin(WS, "L1", "E3")] };
/** Mara's four actions; a4's meeting holds 14 records, so its open returns a4 and nine others, truncated beside it, each record `pad` bytes more. */
function vendorMeeting(pad: number) {
  const filler = (n: number) => (pad === 0 ? "" : ` ${"Sync narrative. ".repeat(200).slice(0, pad)}`) + ` ${n}`;
  const rows = Array.from({ length: 4 }, (_, index) => meetingAction(`a${index + 1}`, { owner: "Mara Lind" }));
  const others = Array.from({ length: 9 }, (_, index) => record(`dvt-${index + 1}`, `DVT sync item ${index + 1}.${filler(index + 1)}`, { kind: "decision" }));
  const body = (index: number) => record(`a${index + 1}`, index === 3 ? `Mara will chase the vendor about the fixture drawings.${filler(0)}` : `Mara will do task ${index + 1}.`, { kind: "action", attributes: { owner: "Mara Lind" } });
  return { list: vi.fn(async () => result(rows) as EvidenceDeskResultV2), open: vi.fn(async (input: { readonly item: string }) => {
    const index = rows.findIndex(row => row.id === input.item);
    return (index === 3 ? result([body(3), ...others], { truncated: true, anchor_truncated: false }) : result([body(index)])) as EvidenceDeskResultV2;
  }) };
}
const SHARED = listed("dash", { kind: "action", list_label: "Publish the DVT dashboard (Exec vendor review, 2026-10-04)", attributes: { owner: "Mara Quinn" } });
const RESTRICTED = listed("exec", { kind: "action", visibility: "approver_only", list_label: "Replace the fixture vendor if the drawings slip again. (Exec vendor review, 2026-10-04)", attributes: { owner: "Dana Lee" } });
const DRAWINGS = "The drawings go to the vendor on Friday; if they slip again, the vendor is to be replaced.";
const x35 = (rows: readonly EvidenceDeskItemV2[], found: string) => ({
  q: "When do the fixture drawings go to the vendor?", need: "when the drawings go to the vendor", desk: () => meetings(rows, undefined, { search: vi.fn(async () => result([record("drawings", "Approved: fixture drawings go to the vendor on Friday.")]) as EvidenceDeskResultV2) }),
  steps: [read([{ tool: "list", args: { source: "meetings", kind: "action" } }, { tool: "search", args: { query: "fixture drawings vendor" } }]), fin(C, found)], out: "answered",
});
const visibilities = (...expected: readonly (readonly [string, string])[]) => ({ response }: Run) =>
  expect(response.citations.map((value: { kind: string; visibility: string }) => [value.kind, value.visibility])).toEqual(expected);

const OCT4_FILTER = { since: "2026-10-04", until: "2026-10-04", date_field: "created", time_zone: "UTC" };
const OCT4_APPLIED = { since: "applied", until: "applied", date_field: "applied" };

describe("Ask's declared kinds: the restructure's scenario corpus (ADR-0041)", () => {
  scenarios([
    { id: "C1", name: "finishes on the complete list in two steps, without opening a page, and names all 8 pages from rows the writer saw without text", ...O4,
      steps: [read([OCT4_LIST]), fin(WI, "L1")], w: [useL1], stop: "finished", out: "answered", says: [cite(FULL8, 8)], listed: 1,
      lists: [{ id: "L1", source: "pages", filter: OCT4_FILTER, filter_applied: OCT4_APPLIED, members: ids(1, 8), shown: 8, ended: true, unverified_end: false, available: true, truncated: false, read_at: LIST_READ_AT, complete: true }],
      check: ({ h, research, steps, writer, response, writer_evidence }) => {
        expect(research.rounds.map((round: any) => round.actions.map((action: any) => action.tool))).toEqual([["list"], ["finish"]]);
        expect(research.plan[0].needs).toEqual([{ need: OCT4_NEED, kind: "which_items", status: "found", evidence: ["L1"] }]);
        expect(h.port.list).toHaveBeenCalledWith(expect.objectContaining({ source: "confluence", date_field: "created", since: "2026-10-04", until: "2026-10-04", limit: 50 }));
        // The second step saw the list by id, with every member, and no inventories; the impact card's coverage view is unchanged.
        expect(steps[1]).not.toHaveProperty("inventories");
        expect(steps[1]!.lists).toEqual([{ id: "L1", args: OCT4_LIST.args, members: ids(1, 8), shown_count: 8, more: false, complete: true, available: true, truncated: false, unverified_end: false }]);
        // Each requested filter comes back applied (research tool contract v1).
        expect(steps[1]!.last_results).toEqual([{ tool: "list", args: OCT4_LIST.args, list: "L1", items: ids(1, 8), more: false, filters: { date_field: "applied", since: "applied", until: "applied" } }]);
        expect(research.coverage.inventories).toEqual([{ source: "pages", shown_count: 8, more: false, available: true, truncated: false }]);
        // Code names each page, citing its row; the writer saw the rows and no text, never a desk id, receipt or permalink.
        expect(response.citations.map((citation: { citation: unknown }) => citation.citation)).toEqual(PAGES.map(page => page.citation));
        expect([writer[0]!.evidence, writer[0]!.research.inventories, writer_evidence]).toEqual([[], undefined, ids(1, 8)]);
        expect(writer[0]!.lists).toEqual([{
          id: "L1", source: "pages", filter: OCT4_FILTER, filter_applied: OCT4_APPLIED, complete: true, count: 8, checked: 0, read_at: LIST_READ_AT, stated: true,
          members: PAGES.map((page, index) => ({ id: `E${index + 1}`, kind: "page", title: OCT4_TITLES[index], dates: page.dates, date: page.occurred_at, date_kind: "version_created", status: "current", checked: false })),
        }]);
        const prompt = h.inputs.find(input => input.system_prompt.startsWith("You write"))!.user_prompt;
        for (const page of PAGES) for (const hidden of [page.id, page.receipt_sha256, (page.citation as { permalink: string }).permalink]) expect(prompt).not.toContain(hidden);
      } },
    ...[EMPTY, useL1].map((writer): Row => ({
      id: "C1", name: `states all 8 October 4 pages after the trace's own step 2 is refused once, the writer using ${writer.lists.length ? "L1" : "no list"}`, ...O4,
      steps: [read([OCT4_LIST]), fin(WI, ...ids(1, 8)), fin(WI, "L1")], w: [writer], rejected: [`${UNLISTED} (L1). `], out: "answered", says: [cite(FULL8, 8)],
    })),
    { id: "C2", name: "notes a which_say need's sentence and states no list, the writer seeing the list as checked, not stated", ...B4, steps: [...READ4, fin(WS, "L1", "E12")], w: [say(TRACE, ["E12"])],
      out: "partial", says: [cite(noted(TRACE, of8(4)), 1)], gap: UNCHECKED, wl: { id: "L1", count: 8, checked: 4, stated: false },
      check: ({ writer }) => expect(writer[0]!.lists[0].members.map((member: { checked: boolean }) => member.checked)).toEqual([true, true, true, true, false, false, false, false]) },
    { id: "C2", name: "notes a sentence citing the list's id too, which brings the 8 only_me page rows after its text (W1)", ...B4, steps: [...READ4, fin(WS, "L1", "E12")], w: [say(TRACE, ["L1", "E12"])],
      out: "partial", says: [cite(noted(TRACE, of8(4)), 9)], gap: UNCHECKED,
      check: ({ response }) => expect(response.citations.map((value: { citation: { section_id: string } }) => value.citation.section_id)).toEqual(["s1", ...Array.from({ length: 8 }, () => "inventory")]) },
    { id: "C2", name: "refuses a which_say finish on sections alone once, naming their list (F1)", ...B4, steps: [...READ4, fin(WS, "E11", "E12"), fin(WS, "L1", "E11", "E12")], w: [say(TWO, ["E11", "E12"])],
      rejected: [`need N1 "${BUG_NEED}" ${UNLISTED} (L1). `], out: "partial", says: [noted(TWO, of8(4))], gap: UNCHECKED },
    { id: "C2 (misdeclared)", name: "answers a which-say question declared content with no note, its list id carrying no meaning", ...B4, steps: [...READ4, fin(C, "L1", "E12")], w: [say(TRACE, ["L1", "E12"])], out: "answered", says: [cite(TRACE, 9)] },
    { id: "CF4", name: "states the list the writer uses beside the noted sentence (path A)", ...B4, steps: [...READ4, fin(WS, "L1", "E12")], w: [say(TRACE, ["E12"], [{ id: "L1" }])], out: "partial", says: [FULL8, noted(TRACE, of8(4))], gap: UNCHECKED },
    { id: "CF4", name: "reads a section beside its own page's row as the section: the row is no citation", ...B4, steps: [...READ4, fin(WS, "L1", "E12")], w: [say(TRACE, ["E12", "E4"], [{ id: "L1" }])], out: "partial", says: [FULL8, noted(TRACE, of8(4))], gap: UNCHECKED },
    { id: "X14 (subset)", name: "notes the October 4 subset beside the list a which_say need checks: its members' text is never a restatement (Known limit)", ...B4,
      steps: [...READ4, fin(WS, "L1", ...SECTIONS)], w: [say(FOUR, SECTIONS, [{ id: "L1" }])], out: "partial", says: [FULL8, noted(FOUR, of8(4))], gap: UNCHECKED },
    ...[fin(WS, "L1", "E11", "E12"), fin(C, "E11", "E12")].map((finish, index): Row => ({
      id: index === 0 ? "C2b, R2" : "R2 (content)", name: `answers which pages mention BUG-412 once every page was checked, ${index === 0 ? "a which_say need" : "declared content"}: the sentence stands, with no note and no list`, ...B4,
      steps: [...READ8, finish], w: [say(TWO, ["E11", "E12"])], out: "answered", says: [cite(TWO, 2)], wl: { count: 8, checked: 8, complete: true, stated: false },
    })),
    { id: "X35d", name: "cites the 8 only_me page rows after the two sections when the sentence also cites the list", ...B4, steps: [...READ8, fin(WS, "L1", "E11", "E12")], w: [say(TWO, ["L1", "E11", "E12"])], out: "answered", says: [cite(TWO, 10)] },
    { id: "X35d", name: "cites only the two sections on team pages, whatever the sentence cites beside them", ...B4, desk: () => oct4({ team: true }), steps: [...READ8, fin(WS, "L1", "E11", "E12")], w: [say(TWO, ["L1", "E11", "E12"])], out: "answered", says: [cite(TWO, 2, true)] },
    { id: "X29", name: "counts an open by a page's title for the page it resolved to, so all eight are checked", ...B4,
      steps: [read([OCT4_LIST]), read(PAGES.slice(0, 4).map(row => ({ tool: "open", args: { id: row.label } }))), read(PAGES.slice(4).map(row => ({ tool: "open", args: { id: row.label } }))), fin(WS, "L1", "E11", "E12")],
      w: [say(TWO, ["E11", "E12"])], out: "answered", says: [TWO], wl: { count: 8, checked: 8 },
      check: ({ research }) => expect(research.rounds[1].actions.map((action: any) => [action.args.id, action.result.id])).toEqual(PAGES.slice(0, 4).map((row, index) => [row.label, `E${index + 1}`])) },
    ...([["C3", ["E1"]], ["C3b", ["L1", "E1"]]] as const).map(([id, evidence]): Row => ({
      id, name: "answers one follow-up's due date from its text on the list's first page, stating no list: a content need never waits", q: "When is THERM-41 due?", need: "THERM-41's due date", v4: {}, desk: () => followUps(DUE_ITEMS),
      steps: [read([FOLLOW_UPS], C), fin(C, ...evidence)], w: [say("THERM-41 follow-up is due October 9, 2026.", ["E1"])], out: "answered", says: [cite("THERM-41 follow-up is due October 9, 2026.", 1, true)], listed: 1, wl: { complete: false, count: 10, stated: false },
    })),
    { id: "C3c (misdeclared)", name: "states all 12 follow-ups for a due-date question declared which_items, then the member's facts by id; the writer's sentence restates the list", q: "When is THERM-41 due?", need: "THERM-41's due date", v4: {}, desk: () => followUps(DUE_ITEMS),
      steps: [read([FOLLOW_UPS], WI), fin(WI, "L1"), read([FOLLOW_UPS], WI), fin(WI, "L1")], w: [say("THERM-41 follow-up is due October 9, 2026.", ["E1"], [{ id: "L1", members: ["E1"] }])],
      rejected: [`need N1 "THERM-41's due date": ${KEEP_FOLLOW_UPS}`], out: "answered", says: [FULL12, `1 ${LEAD12}: ${dueFacts(1)}.`], citations: 12, listed: 2 },
    ...[say("THERM-46 is owned by Dana Lee.", ["E6"]), use({ id: "L1", members: ["E6"] })].map((writer): Row => ({
      id: "C4", name: `opens one ticket for who owns it, a content need refused on its row, and answers from ${writer.sentences.length ? "its text" : "its row facts selected by id"}`, q: "Who owns THERM-46?", need: "THERM-46's owner",
      desk: () => jira(tickets(41, 10), { body: n => `THERM-${n}: fixture work, assigned to Dana Lee.` }), steps: [read([ALL_TICKETS], C), fin(C, "E6"), read(opens(["E6"]), C), fin(C, "E6")], w: [writer],
      rejected: [`need N1 "THERM-46's owner" ${HINT}`], out: "answered",
      says: [cite(writer.sentences.length ? "THERM-46 is owned by Dana Lee." : "1 of the 10 Jira tickets: THERM-46: Fixture work 46 (status In Progress, owner Dana Lee, created October 4, 2026).", 1)],
    })),
    { id: "C5", name: "asks a which_items need to keep reading a follow-up list, then states all 12; the writer's count restates it", ...FU, steps: [read([FOLLOW_UPS], WI), fin(WI, "L1"), read([FOLLOW_UPS], WI), fin(WI, "L1")],
      w: [say("You have 10 open follow-ups.", ["L1", ...ids(1, 10)])], rejected: [`need N1 "my open follow-ups": ${KEEP_FOLLOW_UPS}`], out: "answered", says: [FU12], listed: 2, wl: { id: "L1", complete: true, count: 12, stated: true } },
    { id: "X8 (misdeclared)", name: "finishes a which-question declared content on ten follow-up rows without reading on, and states no list (Known limit)", ...FU, steps: [read([FOLLOW_UPS]), fin(C, ...ids(1, 10))], w: [say("You have 10 open follow-ups.", ["L1", ...ids(1, 10)])], out: "answered", says: ["You have 10 open follow-ups."], stop: "finished", listed: 1, wl: { id: "L1", complete: false, count: 10, stated: false } },
    { id: "C6, R1, R8", name: "states the plan's list beside a reply that found nothing, with no repair", ...O4, steps: [read([OCT4_LIST]), fin(WI, "L1")], w: [nothing("Confluence pages created on October 4, 2026")], out: "partial", says: [cite(FULL8, 8)], gap: "Not found: Confluence pages created on October 4, 2026." },
    { id: "C7a, CF6", name: "names one meeting's actions by their own lines, each with its own due date, though they share the meeting's label", ...MARA,
      desk: () => meetings([0, 1, 2].map(index => meetingAction(`a${index + 1}`, { label: "DVT review (2026-10-01)", list_label: LINES[index]!, ...(index < 2 ? { due_at: ["2026-10-09", "2026-10-12"][index] } : {}) }))),
      steps: [read([MARA_LIST]), fin(WI, "L1")], w: [useL1], out: "answered", says: [cite(`3 actions with owner Mara: ${LINES[0]} (due October 9, 2026); ${LINES[1]} (due October 12, 2026); ${LINES[2]}.`, 3, true)],
      lists: [{ id: "L1", source: "meetings", members: ids(1, 3), filter_applied: { owner: "applied" }, complete: true }],
      // Only Ask's list rows read the line: research steps and citations keep the label (X12).
      check: ({ h, writer, response }) => {
        expect(writer[0]!.lists[0].members.map((member: { title: string }) => member.title)).toEqual(LINES);
        for (const input of h.inputs.filter(value => !value.system_prompt.startsWith("You write"))) for (const line of LINES) expect(input.user_prompt).not.toContain(line);
        expect(response.citations.map((value: { label: string }) => value.label)).toEqual(Array.from({ length: 3 }, () => "DVT review (2026-10-01)")); } },
    ...([[WI, "C7b, CF9d"], [WS, "C7d"]] as const).map(([kind, id]): Row => ({
      id, name: kind === WI ? "states a meeting-action list by its own lines and leaves out the opened subset's sentence" : "notes the same sentence for a which_say need checking the list", ...MARA,
      ...(kind === WS ? { q: "Which of Mara's actions name a numbered task?" } : {}), desk: tasks, steps: [read([MARA_LIST]), read(opens(ids(1, 4))), kind === WI ? fin(WI, "L1") : fin(WS, "L1", ...ids(1, 4))],
      w: [say("Mara owns tasks 1, 2, 3 and 4.", ["L1", ...ids(1, 4)])], wl: { complete: true, count: 8, checked: 4, stated: kind === WI },
      ...(kind === WI ? { out: "answered", says: [`8 actions with owner Mara: ${TASK_ROWS.map((_, index) => `Task ${index + 1} (DVT review, 2026-10-01)`).join("; ")}.`] } : { out: "partial", says: [`Mara owns tasks 1, 2, 3 and 4 ${of8(4)}.`], gap: UNCHECKED }),
      // An opened meeting record keeps its row's id: research read the four members in full.
      check: ({ research }) => expect(research.items.filter((item: any) => item.read_in_full).map((item: any) => item.id)).toEqual(ids(1, 4)),
    })),
    { id: "C7c", name: "answers which of Mara's actions mention the vendor once all 8 were opened: no note", ...VENDOR_ACTIONS, desk: () => meetings(VENDOR_ROWS, vendorBodies),
      steps: [read([MARA_LIST]), read(opens(ids(1, 4))), read(opens(ids(5, 4))), fin(WS, "L1", "E2", "E5")], w: [say("Two of Mara's actions mention the vendor: fixtures 2 and 5.", ["L1", "E2", "E5"])], out: "answered", says: ["Two of Mara's actions mention the vendor: fixtures 2 and 5."] },
    { id: "CF3", name: "names a meeting and each of its records once, the records by their own lines, never as that many meetings", q: "Which meetings did I have on October 4, 2026?", need: "meetings on 2026-10-04",
      desk: () => meetings(([["meeting", "imported_meeting"], ["d1", "decision", "Keep the DVT gate on hold"], ["a1", "action", "Send fixture drawings to vendor"], ["r1", "rationale", "Accuracy fails at 42 °C"]] as const).map(([id, kind, line]) =>
        listed(id, { kind, occurred_at: "2026-10-04", label: "THERM DVT sync (2026-10-04)", ...(line === undefined ? {} : { list_label: `${line} (THERM DVT sync, 2026-10-04)` }), ...(kind === "action" ? { attributes: { owner: "Dana Lee" } } : {}) }))),
      steps: [read([{ tool: "list", args: { source: "meetings", since: "2026-10-04", until: "2026-10-04" } }]), fin(WI, "L1")], w: [useL1], out: "answered",
      says: [cite("4 items from meetings dated on October 4, 2026: THERM DVT sync (2026-10-04) (1 meeting); Keep the DVT gate on hold (THERM DVT sync, 2026-10-04) (1 decision); Send fixture drawings to vendor (THERM DVT sync, 2026-10-04) (1 action, owner Dana Lee); Accuracy fails at 42 °C (THERM DVT sync, 2026-10-04) (1 rationale).", 4, true)] },
    ...[say(FOUR, ids(1, 4)), useL1].map((repair): Row => ({
      id: "CF5a", name: `sends a sentence naming 4 of the 8 pages by their rows back once; ${repair.sentences.length ? "repeated, code states all 8 and says a claim was left out" : "dropped, the list alone is answered"}`, ...O4,
      steps: [read([OCT4_LIST]), fin(WI, "L1")], w: [say(FOUR, ids(1, 4)), repair.sentences.length ? repair : EMPTY], repaired: true,
      ...(repair.sentences.length ? { out: "partial", gap: UNSUPPORTED, says: [cite(FULL8, 8)], check: ({ writer }: Run) => expect(writer[1]!.rejected_response).toContain("The pages are") } : { out: "answered", says: [FULL8] }),
    })),
    { id: "CF9a", name: "refuses a which_items finish on opened sections alone once, naming their pages' list; the sentence then restates the stated list", ...O4,
      steps: [...READ4, fin(WI, ...SECTIONS), fin(WI, "L1", ...SECTIONS)], w: [say(FOUR, SECTIONS)], rejected: [`${UNLISTED} (L1). `], out: "answered", says: [cite(FULL8, 8)], wl: { id: "L1", count: 8, checked: 4, stated: true } },
    ...[READ4, READ8].map((reads): Row => ({
      id: "R5, CF7", name: `leaves out, with no repair, a sentence citing the list's id beside four opened sections, ${reads === READ4 ? "four" : "all eight"} pages opened: it restates the stated list`, ...O4,
      steps: [...reads, fin(WI, "L1")], w: [say(FOUR, ["L1", ...SECTIONS])], out: "answered", says: [cite(FULL8, 8)], wl: { checked: reads === READ4 ? 4 : 8, stated: true },
    })),
    { id: "R3, CF12c", name: "refuses the held trace's finish, rows and sections cut to 12 ids, once, then states the list over its 4-name sentence", ...O4,
      steps: [...READ4, fin(WI, ...ids(1, 12)), fin(WI, "L1", ...ids(1, 12))], w: [say(FOUR, SECTIONS)], rejected: [`${UNLISTED} (L1). `], out: "answered", says: [cite(FULL8, 8)], wl: { checked: 4, stated: true } },
    { id: "R3", name: "states a Jira list over a sentence naming four members from their bodies, opened under the rows' own ids", ...TIX, desk: () => jira(tickets(1, 12), { last: { page_full: false }, body: n => `THERM-${n}: created October 4 for fixture work.` }),
      steps: [read([TICKETS_LIST]), read(opens(ids(1, 4))), fin(WI, ...ids(1, 12)), fin(WI, "L1", ...ids(1, 12))], w: [say("The tickets created on October 4 are THERM-1, THERM-2, THERM-3 and THERM-4.", ids(1, 4))],
      rejected: [`${UNLISTED} (L1). `], out: "answered", says: [`12 Jira tickets created on October 4, 2026: ${names(1, 12)}.`], wl: { count: 12, checked: 4, complete: true, stated: true } },
    { id: "CF8a", name: "refuses a content finish on the list with what each kind of support is, then answers from the page research opened", ...DVT, desk: () => oct4(),
      steps: [read([OCT4_LIST], C), fin(C, "L1"), read(opens(["E3"]), C), fin(C, "E9")], w: [say(HOLD, ["E9"])], rejected: [`need N1 "whether DVT is on hold" ${HINT}`], out: "answered", says: [HOLD] },
    ...([[[claim(["E3"], [{ id: "L1" }]), nothing("whether DVT is on hold")], "Not found: whether DVT is on hold."], [[claim(["E3"], [{ id: "L1" }]), claim(["E3"], [{ id: "L1" }])], UNSUPPORTED]] as const)
      .map(([w, gap]): Row => ({
        id: "CF8b (misdeclared)", name: `never answers what a listed page says from its row: a claim on the row goes back once and ends "${gap}"`, ...DVT, desk: () => oct4(),
        steps: [read([OCT4_LIST]), fin(WI, "L1")], w, repaired: true, out: "partial", says: [FULL8], gap,
      })),
    ...([[claim(["E3"]), `${MISSING} ${UNSUPPORTED}`], [{ ...claim(["E3"]), not_found: ["whether DVT is on hold"] }, `Not found: whether DVT is on hold. ${UNSUPPORTED}`]] as const).map(([reply, gap]): Row => ({
      id: "X28", name: `leaves out a repeated claim on a row after a content need was not found: the part names nothing, partial (${reply.not_found.length ? "with" : "without"} the writer's not_found)`, ...DVT, desk: () => oct4(),
      steps: [read([OCT4_LIST], C), read(opens(["E3"]), C), none(C)], w: [reply, reply], repaired: true, stop: "finished", out: "partial", status: "not_found", says: [], citations: 0, gap,
    })),
    { id: "CF8c (misdeclared)", name: "states the list alone for a one-page question declared which_items: the section's sentence restates a member", q: "What does the gate review page say about DVT?", need: "what the gate review page says about DVT", desk: () => oct4(), steps: [read([OCT4_LIST], WI), read(opens(["E3"]), WI), fin(WI, "L1", "E9")], w: [say(HOLD, ["E9"])], out: "answered", says: [FULL8] },
    { id: "CF8d (misdeclared)", name: "refuses a which_say finish until a page is read, then notes it", ...DVT, desk: () => oct4(), steps: [read([OCT4_LIST], WS), fin(WS, "L1"), read(opens(["E3"]), WS), fin(WS, "L1", "E9")], w: [say(HOLD, ["E9"])],
      rejected: [HINT], out: "partial", says: [noted(HOLD, of8(1))], gap: UNCHECKED },
    ...([["CF9b", SECTIONS, []], ["CF9c", ["L1", ...SECTIONS], []], ["CF9c", ["L1", ...SECTIONS], [{ id: "L1" }]]] as const).map(([id, plan, lists]): Row => ({
      id: `${id} (misdeclared)`, name: `answers the 4-name sentence of a content declaration${lists.length ? ", beside the list the writer uses" : ", stating no list"} (Known limit)`, ...O4,
      steps: [read([OCT4_LIST], C), read(opens(ids(1, 4)), C), fin(C, ...plan)], w: [say(FOUR, SECTIONS, lists)], out: "answered", says: lists.length ? [FULL8, FOUR] : [FOUR],
    })),
    ...([["CF10b", ["L1", "E9"]], ["CF10a, CF12b", ["E3", "E9"]]] as const).map(([id, plan]): Row => ({
      id, name: `answers what one page says from its section when the content need cites ${plan[0] === "L1" ? "the list" : "the page's row"} too: no list, no note`, q: "What does the gate review page created on October 4 say about DVT?", need: "what the gate review page says about DVT",
      desk: () => oct4(), steps: [read([OCT4_LIST]), read(opens(["E3"])), fin(C, ...plan)], w: [say("The gate review says DVT is on hold pending fixture rework.", ["E9"])], out: "answered",
      says: [cite("The gate review says DVT is on hold pending fixture rework.", 1)], wl: { id: "L1", stated: false, checked: 1 },
    })),
    { id: "CF11 (i, iii)", name: "refuses a which_items finish on ten follow-up rows once; read to its end, all 12 are stated and the writer's two names left out", ...FU,
      steps: [read([FOLLOW_UPS], WI), fin(WI, ...ids(1, 10)), read([FOLLOW_UPS], WI), fin(WI, "L1")], w: [say("Your open follow-ups are THERM-41 and THERM-42.", ["E1", "E2"])],
      rejected: [`need N1 "my open follow-ups" ${UNLISTED} (L1); part 1 need N1 "my open follow-ups": ${KEEP_FOLLOW_UPS}`], out: "answered", says: [FU12] },
    { id: "CF11 (ii)", name: "stops research when the repair cites L1 alone, still unfinished: the writer's count stays, partial", ...FU, steps: [read([FOLLOW_UPS], WI), fin(WI, ...ids(1, 10)), fin(WI, "L1")], w: [say("You have 10 open follow-ups.", ids(1, 10))],
      rejected: [`need N1 "my open follow-ups" ${UNLISTED} (L1); part 1 need N1 "my open follow-ups": ${KEEP_FOLLOW_UPS}`, `need N1 "my open follow-ups": ${KEEP_FOLLOW_UPS}`],
      stop: "unusable_step", out: "partial", says: ["You have 10 open follow-ups."], gap: WHICH, listed: 1, wl: { id: "L1", stated: false } },
    { id: "CF12a", name: "accepts a finish on an opened page's row and section while that page's list is unfinished", q: "What accuracy does the PRD require?", need: "the PRD's accuracy requirement",
      desk: () => oct4({ more: true, open: vi.fn(async (input: { readonly item: string }) => { const row = PAGES.find(page => page.id === input.item)!; return result([section(row, "Readings within 0.1 C."), section(row, "Probe at 37 C.", 2)]) as EvidenceDeskResultV2; }) }),
      steps: [read([{ tool: "list", args: { source: "pages" } }]), read(opens(["E5"])), fin(undefined, "E5", "E9")], w: [say("The PRD requires readings within 0.1 C.", ["E9"])],
      stop: "finished", out: "answered", says: ["The PRD requires readings within 0.1 C."], listed: 1, lists: [{ id: "L1", ended: false }] },
    ...[[{ id: "L1", members: ["E5"] }, { id: "L1" }], [{ id: "L1" }, { id: "L1", members: ["E5"] }]].map((lists, index): Row => ({
      id: index === 0 ? "R4a, X2" : "R4c", name: "states a list in full and a member selected by id, in either order, the member one name, beside a content need's sentence", ...R4,
      w: [{ lists, sentences: [{ text: UPDATED, evidence: ["E9"] }], not_found: [] }], out: "answered", says: [FULL8, PRD_FACTS, UPDATED], citations: 9,
    })),
    { id: "R4b", name: "states the list first, then four pages selected by id with their facts: 8 members named", ...R4, w: [use({ id: "L1", members: ids(1, 4) })], out: "answered", citations: 8,
      says: [FULL8, `4 of the 8 Confluence pages created on October 4, 2026: ${[pageFacts(OCT4_TITLES[0]!, "October 5, 2026"), ...OCT4_TITLES.slice(1, 4).map(title => pageFacts(title))].join("; ")}.`] },
    { id: "R6, R10", name: "leaves out a sentence citing only the list's id after one repair, and says a claim was left out", ...O4, steps: [read([OCT4_LIST]), fin(WI, "L1")],
      w: [say("All eight are current pages.", ["L1"], [{ id: "L1" }]), say("All eight are current pages.", ["L1"], [{ id: "L1" }])], repaired: true, out: "partial", says: [FULL8], gap: UNSUPPORTED },
    { id: "R6", name: "answers with the list alone once the writer drops a list-id sentence after its repair", ...O4, steps: [read([OCT4_LIST]), fin(WI, "L1")], w: [say("All eight are current pages.", ["L1"]), useL1], repaired: true, out: "answered", says: [FULL8] },
    { id: "R7 (R2a)", name: "answers which tickets mention BUG-412 once all 8 were opened, the list's id beside the two: no note", q: "Which Jira tickets created on October 4, 2026 mention BUG-412?", need: "tickets created on 2026-10-04 that mention BUG-412",
      desk: () => jira(tickets(1, 8), { body: bodyText }), steps: [read([TICKETS_LIST]), read(opens(ids(1, 4))), read(opens(ids(5, 4))), fin(WS, "L1", "E3", "E5")], w: [say("THERM-3 and THERM-5 mention BUG-412.", ["L1", "E3", "E5"])],
      out: "answered", says: ["THERM-3 and THERM-5 mention BUG-412."], wl: { id: "L1", count: 8, checked: 8, stated: false } },
    { id: "R7 (R2b)", name: "notes the same form after four opens, never forcing it into a list", q: "Which Jira tickets created on October 4, 2026 mention BUG-412?", need: "tickets created on 2026-10-04 that mention BUG-412",
      desk: () => jira(tickets(1, 8), { body: bodyText }), steps: [read([TICKETS_LIST]), read(opens(ids(1, 4))), fin(WS, "L1", "E3")], w: [say("THERM-3 mentions BUG-412.", ["L1", "E3"])],
      out: "partial", says: [`THERM-3 mentions BUG-412 ${of8(4)}.`], gap: UNCHECKED },
    { id: "R7 (R3)", name: "answers which follow-ups mention the fan curve: every follow-up row was read in full when shown", q: "Which of my open follow-ups are about the fan curve?", need: "my open follow-ups about the fan curve", v4: {}, desk: () => followUps(TWELVE.slice(0, 4)),
      steps: [read([FOLLOW_UPS]), fin(WS, "L1", "E2", "E4")], w: [say("THERM-42 follow-up and THERM-44 follow-up say to ship fan curve v2 before DVT.", ["L1", "E2", "E4"])], out: "answered", says: ["THERM-42 follow-up and THERM-44 follow-up say to ship fan curve v2 before DVT."] },
    ...([["ZHEN YE", "answered"], ["Mara Quinn", "not_found"]] as const).map(([value, out]): Row => ({
      id: "X1", name: `answers which tickets are assigned to ${value} with only the members that owner records`, q: "Which of the Jira tickets created on October 4, 2026 are assigned to Zhen Ye?", need: TIX.need,
      desk: () => jira([ticketRow(1, "Zhen Ye"), ticketRow(2, "Dana Lee", "Done"), ticketRow(3, "zhen ye"), ticketRow(4, "Tobias Lund")]), steps: [read([TICKETS_LIST]), fin(WI, "L1")], w: [use({ id: "L1", where: { field: "owner", value } })], out,
      ...(out === "answered"
        ? { says: [cite("2 of the 4 Jira tickets created on October 4, 2026 have owner Zhen Ye: THERM-1: Fixture work 1; THERM-3: Fixture work 3.", 2)], check: ({ response }: Run) => expect(response.citations.map((citation: { label: string }) => citation.label)).toEqual(["THERM-1: Fixture work 1", "THERM-3: Fixture work 3"]) }
        : { says: [], citations: 0, gap: "Not found: Jira tickets created on October 4, 2026 that have owner Mara Quinn." }),
    })),
    { id: "X3", name: "writes the list itself when the writer gives no usable reply", ...O4, steps: [read([OCT4_LIST]), fin(WI, "L1")], w: UNUSABLE, out: "partial", says: [FULL8], gap: "I found these items, but could not write the rest of the answer.", check: ({ part }) => expect(part).not.toHaveProperty("records") },
    { id: "X4", name: "names 25 of a 60-ticket list and says 'and 35 more', the count from ECHO's own list", ...TIX, desk: () => jira(tickets(1, 60), { more: { page_full: false }, last: { page_full: false } }),
      steps: [read([TICKETS_LIST]), read([TICKETS_LIST]), read([TICKETS_LIST]), fin(WI, "L1")], w: [useL1], out: "answered", says: [cite(`60 Jira tickets created on October 4, 2026: ${names(1, 25)}; and 35 more.`, 25)],
      wl: { count: 60, complete: true }, lists: [{ id: "L1", members: ids(1, 60), complete: true }],
      check: ({ writer, response }) => { expect(writer[0]!.lists[0].members).toHaveLength(60); expect(response.citations.map((value: { label: string }) => value.label)).toEqual(tickets(1, 25).map(item => item.label)); } },
    { id: "X5", name: "makes a which_items need research left on rows partial when it stops: the writer's sentence stays, and no list is stated", ...O4,
      steps: [read([OCT4_LIST], WI), read(opens(ids(1, 4)), WI, "found", ids(1, 8)), ...UNUSABLE], w: [say(FOUR, SECTIONS)], rejected: BAD, stop: "unusable_step", out: "partial", says: [FOUR], gap: WHICH,
      check: ({ research }) => expect(research.plan[0].needs).toEqual([{ need: OCT4_NEED, kind: "which_items", status: "found", evidence: ids(1, 8) }]) },
    { id: "X5", name: "makes a which_items need left open partial when research stops for no progress", ...O4,
      steps: [read([OCT4_LIST], WI), ...["updated", "created", "updated"].map(date_field => read([{ tool: "list", args: { ...OCT4_LIST.args, date_field } }], WI))],
      w: [nothing("Confluence pages created on October 4, 2026")], stop: "no_progress", out: "partial", status: "not_found", says: [], gap: `${INCOMPLETE} Missing context: Confluence pages created on October 4, 2026. ${WHICH}` },
    { id: "X6", name: "tells the person a list's filter when the writer chooses to state it", ...X6, w: [say("Dana will publish the dashboard.", ["E1"], [{ id: "L1" }])], out: "answered",
      says: ["2 actions with status open: Meeting a1 (open); Meeting a2.", "Dana will publish the dashboard."], notice: partialNotice("Actions"),
      lists: [{ id: "L1", filter: { kind: "action", status: "open", time_zone: "UTC" }, filter_applied: { status: "partial" }, members: ["E1", "E2"], complete: true }], check: ({ research }) => expect(research.coverage.notices).toEqual([]) },
    { id: "X6", name: "never tells the person the filter of a list nothing names", ...X6, w: [say("Dana will publish the dashboard.", ["E1"])], out: "answered", says: ["Dana will publish the dashboard."] },
    { id: "X7a", name: "refuses a which_say finish before any page was read with what each kind of support is, never a change of kind", ...B4,
      steps: [read([OCT4_LIST], WS), fin(WS, "L1"), UNUSABLE[0]!], w: [nothing(BUG_NEED)], rejected: [HINT, BAD[0]!], stop: "unusable_step", out: "partial", status: "not_found", gap: `${INCOMPLETE} Missing context: ${BUG_NEED}. ${WHICH}`,
      check: ({ h, research }) => { for (const word of ["which_items", "which_say", "kind"]) expect(research.rounds[1].rejected[0]).not.toContain(word); expect(h.port.open).not.toHaveBeenCalled(); } },
    { id: "X7b (misdeclared)", name: "states the list alone for a which-say question declared which_items: the content is left out (Known limit)", ...B4, steps: [read([OCT4_LIST], WI), read(opens(ids(1, 4)), WI), fin(WI, "L1", "E12")], w: [say(TRACE, ["E12"])], out: "answered", says: [FULL8] },
    // X9b's first finish is refused, then repaired to cite the list: one that cites nothing is asked for the list, one that cites the opened pages is told their list's id.
    ...([
      ["X9", "", [none(WS, "L1")], []],
      ["X9b", ", after one refusal of a finish that cites nothing", [none(WS), none(WS, "L1")], [`${UNLISTED} (from lists), or list them first. `]],
      ["X9b", ", after one refusal of a finish that cites the opened pages, not their list", [none(WS, ...ids(1, 4)), none(WS, "L1")], [`${UNLISTED} (L1). `]],
    ] as const).map(([id, after, finishes, rejected]): Row => ({
      id, name: `answers a not_found which_say need over the list it checked with the unchecked gap${after}`, q: "Which pages created on October 4, 2026 mention BUG-999?", need: "pages created on 2026-10-04 that mention BUG-999", desk: () => oct4(),
      steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS), ...finishes], w: [nothing("pages created on October 4 that mention BUG-999")], rejected, stop: "finished", out: "not_found", says: [], citations: 0,
      gap: `Not found: pages created on October 4 that mention BUG-999. ${UNCHECKED}`, check: ({ research }) => expect(research.plan[0].needs).toEqual([{ need: "pages created on 2026-10-04 that mention BUG-999", kind: "which_say", status: "not_found", evidence: ["L1"] }]),
    })),
    { id: "X9b", name: "ends research on a repair that repeats the shape: partial, never an unqualified not_found", q: "Which pages created on October 4, 2026 mention BUG-999?", need: "pages created on 2026-10-04 that mention BUG-999", desk: () => oct4(),
      steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS), none(WS), none(WS)], w: [nothing("pages created on October 4 that mention BUG-999")], rejected: [`${UNLISTED} (from lists), or list them first`, `${UNLISTED} (from lists), or list them first`],
      stop: "unusable_step", out: "partial", status: "not_found", gap: `${INCOMPLETE} Missing context: pages created on October 4 that mention BUG-999. ${WHICH}`, check: ({ research }) => expect(research.plan[0].needs).toEqual([{ need: "pages created on 2026-10-04 that mention BUG-999", kind: "which_say", status: "open", evidence: [] }]) },
    { id: "X9c", name: "makes a which_say need a read step left not_found with no list partial when research stops", ...B4, steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS, "not_found"), ...UNUSABLE],
      w: [nothing("pages created on October 4 that mention BUG-412")], rejected: BAD, stop: "unusable_step", out: "partial", status: "not_found", says: [], gap: `${INCOMPLETE} Missing context: pages created on October 4 that mention BUG-412. ${WHICH}`,
      check: ({ research }) => expect(research.plan[0].needs).toEqual([{ need: BUG_NEED, kind: "which_say", status: "not_found", evidence: [] }]) },
    { id: "X10", name: "keeps a sentence with no note for a which_say need left open without its list, partial", ...B4, steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS), ...UNUSABLE], w: [say(TRACE, ["E12"])], rejected: BAD, stop: "unusable_step", out: "partial", says: [TRACE], gap: WHICH },
    { id: "X11", name: "never waits for the end of a which_say follow-up list, and notes it", q: "Which of my open follow-ups are about the fan curve?", need: "my open follow-ups about the fan curve", v4: {}, desk: () => followUps(TWELVE),
      steps: [read([FOLLOW_UPS], WS), fin(WS, "L1", "E2", "E4")], w: [say("THERM-42 follow-up and THERM-44 follow-up say to ship fan curve v2 before DVT.", ["E2", "E4"])], listed: 1,
      out: "partial", says: ["THERM-42 follow-up and THERM-44 follow-up say to ship fan curve v2 before DVT (10 of at least 10 checked so far)."], gap: UNCHECKED },
    { id: "X11b", name: "refuses a not_found which_say need until the list's end shows absence; all 12 rows shown, all were checked", q: "Which of my open follow-ups are about the oven?", need: "my open follow-ups about the oven", v4: {}, desk: () => followUps(TWELVE),
      steps: [read([FOLLOW_UPS], WS), none(WS, "L1"), read([FOLLOW_UPS], WS), none(WS, "L1")], w: [nothing("open follow-ups about the oven")], rejected: [`need N1 "my open follow-ups about the oven" ${ABSENT}`],
      out: "not_found", says: [], gap: "Not found: open follow-ups about the oven.", listed: 2, wl: { id: "L1", complete: true, count: 12, checked: 12 } },
    { id: "X12", name: "makes a list statement private when one member it names is", ...MARA, desk: () => meetings([meetingAction("a1", { list_label: LINES[0]! }), meetingAction("a2", { visibility: "approver_only", list_label: LINES[1]! })]),
      steps: [read([MARA_LIST]), fin(WI, "L1")], w: [useL1], out: "answered", says: [cite(`2 actions with owner Mara: ${LINES[0]}; ${LINES[1]}.`, 2)] },
    { id: "X13", name: "notes a content sentence about a member of a which_say list too (Known limit)", q: "Which pages created on October 4, 2026 mention BUG-412, and what does the PRD require?", needs: [BUG_NEED, "what the PRD requires"], desk: () => oct4(),
      steps: [step([OCT4_LIST], ["open", [], WS], ["open", [], C]), step(opens(ids(1, 4)), ["open", [], WS], ["open", [], C]), step(opens(["E5"]), ["open", [], WS], ["open", [], C]), step([FINISH], ["found", ["L1", "E12"], WS], ["found", ["E13"], C])],
      w: [sayAll([[TRACE, ["E12"]], ["The PRD requires readings within 0.1 C.", ["E13"]]])], out: "partial", says: [noted(TRACE, "(5 of 8 checked so far)"), "The PRD requires readings within 0.1 C (5 of 8 checked so far)."], gap: UNCHECKED },
    { id: "X14 (misdeclared)", name: "notes the October 4 subset for a which-items question declared which_say, after a refused finish, and states no list", ...O4,
      steps: [read([OCT4_LIST], WS), fin(WS, "L1"), read(opens(ids(1, 4)), WS, "open", ["L1"]), fin(WS, "L1", ...SECTIONS)], w: [say(FOUR, SECTIONS)], rejected: [HINT], out: "partial", says: [noted(FOUR, of8(4))], gap: UNCHECKED },
    { id: "X14 (misdeclared)", name: "answers the subset unqualified once all 8 were opened, as the stop rule asks (Known limit)", ...O4,
      steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS, "open", ["L1"]), read(opens(ids(5, 4)), WS, "open", ["L1"]), fin(WS, "L1", ...SECTIONS)], w: [say(FOUR, SECTIONS)], out: "answered", says: [cite(FOUR, 4)] },
    { id: "X15", name: "keeps both sentences, noted, when a which_items and a which_say need share a list (Known limit)", ...X15,
      steps: [bothOpen([OCT4_LIST], false), bothOpen(opens(ids(1, 4)), true), step([FINISH], ["found", ["L1"], WI], ["found", ["L1", "E12"], WS])], w: [sayAll([[TRACE, ["E12"]], [FOUR, SECTIONS]])],
      out: "partial", says: [FULL8, noted(TRACE, of8(4)), noted(FOUR, of8(4))], gap: UNCHECKED },
    { id: "X15", name: "keeps both unqualified once all 8 were opened: the restated subset stands beside the 8 names (Known limit)", ...X15,
      steps: [bothOpen([OCT4_LIST], false), bothOpen(opens(ids(1, 4)), true), bothOpen(opens(ids(5, 4)), true), step([FINISH], ["found", ["L1"], WI], ["found", ["L1", "E12"], WS])], w: [sayAll([[TRACE, ["E12"]], [FOUR, SECTIONS]])],
      out: "answered", says: [FULL8, TRACE, FOUR] },
    ...[sayAll([[TWO, ["L1", "E11", "E12"]]]), sayAll([[TWO, ["L1", "E11", "E12"]], ["The PRD and the verification plan were also created that day.", ["E5", "E6"]]])].map((repair): Row => ({
      id: "X15 (W4, W1)", name: `keeps a sentence on a which_say list's members beside the stated list, and ${repair.sentences.length === 1 ? "accepts the repair that drops a rows sentence" : "leaves out a repeated rows sentence"}`, ...X15,
      steps: [bothOpen([OCT4_LIST], false), bothOpen(opens(ids(1, 4)), false), bothOpen(opens(ids(5, 4)), false), step([FINISH], ["found", ["L1"], WI], ["found", ["L1", "E11", "E12"], WS])],
      w: [sayAll([[TWO, ["L1", "E11", "E12"]], ["The PRD and the verification plan were also created that day.", ["E5", "E6"]]]), repair], repaired: true, wl: { id: "L1", count: 8, checked: 8, stated: true },
      says: [FULL8, TWO], ...(repair.sentences.length === 1 ? { out: "answered" } : { out: "partial", gap: UNSUPPORTED }),
    })),
    { id: "X17a", name: "states a where date range with its condition, and keeps the writer's sentence beside a statement that names some members (Known limit)", ...WEEK,
      w: [say("THERM-43 follow-up and THERM-47 follow-up are due this week.", ["E3", "E7"], [due("2026-10-18", "2026-10-24")])], out: "answered", says: [THIS_WEEK, "THERM-43 follow-up and THERM-47 follow-up are due this week."],
      check: ({ writer }) => expect(writer[0]).toMatchObject({ today: "2026-10-18" }) },
    { id: "X17b", name: "states the same members selected by id with their facts, never the condition, and leaves out the sentence", ...WEEK,
      w: [say("THERM-43 follow-up and THERM-47 follow-up are due this week.", ["E3", "E7"], [{ id: "L1", members: ["E3", "E7"] }])], out: "answered", says: [FULL12, `2 ${LEAD12}: ${dueFacts(3)}; ${dueFacts(7)}.`] },
    { id: "X17c", name: "answers a range no member's due date falls in with the selection's not-found phrase", ...WEEK, w: [use(due("2026-10-23", "2026-10-29"))], out: "not_found", says: [], citations: 0, gap: NOT_DUE },
    { id: "X17d", name: "selects the overdue by an open range through yesterday", ...WEEK, w: [use(due(undefined, "2026-10-17"))], out: "answered", says: [`1 ${LEAD12} is due through October 17, 2026: THERM-41 follow-up.`] },
    ...([["Asia/Tokyo", `3 of the 8 Confluence pages created on October 4, 2026 were updated since October 11, 2026: ${OCT4_TITLES.slice(0, 3).join("; ")}.`], ["America/Los_Angeles", `1 of the 8 Confluence pages created on October 4, 2026 was updated since October 11, 2026: ${OCT4_TITLES[2]}.`]] as const)
      .map(([zone, text]): Row => ({ id: "X18a", name: `selects pages by an updated date on a list read by creation date, each day ${zone}'s`, ...x18(zone), w: [use({ id: "L1", where: { field: "updated", since: "2026-10-11" } })], out: "answered", says: [text] })),
    { id: "X18b", name: "sends a sentence on a row's date alone back once, the reason naming where; repeated, the list stands, partial", ...x18("UTC"), w: [say("The PRD was updated after October 10.", ["E5"]), say("The PRD was updated after October 10.", ["E5"])], repaired: true, out: "partial", says: [FULL8], gap: UNSUPPORTED },
    { id: "X19a", name: "answers which Jira tickets mention BUG-412 from search as content: no list, no note", ...X19, steps: [read([SEARCH_412], C), fin(C, ...ids(1, 9))], w: [say(HIT_NAMES, ids(1, 9))], out: "answered", says: [cite(HIT_NAMES, 9)] },
    { id: "X19b (misdeclared)", name: "declared which_say, it is refused until it cites a list, then noted over the first page shown (Known limit)", ...X19,
      steps: [read([SEARCH_412], WS), fin(WS, ...ids(1, 9)), read([ALL_TICKETS], WS, "open", ids(1, 9)), fin(WS, "L1", ...ids(1, 9))], w: [say(HIT_NAMES, ids(1, 9))], rejected: [`${UNLISTED} (from lists), or list them first`],
      out: "partial", says: [noted(HIT_NAMES, "(4 of at least 25 checked so far)")], gap: UNCHECKED },
    { id: "X19c (misdeclared)", name: "declared which_items, it reads the whole source and states it; the hits' sentence restates its members (Known limit)", ...X19,
      steps: [read([SEARCH_412], WI), fin(WI, ...ids(1, 9)), ...Array.from({ length: 3 }, () => [read([ALL_TICKETS], WI), fin(WI, "L1")]).flat()], w: [say(HIT_NAMES, ids(1, 9))],
      rejected: [`${UNLISTED} (from lists), or list them first`, "keep reading the list", "keep reading the list"], out: "answered", says: [`60 Jira tickets: ${names(1, 25)}; and 35 more.`], lists: [{ id: "L1", shown: 60, ended: true, complete: true }] },
    { id: "X20", name: "answers with no note once research read every listed page for a which_say need", ...B4,
      steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS, "open", ["L1"]), read(opens(ids(5, 4)), WS, "open", ["L1"]), fin(WS, "L1", ...ids(10, 7))],
      w: [say("Seven of the eight pages mention BUG-412: every page but ECHO Product Pipeline — Start Here.", ids(10, 7))], out: "answered", says: [cite("Seven of the eight pages mention BUG-412: every page but ECHO Product Pipeline — Start Here.", 7)] },
    ...[true, false].map((truncated): Row => ({
      id: "X22", name: `keeps the filter notice of a where selection that names nothing${truncated ? ", and the list-end gap of a list cut short" : " on a complete list"}`, q: "Which of Dana's Jira tickets created on October 4, 2026 are blocked?", need: TIX.need,
      desk: () => jira(tickets(1, 25), { last: { truncated } }), steps: [read([{ tool: "list", args: { ...TICKETS_LIST.args, owner: "Dana" } }]), fin(WI, "L1")], w: [use({ id: "L1", where: { field: "status", value: "Blocked" } })],
      out: truncated ? "partial" : "not_found", status: "not_found", says: [], citations: 0, notice: ownerNotice("Jira tickets"),
      gap: `Not found: Jira tickets created on October 4, 2026 that have status Blocked.${truncated ? ` ${leg("Jira tickets")}` : ""}`,
    })),
    ...([
      ["X23a", "cut short with no member", result(Array.from({ length: 50 }, (_, index) => listed(`x${index + 1}`, { kind: "action", attributes: { owner: "Dana Lee" } })), { truncated: true }), { members: [], ended: true, truncated: true, complete: false }],
      ["X23b", "a source that could not serve its page", result([], { notice: "Meetings are temporarily unavailable." }), { members: [], available: false, complete: false }],
      ["X23c", "a complete list with no member", result([]), { members: [], complete: true }],
    ] as const).map(([id, name, page, list]): Row => ({
      id, name: `states a which_items need's list by its completeness, with no writer call: ${name}`, ...MARA, desk: () => ({ list: vi.fn(async () => page as EvidenceDeskResultV2) }), steps: [read([MARA_LIST]), fin(WI, "L1")], w: [],
      stop: "finished", says: [], citations: 0, lists: [{ id: "L1", ...list }], status: "not_found",
      // A list with no member is named by its kind filter: Mara's list is of actions (research tool contract v1).
      ...(id === "X23c" ? { out: "not_found", gap: MISSING } : { out: "partial", gap: `${MISSING} ${leg("actions")}`, ...(id === "X23b" ? { notice: "Meetings are temporarily unavailable." } : {}) }),
    })),
    { id: "X26a", name: "states every list a which_items need reads past the writer's five, and the sixth list's filter notice", ...daily(6, WI, EMPTY, { owner: 6 }), out: "answered", notice: ownerNotice("Confluence pages"), says: [1, 2, 3, 4, 5, 6].map(dayStatement) },
    { id: "X26b", name: "states the first ten of eleven lists, the response's ten statements, and says what did not fit", ...daily(11, WI, EMPTY), out: "partial", gap: FIT, says: Array.from({ length: 10 }, (_, index) => dayStatement(index + 1)) },
    { id: "X26c", name: "notes and gaps a which_say need checking a sixth list past the writer's five", out: "partial", says: ["Day 6 plan traces BUG-412 to TC-D-03 (1 of 2 checked so far)."], gap: UNCHECKED,
      ...daily(6, WS, say("Day 6 plan traces BUG-412 to TC-D-03.", ["E8"]), { pages: n => n === 6 ? [dayPage(6), dayPage(7)] : [dayPage(n)], opened: ["E6"], cited: ["E8"] }) },
    { id: "X27a", name: "keeps a sentence on a stated list member's text while a content need research left open cites nothing", ...X27,
      steps: [X27_LIST, step(opens(["E3"]), ["found", ["L1"], WI], ["open", [], C]), ...UNUSABLE], w: [say(DVT_GATE, ["E9"])], rejected: BAD, stop: "unusable_step", out: "answered", notice: STOPPED, says: [FULL8, DVT_GATE] },
    { id: "X27b", name: "keeps it, partial, while a which_say need research left without its list", ...X27,
      steps: [X27_LIST, step(opens(["E4"]), ["found", ["L1"], WI], ["open", [], WS, BUG_NEED]), ...UNUSABLE], w: [say(TRACE, ["E9"])], rejected: BAD, stop: "unusable_step", out: "partial", says: [FULL8, TRACE], gap: WHICH },
    { id: "X27c", name: "leaves it out once every need declares and the content need was found on another item (Known limit)", ...X27,
      steps: [X27_LIST, step(opens(["E3", "E4"]), ["found", ["L1"], WI], ["open", [], C]), step([FINISH], ["found", ["L1"], WI], ["found", ["E10"], C])], w: [say(DVT_GATE, ["E9"])], stop: "finished", out: "answered", says: [FULL8] },
    ...([["X27d", "open", ["E9"], false], ["X27d", "found", ["E9"], false], ["X27e", "found", ["L1"], true], ["X27e", "open", [], true]] as const).map(([id, status, evidence, restates]): Row => ({
      id, name: `reads what a content need ${status} citing [${evidence.join(", ")}] declares from what it cites: ${restates ? "nothing, so no restatement is left out" : "Gate reviews, so the Traceability restatement is left out"}`, ...X27,
      steps: [X27_LIST, step(opens(["E3", "E4"]), ["found", ["L1"], WI], [status, evidence, C]), ...UNUSABLE], w: [sayAll([[DVT_GATE, ["E9"]], [RESTATE, ["E10"]]])], rejected: BAD, stop: "unusable_step", out: "answered", notice: STOPPED,
      says: restates ? [FULL8, DVT_GATE, RESTATE] : [FULL8, DVT_GATE],
    })),
    ...([[["E9"], false], [[], true]] as const).map(([evidence, restates]): Row => ({
      id: "X27f", name: `reads what a content need research marked not_found declares from what it cites: [${evidence.join(", ")}]`, ...X27, desk: () => oct4({ search: vi.fn(async () => result([]) as EvidenceDeskResultV2) }),
      steps: [step([OCT4_LIST, { tool: "search", args: { query: "DVT gate hold" } }, { tool: "search", args: { query: "DVT gate status" } }], ["open", [], WI], ["open", []]), step(opens(["E3", "E4"]), ["found", ["L1"], WI], ["open", [], C]), step([FINISH], ["found", ["L1"], WI], ["not_found", evidence, C])],
      w: [sayAll([[DVT_GATE, ["E9"]], [RESTATE, ["E10"]]])], stop: "finished", out: "answered", says: restates ? [FULL8, DVT_GATE, RESTATE] : [FULL8, DVT_GATE],
    })),
    { id: "X30", name: "names a page two stated lists hold once against the answer's 25 names, the writer using no list", ...X30, w: [EMPTY] },
    { id: "X30", name: "names it once whatever each list's use: a where selection of each", ...X30, w: [use({ id: "L1", where: { field: "status", value: "current" } }, { id: "L2", where: { field: "status", value: "current" } })] },
    { id: "X30", name: "names it once whatever each list's use: each list by id, merged with its use in full (W2)", ...X30, w: [use({ id: "L1", members: ids(1, 20) }, { id: "L2", members: ids(1, 20) })] },
    { id: "X31a", name: "keeps a sentence on a member a where selection does not name beside that selection", ...WEEK, w: [say(UNSELECTED, ["E1"], [due("2026-10-18", "2026-10-24")])], out: "answered", says: [THIS_WEEK, UNSELECTED] },
    { id: "X31b", name: "keeps it beside a where selection naming none, partial with its not-found phrase", ...WEEK, w: [say(UNSELECTED, ["E1"], [due("2026-10-23", "2026-10-29")])], out: "partial", says: [UNSELECTED], gap: NOT_DUE },
    { id: "X31c", name: "leaves it out beside the list stated in full", ...WEEK, w: [say(UNSELECTED, ["E1"])], out: "answered", says: [FULL12] },
    { id: "X31d", name: "leaves it out beside a where selection holding every member", ...WEEK, w: [say(UNSELECTED, ["E1"], [{ id: "L1", where: { field: "status", value: "open" } }])], out: "answered", says: [expect.stringMatching(/^12 of the 12 follow-ups with owner Mara Lind and status open have status open: /u)] },
    { id: "X33a", name: "checks no page whose sections the loop left out to fit an open, and tells research the open was cut (addition 4)", ...B4, desk: () => oct4({ open: gateOpen("BUG-412") }),
      steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS, "open", ["L1"]), read(opens(ids(5, 4)), WS, "open", ["L1"]), fin(WS, "L1", "E19")], w: [say(TRACE, ["E19"])],
      out: "partial", says: [noted(TRACE, "(7 of 8 checked so far)")], gap: UNCHECKED, wl: { id: "L1", count: 8, checked: 7 },
      check: ({ research, steps, writer }) => {
        expect(research.rounds[1].actions[2].result).toMatchObject({ id: "E3", ...GATE_CUT });
        expect(steps[2]!.last_results[2]).toEqual({ tool: "open", args: { id: "E3" }, ...GATE_CUT });
        expect(writer[0]!.lists[0].members[2]).toMatchObject({ id: "E3", checked: false }); } },
    { id: "X33b", name: "qualifies its absence too: the unread tenth section is the one that names BUG-999", q: "Which pages created on October 4, 2026 mention BUG-999?", need: "pages created on 2026-10-04 that mention BUG-999", desk: () => oct4({ open: gateOpen("BUG-999") }),
      steps: [read([OCT4_LIST], WS), read(opens(ids(1, 4)), WS, "open", ["L1"]), read(opens(ids(5, 4)), WS, "open", ["L1"]), none(WS, "L1")], w: [nothing("pages created on October 4 that mention BUG-999")],
      out: "not_found", says: [], gap: `Not found: pages created on October 4 that mention BUG-999. ${UNCHECKED}` },
    { id: "X34a", name: "keeps only the actions an owner filter names by whole words, so the statement's owner is every member's", q: "Which actions does Dan own?", need: "actions owned by Dan",
      desk: () => meetings(["Dan Ruiz", "Dana Lee", "Jordan Park"].map((owner, index) => record(`a${index + 1}`, `Action ${index + 1}.`, { kind: "action", attributes: { owner } }))),
      steps: [read([{ tool: "list", args: { source: "meetings", owner: "Dan" } }]), fin(WI, "L1")], w: [EMPTY], out: "answered", says: ["1 action with owner Dan: Meeting a1."], lists: [{ id: "L1", members: ["E1"], filter_applied: { owner: "applied" }, complete: true }] },
    { id: "X34b", name: "says a status filter is partial when a member's status is in neither group, as when it records none", q: "Which decisions are still open?", need: "open decisions",
      desk: () => meetings(["decided", "proposed", "unresolved"].map((status, index) => record(`d${index + 1}`, `Decision ${index + 1}.`, { kind: "decision", attributes: { status } }))),
      steps: [read([{ tool: "list", args: { source: "meetings", kind: "decision", status: "open" } }]), fin(WI, "L1")], w: [EMPTY], out: "answered", says: [expect.stringMatching(/^3 decisions with status open: /u)],
      notice: partialNotice("Decisions"), lists: [{ id: "L1", members: ids(1, 3), filter_applied: { kind: "applied", status: "partial" } }],
      check: ({ steps }) => expect(steps[1]!.last_results[0].note).toContain("some items do not record open or done; they are included") },
    ...[["E2", "E3"], ["L1", "E3"], ["E3", "L1"]].map((evidence): Row => ({
      id: "X35c", name: `makes a writer's sentence citing ${evidence.join(" and ")} private: it cites the approver_only row it saw beside team text`, ...x35([SHARED, RESTRICTED], "E3"), w: [say(DRAWINGS, evidence)], says: [cite(DRAWINGS, 2)],
      check: run => { expect(run.writer[0]!.lists[0].members[1]).toMatchObject({ id: "E2", title: RESTRICTED.list_label }); visibilities(["decision", "team"], ["action", "approver_only"])(run); },
    })),
    { id: "X35c", name: "brings nothing through a list with no private row the writer saw", ...x35([SHARED], "E2"), w: [say(DRAWINGS, ["L1", "E2"])], says: [cite(DRAWINGS, 1, true)], check: visibilities(["decision", "team"]) },
    { id: "addition 4", name: "checks a ticket whose open was cut only beside it, its links; research is told only that the open was truncated", ...A4, desk: () => anchorJira({ anchor_truncated: false }), out: "answered", notice: COVERAGE, says: ["THERM-3 mentions BUG-412."], wl: { id: "L1", count: 4, checked: 4 },
      check: ({ research, steps }) => {
        expect(research.rounds[1].actions[2].result).toMatchObject({ id: "E3", opened: ["E3"], truncated: true, anchor_truncated: false });
        expect(steps[2]!.last_results[2]).toEqual({ tool: "open", args: { id: "E3" }, opened: ["E3"], results: ids(5, 4), truncated: true }); } },
    ...[{ anchor_truncated: true }, {}].map((own): Row => ({
      id: "addition 4", name: own.anchor_truncated ? "never checks a ticket whose own text was cut" : "never checks one a desk does not say was cut only beside it", ...A4, desk: () => anchorJira(own),
      out: "partial", notice: COVERAGE, says: ["THERM-3 mentions BUG-412 (3 of 4 checked so far)."], gap: UNCHECKED, check: ({ research }) => expect(research.rounds[1].actions[2].result).not.toHaveProperty("anchor_truncated"),
    })),
    ...[0, 2_960].map((pad): Row => ({
      id: "addition 4", name: pad === 0 ? "checks an action whose open was cut beside it, its meeting's other records" : "checks it when the loop also leaves out other records that do not fit", ...VENDOR_ACTIONS, desk: () => vendorMeeting(pad),
      steps: [read([MARA_LIST], WS), read(opens(ids(1, 4)), WS, "open", ["L1"]), fin(WS, "L1", "E4")], w: [say("Mara will chase the vendor about the fixture drawings.", ["E4"])], out: "answered", notice: COVERAGE, wl: { id: "L1", count: 4, checked: 4 },
      check: ({ research }) => { expect(research.rounds[1].actions[3].result).toMatchObject({ id: "E4", truncated: true, anchor_truncated: false }); if (pad > 0) expect(research.rounds[1].actions[3].result.opened.length).toBeLessThan(10); },
    })),
    ...([[{ anchor_truncated: false }, 1], [{ anchor_truncated: true }, 2]] as const).map(([own, calls]): Row => ({
      id: "rev 12", name: own.anchor_truncated ? "opens a repeated item whose own text was cut again" : "answers a repeated open of an item cut only beside it from the scratchpad", q: "What does THERM-3 say about BUG-412?", need: "what THERM-3 says about BUG-412",
      desk: () => jira(tickets(1, 4), { open: vi.fn(async () => result([ticketBody(3, bodyText(3)), ...tickets(11, 4)], { truncated: true, ...own }) as EvidenceDeskResultV2) }),
      steps: [read([TICKETS_LIST]), read(opens(["E3"])), read(opens(["E3"])), fin(C, "E3")], w: [say("THERM-3 references BUG-412 in its repro steps.", ["E3"])], out: "answered", notice: COVERAGE,
      check: ({ h, research }) => { expect(h.port.open).toHaveBeenCalledTimes(calls); if (calls === 1) expect(research.rounds[2].actions[0].result).toMatchObject({ note: "already open; its full text is in your scratchpad" }); },
    })),
  ]);
});

/** X18's pages: late on Oct 10 in UTC (Oct 11 in Tokyo), early on Oct 11 in UTC (Oct 10 in Los Angeles), Oct 12, and one with no updated date. */
function x18(time_zone: string) {
  const updates = ["2026-10-10T23:30:00.000Z", "2026-10-11T03:00:00.000Z", "2026-10-12T09:00:00.000Z"];
  const rows = PAGES.map((row, index) => { const { updated: _updated, ...created } = row.dates!; return Object.freeze({ ...row, dates: index === 3 ? created : updates[index] === undefined ? row.dates : { ...row.dates, updated: updates[index] } }); });
  return {
    q: "Which of the Confluence pages created on October 4, 2026 were updated after October 10?", need: "pages created on 2026-10-04", v4: { now: "2026-10-18T01:00:00.000Z", time_zone },
    desk: () => followUps(rows, 50, { live_sources: [CONFLUENCE] }), steps: [read([OCT4_LIST], WI), fin(WI, "L1")],
  };
}

describe("Ask's access check over a list's members (ADR-0041)", () => {
  it("checks access before every model call: a list member revoked mid-request stops research or the writer, and the count is ECHO's own", async () => {
    const revoking = (at: number) => { let checks = 0; return vi.fn(async () => { checks += 1; if (checks === at) throw new AuthorityOperationError("unauthorized", "A listed item is no longer readable"); return checked; }); };
    // The check before the second research call covers the rows the list released: no model sees them again.
    const revalidate = revoking(2);
    const stopped = harness(script(OCT4, [OCT4_NEED], [read([OCT4_LIST]), fin(WI, "L1")], [useL1]).replies, oct4({ revalidate }));
    await expect(stopped.research.research({ trigger: "ask", brief: { goal: { kind: "question", question: OCT4 }, starting: [], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: false } } })).rejects.toMatchObject({ code: "unauthorized" });
    expect([stopped.generate.mock.calls.length, revalidate.mock.calls.length, stopped.audit]).toEqual([1, 2, []]);
    // A vendor's total is never read: the count is the members the desk released; the check before the writer covers them too.
    const released = [ticketRow(1), { ...ticketRow(2), visibility: "team" as const }, ticketRow(3)];
    const desk = (extra: Partial<EvidenceDeskPortV2> = {}) => jira([], { list: vi.fn(async () => ({ ...result(released), total: 500 }) as unknown as EvidenceDeskResultV2), ...extra });
    const replies = () => script(TIX.q, [TIX.need], [read([TICKETS_LIST]), fin(WI, "L1")], [useL1]).replies;
    const answered = harness(replies(), desk());
    const { response } = await answered.research.answerWithResearch({ question: TIX.q });
    expect(response.parts[0]!.statements).toEqual([cite(`3 Jira tickets created on October 4, 2026: ${released.map(item => item.label).join("; ")}.`, 3)]);
    expect(response.citations.map(citation => citation.visibility)).toEqual(["only_me", "team", "only_me"]);
    expect(answered.inputs.at(-1)!.user_prompt).not.toContain("500");
    const revoked = harness(replies(), desk({ revalidate: revoking(3) }));
    await expect(revoked.research.answerWithResearch({ question: TIX.q })).rejects.toMatchObject({ code: "unauthorized" });
    expect(revoked.generate).toHaveBeenCalledTimes(2);
  });
});

describe("a task goal keeps the rules before ADR-0041", () => {
  const approved = record("approved", "Approved: ship the DVT fixture.");
  const task: AgenticBriefV1 = {
    goal: { kind: "task", task: `Find what ${agenticStartingSlotV1(1)} affects.` }, starting: [{ citation: approved.citation, if_unreadable: "fail" }],
    budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, options: { small_scope_preload: false },
  };
  const affects = (need: string, status: "open" | "found", evidence: readonly string[], actions: readonly unknown[]) => ({ parts: [{ question: "What does E1 affect?", needs: [{ need, status, evidence }], notes: "" }], actions });

  it("X16: sees inventories, never lists, cites no list id and records none", async () => {
    const steps = [affects("tickets the record affects", "open", [], [ALL_TICKETS]), ...Array.from({ length: 2 }, () => affects("tickets the record affects", "found", ["L1", "E2"], [FINISH]))];
    const h = harness(steps, { ...jira(tickets(1, 3)), openCitation: async () => result([approved]) });
    const view = await h.research.research({ trigger: "approved_record", brief: task });
    expect(h.prompt(1)).not.toHaveProperty("lists");
    expect(h.prompt(1).inventories).toEqual([{ args: { source: "tickets" }, shown_count: 3, more: false, available: true, truncated: false }]);
    // Its step schema and plan declare no kind.
    const needSchema = (h.inputs[0]!.schema as { properties: { parts: { items: { properties: { needs: { items: { required: readonly string[]; properties: object } } } } } } }).properties.parts.items.properties.needs.items;
    expect(needSchema.required).toEqual(["need", "status", "evidence"]);
    expect(needSchema.properties).not.toHaveProperty("kind");
    expect((h.prompt(1).plan as { needs: object[] }[])[0]!.needs[0]).not.toHaveProperty("kind");
    expect(h.prompt(1).last_results).toEqual([{ tool: "list", args: { source: "tickets" }, items: ["E2", "E3", "E4"], more: false }]);
    // A task's need still needs an item read in full; L1 is no id there, so it is dropped.
    expect(view.rounds[1]!.rejected).toEqual(Array.from({ length: 2 }, () => expect.stringContaining("is found but cites no item whose full text you have read")));
    expect([view.stop, view.plan[0]!.needs[0]!.evidence, "lists" in view]).toEqual([{ reason: "unusable_step", completed: false }, [], false]);
  });

  it("X33: sees an open the loop cut to fit its bounds as before: only the desk says it was truncated", async () => {
    const gate = PAGES[2]!;
    const sections = Array.from({ length: 10 }, (_, index) => section(gate, `Section ${index + 1}. ${"Gate review narrative. ".repeat(130).slice(0, 2960)}`, index + 1));
    const steps = [[[{ tool: "list", args: { source: "pages" } }], []], [opens(["E4"]), []], [[FINISH], ["E10"]]] as const;
    const h = harness(steps.map(([actions, evidence]) => affects("pages the record affects", evidence.length === 0 ? "open" : "found", evidence, actions)), {
      live_sources: [CONFLUENCE], openCitation: async () => result([approved]), list: vi.fn(async () => result(PAGES) as EvidenceDeskResultV2), open: vi.fn(async () => result(sections) as EvidenceDeskResultV2),
    });
    await h.research.research({ trigger: "approved_record", brief: task });
    // The rows are E2..E9 and Gate reviews is E4; the loop admits 8 of its 10 sections, and a task goal's step is told nothing more.
    expect((h.prompt(2).last_results as readonly unknown[])[0]).toEqual({ tool: "open", args: { id: "E4" }, opened: ids(10, 8) });
  });

  it("X12: gives a task goal over the same meeting rows the same model inputs, with or without their list labels", async () => {
    const lines = ["Publish the DVT dashboard", "Order fixture spares"];
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "approved_record")!;
    const record_ = record("approved", "Approved: Mara publishes the DVT dashboard.");
    const event = definition.parseEvent({ record: record_.citation });
    const card = async (labelled: boolean) => {
      const rows = lines.map((value, index) => meetingAction(`a${index + 1}`, { label: "DVT review (2026-10-01)", ...(labelled ? { list_label: `${value} (DVT review, 2026-10-01)` } : {}) }));
      const h = harness([
        affects("work the record affects", "open", [], [MARA_LIST]), affects("work the record affects", "found", ["E1"], [FINISH]), { decided: [{ id: "E1", text: "Mara publishes the DVT dashboard." }], affected: [] },
      ], { openCitation: async () => result([record_]), list: vi.fn(async () => result(rows) as EvidenceDeskResultV2) });
      await h.research.renderWithResearch({ trigger: "approved_record", brief: definition.brief(event, h.port.scope), renderer: definition.renderer!, trigger_input: event });
      return h.inputs.map(({ signal: _signal, ...input }) => input);
    };
    const labelled = await card(true);
    expect(labelled).toHaveLength(3);
    expect(labelled).toEqual(await card(false));
    for (const input of labelled) for (const value of lines) expect(input.user_prompt).not.toContain(value);
  });
});

describe("the finish check for a question goal (ADR-0041)", () => {
  const lists: readonly AskResearchListV1[] = [
    { id: "L1", ended: true, args: { source: "pages" }, members: ["E1", "E2", "E3"] },
    { id: "L2", ended: false, args: { source: "tickets" }, members: ["E4", "E5"] },
  ];
  const page = (page_id: string) => ({ kind: "page", tool_id: "confluence", external_scope_id: "site-one", page_id, section_id: "inventory" });
  const ticket = (ticket_id: string) => ({ kind: "ticket", tool_id: "jira", external_scope_id: "cloud-one", ticket_id });
  // The items the request registered, read for membership as the loop reads it: E9 is ticket E5's text under its own
  // id, so part of L2's member E5; E8 is a record, read in full, that no list holds.
  const items = ([["E1", page("1")], ["E2", page("2")], ["E3", page("3")], ["E4", ticket("4")], ["E5", ticket("5")], ["E9", ticket("5")], ["E8", { kind: "approved_record", atom_id: "a8" }]] as const)
    .map(([short, citation]) => ({ short, item: { citation } }));
  const full = (id: string) => id === "E9" || id === "E4" || id === "E8";
  const settled = (kind: string | undefined, status: "found" | "not_found", evidence: readonly string[]) =>
    [{ needs: [{ id: "N1", need: "the need", ...(kind === undefined ? {} : { kind: kind as "which_items" }), status, evidence, observations_before: 0 }] }];
  const LISTED = [{ operation: "list" as const, fingerprint: "k", complete: true }];
  const label = 'part 1 need N1 "the need"';
  const unlisted = (holders?: string) => `${label} ${UNLISTED}${holders === undefined ? " (from lists), or list them first" : ` (${holders})`}`;
  const unfinished = (id: string, source: string) => `${label}: list ${id} is unfinished: keep reading the list (repeat list with {"source":"${source}"})`;
  const unread = `${label} ${HINT}`;
  const absent = `${label} ${ABSENT}`;
  const L1_OPEN: readonly AskResearchListV1[] = [{ ...lists[0]!, ended: false }, lists[1]!];

  it.each([
    // which_items: a list read to its end, waiting for one that is not, and the list that holds cited rows (F1, F2).
    [WI, ["L1"], []], [WI, ["L1", "E1", "E9"], []], [WI, ["L2"], [unfinished("L2", "tickets")]],
    [WI, ["E1", "E2"], [unlisted("L1")]], [WI, ["E1", "E2"], [unlisted("L1"), unfinished("L1", "pages")], L1_OPEN], [WI, ["E1", "E4"], [unlisted("L1 or L2"), unfinished("L2", "tickets")]],
    [WI, ["L9"], [unlisted()]], [WI, ["E8"], [unlisted()]], [WI, ["E9"], [unlisted("L2"), unfinished("L2", "tickets")]],
    // which_say: the list it checks, never its end, and text read in full (F1, F3); an opened part is its member's.
    [WS, ["L1", "E9"], []], [WS, ["L2", "E9"], []], [WS, ["E9"], [unlisted("L2")]], [WS, ["E8"], [unlisted()]], [WS, ["L1"], [unread]],
    // content: one cited item read in full; its list ids, and rows of an unfinished list, carry no meaning (F3).
    [undefined, ["E9"], []], [C, ["E9"], []], [C, ["E5", "E9"], []], [C, ["L2", "E9"], []], [C, ["E4"], []], [C, ["L1"], [unread]], [C, ["E1", "E2"], [unread]], [C, [], [unread]],
  ] as const)("found %s citing %j: %j", (kind, evidence, expected, given: readonly AskResearchListV1[] = lists) => {
    expect(askQuestionCompletionProblemsV1(settled(kind, "found", evidence), [], given, full, agenticListMembershipV1(given, items).in)).toEqual(expected);
  });

  it.each([
    // A not_found which_say need cites the list it checked (F1, `listed`); absence waits for a completed list, whatever the kind (F4).
    [WS, [], LISTED, [unlisted()]], [WS, ["E1", "E2"], LISTED, [unlisted("L1")]], [WS, ["L1"], LISTED, []], [WS, ["L2"], [], [absent]],
    [WI, [], LISTED, []], [WI, ["E1"], LISTED, []], [C, [], LISTED, []], [undefined, [], [], [absent]],
  ] as const)("not_found %s citing %j after %j: %j", (kind, evidence, observations, expected) => {
    expect(askQuestionCompletionProblemsV1(settled(kind, "not_found", evidence), observations, lists, full, agenticListMembershipV1(lists, items).in)).toEqual(expected);
  });

  it("keeps the not_found and open rules, and a task goal's rule for every need, whatever kind it names", () => {
    const check = (parts: Parameters<typeof askQuestionCompletionProblemsV1>[0], observations: Parameters<typeof askQuestionCompletionProblemsV1>[1]) =>
      askQuestionCompletionProblemsV1(parts, observations, lists, full, agenticListMembershipV1(lists, items).in);
    for (const word of ["which_items", "which_say", "kind"]) expect(unread).not.toContain(word);
    const need = (status: "open" | "not_found", kind?: "which_items") => [{ needs: [{ need: "x", ...(kind === undefined ? {} : { kind }), status, evidence: [], observations_before: 0 }] }];
    expect([check(need("not_found"), LISTED), check(need("not_found"), []), check(need("open"), []), check(need("open", "which_items"), []), check([], [])])
      .toEqual([[], [`part 1 need "x" ${ABSENT}`], ['part 1 need "x" is still open'], ['part 1 need "x" is still open'], ["no parts were written"]]);
    const searches = [{ operation: "search" as const, fingerprint: "a", complete: true }, { operation: "search" as const, fingerprint: "b", complete: true }];
    const unreadTask = `${label} is found but cites no item whose full text you have read`;
    expect([
      askResearchCompletionProblemsV1(settled(undefined, "found", ["E5", "E9"]), [], full), askResearchCompletionProblemsV1(settled(undefined, "found", ["E1"]), [], full),
      askResearchCompletionProblemsV1(settled(WI, "found", ["L1"]), [], full), askResearchCompletionProblemsV1(settled(undefined, "not_found", []), searches, full),
      askResearchCompletionProblemsV1(settled(undefined, "not_found", ["E1"]), searches.slice(0, 1), full, false),
    ]).toEqual([[], [unreadTask], [unreadTask], [], [`${label} is not_found after fewer than two completed searches`]]);
  });
});
