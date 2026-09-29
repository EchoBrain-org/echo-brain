import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  PersonAnswerCitationV4,
  PersonAnswerEvidenceFallbackV4,
  PersonAnswerPartV4,
  PersonAnswerResponseV4,
  PersonAnswerStatementV4,
} from "@echo-brain/organization-api";
import type { AnswerCompositionGenerationProfileV1 } from "../composition/answer-composition-generation-bundle-v1.js";
import type {
  StructuredGenerationInput,
  StructuredGenerationJsonSchema,
  StructuredGenerationPort,
  StructuredGenerationUsageV1,
} from "./retrieval-grounded-answer-composition.js";
import {
  evidenceDeskSourceV1,
  type EvidenceDeskItemV1,
  type EvidenceDeskKindV1,
  type EvidenceDeskListInputV1,
  type EvidenceDeskPortV1,
  type EvidenceDeskResultV1,
  type EvidenceDeskSourceV1,
} from "../shared/evidence-desk-v1.js";
import { withoutCoreRuntimeContentV1 } from "../shared/core-runtime-observation-v1.js";
import {
  ANSWER_PROMPT,
  AGENTIC_ASK_MAX_NEEDS_PER_PART_V1,
  AgenticAskOutputErrorV1,
  STEP_PROMPT,
  answerSchema,
  cleanId,
  cleanLine,
  normalizeQuery,
  parseAnswer,
  parseStep,
  repairPrompt,
  stepSchema,
  type Answer,
  type NeedStatus,
  type Step,
  type StepAction,
  type StepArgs,
  type StepPart,
} from "./agentic-ask-v1-model-protocol.js";
import { compactAndValidateAgenticAskResponseV1 } from "./agentic-ask-v1-response.js";

export {
  AGENTIC_ASK_MAX_ACTIONS_PER_STEP_V1,
  AGENTIC_ASK_MAX_PARTS_V1,
  AgenticAskOutputErrorV1,
} from "./agentic-ask-v1-model-protocol.js";

/**
 * Agentic Ask (RFC-0003): one research loop over three read tools (search,
 * open, list) plus `finish`, then one answer call. The model plans parts and
 * the needs of each part; code owns scope, permissions, ids, budgets, paging,
 * de-duplication, the stop rules, and the response layout.
 */
export const AGENTIC_ASK_MAX_STEPS_V1 = 10;
/** Request-wide model-call budget, including retries and repairs. */
export const AGENTIC_ASK_MAX_MODEL_CALLS_V1 = 24;
/** Quality first: generous enough that a slow provider call can finish (per-call time is also capped by the generation profile). */
export const AGENTIC_ASK_DEADLINE_MS_V1 = 180_000;
/** Time kept for the final answer call; research never starts inside it. */
export const AGENTIC_ASK_ANSWER_RESERVE_MS_V1 = 60_000;
/** Time kept after the answer call for final revalidation and the audit. */
export const AGENTIC_ASK_FINALIZE_RESERVE_MS_V1 = 2_000;
export const AGENTIC_ASK_STEP_TIMEOUT_MS_V1 = 60_000;
export const AGENTIC_ASK_MIN_STEP_MS_V1 = 4_000;
export const AGENTIC_ASK_MIN_ANSWER_MS_V1 = 3_000;
export const AGENTIC_ASK_SEARCH_LIMIT_V1 = 8;
export const AGENTIC_ASK_LIST_PAGE_V1 = 25;
export const AGENTIC_ASK_LIST_FETCH_V1 = 50;
export const AGENTIC_ASK_PREVIEW_CHARS_V1 = 240;
/** Context items an `open` may admit beyond its anchor (a Slack thread returns up to 20 replies). */
export const AGENTIC_ASK_OPEN_EXTRA_ITEMS_V1 = 20;
/** Document passages on each side of an opened passage (desk maximum). */
export const AGENTIC_ASK_OPEN_NEIGHBOURS_V1 = 2;
export const AGENTIC_ASK_OPEN_BYTES_V1 = 24 * 1024;
export const AGENTIC_ASK_SHORTCUT_ITEMS_V1 = 20;
/** Context window assumed when the generation profile does not state one. */
export const AGENTIC_ASK_DEFAULT_CONTEXT_TOKENS_V1 = 32_768;
/** Conservative bytes per token for prompt budgeting. */
const BYTES_PER_TOKEN = 3;
/** Share of the context window left unused as a safety margin. */
const CONTEXT_MARGIN = 0.1;
const MAX_SEEN_ENTRIES = 300;
const OUTPUT_TOKENS = Object.freeze({ step: 1_500, answer: 1_500 } as const);
const NOT_FOUND_GAP = "I couldn't find this in the sources you can access.";
const RECORDS_GAP = "I found these records, but could not write a verified summary in time.";

/** Scratchpad bytes that fit beside a system prompt and an output reserve in the model's context window. */
export function agenticAskContextBudgetBytesV1(contextTokens: number | undefined, systemPrompt: string, outputTokens: number): number {
  const tokens = typeof contextTokens === "number" && Number.isSafeInteger(contextTokens) && contextTokens > 0 ? contextTokens : AGENTIC_ASK_DEFAULT_CONTEXT_TOKENS_V1;
  const usable = Math.floor(tokens * (1 - CONTEXT_MARGIN)) - Math.ceil(Buffer.byteLength(systemPrompt, "utf8") / BYTES_PER_TOKEN) - outputTokens;
  return Math.max(16 * 1024, usable * BYTES_PER_TOKEN);
}

/** The hard request deadline elapsed before a release-safe response could finish. */
export class AgenticAskDeadlineErrorV1 extends Error {
  constructor() {
    super("agentic Ask deadline exhausted");
    this.name = "AgenticAskDeadlineErrorV1";
  }
}

