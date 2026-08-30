import { Buffer } from "node:buffer";
import { organizationProtocolValidationFailure } from "./validation-error.js";

/**
 * The one positive content policy in reviewer V1. A selector, workbench, or
 * second positive choice adds no V1 value, so the identifier is a constant and
 * never a stored per-record column.
 */
export const RESTRICTED_REVIEWER_POLICY_ID = "restricted-reviewer-v1";

/** The one publication mode name that carries the reviewer consequence. */
export const RESTRICTED_REVIEWER_PRESENTATION_MODE = "restricted-reviewer-v1";

/**
 * The human-facing consequence, shown before approval and frozen
 * into the Authority-computed semantic preimage. Changing one byte changes
 * `policy_contract_sha256` and every semantic digest, so it is a contract
 * revision rather than copy editing.
 */
export const RESTRICTED_REVIEWER_CONSEQUENCE_TEXT =
  "Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.";

export const RESTRICTED_REVIEWER_CONSEQUENCE_VERSION = 1;

/** The only `reason_code` a schema-v2 allow may carry. */
export const RESTRICTED_REVIEWER_ALLOW_REASON_CODE =
  "active_reviewer_restricted_notice_v1";

/** The only `payload.surface` an envelope-v2 reviewer approval may carry. */
export const RESTRICTED_REVIEWER_RECORD_SURFACE = "slack-reviewer-v1";

export const REVIEWER_RELEASE_ITEM_KINDS = Object.freeze([
  "decision",
  "action",
  "rationale",
] as const);

export type ReviewerReleaseItemKindV1 =
  (typeof REVIEWER_RELEASE_ITEM_KINDS)[number];

export const MAX_REVIEWER_CARD_TITLE_SCALARS = 150;
export const MAX_REVIEWER_ITEM_TEXT_SCALARS = 240;
export const MAX_REVIEWER_SIGNAL_ID_BYTES = 512;
export const MAX_REVIEWER_RELEASE_ITEMS = 10;

export const REVIEWER_REACTION_PATTERN = /^[a-z0-9_+-]{1,64}$/;
export const REVIEWER_APPROVAL_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Rejects every character class that could make one released string render or
 * canonicalize as something other than the reviewed line: control characters
 * (`Cc`), the two Unicode line/paragraph separators (`Zl`, `Zp`), and unpaired
 * surrogates. Callers also require NFC and a trimmed, non-empty value, so the
 * approved bytes, the card, and the response are the same bytes.
 */
function assertPresentableScalars(value: string, label: string): void {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff) {
      organizationProtocolValidationFailure(
        `${label} contains an unpaired surrogate`,
      );
    }
    if (
      code <= 0x001f ||
      (code >= 0x007f && code <= 0x009f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      organizationProtocolValidationFailure(
        `${label} contains a control or line-separator character`,
      );
    }
  }
}

/**
 * One released, human-visible line. NFC, trimmed, single-line, non-empty, and
 * bounded in Unicode scalar values rather than UTF-16 code units so an astral
 * character costs exactly one unit of the reviewed budget.
 */
export function assertReviewerPresentableText(
  value: unknown,
  label: string,
  maximumScalars: number,
): asserts value is string {
  if (typeof value !== "string") {
    organizationProtocolValidationFailure(`${label} must be a string`);
  }
  if (value.length === 0) {
    organizationProtocolValidationFailure(`${label} must not be empty`);
  }
  assertPresentableScalars(value, label);
  if (value.trim() !== value) {
    organizationProtocolValidationFailure(`${label} must be trimmed`);
  }
  if (value.normalize("NFC") !== value) {
    organizationProtocolValidationFailure(`${label} must be NFC normalized`);
  }
  if ([...value].length > maximumScalars) {
    organizationProtocolValidationFailure(
      `${label} must be at most ${maximumScalars} Unicode scalar values`,
    );
  }
}

/**
 * A raw protocol signal identifier. It is never rendered and never leaves the
 * member host in the clear: only its SHA-256 digest reaches the card, the
 * signed action request, and the fact plane.
 */
export function assertReviewerSignalId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    organizationProtocolValidationFailure(`${label} must be a string`);
  }
  if (value.length === 0) {
    organizationProtocolValidationFailure(`${label} must not be empty`);
  }
  assertPresentableScalars(value, label);
  if (value.trim() !== value) {
    organizationProtocolValidationFailure(`${label} must be trimmed`);
  }
  if (value.normalize("NFC") !== value) {
    organizationProtocolValidationFailure(`${label} must be NFC normalized`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_REVIEWER_SIGNAL_ID_BYTES) {
    organizationProtocolValidationFailure(
      `${label} must be at most ${MAX_REVIEWER_SIGNAL_ID_BYTES} UTF-8 bytes`,
    );
  }
}

export function assertReviewerApprovalId(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !REVIEWER_APPROVAL_ID_PATTERN.test(value)
  ) {
    organizationProtocolValidationFailure(
      `${label} must be a lowercase sha256 approval id`,
    );
  }
}

export function assertReviewerItemKind(
  value: unknown,
  label: string,
): asserts value is ReviewerReleaseItemKindV1 {
  if (
    typeof value !== "string" ||
    !REVIEWER_RELEASE_ITEM_KINDS.includes(value as ReviewerReleaseItemKindV1)
  ) {
    organizationProtocolValidationFailure(
      `${label} must be decision, action, or rationale`,
    );
  }
}

/**
 * The two reaction names are frozen with the card. They must be distinct so a
 * single observed reaction can never satisfy both the approve and the reject
 * interpretation of the same message.
 */
export function assertReviewerReactionPair(
  approveReaction: unknown,
  rejectReaction: unknown,
  label: string,
): void {
  for (const [value, name] of [
    [approveReaction, "approve_reaction"],
    [rejectReaction, "reject_reaction"],
  ] as const) {
    if (typeof value !== "string" || !REVIEWER_REACTION_PATTERN.test(value)) {
      organizationProtocolValidationFailure(`${label} ${name} is invalid`);
    }
  }
  if (approveReaction === rejectReaction) {
    organizationProtocolValidationFailure(
      `${label} approve and reject reactions must be distinct`,
    );
  }
}
