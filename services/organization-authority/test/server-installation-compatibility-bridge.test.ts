import {
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  p256KeyId,
  type InstallationKeyDescriptor,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  verifyOrganizationMemberReadablePermissionCheckRequest,
  verifyOrganizationPermissionCheckRequest,
  type OrganizationMemberReadablePermissionCheckDecisionV3,
  type OrganizationMemberReadablePermissionCheckRequestV3,
  type OrganizationPermissionCheckDecisionV1,
  type OrganizationPermissionCheckRequestV1,
} from '@echo-brain/organization-api';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import type {
  AuthorityReadTransaction,
  OrganizationAuthorityRepository,
  StoredAuthorityAccessState,
  StoredAuthorityEnrollment,
  StoredAuthorityMetadata,
} from '../src/application/ports/authority-repository.js';
import type {
  ApprovalActionAuthorizationRequest,
  OrganizationMemberApprovalActionAuthorizationRequest,
} from '../src/processing/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { validateOrganizationMemberAuthorizationEvidence } from '../src/processing/authorization/organization-member-authorization-evidence.js';
import {
  ServerInstallationCompatibilityBridge,
  type OrganizationMemberPermissionCheckPort,
} from '../src/processing/authorization/server-installation-compatibility-bridge.js';

const NOW = '2026-08-19T20:00:00.000Z';
const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  enrollment: 'enr_00000000-0000-4000-8000-000000000001',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  binding: 'bnd_00000000-0000-4000-8000-000000000001',
  grant: 'pgr_00000000-0000-4000-8000-000000000001',
  audit: 'aud_00000000-0000-4000-8000-000000000001',
  request: 'pcr_00000000-0000-4000-8000-000000000001',
} as const;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

interface TestKey {
  descriptor: P256SigningKeyDescriptor;
  privateKey: KeyObject;
}

function testKey(): TestKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('test key export failed');
  return {
    descriptor: {
      key_id: p256KeyId(publicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKey.toString('base64'),
    },
    privateKey: pair.privateKey,
  };
}

