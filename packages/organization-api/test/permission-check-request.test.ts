import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationPermissionCheckRequest,
  organizationPermissionCheckRequestSha256,
  organizationPermissionProviderEventSha256,
  validateOrganizationPermissionCheckDecision,
  validateOrganizationPermissionCheckRequest,
  verifyOrganizationPermissionCheckRequest,
  type CreateOrganizationPermissionCheckRequestInput,
  type OrganizationPermissionProviderEventInput,
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
): CreateOrganizationPermissionCheckRequestInput {
  return {
    request_id: 'pcr_00000000-0000-4000-8000-000000000001',
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    authority_key_id: digest('a'),
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    installation_signing_key: key,
    provider: 'slack',
    provider_issuer: 'https://slack.com',
    provider_tenant_kind: 'workspace',
    provider_tenant_id: 'T12345678',
    provider_enterprise_id: null,
    provider_connection_subject_id: 'U12345679',
    provider_connection_bot_id: 'B12345678',
    provider_connection_app_id: 'A12345678',
    provider_subject_kind: 'human_user',
    provider_subject_id: 'U12345678',
    adapter_kind: 'approval-surface',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'primary',
    adapter_version: '1.0.0',
    action: 'approve',
    approval_id: 'f'.repeat(64),
    channel_id: 'C12345678',
    message_ts: '1721678400.123456',
    reaction_name: 'white_check_mark',
    requested_at: '2026-07-29T12:00:00.000Z',
  };
}

function eventInput(
  input: CreateOrganizationPermissionCheckRequestInput,
): OrganizationPermissionProviderEventInput {
  return {
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    provider: input.provider,
    provider_issuer: input.provider_issuer,
    provider_tenant_kind: input.provider_tenant_kind,
    provider_tenant_id: input.provider_tenant_id,
    provider_enterprise_id: input.provider_enterprise_id,
    provider_connection_subject_id:
      input.provider_connection_subject_id,
    provider_connection_bot_id: input.provider_connection_bot_id,
    provider_connection_app_id: input.provider_connection_app_id,
    provider_subject_kind: input.provider_subject_kind,
    provider_subject_id: input.provider_subject_id,
    adapter_kind: input.adapter_kind,
    adapter_id: input.adapter_id,
    adapter_instance_id: input.adapter_instance_id,
    adapter_version: input.adapter_version,
    action: input.action,
    approval_id: input.approval_id,
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    reaction_name: input.reaction_name,
  };
}

