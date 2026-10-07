import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type {
  PersonAnswerResponseV5,
  PersonAnswerResponseV6,
  PersonAnswerResponseV4,
} from "@echo-brain/organization-api";
import type { AnswerCompositionGenerationProfileV1 } from "../composition/answer-composition-generation-bundle-v1.js";
import type {
  AnswerCompositionGenerationObservationV1,
  AnswerCompositionStageObservationV1,
  StructuredGenerationFinishReasonV1,
  StructuredGenerationPort,
  StructuredGenerationUsageV1,
} from "./structured-generation-v1.js";
import {
  liveSourceDescriptorV2,
  type EvidenceDeskPortV2,
  type EvidenceDeskSourceV2,
} from "../shared/evidence-desk-v2.js";
import type { EvidenceDeskPortV1 } from "../shared/evidence-desk-v1.js";
import { annotateCoreRuntimeV1 } from "../shared/core-runtime-observation-v1.js";
import {
  ANSWER_PROMPT,
  AgenticAskOutputErrorV1,
  CHECK_TASK_PROMPT,
  STEP_PROMPT,
  SWEEP_TASK_PROMPT,
  type StepSource,
} from "./agentic-ask-v1-model-protocol.js";
import { trimAgenticEvidenceBundleV1, type AgenticEvidenceBundleV1 } from "./agentic-evidence-bundle-v1.js";
import {
  AGENTIC_MODEL_OUTPUT_TOKENS_V1 as OUTPUT_TOKENS,
  AgenticAskDeadlineErrorV1,
  abort,
  createAgenticModelGateV1,
  isAbort,
  object,
  type AgenticAskModelRoleV1,
} from "./agentic-model-gate-v1.js";
import { auditAgenticTerminalV1, releaseAgenticResultV1, type AgenticAskAuditPortV1, type AgenticAuditContextV1 } from "./agentic-release-v1.js";
import { AGENTIC_ASK_FINALIZE_RESERVE_MS_V1, createAgenticResearchLoopV1, type AgenticResearchSourceV1 } from "./agentic-research-loop-v1.js";
import { createAskRendererV1 } from "./renderers/ask-renderer-v1.js";
import {
  AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  AGENTIC_RESEARCH_MAX_FINDING_CITATIONS_V1,
  AGENTIC_RESEARCH_MAX_FINDINGS_V1,
  type AgenticAskWithResearchV1,
  type AgenticResearchBudgetV1,
  type AgenticResearchGoalV1,
  type AgenticResearchInputV1,
  type AgenticResearchResultV1,
  type AgenticResearchTriggerV1,
} from "./agentic-research-v1.js";

export {
  AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  type AgenticAskWithResearchV1,
  type AgenticResearchBudgetV1,
  type AgenticResearchFindingV1,
  type AgenticResearchGoalV1,
  type AgenticResearchInputV1,
  type AgenticResearchResultV1,
  type AgenticResearchTriggerV1,
} from "./agentic-research-v1.js";
export {
  AGENTIC_ASK_MIN_ANSWER_MS_V1,
  AGENTIC_ASK_MIN_STEP_MS_V1,
  AgenticAskDeadlineErrorV1,
  type AgenticAskGenerationObservationV1,
  type AgenticAskModelRoleV1,
} from "./agentic-model-gate-v1.js";
export type { AgenticAskAuditEntryV1, AgenticAskAuditPortV1 } from "./agentic-release-v1.js";
export {
  AGENTIC_ASK_MAX_ACTIONS_PER_STEP_V1,
  AGENTIC_ASK_MAX_PARTS_V1,
  AgenticAskOutputErrorV1,
} from "./agentic-ask-v1-model-protocol.js";
export { AGENTIC_ASK_FINALIZE_RESERVE_MS_V1 } from "./agentic-research-loop-v1.js";

/**
 * Agentic Ask (RFC-0003): the research loop (agentic-research-loop-v1.ts:
 * three read tools, search, open and list, plus `finish`), then Ask's
 * renderer (renderers/ask-renderer-v1.ts): one answer call over the evidence
 * bundle and a code-owned layout. This file is the request runner: request
 * setup, the model gate, the renderer call, release and the terminal audits.
 */
