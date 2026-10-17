import { askResearchCompletionProblemsV1, type AskResearchObservationV1 } from './agentic-ask-research-state-v1.js';
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  evidenceDeskSourceV2,
  type EvidenceDeskItemV2,
  type EvidenceDeskKindV2,
  type EvidenceDeskListInputV2,
  type EvidenceDeskPortV2,
  type EvidenceDeskResultV2,
  type EvidenceDeskSourceV2,
} from "../shared/evidence-desk-v2.js";
import {
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
  type StepPart,
  type StepSource,
} from "./agentic-ask-v1-model-protocol.js";
import { fillAgenticTaskV1, type AgenticBriefV1 } from "./agentic-brief-v1.js";
import { describeAgenticEvidenceItemV1, type AgenticEvidenceBundleItemV1, type AgenticEvidenceBundleV1 } from "./agentic-evidence-bundle-v1.js";
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
 * access-checked desk, then the optional small-scope preload, then planner
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
const SHORTCUT_ITEMS = 20;
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
}

/** One source as the research model sees it in `source_catalog`: its selector and capabilities, never its desk id or kinds. */
export type AgenticResearchCatalogEntryV1 = {
  readonly description: string;
  readonly metadata_only_list?: boolean;
  readonly tool_id?: string;
  readonly requires_channel?: boolean;
  readonly default_since_days?: number;
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
  readonly context: { readonly asked_by?: string; readonly today: string };
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
  /** Loaded before round 1: starting evidence or the small-scope preload. */
  preloaded?: boolean;
  touched: number;
  /** The latest search that returned this item; its preview shows where that search matched. */
  query?: string;
};
type ToolResult = Readonly<Record<string, unknown>>;
/** A completed desk read waits here until earlier planned reads have updated state. */
type OrderedAdmission = (apply: () => ToolResult) => Promise<ToolResult>;
/**
 * Code-owned plan state. A need leaves the plan only by being marked found or not_found. Its id (N1, N2, ...) never
 * changes, so a step can reword a need and still settle it; its wording stays the one first planned.
 */
