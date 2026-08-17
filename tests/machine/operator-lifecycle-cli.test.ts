import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ApprovalRequest,
  MeetingSourceAdapter,
} from '@echo-brain/organization-authority/processing/core/index.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import {
  runProductCli,
  type ProductCliDependencies,
} from '../../src/product/cli.js';
import { DecisionNodeStore } from '../../src/product/approval/decision-node-store.js';
import { createDefaultAdapterFactories } from '../../src/product/default-adapters.js';
import { loadProductRuntimeConfig } from '../../src/product/config.js';
import { canonicalProductConfigSha256 } from '../../src/product/lifecycle-lock.js';
import { reviewerApprovalPresentationRenderer } from '../../src/product/organization/record/adapters/reviewer-presentation-renderer.js';
import { resolveProductStatePaths } from '../../src/product/paths.js';
import { SqliteOrganizationStateStore } from '../../src/product/organization/state/sqlite-organization-state-store.js';
import {
  MAX_TTL_MS,
  NOW,
  TestAuthority,
  TestInstallationSigner,
  signedEnrollmentRequest,
} from '../support/local-organization-fixtures.js';
import type {
  LaunchctlResult,
  LaunchctlRunner,
} from '../../src/product/launchd-service.js';

const roots: string[] = [];
const fixedTime = '2026-07-17T20:00:00.000Z';

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

function fakeLaunchd(): FakeLaunchd {
  let loaded = false;
  let running = false;
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (input) => {
    const args = [...input];
    calls.push(args);
    let result: LaunchctlResult;
    if (args[0] === 'print') {
      result = loaded
        ? {
            status: 0,
            stdout: running
              ? 'state = running\npid = 4242\n'
              : 'state = exited\n',
            stderr: '',
          }
        : { status: 113, stdout: '', stderr: 'Could not find service' };
    } else if (args[0] === 'bootstrap') {
      loaded = true;
      running = true;
      result = { status: 0, stdout: '', stderr: '' };
    } else if (args[0] === 'kickstart') {
      loaded = true;
      running = true;
      result = { status: 0, stdout: '', stderr: '' };
    } else if (args[0] === 'bootout') {
      loaded = false;
      running = false;
      result = { status: 0, stdout: '', stderr: '' };
    } else {
      result = { status: 64, stdout: '', stderr: 'unexpected launchctl call' };
    }
    return result;
  };
  return { runner, calls };
}

function fixtures(root: string, credentialRef?: string) {
  const stateDirectory = join(root, 'state');
  const configPath = join(root, 'runtime.json');
  const cliPath = join(root, 'echo-brain-cli.js');
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        lane: 'team-product',
        state_dir: stateDirectory,
        meeting_sources: [
          {
            adapter_id: 'fixture-meetings',
            instance_id: 'primary',
            ...(credentialRef === undefined
              ? {}
              : { credential_ref: credentialRef }),
            settings: {},
          },
        ],
        decision_processor: {
          adapter_id: 'structured-text',
          instance_id: 'primary',
          settings: {},
        },
        delivery_surfaces: [
          {
            adapter_id: 'jsonl-outbox',
            instance_id: 'local',
            settings: {
              path: join(stateDirectory, 'outbox.jsonl'),
              destination_id: 'local-outbox',
            },
          },
        ],
        approval_mode: 'manual',
      },
      null,
      2,
    )}\n`,
  );
  return { stateDirectory, configPath, cliPath };
}

function adapterFactories(
  health: 'healthy' | 'unavailable' = 'healthy',
): ProductAdapterFactoryRegistry {
  const factories = createDefaultAdapterFactories();
  factories.register({
    kind: 'meeting-source',
    adapter_id: 'fixture-meetings',
    validateStaticConfig: () => ({ ok: true, errors: [] }),
    create: (config): MeetingSourceAdapter => ({
      identity: {
        kind: 'meeting-source',
        adapter_id: config.adapter_id,
        instance_id: config.instance_id,
        version: '1.0.0',
      },
      validateConfig: () => ({ ok: true, errors: [] }),
      healthCheck: async () => ({
        status: health,
        checked_at: fixedTime,
        ...(health === 'healthy' ? {} : { message: 'fixture unavailable' }),
      }),
      pull: async () => ({ meetings: [] }),
    }),
  });
  return factories;
}

function rewriteConfig(
  configPath: string,
  changes: Record<string, unknown>,
): void {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, ...changes }, null, 2)}\n`,
  );
}

function rewriteDecisionProcessor(
  configPath: string,
  adapterId: string,
): void {
  rewriteConfig(configPath, {
    decision_processor: {
      adapter_id: adapterId,
      instance_id: 'primary',
      settings: {},
    },
  });
}

/**
 * Points the fixture config at Slack for both delivery and approval, with the
 * bundled adapters' own static requirements satisfied so the channel rule is
 * what decides each command.
 */
