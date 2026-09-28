import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  PersonAnswerCitationV4,
  PersonAnswerEvidenceFallbackV4,
  PersonAnswerPartV4,
  PersonAnswerResponseV4,
  PersonAnswerStatementV4,
} from "@echo-brain/organization-api";
import { validatePersonQueryText } from "@echo-brain/organization-api";
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
} from "../shared/evidence-desk-v1.js";
import {
  AGENTIC_ASK_MAX_PAD_ITEMS_V1,
  AGENTIC_ASK_MAX_QUERIES_PER_PART_PER_ROUND_V1,
  AgenticAskOutputErrorV1,
  JUDGE_PROMPT,
  PLAN_PROMPT,
  SUMMARY_PROMPT,
  WRITER_PROMPT,
  fallbackPlan,
  judgeSchema,
  parseDraft,
  parseJudge,
  parsePlan,
  parseSummary,
  planSchema,
  summarySchema,
  writerSchema,
  type DraftPart,
  type DraftStatement,
  type Judge,
  type PartPlan,
} from "./agentic-ask-v1-model-protocol.js";
import { compactAndValidateAgenticAskResponseV1 } from "./agentic-ask-v1-response.js";

export {
  AGENTIC_ASK_MAX_PAD_ITEMS_V1,
  AGENTIC_ASK_MAX_PARTS_V1,
  AGENTIC_ASK_MAX_QUERIES_PER_PART_PER_ROUND_V1,
  AgenticAskOutputErrorV1,
} from "./agentic-ask-v1-model-protocol.js";

/** The V3 loop has one request-wide model-call budget. Repairs spend it too. */
export const AGENTIC_ASK_MAX_MODEL_CALLS_V1 = 12;
export const AGENTIC_ASK_MAX_ROUNDS_V1 = 3;
export const AGENTIC_ASK_MAX_PAD_BYTES_V1 = 49_152;
export const AGENTIC_ASK_MAX_NEW_ITEMS_PER_PART_PER_ROUND_V1 = 8;
export const AGENTIC_ASK_DEADLINE_MS_V1 = 60_000;
export const AGENTIC_ASK_WRITING_RESERVE_MS_V1 = 15_000;
export const AGENTIC_ASK_MAX_DISCOVERY_OPENS_V1 = 5;
export const AGENTIC_ASK_MAX_WRITER_ITEMS_V1 = 20;
export const AGENTIC_ASK_MAX_WRITER_BYTES_V1 = 32_768;
const AGENTIC_ASK_OUTPUT_TOKENS_V1 = Object.freeze({ plan: 1_200, judge: 4_096, writer: 1_800, summary: 800 } as const);

/** The hard request deadline elapsed before a release-safe response could finish. */
export class AgenticAskDeadlineErrorV1 extends Error {
  constructor() {
    super("agentic Ask deadline exhausted");
    this.name = "AgenticAskDeadlineErrorV1";
  }
}

/** A provider produced a complete response object with an unusable terminal state. */
class AgenticAskRecoverableGenerationErrorV1 extends AgenticAskOutputErrorV1 {
  constructor(message: string, readonly retry: boolean) { super(message); }
}

export type AgenticAskStatementV1 = PersonAnswerStatementV4;
export type AgenticAskRecordFallbackV1 = PersonAnswerEvidenceFallbackV4;
export type AgenticAskPartV1 = PersonAnswerPartV4;
export type AgenticAskCitationV1 = PersonAnswerCitationV4;
export type AgenticAskResultV1 = PersonAnswerResponseV4;

/** Content-free terminal witness. Route adapters bind identity and storage details. */
export interface AgenticAskAuditEntryV1 {
  readonly kind: "echo-agentic-ask-audit-v1";
  readonly outcome: AgenticAskResultV1["outcome"] | "cancelled" | "timed_out";
  readonly receipt_digests: readonly Sha256Digest[];
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
  readonly role: "plan" | "judge" | "writer" | "summary";
  readonly finish_reason: string | null;
  readonly usage: StructuredGenerationUsageV1 | null;
}

export interface AgenticAskAuditPortV1 {
  append(entry: AgenticAskAuditEntryV1): Promise<unknown> | unknown;
}

