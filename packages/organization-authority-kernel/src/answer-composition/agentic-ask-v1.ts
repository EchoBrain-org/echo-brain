import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type {
  PersonAskTimeContextV1, PersonAnswerResponseV5,
  PersonAnswerResponseV6,
  PersonAnswerResponseV7,
  PersonAnswerResponseV8,
  PersonAnswerResponseV4,
  PersonAskReceiptV3,
} from "@echo-brain/organization-api";
import type { AnswerCompositionGenerationProfileV1 } from "../composition/answer-composition-generation-bundle-v1.js";
import type { StructuredGenerationPort } from "./structured-generation-v1.js";
import type { EvidenceDeskPortV2, EvidenceDeskSourceV2 } from "../shared/evidence-desk-v2.js";
import type { EvidenceDeskPortV1 } from "../shared/evidence-desk-v1.js";
import { FOLLOW_UP_EVIDENCE_KIND_V1, FOLLOW_UPS_MINIMUM_RESPONSE_VERSION_V1, FOLLOW_UPS_SOURCE_ID_V1 } from "../shared/follow-up-evidence-v1.js";
import { DOCUMENTS_SOURCE_CAPABILITIES_V1, MEETINGS_SOURCE_CAPABILITIES_V1 } from "../shared/source-capabilities-v1.js";
import { evidenceDayV1 } from "../shared/temporal-query-v1.js";
import { WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 } from "../shared/workspace-evidence-v1.js";
import { annotateCoreRuntimeV1, observeCoreRuntimeDiagnosticV1 } from "../shared/core-runtime-observation-v1.js";
import { observeAgenticLifecycleV1 } from './agentic-diagnostics-v1.js';
import {
  ANSWER_PROMPT,
  ASK_STEP_PROMPT,
  AgenticAskOutputErrorV1,
  FOLLOW_UPS_ANSWER_GUIDANCE,
  FOLLOW_UPS_STEP_GUIDANCE,
  SEARCH_ONLY_STEP_PROMPT,
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
} from "./agentic-model-gate-v1.js";
import { auditAgenticTerminalV1, releaseAgenticResultV1, type AgenticAskAuditPortV1, type AgenticAuditContextV1 } from "./agentic-release-v1.js";
import type {
  AgenticAskAnswerWithReceiptV2, AgenticAskAnswerWithReceiptV3, AgenticAskProgressInputV2, AgenticAskProgressInputV3,
  AgenticAskProgressRequestV1, AgenticAskProgressSinkV2, AgenticAskProgressSinkV3,
} from "./agentic-ask-progress-v1.js";
import { createAgenticAskProgressRecorderV1 } from "./agentic-ask-progress-recorder-v1.js";
import type { AgenticRendererV1, AgenticRenderOutputV1 } from "./agentic-renderer-v1.js";
import { createAgenticResearchLoopV1, type AgenticResearchCatalogEntryV1, type AgenticResearchCatalogV1, type AgenticResearchSourceV1 } from "./agentic-research-loop-v1.js";
import type { AgenticResearchDriverV1 } from './agentic-research-driver-v1.js';
import { createAskRendererV1 } from "./renderers/ask-renderer-v1.js";
import {
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  type AgenticAskWithResearchV1,
  type AgenticResearchBudgetV1,
  type AgenticResearchResultV1,
} from "./agentic-research-v1.js";

// Other workspaces reach these through this entry point.
export { AGENTIC_RESEARCH_BUDGETS_V1, type AgenticResearchResultV1 } from "./agentic-research-v1.js";
export { AgenticAskDeadlineErrorV1, AgenticAskGenerationFailureV1 } from "./agentic-model-gate-v1.js";
export type { AgenticResearchDriverV1, AgenticResearchDriverSessionV1 } from './agentic-research-driver-v1.js';
export type { AgenticAskAuditEntryV1, AgenticAskAuditPortV1 } from "./agentic-release-v1.js";
export type {
  AgenticAskAnswerWithReceiptV2, AgenticAskAnswerWithReceiptV3, AgenticAskProgressInputV2, AgenticAskProgressInputV3,
  AgenticAskProgressRequestV1, AgenticAskProgressSinkV2, AgenticAskProgressSinkV3,
} from "./agentic-ask-progress-v1.js";
export { createAgenticAskProgressRequestV1 } from "./agentic-ask-progress-recorder-v1.js";

