import type { EvidenceDeskDateKindV1 } from "../shared/evidence-desk-v1.js";
import type { EvidenceDeskItemV2 } from "../shared/evidence-desk-v2.js";
import { evidenceDayV1, matchesEvidenceDateV1, type EvidenceDateFieldV1, type EvidenceDatesV1 } from "../shared/temporal-query-v1.js";
import { attributesOf } from "./agentic-evidence-bundle-v1.js";
import type { AgenticResearchNeedV1 } from "./agentic-research-v1.js";

/**
 * List evidence (ADR-0041). For a question goal (Ask), a list research read is
 * evidence of which items exist: its filter, its members, whether it was read
 * to its end and when. A list supports list facts only (which items exist,
 * and each member's title, dates, status and owner), never what an item says.
 * A task goal (impact cards, sweeps) records no lists and keeps the rules
 * before ADR-0041.
 *
 * Everything here holds model-facing ids (`L1`, `E4`), selectors and row
 * facts only: never a desk id, receipt, cursor, item text or vendor total.
 */

// ---- ids --------------------------------------------------------------

/** A list's model-facing id: `L1`, `L2`, ... in first-read order. Never a desk id. */
export type AgenticListIdV1 = `L${number}`;

const LIST_ID = /^\s*\[?\s*[Ll]\s*(\d{1,4})\s*\]?\s*$/u;
const ITEM_ID = /^E[1-9]\d{0,3}$/u;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** The id of the list read `position`-th in a request (1-based). */
export function agenticListIdV1(position: number): AgenticListIdV1 {
  if (!Number.isSafeInteger(position) || position < 1 || position > 9999) throw new RangeError("List position must be 1 to 9999");
  return `L${position}`;
}

/** A list id as a model writes it ("L3", "l3", "[L3]"); null for anything else, an item id included. */
export function parseAgenticListIdV1(value: unknown): AgenticListIdV1 | null {
  if (typeof value !== "string") return null;
  const match = LIST_ID.exec(value);
  if (match === null) return null;
  const position = Number(match[1]);
  return position >= 1 ? `L${position}` : null;
}

// ---- the record -------------------------------------------------------

/** The filter fields a list request can name (the research protocol's list args other than source). */
export const AGENTIC_LIST_FILTER_FIELDS_V1 = Object.freeze(["kind", "status", "owner", "channel", "since", "until", "date_field"] as const);
export type AgenticListFilterFieldV1 = (typeof AGENTIC_LIST_FILTER_FIELDS_V1)[number];

/**
 * How a requested filter field was applied. `applied`: every member meets it.
 * `partial`: applied only to members that record the field, the others kept
 * (meeting-action status). `ignored`: the source cannot apply it, so the list
 * is wider than asked, and the answer says so (ADR-0041, addition 3).
 */
export type AgenticListFilterApplicationV1 = "applied" | "partial" | "ignored";
const FILTER_APPLICATIONS: ReadonlySet<string> = new Set(["applied", "partial", "ignored"]);

/** The filter as the list applied it, after normalization. An ignored field is absent here. */
export interface AgenticListFilterV1 {
  readonly kind?: string;
  readonly status?: "open" | "done";
  readonly owner?: string;
  readonly channel?: string;
  /** Inclusive YYYY-MM-DD bounds; a catalog default (Slack's 14 days) appears here unrequested. */
  readonly since?: string;
  readonly until?: string;
  readonly date_field?: EvidenceDateFieldV1;
  readonly time_zone?: string;
}

/** One list research read: one normalized selection of one source. Request-local; never stored. */
export interface AgenticListEvidenceV1 {
  readonly id: AgenticListIdV1;
  /** The source selector the model used, as the source catalog shows it. */
  readonly source: string;
  readonly filter: AgenticListFilterV1;
  /** Each filter field the model asked for, and how the list applied it. */
  readonly filter_applied: Readonly<Partial<Record<AgenticListFilterFieldV1, AgenticListFilterApplicationV1>>>;
  /** E ids of the rows the list released, after ECHO's own owner and status filter, in the source's order, each once. */
  readonly members: readonly string[];
  /** Members whose row was in a research step admitted after its access check, under opened or seen. */
  readonly shown: number;
  /** No next page, and every fetched row is a member: research cannot read further. */
  readonly ended: boolean;
  /** The last page had no next link but was exactly full, so its end is not confirmed (addition 1). */
  readonly unverified_end: boolean;
  /** No page carried an availability notice. */
  readonly available: boolean;
  /** The latest page said more items exist than list can show. */
  readonly truncated: boolean;
  /** When the desk returned the list's first page, RFC 3339 UTC (addition 2: a source's search can lag edits). */
  readonly read_at: string;
  /** Derived: available, not truncated, ended, end verified and every member shown. Only then does the list support "all". */
  readonly complete: boolean;
}

/** A list record before code derives `complete`. */
export type AgenticListEvidenceInputV1 = Omit<AgenticListEvidenceV1, "complete">;

/** A list is complete when it was read to a confirmed end and the research model saw every member. */
export function agenticListCompleteV1(list: Pick<AgenticListEvidenceV1, "available" | "truncated" | "ended" | "unverified_end" | "shown" | "members">): boolean {
  return list.available && !list.truncated && list.ended && !list.unverified_end && list.shown === list.members.length;
}