function rewriteSlackSurfaces(
  configPath: string,
  stateDirectory: string,
  deliveryChannel: string,
  overrides: Record<string, unknown> = {},
): void {
  const credential_ref = `file:${slackCredentialPath(stateDirectory)}`;
  rewriteConfig(configPath, {
    delivery_surfaces: [
      {
        adapter_id: 'slack',
        instance_id: 'team-decisions',
        credential_ref,
        settings: { channel_id: deliveryChannel },
      },
    ],
    approval_mode: 'adapter',
    approval_surface: {
      adapter_id: 'slack-reactions',
      instance_id: 'internal-approvals',
      credential_ref,
      settings: {
        channel_id: 'C0REVIEW01',
        reviewer: { slack_user_id: 'U0REVIEWER', name: 'founder' },
      },
    },
    ...overrides,
  });
}

function slackCredentialPath(stateDirectory: string): string {
  return join(stateDirectory, 'credentials', 'slack-bot-token');
}

function configureRestrictedReviewerApproval(
  configPath: string,
  stateDirectory: string,
): void {
  rewriteConfig(configPath, {
    approval_mode: 'adapter',
    approval_surface: {
      adapter_id: 'slack-reactions',
      instance_id: 'internal-approvals',
      credential_ref: `file:${slackCredentialPath(stateDirectory)}`,
      settings: {
        channel_id: 'C0REVIEW01',
        reviewer: { slack_user_id: 'U0REVIEWER', name: 'founder' },
        approve_reaction: 'white_check_mark',
        reject_reaction: 'x',
        presentation_mode: 'restricted-reviewer-v1',
      },
    },
  });
}

function configureOrganizationMemberApproval(
  configPath: string,
  stateDirectory: string,
): void {
  configureRestrictedReviewerApproval(configPath, stateDirectory);
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const approvalSurface = config['approval_surface'] as Record<string, unknown>;
  const settings = approvalSurface['settings'] as Record<string, unknown>;
  settings['presentation_mode'] = 'organization-member-readable-v1';
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

function configureManualApproval(configPath: string): void {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  config['approval_mode'] = 'manual';
  delete config['approval_surface'];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function pendingRestrictedReviewerRequest(): ApprovalRequest {
  return {
    processing_key: 'source:instance:item:revision:processor:instance:version',
    requested_at: '2026-08-11T11:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      title: 'Planning',
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'source',
          instance_id: 'instance',
          version: '1',
        },
        external_id: 'item',
        canonical_revision: 'revision',
        observed_at: '2026-08-11T10:15:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-08-11T10:15:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'meeting-1',
      meeting_revision: 'revision',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'processor',
        instance_id: 'instance',
        version: '1',
      },
      generated_at: '2026-08-11T10:30:00.000Z',
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: { id: 'meeting-1', title: 'Planning', participants: [] },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'revision',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'processor',
          instance_id: 'instance',
          version: '1',
        },
        generated_at: '2026-08-11T10:30:00.000Z',
      },
    },
  };
}

async function seedFrozenRestrictedReviewerCard(
  stateDirectory: string,
  credential: string,
  adapterVersion = '1.0.0',
): Promise<void> {
  const store = new DecisionNodeStore(stateDirectory, { now: () => fixedTime });
  const request = pendingRestrictedReviewerRequest();
  const node = await store.ensureRequested(request);
  await store.freezeApprovalPresentationContract({
    approvalId: node.approval_id,
    contract: {
      schema_version: 1,
      kind: 'echo-slack-approval-presentation-contract',
      mode: 'restricted-reviewer-v1',
      adapter_id: 'slack-reactions',
      adapter_instance_id: 'internal-approvals',
      adapter_version: adapterVersion,
      channel_id: 'C0REVIEW01',
      reviewer_slack_user_id: 'U0REVIEWER',
      reviewer_name: 'founder',
      credential_ref: `file:${slackCredentialPath(stateDirectory)}`,
      credential_fingerprint_sha256:
        reviewerApprovalPresentationRenderer.credentialFingerprint(credential),
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
      reviewer_release_draft_sha256: `sha256:${'a'.repeat(64)}`,
      approval_presentation_sha256: `sha256:${'b'.repeat(64)}`,
    },
  });
}

function stubSlackProvider(calls: string[]): typeof fetch {
  return async (input) => {
    const method = new URL(String(input)).pathname.split('/').pop();
    calls.push(method ?? '');
    if (method !== 'auth.test') {
      throw new Error(`unexpected Slack API method: ${method}`);
    }
    return Response.json({ ok: true, user_id: 'B01' });
  };
}

async function seedEnrolledOrganizationState(
  stateDirectory: string,
): Promise<TestInstallationSigner> {
  const authority = new TestAuthority();
  const signer = new TestInstallationSigner();
  const request = await signedEnrollmentRequest(authority, signer);
  const completion = await authority.complete(request);
  const databasePath = resolveProductStatePaths(stateDirectory).database;
  const state = new SqliteOrganizationStateStore(databasePath);
  try {
    state.pinAuthority(authority.descriptor, authority.pin);
    state.saveAuthorityConnection({
      authority_id: authority.descriptor.authority_id,
      organization_id: authority.descriptor.organization_id,
      authority_base_url: 'https://authority.example.test',
    });
    state.saveEnrollmentRequest(request);
    state.saveEnrollmentReceipt(completion.enrollment_receipt);
    state.acceptAccessState(completion.access_state, {
      now: NOW,
      maximum_active_ttl_ms: MAX_TTL_MS,
    });
  } finally {
    state.close();
  }
  return signer;
}

