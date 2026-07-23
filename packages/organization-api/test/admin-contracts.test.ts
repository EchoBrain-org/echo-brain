import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { organizationEnrollmentGrantSha256 } from '@echo-brain/organization-protocol';
import {
  MAX_ORGANIZATION_API_CURSOR_CHARACTERS,
  MAX_ORGANIZATION_API_PAGE_ITEMS,
  validateIssueOrganizationEnrollmentGrantRequest,
  validateOrganizationAdminOverview,
  validateOrganizationAuditPage,
  validateOrganizationEnrollmentGrantPage,
  validateOrganizationEnrollmentInvitation,
  validateOrganizationInstallationPage,
  validateOrganizationMembershipPage,
  validateProvisionOrganizationMembershipRequest,
} from '../src/index.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  enrollment: 'enr_00000000-0000-4000-8000-000000000001',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  command: 'adm_00000000-0000-4000-8000-000000000001',
} as const;

const DIGESTS = {
  authorityPin:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  installationKey:
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  grant:
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
} as const;

const TIMES = {
  created: '2026-07-22T10:00:00.000Z',
  provisioned: '2026-07-22T11:00:00.000Z',
  enrolled: '2026-07-22T12:00:00.000Z',
  expires: '2026-07-22T13:00:00.000Z',
  revoked: '2026-07-22T14:00:00.000Z',
} as const;

function membershipSummary() {
  return {
    organization_id: IDS.organization,
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    display_name: 'Example Employee',
    membership_type: 'employee' as const,
    status: 'active' as const,
    provisioned_at: TIMES.provisioned,
    revoked_at: null,
    revocation_reason: null,
  };
}

function installationSummary() {
  return {
    organization_id: IDS.organization,
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    enrollment_id: IDS.enrollment,
    installation_id: IDS.installation,
    installation_key_id: DIGESTS.installationKey,
    status: 'active' as const,
    enrolled_at: TIMES.enrolled,
    revoked_at: null,
    revocation_kind: null,
    revocation_reason: null,
    current_access_sequence: 3,
    current_access_status: 'active' as const,
    current_access_valid_until: TIMES.expires,
  };
}

function grantSummary() {
  return {
    organization_id: IDS.organization,
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    enrollment_grant_sha256: DIGESTS.grant,
    issued_at: TIMES.provisioned,
    expires_at: TIMES.expires,
    consumed_at: null,
    status: 'pending' as const,
  };
}

describe('organization administrator commands', () => {
  it('requires canonical administrator command IDs and digest-only grant material', () => {
    const membership = {
      command_id: IDS.command,
      display_name: 'Example Employee',
      membership_type: 'employee' as const,
    };
    const grant = {
      command_id: IDS.command,
      enrollment_grant_sha256: DIGESTS.grant,
      lifetime_seconds: 3600,
    };

    expect(validateProvisionOrganizationMembershipRequest(membership)).toEqual(
      membership,
    );
    expect(validateIssueOrganizationEnrollmentGrantRequest(grant)).toEqual(
      grant,
    );

    expect(() =>
      validateProvisionOrganizationMembershipRequest({
        ...membership,
        command_id: IDS.command.replace('adm_', 'cmd_'),
      }),
    ).toThrow('canonical adm identifier');
    expect(() =>
      validateIssueOrganizationEnrollmentGrantRequest({
        ...grant,
        enrollment_grant_base64url: 'A'.repeat(43),
      }),
    ).toThrow('unexpected shape');
  });

  it('validates the shared secret-bearing invitation handoff exactly', () => {
    const grantBytes = Uint8Array.from({ length: 32 }, () => 7);
    const grantBase64url = Buffer.from(grantBytes).toString('base64url');
    const grantDigest = organizationEnrollmentGrantSha256(grantBytes);
    const pending = {
      schema_version: 1 as const,
      kind: 'echo-organization-enrollment-invitation' as const,
      status: 'pending_registration' as const,
      authority_base_url: 'https://authority.example.com',
      authority_id: IDS.authority,
      authority_pin_sha256: DIGESTS.authorityPin,
      authority_pin_verification: 'independent_pin_required' as const,
      organization_id: IDS.organization,
      membership_id: IDS.membership,
      command_id: IDS.command,
      enrollment_grant_sha256: grantDigest,
      enrollment_grant_base64url: grantBase64url,
      lifetime_seconds: 7200,
      issued: null,
    };
    expect(validateOrganizationEnrollmentInvitation(pending)).toEqual(pending);

    const issued = {
      ...pending,
      status: 'issued' as const,
      issued: {
        authority_id: IDS.authority,
        authority_pin_sha256: DIGESTS.authorityPin,
        organization_id: IDS.organization,
        principal_id: IDS.principal,
        membership_id: IDS.membership,
        enrollment_grant_sha256: grantDigest,
        issued_at: TIMES.provisioned,
        expires_at: TIMES.expires,
      },
    };
    expect(validateOrganizationEnrollmentInvitation(issued)).toEqual(issued);
    expect(() =>
      validateOrganizationEnrollmentInvitation({
        ...issued,
        lifetime_seconds: 3600,
      }),
    ).toThrow('lifetime does not match');
    expect(() =>
      validateOrganizationEnrollmentInvitation({
        ...issued,
        enrollment_grant_sha256: DIGESTS.grant,
      }),
    ).toThrow('digest does not match');
    expect(() =>
      validateOrganizationEnrollmentInvitation({
        ...pending,
        authority_pin_verification: 'trust_the_file',
      }),
    ).toThrow('independent authority PIN');
  });
});

