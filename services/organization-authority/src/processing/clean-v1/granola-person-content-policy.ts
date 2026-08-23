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

/**
 * A Granola author can make a record reviewer-only by starting its title with
 * this exact marker. It is deliberately a title convention, not a new source
 * setting, policy engine, or alternate intake path.
 */
export const GRANOLA_RESTRICTED_PERSON_TITLE_PREFIX_V1 =
  "[echo:restricted] " as const;

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

/** The marker is exact and only recognized at the very start of a title. */
export function selectGranolaPersonContentPolicyV1(
  title: string | null | undefined,
): CleanGranolaPersonContentPolicyV1 {
  return title?.startsWith(GRANOLA_RESTRICTED_PERSON_TITLE_PREFIX_V1) === true
    ? RESTRICTED_REVIEWER_POLICY
    : MEMBER_READABLE_POLICY;
}
