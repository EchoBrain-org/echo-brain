import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type ApprovalContractSha256,
  type PersonApprovalPolicyId,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";

/** Exact case-sensitive Granola folder name for reviewer-only records. */
export const GRANOLA_RESTRICTED_PERSON_FOLDER_NAME_V1 =
  "echo-restricted" as const;

export interface CleanGranolaPersonContentPolicyV1 {
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_text: string;
  readonly policy_consequence_sha256: ApprovalContractSha256;
}

const MEMBER_READABLE_POLICY: CleanGranolaPersonContentPolicyV1 = Object.freeze({
  policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  policy_contract_sha256:
    ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  policy_consequence_text: ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  policy_consequence_sha256:
    ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
});

const RESTRICTED_REVIEWER_POLICY: CleanGranolaPersonContentPolicyV1 =
  Object.freeze({
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    policy_contract_sha256:
      RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
    policy_consequence_text: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
    policy_consequence_sha256:
      RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
  });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The adapter freezes Granola's provider fact under
 * extensions.granola.folder_membership. Nothing inferred from the title can
 * affect Person policy selection.
 */
export function selectGranolaPersonContentPolicyV1(
  extensions: unknown,
): CleanGranolaPersonContentPolicyV1 {
  const folderMembership =
    isRecord(extensions) && isRecord(extensions.granola)
      ? extensions.granola.folder_membership
      : undefined;
  const restricted =
    Array.isArray(folderMembership) &&
    folderMembership.some(
      (folder) =>
        isRecord(folder) &&
        folder.name === GRANOLA_RESTRICTED_PERSON_FOLDER_NAME_V1,
    );
  return restricted
    ? RESTRICTED_REVIEWER_POLICY
    : MEMBER_READABLE_POLICY;
}

/** Rejects selector drift before a Granola review policy is persisted or shown. */
export function assertGranolaPersonContentPolicySnapshotV1(
  extensions: unknown,
  actual: CleanGranolaPersonContentPolicyV1,
): void {
  const expected = selectGranolaPersonContentPolicyV1(extensions);
  if (
    actual.policy_id !== expected.policy_id ||
    actual.policy_contract_sha256 !== expected.policy_contract_sha256 ||
    actual.policy_consequence_text !== expected.policy_consequence_text ||
    actual.policy_consequence_sha256 !== expected.policy_consequence_sha256
  ) {
    throw new Error(
      "clean Granola review policy must match its canonical content policy",
    );
  }
}
