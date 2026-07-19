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
      uid: 501,
      homeDirectory: join(root, 'home'),
      nodePath: realpathSync(process.execPath),
      nodeVersion: 'v22.22.1',
      cliPath,
    },
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

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('operator onboarding and lifecycle CLI', () => {
  it('onboards a new secret-free baseline without creating an empty credential', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-onboard-')));
    roots.push(root);
    const configPath = join(root, 'config', 'runtime.json');
    const stateDirectory = join(root, 'state');
    const result = await command(
      ['onboard', '--config', configPath, '--state-dir', stateDirectory],
      cliDependencies(root, realpathSync(import.meta.filename), fakeLaunchd()),
    );

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: true,
      command: 'onboard',
      config_path: configPath,
      state_dir: stateDirectory,
      credential_path: join(stateDirectory, 'credentials', 'granola-api-key'),
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDirectory, 'credentials')).mode & 0o777).toBe(
      0o700,
    );
    expect(existsSync(report.credential_path)).toBe(false);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.meeting_sources[0].credential_ref).toBe(
      `file:${report.credential_path}`,
    );
    expect(config.decision_processor.adapter_id).toBe('structured-text');
    expect(config.delivery_surfaces[0].adapter_id).toBe('jsonl-outbox');

    const repeated = await command(
      ['onboard', '--config', configPath, '--state-dir', stateDirectory],
      cliDependencies(root, realpathSync(import.meta.filename), fakeLaunchd()),
    );
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain('refusing to replace existing config');
  });

  it('initializes private operator state idempotently', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-init-')));
    roots.push(root);
    const fixture = fixtures(root);
    const dependencies = cliDependencies(root, fixture.cliPath, fakeLaunchd());

    const first = await command(
      ['init', '--config', fixture.configPath],
      dependencies,
    );
    const second = await command(
      ['init', '--config', fixture.configPath],
      dependencies,
    );

    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).created).toBe(true);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).created).toBe(false);
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
    expect(
      (
        await command(
          ['onboard', '--config', configPath, '--state-dir', stateDirectory],
          dependencies,
        )
      ).status,
    ).toBe(0);
    expect(
      (await command(['init', '--config', configPath], dependencies)).status,
    ).toBe(0);

    const missing = await command(
      ['service', 'install', '--config', configPath],
      dependencies,
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('is unavailable or insecure');
    expect(launchd.calls.some((args) => args[0] === 'bootstrap')).toBe(false);

    const credentialPath = join(
      stateDirectory,
      'credentials',
      'granola-api-key',
    );
    writeFileSync(credentialPath, 'synthetic-token\n', { mode: 0o600 });
    const installed = await command(
      ['service', 'install', '--config', configPath],
      dependencies,
    );
    expect(installed.status, installed.stderr).toBe(0);
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
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-service-')));
    roots.push(root);
    const fixture = fixtures(root);
    const launchd = fakeLaunchd();
    const dependencies = cliDependencies(root, fixture.cliPath, launchd);
    expect(
      (await command(['init', '--config', fixture.configPath], dependencies))
        .status,
    ).toBe(0);

    const installed = await command(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );
    expect(installed.status, installed.stderr).toBe(0);
    const installation = JSON.parse(installed.stdout);
    expect(installation).toMatchObject({
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
      service: { installed: true, loaded: true, running: true },
    });

    expect(
      (
        await command(
          ['service', 'stop', '--config', fixture.configPath],
          dependencies,
        )
      ).status,
    ).toBe(0);
    const started = await command(
      ['service', 'start', '--config', fixture.configPath],
      dependencies,
    );
    expect(JSON.parse(started.stdout).service.running).toBe(true);
    const restarted = await command(
      ['service', 'restart', '--config', fixture.configPath],
      dependencies,
    );
    expect(restarted.status, restarted.stderr).toBe(0);
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

    const removed = await command(
      ['service', 'uninstall', '--config', fixture.configPath],
      dependencies,
    );
    expect(removed.status, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      action: 'uninstall',
      installed: false,
      service: { loaded: false, running: false },
    });
    expect(existsSync(plistPath)).toBe(false);
  });

  it('locks before creating state and rejects a service restart after config drift', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-service-identity-')),
    );
    roots.push(root);
    const fixture = fixtures(root);
    const launchd = fakeLaunchd();
    const observations: boolean[] = [];
    const dependencies = {
      ...cliDependencies(root, fixture.cliPath, launchd),
      acquireLifecycleLock: async () => {
        observations.push(existsSync(fixture.stateDirectory));
        return async () => undefined;
      },
    };

    const initialized = await command(
      ['init', '--config', fixture.configPath],
      dependencies,
    );
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(observations).toEqual([false, false]);
    expect(
      (
        await command(
          ['service', 'install', '--config', fixture.configPath],
          dependencies,
        )
      ).status,
    ).toBe(0);

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

    const stopped = await command(
      ['service', 'stop', '--config', fixture.configPath],
      dependencies,
    );
    expect(stopped.status, stopped.stderr).toBe(0);
    const reconfigured = await command(
      ['reconfigure', '--config', fixture.configPath],
      dependencies,
    );
    expect(reconfigured.status, reconfigured.stderr).toBe(0);
    expect(JSON.parse(reconfigured.stdout)).toMatchObject({
      ok: true,
      command: 'reconfigure',
      updated: true,
    });
    const started = await command(
      ['service', 'start', '--config', fixture.configPath],
      dependencies,
    );
    expect(started.status, started.stderr).toBe(0);
  });

  it('fails closed when launchd cannot prove that the service is absent', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-launchd-inspection-')),
    );
    roots.push(root);
    const fixture = fixtures(root);
    const unavailable: FakeLaunchd = {
      calls: [],
      runner: async (args) => {
        unavailable.calls.push([...args]);
        return { status: 1, stdout: '', stderr: 'permission denied' };
      },
    };
    const dependencies = cliDependencies(root, fixture.cliPath, unavailable);
    expect(
      (await command(['init', '--config', fixture.configPath], dependencies))
        .status,
    ).toBe(0);
    const backup = await command(
      [
        'backup',
        '--config',
        fixture.configPath,
        '--backup-root',
        join(root, 'backups'),
        '--id',
        'must-not-run',
      ],
      dependencies,
    );
    expect(backup.status).toBe(1);
    expect(backup.stderr).toContain(
      'launchd inspection failed: permission denied',
    );
    expect(existsSync(join(root, 'backups', 'must-not-run'))).toBe(false);
  });

  it('runs bounded live adapter health checks without a core cycle', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-doctor-')));
    roots.push(root);
    const fixture = fixtures(root);
    const launchd = fakeLaunchd();
    const dependencies = cliDependencies(root, fixture.cliPath, launchd);
    await command(['init', '--config', fixture.configPath], dependencies);
    await command(
      ['service', 'install', '--config', fixture.configPath],
      dependencies,
    );

    const healthy = await command(
      ['doctor', '--config', fixture.configPath],
      dependencies,
    );
    expect(healthy.status, healthy.stderr).toBe(0);
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

  it('backs up and restores stopped product state through the CLI', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-recovery-cli-')),
    );
    roots.push(root);
    const fixture = fixtures(root);
    const launchd = fakeLaunchd();
    const dependencies = cliDependencies(root, fixture.cliPath, launchd);
    const backupRoot = join(root, 'backups');

    expect(
      (await command(['init', '--config', fixture.configPath], dependencies))
        .status,
    ).toBe(0);
    const marker = join(fixture.stateDirectory, 'operator-marker.txt');
    writeFileSync(marker, 'before\n', { mode: 0o600 });

    const backup = await command(
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
    expect(backup.status, backup.stderr).toBe(0);
    const backupReport = JSON.parse(backup.stdout);
    expect(backupReport).toMatchObject({
      ok: true,
      command: 'backup',
      backup_directory: join(backupRoot, 'known-good'),
      evidence: { backup_id: 'known-good' },
    });

    expect(
      (
        await command(
          ['service', 'install', '--config', fixture.configPath],
          dependencies,
        )
      ).status,
    ).toBe(0);
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
    expect(
      (
        await command(
          ['service', 'stop', '--config', fixture.configPath],
          dependencies,
        )
      ).status,
    ).toBe(0);

    writeFileSync(marker, 'after\n', { mode: 0o600 });
    const restore = await command(
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
    expect(restore.status, restore.stderr).toBe(0);
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
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-unsafe-service-')),
    );
    roots.push(root);
    const fixture = fixtures(root, 'env:GRANOLA_API_KEY');
    const launchd = fakeLaunchd();
    const dependencies = {
      ...cliDependencies(root, fixture.cliPath, launchd),
      environment: { GRANOLA_API_KEY: 'must-never-appear' },
    };
    const initialized = await command(
      ['init', '--config', fixture.configPath],
      dependencies,
    );
    expect(initialized.status, initialized.stderr).toBe(0);
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

    const outsideCredential = join(root, 'outside-token');
    writeFileSync(outsideCredential, 'private-but-unmanaged\n', {
      mode: 0o600,
    });
    const outsideRoot = join(root, 'outside-fixture');
    mkdirSync(outsideRoot, { mode: 0o700 });
    const outsideFixture = fixtures(outsideRoot, `file:${outsideCredential}`);
    const outsideDependencies = cliDependencies(
      root,
      outsideFixture.cliPath,
      launchd,
    );
    expect(
      (
        await command(
          ['init', '--config', outsideFixture.configPath],
          outsideDependencies,
        )
      ).status,
    ).toBe(0);
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