function invalid(reason: string): never {
  throw new TypeError(`List evidence is invalid: ${reason}`);
}

/**
 * The one way to make a list record: checks its invariants, derives
 * `complete` and freezes it. A `complete` value passed in is ignored.
 */
export function createAgenticListEvidenceV1(input: AgenticListEvidenceInputV1): AgenticListEvidenceV1 {
  if (parseAgenticListIdV1(input.id) !== input.id) invalid("id must be L1 to L9999");
  if (typeof input.source !== "string" || input.source.trim().length === 0) invalid("source is required");
  if (!Array.isArray(input.members) || !input.members.every(id => typeof id === "string" && ITEM_ID.test(id))) invalid("members must be item ids such as E4");
  if (new Set(input.members).size !== input.members.length) invalid("members must be distinct");
  if (!Number.isSafeInteger(input.shown) || input.shown < 0 || input.shown > input.members.length) invalid("shown must count members");
  for (const flag of ["ended", "unverified_end", "available", "truncated"] as const) if (typeof input[flag] !== "boolean") invalid(`${flag} must be a boolean`);
  if (typeof input.read_at !== "string" || !UTC_TIME.test(input.read_at) || !Number.isFinite(Date.parse(input.read_at))) invalid("read_at must be an RFC 3339 UTC time");
  const filter = input.filter as Readonly<Record<string, unknown>>;
  for (const [field, how] of Object.entries(input.filter_applied)) {
    if (!(AGENTIC_LIST_FILTER_FIELDS_V1 as readonly string[]).includes(field)) invalid(`filter_applied names unknown field ${field}`);
    if (!FILTER_APPLICATIONS.has(how as string)) invalid(`filter_applied.${field} must be applied, partial or ignored`);
    if ((how === "ignored") !== (filter[field] === undefined)) invalid(`filter.${field} must be absent exactly when it was ignored`);
  }
  const record: AgenticListEvidenceInputV1 = {
    id: input.id, source: input.source, filter: Object.freeze({ ...input.filter }), filter_applied: Object.freeze({ ...input.filter_applied }),
    members: Object.freeze([...input.members]), shown: input.shown, ended: input.ended, unverified_end: input.unverified_end,
    available: input.available, truncated: input.truncated, read_at: input.read_at,
  };
  return Object.freeze({ ...record, complete: agenticListCompleteV1(record) });
}

/**
 * Whether a list page leaves the list's end unverified (addition 1): it has no
 * next link, and it was exactly full. A desk that knows its raw page says so
 * with `page_full`; otherwise a page with as many rows as research asked for
 * counts as full. `returned` is the desk's rows before ECHO's own filtering.
 */
export function agenticListEndUnverifiedV1(page: { readonly returned: number; readonly requested: number; readonly next_cursor?: string; readonly page_full?: boolean }): boolean {
  if (page.next_cursor !== undefined) return false;
  if (page.page_full !== undefined) return page.page_full;
  return page.returned > 0 && page.returned >= page.requested;
}

// ---- how a list is named, and what its filter could not do -------------

/**
 * A list's noun for the person (ADR-0041): the source's selector, after its tool when the catalog names one ("Jira
 * tickets", "Confluence pages", "meetings", "follow-ups"). It reads only the catalog entry, never a source-specific rule.
 */
export function agenticListNounV1(source: { readonly selector: string; readonly tool_id?: string }): string {
  const selector = source.selector.replace(/_/gu, "-");
  const tool = source.tool_id === undefined || source.tool_id.length === 0 || source.tool_id === source.selector ? undefined : source.tool_id;
  return tool === undefined ? selector : `${tool.charAt(0).toUpperCase()}${tool.slice(1)} ${selector}`;
}

/**
 * What each desk kind is, plural and singular: a decision is a decision whichever source listed it. A document
 * passage that a list releases stands for its document (the inventory lists each document's first passage).
 */
const KIND_NOUNS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  imported_meeting: ["meetings", "meeting"], decision: ["decisions", "decision"], action: ["actions", "action"], rationale: ["rationales", "rationale"],
  note: ["notes", "note"], document_passage: ["documents", "document"], slack_message: ["messages", "message"],
  ticket: ["tickets", "ticket"], page: ["pages", "page"], follow_up: ["follow-ups", "follow-up"],
});
function kindNoun(kind: string, count: number): string {
  const [plural, singular] = KIND_NOUNS[kind] ?? ["items", "item"];
  return `${count} ${count === 1 ? singular : plural}`;
}
/** A plural noun's singular: "Jira tickets" is "Jira ticket". */
function singularOf(noun: string): string {
  return noun.endsWith("s") && !noun.endsWith("ss") ? noun.slice(0, -1) : noun;
}

/** How a list's members are called, plural and singular. */
export interface AgenticListNounFormsV1 {
  readonly plural: string;
  readonly singular: string;
  /** The one desk kind every member has, when the noun names it; a kind filter then needs no words of its own. */
  readonly kind?: string;
}

/**
 * A list's noun from what its members are (ADR-0041): their desk kinds, after the tool when the catalog names one
 * ("Jira tickets", "Slack messages"), so a meeting list of decisions says "decisions", never "meetings". Members of
 * several kinds are "items from" the source's own noun; a list with no member keeps that noun. It reads the catalog
 * entry and the members' kinds only, never a source-specific rule.
 */
