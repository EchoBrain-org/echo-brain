import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from "../shared/evidence-desk-v2.js";
import type { AgenticAskGenerationObservationV1 } from "./agentic-model-gate-v1.js";
import type {
  AgenticResearchBudgetV1,
  AgenticResearchGoalV1,
  AgenticResearchItemV1,
  AgenticResearchPartV1,
  AgenticResearchResultV1,
  AgenticResearchRoundV1,
  AgenticResearchTriggerV1,
} from "./agentic-research-v1.js";

/**
 * The evidence bundle (research trigger contract v1, section 2): everything
 * the research loop gathered, handed to a renderer and the release step. The
 * full bundle stays on the server; its trimmed form is the evaluation's view
 * (`AgenticResearchResultV1`). It never holds an answer or a conclusion.
 */

/** One item research came across, as the server holds it. `short` is the only id a model ever sees. */
export interface AgenticEvidenceBundleItemV1 {
  readonly short: string;
  /** The source selector the model saw for this item. */
  readonly source: string;
  /** The released desk item: desk id, receipt, ref, visibility. Server only. */
  readonly item: EvidenceDeskItemV2;
  /** The research model saw its complete released text. */
  readonly full: boolean;
  readonly opened: boolean;
  /** Loaded before round 1: starting evidence or the small-scope preload. */
  readonly preloaded: boolean;
  /** When research last used it; larger is more recent. */
  readonly touched: number;
  /** The latest search that returned it. */
  readonly query?: string;
  readonly cited_by_plan: boolean;
}

export interface AgenticEvidenceBundleV1 {
  readonly schema_version: 1;
  readonly kind: "echo-agentic-evidence-bundle-v1";
  readonly trigger: AgenticResearchTriggerV1;
  readonly goal: AgenticResearchGoalV1;
  readonly budget: AgenticResearchBudgetV1;
  /** The checklist: research notes, not proof. */
  readonly plan: readonly AgenticResearchPartV1[];
  /** Every item research came across, in short-id order. */
  readonly items: readonly AgenticEvidenceBundleItemV1[];
  /** Starting items a trigger asked to report rather than fail on. Always empty until briefs carry that option. */
  readonly unreadable_starting: readonly unknown[];
  readonly rounds: readonly AgenticResearchRoundV1[];
  readonly coverage: AgenticResearchResultV1["coverage"];
  readonly stop: AgenticResearchResultV1["stop"];
  readonly cost: AgenticResearchResultV1["cost"];
  /** Whose access gathered it. The person is bound by the desk, never named here. */
  readonly gathered_for: { readonly scope: EvidenceDeskPortV2["scope"]; readonly checked_at: string | null };
  /** Never shown to a model, never saved by the evaluation. */
  readonly server: {
    readonly receipts: readonly Sha256Digest[];
    readonly invocation_digests: readonly Sha256Digest[];
    readonly generations: readonly AgenticAskGenerationObservationV1[];
  };
}

/**
 * What a model or the evaluation sees of an item's attributes. A meeting action
 * with no confirmed owner says so ("none recorded") rather than leaving the
 * owner out, so the model does not fill it in from who the action mentions
 * (ADR-0021).
 */
export function attributesOf(item: EvidenceDeskItemV2): EvidenceDeskItemV2["attributes"] {
  if (item.kind !== "action" || item.attributes?.owner !== undefined) return item.attributes;
  return Object.freeze({ ...item.attributes, owner: "none recorded" });
}

/**
 * How a model sees one item, research step or renderer alike: its short id,
 * source selector, kind, title, provenance, date and details. Never its text,
 * desk id, receipt or citation.
 */
export function describeAgenticEvidenceItemV1(entry: { readonly short: string; readonly source: string; readonly item: EvidenceDeskItemV2 }): Record<string, unknown> {
  return {
    id: entry.short, source: entry.source, kind: entry.item.kind, title: entry.item.label,
    provenance: { kind: entry.item.citation.kind, ...(entry.item.citation.kind === 'page' ? { version: entry.item.citation.version } : {}) },
    ...(entry.item.occurred_at === undefined ? {} : { date: entry.item.occurred_at, date_kind: entry.item.date_kind ?? 'unspecified' }),
    ...(attributesOf(entry.item) === undefined ? {} : { attributes: attributesOf(entry.item) }),
  };
}

/** The evaluation's view: released content only, no desk ids, refs, receipts or model-call records. */
export function trimAgenticEvidenceBundleV1(bundle: AgenticEvidenceBundleV1): AgenticResearchResultV1 {
  const items: AgenticResearchItemV1[] = bundle.items.map(entry => {
    const attributes = attributesOf(entry.item);
    return Object.freeze({
      id: entry.short, source: entry.source, kind: entry.item.kind, title: entry.item.label, citation: entry.item.citation,
      ...(entry.item.occurred_at === undefined ? {} : { date: entry.item.occurred_at, date_kind: entry.item.date_kind ?? "unspecified" }),
      ...(attributes === undefined ? {} : { attributes: attributes as Readonly<Record<string, string>> }),
      ...(entry.item.text === undefined ? {} : { text: entry.item.text }),
      read_in_full: entry.full, opened: entry.opened, preloaded: entry.preloaded, cited_by_plan: entry.cited_by_plan,
    });
  });
  return Object.freeze({
    schema_version: 1 as const, kind: "echo-agentic-research-result-v1" as const, trigger: bundle.trigger, goal: bundle.goal, budget: bundle.budget,
    plan: bundle.plan, items: Object.freeze(items), rounds: bundle.rounds,
    coverage: bundle.coverage, stop: bundle.stop, cost: bundle.cost,
  });
}
