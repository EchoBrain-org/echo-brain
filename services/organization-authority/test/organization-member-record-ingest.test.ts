import { describe, expect, it } from 'vitest';
import {
  organizationMemberReadablePolicyContractSha256,
  type OrganizationRecordOrganizationMemberApprovalEnvelopeV3,
} from '@echo-brain/organization-protocol';
import { AuthorityOperationError } from '../src/domain/errors.js';
import {
  OrganizationRecordIngestAuthority,
  OrganizationRecordIngestRejectionError,
} from '../src/application/organization-record-ingest.js';

const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

function envelope(): OrganizationRecordOrganizationMemberApprovalEnvelopeV3 {
  return {
    schema_version: 3, kind: 'echo-organization-record-envelope', event_type: 'approval',
    envelope_id: 'rec_test', idempotency_key: 'a'.repeat(64),
    submitter: { installation_id: 'ins_test', submitted_at: '2026-08-12T00:00:00.000Z' },
    payload: {
      brief: { provenance: { processor: { instance_id: 'default' } } },
    } as never,
    intent: {} as never,
    integrity: {} as never,
    reviewer: {
      principal_id: 'prn_approver', membership_id: 'mem_approver', reviewed_by: 'Approver',
      authorization: {
        schema_version: 3, kind: 'echo-organization-authorization-evidence',
        policy_id: 'organization-member-readable-v1', policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
        authority_id: 'oau_test', organization_id: 'org_test', enrollment_id: 'enr_test',
        installation_id: 'ins_test', request_id: 'pcr_test', approval_id: 'a'.repeat(64),
        action: 'approve', request_sha256: digest('2'), provider_event_sha256: digest('3'),
        allowed: true, reason_code: 'active_organization_member_readable_notice_v1',
        principal_id: 'prn_approver', membership_id: 'mem_approver', adapter_binding_id: 'bnd_test',
        permission_grant_id: 'pgr_test', evaluated_at: '2026-08-12T00:00:00.000Z',
        authorization_audit_event_id: 'aud_test', authorization_audit_entry_sha256: digest('4'),
        release_draft_sha256: digest('5'), approval_presentation_sha256: digest('6'),
        semantic_intent_sha256: digest('7'), message_presentation_sha256: digest('8'),
      },
    },
  };
}

const ACTIVE_POLICY = Object.freeze({
  schema_version: 1 as const,
  kind: 'organization-recording-policy-v1' as const,
  decision_processor_adapter_instance_id: 'default',
  approval_surface_adapter_instance_id: 'primary',
  presentation_mode: 'organization-member-readable-v1' as const,
  policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
});

function authorityFor(document: OrganizationRecordOrganizationMemberApprovalEnvelopeV3) {
  return {
    recordIngestInstallationContext: () => ({
      authority_id: 'oau_test', organization_id: 'org_test', enrollment_id: 'enr_test',
      principal_id: 'prn_submitter', membership_id: 'mem_submitter', installation_id: 'ins_test',
      installation_signing_key: {} as never, checked_at: '2026-08-12T00:00:00.000Z',
    }),
    verifyRecordEnvelope: () => document,
    signRecordReceipt: async () => ({}),
  };
}

