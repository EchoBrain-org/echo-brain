import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonAskTimeContextV1, PersonAnswerResponseV8, PersonAnswerPreviousV1, PersonAskReceiptV3 } from "@echo-brain/organization-api";
import { validatePersonQuestionText } from "@echo-brain/organization-api";
import type { AnswerCompositionGenerationProfileV1 } from "../composition/answer-composition-generation-bundle-v1.js";
import type { StructuredGenerationPort } from "./structured-generation-v1.js";
import type { EvidenceDeskPortV2, EvidenceDeskSourceV2 } from "../shared/evidence-desk-v2.js";
import { FOLLOW_UP_EVIDENCE_KIND_V1, FOLLOW_UPS_SOURCE_ID_V1 } from "../shared/follow-up-evidence-v1.js";
import { DOCUMENTS_SOURCE_CAPABILITIES_V1, LOCAL_SOURCE_KINDS_V1, MEETINGS_SOURCE_CAPABILITIES_V1 } from "../shared/source-capabilities-v1.js";
import { evidenceDayV1 } from "../shared/temporal-query-v1.js";
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
  AgenticAskStalledErrorV1,
  abort,
  createAgenticModelGateV1,
  isAbort,
  object,
} from "./agentic-model-gate-v1.js";
import { auditAgenticTerminalV1, releaseAgenticResultV1, type AgenticAskAuditPortV1, type AgenticAuditContextV1 } from "./agentic-release-v1.js";
import { agenticAskAnswerSha256V1 } from "./agentic-ask-v1-response.js";
import { agenticClarifyResponseV1, agenticFollowUpStartingV1, agenticPreviousAskedOnV1, resolveAgenticFollowUpV1, type AgenticFollowUpCarryV1 } from "./agentic-follow-up-resolver-v1.js";
import type {
  AgenticAskAnswerWithReceiptV3, AgenticAskProgressInputV3, AgenticAskProgressRequestV1, AgenticAskProgressSinkV3,
} from "./agentic-ask-progress-v1.js";
import { createAgenticAskProgressRecorderV1 } from "./agentic-ask-progress-recorder-v1.js";
import type { AgenticRendererV1, AgenticRenderOutputV1 } from "./agentic-renderer-v1.js";
import {
  createAgenticResearchLoopV1, type AgenticResearchCatalogEntryV1, type AgenticResearchCatalogV1, type AgenticResearchLoopV1, type AgenticResearchProgressV1,
  type AgenticResearchSourceV1,
} from "./agentic-research-loop-v1.js";
import type { AgenticResearchDriverV1 } from './agentic-research-driver-v1.js';
import type { AskFollowUpDraftV1, AskFollowUpSinkV1 } from "./ask-follow-ups-v1.js";
import { createAskRendererV1, type AskEarlierAnswerV1 } from "./renderers/ask-renderer-v1.js";
import {
  AGENTIC_RESEARCH_LIVE_BUDGET_V1,
  type AgenticAskWithResearchV1,
  type AgenticResearchBudgetV1,
  type AgenticResearchResultV1,
} from "./agentic-research-v1.js";

// Other workspaces reach these through this entry point.
export { AGENTIC_RESEARCH_BUDGETS_V1, type AgenticResearchResultV1 } from "./agentic-research-v1.js";
export { AgenticAskStalledErrorV1, AgenticAskGenerationFailureV1 } from "./agentic-model-gate-v1.js";
// The SDK research driver describes the list tool by the same page bound.
export { AGENTIC_ASK_LIST_PAGE_ROWS_V1 } from "./agentic-ask-v1-model-protocol.js";
export type { AgenticResearchDriverV1, AgenticResearchDriverSessionV1 } from './agentic-research-driver-v1.js';
export { ASK_FOLLOW_UP_ABOUT_KINDS_V1, askFollowUpItemIdV1, askFollowUpPointerV1, type AskFollowUpDraftV1, type AskFollowUpSinkV1 } from "./ask-follow-ups-v1.js";
export type { AgenticAskAuditEntryV1, AgenticAskAuditPortV1 } from "./agentic-release-v1.js";
export type {
  AgenticAskAnswerWithReceiptV3, AgenticAskProgressInputV3, AgenticAskProgressRequestV1, AgenticAskProgressSinkV3,
} from "./agentic-ask-progress-v1.js";
export { createAgenticAskProgressRequestV1 } from "./agentic-ask-progress-recorder-v1.js";
// The follow-up resolution eval (ADR-0047) runs the product's resolver on its own.
export { resolveAgenticFollowUpOnceV1, type AgenticFollowUpCarryV1, type AgenticFollowUpResolutionV1, type AgenticFollowUpResolvedV1 } from "./agentic-follow-up-resolver-v1.js";