export const AGENTIC_ASK_MAX_STEPS_V1 = AGENTIC_RESEARCH_LIVE_BUDGET_V1.max_rounds;
/** Request-wide model-call budget, including retries and repairs. */
export const AGENTIC_ASK_MAX_MODEL_CALLS_V1 = AGENTIC_RESEARCH_LIVE_BUDGET_V1.max_model_calls;
/**
 * The whole request, research through audit (ADR-0022). The Authority is
 * reached through Cloudflare, whose proxy drops an origin response that takes
 * more than 100 s (HTTP 524), so a longer loop could never return. 90 s
 * leaves room for the network; per-call time is also capped by the
 * generation profile.
 */
export const AGENTIC_ASK_DEADLINE_MS_V1 = AGENTIC_RESEARCH_LIVE_BUDGET_V1.deadline_ms;
/** Time kept for the final answer call; research never starts inside it. */
export const AGENTIC_ASK_ANSWER_RESERVE_MS_V1 = AGENTIC_RESEARCH_LIVE_BUDGET_V1.writer_reserve_ms;
/** Context window assumed when the generation profile does not state one. */
export const AGENTIC_ASK_DEFAULT_CONTEXT_TOKENS_V1 = 32_768;
/** Conservative bytes per token for prompt budgeting. */
const BYTES_PER_TOKEN = 3;
/** Share of the context window left unused as a safety margin. */
const CONTEXT_MARGIN = 0.1;

/** Scratchpad bytes that fit beside a system prompt and an output reserve in the model's context window. */
export function agenticAskContextBudgetBytesV1(contextTokens: number | undefined, systemPrompt: string, outputTokens: number): number {
  const tokens = typeof contextTokens === "number" && Number.isSafeInteger(contextTokens) && contextTokens > 0 ? contextTokens : AGENTIC_ASK_DEFAULT_CONTEXT_TOKENS_V1;
  const usable = Math.floor(tokens * (1 - CONTEXT_MARGIN)) - Math.ceil(Buffer.byteLength(systemPrompt, "utf8") / BYTES_PER_TOKEN) - outputTokens;
  return Math.max(16 * 1024, usable * BYTES_PER_TOKEN);
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
  /**
   * Content-free stage timings for the Ask journey, in the same shape as the
   * V2 composition: retrieval (desk time during research), planner (research
   * step calls), context, answer, revalidation (final fence) and audit.
   * Observer failures never alter the answer.
   */
  readonly on_stage?: (event: AnswerCompositionStageObservationV1) => void;
}

const FINISH_REASONS: readonly StructuredGenerationFinishReasonV1[] = ["stop", "length", "content_filter", "error", "other"];

/** A directory name the prompts may carry: one trimmed line of 1 to 200 characters, or none. */
function askerName(value: { readonly display_name: string } | undefined): string | undefined {
  const name = typeof value?.display_name === "string" ? value.display_name.trim() : "";
  return name.length === 0 || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name) ? undefined : name;
}

function questionText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 4_000 && value.trim() === value && value === value.normalize("NFC") && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value : null;
}
/** A research goal the request can run, or null. Ask's question keeps its existing bounds. */
function researchGoal(goal: AgenticResearchGoalV1): AgenticResearchGoalV1 | null {
  if (goal.kind === "question") return questionText(goal.question) === null ? null : goal;
  if (goal.kind === "check_record") return object(goal.record) === null ? null : goal;
  if (goal.kind !== "recheck_findings" || !Array.isArray(goal.findings) || goal.findings.length === 0 || goal.findings.length > AGENTIC_RESEARCH_MAX_FINDINGS_V1) return null;
  const line = (value: unknown) => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 1_000;
  return goal.findings.every(finding => line(finding.finding) && line(finding.expected) && Array.isArray(finding.citations) && finding.citations.length > 0 &&
    finding.citations.length <= AGENTIC_RESEARCH_MAX_FINDING_CITATIONS_V1 && finding.citations.every((citation: unknown) => object(citation) !== null)) ? goal : null;
}
/** What the model is told the desk reads. Adding a scope kind is a compile error here. */
function scopeText(scope: EvidenceDeskPortV2["scope"]): string {
  switch (scope.kind) {
    case "project": return "one project: meetings and documents are limited to it; live sources are limited to their saved project mappings. Only sources in source_catalog are available";
    case "mine": return "only what the asker added: their own notes and uploaded documents, and meetings they approved; shared live sources and shared transcripts are not read";
    case "global": return "everything the asker can read";
    default: return unknownScope(scope);
  }
}
function unknownScope(scope: never): never {
  throw new Error(`Ask scope ${String((scope as { readonly kind?: unknown }).kind)} is invalid`);
}

