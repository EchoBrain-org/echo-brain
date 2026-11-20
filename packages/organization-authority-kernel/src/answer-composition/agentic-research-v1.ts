import type { AgenticListEvidenceV1 } from "./agentic-list-evidence-v1.js";
import type { AskFollowUpDraftV1 } from "./ask-follow-ups-v1.js";

/**
 * The research loop's types, separate from any one consumer (research loop
 * evaluation v1). Every trigger hands the loop a brief (agentic-brief-v1.ts);
 * Ask asks a question, every other trigger a task written from its definition.
 */

/**
 * Who waits on a research run: a person in the app (`live`) or nobody (`background`). It sets no limit: research runs
 * while it makes progress, and only a model call or read that stays silent past its silence period stops it
 * (agentic-model-gate-v1.ts, agentic-ask-v1.ts). The audit row records a background run as such.
 */
export interface AgenticResearchBudgetV1 {
  readonly profile: "live" | "background";
}

/** Ask in the app: a person waits, and Ask streams its progress with a heartbeat (ADR-0039). */
export const AGENTIC_RESEARCH_LIVE_BUDGET_V1: AgenticResearchBudgetV1 = Object.freeze({ profile: "live" });

/** Background triggers: nobody waits on the screen. */
export const AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1: AgenticResearchBudgetV1 = Object.freeze({ profile: "background" });

/** The one place a profile's label becomes its value: trigger definitions and the staging request's override both read it. */
export const AGENTIC_RESEARCH_BUDGETS_V1: Readonly<Record<"live" | "background", AgenticResearchBudgetV1>> = Object.freeze({
  live: AGENTIC_RESEARCH_LIVE_BUDGET_V1, background: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
});

/** What research works on: a person's question (Ask), or a task ECHO wrote from its trigger's template. */
export type AgenticResearchGoalV1 =
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "task"; readonly task: string };

/** `stalled`: a research model call sent nothing for its silence period, twice. */
export type AgenticResearchStopReasonV1 = "finished" | "empty_catalog" | "no_progress" | "stalled" | "unusable_step";

/**
 * What an Ask need asks (ADR-0041), declared by research: `which_items`, which items exist in a source or in a set
 * picked by list facts (a list answers it); `which_say`, which members of such a set say something (it cites the list
 * it checks); `content`, anything else (text read in full answers it). A task goal's needs have no kind.
 */
export const AGENTIC_RESEARCH_NEED_KINDS_V1 = Object.freeze(["which_items", "which_say", "content"] as const);
export type AgenticResearchNeedKindV1 = (typeof AGENTIC_RESEARCH_NEED_KINDS_V1)[number];

/**
 * `evidence` holds item ids (`E4`) and, for Ask, list ids (`L1`, ADR-0041). A found which_items need records its
 * inventory L ids and every requested member E id, preserving selection independently of answer presentation.
 * An L-only found need declares the list as its fallback when the writer supplies no selection. Supporting facts
 * unrelated to the requested membership belong in a separate content need. A need without `kind` is content.
 */
export interface AgenticResearchNeedV1 { readonly need: string; readonly kind?: AgenticResearchNeedKindV1; readonly status: "open" | "found" | "not_found"; readonly evidence: readonly string[] }
export interface AgenticResearchPartV1 { readonly part: number; readonly question: string; readonly notes: string; readonly needs: readonly AgenticResearchNeedV1[] }

/** One released item as the eval sees it: no desk id, open ref or receipt. */
export interface AgenticResearchItemV1 {
  readonly id: string;
  readonly source: string;
  readonly kind: string;
  readonly title: string;
  readonly citation: unknown;
  readonly date?: string;
  readonly date_kind?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly text?: string;
  /** The research model saw its complete released text. */
  readonly read_in_full: boolean;
  readonly opened: boolean;
  /** Loaded before round 1 (starting evidence). */
  readonly preloaded: boolean;
  readonly cited_by_plan: boolean;
}

