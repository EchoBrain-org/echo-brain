import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApproveOrganizationInternalLiveReleaseRequestV1,
  IssueOrganizationEnrollmentGrantRequestV1,
  IssuedOrganizationEnrollmentGrantV1,
  OrganizationInternalLiveReleaseManifestV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokeOrganizationSubjectRequestV1,
} from '@echo-brain/organization-api';
import { organizationInternalLiveManifestSha256 } from '@echo-brain/organization-api';
import {
  runOrganizationAuthorityAdminCli,
  type OrganizationAdminCliClient,
  type OrganizationAdminCliDependencies,
  type OrganizationAdminCliIo,
} from '../src/composition/admin-cli.js';
import {
  authorityStatePaths,
  createAuthorityRuntimeConfig,
  writeAuthorityRuntimeConfigExclusive,
} from '../src/composition/operator-config.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  targetMembership: 'mem_00000000-0000-4000-8000-000000000002',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  identityLink: 'clm_00000000-0000-4000-8000-000000000001',
  adapterBinding: 'bnd_00000000-0000-4000-8000-000000000001',
  approveGrant: 'pgr_00000000-0000-4000-8000-000000000001',
  rejectGrant: 'pgr_00000000-0000-4000-8000-000000000002',
  command: 'adm_00000000-0000-4000-8000-000000000001',
} as const;

const PIN =
  'sha256:b237acdd2200b3d2f3816778a40994d872b44345ab4c1cc4ad370630b0f03db2' as const;
const ADMIN_TOKEN = `admin-${'a'.repeat(40)}`;
const PROXY_TOKEN = `proxy-${'p'.repeat(40)}`;
const FIXED_UUID = '10000000-0000-4000-8000-000000000001';
const AUTHORITY_URL = 'https://authority.example.com';

function internalLiveManifest(): OrganizationInternalLiveReleaseManifestV1 {
  return {
    schema_version: 1,
    kind: 'echo-internal-live-release',
    channel: 'internal-live',
    release_version: '0.1.0-internal.1',
    release_tag: 'internal-v0.1.0-internal.1',
    source: {
      sha: 'a'.repeat(40),
      kind: 'materialized-commit',
    },
    artifact: {
      package: 'echo-brain',
      filename: 'echo-brain-0.1.0-internal.1.tgz',
      download_url:
        'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.1/echo-brain-0.1.0-internal.1.tgz',
      size_bytes: 1234,
      sha256: 'b'.repeat(64),
    },
    compatibility: {
      os: 'darwin',
      arch: 'arm64',
      node: '22.22.1',
      npm: '10.9.4',
    },
    build: {
      repository: 'EchoBrain-org/echo-brain',
      workflow: 'internal-live-release.yml',
      run_id: '123456789',
      run_attempt: 1,
    },
  };
}

interface Fixture {
  root: string;
  config_path: string;
  database_path: string;
  invitation_directory: string;
}

