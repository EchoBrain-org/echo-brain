import { Buffer } from 'node:buffer';
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationSlackLinkBeginRequest,
  createOrganizationSlackLinkCompleteRequest,
  ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH,
  organizationSlackLinkBeginRequestSha256,
  organizationSlackLinkChallengeCodeSha256,
  organizationSlackLinkCompleteRequestSha256,
  validateOrganizationSlackLinkBeginRequest,
  validateOrganizationSlackLinkBeginResponse,
  validateOrganizationSlackLinkCompleteRequest,
  validateOrganizationSlackLinkResult,
  verifyOrganizationSlackLinkBeginRequest,
  verifyOrganizationSlackLinkCompleteRequest,
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

const authorityIdentity = {
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  authority_key_id: digest('a'),
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
  installation_id: 'ins_00000000-0000-4000-8000-000000000001',
};

describe('organization Slack identity-link requests', () => {
  it('creates, verifies, hashes, and strictly validates a begin request', async () => {
    const key = installationKey();
    const request = await createOrganizationSlackLinkBeginRequest(
      {
        request_id: 'slb_00000000-0000-4000-8000-000000000001',
        ...authorityIdentity,
        installation_signing_key: key.descriptor,
        challenge_code_sha256: digest('b'),
        requested_at: '2026-07-30T12:00:00.000Z',
      },
      (bytes) => key.sign(bytes),
    );

    expect(validateOrganizationSlackLinkBeginRequest(request)).toEqual(request);
    expect(
      verifyOrganizationSlackLinkBeginRequest(request, key.descriptor),
    ).toEqual(request);
    expect(
      organizationSlackLinkBeginRequestSha256(request, key.descriptor),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      verifyOrganizationSlackLinkBeginRequest(
        { ...request, challenge_code_sha256: digest('c') },
        key.descriptor,
      ),
    ).toThrow('payload digest does not match');
    expect(() =>
      validateOrganizationSlackLinkBeginRequest({ ...request, extra: true }),
    ).toThrow('unexpected shape');
  });

  it('binds a complete request to one canonical raw-byte challenge and adapter', async () => {
    const key = installationKey();
    const challengeBytes = Buffer.alloc(32, 0xab);
    const challengeCode = challengeBytes.toString('base64url');
    const request = await createOrganizationSlackLinkCompleteRequest(
      {
        request_id: 'slc_00000000-0000-4000-8000-000000000001',
        ...authorityIdentity,
        installation_signing_key: key.descriptor,
        challenge_attempt_id:
          'cat_00000000-0000-4000-8000-000000000001',
        challenge_message_ts: '1721678400.123456',
        challenge_code: challengeCode,
        expected_provider_subject_id: 'W12345678',
        adapter_id: 'slack-reactions',
        adapter_instance_id: 'primary',
        adapter_version: '1.0.0',
        requested_at: '2026-07-30T12:01:00.000Z',
      },
      (bytes) => key.sign(bytes),
    );

    expect(validateOrganizationSlackLinkCompleteRequest(request)).toEqual(
      request,
    );
    expect(
      verifyOrganizationSlackLinkCompleteRequest(request, key.descriptor),
    ).toEqual(request);
    expect(
      organizationSlackLinkCompleteRequestSha256(request, key.descriptor),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(organizationSlackLinkChallengeCodeSha256(challengeCode)).toBe(
      `sha256:${createHash('sha256').update(challengeBytes).digest('hex')}`,
    );

    expect(() =>
      organizationSlackLinkChallengeCodeSha256(
        `${challengeCode.slice(0, -1)}B`,
      ),
    ).toThrow('canonical unpadded base64url');
    expect(() =>
      validateOrganizationSlackLinkCompleteRequest({
        ...request,
        adapter_instance_id: 'Primary',
      }),
    ).toThrow('adapter_instance_id');
    expect(() =>
      validateOrganizationSlackLinkCompleteRequest({
        ...request,
        challenge_code: `${challengeCode}=`,
      }),
    ).toThrow('canonical unpadded base64url');
    expect(() =>
      validateOrganizationSlackLinkCompleteRequest({
        ...request,
        expected_provider_subject_id: 'X12345678',
      }),
    ).toThrow('expected_provider_subject_id');
  });

  it('validates exact begin/result responses and guarantees linking grants nothing', () => {
    expect(ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH).toBe(
      '/v1/integration-links/slack/challenges',
    );
    expect(ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH).toBe(
      '/v1/integration-links/slack/completions',
    );

    const beginResponse = {
      schema_version: 1 as const,
      kind: 'echo-organization-slack-link-begin-response' as const,
      challenge_attempt_id:
        'cat_00000000-0000-4000-8000-000000000001',
      provider: 'slack' as const,
      provider_tenant_id: 'T12345678',
      channel_id: 'C12345678',
      challenge_message_ts: '1721678400.123456',
      expires_at: '2026-07-30T12:05:00.000Z',
    };
    expect(validateOrganizationSlackLinkBeginResponse(beginResponse)).toEqual(
      beginResponse,
    );

    const result = {
      schema_version: 1 as const,
      kind: 'echo-organization-slack-link-result' as const,
      identity_link_id: 'clm_00000000-0000-4000-8000-000000000001',
      connection_id: 'con_00000000-0000-4000-8000-000000000001',
      adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
      organization_id: authorityIdentity.organization_id,
      principal_id: 'prn_00000000-0000-4000-8000-000000000001',
      membership_id: 'mem_00000000-0000-4000-8000-000000000001',
      installation_id: authorityIdentity.installation_id,
      provider: 'slack' as const,
      provider_tenant_id: 'T12345678',
      provider_subject_id: 'W12345678',
      channel_id: 'C12345678',
      linked_at: '2026-07-30T12:02:00.000Z',
      identity_link_created: true,
      adapter_binding_created: true,
      permission_grants_created: 0 as const,
    };
    expect(validateOrganizationSlackLinkResult(result)).toEqual(result);
    expect(() =>
      validateOrganizationSlackLinkResult({
        ...result,
        provider_subject_id: 'X12345678',
      }),
    ).toThrow('provider_subject_id');
    expect(() =>
      validateOrganizationSlackLinkResult({
        ...result,
        permission_grants_created: 1,
      }),
    ).toThrow('must be zero');
    expect(() =>
      validateOrganizationSlackLinkResult({ ...result, extra: true }),
    ).toThrow('unexpected shape');
  });
});
