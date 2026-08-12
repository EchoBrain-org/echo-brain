import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_API_READABLE_SEARCH_PATH,
  ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS,
  ORGANIZATION_READABLE_SEARCH_CONTRACT_ID,
  RESTRICTED_REVIEWER_READABLE_SEARCH_WITNESS,
  canonicalOrganizationReadableSearchRequestBytes,
  createOrganizationReadableSearchRequest,
  organizationReadableSearchRequestSha256,
  validateOrganizationReadableSearchRequest,
  validateOrganizationReadableSearchResponse,
  verifyOrganizationReadableSearchRequest,
} from '../src/index.js';

function key(): {
  descriptor: P256SigningKeyDescriptor;
  sign(bytes: Buffer): Promise<Buffer>;
} {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('key export failed');
  return {
    descriptor: {
      key_id: p256KeyId(publicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKey.toString('base64'),
    },
    async sign(bytes: Buffer): Promise<Buffer> {
      return normalizeP256LowS(
        signMessage('sha256', bytes, { key: pair.privateKey, dsaEncoding: 'der' }),
      );
    },
  };
}

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

describe('organization readable search contract', () => {
  it('creates, validates, verifies, and hashes the exact signed target-free request', async () => {
    const installation = key();
    const request = await createOrganizationReadableSearchRequest(
      {
        request_id: 'osq_00000000-0000-4000-8000-000000000001',
        authority_id: 'oau_00000000-0000-4000-8000-000000000001',
        authority_key_id: digest('a'),
        organization_id: 'org_00000000-0000-4000-8000-000000000001',
        enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
        installation_id: 'ins_00000000-0000-4000-8000-000000000001',
        installation_signing_key: installation.descriptor,
        query: 'Launch pricing',
        requested_at: '2026-08-12T08:00:00.000Z',
      },
      (bytes) => installation.sign(bytes),
    );
    expect(request.http_path).toBe(ORGANIZATION_API_READABLE_SEARCH_PATH);
    expect(validateOrganizationReadableSearchRequest(request)).toEqual(request);
    expect(
      Buffer.from(canonicalOrganizationReadableSearchRequestBytes(request)).toString(
        'utf8',
      ),
    ).toBe(canonicalJson(request));
    expect(() =>
      canonicalOrganizationReadableSearchRequestBytes({ ...request, extra: true }),
    ).toThrow('unexpected shape');
    expect(
      verifyOrganizationReadableSearchRequest(request, installation.descriptor),
    ).toEqual(request);
    expect(
      organizationReadableSearchRequestSha256(request, installation.descriptor),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      validateOrganizationReadableSearchRequest({ ...request, policy_id: 'all' }),
    ).toThrow('unexpected shape');
  });

  it.each([
    '',
    ' leading',
    'trailing ',
    'line\nbreak',
    'e\u0301',
    'x'.repeat(241),
    '---',
    Array.from({ length: 17 }, (_value, index) => `term${index}`).join(' '),
    `a${'界'.repeat(22)}`,
  ])('rejects invalid query %j', (query) => {
    const installation = key();
    return expect(
      createOrganizationReadableSearchRequest(
        {
          request_id: 'osq_00000000-0000-4000-8000-000000000001',
          authority_id: 'oau_00000000-0000-4000-8000-000000000001',
          authority_key_id: digest('a'),
          organization_id: 'org_00000000-0000-4000-8000-000000000001',
          enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
          installation_id: 'ins_00000000-0000-4000-8000-000000000001',
          installation_signing_key: installation.descriptor,
          query,
          requested_at: '2026-08-12T08:00:00.000Z',
        },
        (bytes) => installation.sign(bytes),
      ),
    ).rejects.toThrow('query');
  });

  it('accepts only the closed two-policy response with exact witnesses', () => {
    const response = {
      schema_version: 1,
      contract_id: ORGANIZATION_READABLE_SEARCH_CONTRACT_ID,
      items: [
        {
          kind: 'decision',
          text: 'Ship the lexical reader.',
          policy_id: 'organization-member-readable-v1',
          witness: ORGANIZATION_MEMBER_READABLE_SEARCH_WITNESS,
        },
        {
          kind: 'rationale',
          text: 'The exact reviewer accepted it.',
          policy_id: 'restricted-reviewer-v1',
          witness: RESTRICTED_REVIEWER_READABLE_SEARCH_WITNESS,
        },
      ],
    };
    expect(validateOrganizationReadableSearchResponse(response)).toEqual(response);
    expect(() =>
      validateOrganizationReadableSearchResponse({
        ...response,
        items: [{ ...response.items[0], score: 2 }],
      }),
    ).toThrow('unexpected shape');
    expect(() =>
      validateOrganizationReadableSearchResponse({
        ...response,
        items: [{ ...response.items[0], witness: 'trust me' }],
      }),
    ).toThrow('policy or witness');
  });
});