export interface AgenticResearchActionV1 {
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
  readonly result: {
    readonly items: readonly string[];
    readonly opened: readonly string[];
    /** Ask only (ADR-0041): the item an open resolved to, by its short id, whatever form the model gave it (a title too). */
    readonly id?: string;
    readonly note?: string;
    readonly error?: string;
    readonly truncated?: boolean;
    /**
     * Ask only (ADR-0041): false when a truncated open left the opened item's own text whole, the cut being only what
     * came beside it; absent, `truncated` covers the item.
     */
    readonly anchor_truncated?: false;
    readonly more?: boolean;
    readonly notice?: boolean;
    /** Ask only (research tool contract v1): each filter's outcome on this read. */
    readonly filters?: Readonly<Record<string, unknown>>;
    /** Ask only: what a refused read's source supports. */
    readonly supports?: Readonly<Record<string, unknown>>;
    /** Ask only: the items a date filter could not test, and the dates they carry. */
    readonly unchecked?: Readonly<Record<string, unknown>>;
  };
}

export interface AgenticResearchRoundV1 {
  readonly round: number;
  readonly elapsed_ms: number;
  readonly plan: readonly AgenticResearchPartV1[];
  readonly actions: readonly AgenticResearchActionV1[];
  /** Replies the loop rejected before this round's step was accepted, with the reason given to the model. */
  readonly rejected: readonly string[];
}

/**
 * The trimmed evidence bundle (`trimAgenticEvidenceBundleV1`): everything the
 * loop knows when it stops, in the eval view, without the server records.
 * Every item in it was already released to the person running the trigger.
 */
export interface AgenticResearchResultV1 {
  readonly schema_version: 1;
  readonly kind: "echo-agentic-research-result-v1";
  /** The trigger definition's name. */
  readonly trigger: string;
  /** The goal as research worked on it: a task with its starting ids filled in. */
  readonly goal: AgenticResearchGoalV1;
  readonly budget: AgenticResearchBudgetV1;
  readonly plan: readonly AgenticResearchPartV1[];
  readonly items: readonly AgenticResearchItemV1[];
  /** Ask only (ADR-0041): every list research read, unchanged from the bundle; absent for a task goal. */
  readonly lists?: readonly AgenticListEvidenceV1[];
  /** Starting citations the brief marked `report` that could not be read; present only when there are any. */
  readonly unreadable_starting?: readonly unknown[];
  readonly rounds: readonly AgenticResearchRoundV1[];
  readonly coverage: {
    readonly reads: readonly { readonly tool: string; readonly source: string; readonly returned_items: number; readonly truncated: boolean; readonly notice: boolean; readonly unavailable: boolean }[];
    readonly inventories: readonly Readonly<Record<string, unknown>>[];
    readonly notices: readonly string[];
  };
  readonly stop: {
    readonly reason: AgenticResearchStopReasonV1;
    readonly completed: boolean;
    /** Ask only: the request includes a change or message that its read-only tools cannot execute. */
    readonly unsupported_action?: true;
    /** Ask only (ADR-0053): the person asked for a task to be handed to someone or tracked, which Ask's writer may draft. */
    readonly follow_up_requested?: true;
  };
  readonly cost: {
    readonly rounds: number;
    readonly model_calls: number;
    readonly repairs: number;
    readonly fallbacks: number;
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly total_tokens: number | null;
    readonly model_ms: number;
    readonly desk_ms: number;
    readonly elapsed_ms: number;
  };
}

/** Ask's own output beside the research result: what the writer received, and the answer. */
export interface AgenticAskWithResearchV1<R> {
  readonly response: R;
  readonly research: AgenticResearchResultV1;
  /** Short ids handed to the writer, in order: items it read, then list rows it saw (ADR-0041); empty when the writer was not called. */
  readonly writer_evidence: readonly string[];
  /** The follow-ups the answer drafted and its release saved (ADR-0053); absent for none. */
  readonly follow_ups?: readonly AskFollowUpDraftV1[];
}
