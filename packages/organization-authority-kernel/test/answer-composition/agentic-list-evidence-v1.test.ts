import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import { trimAgenticEvidenceBundleV1, type AgenticEvidenceBundleV1 } from "../../src/answer-composition/agentic-evidence-bundle-v1.js";
import {
  AGENTIC_LIST_FILTER_FIELDS_V1, AGENTIC_LIST_NAMED_MAX_V1, AGENTIC_LIST_SELECTION_FIELDS_V1, AGENTIC_LIST_STATEMENT_BYTES_V1,
  agenticCalendarDayV1, agenticListCheckedNoteV1, agenticListCompleteV1, agenticListEndUnverifiedV1, agenticListFilterNoticeV1, agenticListFilterPhraseV1, agenticListIdV1,
  agenticListMembersNounV1, agenticListMembershipV1, agenticListNameSharesV1, agenticListNounV1, agenticListSelectionNotFoundV1, agenticListSelectV1, agenticListStatementV1,
  agenticNeedReadsListV1, agenticOpenReadsV1, agenticPlanListsV1, agenticWriterListMemberV1, agenticWriterListV1, createAgenticListEvidenceV1, parseAgenticListIdV1,
  type AgenticAnswerListUseV1, type AgenticListEvidenceInputV1, type AgenticListEvidenceV1, type AgenticListFilterApplicationV1, type AgenticListIdV1,
  type AgenticListNounFormsV1, type AgenticListSelectionV1, type AgenticListStatementInputV1, type AgenticOpenActionV1, type AgenticWriterListMemberV1,
} from "../../src/answer-composition/agentic-list-evidence-v1.js";
import type { AgenticResearchResultV1 } from "../../src/answer-composition/agentic-research-v1.js";
import type { EvidenceDeskResultV1 } from "../../src/shared/evidence-desk-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import type { PersonLiveEvidencePageV1, PersonLiveEvidenceResultV1 } from "../../src/shared/person-live-evidence-v1.js";
import { EMPTY_BUNDLE } from "./fixtures/agentic-scenarios.js";

/**
 * The list-evidence contract (ADR-0041): the list record, the two support
 * kinds and the writer's view. The October 4 list is the run that held the
 * release (trace ee2f0973): 8 page rows, read to their end.
 */
const OCTOBER_4: AgenticListEvidenceInputV1 = {
  id: "L1", source: "pages", filter: { date_field: "created", since: "2026-10-04", until: "2026-10-04", time_zone: "America/Los_Angeles" },
  filter_applied: { date_field: "applied", since: "applied", until: "applied" },
  members: ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"], shown: 8,
  ended: true, unverified_end: false, available: true, truncated: false, read_at: "2026-10-17T06:58:33.120Z",
};

/** Nouns as the renderer builds them, from a list's catalog entry and its members' kinds. */
const PAGES = agenticListMembersNounV1({ selector: "pages", tool_id: "confluence" }, ["page"]);
const TICKETS = agenticListMembersNounV1({ selector: "tickets", tool_id: "jira" }, ["ticket"]);
const DECISIONS = agenticListMembersNounV1({ selector: "meetings" }, ["decision"]);
const ACTIONS = agenticListMembersNounV1({ selector: "meetings" }, ["action"]);
const FOLLOW_UPS = agenticListMembersNounV1({ selector: "follow_ups" }, ["follow_up"]);
/** A source's own noun, for members of no one kind. */
const ITEMS = agenticListMembersNounV1({ selector: "items" }, []);
/** A statement over `selected`: complete and unfiltered unless given, naming as many as it may. */
const statement = (input: Partial<AgenticListStatementInputV1> & Pick<AgenticListStatementInputV1, "selected">) =>
  agenticListStatementV1({ noun: ITEMS, filter: {}, count: input.selected.length, complete: true, share: 25, ...input });

function pageRow(id: string, label: string): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `page_${id}_inventory`, source_id: "confluence", kind: "page" as const, label, visibility: "only_me" as const,
    citation: { kind: "page" as const, tool_id: "confluence", external_scope_id: "site-one", page_id: id, section_id: "inventory", version: "3", permalink: `https://knowledge.example.test/wiki/pages/${id}`, text_sha256: sha256Digest("") },
    dates: { created: "2026-10-04T23:12:00.000Z", updated: "2026-10-04T23:38:00.000Z" }, occurred_at: "2026-10-04", date_kind: "version_created" as const,
    attributes: { status: "current" }, receipt_sha256: canonicalSha256({ page: id }),
  } satisfies EvidenceDeskItemV2);
}

describe("list ids", () => {
  it("names lists L1, L2, ... and reads only list ids", () => {
    expect([agenticListIdV1(1), agenticListIdV1(12)]).toEqual(["L1", "L12"]);
    for (const position of [0, -1, 1.5, 10_000]) expect(() => agenticListIdV1(position)).toThrow(RangeError);
    for (const [raw, id] of [["L3", "L3"], ["l3", "L3"], ["[L3]", "L3"], [" L 3 ", "L3"], ["L03", "L3"]] as const) expect(parseAgenticListIdV1(raw)).toBe(id);
    for (const raw of ["E3", "3", 3, "L0", "L", "N1", "L12345", null, undefined]) expect(parseAgenticListIdV1(raw)).toBeNull();
    expectTypeOf(agenticListIdV1(2)).toEqualTypeOf<AgenticListIdV1>();
    expectTypeOf<AgenticListIdV1>().toEqualTypeOf<`L${number}`>();
    // @ts-expect-error an item id is not a list id
    const item: AgenticListIdV1 = "E1";
    expect(item).toBe("E1");
  });
});

