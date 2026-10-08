import type { DecisionBrief } from "../contracts/delivery.js";

/**
 * Proposed action owners (ADR-0021). Extraction may propose an owner for an
 * action, but a proposal is never approved content: the approved brief clears
 * it, and only an owner the approver confirms is recorded. These helpers are
 * provider-neutral so every approval surface offers the same proposals.
 */

/** Longest owner a proposal offers, in characters. */
const OWNER_MAX_CHARACTERS_V1 = 120;
/**
 * At most this many owner proposals are offered. A brief with more offers
 * none, so nothing is recorded for any of its actions.
 */
export const OWNER_PROPOSALS_MAX_V1 = 40;

/** One action whose owner extraction proposed; `action_index` is its place in the brief's actions. */
export interface OwnerProposalV1 {
  readonly action_index: number;
  readonly action_text: string;
  readonly owner: string;
}

function isExactDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u0008\u000B-\u001F\u007F]/.test(value)
  );
}

/**
 * An owner as offered: one line, NFC, single spaces, trimmed, at most 120
 * characters, with no control or format characters. Empty or invalid is no
 * owner.
 */
function canonicalProposedOwner(value: string): string | null {
  const owner = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (owner.length === 0) return null;
  if (owner.length > OWNER_MAX_CHARACTERS_V1 || /[\p{Cc}\p{Cf}]/u.test(owner)) return null;
  return owner;
}

/**
 * The brief an approval commits to: every proposed owner cleared. A brief with
 * no proposals is returned unchanged, so its snapshot keeps its exact bytes.
 */
export function withoutProposedOwnersV1(brief: DecisionBrief): DecisionBrief {
  if (brief.actions.every((action) => action.owner === null)) return brief;
  return Object.freeze({
    ...brief,
    actions: Object.freeze(brief.actions.map((action) => action.owner === null ? action : Object.freeze({ ...action, owner: null }))),
  });
}

/**
 * The actions of an uncleared brief whose owner extraction proposed, in brief
 * order. An action is offered only with displayable text and a canonical
 * owner; more than `OWNER_PROPOSALS_MAX_V1` proposals offer none.
 */
export function ownerProposalsV1(brief: DecisionBrief): readonly OwnerProposalV1[] {
  const proposals: OwnerProposalV1[] = [];
  for (const [action_index, action] of brief.actions.entries()) {
    if (action.owner === null || !isExactDisplayText(action.text)) continue;
    const owner = canonicalProposedOwner(action.owner);
    if (owner !== null) proposals.push(Object.freeze({ action_index, action_text: action.text, owner }));
  }
  return Object.freeze(proposals.length > OWNER_PROPOSALS_MAX_V1 ? [] : proposals);
}
