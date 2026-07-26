import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { normalizeP256LowS, p256KeyId } from '@echo-brain/federation-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  createOrganizationAccessLeaseRequest,
  organizationAccessLeaseRequestSha256,
  validateCompletedOrganizationEnrollment,
  validateIssuedOrganizationEnrollmentGrant,
  validateOrganizationAccessLeaseRequest,
  validateOrganizationAccessLeaseResponse,
  validateOrganizationApiError,
  validateOrganizationAuthorityDescriptorResponse,
  validateProvisionedOrganizationMembership,
  validateRevokedOrganizationInstallation,
  validateRevokedOrganizationMembership,
  verifyOrganizationAccessLeaseRequest,
} from '../src/index.js';

function installationKey(): {
  descriptor: P256SigningKeyDescriptor;
  sign(bytes: Buffer): Promise<Buffer>;
} {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('test key export failed');
  return {
    descriptor: {
      key_id: p256KeyId(publicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKey.toString('base64'),
    },
    async sign(bytes: Buffer): Promise<Buffer> {
      return normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: pair.privateKey,
          dsaEncoding: 'der',
        }),
      );
    },
  };
}

describe('organization access lease request', () => {
  it('creates, verifies, and hashes one installation-signed command', async () => {
    const key = installationKey();
    const request = await createOrganizationAccessLeaseRequest(
      {
        request_id: 'alr_00000000-0000-4000-8000-000000000001',
        authority_id: 'oau_00000000-0000-4000-8000-000000000001',
        authority_key_id:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        organization_id: 'org_00000000-0000-4000-8000-000000000001',
        enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
        installation_id: 'ins_00000000-0000-4000-8000-000000000001',
        installation_signing_key: key.descriptor,
        previous_access_state_sha256:
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        requested_at: '2026-07-22T12:00:00.000Z',
      },
      (bytes) => key.sign(bytes),
    );

    expect(
      verifyOrganizationAccessLeaseRequest(request, key.descriptor),
    ).toEqual(request);
    expect(
      organizationAccessLeaseRequestSha256(request, key.descriptor),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(() =>
      verifyOrganizationAccessLeaseRequest(
        {
          ...request,
          previous_access_state_sha256:
            'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
        key.descriptor,
      ),
    ).toThrow('payload digest');
  });

  it('rejects non-exact request shapes before authentication', async () => {
    const key = installationKey();
    const request = await createOrganizationAccessLeaseRequest(
      {
        request_id: 'alr_00000000-0000-4000-8000-000000000002',
        authority_id: 'oau_00000000-0000-4000-8000-000000000001',
        authority_key_id:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        organization_id: 'org_00000000-0000-4000-8000-000000000001',
        enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
        installation_id: 'ins_00000000-0000-4000-8000-000000000001',
        installation_signing_key: key.descriptor,
        previous_access_state_sha256:
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        requested_at: '2026-07-22T12:00:00.000Z',
      },
      (bytes) => key.sign(bytes),
    );
    expect(() =>
      validateOrganizationAccessLeaseRequest({ ...request, extra: true }),
    ).toThrow('unexpected shape');
  });
});

describe('organization API response envelopes', () => {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;

  function responseFixture() {
    const authorityKey = installationKey().descriptor;
    const authorityDescriptor = {
      schema_version: 1 as const,
      kind: 'echo-organization-authority' as const,
      authority_id: 'oau_00000000-0000-4000-8000-000000000001',
      organization_id: 'org_00000000-0000-4000-8000-000000000001',
      signing_key: authorityKey,
    };
    const integrity = {
      canonicalization: 'RFC8785' as const,
      payload_sha256: digest('a'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s' as const,
      key_id: authorityKey.key_id,
      signature_base64: 'AAAAAAAAAAA=',
    };
    const enrollmentReceipt = {
      schema_version: 1 as const,
      kind: 'echo-organization-enrollment-receipt' as const,
      enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
      authority_id: authorityDescriptor.authority_id,
      authority_key_id: authorityKey.key_id,
      organization_id: authorityDescriptor.organization_id,
      principal_id: 'prn_00000000-0000-4000-8000-000000000001',
      membership_id: 'mem_00000000-0000-4000-8000-000000000001',
      membership_type: 'employee' as const,
      installation_id: 'ins_00000000-0000-4000-8000-000000000001',
      installation_key_id: digest('b'),
      request_sha256: digest('c'),
      enrolled_at: '2026-07-22T12:00:00.000Z',
      integrity,
    };
    const accessState = {
      schema_version: 1 as const,
      kind: 'echo-organization-installation-access-state' as const,
      authority_id: authorityDescriptor.authority_id,
      authority_key_id: authorityKey.key_id,
      organization_id: authorityDescriptor.organization_id,
      enrollment_id: enrollmentReceipt.enrollment_id,
      enrollment_receipt_sha256: digest('d'),
      principal_id: enrollmentReceipt.principal_id,
      membership_id: enrollmentReceipt.membership_id,
      membership_type: enrollmentReceipt.membership_type,
      installation_id: enrollmentReceipt.installation_id,
      installation_key_id: enrollmentReceipt.installation_key_id,
      access_state_sequence: 1,
      status: 'active' as const,
      revocation_reason: null,
      evaluated_at: '2026-07-22T12:00:01.000Z',
      valid_until: '2026-07-22T12:05:01.000Z',
      integrity,
    };
    return { authorityDescriptor, enrollmentReceipt, accessState };
  }

  it('validates exact public envelopes through protocol-owned inner validators', () => {
    const fixture = responseFixture();

    expect(
      validateOrganizationAuthorityDescriptorResponse({
        authority_descriptor: fixture.authorityDescriptor,
      }),
    ).toEqual({ authority_descriptor: fixture.authorityDescriptor });
    expect(
      validateCompletedOrganizationEnrollment({
        enrollment_receipt: fixture.enrollmentReceipt,
        access_state: fixture.accessState,
      }),
    ).toEqual({
      enrollment_receipt: fixture.enrollmentReceipt,
      access_state: fixture.accessState,
    });
    expect(
      validateOrganizationAccessLeaseResponse({
        access_state: fixture.accessState,
      }),
    ).toEqual({ access_state: fixture.accessState });
    expect(
      validateOrganizationApiError({
        error: { code: 'conflict', message: 'state advanced' },
      }),
    ).toEqual({
      error: { code: 'conflict', message: 'state advanced' },
    });

    expect(() =>
      validateOrganizationAuthorityDescriptorResponse({
        authority_descriptor: fixture.authorityDescriptor,
        extra: true,
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      validateCompletedOrganizationEnrollment({
        enrollment_receipt: fixture.enrollmentReceipt,
        access_state: { ...fixture.accessState, extra: true },
      }),
    ).toThrow('access_state is invalid');
    expect(() =>
      validateOrganizationApiError({
        error: {
          code: 'conflict',
          message: 'state advanced',
          extra: true,
        },
      }),
    ).toThrow('unexpected shape');
  });

  it('validates the admin response DTOs without owning durable documents', () => {
    const fixture = responseFixture();
    const membership = {
      organization_id: fixture.authorityDescriptor.organization_id,
      principal_id: fixture.enrollmentReceipt.principal_id,
      membership_id: fixture.enrollmentReceipt.membership_id,
      display_name: 'Example Employee',
      membership_type: 'employee' as const,
      status: 'revoked' as const,
      provisioned_at: '2026-07-22T11:00:00.000Z',
      revoked_at: '2026-07-22T13:00:00.000Z',
    };
    const revokedAccessState = {
      ...fixture.accessState,
      status: 'revoked' as const,
      revocation_reason: 'membership_revoked' as const,
      valid_until: null,
    };
    const installation = {
      installation_id: fixture.enrollmentReceipt.installation_id,
      access_state: revokedAccessState,
    };

    expect(validateProvisionedOrganizationMembership(membership)).toEqual(
      membership,
    );
    expect(
      validateIssuedOrganizationEnrollmentGrant({
        authority_id: fixture.authorityDescriptor.authority_id,
        authority_pin_sha256: digest('e'),
        organization_id: fixture.authorityDescriptor.organization_id,
        principal_id: fixture.enrollmentReceipt.principal_id,
        membership_id: fixture.enrollmentReceipt.membership_id,
        enrollment_grant_sha256: digest('f'),
        issued_at: '2026-07-22T11:00:00.000Z',
        expires_at: '2026-07-22T12:00:00.000Z',
      }),
    ).toMatchObject({ authority_id: fixture.authorityDescriptor.authority_id });
    expect(validateRevokedOrganizationInstallation(installation)).toEqual(
      installation,
    );
    expect(
      validateRevokedOrganizationMembership({
        membership,
        installations: [installation],
      }),
    ).toEqual({ membership, installations: [installation] });
  });

  it('rejects noncanonical grants and semantically inconsistent revocation responses', () => {
    const fixture = responseFixture();
    const membership = {
      organization_id: fixture.authorityDescriptor.organization_id,
      principal_id: fixture.enrollmentReceipt.principal_id,
      membership_id: fixture.enrollmentReceipt.membership_id,
      display_name: 'Example Employee',
      membership_type: 'employee' as const,
      status: 'revoked' as const,
      provisioned_at: '2026-07-22T11:00:00.000Z',
      revoked_at: '2026-07-22T13:00:00.000Z',
    };
    const revokedAccessState = {
      ...fixture.accessState,
      status: 'revoked' as const,
      revocation_reason: 'membership_revoked' as const,
      valid_until: null,
    };
    const grant = {
      authority_id: fixture.authorityDescriptor.authority_id,
      authority_pin_sha256: digest('e'),
      organization_id: fixture.authorityDescriptor.organization_id,
      principal_id: fixture.enrollmentReceipt.principal_id,
      membership_id: fixture.enrollmentReceipt.membership_id,
      enrollment_grant_sha256: `sha256:${'A'.repeat(64)}`,
      issued_at: '2026-07-22T11:00:00.000Z',
      expires_at: '2026-07-22T12:00:00.000Z',
    };

    expect(() => validateIssuedOrganizationEnrollmentGrant(grant)).toThrow(
      'canonical SHA-256 digest',
    );
    expect(() =>
      validateRevokedOrganizationInstallation({
        installation_id: fixture.accessState.installation_id,
        access_state: fixture.accessState,
      }),
    ).toThrow('must contain a revoked access state');

    for (const mismatch of [
      { organization_id: 'org_00000000-0000-4000-8000-000000000002' },
      { principal_id: 'prn_00000000-0000-4000-8000-000000000002' },
      { membership_id: 'mem_00000000-0000-4000-8000-000000000002' },
      { membership_type: 'owner' as const },
    ]) {
      expect(() =>
        validateRevokedOrganizationMembership({
          membership,
          installations: [
            {
              installation_id: revokedAccessState.installation_id,
              access_state: { ...revokedAccessState, ...mismatch },
            },
          ],
        }),
      ).toThrow('belongs to another membership');
    }
  });
});
