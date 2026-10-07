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

export interface AgenticBriefV1 {
  /** A person's question (Ask), passed through as asked, or a task ECHO wrote from its trigger's template. */
  readonly goal: AgenticResearchGoalV1;
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

/** The task as the model sees it: each starting slot holds its item's id, or says the item could not be read. */
export function fillAgenticTaskV1(task: string, ids: readonly (string | null)[]): string {
  return task.replace(/\{\{starting:(\d+)\}\}/gu, (slot, position: string) => {
    const id = ids[Number(position) - 1];
    return id === undefined ? slot : id ?? "an item that could not be read";
  });
}