/**
 * How long an evidence read or access check may send nothing before the request treats it as stalled and stops with
 * that reason. No desk read streams, so this is the whole read. It is the only clock on a request: research and the
 * writer run as long as they make progress, and a model call has its own silence period (the generation profile's
 * `timeout_ms`). Ask streams its progress with a heartbeat (ADR-0039), so a person sees a long run is alive.
 */
export const AGENTIC_READ_SILENCE_MS_V1 = 120_000;
/**
 * Bytes a prompt token stands for, when ECHO measures a prompt in bytes: no tokenizer runs before the call, so this is
 * an estimate, and it is low on purpose (most text is longer per token), so a prompt it admits fits the window.
 */
const BYTES_PER_TOKEN = 3;
/** Share of the window the estimate may be wrong by: text that tokenizes worse than three bytes still fits. */
const ESTIMATE_MARGIN = 0.1;

/**
 * Scratchpad bytes that fit beside a system prompt and the reply in the model's own context window (the profile's):
 * (context_tokens x 0.9 - system prompt bytes / 3 - outputTokens) x 3. `outputTokens` is the allowance every call
 * actually requests (the profile's max_output_tokens, which the model gate sends as max_output_tokens), so the reply's
 * reservation is taken out once and evidence fills the rest: with Sonnet's 1,000,000-token window and its 128,000-token
 * output, about (900,000 - 128,000) x 3 = 2,316,000 bytes less the system prompt.
 */
export function agenticAskContextBudgetBytesV1(contextTokens: number, systemPrompt: string, outputTokens: number): number {
  const usable = Math.floor(contextTokens * (1 - ESTIMATE_MARGIN)) - Math.ceil(Buffer.byteLength(systemPrompt, "utf8") / BYTES_PER_TOKEN) - outputTokens;
  return Math.max(0, usable * BYTES_PER_TOKEN);
}

export interface CreateAgenticAskOptions {
  /** Operator-injected research harness; absent keeps the existing engine. */
  readonly research_driver?: AgenticResearchDriverV1;
  readonly desk: EvidenceDeskPortV2;
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
  /**
   * Who is asking, as the organization's directory names them, so "I", "me"
   * and "my" resolve to a person. Only the models see it; audits never do.
   */
  readonly asker?: { readonly display_name: string };
  /**
   * Where an Ask answer's follow-ups are saved (ADR-0053), bound to the asker, and the id of the request this run is one
   * attempt of (`ask_<uuid>`), which fixes each follow-up's id. Only with it is the writer told to draft follow-ups; the
   * drafts are saved once the answer is released, after its last check. Task triggers never draft.
   */
  readonly follow_ups?: { readonly request_id: string; readonly sink: AskFollowUpSinkV1 };
}

