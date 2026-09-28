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
import type {
  EvidenceDeskItemV1,
  EvidenceDeskPortV1,
  EvidenceDeskResultV1,
} from "../shared/evidence-desk-v1.js";
import {
  ANSWER_PROMPT,
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
  type Step,
  type StepAction,
  type StepPart,
} from "./agentic-ask-v1-model-protocol.js";
import { compactAndValidateAgenticAskResponseV1 } from "./agentic-ask-v1-response.js";

export {
  AGENTIC_ASK_MAX_ACTIONS_PER_STEP_V1,
  AGENTIC_ASK_MAX_PARTS_V1,
  AgenticAskOutputErrorV1,
} from "./agentic-ask-v1-model-protocol.js";

/**
 * Agentic Ask: one research loop over three read tools (search, open, browse)
 * plus `finish`, then one final answer call. Code owns scope, permissions,
 * ids, budgets, de-duplication, the stop rules, and the response layout.
 */
export const AGENTIC_ASK_MAX_STEPS_V1 = 6;
/** Request-wide model-call budget, including repairs. */
export const AGENTIC_ASK_MAX_MODEL_CALLS_V1 = 12;
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
export const AGENTIC_ASK_BROWSE_PAGE_V1 = 25;
export const AGENTIC_ASK_BROWSE_FETCH_V1 = 50;
/** Scratchpad budget for full text shown to the model each step. */
export const AGENTIC_ASK_OPENED_BYTES_V1 = 64 * 1024;
/** Scratchpad budget for one-line entries of everything else seen. */
export const AGENTIC_ASK_SEEN_ENTRIES_V1 = 80;
export const AGENTIC_ASK_PREVIEW_CHARS_V1 = 240;
export const AGENTIC_ASK_OPEN_EXTRA_ITEMS_V1 = 4;
/** Document passages on each side of an opened passage (desk maximum). */
export const AGENTIC_ASK_OPEN_NEIGHBOURS_V1 = 2;
export const AGENTIC_ASK_OPEN_BYTES_V1 = 12 * 1024;
export const AGENTIC_ASK_ANSWER_ITEMS_V1 = 20;
export const AGENTIC_ASK_ANSWER_BYTES_V1 = 40 * 1024;
export const AGENTIC_ASK_SHORTCUT_ITEMS_V1 = 20;
const OUTPUT_TOKENS = Object.freeze({ step: 1_000, answer: 1_500 } as const);
const NOT_FOUND_GAP = "I couldn't find this in the records you can access.";
const RECORDS_GAP = "I found these records, but could not write a verified summary in time.";

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
  /** When the whole readable scope is small, open it all before step 1. */
  readonly small_scope_shortcut?: boolean;
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
  if (diagnostic.failure_class === "adapter_finish") return new AgenticAskGenerationFailureV1("the reply was cut off before it finished; keep notes and statements shorter", true);
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
  if (value.code === "invalid_request") return "that request is not valid";
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

