import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { isPersonWorkspaceCitationV1, personWorkspaceRefV1, type PersonAnswerCitationV7, type PersonAnswerCitationV8 } from "@echo-brain/organization-api";
import { AuthorityOperationError } from "../domain/errors.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from "../shared/evidence-desk-v2.js";
import type { AgenticListEvidenceV1 } from "./agentic-list-evidence-v1.js";
import type { AgenticAskGenerationObservationV1 } from "./agentic-model-gate-v1.js";
import { evidenceDayV1, localEvidenceDatesV1, localEvidenceTimeV1 } from "../shared/temporal-query-v1.js";
import type {
  AgenticResearchBudgetV1,
  AgenticResearchGoalV1,
  AgenticResearchItemV1,
  AgenticResearchPartV1,
  AgenticResearchResultV1,
  AgenticResearchRoundV1,
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
  /** Research read its complete released text: a planner step was shown it, or, with no planner, it was starting evidence read in full. */
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
  /** The trigger definition's name: a label the runner adds for the audit and the evaluation. The loop never sees it. */
  readonly trigger: string;
  /** The goal as research worked on it: a task with its starting ids filled in. */
  readonly goal: AgenticResearchGoalV1;
  readonly budget: AgenticResearchBudgetV1;
  /** The checklist: research notes, not proof. */
  readonly plan: readonly AgenticResearchPartV1[];
  /** Every item research came across, in short-id order. */
  readonly items: readonly AgenticEvidenceBundleItemV1[];
  /**
   * Ask only (a question goal, ADR-0041): every list research read, in list-id order. Members are short ids of
   * `items`. Absent for a task goal, whose renderers read `coverage.inventories` as before.
   */
  readonly lists?: readonly AgenticListEvidenceV1[];
  /** Starting citations the brief marked `report` that could not be read, in brief order. Nothing the desk refused is in `items`. */
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

/** Date fields for the client view, or the unchanged source view for a task without a client timezone. */
export function agenticEvidenceDatesV1(item: EvidenceDeskItemV2, timeZone?: string) {
  const field = item.date_kind === 'version_created' ? 'updated' : item.date_kind;
  // The legacy date is already UTC-truncated. Prefer the timestamp with the same meaning, never a different date field.
  const stamp = field === undefined ? item.occurred_at : item.dates?.[field] ?? item.occurred_at;
  const local = timeZone === undefined ? undefined : localEvidenceTimeV1(stamp, timeZone);
  const date = timeZone === undefined ? item.occurred_at : local === undefined ? undefined : evidenceDayV1(local, timeZone);
  const dates = timeZone === undefined ? item.dates : localEvidenceDatesV1(item.dates, timeZone);
  return { ...(dates === undefined ? {} : { dates }), ...(date === undefined ? {} : { date, date_kind: item.date_kind ?? 'unspecified' as const }) };
}

/** Only replace the date suffix ECHO adds to approved meeting labels; source-authored titles and text remain intact. */
export function agenticEvidenceLabelV1(item: EvidenceDeskItemV2, timeZone?: string, list = false): string {
  const label = list ? item.list_label ?? item.label : item.label;
  if (timeZone === undefined || item.citation.kind !== 'approved_record' || item.dates?.occurred === undefined) return label;
  const local = localEvidenceTimeV1(item.dates.occurred, timeZone);
  if (local === undefined) return label;
  const day = evidenceDayV1(local, timeZone)!;
  const rawDay = item.dates.occurred.slice(0, 10);
  const prefix = list && item.list_label !== undefined ? ', ' : ' (';
  const suffix = `${prefix}${rawDay})`;
  return label.endsWith(suffix) ? `${label.slice(0, -suffix.length)}${prefix}${day})` : label;
}

export function agenticEvidenceAttributesV1(item: EvidenceDeskItemV2, timeZone?: string): EvidenceDeskItemV2['attributes'] {
  const attributes = attributesOf(item);
  if (attributes?.due_at === undefined || timeZone === undefined) return attributes;
  const { due_at, ...rest } = attributes;
  const due = localEvidenceTimeV1(due_at, timeZone);
  return { ...rest, ...(due === undefined ? {} : { due_at: due }) };
}

/** How research and renderers see an item: metadata only, never text, desk identity, receipt or citation. */
export function describeAgenticEvidenceItemV1(entry: { readonly short: string; readonly source: string; readonly item: EvidenceDeskItemV2 }, timeZone?: string): Record<string, unknown> {
  const attributes = agenticEvidenceAttributesV1(entry.item, timeZone);
  return {
    id: entry.short, source: entry.source, kind: entry.item.kind, title: agenticEvidenceLabelV1(entry.item, timeZone),
    provenance: { kind: entry.item.citation.kind, ...(entry.item.citation.kind === 'page' ? { version: entry.item.citation.version } : {}) },
    ...agenticEvidenceDatesV1(entry.item, timeZone),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

/** How a renderer's result cites an item: its citation, kind, title, visibility and the ref that opens it. */
export function citationOfAgenticEvidenceItemV1(item: EvidenceDeskItemV2, timeZone?: string): PersonAnswerCitationV7 {
  // A workspace item cites only in the V8 answer; a V7 catalog never offers its source (research tool contract v1).
  if (isPersonWorkspaceCitationV1(item.citation)) throw new AuthorityOperationError('invalid_output', 'A workspace item has no V7 citation');
  return Object.freeze({ citation: item.citation, kind: item.kind as PersonAnswerCitationV7['kind'], label: agenticEvidenceLabelV1(item, timeZone), visibility: item.visibility, ...(item.ref === undefined ? {} : { ref: item.ref as PersonAnswerCitationV7['ref'] }) });
}

/**
 * How the V8 answer cites an item (research tool contract v1): as V7 does, and a workspace item or tool container by its
 * workspace citation. A project and a tool open through their workspace ref; a person and a container carry none, and a
 * container shows its key in its tool beside its label.
 */
export function citationOfAgenticEvidenceItemV8(item: EvidenceDeskItemV2, timeZone?: string): PersonAnswerCitationV8 {
  if (!isPersonWorkspaceCitationV1(item.citation)) return citationOfAgenticEvidenceItemV1(item, timeZone);
  const citation = item.citation;
  const ref = citation.kind === "project" || citation.kind === "tool" ? personWorkspaceRefV1(citation) : undefined;
  const key = citation.kind === "tool_container" ? item.attributes?.key : undefined;
  return Object.freeze({ citation, kind: citation.kind, label: agenticEvidenceLabelV1(item, timeZone), visibility: item.visibility, ...(ref === undefined ? {} : { ref }), ...(key === undefined ? {} : { key }) });
}

/** The evaluation's view: released content only, no desk ids, refs, receipts or model-call records. */
export function trimAgenticEvidenceBundleV1(bundle: AgenticEvidenceBundleV1): AgenticResearchResultV1 {
  const items: AgenticResearchItemV1[] = bundle.items.map(entry => {
    const attributes = attributesOf(entry.item);
    return Object.freeze({
      id: entry.short, source: entry.source, kind: entry.item.kind, title: entry.item.label, citation: entry.item.citation,
      ...(entry.item.dates === undefined ? {} : { dates: entry.item.dates }),
    ...(entry.item.occurred_at === undefined ? {} : { date: entry.item.occurred_at, date_kind: entry.item.date_kind ?? "unspecified" }),
      ...(attributes === undefined ? {} : { attributes: attributes as Readonly<Record<string, string>> }),
      ...(entry.item.text === undefined ? {} : { text: entry.item.text }),
      read_in_full: entry.full, opened: entry.opened, preloaded: entry.preloaded, cited_by_plan: entry.cited_by_plan,
    });
  });
  return Object.freeze({
    schema_version: 1 as const, kind: "echo-agentic-research-result-v1" as const, trigger: bundle.trigger, goal: bundle.goal, budget: bundle.budget,
    plan: bundle.plan, items: Object.freeze(items), ...(bundle.lists === undefined ? {} : { lists: bundle.lists }),
    ...(bundle.unreadable_starting.length === 0 ? {} : { unreadable_starting: bundle.unreadable_starting }), rounds: bundle.rounds,
    coverage: bundle.coverage, stop: bundle.stop, cost: bundle.cost,
  });
}
