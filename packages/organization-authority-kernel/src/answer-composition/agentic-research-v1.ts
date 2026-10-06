/**
 * The research loop's inputs, separate from any one consumer (research loop
 * evaluation v1). Ask is one trigger; Check and Sweep supply other goals and
 * starting evidence and run the same loop under a background budget.
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

/** Background triggers (Check, Sweep): starting values, tuned by the evaluation. */
export const AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1: AgenticResearchBudgetV1 = Object.freeze({
  deadline_ms: 300_000, max_rounds: 20, max_model_calls: 48, writer_reserve_ms: 25_000,
});

/** What starts research. A question comes from Ask; a record or findings from background triggers. */
export type AgenticResearchTriggerV1 = "ask" | "check" | "sweep";

/** An earlier finding a sweep rechecks: what was expected to change, and the items cited then. */
export interface AgenticResearchFindingV1 {
  readonly finding: string;
  readonly expected: string;
  /** Released citations from the earlier run; re-read fresh, never reused. */
  readonly citations: readonly unknown[];
}

export type AgenticResearchGoalV1 =
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "check_record"; readonly record: unknown }
  | { readonly kind: "recheck_findings"; readonly findings: readonly AgenticResearchFindingV1[] };

export interface AgenticResearchInputV1 {
  readonly trigger: Exclude<AgenticResearchTriggerV1, "ask">;
  readonly goal: Exclude<AgenticResearchGoalV1, { readonly kind: "question" }>;
  readonly budget?: AgenticResearchBudgetV1;
  readonly signal?: AbortSignal;
}

export const AGENTIC_RESEARCH_MAX_FINDINGS_V1 = 20;
export const AGENTIC_RESEARCH_MAX_FINDING_CITATIONS_V1 = 12;

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
 * Everything the loop knows when it stops (spec section 2), in the eval view:
 * every item in it was already released to the person running the trigger.
 */
export interface AgenticResearchResultV1 {
  readonly schema_version: 1;
  readonly kind: "echo-agentic-research-result-v1";
  readonly trigger: AgenticResearchTriggerV1;
  readonly goal: AgenticResearchGoalV1;
  readonly budget: AgenticResearchBudgetV1;
  readonly plan: readonly AgenticResearchPartV1[];
  readonly items: readonly AgenticResearchItemV1[];
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
