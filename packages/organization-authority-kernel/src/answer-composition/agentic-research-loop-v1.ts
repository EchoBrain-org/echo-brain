import { calendarDateV1, EVIDENCE_ANY_DATE_V1, evidenceDateFilterV1, matchedEvidenceDatesV1, validateEvidenceDateFilterV1, type EvidenceDateFilterV1, type EvidenceDateFieldV1, type EvidenceDateSelectionV1 } from "../shared/temporal-query-v1.js";
import { askQuestionCompletionProblemsV1, askResearchCompletionProblemsV1, type AskResearchListV1, type AskResearchObservationV1 } from './agentic-ask-research-state-v1.js';
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  evidenceDeskSourceV2,
  type EvidenceDeskItemV2,
  type EvidenceDeskKindV2,
  type EvidenceDeskListInputV2,
  type EvidenceDeskPortV2,
  type EvidenceDeskResultV2,
  type EvidenceDeskSourceV2,
  type EvidenceDeskUncheckedV1,
  type EvidenceSourceCapabilitiesV1,
} from "../shared/evidence-desk-v2.js";
import { followUpOwnerMatchesV1 } from "../shared/follow-up-evidence-v1.js";
import {
  AGENTIC_ASK_LIST_LIMIT_MAX_V1,
  AGENTIC_ASK_MAX_ACTIONS_PER_STEP_V1,
  AGENTIC_ASK_MAX_NEEDS_PER_PART_V1,
  AgenticAskOutputErrorV1,
  cleanId,
  cleanLine,
  createStepSchema,
  normalizeQuery,
  parseStep,
  partQuestion,
  type NeedStatus,
  type Step,
  type StepAction,
  type StepArgs,
  type StepNeed,
  type StepPart,
  type StepSource,
} from "./agentic-ask-v1-model-protocol.js";
import { fillAgenticTaskV1, type AgenticBriefV1 } from "./agentic-brief-v1.js";
import { describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "./agentic-evidence-bundle-v1.js";
import {
  agenticCitedObjectV1,
  agenticListEndUnverifiedV1,
  agenticListIdV1,
  agenticListMembershipV1,
  createAgenticListEvidenceV1,
  type AgenticListEvidenceV1,
  type AgenticListFilterApplicationV1,
  type AgenticListFilterFieldV1,
  type AgenticListFilterV1,
  type AgenticListIdV1,
} from "./agentic-list-evidence-v1.js";
import type { AgenticResearchProgressReporterV1 } from "./agentic-ask-progress-recorder-v1.js";
import {
  AGENTIC_ASK_FINALIZE_RESERVE_MS_V1,
  AGENTIC_ASK_MIN_STEP_MS_V1,
  AgenticAskPostRevalidationNoTimeErrorV1,
  isAbort,
  object,
  raceAbort,
  type AgenticAskModelRoleV1,
  type AgenticModelCallV1,
  type AgenticModelGateV1,
  type CreateAgenticModelGateV1Options,
} from "./agentic-model-gate-v1.js";
import type {
  AgenticResearchActionV1,
  AgenticResearchAdmissionV1,
  AgenticResearchGoalV1,
  AgenticResearchNeedKindV1,
  AgenticResearchPartV1,
  AgenticResearchRoundV1,
} from "./agentic-research-v1.js";
import { AuthorityOperationError } from "../domain/errors.js";
import { observeCoreRuntimeDiagnosticV1, withCoreRuntimeDiagnosticToolV1 } from '../shared/core-runtime-observation-v1.js';
import { coreRuntimeDiagnosticErrorKindV1 } from '../shared/core-runtime-diagnostics-v1.js';
import { observeAgenticLifecycleV1 } from './agentic-diagnostics-v1.js';

/**
 * The research loop (research trigger contract v1): a brief in, the full
 * evidence bundle out. Starting evidence is read fresh through the
 * access-checked desk, then planner
 * rounds over three read tools (search, open, list) plus `finish` until a stop
 * rule fires; a brief with no planner stops after its starting reads. It
 * never answers, renders or releases, never learns which
 * trigger wrote its brief, and reaches the model only through the request's
 * gate. The model plans parts and the needs of each part; code owns ids,
 * paging, de-duplication and the stop rules.
 */

/** One research step's model call; a stalled host fails fast and research goes on. */
const STEP_TIMEOUT_MS = 25_000;
/**
 * A step starts only with this many times the longest step call so far (or a whole step's time): 2233bad1 started its
 * last step with 7.54 s after 6 to 8 s steps, timed out, and reported an unusable step instead of a budget stop.
 */
const STEP_TIME_MARGIN = 1.25;
const SEARCH_LIMIT = 8;
const LIST_PAGE = 25;
const LIST_FETCH = 50;
const PREVIEW_CHARS = 240;
/** Complete released packets admitted directly from search/list; larger bodies require open. */
const PASSAGE_BYTES = 3 * 1024;
/** Context items an `open` may admit beyond its anchor (a Slack thread returns up to 20 replies). */
const OPEN_EXTRA_ITEMS = 20;
/** Document passages on each side of an opened passage (desk maximum). */
const OPEN_NEIGHBOURS = 2;
const OPEN_BYTES = 24 * 1024;
/** Starting reads in flight at once: as many as one planner step's reads, so a sweep of many items never floods a source. */
const STARTING_READS_AT_ONCE = AGENTIC_ASK_MAX_ACTIONS_PER_STEP_V1;
const MAX_SEEN_ENTRIES = 300;
/** What a search-only brief's planner is told when it proposes list. */
const LIST_UNAVAILABLE = "list is unavailable in this run; use search and open";

/** One source research can read: the selector the model uses, the desk kinds behind it, and its list options. */
export interface AgenticResearchSourceV1 {
  readonly source_id: string;
  readonly selector: string;
  readonly kinds: readonly EvidenceDeskKindV2[];
  readonly description: string;
  readonly metadata_only_list?: boolean;
  readonly tool_id?: string;
  readonly requires_channel?: boolean;
  readonly default_since_days?: number;
  /** What the source can do (research tool contract v1); Ask checks each read against it before the desk. */
  readonly capabilities?: EvidenceSourceCapabilitiesV1;
}

/** One source as the research model sees it in `source_catalog`: its selector and capabilities, never its desk id or kinds. */
export type AgenticResearchCatalogEntryV1 = {
  readonly description: string;
  readonly metadata_only_list?: boolean;
  readonly tool_id?: string;
  readonly requires_channel?: boolean;
  readonly default_since_days?: number;
  /** Shown to Ask only; a task goal's catalog leaves it out, so its prompt is unchanged. */
  readonly capabilities?: EvidenceSourceCapabilitiesV1;
  readonly source: StepSource;
};

/** The sources research can read: as the model sees them, by id, and how a model's source name resolves to an id. */
export interface AgenticResearchCatalogV1 {
  readonly entries: readonly AgenticResearchCatalogEntryV1[];
  readonly by_id: ReadonlyMap<string, AgenticResearchSourceV1>;
  readonly resolve: (value: string | undefined) => string | undefined;
}

export interface CreateAgenticResearchLoopV1Options {
  /** The request's access-checked desk; it binds the person and the scope. */
  readonly desk: EvidenceDeskPortV2;
  /** What to research: the goal, starting evidence, budget and options. */
  readonly brief: AgenticBriefV1;
  /** The research step's system prompt, and the scratchpad bytes that fit beside it. */
  readonly prompt: string;
  readonly prompt_budget: number;
  /** The runtime span research steps run in; the audit records them as `step` calls. */
  readonly step_span: AgenticModelCallV1["span"];
  /** Who is asking and today's date (also the base for relative list dates). */
  readonly context: { readonly asked_by?: string; readonly today: string; readonly now?: string; readonly time_zone?: string; readonly time_reference?: string };
  /** What the model is told the desk reads. */
  readonly scope: string;
  readonly catalog: AgenticResearchCatalogV1;
  readonly now: () => number;
  /** Milliseconds left before the request deadline. */
  readonly remaining: () => number;
  /** The request's signal: aborted exactly when the caller cancelled or the deadline passed. */
  readonly signal: AbortSignal;
  /** Throws when the caller cancelled or the request deadline passed. */
  readonly assert_live: () => void;
  /** The runner's own observation, read when the bundle is built: the last access check, and research's model and desk time. */
  readonly observed: () => { readonly checked_at: string | null; readonly model_ms: number; readonly desk_ms: number };
  /** A streamed Ask's progress (ADR-0039): told what research reads and, after each step's access check, what it reads in full. */
  readonly report?: AgenticResearchProgressReporterV1;
  /** Wall-clock epoch milliseconds, for when a list's first page was read (ADR-0041). Defaults to `Date.now`; tests pin it. */
  readonly wall_now?: () => number;
}

/** What the request's audit and journey report read from research, while it runs and after it fails. */
export interface AgenticResearchProgressV1 {
  /** Every released item's receipt, in release order. */
  readonly receipts: readonly Sha256Digest[];
  /** Research steps run. */
  readonly rounds: number;
  /** Research steps that could not be used (they stop research). */
  readonly fallbacks: number;
  readonly searches: number;
  readonly search_hits: number;
  /** Distinct ticket items any read returned. */
  readonly retrieved_tickets: number;
  /** Ask (research tool contract v1): reads refused before or at the desk, refused reads sent again and answered from memory, items a date filter could not test, sources searched or listed, and the most reads one step made. */
  readonly refused_reads: number;
  readonly repeated_refusals: number;
  readonly unchecked_items: number;
  readonly sources_looked_at: number;
  readonly most_reads_in_a_step: number;
}

export interface AgenticResearchLoopV1 {
  /** An admitted step call reads its scratchpad in full. */
  readonly gate_hooks: Pick<CreateAgenticModelGateV1Options, "before_call">;
  progress(): AgenticResearchProgressV1;
  /** Runs research once, calling the model only through `gate`, and returns everything it gathered. The runner adds the trigger's name. */
  run(gate: AgenticModelGateV1): Promise<Omit<AgenticEvidenceBundleV1, "trigger">>;
}

/** One scratchpad entry. `short` is the only id a model ever sees. */
type Entry = {
  readonly short: string;
  item: EvidenceDeskItemV2;
  /** Research read this item's complete released text: a planner step was shown it, or, with no planner, it was starting evidence read in full. */
  full: boolean;
  /** Opened explicitly (or preloaded); full text stays in the prompt while budget allows. */
  opened: boolean;
  /** Loaded before round 1: starting evidence. */
  preloaded?: boolean;
  /**
   * A read returned this item itself: a search or list row, an open's anchor, or a starting or preloaded item. A
   * neighbour or continuation an open admitted beside its anchor is not. Only such an item counts as read for progress.
   */
  direct?: boolean;
  touched: number;
  /** The latest search that returned this item; its preview shows where that search matched. */
  query?: string;
  /** A research step admitted after its access check showed it, under opened or seen: a list member counts once shown (ADR-0041). */
  shown?: boolean;
  /** Which of its dates fell in the window of the dated read that returned it (research tool contract v1). */
  matched?: readonly EvidenceDateFieldV1[];
};
type ToolResult = Readonly<Record<string, unknown>>;
/** A completed desk read waits here until earlier planned reads have updated state. */
type OrderedAdmission = (apply: () => ToolResult) => Promise<ToolResult>;
/**
 * Code-owned plan state. A need leaves the plan only by being marked found or not_found. Its id (N1, N2, ...) never
 * changes, so a step can reword a need and still settle it; its wording stays the one first planned.
 */
type NeedState = { readonly id: string; readonly need: string; kind?: AgenticResearchNeedKindV1; status: NeedStatus; evidence: readonly string[]; readonly observations_before: number };
type PartState = { readonly question: string; notes: string; readonly needs: NeedState[] };
/** How the list applied each filter field the model asked for (ADR-0041). */
type FilterApplication = Partial<Record<AgenticListFilterFieldV1, AgenticListFilterApplicationV1>>;
/**
 * One inventory: a normalized selection of one source and what it has fetched and paged out. A question goal (Ask)
 * keeps it as list evidence (ADR-0041): its id, once its first page is read; its members, the entries it paged out,
 * each once in list order; and the filter as applied.
 */
type ListState = {
  args: StepArgs; readonly source: EvidenceDeskSourceV2; readonly unfiltered: boolean; items: EvidenceDeskItemV2[]; cursor: string | undefined; fetched: boolean;
  /** Fetched items paged out to research so far. */
  paged: number;
  truncated: boolean; available: boolean; note?: string;
  id?: AgenticListIdV1;
  readonly members: Entry[];
  readonly filter: AgenticListFilterV1;
  readonly filter_applied: FilterApplication;
  /** Notes on requested filters this source cannot apply, kept for every later view of the list. */
  readonly filter_notes: string[];
  /** The latest page had no next link but was exactly full (addition 1). */
  unverified_end: boolean;
  /** When the desk returned its first page (addition 2). */
  read_at?: string;
  /** Items the date filter could not test (research tool contract v1), as the desk last counted them. */
  unchecked?: EvidenceDeskUncheckedV1 & { readonly any_of?: readonly ("owner" | "status")[] };
  /** Items the desk released beside its rows, by desk id, each shown with the first page whose members link to it. */
  linked?: Map<string, EvidenceDeskItemV2>;
};
/** An inventory has more to show: listed items not yet shown, or another page. */
function inventoryMore(state: ListState): boolean { return state.paged < state.items.length || state.cursor !== undefined; }
/** Identity of a cited object independent of the version or text released this time. */
function citationIdentity(value: unknown): string {
  const citation = object(value) ?? {};
  const pick = ["kind", "tool_id", "atom_id", "item_id", "ticket_id", "page_id", "document_id", "upload_id", "transcript_id", "channel_id", "message_ts"].filter(key => typeof citation[key] === "string");
  return JSON.stringify(pick.map(key => [key, citation[key]]));
}
/** Desk refusals a model can cause (a stale id, an invalid request) become tool results, not failures. */
function toolRefusal(error: unknown): string | null {
  const value = object(error);
  if (value?.name !== "AuthorityOperationError") return null;
  if (value.code === "not_found") return "that item is not available";
  if (value.code === "invalid_request") return typeof value.message === "string" && value.message.length <= 200 ? value.message : "that request is not valid";
  return null;
}
/** The desk says the person cannot read this item now: deleted, or no longer visible to them. */
function unreadableRefusal(error: unknown): boolean {
  const value = object(error);
  return value?.name === "AuthorityOperationError" && (value.code === "not_found" || value.code === "unauthorized");
}
function bytes(value: string | undefined): number { return value === undefined ? 0 : Buffer.byteLength(value, "utf8"); }
function preview(text: string): string { return cleanLine(text, PREVIEW_CHARS); }
/** Characters a query preview keeps before its first matched word. */
const PREVIEW_LEAD_CHARS = 60;
/**
 * A search hit's preview: the window where the query's words cluster, not
 * only the item's head, so a long transcript or document shows why it matched
 * ("… Jules: I will publish the dashboard by September 11 …"). Words match at
 * a word start, ignoring case; the head wins ties, and with no match the
 * preview is the head.
 */
function queryPreview(text: string, query: string | undefined): string {
  const head = preview(text);
  if (query === undefined) return head;
  const line = cleanLine(text, Number.MAX_SAFE_INTEGER);
  // Terms are letters and digits only, so they need no escaping.
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => [...term].length >= 3))].slice(0, 32);
  const hits: { readonly at: number; readonly term: number }[] = [];
  terms.forEach((term, index) => {
    for (const match of line.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${term}`, "giu"))) hits.push({ at: match.index, term: index });
  });
  const width = PREVIEW_CHARS - 1;
  const matched = (start: number) => new Set(hits.filter(hit => hit.at >= start && hit.at < start + width).map(hit => hit.term)).size;
  let best = { start: 0, first: 0, count: matched(0) };
  for (const hit of [...hits].sort((left, right) => left.at - right.at)) {
    const start = Math.max(0, hit.at - PREVIEW_LEAD_CHARS);
    const count = matched(start);
    if (count > best.count) best = { start, first: hit.at, count };
  }
  if (best.start === 0) return head;
  // Begin at a whole word: skip the word the lead cut into.
  const space = line.indexOf(" ", best.start);
  const start = line[best.start - 1] === " " ? best.start : space >= 0 && space < best.first ? space + 1 : best.first;
  return cleanLine(`…${line.slice(start)}`, PREVIEW_CHARS);
}
function needKey(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

// ---- list argument normalization (named fields, loose forms) --------------
const MEETING_KINDS: Readonly<Record<string, EvidenceDeskKindV2>> = Object.freeze({
  decision: "decision", decisions: "decision", action: "action", actions: "action", task: "action", tasks: "action", rationale: "rationale", rationales: "rationale", reason: "rationale",
});
function statusGroup(value: string): "open" | "done" | null {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  if (["done", "complete", "completed", "closed", "finished", "resolved"].includes(normalized)) return "done";
  if (["open", "pending", "todo", "to do", "in progress", "active", "not started", "blocked"].includes(normalized)) return "open";
  return null;
}
function isoDay(value: Date): string { return value.toISOString().slice(0, 10); }
/** Legacy structured tool ages remain accepted; natural-language questions are interpreted only by the model. */
function listDate(value: string, today: string): string | null {
  const text = value.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) { try { return calendarDateV1(text); } catch { return null; } }
  const relative = /^(\d{1,3})\s*(d|day|days|w|wk|week|weeks|m|mo|month|months)$/u.exec(text);
  if (relative === null) return null;
  const amount = Number(relative[1]);
  const unit = relative[2]!.startsWith("w") ? 7 : relative[2]!.startsWith("m") ? 30 : 1;
  const base = new Date(`${today}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - amount * unit);
  return isoDay(base);
}
/**
 * A list request after normalization. `applied` says how the selection applies each filter field the model asked for
 * (ADR-0041): a field this source cannot apply is `ignored`, with a note, and absent from the selection. `limit` is how
 * many rows this one call pages out (research tool contract v1); it never starts another list.
 */
type ListArgs = EvidenceDateFilterV1 & {
  readonly source: EvidenceDeskSourceV2; readonly kinds?: readonly EvidenceDeskKindV2[]; readonly status?: "open" | "done" | "active" | "archived"; readonly owner?: string;
  readonly role?: "lead" | "member"; readonly channel?: string; readonly since?: string; readonly until?: string; readonly limit?: number;
  readonly notes: readonly string[]; readonly applied: FilterApplication;
};
/**
 * A read Ask refused before the desk, because the source's capabilities do not take it (research tool contract v1). It
 * is a result, never an error: nothing was read, and `supports` says what the source does take.
 */
type ReadRefusal = { readonly refused: { readonly field: AgenticListFilterFieldV1; readonly reason: string; readonly supports: Readonly<Record<string, unknown>> } };
/** Two copies' links, each name's ids once, in the order first seen. */
function linksUnion(left: EvidenceDeskItemV2["links"], right: EvidenceDeskItemV2["links"]): EvidenceDeskItemV2["links"] {
  if (left === undefined || right === undefined) return left ?? right;
  const union: Record<string, readonly string[]> = { ...left };
  for (const [name, ids] of Object.entries(right)) union[name] = Object.freeze([...new Set([...(union[name] ?? []), ...ids])]);
  return Object.freeze(union);
}
/** What a refusal shows of a source's capabilities. */
function supportsOf(capabilities: EvidenceSourceCapabilitiesV1): Readonly<Record<string, unknown>> {
  return Object.freeze({ filters: capabilities.filters, dates: Object.keys(capabilities.dates), any_date: capabilities.any_date });
}
/** A read refused for one field, naming its source and what the source does take. */
function readRefusal(source: AgenticResearchSourceV1, capabilities: EvidenceSourceCapabilitiesV1, field: AgenticListFilterFieldV1, reason: string): ReadRefusal {
  return { refused: Object.freeze({ field, reason: `${source.selector}: ${reason}`, supports: supportsOf(capabilities) }) };
}
/**
 * The dates a search or list asks of a source its capabilities do not take: a date field it does not record, or a window
 * when it records no dates. `askedField` is the read's date_field, "any" already read as none where the source takes any.
 */
function dateRefusal(source: AgenticResearchSourceV1, capabilities: EvidenceSourceCapabilitiesV1, askedField: string | undefined, args: StepArgs): ReadRefusal | undefined {
  const declared = Object.keys(capabilities.dates);
  const none = "it records no dates to filter by";
  if (askedField !== undefined) return declared.includes(askedField) ? undefined : readRefusal(source, capabilities, "date_field", declared.length === 0 ? none : `date_field must be ${declared.join(", ")}`);
  return (args.since !== undefined || args.until !== undefined) && declared.length === 0 ? readRefusal(source, capabilities, args.since !== undefined ? "since" : "until", none) : undefined;
}
/** A refused read's result, for search and list alike. */
function refusedResult(tool: "search" | "list", args: StepArgs, { refused: { field, reason, supports } }: ReadRefusal): ToolResult {
  return { tool, args, refused: true, filters: { [field]: "refused" }, supports, note: `refused: ${reason}` };
}
/** One inventory per normalized selection: notes and ignored filters never start another, owner matching ignores case, and a limit is one call's page. */
function listKey({ notes: _notes, applied: _applied, limit: _limit, status, owner, ...request }: ListArgs): string {
  return JSON.stringify({ ...request, status: status ?? null, owner: owner?.toLowerCase() ?? null });
}
function normalizeListArgs(raw: StepArgs, today: string, sources: ReadonlyMap<string, AgenticResearchSourceV1>, readSource: (value: string | undefined) => string | undefined, ask = false): ListArgs | ReadRefusal | { readonly error: string } {
  const source = readSource(raw.source);
  if (source === undefined) return { error: `source must be ${[...sources.values()].map(value => value.selector).join(", ")}` };
  const descriptor = sources.get(source)!;
  if (ask && descriptor.capabilities !== undefined) return normalizeAskListArgs(raw, today, descriptor, descriptor.capabilities);
  // owner and status filter meeting actions here, after each page.
  const notes: string[] = [];
  const applied: FilterApplication = {};
  let kinds: EvidenceDeskKindV2[] | undefined;
  if (raw.kind !== undefined) {
    const kind = MEETING_KINDS[raw.kind.trim().toLowerCase()];
    if (source !== "meeting") { notes.push("kind applies to meetings only; ignored"); applied.kind = "ignored"; }
    else if (kind === undefined) return { error: "kind must be \"decision\", \"action\" or \"rationale\"" };
    else { kinds = [kind]; applied.kind = "applied"; }
  }
  let status: "open" | "done" | undefined;
  if (raw.status !== undefined) {
    const group = statusGroup(raw.status);
    if (source !== "meeting") { notes.push("status applies to meeting actions only; ignored"); applied.status = "ignored"; }
    else if (group === null) return { error: "status must be \"open\" or \"done\"" };
    else { status = group; applied.status = "applied"; kinds ??= ["action"]; }
  }
  let owner: string | undefined;
  if (raw.owner !== undefined) {
    const name = raw.owner.trim().replace(/^@/u, "").trim();
    if (source !== "meeting") { notes.push("owner applies to meeting actions only; ignored"); applied.owner = "ignored"; }
    else if (name.length === 0 || name.length > 80) return { error: "owner must be a person's name such as \"Dana\"" };
    else { owner = name; applied.owner = "applied"; kinds ??= ["action"]; }
  }
  let channel: string | undefined;
  if (raw.channel !== undefined) {
    const name = raw.channel.trim().replace(/^#/u, "").trim();
    if (!descriptor.requires_channel) { notes.push("channel is unsupported by this source; ignored"); applied.channel = "ignored"; }
    else if (name.length === 0 || name.length > 80) return { error: "channel must be a channel name such as \"hw-dvt\"" };
    else { channel = name; applied.channel = "applied"; }
  }
  if (descriptor.requires_channel && channel === undefined) return { error: `${descriptor.selector} needs a channel, such as ${JSON.stringify({ source: descriptor.selector, channel: "hw-dvt" })}` };
  const since = raw.since === undefined ? undefined : listDate(raw.since, today);
  const until = raw.until === undefined ? undefined : listDate(raw.until, today);
  if ((raw.since !== undefined && since === null) || (raw.until !== undefined && until === null)) return { error: "since and until take a date like 2026-09-21 or an age like 7d or 2w" };
  try { validateEvidenceDateFilterV1({ since: since ?? undefined, until: until ?? undefined, date_field: raw.date_field as EvidenceDateFieldV1 | undefined }); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Invalid date filter' }; }
  const defaultSince = descriptor.default_since_days !== undefined && since === undefined ? listDate(`${descriptor.default_since_days}d`, today)! : since ?? undefined;
  // Dates are applied or refused: a source that cannot apply a date field refuses the read, never widens it. A default
  // since the catalog declares is in the selection but was not asked for.
  if (since !== undefined && since !== null) applied.since = "applied";
  if (until !== undefined && until !== null) applied.until = "applied";
  if (raw.date_field !== undefined) applied.date_field = "applied";
  return {
    source, notes, applied, ...(raw.date_field === undefined ? {} : { date_field: raw.date_field as EvidenceDateFieldV1 }),
    ...(kinds === undefined ? {} : { kinds }), ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }), ...(channel === undefined ? {} : { channel }),
    ...(defaultSince === undefined ? {} : { since: defaultSince }), ...(until === undefined || until === null ? {} : { until }),
  };
}

/**
 * Ask's list arguments against the source's capabilities (research tool contract v1). A filter the source does not take
 * is ignored, with a note, as ADR-0041 ignores it; a value outside the source's allowed values, or a date it does not
 * record, refuses the read, which never widens it. A window with no date field matches any of an item's dates where the
 * source declares `any_date`; otherwise the source's own default date reads it.
 */
function normalizeAskListArgs(raw: StepArgs, today: string, descriptor: AgenticResearchSourceV1, capabilities: EvidenceSourceCapabilitiesV1): ListArgs | ReadRefusal | { readonly error: string } {
  const notes: string[] = [];
  const applied: FilterApplication = {};
  const ignore = (field: AgenticListFilterFieldV1) => { notes.push(`${descriptor.selector} takes no ${field}; ignored`); applied[field] = "ignored"; };
  /** A filter whose values the source lists: ignored where it takes none, refused outside its values, otherwise applied. */
  const listed = (field: "kind" | "status" | "role", value: string | undefined, join: string): string | ReadRefusal | undefined => {
    if (value === undefined) return undefined;
    const allowed = capabilities.filters[field];
    if (allowed === undefined) { ignore(field); return undefined; }
    if (!Array.isArray(allowed) || !allowed.includes(value)) return readRefusal(descriptor, capabilities, field, `${field} must be ${Array.isArray(allowed) ? allowed.join(join) : `a ${field} it lists`}`);
    applied[field] = "applied";
    return value;
  };
  const meeting = descriptor.source_id === "meeting";
  const kind = listed("kind", raw.kind === undefined ? undefined : MEETING_KINDS[raw.kind.trim().toLowerCase()] ?? raw.kind.trim().toLowerCase(), ", ");
  if (typeof kind === "object") return kind;
  let kinds: EvidenceDeskKindV2[] | undefined = kind === undefined ? undefined : [kind as EvidenceDeskKindV2];
  // A source's own value wins ("active" is a project's status); otherwise a loose word reads as open or done.
  const literal = raw.status?.trim().toLowerCase();
  const statuses = capabilities.filters.status;
  const status = listed("status", literal === undefined || (Array.isArray(statuses) && statuses.includes(literal)) ? literal : statusGroup(literal) ?? literal, " or ");
  if (typeof status === "object") return status;
  if (status !== undefined && meeting) kinds ??= ["action"];
  let owner: string | undefined;
  if (raw.owner !== undefined) {
    const name = raw.owner.trim().replace(/^@/u, "").trim();
    if (capabilities.filters.owner === undefined) ignore("owner");
    else if (name.length === 0 || name.length > 80) return { error: "owner must be a person's name such as \"Dana\"" };
    else { owner = name; applied.owner = "applied"; if (meeting) kinds ??= ["action"]; }
  }
  const role = listed("role", raw.role?.trim().toLowerCase(), " or ");
  if (typeof role === "object") return role;
  let channel: string | undefined;
  if (raw.channel !== undefined) {
    const name = raw.channel.trim().replace(/^#/u, "").trim();
    if (!descriptor.requires_channel && capabilities.filters.channel === undefined) ignore("channel");
    else if (name.length === 0 || name.length > 80) return { error: "channel must be a channel name such as \"hw-dvt\"" };
    else { channel = name; applied.channel = "applied"; }
  }
  if (descriptor.requires_channel && channel === undefined) return { error: `${descriptor.selector} needs a channel, such as ${JSON.stringify({ source: descriptor.selector, channel: "hw-dvt" })}` };
  const since = raw.since === undefined ? undefined : listDate(raw.since, today);
  const until = raw.until === undefined ? undefined : listDate(raw.until, today);
  if ((raw.since !== undefined && since === null) || (raw.until !== undefined && until === null)) return { error: "since and until take a date like 2026-09-21" };
  try { validateEvidenceDateFilterV1({ since: since ?? undefined, until: until ?? undefined }); }
  catch (error) { return { error: error instanceof Error ? error.message : 'Invalid date filter' }; }
  // "any" is what leaving date_field out means where the source reads any of its dates: the same request.
  const askedField = raw.date_field === EVIDENCE_ANY_DATE_V1 && capabilities.any_date ? undefined : raw.date_field;
  const refusedDate = dateRefusal(descriptor, capabilities, askedField, raw);
  if (refusedDate !== undefined) return refusedDate;
  const dateField: EvidenceDateSelectionV1 | undefined = askedField !== undefined ? askedField as EvidenceDateFieldV1 : (since != null || until != null) && capabilities.any_date ? EVIDENCE_ANY_DATE_V1 : undefined;
  let limit: number | undefined;
  if (raw.limit !== undefined) {
    limit = Number(raw.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENTIC_ASK_LIST_LIMIT_MAX_V1) return { error: `limit must be a whole number from 1 to ${AGENTIC_ASK_LIST_LIMIT_MAX_V1}` };
  }
  const defaultSince = descriptor.default_since_days !== undefined && since === undefined ? listDate(`${descriptor.default_since_days}d`, today)! : since ?? undefined;
  if (since != null) applied.since = "applied";
  if (until != null) applied.until = "applied";
  if (askedField !== undefined) applied.date_field = "applied";
  return {
    source: descriptor.source_id, notes, applied, ...(dateField === undefined ? {} : { date_field: dateField }),
    ...(kinds === undefined ? {} : { kinds }), ...(status === undefined ? {} : { status: status as ListArgs["status"] }), ...(owner === undefined ? {} : { owner }),
    ...(role === undefined ? {} : { role: role as ListArgs["role"] }), ...(channel === undefined ? {} : { channel }), ...(defaultSince === undefined ? {} : { since: defaultSince }),
    ...(until === undefined || until === null ? {} : { until }), ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * One request's research. Its state lives here; the runner reads it only
 * through `progress()` and the bundle `run` returns.
 */
export function createAgenticResearchLoopV1(options: CreateAgenticResearchLoopV1Options): AgenticResearchLoopV1 {
  const { desk, brief, context, scope, now, remaining, assert_live: assertLive, signal: activeSignal, report } = options;
  const { prompt: researchPrompt, prompt_budget: researchBudget } = options;
  const { by_id: sourcesById, resolve: readSource } = options.catalog;
  /** A search-only brief has no list tool, and its catalog shows nothing only list uses. */
  const listAvailable = brief.options.list !== false;
  /** A question goal (Ask) keeps every list it reads as evidence of which items exist (ADR-0041); a task goal does not. */
  const ask = brief.goal.kind === "question";
  // Only Ask is shown sources' capabilities (research tool contract v1). A task goal's catalog says a connected tool's date
  // fields in its description, as the tool's description did before its capabilities said them; nothing else changes.
  const askedCatalog = ask ? options.catalog.entries : options.catalog.entries.map(({ capabilities, ...entry }) => {
    const dates = entry.tool_id === undefined || capabilities === undefined ? [] : Object.keys(capabilities.dates);
    return Object.freeze(dates.length === 0 ? entry : { ...entry, description: `${entry.description} Date filters support date_field ${dates.length === 1 ? dates[0] : `${dates.slice(0, -1).join(', ')} or ${dates.at(-1)}`}.` });
  });
  const sourceCatalog: readonly AgenticResearchCatalogEntryV1[] = listAvailable ? Object.freeze(askedCatalog)
    : Object.freeze(askedCatalog.map(({ metadata_only_list: _metadata, requires_channel: _channel, default_since_days: _since, ...entry }) => Object.freeze(entry)));
  const budget = brief.budget;
  const wallNow = options.wall_now ?? Date.now;
  /** Research steps: the audit records them as `step` calls, in the span the runner names. */
  const stepCall: AgenticModelCallV1 = Object.freeze({ role: "step", span: options.step_span });
  const requestDay = context.today;
  let fallbacks = 0; let steps = 0; let searchHits = 0;
  // Ask's read accounting (research tool contract v1): refusals, refused reads answered from memory, unchecked items,
  // sources looked at, and the widest step.
  let refusedReadsCount = 0; let repeatedRefusals = 0; let uncheckedItems = 0; let mostReadsInAStep = 0;
  const sourcesLookedAt = new Set<string>();
  /** Ask's refused reads by their exact arguments: one sent again is answered from here, never re-sent. */
  const refusedReads = new Map<string, ToolResult>();
  const receipts: Sha256Digest[] = [];
  const notice = new Set<string>();
  const entries = new Map<string, Entry>();
  const retrievedTickets = new Set<string>();
  const byShort = new Map<string, string>();
  const searchesRun: (EvidenceDateFilterV1 & { readonly query: string; readonly source?: EvidenceDeskSourceV2 })[] = [];
  /** Searches whose first result carried a notice: one repeat of each reads the desk again. */
  const noticedSearches = new Set<string>();
  /** Sources a completed search read (null: every source). A noticed or truncated search shows nothing about absence. */
  const searchedSources = new Set<EvidenceDeskSourceV2 | null>();
  const researchObservations: AskResearchObservationV1[] = [];
  // Observed read coverage, never the planner's hypotheses or raw tool arguments.
  const readCoverage: { tool: 'search' | 'open' | 'list'; source: string; returned_items: number; truncated: boolean; notice: boolean; unavailable: boolean }[] = [];
  const cover = (tool: 'search' | 'open' | 'list', source: string | undefined, result?: EvidenceDeskResultV2) => {
    readCoverage.push({ tool, source: source === undefined ? 'available_sources' : sourcesById.get(source)?.selector ?? source,
      returned_items: result?.items.length ?? 0, truncated: result?.truncated ?? false, notice: result?.notice !== undefined, unavailable: result === undefined });
  };
  /** Sources whose complete, unfiltered inventory was observed empty. */
  const exhaustivelyEmptySources = new Set<EvidenceDeskSourceV2>();
  let retrievalProgress = 0;
  let evidenceNovelty = 0;
  /** List members no list had shown before (a question goal only): reading a list to its end is progress (ADR-0041). */
  let listNovelty = 0;
  /** Entries some list has shown: the same items listed again under other filters are not progress. */
  const everListed = new Set<Entry>();
  /** Lists whose first page was read, so the next list's id follows the count. */
  let listsRead = 0;
  const lists = new Map<string, ListState>();
  /** Items whose latest open cut them (for a task goal, was truncated) or carried a notice. */
  const limitedOpens = new Set<string>();
  /**
   * Items whose own read already returned all an open of them can: the anchor of a planner open, and a starting item
   * other than a document or transcript passage. A neighbour an open admitted, or a starting passage (read without its
   * neighbours), opens to the passages around it.
   */
  const anchorsRead = new Set<string>();
  let touch = 0;

  const observe = (result: EvidenceDeskResultV2) => {
    if (result.notice !== undefined) notice.add(result.notice);
    for (const item of result.items) if (item.citation.kind === "ticket") retrievedTickets.add(item.id);
    // Audits bind every released item, even one that never reaches a prompt: an item released beside a row too.
    for (const item of [...result.items, ...(result.linked ?? [])]) if (!receipts.includes(item.receipt_sha256)) receipts.push(item.receipt_sha256);
    for (const receipt of result.receipt_digests) if (!receipts.includes(receipt)) receipts.push(receipt);
  };
  /**
   * Registers an item and returns its entry. Text only ever upgrades an entry. Only text is novelty: a new item with
   * text or an upgrade to text. A metadata-only row (a list page, a related reference) is not progress.
   */
  const register = (item: EvidenceDeskItemV2): Entry => {
    const existing = entries.get(item.id);
    touch += 1;
    if (existing !== undefined) {
      // Each copy's links are kept, name by name: an item first released beside another's row carries none of its own
      // until a read returns it as a row (research tool contract v1). Links are never novelty.
      const links = linksUnion(existing.item.links, item.links);
      if (item.text !== undefined && existing.item.text === undefined) { existing.item = item; evidenceNovelty += 1; }
      if (links !== undefined) existing.item = Object.freeze({ ...existing.item, links });
      existing.touched = touch;
      return existing;
    }
    const short = `E${entries.size + 1}`;
    const entry: Entry = { short, item, full: false, opened: false, touched: touch };
    if (item.text !== undefined) evidenceNovelty += 1;
    entries.set(item.id, entry); byShort.set(short, item.id);
    return entry;
  };
  const entryOf = (short: string): Entry | undefined => {
    const id = cleanId(short);
    const deskId = id === null ? undefined : byShort.get(id);
    return deskId === undefined ? undefined : entries.get(deskId);
  };
  /** The source selector the models see for an item. */
  const selectorOf = (item: EvidenceDeskItemV2): string => item.source_id === undefined ? evidenceDeskSourceV2(item) : sourcesById.get(item.source_id)?.selector ?? item.source_id;
  // The scratchpad describes each item once, with its body; a tool result names items by id only (lastResult).
  /** An item's links as research sees them: each link's E ids, only for items this request has released (research tool contract v1). */
  const linksOf = (item: EvidenceDeskItemV2): Readonly<Record<string, readonly string[]>> | undefined => {
    if (item.links === undefined) return undefined;
    const view: Record<string, readonly string[]> = {};
    for (const [name, ids] of Object.entries(item.links)) {
      const shorts = [...new Set(ids.map(id => entries.get(id)?.short).filter((short): short is string => short !== undefined))];
      if (shorts.length > 0) view[name] = shorts;
    }
    return Object.keys(view).length === 0 ? undefined : view;
  };
  // A task goal's item view is unchanged; Ask also sees an item's links and which of its dates matched. Never a URL: a
  // provider's host and coordinates stay out of every prompt, and an answer's citation carries an item's link.
  const describe = (entry: Entry): Record<string, unknown> => {
    const base = describeAgenticEvidenceItemV1({ short: entry.short, source: selectorOf(entry.item), item: entry.item }, ask ? context.time_zone ?? 'UTC' : undefined);
    if (!ask) return base;
    const links = linksOf(entry.item);
    return { ...base, ...(links === undefined ? {} : { links }), ...(entry.matched === undefined || entry.matched.length === 0 ? {} : { matched: entry.matched }) };
  };
  /** Registers items a read released beside its own, because its items link to them: seen, never rows of the read. */
  const registerLinked = (result: EvidenceDeskResultV2): Entry[] => (result.linked ?? []).map(item => {
    if (!receipts.includes(item.receipt_sha256)) receipts.push(item.receipt_sha256);
    return register(item);
  });
  /** Ask marks which of an item's dates fell in a dated read's window. */
  const markMatched = (entry: Entry, filter: EvidenceDateFilterV1) => {
    if (!ask || (filter.since === undefined && filter.until === undefined)) return;
    // The latest dated read that returned the item says which of its dates fell in that read's window.
    const matched = matchedEvidenceDatesV1(entry.item.dates, filter);
    if (matched.length > 0) entry.matched = matched; else delete entry.matched;
  };
  /** Released source projections for automatic starting reads, before short ids are assigned. */
  const releasedView = (result: EvidenceDeskResultV2): Record<string, unknown> => ({
    released_items: result.items.map(item => {
      const { id: _id, ...metadata } = describeAgenticEvidenceItemV1({ short: '', source: selectorOf(item), item }, ask ? context.time_zone ?? 'UTC' : undefined);
      return { ...metadata, citation: item.citation, ...(item.text === undefined ? {} : { text: item.text }) };
    }),
    truncated: result.truncated, ...(result.notice === undefined ? {} : { notice: result.notice }),
  });

  // ---- tools ---------------------------------------------------------
  const search = async (args: StepArgs, admit?: OrderedAdmission, signal: AbortSignal = activeSignal): Promise<ToolResult> => {
    const query = normalizeQuery(args.query);
    if (query === null) return { tool: "search", args, error: "query must be 1 to 32 keywords" };
    const source = readSource(args.source);
    if (args.source !== undefined && source === undefined) return { tool: 'search', args, error: `source must be ${sourceCatalog.map(value => value.source).join(', ')}; omit it to search all available sources` };
    // Ask checks a dated search against the source's capabilities (research tool contract v1): a date it does not record
    // refuses the read, and a window with no date field reads any of an item's dates where the source declares that.
    const capabilities = ask && source !== undefined ? sourcesById.get(source)?.capabilities : undefined;
    // "any" is what leaving date_field out means wherever a window reads any date: the same request.
    const askedField = args.date_field === EVIDENCE_ANY_DATE_V1 && ask && (source === undefined || capabilities?.any_date === true) ? undefined : args.date_field;
    if (askedField !== undefined && source === undefined) return { tool: 'search', args, error: 'Choose a source when selecting date_field; sources support different date meanings' };
    const refused = capabilities === undefined ? undefined : dateRefusal(sourcesById.get(source!)!, capabilities, askedField, args);
    if (refused !== undefined) return refusedResult('search', args, refused);
    const windowed = args.since !== undefined || args.until !== undefined;
    // Across sources, Ask's window reads any of each item's dates too; the desk keeps a source that reads one date to it.
    const anyDate = windowed && askedField === undefined && (capabilities?.any_date === true || (ask && source === undefined));
    const dates = { ...(args.since === undefined ? {} : { since: listDate(args.since, requestDay) ?? args.since }), ...(args.until === undefined ? {} : { until: listDate(args.until, requestDay) ?? args.until }), ...(askedField === undefined ? (anyDate ? { date_field: EVIDENCE_ANY_DATE_V1 } : {}) : { date_field: askedField as EvidenceDateFieldV1 }), ...(context.time_zone === undefined ? {} : { time_zone: context.time_zone }) };
    // A field Ask's capabilities admitted, or any date, is the source's to apply; only the bounds and zone are checked here.
    try { validateEvidenceDateFilterV1(capabilities === undefined && !anyDate ? dates : { ...dates, date_field: undefined }); } catch (error) { return { tool: 'search', args, error: error instanceof Error ? error.message : 'Invalid date filter' }; }
    const fingerprint = JSON.stringify({ query: query.toLowerCase(), source: source ?? null, ...dates });
    const repeat = searchesRun.some(previous => previous.source === source && previous.query.toLowerCase() === query.toLowerCase() && JSON.stringify(evidenceDateFilterV1(previous)) === JSON.stringify(dates));
    // A source that could not be searched then (a notice) may answer now, so one repeat runs again; a complete or truncated
    // result would come back the same, and a notice that persists (an index still catching up) is not paid for every round.
    if (repeat && !noticedSearches.has(fingerprint)) return { tool: "search", query, ...(source === undefined ? {} : { source }), note: "already searched; results are in your scratchpad" };
    if (!repeat) searchesRun.push({ query, ...dates, ...(source === undefined ? {} : { source }) });
    noticedSearches.delete(fingerprint);
    const result = await raceAbort(signal, desk.search({ query, ...dates, ...(source === undefined ? {} : { source, kinds: sourcesById.get(source)!.kinds }), limit: SEARCH_LIMIT, signal }));
    const apply = () => {
      observe(result);
      cover('search', source, result);
      // Progress finds what a read gives research: every hit of a search (ADR-0043).
      report?.returned('search', source, result.items);
      const complete = !result.truncated && result.notice === undefined;
      if (!repeat && result.notice !== undefined) noticedSearches.add(fingerprint);
      researchObservations.push({ operation: 'search', fingerprint, complete });
      if (complete) searchedSources.add(source ?? null);
      retrievalProgress += 1;
      const found = result.items.map(item => register(item));
      for (const entry of found) { entry.query = query; entry.direct = true; markMatched(entry, dates); }
      const linked = registerLinked(result);
      searchHits += found.length;
      sourcesLookedAt.add(source ?? '(all sources)');
      if (ask && result.unchecked !== undefined) uncheckedItems += result.unchecked.count;
      return {
        tool: "search", query, ...(source === undefined ? {} : { source }), results: found.map(entry => describe(entry)), ...(found.length === 0 ? { note: "no matches" } : {}), ...(result.truncated ? { truncated: true } : {}), ...(result.notice === undefined ? {} : { notice: result.notice }),
        ...(ask && linked.length > 0 ? { linked: linked.map(entry => describe(entry)) } : {}), ...(ask && result.unchecked !== undefined && result.unchecked.count > 0 ? { unchecked: result.unchecked } : {}),
      };
    };
    return admit === undefined ? apply() : admit(apply);
  };
  /** Models sometimes pass a title instead of an id; resolve it only when a seen title matches. */
  const entryByTitle = (raw: string): Entry | undefined => {
    const wanted = raw.trim().toLowerCase().replace(/\.(md|txt|pdf|docx)$/u, "");
    if (wanted.length < 3) return undefined;
    const matches = [...entries.values()].filter(entry => {
      const title = entry.item.label.toLowerCase();
      return title === wanted || title.replace(/\.(md|txt|pdf|docx)$/u, "") === wanted || title.includes(wanted);
    });
    return matches.find(entry => !entry.opened) ?? matches[0];
  };
  const open = async (args: StepArgs, admit?: OrderedAdmission, signal: AbortSignal = activeSignal): Promise<ToolResult> => {
    const raw = args.id ?? "";
    const entry = entryOf(raw) ?? entryByTitle(raw);
    if (entry === undefined) return { tool: "open", args, error: "unknown id; pass an id such as E4 from your scratchpad" };
    // Like a repeated search: an item already read around whose full text was in the scratchpad the planner just read is
    // not read again (the access check before every model call already covers it), and adds nothing new. An item an open
    // cut (for a task goal, any truncated open) or noticed is still read again: only a clean open of it resolves that limit.
    if (anchorsRead.has(entry.item.id) && researchPromptEntries.includes(entry) && !limitedOpens.has(entry.item.id)) return { tool: "open", id: entry.short, note: "already open; its full text is in your scratchpad" };
    let result: EvidenceDeskResultV2;
    try { result = await raceAbort(signal, desk.open({ item: entry.item.id, neighbours: OPEN_NEIGHBOURS, signal })); }
    catch (error) {
      const refusal = toolRefusal(error);
      if (refusal === null) throw error;
      cover('open', evidenceDeskSourceV2(entry.item));
      return { tool: "open", id: entry.short, error: refusal };
    }
    const apply = () => {
      observe(result);
      cover('open', evidenceDeskSourceV2(entry.item), result);
      const anchor = result.items.find(item => item.id === entry.item.id && item.text !== undefined);
      const others = result.items.filter(item => item.id !== entry.item.id && item.text !== undefined);
      const texts = anchor === undefined ? others : [anchor, ...others];
      const admitted: Entry[] = [];
      let used = 0;
      for (const item of texts) {
        if (admitted.length > OPEN_EXTRA_ITEMS || (admitted.length > 0 && used + bytes(item.text) > OPEN_BYTES)) break;
        const opened = register(item);
        if (!opened.full || !opened.opened) { retrievalProgress += 1; evidenceNovelty += 1; }
        opened.opened = true; used += bytes(item.text);
        admitted.push(opened);
      }
      // For a question goal, an open whose bodies the loop left out to fit its bounds is truncated, as one the desk cut is:
      // research read less than the desk returned, so the open checks no list member (ADR-0041, addition 4). A task goal
      // keeps its rule.
      const truncated = result.truncated || (ask && admitted.length < texts.length);
      // For a question goal the open cut the opened item's own text when the desk says so (its truncated, when it does
      // not say) or the loop left out a body that is part of the item; a cut only beside it (a link, a meeting's other
      // records) leaves the item whole, read and checked. A task goal keeps its rule.
      const object = agenticCitedObjectV1(entry.item.citation);
      const cut = truncated && (!ask || (result.anchor_truncated ?? result.truncated) || texts.slice(admitted.length).some(item => object === undefined || agenticCitedObjectV1(item.citation) === object));
      for (const opened of admitted) if (cut || result.notice !== undefined) limitedOpens.add(opened.item.id); else limitedOpens.delete(opened.item.id);
      // What the open read: its anchor, or the first text read in its place (a page's section); never what came beside it.
      if (admitted[0] !== undefined) admitted[0].direct = true;
      if (anchor !== undefined) anchorsRead.add(anchor.id);
      // Open may also release continuation metadata. Register it beside
      // the bounded text, without treating the continuation as read evidence.
      const metadata = result.items
        .filter(item => item.text === undefined && item.id !== entry.item.id)
        .map(item => register(item));
      const linked = registerLinked(result);
      return { tool: "open", id: entry.short, opened: admitted.map(value => value.short), ...(metadata.length === 0 ? {} : { results: metadata.map(value => describe(value)) }),
        ...(ask && linked.length > 0 ? { linked: linked.map(value => describe(value)) } : {}), ...(truncated ? { truncated: true } : {}), ...(truncated && !cut ? { anchor_truncated: false } : {}), ...(result.notice === undefined ? {} : { notice: result.notice }), ...(admitted.length === 0 ? { note: "no readable text" } : {}) };
    };
    return admit === undefined ? apply() : admit(apply);
  };
  const list = async (args: StepArgs, admit?: OrderedAdmission, signal: AbortSignal = activeSignal): Promise<ToolResult> => {
    if (!listAvailable) return { tool: "list", args, error: LIST_UNAVAILABLE };
    const normalized = normalizeListArgs(args, requestDay, sourcesById, readSource, ask);
    if ("error" in normalized) return { tool: "list", args, error: normalized.error };
    if ("refused" in normalized) return refusedResult("list", args, normalized);
    const { notes, applied, status, owner, role, limit, ...selection } = normalized;
    // For Ask a source's own filters are the desk's, applied before anything is released, except meetings': meeting actions
    // are filtered here, after each page (research tool contract v1).
    const deskFilters = ask && selection.source !== "meeting" && sourcesById.get(selection.source)?.capabilities !== undefined;
    const request = {
      ...selection, ...(deskFilters && status !== undefined ? { status } : {}), ...(deskFilters && owner !== undefined ? { owner } : {}), ...(role === undefined ? {} : { role }),
      ...(context.time_zone === undefined ? {} : { time_zone: context.time_zone }),
    };
    sourcesLookedAt.add(selection.source);
    const key = listKey(normalized);
    let state = lists.get(key);
    if (state === undefined) {
      // The list's args as research sees them and sends them again: a window with no date_field reads any date by itself,
      // so the internal any-date selection never appears there (research tool contract v1).
      const stateArgs: StepArgs = Object.freeze({
        ...(request.date_field === undefined || request.date_field === EVIDENCE_ANY_DATE_V1 ? {} : { date_field: request.date_field }), source: sourcesById.get(request.source)!.selector, ...(request.kinds?.[0] === undefined ? {} : { kind: request.kinds[0] }),
        ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }), ...(role === undefined ? {} : { role }),
        ...(request.channel === undefined ? {} : { channel: request.channel }), ...(request.since === undefined ? {} : { since: request.since }), ...(request.until === undefined ? {} : { until: request.until }),
      });
      const unfiltered = request.kinds === undefined && status === undefined && owner === undefined && role === undefined &&
        request.channel === undefined && request.since === undefined && request.until === undefined && request.date_field === undefined;
      // The filter as applied: the normalized selection, never the model's raw arguments (ADR-0041).
      const filter: AgenticListFilterV1 = Object.freeze({
        ...(request.kinds?.[0] === undefined ? {} : { kind: request.kinds[0] }), ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }), ...(role === undefined ? {} : { role }),
        ...(request.channel === undefined ? {} : { channel: request.channel }), ...(request.since === undefined ? {} : { since: request.since }), ...(request.until === undefined ? {} : { until: request.until }),
        ...(request.date_field === undefined ? {} : { date_field: request.date_field }), ...(request.time_zone === undefined ? {} : { time_zone: request.time_zone }),
      });
      state = {
        args: stateArgs, source: request.source, unfiltered, items: [], cursor: undefined, fetched: false, paged: 0, truncated: false, available: true,
        members: [], filter, filter_applied: {}, filter_notes: [], unverified_end: false,
      };
      lists.set(key, state);
    }
    // The same selection asked with a filter this source ignores is the same list, whose filter was asked for.
    for (const [field, how] of Object.entries(applied) as [AgenticListFilterFieldV1, AgenticListFilterApplicationV1][]) state.filter_applied[field] ??= how;
    for (const note of notes) if (!state.filter_notes.includes(note)) state.filter_notes.push(note);
    const currentState = state;
    let result: EvidenceDeskResultV2 | undefined;
    const before = { cursor: state.cursor, paged: state.paged, fetched: state.fetched };
    if (state.paged >= state.items.length && (!state.fetched || state.cursor !== undefined)) {
      const deskInput: EvidenceDeskListInputV2 = { ...request, limit: LIST_FETCH, ...(state.cursor === undefined ? {} : { cursor: state.cursor }), signal };
      try { result = await raceAbort(signal, desk.list(deskInput)); }
      catch (error) {
        const refusal = toolRefusal(error);
        if (refusal === null) throw error;
        cover('list', request.source);
        return { tool: "list", args, error: refusal };
      }
    }
    const apply = () => {
      if (result !== undefined) {
        observe(result);
        cover('list', request.source, result);
        currentState.available = currentState.available && result.notice === undefined;
        // The desk counts what the filter could not test for the whole selection; a later page's count replaces it. A meeting
        // list's owner and status are ECHO's own filters, applied after the desk counted, so the count says it covers any.
        if (result.unchecked !== undefined) {
          if (ask && currentState.unchecked === undefined) uncheckedItems += result.unchecked.count;
          const anyOf = deskFilters ? [] : [...(owner === undefined ? [] : ["owner" as const]), ...(status === undefined ? [] : ["status" as const])];
          currentState.unchecked = Object.freeze({ ...result.unchecked, ...(anyOf.length === 0 ? {} : { any_of: Object.freeze(anyOf) }) });
        }
        if (!currentState.fetched || result.next_cursor !== currentState.cursor) retrievalProgress += 1;
        // A list's id and read time come from its first page, in plan order (ADR-0041, addition 2: search can lag edits).
        if (!currentState.fetched) { currentState.id = agenticListIdV1(++listsRead); currentState.read_at = new Date(wallNow()).toISOString(); }
        currentState.fetched = true; currentState.cursor = result.next_cursor; currentState.truncated = result.truncated;
        // An exactly full last page with no next link may hide more items (addition 1); counted before ECHO's own filter.
        currentState.unverified_end = agenticListEndUnverifiedV1({ returned: result.items.length, requested: LIST_FETCH, ...(result.next_cursor === undefined ? {} : { next_cursor: result.next_cursor }), ...(result.page_full === undefined ? {} : { page_full: result.page_full }) });
        // A status filter applies only where an item records a status; approved actions usually record owner and
        // due date but not completion, so an item without a status is kept (never silently dropped as "not open").
        const statusOf = (item: EvidenceDeskItemV2) => item.attributes?.status === undefined ? null : statusGroup(item.attributes.status);
        const wanted = owner?.toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
        // For a question goal, every member meets an owner filter as its statement words it (ADR-0041): by whole words, the
        // rule follow-ups' owners follow, so "Dan" never keeps Dana's or Jordan's actions. A task goal keeps its rule.
        const ownerMatches = (item: EvidenceDeskItemV2) => {
          const recorded = item.attributes?.owner;
          return recorded !== undefined && (ask ? followUpOwnerMatchesV1(recorded, owner!) : wanted.every(part => recorded.toLowerCase().includes(part)));
        };
        const kept = result.items.filter(item => deskFilters || ((status === undefined || statusOf(item) === null || statusOf(item) === status) && (owner === undefined || ownerMatches(item))));
        currentState.items.push(...kept);
        // For a question goal, a kept member whose status is in neither group (a decision's "decided") meets a status filter
        // no more than one with none: either leaves the filter partial, and research is told. A task goal keeps its rule.
        if (!deskFilters && status !== undefined && (ask ? kept.some(item => statusOf(item) === null) : result.items.some(item => item.attributes?.status === undefined))) {
          currentState.note = "some items do not record open or done; they are included";
          currentState.filter_applied.status = "partial";
        }
        if (owner !== undefined && currentState.items.length === 0 && result.items.length > 0) currentState.note = `no listed item records ${owner} as owner; owners shown are exact names from the records`;
      }

      // Ask's limit pages out fewer rows for a short look; repeating the call continues the same list.
      const page = currentState.items.slice(currentState.paged, currentState.paged + Math.min(limit ?? LIST_PAGE, LIST_PAGE)).map(item => register(item));
      // Progress finds the page research is given, never the rows fetched behind it or left out by ECHO's own filter
      // (ADR-0043). A repeat that read nothing and paged nothing out is no read.
      if (result !== undefined || page.length > 0) report?.returned('list', request.source, page.map(entry => entry.item));
      // Items released beside the fetched rows wait for the page that shows a member linking to them, so a short page
      // (a small limit) shows only its own members' links (research tool contract v1).
      if (result !== undefined && result.linked !== undefined && result.linked.length > 0) {
        currentState.linked ??= new Map();
        for (const item of result.linked) if (!currentState.linked.has(item.id)) currentState.linked.set(item.id, item);
      }
      const wanted = new Set(page.flatMap(entry => Object.values(entry.item.links ?? {}).flat()));
      const shownBeside = [...wanted].flatMap(id => {
        const item = currentState.linked?.get(id);
        if (item === undefined) return [];
        currentState.linked!.delete(id);
        return [item];
      });
      const linked = registerLinked({ items: [], truncated: false, receipt_digests: [], linked: shownBeside });
      for (const entry of page) {
        entry.direct = true;
        markMatched(entry, request);
        // Members are each once, in list order. For a question goal, a page that adds members no list had shown is
        // progress (ADR-0041); re-listing the same items under another filter is not.
        if (!currentState.members.includes(entry)) currentState.members.push(entry);
        if (ask && !everListed.has(entry)) { everListed.add(entry); listNovelty += 1; }
      }
      currentState.paged += page.length;
      if (page.length > 0) retrievalProgress += 1;
      const more = inventoryMore(currentState);
      // What shows absence is the same end the list evidence trusts: for a question goal, an exactly full last page is no
      // confirmed end (addition 1). A task goal keeps its rule.
      const readToEnd = currentState.available && !more && !currentState.truncated && !(ask && currentState.unverified_end);
      if (currentState.unfiltered && readToEnd && currentState.items.length === 0) exhaustivelyEmptySources.add(request.source);
      if (!before.fetched || before.paged !== currentState.paged || before.cursor !== currentState.cursor) researchObservations.push({ operation: 'list', fingerprint: key, complete: readToEnd });
      // An empty page is never "nothing more" while pages remain: a filter applied after each page can empty one. A repeat
      // of an inventory read to its end makes no desk call and no progress, and says so; only a complete one is "in full".
      // For a question goal, an exactly full last page is not trusted as the end (addition 1).
      const unverified = ask && !more && currentState.unverified_end;
      // A page the source could not read completely (a notice) is never "nothing more": its list is incomplete.
      const emptyNote = page.length > 0 ? [] : more ? ["this page was empty (for example because of a date filter); more pages remain"]
        : result !== undefined ? [currentState.available ? "nothing more to list" : "this source could not be read completely, so its list is incomplete; use search"]
        : !currentState.available ? ["already listed; this source was unavailable, so its list is incomplete; use search"]
        : currentState.truncated || unverified ? ["already listed; nothing more to list"] : ["already listed in full; nothing more to list"];
      const allNotes = [...notes, ...(currentState.note === undefined ? [] : [currentState.note]), ...emptyNote, ...(!more && currentState.truncated ? ["more items exist than list can show; use search"] : []),
        ...(unverified && !currentState.truncated ? ["its last page was exactly full, so more items may exist than list can show; use search"] : [])];
      const filters = Object.keys(currentState.filter_applied).length === 0 ? undefined : { ...currentState.filter_applied };
      return {
        tool: "list", ...(ask && currentState.id !== undefined ? { list: currentState.id } : {}), source: request.source, ...(request.channel === undefined ? {} : { channel: request.channel }), ...(request.since === undefined ? {} : { since: request.since }),
        items: page.map(entry => describe(entry)), more, ...(allNotes.length === 0 ? {} : { note: allNotes.join("; ") }),
        ...(ask && result?.notice !== undefined ? { notice: result.notice } : {}), ...(ask && filters !== undefined ? { filters } : {}),
        ...(ask && currentState.unchecked !== undefined && currentState.unchecked.count > 0 ? { unchecked: currentState.unchecked } : {}),
        ...(ask && linked.length > 0 ? { linked: linked.map(entry => describe(entry)) } : {}),
      };
    };
    return admit === undefined ? apply() : admit(apply);
  };
  /**
   * A read's result as the next step sees it in last_results, and as its tool_response records it: the call, what it
   * returned by id in rank order, and its page state, notes and errors. Item descriptors and bodies are in opened and
   * seen, never repeated here.
   */
  const lastResult = (action: StepAction, value: ToolResult): ToolResult => {
    const ids = (key: "results" | "items" | "linked") => (value[key] as readonly Record<string, unknown>[]).map(row => row.id);
    return Object.freeze({
      tool: action.tool, args: action.args, ...(typeof value.list === "string" ? { list: value.list } : {}),
      ...(Array.isArray(value.opened) ? { opened: value.opened } : {}),
      ...(Array.isArray(value.results) ? { results: ids("results") } : {}), ...(Array.isArray(value.items) ? { items: ids("items") } : {}),
      ...(typeof value.more === "boolean" ? { more: value.more } : {}), ...(value.truncated === true ? { truncated: true } : {}),
      // Ask (research tool contract v1): each filter's outcome, what a refused read's source supports, the items a date
      // filter could not test, and the items released beside this read because its items link to them.
      ...(value.filters !== undefined ? { filters: value.filters } : {}), ...(value.supports !== undefined ? { supports: value.supports } : {}),
      ...(value.unchecked !== undefined ? { unchecked: value.unchecked } : {}), ...(Array.isArray(value.linked) ? { linked: ids("linked") } : {}),
      ...(typeof value.notice === "string" ? { notice: value.notice } : {}), ...(typeof value.note === "string" ? { note: value.note } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    });
  };
  /** A read's exact arguments, for Ask's memory of refused reads. */
  const readKey = (action: StepAction) => `${action.tool}:${JSON.stringify(Object.keys(action.args).sort().map(key => [key, action.args[key as keyof StepArgs]]))}`;
  let toolCalls = 0;
  const run = async (action: StepAction, admit?: OrderedAdmission, signal?: AbortSignal): Promise<ToolResult> => {
    // Only planner-selected reads enter this function; finish has no tool result.
    const tool = action.tool === 'search' || action.tool === 'open' ? action.tool : 'list';
    const identity = { tool_call_id: ++toolCalls, round: steps, tool } as const;
    return withCoreRuntimeDiagnosticToolV1(identity, async () => {
    observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', ...identity, args: action.args });
    try {
      // Ask never sends a refused read again (research tool contract v1): the same arguments get the same refusal, unsent.
      const key = readKey(action);
      const refusedBefore = ask ? refusedReads.get(key) : undefined;
      if (refusedBefore !== undefined) {
        repeatedRefusals += 1;
        const again = "refused again: this exact request was already refused in this Ask, so it was not sent; change the source, the filter or the approach";
        const value: ToolResult = Object.freeze({ ...refusedBefore, note: typeof refusedBefore.note === "string" ? `${refusedBefore.note}; ${again}` : again });
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', ...identity, result: lastResult(action, value) });
        return value;
      }
      const value = await (tool === 'search' ? search(action.args, admit, signal) : tool === 'open' ? open(action.args, admit, signal) : list(action.args, admit, signal));
      if (ask && (typeof value.error === "string" || value.refused === true)) { refusedReads.set(key, value); refusedReadsCount += 1; }
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', ...identity, result: lastResult(action, value) });
      return value;
    } catch (error) {
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_error', ...identity, error_kind: coreRuntimeDiagnosticErrorKindV1(error) });
      throw error;
    }
    });
  };
  /**
   * Reads planned together have no model-visible dependency. Start their
   * I/O together, then apply completed results in plan order so evidence
   * ids, receipts and the next prompt stay deterministic. Only repeated
   * lists with the same normalized selection depend on an earlier read.
   */
  const runReads = async (actions: readonly StepAction[]): Promise<readonly ToolResult[]> => {
    const batchAbort = new AbortController();
    const signal = AbortSignal.any([activeSignal, batchAbort.signal]);
    let next = 0;
    let stopped = false;
    let failure: unknown;
    const pending = new Map<number, { readonly apply: () => ToolResult; readonly resolve: (value: ToolResult) => void; readonly reject: (reason: unknown) => void }>();
    const skipped = new Set<number>();
    const advance = () => {
      while (!stopped) {
        const entry = pending.get(next);
        if (entry === undefined) {
          if (!skipped.delete(next)) return;
          next += 1;
          continue;
        }
        pending.delete(next); next += 1;
        try { signal.throwIfAborted(); assertLive(); entry.resolve(entry.apply()); } catch (error) { stopped = true; failure = error; batchAbort.abort(error); entry.reject(error); }
      }
      for (const entry of pending.values()) entry.reject(failure);
      pending.clear();
    };
    const admit = (index: number): OrderedAdmission => apply => new Promise<ToolResult>((resolve, reject) => {
      if (stopped) { reject(failure); return; }
      pending.set(index, { apply, resolve, reject });
      advance();
    });
    const skip = (index: number) => {
      if (stopped || index < next) return;
      skipped.add(index); advance();
    };
    const fail = (error: unknown) => {
      if (stopped) return;
      stopped = true; failure = error; batchAbort.abort(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    const listTasks = new Map<string, Promise<ToolResult>>();
    // Ask: the same read twice in one step waits for the first, so a refusal is remembered before its copy runs.
    const readTasks = new Map<string, Promise<ToolResult>>();
    const tasks = actions.map((action, index) => {
      let key: string | undefined;
      if (action.tool === 'list') {
        const normalized = normalizeListArgs(action.args, requestDay, sourcesById, readSource, ask);
        if (!('error' in normalized) && !('refused' in normalized)) key = listKey(normalized);
      }
      const read = ask ? readKey(action) : undefined;
      const previous = [...new Set([key === undefined ? undefined : listTasks.get(key), read === undefined ? undefined : readTasks.get(read)])]
        .filter((value): value is Promise<ToolResult> => value !== undefined);
      const task = (async () => {
        try {
          if (previous.length > 0) await Promise.all(previous);
          signal.throwIfAborted(); assertLive();
          const value = await run(action, admit(index), signal);
          skip(index);
          return value;
        } catch (error) {
          fail(error);
          throw error;
        }
      })();
      if (key !== undefined) listTasks.set(key, task);
      if (read !== undefined) readTasks.set(read, task);
      return task;
    });
    const settled = await Promise.allSettled(tasks);
    if (stopped) throw failure;
    const rejection = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejection !== undefined) throw rejection.reason;
    return Object.freeze(settled.map(result => (result as PromiseFulfilledResult<ToolResult>).value));
  };

  // ---- plan (parts and needs) -------------------------------------------
  let plan: PartState[] = [];
  /** The plan a step proposes, merged into the current one. Nothing is kept until the step is accepted. */
  const proposedPlan = (parts: readonly StepPart[]): PartState[] => {
    const next = plan.map(part => ({ ...part, needs: part.needs.map(need => ({ ...need })) }));
    // Needs are never removed, so the next id follows the count.
    let ids = next.reduce((count, part) => count + part.needs.length, 0);
    const newNeed = (need: string, status: NeedStatus, evidence: readonly string[], kind?: AgenticResearchNeedKindV1): NeedState =>
      ({ id: `N${++ids}`, need, ...(kind === undefined ? {} : { kind }), status, evidence, observations_before: researchObservations.length });
    const newPart = (part: StepPart): PartState => ({
      question: part.question, notes: part.notes,
      // A part without needs still needs its own answer.
      needs: part.needs.length > 0 ? part.needs.map(need => newNeed(need.need, need.status, need.evidence, need.kind)) : [newNeed(part.question, "open", [], ask ? "content" : undefined)],
    });
    if (parts.length === 0) return next;
    if (next.length === 0) return parts.map(newPart);
    const updated = new Set<NeedState>();
    const byId = (need: StepNeed) => (need.id === undefined ? undefined : next.flatMap(value => value.needs).find(value => value.id === need.id));
    // Each step's proposal is the need's declaration of its kind (ADR-0041).
    const settle = (match: NeedState, need: StepNeed) => {
      if (updated.has(match)) return;
      updated.add(match); match.status = need.status; match.evidence = need.evidence;
      if (need.kind !== undefined) match.kind = need.kind;
    };
    for (const [index, part] of parts.entries()) {
      const existing = next[index];
      if (existing === undefined) {
        // A need named by the id of one already planned is that need, settled where it was planned; only the rest are new.
        // A part made only of planned needs adds no part (it would get an open need for its question, refusing the finish).
        const fresh = part.needs.filter(need => {
          const match = byId(need);
          if (match !== undefined) settle(match, need);
          return match === undefined;
        });
        if (part.needs.length === 0 || fresh.length > 0) next.push(newPart({ ...part, needs: fresh }));
        continue;
      }
      if (part.notes.length > 0) existing.notes = part.notes;
      for (const need of part.needs) {
        // The same need by its id, in whichever part, or else by its wording in this part (005d7876: a reworded need
        // with no id left the original open, so a correct finish was refused). The first proposal for a need wins.
        const match = byId(need) ?? existing.needs.find(value => needKey(value.need) === needKey(need.need));
        if (match !== undefined) settle(match, need);
        else if (existing.needs.length < AGENTIC_ASK_MAX_NEEDS_PER_PART_V1) existing.needs.push(newNeed(need.need, need.status, need.evidence, need.kind));
      }
    }
    return next;
  };
  /** The plan as the bundle and rounds record it; a step is also shown each need's id. An Ask need shows its kind (ADR-0041). */
  const planView = (ids = false) => plan.map((part, index) => ({
    part: index + 1, question: part.question, notes: part.notes,
    needs: part.needs.map(need => ({ ...(ids ? { id: need.id } : {}), need: need.need, ...(need.kind === undefined ? {} : { kind: need.kind }), status: need.status, evidence: need.evidence })),
  }));
  /** Listed inventories continue across planner turns without exposing cursors or desk identities. */
  const inventoryView = () => [...lists.values()].filter(state => state.fetched).map(state => Object.freeze({
    args: state.args, shown_count: state.paged, more: inventoryMore(state),
    available: state.available, truncated: state.truncated,
  }));
  /**
   * Inventories whose unread pages still block a not_found finish. A complete
   * unfiltered inventory of a source covers its filtered ones. A metadata-only
   * list (live tickets or pages, newest first) shows titles and dates only, so
   * its pages cannot show that a fact is absent: once a search of that source
   * (or of every source) has completed, its unread pages no longer block.
   */
  const blockingInventories = (): readonly ListState[] => {
    const fetched = [...lists.values()].filter(state => state.fetched);
    const covered = new Set(fetched.filter(state => state.unfiltered && state.available && !state.truncated && !inventoryMore(state) && !(ask && state.unverified_end)).map(state => state.source));
    const searched = (source: EvidenceDeskSourceV2) => searchedSources.has(null) || searchedSources.has(source);
    return fetched.filter(state => inventoryMore(state) && !covered.has(state.source) && !(sourcesById.get(state.source)?.metadata_only_list === true && searched(state.source)));
  };
  /** Lists research read, in id order (a list gets its id when its first page is read). */
  const listsInOrder = (): readonly (ListState & { readonly id: AgenticListIdV1 })[] =>
    [...lists.values()].filter((state): state is ListState & { readonly id: AgenticListIdV1 } => state.id !== undefined).sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
  /** A list as list evidence. `extraShown`: members the prompt being built shows, which its admission will mark shown. */
  const listEvidence = (state: ListState & { readonly id: AgenticListIdV1 }, extraShown: ReadonlySet<Entry> = new Set()): AgenticListEvidenceV1 => createAgenticListEvidenceV1({
    id: state.id, source: state.args.source!, filter: state.filter, filter_applied: { ...state.filter_applied },
    members: state.members.map(entry => entry.short), shown: state.members.filter(entry => entry.shown === true || extraShown.has(entry)).length,
    ended: !inventoryMore(state), unverified_end: state.unverified_end, available: state.available, truncated: state.truncated, read_at: state.read_at!,
    ...(state.unchecked === undefined ? {} : { unchecked: state.unchecked }),
  });
  /**
   * Ask's persistent lists (ADR-0041): each list by id, with its members, as the step being built will see it. `complete`
   * counts the members this step shows, since admitting the step marks them shown.
   */
  const listView = (extraShown: ReadonlySet<Entry> = new Set()) => listsInOrder().map(state => {
    const evidence = listEvidence(state, extraShown);
    const notes = [...state.filter_notes, ...(state.note === undefined ? [] : [state.note])];
    return Object.freeze({
      id: state.id, args: state.args, members: evidence.members, shown_count: state.paged, more: inventoryMore(state), complete: evidence.complete,
      available: state.available, truncated: state.truncated, unverified_end: state.unverified_end, ...(notes.length === 0 ? {} : { notes }),
      ...(evidence.unchecked === undefined ? {} : { unchecked: evidence.unchecked }),
    });
  });
  /** What the finish check knows about each list (ADR-0041). */
  const listsForCheck = (): readonly AskResearchListV1[] => listsInOrder().map(state => Object.freeze({
    id: state.id, ended: !inventoryMore(state), args: state.args as Readonly<Record<string, string>>, members: state.members.map(entry => entry.short),
  }));
  /** Which list member each item is, or is part of: an opened page's section is its page (ADR-0041). */
  const listMembership = (lists: readonly { readonly id: AgenticListIdV1; readonly members: readonly string[] }[]) => agenticListMembershipV1(lists, [...entries.values()]);
  /** A question goal's finish check, by each need's declared kind; membership only words a refusal (ADR-0041). */
  const questionCompletionProblems = (parts: readonly { readonly needs: readonly NeedState[] }[]) => {
    const checked = listsForCheck();
    return askQuestionCompletionProblemsV1(parts, researchObservations, checked, citable, listMembership(checked).in);
  };

  // ---- scratchpad ------------------------------------------------------
  const citable = (short: string): boolean => entryOf(short)?.full === true;
  const citedShorts = () => new Set(plan.flatMap(part => part.needs.flatMap(need => need.evidence)).filter(citable));
  /** What the latest step prompt reads in full, and every entry it shows (opened or seen): its admission marks them. */
  let researchPromptEntries: readonly Entry[] = [];
  let researchPromptShown: readonly Entry[] = [];
  /** Step model time (the runner's) when the latest step call started, and the longest step call so far. */
  let stepCallStartedAt: number | undefined;
  let longestStepMs = 0;
  const settleStepCall = () => {
    if (stepCallStartedAt === undefined) return;
    longestStepMs = Math.max(longestStepMs, options.observed().model_ms - stepCallStartedAt);
    stepCallStartedAt = undefined;
  };
  /**
   * The scratchpad: opened bodies, then every other entry, each in E-id order and never re-sorted between steps, so a
   * step's prompt repeats the evidence of the step before as its prefix (prompt caching). Exact released bodies when
   * opened or packet-sized; previews are always explicitly incomplete. When the budget binds, what the latest reads
   * returned is kept first (last_results names it only by id), then entries in id order: the newest others are left out.
   */
  const scratchpad = (budget: number, latest: ReadonlySet<string>) => {
    // Entries are never removed, so their insertion order is id order.
    const keptFirst = (list: readonly Entry[]) => [...list.filter(entry => latest.has(entry.short)), ...list.filter(entry => !latest.has(entry.short))];
    const idOrder = (left: Entry, right: Entry) => Number(left.short.slice(1)) - Number(right.short.slice(1));
    const all = [...entries.values()];
    const shown: Entry[] = []; const shownIds = new Set<string>(); let used = 0;
    for (const entry of keptFirst(all.filter(entry => entry.opened && entry.item.text !== undefined))) {
      const cost = bytes(JSON.stringify({ ...describe(entry), text: entry.item.text })) + 1;
      if (used + cost > budget) continue;
      used += cost; shownIds.add(entry.short); shown.push(entry);
    }
    const seen: { readonly entry: Entry; readonly value: Record<string, unknown> }[] = [];
    for (const entry of keptFirst(all.filter(entry => !shownIds.has(entry.short)))) {
      if (seen.length >= MAX_SEEN_ENTRIES) break;
      const text = entry.item.text;
      let value: Record<string, unknown> = text !== undefined && bytes(text) <= PASSAGE_BYTES
        ? { ...describe(entry), text, full: true }
        : { ...describe(entry), ...(text === undefined ? {} : { preview: queryPreview(text, entry.query), full: false }) };
      let cost = bytes(JSON.stringify(value)) + 1;
      if (used + cost > budget && text !== undefined) {
        value = { ...describe(entry), preview: queryPreview(text, entry.query), full: false };
        cost = bytes(JSON.stringify(value)) + 1;
      }
      if (used + cost > budget) continue;
      used += cost; seen.push({ entry, value });
    }
    shown.sort(idOrder); seen.sort((left, right) => idOrder(left.entry, right.entry));
    return {
      opened: shown.map(entry => ({ ...describe(entry), text: entry.item.text })), seen: seen.map(({ value }) => value),
      read: [...shown, ...seen.filter(({ value }) => value.full === true).map(({ entry }) => entry)],
      entries: [...shown, ...seen.map(({ entry }) => entry)],
    };
  };
  // ---- stop state ------------------------------------------------------
  let researchIncomplete = true;
  let researchStop: 'finished' | 'empty_catalog' | 'no_progress' | 'step_limit' | 'budget' | 'unusable_step' = 'step_limit';
  let researchAdmission: AgenticResearchAdmissionV1 | undefined;

  // ---- research bookkeeping (never enters a prompt) ----------------------
  const rounds: AgenticResearchRoundV1[] = [];
  let stepRejections: string[] = [];
  /** Starting citations the brief marked `report` that could not be read. */
  const unreadableStarting: unknown[] = [];
  /**
   * A read as its round records it, from what the next step sees (`value`); an Ask open adds the item it resolved to, and
   * whether a truncated open left that item's own text whole (`raw`).
   */
  const roundView = (tool: string, args: StepArgs, value: ToolResult | undefined, raw?: ToolResult): AgenticResearchActionV1 => {
    const listed = (key: string) => Array.isArray(value?.[key]) ? (value![key] as readonly unknown[]).map(String) : [];
    const opened = Array.isArray(value?.opened) ? (value!.opened as readonly string[]) : [];
    return Object.freeze({ tool, args: Object.freeze({ ...args }), result: Object.freeze({
      items: [...listed("results"), ...listed("items")], opened: [...opened], ...(ask && typeof raw?.id === "string" ? { id: raw.id } : {}),
      ...(typeof value?.note === "string" ? { note: value.note } : {}), ...(typeof value?.error === "string" ? { error: value.error } : {}),
      ...(value?.truncated === true ? { truncated: true } : {}), ...(raw?.anchor_truncated === false ? { anchor_truncated: false as const } : {}),
      ...(typeof value?.more === "boolean" ? { more: value.more } : {}), ...(typeof value?.notice === "string" ? { notice: true } : {}),
      // Ask (research tool contract v1): what the step saw of each filter's outcome, a refused read's supports and the
      // items its dates could not test, so an evaluation reads them from the round as the model did.
      ...(ask && value?.filters !== undefined ? { filters: value.filters as Readonly<Record<string, unknown>> } : {}),
      ...(ask && value?.supports !== undefined ? { supports: value.supports as Readonly<Record<string, unknown>> } : {}),
      ...(ask && value?.unchecked !== undefined ? { unchecked: value.unchecked as Readonly<Record<string, unknown>> } : {}),
    }) });
  };
  const recordRound = (startedAt: number, actions: readonly AgenticResearchActionV1[]) => {
    rounds.push(Object.freeze({ round: rounds.length + 1, elapsed_ms: Math.max(0, Math.round(now() - startedAt)), plan: planView() as readonly AgenticResearchPartV1[], actions: Object.freeze([...actions]), rejected: Object.freeze([...stepRejections]) }));
    stepRejections = [];
  };
  /** The goal as the model sees it: a task's slots are filled once its starting items are read. */
  let goal: AgenticResearchGoalV1 = brief.goal;
  const goalFields = (): Record<string, unknown> => goal.kind === "question" ? { question: goal.question } : { task: goal.task };

  /** The research phase: starting reads, then the loop until a stop rule fires. */
  const research = async (gate: AgenticModelGateV1): Promise<void> => {
    // ---- starting evidence: read fresh through the access-checked desk ----
    // The reads run together, a few at a time in brief order, and are registered in brief order, so ids, receipts and
    // failures are those of reading one at a time: a failure that stops research stops only the reads after it, and the
    // first failure in brief order is the one thrown.
    type StartingRead = { readonly opened: EvidenceDeskResultV2; readonly readable: readonly EvidenceDeskItemV2[]; readonly anchor: EvidenceDeskItemV2 | undefined } | { readonly unreadable: true };
    assertLive();
    const stopReads = brief.starting.map(() => new AbortController());
    let reading = 0;
    const waiting: (() => void)[] = [];
    /** What each starting read released, by brief index, kept the moment the desk returns it. */
    const released: (EvidenceDeskResultV2 | undefined)[] = [];
    const settled = await Promise.allSettled(brief.starting.map(async ({ citation, if_unreadable: ifUnreadable }, index): Promise<StartingRead> => {
      const signal = AbortSignal.any([activeSignal, stopReads[index]!.signal]);
      if (reading >= STARTING_READS_AT_ONCE) await new Promise<void>(resolve => { waiting.push(resolve); });
      reading += 1;
      try {
        signal.throwIfAborted();
        const opened = await observeAgenticLifecycleV1('starting_read', 'research_starting_read', { index: index + 1, citation, if_unreadable: ifUnreadable }, async () => {
          if (desk.openCitation === undefined) throw new AuthorityOperationError("unavailable", "Starting evidence is unavailable");
          return raceAbort(signal, desk.openCitation({ citation, signal }));
        }, releasedView);
        released[index] = opened;
        const readable = opened.items.filter(item => item.text !== undefined);
        const anchor = readable.find(item => citationIdentity(item.citation) === citationIdentity(citation)) ?? readable[0];
        // Fail closed unless the brief asked to report it: research never runs without evidence its brief names.
        if (anchor === undefined && ifUnreadable !== "report") throw new AuthorityOperationError("not_found", "Starting evidence is not available");
        return { opened, readable, anchor };
      } catch (error) {
        // A deleted or now-hidden item is news to a brief that asked to hear about it; nothing else about it is known.
        if (ifUnreadable === "report" && unreadableRefusal(error)) return { unreadable: true };
        for (const stop of stopReads.slice(index + 1)) stop.abort();
        throw error;
      } finally {
        reading -= 1;
        waiting.shift()?.();
      }
    }));
    const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed !== undefined) {
      // The audit of a cancelled or timed-out request still binds everything the desk released, in brief order, including
      // what a read that failed closed returned.
      for (const opened of released) if (opened !== undefined) observe(opened);
      throw failed.reason;
    }
    // Each starting item's id, in brief order; null when it could not be read.
    const startingIds: (string | null)[] = [];
    for (const [index, outcome] of settled.entries()) {
      const read = (outcome as PromiseFulfilledResult<StartingRead>).value;
      const { citation } = brief.starting[index]!;
      if ("unreadable" in read) {
        cover('open', undefined);
        unreadableStarting.push(citation); startingIds.push(null);
        continue;
      }
      const { opened, readable, anchor } = read;
      observe(opened);
      cover('open', anchor === undefined ? undefined : evidenceDeskSourceV2(anchor), opened);
      if (anchor === undefined) {
        for (const item of opened.items) register(item);
        unreadableStarting.push(citation); startingIds.push(null);
        continue;
      }
      let used = 0;
      for (const item of [anchor, ...readable.filter(value => value !== anchor)]) {
        if (item !== anchor && used + bytes(item.text) > OPEN_BYTES) break;
        const entry = register(item); entry.opened = true; entry.preloaded = true; used += bytes(item.text);
        if (item === anchor) { startingIds.push(entry.short); entry.direct = true; }
      }
      if (anchor.citation.kind !== "source_revision") anchorsRead.add(anchor.id);
      for (const item of opened.items.filter(value => value.text === undefined)) register(item);
    }
    if (brief.goal.kind === "task") goal = Object.freeze({ kind: "task", task: fillAgenticTaskV1(brief.goal.task, startingIds, brief.goal.data) });

    // ---- no planner: the reads above are the research --------------------
    // The starting items were read in full, so they count as read; the renderer judges from them. No plan is written.
    if (brief.options.planner === false) {
      for (const entry of entries.values()) if (entry.preloaded === true && entry.opened && entry.item.text !== undefined) entry.full = true;
      researchIncomplete = false;
      researchStop = 'finished';
      return;
    }

    // ---- research loop --------------------------------------------------
    /** What the last step's reads returned, as the next step sees it, and the ids of the items they returned. */
    let results: readonly ToolResult[] = [];
    let latest: ReadonlySet<string> = new Set();
    let idleSteps = 0;
    /** A round of the current idle streak discovered new items: the planner keeps one more round to open them. */
    let idleDiscovered = false;
    const stepTimeout = () => Math.min(STEP_TIMEOUT_MS, remaining() - budget.writer_reserve_ms - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1);
    /** The time a step needs to start: the minimum, or the margin over the longest step call so far, at most a whole step. */
    const stepNeeds = () => Math.min(STEP_TIMEOUT_MS, Math.max(AGENTIC_ASK_MIN_STEP_MS_V1, Math.ceil(STEP_TIME_MARGIN * longestStepMs)));
    while (steps < budget.max_rounds) {
      assertLive();
      settleStepCall();
      const roundStartedAt = now();
      // Leave room for the answer call and its possible repair, and never start a step that probably cannot finish:
      // the writer gets the time instead.
      if (stepTimeout() < stepNeeds() || gate.stats().calls + 2 >= budget.max_model_calls) { researchStop = 'budget'; break; }
      // A stable head, then the evidence, which only grows, then what changes every step: each step's prompt repeats the
      // last one's head and evidence as its prefix, so the provider can serve that prefix from its cache. JSON keeps this
      // key order through the gate and the provider adapter.
      const head = { ...goalFields(), ...context, scope, source_catalog: sourceCatalog };
      // A question goal sees its lists by id (ADR-0041); a task goal keeps its inventories. A list's view can only shrink
      // once the scratchpad is known (complete "false" becomes "true"), so the budget is measured before it.
      const tailWith = (shownNow?: ReadonlySet<Entry>) => ({
        step: steps + 1, steps_left: budget.max_rounds - steps - 1, plan: planView(true), ...(ask ? { lists: listView(shownNow) } : { inventories: inventoryView() }), last_results: results, searches_done: [...searchesRun],
      });
      const pad = scratchpad(researchBudget - bytes(JSON.stringify({ ...head, opened: [], seen: [], ...tailWith() })), latest);
      researchPromptEntries = pad.read; researchPromptShown = pad.entries;
      const user = { ...head, opened: pad.opened, seen: pad.seen, ...tailWith(new Set(pad.entries)) };
      const openIds = [...entries.values()].map(entry => entry.short);
      const finishAvailable = researchObservations.length > 0 || pad.read.length > 0 || [...entries.values()].some(entry => entry.full);
      const stepSchema = createStepSchema(sourceCatalog.map(source => source.source), openIds, finishAvailable, listAvailable, ask);
      let step: Step;
      // The need holds after the access check too: a check retried after a transient failure can spend the margin, and a
      // step call sent below it would likely time out with no time to repair. No time here is the gate's budget stop. The one
      // repair keeps the gate's plain minimum.
      const callsBefore = gate.stats().calls;
      const timeout = () => (gate.stats().calls === callsBefore && stepTimeout() < stepNeeds() ? 0 : stepTimeout());
      // A count only: the names wait for the access check before this call (the gate's before_call).
      report?.before_check(pad.read.filter(entry => entry.direct === true).map(entry => entry.item));
      try {
        step = await gate.withRepair(stepCall, researchPrompt, user, stepSchema, timeout, value => {
          const parsed = parseStep(value, { lists: ask });
          if (parsed.actions.length === 0) throw new AgenticAskOutputErrorV1('actions must contain a read action or a valid finish');
          for (const action of parsed.actions) {
            if (action.tool === 'list' && !listAvailable) throw new AgenticAskOutputErrorV1(LIST_UNAVAILABLE);
            if ((action.tool === 'search' || action.tool === 'list') && action.args.source !== undefined) {
              const source = readSource(action.args.source);
              if (!sourceCatalog.some(value => readSource(value.source) === source)) throw new AgenticAskOutputErrorV1(`source is unavailable; choose from ${sourceCatalog.map(value => value.source).join(', ')}`);
            }
            if (action.tool !== 'open') continue;
            const id = action.args.id ?? '';
            // Keep the existing normalization of a discovered title, but
            // never advance research with an invented item reference.
            if (entryOf(id) !== undefined || entryByTitle(id) !== undefined) continue;
            throw new AgenticAskOutputErrorV1(openIds.length === 0
              ? `open is unavailable: no items have been discovered. Use ${listAvailable ? 'search or list' : 'search'} first.`
              : `open requires a discovered id from your scratchpad, such as ${openIds.slice(0, 12).join(', ')}`);
          }
          if (parsed.actions.every(action => action.tool === 'finish')) {
            const completionPlan = proposedPlan(parsed.parts);
            // A question goal's needs are checked by their declared kinds (ADR-0041); a task goal's need an item read in full.
            const problems = [...(ask
              ? questionCompletionProblems(completionPlan)
              : askResearchCompletionProblemsV1(completionPlan, researchObservations, citable, listAvailable))];
            if (completionPlan.some(part => part.needs.some(need => need.status === 'not_found'))) {
              if (entries.size > 0 && [...entries.values()].every(entry => entry.item.text === undefined)) {
                problems.unshift('discovered items have metadata only; open potentially relevant discovered items before concluding that it is absent');
              }
              const unread = blockingInventories();
              const unsearched = [...new Set(unread.filter(state => sourcesById.get(state.source)?.metadata_only_list === true).map(state => state.args.source))];
              if (unread.length > 0) problems.unshift(`listed inventory still has unread pages; repeat list with ${unread.slice(0, 3).map(state => JSON.stringify(state.args)).join(' or ')}${unsearched.length === 0 ? '' : `, or search ${unsearched.join(' and ')} for the fact`}`);
            }
            if (!finishAvailable) problems.unshift(`no source has been read; use ${listAvailable ? 'search or list' : 'search'} first`);
            if (problems.length > 0) throw new AgenticAskOutputErrorV1(`finish was not accepted: ${problems.slice(0, 8).join('; ')}. ${listAvailable ? 'Search, list or open more' : 'Search or open more'}, or correct the need status and evidence.`);
          }
          return parsed;
        }, reason => stepRejections.push(cleanLine(reason, 600)));
      }
      catch (error) {
        // The request's signal is aborted exactly when the caller cancelled or the deadline passed.
        if (isAbort(error, activeSignal) || !(error instanceof AgenticAskOutputErrorV1)) throw error;
        // The access fence is required. If it consumed the next step's minimum
        // time, preserve released evidence and report a budget stop, rather
        // than claiming that the planner produced an unusable reply.
        if (error instanceof AgenticAskPostRevalidationNoTimeErrorV1) {
          researchStop = 'budget';
          researchAdmission = 'post_revalidation_no_time';
          recordRound(roundStartedAt, []);
          break;
        }
        // A research step that cannot finish stops research; the answer uses what was found.
        fallbacks += 1; researchStop = 'unusable_step';
        stepRejections.push(cleanLine(error.message, 600)); recordRound(roundStartedAt, []);
        break;
      }
      steps += 1;
      plan = proposedPlan(step.parts);
      // Batched reads must be observed in another step before completion.
      const reads = step.actions.filter(action => action.tool !== "finish");
      mostReadsInAStep = Math.max(mostReadsInAStep, reads.length);
      if (reads.length === 0) {
        const identity = { tool_call_id: ++toolCalls, round: steps, tool: 'finish' } as const;
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', ...identity, args: {} });
        researchIncomplete = false;
        researchStop = 'finished';
        recordRound(roundStartedAt, [roundView("finish", {}, undefined)]);
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', ...identity, result: { tool: 'finish' } });
        break;
      }
      const hadCitableEvidence = [...entries.values()].some(entry => entry.full);
      // Once research has read some text, only new evidence is progress: new text, or, for a question goal, list members.
      const novelty = () => evidenceNovelty + listNovelty;
      const before = hadCitableEvidence ? novelty() : retrievalProgress;
      const entriesBefore = entries.size;
      report?.reads(reads.some(action => action.tool !== "open"));
      const raw = await runReads(reads);
      results = raw.map((value, index) => lastResult(reads[index]!, value));
      report?.reads_done();
      const actions = reads.map((action, index) => roundView(action.tool, action.args, results[index], raw[index]));
      recordRound(roundStartedAt, actions);
      latest = new Set(actions.flatMap(action => [...action.result.opened, ...action.result.items]));
      const catalogIsExhaustivelyEmpty = entries.size === 0 && sourceCatalog.length > 0 && sourceCatalog.every(source => {
        const normalized = readSource(source.source);
        return normalized !== undefined && exhaustivelyEmptySources.has(normalized);
      });
      if (catalogIsExhaustivelyEmpty) {
        researchIncomplete = false;
        researchStop = 'empty_catalog';
        break;
      }
      const progressed = (hadCitableEvidence ? novelty() : retrievalProgress) > before;
      idleSteps = progressed ? 0 : idleSteps + 1;
      // New metadata-only items are not progress, but the planner may still open what the streak discovered, even after
      // another read first (a search that found titles, then an empty search, then a not_found finish).
      idleDiscovered = !progressed && (idleDiscovered || entries.size > entriesBefore);
      if (idleSteps >= (idleDiscovered ? 3 : 2)) { researchStop = 'no_progress'; break; }
    }
    if (plan.length === 0) plan = proposedPlan([{ question: partQuestion(goal.kind === "question" ? goal.question : goal.task), needs: [], notes: "" }]);
  };
  /** Everything research gathered, as the server holds it; built once research stops. */
  const evidenceBundle = (gate: AgenticModelGateV1, researchStartedAt: number): Omit<AgenticEvidenceBundleV1, "trigger"> => {
    const cited = citedShorts();
    const observed = options.observed();
    const { calls, repairs, generations, invocation_digests } = gate.stats();
    const usage = (field: "input_tokens" | "output_tokens" | "total_tokens"): number | null => {
      const values = generations.filter(entry => entry.role === "step").map(entry => entry.usage?.[field]);
      return values.length === 0 || values.some(value => typeof value !== "number") ? null : values.reduce<number>((total, value) => total + (value as number), 0);
    };
    const items: AgenticEvidenceBundleItemV1[] = [...entries.values()].sort((left, right) => Number(left.short.slice(1)) - Number(right.short.slice(1))).map(entry => Object.freeze({
      short: entry.short, source: selectorOf(entry.item), item: entry.item,
      full: entry.full, opened: entry.opened, preloaded: entry.preloaded === true, touched: entry.touched,
      ...(entry.query === undefined ? {} : { query: entry.query }), cited_by_plan: cited.has(entry.short),
    }));
    // A question goal's lists (ADR-0041); the renderer tells the person about the filters of those its answer names.
    const listRecords = ask ? listsInOrder().map(state => listEvidence(state)) : [];
    return Object.freeze({
      schema_version: 1 as const, kind: "echo-agentic-evidence-bundle-v1" as const, goal, budget,
      plan: planView() as readonly AgenticResearchPartV1[], items: Object.freeze(items), ...(ask ? { lists: Object.freeze(listRecords) } : {}),
      unreadable_starting: Object.freeze([...unreadableStarting]), rounds: Object.freeze([...rounds]),
      coverage: Object.freeze({ reads: Object.freeze(readCoverage.map(read => Object.freeze({ ...read }))), inventories: Object.freeze(inventoryView().map(({ args, ...inventory }) => Object.freeze({ source: args.source, ...inventory }))), notices: Object.freeze([...notice]) }),
      stop: Object.freeze({ reason: researchStop, completed: !researchIncomplete, ...(researchAdmission === undefined ? {} : { admission: researchAdmission }) }),
      cost: Object.freeze({ rounds: steps, model_calls: calls, repairs, fallbacks, input_tokens: usage("input_tokens"), output_tokens: usage("output_tokens"), total_tokens: usage("total_tokens"),
        model_ms: Math.max(0, Math.round(observed.model_ms)), desk_ms: Math.max(0, Math.round(observed.desk_ms)), elapsed_ms: Math.max(0, Math.round(now() - researchStartedAt)) }),
      gathered_for: Object.freeze({ scope: desk.scope, checked_at: observed.checked_at }),
      server: Object.freeze({ receipts: Object.freeze([...receipts]), invocation_digests, generations }),
    });
  };

  return Object.freeze({
    gate_hooks: Object.freeze({
      // Only an admitted research call makes a complete body read. Retrieval,
      // opening, and scratchpad construction alone cannot satisfy a need.
      before_call: (role: AgenticAskModelRoleV1) => {
        if (role !== 'step') return;
        // A repair's call ends the call before it.
        settleStepCall(); stepCallStartedAt = options.observed().model_ms;
        for (const entry of researchPromptEntries) {
          if (!entry.full) evidenceNovelty += 1;
          entry.full = true;
        }
        // Everything the call shows, text or row, has been shown to research: a list counts once every member has (ADR-0041).
        for (const entry of researchPromptShown) entry.shown = true;
        // This call's access check has passed: the items it reads in full may now be named (ADR-0039), and every item it
        // shows, row or text, counts as looked through (ADR-0043).
        const direct = (prompted: readonly Entry[]) => prompted.filter(entry => entry.direct === true).map(entry => entry.item);
        report?.given(direct(researchPromptEntries), direct(researchPromptShown));
      },
    }),
    progress: () => Object.freeze({
      receipts, rounds: steps, fallbacks, searches: searchesRun.length, search_hits: searchHits, retrieved_tickets: retrievedTickets.size,
      refused_reads: refusedReadsCount, repeated_refusals: repeatedRefusals, unchecked_items: uncheckedItems, sources_looked_at: sourcesLookedAt.size, most_reads_in_a_step: mostReadsInAStep,
    }),
    async run(gate: AgenticModelGateV1) {
      const researchStartedAt = now();
      await research(gate);
      return evidenceBundle(gate, researchStartedAt);
    },
  });
}