function sqliteLogicalSnapshot(databasePath: string): Buffer {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma('query_only = ON');
    database.exec('BEGIN');
    const snapshot = database.serialize();
    database.exec('COMMIT');
    return snapshot;
  } finally {
    database.close();
  }
}

/**
 * Strips the recorded build identity, and optionally re-records the current
 * configuration, so reconfigure sees a manifest that predates them and re-pins.
 * Returns the manifest path.
 */
function legacyManifest(stateDirectory: string, configPath?: string): string {
  const path = join(
    stateDirectory,
    'manifests',
    'operator-installation.v1.json',
  );
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  delete record['source_sha'];
  delete record['source_kind'];
  if (configPath !== undefined) {
    record['config_sha256'] = canonicalProductConfigSha256(
      loadProductRuntimeConfig(configPath),
    );
  }
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function cliDependencies(root: string, cliPath: string, launchd: FakeLaunchd) {
  return {
    classifyStateFilesystem: async () => ({
      kind: 'local' as const,
      raw: 'apfs',
    }),
    adapterFactories: adapterFactories(),
    now: () => fixedTime,
    operator: {
      launchctl: launchd.runner,
      platform: 'darwin' as const,
      architecture: 'arm64',
      uid: statSync(root).uid,
      homeDirectory: join(root, 'home'),
      nodePath: realpathSync(process.execPath),
      nodeVersion: 'v22.22.1',
      cliPath,
      buildIdentity: {
        source_sha: '1'.repeat(40),
        source_kind: 'materialized-commit' as const,
      },
    },
  };
}

/**
 * A canonical private root carrying the fixture config and CLI, plus the
 * dependencies that drive them. Every lifecycle test starts from one.
 */
function installation(
  prefix: string,
  launchd: FakeLaunchd = fakeLaunchd(),
  credentialRef?: string,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  const fixture = fixtures(root, credentialRef);
  return {
    ...fixture,
    root,
    launchd,
    dependencies: cliDependencies(root, fixture.cliPath, launchd),
  };
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

/** A command that must succeed; failures report the CLI's own diagnosis. */
async function expectOk(
  argv: readonly string[],
  dependencies: ProductCliDependencies,
) {
  const result = await command(argv, dependencies);
  expect(result.status, result.stderr).toBe(0);
  return result;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('operator onboarding and lifecycle CLI', () => {
  it('initializes private operator state idempotently', async () => {
    const { dependencies, ...fixture } = installation('echo-init-');

    const init = ['init', '--config', fixture.configPath];
    const first = await expectOk(init, dependencies);
    const second = await expectOk(init, dependencies);

    expect(JSON.parse(first.stdout).created).toBe(true);
    expect(JSON.parse(second.stdout).created).toBe(false);
    expect(JSON.parse(first.stdout).installation).toMatchObject({
      product_version: expect.any(String),
      source_sha: '1'.repeat(40),
      source_kind: 'materialized-commit',
    });
    expect(statSync(fixture.stateDirectory).mode & 0o777).toBe(0o700);
    expect(
      statSync(
        join(
          fixture.stateDirectory,
          'manifests',
          'operator-installation.v1.json',
        ),
      ).mode & 0o777,
    ).toBe(0o600);
  });

  it('upgrades a legacy installation manifest with exact build identity', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-build-identity-upgrade-',
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);

    legacyManifest(fixture.stateDirectory);

    const result = await expectOk(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      updated: true,
      installation: {
        source_sha: '1'.repeat(40),
        source_kind: 'materialized-commit',
      },
    });
  });

  it('requires a private readable credential file before installing the service', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-file-credential-')),
    );
    roots.push(root);
    const credentialPath = join(
      root,
      'state',
      'credentials',
      'meeting-source-api-key',
    );
    const { configPath, stateDirectory, cliPath } = fixtures(
      root,
      `file:${credentialPath}`,
    );
    const launchd = fakeLaunchd();
    const dependencies = cliDependencies(root, cliPath, launchd);
    await expectOk(['init', '--config', configPath], dependencies);

    const missing = await command(
      ['service', 'install', '--config', configPath],
      dependencies,
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('is unavailable or insecure');
    expect(launchd.calls.some((args) => args[0] === 'bootstrap')).toBe(false);

    mkdirSync(join(stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(credentialPath, 'synthetic-token\n', { mode: 0o600 });
    await expectOk(['service', 'install', '--config', configPath], dependencies);
    const manifest = JSON.parse(
      readFileSync(
        join(stateDirectory, 'manifests', 'operator-installation.v1.json'),
        'utf8',
      ),
    );
    expect(readFileSync(manifest.service.plist_path, 'utf8')).not.toContain(
      'synthetic-token',
    );
  });

  it('installs, starts, inspects, stops, restarts, and uninstalls without touching host launchd', async () => {
    const { dependencies, launchd, ...fixture } = installation('echo-service-');
    await expectOk(['init', '--config', fixture.configPath], dependencies);

    const installed = await expectOk(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(installed.stdout)).toMatchObject({
      action: 'install',
      installed: true,
      changed: true,
      service: { loaded: true, running: true },
    });
    const plistPath = JSON.parse(
      readFileSync(
        join(
          fixture.stateDirectory,
          'manifests',
          'operator-installation.v1.json',
        ),
        'utf8',
      ),
    ).service.plist_path;
    const plist = readFileSync(plistPath, 'utf8');
    expect(statSync(plistPath).mode & 0o777).toBe(0o600);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<string>service-run</string>');
    expect(plist).toContain(fixture.configPath);
    expect(plist).toContain(fixture.stateDirectory);

    const repeated = await command(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(repeated.stdout).changed).toBe(false);
    expect(
      launchd.calls.filter((args) => args[0] === 'bootstrap'),
    ).toHaveLength(1);

    const status = await command(
      ['status', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(status.stdout)).toMatchObject({
      initialized: true,
      package_identity: {
        source_sha: '1'.repeat(40),
        source_kind: 'materialized-commit',
      },
      service: { installed: true, loaded: true, running: true },
    });

    await expectOk(
      ['service', 'stop', '--config', fixture.configPath],
      dependencies,
    );
    const started = await command(
      ['service', 'start', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(started.stdout).service.running).toBe(true);
    await expectOk(
      ['service', 'restart', '--config', fixture.configPath],
      dependencies,
    );
    const restartCalls = launchd.calls.slice(
      launchd.calls.map((args) => args[0]).lastIndexOf('bootout'),
    );
    expect(restartCalls.map((args) => args[0])).toEqual(
      expect.arrayContaining(['bootout', 'bootstrap']),
    );
    expect(
      launchd.calls.some(
        (args) => args[0] === 'kickstart' && args.includes('-k'),
      ),
    ).toBe(false);

    const removed = await expectOk(
      ['service', 'uninstall', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(removed.stdout)).toMatchObject({
      action: 'uninstall',
      installed: false,
      service: { loaded: false, running: false },
    });
    expect(existsSync(plistPath)).toBe(false);
  });

  it('locks before creating state and rejects a service restart after config drift', async () => {
    const { dependencies: base, ...fixture } = installation(
      'echo-service-identity-',
    );
    const observations: boolean[] = [];
    const dependencies = {
      ...base,
      acquireLifecycleLock: async () => {
        observations.push(existsSync(fixture.stateDirectory));
        return async () => undefined;
      },
    };

    await expectOk(['init', '--config', fixture.configPath], dependencies);
    expect(observations).toEqual([false, false]);
    await expectOk(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );

    const changed = JSON.parse(
      readFileSync(fixture.configPath, 'utf8'),
    ) as Record<string, unknown>;
    changed['cycle_interval_ms'] = 90_000;
    writeFileSync(fixture.configPath, `${JSON.stringify(changed, null, 2)}\n`);
    const serviceRun = await command(
      ['service-run', '--config', fixture.configPath],
      dependencies,
    );
    expect(serviceRun.status).toBe(1);
    expect(serviceRun.stderr).toContain('installation manifest does not match');

    await expectOk(
      ['service', 'stop', '--config', fixture.configPath],
      dependencies,
    );
    const reconfigured = await expectOk(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(reconfigured.stdout)).toMatchObject({
      ok: true,
      command: 'reconfigure',
      updated: true,
    });
    await expectOk(
      ['service', 'start', '--config', fixture.configPath],
      dependencies,
    );
  });

  it('proves the configured adapters offline before re-pinning the installation', async () => {
    const { dependencies, ...fixture } = installation('echo-repin-adapters-');
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    const installationPath = legacyManifest(fixture.stateDirectory);
    const before = readFileSync(installationPath, 'utf8');

    // A bundled processor whose own static validator rejects this settings
    // block. The static proof itself -- aggregation across every configured
    // adapter, failing closed without a validator, and never calling `create`
    // -- is covered by tests/product/adapter-factories.test.ts; what matters
    // here is that reconfigure runs it before rewriting anything.
    rewriteDecisionProcessor(fixture.configPath, 'llm');
    const refused = await command(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );
    expect(refused.status).toBe(1);
    const failure = JSON.parse(refused.stderr);
    expect(failure.code).toBe('adapter_unavailable');
    expect(failure.error).toContain(
      'reconfigure was refused before the installation manifest was updated',
    );
    expect(failure.error).toContain('settings.model is required');
    expect(readFileSync(installationPath, 'utf8')).toBe(before);
  });

  it('refuses to pin a new approval mode while an old-mode frozen card is unresolved', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-reconfigure-frozen-mode-',
    );
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      slackCredentialPath(fixture.stateDirectory),
      'xoxb-matching\n',
      { mode: 0o600 },
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    await seedFrozenRestrictedReviewerCard(
      fixture.stateDirectory,
      'xoxb-matching',
    );
    const installationPath = join(
      fixture.stateDirectory,
      'manifests',
      'operator-installation.v1.json',
    );
    const before = readFileSync(installationPath, 'utf8');

    configureOrganizationMemberApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    const refused = await command(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );

    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      code: 'installation_conflict',
      error: expect.stringContaining(
        'holds an unresolved restricted-reviewer-v1 presentation contract',
      ),
    });
    expect(readFileSync(installationPath, 'utf8')).toBe(before);
  });

  it('refuses a package-only re-pin when its approval adapter version cannot resume a frozen card', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-repin-frozen-adapter-version-',
    );
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      slackCredentialPath(fixture.stateDirectory),
      'xoxb-matching\n',
      { mode: 0o600 },
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    await seedFrozenRestrictedReviewerCard(
      fixture.stateDirectory,
      'xoxb-matching',
      '0.9.0',
    );
    const installationPath = legacyManifest(
      fixture.stateDirectory,
      fixture.configPath,
    );
    const before = readFileSync(installationPath, 'utf8');

    const refused = await command(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );

    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      code: 'installation_conflict',
      error: expect.stringContaining(
        'froze adapter_version and it was rotated in place',
      ),
    });
    expect(readFileSync(installationPath, 'utf8')).toBe(before);
  });

  it('refuses to switch to manual approval while a legacy Authority-published Slack card is unresolved', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-reconfigure-frozen-to-manual-',
    );
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      slackCredentialPath(fixture.stateDirectory),
      'xoxb-matching\n',
      { mode: 0o600 },
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    const store = new DecisionNodeStore(fixture.stateDirectory, {
      now: () => fixedTime,
    });
    await store.ensureRequested(pendingRestrictedReviewerRequest());
    await store.recordPublished({
      processingKey: pendingRestrictedReviewerRequest().processing_key,
      surface: 'slack-authority-v1',
      reference: { channel_id: 'C0REVIEW01', message_ts: '172.1' },
    });
    const installationPath = join(
      fixture.stateDirectory,
      'manifests',
      'operator-installation.v1.json',
    );
    const before = readFileSync(installationPath, 'utf8');
    configureManualApproval(fixture.configPath);

    const refused = await command(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );

    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      code: 'installation_conflict',
      error: expect.stringContaining(
        'was published without a frozen approval presentation contract',
      ),
    });
    expect(readFileSync(installationPath, 'utf8')).toBe(before);
  });

  it('allows manual reconfigure when the only unresolved node is a requested-only crash window', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-reconfigure-requested-only-to-manual-',
    );
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    const store = new DecisionNodeStore(fixture.stateDirectory, {
      now: () => fixedTime,
    });
    await store.ensureRequested(pendingRestrictedReviewerRequest());
    configureManualApproval(fixture.configPath);

    const reconfigured = await expectOk(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );

    expect(JSON.parse(reconfigured.stdout)).toMatchObject({ updated: true });
  });

  it('refuses to switch to another approval adapter while a frozen Slack card is unresolved', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-reconfigure-frozen-to-another-adapter-',
    );
    dependencies.adapterFactories.register({
      kind: 'approval-surface',
      adapter_id: 'fixture-approval',
      validateStaticConfig: () => ({ ok: true, errors: [] }),
      create: () => {
        throw new Error('fixture approval surface is static-only');
      },
    });
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      slackCredentialPath(fixture.stateDirectory),
      'xoxb-matching\n',
      { mode: 0o600 },
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    await seedFrozenRestrictedReviewerCard(
      fixture.stateDirectory,
      'xoxb-matching',
    );
    const installationPath = join(
      fixture.stateDirectory,
      'manifests',
      'operator-installation.v1.json',
    );
    const before = readFileSync(installationPath, 'utf8');
    rewriteConfig(fixture.configPath, {
      approval_mode: 'adapter',
      approval_surface: {
        adapter_id: 'fixture-approval',
        instance_id: 'future-surface',
        settings: {},
      },
    });

    const refused = await command(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );

    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      code: 'installation_conflict',
      error: expect.stringContaining(
        "approval adapter 'fixture-approval/future-surface' cannot resume",
      ),
    });
    expect(readFileSync(installationPath, 'utf8')).toBe(before);
  });

  it('allows stopped reconfigure when unresolved frozen cards still match the configured mode', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-reconfigure-matching-frozen-mode-',
    );
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      slackCredentialPath(fixture.stateDirectory),
      'xoxb-matching\n',
      { mode: 0o600 },
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    await seedFrozenRestrictedReviewerCard(
      fixture.stateDirectory,
      'xoxb-matching',
    );
    rewriteConfig(fixture.configPath, { cycle_interval_ms: 90_000 });

    const reconfigured = await expectOk(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );

    expect(JSON.parse(reconfigured.stdout)).toMatchObject({
      updated: true,
    });
  });

  it('keeps Slack approval and Slack delivery on separate channels', async () => {
    const { configPath, stateDirectory, dependencies } =
      installation('echo-slack-split-');

    // Fresh init refuses one channel carrying both review and delivery traffic,
    // before it creates any state.
    rewriteSlackSurfaces(configPath, stateDirectory, 'C0REVIEW01');
    const conflicting = await command(
      ['init', '--config', configPath],
      dependencies,
    );
    expect(conflicting.status).toBe(1);
    expect(JSON.parse(conflicting.stderr).error).toContain(
      'Slack approval channel C0REVIEW01 is also configured for Slack delivery',
    );
    expect(existsSync(join(stateDirectory, 'manifests'))).toBe(false);

    rewriteSlackSurfaces(configPath, stateDirectory, 'C0DELIVERY');
    await expectOk(['init', '--config', configPath], dependencies);
    // Reconfigure reads every configured credential ref before anything else.
    writeFileSync(slackCredentialPath(stateDirectory), 'xoxb-fixture\n', {
      mode: 0o600,
    });

    // A grandfathered installation whose recorded config already shares one
    // channel may still be re-pinned onto a new package.
    rewriteSlackSurfaces(configPath, stateDirectory, 'C0REVIEW01');
    const installationPath = legacyManifest(stateDirectory, configPath);
    const repinned = await expectOk(
      ['reconfigure', '--config', configPath],
      dependencies,
    );
    expect(JSON.parse(repinned.stdout).updated).toBe(true);

    // Changing that grandfathered configuration brings the rule back, and the
    // manifest that reconfigure would have rewritten is left untouched.
    const pinned = readFileSync(installationPath, 'utf8');
    rewriteSlackSurfaces(configPath, stateDirectory, 'C0REVIEW01', {
      cycle_interval_ms: 90_000,
    });
    const changed = await command(
      ['reconfigure', '--config', configPath],
      dependencies,
    );
    expect(changed.status).toBe(1);
    expect(JSON.parse(changed.stderr).error).toContain(
      'give generic Slack delivery its own channel',
    );
    expect(readFileSync(installationPath, 'utf8')).toBe(pinned);
  });

  it('runs bounded live adapter health checks without a core cycle', async () => {
    const { dependencies, ...fixture } = installation('echo-doctor-');
    await command(['init', '--config', fixture.configPath], dependencies);
    await command(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );

    const healthy = await expectOk(
      ['doctor', '--config', fixture.configPath],
      dependencies,
    );
    const report = JSON.parse(healthy.stdout);
    expect(report.ok).toBe(true);
    expect(report.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'meeting-source',
          adapter_id: 'fixture-meetings',
          status: 'healthy',
        }),
        expect.objectContaining({
          kind: 'decision-processor',
          status: 'healthy',
        }),
        expect.objectContaining({
          kind: 'delivery-surface',
          status: 'healthy',
        }),
      ]),
    );
    expect(report).not.toHaveProperty('cycle');

    const unhealthyDependencies = {
      ...dependencies,
      adapterFactories: adapterFactories('unavailable'),
    };
    const unhealthy = await command(
      ['doctor', '--config', fixture.configPath],
      unhealthyDependencies,
    );
    expect(unhealthy.status).toBe(1);
    expect(JSON.parse(unhealthy.stderr).adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapter_id: 'fixture-meetings',
          status: 'unavailable',
          message: 'fixture unavailable',
        }),
      ]),
    );
  });

  it('does not create organization state for an ordinary full doctor', async () => {
    const { dependencies, ...fixture } = installation(
      'echo-doctor-ordinary-no-org-db-',
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    await expectOk(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    const databasePath = resolveProductStatePaths(fixture.stateDirectory).database;
    expect(existsSync(databasePath)).toBe(false);

    const absent = await expectOk(
      ['doctor', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(absent.stdout).checks).toContainEqual(
      expect.objectContaining({ id: 'organization-state', ok: true }),
    );

    expect(existsSync(databasePath)).toBe(false);

    const legacy = new Database(databasePath);
    legacy.pragma('user_version = 4');
    legacy.close();
    chmodSync(databasePath, 0o600);
    const preOrganization = await expectOk(
      ['doctor', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(preOrganization.stdout).checks).toContainEqual(
      expect.objectContaining({
        id: 'organization-state',
        ok: true,
        detail: expect.stringContaining('schema v4 predates organization state'),
      }),
    );
    const unchanged = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(4);
    unchanged.close();
  });

  it('runs local doctor checks without probing configured adapters', async () => {
    const { dependencies: base, ...fixture } =
      installation('echo-doctor-local-');
    const dependencies = {
      ...base,
      adapterFactories: adapterFactories('unavailable'),
    };
    await command(['init', '--config', fixture.configPath], dependencies);
    await command(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    const databasePath = resolveProductStatePaths(fixture.stateDirectory).database;
    expect(existsSync(databasePath)).toBe(false);

    const local = await expectOk(
      ['doctor', '--local-only', '--config', fixture.configPath],
      dependencies,
    );

    const report = JSON.parse(local.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(10);
    expect(report.checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'adapters' })]),
    );
    expect(report.adapters).toEqual([]);
    expect(existsSync(databasePath)).toBe(false);
  });

  it('fails closed for an unenrolled frozen reviewer in full doctor', async () => {
    const { dependencies: base, ...fixture } = installation(
      'echo-doctor-reviewer-composition-',
    );
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(slackCredentialPath(fixture.stateDirectory), 'xoxb-matching\n', {
      mode: 0o600,
    });
    await expectOk(['init', '--config', fixture.configPath], base);
    const dependencies: ProductCliDependencies = base;
    await expectOk(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    await seedFrozenRestrictedReviewerCard(
      fixture.stateDirectory,
      'xoxb-matching',
    );
    const databasePath = resolveProductStatePaths(fixture.stateDirectory).database;
    expect(existsSync(databasePath)).toBe(false);

    const originalFetch = globalThis.fetch;
    const slackCalls: string[] = [];
    globalThis.fetch = stubSlackProvider(slackCalls);
    try {
      const matching = await command(
        ['doctor', '--config', fixture.configPath],
        dependencies,
      );
      expect(matching.status).toBe(1);
      const matchingReport = JSON.parse(matching.stderr);
      expect(matchingReport.checks).toContainEqual(
        expect.objectContaining({
          id: 'organization-state',
          ok: false,
          detail: expect.stringContaining(
            'requires organization authorization',
          ),
        }),
      );
      expect(matchingReport.adapters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'approval-surface',
            adapter_id: 'slack-reactions',
            status: 'unavailable',
            message: expect.stringContaining(
              'requires an injected reviewer approval authorizer',
            ),
          }),
        ]),
      );
      expect(slackCalls).toEqual([]);
      expect(existsSync(databasePath)).toBe(false);

      writeFileSync(
        slackCredentialPath(fixture.stateDirectory),
        'xoxb-rotated\n',
        { mode: 0o600 },
      );
      const rotated = await command(
        ['doctor', '--config', fixture.configPath],
        dependencies,
      );
      expect(rotated.status).toBe(1);
      expect(rotated.stderr).toContain('froze its credential value');
      // Preflight rejects before the provider health check, so a rotated token
      // is never used to contact Slack.
      expect(slackCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses real enrolled reviewer authorization without mutating SQLite during full doctor', async () => {
    const { dependencies: base, ...fixture } = installation(
      'echo-doctor-enrolled-reviewer-composition-',
    );
    configureRestrictedReviewerApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(slackCredentialPath(fixture.stateDirectory), 'xoxb-matching\n', {
      mode: 0o600,
    });
    await expectOk(['init', '--config', fixture.configPath], base);
    await expectOk(
      ['service', 'install', '--config', fixture.configPath],
      base,
    );
    await seedFrozenRestrictedReviewerCard(
      fixture.stateDirectory,
      'xoxb-matching',
    );
    const signer = await seedEnrolledOrganizationState(fixture.stateDirectory);
    const dependencies: ProductCliDependencies = {
      ...base,
      organization: { installationSigner: signer },
    };
    const databasePath = resolveProductStatePaths(fixture.stateDirectory).database;
    const before = sqliteLogicalSnapshot(databasePath);

    const originalFetch = globalThis.fetch;
    const slackCalls: string[] = [];
    globalThis.fetch = stubSlackProvider(slackCalls);
    try {
      const matching = await expectOk(
        ['doctor', '--config', fixture.configPath],
        dependencies,
      );
      expect(JSON.parse(matching.stdout).adapters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'approval-surface',
            adapter_id: 'slack-reactions',
            status: 'healthy',
          }),
        ]),
      );
      expect(slackCalls).toEqual(['auth.test']);
      expect(sqliteLogicalSnapshot(databasePath)).toEqual(before);

      writeFileSync(
        slackCredentialPath(fixture.stateDirectory),
        'xoxb-rotated\n',
        { mode: 0o600 },
      );
      const rotated = await command(
        ['doctor', '--config', fixture.configPath],
        dependencies,
      );
      expect(rotated.status).toBe(1);
      expect(rotated.stderr).toContain('froze its credential value');
      expect(slackCalls).toEqual(['auth.test']);
      expect(sqliteLogicalSnapshot(databasePath)).toEqual(before);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires the same connected organization capability for member-readable doctor checks', async () => {
    const { dependencies: base, ...fixture } = installation(
      'echo-doctor-member-composition-',
    );
    configureOrganizationMemberApproval(
      fixture.configPath,
      fixture.stateDirectory,
    );
    mkdirSync(join(fixture.stateDirectory, 'credentials'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(slackCredentialPath(fixture.stateDirectory), 'xoxb-member\n', {
      mode: 0o600,
    });
    await expectOk(['init', '--config', fixture.configPath], base);
    await expectOk(
      ['service', 'install', '--config', fixture.configPath],
      base,
    );

    const originalFetch = globalThis.fetch;
    const slackCalls: string[] = [];
    globalThis.fetch = stubSlackProvider(slackCalls);
    try {
      const unenrolled = await command(
        ['doctor', '--config', fixture.configPath],
        base,
      );
      expect(unenrolled.status).toBe(1);
      expect(JSON.parse(unenrolled.stderr).checks).toContainEqual(
        expect.objectContaining({ id: 'organization-state', ok: false }),
      );
      expect(unenrolled.stderr).toContain(
        'requires an injected schema-v3 organization-member approval authorizer',
      );
      expect(slackCalls).toEqual([]);

      const signer = await seedEnrolledOrganizationState(
        fixture.stateDirectory,
      );
      const wrongSigner = await command(
        ['doctor', '--config', fixture.configPath],
        {
          ...base,
          organization: {
            installationSigner: new TestInstallationSigner(),
          },
        },
      );
      expect(wrongSigner.status).toBe(1);
      expect(wrongSigner.stderr).toContain(
        'organization installation signer no longer matches the enrollment',
      );
      expect(slackCalls).toEqual([]);
      const enrolled = await expectOk(
        ['doctor', '--config', fixture.configPath],
        {
          ...base,
          organization: { installationSigner: signer },
        },
      );
      const report = JSON.parse(enrolled.stdout) as {
        checks: Array<{ id: string; ok: boolean }>;
        adapters: Array<{ adapter_id: string; status: string }>;
      };
      expect(report.checks).toContainEqual(
        expect.objectContaining({ id: 'organization-state', ok: true }),
      );
      expect(report.adapters).toContainEqual(
        expect.objectContaining({
          adapter_id: 'slack-reactions',
          status: 'healthy',
        }),
      );
      expect(slackCalls).toEqual(['auth.test']);

      const databasePath = resolveProductStatePaths(
        fixture.stateDirectory,
      ).database;
      const disconnectedDatabase = new Database(databasePath);
      disconnectedDatabase.exec(
        'DROP TABLE organization_authority_connections',
      );
      disconnectedDatabase.pragma('user_version = 5');
      disconnectedDatabase.close();
      const disconnected = await command(
        ['doctor', '--config', fixture.configPath],
        {
          ...base,
          organization: { installationSigner: signer },
        },
      );
      expect(disconnected.status).toBe(1);
      expect(disconnected.stderr).toContain(
        'organization enrollment is accepted but its authority connection is unavailable',
      );
      expect(slackCalls).toEqual(['auth.test']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects interactive env credentials and unsupported platforms without leaking values', async () => {
    const {
      dependencies: base,
      launchd,
      ...fixture
    } = installation(
      'echo-unsafe-service-',
      fakeLaunchd(),
      'env:GRANOLA_API_KEY',
    );
    const dependencies = {
      ...base,
      environment: { GRANOLA_API_KEY: 'must-never-appear' },
    };
    const initialized = await expectOk(
      ['init', '--config', fixture.configPath],
      dependencies,
    );
    expect(initialized.stdout).toContain(
      `file:${join(fixture.stateDirectory, 'credentials', 'granola-api-key')}`,
    );
    const rejected = await command(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('launchd cannot safely persist');
    expect(rejected.stderr).not.toContain('must-never-appear');
    expect(launchd.calls.some((args) => args[0] === 'bootstrap')).toBe(false);

    const outsideCredential = join(fixture.root, 'outside-token');
    writeFileSync(outsideCredential, 'private-but-unmanaged\n', {
      mode: 0o600,
    });
    const outsideRoot = join(fixture.root, 'outside-fixture');
    mkdirSync(outsideRoot, { mode: 0o700 });
    const outsideFixture = fixtures(outsideRoot, `file:${outsideCredential}`);
    const outsideDependencies = cliDependencies(
      fixture.root,
      outsideFixture.cliPath,
      launchd,
    );
    await expectOk(
      ['init', '--config', outsideFixture.configPath],
      outsideDependencies,
    );
    const outsideRejected = await command(
      ['service', 'install', '--config', outsideFixture.configPath],
      outsideDependencies,
    );
    expect(outsideRejected.status).toBe(1);
    expect(outsideRejected.stderr).toContain('launchd cannot safely persist');

    const unsupported = await command(
      ['status', '--config', fixture.configPath],
      {
        ...dependencies,
        operator: { ...dependencies.operator, platform: 'linux' },
      },
    );
    expect(unsupported.status).toBe(0);
    expect(JSON.parse(unsupported.stdout)).toMatchObject({
      service: { supported: false, loaded: false, running: false },
      issues: [expect.stringContaining('requires darwin/arm64')],
    });
  });
});
