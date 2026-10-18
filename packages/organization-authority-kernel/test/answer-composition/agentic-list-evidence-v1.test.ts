import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import { trimAgenticEvidenceBundleV1, type AgenticEvidenceBundleV1 } from "../../src/answer-composition/agentic-evidence-bundle-v1.js";
import {
  AGENTIC_LIST_FILTER_FIELDS_V1,
  AGENTIC_LIST_NAMED_MAX_V1,
  AGENTIC_LIST_SELECTION_FIELDS_V1,
  AGENTIC_LIST_STATEMENT_BYTES_V1,
  AGENTIC_LIST_WRITER_MEMBERS_MAX_V1,
  agenticCalendarDayV1,
  agenticListCheckedNoteV1,
  agenticListCompleteV1,
  agenticListEndUnverifiedV1,
  agenticListFilterNoticeV1,
  agenticListFilterPhraseV1,
  agenticListIdV1,
  agenticListMemberNamesV1,
  agenticListMembersNounV1,
  agenticListNameSharesV1,
  agenticListNounV1,
  agenticListSelectionNotFoundV1,
  agenticListSelectV1,
  agenticListStatementV1,
  agenticListMembershipV1,
  agenticNeedReadsListV1,
  agenticOpenReadsV1,
  agenticPlanListsV1,
  agenticWriterListMemberV1,
  agenticWriterListV1,
  createAgenticListEvidenceV1,
  parseAgenticListIdV1,
  type AgenticAnswerListUseV1,
  type AgenticListEvidenceInputV1,
  type AgenticListEvidenceV1,
  type AgenticListFilterApplicationV1,
  type AgenticListIdV1,
  type AgenticListSelectionV1,
  type AgenticOpenActionV1,
  type AgenticWriterListMemberV1,
} from "../../src/answer-composition/agentic-list-evidence-v1.js";
import type { AgenticResearchResultV1 } from "../../src/answer-composition/agentic-research-v1.js";
import { AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from "../../src/answer-composition/agentic-research-v1.js";
import type { EvidenceDeskResultV1 } from "../../src/shared/evidence-desk-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";
import type { PersonLiveEvidencePageV1, PersonLiveEvidenceResultV1 } from "../../src/shared/person-live-evidence-v1.js";

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
    expect(agenticListIdV1(1)).toBe("L1");
    expect(agenticListIdV1(12)).toBe("L12");
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
  it("is complete for the October 4 list: read to a confirmed end, every member shown", () => {
    const list = createAgenticListEvidenceV1(OCTOBER_4);
    expect(list.complete).toBe(true);
    expect(Object.isFrozen(list) && Object.isFrozen(list.members) && Object.isFrozen(list.filter) && Object.isFrozen(list.filter_applied)).toBe(true);
    expect(list).toEqual({ ...OCTOBER_4, complete: true });
  });

  it.each([
    ["more pages remain", { ended: false }],
    ["the last page was exactly full with no next link", { unverified_end: true }],
    ["a page said more exist than list can show", { truncated: true }],
    ["a page carried an availability notice", { available: false }],
    ["one member was never shown to the research model", { shown: 7 }],
  ] as const)("is not complete when %s", (_reason, change) => {
    expect(createAgenticListEvidenceV1({ ...OCTOBER_4, ...change }).complete).toBe(false);
    expect(agenticListCompleteV1({ ...OCTOBER_4, ...change })).toBe(false);
  });

  it("derives complete itself and ignores a value passed in", () => {
    // @ts-expect-error complete is derived, never passed
    const list = createAgenticListEvidenceV1({ ...OCTOBER_4, shown: 0, complete: true });
    expect(list.complete).toBe(false);
  });

  it("records an empty list read to its end as complete with no members", () => {
    const empty = createAgenticListEvidenceV1({ ...OCTOBER_4, id: "L2", members: [], shown: 0 });
    expect(empty).toMatchObject({ members: [], complete: true });
  });

  it("names a requested filter the source ignored and keeps it out of the applied filter", () => {
    const tickets = createAgenticListEvidenceV1({
      ...OCTOBER_4, id: "L2", source: "tickets", filter: { status: "open" }, filter_applied: { owner: "ignored", status: "partial" },
    });
    expect(tickets.filter).toEqual({ status: "open" });
    expect(tickets.filter_applied).toEqual({ owner: "ignored", status: "partial" });
    expectTypeOf<AgenticListFilterApplicationV1>().toEqualTypeOf<"applied" | "partial" | "ignored">();
    expect(AGENTIC_LIST_FILTER_FIELDS_V1).toEqual(["kind", "status", "owner", "channel", "since", "until", "date_field"]);
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
    expect(agenticListNounV1({ selector: "tickets", tool_id: "jira" })).toBe("Jira tickets");
    expect(agenticListNounV1({ selector: "pages", tool_id: "confluence" })).toBe("Confluence pages");
    expect(agenticListNounV1({ selector: "meetings" })).toBe("meetings");
    expect(agenticListNounV1({ selector: "follow_ups" })).toBe("follow-ups");
    expect(agenticListNounV1({ selector: "slack", tool_id: "slack" })).toBe("slack");
  });

  it("names members by what their desk kinds are, never a meeting for a decision", () => {
    const forms = (plural: string, singular: string, kind?: string) => ({ plural, singular, ...(kind === undefined ? {} : { kind }) });
    expect(agenticListMembersNounV1({ selector: "tickets", tool_id: "jira" }, ["ticket", "ticket"])).toEqual(forms("Jira tickets", "Jira ticket", "ticket"));
    expect(agenticListMembersNounV1({ selector: "pages", tool_id: "confluence" }, ["page"])).toEqual(forms("Confluence pages", "Confluence page", "page"));
    expect(agenticListMembersNounV1({ selector: "follow_ups" }, ["follow_up"])).toEqual(forms("follow-ups", "follow-up", "follow_up"));
    expect(agenticListMembersNounV1({ selector: "slack", tool_id: "slack" }, ["slack_message"])).toEqual(forms("Slack messages", "Slack message", "slack_message"));
    expect(agenticListMembersNounV1({ selector: "meetings" }, ["decision", "decision"])).toEqual(forms("decisions", "decision", "decision"));
    expect(agenticListMembersNounV1({ selector: "meetings" }, ["action"])).toEqual(forms("actions", "action", "action"));
    // Members of several kinds are items from the source; no member keeps the source's own noun.
    expect(agenticListMembersNounV1({ selector: "meetings" }, ["imported_meeting", "decision", "action"])).toEqual(forms("items from meetings", "item from meetings"));
    expect(agenticListMembersNounV1({ selector: "meetings" }, [])).toEqual(forms("meetings", "meeting"));
  });

  it("says which requested filters a source ignored or applied only where items record them", () => {
    expect(agenticListFilterNoticeV1({ filter_applied: { owner: "ignored" } }, "Jira tickets")).toBe("Jira tickets could not be filtered by owner, so this list is not limited to that owner.");
    expect(agenticListFilterNoticeV1({ filter_applied: { owner: "ignored", status: "ignored", since: "applied" } }, "Confluence pages"))
      .toBe("Confluence pages could not be filtered by owner or status, so this list is not limited to those filters.");
    expect(agenticListFilterNoticeV1({ filter_applied: { status: "partial", owner: "applied" } }, "meetings"))
      .toBe("Meetings were filtered by status only where they record one, so this list also includes items that record none.");
    expect(agenticListFilterNoticeV1({ filter_applied: { kind: "ignored", status: "partial" } }, "follow-ups"))
      .toBe("Follow-ups could not be filtered by kind, so this list is not limited to that kind. Follow-ups were filtered by status only where they record one, so this list also includes items that record none.");
    expect(agenticListFilterNoticeV1({ filter_applied: { since: "applied", until: "applied", date_field: "applied" } }, "Confluence pages")).toBeUndefined();
    expect(agenticListFilterNoticeV1({ filter_applied: {} }, "meetings")).toBeUndefined();
  });
});

