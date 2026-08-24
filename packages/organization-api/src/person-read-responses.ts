import { canonicalJsonBytes } from "@echo-brain/federation-protocol";
import {
  MAX_REVIEWER_ITEM_TEXT_SCALARS,
  RESTRICTED_REVIEWER_POLICY_ID,
  assertReviewerPresentableText,
  isOrganizationProtocolValidationError,
} from "@echo-brain/organization-protocol";
import type {
  OrganizationReadableSearchResponseV1,
  OrganizationReadableSearchResultItemV1,
  OrganizationRecentDecisionItemV1,
  OrganizationRecentDecisionsResponseV1,
  OrganizationReviewerRecentDecisionItemV1,
  OrganizationReviewerRecentDecisionsResponseV1,
} from "./contracts.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertOnlyEnumerableDataProperties,
  fail,
} from "./validation.js";

export const MAX_ORGANIZATION_READABLE_SEARCH_RESPONSE_BYTES = 60 * 1024;
export const MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES = 60 * 1024;
export const MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES =
  60 * 1024;

const MAX_ITEMS = 10;
const SEARCH_CONTRACT_ID = "permission-aware-readable-search-v1";
const MEMBER_WITNESS =
  "You may read this item because it was explicitly approved for current active owner or employee members, including members admitted after approval, and your membership is active.";
const REVIEWER_WITNESS =
  "You may read this item because it records you as the approving reviewer and that exact reviewer membership is currently active.";
export const ORGANIZATION_RECENT_DECISIONS_POLICY_ID =
  "pilot-member-readable-v1" as const;
export const ORGANIZATION_RECENT_DECISIONS_WITNESS =
  "Readable because your active membership is one of the two memberships bound to pilot-member-readable-v1 and the returned records carry the exact two-person sharing notice.";
const REVIEWER_RECENT_WITNESS =
  "Allowed by restricted-reviewer-v1 because every returned item records you as its approving reviewer and that exact reviewer membership is currently active.";

function extractDenseArray(value: unknown, label: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    value.length > MAX_ITEMS ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    return fail(
      label + " must be a dense array with at most " + MAX_ITEMS + " items",
    );
  }

  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(
        label + " must be a dense array with at most " + MAX_ITEMS + " items",
      );
    }
    items.push(descriptor.value);
  }
  return items;
}

function assertKind(value: unknown, label: string): void {
  if (value !== "decision" && value !== "action" && value !== "rationale") {
    fail(label + " kind is unsupported");
  }
}

function assertDisplayText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.trim() !== value ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    [...value].length > 240
  ) {
    fail(label + " text is invalid");
  }
}

function validateSearchItem(
  value: unknown,
  index: number,
): OrganizationReadableSearchResultItemV1 {
  const label = "organization readable search response items[" + index + "]";
  const record = asRecord(value, label);
  assertExactKeys(record, ["kind", "text", "policy_id", "witness"], label);
  assertKind(record.kind, label);
  assertDisplayText(record.text, label);
  if (
    (record.policy_id === "organization-member-readable-v1" &&
      record.witness === MEMBER_WITNESS) ||
    (record.policy_id === "restricted-reviewer-v1" &&
      record.witness === REVIEWER_WITNESS)
  ) {
    return record as unknown as OrganizationReadableSearchResultItemV1;
  }
  return fail(label + " policy or witness is unsupported");
}

export function validateOrganizationReadableSearchResponse(
  value: unknown,
): OrganizationReadableSearchResponseV1 {
  const label = "organization readable search response";
  assertOnlyEnumerableDataProperties(value, label);
  const record = asRecord(value, label);
  assertExactKeys(record, ["schema_version", "contract_id", "items"], label);
  if (record.schema_version !== 1 || record.contract_id !== SEARCH_CONTRACT_ID) {
    fail(label + " identity is invalid");
  }
  const items = extractDenseArray(record.items, label + " items").map(
    validateSearchItem,
  );
  const response: OrganizationReadableSearchResponseV1 = {
    schema_version: 1,
    contract_id: SEARCH_CONTRACT_ID,
    items,
  };
  if (canonicalJsonBytes(response).byteLength > MAX_ORGANIZATION_READABLE_SEARCH_RESPONSE_BYTES) {
    fail(label + " exceeds its canonical byte limit");
  }
  return response;
}

function validateRecentItem(
  value: unknown,
  index: number,
): OrganizationRecentDecisionItemV1 {
  const label = "recent decisions response items[" + index + "]";
  const record = asRecord(value, label);
  assertExactKeys(record, ["atom_id", "kind", "text", "record_hash"], label);
  assertDigest(record.atom_id, label + " atom_id");
  assertDigest(record.record_hash, label + " record_hash");
  assertKind(record.kind, label);
  assertDisplayText(record.text, label);
  return record as unknown as OrganizationRecentDecisionItemV1;
}

export function validateOrganizationRecentDecisionsResponse(
  value: unknown,
): OrganizationRecentDecisionsResponseV1 {
  const label = "recent decisions response";
  const record = asRecord(value, label);
  assertExactKeys(record, ["schema_version", "policy_id", "witness", "items"], label);
  if (
    record.schema_version !== 1 ||
    record.policy_id !== ORGANIZATION_RECENT_DECISIONS_POLICY_ID ||
    record.witness !== ORGANIZATION_RECENT_DECISIONS_WITNESS
  ) {
    fail(label + " identity is unsupported");
  }
  const items = extractDenseArray(record.items, label + " items").map(
    validateRecentItem,
  );
  if (new Set(items.map((item) => item.atom_id)).size !== items.length) {
    fail(label + " repeats an atom_id");
  }
  const response: OrganizationRecentDecisionsResponseV1 = {
    schema_version: 1,
    policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
    witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
    items,
  };
  if (canonicalJsonBytes(response).byteLength > MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES) {
    fail(label + " exceeds its canonical byte limit");
  }
  return response;
}

function validateReviewerItem(
  value: unknown,
  index: number,
): OrganizationReviewerRecentDecisionItemV1 {
  const label = "reviewer recent decisions response items[" + index + "]";
  const record = asRecord(value, label);
  assertExactKeys(record, ["kind", "text"], label);
  assertKind(record.kind, label);
  try {
    assertReviewerPresentableText(
      record.text,
      label + " text",
      MAX_REVIEWER_ITEM_TEXT_SCALARS,
    );
  } catch (error) {
    if (isOrganizationProtocolValidationError(error)) {
      fail(label + " text is invalid", error);
    }
    throw error;
  }
  return record as unknown as OrganizationReviewerRecentDecisionItemV1;
}

export function validateOrganizationReviewerRecentDecisionsResponse(
  value: unknown,
): OrganizationReviewerRecentDecisionsResponseV1 {
  const label = "reviewer recent decisions response";
  assertOnlyEnumerableDataProperties(value, label);
  const record = asRecord(value, label);
  assertExactKeys(record, ["schema_version", "items", "policy_id", "witness"], label);
  if (
    record.schema_version !== 1 ||
    record.policy_id !== RESTRICTED_REVIEWER_POLICY_ID ||
    record.witness !== REVIEWER_RECENT_WITNESS
  ) {
    fail(label + " identity is unsupported");
  }
  const items = extractDenseArray(record.items, label + " items").map(
    validateReviewerItem,
  );
  const response: OrganizationReviewerRecentDecisionsResponseV1 = {
    schema_version: 1,
    items,
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    witness: REVIEWER_RECENT_WITNESS,
  };
  if (canonicalJsonBytes(response).byteLength > MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES) {
    fail(label + " exceeds its canonical byte limit");
  }
  return response;
}
