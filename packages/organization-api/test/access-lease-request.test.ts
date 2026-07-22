import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { normalizeP256LowS, p256KeyId } from '@echo-brain/federation-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  createOrganizationAccessLeaseRequest,
  organizationAccessLeaseRequestSha256,
  validateOrganizationAccessLeaseRequest,
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