/** A provider produced no usable value. `retry` is true only for invalid output. */
class AgenticAskGenerationFailureV1 extends AgenticAskOutputErrorV1 {
  constructor(message: string, readonly retry: boolean) { super(message); }
}

export type AgenticAskStatementV1 = PersonAnswerStatementV4;
export type AgenticAskRecordFallbackV1 = PersonAnswerEvidenceFallbackV4;
export type AgenticAskPartV1 = PersonAnswerPartV4;
export type AgenticAskCitationV1 = PersonAnswerCitationV4;
export type AgenticAskResultV1 = PersonAnswerResponseV4;
export type AgenticAskModelRoleV1 = "step" | "answer";

/** Content-free terminal witness. Route adapters bind identity and storage details. */
export interface AgenticAskAuditEntryV1 {
  readonly kind: "echo-agentic-ask-audit-v1";
  readonly outcome: AgenticAskResultV1["outcome"] | "cancelled" | "timed_out";
  readonly receipt_digests: readonly Sha256Digest[];
  /** Research steps run. */
  readonly rounds: number;
  readonly model_calls: number;
  readonly repairs: number;
  readonly fallbacks: number;
  readonly citation_count: number;
  readonly checked_at: string | null;
  /** Hashes bind terminal output without retaining question, evidence, or prose. */
  readonly prompt_sha256: Sha256Digest | null;
  readonly answer_sha256: Sha256Digest | null;
  readonly response_sha256: Sha256Digest | null;
  /** Provider metadata only. It deliberately carries no prompt, output, or evidence. */
  readonly generations: readonly AgenticAskGenerationObservationV1[];
  readonly generation_usage: { readonly input_tokens: number | null; readonly output_tokens: number | null; readonly total_tokens: number | null };
  readonly finish_reason_counts: Readonly<Record<string, number>>;
}

export interface AgenticAskGenerationObservationV1 {
  readonly role: AgenticAskModelRoleV1;
  readonly finish_reason: string | null;
  readonly usage: StructuredGenerationUsageV1 | null;
}

export interface AgenticAskAuditPortV1 {
  append(entry: AgenticAskAuditEntryV1): Promise<unknown> | unknown;
}

export interface CreateAgenticAskV1Options {
  readonly desk: EvidenceDeskPortV1;
  readonly model: StructuredGenerationPort;
  /** The existing provider binding; every role uses answer_model. */
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly audit: AgenticAskAuditPortV1;
  /** Monotonic milliseconds, supplied by tests or the route telemetry clock. */
  readonly now_ms?: () => number;
  /** Today's date (YYYY-MM-DD) for relative `list` dates; tests pin it. */
  readonly today?: () => string;
  /** When the whole readable scope is small, open it all before step 1. */
  readonly small_scope_shortcut?: boolean;
  /**
   * Who is asking, as the organization's directory names them, so "I", "me"
   * and "my" resolve to a person. Only the models see it; audits never do.
   */
  readonly asker?: { readonly display_name: string };
}

/** A directory name the prompts may carry: one trimmed line of 1 to 200 characters, or none. */
function askerName(value: { readonly display_name: string } | undefined): string | undefined {
  const name = typeof value?.display_name === "string" ? value.display_name.trim() : "";
  return name.length === 0 || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name) ? undefined : name;
}

