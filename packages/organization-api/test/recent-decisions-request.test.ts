import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  MAX_ORGANIZATION_RECENT_DECISIONS_ITEMS,
  ORGANIZATION_API_RECENT_DECISIONS_PATH,
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
  createOrganizationRecentDecisionsRequest,
  organizationRecentDecisionsRequestSha256,
  validateOrganizationRecentDecisionsRequest,
  validateOrganizationRecentDecisionsResponse,
  verifyOrganizationRecentDecisionsRequest,
  type CreateOrganizationRecentDecisionsRequestInput,
  type OrganizationRecentDecisionKindV1,
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

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

function requestInput(
  key: P256SigningKeyDescriptor,
): CreateOrganizationRecentDecisionsRequestInput {
  return {
    request_id: 'rdr_00000000-0000-4000-8000-000000000001',
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    authority_key_id: digest('a'),
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    installation_signing_key: key,
    requested_at: '2026-08-10T12:00:00.000Z',
  };
}

function responseItem(
  index: number,
  kind: OrganizationRecentDecisionKindV1 = 'decision',
) {
  const hex = index.toString(16).padStart(64, '0');
  return {
    atom_id: `sha256:${hex}`,
    kind,
    text: `Approved signal ${index}`,
    record_hash: digest('f'),
  };
}

function response(items: unknown[]) {
  return {
    schema_version: 1,
    policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
    witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
    items,
  };
}

describe('organization recent decisions contract', () => {
  it('creates, validates, verifies, and hashes the exact signed operation', async () => {
    const key = installationKey();
    const request = await createOrganizationRecentDecisionsRequest(
      requestInput(key.descriptor),
      (bytes) => key.sign(bytes),
    );

    expect(request).toMatchObject({
      kind: 'echo-organization-recent-decisions-request',
      http_method: 'POST',
      http_path: ORGANIZATION_API_RECENT_DECISIONS_PATH,
    });
    expect(validateOrganizationRecentDecisionsRequest(request)).toEqual(
      request,
    );
    expect(
      verifyOrganizationRecentDecisionsRequest(request, key.descriptor),
    ).toEqual(request);
    expect(
      organizationRecentDecisionsRequestSha256(request, key.descriptor),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(() =>
      validateOrganizationRecentDecisionsRequest({
        ...request,
        http_path: '/v1/other',
      }),
    ).toThrow('HTTP operation is unsupported');
    expect(() =>
      verifyOrganizationRecentDecisionsRequest(
        {
          ...request,
          request_id: 'rdr_00000000-0000-4000-8000-000000000002',
        },
        key.descriptor,
      ),
    ).toThrow('payload digest does not match');
    expect(() =>
      validateOrganizationRecentDecisionsRequest({ ...request, limit: 10 }),
    ).toThrow('unexpected shape');
  });

  it('accepts only the closed empty or bounded atom response', () => {
    expect(validateOrganizationRecentDecisionsResponse(response([]))).toEqual(
      response([]),
    );
    const items = [
      responseItem(1, 'decision'),
      responseItem(2, 'action'),
      responseItem(3, 'rationale'),
    ];
    expect(
      validateOrganizationRecentDecisionsResponse(response(items)),
    ).toEqual(response(items));

    expect(() =>
      validateOrganizationRecentDecisionsResponse({
        ...response(items),
        cursor: 'hidden',
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationRecentDecisionsResponse(
        response([{ ...responseItem(1), log_position: 7 }]),
      ),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationRecentDecisionsResponse(
        response([{ ...responseItem(1), kind: 'summary' }]),
      ),
    ).toThrow('kind is unsupported');
    expect(() =>
      validateOrganizationRecentDecisionsResponse({
        ...response(items),
        witness: 'trust me',
      }),
    ).toThrow('policy, or witness is unsupported');
  });

  it('rejects repeated, over-count, and over-byte responses', () => {
    expect(() =>
      validateOrganizationRecentDecisionsResponse(
        response([responseItem(1), responseItem(1)]),
      ),
    ).toThrow('repeats an atom_id');
    expect(() =>
      validateOrganizationRecentDecisionsResponse(
        response(
          Array.from(
            { length: MAX_ORGANIZATION_RECENT_DECISIONS_ITEMS + 1 },
            (_, index) => responseItem(index + 1),
          ),
        ),
      ),
    ).toThrow('maximum item count');
    expect(() =>
      validateOrganizationRecentDecisionsResponse(
        response([{ ...responseItem(1), text: 'x'.repeat(61 * 1024) }]),
      ),
    ).toThrow('canonical byte limit');
  });
});
