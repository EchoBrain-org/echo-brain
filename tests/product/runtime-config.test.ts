import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMountTable,
  createStateFilesystemClassifier,
  ProductConfigError,
  validateProductRuntimeConfig,
  type ProductRuntimeConfig,
} from '../../src/product/config.js';
import {
  createOrganizationIngestExclusion,
} from '../../src/product/organization/record/index.js';
import { runProductCli } from '../../src/product/cli.js';

const directories: string[] = [];

function validConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: '/tmp/echo-brain/state',
    meeting_sources: [
      {
        adapter_id: 'fixture-meetings',
        instance_id: 'primary',
        credential_ref: 'env:MEETING_SOURCE_KEY',
        settings: { workspace: 'synthetic' },
      },
    ],
    decision_processor: {
      adapter_id: 'fixture-processor',
      instance_id: 'primary',
      credential_ref: 'env:DECISION_PROCESSOR_KEY',
      settings: { model: 'synthetic' },
    },
    delivery_surfaces: [
      {
        adapter_id: 'fixture-delivery',
        instance_id: 'team',
        credential_ref: 'env:ECHO_CHANNEL_KEY',
        settings: { destination: 'synthetic' },
      },
    ],
    approval_mode: 'manual',
    cycle_interval_ms: 30_000,
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
  while (directories.length > 0)
    rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('product runtime configuration', () => {
  it('accepts tool-agnostic adapter descriptors and secret references', () => {
    const config = validateProductRuntimeConfig(validConfig());
    expect(config).toMatchObject({
      schema_version: 1,
      lane: 'team-product',
      approval_mode: 'manual',
      cycle_interval_ms: 30_000,
      meeting_sources: [
        {
          adapter_id: 'fixture-meetings',
          instance_id: 'primary',
          credential_ref: 'env:MEETING_SOURCE_KEY',
        },
      ],
      decision_processor: {
        adapter_id: 'fixture-processor',
        instance_id: 'primary',
        credential_ref: 'env:DECISION_PROCESSOR_KEY',
      },
      delivery_surfaces: [
        {
          adapter_id: 'fixture-delivery',
          instance_id: 'team',
          credential_ref: 'env:ECHO_CHANNEL_KEY',
        },
      ],
    });
    expect(Object.isFrozen(config.delivery_surfaces)).toBe(true);
    expect(Object.isFrozen(config.delivery_surfaces[0])).toBe(true);
    expect(Object.isFrozen(config.delivery_surfaces[0]!.settings)).toBe(true);
  });

  it('rejects the retired communication_channels key', () => {
    const value = validConfig();
    value.communication_channels = value.delivery_surfaces;
    delete value.delivery_surfaces;

    expect(() => validateProductRuntimeConfig(value)).toThrow(
      /invalid product runtime configuration/,
    );
  });

  it('rejects configs that contain both delivery vocabularies', () => {
    const value = validConfig({
      communication_channels: validConfig().delivery_surfaces,
    });

    expect(() => validateProductRuntimeConfig(value)).toThrow(
      /invalid product runtime configuration/,
    );
  });

  it.each([
    ['retired profile', { profile: 'customer' }],
    [
      'inline adapter secret outside settings',
      {
        decision_processor: {
          adapter_id: 'fixture-processor',
          instance_id: 'primary',
          settings: {},
          api_key: 'secret-value',
        },
      },
    ],
    ['relative state', { state_dir: 'relative/state' }],
    ['traversing state', { state_dir: '/tmp/echo/../shared' }],
    ['unknown field', { surprise: true }],
    ['no meeting source', { meeting_sources: [] }],
    ['missing decision processor', { decision_processor: undefined }],
    ['no delivery surface', { delivery_surfaces: [] }],
    ['wrong lane', { lane: 'dogfood' }],
    [
      'unsupported keychain credential',
      {
        delivery_surfaces: [
          {
            adapter_id: 'fixture-delivery',
            instance_id: 'team',
            credential_ref: 'keychain:ECHO_CHANNEL_KEY',
            settings: {},
          },
        ],
      },
    ],
    ['non-manual approval', { approval_mode: 'automatic' }],
    [
      'adapter approval without a surface',
      { approval_mode: 'adapter' },
    ],
    [
      'manual approval with a surface',
      {
        approval_mode: 'manual',
        approval_surface: {
          adapter_id: 'slack-reactions',
          instance_id: 'founder',
          credential_ref: 'env:SLACK_BOT_TOKEN',
          settings: {},
        },
      },
    ],
    ['too-frequent cycle', { cycle_interval_ms: 999 }],
    ['too-short extraction timeout', { extraction_timeout_ms: 999 }],
    ['too-long extraction timeout', { extraction_timeout_ms: 600_001 }],
  ])('rejects %s', (_name, overrides) => {
    const value = validConfig(overrides as Record<string, unknown>);
    if (
      'decision_processor' in overrides &&
      overrides.decision_processor === undefined
    ) {
      delete value.decision_processor;
    }
    expect(() => validateProductRuntimeConfig(value)).toThrow(
      /invalid product runtime configuration/,
    );
  });

  it('accepts adapter approval mode paired with an approval surface', () => {
    expect(
      validateProductRuntimeConfig(
        validConfig({
          approval_mode: 'adapter',
          approval_surface: {
            adapter_id: 'slack-reactions',
            instance_id: 'founder',
            credential_ref: 'env:SLACK_BOT_TOKEN',
            settings: { channel_id: 'C123' },
          },
        }),
      ),
    ).toMatchObject({
      approval_mode: 'adapter',
      approval_surface: {
        adapter_id: 'slack-reactions',
        instance_id: 'founder',
        credential_ref: 'env:SLACK_BOT_TOKEN',
      },
    });
  });

  it('accepts an explicit extraction timeout for slow decision processors', () => {
    expect(
      validateProductRuntimeConfig(
        validConfig({ extraction_timeout_ms: 300_000 }),
      ),
    ).toMatchObject({ extraction_timeout_ms: 300_000 });
  });

  it('accepts exact source and meeting organization ingest exclusions', () => {
    const config = validateProductRuntimeConfig(
      validConfig({
        organization_ingest: {
          exclude: {
            sources: [{ adapter_id: 'granola', instance_id: 'payroll' }],
            meetings: [
              {
                source: { adapter_id: 'granola', instance_id: 'primary' },
                external_id: 'meeting-42',
              },
            ],
          },
        },
      }),
    );

    const exclude = config.organization_ingest?.exclude;
    expect(exclude).toEqual({
      sources: [{ adapter_id: 'granola', instance_id: 'payroll' }],
      meetings: [
        {
          source: { adapter_id: 'granola', instance_id: 'primary' },
          external_id: 'meeting-42',
        },
      ],
    });
    expect(Object.isFrozen(exclude)).toBe(true);
    expect(Object.isFrozen(exclude?.sources)).toBe(true);
    expect(Object.isFrozen(exclude?.meetings[0])).toBe(true);

    const exclusion = createOrganizationIngestExclusion(exclude!);
    // Whole-source exclusion covers every meeting under it.
    expect(
      exclusion.excludes({
        adapter_id: 'granola',
        instance_id: 'payroll',
        external_id: 'anything',
      }),
    ).toBe(true);
    // Single-meeting exclusion covers exactly that meeting.
    expect(
      exclusion.excludes({
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: 'meeting-42',
      }),
    ).toBe(true);
    expect(
      exclusion.excludes({
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: 'meeting-43',
      }),
    ).toBe(false);
    // Exact match only: no prefix, glob, or case-insensitive matching.
    expect(
      exclusion.excludes({
        adapter_id: 'granola',
        instance_id: 'payroll-archive',
        external_id: 'meeting-42',
      }),
    ).toBe(false);
    expect(
      exclusion.excludes({
        adapter_id: 'Granola',
        instance_id: 'payroll',
        external_id: 'meeting-42',
      }),
    ).toBe(false);
  });

  it.each([
    ['unknown key', { exclude: { sources: [], groups: [] } }],
    [
      'partial source entry',
      { exclude: { sources: [{ adapter_id: 'granola' }] } },
    ],
    [
      'empty meeting external id',
      {
        exclude: {
          meetings: [
            {
              source: { adapter_id: 'granola', instance_id: 'primary' },
              external_id: '   ',
            },
          ],
        },
      },
    ],
    [
      'padded source identifier',
      {
        exclude: {
          sources: [{ adapter_id: ' granola', instance_id: 'primary' }],
        },
      },
    ],
    [
      'padded meeting external id',
      {
        exclude: {
          meetings: [
            {
              source: { adapter_id: 'granola', instance_id: 'primary' },
              external_id: 'meeting-42 ',
            },
          ],
        },
      },
    ],
    ['non-array sources', { exclude: { sources: {} } }],
    ['missing exclude section', {}],
  ])('fails closed on an invalid exclusion config (%s)', (_label, ingest) => {
    // An unreadable never-ingest list is never treated as an empty one: the
    // whole configuration is refused so nothing ships unfiltered.
    expect(() =>
      validateProductRuntimeConfig(
        validConfig({ organization_ingest: ingest }),
      ),
    ).toThrow(ProductConfigError);
  });

  it('rejects duplicate adapter instances within one capability', () => {
    const duplicate = {
      adapter_id: 'fixture-meetings',
      instance_id: 'primary',
      settings: {},
    };
    try {
      validateProductRuntimeConfig(
        validConfig({ meeting_sources: [duplicate, duplicate] }),
      );
      throw new Error('expected duplicate adapter instance to fail validation');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductConfigError);
      expect((error as ProductConfigError).issues).toContain(
        "/meeting_sources contains duplicate adapter instance 'fixture-meetings/primary'",
      );
    }
  });

  it('reports duplicate delivery surfaces at the canonical config path', () => {
    const duplicate = {
      adapter_id: 'fixture-delivery',
      instance_id: 'team',
      settings: {},
    };
    try {
      validateProductRuntimeConfig(
        validConfig({ delivery_surfaces: [duplicate, duplicate] }),
      );
      throw new Error('expected duplicate adapter instance to fail validation');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductConfigError);
      expect((error as ProductConfigError).issues).toContain(
        "/delivery_surfaces contains duplicate adapter instance 'fixture-delivery/team'",
      );
    }
  });

  it('fails invalid CLI config before the filesystem probe or any state side effect', async () => {
    const configPath = writeConfig(validConfig({ state_dir: 'relative' }));
    let probes = 0;
    let stderr = '';
    const status = await runProductCli(
      ['validate-config', '--config', configPath],
      {
        classifyStateFilesystem: async () => {
          probes += 1;
          return { kind: 'local', raw: 'apfs' };
        },
        stdout: { write: () => true },
        stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
      },
    );
    expect(status).toBe(2);
    expect(probes).toBe(0);
    expect(stderr).toContain('invalid product runtime configuration');
  });

  it('runs read-only validate-config without claiming the wedge ran', async () => {
    const configPath = writeConfig(validConfig());
    let stdout = '';
    const status = await runProductCli(
      ['validate-config', '--config', configPath],
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
        stderr: { write: () => true },
      },
    );
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as {
      maturity: string;
      wedge_executed: boolean;
      adapters_loaded: boolean;
      runtime_readiness: { checked: boolean; detail: string };
      adapter_references: {
        meeting_sources: Array<{ adapter_id: string; instance_id: string }>;
        decision_processor: { adapter_id: string; instance_id: string };
        delivery_surfaces: Array<{
          adapter_id: string;
          instance_id: string;
        }>;
      };
    };
    expect(report.maturity).toBe('DEV');
    expect(report.wedge_executed).toBe(false);
    expect(report.adapters_loaded).toBe(false);
    expect(report.runtime_readiness.checked).toBe(false);
    expect(report.runtime_readiness.detail).toContain(
      'no credential, provider, or service health was verified',
    );
    expect(report.adapter_references).toEqual({
      meeting_sources: [
        { adapter_id: 'fixture-meetings', instance_id: 'primary' },
      ],
      decision_processor: {
        adapter_id: 'fixture-processor',
        instance_id: 'primary',
      },
      delivery_surfaces: [
        { adapter_id: 'fixture-delivery', instance_id: 'team' },
      ],
    });
  });

  it('reports the configured approval surface without loading adapters', async () => {
    const configPath = writeConfig(
      validConfig({
        approval_mode: 'adapter',
        approval_surface: {
          adapter_id: 'slack-reactions',
          instance_id: 'founder',
          credential_ref: 'env:SLACK_BOT_TOKEN',
          settings: {
            channel_id: 'C123',
            reviewer: { slack_user_id: 'U123', name: 'founder' },
          },
        },
      }),
    );
    let stdout = '';
    const status = await runProductCli(
      ['validate-config', '--config', configPath],
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
        stderr: { write: () => true },
      },
    );

    expect(status).toBe(0);
    expect(JSON.parse(stdout).adapter_references.approval_surface).toEqual({
      adapter_id: 'slack-reactions',
      instance_id: 'founder',
    });
  });

  it('makes a production cycle report every unavailable adapter before probing state', async () => {
    const configPath = writeConfig(validConfig());
    let probes = 0;
    let stderr = '';
    const status = await runProductCli(['run-once', '--config', configPath], {
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
    expect(stderr).toContain('fixture-meetings');
    expect(stderr).toContain('fixture-processor');
    expect(stderr).toContain('fixture-delivery');
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
    expect(
      classifyMountTable('/target/state', `source on / (${type}, local)\n`),
    ).toEqual({
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
    expect(classifyMountTable('/Volumes/team/echo/state', nestedFirst)).toEqual(
      {
        kind: 'network',
        raw: 'nfs',
      },
    );
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
    expect(classifyMountTable('/tmp/state', 'not mount output\n').kind).toBe(
      'unknown',
    );
    expect(classifyMountTable('/tmp/state', '').kind).toBe('unknown');
    expect(
      classifyMountTable(
        '/tmp/state',
        'source on /Volumes/else (apfs, local)\n',
      ).kind,
    ).toBe('unknown');
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
    expect(await classifier('/install/not-created/state')).toEqual({
      kind: 'local',
      raw: 'apfs',
    });
    expect(seen).toEqual(['/install']);

    const failed = createStateFilesystemClassifier({
      exists: () => true,
      realpath: (path) => path,
      mountTable: async () => ({ ok: false, stdout: '', stderr: 'timed out' }),
    });
    expect(await failed('/install')).toEqual({
      kind: 'unknown',
      raw: 'timed out',
    });
  });

  it('treats network and unknown probes as fail-closed in CLI commands', async () => {
    const configPath = writeConfig(validConfig());
    for (const classification of [
      { kind: 'network', raw: 'smbfs' },
      { kind: 'unknown', raw: 'probe failed' },
    ] as const) {
      const status = await runProductCli(
        ['validate-config', '--config', configPath],
        {
          classifyStateFilesystem: async () => classification,
          stdout: { write: () => true },
          stderr: { write: () => true },
        },
      );
      expect(status).toBe(1);
    }
  });
});

export type { ProductRuntimeConfig };
