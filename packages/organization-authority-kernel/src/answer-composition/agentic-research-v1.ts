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
