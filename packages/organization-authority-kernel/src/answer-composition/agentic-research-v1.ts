/**
 * The research loop's types, separate from any one consumer (research loop
 * evaluation v1). Every trigger hands the loop a brief (agentic-brief-v1.ts);
 * Ask asks a question, every other trigger a task written from its definition.
 */

/** Limits one trigger gives the research loop. */
export interface AgenticResearchBudgetV1 {
  /** The whole request, research through the consumer's writer and audit. */
  readonly deadline_ms: number;
  readonly max_rounds: number;
  /** Request-wide model calls, including retries, repairs and the writer. */
  readonly max_model_calls: number;
  /** Time research leaves for the consumer's writer call. */
  readonly writer_reserve_ms: number;
}

/** Ask in the app: the Cloudflare proxy drops responses after 100 s (ADR-0022). */
export const AGENTIC_RESEARCH_LIVE_BUDGET_V1: AgenticResearchBudgetV1 = Object.freeze({
  deadline_ms: 90_000, max_rounds: 10, max_model_calls: 24, writer_reserve_ms: 25_000,
});

/** Background triggers: starting values, tuned by the evaluation. */
export const AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1: AgenticResearchBudgetV1 = Object.freeze({
  deadline_ms: 300_000, max_rounds: 20, max_model_calls: 48, writer_reserve_ms: 25_000,
});

/** The one place a budget profile's label becomes its limits: trigger definitions and the staging request's override both read it. */
export const AGENTIC_RESEARCH_BUDGETS_V1: Readonly<Record<"live" | "background", AgenticResearchBudgetV1>> = Object.freeze({
  live: AGENTIC_RESEARCH_LIVE_BUDGET_V1, background: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
});

/** What research works on: a person's question (Ask), or a task ECHO wrote from its trigger's template. */
export type AgenticResearchGoalV1 =
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "task"; readonly task: string };

export type AgenticResearchStopReasonV1 = "finished" | "empty_catalog" | "no_progress" | "step_limit" | "budget" | "unusable_step";

export interface AgenticResearchNeedV1 { readonly need: string; readonly status: "open" | "found" | "not_found"; readonly evidence: readonly string[] }
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
  /** Loaded before round 1 (starting evidence or the small-scope preload). */
  readonly preloaded: boolean;
  readonly cited_by_plan: boolean;
}

export interface AgenticResearchActionV1 {
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
  readonly result: {
    readonly items: readonly string[];
    readonly opened: readonly string[];
    readonly note?: string;
    readonly error?: string;
    readonly truncated?: boolean;
    readonly more?: boolean;
    readonly notice?: boolean;
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
  /** Starting citations the brief marked `report` that could not be read; present only when there are any. */
  readonly unreadable_starting?: readonly unknown[];
  readonly rounds: readonly AgenticResearchRoundV1[];
  readonly coverage: {
    readonly reads: readonly { readonly tool: string; readonly source: string; readonly returned_items: number; readonly truncated: boolean; readonly notice: boolean; readonly unavailable: boolean }[];
    readonly inventories: readonly Readonly<Record<string, unknown>>[];
    readonly notices: readonly string[];
  };
  readonly stop: { readonly reason: AgenticResearchStopReasonV1; readonly completed: boolean };
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
  /** Short ids handed to the writer, in order; empty when the writer was not called. */
  readonly writer_evidence: readonly string[];
}
