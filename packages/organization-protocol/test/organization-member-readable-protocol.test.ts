import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_POLICY_ID,
  ORGANIZATION_MEMBER_READABLE_SLACK_REACTION_RECORD_SURFACE,
  organizationMemberReadableSlackReactionApprovalPolicyContractSha256,
  organizationMemberReadableSlackReactionApprovalPresentation,
  projectOrganizationMemberReadableReleaseDraft,
  validateOrganizationMemberReadableReleaseDraft,
} from '../src/index.js';

const approvalId = 'a'.repeat(64);
const brief = {
  meeting: { id: 'meeting-1', title: 'Member-readable decision' },
  decisions: [{ id: 'decision-1', kind: 'decision', text: 'Ship the approved change.' }],
  actions: [{ id: 'action-1', kind: 'action', text: 'Publish the release notes.' }],
  rationales: [{ id: 'rationale-1', kind: 'rationale', text: 'The organization approved this package.' }],
};

describe('organization-member-readable protocol', () => {
  it('pins the closed policy digest and complete ordered release card', () => {
    const draft = projectOrganizationMemberReadableReleaseDraft({ approval_id: approvalId, brief });
    expect(draft.items.map((item) => item.kind)).toEqual(['decision', 'action', 'rationale']);
    const card = organizationMemberReadableSlackReactionApprovalPresentation({ draft, approve_reaction: 'white_check_mark', reject_reaction: 'x' });
    expect(card.blocks.at(-2)).toMatchObject({ block_id: `echo-approval-${approvalId}-organization-member-policy-v1`, text: { text: ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT, emoji: false } });
    expect(card.text).toContain(ORGANIZATION_MEMBER_READABLE_CONSEQUENCE_TEXT);
    expect(organizationMemberReadableSlackReactionApprovalPolicyContractSha256()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ORGANIZATION_MEMBER_READABLE_POLICY_ID).toBe('organization-member-readable-v1');
  });

  it('rejects extra draft fields and a non-member-readable surface is not implicit', () => {
    const draft = projectOrganizationMemberReadableReleaseDraft({ approval_id: approvalId, brief });
    expect(() => validateOrganizationMemberReadableReleaseDraft({ ...draft, extra: true })).toThrow();
    expect(ORGANIZATION_MEMBER_READABLE_SLACK_REACTION_RECORD_SURFACE).toBe('slack-organization-member-readable-v1');
  });
});