/**
 * The whole request, research through audit (ADR-0022). The Authority is
 * reached through Cloudflare, whose proxy drops an origin response that takes
 * more than 100 s (HTTP 524), so a longer loop could never return. 90 s
 * leaves room for the network; per-call time is also capped by the
 * generation profile.
 */
export const AGENTIC_ASK_DEADLINE_MS_V1 = AGENTIC_RESEARCH_LIVE_BUDGET_V1.deadline_ms;
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
  /** Operator-injected research harness; absent keeps the existing engine. */
  readonly research_driver?: AgenticResearchDriverV1;
  readonly desk: EvidenceDeskPortV1;
  readonly model: StructuredGenerationPort;
  /** The existing provider binding; every role uses answer_model. */
  readonly generation: AnswerCompositionGenerationProfileV1;
  readonly audit: AgenticAskAuditPortV1;
  /** Monotonic milliseconds, supplied by tests or the route telemetry clock. */
  readonly now_ms?: () => number;
  /** Wall-clock epoch milliseconds, for when each list was read (ADR-0041). Defaults to `Date.now`; tests pin it. */
  readonly wall_ms?: () => number;
  /** Today's date (YYYY-MM-DD) for relative `list` dates; tests pin it. */
  readonly today?: () => string;
  /** Captured once by the calling client, used only to interpret temporal questions. */
  readonly time_context?: PersonAskTimeContextV1;
  /** The client asked for answer layout v1 (ADR-0045): a V8 answer's part carries its layout. */
  readonly answer_layout?: boolean;
  /**
   * Who is asking, as the organization's directory names them, so "I", "me"
   * and "my" resolve to a person. Only the models see it; audits never do.
   */
  readonly asker?: { readonly display_name: string };
}

/** One run: the brief, and the trigger definition's name as a label for the audit and the evaluation. */
export interface AgenticResearchInputV1 {
  readonly trigger: string;
  readonly brief: AgenticBriefV1;
  readonly signal?: AbortSignal;
  /**
   * A streamed Ask's progress sink (ADR-0039); a run without one names nothing and audits no names.
   * A V7 run sends it V2 events (ADR-0040), a V8 run V3 events (research tool contract v1).
   */
  readonly on_progress?: AgenticAskProgressSinkV2 | AgenticAskProgressSinkV3;
  /** With `on_progress`: the streamed request this run is one attempt of. */
  readonly progress_request?: AgenticAskProgressRequestV1;
}

