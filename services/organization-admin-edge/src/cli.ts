import {
  readOrganizationAdminEdgeRuntimeConfig,
  resolveOrganizationAdminEdgeServeConfig,
  type OrganizationAdminEdgeRuntimeConfigV1,
  type OrganizationAdminEdgeServeConfig,
} from './config.js';
import {
  OrganizationAdminEdgePreflightError,
  preflightOrganizationAdminEdgeServeConfig,
  startOrganizationAdminEdge,
  type OrganizationAdminEdgePreflightFailure,
  type RunningOrganizationAdminEdge,
  type OrganizationAdminEdgeServePreflight,
} from './edge.js';

const USAGE = `usage:
  echo-organization-admin-edge preflight --config <absolute-path>
  echo-organization-admin-edge serve --config <absolute-path> [--acknowledge-unsupported-host-for-development]
  echo-organization-admin-edge --help`;

export interface OrganizationAdminEdgeCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface OrganizationAdminEdgeObservedPlatform {
  readonly os: string;
  readonly architecture: string;
  readonly node: string;
}

export interface OrganizationAdminEdgeCliDependencies {
  readonly inspect_runtime_platform?: () => OrganizationAdminEdgeObservedPlatform;
  readonly read_runtime_config?: (
    path: string,
  ) => OrganizationAdminEdgeRuntimeConfigV1;
  readonly resolve_serve_config?: (
    config: OrganizationAdminEdgeRuntimeConfigV1,
  ) => OrganizationAdminEdgeServeConfig;
  readonly preflight_serve_config?: (
    config: OrganizationAdminEdgeServeConfig,
  ) => OrganizationAdminEdgeServePreflight;
  readonly start_edge?: (
    config: OrganizationAdminEdgeServeConfig,
  ) => Promise<RunningOrganizationAdminEdge>;
  readonly register_shutdown_signal?: (
    signal: 'SIGINT' | 'SIGTERM',
    listener: () => void,
  ) => void;
}

interface OrganizationAdminEdgePlatformPreflight {
  readonly release_platform_qualified: boolean;
  readonly mismatches: readonly string[];
}

interface OrganizationAdminEdgeServeArguments {
  readonly config_path: string;
  readonly acknowledge_unsupported_host_for_development: boolean;
}

type OrganizationAdminEdgeCliPreflightFailure =
  | 'release_platform'
  | 'runtime_config'
  | 'runtime_material'
  | OrganizationAdminEdgePreflightFailure;

export const ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM = Object.freeze({
  os: 'darwin',
  architecture: 'arm64',
  node: '22.22.1',
  npm: '10.9.4',
});

const PROCESS_IO: OrganizationAdminEdgeCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function serveArguments(
  arguments_: readonly string[],
): OrganizationAdminEdgeServeArguments {
  let configPath: string | undefined;
  let acknowledgeUnsupportedHostForDevelopment = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--config') {
      const value = arguments_[index + 1];
      if (
        configPath !== undefined ||
        value === undefined ||
        value.length === 0 ||
        value.startsWith('--')
      ) {
        throw new Error(USAGE);
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (argument === '--acknowledge-unsupported-host-for-development') {
      if (acknowledgeUnsupportedHostForDevelopment) throw new Error(USAGE);
      acknowledgeUnsupportedHostForDevelopment = true;
      continue;
    }
    throw new Error(USAGE);
  }
  if (configPath === undefined) throw new Error(USAGE);
  return {
    config_path: configPath,
    acknowledge_unsupported_host_for_development:
      acknowledgeUnsupportedHostForDevelopment,
  };
}

function preflightFailure(
  io: OrganizationAdminEdgeCliIo,
  observedPlatform: OrganizationAdminEdgeObservedPlatform,
  failedCheck: OrganizationAdminEdgeCliPreflightFailure,
): number {
  io.stdout(
    `${JSON.stringify({
      schema_version: 1,
      kind: 'echo-organization-admin-edge-preflight',
      ok: false,
      release_platform_qualified: failedCheck !== 'release_platform',
      declared_platform: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM,
      observed_platform: observedPlatform,
      failed_check: failedCheck,
    })}\n`,
  );
  return 1;
}

export function inspectOrganizationAdminEdgeRuntimePlatform(): OrganizationAdminEdgeObservedPlatform {
  return Object.freeze({
    os: process.platform,
    architecture: process.arch,
    node: process.versions.node,
  });
}

export function organizationAdminEdgePlatformPreflight(
  observed: OrganizationAdminEdgeObservedPlatform,
  acknowledgeUnsupportedHostForDevelopment: boolean,
): OrganizationAdminEdgePlatformPreflight {
  const mismatches = (
    [
      ['os', ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.os, observed.os],
      [
        'architecture',
        ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.architecture,
        observed.architecture,
      ],
      ['node', ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.node, observed.node],
    ] as const
  )
    .filter(([, expected, actual]) => expected !== actual)
    .map(([name, expected, actual]) => `${name}:${expected}->${actual}`);
  if (mismatches.length === 0) {
    if (acknowledgeUnsupportedHostForDevelopment) {
      throw new Error(
        'organization admin edge platform preflight: the development-only unsupported-host acknowledgement is invalid on the declared release platform',
      );
    }
    return Object.freeze({
      release_platform_qualified: true,
      mismatches: Object.freeze([]),
    });
  }
  if (!acknowledgeUnsupportedHostForDevelopment) {
    throw new Error(
      `organization admin edge platform preflight: release runtime requires darwin/arm64 Node ${ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM.node}; observed ${observed.os}/${observed.architecture} Node ${observed.node}; mismatches ${mismatches.join(', ')}; --acknowledge-unsupported-host-for-development is required only for a loopback development or rehearsal`,
    );
  }
  return Object.freeze({
    release_platform_qualified: false,
    mismatches: Object.freeze(mismatches),
  });
}