export function agenticListMembersNounV1(source: { readonly selector: string; readonly tool_id?: string }, kinds: readonly string[]): AgenticListNounFormsV1 {
  const distinct = [...new Set(kinds)];
  const known = distinct.length === 1 ? KIND_NOUNS[distinct[0]!] : undefined;
  const tool = source.tool_id === undefined || source.tool_id.length === 0 ? undefined : `${source.tool_id.charAt(0).toUpperCase()}${source.tool_id.slice(1)}`;
  if (known !== undefined) {
    const tooled = (noun: string) => tool === undefined ? noun : `${tool} ${noun}`;
    return Object.freeze({ plural: tooled(known[0]), singular: tooled(known[1]), kind: distinct[0]! });
  }
  const noun = agenticListNounV1(source);
  return Object.freeze(distinct.length < 2 ? { plural: noun, singular: singularOf(noun) } : { plural: `items from ${noun}`, singular: `item from ${noun}` });
}
/** A noun as a caller passes it: forms, or a plural whose singular drops its last "s". */
function formsOf(noun: string | AgenticListNounFormsV1): AgenticListNounFormsV1 {
  return typeof noun === "string" ? { plural: noun, singular: singularOf(noun) } : noun;
}

const FILTER_WORDS: Readonly<Record<AgenticListFilterFieldV1, string>> = Object.freeze({
  kind: "kind", status: "status", owner: "owner", channel: "channel", since: "date", until: "date", date_field: "date",
});
function sentence(value: string): string { return `${value.charAt(0).toUpperCase()}${value.slice(1)}`; }
function words(fields: readonly AgenticListFilterFieldV1[]): readonly string[] { return [...new Set(fields.map(field => FILTER_WORDS[field]))]; }

/**
 * What the person is told about a list's filter (addition 3): a requested filter the source ignored, so the list is
 * wider than asked, or one applied only where items record the field. Undefined when every requested filter applied.
 * A date filter is never here: a source that cannot apply one refuses the read.
 */
export function agenticListFilterNoticeV1(list: Pick<AgenticListEvidenceV1, "filter_applied">, noun: string): string | undefined {
  const fields = Object.entries(list.filter_applied) as [AgenticListFilterFieldV1, AgenticListFilterApplicationV1][];
  const ignored = words(fields.filter(([, how]) => how === "ignored").map(([field]) => field));
  const partial = words(fields.filter(([, how]) => how === "partial").map(([field]) => field));
  const notices = [
    ...(ignored.length === 0 ? [] : [`${sentence(noun)} could not be filtered by ${ignored.join(" or ")}, so this list is not limited to ${ignored.length === 1 ? `that ${ignored[0]}` : "those filters"}.`]),
    ...(partial.length === 0 ? [] : [`${sentence(noun)} were filtered by ${partial.join(" and ")} only where they record ${partial.length === 1 ? "one" : "them"}, so this list also includes items that record none.`]),
  ];
  return notices.length === 0 ? undefined : notices.join(" ");
}

// ---- what a need's declared kind asks of lists --------------------------

/**
 * Whether code reads a list for a need (ADR-0041), from its declared kind alone: a which_items need research has not
 * given up on (found, or open when research stopped), whose lists code states, or a which_say need of any status, whose
 * list code counts, since "k of N checked" qualifies "none of them" as much as "these". A content need's list ids, and
 * a need without a kind, carry no meaning. The finish check and the answer read this one definition.
 */
export function agenticNeedReadsListV1(need: Pick<AgenticResearchNeedV1, "kind" | "status">): boolean {
  return need.kind === "which_say" || (need.kind === "which_items" && need.status !== "not_found");
}

/**
 * The lists a plan's declared kinds read (ADR-0041), each once in plan order, from the needs code reads a list for:
 * those its which_items needs cite by id, which code states, and those its which_say needs cite, which research
 * checks. `known` says which ids name a list research read.
 */
export function agenticPlanListsV1(
  needs: readonly Pick<AgenticResearchNeedV1, "kind" | "status" | "evidence">[],
  known: (id: AgenticListIdV1) => boolean,
): { readonly stated: readonly AgenticListIdV1[]; readonly checking: readonly AgenticListIdV1[] } {
  const cited = (kind: "which_items" | "which_say") => Object.freeze([...new Set(needs.filter(need => need.kind === kind && agenticNeedReadsListV1(need)).flatMap(need =>
    need.evidence.flatMap(id => { const list = parseAgenticListIdV1(id); return list !== null && known(list) ? [list] : []; })))]);
  return Object.freeze({ stated: cited("which_items"), checking: cited("which_say") });
}

// ---- opens: what research read by opening an item ------------------------

/** An open as research's rounds record it: the id it asked for and what it returned. */
export interface AgenticOpenActionV1 {
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
  readonly result: { readonly opened: readonly string[]; readonly error?: string; readonly truncated?: boolean; readonly notice?: boolean };
}

/** What research's opens read (agenticOpenReadsV1). */
export interface AgenticOpenReadsV1 {
  /** Each item whose open was clean, with the bodies that open returned: an opened page's sections are new items. */
  readonly clean: ReadonlyMap<string, readonly string[]>;
  /** Each item whose latest open was limited: truncated, with a notice or with an error. */
  readonly limited: ReadonlySet<string>;
}