export function createAgenticAskV1(options: CreateAgenticAskV1Options) {
  const now = options.now_ms ?? (() => performance.now());
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
      let browseCache: readonly EvidenceDeskItemV1[] | undefined;
      let browseTruncated = false;
      let browsePages = 0;
      let touch = 0;

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
      const listing = (entry: Entry, withPreview: boolean): Record<string, unknown> => ({
        id: entry.short, kind: entry.item.kind, title: entry.item.label,
        ...(entry.item.attributes === undefined ? {} : { attributes: entry.item.attributes }),
        ...(withPreview && entry.item.text !== undefined ? { preview: preview(entry.item.text), full: entry.full } : {}),
      });

      // ---- tools ---------------------------------------------------------
      const search = async (raw: string): Promise<ToolResult> => {
        const query = normalizeQuery(raw);
        if (query === null) return { tool: "search", input: raw, error: "use 1 to 32 keywords" };
        if (searchesRun.includes(query.toLowerCase())) return { tool: "search", input: query, note: "already searched; results are in your scratchpad" };
        searchesRun.push(query.toLowerCase());
        const result = await raceAbort(activeSignal, options.desk.search({ query, limit: AGENTIC_ASK_SEARCH_LIMIT_V1, signal: activeSignal }));
        observe(result);
        const found = result.items.filter(item => item.text !== undefined).map(item => register(item, true));
        return { tool: "search", input: query, results: found.map(entry => listing(entry, true)), ...(found.length === 0 ? { note: "no matches" } : {}) };
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
      const open = async (raw: string): Promise<ToolResult> => {
        const entry = entryOf(raw) ?? entryByTitle(raw);
        if (entry === undefined) return { tool: "open", input: raw, error: "unknown id; pass an id such as E4 from your scratchpad" };
        let result: EvidenceDeskResultV1;
        try { result = await raceAbort(activeSignal, options.desk.open({ item: entry.item.id, neighbours: AGENTIC_ASK_OPEN_NEIGHBOURS_V1, signal: activeSignal })); }
        catch (error) {
          const refusal = toolRefusal(error);
          if (refusal === null) throw error;
          return { tool: "open", input: entry.short, error: refusal };
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
        return { tool: "open", input: entry.short, opened: admitted.map(value => value.short), ...(admitted.length === 0 ? { note: "no readable text" } : {}) };
      };
      const browse = async (): Promise<ToolResult> => {
        if (browseCache === undefined) {
          const result = await raceAbort(activeSignal, options.desk.search({ limit: AGENTIC_ASK_BROWSE_FETCH_V1, signal: activeSignal }));
          observe(result);
          browseCache = result.items; browseTruncated = result.truncated;
        }
        const start = browsePages * AGENTIC_ASK_BROWSE_PAGE_V1;
        browsePages += 1;
        const page = browseCache.slice(start, start + AGENTIC_ASK_BROWSE_PAGE_V1).map(item => register(item, true));
        const more = browseCache.length > start + AGENTIC_ASK_BROWSE_PAGE_V1;
        return { tool: "browse", page: browsePages, items: page.map(entry => listing(entry, false)), more, ...(!more && browseTruncated ? { note: "more items exist than browse can list; use search" } : {}), ...(page.length === 0 ? { note: "nothing more to list" } : {}) };
      };
      const run = async (action: StepAction): Promise<ToolResult> => {
        if (action.tool === "search") return search(action.input);
        if (action.tool === "open") return open(action.input);
        return browse();
      };

      // ---- scratchpad ------------------------------------------------------
      const citable = (short: string): boolean => entryOf(short)?.full === true;
      const scratchpad = (parts: readonly StepPart[]) => {
        const cited = new Set(parts.flatMap(part => part.evidence).filter(citable));
        const openedEntries = [...entries.values()].filter(entry => entry.opened && entry.item.text !== undefined)
          .sort((left, right) => Number(cited.has(right.short)) - Number(cited.has(left.short)) || right.touched - left.touched);
        const shown: Record<string, unknown>[] = []; const shownIds = new Set<string>(); let used = 0;
        for (const entry of openedEntries) {
          if (used + bytes(entry.item.text) > AGENTIC_ASK_OPENED_BYTES_V1) continue;
          used += bytes(entry.item.text); shownIds.add(entry.short);
          shown.push({ id: entry.short, kind: entry.item.kind, title: entry.item.label, ...(entry.item.attributes === undefined ? {} : { attributes: entry.item.attributes }), text: entry.item.text });
        }
        const seen = [...entries.values()].filter(entry => !shownIds.has(entry.short))
          .sort((left, right) => Number(cited.has(right.short)) - Number(cited.has(left.short)) || right.touched - left.touched)
          .slice(0, AGENTIC_ASK_SEEN_ENTRIES_V1)
          .sort((left, right) => Number(left.short.slice(1)) - Number(right.short.slice(1)))
          .map(entry => listing(entry, true));
        return { opened: shown, seen };
      };

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
        try {
          if (options.model.generate_with_observation !== undefined) {
            const observed = await raceAbort(activeSignal, options.model.generate_with_observation(modelInput));
            generations.push(Object.freeze({ role, finish_reason: observed.finish_reason, usage: observed.usage }));
            if (observed.finish_reason === "length") throw new AgenticAskGenerationFailureV1("the reply was cut off before it finished; keep notes and statements shorter", true);
            if (observed.finish_reason !== null && observed.finish_reason !== "stop") throw new AgenticAskGenerationFailureV1("the reply did not finish normally", true);
            return observed.value;
          }
          const value = await raceAbort(activeSignal, options.model.generate(modelInput));
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
      /** One call plus at most one repair that names the concrete problem. */
      const withRepair = async <T>(role: AgenticAskModelRoleV1, system: string, user: unknown, schema: StructuredGenerationJsonSchema, timeout: () => number, parse: (value: unknown) => T): Promise<T> => {
        let reason: string | null;
        try { return parse(await call(role, system, user, schema, timeout())); }
        catch (error) {
          if (isAbort(error, input.signal) || deadlineExpired || !(error instanceof AgenticAskOutputErrorV1)) throw error;
          if (error instanceof AgenticAskGenerationFailureV1 && error.message === "call budget exhausted") throw error;
          // An unavailable or timed-out provider call is retried unchanged; invalid output is repaired with its reason.
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
              if (exact === undefined || used + bytes(exact.text) > AGENTIC_ASK_OPENED_BYTES_V1) continue;
              const entry = register(exact, false); entry.full = true; entry.opened = true; used += bytes(exact.text);
            }
          }
        }

        // ---- research loop --------------------------------------------------
        let parts: readonly StepPart[] = [];
        let results: ToolResult[] = [];
        let finishRejected = false;
        let idleSteps = 0;
        const stepTimeout = () => Math.min(AGENTIC_ASK_STEP_TIMEOUT_MS_V1, remaining() - AGENTIC_ASK_ANSWER_RESERVE_MS_V1 - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1);
        while (steps < AGENTIC_ASK_MAX_STEPS_V1) {
          assertLive();
          // Leave room for the answer call and its possible repair.
          if (stepTimeout() < AGENTIC_ASK_MIN_STEP_MS_V1 || calls + 2 >= AGENTIC_ASK_MAX_MODEL_CALLS_V1) break;
          const pad = scratchpad(parts);
          const user = {
            question: input.question, step: steps + 1, steps_left: AGENTIC_ASK_MAX_STEPS_V1 - steps - 1,
            parts: parts.map(part => ({ question: part.question, status: part.status, notes: part.notes, evidence: part.evidence })),
            last_results: results, searches_done: [...searchesRun], opened: pad.opened, seen: pad.seen,
          };
          let step: Step;
          try { step = await withRepair("step", STEP_PROMPT, user, stepSchema, stepTimeout, parseStep); }
          catch (error) {
            if (isAbort(error, input.signal) || deadlineExpired || !(error instanceof AgenticAskOutputErrorV1)) throw error;
            // A research step that cannot finish stops research; the answer uses what was found.
            fallbacks += 1; break;
          }
          steps += 1;
          if (step.parts.length > 0) parts = step.parts;
          const finish = step.actions.length === 0 || step.actions.some(action => action.tool === "finish");
          if (finish) {
            const problems: string[] = [];
            for (const [index, part] of parts.entries()) {
              const evidence = part.evidence.filter(citable);
              if (part.status === "searching") problems.push(`part ${index + 1} is still "searching"`);
              else if (part.status === "answered" && evidence.length === 0) problems.push(`part ${index + 1} is "answered" but cites no item whose full text you have read`);
              else if (part.status === "not_found" && searchesRun.length < 2 && browsePages === 0) problems.push(`part ${index + 1} is "not_found" after fewer than two searches`);
            }
            if (parts.length === 0) problems.push("no parts were written");
            if (problems.length === 0 || finishRejected || steps >= AGENTIC_ASK_MAX_STEPS_V1) break;
            finishRejected = true;
            results = [{ tool: "finish", error: `finish was not accepted: ${problems.join("; ")}. Search or open more, or fix the part status and evidence.` }];
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
        if (parts.length === 0) parts = Object.freeze([Object.freeze({ question: partQuestion(input.question), status: "searching" as const, notes: "", evidence: Object.freeze([]) })]);

        // ---- final answer ---------------------------------------------------
        const citedByPart = parts.map(part => part.evidence.filter(citable).map(short => entryOf(short)!));
        const evidence: Entry[] = []; let evidenceBytes = 0;
        const admit = (entry: Entry) => {
          if (evidence.includes(entry) || evidence.length >= AGENTIC_ASK_ANSWER_ITEMS_V1 || evidenceBytes + bytes(entry.item.text) > AGENTIC_ASK_ANSWER_BYTES_V1) return;
          evidence.push(entry); evidenceBytes += bytes(entry.item.text);
        };
        for (const cited of citedByPart) for (const entry of cited) admit(entry);
        for (const entry of [...entries.values()].filter(value => value.full).sort((left, right) => right.touched - left.touched)) admit(entry);
        const allowed = new Set(evidence.map(entry => entry.short));

        let answer: Answer | null = null;
        const answerTimeout = () => remaining() - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1;
        if (evidence.length > 0 && answerTimeout() >= AGENTIC_ASK_MIN_ANSWER_MS_V1 && calls < AGENTIC_ASK_MAX_MODEL_CALLS_V1) {
          const user = {
            question: input.question,
            parts: parts.map((part, index) => ({ part: index + 1, question: part.question, research_notes: part.notes, suggested_evidence: part.evidence.filter(short => allowed.has(short)) })),
            evidence: evidence.map(entry => ({ id: entry.short, kind: entry.item.kind, title: entry.item.label, ...(entry.item.attributes === undefined ? {} : { attributes: entry.item.attributes }), text: entry.item.text })),
          };
          try { answer = await withRepair("answer", ANSWER_PROMPT, user, answerSchema, answerTimeout, value => parseAnswer(value, parts.length)); }
          catch (error) {
            if (isAbort(error, input.signal) || deadlineExpired || !(error instanceof AgenticAskOutputErrorV1)) throw error;
            fallbacks += 1;
          }
        }

        // ---- layout (code, not model) ----------------------------------------
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
        const openedFallback = [...entries.values()].filter(entry => entry.opened && entry.full).sort((left, right) => right.touched - left.touched);
        type Draft = { question: string; status: PersonAnswerPartV4["status"]; statements: { text: string; citation_indexes: number[]; private: boolean }[]; gap?: string; records?: { text: string; citation_indexes: number[]; private: boolean }[] };
        const drafts: Draft[] = parts.map((part, index) => {
          const question = partQuestion(part.question);
          const written = answer?.parts.find(value => value.part === index + 1);
          const statements = (written?.statements ?? [])
            .map(statement => ({ statement, shorts: statement.evidence.filter(short => allowed.has(short)) }))
            .filter(value => value.shorts.length > 0)
            .map(value => ({ text: value.statement.text, citation_indexes: use(value.shorts), private: isPrivate(value.shorts) }));
          if (statements.length > 0) {
            const gap = written?.gap ?? "";
            return gap.length > 0 ? { question, status: "partial" as const, statements, gap } : { question, status: "answered" as const, statements };
          }
          if (answer === null && part.status !== "not_found") {
            // The answer call failed: show what research found rather than "not found".
            // Cited items first; a part that cited nothing gets the most recently opened items.
            const fallback = citedByPart[index]!.length > 0 ? citedByPart[index]! : openedFallback;
            const records = fallback.filter(entry => allowed.has(entry.short)).slice(0, 3)
              .map(entry => ({ text: entry.item.text!, citation_indexes: use([entry.short]), private: privateItem(entry.item) }));
            if (records.length > 0) return { question, status: "records_only" as const, statements: [], records, gap: RECORDS_GAP };
          }
          const gap = written?.gap !== undefined && written.gap.length > 0 ? written.gap : NOT_FOUND_GAP;
          return { question, status: "not_found" as const, statements: [], gap };
        });
        const anyEvidence = drafts.some(draft => draft.statements.length > 0 || (draft.records?.length ?? 0) > 0);
        const directDraft = answer?.direct ?? null;
        const directShorts = directDraft?.evidence.filter(short => allowed.has(short)) ?? [];
        const direct = anyEvidence && directDraft !== null && directShorts.length > 0
          ? Object.freeze({ text: directDraft.text, citation_indexes: Object.freeze(use(directShorts)), private: isPrivate(directShorts) })
          : undefined;
        const statuses = drafts.map(draft => draft.status);
        const outcome = !anyEvidence ? "not_found" as const : statuses.every(value => value === "answered") ? "answered" as const : "partial" as const;
        const result: AgenticAskResultV1 = Object.freeze({
          schema_version: 4, kind: "echo-clean-person-answer-v4", scope: options.desk.scope, outcome,
          ...(direct === undefined ? {} : { direct }),
          parts: Object.freeze(drafts.map(draft => Object.freeze({
            question: draft.question, status: draft.status,
            statements: Object.freeze(draft.statements.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))),
            ...(draft.gap === undefined ? {} : { gap: draft.gap }),
            ...(draft.records === undefined ? {} : { records: Object.freeze(draft.records.map(value => Object.freeze({ text: value.text, citation_indexes: Object.freeze(value.citation_indexes), private: value.private }))) }),
          }))),
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
