import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMountTable,
  createStateFilesystemClassifier,
  validateProductRuntimeConfig,
  type ProductRuntimeConfig,
} from '../../src/product/config.js';
import { runProductCli } from '../../src/product/cli.js';

const directories: string[] = [];

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: '/tmp/echo-brain/state',
    granola: {
      workspace_id: 'workspace-synthetic',
      input: 'api',
      credential_ref: 'env:GRANOLA_API_KEY',
    },
    brain_adapter: {
      id: 'anthropic-api',
      credential_ref: 'env:ANTHROPIC_API_KEY',
    },
    approval_mode: 'manual',
    ...overrides,
  };
}

function writeConfig(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-product-config-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('product runtime configuration', () => {
  it('accepts the explicit Team-product lane and secret references', () => {
    expect(validateProductRuntimeConfig(validConfig())).toMatchObject({
      schema_version: 1,
      lane: 'team-product',
      approval_mode: 'manual',
      granola: { input: 'api', credential_ref: 'env:GRANOLA_API_KEY' },
      brain_adapter: { id: 'anthropic-api', credential_ref: 'env:ANTHROPIC_API_KEY' },
    });
  });

  it.each([
    ['retired profile', { profile: 'customer' }],
    [
      'inline Granola secret',
      {
        granola: {
          workspace_id: 'workspace-synthetic',
          input: 'api',
          credential_ref: 'env:GRANOLA_API_KEY',
          api_key: 'secret-value',
        },
      },
    ],
    ['relative state', { state_dir: 'relative/state' }],
    ['traversing state', { state_dir: '/tmp/echo/../shared' }],
    ['unknown field', { surprise: true }],
    ['missing wedge dependency', { granola: undefined }],
    ['wrong lane', { lane: 'dogfood' }],
    ['non-manual approval', { approval_mode: 'automatic' }],
  ])('rejects %s', (_name, overrides) => {
    const value = validConfig(overrides as Record<string, unknown>);
    if ('granola' in overrides && overrides.granola === undefined) delete value.granola;
    expect(() => validateProductRuntimeConfig(value)).toThrow(/invalid product runtime configuration/);
  });

  it('fails invalid CLI config before the filesystem probe or any state side effect', async () => {
    const configPath = writeConfig(validConfig({ state_dir: 'relative' }));
    let probes = 0;
    let stderr = '';
    const status = await runProductCli(['validate-config', '--config', configPath], {
      classifyStateFilesystem: async () => {
        probes += 1;
        return { kind: 'local', raw: 'apfs' };
      },
      stdout: { write: () => true },
      stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
    });
    expect(status).toBe(2);
    expect(probes).toBe(0);
    expect(stderr).toContain('invalid product runtime configuration');
  });

  it('runs read-only validate-config and offline selftest without claiming the wedge ran', async () => {
    const configPath = writeConfig(validConfig());
    for (const command of ['validate-config', 'selftest'] as const) {
      let stdout = '';
      const status = await runProductCli([command, '--config', configPath], {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
        stderr: { write: () => true },
      });
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as {
        maturity: string;
        wedge_executed: boolean;
        brain_adapter: { status: string };
      };
      expect(report.maturity).toBe('DEV');
      expect(report.wedge_executed).toBe(false);
      if (command === 'selftest') expect(report.brain_adapter.status).toBe('pending');
    }
  });

  it('makes production run fail loudly on the unavailable rank-3 adapter before probing state', async () => {
    const configPath = writeConfig(validConfig());
    let probes = 0;
    let stderr = '';
    const status = await runProductCli(['run', '--config', configPath], {
      classifyStateFilesystem: async () => {
        probes += 1;
        return { kind: 'local', raw: 'apfs' };
      },
      stdout: { write: () => true },
      stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
    });
    expect(status).toBe(1);
    expect(probes).toBe(0);
    expect(stderr).toContain('adapter_unavailable');
    expect(stderr).toContain('anthropic-api');
  });
});

describe('state filesystem classification', () => {
  it.each([
    ['nfs', 'network'],
    ['smbfs', 'network'],
    ['afpfs', 'network'],
    ['webdav', 'network'],
    ['apfs', 'local'],
    ['hfs', 'local'],
    ['ext4', 'unknown'],
  ] as const)('normalizes exactly %s as %s', (type, kind) => {
    expect(classifyMountTable('/target/state', `source on / (${type}, local)\n`)).toEqual({
      kind,
      raw: type,
    });
  });

  it('decodes escaped mount paths containing spaces', () => {
    expect(
      classifyMountTable(
        '/Volumes/Client Data/echo/state',
        '/dev/disk1 on / (apfs, local)\nserver on /Volumes/Client\\040Data (smbfs, nodev)\n',
      ),
    ).toEqual({ kind: 'network', raw: 'smbfs' });
  });

  it('uses the unique deepest component match independent of table order', () => {
    const rootFirst =
      '/dev/disk1 on / (apfs, local)\nserver on /Volumes/team (nfs, nodev)\n';
    const nestedFirst =
      'server on /Volumes/team (nfs, nodev)\n/dev/disk1 on / (apfs, local)\n';
    expect(classifyMountTable('/Volumes/team/echo/state', rootFirst)).toEqual({
      kind: 'network',
      raw: 'nfs',
    });
    expect(classifyMountTable('/Volumes/team/echo/state', nestedFirst)).toEqual({
      kind: 'network',
      raw: 'nfs',
    });
  });

  it('does not treat string-prefix collisions as descendants', () => {
    const table =
      '/dev/disk1 on / (apfs, local)\nserver on /Volumes/foo (nfs, nodev)\n';
    expect(classifyMountTable('/Volumes/foobar/echo', table)).toEqual({
      kind: 'local',
      raw: 'apfs',
    });
  });

  it('fails closed for malformed, empty, unmatched, and equal-depth ambiguous tables', () => {
    expect(classifyMountTable('/tmp/state', 'not mount output\n').kind).toBe('unknown');
    expect(classifyMountTable('/tmp/state', '').kind).toBe('unknown');
    expect(classifyMountTable('/tmp/state', 'source on /Volumes/else (apfs, local)\n').kind).toBe(
      'unknown',
    );
    expect(
      classifyMountTable(
        '/Volumes/team/state',
        'a on /Volumes/team (apfs, local)\nb on /Volumes/team (nfs, nodev)\n',
      ).kind,
    ).toBe('unknown');
  });

  it('realpath-resolves the closest existing ancestor and fails closed on command errors', async () => {
    const seen: string[] = [];
    const classifier = createStateFilesystemClassifier({
      exists: (path) => path === '/install',
      realpath: (path) => {
        seen.push(path);
        return '/private/install';
      },
      mountTable: async () => ({
        ok: true,
        stdout: '/dev/disk1 on / (apfs, local)\n',
        stderr: '',
      }),
    });
    expect(await classifier('/install/not-created/state')).toEqual({ kind: 'local', raw: 'apfs' });
    expect(seen).toEqual(['/install']);

    const failed = createStateFilesystemClassifier({
      exists: () => true,
      realpath: (path) => path,
      mountTable: async () => ({ ok: false, stdout: '', stderr: 'timed out' }),
    });
    expect(await failed('/install')).toEqual({ kind: 'unknown', raw: 'timed out' });
  });

  it('treats network and unknown probes as fail-closed in CLI commands', async () => {
    const configPath = writeConfig(validConfig());
    for (const classification of [
      { kind: 'network', raw: 'smbfs' },
      { kind: 'unknown', raw: 'probe failed' },
    ] as const) {
      const status = await runProductCli(['validate-config', '--config', configPath], {
        classifyStateFilesystem: async () => classification,
        stdout: { write: () => true },
        stderr: { write: () => true },
      });
      expect(status).toBe(1);
    }
  });
});

export type { ProductRuntimeConfig };