/**
 * What research read by opening items, from its rounds in order (ADR-0041). An open is clean when it was not
 * truncated, carried no notice or error, and returned only bodies research then read in full. A limited open undoes
 * an item's clean open until a later clean one. The renderer and the evaluation read the same relation: a list member
 * is checked through its clean open (addition 4). `id_of` reads an open's id as the step protocol does.
 */
export function agenticOpenReadsV1(
  rounds: readonly { readonly actions: readonly AgenticOpenActionV1[] }[],
  full: (id: string) => boolean,
  id_of: (raw: unknown) => string | null,
): AgenticOpenReadsV1 {
  const clean = new Map<string, readonly string[]>(); const limited = new Set<string>();
  for (const round of rounds) for (const action of round.actions) {
    if (action.tool !== "open") continue;
    const id = id_of(action.args.id);
    if (id === null) continue;
    if (action.result.error !== undefined || action.result.truncated === true || action.result.notice === true) { limited.add(id); clean.delete(id); continue; }
    if (action.result.opened.length > 0 && action.result.opened.every(full)) { clean.set(id, Object.freeze([...action.result.opened])); limited.delete(id); }
  }
  return Object.freeze({ clean, limited });
}

// ---- membership: an item is a member, or part of one --------------------

/**
 * The fields that name the object a citation cites, by citation kind. A page's
 * section and version, a document passage's anchor and representation, and a
 * ticket's or follow-up's released text are parts of one object; each meeting
 * record and each message is its own. A kind not here is its own object only.
 */
const CITED_OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  page: ["tool_id", "external_scope_id", "page_id"], ticket: ["tool_id", "external_scope_id", "ticket_id"],
  slack_message: ["team_id", "channel_id", "message_ts"], approved_record: ["atom_id"], source_revision: ["source_id", "revision_id"], follow_up: ["item_id"],
});
function citedObject(citation: unknown): string | undefined {
  if (typeof citation !== "object" || citation === null) return undefined;
  const value = citation as Readonly<Record<string, unknown>>;
  const fields = CITED_OBJECT_FIELDS[String(value.kind)];
  if (fields === undefined || fields.some(field => typeof value[field] !== "string")) return undefined;
  return JSON.stringify([value.kind, ...fields.map(field => value[field])]);
}

/** Which list member an item is (ADR-0041). */
export interface AgenticListMembershipV1 {
  /** The member of `list` the item is, or is part of. */
  readonly in: (list: AgenticListIdV1, id: string) => string | undefined;
}

/**
 * An item belongs to a list when it is a member, or when it cites the same
 * object as a member: opening a Confluence row releases its sections as new
 * items, and opening a ticket row releases its body. So "the pages are A, B, C
 * and D" citing four opened sections names four of the list's members. It is
 * identity only: it never says what a need asks. `items` every item the
 * request registered.
 */
export function agenticListMembershipV1(
  lists: readonly { readonly id: AgenticListIdV1; readonly members: readonly string[] }[],
  items: readonly { readonly short: string; readonly item: { readonly citation: unknown } }[],
): AgenticListMembershipV1 {
  const citationOf = new Map(items.map(entry => [entry.short, entry.item.citation]));
  const objects = new Map(lists.map(list => {
    const byObject = new Map<string, string>();
    for (const member of list.members) {
      const object = citedObject(citationOf.get(member));
      if (object !== undefined && !byObject.has(object)) byObject.set(object, member);
    }
    return [list.id, { members: new Set(list.members), byObject }] as const;
  }));
  return Object.freeze({
    in: (list: AgenticListIdV1, id: string): string | undefined => {
      const known = objects.get(list);
      if (known === undefined) return undefined;
      if (known.members.has(id)) return id;
      const object = citedObject(citationOf.get(id));
      return object === undefined ? undefined : known.byObject.get(object);
    },
  });
}

// ---- the writer -------------------------------------------------------

/** Members named across one answer; the rest are "and N more", N from the list itself (addition 5). */
export const AGENTIC_LIST_NAMED_MAX_V1 = 25;
/** Characters of a member's label in a code-written name. */
export const AGENTIC_LIST_NAME_CHARS_V1 = 120;
/** Lists the writer sees, the plan's first. */
export const AGENTIC_LIST_WRITER_LISTS_MAX_V1 = 5;
/** Members of one list the writer sees as rows; `members_omitted` counts the rest. */
export const AGENTIC_LIST_WRITER_MEMBERS_MAX_V1 = 100;

/** A list member as the writer sees it: its row facts only. It never carries text. */
export interface AgenticWriterListMemberV1 {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly dates?: EvidenceDatesV1;
  readonly date?: string;
  readonly date_kind?: EvidenceDeskDateKindV1 | "unspecified";
  readonly status?: string;
  /** A meeting action with no confirmed owner says "none recorded" (ADR-0021). */
  readonly owner?: string;
  readonly due?: string;
  /** Research read its text through an open that was not truncated and carried no notice (addition 4). */
  readonly checked: boolean;
}

