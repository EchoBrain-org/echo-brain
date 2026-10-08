/**
 * The private Slack approval card's inputs, derived from a decision brief.
 *
 * A card shows the complete review of the exact brief it asks about. When an
 * item cannot be shown exactly, or the card cannot fit Slack's limits, there
 * is no card rather than a truncated informed-consent view. Owner proposals
 * come from the provider-neutral helpers, so every surface offers the same.
 */
import type { compileDecisionBrief } from "@echo-brain/organization-processing/core/processing/brief";
import { ownerProposalsV1 } from "@echo-brain/organization-processing/core/processing/owner-proposals-v1";
import type {
  PrivateSlackApprovalActionItemV1,
  PrivateSlackApprovalDecisionGroupV1,
  PrivateSlackApprovalReviewItemV1,
} from "./private-slack-approval-block-kit-card-v1.js";
import {
  buildPrivateSlackApprovalBlockKitCardV2,
  buildPrivateSlackApprovalBlockKitCardV3,
  type PrivateSlackApprovalBlockKitCardV2,
  type PrivateSlackApprovalBlockKitCardV3,
  type PrivateSlackApprovalEligibleProjectV2,
} from "./private-slack-approval-block-kit-card-v2.js";

type DecisionBriefV1 = ReturnType<typeof compileDecisionBrief>;
type ReviewSignal =
  | DecisionBriefV1["decisions"][number]
  | DecisionBriefV1["actions"][number]
  | DecisionBriefV1["rationales"][number];

/** The review blocks of one card, grouped as the card shows them. */
export interface PrivateSlackApprovalFrozenReviewV1 {
  readonly decision_groups: readonly PrivateSlackApprovalDecisionGroupV1[];
  readonly ungrouped_actions?: readonly PrivateSlackApprovalActionItemV1[];
  readonly ungrouped_rationales?: readonly PrivateSlackApprovalReviewItemV1[];
}

const MAX_TITLE = 150;

function meetingTitle(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
      : "";
  const selected = normalized.length === 0 ? "Meeting approval" : normalized;
  return selected.slice(0, MAX_TITLE).trim();
}

function isExactDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u0008\u000B-\u001F\u007F]/.test(value)
  );
}

function evidenceReferenceText(signal: ReviewSignal): string | undefined {
  const evidence = signal.evidence[0];
  if (evidence === undefined || !isExactDisplayText(evidence.block_id)) {
    return undefined;
  }
  return `Transcript block ${evidence.block_id}`;
}

function reviewItem(signal: ReviewSignal): PrivateSlackApprovalReviewItemV1 | undefined {
  const evidence_reference = evidenceReferenceText(signal);
  if (!isExactDisplayText(signal.text) || evidence_reference === undefined) {
    return undefined;
  }
  return Object.freeze({ text: signal.text, evidence_reference });
}

/**
 * Each decision with the rationales that support it, then the actions and the
 * rationales that support no decision. Undefined when any item has no exact
 * display text or evidence reference.
 */
export function frozenReviewV1(brief: DecisionBriefV1): PrivateSlackApprovalFrozenReviewV1 | undefined {
  const decisionIds = new Set(brief.decisions.map((decision) => decision.id));
  const decision_groups: PrivateSlackApprovalDecisionGroupV1[] = [];

  for (const [index, decision] of brief.decisions.entries()) {
    const item = reviewItem(decision);
    if (item === undefined) return undefined;
    const rationales: PrivateSlackApprovalReviewItemV1[] = [];
    for (const rationale of brief.rationales) {
      if (!rationale.supports_signal_ids.includes(decision.id)) continue;
      const rationaleItem = reviewItem(rationale);
      if (rationaleItem === undefined) return undefined;
      rationales.push(rationaleItem);
    }
    decision_groups.push(Object.freeze({
      id: `decision-group-${index + 1}`,
      decision: Object.freeze({ ...item, status: decision.status }),
      rationales: Object.freeze(rationales),
    }));
  }

  const ungrouped_actions: PrivateSlackApprovalActionItemV1[] = [];
  for (const action of brief.actions) {
    const item = reviewItem(action);
    if (item === undefined) return undefined;
    ungrouped_actions.push(item);
  }

  const ungrouped_rationales: PrivateSlackApprovalReviewItemV1[] = [];
  for (const rationale of brief.rationales) {
    if (rationale.supports_signal_ids.some((id) => decisionIds.has(id))) continue;
    const item = reviewItem(rationale);
    if (item === undefined) return undefined;
    ungrouped_rationales.push(item);
  }

  return Object.freeze({
    decision_groups: Object.freeze(decision_groups),
    ...(ungrouped_actions.length === 0
      ? {}
      : { ungrouped_actions: Object.freeze(ungrouped_actions) }),
    ...(ungrouped_rationales.length === 0
      ? {}
      : { ungrouped_rationales: Object.freeze(ungrouped_rationales) }),
  });
}

function isCardLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("private approval Block Kit card ");
}

export interface PrivateSlackApprovalCardFromBriefInputV1 {
  readonly approval_id: string;
  readonly meeting_title: unknown;
  /** The uncleared brief: its proposed owners become the card's owner fields. */
  readonly brief: DecisionBriefV1;
  readonly eligible_projects: readonly PrivateSlackApprovalEligibleProjectV2[];
}

/**
 * The V3 card when the brief proposes owners and their fields fit, otherwise
 * the V2 card, whose proposals are simply not offered. Undefined when the
 * review cannot be shown completely within Slack's limits.
 */
export function buildPrivateSlackApprovalCardFromBriefV1(
  input: PrivateSlackApprovalCardFromBriefInputV1,
): PrivateSlackApprovalBlockKitCardV2 | PrivateSlackApprovalBlockKitCardV3 | undefined {
  const review = frozenReviewV1(input.brief);
  if (review === undefined) return undefined;
  const base = {
    approval_id: input.approval_id,
    meeting_title: meetingTitle(input.meeting_title),
    eligible_projects: input.eligible_projects,
    ...review,
  };
  const proposals = ownerProposalsV1(input.brief);
  if (proposals.length > 0) {
    try {
      return buildPrivateSlackApprovalBlockKitCardV3({ schema_version: 3, ...base, owner_proposals: proposals });
    } catch (error) {
      if (!isCardLimitError(error)) throw error;
    }
  }
  try {
    return buildPrivateSlackApprovalBlockKitCardV2({ schema_version: 2, ...base });
  } catch (error) {
    // V1 review errors raised inside the V2 build are the same card limit.
    if (isCardLimitError(error)) return undefined;
    throw error;
  }
}