/** One run: the brief, and the trigger definition's name as a label for the audit and the evaluation. */
export interface AgenticResearchInputV1 {
  readonly trigger: string;
  readonly brief: AgenticBriefV1;
  readonly signal?: AbortSignal;
  /** A streamed Ask's progress sink (ADR-0039), sent progress V3 events; a run without one names nothing and audits no names. */
  readonly on_progress?: AgenticAskProgressSinkV3;
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

/** Ask's question as the API takes it (validatePersonQuestionText), checked by that one rule, or null. */
function questionText(value: unknown): string | null {
  try { return validatePersonQuestionText(value); } catch { return null; }
}
/** A brief the request can run, or null. Ask's question keeps the API's question rule; a task's definition bounds its own text. */
function runnableBrief(brief: AgenticBriefV1): AgenticBriefV1 | null {
  const { goal, starting } = brief;
  // Only a question skips a starting item unmentioned: a task's slots name every one of its starting items.
  if (!Array.isArray(starting) || !starting.every(start => object(start.citation) !== null &&
    (start.if_unreadable === "fail" || start.if_unreadable === "report" || (start.if_unreadable === "skip" && goal.kind === "question")))) return null;
  // A question always has the list tool.
  const { list } = object(brief.options) ?? {};
  if (list !== undefined && (typeof list !== "boolean" || (!list && goal.kind === "question"))) return null;
  if (goal.kind === "question") return questionText(goal.question) === null ? null : brief;
  if (goal.kind !== "task" || typeof goal.task !== "string" || goal.task.trim().length === 0) return null;
  // A task slot with nothing to fill it is a definition bug, refused before any audited read.
  return agenticTaskSlotsFitV1(goal.task, starting.length) ? brief : null;
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
/** Research that never ran: a follow-up that asked which one (ADR-0047), or a request stopped before research began. */
const NO_RESEARCH: AgenticResearchProgressV1 = Object.freeze({
  receipts: Object.freeze([]), rounds: 0, fallbacks: 0, searches: 0, search_hits: 0, retrieved_tickets: 0,
  refused_reads: 0, repeated_refusals: 0, unchecked_items: 0, sources_looked_at: 0, most_reads_in_a_step: 0,
});
/** The earlier answer an Ask again's writer compares with (ADR-0047): its day where the asker is, and its sentences with their sources' labels. */
function earlierAnswer(previous: PersonAnswerPreviousV1, timeZone: string): AskEarlierAnswerV1 {
  return Object.freeze({
    asked_on: agenticPreviousAskedOnV1(previous, timeZone),
    statements: Object.freeze(previous.statements.map(statement => Object.freeze({
      text: statement.text, sources: Object.freeze(statement.citation_indexes.map(index => previous.citations[index]!.label)),
    }))),
  });
}
/** What the model is told the desk reads. Adding a scope kind is a compile error here. */
function scopeText(scope: EvidenceDeskPortV2["scope"]): string {
  switch (scope.kind) {
    case "project": return "one project: meetings and documents are limited to it; live sources are limited to their saved project mappings. Only sources in source_catalog are available";
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

/**
 * Ask's core, and the research loop for every trigger (research tool contract v1). A question brief is rendered by Ask's
 * writer as the V8 answer, which may read and cite live tickets and pages, ECHO's shared follow-ups (ADR-0040), and the
 * asker's projects, the people in their organization, their tools, and the containers of their connected tools; its
 * progress streams in V3. A task brief is research only, or its trigger's renderer. The cores of the V4 to V7 answers
 * were retired with their routes.
 */
export function createAgenticAskV5(options: CreateAgenticAskOptions) {
  const now = options.now_ms ?? (() => performance.now());
  const temporal = options.time_context;
  // The HTTP boundary validates the time context, so its day always parses.
  const today = options.today ?? (() => temporal === undefined ? new Date().toISOString().slice(0, 10) : evidenceDayV1(temporal.now, temporal.time_zone)!);
  const askedBy = askerName(options.asker);
  // Every scope reads each live source the desk offers.
  const liveCatalog: AgenticResearchSourceV1[] = (options.desk.live_sources ?? []).map(descriptor => ({ ...descriptor, kinds: [descriptor.kind] }));
  const researchSources: readonly AgenticResearchSourceV1[] = Object.freeze([
    { source_id: 'meeting', selector: 'meetings', kinds: LOCAL_SOURCE_KINDS_V1.meeting, description: 'Imported meeting notes (unapproved), approved meeting decisions, and explicitly shared transcripts. Keep imported notes distinct from approved decisions.', capabilities: MEETINGS_SOURCE_CAPABILITIES_V1 },
    { source_id: 'document', selector: 'documents', kinds: LOCAL_SOURCE_KINDS_V1.document, description: 'Uploaded document passages and notes.', capabilities: DOCUMENTS_SOURCE_CAPABILITIES_V1 },
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
  const stepPrompt = (prompt: string) => Object.freeze({ prompt, prompt_budget: agenticAskContextBudgetBytesV1(options.generation.context_tokens, prompt, options.generation.max_output_tokens) });
  /**
   * The research step's prompts: Ask's question has its own, with list evidence (ADR-0041); every task-form goal keeps the
   * step prompt before it and adds the one shared task rule, and a search-only task brief (no list) has its own.
   */
  const taskPrompt = (list: boolean) => stepPrompt(`${guided(list ? STEP_PROMPT : SEARCH_ONLY_STEP_PROMPT, liveGuidance(list), FOLLOW_UPS_STEP_GUIDANCE)}\n\n${TASK_RULE_PROMPT}`);
  const prompts = Object.freeze({ ask: stepPrompt(guided(ASK_STEP_PROMPT, liveGuidance(true), FOLLOW_UPS_STEP_GUIDANCE)), task: taskPrompt(true), search_only_task: taskPrompt(false) });
  /** What a renderer's user prompt may fill beside its system prompt. */
  const promptBudget = (system: string) => agenticAskContextBudgetBytesV1(options.generation.context_tokens, system, options.generation.max_output_tokens);
  /**
   * One agentic request: shared session state (deadline, model-call budget,
   * access fences, audit), the research loop, then a renderer (Ask's for a
   * question, the trigger's own for a task, or none) and the shared release step.
   */
  /** Every request researches, except a follow-up that asked which one (ADR-0047). */
  type RequestOutput = {
    readonly response?: PersonAnswerResponseV8; readonly rendered?: unknown; readonly research?: AgenticResearchResultV1; readonly writer_evidence: readonly string[]; readonly receipt?: PersonAskReceiptV3;
    /** The follow-ups an Ask answer drafted and its release saved (ADR-0053); absent for none. */
    readonly follow_ups?: readonly AskFollowUpDraftV1[];
  };
  /** `previous`: the asker's previous turn (ADR-0047), which only an Ask carries; `followUp`, its resolution carried between attempts. */
  const request = async (input: AgenticResearchInputV1, render?: Pick<AgenticRenderedResearchInputV1<unknown, unknown>, "renderer" | "trigger_input">, previous?: PersonAnswerPreviousV1,
    followUp?: AgenticFollowUpCarryV1): Promise<RequestOutput> => observeAgenticLifecycleV1<RequestOutput>('run', undefined, { trigger: input.trigger }, async () => {
      const brief = await observeAgenticLifecycleV1('brief', 'research_brief', { trigger: input.trigger, brief: input.brief, scope: options.desk.scope }, async () => {
        const selected = runnableBrief(input.brief);
        if (selected === null) throw new AgenticAskOutputErrorV1(input.brief.goal.kind === "question" ? "question is invalid" : "research goal is invalid");
        // Ask's question has Ask's writer; only a task brief takes its trigger's renderer.
        if (render !== undefined && selected.goal.kind === "question") throw new AgenticAskOutputErrorV1("research goal is invalid");
        return selected;
      }, value => ({ brief: value, output_kind: value.goal.kind === 'question' ? 'answer' : render === undefined ? 'research' : 'rendered' }));
      const { goal, budget } = brief;
      const researchOnly = goal.kind !== "question";
      const background = budget.profile === "background";
      const startedAt = now();
      const requestDay = today();
      const terminalAbort = new AbortController();
      const activeSignal = input.signal === undefined ? terminalAbort.signal : AbortSignal.any([input.signal, terminalAbort.signal]);
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
      /**
       * One desk call watched for silence: one that sends nothing for its silence period stops the request with a stall,
       * which every wait on the request's signal (research's reads, the gate's checks, release) then throws.
       */
      const watched = <R, T>(stalled: "read" | "check", request: R, operation: (request: R) => Promise<T>): Promise<T> => timed(() => {
        const timer = setTimeout(() => terminalAbort.abort(new AgenticAskStalledErrorV1(stalled, AGENTIC_READ_SILENCE_MS_V1)), AGENTIC_READ_SILENCE_MS_V1);
        timer.unref?.();
        const pending = operation(request);
        pending.then(() => clearTimeout(timer), () => clearTimeout(timer));
        return pending;
      });
      const desk: EvidenceDeskPortV2 = Object.freeze({
        scope: options.desk.scope,
        search: (request: Parameters<EvidenceDeskPortV2["search"]>[0]) => watched("read", request, value => options.desk.search(value)),
        open: (request: Parameters<EvidenceDeskPortV2["open"]>[0]) => watched("read", request, value => options.desk.open(value)),
        list: (request: Parameters<EvidenceDeskPortV2["list"]>[0]) => watched("read", request, value => options.desk.list(value)),
        revalidate: (request: Parameters<EvidenceDeskPortV2["revalidate"]>[0]) => watched("check", request, value => options.desk.revalidate(value)),
        ...(options.desk.openCitation === undefined ? {} : { openCitation: (request: Parameters<NonNullable<EvidenceDeskPortV2["openCitation"]>>[0]) => watched("read", request, value => options.desk.openCitation!(value)) }),
      });
      let terminalAudited = false;
      // A streamed Ask's record of what it searched and named (ADR-0039), in progress V3; it stops sending once the request's
      // signal aborts.
      const progress = input.on_progress === undefined ? undefined : createAgenticAskProgressRecorderV1({
        sink: input.on_progress, sources: researchSources, signal: activeSignal,
        ...(input.progress_request === undefined ? {} : { named: input.progress_request.named }) });
      let selectedTicketCount = 0; let ticketContextCount = 0; let ticketCitationCount = 0;
      const scope = scopeText(options.desk.scope);

      const assertLive = () => {
        if (input.signal?.aborted) abort(input.signal);
        if (activeSignal.aborted && activeSignal.reason instanceof AgenticAskStalledErrorV1) throw activeSignal.reason;
        if (activeSignal.aborted) throw new DOMException("Ask stopped", "AbortError");
      };

      // ---- the model gate: research's hooks bind once research starts, after a follow-up is resolved (ADR-0047) ----
      let loop: AgenticResearchLoopV1 | undefined;
      const gate = createAgenticModelGateV1({
        generation: options.generation, model: options.model,
        desk_revalidate: request => desk.revalidate(request),
        on_checked: at => { checkedAt = at; },
        now, signal: activeSignal,
        ...(input.signal === undefined ? {} : { input_signal: input.signal }),
        on_span: event => {
          if (event.phase === "enter") { if (event.role === "answer") ticketContextCount = selectedTicketCount; return; }
          if (event.role === "step") stepModelMs += event.elapsed_ms;
        },
        // Only a research step has a hook: the loop's, once it exists.
        before_call: role => loop?.gate_hooks.before_call?.(role),
      });
      /** What research has done: nothing before it starts, and nothing for a follow-up that asked which one. */
      const researchProgress = (): AgenticResearchProgressV1 => loop?.progress() ?? NO_RESEARCH;
      /** What every audit record of this request carries, taken when its release or terminal witness starts. */
      const auditContext = (): AgenticAuditContextV1 => {
        const { receipts, rounds, fallbacks } = researchProgress();
        return {
          audit: options.audit, generation_adapter_id: options.generation.generation_adapter_id, gate_stats: gate.stats,
          ...(researchOnly ? { trigger: input.trigger } : {}),
          background, receipts, rounds, fallbacks: fallbacks + writerFallbacks,
          ...(progress === undefined ? {} : { named_citation_digests: progress.named_citation_digests() }),
        };
      };
      /**
       * How every output leaves the request: the shared release step and its summary. An Ask also
       * streams the access check and gets its receipt, rebuilt from the run's own record after every check passed, timed
       * from the request's start, before its first attempt, when the run is one attempt of a request.
       */
      const release = async <Result>(outcome: PersonAnswerResponseV8["outcome"], citationCount: number, result: Result, answerSha256: Sha256Digest, onReleased?: () => void) => {
        const asked = researchOnly ? undefined : progress;
        asked?.stage("checking_access");
        const released = await releaseAgenticResultV1({
          ...auditContext(), desk, outcome, citation_count: citationCount, result, answer_sha256: answerSha256,
          signal: activeSignal, assert_live: assertLive,
          on_checked: at => { checkedAt = at; }, on_audited: () => { terminalAudited = true; },
          ...(onReleased === undefined ? {} : { on_released: onReleased }),
        });
        annotateCoreRuntimeV1({ result: outcome, counts: { citation_count: citationCount } });
        const receipt = asked?.receipt(input.progress_request?.elapsed() ?? now() - startedAt);
        return { released, ...(receipt === undefined ? {} : { receipt }) };
      };

      try {
        // ---- a follow-up (ADR-0047): what it refers to, before research; an Ask again researches the question as asked ----
        let researchBrief = brief;
        let resolvedQuestion: string | undefined;
        if (previous?.purpose === "follow_up" && goal.kind === "question") {
          // A resolution an earlier attempt of this request already paid for, from the same previous turn, is used as it is.
          const resolved = followUp?.resolved ?? await resolveAgenticFollowUpV1({
            gate, previous, question: goal.question, today: requestDay, time_zone: temporal?.time_zone ?? "UTC", signal: activeSignal,
          });
          if (followUp?.resolved === undefined) followUp?.on_resolved?.(resolved);
          const { resolution } = resolved;
          if (resolution.resolution === "clarify") {
            // More than one thing could fit: no research runs, and the answer asks which one, released as every answer is.
            phase = "final";
            const clarified = agenticClarifyResponseV1(options.desk.scope, goal.question, resolution.choices);
            const { released: response, ...receipt } = await release(clarified.outcome, 0, clarified, agenticAskAnswerSha256V1(clarified));
            return Object.freeze({ response, writer_evidence: Object.freeze([]), ...receipt });
          }
          // Exactly one thing fits: research answers the full question that names it, starting from what it is about.
          if (resolution.resolution === "resolved") {
            resolvedQuestion = resolution.question;
            researchBrief = Object.freeze({
              ...brief, goal: Object.freeze({ kind: "question" as const, question: resolution.question }),
              starting: options.desk.openCitation === undefined ? [] : agenticFollowUpStartingV1(previous, resolution.about),
            });
            if (runnableBrief(researchBrief) === null) throw new AgenticAskOutputErrorV1("question is invalid");
          }
        }

        // ---- research: the loop owns its state; the runner reads its progress and its bundle ----
        const researchStep = !researchOnly ? prompts.ask : brief.options.list === false ? prompts.search_only_task : prompts.task;
        const researching = createAgenticResearchLoopV1({
          desk, brief: researchBrief,
          ...(options.research_driver === undefined ? {} : { driver: options.research_driver }),
          ...researchStep, step_span: "ask_planner",
          context: context(requestDay), scope, catalog,
          now, silence_ms: options.generation.timeout_ms, signal: activeSignal, assert_live: assertLive, ...(options.wall_ms === undefined ? {} : { wall_now: options.wall_ms }),
          observed: () => ({ checked_at: checkedAt, model_ms: stepModelMs, desk_ms: deskMs }),
          ...(progress === undefined ? {} : { report: progress.research }),
        });
        loop = researching;
        // The loop never sees the trigger; its name is a label for the audit and the evaluation.
        const { schema_version, kind, ...gathered } = await observeAgenticLifecycleV1('research', 'research_loop', {}, () => researching.run(gate), value => {
          annotateCoreRuntimeV1({ research_stop_reason: value.stop.reason });
          return { research: trimAgenticEvidenceBundleV1({ ...value, trigger: input.trigger }) };
        });
        const bundle: AgenticEvidenceBundleV1 = Object.freeze({ schema_version, kind, trigger: input.trigger, ...gathered });
        const researched = trimAgenticEvidenceBundleV1(bundle);
        // Back in the enclosing run span: one summary for every trigger.
        annotateCoreRuntimeV1({ research_stop_reason: bundle.stop.reason,
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
            // Counted as renderer context only once its model call starts (its span), as Ask's writer is.
            on_context: ids => { selectedEvidence = ids; selectedTicketCount = ticketsAmong(ids); },
          }), value => ({ output_kind: 'rendered', selected_evidence: selectedEvidence, fallback_count: value.fallbacks, outcome: value.outcome, result: value.result }));
          writerFallbacks += output.fallbacks;
          annotateCoreRuntimeV1({ counts: { context_atom_count: selectedEvidence.length } });
          const { released } = await release(output.outcome, output.cited.length, output.result, output.answer_sha256);
          ticketCitationCount = ticketsAmong(output.cited);
          return Object.freeze({ ...(render === undefined ? {} : { rendered: released }), research: researched, writer_evidence: Object.freeze([]) });
        }

        // Research is over; its cost bundle excludes renderer and finalization work.
        phase = "answer";

        // ---- Ask's renderer: the writer and the layout read only the bundle ----
        const writer = createAskRendererV1({
          answer_prompt: answerPrompt,
          source_catalog: sourceCatalog, scope, context: context(requestDay), desk_scope: options.desk.scope,
          // An answer to an Ask that carried its previous turn names the question it answers, and an Ask again's writer also
          // says what is different since the earlier answer (ADR-0047). With none of its sentences left to compare with, an
          // Ask again is answered as asked: it cannot say what changed.
          ...(previous === undefined ? {} : { answers: resolvedQuestion ?? goal.question }),
          ...(previous?.purpose === "ask_again" && previous.statements.length > 0 ? { earlier: earlierAnswer(previous, temporal?.time_zone ?? "UTC") } : {}),
          // Only a request that saves follow-ups drafts them (ADR-0053).
          ...(options.follow_ups === undefined ? {} : { follow_ups: { request_id: options.follow_ups.request_id } }),
        });
        let selectedEvidence: readonly string[] = [];
        progress?.stage("writing");
        const rendered = await observeAgenticLifecycleV1('renderer', 'research_output', { output_kind: 'answer' }, () => writer.render({
          // The writer answers the resolved question; only the words the person typed (the brief's) vouch for a follow-up's task.
          bundle, trigger_input: { question: resolvedQuestion ?? goal.question, typed_question: goal.question }, gate, signal: activeSignal, prompt_budget: promptBudget,
          on_context: selected => {
            selectedEvidence = selected;
            // Counted as answer context only once the writer call starts (its span).
            selectedTicketCount = ticketsAmong(selected);
          },
        }), value => ({ output_kind: 'answer', selected_evidence: selectedEvidence, fallback_count: value.fallbacks, outcome: value.outcome, result: value.result.response }));
        writerFallbacks += rendered.fallbacks;
        annotateCoreRuntimeV1({ counts: { context_atom_count: selectedEvidence.length } });
        phase = "final";
        // Only a released answer has a receipt. Its follow-ups are saved once every check has passed, so a cancelled,
        // refused or failed answer saves none; their ids are the request's, so a restarted attempt saves the same ones.
        const drafts = rendered.result.follow_ups;
        const sink = options.follow_ups?.sink;
        const save = sink === undefined || drafts.length === 0 ? undefined : () => sink.save(drafts);
        const { released: response, ...receipt } = await release(rendered.outcome, rendered.cited.length, rendered.result.response, rendered.answer_sha256, save);
        ticketCitationCount = response.citations.filter(value => value.citation.kind === "ticket").length;
        return Object.freeze({ response, research: researched, writer_evidence: rendered.result.writer_evidence, ...receipt, ...(save === undefined ? {} : { follow_ups: drafts }) });
      } catch (error) {
        // A stall stops the request with its reason; the audit records it as timed out.
        const stall = error instanceof AgenticAskStalledErrorV1 ? error
          : activeSignal.aborted && activeSignal.reason instanceof AgenticAskStalledErrorV1 ? activeSignal.reason : undefined;
        if (stall !== undefined && input.signal?.aborted !== true) {
          terminalAbort.abort(stall);
          if (!terminalAudited) await auditAgenticTerminalV1("timed_out", { ...auditContext(), checked_at: checkedAt });
          throw stall;
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
        const { searches, search_hits, refused_reads, repeated_refusals, unchecked_items, sources_looked_at, most_reads_in_a_step, retrieved_tickets } = researchProgress();
        annotateCoreRuntimeV1({ counts: { planned_query_count: searches, query_hit_count: search_hits } });
        // Ask's read accounting (research tool contract v1), beside planned_query_count for operators (RB-OPERATIONS-001).
        // The release check counts its own from the research rounds.
        if (goal.kind === "question") annotateCoreRuntimeV1({ counts: { refused_read_count: refused_reads, repeated_refusal_count: repeated_refusals, unchecked_item_count: unchecked_items, sources_looked_at, most_reads_in_a_step } });
        annotateCoreRuntimeV1({ counts: { ticket_retrieved_items: retrieved_tickets, ticket_context_items: ticketContextCount, ticket_citations: ticketCitationCount } });
      }
  }, value => ({ trigger: input.trigger, output_kind: value.response !== undefined ? 'answer' : value.rendered !== undefined ? 'rendered' : 'research', result: value.response ?? value.rendered ?? value.research }));
  const signalOf = (signal: AbortSignal | undefined) => signal === undefined ? {} : { signal };
  return Object.freeze({
    /** `previous`: the asker's previous turn (ADR-0047). */
    async answer(input: { readonly question: string; readonly signal?: AbortSignal; readonly previous?: PersonAnswerPreviousV1; readonly follow_up?: AgenticFollowUpCarryV1 }): Promise<PersonAnswerResponseV8> {
      return (await request({ trigger: "ask", brief: questionBrief(input.question, AGENTIC_RESEARCH_LIVE_BUDGET_V1), ...signalOf(input.signal) }, undefined, input.previous, input.follow_up)).response!;
    },
    /** Ask with its progress sent to `on_progress` while it runs, in V3, and the receipt built after release (ADR-0039). */
    async answerWithReceipt(input: AgenticAskProgressInputV3): Promise<AgenticAskAnswerWithReceiptV3> {
      if (typeof input.on_progress !== "function") throw new AgenticAskOutputErrorV1("Ask progress is unavailable");
      const output = await request({ trigger: "ask", brief: questionBrief(input.question, AGENTIC_RESEARCH_LIVE_BUDGET_V1), ...signalOf(input.signal), on_progress: input.on_progress,
        ...(input.request === undefined ? {} : { progress_request: input.request }) }, undefined, input.previous, input.follow_up);
      return Object.freeze({ response: output.response!, receipt: output.receipt! });
    },
    /** Ask plus its research result and writer input, for the research evaluation. */
    async answerWithResearch(input: { readonly question: string; readonly signal?: AbortSignal; readonly budget?: AgenticResearchBudgetV1 }): Promise<AgenticAskWithResearchV1<PersonAnswerResponseV8>> {
      const output = await request({ trigger: "ask", brief: questionBrief(input.question, input.budget ?? AGENTIC_RESEARCH_LIVE_BUDGET_V1), ...signalOf(input.signal) });
      return Object.freeze({ response: output.response!, research: output.research!, writer_evidence: output.writer_evidence, ...(output.follow_ups === undefined ? {} : { follow_ups: output.follow_ups }) });
    },
    /** One trigger's brief: a task brief runs research only and its trimmed result is audited and returned. */
    async research(input: AgenticResearchInputV1): Promise<AgenticResearchResultV1> {
      return (await request(input)).research!;
    },
    /** A task brief with its trigger's renderer: the released result, and the research it read (for the evaluation). */
    async renderWithResearch<In, Out>(input: AgenticRenderedResearchInputV1<In, Out>): Promise<{ readonly rendered: Out; readonly research: AgenticResearchResultV1 }> {
      const { renderer, trigger_input: triggerInput, ...run } = input;
      const output = await request(run, { renderer: renderer as AgenticRendererV1<unknown, unknown>, trigger_input: triggerInput });
      return Object.freeze({ rendered: output.rendered as Out, research: output.research! });
    },
  });
}
/** The same factory, under the name the trigger runs and the research evaluation call it by. */
export const createAgenticResearchV1 = createAgenticAskV5;
