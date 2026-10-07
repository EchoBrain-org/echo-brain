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
  STEP_PROMPT,
  TASK_RULE_PROMPT,
} from "./agentic-ask-v1-model-protocol.js";
import { agenticTaskSlotsFitV1, type AgenticBriefV1 } from "./agentic-brief-v1.js";
import { trimAgenticEvidenceBundleV1, type AgenticEvidenceBundleV1 } from "./agentic-evidence-bundle-v1.js";
import {
  AGENTIC_ASK_FINALIZE_RESERVE_MS_V1,
  AGENTIC_MODEL_OUTPUT_TOKENS_V1 as OUTPUT_TOKENS,
  AgenticAskDeadlineErrorV1,
  abort,
  createAgenticModelGateV1,
  isAbort,
  object,
  type AgenticAskModelRoleV1,
} from "./agentic-model-gate-v1.js";
import { auditAgenticTerminalV1, releaseAgenticResultV1, type AgenticAskAuditPortV1, type AgenticAuditContextV1 } from "./agentic-release-v1.js";
import type { AgenticRendererV1, AgenticRenderOutputV1 } from "./agentic-renderer-v1.js";
import { createAgenticResearchLoopV1, type AgenticResearchCatalogEntryV1, type AgenticResearchCatalogV1, type AgenticResearchSourceV1 } from "./agentic-research-loop-v1.js";
import { createAskRendererV1 } from "./renderers/ask-renderer-v1.js";
import {
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  type AgenticAskWithResearchV1,
  type AgenticResearchBudgetV1,
  type AgenticResearchResultV1,
} from "./agentic-research-v1.js";

// Other workspaces reach these through this entry point.
export { AGENTIC_RESEARCH_BUDGETS_V1, type AgenticResearchResultV1 } from "./agentic-research-v1.js";
export { AgenticAskDeadlineErrorV1 } from "./agentic-model-gate-v1.js";
export type { AgenticAskAuditEntryV1, AgenticAskAuditPortV1 } from "./agentic-release-v1.js";

/**
 * Agentic Ask (RFC-0003): the research loop (agentic-research-loop-v1.ts:
 * three read tools, search, open and list, plus `finish`), then Ask's
 * renderer (renderers/ask-renderer-v1.ts): one answer call over the evidence
 * bundle and a code-owned layout. A task brief runs research only, or with
 * the renderer its trigger definition names. This file is the request runner:
 * request setup, the model gate, the renderer call, release and the terminal
 * audits.
 */

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
const AGENTIC_ASK_DEFAULT_CONTEXT_TOKENS_V1 = 32_768;
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

/** One run: the brief, and the trigger definition's name as a label for the audit and the evaluation. */
export interface AgenticResearchInputV1 {
  readonly trigger: string;
  readonly brief: AgenticBriefV1;
  readonly signal?: AbortSignal;
}

