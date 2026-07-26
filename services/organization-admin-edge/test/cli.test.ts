import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type {
  OrganizationAdminEdgeRuntimeConfigV1,
  OrganizationAdminEdgeServeConfig,
} from '../src/config.js';
import {
  ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM,
  assertOrganizationAdminEdgeDevelopmentListener,
  organizationAdminEdgePlatformPreflight,
  runOrganizationAdminEdgeCli,
  type OrganizationAdminEdgeCliIo,
  type OrganizationAdminEdgeObservedPlatform,
} from '../src/cli.js';
import type { RunningOrganizationAdminEdge } from '../src/edge.js';

const UNSUPPORTED_PLATFORM: OrganizationAdminEdgeObservedPlatform = {
  os: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.os,
  architecture: 'x64',
  node: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.node,
};
const SUPPORTED_RUNTIME_PLATFORM: OrganizationAdminEdgeObservedPlatform = {
  os: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.os,
  architecture: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.architecture,
  node: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.node,
};
const RUNTIME_BOUNDARY_PATH = fileURLToPath(
  new URL(
    '../../../release/organization-admin-edge/runtime-boundary.v1.json',
    import.meta.url,
  ),
);

function capturedIo(): OrganizationAdminEdgeCliIo & {
  readonly stdout_values: string[];
  readonly stderr_values: string[];
} {
  const stdoutValues: string[] = [];
  const stderrValues: string[] = [];
  return {
    stdout_values: stdoutValues,
    stderr_values: stderrValues,
    stdout: (value) => stdoutValues.push(value),
    stderr: (value) => stderrValues.push(value),
  };
}

describe('organization administrator edge CLI platform preflight', () => {
  it('matches the committed administrator-edge release-cell declaration', () => {
    const boundary = JSON.parse(
      readFileSync(RUNTIME_BOUNDARY_PATH, 'utf8'),
    ) as {
      readonly declared_platform: unknown;
    };
    expect(ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM).toEqual(
      boundary.declared_platform,
    );
  });

  it('fails closed on every declared platform mismatch without reading runtime config', async () => {
    const readRuntimeConfig = vi.fn();
    await expect(
      runOrganizationAdminEdgeCli(
        ['serve', '--config', '/private/edge.json'],
        capturedIo(),
        {
          inspect_runtime_platform: () => ({
            os: 'linux',
            architecture: 'x64',
            node: '22.21.0',
          }),
          read_runtime_config: readRuntimeConfig,
        },
      ),
    ).rejects.toThrow(
      'mismatches os:darwin->linux, architecture:arm64->x64, node:22.22.1->22.21.0',
    );
    expect(readRuntimeConfig).not.toHaveBeenCalled();
  });

  it('rejects ambiguous or unknown serve arguments before platform inspection', async () => {
    for (const arguments_ of [
      ['serve', '--config', '/private/edge.json', '--config', '/other.json'],
      [
        'serve',
        '--config',
        '/private/edge.json',
        '--acknowledge-unsupported-host-for-development',
        '--acknowledge-unsupported-host-for-development',
      ],
      ['serve', '--config', '/private/edge.json', '--unknown'],
    ]) {
      await expect(
        runOrganizationAdminEdgeCli(arguments_, capturedIo(), {
          inspect_runtime_platform: () => {
            throw new Error('platform inspection must not run');
          },
        }),
      ).rejects.toThrow('usage:');
    }
  });

  it('allows an explicitly acknowledged unsupported host only on loopback and marks readiness non-qualifying', async () => {
    const io = capturedIo();
    const runtimeConfig = {
      listener: { host: '127.0.0.1', port: 8443 },
      public_origin: 'https://admin.edge.test:8443',
    } as OrganizationAdminEdgeRuntimeConfigV1;
    const serveConfig = {} as OrganizationAdminEdgeServeConfig;
    const edge: RunningOrganizationAdminEdge = {
      address: {
        address: '127.0.0.1',
        family: 'IPv4',
        port: 8443,
      } as AddressInfo,
      active_connection_count: async () => 0,
      close: async () => undefined,
    };
    const startEdge = vi.fn(async () => edge);
    const registerShutdownSignal = vi.fn();

    await expect(
      runOrganizationAdminEdgeCli(
        [
          'serve',
          '--config',
          '/private/edge.json',
          '--acknowledge-unsupported-host-for-development',
        ],
        io,
        {
          inspect_runtime_platform: () => UNSUPPORTED_PLATFORM,
          read_runtime_config: () => runtimeConfig,
          resolve_serve_config: () => serveConfig,
          start_edge: startEdge,
          register_shutdown_signal: registerShutdownSignal,
        },
      ),
    ).resolves.toBe(0);

    expect(startEdge).toHaveBeenCalledWith(serveConfig);
    expect(registerShutdownSignal).toHaveBeenCalledTimes(2);
    expect(io.stdout_values).toEqual([]);
    expect(io.stderr_values.map((value) => JSON.parse(value))).toEqual([
      {
        schema_version: 1,
        kind: 'echo-organization-admin-edge-development-platform-acknowledgement',
        release_platform_qualified: false,
        declared_platform: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM,
        observed_platform: UNSUPPORTED_PLATFORM,
        mismatches: ['architecture:arm64->x64'],
      },
      {
        schema_version: 1,
        kind: 'echo-organization-admin-edge-ready',
        host: '127.0.0.1',
        port: 8443,
        public_origin: 'https://admin.edge.test:8443',
        release_platform_qualified: false,
      },
    ]);
  });

  it('rejects the development acknowledgement on a public listener or the declared release platform', () => {
    expect(() =>
      assertOrganizationAdminEdgeDevelopmentListener('0.0.0.0'),
    ).toThrow('requires an exact loopback listener');
    expect(() =>
      organizationAdminEdgePlatformPreflight(
        SUPPORTED_RUNTIME_PLATFORM,
        true,
      ),
    ).toThrow('acknowledgement is invalid on the declared release platform');
  });
});