describe("the list record", () => {
  it("is complete for a list read to a confirmed end with every member shown, an empty one too, and derives complete itself", () => {
    const list = createAgenticListEvidenceV1(OCTOBER_4);
    expect(list).toEqual({ ...OCTOBER_4, complete: true });
    expect([list, list.members, list.filter, list.filter_applied].every(value => Object.isFrozen(value))).toBe(true);
    expect(createAgenticListEvidenceV1({ ...OCTOBER_4, id: "L2", members: [], shown: 0 })).toMatchObject({ members: [], complete: true });
    // @ts-expect-error complete is derived, never passed
    expect(createAgenticListEvidenceV1({ ...OCTOBER_4, shown: 0, complete: true }).complete).toBe(false);
  });

  it.each([
    ["more pages remain", { ended: false }], ["the last page was exactly full with no next link", { unverified_end: true }], ["a page said more exist than list can show", { truncated: true }],
    ["a page carried an availability notice", { available: false }], ["one member was never shown to the research model", { shown: 7 }],
  ] as const)("is not complete when %s", (_reason, change) => {
    expect([createAgenticListEvidenceV1({ ...OCTOBER_4, ...change }).complete, agenticListCompleteV1({ ...OCTOBER_4, ...change })]).toEqual([false, false]);
  });

  it("names a requested filter the source ignored and keeps it out of the applied filter", () => {
    const tickets = createAgenticListEvidenceV1({ ...OCTOBER_4, id: "L2", source: "tickets", filter: { status: "open" }, filter_applied: { owner: "ignored", status: "partial" } });
    expect([tickets.filter, tickets.filter_applied]).toEqual([{ status: "open" }, { owner: "ignored", status: "partial" }]);
    expectTypeOf<AgenticListFilterApplicationV1>().toEqualTypeOf<"applied" | "partial" | "ignored">();
    expect(AGENTIC_LIST_FILTER_FIELDS_V1).toEqual(["kind", "status", "owner", "role", "channel", "since", "until", "date_field"]);
  });

  it.each([
    ["a malformed id", { id: "E1" as AgenticListIdV1 }, "id"],
    ["no source", { source: " " }, "source"],
    ["a member that is not an item id", { members: ["E1", "L2"], shown: 1 }, "members must be item ids"],
    ["a repeated member", { members: ["E1", "E1"], shown: 2 }, "distinct"],
    ["more shown than members", { shown: 9 }, "shown"],
    ["a read time that is not UTC", { read_at: "2026-10-17T06:58:33-07:00" }, "read_at"],
    ["an ignored field still in the filter", { filter_applied: { date_field: "ignored", since: "applied", until: "applied" } }, "filter.date_field"],
    ["an applied field missing from the filter", { filter_applied: { ...OCTOBER_4.filter_applied, owner: "applied" } }, "filter.owner"],
    ["an unknown filter field", { filter_applied: { ...OCTOBER_4.filter_applied, title: "applied" } as AgenticListEvidenceInputV1["filter_applied"] }, "unknown field title"],
    ["an unknown application", { filter_applied: { since: "widened", until: "applied", date_field: "applied" } as unknown as AgenticListEvidenceInputV1["filter_applied"] }, "applied, partial or ignored"],
  ] as const)("refuses %s", (_case, change, message) => {
    expect(() => createAgenticListEvidenceV1({ ...OCTOBER_4, ...change })).toThrow(new RegExp(`List evidence is invalid: .*${message.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  });
});

describe("an unverified end (addition 1)", () => {
  it.each([
    ["a next link", { returned: 25, requested: 25, next_cursor: "c1" }, false],
    ["a next link, even when the desk says full", { returned: 25, requested: 50, next_cursor: "c1", page_full: true }, false],
    ["no next link and a full raw page", { returned: 20, requested: 50, page_full: true }, true],
    ["no next link and a desk that confirmed its end", { returned: 50, requested: 50, page_full: false }, false],
    ["no next link, no desk word, as many rows as asked for", { returned: 50, requested: 50 }, true],
    ["no next link, no desk word, fewer rows", { returned: 8, requested: 50 }, false],
    ["an empty last page", { returned: 0, requested: 50 }, false],
  ] as const)("with %s is %s", (_case, page, unverified) => {
    expect(agenticListEndUnverifiedV1(page)).toBe(unverified);
  });

  it("is reported by desks and live readers on list pages", () => {
    expectTypeOf<EvidenceDeskResultV1["page_full"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<EvidenceDeskResultV2["page_full"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PersonLiveEvidencePageV1["page_full"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PersonLiveEvidenceResultV1["page_full"]>().toEqualTypeOf<boolean | undefined>();
  });
});

describe("a list's noun and its filter notice (addition 3)", () => {
  it("names a list from the catalog's selector and tool, with no source-specific rule", () => {
    expect([{ selector: "tickets", tool_id: "jira" }, { selector: "pages", tool_id: "confluence" }, { selector: "meetings" }, { selector: "follow_ups" }, { selector: "handbook", tool_id: "handbook" }].map(agenticListNounV1))
      .toEqual(["Jira tickets", "Confluence pages", "meetings", "follow-ups", "handbook"]);
  });

  it.each([
    [{ selector: "tickets", tool_id: "jira" }, ["ticket", "ticket"], ["Jira tickets", "Jira ticket", "ticket"]],
    [{ selector: "pages", tool_id: "confluence" }, ["page"], ["Confluence pages", "Confluence page", "page"]],
    [{ selector: "follow_ups" }, ["follow_up"], ["follow-ups", "follow-up", "follow_up"]],
    [{ selector: "meetings" }, ["decision", "decision"], ["decisions", "decision", "decision"]],
    [{ selector: "meetings" }, ["action"], ["actions", "action", "action"]],
    // Members of several kinds are items from the source; no member keeps the source's own noun.
    [{ selector: "meetings" }, ["imported_meeting", "decision", "action"], ["items from meetings", "item from meetings"]],
    [{ selector: "meetings" }, [], ["meetings", "meeting"]],
  ] as const)("names members of %j by their desk kinds %j, never a meeting for a decision", (source, kinds, [plural, singular, kind]) => {
    expect(agenticListMembersNounV1(source, kinds)).toEqual({ plural, singular, ...(kind === undefined ? {} : { kind }) });
  });

  it.each([
    [{ owner: "ignored" }, "Jira tickets", "Jira tickets could not be filtered by owner, so this list is not limited to that owner."],
    [{ owner: "ignored", status: "ignored", since: "applied" }, "Confluence pages", "Confluence pages could not be filtered by owner or status, so this list is not limited to those filters."],
    [{ status: "partial", owner: "applied" }, "meetings", "Meetings were filtered by status only where they record one the filter can match, so this list also includes items it could not filter."],
    [{ kind: "ignored", status: "partial" }, "follow-ups", "Follow-ups could not be filtered by kind, so this list is not limited to that kind. Follow-ups were filtered by status only where they record one the filter can match, so this list also includes items it could not filter."],
    // One text for every partial field, whatever kept an item: no value, or one the filter cannot match (a decision's "decided").
    [{ owner: "partial", status: "partial" }, "actions", "Actions were filtered by owner and status only where they record ones the filters can match, so this list also includes items they could not filter."],
    [{ since: "applied", until: "applied", date_field: "applied" }, "Confluence pages", undefined], [{}, "meetings", undefined],
  ] as const)("says which requested filters of %j a source ignored or applied only where items record them", (filter_applied, noun, notice) => {
    expect(agenticListFilterNoticeV1({ filter_applied }, noun)).toBe(notice);
  });
});

describe("list membership", () => {
  const pages = ["589865", "1474561", "1441793"].map((id, index) => ({ short: `E${index + 1}`, item: pageRow(id, `Page ${index + 1}`) }));
  const section = (short: string, row: EvidenceDeskItemV2, section_id: string) =>
    ({ short, item: { ...row, id: row.id.replace("inventory", section_id), citation: { ...(row.citation as Extract<EvidenceDeskItemV2["citation"], { kind: "page" }>), section_id } } });

  it("reads an opened section of a listed page as that page, never as another member", () => {
    const membership = agenticListMembershipV1([{ id: "L1", members: ["E1", "E2", "E3"] }, { id: "L2", members: ["E2"] }],
      [...pages, section("E9", pages[0]!.item, "s1"), section("E10", pages[0]!.item, "s2"), section("E11", pages[1]!.item, "s1"), section("E12", pageRow("999", "Other"), "s1")]);
    expect([["L1", "E2"], ["L2", "E2"], ["L1", "E9"], ["L1", "E10"], ["L2", "E11"], ["L2", "E9"]].map(([list, id]) => membership.in(list as AgenticListIdV1, id!))).toEqual(["E2", "E2", "E1", "E1", "E2", undefined]);
    // A page no list holds, an id nothing knows, and a list nobody read hold nothing.
    for (const list of ["L1", "L2"] as const) for (const id of ["E12", "E40"]) expect(membership.in(list, id)).toBeUndefined();
    expect(membership.in("L3", "E1")).toBeUndefined();
  });

  it("reads a ticket's opened body as its listed row, and keeps each meeting record its own", () => {
    const ticket = (short: string, id: string, ticket_id: string) => ({ short, item: { id, citation: { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-one", ticket_id, permalink: `https://tickets.example.test/browse/T-${ticket_id}`, text_sha256: sha256Digest(id) } } });
    const atom = (short: string, atom_id: string) => ({ short, item: { id: atom_id, citation: { kind: "approved_record", atom_id, record_sha256: canonicalSha256({ record: 1 }) } } });
    const membership = agenticListMembershipV1([{ id: "L1", members: ["E1", "E3"] }], [ticket("E1", "row", "100"), ticket("E2", "body", "100"), atom("E3", canonicalSha256({ atom: 1 })), atom("E4", canonicalSha256({ atom: 2 }))]);
    expect([membership.in("L1", "E2"), membership.in("L1", "E4")]).toEqual(["E1", undefined]);
  });
});

describe("what a need's declared kind asks of lists", () => {
  const need = (kind: "which_items" | "which_say" | "content" | undefined, status: "open" | "found" | "not_found", evidence: readonly string[] = []) =>
    ({ need: "n", ...(kind === undefined ? {} : { kind }), status, evidence });

  it("reads a list for a which_items need research has not given up on, and for a which_say need of any status", () => {
    // A content need's list ids carry no meaning, and a need without a kind is content.
    expect((["which_items", "which_say", "content", undefined] as const).map(kind => (["open", "found", "not_found"] as const).map(status => agenticNeedReadsListV1(need(kind, status)))))
      .toEqual([[true, true, false], [true, true, true], [false, false, false], [false, false, false]]);
  });

  it("names the lists code states and the lists research checks, each once in plan order, never a content need's, and a need with none", () => {
    const known = (id: AgenticListIdV1) => id !== "L9";
    const plan = [
      need("content", "found", ["L4", "E1"]), need("which_say", "found", ["L2", "E9", "L1"]), need("which_items", "found", ["L3", "L1", "L9"]),
      need("which_items", "open", ["l5"]), need("which_items", "not_found", ["L6"]), need("which_say", "not_found", ["L7"]), need(undefined, "found", ["L8"]),
    ] as const;
    expect(agenticPlanListsV1(plan, known)).toEqual({ stated: ["L3", "L1", "L5"], checking: ["L2", "L1", "L7"], unlisted: false });
    // A need code reads a list for that cites only rows, or only a list research never read, has no list (W3's gap).
    expect(agenticPlanListsV1([...plan, need("which_items", "found", ["E1", "E2"])], known)).toMatchObject({ stated: ["L3", "L1", "L5"], unlisted: true });
    expect(agenticPlanListsV1([need("which_say", "not_found", ["L9"])], known)).toEqual({ stated: [], checking: [], unlisted: true });
    // A not_found which_items need or a content need asks for no list, so it never makes the plan unlisted.
    for (const value of [[need("which_items", "not_found"), need("content", "found", ["E1"])], []]) expect(agenticPlanListsV1(value, known)).toEqual({ stated: [], checking: [], unlisted: false });
  });
});

describe("what research's opens read", () => {
  it("keeps each item whose open was clean, its bodies read in full, until a limited open undoes it", () => {
    /** An open as the loop records it: `id` is the item it resolved to, absent when it resolved to none. */
    const open = (id: string | undefined, opened: readonly string[], result: { readonly error?: string; readonly truncated?: boolean } = {}): AgenticOpenActionV1 =>
      ({ tool: "open", result: { ...(id === undefined ? {} : { id }), opened, ...result } });
    const reads = agenticOpenReadsV1([
      { actions: [open("E1", ["E9", "E10"]), open("E2", ["E11"], { truncated: true }), open("E3", ["E12", "E13"]), { tool: "search", result: { opened: ["E12"] } }] },
      { actions: [open("E1", [], { error: "unavailable" }), open("E2", ["E11"]), open("E4", []), open(undefined, ["E12"], { error: "unknown id; pass an id such as E4 from your scratchpad" })] },
    ], id => ["E9", "E10", "E11", "E12"].includes(id));
    // E1's later open failed; E2's later open was clean; E3 returned a body research did not read; E4 returned none; an
    // open that resolved to no item counts for none.
    expect([[...reads.clean], [...reads.limited]]).toEqual([["E2"], ["E1"]]);
  });
});

describe("the writer's view", () => {
  it("shows a member's row facts and never its text", () => {
    const member = agenticWriterListMemberV1({ short: "E3", item: { ...pageRow("1441793", "Gate reviews — EVT pass, DVT hold, PVT pending"), text: "Released section text" } }, false);
    expect(member).toEqual({
      id: "E3", kind: "page", title: "Gate reviews — EVT pass, DVT hold, PVT pending", status: "current",
      dates: { created: "2026-10-04T23:12:00.000Z", updated: "2026-10-04T23:38:00.000Z" }, date: "2026-10-04", date_kind: "version_created", checked: false,
    });
    // @ts-expect-error a writer member never carries text
    const withText: AgenticWriterListMemberV1 = { ...member, text: "x" };
    expect(withText).toBeDefined();
  });

  it("titles a member by its list label when it has one and its label otherwise, and keeps a ticket's status, owner and due date and an action's missing owner", () => {
    // Every record of a meeting carries the meeting's label; its list label is one line of its own text, then the meeting.
    const action = { ...pageRow("7", "THERM DVT sync (2026-10-04)"), kind: "action" as const, list_label: "Send fixture drawings to vendor (THERM DVT sync, 2026-10-04)", attributes: { owner: "Dana Lee" } } as EvidenceDeskItemV2;
    const titled = agenticWriterListMemberV1({ short: "E1", item: action }, false);
    expect(titled).toMatchObject({ id: "E1", kind: "action", title: "Send fixture drawings to vendor (THERM DVT sync, 2026-10-04)", owner: "Dana Lee" });
    expect(titled).not.toHaveProperty("list_label");
    expect(agenticWriterListMemberV1({ short: "E2", item: pageRow("8", "PRD — System and acceptance requirements") }, false).title).toBe("PRD — System and acceptance requirements");
    const ticket = { ...pageRow("46", "THERM-46: Display firmware"), kind: "ticket" as const, attributes: { status: "In Progress", owner: "Tobias Lund", due_at: "2026-10-15" } } as EvidenceDeskItemV2;
    expect(agenticWriterListMemberV1({ short: "E1", item: ticket }, true)).toMatchObject({ status: "In Progress", owner: "Tobias Lund", due: "2026-10-15", checked: true });
    const unowned = { ...pageRow("7", "Check the numbers"), kind: "action" as const, attributes: { due_at: "2026-09-12" } } as EvidenceDeskItemV2;
    expect(agenticWriterListMemberV1({ short: "E2", item: unowned }, false)).toMatchObject({ owner: "none recorded", due: "2026-09-12" });
  });

  it('keeps all 105 rows available to the writer before applying its actual prompt budget', () => {
    const ids = Array.from({ length: 105 }, (_, index) => `E${index + 1}`);
    const list = createAgenticListEvidenceV1({ ...OCTOBER_4, members: ids, shown: 105 });
    const rows = ids.map((id, index) => agenticWriterListMemberV1({ short: id, item: pageRow(String(index + 1), `Page ${index + 1}`) }, false));
    const view = agenticWriterListV1(list, rows, true);
    expect(view.members).toHaveLength(105);
    expect(view).not.toHaveProperty('members_omitted');
  });

  it("preserves a long list and counts all checked members, reducing rows only for an explicit prompt bound", () => {
    const short = createAgenticListEvidenceV1(OCTOBER_4);
    const eight = short.members.map((id, index) => agenticWriterListMemberV1({ short: id, item: pageRow(String(index + 1), `Page ${index + 1}`) }, false));
    expect(agenticWriterListV1(short, eight, true, 3)).toMatchObject({ count: 8, members: eight.slice(0, 3), members_omitted: 5 });
    expect(agenticWriterListV1(short, eight, true, 0)).toMatchObject({ count: 8, members: [], members_omitted: 8 });
    expect(() => agenticWriterListV1(short, eight, true, -1)).toThrow(/max_members/u);
    expect(agenticWriterListV1(short, eight, false)).not.toHaveProperty("members_omitted");
    const ids = Array.from({ length: 120 }, (_, index) => `E${index + 1}`);
    const list = createAgenticListEvidenceV1({ ...OCTOBER_4, members: ids, shown: 120 });
    const rows = ids.map((id, index) => agenticWriterListMemberV1({ short: id, item: pageRow(String(index + 1), `Page ${index + 1}`) }, index === 0 || index === 110));
    const view = agenticWriterListV1(list, rows, true);
    expect(view).toMatchObject({ id: "L1", source: "pages", complete: true, count: 120, checked: 2, stated: true, read_at: OCTOBER_4.read_at });
    expect(view.members).toHaveLength(120);
    expect(view).not.toHaveProperty("members_omitted");
    expect(() => agenticWriterListV1(list, [...rows].reverse(), true)).toThrow(/the list's members, in order/u);
  });

  it("lets the writer choose a list and select by one row fact other than its title, never write names", () => {
    expect(AGENTIC_LIST_SELECTION_FIELDS_V1).toEqual(["owner", "status", "due", "created", "updated", "received", "occurred", "approved", "sent", "reassigned", "checked"]);
    const mine: AgenticAnswerListUseV1 = { id: "L1", where: { field: "owner", value: "Dana Lee" } };
    const week: AgenticAnswerListUseV1 = { id: "L1", where: { field: "due", since: "2026-10-18", until: "2026-10-24" } };
    expect([mine.where?.field, week.where?.field]).toEqual(["owner", "due"]);
    expectTypeOf<NonNullable<AgenticAnswerListUseV1["where"]>>().toEqualTypeOf<AgenticListSelectionV1>();
    expectTypeOf<NonNullable<AgenticAnswerListUseV1["where"]>["field"]>().toEqualTypeOf<"owner" | "status" | "due" | "created" | "updated" | "received" | "occurred" | "approved" | "sent" | "reassigned" | "checked">();
    // @ts-expect-error a selection is never by title
    const byTitle: AgenticAnswerListUseV1 = { id: "L1", where: { field: "title", value: "PRD" } };
    // @ts-expect-error the writer names lists, never member names
    const named: AgenticAnswerListUseV1 = { id: "L1", names: ["PRD"] };
    // It selects members for their row facts by id, never by what it would write of them.
    const prd: AgenticAnswerListUseV1 = { id: "L1", members: ["E5"] };
    expect([byTitle, named, prd]).toHaveLength(3);
  });
});

describe("names across one answer", () => {
  /** `count` members of one list, E`from`.., each with its own title. */
  const members = (count: number, from = 1) => Array.from({ length: count }, (_, index) => ({ id: `E${from + index}`, title: `Page ${from + index}` }));
  const which = (selected: ReturnType<typeof members>) => ({ selected, by_id: false });
  const byId = (selected: ReturnType<typeof members>) => ({ selected, by_id: true });
  type Use = ReturnType<typeof which>;
  /** Each statement's share and free members, and the members it then names. */
  const named = (statements: readonly Use[], noun = PAGES) => {
    const shares = agenticListNameSharesV1(statements);
    return { shares, cited: statements.map((value, index) => agenticListStatementV1({ noun, filter: {}, count: value.selected.length, complete: true, selected: value.selected, share: shares[index]!.share, free: shares[index]!.free, ...(value.by_id ? { by_id: true } : {}) }).cited) };
  };

  it.each([
    [[8], [8]], [[60], [25]], [[8, 60], [8, 17]], [[60, 60], [13, 12]], [[0, 5], [0, 5]], [[], []],
  ] as const)("shares statements of %j distinct members as %j, at most 25 in all", (selected, shares) => {
    let from = 1;
    const result = agenticListNameSharesV1(selected.map(count => { const value = which(members(count, from)); from += count; return value; }));
    expect(result.map(value => value.share)).toEqual(shares);
    expect(result.every(value => value.free.size === 0)).toBe(true);
    expect(result.reduce((total, value) => total + value.share, 0)).toBeLessThanOrEqual(AGENTIC_LIST_NAMED_MAX_V1);
  });

  it("costs a member one name however many statements name it, by id or not (W6)", () => {
    // Two lists of the same 20 pages (created that week, updated that week): each takes every other page, and each
    // statement names all 20, the other's pages free; 20 distinct names, within the 25.
    for (const statements of [[which(members(20)), which(members(20))], [byId(members(20)), byId(members(20))]]) {
      const { shares, cited } = named(statements);
      expect([shares.map(value => value.share), cited.map(value => value.length)]).toEqual([[10, 10], [20, 20]]);
    }
    // Members selected by id come first: 10 of 25 by id, then the list in full takes the other 15 and names all 25.
    const partly = named([byId(members(10)), which(members(25))]);
    expect([partly.shares.map(value => value.share), [...partly.shares[1]!.free], partly.cited.map(value => value.length)]).toEqual([[10, 15], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 25]]);
    // Overlapping lists past the bound: 30 pages and the 20 of them updated that week name 25 distinct pages in all.
    const wide = [which(members(30)), which(members(20, 11))];
    const overlap = named(wide);
    expect(overlap.shares.reduce((total, value) => total + value.share, 0)).toBe(AGENTIC_LIST_NAMED_MAX_V1);
    expect(new Set(overlap.cited.flatMap((cited, index) => cited.map(at => wide[index]!.selected[at]!.id))).size).toBe(AGENTIC_LIST_NAMED_MAX_V1);
  });

  it("names a statement's first member past a spent share only when no other statement takes it, and buys nothing else with it (W6)", () => {
    const first = (statements: readonly Use[]) => {
      const shares = agenticListNameSharesV1(statements);
      expect(shares[0]!.share).toBe(0);
      const value = agenticListStatementV1({ noun: TICKETS, filter: {}, count: 30, complete: true, selected: statements[0]!.selected, share: shares[0]!.share, free: shares[0]!.free });
      return { text: value.text, cited: value.cited.length, distinct: new Set([...value.cited.map(at => statements[0]!.selected[at]!.id), ...statements.slice(1).flatMap(other => other.selected.map(member => member.id))]).size };
    };
    // The first 25 of 30 by id take the answer's 25 names; the list in full names them free, its first member among them, so it names no 26th.
    expect(first([which(members(30)), byId(members(25))])).toMatchObject({ cited: 25, distinct: 25, text: expect.stringMatching(/: Page 1; .*; Page 25; and 5 more\.$/u) });
    // Members 2 to 26 by id: the first member is no other statement's, so it is named past the spent share, and its name
    // buys no other member: the free ones follow, and the rest are "and N more".
    expect(first([which(members(30)), byId(members(25, 2))])).toMatchObject({ cited: 26, distinct: 26, text: expect.stringMatching(/: Page 1; Page 2; .*; Page 26; and 4 more\.$/u) });
    expect(() => statement({ noun: PAGES, selected: members(1), share: -1 })).toThrow(RangeError);
  });
});

describe("the bundle and the evaluation view", () => {
  it("carries lists for Ask and leaves them out for a task goal", () => {
    expectTypeOf<AgenticEvidenceBundleV1["lists"]>().toEqualTypeOf<readonly AgenticListEvidenceV1[] | undefined>();
    expectTypeOf<AgenticResearchResultV1["lists"]>().toEqualTypeOf<readonly AgenticListEvidenceV1[] | undefined>();
    const list = createAgenticListEvidenceV1(OCTOBER_4);
    expect(trimAgenticEvidenceBundleV1({ ...EMPTY_BUNDLE, lists: [list] }).lists).toEqual([list]);
    expect(trimAgenticEvidenceBundleV1(EMPTY_BUNDLE)).not.toHaveProperty("lists");
  });
});

describe("the statement code writes for a list (ADR-0041)", () => {
  const titles = ["ECHO Product Pipeline — Start Here", "Assumptions and decisions — source facts versus proposals", "Gate reviews — EVT pass, DVT hold, PVT pending"];
  const pages = titles.map(title => ({ title, status: "current" }));
  const sixty = Array.from({ length: 60 }, (_, index) => ({ title: `THERM-${index + 1}: Fixture work ${index + 1}` }));
  const sync = "THERM DVT sync (2026-10-04)";
  const review = "DVT review (2026-10-01)";
  const decisions = Array.from({ length: 3 }, () => ({ title: sync, kind: "decision" }));
  const due = (date?: string) => ({ title: review, kind: "action", owner: "Mara Quinn", ...(date === undefined ? {} : { due: date }) });
  const mara = { owner: "Mara Lind", status: "open" as const };
  const owners = [{ title: "THERM-1: A", owner: "Dana Lee" }, { title: "THERM-2: B", owner: "Tobias Lund" }, { title: "THERM-3: C", owner: "dana lee" }];
  const prd = { title: "PRD — System and acceptance requirements", kind: "page", status: "current", dates: { created: "2026-10-05T03:00:00.000Z", updated: "2026-10-05T22:11:30.875Z" } };
  // Actions of one meeting share its label, but each keeps its own owner and due date; a calendar day keeps its day.
  const actions = [
    { title: review, kind: "action", owner: "Mara Quinn", due: "2026-10-09", date: "2026-10-01", date_kind: "occurred" as const },
    { title: review, kind: "action", owner: "none recorded", dates: { occurred: "2026-10-01", due: "2026-10-12" } },
  ];
  const actionFacts = `${review} (owner Mara Quinn, due October 9, 2026, dated October 1, 2026); ${review} (no owner recorded, dated October 1, 2026, due October 12, 2026).`;
  const reviewed = Array.from({ length: 25 }, (_, index) => ({ title: `THERM-${index + 1}: A`, status: "In Review" }));
  const meeting = [{ title: sync, kind: "imported_meeting" }, { title: sync, kind: "decision" }, { title: "Vendor review (2026-10-04)", kind: "action", owner: "Dana" }, { title: sync, kind: "action", owner: "Dana" }, { title: sync, kind: "rationale" }];

  it("reads a filter as applied: dates and fields, never the model's arguments", () => {
    expect([agenticCalendarDayV1("2026-10-04"), agenticCalendarDayV1("2026-10-04T08:00:00Z")]).toEqual(["October 4, 2026", "2026-10-04T08:00:00Z"]);
    expect(([
      OCTOBER_4.filter, { date_field: "updated", since: "2026-10-01", until: "2026-10-04" }, { since: "2025-12-30", until: "2026-01-02" }, { since: "2026-10-03" },
      { date_field: "due", until: "2026-10-09" }, { kind: "action", owner: "Mara", status: "open", time_zone: "UTC" }, { time_zone: "UTC" },
    ] as const).map(filter => agenticListFilterPhraseV1(filter))).toEqual([
      " created on October 4, 2026", " updated from October 1 to October 4, 2026", " dated from December 30, 2025 to January 2, 2026", " dated since October 3, 2026",
      " due through October 9, 2026", " with kind action, owner Mara and status open", "",
    ]);
  });

  it.each<[string, Partial<AgenticListStatementInputV1> & Pick<AgenticListStatementInputV1, "selected">, string]>([
    // Status, owner and due date only where they differ, read among the names the statement writes.
    ["names alone", { selected: pages }, `3 items: ${titles.join("; ")}.`],
    ["status and due dates that differ", { selected: [{ title: "THERM-1: Fixture", status: "In Progress", owner: "Dana Lee" }, { title: "THERM-2: Firmware", status: "Done", owner: "Dana Lee", due: "2026-10-09" }] }, "2 items: THERM-1: Fixture (In Progress); THERM-2: Firmware (Done, due October 9, 2026)."],
    ["owners that differ", { selected: [{ title: "Check the numbers", owner: "none recorded" }, { title: "Ship it", owner: "Mara" }] }, "2 items: Check the numbers (no owner recorded); Ship it (owner Mara)."],
    ["a status that differs only past the share", { count: 3, share: 2, selected: [{ title: "Alpha", status: "open" }, { title: "Beta", status: "open" }, { title: "Gamma", status: "done" }] }, "3 items: Alpha; Beta; and 1 more."],
    // A plain statement's lead counts the list, never the members it names: here 2 named of at least 25 listed.
    ["a count past the members it names", { noun: TICKETS, count: 25, complete: false, share: 2, selected: sixty.slice(0, 2) }, "At least 25 Jira tickets: THERM-1: Fixture work 1; THERM-2: Fixture work 2."],
    ["a status that differs among the names", { selected: [{ title: "Alpha", status: "open" }, { title: "Beta", status: "open" }, { title: "Gamma", status: "done" }] }, "3 items: Alpha (open); Beta (open); Gamma (done)."],
    // A merge never hides a row fact: one meeting's actions due on different days are named apart, each with its date.
    ["one meeting's actions by due date", { selected: [due("2026-10-09"), due("2026-10-12"), due(), due(" 2026-10-09")] }, `4 items: ${review} (2 actions, due October 9, 2026); ${review} (due October 12, 2026); ${review}.`],
    // A kind filter is the noun, not a phrase; three decisions of one meeting are one name.
    ["three decisions of one meeting", { noun: agenticListMembersNounV1({ selector: "meetings" }, ["decision"]), filter: { kind: "decision", owner: "Dana" }, selected: decisions }, `3 decisions with owner Dana: ${sync} (3 decisions).`],
    // A selection says its condition in its lead, one member "has" it, and a list not read to its end says how many were listed (more: X1, R9, X17).
    ["one member's status selection of a list not read to its end", { noun: TICKETS, count: 50, complete: false, where: { field: "status", value: "Done" }, selected: [owners[1]!] }, "At least 1 Jira ticket has status Done (50 listed so far): THERM-2: B."],
    ["an updated range of a list not read to its end", { noun: TICKETS, filter: OCTOBER_4.filter, count: 25, complete: false, where: { field: "updated", since: "2026-10-11" }, selected: reviewed.slice(0, 3).map(value => ({ title: value.title })) }, "At least 3 Jira tickets created on October 4, 2026 were updated since October 11, 2026 (25 listed so far): THERM-1: A; THERM-2: A; THERM-3: A."],
    ["a created day", { noun: PAGES, count: 8, where: { field: "created", since: "2026-10-04", until: "2026-10-04" }, selected: [{ title: "PRD" }] }, "1 of the 8 Confluence pages was created on October 4, 2026: PRD."],
    // Members selected by id: each one's row facts, every date in the list's time zone (03:00 UTC on October 5 is October 4 in Los Angeles).
    ["a page selected by id", { noun: PAGES, filter: OCTOBER_4.filter, count: 8, by_id: true, selected: [prd] }, "1 of the 8 Confluence pages created on October 4, 2026: PRD — System and acceptance requirements (status current, created October 4, 2026, updated October 5, 2026)."],
    // However many it selects, a selection by id states row facts, never which items exist (W2); merged with a use in full, it leads with the list's count.
    ["actions selected by id", { noun: ACTIONS, filter: { time_zone: "UTC" }, complete: false, by_id: true, selected: actions }, `2 of at least 2 actions: ${actionFacts}`],
    ["actions selected by id and used in full", { noun: ACTIONS, filter: { time_zone: "UTC" }, complete: false, by_id: true, which: true, selected: actions }, `At least 2 actions: ${actionFacts}`],
    ["a ticket selected by id with an unspecified date", { noun: TICKETS, count: 25, complete: false, by_id: true, selected: [{ title: "THERM-46: Fixture", status: "In Progress", date: "2026-10-04", date_kind: "unspecified" }] }, "1 of at least 25 Jira tickets: THERM-46: Fixture (status In Progress)."],
    // A where use and a selection by id of the same members: the condition's lead, each member named with its facts (W2).
    ["a where selection by id", { noun: TICKETS, count: 25, where: { field: "status", value: "In Review" }, by_id: true, selected: reviewed.slice(0, 2) }, "2 of the 25 Jira tickets have status In Review: THERM-1: A (status In Review); THERM-2: A (status In Review)."],
  ])("writes %s", (_case, input, text) => {
    expect(statement(input).text).toBe(text);
  });

  it("names members that share a label and their row facts once, with their kinds counted, and cites every member it names (W6)", () => {
    // A meeting's records all carry the meeting's label; its action records an owner the others do not.
    expect(statement({ noun: agenticListMembersNounV1({ selector: "meetings" }, meeting.map(value => value.kind)), filter: { since: "2026-10-04", until: "2026-10-04" }, selected: meeting }))
      .toEqual({ text: `5 items from meetings dated on October 4, 2026: ${sync} (1 meeting, 1 decision and 1 rationale); Vendor review (2026-10-04) (1 action, owner Dana); ${sync} (1 action, owner Dana).`, cited: [0, 1, 2, 3, 4] });
    // A share smaller than a name's members names as many of them as it cites; "and N more" counts the rest, from the list.
    expect(statement({ noun: DECISIONS, count: 4, share: 2, selected: [...decisions, { title: "Other (2026-10-05)", kind: "decision" }] })).toEqual({ text: `4 decisions: ${sync} (2 decisions); and 2 more.`, cited: [0, 1] });
    // A merged group names its free members and at most `share` of the others; members another statement named by id cost no share.
    expect(statement({ noun: DECISIONS, count: 4, share: 1, free: new Set([2, 3]), selected: Array.from({ length: 4 }, () => ({ title: sync, kind: "decision" })) })).toEqual({ text: `4 decisions: ${sync} (3 decisions); and 1 more.`, cited: [0, 2, 3] });
    expect(statement({ noun: TICKETS, complete: false, share: 15, free: new Set(Array.from({ length: 10 }, (_, index) => index)), selected: reviewed }))
      .toEqual({ text: `At least 25 Jira tickets: ${reviewed.map(value => value.title).join("; ")}.`, cited: Array.from({ length: 25 }, (_, index) => index) });
    expect(statement({ noun: TICKETS, complete: false, share: 15, selected: reviewed }).cited).toEqual(Array.from({ length: 15 }, (_, index) => index));
    expect(statement({ noun: TICKETS, filter: OCTOBER_4.filter, count: 60, selected: sixty }))
      .toEqual({ text: `60 Jira tickets created on October 4, 2026: ${sixty.slice(0, 25).map(value => value.title).join("; ")}; and 35 more.`, cited: Array.from({ length: 25 }, (_, index) => index) });
    const long = statement({ selected: [{ title: `${"x".repeat(200)}\nsecond line` }] }).text.slice("1 item: ".length, -1);
    expect([[...long].length, long.endsWith("…")]).toEqual([120, true]);
  });

  it("takes the noun as the renderer builds it, and gives the text and the members it cites, all the renderer reads", () => {
    expectTypeOf<AgenticListStatementInputV1["noun"]>().toEqualTypeOf<AgenticListNounFormsV1>();
    expectTypeOf<Parameters<typeof agenticListSelectionNotFoundV1>[0]>().toEqualTypeOf<AgenticListNounFormsV1>();
    expectTypeOf<ReturnType<typeof agenticListStatementV1>>().toEqualTypeOf<{ readonly text: string; readonly cited: readonly number[] }>();
  });

  it("writes a selection's not-found phrase, and selects by owner, status or a row date within an inclusive range, each day the list's", () => {
    expect(agenticListSelectV1(owners, undefined)).toBe(owners);
    expect([
      agenticListSelectionNotFoundV1(TICKETS, OCTOBER_4.filter, { field: "owner", value: "Zhen Ye" }), agenticListSelectionNotFoundV1(FOLLOW_UPS, mara, { field: "due", since: "2026-10-18", until: "2026-10-24" }),
      agenticListSelectionNotFoundV1(PAGES, OCTOBER_4.filter, { field: "updated", since: "2026-10-11" }),
    ]).toEqual(["Jira tickets created on October 4, 2026 that have owner Zhen Ye", "follow-ups with owner Mara Lind and status open due from October 18 to October 24, 2026", "Confluence pages created on October 4, 2026 updated since October 11, 2026"]);
    const titled = (members: readonly { readonly title: string }[]) => members.map(member => member.title);
    // A member's due date: its named dates first, then its due date, then its one dated fact when that is a due date.
    const rows = [
      { title: "named", dates: { due: "2026-10-20" }, due: "2026-11-30" }, { title: "attribute", due: "2026-10-24" }, { title: "dated", date: "2026-10-18", date_kind: "due" as const },
      { title: "later", due: "2026-10-25" }, { title: "none" }, { title: "created", date: "2026-10-19", date_kind: "created" as const },
    ];
    expect([{ field: "due", since: "2026-10-18", until: "2026-10-24" }, { field: "due", since: "2026-10-24" }, { field: "due", until: "2026-10-18" }, { field: "created", since: "2026-10-19", until: "2026-10-19" }]
      .map(where => titled(agenticListSelectV1(rows, where as AgenticListSelectionV1)))).toEqual([["named", "attribute", "dated"], ["attribute", "later"], ["dated"], ["created"]]);
    // A timestamp is placed in the list's time zone, as the desk's own date filter places it; a calendar day keeps its day.
    const updated = [{ title: "Tokyo's Oct 11", dates: { updated: "2026-10-10T23:30:00.000Z" } }, { title: "Los Angeles' Oct 10", dates: { updated: "2026-10-11T03:00:00.000Z" } }, { title: "a day", dates: { updated: "2026-10-11" } }];
    expect(["Asia/Tokyo", "America/Los_Angeles", "UTC", undefined].map(zone => titled(agenticListSelectV1(updated, { field: "updated", since: "2026-10-11" }, zone))))
      .toEqual([["Tokyo's Oct 11", "Los Angeles' Oct 10", "a day"], ["a day"], ["Los Angeles' Oct 10", "a day"], ["Los Angeles' Oct 10", "a day"]]);
    expect(titled(agenticListSelectV1([{ title: "a", status: "Done" }, { title: "b", status: "done " }, { title: "c" }], { field: "status", value: "DONE" }))).toEqual(["a", "b"]);
    expect(titled(agenticListSelectV1(owners, { field: "owner", value: " DANA LEE " }))).toEqual(["THERM-1: A", "THERM-3: C"]);
  });

  it("stops naming before a statement passes its byte bound, and counts the rest as more", () => {
    const wide = statement({ noun: PAGES, filter: OCTOBER_4.filter, selected: Array.from({ length: 25 }, (_, index) => ({ title: `${index} ${"𝔸".repeat(118)}` })) });
    expect(Buffer.byteLength(wide.text, "utf8")).toBeLessThanOrEqual(AGENTIC_LIST_STATEMENT_BYTES_V1);
    expect(wide.cited.length).toBeLessThan(25);
    expect(wide.text.endsWith(`; and ${25 - wide.cited.length} more.`)).toBe(true);
    expect(() => statement({ noun: PAGES, selected: [] })).toThrow(RangeError);
  });

  it("says how many members were checked for content across a list (addition 4)", () => {
    expect([{ checked: 4, count: 8, complete: true }, { checked: 25, count: 25, complete: false }, { checked: 8, count: 8, complete: true }].map(agenticListCheckedNoteV1))
      .toEqual(["(4 of 8 checked so far)", "(25 of at least 25 checked so far)", undefined]);
  });
});