type NeedState = { readonly id: string; readonly need: string; status: NeedStatus; evidence: readonly string[]; readonly observations_before: number };
type PartState = { readonly question: string; notes: string; readonly needs: NeedState[] };
type ListState = { args: StepArgs; readonly source: EvidenceDeskSourceV2; readonly unfiltered: boolean; items: EvidenceDeskItemV2[]; cursor: string | undefined; fetched: boolean; shown: number; truncated: boolean; available: boolean; note?: string };
/** An inventory has more to show: listed items not yet shown, or another page. */
function inventoryMore(state: ListState): boolean { return state.shown < state.items.length || state.cursor !== undefined; }
/** Identity of a cited object independent of the version or text released this time. */
function citationIdentity(value: unknown): string {
  const citation = object(value) ?? {};
  const pick = ["kind", "tool_id", "atom_id", "ticket_id", "page_id", "document_id", "upload_id", "transcript_id", "channel_id", "message_ts"].filter(key => typeof citation[key] === "string");
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
function listDate(value: string, today: string): string | null {
  const text = value.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? null : text;
  const relative = /^(\d{1,3})\s*(d|day|days|w|wk|week|weeks|m|mo|month|months)$/u.exec(text);
  if (relative === null) return null;
  const amount = Number(relative[1]);
  const unit = relative[2]!.startsWith("w") ? 7 : relative[2]!.startsWith("m") ? 30 : 1;
  const base = new Date(`${today}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - amount * unit);
  return isoDay(base);
}
type ListArgs = { readonly source: EvidenceDeskSourceV2; readonly kinds?: readonly EvidenceDeskKindV2[]; readonly status?: "open" | "done"; readonly owner?: string; readonly channel?: string; readonly since?: string; readonly until?: string; readonly notes: readonly string[] };
/** One inventory per normalized selection: notes never start another, and owner matching ignores case. */
function listKey({ notes: _notes, status, owner, ...request }: ListArgs): string {
  return JSON.stringify({ ...request, status: status ?? null, owner: owner?.toLowerCase() ?? null });
}
function normalizeListArgs(raw: StepArgs, today: string, sources: ReadonlyMap<string, AgenticResearchSourceV1>, readSource: (value: string | undefined) => string | undefined): ListArgs | { readonly error: string } {
  const source = readSource(raw.source);
  if (source === undefined) return { error: `source must be ${[...sources.values()].map(value => value.selector).join(", ")}` };
  const descriptor = sources.get(source)!;
  const notes: string[] = [];
  let kinds: EvidenceDeskKindV2[] | undefined;
  if (raw.kind !== undefined) {
    const kind = MEETING_KINDS[raw.kind.trim().toLowerCase()];
    if (source !== "meeting") notes.push("kind applies to meetings only; ignored");
    else if (kind === undefined) return { error: "kind must be \"decision\", \"action\" or \"rationale\"" };
    else kinds = [kind];
  }
  let status: "open" | "done" | undefined;
  if (raw.status !== undefined) {
    const group = statusGroup(raw.status);
    if (source !== "meeting") notes.push("status applies to meeting actions only; ignored");
    else if (group === null) return { error: "status must be \"open\" or \"done\"" };
    else { status = group; kinds ??= ["action"]; }
  }
  let owner: string | undefined;
  if (raw.owner !== undefined) {
    const name = raw.owner.trim().replace(/^@/u, "").trim();
    if (source !== "meeting") notes.push("owner applies to meeting actions only; ignored");
    else if (name.length === 0 || name.length > 80) return { error: "owner must be a person's name such as \"Dana\"" };
    else { owner = name; kinds ??= ["action"]; }
  }
  let channel: string | undefined;
  if (raw.channel !== undefined) {
    const name = raw.channel.trim().replace(/^#/u, "").trim();
    if (!descriptor.requires_channel) notes.push("channel is unsupported by this source; ignored");
    else if (name.length === 0 || name.length > 80) return { error: "channel must be a channel name such as \"hw-dvt\"" };
    else channel = name;
  }
  if (descriptor.requires_channel && channel === undefined) return { error: `${descriptor.selector} needs a channel, such as ${JSON.stringify({ source: descriptor.selector, channel: "hw-dvt" })}` };
  const since = raw.since === undefined ? undefined : listDate(raw.since, today);
  const until = raw.until === undefined ? undefined : listDate(raw.until, today);
  if ((raw.since !== undefined && since === null) || (raw.until !== undefined && until === null)) return { error: "since and until take a date like 2026-09-21 or an age like 7d or 2w" };
  const defaultSince = descriptor.default_since_days !== undefined && since === undefined ? listDate(`${descriptor.default_since_days}d`, today)! : since ?? undefined;
  return {
    source, notes,
    ...(kinds === undefined ? {} : { kinds }), ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }), ...(channel === undefined ? {} : { channel }),
    ...(defaultSince === undefined ? {} : { since: defaultSince }), ...(until === undefined || until === null ? {} : { until }),
  };
}

/**
 * One request's research. Its state lives here; the runner reads it only
 * through `progress()` and the bundle `run` returns.
 */
export function createAgenticResearchLoopV1(options: CreateAgenticResearchLoopV1Options): AgenticResearchLoopV1 {
  const { desk, brief, context, scope, now, remaining, assert_live: assertLive, signal: activeSignal } = options;
  const { prompt: researchPrompt, prompt_budget: researchBudget } = options;
  const { by_id: sourcesById, resolve: readSource } = options.catalog;
  /** A search-only brief has no list tool, and its catalog shows nothing only list uses. */
  const listAvailable = brief.options.list !== false;
  const sourceCatalog: readonly AgenticResearchCatalogEntryV1[] = listAvailable ? options.catalog.entries
    : Object.freeze(options.catalog.entries.map(({ metadata_only_list: _metadata, requires_channel: _channel, default_since_days: _since, ...entry }) => Object.freeze(entry)));
  const budget = brief.budget;
  /** Research steps: the audit records them as `step` calls, in the span the runner names. */
  const stepCall: AgenticModelCallV1 = Object.freeze({ role: "step", span: options.step_span });
  const requestDay = context.today;
  let fallbacks = 0; let steps = 0; let searchHits = 0;
  const receipts: Sha256Digest[] = [];
  const notice = new Set<string>();
  const entries = new Map<string, Entry>();
  const retrievedTickets = new Set<string>();
  const byShort = new Map<string, string>();
  const searchesRun: { readonly query: string; readonly source?: EvidenceDeskSourceV2 }[] = [];
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
  const lists = new Map<string, ListState>();
  /** Items whose latest open was truncated or carried a notice. */
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
    // Audits bind every released item, even one that never reaches a prompt.
    for (const item of result.items) if (!receipts.includes(item.receipt_sha256)) receipts.push(item.receipt_sha256);
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
      if (item.text !== undefined && existing.item.text === undefined) { existing.item = item; evidenceNovelty += 1; }
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
  const describe = (entry: Entry): Record<string, unknown> => describeAgenticEvidenceItemV1({ short: entry.short, source: selectorOf(entry.item), item: entry.item });
  /** Released source projections for automatic starting/preload reads, before short ids are assigned. */
  const releasedView = (result: EvidenceDeskResultV2): Record<string, unknown> => ({
    released_items: result.items.map(item => {
      const { id: _id, ...metadata } = describeAgenticEvidenceItemV1({ short: '', source: selectorOf(item), item });
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
    if (searchesRun.some(previous => previous.source === source && previous.query.toLowerCase() === query.toLowerCase())) return { tool: "search", query, ...(source === undefined ? {} : { source }), note: "already searched; results are in your scratchpad" };
    searchesRun.push({ query, ...(source === undefined ? {} : { source }) });
    const result = await raceAbort(signal, desk.search({ query, ...(source === undefined ? {} : { source, kinds: sourcesById.get(source)!.kinds }), limit: SEARCH_LIMIT, signal }));
    const apply = () => {
      observe(result);
      cover('search', source, result);
      const complete = !result.truncated && result.notice === undefined;
      researchObservations.push({ operation: 'search', fingerprint: JSON.stringify({ query: query.toLowerCase(), source: source ?? null }), complete });
      if (complete) searchedSources.add(source ?? null);
      retrievalProgress += 1;
      const found = result.items.map(item => register(item));
      for (const entry of found) entry.query = query;
      searchHits += found.length;
      return { tool: "search", query, ...(source === undefined ? {} : { source }), results: found.map(entry => describe(entry)), ...(found.length === 0 ? { note: "no matches" } : {}), ...(result.truncated ? { truncated: true } : {}), ...(result.notice === undefined ? {} : { notice: result.notice }) };
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
    // not read again (the access check before every model call already covers it), and adds nothing new. An item a
    // truncated or noticed open returned is still read again: only a clean open of it resolves that limit.
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
      const admitted: Entry[] = [];
      let used = 0;
      for (const item of anchor === undefined ? others : [anchor, ...others]) {
        if (admitted.length > OPEN_EXTRA_ITEMS || (admitted.length > 0 && used + bytes(item.text) > OPEN_BYTES)) break;
        const opened = register(item);
        if (!opened.full || !opened.opened) { retrievalProgress += 1; evidenceNovelty += 1; }
        opened.opened = true; used += bytes(item.text);
        admitted.push(opened);
        if (result.truncated || result.notice !== undefined) limitedOpens.add(item.id); else limitedOpens.delete(item.id);
      }
      if (anchor !== undefined) anchorsRead.add(anchor.id);
      // Open may also release continuation metadata. Register it beside
      // the bounded text, without treating the continuation as read evidence.
      const metadata = result.items
        .filter(item => item.text === undefined && item.id !== entry.item.id)
        .map(item => register(item));
      return { tool: "open", id: entry.short, opened: admitted.map(value => value.short), ...(metadata.length === 0 ? {} : { results: metadata.map(value => describe(value)) }), ...(result.truncated ? { truncated: true } : {}), ...(result.notice === undefined ? {} : { notice: result.notice }), ...(admitted.length === 0 ? { note: "no readable text" } : {}) };
    };
    return admit === undefined ? apply() : admit(apply);
  };
  const list = async (args: StepArgs, admit?: OrderedAdmission, signal: AbortSignal = activeSignal): Promise<ToolResult> => {
    if (!listAvailable) return { tool: "list", args, error: LIST_UNAVAILABLE };
    const normalized = normalizeListArgs(args, requestDay, sourcesById, readSource);
    if ("error" in normalized) return { tool: "list", args, error: normalized.error };
    const { notes, status, owner, ...request } = normalized;
    const key = listKey(normalized);
    let state = lists.get(key);
    if (state === undefined) {
      const stateArgs: StepArgs = Object.freeze({
        source: sourcesById.get(request.source)!.selector, ...(request.kinds?.[0] === undefined ? {} : { kind: request.kinds[0] }),
        ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }),
        ...(request.channel === undefined ? {} : { channel: request.channel }), ...(request.since === undefined ? {} : { since: request.since }), ...(request.until === undefined ? {} : { until: request.until }),
      });
      const unfiltered = request.kinds === undefined && status === undefined && owner === undefined &&
        request.channel === undefined && request.since === undefined && request.until === undefined;
      state = { args: stateArgs, source: request.source, unfiltered, items: [], cursor: undefined, fetched: false, shown: 0, truncated: false, available: true };
      lists.set(key, state);
    }
    const currentState = state;
    let result: EvidenceDeskResultV2 | undefined;
    const before = { cursor: state.cursor, shown: state.shown, fetched: state.fetched };
    if (state.shown >= state.items.length && (!state.fetched || state.cursor !== undefined)) {
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
        if (!currentState.fetched || result.next_cursor !== currentState.cursor) retrievalProgress += 1;
        currentState.fetched = true; currentState.cursor = result.next_cursor; currentState.truncated = result.truncated;
        // A status filter applies only where an item records a status; approved actions usually record owner and
        // due date but not completion, so an item without a status is kept (never silently dropped as "not open").
        const statusOf = (item: EvidenceDeskItemV2) => item.attributes?.status === undefined ? null : statusGroup(item.attributes.status);
        const wanted = owner?.toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
        const ownerMatches = (item: EvidenceDeskItemV2) => {
          const recorded = item.attributes?.owner?.toLowerCase();
          return recorded !== undefined && wanted.every(part => recorded.includes(part));
        };
        currentState.items.push(...result.items.filter(item => (status === undefined || statusOf(item) === null || statusOf(item) === status) && (owner === undefined || ownerMatches(item))));
        if (status !== undefined && result.items.some(item => item.attributes?.status === undefined)) currentState.note = "some items do not record open or done; they are included";
        if (owner !== undefined && currentState.items.length === 0 && result.items.length > 0) currentState.note = `no listed item records ${owner} as owner; owners shown are exact names from the records`;
      }

      const page = currentState.items.slice(currentState.shown, currentState.shown + LIST_PAGE).map(item => register(item));
      currentState.shown += page.length;
      if (page.length > 0) retrievalProgress += 1;
      const more = inventoryMore(currentState);
      if (currentState.unfiltered && currentState.available && !more && !currentState.truncated && currentState.items.length === 0) exhaustivelyEmptySources.add(request.source);
      if (!before.fetched || before.shown !== currentState.shown || before.cursor !== currentState.cursor) researchObservations.push({ operation: 'list', fingerprint: key, complete: currentState.available && !more && !currentState.truncated });
      // An empty page is never "nothing more" while pages remain: a filter applied after each page can empty one. A repeat
      // of an inventory read to its end makes no desk call and no progress, and says so; only a complete one is "in full".
      const emptyNote = page.length > 0 ? [] : more ? ["this page was empty (for example because of a date filter); more pages remain"]
        : result !== undefined ? ["nothing more to list"]
        : !currentState.available ? ["already listed; this source was unavailable, so its list is incomplete; use search"]
        : currentState.truncated ? ["already listed; nothing more to list"] : ["already listed in full; nothing more to list"];
      const allNotes = [...notes, ...(currentState.note === undefined ? [] : [currentState.note]), ...emptyNote, ...(!more && currentState.truncated ? ["more items exist than list can show; use search"] : [])];
      return { tool: "list", source: request.source, ...(request.channel === undefined ? {} : { channel: request.channel }), ...(request.since === undefined ? {} : { since: request.since }), items: page.map(entry => describe(entry)), more, ...(allNotes.length === 0 ? {} : { note: allNotes.join("; ") }) };
    };
    return admit === undefined ? apply() : admit(apply);
  };
  /**
   * A read's result as the next step sees it in last_results, and as its tool_response records it: the call, what it
   * returned by id in rank order, and its page state, notes and errors. Item descriptors and bodies are in opened and
   * seen, never repeated here.
   */
  const lastResult = (action: StepAction, value: ToolResult): ToolResult => {
    const ids = (key: "results" | "items") => (value[key] as readonly Record<string, unknown>[]).map(row => row.id);
    return Object.freeze({
      tool: action.tool, args: action.args,
      ...(Array.isArray(value.opened) ? { opened: value.opened } : {}),
      ...(Array.isArray(value.results) ? { results: ids("results") } : {}), ...(Array.isArray(value.items) ? { items: ids("items") } : {}),
      ...(typeof value.more === "boolean" ? { more: value.more } : {}), ...(value.truncated === true ? { truncated: true } : {}),
      ...(typeof value.notice === "string" ? { notice: value.notice } : {}), ...(typeof value.note === "string" ? { note: value.note } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    });
  };
  let toolCalls = 0;
  const run = async (action: StepAction, admit?: OrderedAdmission, signal?: AbortSignal): Promise<ToolResult> => {
    // Only planner-selected reads enter this function; finish has no tool result.
    const tool = action.tool === 'search' || action.tool === 'open' ? action.tool : 'list';
    const identity = { tool_call_id: ++toolCalls, round: steps, tool } as const;
    return withCoreRuntimeDiagnosticToolV1(identity, async () => {
    observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', ...identity, args: action.args });
    try {
      const result = lastResult(action, await (tool === 'search' ? search(action.args, admit, signal) : tool === 'open' ? open(action.args, admit, signal) : list(action.args, admit, signal)));
      observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', ...identity, result });
      return result;
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
    const tasks = actions.map((action, index) => {
      let key: string | undefined;
      if (action.tool === 'list') {
        const normalized = normalizeListArgs(action.args, requestDay, sourcesById, readSource);
        if (!('error' in normalized)) key = listKey(normalized);
      }
      const previous = key === undefined ? undefined : listTasks.get(key);
      const task = (async () => {
        try {
          if (previous !== undefined) await previous;
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
    const newNeed = (need: string, status: NeedStatus, evidence: readonly string[]): NeedState =>
      ({ id: `N${++ids}`, need, status, evidence, observations_before: researchObservations.length });
    const newPart = (part: StepPart): PartState => ({
      question: part.question, notes: part.notes,
      // A part without needs still needs its own answer.
      needs: part.needs.length > 0 ? part.needs.map(need => newNeed(need.need, need.status, need.evidence)) : [newNeed(part.question, "open", [])],
    });
    if (parts.length === 0) return next;
    if (next.length === 0) return parts.map(newPart);
    const updated = new Set<NeedState>();
    for (const [index, part] of parts.entries()) {
      const existing = next[index];
      if (existing === undefined) { next.push(newPart(part)); continue; }
      if (part.notes.length > 0) existing.notes = part.notes;
      for (const need of part.needs) {
        // The same need by its id, in whichever part, or else by its wording in this part (005d7876: a reworded need
        // with no id left the original open, so a correct finish was refused). The first proposal for a need wins.
        const match = (need.id === undefined ? undefined : next.flatMap(value => value.needs).find(value => value.id === need.id))
          ?? existing.needs.find(value => needKey(value.need) === needKey(need.need));
        if (match !== undefined) {
          if (updated.has(match)) continue;
          updated.add(match); match.status = need.status; match.evidence = need.evidence;
        } else if (existing.needs.length < AGENTIC_ASK_MAX_NEEDS_PER_PART_V1) existing.needs.push(newNeed(need.need, need.status, need.evidence));
      }
    }
    return next;
  };
  /** The plan as the bundle and rounds record it; a step is also shown each need's id. */
  const planView = (ids = false) => plan.map((part, index) => ({
    part: index + 1, question: part.question, notes: part.notes,
    needs: part.needs.map(need => ({ ...(ids ? { id: need.id } : {}), need: need.need, status: need.status, evidence: need.evidence })),
  }));
  /** Listed inventories continue across planner turns without exposing cursors or desk identities. */
  const inventoryView = () => [...lists.values()].filter(state => state.fetched).map(state => Object.freeze({
    args: state.args, shown_count: state.shown, more: inventoryMore(state),
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
    const covered = new Set(fetched.filter(state => state.unfiltered && state.available && !state.truncated && !inventoryMore(state)).map(state => state.source));
    const searched = (source: EvidenceDeskSourceV2) => searchedSources.has(null) || searchedSources.has(source);
    return fetched.filter(state => inventoryMore(state) && !covered.has(state.source) && !(sourcesById.get(state.source)?.metadata_only_list === true && searched(state.source)));
  };

  // ---- scratchpad ------------------------------------------------------
  const citable = (short: string): boolean => entryOf(short)?.full === true;
  const citedShorts = () => new Set(plan.flatMap(part => part.needs.flatMap(need => need.evidence)).filter(citable));
  let researchPromptEntries: readonly Entry[] = [];
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
  const roundView = (tool: string, args: StepArgs, value: ToolResult | undefined): AgenticResearchActionV1 => {
    const listed = (key: string) => Array.isArray(value?.[key]) ? (value![key] as readonly unknown[]).map(String) : [];
    const opened = Array.isArray(value?.opened) ? (value!.opened as readonly string[]) : [];
    return Object.freeze({ tool, args: Object.freeze({ ...args }), result: Object.freeze({
      items: [...listed("results"), ...listed("items")], opened: [...opened],
      ...(typeof value?.note === "string" ? { note: value.note } : {}), ...(typeof value?.error === "string" ? { error: value.error } : {}),
      ...(value?.truncated === true ? { truncated: true } : {}), ...(typeof value?.more === "boolean" ? { more: value.more } : {}),
      ...(typeof value?.notice === "string" ? { notice: true } : {}),
    }) });
  };
  const recordRound = (startedAt: number, actions: readonly AgenticResearchActionV1[]) => {
    rounds.push(Object.freeze({ round: rounds.length + 1, elapsed_ms: Math.max(0, Math.round(now() - startedAt)), plan: planView() as readonly AgenticResearchPartV1[], actions: Object.freeze([...actions]), rejected: Object.freeze([...stepRejections]) }));
    stepRejections = [];
  };
  /** The goal as the model sees it: a task's slots are filled once its starting items are read. */
  let goal: AgenticResearchGoalV1 = brief.goal;
  const goalFields = (): Record<string, unknown> => goal.kind === "question" ? { question: goal.question } : { task: goal.task };

  /** The research phase: optional preload, then the loop until a stop rule fires. */
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
        if (item === anchor) startingIds.push(entry.short);
      }
      if (anchor.citation.kind !== "source_revision") anchorsRead.add(anchor.id);
      for (const item of opened.items.filter(value => value.text === undefined)) register(item);
    }
    if (brief.goal.kind === "task") goal = Object.freeze({ kind: "task", task: fillAgenticTaskV1(brief.goal.task, startingIds, brief.goal.data) });

    // ---- optional small-scope preload -----------------------------------
    if (brief.options.small_scope_preload) {
      assertLive();
      const inventory = await observeAgenticLifecycleV1('preload', 'research_preload', { operation: 'search', limit: SHORTCUT_ITEMS, inventory_mode: 'items' },
        () => raceAbort(activeSignal, desk.search({ limit: SHORTCUT_ITEMS, inventory_mode: "items", signal: activeSignal })), releasedView);
      observe(inventory);
      cover('search', undefined, inventory);
      if (!inventory.truncated && inventory.items.length <= SHORTCUT_ITEMS) {
        let used = 0;
        for (const listed of inventory.items) {
          assertLive();
          const opened = await observeAgenticLifecycleV1('preload', 'research_preload', { operation: 'open', citation: listed.citation },
            () => raceAbort(activeSignal, desk.open({ item: listed.id, signal: activeSignal })), releasedView);
          observe(opened);
          cover('open', evidenceDeskSourceV2(listed), opened);
          const exact = opened.items.find(item => item.id === listed.id && item.text !== undefined);
          if (exact === undefined || used + bytes(exact.text) > researchBudget / 2) continue;
          const entry = register(exact); entry.opened = true; entry.preloaded = true; used += bytes(exact.text);
        }
      }
    } else observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'preload', event: 'skipped' });

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
      const tail = { step: steps + 1, steps_left: budget.max_rounds - steps - 1, plan: planView(true), inventories: inventoryView(), last_results: results, searches_done: [...searchesRun] };
      const pad = scratchpad(researchBudget - bytes(JSON.stringify({ ...head, opened: [], seen: [], ...tail })), latest);
      researchPromptEntries = pad.read;
      const user = { ...head, opened: pad.opened, seen: pad.seen, ...tail };
      const openIds = [...entries.values()].map(entry => entry.short);
      const finishAvailable = researchObservations.length > 0 || pad.read.length > 0 || [...entries.values()].some(entry => entry.full);
      const stepSchema = createStepSchema(sourceCatalog.map(source => source.source), openIds, finishAvailable, listAvailable);
      let step: Step;
      try {
        step = await gate.withRepair(stepCall, researchPrompt, user, stepSchema, stepTimeout, value => {
          const parsed = parseStep(value);
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
            const problems = [...askResearchCompletionProblemsV1(completionPlan, researchObservations, citable, listAvailable)];
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
      const before = hadCitableEvidence ? evidenceNovelty : retrievalProgress;
      const entriesBefore = entries.size;
      results = await runReads(reads);
      const actions = reads.map((action, index) => roundView(action.tool, action.args, results[index]));
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
      const progressed = (hadCitableEvidence ? evidenceNovelty : retrievalProgress) > before;
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
    return Object.freeze({
      schema_version: 1 as const, kind: "echo-agentic-evidence-bundle-v1" as const, goal, budget,
      plan: planView() as readonly AgenticResearchPartV1[], items: Object.freeze(items), unreadable_starting: Object.freeze([...unreadableStarting]), rounds: Object.freeze([...rounds]),
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
      },
    }),
    progress: () => Object.freeze({ receipts, rounds: steps, fallbacks, searches: searchesRun.length, search_hits: searchHits, retrieved_tickets: retrievedTickets.size }),
    async run(gate: AgenticModelGateV1) {
      const researchStartedAt = now();
      await research(gate);
      return evidenceBundle(gate, researchStartedAt);
    },
  });
}