/** A list as the writer sees it. */
export interface AgenticWriterListV1 {
  readonly id: AgenticListIdV1;
  readonly source: string;
  readonly filter: AgenticListFilterV1;
  readonly filter_applied: AgenticListEvidenceV1["filter_applied"];
  readonly complete: boolean;
  /** Members ECHO listed. When `complete` is false, at least this many exist. */
  readonly count: number;
  /** Members research checked, out of `count`. */
  readonly checked: number;
  readonly read_at: string;
  /** Research marked a need found on this list. */
  readonly cited_by_plan: boolean;
  /** At most AGENTIC_LIST_WRITER_MEMBERS_MAX_V1 members, in list order. */
  readonly members: readonly AgenticWriterListMemberV1[];
  /** Members past the writer's bound; present only when some were left out. */
  readonly members_omitted?: number;
}

/**
 * One member's row facts for the writer. Text is never copied, whatever the item holds. A member is titled by its list
 * label when it has one (a meeting record, named by a line of its own text), and by its label otherwise; only Ask's
 * list rows and code's statements read it.
 */
export function agenticWriterListMemberV1(entry: { readonly short: string; readonly item: EvidenceDeskItemV2 }, checked: boolean): AgenticWriterListMemberV1 {
  const { item } = entry;
  const attributes = attributesOf(item);
  return Object.freeze({
    id: entry.short, kind: item.kind, title: item.list_label ?? item.label,
    ...(item.dates === undefined ? {} : { dates: item.dates }),
    ...(item.occurred_at === undefined ? {} : { date: item.occurred_at, date_kind: item.date_kind ?? "unspecified" as const }),
    ...(attributes?.status === undefined ? {} : { status: attributes.status }),
    ...(attributes?.owner === undefined ? {} : { owner: attributes.owner }),
    ...(attributes?.due_at === undefined ? {} : { due: attributes.due_at }),
    checked,
  });
}

/**
 * A list for the writer. `members` are every member's rows in list order; the
 * checked count covers all of them, and the writer sees the first
 * `max_members` (at most AGENTIC_LIST_WRITER_MEMBERS_MAX_V1; fewer when the
 * writer's prompt has less room).
 */
export function agenticWriterListV1(list: AgenticListEvidenceV1, members: readonly AgenticWriterListMemberV1[], cited_by_plan: boolean, max_members: number = AGENTIC_LIST_WRITER_MEMBERS_MAX_V1): AgenticWriterListV1 {
  if (members.length !== list.members.length || members.some((member, index) => member.id !== list.members[index])) invalid("writer members must be the list's members, in order");
  if (!Number.isSafeInteger(max_members) || max_members < 0) invalid("max_members must be a whole, non-negative count");
  const shown = members.slice(0, Math.min(max_members, AGENTIC_LIST_WRITER_MEMBERS_MAX_V1));
  return Object.freeze({
    id: list.id, source: list.source, filter: list.filter, filter_applied: list.filter_applied, complete: list.complete,
    count: list.members.length, checked: members.filter(member => member.checked).length, read_at: list.read_at, cited_by_plan,
    members: Object.freeze(shown), ...(shown.length === members.length ? {} : { members_omitted: members.length - shown.length }),
  });
}

/** The row fields a writer may select members by: an owner or status by value, or one of a row's dates by range. */
export const AGENTIC_LIST_SELECTION_FIELDS_V1 = Object.freeze(["owner", "status", "due", "created", "updated", "received", "occurred"] as const);
/** A writer's selection (ADR-0041): members whose owner or status is `value`, or whose date of `field` is within `since` and `until`, inclusive. */
export type AgenticListSelectionV1 =
  | { readonly field: "owner" | "status"; readonly value: string }
  | { readonly field: EvidenceDateFieldV1; readonly since?: string; readonly until?: string };

/**
 * The writer's use of a list: code names its members, all of them, those
 * one row fact selects (`where`), or those `members` names by id, each with
 * every row fact it records ("who owns THERM-46"). The writer never writes
 * the names or the row facts itself.
 */
export interface AgenticAnswerListUseV1 {
  readonly id: AgenticListIdV1;
  readonly where?: AgenticListSelectionV1;
  /** Members selected by their E ids, at most AGENTIC_LIST_NAMED_MAX_V1; set instead of `where`. */
  readonly members?: readonly string[];
}

/**
 * How many members each used list names, given how many each selects:
 * round-robin in answer order, at most `budget` across the answer. Each list's
 * statement ends "and N more" with N = selected - share.
 */
export function agenticListNameSharesV1(selected: readonly number[], budget: number = AGENTIC_LIST_NAMED_MAX_V1): readonly number[] {
  if (!Number.isSafeInteger(budget) || budget < 0 || !selected.every(count => Number.isSafeInteger(count) && count >= 0)) throw new RangeError("Name shares need whole, non-negative counts");
  const shares = selected.map(() => 0);
  let left = budget;
  for (let gave = true; left > 0 && gave;) {
    gave = false;
    for (let index = 0; index < selected.length && left > 0; index += 1) {
      if (shares[index]! >= selected[index]!) continue;
      shares[index] = shares[index]! + 1; left -= 1; gave = true;
    }
  }
  return Object.freeze(shares);
}

// ---- the statement code writes ----------------------------------------

/** UTF-8 bytes of one code-written statement: the response's statement bound. */
export const AGENTIC_LIST_STATEMENT_BYTES_V1 = 4 * 1024;