/** Older and loose source names models use in search and list arguments (readSource). */
const LIST_SOURCES: Readonly<Record<string, EvidenceDeskSourceV2>> = Object.freeze({
  meeting: "meeting", meetings: "meeting", record: "meeting", records: "meeting", decisions: "meeting",
  document: "document", documents: "document", doc: "document", docs: "document", file: "document", files: "document",
  slack: "slack", messages: "slack", message: "slack",
  ticket: "ticket", tickets: "ticket",
  page: "page", pages: "page", knowledge: "page", wiki: "page",
});

export interface CreateAgenticAskV2Options extends Omit<CreateAgenticAskV1Options, 'desk'> { readonly desk: EvidenceDeskPortV2 }
export function createAgenticAskV1(options: CreateAgenticAskV1Options) {
  return createAgenticAskCore(options as CreateAgenticAskV2Options, 4) as { answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV4> };
}
export function createAgenticAskV2(options: CreateAgenticAskV2Options) {
  return createAgenticAskCore(options, 5) as { answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV5> };
}
/** The research loop for every trigger, with Ask's V6 writer available beside research-only runs. */
export function createAgenticResearchV1(options: CreateAgenticAskV2Options) {
  return createAgenticAskCore(options, 6) as unknown as {
    answerWithResearch(input: { readonly question: string; readonly signal?: AbortSignal; readonly budget?: AgenticResearchBudgetV1 }): Promise<AgenticAskWithResearchV1<PersonAnswerResponseV6>>;
    research(input: AgenticResearchInputV1): Promise<AgenticResearchResultV1>;
    researchBundle(input: AgenticResearchInputV1): Promise<AgenticEvidenceBundleV1>;
  };
}
/** V3 core keeps V5 strict and emits V6 only when a live page source is selected. */
export function createAgenticAskV3(options: CreateAgenticAskV2Options) {
  return createAgenticAskCore(options, 6) as unknown as { answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV6> };
}
function createAgenticAskCore(options: CreateAgenticAskV2Options, responseVersion: 4 | 5 | 6) {
  const tickets = responseVersion >= 5;
  const now = options.now_ms ?? (() => performance.now());
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const askedBy = askerName(options.asker);
  const liveCatalog: AgenticResearchSourceV1[] = (options.desk.live_sources ?? []).flatMap(value => {
    const descriptor = liveSourceDescriptorV2(value);
    // Citation compatibility belongs to the response version, never a provider name.
    if (descriptor.kind === 'ticket' && (!tickets || options.desk.ticket_available === false || options.desk.scope.kind === 'mine')) return [];
    if (descriptor.kind === 'page' && (responseVersion !== 6 || options.desk.scope.kind === 'mine')) return [];
    return [{ ...descriptor, kinds: [descriptor.kind] }];
  });
  const researchSources: readonly AgenticResearchSourceV1[] = Object.freeze([
    { source_id: 'meeting', selector: 'meetings', kinds: ['imported_meeting', 'decision', 'action', 'rationale'], description: 'Imported meeting notes (unapproved), approved meeting decisions, and explicitly shared transcripts. Keep imported notes distinct from approved decisions.' },
    { source_id: 'document', selector: 'documents', kinds: ['note', 'document_passage'], description: 'Uploaded document passages and notes.' },
    ...liveCatalog,
  ]);
  const sourcesById = new Map(researchSources.map(source => [source.source_id, source]));
  const sourceCatalog: readonly { readonly source: StepSource; readonly description: string; readonly metadata_only_list?: boolean; readonly tool_id?: string; readonly requires_channel?: boolean; readonly default_since_days?: number }[] = Object.freeze(researchSources.map(({ source_id: _id, kinds: _kinds, selector, ...descriptor }) => Object.freeze({ ...descriptor, source: selector })));
  const readSource = (value: string | undefined): string | undefined => {
    const key = value?.trim().toLowerCase();
    if (key === undefined) return undefined;
    const exact = researchSources.find(source => source.selector === key || source.source_id === key);
    if (exact !== undefined) return exact.source_id;
    // Older model aliases are accepted only when their target remains uniquely advertised.
    const alias = LIST_SOURCES[key];
    if (alias === undefined) return undefined;
    if (sourcesById.has(alias)) return alias;
    const kind = alias === 'slack' ? 'slack_message' : alias;
    const compatible = researchSources.filter(source => source.kinds.length === 1 && source.kinds[0] === kind);
    return compatible.length === 1 ? compatible[0]!.source_id : undefined;
  };
  /** Who is asking and today's date: context for "my", "this week" and "overdue". */
  const context = (day: string) => ({ ...(askedBy === undefined ? {} : { asked_by: askedBy }), today: day });
  const liveGuidance = "Live sources report current tool context under the asker's connection. They are not approved meeting records. Use each source's selector and capabilities from source_catalog. Metadata-only search/list discovers items; open their request-owned ids before relying on their bodies. The server already applies scope and permissions. Never choose a tenant, account, connection or project mapping.";
  const stepPrompt = liveCatalog.length === 0 ? STEP_PROMPT : `${STEP_PROMPT}\n\n${liveGuidance}`;
  const answerPrompt = liveCatalog.length === 0 ? ANSWER_PROMPT : `${ANSWER_PROMPT}\n\n${liveGuidance}`;
  const stepBudget = agenticAskContextBudgetBytesV1(options.generation.context_tokens, stepPrompt, OUTPUT_TOKENS.step);
  /** Background triggers add one task paragraph; Ask keeps its prompt exactly. */
  const taskPrompts = { check_record: `${stepPrompt}\n\n${CHECK_TASK_PROMPT}`, recheck_findings: `${stepPrompt}\n\n${SWEEP_TASK_PROMPT}` } as const;
  const answerBudget = agenticAskContextBudgetBytesV1(options.generation.context_tokens, answerPrompt, OUTPUT_TOKENS.answer);
  /**
   * One agentic request: shared session state (deadline, model-call budget,
   * access fences, audit), the research loop, then Ask's renderer and the
   * shared release step.
   */
  type RequestOutput = { readonly response?: PersonAnswerResponseV4 | PersonAnswerResponseV5 | PersonAnswerResponseV6; readonly bundle: AgenticEvidenceBundleV1; readonly research: AgenticResearchResultV1; readonly writer_evidence: readonly string[] };
  const request = async (input: { readonly goal: AgenticResearchGoalV1; readonly trigger: AgenticResearchTriggerV1; readonly signal?: AbortSignal }, budget: AgenticResearchBudgetV1): Promise<RequestOutput> => {
      const goal = researchGoal(input.goal);
      if (goal === null) throw new AgenticAskOutputErrorV1(input.goal.kind === "question" ? "question is invalid" : "research goal is invalid");
      const researchOnly = goal.kind !== "question";
      const beyondLive = budget.deadline_ms > AGENTIC_RESEARCH_LIVE_BUDGET_V1.deadline_ms || budget.max_rounds > AGENTIC_RESEARCH_LIVE_BUDGET_V1.max_rounds || budget.max_model_calls > AGENTIC_RESEARCH_LIVE_BUDGET_V1.max_model_calls;
      const researchPrompt = goal.kind === "question" ? stepPrompt : taskPrompts[goal.kind];
      const researchBudget = goal.kind === "question" ? stepBudget : agenticAskContextBudgetBytesV1(options.generation.context_tokens, researchPrompt, OUTPUT_TOKENS.step);
      const startedAt = now();
      const requestDay = today();
      const deadline = startedAt + budget.deadline_ms;
      const terminalAbort = new AbortController();
      const activeSignal = input.signal === undefined ? terminalAbort.signal : AbortSignal.any([input.signal, terminalAbort.signal]);
      let deadlineExpired = false;
      const deadlineTimer = setTimeout(() => { deadlineExpired = true; terminalAbort.abort(new AgenticAskDeadlineErrorV1()); }, budget.deadline_ms);
      deadlineTimer.unref?.();
      let writerFallbacks = 0; let checkedAt: string | null = null;
      // ---- journey observation (content-free; never alters the answer) ----
      let phase: "research" | "answer" | "final" = "research";
      let deskMs = 0; let stepModelMs = 0; let answerModelMs = 0;
      const report = (event: Pick<AnswerCompositionStageObservationV1, "stage" | "event" | "elapsed_ms"> & Partial<AnswerCompositionStageObservationV1>): void => {
        if (options.on_stage === undefined) return;
        try {
          options.on_stage(Object.freeze({ failure_class: null, http_status: null, generation_usage: null, retrieval: null, ...event, elapsed_ms: Math.max(0, Math.round(event.elapsed_ms)) }));
        } catch { /* observation only */ }
      };
      /** Research desk time is wall time: overlapping reads occupy one interval. */
      let activeResearchDeskCalls = 0;
      let researchDeskStartedAt = 0;
      const timed = <T>(operation: () => Promise<T>): Promise<T> => {
        const research = phase === "research";
        if (research && activeResearchDeskCalls++ === 0) researchDeskStartedAt = now();
        const settle = () => {
          if (!research || --activeResearchDeskCalls !== 0) return;
          deskMs += Math.max(0, now() - researchDeskStartedAt);
        };
        return Promise.resolve().then(() => { assertLive(); return operation(); }).then(value => { settle(); return value; }, (error: unknown) => { settle(); throw error; });
      };
      const desk: EvidenceDeskPortV2 = Object.freeze({
        scope: options.desk.scope,
        search: (request: Parameters<EvidenceDeskPortV2["search"]>[0]) => timed(() => options.desk.search(request)),
        open: (request: Parameters<EvidenceDeskPortV2["open"]>[0]) => timed(() => options.desk.open(request)),
        list: (request: Parameters<EvidenceDeskPortV2["list"]>[0]) => timed(() => options.desk.list(request)),
        revalidate: (request: Parameters<EvidenceDeskPortV2["revalidate"]>[0]) => timed(() => options.desk.revalidate(request)),
        ...(options.desk.openCitation === undefined ? {} : { openCitation: (request: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]) => timed(() => options.desk.openCitation!(request)) }),
      });
      let terminalAudited = false;
      /** One role's calls summed, for the journey's LLM usage; any unreported part makes that total unknown. */
      const usageOf = (role: AgenticAskModelRoleV1, elapsedMs: number): AnswerCompositionGenerationObservationV1 | null => {
        const matching = gate.stats().generations.filter(entry => entry.role === role);
        if (matching.length === 0) return null;
        const sum = (field: keyof StructuredGenerationUsageV1): number | null =>
          matching.every(entry => typeof entry.usage?.[field] === "number") ? matching.reduce((total, entry) => total + (entry.usage![field] as number), 0) : null;
        const last = matching.at(-1)!.finish_reason;
        return Object.freeze({
          adapter_id: options.generation.generation_adapter_id, model: options.generation.answer_model,
          provider_latency_ms: Math.max(0, Math.round(elapsedMs)),
          input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), total_tokens: sum("total_tokens"),
          cached_input_tokens: sum("cached_input_tokens"), reasoning_tokens: sum("reasoning_tokens"),
          finish_reason: last === null ? null : FINISH_REASONS.includes(last as StructuredGenerationFinishReasonV1) ? last as StructuredGenerationFinishReasonV1 : "other",
        });
      };
      let selectedTicketCount = 0; let ticketContextCount = 0; let ticketCitationCount = 0;
      const scope = scopeText(options.desk.scope);

      const remaining = () => deadline - now();
      const assertLive = () => {
        if (input.signal?.aborted) abort();
        if (deadlineExpired || now() >= deadline) throw new AgenticAskDeadlineErrorV1();
        if (activeSignal.aborted) throw new DOMException("Ask stopped", "AbortError");
      };

      // ---- research: the loop owns its state; the runner reads its progress and its bundle ----
      const loop = createAgenticResearchLoopV1({
        desk, goal, trigger: input.trigger, budget, prompt: researchPrompt, prompt_budget: researchBudget,
        small_scope_preload: options.small_scope_shortcut === true && !researchOnly,
        context: context(requestDay), scope, source_catalog: sourceCatalog, sources_by_id: sourcesById, read_source: readSource,
        now, remaining, signal: activeSignal, assert_live: assertLive,
        observed: () => ({ checked_at: checkedAt, model_ms: stepModelMs, desk_ms: deskMs }),
      });
      const gate = createAgenticModelGateV1({
        generation: options.generation, model: options.model,
        desk_revalidate: request => desk.revalidate(request),
        on_checked: at => { checkedAt = at; },
        budget, now, deadline, signal: activeSignal,
        ...(input.signal === undefined ? {} : { input_signal: input.signal }),
        is_deadline_expired: () => deadlineExpired,
        on_span: event => {
          if (event.phase === "enter") { if (event.role === "answer") ticketContextCount = selectedTicketCount; return; }
          if (event.role === "step") stepModelMs += event.elapsed_ms; else answerModelMs += event.elapsed_ms;
        },
        ...loop.gate_hooks,
      });
      /** What every audit record of this request carries, read at the moment it is written. */
      const auditContext = (): AgenticAuditContextV1 => {
        const { receipts, rounds, fallbacks } = loop.progress();
        return {
          audit: options.audit, generation_adapter_id: options.generation.generation_adapter_id, gate_stats: gate.stats,
          ...(researchOnly ? { trigger: input.trigger as Exclude<AgenticResearchTriggerV1, "ask"> } : {}),
          background: beyondLive, receipts, rounds, fallbacks: fallbacks + writerFallbacks,
        };
      };

      try {
        const bundle = await loop.run(gate);
        const researched = trimAgenticEvidenceBundleV1(bundle);
        if (researchOnly) {
          // Research-only triggers: no writer runs; the trimmed bundle goes through the shared release step.
          phase = "final";
          const researchIncomplete = !bundle.stop.completed;
          const needs = bundle.plan.flatMap(part => part.needs);
          const found = needs.filter(value => value.status === "found").length;
          const outcome = found === 0 ? (researchIncomplete ? "partial" as const : "not_found" as const) : found === needs.length && !researchIncomplete ? "answered" as const : "partial" as const;
          await releaseAgenticResultV1({
            ...auditContext(), desk, outcome, citation_count: bundle.items.filter(item => item.cited_by_plan).length, result: researched,
            digests: { answer_sha256: canonicalSha256({ trigger: input.trigger, plan: researched.plan }), response_sha256: canonicalSha256(researched) },
            fence_after_audit: true, signal: activeSignal, assert_live: assertLive, now,
            on_checked: at => { checkedAt = at; }, on_audited: () => { terminalAudited = true; },
          });
          clearTimeout(deadlineTimer);
          return Object.freeze({ bundle, research: researched, writer_evidence: Object.freeze([]) });
        }

        // Research is over: its desk time is the journey's retrieval stage and its step calls the planner stage.
        phase = "answer";
        const { searches, search_hits } = loop.progress();
        report({ stage: "retrieval", event: "succeeded", elapsed_ms: deskMs, retrieval: { planned_query_count: searches, query_hit_count: search_hits, released_atom_count: bundle.items.length } });
        const stepUsage = usageOf("step", stepModelMs);
        report(stepUsage === null ? { stage: "planner", event: "skipped", elapsed_ms: 0 } : { stage: "planner", event: "succeeded", elapsed_ms: stepModelMs, generation_usage: stepUsage });

        // ---- Ask's renderer: the writer and the layout read only the bundle ----
        const writer = createAskRendererV1({
          response_version: responseVersion, answer_prompt: answerPrompt, answer_budget: answerBudget,
          source_catalog: sourceCatalog, scope, context: context(requestDay), desk_scope: options.desk.scope,
        });
        const ticketsAmong = (shorts: readonly string[]) => shorts.filter(short => bundle.items.find(item => item.short === short)?.item.citation.kind === "ticket").length;
        const rendered = await writer.render({
          bundle, trigger_input: { question: goal.question }, gate, signal: activeSignal,
          // The release step keeps its reserve after the writer.
          remaining: () => remaining() - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1,
          on_context: selected => {
            report({ stage: "context", event: "succeeded", elapsed_ms: 0, retrieval: { context_atom_count: selected.length } });
            // Counted as answer context only once the writer call starts (its span).
            selectedTicketCount = ticketsAmong(selected);
          },
        });
        writerFallbacks += rendered.fallbacks;
        const validated = rendered.result.response;
        // A failed answer call still ends in a response (records or not found); its span keeps the failure.
        const answerUsage = usageOf("answer", answerModelMs);
        report(answerUsage === null ? { stage: "answer", event: "skipped", elapsed_ms: 0 } : { stage: "answer", event: "succeeded", elapsed_ms: answerModelMs, generation_usage: answerUsage, retrieval: { citation_count: rendered.cited.length } });
        phase = "final";
        // V5/V6 keep the access check after the audit write; V4 never had one.
        await releaseAgenticResultV1({
          ...auditContext(), desk, outcome: rendered.outcome, citation_count: rendered.cited.length, result: validated, digests: "from_response",
          fence_after_audit: tickets, signal: activeSignal, assert_live: assertLive, now,
          on_checked: at => { checkedAt = at; }, on_audited: () => { terminalAudited = true; },
          on_stage: event => report(event.stage === "revalidation"
            ? { stage: "revalidation", event: "succeeded", elapsed_ms: event.elapsed_ms }
            : { stage: "audit", event: "succeeded", elapsed_ms: event.elapsed_ms, retrieval: { citation_count: rendered.cited.length } }),
        });
        clearTimeout(deadlineTimer);
        ticketCitationCount = validated.citations.filter(value => value.citation.kind === "ticket").length;
        return Object.freeze({ response: validated, bundle, research: researched, writer_evidence: rendered.result.writer_evidence });
      } catch (error) {
        clearTimeout(deadlineTimer);
        if (deadlineExpired || error instanceof AgenticAskDeadlineErrorV1) {
          terminalAbort.abort();
          if (!terminalAudited) await auditAgenticTerminalV1("timed_out", { ...auditContext(), checked_at: checkedAt });
          throw error instanceof AgenticAskDeadlineErrorV1 ? error : new AgenticAskDeadlineErrorV1();
        }
        if (input.signal?.aborted || isAbort(error, input.signal)) {
          terminalAbort.abort();
          if (!terminalAudited) await auditAgenticTerminalV1("cancelled", { ...auditContext(), checked_at: checkedAt });
          throw error;
        }
        terminalAbort.abort();
        throw error;
      } finally {
        if (tickets) annotateCoreRuntimeV1({ counts: { ticket_retrieved_items: loop.progress().retrieved_tickets, ticket_context_items: ticketContextCount, ticket_citations: ticketCitationCount } });
      }
  };
  return Object.freeze({
    async answer(input: { readonly question: string; readonly signal?: AbortSignal }) {
      return (await request({ goal: { kind: "question", question: input.question }, trigger: "ask", ...(input.signal === undefined ? {} : { signal: input.signal }) }, AGENTIC_RESEARCH_LIVE_BUDGET_V1)).response!;
    },
    /** Ask plus its research result and writer input, for the research evaluation. */
    async answerWithResearch(input: { readonly question: string; readonly signal?: AbortSignal; readonly budget?: AgenticResearchBudgetV1 }) {
      const output = await request({ goal: { kind: "question", question: input.question }, trigger: "ask", ...(input.signal === undefined ? {} : { signal: input.signal }) }, input.budget ?? AGENTIC_RESEARCH_LIVE_BUDGET_V1);
      return Object.freeze({ response: output.response!, research: output.research, writer_evidence: output.writer_evidence });
    },
    /** A research-only trigger (Check, Sweep): no writer; the result is audited and returned. */
    async research(input: AgenticResearchInputV1): Promise<AgenticResearchResultV1> {
      return (await request({ goal: input.goal, trigger: input.trigger, ...(input.signal === undefined ? {} : { signal: input.signal }) }, input.budget ?? AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1)).research;
    },
    /** The same run, returning the full server-side evidence bundle (renderers and tests). */
    async researchBundle(input: AgenticResearchInputV1): Promise<AgenticEvidenceBundleV1> {
      return (await request({ goal: input.goal, trigger: input.trigger, ...(input.signal === undefined ? {} : { signal: input.signal }) }, input.budget ?? AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1)).bundle;
    },
  });
}
