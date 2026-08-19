import { describe, expect, it } from 'vitest';
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
import {
  organizationMemberApprovalPolicyContractSha256,
  organizationMemberApprovalPresentationRenderer,
  renderOrganizationMemberApprovalPresentation,
  slackCredentialFingerprintSha256,
} from '../src/processing/record/adapters/organization-member-presentation-renderer.js';

const APPROVAL_ID = 'a'.repeat(64);
const MEETING_ID = 'granola:meeting-2026-08-19';

function brief(text = 'Ship the organization-member release.'): OrganizationRecordDecisionBriefV1 {
  return {
    schema_version: 1,
    id: 'brief-1',
    meeting: {
      id: MEETING_ID,
      title: 'Launch review',
      participants: [],
    },
    decisions: [
      {
        id: 'decision-1',
        kind: 'decision',
        text,
        subject: null,
        confidence: null,
        evidence: [{ meeting_id: MEETING_ID, block_id: 'block-1' }],
        status: 'decided',
      },
    ],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: 'rev-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'default',
        version: '1.0.0',
      },
      generated_at: '2026-08-19T12:00:00.000Z',
    },
  };
}

describe('organization-member Slack presentation renderer', () => {
  it('returns the exact schema-v3 protocol presentation and commitments', () => {
    const input = {
      approvalId: APPROVAL_ID,
      brief: brief(),
      approveReaction: 'white_check_mark',
      rejectReaction: 'x',
    };
    const draft = projectOrganizationMemberReadableReleaseDraft({
      approval_id: input.approvalId,
      brief: input.brief,
    });
    const presentation = organizationMemberReadableApprovalPresentation({
      draft,
      approve_reaction: input.approveReaction,
      reject_reaction: input.rejectReaction,
    });

    expect(renderOrganizationMemberApprovalPresentation(input)).toEqual({
      text: presentation.text,
      blocks: presentation.blocks,
      policy_id: ORGANIZATION_MEMBER_READABLE_POLICY_ID,
      policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
      release_draft_sha256:
        organizationMemberReadableReleaseDraftSha256(draft),
      approval_presentation_sha256:
        organizationMemberReadableApprovalPresentationSha256(presentation),
    });
    expect(organizationMemberApprovalPolicyContractSha256()).toBe(
      organizationMemberReadablePolicyContractSha256(),
    );
  });

  it('is deterministic and changes both content commitments with the brief', () => {
    const input = {
      approvalId: APPROVAL_ID,
      brief: brief(),
      approveReaction: 'white_check_mark',
      rejectReaction: 'x',
    };
    const first = organizationMemberApprovalPresentationRenderer.render(input);
    const retry = organizationMemberApprovalPresentationRenderer.render(input);
    const changed = organizationMemberApprovalPresentationRenderer.render({
      ...input,
      brief: brief('Hold the organization-member release.'),
    });

    expect(retry).toEqual(first);
    expect(changed.release_draft_sha256).not.toBe(first.release_draft_sha256);
    expect(changed.approval_presentation_sha256).not.toBe(
      first.approval_presentation_sha256,
    );
  });

  it('fingerprints the exact credential preimage without returning the token', () => {
    const token = 'xoxb-secret';
    const expected = canonicalSha256({
      schema_version: 1,
      kind: 'slack-credential-fingerprint-v1',
      token,
    });

    expect(slackCredentialFingerprintSha256(token)).toBe(expected);
    expect(
      organizationMemberApprovalPresentationRenderer.credentialFingerprint(
        token,
      ),
    ).toBe(expected);
    expect(expected).not.toContain(token);
    expect(slackCredentialFingerprintSha256('xoxb-other')).not.toBe(expected);
    expect(() => slackCredentialFingerprintSha256('')).toThrow(
      'Slack credential value is unavailable',
    );
  });
});