export interface CreateAgenticAskV1Options {
  readonly desk: EvidenceDeskPortV1;
  readonly model: StructuredGenerationPort;
  /** The existing provider binding; V3 deliberately uses answer_model for every role. */
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly audit: AgenticAskAuditPortV1;
  /** Monotonic milliseconds, supplied by tests or the route telemetry clock. */
  readonly now_ms?: () => number;
  /** Experimental measured switch. Disabled unless the route explicitly opts in. */
  readonly small_scope_shortcut?: boolean;
}
type UnmaterializedStatement = { readonly text: string; readonly citation_ids: readonly string[]; readonly private: boolean };
type UnmaterializedRecordFallback = { readonly text: string; readonly citation_ids: readonly string[]; readonly private: boolean };
type UnmaterializedPart = {
  readonly question: string;
  readonly status: PersonAnswerPartV4["status"];
  readonly statements: readonly UnmaterializedStatement[];
  readonly gap?: string;
  readonly records?: readonly UnmaterializedRecordFallback[];
};

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
function recoverableGenerationFailure(error: unknown): AgenticAskRecoverableGenerationErrorV1 | null {
  const diagnostic = errorDiagnostic(error);
  if (["adapter_json", "adapter_finish", "adapter_refusal"].includes(diagnostic.failure_class ?? "") || (diagnostic.failure_class === "adapter_response" && diagnostic.http_status !== null && diagnostic.http_status >= 200 && diagnostic.http_status < 300)) return new AgenticAskRecoverableGenerationErrorV1("model returned invalid structured output", true);
  if (["adapter_timeout", "adapter_transport"].includes(diagnostic.failure_class ?? "")) return new AgenticAskRecoverableGenerationErrorV1("model was unavailable", false);
  return null;
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof AgenticAskDeadlineErrorV1
    ? signal.reason
    : new DOMException("Ask cancelled", "AbortError");
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
function text(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && value.trim() === value && value === value.normalize("NFC") && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value : null;
}
function privateItem(item: EvidenceDeskItemV1): boolean {
  return item.visibility === "only_me" || item.visibility === "approver_only";
}
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}
function recoverableFallback(error: unknown): boolean {
  return error instanceof AgenticAskOutputErrorV1;
}
function abort(): never { throw new DOMException("Ask cancelled", "AbortError"); }
function deskQuery(value: string): string | null {
  try { return validatePersonQueryText(value); } catch { return null; }
}
function itemBytes(item: EvidenceDeskItemV1): number { return Buffer.byteLength(JSON.stringify(item), "utf8"); }
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) current.push(Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)));
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}
function nearSpelling(question: string, evidence: readonly EvidenceDeskItemV1[]): { readonly asked: string; readonly assumed: string } | null {
  const asked = question.match(/\b[A-Z][\p{L}]{1,}\b/gu) ?? [];
  const candidates = evidence.flatMap(item => `${item.label}\n${item.text ?? ""}`.match(/\b[A-Z][\p{L}]{1,}\b/gu) ?? []);
  for (const source of asked) for (const candidate of candidates) {
    if (source === candidate || source[0] !== candidate[0]) continue;
    const maximum = source.length <= 6 ? 1 : 2;
    if (editDistance(source.toLocaleLowerCase(), candidate.toLocaleLowerCase()) <= maximum) return Object.freeze({ asked: source, assumed: candidate });
  }
  return null;
}

