import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  organizationEnrollmentGrantSha256,
  type OrganizationInstallationAccessStateV1,
  type OrganizationEnrollmentReceiptV1,
  type OrganizationEnrollmentRequestV1,
} from '@echo-brain/organization-protocol';
import {
  runProductCli,
  type ProductCliDependencies,
} from '../../src/product/cli.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import type {
  LaunchctlResult,
  LaunchctlRunner,
} from '../../src/product/launchd-service.js';
import {
  GRANT,
  ORGANIZATION_IDS,
  requestedAccessLeaseTtlMs,
  TestAuthority,
} from '../support/local-organization-fixtures.js';

const roots: string[] = [];
const NOW = '2026-07-22T00:03:00.000Z';
const AUTHORITY_ORIGIN = 'https://authority.example.test';
const GRANOLA_TOKEN = 'grn_test_bootstrap_token';
const SLACK_TOKEN = 'xoxb-test-bootstrap-token';
const SLACK_CHANNEL_ID = 'C0BFRT0E9L2';
const SLACK_REVIEWER_USER_ID = 'U0BFVNMRW65';
const SLACK_REVIEWER_NAME = 'Audrey Ng';

function output() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += chunk.toString();
        return true;
      },
    },
    read: () => value,
  };
}

interface FakeLaunchd {
  runner: LaunchctlRunner;
  calls: string[][];
}

function stoppedLaunchd(): FakeLaunchd {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (input) => {
    const args = [...input];
    calls.push(args);
    const result: LaunchctlResult =
      args[0] === 'print'
        ? {
            status: 113,
            stdout: '',
            stderr: 'Could not find service',
          }
        : {
            status: 64,
            stdout: '',
            stderr: `bootstrap must not invoke launchctl ${args[0] ?? ''}`,
          };
    return result;
  };
  return { runner, calls };
}