/** One scratchpad entry. `short` is the only id a model ever sees. */
type Entry = {
  readonly short: string;
  item: EvidenceDeskItemV1;
  /** The model has seen this item's complete released text. */
  full: boolean;
  /** Opened explicitly (or preloaded); full text stays in the prompt while budget allows. */
  opened: boolean;
  touched: number;
};
type ToolResult = Readonly<Record<string, unknown>>;
/** Code-owned plan state. A need leaves the plan only by being marked found or not_found. */
type NeedState = { readonly need: string; status: NeedStatus; evidence: readonly string[]; readonly searches_before: number; readonly lists_before: number };
type PartState = { readonly question: string; notes: string; readonly needs: NeedState[] };
type ListState = { items: EvidenceDeskItemV1[]; cursor: string | undefined; fetched: boolean; shown: number; truncated: boolean; note?: string };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function errorDiagnostic(error: unknown): { readonly failure_class: string | null; readonly http_status: number | null; readonly finish_reason: string | null; readonly usage: StructuredGenerationUsageV1 | null } {
  const outer = object(error); const diagnostic = object(outer?.diagnostic);
  const observation = object(outer?.generation_observation); const usage = object(observation?.usage);
  const valid = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return Object.freeze({
    failure_class: typeof diagnostic?.failure_class === "string" ? diagnostic.failure_class : null,
    http_status: typeof diagnostic?.http_status === "number" && Number.isSafeInteger(diagnostic.http_status) ? diagnostic.http_status : null,
    finish_reason: typeof diagnostic?.finish_reason === "string" ? diagnostic.finish_reason : null,
    usage: usage === null ? null : Object.freeze({ input_tokens: valid(usage.input_tokens), output_tokens: valid(usage.output_tokens), total_tokens: valid(usage.total_tokens), cached_input_tokens: valid(usage.cached_input_tokens), reasoning_tokens: valid(usage.reasoning_tokens) }),
  });
}
function generationFailure(error: unknown): AgenticAskGenerationFailureV1 | null {
  const diagnostic = errorDiagnostic(error);
  if (diagnostic.failure_class === "adapter_json") return new AgenticAskGenerationFailureV1("the reply was not valid JSON", true);
  if (diagnostic.failure_class === "adapter_finish") return new AgenticAskGenerationFailureV1("the reply was cut off before it finished; keep notes and sentences shorter", true);
  if (diagnostic.failure_class === "adapter_refusal" || (diagnostic.failure_class === "adapter_response" && diagnostic.http_status !== null && diagnostic.http_status >= 200 && diagnostic.http_status < 300)) return new AgenticAskGenerationFailureV1("the reply had no usable content", true);
  if (["adapter_timeout", "adapter_transport", "adapter_http", "adapter_provider_error"].includes(diagnostic.failure_class ?? "")) return new AgenticAskGenerationFailureV1("model was unavailable", false);
  return null;
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof AgenticAskDeadlineErrorV1 ? signal.reason : new DOMException("Ask cancelled", "AbortError");
}
function raceAbort<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(abortReason(signal));
    signal.addEventListener("abort", cancelled, { once: true });
    operation.then(
      value => { signal.removeEventListener("abort", cancelled); resolve(value); },
      error => { signal.removeEventListener("abort", cancelled); reject(error); },
    );
  });
}
function questionText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 4_000 && value.trim() === value && value === value.normalize("NFC") && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value : null;
}
function privateItem(item: EvidenceDeskItemV1): boolean {
  return item.visibility === "only_me" || item.visibility === "approver_only";
}
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}
/** Desk refusals a model can cause (a stale id, an invalid request) become tool results, not failures. */
function toolRefusal(error: unknown): string | null {
  const value = object(error);
  if (value?.name !== "AuthorityOperationError") return null;
  if (value.code === "not_found") return "that item is not available";
  if (value.code === "invalid_request") return typeof value.message === "string" && value.message.length <= 200 ? value.message : "that request is not valid";
  return null;
}
function abort(): never { throw new DOMException("Ask cancelled", "AbortError"); }
function bytes(value: string | undefined): number { return value === undefined ? 0 : Buffer.byteLength(value, "utf8"); }
function preview(text: string): string { return cleanLine(text, AGENTIC_ASK_PREVIEW_CHARS_V1); }
function partQuestion(value: string): string {
  // V4 bounds part questions to 1 KiB of single-line text.
  let text = cleanLine(value, 400);
  while (Buffer.byteLength(text, "utf8") > 1_000) text = cleanLine(text.slice(0, -8), 400);
  return text.length === 0 ? "Question" : text;
}
function needKey(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

// ---- list argument normalization (named fields, loose forms) --------------
const LIST_SOURCES: Readonly<Record<string, EvidenceDeskSourceV1>> = Object.freeze({
  meeting: "meeting", meetings: "meeting", record: "meeting", records: "meeting", decisions: "meeting",
  document: "document", documents: "document", doc: "document", docs: "document", file: "document", files: "document",
  slack: "slack", messages: "slack", message: "slack",
});
const MEETING_KINDS: Readonly<Record<string, EvidenceDeskKindV1>> = Object.freeze({
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
type ListArgs = { readonly source: EvidenceDeskSourceV1; readonly kinds?: readonly EvidenceDeskKindV1[]; readonly status?: "open" | "done"; readonly owner?: string; readonly channel?: string; readonly since?: string; readonly until?: string; readonly notes: readonly string[] };
function normalizeListArgs(raw: StepArgs, today: string): ListArgs | { readonly error: string } {
  const source = LIST_SOURCES[(raw.source ?? "").trim().toLowerCase()];
  if (source === undefined) return { error: "source must be \"meetings\", \"documents\" or \"slack\"" };
  const notes: string[] = [];
  let kinds: EvidenceDeskKindV1[] | undefined;
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
    if (source !== "slack") notes.push("channel applies to slack only; ignored");
    else if (name.length === 0 || name.length > 80) return { error: "channel must be a Slack channel name such as \"hw-dvt\"" };
    else channel = name;
  }
  if (source === "slack" && channel === undefined) return { error: "slack needs a channel, such as {\"source\": \"slack\", \"channel\": \"hw-dvt\"}" };
  const since = raw.since === undefined ? undefined : listDate(raw.since, today);
  const until = raw.until === undefined ? undefined : listDate(raw.until, today);
  if ((raw.since !== undefined && since === null) || (raw.until !== undefined && until === null)) return { error: "since and until take a date like 2026-09-21 or an age like 7d or 2w" };
  const defaultSince = source === "slack" && since === undefined ? listDate("14d", today)! : since ?? undefined;
  return {
    source, notes,
    ...(kinds === undefined ? {} : { kinds }), ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }), ...(channel === undefined ? {} : { channel }),
    ...(defaultSince === undefined ? {} : { since: defaultSince }), ...(until === undefined || until === null ? {} : { until }),
  };
}

