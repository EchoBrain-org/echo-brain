import type { AgenticResearchBudgetV1, AgenticResearchGoalV1 } from "./agentic-research-v1.js";

/**
 * The brief (research trigger contract v1, section 1): what every trigger
 * hands the research loop. A trigger definition writes it from its event; the
 * loop never learns which trigger wrote it. The person and the scope are not
 * in it: the request's access-checked desk binds them.
 */

/** One starting item: a citation released by an earlier request, re-read fresh through the desk before round one. */
export interface AgenticBriefStartingItemV1 {
  readonly citation: unknown;
  /** `fail` stops the run when the item cannot be read; `report` lists it in the bundle and research goes on. */
  readonly if_unreadable: "fail" | "report";
}

/**
 * A person's question (Ask), passed through as asked, or a task ECHO wrote
 * from its trigger's fixed template. The event's own text never joins the
 * template: it travels in `data` and goes in by data slot.
 */
export type AgenticBriefGoalV1 =
  | Extract<AgenticResearchGoalV1, { readonly kind: "question" }>
  | { readonly kind: "task"; readonly task: string; readonly data?: readonly string[] };

export interface AgenticBriefV1 {
  readonly goal: AgenticBriefGoalV1;
  readonly starting: readonly AgenticBriefStartingItemV1[];
  /** The budget profile, including the time held back for the renderer. */
  readonly budget: AgenticResearchBudgetV1;
  readonly options: {
    /** If the readable scope is small, open it all before round one (when the deployment allows it). */
    readonly small_scope_preload: boolean;
  };
}

/** How a task names its starting item `position` (1-based, in brief order) before the loop has read it. */
export function agenticStartingSlotV1(position: number): string {
  return `{{starting:${position}}}`;
}

/** How a task places its event's text `position` (1-based, in `goal.data`). */
export function agenticDataSlotV1(position: number): string {
  return `{{data:${position}}}`;
}

/**
 * The task as the model sees it. One pass over the fixed template: each
 * starting slot gets its item's id (or says the item could not be read), each
 * data slot its event text. What a slot receives is never read again, so event
 * text cannot act as template. A slot with nothing to fill it is a definition
 * bug and stops the run.
 */
export function fillAgenticTaskV1(task: string, ids: readonly (string | null)[], data: readonly string[] = []): string {
  return task.replace(/\{\{(starting|data):(\d+)\}\}/gu, (slot, kind: string, position: string) => {
    const value = (kind === "starting" ? ids : data)[Number(position) - 1];
    if (value === undefined) throw new Error(`Task slot ${slot} has nothing to fill it`);
    return value ?? "an item that could not be read";
  });
}