function invitationPath(
  root: string,
  authority: TestAuthority,
  filename = 'echo-organization-invitation.json',
): string {
  const path = join(root, filename);
  const grantSha256 = organizationEnrollmentGrantSha256(GRANT);
  const invitation = {
    schema_version: 1,
    kind: 'echo-organization-enrollment-invitation',
    status: 'issued',
    authority_base_url: AUTHORITY_ORIGIN,
    authority_id: authority.descriptor.authority_id,
    authority_pin_sha256: authority.pin,
    authority_pin_verification: 'independent_pin_required',
    organization_id: authority.descriptor.organization_id,
    membership_id: ORGANIZATION_IDS.membership,
    command_id: 'adm_00000000-0000-4000-8000-000000000001',
    enrollment_grant_sha256: grantSha256,
    enrollment_grant_base64url: GRANT.toString('base64url'),
    lifetime_seconds: 60 * 60,
    issued: {
      authority_id: authority.descriptor.authority_id,
      authority_pin_sha256: authority.pin,
      organization_id: authority.descriptor.organization_id,
      principal_id: ORGANIZATION_IDS.principal,
      membership_id: ORGANIZATION_IDS.membership,
      enrollment_grant_sha256: grantSha256,
      issued_at: '2026-07-22T00:00:00.000Z',
      expires_at: '2026-07-22T01:00:00.000Z',
    },
  } as const;
  writeFileSync(path, `${canonicalJson(invitation)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function bootstrapArgv(options: {
  configPath: string;
  stateDirectory: string;
  ownerEmail: string;
  invitationPath: string;
  authorityPin: string;
}): string[] {
  return [
    'bootstrap',
    '--config',
    options.configPath,
    '--state-dir',
    options.stateDirectory,
    '--owner-email',
    options.ownerEmail,
    '--slack-channel-id',
    SLACK_CHANNEL_ID,
    '--slack-reviewer-user-id',
    SLACK_REVIEWER_USER_ID,
    '--slack-reviewer-name',
    SLACK_REVIEWER_NAME,
    '--invitation',
    options.invitationPath,
    '--authority-pin',
    options.authorityPin,
    '--allow-exportable-software-key',
  ];
}

async function command(
  argv: readonly string[],
  dependencies: ProductCliDependencies,
) {
  const stdout = output();
  const stderr = output();
  const status = await runProductCli(argv, {
    ...dependencies,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { status, stdout: stdout.read(), stderr: stderr.read() };
}

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-internal-live-bootstrap-')),
  );
  chmodSync(root, 0o700);
  roots.push(root);
  const configPath = join(root, 'config', 'runtime.json');
  const stateDirectory = join(root, 'state');
  const authority = new TestAuthority();
  const invitation = invitationPath(root, authority);
  const launchd = stoppedLaunchd();
  const authorityPaths: string[] = [];
  let enrollmentRequest: OrganizationEnrollmentRequestV1 | null = null;
  let enrollmentReceipt: OrganizationEnrollmentReceiptV1 | null = null;
  let accessState: OrganizationInstallationAccessStateV1 | null = null;
  let loseNextEnrollmentResponse = false;
  let granolaCredentialReads = 0;
  let granolaOwnerObservations = 0;
  let granolaOwnerObservationFailure: string | null = null;
  let slackCredentialReads = 0;
  let adapterConstructions = 0;
  const adapterFactories = new ProductAdapterFactoryRegistry();
  for (const [kind, adapterId] of [
    ['meeting-source', 'granola'],
    ['decision-processor', 'structured-text'],
    ['delivery-surface', 'jsonl-outbox'],
    ['approval-surface', 'slack-reactions'],
  ] as const) {
    adapterFactories.register({
      kind,
      adapter_id: adapterId,
      create: () => {
        adapterConstructions += 1;
        throw new Error('bootstrap must not construct product adapters');
      },
    });
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    authorityPaths.push(url.pathname);
    if (url.pathname === '/v1/authority-descriptor') {
      return Response.json({
        authority_descriptor: authority.descriptor,
      });
    }
    if (url.pathname === '/v1/enrollments') {
      const body = JSON.parse(String(init?.body)) as {
        enrollment_request: OrganizationEnrollmentRequestV1;
      };
      enrollmentRequest = body.enrollment_request;
      const completion = await authority.complete(body.enrollment_request);
      enrollmentReceipt = completion.enrollment_receipt;
      accessState = completion.access_state;
      if (loseNextEnrollmentResponse) {
        loseNextEnrollmentResponse = false;
        throw new Error('simulated lost enrollment response');
      }
      return Response.json(completion, { status: 201 });
    }
    if (url.pathname === '/v1/access-leases') {
      if (
        enrollmentRequest === null ||
        enrollmentReceipt === null ||
        accessState === null
      ) {
        throw new Error('enrollment must precede access refresh');
      }
      const activeLeaseTtlMs = requestedAccessLeaseTtlMs(
        JSON.parse(String(init?.body)) as unknown,
      );
      accessState = await authority.nextActiveState(
        enrollmentRequest,
        enrollmentReceipt,
        accessState,
        activeLeaseTtlMs,
      );
      return Response.json({ access_state: accessState });
    }
    throw new Error(`unexpected organization authority path ${url.pathname}`);
  };
  const dependencies: ProductCliDependencies = {
    classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
    adapterFactories,
    bootstrap: {
      readGranolaCredential: async () => {
        granolaCredentialReads += 1;
        return GRANOLA_TOKEN;
      },
      observeGranolaRecordOwner: async (credential, ownerEmail) => {
        granolaOwnerObservations += 1;
        if (credential !== GRANOLA_TOKEN) {
          throw new Error('Granola observation received another credential');
        }
        if (granolaOwnerObservationFailure !== null) {
          throw new Error(granolaOwnerObservationFailure);
        }
        return {
          provider: 'granola',
          relationship: 'record_owner',
          subject: { kind: 'email', value: ownerEmail },
          assurance: 'provider_record_owner_observed',
          notes_examined: 2,
        };
      },
      readSlackCredential: async () => {
        slackCredentialReads += 1;
        return SLACK_TOKEN;
      },
    },
    now: () => NOW,
    operator: {
      launchctl: launchd.runner,
      platform: 'darwin',
      architecture: 'arm64',
      uid: statSync(root).uid,
      homeDirectory: join(root, 'home'),
      nodePath: realpathSync(process.execPath),
      nodeVersion: 'v22.22.1',
      cliPath: realpathSync(import.meta.filename),
      productVersion: '0.1.0-internal.test',
      buildIdentity: {
        source_sha: '1'.repeat(40),
        source_kind: 'materialized-commit',
      },
    },
    organization: {
      fetch: fetchImpl,
      createInstallationId: () => ORGANIZATION_IDS.installation,
    },
  };
  return {
    root,
    configPath,
    stateDirectory,
    authority,
    invitation,
    launchd,
    authorityPaths,
    adapterConstructions: () => adapterConstructions,
    granolaCredentialReads: () => granolaCredentialReads,
    granolaOwnerObservations: () => granolaOwnerObservations,
    slackCredentialReads: () => slackCredentialReads,
    failGranolaOwnerObservation: (message: string | null) => {
      granolaOwnerObservationFailure = message;
    },
    loseNextEnrollmentResponse: () => {
      loseNextEnrollmentResponse = true;
    },
    dependencies,
  };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('internal-live employee bootstrap CLI', () => {
  it('creates an owner-bound enrolled installation but leaves product work stopped', async () => {
    const test = fixture();
    const argv = bootstrapArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      ownerEmail: 'audrey@echobrain.org',
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });

    const result = await command(argv, test.dependencies);

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: true,
      command: 'bootstrap',
      owner_email: 'audrey@echobrain.org',
      organization: {
        enrolled: true,
        access: {
          permitted: true,
          status: 'active',
          installation_id: ORGANIZATION_IDS.installation,
        },
      },
      service: {
        installed: false,
        loaded: false,
        running: false,
      },
      granola_record_owner: {
        provider: 'granola',
        relationship: 'record_owner',
        subject: { kind: 'email', value: 'audrey@echobrain.org' },
        assurance: 'provider_record_owner_observed',
        notes_examined: 2,
      },
    });
    expect(report).not.toHaveProperty('approval_activation');
    expect(report.next_steps).toContainEqual(
      `echo-brain organization slack-link-begin --config ${test.configPath}`,
    );
    expect(report.next_steps).toContainEqual(
      expect.stringContaining('echo-organization-admin slack approval activate'),
    );

    const config = JSON.parse(readFileSync(test.configPath, 'utf8'));
    expect(config.meeting_sources).toHaveLength(1);
    expect(config.meeting_sources[0]).toMatchObject({
      adapter_id: 'granola',
      settings: {
        owner_email: 'audrey@echobrain.org',
        page_size: 1,
      },
    });
    expect(config).toMatchObject({
      approval_mode: 'adapter',
      approval_surface: {
        adapter_id: 'slack-reactions',
        instance_id: 'internal-approvals',
        settings: {
          channel_id: SLACK_CHANNEL_ID,
          reviewer: {
            slack_user_id: SLACK_REVIEWER_USER_ID,
            name: SLACK_REVIEWER_NAME,
          },
          approve_reaction: 'white_check_mark',
          reject_reaction: 'x',
        },
      },
    });
    expect(statSync(test.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(test.stateDirectory).mode & 0o777).toBe(0o700);
    const credentialPath = join(
      test.stateDirectory,
      'credentials',
      'granola-api-key',
    );
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(credentialPath, 'utf8').trim()).toBe(GRANOLA_TOKEN);
    const slackCredentialPath = join(
      test.stateDirectory,
      'credentials',
      'slack-bot-token',
    );
    expect(config.approval_surface.credential_ref).toBe(
      `file:${slackCredentialPath}`,
    );
    expect(statSync(slackCredentialPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(slackCredentialPath, 'utf8')).toBe(SLACK_TOKEN);
    expect(result.stdout).not.toContain(GRANOLA_TOKEN);
    expect(result.stderr).not.toContain(GRANOLA_TOKEN);
    expect(result.stdout).not.toContain(SLACK_TOKEN);
    expect(result.stderr).not.toContain(SLACK_TOKEN);
    expect(test.granolaCredentialReads()).toBe(1);
    expect(test.granolaOwnerObservations()).toBe(1);
    expect(test.slackCredentialReads()).toBe(1);
    expect(test.authorityPaths).toEqual([
      '/v1/authority-descriptor',
      '/v1/authority-descriptor',
      '/v1/enrollments',
    ]);
    expect(test.adapterConstructions()).toBe(0);
    expect(test.launchd.calls.length).toBeGreaterThan(0);
    expect(
      test.launchd.calls.every((args) => args[0] === 'print'),
    ).toBe(true);

    const status = await command(
      ['status', '--config', test.configPath],
      test.dependencies,
    );
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).service).toMatchObject({
      installed: false,
      loaded: false,
      running: false,
    });

    const configBeforeRetry = readFileSync(test.configPath, 'utf8');
    const retry = await command(argv, test.dependencies);
    expect(retry.status, retry.stderr).toBe(0);
    expect(readFileSync(test.configPath, 'utf8')).toBe(configBeforeRetry);
    expect(test.authorityPaths.at(-1)).toBe('/v1/access-leases');
    expect(test.granolaCredentialReads()).toBe(1);
    expect(test.granolaOwnerObservations()).toBe(2);
    expect(test.slackCredentialReads()).toBe(1);
    expect(
      test.launchd.calls.every((args) => args[0] === 'print'),
    ).toBe(true);
  });

  it('stops before Slack and Authority work when Granola cannot observe the configured owner', async () => {
    const test = fixture();
    const argv = bootstrapArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      ownerEmail: 'audrey@echobrain.org',
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    test.failGranolaOwnerObservation(
      'Granola did not return a record owned by audrey@echobrain.org',
    );

    const first = await command(argv, test.dependencies);

    expect(first.status).toBe(1);
    expect(first.stderr).toContain(
      'Granola did not return a record owned by audrey@echobrain.org',
    );
    expect(test.granolaCredentialReads()).toBe(1);
    expect(test.granolaOwnerObservations()).toBe(1);
    expect(test.slackCredentialReads()).toBe(0);
    expect(test.authorityPaths).toEqual([]);
    expect(test.adapterConstructions()).toBe(0);
    expect(
      existsSync(
        join(test.stateDirectory, 'credentials', 'granola-api-key'),
      ),
    ).toBe(false);
  });

  it('resumes an exact enrollment after the Authority response is lost', async () => {
    const test = fixture();
    const argv = bootstrapArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      ownerEmail: 'audrey@echobrain.org',
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    test.loseNextEnrollmentResponse();

    const first = await command(argv, test.dependencies);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain('simulated lost enrollment response');
    expect(existsSync(test.configPath)).toBe(true);
    expect(existsSync(test.stateDirectory)).toBe(true);
    expect(test.granolaCredentialReads()).toBe(1);
    expect(test.granolaOwnerObservations()).toBe(1);
    expect(test.slackCredentialReads()).toBe(1);

    const resumed = await command(argv, test.dependencies);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      ok: true,
      command: 'bootstrap',
      owner_email: 'audrey@echobrain.org',
      organization: {
        enrolled: true,
        access: { permitted: true, status: 'active' },
      },
      service: { installed: false, loaded: false, running: false },
      product_work_started: false,
    });
    expect(test.granolaCredentialReads()).toBe(1);
    expect(test.granolaOwnerObservations()).toBe(2);
    expect(test.adapterConstructions()).toBe(0);
    expect(
      test.launchd.calls.every((args) => args[0] === 'print'),
    ).toBe(true);
  });

  it('refuses an unverified worktree build before creating local state', async () => {
    const test = fixture();
    test.dependencies.operator = {
      ...test.dependencies.operator,
      buildIdentity: {
        source_sha: '2'.repeat(40),
        source_kind: 'worktree-head-unverified',
      },
    };

    const result = await command(
      bootstrapArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        ownerEmail: 'audrey@echobrain.org',
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('materialized-commit');
    expect(existsSync(test.configPath)).toBe(false);
    expect(existsSync(test.stateDirectory)).toBe(false);
    expect(test.authorityPaths).toEqual([]);
    expect(test.launchd.calls).toEqual([]);
    expect(test.granolaCredentialReads()).toBe(0);
    expect(test.slackCredentialReads()).toBe(0);
  });

  it('refuses a non-canonical owner before creating local state', async () => {
    const test = fixture();

    const result = await command(
      bootstrapArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        ownerEmail: 'Audrey@EchoBrain.org',
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('canonical lowercase email');
    expect(existsSync(test.configPath)).toBe(false);
    expect(existsSync(test.stateDirectory)).toBe(false);
    expect(test.authorityPaths).toEqual([]);
    expect(test.launchd.calls).toEqual([]);
    expect(test.granolaCredentialReads()).toBe(0);
    expect(test.slackCredentialReads()).toBe(0);
  });

  it('refuses a different invitation when resuming an enrolled bootstrap', async () => {
    const test = fixture();
    const originalArgv = bootstrapArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      ownerEmail: 'audrey@echobrain.org',
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    const first = await command(originalArgv, test.dependencies);
    expect(first.status, first.stderr).toBe(0);

    const otherAuthority = new TestAuthority(2);
    const otherInvitation = invitationPath(
      test.root,
      otherAuthority,
      'different-organization-invitation.json',
    );
    const pathsBefore = [...test.authorityPaths];
    const resumed = await command(
      bootstrapArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        ownerEmail: 'audrey@echobrain.org',
        invitationPath: otherInvitation,
        authorityPin: otherAuthority.pin,
      }),
      test.dependencies,
    );

    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain(
      'invitation does not match the enrolled organization identity',
    );
    expect(test.authorityPaths).toEqual(pathsBefore);
    expect(test.granolaCredentialReads()).toBe(1);
    expect(test.slackCredentialReads()).toBe(1);
  });

  it('rejects non-local state before reading or writing credentials', async () => {
    const test = fixture();
    test.dependencies.classifyStateFilesystem = async () => ({
      kind: 'network',
      raw: 'smbfs',
    });

    const result = await command(
      bootstrapArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        ownerEmail: 'audrey@echobrain.org',
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires a local state filesystem');
    expect(test.granolaCredentialReads()).toBe(0);
    expect(test.slackCredentialReads()).toBe(0);
    expect(existsSync(test.configPath)).toBe(false);
    expect(existsSync(test.stateDirectory)).toBe(false);
    expect(test.authorityPaths).toEqual([]);
  });

  it('resumes from an empty state directory and repairs one missing credential', async () => {
    const test = fixture();
    mkdirSync(test.stateDirectory, { mode: 0o700 });
    const argv = bootstrapArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      ownerEmail: 'audrey@echobrain.org',
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });

    const first = await command(argv, test.dependencies);
    expect(first.status, first.stderr).toBe(0);
    const slackCredentialPath = join(
      test.stateDirectory,
      'credentials',
      'slack-bot-token',
    );
    unlinkSync(slackCredentialPath);

    const resumed = await command(argv, test.dependencies);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(slackCredentialPath, 'utf8')).toBe(SLACK_TOKEN);
    expect(test.granolaCredentialReads()).toBe(1);
    expect(test.slackCredentialReads()).toBe(2);
  });

  it.skipIf(process.platform !== 'darwin')(
    'rejects an inherited permissive ACL before reading credentials',
    async () => {
      const test = fixture();
      const aclParent = join(test.root, 'acl-state-parent');
      const stateDirectory = join(aclParent, 'state');
      mkdirSync(aclParent, { mode: 0o700 });
      const acl = spawnSync(
        '/bin/chmod',
        [
          '+a',
          'everyone allow read,readattr,readextattr,readsecurity,file_inherit,directory_inherit',
          aclParent,
        ],
        { encoding: 'utf8' },
      );
      expect(acl.status, acl.stderr).toBe(0);

      const result = await command(
        bootstrapArgv({
          configPath: test.configPath,
          stateDirectory,
          ownerEmail: 'audrey@echobrain.org',
          invitationPath: test.invitation,
          authorityPin: test.authority.pin,
        }),
        test.dependencies,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('macOS ACL');
      expect(test.granolaCredentialReads()).toBe(0);
      expect(test.slackCredentialReads()).toBe(0);
      expect(existsSync(test.configPath)).toBe(false);
      expect(existsSync(stateDirectory)).toBe(false);
    },
  );
});
