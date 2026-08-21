import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_READABLE_POLICY_ID,
  organizationMemberReadableApprovalPresentation,
  organizationMemberReadableApprovalPresentationSha256,
  organizationMemberReadablePolicyContractSha256,
  organizationMemberReadableReleaseDraftSha256,
  projectOrganizationMemberReadableReleaseDraft,
} from '@echo-brain/organization-protocol';
import type { OrganizationRecordDecisionBriefV1 } from '@echo-brain/organization-protocol';

export interface OrganizationMemberApprovalPresentationRendering {
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
  readonly policy_id: typeof ORGANIZATION_MEMBER_READABLE_POLICY_ID;
  readonly policy_contract_sha256: string;
  readonly release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
}

export interface OrganizationMemberApprovalPresentationRenderInput {
  readonly approvalId: string;
  readonly brief: OrganizationRecordDecisionBriefV1;
  readonly approveReaction: string;
  readonly rejectReaction: string;
}

/** Projects the exact schema-v3 Slack card and its protocol commitments. */
export function renderOrganizationMemberApprovalPresentation(
  input: OrganizationMemberApprovalPresentationRenderInput,
): OrganizationMemberApprovalPresentationRendering {
  const draft = projectOrganizationMemberReadableReleaseDraft({
    approval_id: input.approvalId,
    brief: input.brief,
  });
  const presentation = organizationMemberReadableApprovalPresentation({
    draft,
    approve_reaction: input.approveReaction,
    reject_reaction: input.rejectReaction,
  });
  return Object.freeze({
    text: presentation.text,
    blocks: presentation.blocks as unknown as readonly Record<string, unknown>[],
    policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
    policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
    release_draft_sha256: organizationMemberReadableReleaseDraftSha256(draft),
    approval_presentation_sha256:
      organizationMemberReadableApprovalPresentationSha256(presentation),
  });
}

/**
 * Detects an in-place Slack secret rotation without retaining or returning the
 * credential itself.
 */
export function slackCredentialFingerprintSha256(token: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Slack credential value is unavailable');
  }
  return canonicalSha256({
    schema_version: 1,
    kind: 'slack-credential-fingerprint-v1',
    token,
  });
}

/** Structurally satisfies the schema-v3 renderer port on the Slack surface. */
export const organizationMemberApprovalPresentationRenderer = Object.freeze({
  render: renderOrganizationMemberApprovalPresentation,
  credentialFingerprint: slackCredentialFingerprintSha256,
});

/** The fixed schema-v3 policy digest used by publication preflight. */
export const organizationMemberApprovalPolicyContractSha256 =
  organizationMemberReadablePolicyContractSha256;
