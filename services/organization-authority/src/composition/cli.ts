import { canonicalJson } from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import {
  loadAuthorityServeConfig,
  loadDevelopmentSignerConfig,
} from './config.js';
import {
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from './operator-config.js';
import {
  initializeDevelopmentAuthority,
  inspectAuthorityServePreflight,
} from './operator-state.js';
import { initializeMissingLegacyDevelopmentDatabase } from './legacy-development-state.js';
import { startOrganizationAuthority } from './runtime.js';
import { canonicalAuthorityStatus, inspectAuthorityStatus } from './status.js';

const USAGE = `usage:
  echo-organization-authority init-development --config <absolute-path> --state-dir <absolute-path> --organization-name <name> [--port <1-65535>]
  echo-organization-authority serve --config <absolute-path>
  echo-organization-authority status --config <absolute-path>`;

interface AuthorityCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const PROCESS_IO: AuthorityCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function parseFlags(
  arguments_: readonly string[],
  accepted: readonly string[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const allowed = new Set(accepted);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      !allowed.has(flag) ||
      value === undefined ||
      result[flag] !== undefined
    ) {
      throw new Error(USAGE);
    }
    result[flag] = value;
  }
  return result;
}

function requiredFlag(
  flags: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = flags[name];
  if (value === undefined || value.length === 0) throw new Error(USAGE);
  return value;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error(USAGE);
  const port = Number(value);
  if (port > 65_535) throw new Error(USAGE);
  return port;
}

async function runLegacyDevelopmentInitialization(
  environment: NodeJS.ProcessEnv,
  io: AuthorityCliIo,
): Promise<number> {
  const config = loadDevelopmentSignerConfig(environment);
  const signer = DevelopmentFileOrganizationAuthoritySigner.initialize({
    directory: config.key_directory,
    authority_id: config.authority_id,
    organization_id: config.organization_id,
  });
  const descriptor = await signer.inspect();
  io.stdout(
    `${canonicalJson({
      authority_descriptor: descriptor,
      authority_pin_sha256: organizationAuthorityPinSha256(descriptor),
    })}\n`,
  );
  return 0;
}

async function runServe(
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv,
  io: AuthorityCliIo,
): Promise<number> {
  const runtimeConfig =
    configPath === undefined
      ? undefined
      : readAuthorityRuntimeConfig(configPath);
  if (runtimeConfig !== undefined && configPath !== undefined) {
    await inspectAuthorityServePreflight(configPath, runtimeConfig);
  }
  const config =
    runtimeConfig === undefined
      ? loadAuthorityServeConfig(environment)
      : resolveAuthorityServeConfig(runtimeConfig);
  if (runtimeConfig === undefined) {
    await initializeMissingLegacyDevelopmentDatabase(config);
  }
  const runtime = await startOrganizationAuthority(config);
  const listening =
    `organization authority listening on ${runtime.address.address}:` +
    String(runtime.address.port);
  io.stderr(
    `${canonicalJson({
      schema_version: 1,
      kind: 'echo-organization-authority-ready',
      host: runtime.address.address,
      port: runtime.address.port,
      message: listening,
    })}\n`,
  );
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.close().catch((error: unknown) => {
      io.stderr(
        `${error instanceof Error ? error.message : 'authority shutdown failed'}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

export async function runOrganizationAuthorityCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: AuthorityCliIo = PROCESS_IO,
): Promise<number> {
  const command = arguments_[0];
  const commandArguments = arguments_.slice(1);
  if (command === 'help' || command === '--help') {
    if (commandArguments.length !== 0) throw new Error(USAGE);
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command === 'init-development') {
    if (commandArguments.length === 0) {
      return await runLegacyDevelopmentInitialization(environment, io);
    }
    const flags = parseFlags(commandArguments, [
      '--config',
      '--state-dir',
      '--organization-name',
      '--port',
    ]);
    const port = parsePort(flags['--port']);
    const result = await initializeDevelopmentAuthority({
      config_path: requiredFlag(flags, '--config'),
      state_directory: requiredFlag(flags, '--state-dir'),
      organization_display_name: requiredFlag(flags, '--organization-name'),
      ...(port === undefined ? {} : { port }),
    });
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'serve') {
    if (commandArguments.length === 0) {
      return await runServe(undefined, environment, io);
    }
    const flags = parseFlags(commandArguments, ['--config']);
    return await runServe(requiredFlag(flags, '--config'), environment, io);
  }
  if (command === 'status') {
    const flags = parseFlags(commandArguments, ['--config']);
    const report = await inspectAuthorityStatus(
      requiredFlag(flags, '--config'),
    );
    io.stdout(`${canonicalAuthorityStatus(report)}\n`);
    return report.ok ? 0 : 1;
  }
  throw new Error(USAGE);
}
