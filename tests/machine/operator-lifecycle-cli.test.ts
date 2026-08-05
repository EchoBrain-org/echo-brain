import {
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
import { afterEach, describe, expect, it } from 'vitest';
import type { MeetingSourceAdapter } from '../../src/core/index.js';
import { ProductAdapterFactoryRegistry } from '../../src/product/adapter-factories.js';
import {
  runProductCli,
  type ProductCliDependencies,
} from '../../src/product/cli.js';
import { createDefaultAdapterFactories } from '../../src/product/default-adapters.js';
import { loadProductRuntimeConfig } from '../../src/product/config.js';
import { canonicalProductConfigSha256 } from '../../src/product/lifecycle-lock.js';
import { onboardProduct } from '../../src/product/operator-lifecycle.js';
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

  it('dispatches an update even when package replacement made the install record stale', async () => {
    const { dependencies: base, ...fixture } = installation('echo-update-cli-');
    let observedConfigPath: string | undefined;
    const dependencies: ProductCliDependencies = {
      ...base,
      internalLive: {
        execute: async (options) => {
          observedConfigPath = options.configPath;
          return {
            directive_sequence: 7,
            receipt: {
              schema_version: 1,
              kind: 'echo-internal-live-update-receipt',
              channel: 'internal-live',
              transaction_id: 'upd_00000000-0000-4000-8000-000000000001',
              release_version: '0.1.0-internal.2',
              manifest_sha256: 'a'.repeat(64),
              artifact_sha256: 'b'.repeat(64),
              source_sha: 'c'.repeat(40),
              previous: {
                product_version: '0.1.0-internal.1',
                source_sha: '1'.repeat(40),
              },
              outcome: 'healthy',
              doctor: { ok: true, passed: 11, total: 11 },
              failure: null,
              started_at: fixedTime,
              finished_at: fixedTime,
            },
          };
        },
      },
    };
    await expectOk(['init', '--config', fixture.configPath], base);
    dependencies.operator = {
      ...base.operator,
      buildIdentity: {
        source_sha: '2'.repeat(40),
        source_kind: 'materialized-commit',
      },
    };

    const result = await command(
      [
        'update',
        'apply',
        '--channel',
        'internal-live',
        '--config',
        fixture.configPath,
      ],
      dependencies,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(observedConfigPath).toBe(fixture.configPath);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: 'update',
      action: 'apply',
      channel: 'internal-live',
      directive_sequence: 7,
      receipt: { outcome: 'healthy' },
    });
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
    const configPath = join(root, 'config', 'runtime.json');
    const stateDirectory = join(root, 'state');
    const cliPath = join(root, 'echo-brain-cli.js');
    writeFileSync(cliPath, '#!/usr/bin/env node\n');
    const launchd = fakeLaunchd();
    const dependencies = cliDependencies(root, cliPath, launchd);
    // `bootstrap` owns the only supported v1 setup and the real suite proves the
    // baseline it writes; that baseline is arranged directly here so this test
    // stays about the credential the service needs.
    const { credential_path } = onboardProduct(configPath, stateDirectory);
    await expectOk(['init', '--config', configPath], dependencies);

    const missing = await command(
      ['service', 'install', '--config', configPath],
      dependencies,
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('is unavailable or insecure');
    expect(launchd.calls.some((args) => args[0] === 'bootstrap')).toBe(false);

    writeFileSync(credential_path, 'synthetic-token\n', { mode: 0o600 });
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

  it('fails closed when launchd cannot prove that the service is absent', async () => {
    const unavailable: FakeLaunchd = {
      calls: [],
      runner: async (args) => {
        unavailable.calls.push([...args]);
        return { status: 1, stdout: '', stderr: 'permission denied' };
      },
    };
    const { dependencies, ...fixture } = installation(
      'echo-launchd-inspection-',
      unavailable,
    );
    await expectOk(['init', '--config', fixture.configPath], dependencies);
    const backup = await command(
      [
        'backup',
        '--config',
        fixture.configPath,
        '--backup-root',
        join(fixture.root, 'backups'),
        '--id',
        'must-not-run',
      ],
      dependencies,
    );
    expect(backup.status).toBe(1);
    expect(backup.stderr).toContain(
      'launchd inspection failed: permission denied',
    );
    expect(existsSync(join(fixture.root, 'backups', 'must-not-run'))).toBe(
      false,
    );
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
  });

  it('backs up and restores stopped product state through the CLI', async () => {
    const { dependencies, ...fixture } = installation('echo-recovery-cli-');
    const backupRoot = join(fixture.root, 'backups');

    await expectOk(['init', '--config', fixture.configPath], dependencies);
    const marker = join(fixture.stateDirectory, 'operator-marker.txt');
    writeFileSync(marker, 'before\n', { mode: 0o600 });

    const backup = await expectOk(
      [
        'backup',
        '--config',
        fixture.configPath,
        '--backup-root',
        backupRoot,
        '--id',
        'known-good',
      ],
      dependencies,
    );
    expect(JSON.parse(backup.stdout)).toMatchObject({
      ok: true,
      command: 'backup',
      backup_directory: join(backupRoot, 'known-good'),
      evidence: { backup_id: 'known-good' },
    });

    await expectOk(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    const whileLoaded = await command(
      [
        'backup',
        '--config',
        fixture.configPath,
        '--backup-root',
        backupRoot,
        '--id',
        'must-not-run',
      ],
      dependencies,
    );
    expect(whileLoaded.status).toBe(1);
    expect(whileLoaded.stderr).toContain('service is loaded');
    await expectOk(
      ['service', 'stop', '--config', fixture.configPath],
      dependencies,
    );

    writeFileSync(marker, 'after\n', { mode: 0o600 });
    const restore = await expectOk(
      [
        'restore',
        '--config',
        fixture.configPath,
        '--backup',
        join(backupRoot, 'known-good'),
        '--backup-root',
        backupRoot,
        '--id',
        'restore-known-good',
      ],
      dependencies,
    );
    expect(JSON.parse(restore.stdout)).toMatchObject({
      ok: true,
      command: 'restore',
      evidence: {
        operation_id: 'restore-known-good',
        restored_backup_id: 'known-good',
      },
    });
    expect(readFileSync(marker, 'utf8')).toBe('before\n');
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