export function createAgenticAskV1(options: CreateAgenticAskV1Options) {
  const now = options.now_ms ?? (() => performance.now());
  const today = options.today ?? (() => isoDay(new Date()));
  const askedBy = askerName(options.asker);
  /** Who is asking and today's date: context for "my", "this week" and "overdue". */
  const context = () => ({ ...(askedBy === undefined ? {} : { asked_by: askedBy }), today: today() });
  const stepBudget = agenticAskContextBudgetBytesV1(options.generation.context_tokens, STEP_PROMPT, OUTPUT_TOKENS.step);
  const answerBudget = agenticAskContextBudgetBytesV1(options.generation.context_tokens, ANSWER_PROMPT, OUTPUT_TOKENS.answer);
  return Object.freeze({
    async answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<AgenticAskResultV1> {
      if (questionText(input.question) === null) throw new AgenticAskOutputErrorV1("question is invalid");
      const startedAt = now();
      const deadline = startedAt + AGENTIC_ASK_DEADLINE_MS_V1;
      const terminalAbort = new AbortController();
      const activeSignal = input.signal === undefined ? terminalAbort.signal : AbortSignal.any([input.signal, terminalAbort.signal]);
      let deadlineExpired = false;
      const deadlineTimer = setTimeout(() => { deadlineExpired = true; terminalAbort.abort(new AgenticAskDeadlineErrorV1()); }, AGENTIC_ASK_DEADLINE_MS_V1);
      deadlineTimer.unref?.();
      let calls = 0; let repairs = 0; let fallbacks = 0; let steps = 0; let checkedAt: string | null = null;
      let terminalAudited = false;
      const generations: AgenticAskGenerationObservationV1[] = [];
      const invocationDigests: Sha256Digest[] = [];
      const receipts: Sha256Digest[] = [];
      const notice = new Set<string>();
      const entries = new Map<string, Entry>();
      const byShort = new Map<string, string>();
      const searchesRun: string[] = [];
      let listsRun = 0;
      const lists = new Map<string, ListState>();
      let touch = 0;
      const scope = options.desk.scope.kind === "project"
        ? "one project: meetings and documents are limited to it; Slack is not"
        : "everything the asker can read";

      const remaining = () => deadline - now();
      const assertLive = () => {
        if (input.signal?.aborted) abort();
        if (deadlineExpired || now() >= deadline) throw new AgenticAskDeadlineErrorV1();
        if (activeSignal.aborted) throw new DOMException("Ask stopped", "AbortError");
      };
      const observe = (result: EvidenceDeskResultV1) => {
        if (result.notice !== undefined) notice.add(result.notice);
        // Audits bind every released item, even one that never reaches a prompt.
        for (const item of result.items) if (!receipts.includes(item.receipt_sha256)) receipts.push(item.receipt_sha256);
        for (const receipt of result.receipt_digests) if (!receipts.includes(receipt)) receipts.push(receipt);
      };
      /** Registers an item and returns its entry. Text only ever upgrades an entry. */
      const register = (item: EvidenceDeskItemV1, fullIfShort: boolean): Entry => {
        const existing = entries.get(item.id);
        touch += 1;
        if (existing !== undefined) {
          if (item.text !== undefined && existing.item.text === undefined) existing.item = item;
          if (fullIfShort && existing.item.text !== undefined && existing.item.text.length <= AGENTIC_ASK_PREVIEW_CHARS_V1) existing.full = true;
          existing.touched = touch;
          return existing;
        }
        const short = `E${entries.size + 1}`;
        const entry: Entry = { short, item, full: fullIfShort && item.text !== undefined && item.text.length <= AGENTIC_ASK_PREVIEW_CHARS_V1, opened: false, touched: touch };
        entries.set(item.id, entry); byShort.set(short, item.id);
        return entry;
      };
      const entryOf = (short: string): Entry | undefined => {
        const id = cleanId(short);
        const deskId = id === null ? undefined : byShort.get(id);
        return deskId === undefined ? undefined : entries.get(deskId);
      };
      const describe = (entry: Entry): Record<string, unknown> => ({
        id: entry.short, source: evidenceDeskSourceV1(entry.item), kind: entry.item.kind, title: entry.item.label,
        ...(entry.item.occurred_at === undefined ? {} : { date: entry.item.occurred_at }),
        ...(entry.item.attributes === undefined ? {} : { attributes: entry.item.attributes }),
      });
      const listing = (entry: Entry, withPreview: boolean): Record<string, unknown> => ({
        ...describe(entry),
        ...(withPreview && entry.item.text !== undefined ? { preview: preview(entry.item.text), full: entry.full } : {}),
      });

      // ---- tools ---------------------------------------------------------
      const search = async (args: StepArgs): Promise<ToolResult> => {
        const query = normalizeQuery(args.query);
        if (query === null) return { tool: "search", args, error: "query must be 1 to 32 keywords" };
        if (searchesRun.includes(query.toLowerCase())) return { tool: "search", query, note: "already searched; results are in your scratchpad" };
        searchesRun.push(query.toLowerCase());
        const result = await raceAbort(activeSignal, options.desk.search({ query, limit: AGENTIC_ASK_SEARCH_LIMIT_V1, signal: activeSignal }));
        observe(result);
        const found = result.items.filter(item => item.text !== undefined).map(item => register(item, true));
        return { tool: "search", query, results: found.map(entry => listing(entry, true)), ...(found.length === 0 ? { note: "no matches" } : {}) };
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
      const open = async (args: StepArgs): Promise<ToolResult> => {
        const raw = args.id ?? "";
        const entry = entryOf(raw) ?? entryByTitle(raw);
        if (entry === undefined) return { tool: "open", args, error: "unknown id; pass an id such as E4 from your scratchpad" };
        let result: EvidenceDeskResultV1;
        try { result = await raceAbort(activeSignal, options.desk.open({ item: entry.item.id, neighbours: AGENTIC_ASK_OPEN_NEIGHBOURS_V1, signal: activeSignal })); }
        catch (error) {
          const refusal = toolRefusal(error);
          if (refusal === null) throw error;
          return { tool: "open", id: entry.short, error: refusal };
        }
        observe(result);
        const anchor = result.items.find(item => item.id === entry.item.id && item.text !== undefined);
        const others = result.items.filter(item => item.id !== entry.item.id && item.text !== undefined);
        const admitted: Entry[] = [];
        let used = 0;
        for (const item of anchor === undefined ? others : [anchor, ...others]) {
          if (admitted.length > AGENTIC_ASK_OPEN_EXTRA_ITEMS_V1 || (admitted.length > 0 && used + bytes(item.text) > AGENTIC_ASK_OPEN_BYTES_V1)) break;
          const opened = register(item, false);
          opened.full = true; opened.opened = true; used += bytes(item.text);
          admitted.push(opened);
        }
        return { tool: "open", id: entry.short, opened: admitted.map(value => value.short), ...(result.truncated ? { truncated: true } : {}), ...(admitted.length === 0 ? { note: "no readable text" } : {}) };
      };
      const list = async (args: StepArgs): Promise<ToolResult> => {
        const normalized = normalizeListArgs(args, today());
        if ("error" in normalized) return { tool: "list", args, error: normalized.error };
        const { notes, status, owner, ...request } = normalized;
        const key = JSON.stringify({ ...request, status: status ?? null, owner: owner?.toLowerCase() ?? null });
        let state = lists.get(key);
        if (state === undefined) { state = { items: [], cursor: undefined, fetched: false, shown: 0, truncated: false }; lists.set(key, state); }
        listsRun += 1;
        if (state.shown >= state.items.length && (!state.fetched || state.cursor !== undefined)) {
          const deskInput: EvidenceDeskListInputV1 = { ...request, limit: AGENTIC_ASK_LIST_FETCH_V1, ...(state.cursor === undefined ? {} : { cursor: state.cursor }), signal: activeSignal };
          let result: EvidenceDeskResultV1;
          try { result = await raceAbort(activeSignal, options.desk.list(deskInput)); }
          catch (error) {
            const refusal = toolRefusal(error);
            if (refusal === null) throw error;
            return { tool: "list", args, error: refusal };
          }
          observe(result);
          state.fetched = true; state.cursor = result.next_cursor; state.truncated = result.truncated;
          // A status filter applies only where an item records a status; approved actions usually record owner and
          // due date but not completion, so an item without a status is kept (never silently dropped as "not open").
          const statusOf = (item: EvidenceDeskItemV1) => item.attributes?.status === undefined ? null : statusGroup(item.attributes.status);
          const wanted = owner?.toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
          const ownerMatches = (item: EvidenceDeskItemV1) => {
            const recorded = item.attributes?.owner?.toLowerCase();
            return recorded !== undefined && wanted.every(part => recorded.includes(part));
          };
          state.items.push(...result.items.filter(item => (status === undefined || statusOf(item) === null || statusOf(item) === status) && (owner === undefined || ownerMatches(item))));
          if (status !== undefined && result.items.some(item => item.attributes?.status === undefined)) state.note = "some items do not record open or done; they are included";
          if (owner !== undefined && state.items.length === 0 && result.items.length > 0) state.note = `no listed item records ${owner} as owner; owners shown are exact names from the records`;
        }
        const page = state.items.slice(state.shown, state.shown + AGENTIC_ASK_LIST_PAGE_V1).map(item => register(item, true));
        state.shown += page.length;
        const more = state.shown < state.items.length || state.cursor !== undefined;
        const allNotes = [...notes, ...(state.note === undefined ? [] : [state.note]), ...(page.length === 0 ? ["nothing more to list"] : []), ...(!more && state.truncated ? ["more items exist than list can show; use search"] : [])];
        return { tool: "list", source: request.source, ...(request.channel === undefined ? {} : { channel: request.channel }), ...(request.since === undefined ? {} : { since: request.since }), items: page.map(entry => listing(entry, entry.item.text !== undefined)), more, ...(allNotes.length === 0 ? {} : { note: allNotes.join("; ") }) };
      };
      const run = async (action: StepAction): Promise<ToolResult> => {
        if (action.tool === "search") return search(action.args);
        if (action.tool === "open") return open(action.args);
        return list(action.args);
      };

      // ---- plan (parts and needs) -------------------------------------------
      let plan: PartState[] = [];
      const newNeed = (need: string, status: NeedStatus, evidence: readonly string[]): NeedState =>
        ({ need, status, evidence, searches_before: searchesRun.length, lists_before: listsRun });
      const newPart = (part: StepPart): PartState => ({
        question: part.question, notes: part.notes,
        // A part without needs still needs its own answer.
        needs: part.needs.length > 0 ? part.needs.map(need => newNeed(need.need, need.status, need.evidence)) : [newNeed(part.question, "open", [])],
      });
      const merge = (parts: readonly StepPart[]) => {
        if (parts.length === 0) return;
        if (plan.length === 0) { plan = parts.map(newPart); return; }
        for (const [index, part] of parts.entries()) {
          const existing = plan[index];
          if (existing === undefined) { plan.push(newPart(part)); continue; }
          if (part.notes.length > 0) existing.notes = part.notes;
          for (const need of part.needs) {
            const match = existing.needs.find(value => needKey(value.need) === needKey(need.need));
            if (match !== undefined) { match.status = need.status; match.evidence = need.evidence; }
            else if (existing.needs.length < AGENTIC_ASK_MAX_NEEDS_PER_PART_V1) existing.needs.push(newNeed(need.need, need.status, need.evidence));
          }
        }
      };
      const planView = () => plan.map((part, index) => ({
        part: index + 1, question: part.question, notes: part.notes,
        needs: part.needs.map(need => ({ need: need.need, status: need.status, evidence: need.evidence })),
      }));

      // ---- scratchpad ------------------------------------------------------
      const citable = (short: string): boolean => entryOf(short)?.full === true;
      const citedShorts = () => new Set(plan.flatMap(part => part.needs.flatMap(need => need.evidence)).filter(citable));
      /** Opened full text first (cited, then most recent), then previews of everything else, within the context budget. */
      const scratchpad = (budget: number) => {
        const cited = citedShorts();
        const openedEntries = [...entries.values()].filter(entry => entry.opened && entry.item.text !== undefined)
          .sort((left, right) => Number(cited.has(right.short)) - Number(cited.has(left.short)) || right.touched - left.touched);
        const shown: Record<string, unknown>[] = []; const shownIds = new Set<string>(); let used = 0;
        for (const entry of openedEntries) {
          const cost = bytes(entry.item.text) + 200;
          if (used + cost > budget) continue;
          used += cost; shownIds.add(entry.short);
          shown.push({ ...describe(entry), text: entry.item.text });
        }
        const seen: Record<string, unknown>[] = [];
        const rest = [...entries.values()].filter(entry => !shownIds.has(entry.short))
          .sort((left, right) => Number(cited.has(right.short)) - Number(cited.has(left.short)) || right.touched - left.touched);
        for (const entry of rest) {
          if (seen.length >= MAX_SEEN_ENTRIES) break;
          const value = listing(entry, true);
          const cost = bytes(JSON.stringify(value));
          if (used + cost > budget) break;
          used += cost; seen.push(value);
        }
        seen.sort((left, right) => Number(String(left.id).slice(1)) - Number(String(right.id).slice(1)));
        return { opened: shown, seen };
      };
      const slackInPrompt = () => [...entries.values()].some(entry => entry.item.citation.kind === "slack_message");

      // ---- model calls -----------------------------------------------------
      const call = async (role: AgenticAskModelRoleV1, system_prompt: string, user: unknown, schema: StructuredGenerationJsonSchema, timeoutMs: number): Promise<unknown> => {
        assertLive();
        if (calls >= AGENTIC_ASK_MAX_MODEL_CALLS_V1) throw new AgenticAskGenerationFailureV1("call budget exhausted", false);
        // Every call is preceded by a cumulative desk revalidation of what it may carry.
        const validated = await raceAbort(activeSignal, options.desk.revalidate({ signal: activeSignal }));
        checkedAt = validated.checked_at;
        assertLive();
        calls += 1;
        const modelInput: StructuredGenerationInput = Object.freeze({ model: options.generation.answer_model, system_prompt, user_prompt: JSON.stringify(user), schema, max_output_tokens: OUTPUT_TOKENS[role], timeout_ms: Math.max(1, Math.min(options.generation.timeout_ms, timeoutMs, remaining())), signal: activeSignal });
        invocationDigests.push(canonicalSha256({ role, model: modelInput.model, system_prompt: modelInput.system_prompt, user_prompt: modelInput.user_prompt, schema: modelInput.schema, max_output_tokens: modelInput.max_output_tokens, timeout_ms: modelInput.timeout_ms }));
        // Slack text must never reach runtime content capture (RFC-0003 retention).
        const contentSafe = <T>(operation: () => Promise<T>): Promise<T> => slackInPrompt() ? withoutCoreRuntimeContentV1(operation) : operation();
        try {
          if (options.model.generate_with_observation !== undefined) {
            const generate = options.model.generate_with_observation.bind(options.model);
            const observed = await raceAbort(activeSignal, contentSafe(() => generate(modelInput)));
            generations.push(Object.freeze({ role, finish_reason: observed.finish_reason, usage: observed.usage }));
            if (observed.finish_reason === "length") throw new AgenticAskGenerationFailureV1("the reply was cut off before it finished; keep notes and sentences shorter", true);
            if (observed.finish_reason !== null && observed.finish_reason !== "stop") throw new AgenticAskGenerationFailureV1("the reply did not finish normally", true);
            return observed.value;
          }
          const value = await raceAbort(activeSignal, contentSafe(() => options.model.generate(modelInput)));
          generations.push(Object.freeze({ role, finish_reason: null, usage: null }));
          return value;
        } catch (error) {
          if (error instanceof AgenticAskGenerationFailureV1) throw error;
          // Every admitted call leaves exactly one content-free observation, including aborts.
          const diagnostic = errorDiagnostic(error);
          generations.push(Object.freeze({ role, finish_reason: diagnostic.finish_reason, usage: diagnostic.usage }));
          if (isAbort(error, input.signal) || deadlineExpired) throw error;
          throw generationFailure(error) ?? error;
        }
      };
      /** One call plus at most one retry: an unavailable call is retried unchanged, invalid output is repaired with its reason. */
      const withRepair = async <T>(role: AgenticAskModelRoleV1, system: string, user: unknown, schema: StructuredGenerationJsonSchema, timeout: () => number, parse: (value: unknown) => T): Promise<T> => {
        let reason: string | null;
        try { return parse(await call(role, system, user, schema, timeout())); }
        catch (error) {
          if (isAbort(error, input.signal) || deadlineExpired || !(error instanceof AgenticAskOutputErrorV1)) throw error;
          if (error instanceof AgenticAskGenerationFailureV1 && error.message === "call budget exhausted") throw error;
          reason = error instanceof AgenticAskGenerationFailureV1 && !error.retry ? null : error.message;
        }
        const minimum = role === "step" ? AGENTIC_ASK_MIN_STEP_MS_V1 : AGENTIC_ASK_MIN_ANSWER_MS_V1;
        if (timeout() < minimum || calls >= AGENTIC_ASK_MAX_MODEL_CALLS_V1) throw new AgenticAskGenerationFailureV1("no time left to repair", false);
        repairs += 1;
        return parse(await call(role, reason === null ? system : repairPrompt(system, reason), user, schema, timeout()));
      };
      const audit = async (outcome: AgenticAskAuditEntryV1["outcome"], citations: number, result?: AgenticAskResultV1) => {
        const aggregate = (field: keyof StructuredGenerationUsageV1): number | null => {
          const values = generations.map(entry => entry.usage?.[field]);
          return values.length === 0 || values.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) ? null : values.reduce<number>((total, value) => total + value!, 0);
        };
        const finishReasonCounts: Record<string, number> = {};
        for (const generation of generations) if (generation.finish_reason !== null) finishReasonCounts[generation.finish_reason] = (finishReasonCounts[generation.finish_reason] ?? 0) + 1;
        await options.audit.append(Object.freeze({
          kind: "echo-agentic-ask-audit-v1", outcome, receipt_digests: Object.freeze([...receipts]), rounds: steps, model_calls: calls, repairs, fallbacks, citation_count: citations, checked_at: checkedAt,
          prompt_sha256: outcome === "cancelled" || outcome === "timed_out" ? null : canonicalSha256({ generation: options.generation.generation_adapter_id, invocations: invocationDigests }),
          answer_sha256: result === undefined ? null : canonicalSha256({ direct: result.direct ?? null, parts: result.parts }),
          response_sha256: result === undefined ? null : canonicalSha256(result),
          generations: Object.freeze([...generations]),
          generation_usage: Object.freeze({ input_tokens: aggregate("input_tokens"), output_tokens: aggregate("output_tokens"), total_tokens: aggregate("total_tokens") }),
          finish_reason_counts: Object.freeze(finishReasonCounts),
        }));
        terminalAudited = true;
      };

      try {
        // ---- optional small-scope preload -----------------------------------
        if (options.small_scope_shortcut === true) {
          const inventory = await raceAbort(activeSignal, options.desk.search({ limit: AGENTIC_ASK_SHORTCUT_ITEMS_V1, inventory_mode: "items", signal: activeSignal }));
          observe(inventory);
          if (!inventory.truncated && inventory.items.length <= AGENTIC_ASK_SHORTCUT_ITEMS_V1) {
            let used = 0;
            for (const listed of inventory.items) {
              assertLive();
              const opened = await raceAbort(activeSignal, options.desk.open({ item: listed.id, signal: activeSignal }));
              observe(opened);
              const exact = opened.items.find(item => item.id === listed.id && item.text !== undefined);
              if (exact === undefined || used + bytes(exact.text) > stepBudget / 2) continue;
              const entry = register(exact, false); entry.full = true; entry.opened = true; used += bytes(exact.text);
            }
          }
        }

        // ---- research loop --------------------------------------------------
        let results: ToolResult[] = [];
        let finishRejected = false;
        let idleSteps = 0;
        const stepTimeout = () => Math.min(AGENTIC_ASK_STEP_TIMEOUT_MS_V1, remaining() - AGENTIC_ASK_ANSWER_RESERVE_MS_V1 - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1);
        while (steps < AGENTIC_ASK_MAX_STEPS_V1) {
          assertLive();
          // Leave room for the answer call and its possible repair.
          if (stepTimeout() < AGENTIC_ASK_MIN_STEP_MS_V1 || calls + 2 >= AGENTIC_ASK_MAX_MODEL_CALLS_V1) break;
          const header = { question: input.question, ...context(), scope, step: steps + 1, steps_left: AGENTIC_ASK_MAX_STEPS_V1 - steps - 1, plan: planView(), last_results: results, searches_done: [...searchesRun] };
          const pad = scratchpad(stepBudget - bytes(JSON.stringify(header)));
          const user = { ...header, opened: pad.opened, seen: pad.seen };
          let step: Step;
          try { step = await withRepair("step", STEP_PROMPT, user, stepSchema, stepTimeout, parseStep); }
          catch (error) {
            if (isAbort(error, input.signal) || deadlineExpired || !(error instanceof AgenticAskOutputErrorV1)) throw error;
            // A research step that cannot finish stops research; the answer uses what was found.
            fallbacks += 1; break;
          }
          steps += 1;
          merge(step.parts);
          const finish = step.actions.length === 0 || step.actions.some(action => action.tool === "finish");
          if (finish) {
            const problems: string[] = [];
            for (const [index, part] of plan.entries()) {
              for (const need of part.needs) {
                const label = `part ${index + 1} need "${need.need}"`;
                if (need.status === "open") problems.push(`${label} is still open`);
                else if (need.status === "found" && !need.evidence.some(citable)) problems.push(`${label} is found but cites no item whose full text you have read`);
                else if (need.status === "not_found" && searchesRun.length - need.searches_before < 2 && listsRun - need.lists_before < 1) problems.push(`${label} is not_found after fewer than two searches or a list`);
              }
            }
            if (plan.length === 0) problems.push("no parts were written");
            if (problems.length === 0 || finishRejected || steps >= AGENTIC_ASK_MAX_STEPS_V1) break;
            finishRejected = true;
            results = [{ tool: "finish", error: `finish was not accepted: ${problems.slice(0, 8).join("; ")}. Search, list or open more, or fix the need status and evidence.` }];
            continue;
          }
          const before = { entries: entries.size, opened: [...entries.values()].filter(entry => entry.opened).length };
          results = [];
          for (const action of step.actions) {
            assertLive();
            results.push(await run(action));
          }
          const progressed = entries.size > before.entries || [...entries.values()].filter(entry => entry.opened).length > before.opened;
          idleSteps = progressed ? 0 : idleSteps + 1;
          if (idleSteps >= 2) break;
        }
        if (plan.length === 0) plan = [newPart({ question: partQuestion(input.question), needs: [], notes: "" })];

        // ---- final answer ---------------------------------------------------
        const cited = [...citedShorts()].map(short => entryOf(short)!);
        const evidence: Entry[] = []; let evidenceBytes = 0;
        const admit = (entry: Entry) => {
          const cost = bytes(entry.item.text) + 200;
          if (evidence.includes(entry) || evidenceBytes + cost > answerBudget) return;
          evidence.push(entry); evidenceBytes += cost;
        };
        for (const entry of cited) admit(entry);
        for (const entry of [...entries.values()].filter(value => value.full).sort((left, right) => right.touched - left.touched)) admit(entry);
        const allowed = new Set(evidence.map(entry => entry.short));

        let answer: Answer | null = null;
        const answerTimeout = () => remaining() - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1;
        if (evidence.length > 0 && answerTimeout() >= AGENTIC_ASK_MIN_ANSWER_MS_V1 && calls < AGENTIC_ASK_MAX_MODEL_CALLS_V1) {
          const user = {
            question: input.question, ...context(), scope,
            research_plan: plan.map((part, index) => ({ part: index + 1, question: part.question, notes: part.notes, needs: part.needs.map(need => ({ need: need.need, status: need.status, suggested_evidence: need.evidence.filter(short => allowed.has(short)) })) })),
            evidence: evidence.map(entry => ({ ...describe(entry), text: entry.item.text })),
          };
          try { answer = await withRepair("answer", ANSWER_PROMPT, user, answerSchema, answerTimeout, parseAnswer); }
          catch (error) {
            if (isAbort(error, input.signal) || deadlineExpired || !(error instanceof AgenticAskOutputErrorV1)) throw error;
            fallbacks += 1;
          }
        }

        // ---- layout (code, not model): one part, read as one paragraph ------
        const used: Entry[] = [];
        const use = (shorts: readonly string[]): number[] => {
          const indexes: number[] = [];
          for (const short of shorts) {
            if (!allowed.has(short)) continue;
            const entry = entryOf(short)!;
            if (!used.includes(entry)) used.push(entry);
            const index = used.indexOf(entry);
            if (!indexes.includes(index)) indexes.push(index);
          }
          return indexes;
        };
        const isPrivate = (shorts: readonly string[]) => shorts.some(short => allowed.has(short) && privateItem(entryOf(short)!.item));
        const question = partQuestion(input.question);
        const statements = (answer?.sentences ?? [])
          .map(sentence => ({ sentence, shorts: sentence.evidence.filter(short => allowed.has(short)) }))
          .filter(value => value.shorts.length > 0)
          .map(value => ({ text: value.sentence.text, citation_indexes: use(value.shorts), private: isPrivate(value.shorts) }));
        const notFound = answer?.not_found ?? [];
        const gapText = notFound.length === 0 ? undefined : cleanLine(`Not found: ${notFound.join("; ")}.`, 600);
        type Draft = { status: PersonAnswerPartV4["status"]; statements: typeof statements; gap?: string; records?: { text: string; citation_indexes: number[]; private: boolean }[] };
        let draft: Draft;
        if (statements.length > 0) {
          draft = gapText === undefined ? { status: "answered", statements } : { status: "partial", statements, gap: gapText };
        } else {
          // No verified sentence: show what research found rather than "not found".
          const opened = [...entries.values()].filter(entry => entry.opened && entry.full).sort((left, right) => right.touched - left.touched);
          const fallback = (cited.length > 0 ? cited : answer === null ? opened : []).filter(entry => allowed.has(entry.short)).slice(0, 3);
          const records = fallback.map(entry => ({ text: entry.item.text!, citation_indexes: use([entry.short]), private: privateItem(entry.item) }));
          draft = records.length > 0
            ? { status: "records_only", statements: [], records, gap: RECORDS_GAP }
            : { status: "not_found", statements: [], gap: gapText ?? NOT_FOUND_GAP };
        }
        const anyEvidence = draft.statements.length > 0 || (draft.records?.length ?? 0) > 0;
        const outcome = !anyEvidence ? "not_found" as const : draft.status === "answered" ? "answered" as const : "partial" as const;
        const result: AgenticAskResultV1 = Object.freeze({
          schema_version: 4, kind: "echo-clean-person-answer-v4", scope: options.desk.scope, outcome,
          parts: Object.freeze([Object.freeze({
            question, status: draft.status,
            statements: Object.freeze(draft.statements.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))),
            ...(draft.gap === undefined ? {} : { gap: draft.gap }),
            ...(draft.records === undefined ? {} : { records: Object.freeze(draft.records.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))) }),
          })]),
          citations: Object.freeze(anyEvidence ? used.map(entry => Object.freeze({ citation: entry.item.citation, kind: entry.item.kind, label: entry.item.label, visibility: entry.item.visibility })) : []),
          ...(notice.size === 0 ? {} : { notice: [...notice].join(" ") }),
        });
        const validated = compactAndValidateAgenticAskResponseV1(result);
        assertLive();
        const revalidated = await raceAbort(activeSignal, options.desk.revalidate({ signal: activeSignal })); checkedAt = revalidated.checked_at;
        await audit(validated.outcome, validated.citations.length, validated);
        // An abort that races the terminal audit still suppresses publication.
        if (input.signal?.aborted) abort();
        assertLive();
        clearTimeout(deadlineTimer);
        return validated;
      } catch (error) {
        clearTimeout(deadlineTimer);
        if (deadlineExpired || error instanceof AgenticAskDeadlineErrorV1) {
          terminalAbort.abort();
          if (!terminalAudited) await audit("timed_out", 0);
          throw error instanceof AgenticAskDeadlineErrorV1 ? error : new AgenticAskDeadlineErrorV1();
        }
        if (input.signal?.aborted || isAbort(error, input.signal)) {
          terminalAbort.abort();
          if (!terminalAudited) await audit("cancelled", 0);
          throw error;
        }
        terminalAbort.abort();
        throw error;
      }
    },
  });
}