const MONTHS = Object.freeze(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
/** "2026-10-04" as "October 4, 2026"; any other value unchanged. */
export function agenticCalendarDayV1(value: string): string {
  const match = CALENDAR_DAY.exec(value);
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  return match === null || month === undefined ? value : `${month} ${Number(match[3])}, ${match[1]}`;
}
/** How a date filter reads after its noun. Occurred, and a filter with no field, read as "dated". */
const DATE_WORDS: Readonly<Record<EvidenceDateFieldV1, string>> = Object.freeze({ created: "created", updated: "updated", due: "due", received: "received", occurred: "dated" });
function dateRange(since: string | undefined, until: string | undefined): string | undefined {
  if (since !== undefined && until !== undefined) {
    if (since === until) return `on ${agenticCalendarDayV1(since)}`;
    const sameYear = CALENDAR_DAY.test(since) && CALENDAR_DAY.test(until) && since.slice(0, 4) === until.slice(0, 4);
    const from = agenticCalendarDayV1(since);
    return `from ${sameYear ? from.replace(/, \d{4}$/u, "") : from} to ${agenticCalendarDayV1(until)}`;
  }
  if (since !== undefined) return `since ${agenticCalendarDayV1(since)}`;
  return until === undefined ? undefined : `through ${agenticCalendarDayV1(until)}`;
}
function joined(values: readonly string[]): string {
  return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values.at(-1)!}`;
}
/** One line, at most `chars` characters: a member's label as a statement names it. */
function line(value: string, chars: number): string {
  const text = value.normalize("NFC").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = [...text];
  return characters.length <= chars ? text : `${characters.slice(0, chars - 1).join("").trimEnd()}…`;
}

/**
 * What a list's applied filter says after its noun (ADR-0041): its channel, its
 * dates and its other fields, from the filter as applied, never the model's
 * arguments. " created on October 4, 2026", " with kind action and owner Mara".
 */
export function agenticListFilterPhraseV1(filter: AgenticListFilterV1): string {
  const fields = [
    ...(filter.kind === undefined ? [] : [`kind ${filter.kind}`]),
    ...(filter.owner === undefined ? [] : [`owner ${filter.owner}`]),
    ...(filter.status === undefined ? [] : [`status ${filter.status}`]),
  ];
  const range = dateRange(filter.since, filter.until);
  return [
    ...(filter.channel === undefined ? [] : [` in #${filter.channel}`]),
    ...(range === undefined ? [] : [` ${DATE_WORDS[filter.date_field ?? "occurred"]} ${range}`]),
    ...(fields.length === 0 ? [] : [` with ${joined(fields)}`]),
  ].join("");
}

/** A noun for a count: "1 Jira ticket", "8 Confluence pages". */
function counted(noun: AgenticListNounFormsV1, count: number): string {
  return count === 1 ? noun.singular : noun.plural;
}
/** The filter phrase after a noun: a kind filter the noun already names has no words of its own. */
function phraseAfter(noun: AgenticListNounFormsV1, filter: AgenticListFilterV1): string {
  if (noun.kind === undefined || filter.kind !== noun.kind) return agenticListFilterPhraseV1(filter);
  const { kind: _kind, ...rest } = filter;
  return agenticListFilterPhraseV1(rest);
}

/** The row facts a code-written statement names; `kind` is the member's desk kind. */
export type AgenticListNamedMemberV1 = Pick<AgenticWriterListMemberV1, "title" | "status" | "owner" | "due" | "dates" | "date" | "date_kind"> & { readonly kind?: string };

/** A row fact as names compare it: values that differ only in case or spacing are the same value. */
function same(value: string | undefined): string | undefined { return value?.trim().replace(/\s+/gu, " ").toLowerCase(); }

/**
 * Members that share a label (ignoring case and spacing) and record the same status, owner and due date are one name:
 * indexes in list order, by first member. Members whose row facts differ stay apart, so a merge never hides one: three
 * actions of one meeting due on two days are two names.
 */