export function createAgenticAskV1(options: CreateAgenticAskV1Options) {
  const now = options.now_ms ?? (() => performance.now());
  return Object.freeze({
    async answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<AgenticAskResultV1> {
      if (text(input.question, 4_000) === null) throw new AgenticAskOutputErrorV1("question is invalid");
      const startedAt = now();
      const deadline = startedAt + AGENTIC_ASK_DEADLINE_MS_V1;
      const terminalAbort = new AbortController();
      const activeSignal = input.signal === undefined
        ? terminalAbort.signal
        : AbortSignal.any([input.signal, terminalAbort.signal]);
      let deadlineExpired = false;
      const deadlineTimer = setTimeout(() => { deadlineExpired = true; terminalAbort.abort(new AgenticAskDeadlineErrorV1()); }, AGENTIC_ASK_DEADLINE_MS_V1);
      deadlineTimer.unref?.();
      let calls = 0; let repairs = 0; let fallbacks = 0; let rounds = 0; let checkedAt: string | null = null;
      let terminalAudited = false;
      const generations: AgenticAskGenerationObservationV1[] = [];
      const invocation_digests: Sha256Digest[] = [];
      let admission: Promise<void> = Promise.resolve();
      let terminalDeskFailure: unknown;
      const receipts: Sha256Digest[] = [];
      const pad = new Map<string, EvidenceDeskItemV1>();
      const notice = new Set<string>();
      const partItems = new Map<string, Set<string>>();
      const literalQuestionItems = new Set<string>();
      const partTriedQueries = new Map<string, Set<string>>();
      let roundAdditions = new Map<string, number>();
      const triedQueries = new Set<string>();
      const searchResults = new Map<string, readonly EvidenceDeskItemV1[]>();
      const assertLive = (reserve = 0) => {
        if (input.signal?.aborted) abort();
        if (deadlineExpired) throw new AgenticAskDeadlineErrorV1();
        if (activeSignal.aborted) throw new DOMException("Ask stopped", "AbortError");
        if (now() >= deadline) throw new AgenticAskDeadlineErrorV1();
        if (reserve > 0 && now() >= deadline - reserve) throw new AgenticAskOutputErrorV1("agentic Ask writing reserve exhausted");
      };
      const addReceipt = (item: EvidenceDeskItemV1) => { if (!receipts.includes(item.receipt_sha256)) receipts.push(item.receipt_sha256); };
      const observeDeskResult = (result: { readonly items: readonly EvidenceDeskItemV1[]; readonly receipt_digests: readonly Sha256Digest[]; readonly notice?: string }) => {
        if (result.notice !== undefined) notice.add(result.notice);
        // Audits bind every released item, even if it does not fit the prompt pad.
        for (const item of result.items) addReceipt(item);
        for (const receipt of result.receipt_digests) if (!receipts.includes(receipt)) receipts.push(receipt);
      };
      const add = (partIds: readonly string[], items: readonly EvidenceDeskItemV1[], perPartLimit: number) => {
        for (const item of items) {
          if (item.text === undefined || item.text.length === 0) continue;
          const itemSize = itemBytes(item);
          const wouldFit = pad.has(item.id) || (pad.size < AGENTIC_ASK_MAX_PAD_ITEMS_V1 && [...pad.values()].reduce((total, current) => total + itemBytes(current), 0) + itemSize <= AGENTIC_ASK_MAX_PAD_BYTES_V1);
          if (!wouldFit) continue;
          const eligible = partIds.filter(id => (roundAdditions.get(id) ?? 0) < perPartLimit || partItems.get(id)?.has(item.id) === true);
          if (eligible.length === 0) continue;
          if (!pad.has(item.id)) pad.set(item.id, item);
          for (const id of eligible) {
            const set = partItems.get(id) ?? new Set<string>();
            const wasNewForPart = !set.has(item.id);
            set.add(item.id); partItems.set(id, set);
            if (wasNewForPart) roundAdditions.set(id, (roundAdditions.get(id) ?? 0) + 1);
          }
        }
      };
      const addLiteralQuestionItems = (items: readonly EvidenceDeskItemV1[]) => {
        for (const item of items) {
          if (item.text === undefined || item.text.length === 0) continue;
          const itemSize = itemBytes(item);
          const wouldFit = pad.has(item.id) || (pad.size < AGENTIC_ASK_MAX_PAD_ITEMS_V1 && [...pad.values()].reduce((total, current) => total + itemBytes(current), 0) + itemSize <= AGENTIC_ASK_MAX_PAD_BYTES_V1);
          if (!wouldFit) continue;
          if (!pad.has(item.id)) pad.set(item.id, item);
          literalQuestionItems.add(item.id);
        }
      };
      const trackQuery = (query: string, target: readonly string[]) => {
        for (const id of target) {
          const queries = partTriedQueries.get(id) ?? new Set<string>();
          queries.add(query);
          partTriedQueries.set(id, queries);
        }
      };
      const search = async (query: string, target: readonly string[], limit: number) => {
        assertLive(AGENTIC_ASK_WRITING_RESERVE_MS_V1);
        trackQuery(query, target);
        const previous = searchResults.get(query);
        if (previous !== undefined) {
          add(target, previous, AGENTIC_ASK_MAX_NEW_ITEMS_PER_PART_PER_ROUND_V1);
          return;
        }
        triedQueries.add(query);
        const result = await raceAbort(activeSignal, options.desk.search({ query, limit, signal: activeSignal }));
        observeDeskResult(result);
        searchResults.set(query, result.items);
        add(target, result.items, AGENTIC_ASK_MAX_NEW_ITEMS_PER_PART_PER_ROUND_V1);
      };
      const searchRoundRobin = async (query: string, target: readonly string[], limit: number) => {
        assertLive(AGENTIC_ASK_WRITING_RESERVE_MS_V1);
        trackQuery(query, target);
        if (triedQueries.has(query) || target.length === 0) return;
        triedQueries.add(query);
        const result = await raceAbort(activeSignal, options.desk.search({ query, limit, signal: activeSignal }));
        observeDeskResult(result);
        searchResults.set(query, result.items);
        if (query === input.question) addLiteralQuestionItems(result.items);
        else for (const [index, item] of result.items.entries()) add([target[index % target.length]!], [item], AGENTIC_ASK_MAX_NEW_ITEMS_PER_PART_PER_ROUND_V1);
      };
      const searchWhileReserved = async (operation: () => Promise<void>): Promise<boolean> => {
        if (deadlineExpired || now() >= deadline) assertLive();
        if (now() >= deadline - AGENTIC_ASK_WRITING_RESERVE_MS_V1) return false;
        await operation();
        return true;
      };
      const smallScopeItems = async (): Promise<readonly string[] | undefined> => {
        if (options.small_scope_shortcut !== true) return undefined;
        // A shortcut probe is optional. Preserve terminal cancellation and the
        // hard deadline, but fall through to the regular bounded path once the
        // writing reserve starts instead of failing the whole answer.
        assertLive();
        if (now() >= deadline - AGENTIC_ASK_WRITING_RESERVE_MS_V1) return undefined;
        const inventory = await raceAbort(activeSignal, options.desk.search({ limit: AGENTIC_ASK_MAX_WRITER_ITEMS_V1, inventory_mode: "items", signal: activeSignal }));
        observeDeskResult(inventory);
        // A capped/truncated inventory cannot prove that this is the complete
        // readable scope, so it deliberately falls through to normal search.
        if (inventory.truncated || inventory.items.length > AGENTIC_ASK_MAX_WRITER_ITEMS_V1) return undefined;
        assertLive();
        if (now() >= deadline - AGENTIC_ASK_WRITING_RESERVE_MS_V1) return undefined;
        const provisional = new Map<string, EvidenceDeskItemV1>();
        for (const inventoryItem of inventory.items) {
          assertLive();
          if (now() >= deadline - AGENTIC_ASK_WRITING_RESERVE_MS_V1) return undefined;
          const opened = await raceAbort(activeSignal, options.desk.open({ item: inventoryItem.id, signal: activeSignal }));
          observeDeskResult(opened);
          // An open may include a truncated neighbour expansion. The inventory
          // is still complete when this coordinate itself resolves exactly.
          const exact = opened.items.find(item => item.id === inventoryItem.id && item.text !== undefined);
          // Every inventory coordinate must yield one readable item. Duplicate
          // identities or a neighbour-only open cannot establish completeness.
          if (exact === undefined || provisional.has(exact.id)) return undefined;
          provisional.set(exact.id, exact);
        }
        const values = [...provisional.values()];
        const bytes = values.reduce((total, item) => total + itemBytes(item), 0);
        if (values.length !== inventory.items.length || values.length > AGENTIC_ASK_MAX_WRITER_ITEMS_V1 || bytes > AGENTIC_ASK_MAX_WRITER_BYTES_V1 || values.length > AGENTIC_ASK_MAX_PAD_ITEMS_V1 || bytes > AGENTIC_ASK_MAX_PAD_BYTES_V1) return undefined;
        // Commit only after the whole inventory proves it fits. This keeps a
        // failed probe out of round/part tagging while desk releases remain
        // covered by the normal pre-call revalidation fence.
        for (const item of values) pad.set(item.id, item);
        return Object.freeze(values.map(item => item.id));
      };
      const call = async (role: "plan" | "judge" | "writer" | "summary", system_prompt: string, user: unknown, schema: StructuredGenerationJsonSchema, reserve: number): Promise<unknown> => {
        // Admission is serialized so every call is preceded by a cumulative desk revalidation;
        // provider work begins after admission and may run in parallel with later writers.
        let modelInput: StructuredGenerationInput | undefined;
        const previous = admission;
        let releaseAdmission!: () => void;
        admission = new Promise<void>(resolve => { releaseAdmission = resolve; });
        await previous;
        try {
          if (terminalDeskFailure !== undefined) throw terminalDeskFailure;
          assertLive(reserve);
          if (calls >= AGENTIC_ASK_MAX_MODEL_CALLS_V1) throw new AgenticAskOutputErrorV1("agentic Ask call budget exhausted");
          let validated: { readonly checked_at: string };
          try {
            validated = await raceAbort(activeSignal, options.desk.revalidate({ signal: activeSignal }));
          } catch (error) {
            terminalDeskFailure ??= error;
            throw error;
          }
          checkedAt = validated.checked_at;
          assertLive(reserve);
          calls += 1;
          modelInput = Object.freeze({ model: options.generation.answer_model, system_prompt, user_prompt: JSON.stringify(user), schema, max_output_tokens: AGENTIC_ASK_OUTPUT_TOKENS_V1[role], timeout_ms: Math.max(1, Math.min(options.generation.timeout_ms, deadline - now() - reserve)), signal: activeSignal });
          invocation_digests.push(canonicalSha256({ role, model: modelInput.model, system_prompt: modelInput.system_prompt, user_prompt: modelInput.user_prompt, schema: modelInput.schema, max_output_tokens: modelInput.max_output_tokens, timeout_ms: modelInput.timeout_ms }));
        } finally { releaseAdmission(); }
        if (modelInput === undefined) throw new AgenticAskOutputErrorV1("model admission failed");
        try {
          if (options.model.generate_with_observation !== undefined) {
            const observed = await raceAbort(activeSignal, options.model.generate_with_observation(modelInput));
            generations.push(Object.freeze({ role, finish_reason: observed.finish_reason, usage: observed.usage }));
            if (observed.finish_reason !== null && observed.finish_reason !== "stop") {
              throw new AgenticAskRecoverableGenerationErrorV1("model response was truncated, refused, or otherwise unfinished", true);
            }
            return observed.value;
          }
          const value = await raceAbort(activeSignal, options.model.generate(modelInput));
          generations.push(Object.freeze({ role, finish_reason: null, usage: null }));
          return value;
        } catch (error) {
          if (error instanceof AgenticAskRecoverableGenerationErrorV1) throw error;
          const diagnostic = errorDiagnostic(error);
          generations.push(Object.freeze({ role, finish_reason: diagnostic.finish_reason, usage: diagnostic.usage }));
          throw recoverableGenerationFailure(error) ?? error;
        }
      };
      const withRepair = async <T>(role: "plan" | "judge" | "writer" | "summary", system: string, user: unknown, schema: StructuredGenerationJsonSchema, reserve: number, parse: (value: unknown) => T): Promise<T> => {
        // Provider, desk, deadline and cancellation failures are terminal for this
        // invocation. Only a schema/grounding parse failure is eligible for repair.
        let first: unknown;
        try { first = await call(role, system, user, schema, reserve); }
        catch (error) {
          if (isAbort(error, input.signal) || !(error instanceof AgenticAskRecoverableGenerationErrorV1) || !error.retry || calls >= AGENTIC_ASK_MAX_MODEL_CALLS_V1) throw error;
          repairs += 1;
          return parse(await call(role, `${system} Your previous response was invalid. Return exactly the requested JSON schema.`, user, schema, reserve));
        }
        try { return parse(first); }
        catch (error) {
          if (isAbort(error, input.signal) || !(error instanceof AgenticAskOutputErrorV1) || calls >= AGENTIC_ASK_MAX_MODEL_CALLS_V1) throw error;
          repairs += 1;
          return parse(await call(role, `${system} Your previous response was invalid. Return exactly the requested JSON schema.`, user, schema, reserve));
        }
      };
      const audit = async (outcome: AgenticAskAuditEntryV1["outcome"], citations: number, result?: AgenticAskResultV1) => {
        const aggregate = (field: keyof StructuredGenerationUsageV1): number | null => {
          const values = generations.map(entry => entry.usage?.[field]);
          return values.length === 0 || values.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) ? null : values.reduce<number>((total, value) => total + value!, 0);
        };
        const finishReasonCounts: Record<string, number> = {};
        for (const generation of generations) if (generation.finish_reason !== null) finishReasonCounts[generation.finish_reason] = (finishReasonCounts[generation.finish_reason] ?? 0) + 1;
        await options.audit.append(Object.freeze({
          kind: "echo-agentic-ask-audit-v1", outcome, receipt_digests: Object.freeze([...receipts]), rounds, model_calls: calls, repairs, fallbacks, citation_count: citations, checked_at: checkedAt,
          prompt_sha256: outcome === "cancelled" || outcome === "timed_out" ? null : canonicalSha256({ generation: options.generation.generation_adapter_id, invocations: invocation_digests }),
          answer_sha256: result === undefined ? null : canonicalSha256({ direct: result.direct ?? null, parts: result.parts }),
          response_sha256: result === undefined ? null : canonicalSha256(result),
          generations: Object.freeze([...generations]),
          generation_usage: Object.freeze({ input_tokens: aggregate("input_tokens"), output_tokens: aggregate("output_tokens"), total_tokens: aggregate("total_tokens") }),
          finish_reason_counts: Object.freeze(finishReasonCounts),
        }));
        terminalAudited = true;
      };
      const judgeEvidence = () => [...pad.values()].map(item => ({ id: item.id, kind: item.kind, label: item.label, text: item.text, ...(item.attributes === undefined ? {} : { attributes: item.attributes }) }));
      const judgeParts = (parts: readonly PartPlan[]) => parts.map(part => ({ ...part, tried_queries: Object.freeze([...(partTriedQueries.get(part.id) ?? new Set<string>())]) }));
      try {
        let parts: readonly PartPlan[];
        try { parts = await withRepair("plan", PLAN_PROMPT, { question: input.question }, planSchema, AGENTIC_ASK_WRITING_RESERVE_MS_V1, parsePlan); }
        catch (error) { if (isAbort(error, input.signal) || !recoverableFallback(error)) throw error; parts = fallbackPlan(input.question); fallbacks += 1; }
        for (const part of parts) { partItems.set(part.id, new Set()); partTriedQueries.set(part.id, new Set()); }

        const shortcutItems = await smallScopeItems();
        let judge: Judge | undefined;
        if (shortcutItems === undefined) {
          rounds = 1;
          roundAdditions = new Map();
          let searchTimeRemaining = await searchWhileReserved(() => searchRoundRobin(input.question, parts.map(part => part.id), 10));
          for (const part of parts) for (const query of part.queries) {
            if (!searchTimeRemaining) break;
            if (query !== input.question) searchTimeRemaining = await searchWhileReserved(() => search(query, [part.id], 10));
          }

          // Lean discovery: only a true zero-result first round obtains the readable
          // inventory and opens its first bounded entries; labels never enter a model prompt.
          if (pad.size === 0 && searchTimeRemaining) {
            let inventory: { readonly items: readonly EvidenceDeskItemV1[] } | undefined;
            searchTimeRemaining = await searchWhileReserved(async () => {
              const result = await raceAbort(activeSignal, options.desk.search({ limit: 50, signal: activeSignal }));
              observeDeskResult(result);
              inventory = result;
            });
            for (const [index, item] of (inventory?.items ?? []).slice(0, AGENTIC_ASK_MAX_DISCOVERY_OPENS_V1).entries()) {
              if (!searchTimeRemaining) break;
              let opened: { readonly items: readonly EvidenceDeskItemV1[] } | undefined;
              searchTimeRemaining = await searchWhileReserved(async () => {
                const result = await raceAbort(activeSignal, options.desk.open({ item: item.id, signal: activeSignal }));
                observeDeskResult(result);
                opened = result;
              });
              if (opened !== undefined) add([parts[index % parts.length]!.id], opened.items, AGENTIC_ASK_MAX_NEW_ITEMS_PER_PART_PER_ROUND_V1);
            }
          }

          for (;;) {
            const ids = new Set(pad.keys());
            try {
              judge = await withRepair("judge", JUDGE_PROMPT, { question: input.question, parts: judgeParts(parts), evidence: judgeEvidence() }, judgeSchema, AGENTIC_ASK_WRITING_RESERVE_MS_V1, value => parseJudge(value, parts, ids));
            } catch (error) { if (isAbort(error, input.signal) || !recoverableFallback(error)) throw error; fallbacks += 1; break; }
            if (judge.parts.every(part => part.status === "answered") || rounds >= AGENTIC_ASK_MAX_ROUNDS_V1 || now() >= deadline - AGENTIC_ASK_WRITING_RESERVE_MS_V1) break;
            const before = pad.size; rounds += 1; roundAdditions = new Map();
            for (const judged of judge.parts.filter(part => part.status !== "answered")) {
              const plan = parts.find(part => part.id === judged.id)!;
              const unusedPlannerQueries = plan.queries.filter(query => !(partTriedQueries.get(plan.id)?.has(query) ?? false));
              const partTextQuery = deskQuery(plan.question);
              const queries = judged.new_queries.length > 0
                ? judged.new_queries
                : unusedPlannerQueries.length > 0
                  ? unusedPlannerQueries
                  : partTextQuery === null ? [] : [partTextQuery];
              for (const query of queries.slice(0, AGENTIC_ASK_MAX_QUERIES_PER_PART_PER_ROUND_V1)) {
                if (!(await searchWhileReserved(() => search(query, [plan.id], 10)))) break;
              }
            }
            if (pad.size === before) break;
          }
        }

        let assumption: string | undefined;
        if (judge !== undefined && !judge.matches_question) {
          const spelling = nearSpelling(input.question, [...pad.values()]);
          if (spelling !== null) {
            assumption = `Assuming '${spelling.asked}' means '${spelling.assumed}'.`;
            try {
              judge = await withRepair("judge", JUDGE_PROMPT, { question: input.question, assumption, parts: judgeParts(parts), evidence: judgeEvidence() }, judgeSchema, AGENTIC_ASK_WRITING_RESERVE_MS_V1, value => parseJudge(value, parts, new Set(pad.keys())));
            } catch (error) { if (isAbort(error, input.signal) || !recoverableFallback(error)) throw error; fallbacks += 1; }
          }
        }
        const assigned = new Map<string, readonly string[]>();
        for (const part of parts) {
          const candidates = shortcutItems === undefined
            ? [
              ...(judge?.parts.find(value => value.id === part.id)?.evidence_ids ?? []),
              ...(partItems.get(part.id) ?? new Set<string>()),
              ...literalQuestionItems,
            ]
            : shortcutItems;
          const ids: string[] = []; let bytes = 0;
          for (const id of candidates) {
            if (ids.includes(id)) continue;
            const item = pad.get(id);
            if (item === undefined || ids.length >= AGENTIC_ASK_MAX_WRITER_ITEMS_V1 || bytes + itemBytes(item) > AGENTIC_ASK_MAX_WRITER_BYTES_V1) continue;
            ids.push(id); bytes += itemBytes(item);
          }
          assigned.set(part.id, Object.freeze(ids));
        }
        const drafts = await Promise.all(parts.map(async part => {
          const ids = assigned.get(part.id)!;
          if (ids.length === 0 || now() >= deadline) return Object.freeze({ part, draft: null as DraftPart | null, fallback: false });
          const allowed = new Set(ids);
          const evidence = ids.map(id => pad.get(id)).filter((item): item is EvidenceDeskItemV1 => item !== undefined);
          try {
            return Object.freeze({ part, draft: await withRepair("writer", WRITER_PROMPT, { question: part.question, evidence: evidence.map(item => ({ id: item.id, kind: item.kind, label: item.label, text: item.text, attributes: item.attributes })) }, writerSchema, 0, value => parseDraft(value, allowed)), fallback: false });
          } catch (error) { if (isAbort(error, input.signal) || !recoverableFallback(error)) throw error; fallbacks += 1; return Object.freeze({ part, draft: null as DraftPart | null, fallback: true }); }
        }));

        const used = new Map<string, EvidenceDeskItemV1>();
        const partResults: UnmaterializedPart[] = [];
        for (const written of drafts) {
          const ids = assigned.get(written.part.id)!;
          if (written.draft === null || written.draft.statements.length === 0) {
            const evidence = ids.map(id => pad.get(id)).filter((item): item is EvidenceDeskItemV1 => item !== undefined);
            if (evidence.length === 0) partResults.push(Object.freeze({ question: written.part.question, status: "not_found", statements: Object.freeze([]), gap: "I couldn't find evidence in the records you can access." }));
            else {
              for (const item of evidence) used.set(item.id, item);
              partResults.push(Object.freeze({ question: written.part.question, status: "records_only", statements: Object.freeze([]), records: Object.freeze(evidence.map(item => Object.freeze({ text: item.text!, citation_ids: Object.freeze([item.id]), private: privateItem(item) }))), gap: "I found these records, but could not produce a verified summary." }));
            }
            continue;
          }
          const statements = written.draft.statements.map(statement => {
            const evidence = statement.evidence_ids.map(id => pad.get(id)).filter((item): item is EvidenceDeskItemV1 => item !== undefined);
            for (const item of evidence) used.set(item.id, item);
            return Object.freeze({ text: statement.text, citation_ids: Object.freeze(statement.evidence_ids), private: evidence.some(privateItem) });
          });
          const judgedStatus = judge?.parts.find(part => part.id === written.part.id)?.status;
          const status = statements.length === 0 ? "partial" as const : (judgedStatus === "partial" || written.draft.gap !== undefined ? "partial" as const : "answered" as const);
          const gap = written.draft.gap ?? (judgedStatus === "partial" ? "I could not verify every requested detail from the accessible evidence." : undefined);
          partResults.push(Object.freeze({ question: written.part.question, status, statements: Object.freeze(statements), ...(gap === undefined ? {} : { gap }) }));
        }

        let directDraft: DraftStatement | null = null;
        const allStatementIds = new Set(partResults.flatMap(part => part.statements.flatMap(statement => statement.citation_ids)));
        if (allStatementIds.size > 0 && calls < AGENTIC_ASK_MAX_MODEL_CALLS_V1 && now() < deadline) {
          try { directDraft = await withRepair("summary", SUMMARY_PROMPT, { parts: partResults.map(part => ({ question: part.question, statements: part.statements.map(statement => ({ text: statement.text, evidence_ids: statement.citation_ids })) })) }, summarySchema, 0, value => parseSummary(value, allStatementIds)); }
          catch (error) { if (isAbort(error, input.signal) || !recoverableFallback(error)) throw error; fallbacks += 1; }
        }
        if (directDraft !== null) for (const id of directDraft.evidence_ids) { const item = pad.get(id); if (item !== undefined) used.set(id, item); }
        const citations = [...used.values()];
        const citationIndex = new Map(citations.map((item, index) => [item.id, index]));
        const materialize = (statement: UnmaterializedStatement): AgenticAskStatementV1 => Object.freeze({ text: statement.text, private: statement.private, citation_indexes: Object.freeze(statement.citation_ids.map(id => citationIndex.get(id)).filter((index): index is number => index !== undefined)) });
        const materializeFallback = (record: UnmaterializedRecordFallback): AgenticAskRecordFallbackV1 => Object.freeze({ text: record.text, private: record.private, citation_indexes: Object.freeze(record.citation_ids.map(id => citationIndex.get(id)).filter((index): index is number => index !== undefined)) });
        const finishedParts: readonly AgenticAskPartV1[] = Object.freeze(partResults.map(part => Object.freeze({ question: part.question, status: part.status, statements: Object.freeze(part.statements.map(materialize)), ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.records === undefined ? {} : { records: Object.freeze(part.records.map(materializeFallback)) }) })));
        const direct = directDraft === null ? undefined : materialize(Object.freeze({ text: directDraft.text, citation_ids: directDraft.evidence_ids, private: directDraft.evidence_ids.some(id => privateItem(pad.get(id)!)) }));
        const outcomes = finishedParts.map(part => part.status);
        const noReleasedStatement = outcomes.every(status => status === "not_found");
        const scopeRejected = judge !== undefined && !judge.matches_question;
        const outcome = scopeRejected && noReleasedStatement ? "off_scope" : noReleasedStatement ? "not_found" : outcomes.every(status => status === "answered") ? "answered" : "partial";
        // The response already retains the asker's part text. Do not echo a
        // valid 4 KB question into the bounded public notice.
        if (outcome === "off_scope" && judge!.note.length > 0) notice.add(judge!.note);
        const result: AgenticAskResultV1 = Object.freeze({ schema_version: 4, kind: "echo-clean-person-answer-v4", scope: options.desk.scope, outcome, ...(direct === undefined ? {} : { direct }), parts: Object.freeze(finishedParts), citations: Object.freeze(citations.map(item => Object.freeze({ citation: item.citation, kind: item.kind, label: item.label, visibility: item.visibility }))), ...(assumption === undefined ? {} : { assumption }), ...(notice.size === 0 ? {} : { notice: [...notice].join(" ") }) });
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
          throw error;
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