describe('organization permission check request', () => {
  it('creates, validates, verifies, and hashes one exact installation command', async () => {
    const key = installationKey();
    const input = requestInput(key.descriptor);
    const request = await createOrganizationPermissionCheckRequest(
      input,
      (bytes) => key.sign(bytes),
    );

    expect(request.provider_event_sha256).toBe(
      organizationPermissionProviderEventSha256(eventInput(input)),
    );
    expect(validateOrganizationPermissionCheckRequest(request)).toEqual(
      request,
    );
    expect(
      verifyOrganizationPermissionCheckRequest(request, key.descriptor),
    ).toEqual(request);
    expect(
      organizationPermissionCheckRequestSha256(request, key.descriptor),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(() =>
      verifyOrganizationPermissionCheckRequest(
        { ...request, action: 'reject' },
        key.descriptor,
      ),
    ).toThrow('provider_event_sha256 does not match');
    expect(() =>
      verifyOrganizationPermissionCheckRequest(
        {
          ...request,
          request_id: 'pcr_00000000-0000-4000-8000-000000000002',
        },
        key.descriptor,
      ),
    ).toThrow('payload digest does not match');
    expect(() =>
      validateOrganizationPermissionCheckRequest({ ...request, extra: true }),
    ).toThrow('unexpected shape');
  });

  it('accepts Enterprise Grid W IDs for both the Slack bot and human', async () => {
    const key = installationKey();
    const request = await createOrganizationPermissionCheckRequest(
      {
        ...requestInput(key.descriptor),
        provider_connection_subject_id: 'W12345679',
        provider_subject_id: 'W12345678',
      },
      (bytes) => key.sign(bytes),
    );

    expect(validateOrganizationPermissionCheckRequest(request)).toMatchObject({
      provider_connection_subject_id: 'W12345679',
      provider_subject_id: 'W12345678',
    });
  });

  it('derives provider-event identity from event fields, not retry metadata', async () => {
    const key = installationKey();
    const input = requestInput(key.descriptor);
    const first = await createOrganizationPermissionCheckRequest(
      input,
      (bytes) => key.sign(bytes),
    );
    const retry = await createOrganizationPermissionCheckRequest(
      {
        ...input,
        request_id: 'pcr_00000000-0000-4000-8000-000000000002',
        requested_at: '2026-07-29T12:00:01.000Z',
      },
      (bytes) => key.sign(bytes),
    );
    expect(retry.provider_event_sha256).toBe(first.provider_event_sha256);

    const base = eventInput(input);
    const changedEvents: OrganizationPermissionProviderEventInput[] = [
      {
        ...base,
        authority_id: 'oau_00000000-0000-4000-8000-000000000002',
      },
      {
        ...base,
        authority_key_id: digest('b'),
      },
      {
        ...base,
        organization_id: 'org_00000000-0000-4000-8000-000000000002',
      },
      {
        ...base,
        enrollment_id: 'enr_00000000-0000-4000-8000-000000000002',
      },
      {
        ...base,
        installation_id: 'ins_00000000-0000-4000-8000-000000000002',
      },
      {
        ...base,
        installation_key_id: digest('c'),
      },
      {
        ...base,
        provider: 'teams',
      } as unknown as OrganizationPermissionProviderEventInput,
      {
        ...base,
        provider_issuer: 'https://issuer.example.test',
      } as unknown as OrganizationPermissionProviderEventInput,
      {
        ...base,
        provider_tenant_kind: 'organization',
      } as unknown as OrganizationPermissionProviderEventInput,
      { ...base, provider_tenant_id: 'T87654321' },
      { ...base, provider_enterprise_id: 'E12345678' },
      { ...base, provider_connection_subject_id: 'U87654321' },
      { ...base, provider_connection_bot_id: 'B87654321' },
      { ...base, provider_connection_app_id: 'A87654321' },
      {
        ...base,
        provider_subject_kind: 'service_account',
      } as unknown as OrganizationPermissionProviderEventInput,
      { ...base, provider_subject_id: 'U87654321' },
      {
        ...base,
        adapter_kind: 'delivery-surface',
      } as unknown as OrganizationPermissionProviderEventInput,
      { ...base, adapter_id: 'other-approval' },
      { ...base, adapter_instance_id: 'secondary' },
      { ...base, adapter_version: '2.0.0' },
      { ...base, action: 'reject' },
      { ...base, approval_id: 'e'.repeat(64) },
      { ...base, channel_id: 'C87654321' },
      { ...base, message_ts: '1721678401.123456' },
      { ...base, reaction_name: 'x' },
    ];
    for (const changed of changedEvents) {
      expect(organizationPermissionProviderEventSha256(changed)).not.toBe(
        first.provider_event_sha256,
      );
    }
  });

  it('validates exact ephemeral decisions and requires complete allow IDs', () => {
    const decision = {
      schema_version: 1 as const,
      kind: 'echo-organization-permission-check-decision' as const,
      request_sha256: digest('a'),
      provider_event_sha256: digest('b'),
      allowed: true,
      reason_code: 'active_membership_and_direct_grant',
      principal_id: 'prn_00000000-0000-4000-8000-000000000001',
      membership_id: 'mem_00000000-0000-4000-8000-000000000001',
      adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
      permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001',
      evaluated_at: '2026-07-29T12:00:00.000Z',
    };
    expect(validateOrganizationPermissionCheckDecision(decision)).toEqual(
      decision,
    );
    expect(() =>
      validateOrganizationPermissionCheckDecision({
        ...decision,
        permission_grant_id: null,
      }),
    ).toThrow('requires exact authorization IDs');
    expect(
      validateOrganizationPermissionCheckDecision({
        ...decision,
        allowed: false,
        reason_code: 'provider_identity_unlinked',
        principal_id: null,
        membership_id: null,
        adapter_binding_id: null,
        permission_grant_id: null,
      }),
    ).toMatchObject({ allowed: false });
  });
});
