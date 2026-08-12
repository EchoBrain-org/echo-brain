import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_POLICY_ID,
  RESTRICTED_REVIEWER_POLICY_ID,
  type ReadableSearchSegmentIdentity,
} from './contracts.js';
import {
  assertReadableSearchDigest,
  assertReadableSearchIdentifier,
} from './validation.js';

export function organizationMemberSegmentIdentity(input: {
  organization_id: string;
  policy_contract_sha256: `sha256:${string}`;
}): ReadableSearchSegmentIdentity {
  const organizationId = assertReadableSearchIdentifier(input.organization_id, 'organization_id');
  const policyContract = assertReadableSearchDigest(input.policy_contract_sha256, 'policy_contract_sha256');
  return Object.freeze({
    organization_id: organizationId,
    segment_id: canonicalSha256({
      schema_version: 1,
      kind: 'readable-search-organization-member-segment-v1',
      organization_id: organizationId,
      policy_id: ORGANIZATION_MEMBER_POLICY_ID,
      policy_contract_sha256: policyContract,
    }),
    segment_kind: 'organization-member',
    policy_id: ORGANIZATION_MEMBER_POLICY_ID,
    policy_contract_sha256: policyContract,
    reviewer_principal_id: null,
    reviewer_membership_id: null,
  });
}

export function reviewerSegmentIdentity(input: {
  organization_id: string;
  policy_contract_sha256: `sha256:${string}`;
  reviewer_principal_id: string;
  reviewer_membership_id: string;
}): ReadableSearchSegmentIdentity {
  const organizationId = assertReadableSearchIdentifier(input.organization_id, 'organization_id');
  const policyContract = assertReadableSearchDigest(input.policy_contract_sha256, 'policy_contract_sha256');
  const principalId = assertReadableSearchIdentifier(input.reviewer_principal_id, 'reviewer_principal_id');
  const membershipId = assertReadableSearchIdentifier(input.reviewer_membership_id, 'reviewer_membership_id');
  return Object.freeze({
    organization_id: organizationId,
    segment_id: canonicalSha256({
      schema_version: 1,
      kind: 'readable-search-reviewer-segment-v1',
      organization_id: organizationId,
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      policy_contract_sha256: policyContract,
      reviewer_principal_id: principalId,
      reviewer_membership_id: membershipId,
    }),
    segment_kind: 'reviewer',
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    policy_contract_sha256: policyContract,
    reviewer_principal_id: principalId,
    reviewer_membership_id: membershipId,
  });
}