function keyStateFile(): {
  path: string;
  descriptor: InstallationKeyDescriptor;
} {
  const directory = mkdtempSync(join(tmpdir(), 'echo-server-installation-'));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const key = testKey();
  const descriptor: InstallationKeyDescriptor = {
    installation_id: IDS.installation,
    ...key.descriptor,
    protection: 'development-file',
    assurance: 'software_key_development_only',
    private_key_exportable: true,
  };
  const privateKey = key.privateKey.export({ format: 'der', type: 'pkcs8' });
  if (!Buffer.isBuffer(privateKey)) throw new Error('private key export failed');
  const path = join(directory, `${IDS.installation}.key-state.v1.json`);
  writeFileSync(
    path,
    canonicalJson({
      schema_version: 1,
      descriptor,
      private_key_pkcs8_der_base64: privateKey.toString('base64'),
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return { path, descriptor };
}

function protocolKey(
  descriptor: InstallationKeyDescriptor,
): P256SigningKeyDescriptor {
  return {
    key_id: descriptor.key_id,
    algorithm: descriptor.algorithm,
    public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
  };
}

function authorityState(
  installationKey: InstallationKeyDescriptor,
): {
  metadata: StoredAuthorityMetadata;
  enrollment: StoredAuthorityEnrollment;
  access: StoredAuthorityAccessState;
} {
  const authorityKey = testKey().descriptor;
  const metadata = {
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    organization_display_name: 'Example Company',
    authority_pin_sha256: digest('1'),
    descriptor: {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      signing_key: authorityKey,
    },
    created_at: '2026-08-19T19:00:00.000Z',
    last_observed_at: NOW,
  } as StoredAuthorityMetadata;
  const enrollment = {
    enrollment_id: IDS.enrollment,
    grant_sha256: digest('2'),
    request_sha256: digest('3'),
    request: {},
    receipt_sha256: digest('4'),
    receipt: {},
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    membership_type: 'employee',
    installation_id: IDS.installation,
    installation_signing_key: protocolKey(installationKey),
    status: 'active',
    enrolled_at: '2026-08-19T19:00:00.000Z',
    revoked_at: null,
    revocation_kind: null,
    revocation_reason: null,
  } as StoredAuthorityEnrollment;
  const access = {
    enrollment_id: IDS.enrollment,
    state_sha256: digest('5'),
    state: {
      schema_version: 1,
      kind: 'echo-organization-installation-access-state',
      authority_id: IDS.authority,
      authority_key_id: authorityKey.key_id,
      organization_id: IDS.organization,
      enrollment_id: IDS.enrollment,
      enrollment_receipt_sha256: enrollment.receipt_sha256,
      principal_id: IDS.principal,
      membership_id: IDS.membership,
      membership_type: 'employee',
      installation_id: IDS.installation,
      installation_key_id: installationKey.key_id,
      access_state_sequence: 1,
      status: 'active',
      revocation_reason: null,
      evaluated_at: '2026-08-19T19:00:00.000Z',
      valid_until: '2026-08-19T20:05:00.000Z',
      integrity: {},
    },
  } as StoredAuthorityAccessState;
  return { metadata, enrollment, access };
}

class MutableAuthorityReader
  implements Pick<OrganizationAuthorityRepository, 'read'>
{
  reads = 0;

  constructor(
    readonly metadata: StoredAuthorityMetadata,
    readonly enrollment: StoredAuthorityEnrollment,
    public access: StoredAuthorityAccessState | undefined,
  ) {}

  read<T>(operation: (transaction: AuthorityReadTransaction) => T): T {
    this.reads += 1;
    return operation({
      metadata: () => this.metadata,
      enrollmentByInstallation: (installationId: string) =>
        installationId === this.enrollment.installation_id
          ? this.enrollment
          : undefined,
      currentAccessState: (enrollmentId: string) =>
        enrollmentId === this.enrollment.enrollment_id
          ? this.access
          : undefined,
    } as AuthorityReadTransaction);
  }
}

function ordinaryInput(): ApprovalActionAuthorizationRequest {
  return {
    approval_id: 'f'.repeat(64),
    action: 'reject',
    adapter_identity: {
      kind: 'approval-surface',
      adapter_id: 'slack-reactions',
      instance_id: 'primary',
      version: '1.0.0',
    },
    provider_identity: {
      provider: 'slack',
      team_id: 'T123TEAM',
      enterprise_id: null,
      bot_user_id: 'U123BOT',
      bot_id: 'B123BOT',
      app_id: 'A123APP',
    },
    actor: {
      provider: 'slack',
      team_id: 'T123TEAM',
      user_id: 'U123USER',
    },
    channel_id: 'C123CHANNEL',
    message_ts: '1753822800.000001',
    reaction_name: 'x',
  };
}

function memberInput(): OrganizationMemberApprovalActionAuthorizationRequest {
  const ordinary = ordinaryInput();
  return {
    approval_id: ordinary.approval_id,
    adapter_identity: ordinary.adapter_identity,
    provider_identity: ordinary.provider_identity,
    actor: ordinary.actor,
    channel_id: ordinary.channel_id,
    message_ts: ordinary.message_ts,
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256:
      organizationMemberReadablePolicyContractSha256(),
    release_draft_sha256: digest('d'),
    approval_presentation_sha256: digest('e'),
  };
}

function memberAllow(
  request: OrganizationMemberReadablePermissionCheckRequestV3,
): OrganizationMemberReadablePermissionCheckDecisionV3 {
  return {
    schema_version: 3,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: canonicalSha256(request),
    provider_event_sha256: request.provider_event_sha256,
    allowed: true,
    reason_code: 'active_organization_member_readable_notice_v1',
    policy_id: request.policy_id,
    policy_contract_sha256: request.policy_contract_sha256,
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: NOW,
    authorization_audit_event_id: IDS.audit,
    authorization_audit_entry_sha256: digest('a'),
    release_draft_sha256: request.release_draft_sha256,
    approval_presentation_sha256: request.approval_presentation_sha256,
    semantic_intent_sha256: digest('b'),
    message_presentation_sha256: digest('c'),
  };
}

function ordinaryAllow(
  request: OrganizationPermissionCheckRequestV1,
): OrganizationPermissionCheckDecisionV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: canonicalSha256(request),
    provider_event_sha256: request.provider_event_sha256,
    allowed: true,
    reason_code: 'active_membership_and_direct_grant',
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: NOW,
  };
}

function bridgeFixture(options: {
  access?: StoredAuthorityAccessState;
  port?: Partial<OrganizationMemberPermissionCheckPort>;
} = {}) {
  const installation = keyStateFile();
  const state = authorityState(installation.descriptor);
  const repository = new MutableAuthorityReader(
    state.metadata,
    state.enrollment,
    options.access ?? state.access,
  );
  const port: OrganizationMemberPermissionCheckPort = {
    checkPermission: async (request) => ordinaryAllow(request),
    checkOrganizationMemberReadablePermission: async (request) =>
      memberAllow(request),
    ...options.port,
  };
  return { installation, state, repository, port };
}

describe('server installation compatibility bridge', () => {
  it('signs a fresh schema-v3 request and returns validated frozen evidence', async () => {
    let observed: OrganizationMemberReadablePermissionCheckRequestV3 | undefined;
    const cancellation = new AbortController();
    const fixture = bridgeFixture({
      port: {
        checkOrganizationMemberReadablePermission: async (request, signal) => {
          expect(signal).toBe(cancellation.signal);
          observed = verifyOrganizationMemberReadablePermissionCheckRequest(
            request,
            protocolKey(fixture.installation.descriptor),
          );
          return memberAllow(request);
        },
      },
    });
    const bridge = new ServerInstallationCompatibilityBridge({
      authorityRepository: fixture.repository,
      keyStatePath: fixture.installation.path,
      permissionCheck: fixture.port,
      now: () => NOW,
      nextRequestId: () => IDS.request,
    });

    const result = await bridge.authorizeOrganizationMemberApproval(
      memberInput(),
      cancellation.signal,
    );

    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('member allow expected');
    expect(
      validateOrganizationMemberAuthorizationEvidence(result.evidence),
    ).toEqual(result.evidence);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(observed).toMatchObject({
      schema_version: 3,
      request_id: IDS.request,
      enrollment_id: IDS.enrollment,
      installation_id: IDS.installation,
      approval_id: 'f'.repeat(64),
      reaction_name: 'white_check_mark',
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
    });
    expect(fixture.repository.reads).toBe(1);
  });

  it('implements the ordinary V1 rejection authorization required by Slack', async () => {
    let observed: OrganizationPermissionCheckRequestV1 | undefined;
    const fixture = bridgeFixture({
      port: {
        checkPermission: async (request) => {
          observed = verifyOrganizationPermissionCheckRequest(
            request,
            protocolKey(fixture.installation.descriptor),
          );
          return ordinaryAllow(request);
        },
      },
    });
    const bridge = new ServerInstallationCompatibilityBridge({
      authorityRepository: fixture.repository,
      keyStatePath: fixture.installation.path,
      permissionCheck: fixture.port,
      now: () => NOW,
      nextRequestId: () => IDS.request,
    });

    const result = await bridge.authorize(ordinaryInput());

    expect(result).toMatchObject({
      allowed: true,
      evidence: {
        schema_version: 1,
        action: 'reject',
        request_id: IDS.request,
        enrollment_id: IDS.enrollment,
        principal_id: IDS.principal,
        membership_id: IDS.membership,
      },
    });
    expect(observed).toMatchObject({
      schema_version: 1,
      action: 'reject',
      reaction_name: 'x',
    });
  });

  it('invokes the refresh hook once and rereads Authority access', async () => {
    const fixture = bridgeFixture();
    fixture.repository.access = {
      ...fixture.state.access,
      state: {
        ...fixture.state.access.state,
        valid_until: '2026-08-19T19:59:59.999Z',
      },
    } as StoredAuthorityAccessState;
    let refreshes = 0;
    const bridge = new ServerInstallationCompatibilityBridge({
      authorityRepository: fixture.repository,
      keyStatePath: fixture.installation.path,
      permissionCheck: fixture.port,
      now: () => NOW,
      nextRequestId: () => IDS.request,
      accessRefresh: {
        refreshInstallationAccess: async (input) => {
          refreshes += 1;
          expect(input).toEqual({
            installation_id: IDS.installation,
            enrollment_id: IDS.enrollment,
            current_access_state_sha256: fixture.state.access.state_sha256,
            requested_at: NOW,
          });
          fixture.repository.access = {
            ...fixture.state.access,
            state_sha256: digest('6'),
            state: {
              ...fixture.state.access.state,
              access_state_sequence: 2,
              valid_until: '2026-08-19T20:10:00.000Z',
            },
          } as StoredAuthorityAccessState;
        },
      },
    });

    await expect(
      bridge.authorizeOrganizationMemberApproval(memberInput()),
    ).resolves.toMatchObject({ allowed: true });
    expect(refreshes).toBe(1);
    expect(fixture.repository.reads).toBe(2);
  });

  it('fails closed on revoked access without invoking refresh or permission', async () => {
    const fixture = bridgeFixture();
    fixture.repository.access = {
      ...fixture.state.access,
      state: {
        ...fixture.state.access.state,
        status: 'revoked',
        revocation_reason: 'installation_revoked',
        valid_until: null,
      },
    } as StoredAuthorityAccessState;
    let refreshes = 0;
    let checks = 0;
    const bridge = new ServerInstallationCompatibilityBridge({
      authorityRepository: fixture.repository,
      keyStatePath: fixture.installation.path,
      permissionCheck: {
        checkPermission: async (request) => {
          checks += 1;
          return ordinaryAllow(request);
        },
        checkOrganizationMemberReadablePermission: async (request) => {
          checks += 1;
          return memberAllow(request);
        },
      },
      now: () => NOW,
      accessRefresh: {
        refreshInstallationAccess: async () => {
          refreshes += 1;
        },
      },
    });

    await expect(
      bridge.authorizeOrganizationMemberApproval(memberInput()),
    ).rejects.toThrow('server installation access is revoked');
    expect(refreshes).toBe(0);
    expect(checks).toBe(0);
  });

  it('refuses a key-state file that is not mode 0600', async () => {
    const fixture = bridgeFixture();
    chmodSync(fixture.installation.path, 0o644);
    const bridge = new ServerInstallationCompatibilityBridge({
      authorityRepository: fixture.repository,
      keyStatePath: fixture.installation.path,
      permissionCheck: fixture.port,
      now: () => NOW,
    });

    await expect(bridge.authorize(ordinaryInput())).rejects.toThrow(
      'key state must have mode 0600',
    );
    expect(fixture.repository.reads).toBe(0);
  });
});
