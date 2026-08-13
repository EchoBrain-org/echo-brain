import { canonicalJson } from '@echo-brain/federation-protocol';
import { readAuthorityRuntimeConfig } from './operator-config.js';
import {
  activateOrganizationMemberRecording,
  activateOrganizationPermissionPilot,
  expireReadableSearchQueryAudit,
  expireReviewerQueryAudit,
  exportReadableSearchQueryAudit,
  exportReviewerQueryAudit,
  initializeDevelopmentAuthority,
  installAuthorityIntegrations,
  inspectAuthorityServePreflight,
  resolveEffectiveAuthorityServeConfig,
  rebuildAuthorityReadableSearch,
  rebuildAuthorityDerivedRecordStore,
  verifyAuthorityReadableSearchBackup,
} from './operator-state.js';
import { startOrganizationAuthority } from './runtime.js';
import { canonicalAuthorityStatus, inspectAuthorityStatus } from './status.js';

const USAGE = `usage:
  echo-organization-authority init-development --config <absolute-path> --state-dir <absolute-path> --organization-name <name> [--port <1-65535>]
  echo-organization-authority install-integrations --config <absolute-path>
  echo-organization-authority activate-permission-pilot --config <absolute-path> --command <absolute-json-path>
  echo-organization-authority activate-organization-member-recording --config <absolute-path> --command <absolute-json-path>
  echo-organization-authority reviewer-query-audit-export --config <absolute-path> --command <absolute-json-path> --output <absolute-path>
  echo-organization-authority reviewer-query-audit-expire --config <absolute-path> --command <absolute-json-path>
  echo-organization-authority readable-search-query-audit-export --config <absolute-path> --command <absolute-json-path> --output <absolute-path>
  echo-organization-authority readable-search-query-audit-expire --config <absolute-path> --command <absolute-json-path>
  echo-organization-authority rebuild-derived --config <absolute-path>
  echo-organization-authority rebuild-readable-search --config <absolute-path>
  echo-organization-authority verify-readable-search-backup --config <absolute-path>
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

async function runServe(
  configPath: string,
  io: AuthorityCliIo,
): Promise<number> {
  const runtimeConfig = readAuthorityRuntimeConfig(configPath);
  await inspectAuthorityServePreflight(configPath, runtimeConfig);
  const config = resolveEffectiveAuthorityServeConfig(
    configPath,
    runtimeConfig,
  );
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
  // The exit code and the whole teardown are already handled inside the
  // runtime; this is the operator-visible line explaining why an apparently
  // healthy process stopped answering. Claiming the stop keeps a later signal
  // from reporting the same halt a second time, and the command outlives the
  // runtime no further: with the listener, both databases, and singleton
  // ownership released, nothing is left holding this process open.
  void runtime.fatalFailure.then((failure) => {
    shuttingDown = true;
    io.stderr(
      `${canonicalJson({
        schema_version: 1,
        kind: 'echo-organization-authority-fatal',
        message: failure.message,
      })}\n`,
    );
  });
  return 0;
}

export async function runOrganizationAuthorityCli(
  arguments_: readonly string[],
  _environment: NodeJS.ProcessEnv,
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
    const flags = parseFlags(commandArguments, ['--config']);
    return await runServe(requiredFlag(flags, '--config'), io);
  }
  if (command === 'install-integrations') {
    const flags = parseFlags(commandArguments, ['--config']);
    const result = await installAuthorityIntegrations(
      requiredFlag(flags, '--config'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'activate-permission-pilot') {
    const flags = parseFlags(commandArguments, ['--config', '--command']);
    const result = await activateOrganizationPermissionPilot(
      requiredFlag(flags, '--config'),
      requiredFlag(flags, '--command'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'activate-organization-member-recording') {
    const flags = parseFlags(commandArguments, ['--config', '--command']);
    const result = await activateOrganizationMemberRecording(
      requiredFlag(flags, '--config'),
      requiredFlag(flags, '--command'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'reviewer-query-audit-export') {
    const flags = parseFlags(commandArguments, [
      '--config',
      '--command',
      '--output',
    ]);
    const result = await exportReviewerQueryAudit(
      requiredFlag(flags, '--config'),
      requiredFlag(flags, '--command'),
      requiredFlag(flags, '--output'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'reviewer-query-audit-expire') {
    const flags = parseFlags(commandArguments, ['--config', '--command']);
    const result = await expireReviewerQueryAudit(
      requiredFlag(flags, '--config'),
      requiredFlag(flags, '--command'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'readable-search-query-audit-export') {
    const flags = parseFlags(commandArguments, [
      '--config',
      '--command',
      '--output',
    ]);
    const result = await exportReadableSearchQueryAudit(
      requiredFlag(flags, '--config'),
      requiredFlag(flags, '--command'),
      requiredFlag(flags, '--output'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'readable-search-query-audit-expire') {
    const flags = parseFlags(commandArguments, ['--config', '--command']);
    const result = await expireReadableSearchQueryAudit(
      requiredFlag(flags, '--config'),
      requiredFlag(flags, '--command'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'rebuild-derived') {
    const flags = parseFlags(commandArguments, ['--config']);
    const result = await rebuildAuthorityDerivedRecordStore(
      requiredFlag(flags, '--config'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'rebuild-readable-search') {
    const flags = parseFlags(commandArguments, ['--config']);
    const result = await rebuildAuthorityReadableSearch(
      requiredFlag(flags, '--config'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
  }
  if (command === 'verify-readable-search-backup') {
    const flags = parseFlags(commandArguments, ['--config']);
    const result = await verifyAuthorityReadableSearchBackup(
      requiredFlag(flags, '--config'),
    );
    io.stdout(`${canonicalJson(result as never)}\n`);
    return 0;
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