/** A task brief's run with its trigger definition's renderer, which receives the trigger's own input. */
export interface AgenticRenderedResearchInputV1<In, Out> extends AgenticResearchInputV1 {
  readonly renderer: AgenticRendererV1<In, Out>;
  readonly trigger_input: In;
}


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
  // With no planner research only reads its starting items: a question, or a task with none, would read nothing. A
  // question always has the list tool.
  const { planner, list } = object(brief.options) ?? {};
  if (planner !== undefined && (typeof planner !== "boolean" || (!planner && (goal.kind === "question" || starting.length === 0)))) return null;
  if (list !== undefined && (typeof list !== "boolean" || (!list && goal.kind === "question"))) return null;
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
/** Ask's brief: the person's question as asked, with no starting evidence. */
function questionBrief(question: string, budget: AgenticResearchBudgetV1): AgenticBriefV1 {
  return { goal: { kind: "question", question }, starting: [], budget, options: {} };
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
  ticket: "ticket", tickets: "ticket",
  page: "page", pages: "page", knowledge: "page", wiki: "page",
  follow_up: FOLLOW_UPS_SOURCE_ID_V1, "follow-up": FOLLOW_UPS_SOURCE_ID_V1, "follow-ups": FOLLOW_UPS_SOURCE_ID_V1, "follow ups": FOLLOW_UPS_SOURCE_ID_V1,
  followup: FOLLOW_UPS_SOURCE_ID_V1, followups: FOLLOW_UPS_SOURCE_ID_V1, open_items: FOLLOW_UPS_SOURCE_ID_V1, "open-items": FOLLOW_UPS_SOURCE_ID_V1, "open items": FOLLOW_UPS_SOURCE_ID_V1,
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
/**
 * V3 core: V6 answers, the first that may read and cite live pages. It does not stream: its progress V1 was retired on
 * 2026-10-19 (ADR-0039).
 */
export function createAgenticAskV3(options: CreateAgenticAskV2Options) {
  return createAgenticAskCore(options, 6) as unknown as {
    answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV6>;
  };
}
/**
 * V4 core: V7 answers, the first that may read and cite follow-ups (ADR-0040).
 * `answerWithReceipt` streams its progress in V2, whose reads may name follow-ups.
 */
export function createAgenticAskV4(options: CreateAgenticAskV2Options) {
  return createAgenticAskCore(options, 7) as unknown as {
    answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV7>;
    answerWithReceipt(input: AgenticAskProgressInputV2): Promise<AgenticAskAnswerWithReceiptV2>;
  };
}
/**
 * V5 core: V8 answers (research tool contract v1), the first that may read and cite the asker's projects, the people in
 * their organization, their tools, and the containers of their connected tools. Progress streams in V3.
 */
export function createAgenticAskV5(options: CreateAgenticAskV2Options) {
  return createAgenticAskCore(options, 8) as unknown as {
    answer(input: { readonly question: string; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV8>;
    answerWithReceipt(input: AgenticAskProgressInputV3): Promise<AgenticAskAnswerWithReceiptV3>;
    answerWithResearch(input: { readonly question: string; readonly signal?: AbortSignal; readonly budget?: AgenticResearchBudgetV1 }): Promise<AgenticAskWithResearchV1<PersonAnswerResponseV8>>;
  };
}
function createAgenticAskCore(options: CreateAgenticAskV2Options, responseVersion: 4 | 5 | 6 | 7 | 8) {
  const tickets = responseVersion >= 5;
  const now = options.now_ms ?? (() => performance.now());
  const temporal = options.time_context;
  // The HTTP boundary validates the time context, so its day always parses.
  const today = options.today ?? (() => temporal === undefined ? new Date().toISOString().slice(0, 10) : evidenceDayV1(temporal.now, temporal.time_zone)!);
  const askedBy = askerName(options.asker);
  const liveCatalog: AgenticResearchSourceV1[] = (options.desk.live_sources ?? []).flatMap(descriptor => {
    // Citation compatibility belongs to the response version, never a provider name.
    if (descriptor.kind === 'ticket' && (!tickets || options.desk.scope.kind === 'mine')) return [];
    if (descriptor.kind === 'page' && (responseVersion < 6 || options.desk.scope.kind === 'mine')) return [];
    // Follow-ups are cited only from V7, and Mine reads only what the asker added (ADR-0040).
    if (descriptor.kind === FOLLOW_UP_EVIDENCE_KIND_V1 && (responseVersion < FOLLOW_UPS_MINIMUM_RESPONSE_VERSION_V1 || options.desk.scope.kind === 'mine')) return [];
    // The workspace sources and a tool's containers are cited only from V8 (research tool contract v1), outside Mine.
    const workspace = descriptor.kind === 'project' || descriptor.kind === 'person' || descriptor.kind === 'tool' || descriptor.kind === 'tool_container';
    if (workspace && (responseVersion < WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 || options.desk.scope.kind === 'mine')) return [];
    return [{ ...descriptor, kinds: [descriptor.kind] }];
  });
  const researchSources: readonly AgenticResearchSourceV1[] = Object.freeze([
    { source_id: 'meeting', selector: 'meetings', kinds: ['imported_meeting', 'decision', 'action', 'rationale', 'note'], description: 'Imported meeting notes (unapproved), approved meeting decisions, and explicitly shared transcripts. Keep imported notes distinct from approved decisions.', capabilities: MEETINGS_SOURCE_CAPABILITIES_V1 },
    { source_id: 'document', selector: 'documents', kinds: ['note', 'document_passage'], description: 'Uploaded document passages and notes.', capabilities: DOCUMENTS_SOURCE_CAPABILITIES_V1 },
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
    const compatible = researchSources.filter(source => source.kinds.length === 1 && source.kinds[0] === alias);
    return compatible.length === 1 ? compatible[0]!.source_id : undefined;
  };
  const catalog: AgenticResearchCatalogV1 = Object.freeze({ entries: sourceCatalog, by_id: sourcesById, resolve: readSource });
  /** Who is asking and today's date: context for "my", "this week" and "overdue". */
  const context = (day: string) => ({ ...(askedBy === undefined ? {} : { asked_by: askedBy }), today: day, ...(temporal === undefined ? { time_zone: "UTC", time_reference: "server" } : { now: temporal.now, time_zone: temporal.time_zone, time_reference: "client" }) });
  const liveGuidance = (list: boolean) => `Live sources report current tool context under the asker's connection. They are not approved meeting records. Use each source's selector and capabilities from source_catalog. Metadata-only ${list ? "search/list" : "search"} discovers items; open their request-owned ids before relying on their bodies. The server already applies scope and permissions. Never choose a tenant, account, connection or project mapping.`;
  // Follow-ups are ECHO's own items with their own guidance; the live guidance is for connected tools (ADR-0040).
  // The workspace sources are ECHO's own too: only connected tools (their items and containers) get the live guidance.
  const toolSources = liveCatalog.filter(source => !source.kinds.some(kind => kind === FOLLOW_UP_EVIDENCE_KIND_V1 || kind === 'project' || kind === 'person' || kind === 'tool'));
  const followUps = liveCatalog.some(source => source.kinds.includes(FOLLOW_UP_EVIDENCE_KIND_V1));
  const guided = (base: string, live: string, followUp: string) => [base, ...(toolSources.length === 0 ? [] : [live]), ...(followUps ? [followUp] : [])].join("\n\n");
  const answerPrompt = guided(ANSWER_PROMPT, liveGuidance(true), FOLLOW_UPS_ANSWER_GUIDANCE);
  /** A research step's system prompt, and the scratchpad bytes that fit beside it. */
  const stepPrompt = (prompt: string) => Object.freeze({ prompt, prompt_budget: agenticAskContextBudgetBytesV1(options.generation.context_tokens, prompt, OUTPUT_TOKENS.step) });
  /**
   * The research step's prompts: Ask's question has its own, with list evidence (ADR-0041); every task-form goal keeps the
   * step prompt before it and adds the one shared task rule, and a search-only task brief (no list) has its own.
   */
  const taskPrompt = (list: boolean) => stepPrompt(`${guided(list ? STEP_PROMPT : SEARCH_ONLY_STEP_PROMPT, liveGuidance(list), FOLLOW_UPS_STEP_GUIDANCE)}\n\n${TASK_RULE_PROMPT}`);
  const prompts = Object.freeze({ ask: stepPrompt(guided(ASK_STEP_PROMPT, liveGuidance(true), FOLLOW_UPS_STEP_GUIDANCE)), task: taskPrompt(true), search_only_task: taskPrompt(false) });
  /** What a renderer's user prompt may fill beside its system prompt. */
  const promptBudget = (system: string, outputTokens: number = OUTPUT_TOKENS.answer) => agenticAskContextBudgetBytesV1(options.generation.context_tokens, system, outputTokens);
  /**
   * One agentic request: shared session state (deadline, model-call budget,
   * access fences, audit), the research loop, then a renderer (Ask's for a
   * question, the trigger's own for a task, or none) and the shared release step.
   */
  type RequestOutput = { readonly response?: PersonAnswerResponseV4 | PersonAnswerResponseV5 | PersonAnswerResponseV6 | PersonAnswerResponseV7 | PersonAnswerResponseV8; readonly rendered?: unknown; readonly research: AgenticResearchResultV1; readonly writer_evidence: readonly string[]; readonly receipt?: PersonAskReceiptV3 };
  const request = async (input: AgenticResearchInputV1, render?: Pick<AgenticRenderedResearchInputV1<unknown, unknown>, "renderer" | "trigger_input">): Promise<RequestOutput> => observeAgenticLifecycleV1<RequestOutput>('run', undefined, { trigger: input.trigger }, async () => {
      const brief = await observeAgenticLifecycleV1('brief', 'research_brief', { trigger: input.trigger, brief: input.brief, scope: options.desk.scope }, async () => {
        const selected = runnableBrief(input.brief);
        if (selected === null) throw new AgenticAskOutputErrorV1(input.brief.goal.kind === "question" ? "question is invalid" : "research goal is invalid");
        // Ask's question has Ask's writer; only a task brief takes its trigger's renderer.
        if (render !== undefined && selected.goal.kind === "question") throw new AgenticAskOutputErrorV1("research goal is invalid");
        return selected;
      }, value => ({ brief: value, output_kind: value.goal.kind === 'question' ? 'answer' : render === undefined ? 'research' : 'rendered' }));
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
      // ---- research cost accounting; shared core spans own runtime observation ----
      let phase: "research" | "answer" | "final" = "research";
      let deskMs = 0; let stepModelMs = 0;
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
      // A streamed Ask's record of what it searched and named (ADR-0039); it stops sending once the request's signal aborts.
      // The V7 answer streams progress V2 and the V8 answer V3, so their reads may name follow-ups.
      const progress = input.on_progress === undefined ? undefined : createAgenticAskProgressRecorderV1({
        sink: input.on_progress as AgenticAskProgressSinkV3, version: responseVersion === 8 ? 3 : 2, sources: researchSources, signal: activeSignal,
        ...(input.progress_request === undefined ? {} : { named: input.progress_request.named }) });
      let selectedTicketCount = 0; let ticketContextCount = 0; let ticketCitationCount = 0;
      const scope = scopeText(options.desk.scope);

      const remaining = () => deadline - now();
      const assertLive = () => {
        if (input.signal?.aborted) abort(input.signal);
        if (deadlineExpired || now() >= deadline) throw new AgenticAskDeadlineErrorV1();
        if (activeSignal.aborted) throw new DOMException("Ask stopped", "AbortError");
      };

      // ---- research: the loop owns its state; the runner reads its progress and its bundle ----
      const researchStep = !researchOnly ? prompts.ask : brief.options.list === false ? prompts.search_only_task : prompts.task;
      const loop = createAgenticResearchLoopV1({
        desk, brief,
        ...(options.research_driver === undefined ? {} : { driver: options.research_driver }),
        ...researchStep, step_span: "ask_planner",
        context: context(requestDay), scope, catalog,
        now, remaining, signal: activeSignal, assert_live: assertLive, ...(options.wall_ms === undefined ? {} : { wall_now: options.wall_ms }),
        observed: () => ({ checked_at: checkedAt, model_ms: stepModelMs, desk_ms: deskMs }),
        ...(progress === undefined ? {} : { report: progress.research }),
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
          if (event.role === "step") stepModelMs += event.elapsed_ms;
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
          ...(progress === undefined ? {} : { named_citation_digests: progress.named_citation_digests() }),
        };
      };

      try {
        // The loop never sees the trigger; its name is a label for the audit and the evaluation.
        const { schema_version, kind, ...gathered } = await observeAgenticLifecycleV1('research', 'research_loop', {}, () => loop.run(gate), value => {
          annotateCoreRuntimeV1({ research_stop_reason: value.stop.reason, ...(value.stop.admission === undefined ? {} : { research_admission: value.stop.admission }) });
          return { research: trimAgenticEvidenceBundleV1({ ...value, trigger: input.trigger }) };
        });
        const bundle: AgenticEvidenceBundleV1 = Object.freeze({ schema_version, kind, trigger: input.trigger, ...gathered });
        const researched = trimAgenticEvidenceBundleV1(bundle);
        // Back in the enclosing run span: one summary for every trigger.
        annotateCoreRuntimeV1({ research_stop_reason: bundle.stop.reason,
          ...(bundle.stop.admission === undefined ? {} : { research_admission: bundle.stop.admission }),
          counts: { released_atom_count: bundle.items.length },
        });
        /** Ticket items among short ids: what a renderer was shown, and what its result cites. */
        const ticketsAmong = (shorts: readonly string[]) => shorts.filter(short => bundle.items.find(item => item.short === short)?.item.citation.kind === "ticket").length;
        if (researchOnly) {
          // A task brief: its trigger's renderer, which reads only the bundle, or research only.
          // Either result goes through the shared release step.
          phase = "final";
          let selectedEvidence: readonly string[] = [];
          if (render === undefined) observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'renderer', event: 'skipped', data: { output_kind: 'research' } });
          const output = render === undefined ? researchOnlyOutput(bundle, researched) : await observeAgenticLifecycleV1('renderer', 'research_output', { output_kind: 'rendered' }, () => render.renderer.render({
            bundle, trigger_input: render.trigger_input, gate, signal: activeSignal, prompt_budget: promptBudget,
            remaining: () => remaining() - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1,
            // Counted as renderer context only once its model call starts (its span), as Ask's writer is.
            on_context: ids => { selectedEvidence = ids; selectedTicketCount = ticketsAmong(ids); },
          }), value => ({ output_kind: 'rendered', selected_evidence: selectedEvidence, fallback_count: value.fallbacks, outcome: value.outcome, result: value.result }));
          writerFallbacks += output.fallbacks;
          annotateCoreRuntimeV1({ counts: { context_atom_count: selectedEvidence.length } });
          const released = await releaseAgenticResultV1({
            ...auditContext(), desk, outcome: output.outcome, citation_count: output.cited.length, result: output.result, answer_sha256: output.answer_sha256,
            fence_after_audit: true, signal: activeSignal, assert_live: assertLive,
            on_checked: at => { checkedAt = at; }, on_audited: () => { terminalAudited = true; },
          });
          annotateCoreRuntimeV1({ result: output.outcome, counts: { citation_count: output.cited.length } });
          clearTimeout(deadlineTimer);
          ticketCitationCount = ticketsAmong(output.cited);
          return Object.freeze({ ...(render === undefined ? {} : { rendered: released }), research: researched, writer_evidence: Object.freeze([]) });
        }

        // Research is over; its cost bundle excludes renderer and finalization work.
        phase = "answer";

        // ---- Ask's renderer: the writer and the layout read only the bundle ----
        const writer = createAskRendererV1({
          response_version: responseVersion, answer_prompt: answerPrompt,
          source_catalog: sourceCatalog, scope, context: context(requestDay), desk_scope: options.desk.scope,
          layout: responseVersion === 8 && options.answer_layout === true,
        });
        let selectedEvidence: readonly string[] = [];
        progress?.stage("writing");
        const rendered = await observeAgenticLifecycleV1('renderer', 'research_output', { output_kind: 'answer' }, () => writer.render({
          bundle, trigger_input: { question: goal.question }, gate, signal: activeSignal, prompt_budget: promptBudget,
          // The release step keeps its reserve after the writer.
          remaining: () => remaining() - AGENTIC_ASK_FINALIZE_RESERVE_MS_V1,
          on_context: selected => {
            selectedEvidence = selected;
            // Counted as answer context only once the writer call starts (its span).
            selectedTicketCount = ticketsAmong(selected);
          },
        }), value => ({ output_kind: 'answer', selected_evidence: selectedEvidence, fallback_count: value.fallbacks, outcome: value.outcome, result: value.result.response }));
        writerFallbacks += rendered.fallbacks;
        annotateCoreRuntimeV1({ counts: { context_atom_count: selectedEvidence.length } });
        phase = "final";
        progress?.stage("checking_access");
        // V5 to V8 keep the access check after the audit write; V4 never had one.
        const response = await releaseAgenticResultV1({
          ...auditContext(), desk, outcome: rendered.outcome, citation_count: rendered.cited.length, result: rendered.result.response, answer_sha256: rendered.answer_sha256,
          fence_after_audit: tickets, signal: activeSignal, assert_live: assertLive,
          on_checked: at => { checkedAt = at; }, on_audited: () => { terminalAudited = true; },
        });
        annotateCoreRuntimeV1({ result: rendered.outcome, counts: { citation_count: rendered.cited.length } });
        clearTimeout(deadlineTimer);
        ticketCitationCount = response.citations.filter(value => value.citation.kind === "ticket").length;
        // Only a released answer has a receipt, rebuilt from the run's own record after every check passed.
        // Timed from the request's start, before its first attempt, when the run is one attempt of a request.
        const receipt = progress?.receipt(input.progress_request?.elapsed() ?? now() - startedAt);
        return Object.freeze({ response, research: researched, writer_evidence: rendered.result.writer_evidence, ...(receipt === undefined ? {} : { receipt }) });
      } catch (error) {
        clearTimeout(deadlineTimer);
        const inheritedDeadline = input.signal?.aborted && input.signal.reason instanceof AgenticAskDeadlineErrorV1 ? input.signal.reason : undefined;
        if (deadlineExpired || error instanceof AgenticAskDeadlineErrorV1 || inheritedDeadline !== undefined) {
          terminalAbort.abort();
          if (!terminalAudited) await auditAgenticTerminalV1("timed_out", { ...auditContext(), checked_at: checkedAt });
          throw error instanceof AgenticAskDeadlineErrorV1 ? error : inheritedDeadline ?? new AgenticAskDeadlineErrorV1();
        }
        if (input.signal?.aborted || isAbort(error, input.signal)) {
          terminalAbort.abort();
          if (!terminalAudited) await auditAgenticTerminalV1("cancelled", { ...auditContext(), checked_at: checkedAt });
          throw error;
        }
        terminalAbort.abort();
        throw error;
      } finally {
        progress?.settle();
        const { searches, search_hits, refused_reads, repeated_refusals, unchecked_items, sources_looked_at, most_reads_in_a_step } = loop.progress();
        annotateCoreRuntimeV1({ counts: { planned_query_count: searches, query_hit_count: search_hits } });
        // Ask's read accounting (research tool contract v1), beside planned_query_count for operators (RB-OPERATIONS-001).
        // The release check counts its own from the research rounds.
        if (goal.kind === "question") annotateCoreRuntimeV1({ counts: { refused_read_count: refused_reads, repeated_refusal_count: repeated_refusals, unchecked_item_count: unchecked_items, sources_looked_at, most_reads_in_a_step } });
        if (tickets) annotateCoreRuntimeV1({ counts: { ticket_retrieved_items: loop.progress().retrieved_tickets, ticket_context_items: ticketContextCount, ticket_citations: ticketCitationCount } });
      }
  }, value => ({ trigger: input.trigger, output_kind: value.response !== undefined ? 'answer' : value.rendered !== undefined ? 'rendered' : 'research', result: value.response ?? value.rendered ?? value.research }));
  const signalOf = (signal: AbortSignal | undefined) => signal === undefined ? {} : { signal };
  return Object.freeze({
    async answer(input: { readonly question: string; readonly signal?: AbortSignal }) {
      return (await request({ trigger: "ask", brief: questionBrief(input.question, AGENTIC_RESEARCH_LIVE_BUDGET_V1), ...signalOf(input.signal) })).response!;
    },
    /**
     * Ask with its progress sent to `on_progress` while it runs, and the receipt
     * built after release (ADR-0039). Only the V7 core (progress V2, ADR-0040)
     * and the V8 core (progress V3) stream.
     */
    async answerWithReceipt(input: AgenticAskProgressInputV2 | AgenticAskProgressInputV3): Promise<AgenticAskAnswerWithReceiptV2 | AgenticAskAnswerWithReceiptV3> {
      if ((responseVersion !== 7 && responseVersion !== 8) || typeof input.on_progress !== "function") throw new AgenticAskOutputErrorV1("Ask progress is unavailable");
      const output = await request({ trigger: "ask", brief: questionBrief(input.question, AGENTIC_RESEARCH_LIVE_BUDGET_V1), ...signalOf(input.signal), on_progress: input.on_progress,
        ...(input.request === undefined ? {} : { progress_request: input.request }) });
      return Object.freeze({ response: output.response as PersonAnswerResponseV7 | PersonAnswerResponseV8, receipt: output.receipt! }) as AgenticAskAnswerWithReceiptV2 | AgenticAskAnswerWithReceiptV3;
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