export function assertOrganizationAdminEdgeDevelopmentListener(
  listenerHost: string,
): void {
  if (listenerHost !== '127.0.0.1' && listenerHost !== '::1') {
    throw new Error(
      'organization admin edge platform preflight: the development-only unsupported-host acknowledgement requires an exact loopback listener',
    );
  }
}

export async function runOrganizationAdminEdgeCli(
  arguments_: readonly string[],
  io: OrganizationAdminEdgeCliIo = PROCESS_IO,
  dependencies: OrganizationAdminEdgeCliDependencies = {},
): Promise<number> {
  const command = arguments_[0];
  const commandArguments = arguments_.slice(1);
  if (command === '--help' || command === 'help') {
    if (commandArguments.length !== 0) throw new Error(USAGE);
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command !== 'preflight' && command !== 'serve') {
    throw new Error(USAGE);
  }

  const serve = serveArguments(commandArguments);
  if (
    command === 'preflight' &&
    serve.acknowledge_unsupported_host_for_development
  ) {
    throw new Error(USAGE);
  }
  const observedPlatform = (
    dependencies.inspect_runtime_platform ??
    inspectOrganizationAdminEdgeRuntimePlatform
  )();
  let platformPreflight: OrganizationAdminEdgePlatformPreflight;
  try {
    platformPreflight = organizationAdminEdgePlatformPreflight(
      observedPlatform,
      serve.acknowledge_unsupported_host_for_development,
    );
  } catch (error) {
    if (command === 'preflight') {
      return preflightFailure(io, observedPlatform, 'release_platform');
    }
    throw error;
  }
  let runtimeConfig: OrganizationAdminEdgeRuntimeConfigV1;
  try {
    runtimeConfig = (
      dependencies.read_runtime_config ??
      readOrganizationAdminEdgeRuntimeConfig
    )(serve.config_path);
  } catch (error) {
    if (command === 'preflight') {
      return preflightFailure(io, observedPlatform, 'runtime_config');
    }
    throw error;
  }
  if (!platformPreflight.release_platform_qualified) {
    assertOrganizationAdminEdgeDevelopmentListener(
      runtimeConfig.listener.host,
    );
    io.stderr(
      `${JSON.stringify({
        schema_version: 1,
        kind: 'echo-organization-admin-edge-development-platform-acknowledgement',
        release_platform_qualified: false,
        declared_platform: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM,
        observed_platform: observedPlatform,
        mismatches: platformPreflight.mismatches,
      })}\n`,
    );
  }
  let serveConfig: OrganizationAdminEdgeServeConfig;
  try {
    serveConfig = (
      dependencies.resolve_serve_config ??
      resolveOrganizationAdminEdgeServeConfig
    )(runtimeConfig);
  } catch (error) {
    if (command === 'preflight') {
      return preflightFailure(io, observedPlatform, 'runtime_material');
    }
    throw error;
  }
  if (command === 'preflight') {
    let preflight: OrganizationAdminEdgeServePreflight;
    try {
      preflight = (
        dependencies.preflight_serve_config ??
        preflightOrganizationAdminEdgeServeConfig
      )(serveConfig);
    } catch (error) {
      if (error instanceof OrganizationAdminEdgePreflightError) {
        return preflightFailure(
          io,
          observedPlatform,
          error.failed_check,
        );
      }
      throw error;
    }
    io.stdout(
      `${JSON.stringify({
        schema_version: 1,
        kind: 'echo-organization-admin-edge-preflight',
        ok: true,
        release_platform_qualified: true,
        declared_platform: ORGANIZATION_ADMIN_EDGE_DECLARED_PLATFORM,
        observed_platform: observedPlatform,
        listener: preflight.listener,
        public_origin: preflight.public_origin,
        employee_authority_base_url:
          preflight.employee_authority_base_url,
        authority_origin: preflight.authority_origin,
        allowed_admin_client_count:
          preflight.allowed_admin_client_count,
        checked_at: preflight.checked_at,
        server_certificate_not_before:
          preflight.server_certificate_not_before,
        server_certificate_not_after:
          preflight.server_certificate_not_after,
        client_ca_certificate_count:
          preflight.client_ca_certificate_count,
      })}\n`,
    );
    return 0;
  }
  const edge = await (dependencies.start_edge ?? startOrganizationAdminEdge)(
    serveConfig,
  );
  io.stderr(
    `${JSON.stringify({
      schema_version: 1,
      kind: 'echo-organization-admin-edge-ready',
      host: edge.address.address,
      port: edge.address.port,
      public_origin: runtimeConfig.public_origin,
      release_platform_qualified:
        platformPreflight.release_platform_qualified,
    })}\n`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void edge.close().catch(() => {
      io.stderr('organization admin edge shutdown failed\n');
      process.exitCode = 1;
    });
  };
  const registerShutdownSignal =
    dependencies.register_shutdown_signal ??
    ((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      process.once(signal, listener);
    });
  registerShutdownSignal('SIGINT', shutdown);
  registerShutdownSignal('SIGTERM', shutdown);
  return 0;
}