interface CapturedIo extends OrganizationAdminCliIo {
  stdout_values: string[];
  stderr_values: string[];
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateFile(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-admin-cli-')));
  roots.push(root);
  chmodSync(root, 0o700);
  const configDirectory = join(root, 'config');
  const stateDirectory = join(root, 'state');
  const invitationDirectory = join(root, 'invitations');
  privateDirectory(configDirectory);
  privateDirectory(stateDirectory);
  privateDirectory(invitationDirectory);
  const paths = authorityStatePaths(stateDirectory);
  privateDirectory(paths.credential_directory);
  privateFile(paths.admin_credential_path, ADMIN_TOKEN);
  privateFile(paths.proxy_credential_path, PROXY_TOKEN);
  const configPath = join(configDirectory, 'authority.json');
  const config = createAuthorityRuntimeConfig({
    state_directory: stateDirectory,
    organization_id: IDS.organization,
    organization_display_name: 'Example Company',
    authority_id: IDS.authority,
    authority_pin_sha256: PIN,
    port: 39479,
  });
  writeAuthorityRuntimeConfigExclusive(configPath, config);
  return {
    root,
    config_path: configPath,
    database_path: paths.database_path,
    invitation_directory: invitationDirectory,
  };
}

function capturedIo(): CapturedIo {
  const stdoutValues: string[] = [];
  const stderrValues: string[] = [];
  return {
    stdout_values: stdoutValues,
    stderr_values: stderrValues,
    stdout: (value) => stdoutValues.push(value),
    stderr: (value) => stderrValues.push(value),
  };
}

function fakeClient(
  overrides: Partial<OrganizationAdminCliClient> = {},
): OrganizationAdminCliClient {
  return {
    overview: async () =>
      ({
        operation: 'overview',
      }) as never,
    listMemberships: async () => ({ operation: 'memberships' }) as never,
    listInstallations: async () => ({ operation: 'installations' }) as never,
    listEnrollmentGrants: async () => ({ operation: 'invitations' }) as never,
    listAudit: async () => ({ operation: 'audit' }) as never,
    provisionMembership: async () => ({ operation: 'member-create' }) as never,
    registerEnrollmentGrant: async () =>
      ({ operation: 'invitation-create' }) as never,
    revokeMembership: async () => ({ operation: 'member-revoke' }) as never,
    revokeInstallation: async () =>
      ({ operation: 'installation-revoke' }) as never,
    activateSlackApproval: async () =>
      ({ operation: 'slack-approval-activate' }) as never,
    approveInternalLiveRelease: async () =>
      ({ operation: 'internal-live-release-approve' }) as never,
    internalLiveRolloutStatus: async () =>
      ({ operation: 'internal-live-rollout-status' }) as never,
    ...overrides,
  };
}

function successfulDependencies(
  client: OrganizationAdminCliClient,
  overrides: OrganizationAdminCliDependencies = {},
): OrganizationAdminCliDependencies {
  return {
    client_factory: () => client,
    preflight: async (configPath) => ({
      schema_version: 1,
      kind: 'echo-organization-authority-status',
      ok: true,
      initialized: true,
      running: true,
      healthy: true,
      config_path: configPath,
      state_dir: null,
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      listener: 'http://127.0.0.1:39479',
      checks: [],
    }),
    ...overrides,
  };
}

function configArguments(value: Fixture): string[] {
  return ['--config', value.config_path];
}

describe('organization administrator CLI transport boundary', () => {
  it('reads the strict operator config and reaches overview through the loopback HTTP client port only', async () => {
    const value = fixture();
    const io = capturedIo();
    const client = fakeClient();
    const factory = vi.fn(() => client);

    expect(existsSync(value.database_path)).toBe(false);
    await expect(
      runOrganizationAuthorityAdminCli(
        ['overview', ...configArguments(value)],
        io,
        successfulDependencies(client, { client_factory: factory }),
      ),
    ).resolves.toBe(0);
    expect(existsSync(value.database_path)).toBe(false);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({
      base_url: 'http://127.0.0.1:39479',
      admin_token: ADMIN_TOKEN,
      trusted_proxy_token: PROXY_TOKEN,
      client_identity: expect.stringMatching(/^cid_[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.parse(io.stdout_values.join(''))).toEqual({
      operation: 'overview',
    });
    expect(io.stderr_values).toEqual([]);
    expect(io.stdout_values.join('')).not.toContain(ADMIN_TOKEN);
    expect(io.stdout_values.join('')).not.toContain(PROXY_TOKEN);
  });

  it.each([
    { name: 'stopped authority', ok: true, running: false, healthy: false },
    { name: 'unproven listener', ok: false, running: true, healthy: false },
  ])(
    'refuses a $name before constructing a credential-bearing client',
    async ({ ok, running, healthy }) => {
      const value = fixture();
      const factory = vi.fn(() => fakeClient());
      await expect(
        runOrganizationAuthorityAdminCli(
          ['overview', ...configArguments(value)],
          capturedIo(),
          {
            client_factory: factory,
            preflight: async (configPath) => ({
              schema_version: 1,
              kind: 'echo-organization-authority-status',
              ok,
              initialized: true,
              running,
              healthy,
              config_path: configPath,
              state_dir: null,
              authority_id: IDS.authority,
              organization_id: IDS.organization,
              listener: 'http://127.0.0.1:39479',
              checks: [],
            }),
          },
        ),
      ).rejects.toThrow('must prove that it is running and healthy');
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it('dispatches each bounded list over the admin client with one canonical page request', async () => {
    const value = fixture();
    const cursor = Buffer.from('next page', 'utf8').toString('base64url');
    const calls: Array<{ command: string; page: unknown }> = [];
    const client = fakeClient({
      listMemberships: async (page) => {
        calls.push({ command: 'memberships', page });
        return { items: [], next_cursor: null };
      },
      listInstallations: async (page) => {
        calls.push({ command: 'installations', page });
        return { items: [], next_cursor: null };
      },
      listEnrollmentGrants: async (page) => {
        calls.push({ command: 'invitations', page });
        return { items: [], next_cursor: null };
      },
      listAudit: async (page) => {
        calls.push({ command: 'audit', page });
        return { items: [], next_cursor: null };
      },
    });

    for (const command of [
      'memberships',
      'installations',
      'invitations',
      'audit',
    ]) {
      await runOrganizationAuthorityAdminCli(
        [
          command,
          'list',
          ...configArguments(value),
          '--cursor',
          cursor,
          '--limit',
          '25',
        ],
        capturedIo(),
        successfulDependencies(client),
      );
    }

    expect(calls).toEqual([
      { command: 'memberships', page: { cursor, limit: 25 } },
      { command: 'installations', page: { cursor, limit: 25 } },
      { command: 'invitations', page: { cursor, limit: 25 } },
      { command: 'audit', page: { cursor, limit: 25 } },
    ]);
  });

  it('validates and dispatches membership creation and both revocations', async () => {
    const value = fixture();
    const provisioned: ProvisionOrganizationMembershipRequestV1[] = [];
    const membershipRevocations: Array<{
      id: string;
      request: RevokeOrganizationSubjectRequestV1;
    }> = [];
    const installationRevocations: Array<{
      id: string;
      request: RevokeOrganizationSubjectRequestV1;
    }> = [];
    const client = fakeClient({
      provisionMembership: async (request) => {
        provisioned.push(request);
        return { operation: 'member-create' } as never;
      },
      revokeMembership: async (id, request) => {
        membershipRevocations.push({ id, request });
        return { operation: 'member-revoke' } as never;
      },
      revokeInstallation: async (id, request) => {
        installationRevocations.push({ id, request });
        return { operation: 'installation-revoke' } as never;
      },
    });
    const dependencies = successfulDependencies(client, {
      random_uuid: () => FIXED_UUID,
    });

    await runOrganizationAuthorityAdminCli(
      [
        'member',
        'create',
        ...configArguments(value),
        '--display-name',
        'Ada Lovelace',
        '--membership-type',
        'employee',
      ],
      capturedIo(),
      dependencies,
    );
    await runOrganizationAuthorityAdminCli(
      [
        'member',
        'create',
        ...configArguments(value),
        '--display-name',
        'Grace Hopper',
        '--membership-type',
        'owner',
        '--command-id',
        IDS.command,
      ],
      capturedIo(),
      dependencies,
    );
    await runOrganizationAuthorityAdminCli(
      [
        'member',
        'revoke',
        ...configArguments(value),
        '--membership-id',
        IDS.membership,
        '--reason',
        'Employment ended',
      ],
      capturedIo(),
      dependencies,
    );
    await runOrganizationAuthorityAdminCli(
      [
        'installation',
        'revoke',
        ...configArguments(value),
        '--installation-id',
        IDS.installation,
        '--reason',
        'Device retired',
      ],
      capturedIo(),
      dependencies,
    );

    expect(provisioned).toEqual([
      {
        command_id: `adm_${FIXED_UUID}`,
        display_name: 'Ada Lovelace',
        membership_type: 'employee',
      },
      {
        command_id: IDS.command,
        display_name: 'Grace Hopper',
        membership_type: 'owner',
      },
    ]);
    expect(membershipRevocations).toEqual([
      {
        id: IDS.membership,
        request: { reason: 'Employment ended' },
      },
    ]);
    expect(installationRevocations).toEqual([
      {
        id: IDS.installation,
        request: { reason: 'Device retired' },
      },
    ]);
  });

  it('activates Slack approval from existing employee link IDs only', async () => {
    const value = fixture();
    const requests: unknown[] = [];
    const result = {
      identity_link_id: IDS.identityLink,
      adapter_binding_id: IDS.adapterBinding,
      approve_permission_grant_id: IDS.approveGrant,
      reject_permission_grant_id: IDS.rejectGrant,
      membership_id: IDS.targetMembership,
      installation_id: IDS.installation,
      activated_at: '2026-07-22T00:03:00.000Z',
      permission_grants_created: 2 as const,
    };
    const client = fakeClient({
      activateSlackApproval: async (request) => {
        requests.push(request);
        return result;
      },
    });
    const io = capturedIo();

    await expect(
      runOrganizationAuthorityAdminCli(
        [
          'slack',
          'approval',
          'activate',
          ...configArguments(value),
          '--administrator-membership-id',
          IDS.membership,
          '--target-membership-id',
          IDS.targetMembership,
          '--installation-id',
          IDS.installation,
          '--identity-link-id',
          IDS.identityLink,
          '--adapter-binding-id',
          IDS.adapterBinding,
        ],
        io,
        successfulDependencies(client, { random_uuid: () => FIXED_UUID }),
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        command_id: `adm_${FIXED_UUID}`,
        administrator_membership_id: IDS.membership,
        target_membership_id: IDS.targetMembership,
        installation_id: IDS.installation,
        identity_link_id: IDS.identityLink,
        adapter_binding_id: IDS.adapterBinding,
      },
    ]);
    expect(JSON.parse(io.stdout_values.join(''))).toEqual(result);
    expect(io.stdout_values.join('')).not.toContain('xoxb-');
  });
});

describe('organization invitation output safety and retry', () => {
  it('persists a pending 0600 secret before transport and reuses it after uncertainty', async () => {
    const value = fixture();
    const outputPath = join(value.invitation_directory, 'ada.invitation.json');
    const calls: IssueOrganizationEnrollmentGrantRequestV1[] = [];
    let attempt = 0;
    const client = fakeClient({
      registerEnrollmentGrant: async (membershipId, request) => {
        expect(membershipId).toBe(IDS.membership);
        calls.push(request);
        attempt += 1;
        if (attempt === 1) {
          throw new Error('organization administrator request failed');
        }
        return {
          authority_id: IDS.authority,
          authority_pin_sha256: PIN,
          organization_id: IDS.organization,
          principal_id: IDS.principal,
          membership_id: IDS.membership,
          enrollment_grant_sha256: request.enrollment_grant_sha256,
          issued_at: '2026-07-22T00:00:00.000Z',
          expires_at: '2026-07-22T01:00:00.000Z',
        } satisfies IssuedOrganizationEnrollmentGrantV1;
      },
    });
    const firstIo = capturedIo();
    const invocation = [
      'invitation',
      'create',
      ...configArguments(value),
      '--authority-url',
      AUTHORITY_URL,
      '--membership-id',
      IDS.membership,
      '--lifetime-seconds',
      '3600',
      '--out',
      outputPath,
    ];

    await expect(
      runOrganizationAuthorityAdminCli(
        invocation,
        firstIo,
        successfulDependencies(client, {
          random_bytes: (size) => Buffer.alloc(size, 9),
          random_uuid: () => FIXED_UUID,
        }),
      ),
    ).rejects.toThrow('organization administrator request failed');
    expect(firstIo.stdout_values).toEqual([]);
    expect(firstIo.stderr_values).toEqual([]);
    expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
    const pendingRaw = readFileSync(outputPath, 'utf8');
    const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
    expect(pending.status).toBe('pending_registration');
    expect(pending.command_id).toBe(`adm_${FIXED_UUID}`);
    expect(pending.enrollment_grant_base64url).toBe(
      Buffer.alloc(32, 9).toString('base64url'),
    );

    const secondIo = capturedIo();
    await expect(
      runOrganizationAuthorityAdminCli(
        invocation,
        secondIo,
        successfulDependencies(client, {
          random_bytes: () => {
            throw new Error('retry generated a replacement secret');
          },
          random_uuid: () => {
            throw new Error('retry generated a replacement command');
          },
        }),
      ),
    ).resolves.toBe(0);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    const issuedRaw = readFileSync(outputPath, 'utf8');
    const envelope = JSON.parse(issuedRaw) as Record<string, unknown>;
    expect(envelope.status).toBe('issued');
    expect(envelope.enrollment_grant_base64url).toBe(
      pending.enrollment_grant_base64url,
    );
    const safeOutput = JSON.parse(secondIo.stdout_values.join('')) as Record<
      string,
      unknown
    >;
    expect(safeOutput).toMatchObject({
      invitation_path: outputPath,
      authority_url: AUTHORITY_URL,
      configured_authority_pin_sha256: PIN,
      authority_pin_verification: 'verify_independently_before_enrollment',
    });
    expect(secondIo.stdout_values.join('')).not.toContain(
      String(pending.enrollment_grant_base64url),
    );
    expect(secondIo.stdout_values.join('')).not.toContain(ADMIN_TOKEN);
    expect(secondIo.stdout_values.join('')).not.toContain(PROXY_TOKEN);
  });
});

describe('INTERNAL LIVE release administration', () => {
  it('securely validates and approves the exact manifest with a computed digest', async () => {
    const value = fixture();
    const manifest = internalLiveManifest();
    const manifestPath = join(
      value.root,
      'internal-live-release-manifest.v1.json',
    );
    privateFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const requests: ApproveOrganizationInternalLiveReleaseRequestV1[] = [];
    const client = fakeClient({
      approveInternalLiveRelease: async (request) => {
        requests.push(request);
        return {
          schema_version: 1,
          kind: 'echo-internal-live-update-directive',
          channel: 'internal-live',
          directive_sequence: 7,
          manifest_url: request.manifest_url,
          manifest_sha256: request.manifest_sha256,
          approved_at: '2026-08-02T20:00:00.000Z',
          evaluated_at: '2026-08-02T20:00:00.001Z',
        };
      },
    });
    const io = capturedIo();

    await expect(
      runOrganizationAuthorityAdminCli(
        [
          'internal-live',
          'release',
          'approve',
          ...configArguments(value),
          '--manifest',
          manifestPath,
        ],
        io,
        successfulDependencies(client, { random_uuid: () => FIXED_UUID }),
      ),
    ).resolves.toBe(0);

    const manifestSha256 = organizationInternalLiveManifestSha256(manifest);
    expect(requests).toEqual([
      {
        schema_version: 1,
        kind: 'echo-internal-live-release-approval-request',
        command_id: `adm_${FIXED_UUID}`,
        manifest_url:
          'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.1/internal-live-release-manifest.v1.json',
        manifest_sha256: manifestSha256,
        manifest,
      },
    ]);
    const output = JSON.parse(io.stdout_values.join('')) as Record<
      string,
      unknown
    >;
    expect(output).toMatchObject({
      schema_version: 1,
      kind: 'echo-organization-internal-live-release-approved',
      promotion_stage: 'INTERNAL LIVE',
      command_id: `adm_${FIXED_UUID}`,
      release: {
        release_version: manifest.release_version,
        source_sha: manifest.source.sha,
        artifact_sha256: manifest.artifact.sha256,
        manifest_sha256: manifestSha256,
      },
      directive: {
        directive_sequence: 7,
        channel: 'internal-live',
      },
    });
    expect(io.stdout_values.join('')).not.toContain(value.root);
    expect(io.stdout_values.join('')).not.toContain(ADMIN_TOKEN);
    expect(io.stdout_values.join('')).not.toContain(PROXY_TOKEN);
  });

  it('uses a supplied idempotency command and returns validated rollout status', async () => {
    const value = fixture();
    const manifest = internalLiveManifest();
    const manifestPath = join(value.root, 'release.json');
    privateFile(manifestPath, JSON.stringify(manifest));
    const approval = vi.fn(async (request) => ({
      schema_version: 1 as const,
      kind: 'echo-internal-live-update-directive' as const,
      channel: 'internal-live' as const,
      directive_sequence: 1,
      manifest_url: request.manifest_url,
      manifest_sha256: request.manifest_sha256,
      approved_at: '2026-08-02T20:00:00.000Z',
      evaluated_at: '2026-08-02T20:00:00.001Z',
    }));
    const status = {
      schema_version: 1 as const,
      kind: 'echo-internal-live-rollout-status' as const,
      channel: 'internal-live' as const,
      evaluated_at: '2026-08-02T20:01:00.000Z',
      approved_release: null,
      installations: [],
    };
    const client = fakeClient({
      approveInternalLiveRelease: approval,
      internalLiveRolloutStatus: async () => status,
    });
    const dependencies = successfulDependencies(client);

    await runOrganizationAuthorityAdminCli(
      [
        'internal-live',
        'release',
        'approve',
        ...configArguments(value),
        '--manifest',
        manifestPath,
        '--command-id',
        IDS.command,
      ],
      capturedIo(),
      dependencies,
    );
    const statusIo = capturedIo();
    await runOrganizationAuthorityAdminCli(
      [
        'internal-live',
        'rollout',
        'status',
        ...configArguments(value),
      ],
      statusIo,
      dependencies,
    );

    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ command_id: IDS.command }),
    );
    expect(JSON.parse(statusIo.stdout_values.join(''))).toEqual(status);
  });

  it('rejects symlinked, writable-by-others, and wrong-repository manifests before transport', async () => {
    const value = fixture();
    const manifest = internalLiveManifest();
    const targetPath = join(value.root, 'manifest-target.json');
    const symlinkPath = join(value.root, 'manifest-link.json');
    privateFile(targetPath, JSON.stringify(manifest));
    symlinkSync(targetPath, symlinkPath);
    const publicPath = join(value.root, 'manifest-public.json');
    writeFileSync(publicPath, JSON.stringify(manifest), { mode: 0o666 });
    chmodSync(publicPath, 0o666);
    const wrongRepositoryPath = join(value.root, 'manifest-wrong-repo.json');
    privateFile(
      wrongRepositoryPath,
      JSON.stringify({
        ...manifest,
        artifact: {
          ...manifest.artifact,
          download_url:
            'https://github.com/attacker/echo-brain/releases/download/internal-v0.1.0-internal.1/echo-brain-0.1.0-internal.1.tgz',
        },
        build: { ...manifest.build, repository: 'attacker/echo-brain' },
      }),
    );
    const approve = vi.fn();
    const dependencies = successfulDependencies(
      fakeClient({ approveInternalLiveRelease: approve }),
    );

    for (const path of [symlinkPath, publicPath]) {
      await expect(
        runOrganizationAuthorityAdminCli(
          [
            'internal-live',
            'release',
            'approve',
            ...configArguments(value),
            '--manifest',
            path,
          ],
          capturedIo(),
          dependencies,
        ),
      ).rejects.toThrow(/bounded current-user canonical regular file/);
    }
    await expect(
      runOrganizationAuthorityAdminCli(
        [
          'internal-live',
          'release',
          'approve',
          ...configArguments(value),
          '--manifest',
          wrongRepositoryPath,
        ],
        capturedIo(),
        dependencies,
      ),
    ).rejects.toThrow(/repository is unsupported/);
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('organization administrator CLI argument bounds', () => {
  it.each([
    {
      name: 'relative config',
      arguments_: ['overview', '--config', 'authority.json'],
    },
    {
      name: 'oversized page',
      arguments_: ['memberships', 'list', '--limit', '101'],
    },
    {
      name: 'noncanonical membership',
      arguments_: [
        'member',
        'revoke',
        '--membership-id',
        'mem_not-a-uuid',
        '--reason',
        'retired',
      ],
    },
    {
      name: 'oversized display name',
      arguments_: [
        'member',
        'create',
        '--display-name',
        'a'.repeat(201),
        '--membership-type',
        'employee',
      ],
    },
    {
      name: 'noncanonical Slack identity link',
      arguments_: [
        'slack',
        'approval',
        'activate',
        '--administrator-membership-id',
        IDS.membership,
        '--target-membership-id',
        IDS.targetMembership,
        '--installation-id',
        IDS.installation,
        '--identity-link-id',
        'clm_not-a-uuid',
        '--adapter-binding-id',
        IDS.adapterBinding,
      ],
    },
    {
      name: 'oversized lifetime',
      arguments_: [
        'invitation',
        'create',
        '--authority-url',
        AUTHORITY_URL,
        '--membership-id',
        IDS.membership,
        '--lifetime-seconds',
        String(7 * 24 * 60 * 60 + 1),
        '--out',
        '/tmp/invitation.json',
      ],
    },
  ])('rejects $name', async ({ arguments_ }) => {
    const value = fixture();
    const withConfig = arguments_.includes('--config')
      ? arguments_
      : [...arguments_, ...configArguments(value)];
    const client = fakeClient();
    await expect(
      runOrganizationAuthorityAdminCli(
        withConfig,
        capturedIo(),
        successfulDependencies(client),
      ),
    ).rejects.toThrow();
  });

  it('requires invitation output beneath a canonical current-user 0700 parent', async () => {
    const value = fixture();
    const publicDirectory = join(value.root, 'public');
    mkdirSync(publicDirectory, { mode: 0o755 });
    chmodSync(publicDirectory, 0o755);
    const outputPath = join(publicDirectory, 'invitation.json');

    await expect(
      runOrganizationAuthorityAdminCli(
        [
          'invitation',
          'create',
          ...configArguments(value),
          '--authority-url',
          AUTHORITY_URL,
          '--membership-id',
          IDS.membership,
          '--lifetime-seconds',
          '3600',
          '--out',
          outputPath,
        ],
        capturedIo(),
        successfulDependencies(fakeClient()),
      ),
    ).rejects.toThrow('0700 canonical directory');
    expect(existsSync(outputPath)).toBe(false);
  });
});