describe('organization administrator read responses', () => {
  it('validates an explicit, internally consistent overview', () => {
    const overview = {
      organization_id: IDS.organization,
      organization_display_name: 'Example Company',
      authority_id: IDS.authority,
      authority_pin_sha256: DIGESTS.authorityPin,
      created_at: TIMES.created,
      last_observed_at: TIMES.revoked,
      counts: {
        memberships: 3,
        active_memberships: 2,
        revoked_memberships: 1,
        installations: 2,
        active_installations: 1,
        revoked_installations: 1,
        enrollment_grants: 4,
        pending_enrollment_grants: 1,
        consumed_enrollment_grants: 2,
        expired_enrollment_grants: 1,
        audit_entries: 12,
      },
    };
    expect(validateOrganizationAdminOverview(overview)).toEqual(overview);
    expect(() =>
      validateOrganizationAdminOverview({
        ...overview,
        counts: { ...overview.counts, active_memberships: 3 },
      }),
    ).toThrow('membership counts are inconsistent');
  });

  it('validates bounded membership and installation pages', () => {
    const cursor = 'eyJpZCI6MX0';
    expect(
      validateOrganizationMembershipPage({
        items: [membershipSummary()],
        next_cursor: cursor,
      }),
    ).toEqual({ items: [membershipSummary()], next_cursor: cursor });
    expect(
      validateOrganizationInstallationPage({
        items: [installationSummary()],
        next_cursor: null,
      }),
    ).toEqual({ items: [installationSummary()], next_cursor: null });

    expect(() =>
      validateOrganizationMembershipPage({
        items: [membershipSummary()],
        next_cursor: 'x',
      }),
    ).toThrow('canonical base64url');
    expect(() =>
      validateOrganizationMembershipPage({
        items: Array.from(
          { length: MAX_ORGANIZATION_API_PAGE_ITEMS + 1 },
          membershipSummary,
        ),
        next_cursor: null,
      }),
    ).toThrow('maximum page size');
    expect(() =>
      validateOrganizationMembershipPage({
        items: [],
        next_cursor: 'A'.repeat(MAX_ORGANIZATION_API_CURSOR_CHARACTERS + 1),
      }),
    ).toThrow('canonical base64url');
  });

  it('rejects inconsistent membership and installation lifecycle summaries', () => {
    expect(() =>
      validateOrganizationMembershipPage({
        items: [
          {
            ...membershipSummary(),
            status: 'revoked',
            revoked_at: TIMES.revoked,
          },
        ],
        next_cursor: null,
      }),
    ).toThrow('revocation_reason');
    expect(() =>
      validateOrganizationInstallationPage({
        items: [
          {
            ...installationSummary(),
            current_access_status: 'revoked',
            current_access_valid_until: null,
          },
        ],
        next_cursor: null,
      }),
    ).toThrow('statuses are inconsistent');
  });

  it('validates grant and structured audit pages without returning grant bytes', () => {
    const audit = {
      audit_sequence: 7,
      occurred_at: TIMES.enrolled,
      actor_kind: 'admin' as const,
      action: 'enrollment_grant.issued',
      subject_id: IDS.membership,
      detail: { grant_sha256: DIGESTS.grant, retry: false },
    };
    expect(
      validateOrganizationEnrollmentGrantPage({
        items: [grantSummary()],
        next_cursor: null,
      }),
    ).toEqual({ items: [grantSummary()], next_cursor: null });
    expect(
      validateOrganizationAuditPage({ items: [audit], next_cursor: null }),
    ).toEqual({ items: [audit], next_cursor: null });

    expect(() =>
      validateOrganizationEnrollmentGrantPage({
        items: [
          {
            ...grantSummary(),
            status: 'consumed',
          },
        ],
        next_cursor: null,
      }),
    ).toThrow('consumed_at');
    expect(() =>
      validateOrganizationAuditPage({
        items: [{ ...audit, detail: { invalid: undefined } }],
        next_cursor: null,
      }),
    ).toThrow('plain object');
  });
});