function nameGroups(members: readonly AgenticListNamedMemberV1[]): readonly (readonly number[])[] {
  const groups = new Map<string, number[]>();
  members.forEach((member, index) => {
    const key = JSON.stringify([line(member.title, AGENTIC_LIST_NAME_CHARS_V1).toLowerCase(), same(member.status), same(member.owner), same(member.due)]);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return [...groups.values()];
}

/** Names for groups of `members` (nameGroups), in order. */
function groupNames(members: readonly AgenticListNamedMemberV1[], groups: readonly (readonly number[])[]): readonly string[] {
  // A group's status, owner or due date is the value all its members record (nameGroups keeps them apart otherwise).
  const common = (group: readonly number[], field: "status" | "owner" | "due") => members[group[0]!]![field];
  const differs = (field: "status" | "owner" | "due") => new Set(groups.map(group => same(common(group, field)))).size > 1;
  const show = { status: differs("status"), owner: differs("owner"), due: differs("due") };
  // Several kinds among the members: each name says which kinds it holds.
  const mixed = new Set(members.map(member => member.kind)).size > 1;
  return Object.freeze(groups.map(group => {
    const kinds = [...new Set(group.map(index => members[index]!.kind ?? ""))];
    const status = show.status ? common(group, "status") : undefined;
    const owner = show.owner ? common(group, "owner") : undefined;
    const due = show.due ? common(group, "due") : undefined;
    const details = [
      ...(group.length > 1 || mixed ? [joined(kinds.map(kind => kindNoun(kind, group.filter(index => (members[index]!.kind ?? "") === kind).length)))] : []),
      ...(status === undefined ? [] : [line(status, 60)]),
      ...(owner === undefined ? [] : [owner === "none recorded" ? "no owner recorded" : `owner ${line(owner, 80)}`]),
      ...(due === undefined ? [] : [`due ${agenticCalendarDayV1(line(due, 40))}`]),
    ];
    const label = line(members[group[0]!]!.title, AGENTIC_LIST_NAME_CHARS_V1);
    return details.length === 0 ? label : `${label} (${details.join(", ")})`;
  }));
}

/** How a member's dates read in its row facts, in this order. A due date the member's attributes record is said once. */
const FACT_DATES: readonly (readonly [EvidenceDateFieldV1, string])[] = Object.freeze([["created", "created"], ["updated", "updated"], ["occurred", "dated"], ["due", "due"], ["received", "received"]]);
const DATE_KIND_WORDS: Readonly<Partial<Record<EvidenceDeskDateKindV1, string>>> = Object.freeze({ created: "created", version_created: "version created", occurred: "dated", updated: "updated", due: "due", received: "received" });
/**
 * One member named with every row fact it records: its label, then its status, owner, due date and dates, each day
 * in the list's time zone. "PRD — System and acceptance requirements (status current, created October 4, 2026, updated
 * October 4, 2026)". A date with no stated meaning is left out.
 */
function factsName(member: AgenticListNamedMemberV1, timeZone: string | undefined): string {
  const day = (value: string) => agenticCalendarDayV1(evidenceDayV1(line(value, 40), timeZone ?? "UTC") ?? line(value, 40));
  const dated = member.dates === undefined || Object.keys(member.dates).length === 0
    ? (member.date === undefined || member.date_kind === undefined || member.date_kind === "unspecified" || DATE_KIND_WORDS[member.date_kind] === undefined
      ? [] : [`${DATE_KIND_WORDS[member.date_kind]} ${day(member.date)}`])
    : FACT_DATES.flatMap(([field, word]) => member.dates?.[field] === undefined || (field === "due" && member.due !== undefined) ? [] : [`${word} ${day(member.dates[field]!)}`]);
  const facts = [
    ...(member.status === undefined ? [] : [`status ${line(member.status, 60)}`]),
    ...(member.owner === undefined ? [] : [member.owner === "none recorded" ? "no owner recorded" : `owner ${line(member.owner, 80)}`]),
    ...(member.due === undefined ? [] : [`due ${day(member.due)}`]),
    ...dated,
  ];
  const label = line(member.title, AGENTIC_LIST_NAME_CHARS_V1);
  return facts.length === 0 ? label : `${label} (${facts.join(", ")})`;
}

/**
 * Members as a code-written statement names them: each title, cut to
 * AGENTIC_LIST_NAME_CHARS_V1 characters, then its status, owner and due date
 * wherever those differ between the named members (ignoring case). Members
 * that share a title and those row facts are one name with their kinds
 * counted ("2 actions"); members whose row facts differ are named apart, each
 * with its own. No
 * source-specific rule: a page reads by title, a ticket by key and summary, a
 * follow-up by title, a meeting record by a line of its own text and its
 * meeting (its list label).
 */
export function agenticListMemberNamesV1(members: readonly AgenticListNamedMemberV1[]): readonly string[] {
  return groupNames(members, nameGroups(members));
}

/** A member's own date of one field: its named dates, then its due date, then its one dated fact. */
function memberDate(member: AgenticListNamedMemberV1, field: EvidenceDateFieldV1): string | undefined {
  return member.dates?.[field] ?? (field === "due" ? member.due : undefined) ?? (member.date_kind === field ? member.date : undefined);
}

/**
 * Members the selection names, in list order; every member without one. An owner or status matches its value,
 * ignoring case; a date falls within the range as the desk matches a list's date filter, its day in `time_zone`. A
 * member that records no such fact is not one of them.
 */
export function agenticListSelectV1<T extends AgenticListNamedMemberV1>(members: readonly T[], where: AgenticListSelectionV1 | undefined, time_zone?: string): readonly T[] {
  if (where === undefined) return members;
  if ("value" in where) { const wanted = where.value.trim().toLowerCase(); return Object.freeze(members.filter(member => member[where.field]?.trim().toLowerCase() === wanted)); }
  return Object.freeze(members.filter(member => {
    const date = memberDate(member, where.field);
    return date !== undefined && matchesEvidenceDateV1({ [where.field]: date }, { since: where.since, until: where.until, date_field: where.field, time_zone }, where.field);
  }));
}

/** A selection as a statement says it: "have owner Dana Lee", "are due from October 18 to October 24, 2026", "were updated since October 11, 2026". */
function selectionWords(where: AgenticListSelectionV1, one: boolean): string {
  if ("value" in where) return `${one ? "has" : "have"} ${where.field} ${line(where.value, 120)}`;
  const verb = where.field === "due" || where.field === "occurred" ? (one ? "is" : "are") : (one ? "was" : "were");
  return `${verb} ${DATE_WORDS[where.field]} ${dateRange(where.since, where.until)!}`;
}

/** What one code-written statement says about a list. */
export interface AgenticListStatementInputV1 {
  /** The list's noun (agenticListMembersNounV1), or a plural ("Confluence pages") whose singular drops its "s". */
  readonly noun: string | AgenticListNounFormsV1;
  readonly filter: AgenticListFilterV1;
  /** Members ECHO listed: the list's own count, never a vendor's total (addition 5). */
  readonly count: number;
  readonly complete: boolean;
  /** The writer's selection: an owner or status `value` as the selected members record it, or a date range as given. */
  readonly where?: AgenticListSelectionV1;
  /** The writer selected `selected` by id: each is named alone, with every row fact it records. */
  readonly by_id?: boolean;
  /** The selected members, in list order: every member without a selection. */
  readonly selected: readonly AgenticListNamedMemberV1[];
  /** Members this statement may cite: the answer's share (agenticListNameSharesV1). */
  readonly share: number;
}

/**
 * The statement code writes for a list the answer uses (ADR-0041): its count,
 * its filter and its names, then "and N more" with N from the list.
 * A complete list: "8 Confluence pages created on October 4, 2026: A; B; ...".
 * A selection: "3 of the 60 Jira tickets created ... have owner Dana Lee: A; B; C",
 * or "2 of the 12 follow-ups ... are due from October 18 to October 24, 2026: ...".
 * A list that is not complete: "At least 12 Jira tickets ...". Members the
 * writer selected by id: "1 of the 8 Confluence pages created ...: PRD (status
 * current, created October 4, 2026)", each named alone with every row fact it
 * records. Otherwise members that share a label are one name
 * (agenticListMemberNamesV1). Names are taken in
 * list order while the members they cover fit `share` (the first always, citing
 * at most `share` of its members), and stop early when the statement would pass
 * AGENTIC_LIST_STATEMENT_BYTES_V1. `named` is how many of `selected` the names
 * cover, so "and N more" is `selected.length - named`; `cited` are the indexes
 * of `selected`, in order, the caller cites.
 */
export function agenticListStatementV1(input: AgenticListStatementInputV1): { readonly text: string; readonly named: number; readonly cited: readonly number[] } {
  const { count, complete, where, selected } = input;
  if (selected.length === 0 || input.share < 1) throw new RangeError("A list statement names at least one member");
  const noun = formsOf(input.noun);
  const phrase = phraseAfter(noun, input.filter);
  const k = selected.length;
  const byId = input.by_id === true;
  const lead = where !== undefined
    ? complete
      ? `${k} of the ${count} ${counted(noun, count)}${phrase} ${selectionWords(where, k === 1)}`
      : `At least ${k} ${counted(noun, k)}${phrase} ${selectionWords(where, k === 1)} (${count} listed so far)`
    : byId && k < count
      ? `${k} of ${complete ? "the" : "at least"} ${count} ${counted(noun, count)}${phrase}`
      : `${complete ? "" : "At least "}${count} ${counted(noun, count)}${phrase}`;
  const groups = byId ? selected.map((_, index) => [index]) : nameGroups(selected);
  const namesOf = (named: readonly (readonly number[])[]) => byId ? named.map(([index]) => factsName(selected[index!]!, input.filter.time_zone)) : groupNames(selected, named);
  let fit = 1;
  for (let covered = groups[0]!.length; fit < groups.length && covered + groups[fit]!.length <= input.share; fit += 1) covered += groups[fit]!.length;
  for (let shown = fit; shown >= 1; shown -= 1) {
    const named = groups.slice(0, shown);
    const covered = named.reduce((total, group) => total + group.length, 0);
    const text = `${lead}: ${namesOf(named).join("; ")}${covered < k ? `; and ${k - covered} more` : ""}.`;
    if (Buffer.byteLength(text, "utf8") <= AGENTIC_LIST_STATEMENT_BYTES_V1 || shown === 1) {
      const cited = named.flatMap(group => group).slice(0, Math.max(input.share, 1));
      return Object.freeze({ text, named: covered, cited: Object.freeze([...cited].sort((left, right) => left - right)) });
    }
  }
  throw new RangeError("unreachable");
}

/** The not_found phrase for a selection that matches no member: never a statement (ADR-0041). */
export function agenticListSelectionNotFoundV1(noun: string | AgenticListNounFormsV1, filter: AgenticListFilterV1, where: AgenticListSelectionV1): string {
  const forms = formsOf(noun);
  const condition = "value" in where ? `that have ${where.field} ${line(where.value, 120)}` : `${DATE_WORDS[where.field]} ${dateRange(where.since, where.until)!}`;
  return `${forms.plural}${phraseAfter(forms, filter)} ${condition}`;
}

/**
 * What code adds to a sentence that claims content across a list (addition 4)
 * when not every member was checked: "(4 of 8 checked so far)"; for a list not
 * read to its end, "(4 of at least 8 checked so far)". Undefined once every
 * member of a complete list was checked.
 */
export function agenticListCheckedNoteV1(list: Pick<AgenticWriterListV1, "checked" | "count" | "complete">): string | undefined {
  if (list.complete && list.checked >= list.count) return undefined;
  return `(${list.checked} of ${list.complete ? "" : "at least "}${list.count} checked so far)`;
}
