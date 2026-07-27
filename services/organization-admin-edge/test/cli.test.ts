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
import {
  OrganizationAdminEdgePreflightError,
  type OrganizationAdminEdgeServePreflight,
  type RunningOrganizationAdminEdge,
} from '../src/edge.js';

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

  it('preflights resolved material without opening a listener or registering signals', async () => {
    const io = capturedIo();
    const runtimeConfig = {
      listener: { host: '0.0.0.0', port: 443 },
      public_origin: 'https://admin.edge.test',
    } as OrganizationAdminEdgeRuntimeConfigV1;
    const serveConfig = {
      trusted_proxy_token:
        'must-not-appear-in-the-preflight-record-000000000001',
    } as OrganizationAdminEdgeServeConfig;
    const preflight: OrganizationAdminEdgeServePreflight = {
      listener: { host: '0.0.0.0', port: 443 },
      public_origin: 'https://admin.edge.test',
      employee_authority_base_url: 'https://authority.edge.test',
      authority_origin: 'http://127.0.0.1:39479',
      allowed_admin_client_count: 1,
      checked_at: '2026-07-26T12:00:00.000Z',
      server_certificate_not_before: '2026-07-25T12:00:00.000Z',
      server_certificate_not_after: '2026-08-25T12:00:00.000Z',
      client_ca_certificate_count: 1,
    };
    const preflightWithUnexpectedSecret = {
      ...preflight,
      unexpected_secret:
        'must-not-appear-from-the-preflight-result-000000000001',
    } as OrganizationAdminEdgeServePreflight;
    const readRuntimeConfig = vi.fn(() => runtimeConfig);
    const resolveServeConfig = vi.fn(() => serveConfig);
    const preflightServeConfig = vi.fn(() => preflightWithUnexpectedSecret);
    const startEdge = vi.fn();
    const registerShutdownSignal = vi.fn();

    await expect(
      runOrganizationAdminEdgeCli(
        ['preflight', '--config', '/private/edge.json'],
        io,
        {
          inspect_runtime_platform: () => SUPPORTED_RUNTIME_PLATFORM,
          read_runtime_config: readRuntimeConfig,
          resolve_serve_config: resolveServeConfig,
          preflight_serve_config: preflightServeConfig,
          start_edge: startEdge,
          register_shutdown_signal: registerShutdownSignal,
        },
      ),
    ).resolves.toBe(0);

    expect(readRuntimeConfig).toHaveBeenCalledWith('/private/edge.json');
    expect(resolveServeConfig).toHaveBeenCalledWith(runtimeConfig);
    expect(preflightServeConfig).toHaveBeenCalledWith(serveConfig);
    expect(startEdge).not.toHaveBeenCalled();
    expect(registerShutdownSignal).not.toHaveBeenCalled();
    expect(io.stderr_values).toEqual([]);
    expect(io.stdout_values).toHaveLength(1);
    expect(JSON.parse(io.stdout_values[0]!)).toEqual({
      schema_version: 1,
      kind: 'echo-organization-admin-edge-preflight',
      ok: true,
      release_platform_qualified: true,
      declared_platform: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM,
      observed_platform: SUPPORTED_RUNTIME_PLATFORM,
      ...preflight,
    });
    expect(io.stdout_values[0]).not.toContain('must-not-appear');
    expect(io.stdout_values[0]).not.toContain('/private/edge.json');
  });

  it('reports a bounded platform failure before reading private configuration', async () => {
    const io = capturedIo();
    const readRuntimeConfig = vi.fn(() => {
      throw new Error('private path must not be read');
    });

    await expect(
      runOrganizationAdminEdgeCli(
        ['preflight', '--config', '/private/edge.json'],
        io,
        {
          inspect_runtime_platform: () => UNSUPPORTED_PLATFORM,
          read_runtime_config: readRuntimeConfig,
        },
      ),
    ).resolves.toBe(1);

    expect(readRuntimeConfig).not.toHaveBeenCalled();
    expect(io.stderr_values).toEqual([]);
    expect(io.stdout_values.map((value) => JSON.parse(value))).toEqual([
      {
        schema_version: 1,
        kind: 'echo-organization-admin-edge-preflight',
        ok: false,
        release_platform_qualified: false,
        declared_platform: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM,
        observed_platform: UNSUPPORTED_PLATFORM,
        failed_check: 'release_platform',
      },
    ]);
  });

  it('maps expected preflight failures without exposing exception text', async () => {
    const runtimeConfig = {} as OrganizationAdminEdgeRuntimeConfigV1;
    const serveConfig = {} as OrganizationAdminEdgeServeConfig;
    const cases = [
      {
        failed_check: 'runtime_config',
        dependencies: {
          read_runtime_config: () => {
            throw new Error(
              '/private/config/secret.json token-value-must-not-leak',
            );
          },
        },
      },
      {
        failed_check: 'runtime_material',
        dependencies: {
          read_runtime_config: () => runtimeConfig,
          resolve_serve_config: () => {
            throw new Error(
              '/private/tls/server-key.pem key-bytes-must-not-leak',
            );
          },
        },
      },
      {
        failed_check: 'server_certificate_expired',
        dependencies: {
          read_runtime_config: () => runtimeConfig,
          resolve_serve_config: () => serveConfig,
          preflight_serve_config: () => {
            throw new OrganizationAdminEdgePreflightError(
              'server_certificate_expired',
            );
          },
        },
      },
    ] as const;

    for (const candidate of cases) {
      const io = capturedIo();
      await expect(
        runOrganizationAdminEdgeCli(
          ['preflight', '--config', '/private/edge.json'],
          io,
          {
            inspect_runtime_platform: () => SUPPORTED_RUNTIME_PLATFORM,
            ...candidate.dependencies,
          },
        ),
      ).resolves.toBe(1);
      expect(io.stderr_values).toEqual([]);
      expect(io.stdout_values).toHaveLength(1);
      expect(JSON.parse(io.stdout_values[0]!)).toMatchObject({
        schema_version: 1,
        kind: 'echo-organization-admin-edge-preflight',
        ok: false,
        release_platform_qualified: true,
        failed_check: candidate.failed_check,
      });
      expect(io.stdout_values[0]).not.toContain('/private/');
      expect(io.stdout_values[0]).not.toContain('must-not-leak');
    }
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
      [
        'preflight',
        '--config',
        '/private/edge.json',
        '--acknowledge-unsupported-host-for-development',
      ],
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
      organizationAdminEdgePlatformPreflight(SUPPORTED_RUNTIME_PLATFORM, true),
    ).toThrow('acknowledgement is invalid on the declared release platform');
  });
});
