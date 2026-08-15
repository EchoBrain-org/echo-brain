import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  organizationEnrollmentGrantSha256,
  type OrganizationEnrollmentReceiptV1,
  type OrganizationEnrollmentRequestV1,
  type OrganizationInstallationAccessStateV1,
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
const GRANOLA_TOKEN = 'grn_test_onboard_token';
const SLACK_TOKEN = 'xoxb-test-onboard-token';
const SLACK_CHANNEL_ID = 'C0BFRT0E9L2';
const SLACK_REVIEWER_USER_ID = 'U0BFVNMRW65';
const SLACK_REVIEWER_NAME = 'Audrey Ng';

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

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

interface ManagedLaunchd {
  runner: LaunchctlRunner;
  calls: string[][];
}

/**
 * A launchd double that supports the managed service lifecycle: `bootstrap`
 * loads and starts the LaunchAgent, `print` reflects that state, and
 * everything else is refused, so an unexpected launchctl verb fails the test.
 */
function managedLaunchd(): ManagedLaunchd {
  const calls: string[][] = [];
  let running = false;
  const runner: LaunchctlRunner = async (input) => {
    const args = [...input];
    calls.push(args);
    if (args[0] === 'bootstrap') {
      running = true;
      return { status: 0, stdout: '', stderr: '' } satisfies LaunchctlResult;
    }
    if (args[0] === 'print') {
      return running
        ? { status: 0, stdout: 'state = running\npid = 4242\n', stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' };
    }
    return {
      status: 64,
      stdout: '',
      stderr: `onboard test does not support launchctl ${args[0] ?? ''}`,
    };
  };
  return { runner, calls };
}

function invitationPath(root: string, authority: TestAuthority): string {
  const path = join(root, 'echo-organization-invitation.json');
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

function onboardArgv(options: {
  configPath: string;
  stateDirectory: string;
  invitationPath: string;
  authorityPin: string;
  consent?: boolean;
}): string[] {
  return [
    'onboard',
    '--config',
    options.configPath,
    '--state-dir',
    options.stateDirectory,
    '--owner-email',
    'employee@example.test',
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
    ...(options.consent === false ? [] : ['--allow-exportable-software-key']),
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-onboard-cli-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const configPath = join(root, 'config', 'runtime.json');
  const stateDirectory = join(root, 'state');
  const authority = new TestAuthority();
  const invitation = invitationPath(root, authority);
  const launchd = managedLaunchd();
  const authorityPaths: string[] = [];
  const enrollmentRequests: OrganizationEnrollmentRequestV1[] = [];
  let enrollmentReceipt: OrganizationEnrollmentReceiptV1 | null = null;
  let accessState: OrganizationInstallationAccessStateV1 | null = null;
  let loseNextEnrollmentResponse = false;
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
        throw new Error('onboard must not construct product adapters');
      },
    });
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    authorityPaths.push(url.pathname);
    if (url.pathname === '/v1/authority-descriptor') {
      return Response.json({ authority_descriptor: authority.descriptor });
    }
    if (url.pathname === '/v1/enrollments') {
      const body = JSON.parse(String(init?.body)) as {
        enrollment_request: OrganizationEnrollmentRequestV1;
      };
      enrollmentRequests.push(body.enrollment_request);
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
        enrollmentRequests.length === 0 ||
        enrollmentReceipt === null ||
        accessState === null
      ) {
        throw new Error('enrollment must precede access refresh');
      }
      const activeLeaseTtlMs = requestedAccessLeaseTtlMs(
        JSON.parse(String(init?.body)) as unknown,
      );
      accessState = await authority.nextActiveState(
        enrollmentRequests[enrollmentRequests.length - 1]!,
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
      readGranolaCredential: async () => GRANOLA_TOKEN,
      observeGranolaRecordOwner: async (_credential, ownerEmail) => ({
        provider: 'granola',
        relationship: 'record_owner',
        subject: { kind: 'email', value: ownerEmail },
        assurance: 'provider_record_owner_observed',
        notes_examined: 2,
      }),
      readSlackCredential: async () => SLACK_TOKEN,
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
    enrollmentRequests,
    loseNextEnrollmentResponse: () => {
      loseNextEnrollmentResponse = true;
    },
    dependencies,
    transactionPath: join(root, 'config', 'onboarding', 'active-transaction.v1.json'),
    receiptsDirectory: join(root, 'config', 'onboarding', 'receipts'),
  };
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe('onboard CLI (RFC-0001 slice 1)', () => {
  it('reaches ready in one command with no follow-up command list', async () => {
    const test = fixture();
    const result = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report['status']).toBe('ready');
    expect(report['step']).toBe('activate');
    expect(report).not.toHaveProperty('next_steps');
    expect(report['effects']).toMatchObject({
      central_enrollment: true,
      service_activation: true,
    });
    expect(test.enrollmentRequests).toHaveLength(1);
    expect(
      test.launchd.calls.filter((call) => call[0] === 'bootstrap'),
    ).toHaveLength(1);
    const transaction = parseJson(readFileSync(test.transactionPath, 'utf8'));
    expect(transaction['finished_at']).not.toBeNull();
    expect(existsSync(test.receiptsDirectory)).toBe(true);
  });

  it('ONB-RESUME-01: resumes a lost enrollment response with the same operation identity and exactly one enrollment', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    test.loseNextEnrollmentResponse();
    const first = await command(argv, test.dependencies);
    expect(first.status).toBe(0);
    expect(parseJson(first.stdout)['status']).toBe('retryable');
    const interrupted = parseJson(
      readFileSync(test.transactionPath, 'utf8'),
    ) as {
      steps: Record<string, { state: string; operation_id: string | null }>;
      effects: Record<string, boolean>;
    };
    expect(interrupted.steps['stage_local']!.state).toBe('prepared');
    expect(interrupted.effects['central_enrollment']).toBe(true);
    const preparedOperationId = interrupted.steps['stage_local']!.operation_id;
    expect(preparedOperationId).not.toBeNull();

    const second = await command(argv, test.dependencies);
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(parseJson(second.stdout)['status']).toBe('ready');

    expect(test.enrollmentRequests).toHaveLength(2);
    expect(canonicalJson(test.enrollmentRequests[0])).toBe(
      canonicalJson(test.enrollmentRequests[1]),
    );
    const resumed = parseJson(readFileSync(test.transactionPath, 'utf8')) as {
      steps: Record<string, { state: string; operation_id: string | null }>;
    };
    expect(resumed.steps['stage_local']!.state).toBe('succeeded');
    expect(resumed.steps['stage_local']!.operation_id).toBe(
      preparedOperationId,
    );
  });

  it('ONB-PREAUTH-01: a wrong pin is a closed denial with no Authority contact and no replayable state', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: `sha256:${'f'.repeat(64)}`,
    });
    const first = await command(argv, test.dependencies);
    expect(first.status).toBe(1);
    expect(parseJson(first.stdout)['status']).toBe('denied');
    expect(test.authorityPaths).toHaveLength(0);
    expect(test.launchd.calls).toHaveLength(0);

    const second = await command(argv, test.dependencies);
    expect(second.status).toBe(1);
    expect(parseJson(second.stdout)['status']).toBe('denied');
    expect(test.authorityPaths).toHaveLength(0);
    expect(test.enrollmentRequests).toHaveLength(0);
  });

  it('pauses for software-key consent instead of failing usage', async () => {
    const test = fixture();
    const result = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
        consent: false,
      }),
      test.dependencies,
    );
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report['status']).toBe('waiting_for_user');
    expect(report['step']).toBe('confirm_human');
    expect(test.authorityPaths).toHaveLength(0);
  });
});