/** A task brief's run with its trigger definition's renderer, which receives the trigger's own input. */
export interface AgenticRenderedResearchInputV1<In, Out> extends AgenticResearchInputV1 {
  readonly renderer: AgenticRendererV1<In, Out>;
  readonly trigger_input: In;
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
/** A brief the request can run, or null. Ask's question keeps its existing bounds; a task's definition bounds its own text. */
function runnableBrief(brief: AgenticBriefV1): AgenticBriefV1 | null {
  const { goal, starting } = brief;
  if (!Array.isArray(starting) || !starting.every(start => object(start.citation) !== null && (start.if_unreadable === "fail" || start.if_unreadable === "report"))) return null;
  if (goal.kind === "question") return questionText(goal.question) === null ? null : brief;
  const data = goal.data === undefined ? [] : goal.data;
  if (goal.kind !== "task" || typeof goal.task !== "string" || goal.task.trim().length === 0 || !Array.isArray(data) || !data.every(value => typeof value === "string")) return null;
  // A task slot with nothing to fill it is a definition bug, refused before any audited read.
  return agenticTaskSlotsFitV1(goal.task, starting.length, data.length) ? brief : null;
}
/** A research-only run releases its trimmed bundle; the outcome counts the checklist's found needs. */
function researchOnlyOutput(bundle: AgenticEvidenceBundleV1, researched: AgenticResearchResultV1): AgenticRenderOutputV1<AgenticResearchResultV1> {
  const incomplete = !bundle.stop.completed;
  const needs = bundle.plan.flatMap(part => part.needs);
  const found = needs.filter(value => value.status === "found").length;
  return {
    result: researched, cited: bundle.items.filter(item => item.cited_by_plan).map(item => item.short), fallbacks: 0,
    outcome: found === 0 ? (incomplete ? "partial" : "not_found") : found === needs.length && !incomplete ? "answered" : "partial",
    answer_sha256: canonicalSha256({ trigger: bundle.trigger, plan: researched.plan }),
  };
}
/** Ask's brief: the person's question as asked, no starting evidence, and the small-scope preload. */
function questionBrief(question: string, budget: AgenticResearchBudgetV1): AgenticBriefV1 {
  return { goal: { kind: "question", question }, starting: [], budget, options: { small_scope_preload: true } };
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
/**
 * The research loop for every trigger, with Ask's V6 writer. A question brief
 * is rendered by Ask's writer; a task brief is research only.
 */
export function createAgenticResearchV1(options: CreateAgenticAskV2Options) {
  return createAgenticAskCore(options, 6) as unknown as {
    answerWithResearch(input: { readonly question: string; readonly signal?: AbortSignal; readonly budget?: AgenticResearchBudgetV1 }): Promise<AgenticAskWithResearchV1<PersonAnswerResponseV6>>;
    research(input: AgenticResearchInputV1): Promise<AgenticResearchResultV1>;
    renderWithResearch<In, Out>(input: AgenticRenderedResearchInputV1<In, Out>): Promise<{ readonly rendered: Out; readonly research: AgenticResearchResultV1 }>;
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
  const sourceCatalog: readonly AgenticResearchCatalogEntryV1[] = Object.freeze(researchSources.map(({ source_id: _id, kinds: _kinds, selector, ...descriptor }) => Object.freeze({ ...descriptor, source: selector })));
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
  const catalog: AgenticResearchCatalogV1 = Object.freeze({ entries: sourceCatalog, by_id: sourcesById, resolve: readSource });
  /** Who is asking and today's date: context for "my", "this week" and "overdue". */
  const context = (day: string) => ({ ...(askedBy === undefined ? {} : { asked_by: askedBy }), today: day });
  const liveGuidance = "Live sources report current tool context under the asker's connection. They are not approved meeting records. Use each source's selector and capabilities from source_catalog. Metadata-only search/list discovers items; open their request-owned ids before relying on their bodies. The server already applies scope and permissions. Never choose a tenant, account, connection or project mapping.";
  const stepPrompt = liveCatalog.length === 0 ? STEP_PROMPT : `${STEP_PROMPT}\n\n${liveGuidance}`;
  const answerPrompt = liveCatalog.length === 0 ? ANSWER_PROMPT : `${ANSWER_PROMPT}\n\n${liveGuidance}`;
  const stepBudget = agenticAskContextBudgetBytesV1(options.generation.context_tokens, stepPrompt, OUTPUT_TOKENS.step);
  /** Every task-form goal adds the one shared task rule; Ask's question keeps its prompt exactly. */
  const taskPrompt = `${stepPrompt}\n\n${TASK_RULE_PROMPT}`;
  const taskBudget = agenticAskContextBudgetBytesV1(options.generation.context_tokens, taskPrompt, OUTPUT_TOKENS.step);
  /** What a renderer's user prompt may fill beside its system prompt. */
  const promptBudget = (system: string) => agenticAskContextBudgetBytesV1(options.generation.context_tokens, system, OUTPUT_TOKENS.answer);
  /**
   * One agentic request: shared session state (deadline, model-call budget,
   * access fences, audit), the research loop, then a renderer (Ask's for a
   * question, the trigger's own for a task, or none) and the shared release step.
   */
  type RequestOutput = { readonly response?: PersonAnswerResponseV4 | PersonAnswerResponseV5 | PersonAnswerResponseV6; readonly rendered?: unknown; readonly research: AgenticResearchResultV1; readonly writer_evidence: readonly string[] };
  const request = async (input: AgenticResearchInputV1, render?: Pick<AgenticRenderedResearchInputV1<unknown, unknown>, "renderer" | "trigger_input">): Promise<RequestOutput> => {
      const brief = runnableBrief(input.brief);
      if (brief === null) throw new AgenticAskOutputErrorV1(input.brief.goal.kind === "question" ? "question is invalid" : "research goal is invalid");
      // Ask's question has Ask's writer; only a task brief takes its trigger's renderer.
      if (render !== undefined && brief.goal.kind === "question") throw new AgenticAskOutputErrorV1("research goal is invalid");
      const { goal, budget } = brief;
      const researchOnly = goal.kind !== "question";
      const beyondLive = budget.deadline_ms > AGENTIC_RESEARCH_LIVE_BUDGET_V1.deadline_ms || budget.max_rounds > AGENTIC_RESEARCH_LIVE_BUDGET_V1.max_rounds || budget.max_model_calls > AGENTIC_RESEARCH_LIVE_BUDGET_V1.max_model_calls;
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
        desk, brief: { ...brief, options: { small_scope_preload: options.small_scope_shortcut === true && brief.options.small_scope_preload } },
        prompt: researchOnly ? taskPrompt : stepPrompt, prompt_budget: researchOnly ? taskBudget : stepBudget, step_span: "ask_planner",
        context: context(requestDay), scope, catalog,
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
      /** What every audit record of this request carries, taken when its release or terminal witness starts. */
      const auditContext = (): AgenticAuditContextV1 => {
        const { receipts, rounds, fallbacks } = loop.progress();
        return {
          audit: options.audit, generation_adapter_id: options.generation.generation_adapter_id, gate_stats: gate.stats,
          ...(researchOnly ? { trigger: input.trigger } : {}),
          background: beyondLive, receipts, rounds, fallbacks: fallbacks + writerFallbacks,
        };
      };

      try {
        // The loop never sees the trigger; its name is a label for the audit and the evaluation.
        const { schema_version, kind, ...gathered } = await loop.run(gate);
        const bundle: AgenticEvidenceBundleV1 = Object.freeze({ schema_version, kind, trigger: input.trigger, ...gathered });
        const researched = trimAgenticEvidenceBundleV1(bundle);
        if (researchOnly) {
          // A task brief: its trigger's renderer, which reads only the bundle, or research only.
          // Either result goes through the shared release step.
          phase = "final";
          const output = render === undefined ? researchOnlyOutput(bundle, researched) : await render.renderer.render({
            bundle, trigger_input: render.trigger_input, gate, signal: activeSignal, prompt_budget: promptBudget,
            remaining: () => remaining() - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1,
          });
          writerFallbacks += output.fallbacks;
          const released = await releaseAgenticResultV1({
            ...auditContext(), desk, outcome: output.outcome, citation_count: output.cited.length, result: output.result, answer_sha256: output.answer_sha256,
            fence_after_audit: true, signal: activeSignal, assert_live: assertLive, now,
            on_checked: at => { checkedAt = at; }, on_audited: () => { terminalAudited = true; },
          });
          clearTimeout(deadlineTimer);
          return Object.freeze({ ...(render === undefined ? {} : { rendered: released }), research: researched, writer_evidence: Object.freeze([]) });
        }

        // Research is over: its desk time is the journey's retrieval stage and its step calls the planner stage.
        phase = "answer";
        const { searches, search_hits } = loop.progress();
        report({ stage: "retrieval", event: "succeeded", elapsed_ms: deskMs, retrieval: { planned_query_count: searches, query_hit_count: search_hits, released_atom_count: bundle.items.length } });
        const stepUsage = usageOf("step", stepModelMs);
        report(stepUsage === null ? { stage: "planner", event: "skipped", elapsed_ms: 0 } : { stage: "planner", event: "succeeded", elapsed_ms: stepModelMs, generation_usage: stepUsage });

        // ---- Ask's renderer: the writer and the layout read only the bundle ----
        const writer = createAskRendererV1({
          response_version: responseVersion, answer_prompt: answerPrompt,
          source_catalog: sourceCatalog, scope, context: context(requestDay), desk_scope: options.desk.scope,
        });
        const ticketsAmong = (shorts: readonly string[]) => shorts.filter(short => bundle.items.find(item => item.short === short)?.item.citation.kind === "ticket").length;
        const rendered = await writer.render({
          bundle, trigger_input: { question: goal.question }, gate, signal: activeSignal, prompt_budget: promptBudget,
          // The release step keeps its reserve after the writer.
          remaining: () => remaining() - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1,
          on_context: selected => {
            report({ stage: "context", event: "succeeded", elapsed_ms: 0, retrieval: { context_atom_count: selected.length } });
            // Counted as answer context only once the writer call starts (its span).
            selectedTicketCount = ticketsAmong(selected);
          },
        });
        writerFallbacks += rendered.fallbacks;
        // A failed answer call still ends in a response (records or not found); its span keeps the failure.
        const answerUsage = usageOf("answer", answerModelMs);
        report(answerUsage === null ? { stage: "answer", event: "skipped", elapsed_ms: 0 } : { stage: "answer", event: "succeeded", elapsed_ms: answerModelMs, generation_usage: answerUsage, retrieval: { citation_count: rendered.cited.length } });
        phase = "final";
        // V5/V6 keep the access check after the audit write; V4 never had one.
        const response = await releaseAgenticResultV1({
          ...auditContext(), desk, outcome: rendered.outcome, citation_count: rendered.cited.length, result: rendered.result.response, answer_sha256: rendered.answer_sha256,
          fence_after_audit: tickets, signal: activeSignal, assert_live: assertLive, now,
          on_checked: at => { checkedAt = at; }, on_audited: () => { terminalAudited = true; },
          on_stage: event => report(event.stage === "revalidation"
            ? { stage: "revalidation", event: "succeeded", elapsed_ms: event.elapsed_ms }
            : { stage: "audit", event: "succeeded", elapsed_ms: event.elapsed_ms, retrieval: { citation_count: rendered.cited.length } }),
        });
        clearTimeout(deadlineTimer);
        ticketCitationCount = response.citations.filter(value => value.citation.kind === "ticket").length;
        return Object.freeze({ response, research: researched, writer_evidence: rendered.result.writer_evidence });
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
  const signalOf = (signal: AbortSignal | undefined) => signal === undefined ? {} : { signal };
  return Object.freeze({
    async answer(input: { readonly question: string; readonly signal?: AbortSignal }) {
      return (await request({ trigger: "ask", brief: questionBrief(input.question, AGENTIC_RESEARCH_LIVE_BUDGET_V1), ...signalOf(input.signal) })).response!;
    },
    /** Ask plus its research result and writer input, for the research evaluation. */
    async answerWithResearch(input: { readonly question: string; readonly signal?: AbortSignal; readonly budget?: AgenticResearchBudgetV1 }) {
      const output = await request({ trigger: "ask", brief: questionBrief(input.question, input.budget ?? AGENTIC_RESEARCH_LIVE_BUDGET_V1), ...signalOf(input.signal) });
      return Object.freeze({ response: output.response!, research: output.research, writer_evidence: output.writer_evidence });
    },
    /** One trigger's brief: a task brief runs research only and its trimmed result is audited and returned. */
    async research(input: AgenticResearchInputV1): Promise<AgenticResearchResultV1> {
      return (await request(input)).research;
    },
    /** A task brief with its trigger's renderer: the released result, and the research it read (for the evaluation). */
    async renderWithResearch<In, Out>(input: AgenticRenderedResearchInputV1<In, Out>): Promise<{ readonly rendered: Out; readonly research: AgenticResearchResultV1 }> {
      const { renderer, trigger_input: triggerInput, ...run } = input;
      const output = await request(run, { renderer: renderer as AgenticRendererV1<unknown, unknown>, trigger_input: triggerInput });
      return Object.freeze({ rendered: output.rendered as Out, research: output.research });
    },
  });
}