describe('schema-v3 organization-member record ingest', () => {
  it('requires exact audit reproof and returns the capability proof view', async () => {
    const document = envelope();
    const authority = new OrganizationRecordIngestAuthority({
      authority: authorityFor(document) as never,
      permissionPilotHealth: { kind: 'absent' },
      reviewerRestrictedHealth: { kind: 'ready' },
      organizationMemberReadableHealth: { kind: 'ready' },
      organizationRecordingPolicy: ACTIVE_POLICY,
      evidence: {
        findAllowedApprovalAuthorizationEvidence: () => ({ status: 'matched' }),
        findAllowedReviewerAuthorizationEvidenceById: () => ({ status: 'absent' }),
        findAllowedOrganizationMemberAuthorizationEvidenceById: () => ({
          status: 'matched', audit_entry_sha256: document.reviewer.authorization.authorization_audit_entry_sha256,
          adapter_instance_id: 'primary',
        }),
      },
    });
    const verified = await authority.verifyEnvelope({ submitter: { installation_id: 'ins_test' } });
    expect(verified.envelope_schema_version).toBe(3);
    expect(verified.organization_member_readable_proof).toMatchObject({
      policy_id: 'organization-member-readable-v1',
      approving_principal_id: 'prn_approver',
      authorization_audit_event_id: 'aud_test',
    });
  });

  it('does not admit v3 while audit reproof is unavailable', async () => {
    const document = envelope();
    const authority = new OrganizationRecordIngestAuthority({
      authority: authorityFor(document) as never,
      permissionPilotHealth: { kind: 'absent' }, reviewerRestrictedHealth: { kind: 'ready' },
      organizationMemberReadableHealth: { kind: 'ready' },
      organizationRecordingPolicy: ACTIVE_POLICY,
      evidence: {
        findAllowedApprovalAuthorizationEvidence: () => ({ status: 'matched' }),
        findAllowedReviewerAuthorizationEvidenceById: () => ({ status: 'absent' }),
      },
    });
    await expect(authority.verifyEnvelope({ submitter: { installation_id: 'ins_test' } }))
      .rejects.toBeInstanceOf(AuthorityOperationError);
  });

  it('turns a proved audit mismatch into terminal invalid input', async () => {
    const document = envelope();
    const authority = new OrganizationRecordIngestAuthority({
      authority: authorityFor(document) as never,
      permissionPilotHealth: { kind: 'absent' }, reviewerRestrictedHealth: { kind: 'ready' },
      organizationMemberReadableHealth: { kind: 'ready' },
      organizationRecordingPolicy: ACTIVE_POLICY,
      evidence: {
        findAllowedApprovalAuthorizationEvidence: () => ({ status: 'matched' }),
        findAllowedReviewerAuthorizationEvidenceById: () => ({ status: 'absent' }),
        findAllowedOrganizationMemberAuthorizationEvidenceById: () => ({ status: 'mismatch' }),
      },
    });
    await expect(authority.verifyEnvelope({ submitter: { installation_id: 'ins_test' } }))
      .rejects.toBeInstanceOf(OrganizationRecordIngestRejectionError);
  });

  it('does not mistake self-asserted processor provenance for central authorization', async () => {
    const document = envelope();
    (document.payload.brief.provenance.processor as { instance_id: string }).instance_id =
      'unexpected-processor';
    const authority = new OrganizationRecordIngestAuthority({
      authority: authorityFor(document) as never,
      permissionPilotHealth: { kind: 'absent' },
      reviewerRestrictedHealth: { kind: 'ready' },
      organizationMemberReadableHealth: { kind: 'ready' },
      organizationRecordingPolicy: ACTIVE_POLICY,
      evidence: {
        findAllowedApprovalAuthorizationEvidence: () => ({ status: 'matched' }),
        findAllowedReviewerAuthorizationEvidenceById: () => ({ status: 'absent' }),
        findAllowedOrganizationMemberAuthorizationEvidenceById: () => ({
          status: 'matched',
          audit_entry_sha256:
            document.reviewer.authorization.authorization_audit_entry_sha256,
          adapter_instance_id: 'primary',
        }),
      },
    });
    await expect(
      authority.verifyEnvelope({ submitter: { installation_id: 'ins_test' } }),
    ).resolves.toMatchObject({ envelope_schema_version: 3 });
  });

  it('rejects v3 when the audited approval-surface instance differs from the policy head', async () => {
    const document = envelope();
    const authority = new OrganizationRecordIngestAuthority({
      authority: authorityFor(document) as never,
      permissionPilotHealth: { kind: 'absent' },
      reviewerRestrictedHealth: { kind: 'ready' },
      organizationMemberReadableHealth: { kind: 'ready' },
      organizationRecordingPolicy: ACTIVE_POLICY,
      evidence: {
        findAllowedApprovalAuthorizationEvidence: () => ({ status: 'matched' }),
        findAllowedReviewerAuthorizationEvidenceById: () => ({ status: 'absent' }),
        findAllowedOrganizationMemberAuthorizationEvidenceById: () => ({
          status: 'matched',
          audit_entry_sha256:
            document.reviewer.authorization.authorization_audit_entry_sha256,
          adapter_instance_id: 'other-surface',
        }),
      },
    });
    await expect(
      authority.verifyEnvelope({ submitter: { installation_id: 'ins_test' } }),
    ).rejects.toBeInstanceOf(OrganizationRecordIngestRejectionError);
  });
});
