import {
  organizationMemberReadableApprovalPresentation,
  organizationMemberReadableApprovalPresentationSha256,
  organizationMemberReadablePolicyContractSha256,
  projectOrganizationMemberReadableReleaseDraft,
  organizationMemberReadableReleaseDraftSha256,
} from '@echo-brain/organization-protocol';
import { reviewerCredentialFingerprintSha256 } from './reviewer-presentation-renderer.js';

/**
 * The one local schema-v3 organization-member card renderer. The adapter owns
 * Slack transport only; this product-local projection owns the exact protocol
 * draft, consequence block, presentation bytes, and policy binding.
 */
export function renderOrganizationMemberApprovalPresentation(input: {
  readonly approvalId: string;
  readonly brief: unknown;
  readonly approveReaction: string;
  readonly rejectReaction: string;
}): {
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
  readonly policy_id: 'organization-member-readable-v1';
  readonly policy_contract_sha256: string;
  readonly release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
} {
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
    policy_id: 'organization-member-readable-v1' as const,
    policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
    release_draft_sha256: organizationMemberReadableReleaseDraftSha256(draft),
    approval_presentation_sha256:
      organizationMemberReadableApprovalPresentationSha256(presentation),
  });
}

export const organizationMemberApprovalPresentationRenderer = Object.freeze({
  render: renderOrganizationMemberApprovalPresentation,
  credentialFingerprint: reviewerCredentialFingerprintSha256,
});

/** The fixed schema-v3 policy digest used by startup preflight. */
export const organizationMemberApprovalPolicyContractSha256 =
  organizationMemberReadablePolicyContractSha256;
