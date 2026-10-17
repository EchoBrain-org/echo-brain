import type { EvidenceDeskDateKindV1 } from "../shared/evidence-desk-v1.js";
import type { EvidenceDeskItemV2 } from "../shared/evidence-desk-v2.js";
import type { EvidenceDateFieldV1, EvidenceDatesV1 } from "../shared/temporal-query-v1.js";
import { attributesOf } from "./agentic-evidence-bundle-v1.js";

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

// ---- support kinds ----------------------------------------------------

/** What can support a found need. A list gives list facts; an item read in full gives content. */
export const AGENTIC_SUPPORT_KINDS_V1 = Object.freeze(["list_fact", "content"] as const);
export type AgenticSupportKindV1 = (typeof AGENTIC_SUPPORT_KINDS_V1)[number];

/** The facts a list supports: which items exist, and each member's row facts. Never what a member says. */
export const AGENTIC_LIST_FACTS_V1 = Object.freeze(["membership", "title", "dates", "status", "owner"] as const);
export type AgenticListFactV1 = (typeof AGENTIC_LIST_FACTS_V1)[number];

/** How one found need's cited ids divide into support. */
export interface AgenticNeedSupportV1 {
  /** Lists cited by id, then the list of each cited member row (a member research never read in full), each once. List facts. */
  readonly lists: readonly AgenticListIdV1[];
  /** Cited items research read in full. Content. */
  readonly content: readonly string[];
  /** Cited ids that support nothing: an unknown list, or an item neither read in full nor a list member. */
  readonly unsupported: readonly string[];
}

/** What the request knows about a cited id. */
export interface AgenticNeedSupportLookupV1 {
  /** A list with this id was read in this request. */
  readonly list: (id: AgenticListIdV1) => boolean;
  /** Research read this item's complete released text. */
  readonly full: (id: string) => boolean;
  /** The first list, in id order, whose members include this item. */
  readonly list_of: (id: string) => AgenticListIdV1 | undefined;
}

/**
 * Divides a found need's evidence (ADR-0041). The finish check then refuses a
 * need whose lists can still be read further ("keep reading the list"), and a
 * need with no list and no content (today's rule for content needs).
 */
export function agenticNeedSupportV1(evidence: readonly string[], lookup: AgenticNeedSupportLookupV1): AgenticNeedSupportV1 {
  const lists: AgenticListIdV1[] = []; const content: string[] = []; const unsupported: string[] = [];
  const add = <T>(values: T[], value: T) => { if (!values.includes(value)) values.push(value); };
  for (const id of evidence) {
    const list = parseAgenticListIdV1(id);
    if (list !== null) { if (lookup.list(list)) add(lists, list); else add(unsupported, id); continue; }
    if (lookup.full(id)) { add(content, id); continue; }
    const member = lookup.list_of(id);
    if (member !== undefined) add(lists, member); else add(unsupported, id);
  }
  return Object.freeze({ lists: Object.freeze(lists), content: Object.freeze(content), unsupported: Object.freeze(unsupported) });
}

/** The kinds of support a need has. */
export function agenticSupportKindsV1(support: AgenticNeedSupportV1): readonly AgenticSupportKindV1[] {
  return Object.freeze([...(support.lists.length > 0 ? ["list_fact" as const] : []), ...(support.content.length > 0 ? ["content" as const] : [])]);
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

/** One member's row facts for the writer. Text is never copied, whatever the item holds. */
export function agenticWriterListMemberV1(entry: { readonly short: string; readonly item: EvidenceDeskItemV2 }, checked: boolean): AgenticWriterListMemberV1 {
  const { item } = entry;
  const attributes = attributesOf(item);
  return Object.freeze({
    id: entry.short, kind: item.kind, title: item.label,
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
 * AGENTIC_LIST_WRITER_MEMBERS_MAX_V1.
 */
export function agenticWriterListV1(list: AgenticListEvidenceV1, members: readonly AgenticWriterListMemberV1[], cited_by_plan: boolean): AgenticWriterListV1 {
  if (members.length !== list.members.length || members.some((member, index) => member.id !== list.members[index])) invalid("writer members must be the list's members, in order");
  const shown = members.slice(0, AGENTIC_LIST_WRITER_MEMBERS_MAX_V1);
  return Object.freeze({
    id: list.id, source: list.source, filter: list.filter, filter_applied: list.filter_applied, complete: list.complete,
    count: list.members.length, checked: members.filter(member => member.checked).length, read_at: list.read_at, cited_by_plan,
    members: Object.freeze(shown), ...(shown.length === members.length ? {} : { members_omitted: members.length - shown.length }),
  });
}

/** The row fields a writer may select members by. */
export const AGENTIC_LIST_SELECTION_FIELDS_V1 = Object.freeze(["owner", "status"] as const);

/**
 * The writer's use of a list: code names its members, all of them or those
 * whose row field equals `value` (ignoring case). The writer never writes the
 * names itself.
 */
export interface AgenticAnswerListUseV1 {
  readonly id: AgenticListIdV1;
  readonly where?: { readonly field: (typeof AGENTIC_LIST_SELECTION_FIELDS_V1)[number]; readonly value: string };
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
