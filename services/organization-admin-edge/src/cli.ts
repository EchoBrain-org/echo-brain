import {
  readOrganizationAdminEdgeRuntimeConfig,
  resolveOrganizationAdminEdgeServeConfig,
} from './config.js';
import { startOrganizationAdminEdge } from './edge.js';

const USAGE = `usage:
  echo-organization-admin-edge serve --config <absolute-path>
  echo-organization-admin-edge --help`;

export interface OrganizationAdminEdgeCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const PROCESS_IO: OrganizationAdminEdgeCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function configPath(arguments_: readonly string[]): string {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== '--config' ||
    arguments_[1] === undefined ||
    arguments_[1].length === 0
  ) {
    throw new Error(USAGE);
  }
  return arguments_[1];
}

export async function runOrganizationAdminEdgeCli(
  arguments_: readonly string[],
  io: OrganizationAdminEdgeCliIo = PROCESS_IO,
): Promise<number> {
  const command = arguments_[0];
  const commandArguments = arguments_.slice(1);
  if (command === '--help' || command === 'help') {
    if (commandArguments.length !== 0) throw new Error(USAGE);
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command !== 'serve') throw new Error(USAGE);

  const runtimeConfig = readOrganizationAdminEdgeRuntimeConfig(
    configPath(commandArguments),
  );
  const edge = await startOrganizationAdminEdge(
    resolveOrganizationAdminEdgeServeConfig(runtimeConfig),
  );
  io.stderr(
    `${JSON.stringify({
      schema_version: 1,
      kind: 'echo-organization-admin-edge-ready',
      host: edge.address.address,
      port: edge.address.port,
      public_origin: runtimeConfig.public_origin,
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
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}
