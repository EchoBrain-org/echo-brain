import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '@echo-brain/federation-protocol';
import type {
  ApprovalSurfaceAdapter,
  DecisionProcessorAdapter,
  DeliverySurfaceAdapter,
  MeetingSourceAdapter,
} from '../../src/core/index.js';
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
import {
  createOnboardingTransaction,
  deriveOnboardingIdentity,
  onboardingDocumentSha256,
  transitionOnboardingStep,
} from '../../src/product/onboarding/onboarding-transaction.js';
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
  failNextBootstrapBeforeCommit(): void;
  loseNextBootstrapResponse(): void;
  beforeBootstrap(callback: () => void): void;
}

/**
 * A launchd double that supports the managed service lifecycle: `bootstrap`
 * loads and starts the LaunchAgent, `print` reflects that state, and
 * everything else is refused, so an unexpected launchctl verb fails the test.
 */
function managedLaunchd(): ManagedLaunchd {
  const calls: string[][] = [];
  let running = false;
  let failBootstrapBeforeCommit = false;
  let loseBootstrapResponse = false;
  let bootstrapCallback: (() => void) | undefined;
  const runner: LaunchctlRunner = async (input) => {
    const args = [...input];
    calls.push(args);
    if (args[0] === 'bootstrap') {
      bootstrapCallback?.();
      if (failBootstrapBeforeCommit) {
        failBootstrapBeforeCommit = false;
        throw new Error('simulated crash before launchd bootstrap commit');
      }
      running = true;
      if (loseBootstrapResponse) {
        loseBootstrapResponse = false;
        throw new Error('simulated lost launchd bootstrap response');
      }
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
  return {
    runner,
    calls,
    failNextBootstrapBeforeCommit() {
      failBootstrapBeforeCommit = true;
    },
    loseNextBootstrapResponse() {
      loseBootstrapResponse = true;
    },
    beforeBootstrap(callback) {
      bootstrapCallback = callback;
    },
  };
}

interface SimulatedTerminal {
  rawModeCalls: boolean[];
  restore(): void;
}

/**
 * Simulates a controlling terminal on process.stdin for the hidden credential
 * prompts: raw-mode capable and scripted to answer each prompt as raw mode is
 * entered. Every patched property is restored so other tests observe the real
 * worker stdin.
 */
function simulatedTerminalStdin(answers: readonly string[]): SimulatedTerminal {
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const pending = [...answers];
  const rawModeCalls: boolean[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>(
    ['isTTY', 'isRaw', 'setRawMode'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(stdin, name),
    ]),
  );
  Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(stdin, 'isRaw', {
    value: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(stdin, 'setRawMode', {
    configurable: true,
    value(mode: boolean) {
      rawModeCalls.push(mode);
      stdin.isRaw = mode;
      if (mode && pending.length > 0) {
        const answer = pending.shift()!;
        setImmediate(() => stdin.emit('data', Buffer.from(answer, 'utf8')));
      }
      return stdin;
    },
  });
  return {
    rawModeCalls,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) {
          delete (stdin as unknown as Record<string, unknown>)[name];
        } else {
          Object.defineProperty(stdin, name, descriptor);
        }
      }
    },
  };
}

function invitationDocument(authority: TestAuthority) {
  const grantSha256 = organizationEnrollmentGrantSha256(GRANT);
  return {
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
}

function invitationPath(root: string, authority: TestAuthority): string {
  const path = join(root, 'echo-organization-invitation.json');
  const invitation = invitationDocument(authority);
  writeFileSync(path, `${canonicalJson(invitation)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function onboardArgv(options: {
  configPath?: string;
  stateDirectory?: string;
  invitationPath: string;
  authorityPin: string;
  consent?: boolean;
}): string[] {
  return [
    'onboard',
    ...(options.configPath === undefined
      ? []
      : ['--config', options.configPath]),
    ...(options.stateDirectory === undefined
      ? []
      : ['--state-dir', options.stateDirectory]),
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
  const enrollmentIds: string[] = [];
  let enrollmentReceipt: OrganizationEnrollmentReceiptV1 | null = null;
  let accessState: OrganizationInstallationAccessStateV1 | null = null;
  let failNextEnrollmentBeforeCommit = false;
  let loseNextEnrollmentResponse = false;
  let currentNow = NOW;
  let doctorHealthy = true;
  let providerObservationCalls = 0;
  const adapterHealthChecks: string[] = [];
  const productWorkCalls: string[] = [];
  const adapterFactories = new ProductAdapterFactoryRegistry();
  for (const [kind, adapterId] of [
    ['meeting-source', 'granola'],
    ['decision-processor', 'structured-text'],
    ['delivery-surface', 'jsonl-outbox'],
    ['approval-surface', 'slack-reactions'],
  ] as const) {
    const healthCheck = async () => {
      adapterHealthChecks.push(`${kind}:${adapterId}`);
      return {
        status: doctorHealthy ? ('healthy' as const) : ('unavailable' as const),
        checked_at: currentNow,
      };
    };
    adapterFactories.register({
      kind,
      adapter_id: adapterId,
      validateStaticConfig: () => ({ ok: true, errors: [] }),
      create: (adapterConfig) => {
        const validateConfig = () => ({ ok: true, errors: [] });
        if (kind === 'meeting-source') {
          return {
            identity: {
              kind,
              adapter_id: adapterId,
              instance_id: adapterConfig.instance_id,
              version: 'onboard-doctor-test-v1',
            },
            validateConfig,
            healthCheck,
            pull: async () => {
              productWorkCalls.push('pull');
              throw new Error('onboarding test must not pull meetings');
            },
          } satisfies MeetingSourceAdapter;
        }
        if (kind === 'decision-processor') {
          return {
            identity: {
              kind,
              adapter_id: adapterId,
              instance_id: adapterConfig.instance_id,
              version: 'onboard-doctor-test-v1',
            },
            validateConfig,
            healthCheck,
            extract: async () => {
              productWorkCalls.push('extract');
              throw new Error('onboarding test must not extract decisions');
            },
          } satisfies DecisionProcessorAdapter;
        }
        if (kind === 'delivery-surface') {
          return {
            identity: {
              kind,
              adapter_id: adapterId,
              instance_id: adapterConfig.instance_id,
              version: 'onboard-doctor-test-v1',
            },
            destination: {
              adapter_id: adapterId,
              instance_id: adapterConfig.instance_id,
              external_id: 'onboard-test',
            },
            validateConfig,
            healthCheck,
            publish: async () => {
              productWorkCalls.push('publish');
              throw new Error('onboarding test must not publish delivery');
            },
          } satisfies DeliverySurfaceAdapter;
        }
        return {
          identity: {
            kind,
            adapter_id: adapterId,
            instance_id: adapterConfig.instance_id,
            version: 'onboard-doctor-test-v1',
          },
          validateConfig,
          healthCheck,
          review: async () => {
            productWorkCalls.push('review');
            throw new Error('onboarding test must not request approval');
          },
        } satisfies ApprovalSurfaceAdapter;
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
      if (failNextEnrollmentBeforeCommit) {
        failNextEnrollmentBeforeCommit = false;
        throw new Error('simulated crash before enrollment commit');
      }
      const completion = await authority.complete(body.enrollment_request);
      enrollmentIds.push(completion.enrollment_receipt.enrollment_id);
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
        currentNow,
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
      observeGranolaRecordOwner: async (_credential, ownerEmail) => {
        providerObservationCalls += 1;
        return {
          provider: 'granola',
          relationship: 'record_owner',
          subject: { kind: 'email', value: ownerEmail },
          assurance: 'provider_record_owner_observed',
          notes_examined: 2,
        };
      },
      readSlackCredential: async () => SLACK_TOKEN,
    },
    now: () => currentNow,
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
    enrollmentIds,
    adapterHealthChecks,
    productWorkCalls,
    providerObservationCalls: () => providerObservationCalls,
    setDoctorHealthy(value: boolean) {
      doctorHealthy = value;
    },
    setNow(value: string) {
      currentNow = value;
    },
    failNextEnrollmentBeforeCommit: () => {
      failNextEnrollmentBeforeCommit = true;
    },
    loseNextEnrollmentResponse: () => {
      loseNextEnrollmentResponse = true;
    },
    dependencies,
    transactionPath: join(
      root,
      'home',
      'Library',
      'Application Support',
      'Echo Brain',
      'onboarding',
      'active-transaction.v1.json',
    ),
    receiptsDirectory: join(
      root,
      'home',
      'Library',
      'Application Support',
      'Echo Brain',
      'onboarding',
      'receipts',
    ),
  };
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe('onboard CLI (RFC-0001 slice 1)', () => {
  it('derives one standard profile config and state path when targets are omitted', async () => {
    const test = fixture();
    const result = await command(
      onboardArgv({
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)['status']).toBe('ready');

    const identity = deriveOnboardingIdentity({
      authorityId: test.authority.descriptor.authority_id,
      organizationId: test.authority.descriptor.organization_id,
      membershipId: ORGANIZATION_IDS.membership,
      invitationCommandId: 'adm_00000000-0000-4000-8000-000000000001',
      enrollmentGrantSha256: organizationEnrollmentGrantSha256(GRANT),
    });
    const profileRoot = join(
      test.root,
      'home',
      'Library',
      'Application Support',
      'Echo Brain',
      'profiles',
      identity.profile_id,
    );
    expect(existsSync(join(profileRoot, 'config', 'runtime.json'))).toBe(true);
    expect(existsSync(join(profileRoot, 'state'))).toBe(true);
    expect(existsSync(test.transactionPath)).toBe(true);
  });

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
      local_mutation: true,
      central_enrollment: true,
      provider_connection: true,
      service_activation: true,
      product_work: true,
    });
    expect(test.enrollmentRequests).toHaveLength(1);
    expect(
      test.launchd.calls.filter((call) => call[0] === 'bootstrap'),
    ).toHaveLength(1);
    expect(test.adapterHealthChecks.sort()).toEqual([
      'approval-surface:slack-reactions',
      'decision-processor:structured-text',
      'delivery-surface:jsonl-outbox',
      'meeting-source:granola',
    ]);
    expect(test.productWorkCalls).toHaveLength(0);
    const transaction = parseJson(readFileSync(test.transactionPath, 'utf8'));
    expect(transaction['finished_at']).not.toBeNull();
    expect(existsSync(test.receiptsDirectory)).toBe(true);
  });

  it('ONB-PROMPT-01: hidden credential prompt labels reach the onboard terminal, not the captured bootstrap diagnostics', async () => {
    const test = fixture();
    test.dependencies.bootstrap = {
      observeGranolaRecordOwner:
        test.dependencies.bootstrap!.observeGranolaRecordOwner!,
    };
    const terminal = simulatedTerminalStdin([
      `${GRANOLA_TOKEN}\r`,
      `${SLACK_TOKEN}\r`,
    ]);
    try {
      const result = await command(
        onboardArgv({
          configPath: test.configPath,
          stateDirectory: test.stateDirectory,
          invitationPath: test.invitation,
          authorityPin: test.authority.pin,
        }),
        test.dependencies,
      );
      expect(result.status).toBe(0);
      expect(parseJson(result.stdout)['status']).toBe('ready');
      expect(result.stderr).toContain('Granola API token (hidden): ');
      expect(result.stderr).toContain('Slack bot token (hidden): ');
    } finally {
      terminal.restore();
    }
  });

  it('ONB-PROMPT-03: bracketed-paste wrapped credentials are read as the bare token', async () => {
    const test = fixture();
    test.dependencies.bootstrap = {
      observeGranolaRecordOwner:
        test.dependencies.bootstrap!.observeGranolaRecordOwner!,
    };
    // Terminal emulators wrap pastes in ESC[200~ ... ESC[201~ while
    // bracketed paste mode is active; the hidden reader must not retain the
    // markers in the secret.
    const terminal = simulatedTerminalStdin([
      `[200~${GRANOLA_TOKEN}[201~\r`,
      `[200~${SLACK_TOKEN}[201~\r`,
    ]);
    try {
      const result = await command(
        onboardArgv({
          configPath: test.configPath,
          stateDirectory: test.stateDirectory,
          invitationPath: test.invitation,
          authorityPin: test.authority.pin,
        }),
        test.dependencies,
      );
      expect(result.stderr).not.toContain('not a valid API token');
      expect(result.status).toBe(0);
      expect(parseJson(result.stdout)['status']).toBe('ready');
    } finally {
      terminal.restore();
    }
  });

  it('ONB-PROMPT-02: a stage_local failure surfaces its one-line reason on the onboard terminal while the public status stays interruption-shaped', async () => {
    const test = fixture();
    test.dependencies.bootstrap = {
      ...test.dependencies.bootstrap,
      observeGranolaRecordOwner: async () => {
        throw new Error('granola record owner observation refused');
      },
    };
    const result = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report['status']).toBe('retryable');
    expect(report['reason_code']).toBe('stage_local_interrupted');
    expect(result.stderr).toContain(
      'granola record owner observation refused',
    );
  });

  it('ONB-RESUME-01: resumes a lost enrollment response after invitation expiry with the same operation identity and exactly one enrollment', async () => {
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
      steps: Record<
        string,
        {
          state: string;
          operation_id: string | null;
          prepared_request_sha256: string | null;
        }
      >;
      effects: Record<string, boolean>;
    };
    expect(interrupted.steps['stage_local']!.state).toBe('prepared');
    expect(interrupted.effects['central_enrollment']).toBe(true);
    const preparedOperationId = interrupted.steps['stage_local']!.operation_id;
    const preparedRequestSha256 =
      interrupted.steps['stage_local']!.prepared_request_sha256;
    expect(preparedOperationId).not.toBeNull();
    expect(preparedRequestSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);

    test.setNow('2026-07-22T01:01:00.000Z');
    const second = await command(argv, test.dependencies);
    if (JSON.parse(second.stdout)['status'] !== 'ready') console.error('DEBUG-SECOND', second.stdout);
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(parseJson(second.stdout)['status']).toBe('ready');

    expect(test.enrollmentRequests).toHaveLength(2);
    expect(canonicalJson(test.enrollmentRequests[0])).toBe(
      canonicalJson(test.enrollmentRequests[1]),
    );
    expect(new Set(test.enrollmentIds).size).toBe(1);
    const resumed = parseJson(readFileSync(test.transactionPath, 'utf8')) as {
      steps: Record<
        string,
        {
          state: string;
          operation_id: string | null;
          prepared_request_sha256: string | null;
          accepted_receipt_sha256: string | null;
        }
      >;
    };
    expect(resumed.steps['stage_local']!.state).toBe('succeeded');
    expect(resumed.steps['stage_local']!.operation_id).toBe(
      preparedOperationId,
    );
    expect(resumed.steps['stage_local']!.prepared_request_sha256).toBe(
      preparedRequestSha256,
    );
    expect(resumed.steps['stage_local']!.accepted_receipt_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it('ONB-RESUME-01: replays the same prepared enrollment after a crash before Authority commit', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    test.failNextEnrollmentBeforeCommit();
    expect(parseJson((await command(argv, test.dependencies)).stdout)['status']).toBe(
      'retryable',
    );
    const interrupted = parseJson(
      readFileSync(test.transactionPath, 'utf8'),
    ) as {
      steps: Record<
        string,
        { operation_id: string | null; prepared_request_sha256: string | null }
      >;
    };
    const prepared = interrupted.steps['stage_local']!;

    expect(parseJson((await command(argv, test.dependencies)).stdout)['status']).toBe(
      'ready',
    );
    expect(test.enrollmentRequests).toHaveLength(2);
    expect(canonicalJson(test.enrollmentRequests[0])).toBe(
      canonicalJson(test.enrollmentRequests[1]),
    );
    expect(test.enrollmentIds).toHaveLength(1);
    const resumed = parseJson(readFileSync(test.transactionPath, 'utf8')) as {
      steps: Record<
        string,
        { operation_id: string | null; prepared_request_sha256: string | null }
      >;
    };
    expect(resumed.steps['stage_local']?.operation_id).toBe(prepared.operation_id);
    expect(resumed.steps['stage_local']?.prepared_request_sha256).toBe(
      prepared.prepared_request_sha256,
    );
  });

  it('ONB-RESUME-01: reconciles a lost service-creation response without creating a second service identity', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    test.launchd.beforeBootstrap(() => {
      expect(readdirSync(test.receiptsDirectory)).toHaveLength(1);
    });
    test.launchd.loseNextBootstrapResponse();

    const first = await command(argv, test.dependencies);
    expect(first.status).toBe(0);
    expect(parseJson(first.stdout)['status']).toBe('retryable');
    const interrupted = parseJson(
      readFileSync(test.transactionPath, 'utf8'),
    ) as {
      steps: Record<
        string,
        {
          state: string;
          operation_id: string | null;
          prepared_request_sha256: string | null;
        }
      >;
      finished_at: string | null;
      terminal_result: string | null;
    };
    const prepared = interrupted.steps['activate']!;
    expect(interrupted.finished_at).not.toBeNull();
    expect(interrupted.terminal_result).toBe('ready');
    expect(interrupted.steps['service_install']!.state).toBe('succeeded');
    expect(prepared.state).toBe('succeeded');
    expect(prepared.operation_id).not.toBeNull();
    expect(prepared.prepared_request_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );

    const second = await command(argv, test.dependencies);
    expect(second.status).toBe(0);
    expect(parseJson(second.stdout)['status']).toBe('ready');
    const serviceBootstraps = test.launchd.calls.filter(
      (call) => call[0] === 'bootstrap',
    );
    expect(serviceBootstraps).toHaveLength(1);
    expect(new Set(serviceBootstraps.map((call) => call.join('\0'))).size).toBe(1);
    const resumed = parseJson(readFileSync(test.transactionPath, 'utf8')) as {
      steps: Record<
        string,
        {
          state: string;
          operation_id: string | null;
          accepted_receipt_sha256: string | null;
        }
      >;
    };
    expect(resumed.steps['activate']!.state).toBe('succeeded');
    expect(resumed.steps['activate']!.operation_id).toBe(
      prepared.operation_id,
    );
    expect(resumed.steps['activate']!.accepted_receipt_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it('ONB-RESUME-01: retries one service identity after a crash before service creation', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    test.launchd.beforeBootstrap(() => {
      expect(readdirSync(test.receiptsDirectory)).toHaveLength(1);
    });
    test.launchd.failNextBootstrapBeforeCommit();
    expect(parseJson((await command(argv, test.dependencies)).stdout)['status']).toBe(
      'retryable',
    );
    const interrupted = parseJson(
      readFileSync(test.transactionPath, 'utf8'),
    ) as {
      steps: Record<
        string,
        { operation_id: string | null; prepared_request_sha256: string | null }
      >;
    };
    const prepared = interrupted.steps['activate']!;

    expect(parseJson((await command(argv, test.dependencies)).stdout)['status']).toBe(
      'ready',
    );
    const serviceAttempts = test.launchd.calls.filter(
      (call) => call[0] === 'bootstrap',
    );
    expect(serviceAttempts).toHaveLength(2);
    expect(new Set(serviceAttempts.map((call) => call.join('\0'))).size).toBe(1);
    const resumed = parseJson(readFileSync(test.transactionPath, 'utf8')) as {
      steps: Record<
        string,
        { operation_id: string | null; prepared_request_sha256: string | null }
      >;
    };
    expect(resumed.steps['activate']?.operation_id).toBe(
      prepared.operation_id,
    );
    expect(resumed.steps['activate']?.prepared_request_sha256).toBe(
      prepared.prepared_request_sha256,
    );
  });

  it('ONB-PREAUTH-01: a wrong pin is a closed denial with no Authority contact and no replayable state', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: `sha256:${'f'.repeat(64)}`,
      consent: false,
    });
    const first = await command(argv, test.dependencies);
    expect(first.status).toBe(1);
    expect(parseJson(first.stdout)['status']).toBe('denied');
    expect(test.authorityPaths).toHaveLength(0);
    expect(test.launchd.calls).toHaveLength(0);
    expect(existsSync(test.transactionPath)).toBe(false);

    const second = await command(argv, test.dependencies);
    expect(second.status).toBe(1);
    expect(parseJson(second.stdout)['status']).toBe('denied');
    expect(test.authorityPaths).toHaveLength(0);
    expect(test.enrollmentRequests).toHaveLength(0);
    expect(existsSync(test.transactionPath)).toBe(false);

    const corrected = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );
    expect(parseJson(corrected.stdout)['status']).toBe('ready');
  });

  it('ONB-PREAUTH-01: refuses expiry and descriptor mismatch before local or provider effects', async () => {
    const expired = fixture();
    const expiredDocument = JSON.parse(
      readFileSync(expired.invitation, 'utf8'),
    ) as Record<string, unknown> & {
      issued: Record<string, unknown>;
    };
    expiredDocument.issued['issued_at'] = '2026-07-21T22:00:00.000Z';
    expiredDocument.issued['expires_at'] = '2026-07-21T23:00:00.000Z';
    writeFileSync(expired.invitation, `${canonicalJson(expiredDocument)}\n`, {
      mode: 0o600,
    });
    const expiredResult = await command(
      onboardArgv({
        configPath: expired.configPath,
        stateDirectory: expired.stateDirectory,
        invitationPath: expired.invitation,
        authorityPin: expired.authority.pin,
      }),
      expired.dependencies,
    );
    expect(parseJson(expiredResult.stdout)).toMatchObject({
      status: 'denied',
      reason_code: 'invitation_expired',
    });
    expect(existsSync(expired.transactionPath)).toBe(false);
    expect(existsSync(expired.configPath)).toBe(false);
    expect(expired.providerObservationCalls()).toBe(0);
    expect(expired.authorityPaths).toHaveLength(0);
    expect(expired.launchd.calls).toHaveLength(0);

    const mismatch = fixture();
    const alienAuthority = new TestAuthority(2);
    let descriptorReads = 0;
    const mismatchResult = await command(
      onboardArgv({
        configPath: mismatch.configPath,
        stateDirectory: mismatch.stateDirectory,
        invitationPath: mismatch.invitation,
        authorityPin: mismatch.authority.pin,
      }),
      {
        ...mismatch.dependencies,
        organization: {
          ...mismatch.dependencies.organization,
          fetch: async () => {
            descriptorReads += 1;
            return Response.json({
              authority_descriptor: alienAuthority.descriptor,
            });
          },
        },
      },
    );
    expect(parseJson(mismatchResult.stdout)).toMatchObject({
      status: 'denied',
      reason_code: 'authority_descriptor_mismatch',
    });
    expect(descriptorReads).toBe(1);
    expect(existsSync(mismatch.transactionPath)).toBe(false);
    expect(existsSync(mismatch.configPath)).toBe(false);
    expect(mismatch.providerObservationCalls()).toBe(0);
    expect(mismatch.enrollmentRequests).toHaveLength(0);
    expect(mismatch.launchd.calls).toHaveLength(0);
  });

  it('ONB-PREAUTH-01: a forged matching pre-enrollment journal cannot reach the Authority or any effect boundary', async () => {
    const test = fixture();
    const wrongPin = `sha256:${'f'.repeat(64)}`;
    const invitationDoc = invitationDocument(test.authority);
    const identity = deriveOnboardingIdentity({
      authorityId: invitationDoc.authority_id,
      organizationId: invitationDoc.organization_id,
      membershipId: invitationDoc.membership_id,
      invitationCommandId: invitationDoc.command_id,
      enrollmentGrantSha256: invitationDoc.enrollment_grant_sha256,
    });
    const forgedInputSha256 = onboardingDocumentSha256({
      schema_version: 1,
      kind: 'echo-onboarding-input-binding',
      flow_id: identity.flow_id,
      profile_id: identity.profile_id,
      authority_base_url: invitationDoc.authority_base_url,
      authority_id: invitationDoc.authority_id,
      organization_id: invitationDoc.organization_id,
      membership_id: invitationDoc.membership_id,
      principal_id: invitationDoc.issued.principal_id,
      invitation_command_id: invitationDoc.command_id,
      enrollment_grant_sha256: invitationDoc.enrollment_grant_sha256,
      authority_pin_sha256: wrongPin,
      authority_ca_sha256: null,
      invitation_sha256: onboardingDocumentSha256(invitationDoc),
      product_version: '0.1.0-internal.test',
      source_sha: '1'.repeat(40),
      source_kind: 'materialized-commit',
      platform: 'darwin',
      architecture: 'arm64',
    });
    let forged = createOnboardingTransaction({
      identity,
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      inputSha256: forgedInputSha256,
      now: NOW,
    });
    for (const step of ['classify', 'verify_trust'] as const) {
      forged = transitionOnboardingStep(forged, step, {
        to: 'prepared',
        operationId: `forged-${step}`,
        preparedRequestSha256: `sha256:${'d'.repeat(64)}`,
        now: NOW,
      });
      forged = transitionOnboardingStep(forged, step, {
        to: 'succeeded',
        acceptedReceiptSha256: `sha256:${'e'.repeat(64)}`,
        now: NOW,
      });
    }
    forged = transitionOnboardingStep(forged, 'confirm_human', {
      to: 'waiting_for_user',
      now: NOW,
    });
    mkdirSync(dirname(test.transactionPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(test.transactionPath, canonicalJson(forged), {
      mode: 0o600,
    });

    const denied = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: wrongPin,
      }),
      test.dependencies,
    );
    expect(denied.status).toBe(1);
    const report = parseJson(denied.stdout);
    expect(report['reason_code']).toBe('authority_pin_mismatch');
    expect(report['status']).toBe('denied');
    expect(test.authorityPaths).toHaveLength(0);
    expect(test.enrollmentRequests).toHaveLength(0);
    expect(test.launchd.calls).toHaveLength(0);
    expect(existsSync(test.configPath)).toBe(false);
    expect(existsSync(test.stateDirectory)).toBe(false);

    // The same forged journal under a corrected pin is a different input
    // binding: zero-effect state is replaced, never trusted, and the fresh
    // flow re-proves trust end-to-end with its own operation identities.
    const corrected = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );
    expect(corrected.status).toBe(0);
    expect(parseJson(corrected.stdout)['status']).toBe('ready');
    expect(test.enrollmentRequests).toHaveLength(1);
    const replaced = parseJson(
      readFileSync(test.transactionPath, 'utf8'),
    ) as { steps: Record<string, { operation_id: string | null }> };
    expect(replaced.steps['classify']!.operation_id).not.toBe('forged-classify');
  });

  it('preserves a nonempty state residue before publishing an onboarding transaction', async () => {
    const test = fixture();
    mkdirSync(test.stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(test.stateDirectory, 'unowned-state'), 'old bytes', {
      mode: 0o600,
    });
    const result = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );
    expect(parseJson(result.stdout)).toMatchObject({
      status: 'preserved',
      reason_code: 'incomplete_config_state_pair',
    });
    expect(existsSync(test.transactionPath)).toBe(false);
    expect(test.providerObservationCalls()).toBe(0);
    expect(test.enrollmentRequests).toHaveLength(0);
    expect(test.launchd.calls).toHaveLength(0);
  });

  it('quarantines every product-work ingress until the ready receipt is durable', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
    });
    test.setDoctorHealthy(false);
    expect(parseJson((await command(argv, test.dependencies)).stdout)['status']).toBe(
      'retryable',
    );
    expect(readdirSync(test.receiptsDirectory)).toHaveLength(0);
    expect(test.launchd.calls.filter((call) => call[0] === 'bootstrap')).toHaveLength(0);
    expect(test.productWorkCalls).toHaveLength(0);
    const authorityCallsBeforeForbidden = test.authorityPaths.length;

    for (const forbidden of [
      ['run-once', '--config', test.configPath],
      ['service', 'start', '--config', test.configPath],
      ['service-run', '--config', test.configPath],
      [
        'organization',
        'readable-search',
        '--config',
        test.configPath,
        '--query',
        'hidden',
      ],
    ]) {
      expect((await command(forbidden, test.dependencies)).status).toBe(1);
    }
    let updateCalls = 0;
    expect(
      (
        await command(
          [
            'update',
            'apply',
            '--channel',
            'internal-live',
            '--config',
            test.configPath,
          ],
          {
            ...test.dependencies,
            internalLive: {
              execute: async () => {
                updateCalls += 1;
                throw new Error('update must remain quarantined');
              },
            },
          },
        )
      ).status,
    ).toBe(1);
    expect(updateCalls).toBe(0);
    expect(test.authorityPaths).toHaveLength(authorityCallsBeforeForbidden);
    expect(test.productWorkCalls).toHaveLength(0);
    expect(test.launchd.calls.filter((call) => call[0] === 'bootstrap')).toHaveLength(0);

    test.setDoctorHealthy(true);
    expect(parseJson((await command(argv, test.dependencies)).stdout)['status']).toBe(
      'ready',
    );
    expect(readdirSync(test.receiptsDirectory)).toHaveLength(1);
    expect(test.launchd.calls.filter((call) => call[0] === 'bootstrap')).toHaveLength(1);
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
    expect(test.authorityPaths).toEqual(['/v1/authority-descriptor']);
    expect(test.enrollmentRequests).toHaveLength(0);
    expect(test.providerObservationCalls()).toBe(0);
    expect(test.launchd.calls).toHaveLength(0);
    expect(existsSync(test.transactionPath)).toBe(false);
  });

  it('accepts a corrected target after a zero-effect consent pause', async () => {
    const test = fixture();
    const pausedArgv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
      consent: false,
    });
    expect((await command(pausedArgv, test.dependencies)).status).toBe(0);

    const changed = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: join(test.root, 'other-state'),
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      test.dependencies,
    );
    expect(changed.status).toBe(0);
    expect(parseJson(changed.stdout)['status']).toBe('ready');
    expect(test.enrollmentRequests).toHaveLength(1);
  });

  it('accepts a verified package change after a zero-effect consent pause', async () => {
    const test = fixture();
    const argv = onboardArgv({
      configPath: test.configPath,
      stateDirectory: test.stateDirectory,
      invitationPath: test.invitation,
      authorityPin: test.authority.pin,
      consent: false,
    });
    expect((await command(argv, test.dependencies)).status).toBe(0);

    const changed = await command(
      onboardArgv({
        configPath: test.configPath,
        stateDirectory: test.stateDirectory,
        invitationPath: test.invitation,
        authorityPin: test.authority.pin,
      }),
      {
      ...test.dependencies,
      operator: {
        ...test.dependencies.operator,
        productVersion: '0.1.0-internal.changed',
      },
      },
    );
    expect(changed.status).toBe(0);
    expect(parseJson(changed.stdout)['status']).toBe('ready');
    expect(test.enrollmentRequests).toHaveLength(1);
  });

  it('preserves an effectful flow against a changed target or build', async () => {
    const target = fixture();
    const argv = onboardArgv({
      configPath: target.configPath,
      stateDirectory: target.stateDirectory,
      invitationPath: target.invitation,
      authorityPin: target.authority.pin,
    });
    target.failNextEnrollmentBeforeCommit();
    expect(parseJson((await command(argv, target.dependencies)).stdout)['status']).toBe(
      'retryable',
    );
    const changedTarget = await command(
      onboardArgv({
        configPath: target.configPath,
        stateDirectory: join(target.root, 'other-state'),
        invitationPath: target.invitation,
        authorityPin: target.authority.pin,
      }),
      target.dependencies,
    );
    expect(parseJson(changedTarget.stdout)).toMatchObject({
      status: 'preserved',
      reason_code: 'onboarding_transaction_conflict',
    });

    const changedBuild = await command(argv, {
      ...target.dependencies,
      operator: {
        ...target.dependencies.operator,
        productVersion: '0.1.0-internal.changed',
      },
    });
    expect(parseJson(changedBuild.stdout)).toMatchObject({
      status: 'preserved',
      reason_code: 'onboarding_transaction_conflict',
    });
    expect(target.enrollmentRequests).toHaveLength(1);
    expect(target.launchd.calls.filter((call) => call[0] === 'bootstrap')).toHaveLength(0);
  });
});