describe("list membership", () => {
  const pages = ["589865", "1474561", "1441793"].map((id, index) => ({ short: `E${index + 1}`, item: pageRow(id, `Page ${index + 1}`) }));
  const section = (short: string, row: EvidenceDeskItemV2, section_id: string) =>
    ({ short, item: { ...row, id: row.id.replace("inventory", section_id), citation: { ...(row.citation as Extract<EvidenceDeskItemV2["citation"], { kind: "page" }>), section_id } } });
  const lists = [{ id: "L1" as const, members: ["E1", "E2", "E3"] }, { id: "L2" as const, members: ["E2"] }];

  it("reads an opened section of a listed page as that page, never as another member", () => {
    const membership = agenticListMembershipV1(lists, [...pages, section("E9", pages[0]!.item, "s1"), section("E10", pages[0]!.item, "s2"), section("E11", pages[1]!.item, "s1"), section("E12", pageRow("999", "Other"), "s1")]);
    expect(membership.in("L1", "E2")).toBe("E2");
    expect(membership.in("L2", "E2")).toBe("E2");
    expect(membership.in("L1", "E9")).toBe("E1");
    expect(membership.in("L1", "E10")).toBe("E1");
    expect(membership.in("L2", "E11")).toBe("E2");
    expect(membership.in("L2", "E9")).toBeUndefined();
    // A page no list holds, an id nothing knows, and a list nobody read hold nothing.
    for (const list of ["L1", "L2"] as const) for (const id of ["E12", "E40"]) expect(membership.in(list, id)).toBeUndefined();
    expect(membership.in("L3", "E1")).toBeUndefined();
  });

  it("reads a ticket's opened body as its listed row, and keeps each meeting record its own", () => {
    const ticket = (short: string, id: string, ticket_id: string) => ({ short, item: { id, citation: { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-one", ticket_id, permalink: `https://tickets.example.test/browse/T-${ticket_id}`, text_sha256: sha256Digest(id) } } });
    const atom = (short: string, atom_id: string) => ({ short, item: { id: atom_id, citation: { kind: "approved_record", atom_id, record_sha256: canonicalSha256({ record: 1 }) } } });
    const membership = agenticListMembershipV1([{ id: "L1", members: ["E1", "E3"] }], [ticket("E1", "row", "100"), ticket("E2", "body", "100"), atom("E3", canonicalSha256({ atom: 1 })), atom("E4", canonicalSha256({ atom: 2 }))]);
    expect(membership.in("L1", "E2")).toBe("E1");
    expect(membership.in("L1", "E4")).toBeUndefined();
  });
});

describe("what a need's declared kind asks of lists", () => {
  const need = (kind: "which_items" | "which_say" | "content" | undefined, status: "open" | "found" | "not_found", evidence: readonly string[] = []) =>
    ({ need: "n", ...(kind === undefined ? {} : { kind }), status, evidence });

  it("reads a list for a which_items need research has not given up on, and for a which_say need of any status", () => {
    expect(["open", "found", "not_found"].map(status => agenticNeedReadsListV1(need("which_items", status as "open")))).toEqual([true, true, false]);
    expect(["open", "found", "not_found"].map(status => agenticNeedReadsListV1(need("which_say", status as "open")))).toEqual([true, true, true]);
    // A content need's list ids carry no meaning, and a need without a kind is content.
    for (const status of ["open", "found", "not_found"] as const) for (const kind of ["content", undefined] as const) expect(agenticNeedReadsListV1(need(kind, status))).toBe(false);
  });

  it("names the lists code states and the lists research checks, each once in plan order, never a content need's", () => {
    const known = (id: AgenticListIdV1) => id !== "L9";
    expect(agenticPlanListsV1([
      need("content", "found", ["L4", "E1"]), need("which_say", "found", ["L2", "E9", "L1"]), need("which_items", "found", ["L3", "L1", "L9"]),
      need("which_items", "open", ["l5"]), need("which_items", "not_found", ["L6"]), need("which_say", "not_found", ["L7"]), need(undefined, "found", ["L8"]), need("which_items", "found", ["E1", "E2"]),
    ], known)).toEqual({ stated: ["L3", "L1", "L5"], checking: ["L2", "L1", "L7"] });
    expect(agenticPlanListsV1([], known)).toEqual({ stated: [], checking: [] });
  });
});

describe("what research's opens read", () => {
  const open = (id: string, opened: readonly string[], result: { readonly error?: string; readonly truncated?: boolean; readonly notice?: boolean } = {}): AgenticOpenActionV1 =>
    ({ tool: "open", args: { id }, result: { opened, ...result } });
  const round = (...actions: AgenticOpenActionV1[]) => ({ actions });
  const id_of = (raw: unknown) => typeof raw === "string" && /^E\d+$/u.test(raw) ? raw : null;

  it("keeps each clean open's bodies, read in full, until a limited open undoes it", () => {
    const full = (id: string) => ["E9", "E10", "E11", "E12"].includes(id);
    const reads = agenticOpenReadsV1([
      round(open("E1", ["E9", "E10"]), open("E2", ["E11"], { truncated: true }), open("E3", ["E12", "E13"]), { tool: "search", args: { query: "E4" }, result: { opened: ["E12"] } }),
      round(open("E1", [], { error: "unavailable" }), open("E2", ["E11"]), open("E4", []), open("a title", ["E12"])),
    ], full, id_of);
    // E1's later open failed; E2's later open was clean; E3 returned a body research did not read; E4 returned none.
    expect([...reads.clean]).toEqual([["E2", ["E11"]]]);
    expect([...reads.limited]).toEqual(["E1"]);
  });
});

describe("the writer's view", () => {
  it("shows a member's row facts and never its text", () => {
    const row = pageRow("1441793", "Gate reviews — EVT pass, DVT hold, PVT pending");
    const member = agenticWriterListMemberV1({ short: "E3", item: { ...row, text: "Released section text" } }, false);
    expect(member).toEqual({
      id: "E3", kind: "page", title: "Gate reviews — EVT pass, DVT hold, PVT pending", status: "current",
      dates: { created: "2026-10-04T23:12:00.000Z", updated: "2026-10-04T23:38:00.000Z" }, date: "2026-10-04", date_kind: "version_created", checked: false,
    });
    expect(member).not.toHaveProperty("text");
    // @ts-expect-error a writer member never carries text
    const withText: AgenticWriterListMemberV1 = { ...member, text: "x" };
    expect(withText).toBeDefined();
  });

  it("titles a member by its list label when it has one, and by its label otherwise (ADR-0041)", () => {
    // Every record of a meeting carries the meeting's label; its list label is one line of its own text, then the meeting.
    const action = { ...pageRow("7", "THERM DVT sync (2026-10-04)"), kind: "action" as const, list_label: "Send fixture drawings to vendor (THERM DVT sync, 2026-10-04)", attributes: { owner: "Dana Lee" } } as EvidenceDeskItemV2;
    expect(agenticWriterListMemberV1({ short: "E1", item: action }, false)).toMatchObject({ id: "E1", kind: "action", title: "Send fixture drawings to vendor (THERM DVT sync, 2026-10-04)", owner: "Dana Lee" });
    expect(agenticWriterListMemberV1({ short: "E2", item: pageRow("8", "PRD — System and acceptance requirements") }, false).title).toBe("PRD — System and acceptance requirements");
    expect(agenticWriterListMemberV1({ short: "E1", item: action }, false)).not.toHaveProperty("list_label");
  });

  it("keeps a ticket's status, owner and due date, and says when an action has no owner", () => {
    const ticket = { ...pageRow("46", "THERM-46: Display firmware"), kind: "ticket" as const, attributes: { status: "In Progress", owner: "Tobias Lund", due_at: "2026-10-15" } } as EvidenceDeskItemV2;
    expect(agenticWriterListMemberV1({ short: "E1", item: ticket }, true)).toMatchObject({ status: "In Progress", owner: "Tobias Lund", due: "2026-10-15", checked: true });
    const action = { ...pageRow("7", "Check the numbers"), kind: "action" as const, attributes: { due_at: "2026-09-12" } } as EvidenceDeskItemV2;
    expect(agenticWriterListMemberV1({ short: "E2", item: action }, false)).toMatchObject({ owner: "none recorded", due: "2026-09-12" });
  });

  it("shows fewer members when the writer's prompt has less room, never fewer than none", () => {
    const list = createAgenticListEvidenceV1(OCTOBER_4);
    const rows = list.members.map((id, index) => agenticWriterListMemberV1({ short: id, item: pageRow(String(index + 1), `Page ${index + 1}`) }, false));
    expect(agenticWriterListV1(list, rows, true, 3)).toMatchObject({ count: 8, members: rows.slice(0, 3), members_omitted: 5 });
    expect(agenticWriterListV1(list, rows, true, 0)).toMatchObject({ count: 8, members: [], members_omitted: 8 });
    expect(() => agenticWriterListV1(list, rows, true, -1)).toThrow(/max_members/u);
  });

  it("bounds a long list's members and counts the rest, with checks counted over all members", () => {
    const ids = Array.from({ length: 120 }, (_, index) => `E${index + 1}`);
    const list = createAgenticListEvidenceV1({ ...OCTOBER_4, members: ids, shown: 120 });
    const rows = ids.map((id, index) => agenticWriterListMemberV1({ short: id, item: pageRow(String(index + 1), `Page ${index + 1}`) }, index === 0 || index === 110));
    const view = agenticWriterListV1(list, rows, true);
    expect(view).toMatchObject({ id: "L1", source: "pages", complete: true, count: 120, checked: 2, stated: true, members_omitted: 20, read_at: OCTOBER_4.read_at });
    expect(view.members).toHaveLength(AGENTIC_LIST_WRITER_MEMBERS_MAX_V1);
    expect(agenticWriterListV1(createAgenticListEvidenceV1(OCTOBER_4), rows.slice(0, 8), false)).not.toHaveProperty("members_omitted");
    expect(() => agenticWriterListV1(list, [...rows].reverse(), true)).toThrow(/the list's members, in order/u);
  });

  it("lets the writer choose a list and select by one row fact other than its title, never write names", () => {
    expect(AGENTIC_LIST_SELECTION_FIELDS_V1).toEqual(["owner", "status", "due", "created", "updated", "received", "occurred"]);
    const mine: AgenticAnswerListUseV1 = { id: "L1", where: { field: "owner", value: "Dana Lee" } };
    const week: AgenticAnswerListUseV1 = { id: "L1", where: { field: "due", since: "2026-10-18", until: "2026-10-24" } };
    expect([mine.where?.field, week.where?.field]).toEqual(["owner", "due"]);
    expectTypeOf<NonNullable<AgenticAnswerListUseV1["where"]>>().toEqualTypeOf<AgenticListSelectionV1>();
    expectTypeOf<NonNullable<AgenticAnswerListUseV1["where"]>["field"]>().toEqualTypeOf<"owner" | "status" | "due" | "created" | "updated" | "received" | "occurred">();
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
  it.each([
    [[8], [8]],
    [[60], [25]],
    [[8, 60], [8, 17]],
    [[60, 60], [13, 12]],
    [[0, 5], [0, 5]],
    [[], []],
  ] as const)("shares %j as %j, at most 25 in all", (selected, shares) => {
    const result = agenticListNameSharesV1(selected);
    expect(result).toEqual(shares);
    expect(result.reduce((total, share) => total + share, 0)).toBeLessThanOrEqual(AGENTIC_LIST_NAMED_MAX_V1);
  });

  it("takes 'and N more' from the list itself: 60 members, 25 named, 35 more", () => {
    const [share] = agenticListNameSharesV1([60]);
    expect(60 - share!).toBe(35);
    expect(agenticListNameSharesV1([3], 0)).toEqual([0]);
    expect(() => agenticListNameSharesV1([-1])).toThrow(RangeError);
  });
});

describe("the bundle and the evaluation view", () => {
  function bundle(lists?: readonly AgenticListEvidenceV1[]): AgenticEvidenceBundleV1 {
    return {
      schema_version: 1, kind: "echo-agentic-evidence-bundle-v1", trigger: "ask", goal: { kind: "question", question: "Which Confluence pages were created on October 4, 2026?" },
      budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, plan: [], items: [], ...(lists === undefined ? {} : { lists }), unreadable_starting: [], rounds: [],
      coverage: { reads: [], inventories: [], notices: [] }, stop: { reason: "finished", completed: true },
      cost: { rounds: 2, model_calls: 3, repairs: 0, fallbacks: 0, input_tokens: null, output_tokens: null, total_tokens: null, model_ms: 0, desk_ms: 0, elapsed_ms: 0 },
      gathered_for: { scope: { kind: "global" }, checked_at: null }, server: { receipts: [], invocation_digests: [], generations: [] },
    };
  }

  it("carries lists for Ask and leaves them out for a task goal", () => {
    expectTypeOf<AgenticEvidenceBundleV1["lists"]>().toEqualTypeOf<readonly AgenticListEvidenceV1[] | undefined>();
    expectTypeOf<AgenticResearchResultV1["lists"]>().toEqualTypeOf<readonly AgenticListEvidenceV1[] | undefined>();
    const list = createAgenticListEvidenceV1(OCTOBER_4);
    expect(trimAgenticEvidenceBundleV1(bundle([list])).lists).toEqual([list]);
    expect(trimAgenticEvidenceBundleV1(bundle())).not.toHaveProperty("lists");
  });
});

describe("the statement code writes for a list (ADR-0041)", () => {
  const titles = ["ECHO Product Pipeline — Start Here", "Assumptions and decisions — source facts versus proposals", "Gate reviews — EVT pass, DVT hold, PVT pending"];
  const page = (title: string) => ({ title, status: "current" });

  it("reads a filter as applied: dates, channel and fields, never the model's arguments", () => {
    expect(agenticCalendarDayV1("2026-10-04")).toBe("October 4, 2026");
    expect(agenticCalendarDayV1("2026-10-04T08:00:00Z")).toBe("2026-10-04T08:00:00Z");
    expect(agenticListFilterPhraseV1(OCTOBER_4.filter)).toBe(" created on October 4, 2026");
    expect(agenticListFilterPhraseV1({ date_field: "updated", since: "2026-10-01", until: "2026-10-04" })).toBe(" updated from October 1 to October 4, 2026");
    expect(agenticListFilterPhraseV1({ since: "2025-12-30", until: "2026-01-02" })).toBe(" dated from December 30, 2025 to January 2, 2026");
    expect(agenticListFilterPhraseV1({ channel: "hw-dvt", since: "2026-10-03" })).toBe(" in #hw-dvt dated since October 3, 2026");
    expect(agenticListFilterPhraseV1({ date_field: "due", until: "2026-10-09" })).toBe(" due through October 9, 2026");
    expect(agenticListFilterPhraseV1({ kind: "action", owner: "Mara", status: "open", time_zone: "UTC" })).toBe(" with kind action, owner Mara and status open");
    expect(agenticListFilterPhraseV1({ time_zone: "UTC" })).toBe("");
  });

  it("names members by label, with status, owner and due date only where they differ", () => {
    expect(agenticListMemberNamesV1(titles.map(page))).toEqual(titles);
    expect(agenticListMemberNamesV1([
      { title: "THERM-1: Fixture", status: "In Progress", owner: "Dana Lee" },
      { title: "THERM-2: Firmware", status: "Done", owner: "Dana Lee", due: "2026-10-09" },
    ])).toEqual(["THERM-1: Fixture (In Progress)", "THERM-2: Firmware (Done, due October 9, 2026)"]);
    expect(agenticListMemberNamesV1([{ title: "Check the numbers", owner: "none recorded" }, { title: "Ship it", owner: "Mara" }]))
      .toEqual(["Check the numbers (no owner recorded)", "Ship it (owner Mara)"]);
    const [long] = agenticListMemberNamesV1([{ title: `${"x".repeat(200)}\nsecond line` }]);
    expect([...long!]).toHaveLength(120);
    expect(long!.endsWith("…")).toBe(true);
  });

  it("names members that share a label and their row facts once, with their kinds counted", () => {
    const sync = "THERM DVT sync (2026-10-04)";
    // A meeting's records all carry the meeting's label; its action records an owner the others do not.
    const records = [{ title: sync, kind: "imported_meeting" }, { title: sync, kind: "decision" }, { title: "Vendor review (2026-10-04)", kind: "action", owner: "Dana" }, { title: sync, kind: "action", owner: "Dana" }, { title: sync, kind: "rationale" }];
    expect(agenticListMemberNamesV1(records)).toEqual([`${sync} (1 meeting, 1 decision and 1 rationale)`, "Vendor review (2026-10-04) (1 action, owner Dana)", `${sync} (1 action, owner Dana)`]);
    const statement = agenticListStatementV1({ noun: agenticListMembersNounV1({ selector: "meetings" }, records.map(record => record.kind)), filter: { since: "2026-10-04", until: "2026-10-04" }, count: 5, complete: true, selected: records, share: 25 });
    expect(statement).toEqual({ text: `5 items from meetings dated on October 4, 2026: ${sync} (1 meeting, 1 decision and 1 rationale); Vendor review (2026-10-04) (1 action, owner Dana); ${sync} (1 action, owner Dana).`, named: 5, cited: [0, 1, 2, 3, 4] });
    // A merge never hides a row fact: one meeting's actions due on different days are named apart, each with its date.
    const review = "DVT review (2026-10-01)";
    const due = (date?: string) => ({ title: review, kind: "action", owner: "Mara Quinn", ...(date === undefined ? {} : { due: date }) });
    expect(agenticListMemberNamesV1([due("2026-10-09"), due("2026-10-12"), due(), due(" 2026-10-09")]))
      .toEqual([`${review} (2 actions, due October 9, 2026)`, `${review} (due October 12, 2026)`, review]);
    // A kind filter is the noun, not a phrase; three decisions of one meeting are one name.
    const decisions = Array.from({ length: 3 }, () => ({ title: sync, kind: "decision" }));
    expect(agenticListStatementV1({ noun: agenticListMembersNounV1({ selector: "meetings" }, ["decision"]), filter: { kind: "decision", owner: "Dana" }, count: 3, complete: true, selected: decisions, share: 25 }).text)
      .toBe(`3 decisions with owner Dana: ${sync} (3 decisions).`);
    // A share smaller than a name's members cites the first of them; "and N more" counts members, from the list.
    const two = agenticListStatementV1({ noun: "decisions", filter: {}, count: 4, complete: true, selected: [...decisions, { title: "Other (2026-10-05)", kind: "decision" }], share: 2 });
    expect(two).toEqual({ text: `4 decisions: ${sync} (3 decisions); and 1 more.`, named: 3, cited: [0, 1] });
  });

  it("writes the October 4 statement: the count, the filter and every name", () => {
    const statement = agenticListStatementV1({ noun: "Confluence pages", filter: OCTOBER_4.filter, count: 3, complete: true, selected: titles.map(page), share: 25 });
    expect(statement).toEqual({ text: `3 Confluence pages created on October 4, 2026: ${titles.join("; ")}.`, named: 3, cited: [0, 1, 2] });
    expect(agenticListStatementV1({ noun: "Confluence pages", filter: OCTOBER_4.filter, count: 1, complete: true, selected: [page(titles[0]!)], share: 25 }).text)
      .toBe(`1 Confluence page created on October 4, 2026: ${titles[0]}.`);
  });

  it("names its share, then 'and N more' with N from the list, and says 'at least' for a list not read to its end", () => {
    const sixty = Array.from({ length: 60 }, (_, index) => ({ title: `THERM-${index + 1}: Fixture work ${index + 1}` }));
    const statement = agenticListStatementV1({ noun: "Jira tickets", filter: OCTOBER_4.filter, count: 60, complete: true, selected: sixty, share: 25 });
    expect(statement.named).toBe(25);
    expect(statement.text).toBe(`60 Jira tickets created on October 4, 2026: ${sixty.slice(0, 25).map(value => value.title).join("; ")}; and 35 more.`);
    expect(agenticListStatementV1({ noun: "Jira tickets", filter: {}, count: 25, complete: false, selected: sixty.slice(0, 2), share: 2 }).text)
      .toBe("At least 25 Jira tickets: THERM-1: Fixture work 1; THERM-2: Fixture work 2.");
  });

  it("writes a selection by owner, and its not-found phrase when it matches nothing", () => {
    const rows = [{ title: "THERM-1: A", owner: "Dana Lee" }, { title: "THERM-2: B", owner: "Tobias Lund" }, { title: "THERM-3: C", owner: "dana lee" }];
    const mine = agenticListSelectV1(rows, { field: "owner", value: " DANA LEE " });
    expect(mine).toEqual([rows[0], rows[2]]);
    expect(agenticListSelectV1(rows, undefined)).toBe(rows);
    expect(agenticListStatementV1({ noun: "Jira tickets", filter: OCTOBER_4.filter, count: 3, complete: true, where: { field: "owner", value: "Dana Lee" }, selected: mine, share: 25 }).text)
      .toBe("2 of the 3 Jira tickets created on October 4, 2026 have owner Dana Lee: THERM-1: A; THERM-3: C.");
    expect(agenticListStatementV1({ noun: "Jira tickets", filter: {}, count: 50, complete: false, where: { field: "status", value: "Done" }, selected: [rows[1]!], share: 25 }).text)
      .toBe("At least 1 Jira ticket has status Done (50 listed so far): THERM-2: B.");
    expect(agenticListSelectionNotFoundV1("Jira tickets", OCTOBER_4.filter, { field: "owner", value: "Zhen Ye" })).toBe("Jira tickets created on October 4, 2026 that have owner Zhen Ye");
  });

  it("selects by a row date within an inclusive range, each day the list's, and leaves out a member that records none", () => {
    const titles = (members: readonly { readonly title: string }[]) => members.map(member => member.title);
    // A member's due date: its named dates first, then its due date, then its one dated fact when that is a due date.
    const rows = [
      { title: "named", dates: { due: "2026-10-20" }, due: "2026-11-30" }, { title: "attribute", due: "2026-10-24" }, { title: "dated", date: "2026-10-18", date_kind: "due" as const },
      { title: "later", due: "2026-10-25" }, { title: "none" }, { title: "created", date: "2026-10-19", date_kind: "created" as const },
    ];
    expect(titles(agenticListSelectV1(rows, { field: "due", since: "2026-10-18", until: "2026-10-24" }))).toEqual(["named", "attribute", "dated"]);
    expect(titles(agenticListSelectV1(rows, { field: "due", since: "2026-10-24" }))).toEqual(["attribute", "later"]);
    expect(titles(agenticListSelectV1(rows, { field: "due", until: "2026-10-18" }))).toEqual(["dated"]);
    expect(titles(agenticListSelectV1(rows, { field: "created", since: "2026-10-19", until: "2026-10-19" }))).toEqual(["created"]);
    // A timestamp is placed in the list's time zone, as the desk's own date filter places it; a calendar day keeps its day.
    const updated = [
      { title: "Tokyo's Oct 11", dates: { updated: "2026-10-10T23:30:00.000Z" } }, { title: "Los Angeles' Oct 10", dates: { updated: "2026-10-11T03:00:00.000Z" } },
      { title: "a day", dates: { updated: "2026-10-11" } },
    ];
    const since = { field: "updated", since: "2026-10-11" } as const;
    expect(titles(agenticListSelectV1(updated, since, "Asia/Tokyo"))).toEqual(["Tokyo's Oct 11", "Los Angeles' Oct 10", "a day"]);
    expect(titles(agenticListSelectV1(updated, since, "America/Los_Angeles"))).toEqual(["a day"]);
    expect(titles(agenticListSelectV1(updated, since, "UTC"))).toEqual(["Los Angeles' Oct 10", "a day"]);
    expect(titles(agenticListSelectV1(updated, since))).toEqual(["Los Angeles' Oct 10", "a day"]);
    // An owner or status selection is unchanged.
    expect(titles(agenticListSelectV1([{ title: "a", status: "Done" }, { title: "b", status: "done " }, { title: "c" }], { field: "status", value: "DONE" }))).toEqual(["a", "b"]);
  });

  it("says a date selection's range in its lead and its not-found phrase, and an owner or status as before", () => {
    const followUps = { plural: "follow-ups", singular: "follow-up", kind: "follow_up" };
    const mara = { owner: "Mara Lind", status: "open" as const };
    const due = { field: "due", since: "2026-10-18", until: "2026-10-24" } as const;
    expect(agenticListStatementV1({ noun: followUps, filter: mara, count: 12, complete: true, where: due, selected: [{ title: "THERM-43 follow-up" }, { title: "THERM-47 follow-up" }], share: 25 }).text)
      .toBe("2 of the 12 follow-ups with owner Mara Lind and status open are due from October 18 to October 24, 2026: THERM-43 follow-up; THERM-47 follow-up.");
    expect(agenticListStatementV1({ noun: followUps, filter: mara, count: 12, complete: true, where: { field: "due", until: "2026-10-17" }, selected: [{ title: "THERM-41 follow-up" }], share: 25 }).text)
      .toBe("1 of the 12 follow-ups with owner Mara Lind and status open is due through October 17, 2026: THERM-41 follow-up.");
    const three = Array.from({ length: 3 }, (_, index) => ({ title: `THERM-${index + 1}: A` }));
    expect(agenticListStatementV1({ noun: "Jira tickets", filter: OCTOBER_4.filter, count: 25, complete: false, where: { field: "updated", since: "2026-10-11" }, selected: three, share: 25 }).text)
      .toBe("At least 3 Jira tickets created on October 4, 2026 were updated since October 11, 2026 (25 listed so far): THERM-1: A; THERM-2: A; THERM-3: A.");
    expect(agenticListStatementV1({ noun: "Confluence pages", filter: {}, count: 8, complete: true, where: { field: "created", since: "2026-10-04", until: "2026-10-04" }, selected: [{ title: "PRD" }], share: 25 }).text)
      .toBe("1 of the 8 Confluence pages was created on October 4, 2026: PRD.");
    expect(agenticListSelectionNotFoundV1(followUps, mara, due)).toBe("follow-ups with owner Mara Lind and status open due from October 18 to October 24, 2026");
    expect(agenticListSelectionNotFoundV1("Confluence pages", OCTOBER_4.filter, { field: "updated", since: "2026-10-11" })).toBe("Confluence pages created on October 4, 2026 updated since October 11, 2026");
  });

  it("states the row facts of members selected by id, each alone, with every date in the list's time zone", () => {
    const prd = { title: "PRD — System and acceptance requirements", kind: "page", status: "current", dates: { created: "2026-10-05T03:00:00.000Z", updated: "2026-10-05T22:11:30.875Z" } };
    // 03:00 UTC on October 5 is October 4 in Los Angeles: a day is the list's, never UTC's.
    expect(agenticListStatementV1({ noun: "Confluence pages", filter: OCTOBER_4.filter, count: 8, complete: true, by_id: true, selected: [prd], share: 25 }))
      .toEqual({ text: "1 of the 8 Confluence pages created on October 4, 2026: PRD — System and acceptance requirements (status current, created October 4, 2026, updated October 5, 2026).", named: 1, cited: [0] });
    // Actions of one meeting share its label, but each keeps its own owner and due date; a calendar day keeps its day.
    const sync = "DVT review (2026-10-01)";
    const actions = [
      { title: sync, kind: "action", owner: "Mara Quinn", due: "2026-10-09", date: "2026-10-01", date_kind: "occurred" as const },
      { title: sync, kind: "action", owner: "none recorded", dates: { occurred: "2026-10-01", due: "2026-10-12" } },
    ];
    expect(agenticListStatementV1({ noun: "actions", filter: { time_zone: "UTC" }, count: 2, complete: false, by_id: true, selected: actions, share: 25 }).text)
      .toBe(`At least 2 actions: ${sync} (owner Mara Quinn, due October 9, 2026, dated October 1, 2026); ${sync} (no owner recorded, dated October 1, 2026, due October 12, 2026).`);
    expect(agenticListStatementV1({ noun: "Jira tickets", filter: {}, count: 25, complete: false, by_id: true, selected: [{ title: "THERM-46: Fixture", status: "In Progress", date: "2026-10-04", date_kind: "unspecified" }], share: 25 }).text)
      .toBe("1 of at least 25 Jira tickets: THERM-46: Fixture (status In Progress).");
  });

  it("names members another statement already named by id at no share, and leads a selection named by id with its condition (W2, W6)", () => {
    const tickets = Array.from({ length: 25 }, (_, index) => ({ title: `THERM-${index + 1}: A`, status: "In Review" }));
    const free = new Set(Array.from({ length: 10 }, (_, index) => index));
    const all = agenticListStatementV1({ noun: "Jira tickets", filter: {}, count: 25, complete: false, selected: tickets, share: 15, free });
    expect(all).toEqual({ text: `At least 25 Jira tickets: ${tickets.map(ticket => ticket.title).join("; ")}.`, named: 25, cited: Array.from({ length: 25 }, (_, index) => index) });
    // Without them free, the same share names 15, and cites those 15.
    expect(agenticListStatementV1({ noun: "Jira tickets", filter: {}, count: 25, complete: false, selected: tickets, share: 15 })).toMatchObject({ named: 15, cited: Array.from({ length: 15 }, (_, index) => index) });
    // A merged group cites every free member it names, and at most `share` of the others.
    const sync = Array.from({ length: 4 }, () => ({ title: "THERM DVT sync (2026-10-04)", kind: "decision" }));
    expect(agenticListStatementV1({ noun: "decisions", filter: {}, count: 4, complete: true, selected: sync, share: 1, free: new Set([2, 3]) })).toMatchObject({ named: 4, cited: [0, 2, 3] });
    // A where use and a selection by id of the same members: the condition's lead, each member named with its facts.
    expect(agenticListStatementV1({ noun: "Jira tickets", filter: {}, count: 25, complete: true, where: { field: "status", value: "In Review" }, by_id: true, selected: tickets.slice(0, 2), share: 25 }).text)
      .toBe("2 of the 25 Jira tickets have status In Review: THERM-1: A (status In Review); THERM-2: A (status In Review).");
  });

  it("stops naming before a statement passes its byte bound, and counts the rest as more", () => {
    const wide = Array.from({ length: 25 }, (_, index) => ({ title: `${index} ${"𝔸".repeat(118)}` }));
    const statement = agenticListStatementV1({ noun: "Confluence pages", filter: OCTOBER_4.filter, count: 25, complete: true, selected: wide, share: 25 });
    expect(Buffer.byteLength(statement.text, "utf8")).toBeLessThanOrEqual(AGENTIC_LIST_STATEMENT_BYTES_V1);
    expect(statement.named).toBeLessThan(25);
    expect(statement.text.endsWith(`; and ${25 - statement.named} more.`)).toBe(true);
    expect(() => agenticListStatementV1({ noun: "pages", filter: {}, count: 0, complete: true, selected: [], share: 25 })).toThrow(RangeError);
  });

  it("says how many members were checked for content across a list (addition 4)", () => {
    expect(agenticListCheckedNoteV1({ checked: 4, count: 8, complete: true })).toBe("(4 of 8 checked so far)");
    expect(agenticListCheckedNoteV1({ checked: 25, count: 25, complete: false })).toBe("(25 of at least 25 checked so far)");
    expect(agenticListCheckedNoteV1({ checked: 8, count: 8, complete: true })).toBeUndefined();
  });
});
