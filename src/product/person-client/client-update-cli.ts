import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientUpdateError, UPDATE_METADATA_LIMIT } from './client-update-contract.js';
import { readUpdateFile } from './client-update-files.js';
import {
  configureClientUpdates,
  detectUpdatePlatform,
  readClientUpdateConfig,
  runClientUpdate,
  type ClientUpdateResult,
} from './client-update.js';

const HELP = `usage: echo-brain update [--check | --status | --if-due] [--json]
       echo-brain update configure --file <trusted-config.json> [--json]

Install an available update now:
  echo-brain update

Check online without installing:
  echo-brain update --check

Show saved local update status without checking online:
  echo-brain update --status

Check and install an update when an automatic check is due:
  echo-brain update --if-due

Configure updates from an absolute trusted configuration file:
  echo-brain update configure --file /absolute/path/trusted-config.json

Use --json for machine-readable output. Output is also JSON when piped.
`;

type UpdateCliMode = 'apply' | 'check' | 'status' | 'automatic' | 'configure';
export interface ParsedClientUpdateCliArguments {
  mode: UpdateCliMode;
  json: boolean;
  file?: string;
}
interface UpdatePresentation {
  tty: boolean | undefined;
  json: boolean;
}
interface UpdateResultPresentation extends UpdatePresentation {
  mode: Exclude<UpdateCliMode, 'configure'>;
  automatic: boolean;
}

export function parseClientUpdateCliArguments(argv: readonly string[]): ParsedClientUpdateCliArguments | undefined {
  const json = argv.filter(arg => arg === '--json');
  if (json.length > 1) return undefined;
  const args = argv.filter(arg => arg !== '--json');
  const jsonRequested = json.length === 1;
  if (!args.length) return { mode: 'apply', json: jsonRequested };
  if (args.length === 1 && args[0] === '--check') return { mode: 'check', json: jsonRequested };
  if (args.length === 1 && args[0] === '--status') return { mode: 'status', json: jsonRequested };
  if (args.length === 1 && args[0] === '--if-due') return { mode: 'automatic', json: jsonRequested };
  if (args.length === 3 && args[0] === 'configure' && args[1] === '--file') {
    return { mode: 'configure', json: jsonRequested, file: args[2] };
  }
  return undefined;
}

function jsonOutput(value: unknown): string {
  return JSON.stringify(value) + '\n';
}
function safeRelease(value: string | null): string {
  return value !== null && /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/.test(value) ? value : 'unknown';
}
function safeTimestamp(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) return 'unknown';
  return new Date(value).toISOString().replace('.000Z', 'Z');
}
function savedStatusDetails(result: ClientUpdateResult, automatic: boolean): string {
  return [
    'Installed release: ' + safeRelease(result.installed_release) + '.',
    'Latest known release: ' + safeRelease(result.available_release) + '.',
    'Last checked: ' + safeTimestamp(result.checked_at) + '.',
    'Automatic checks: ' + (automatic ? 'enabled' : 'disabled') + '.',
  ].join('\n');
}
function updateProblem(code: string): string {
  if (['installation_outcome_unknown', 'activation_mismatch'].includes(code)) {
    return 'ECHO could not confirm whether installation finished. Contact the release operator before retrying.';
  }
  if (code === 'expired_metadata') return 'The update information has expired. Try again later or contact the release operator.';
  if (['download_failed', 'download_too_large', 'incomplete_download', 'metadata_too_large'].includes(code)) return 'The update download failed. Your installed version was not changed.';
  if (['invalid_signature', 'artifact_mismatch', 'release_mismatch', 'changed_metadata', 'stale_metadata'].includes(code)) return 'The update could not be verified. It was not installed.';
  if (['unsupported_platform', 'adapter_unavailable'].includes(code)) return 'Updates are not supported for this installation.';
  if (code === 'update_busy') return 'Another ECHO update is already running. Try again shortly.';
  if (code === 'installed_client_required') return 'Updates can only run from an installed ECHO CLI release.';
  if (code === 'not_configured') return 'Updates are not configured. Use echo-brain update configure --file /absolute/path/trusted-config.json.';
  if (code === 'absolute_config_path_required') return 'The configuration file must use an absolute trusted path.';
  if (['installation_mismatch', 'invalid_config', 'already_configured'].includes(code)) return 'The update configuration is invalid or conflicts with this installation. Contact the release operator for the correct configuration.';
  if (['unsafe_installation', 'unsafe_update_file', 'invalid_update_state'].includes(code)) return 'ECHO could not safely use this installation or its update files. Contact the release operator before retrying.';
  return 'ECHO update failed. Please try again or contact the release operator.';
}
function savedResultProblem(code: string): string | undefined {
  if (code === 'updated') return 'Last saved update result: updated successfully.';
  if (code === 'current') return undefined;
  return updateProblem(code);
}

export function formatClientUpdateError(code: string, presentation: UpdatePresentation): string {
  if (!presentation.tty || presentation.json) return jsonOutput({ ok: false, error: code });
  return updateProblem(code) + '\n';
}

export function renderClientUpdateResult(result: ClientUpdateResult, presentation: UpdateResultPresentation): string {
  if (!presentation.tty || presentation.json) return jsonOutput(result);
  const installed = safeRelease(result.installed_release);
  const available = safeRelease(result.available_release);
  if (presentation.mode === 'status') {
    if (result.status === 'not_configured') return updateProblem(result.status) + '\n';
    if (result.status === 'not_checked') {
      return 'No saved update check yet.\nInstalled release: ' + installed + '.\nAutomatic checks: ' +
        (presentation.automatic ? 'enabled' : 'disabled') + '.\nRun echo-brain update --check to check online.\n';
    }
    let message = 'Saved update status (no online check).\n' + savedStatusDetails(result, presentation.automatic);
    if (result.status === 'available') message += '\nRun echo-brain update to install it.';
    else {
      const problem = savedResultProblem(result.status);
      if (problem) message += '\n' + problem;
    }
    return message + '\n';
  }
  if (result.status === 'updated') return 'Updated ECHO to ' + installed + '.\n';
  if (result.status === 'current') return 'ECHO is up to date. Installed release: ' + installed + '.\n';
  if (result.status === 'available') {
    return 'Update available. Installed release: ' + installed + '.\nAvailable release: ' + available +
      '.\nRun echo-brain update to install it.\n';
  }
  if (result.status === 'not_due') return 'Automatic update check is not due yet.\n' + savedStatusDetails(result, presentation.automatic) + '\n';
  if (result.status === 'automatic_disabled') return 'Automatic update checks are disabled. Installed release: ' + installed + '.\n';
  if (result.status === 'not_configured') return updateProblem(result.status) + '\n';
  return updateProblem(result.status) + '\n';
}

export function installedUpdateRoot(moduleUrl = import.meta.url): string | undefined {
  const releaseRoot = resolve(dirname(fileURLToPath(moduleUrl)), '../..');
  if (!existsSync(join(releaseRoot, '.echo-owned-release-v1')) || dirname(releaseRoot).split(/[\\/]/).at(-1) !== 'releases') return undefined;
  if (process.platform === 'darwin') {
    if (!process.env.HOME || dirname(dirname(releaseRoot)) !== join(process.env.HOME, 'Library/Application Support/ECHO/cli')) return undefined;
    // The old Mac kit owns a matched desktop app/CLI pair. Only the separate
    // CLI kit may enroll for independent automatic activation.
    const manifest = JSON.parse(readUpdateFile(join(releaseRoot, 'kit-manifest.v1.json'), UPDATE_METADATA_LIMIT).toString('utf8'));
    if (manifest.schema_version !== 3 || manifest.kind !== 'echo-person-cli-kit-v1' ||
        manifest.runtime?.platform !== 'darwin' || manifest.runtime?.architecture !== 'arm64') return undefined;
  }
  return dirname(dirname(releaseRoot));
}

export async function runClientUpdateCli(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(HELP); return 0; }
  const args = parseClientUpdateCliArguments(argv);
  if (!args) {
    process.stderr.write(HELP); return 2;
  }
  try {
    const root = installedUpdateRoot();
    if (!root) throw new ClientUpdateError('installed_client_required');
    if (args.mode === 'configure') {
      if (!args.file?.startsWith('/')) throw new ClientUpdateError('absolute_config_path_required');
      configureClientUpdates(root, JSON.parse(readUpdateFile(args.file, UPDATE_METADATA_LIMIT).toString('utf8')));
      const config = readClientUpdateConfig(root);
      if (!process.stdout.isTTY || args.json) {
        process.stdout.write(jsonOutput({ kind: 'echo-client-update-result-v1', status: 'configured' }));
      } else {
        process.stdout.write('Update checks configured. Automatic checks: ' + (config?.automatic ? 'enabled' : 'disabled') + '.\n');
      }
      return 0;
    }
    const config = readClientUpdateConfig(root);
    const platform = detectUpdatePlatform(config?.installation ?? 'cli-kit');
    const result = await runClientUpdate(args.mode, { root, platform });
    process.stdout.write(renderClientUpdateResult(result, {
      tty: process.stdout.isTTY,
      json: args.json,
      mode: args.mode,
      automatic: config?.automatic ?? false,
    }));
    return args.mode === 'status' || ['updated', 'current', 'available', 'not_due', 'automatic_disabled'].includes(result.status) ? 0 : 1;
  } catch (error) {
    process.stderr.write(formatClientUpdateError(error instanceof ClientUpdateError ? error.code : 'update_failed', {
      tty: process.stderr.isTTY,
      json: args.json,
    }));
    return 1;
  }
}

/** Runs before Person command dispatch, so no submitted operation is replayed. */
export async function updateBeforePersonCommand(argv: readonly string[]): Promise<number | undefined> {
  if (process.env.ECHO_CLIENT_UPDATE_DISPATCH === '1') return undefined;
  try {
    const root = installedUpdateRoot();
    if (!root) return undefined;
    const config = readClientUpdateConfig(root);
    if (!config?.automatic) return undefined;
    const result = await runClientUpdate('automatic', { root, platform: detectUpdatePlatform(config.installation) });
    if (result.status === 'updated') {
      process.stderr.write(`ECHO updated to ${result.installed_release}.\n`);
      const child = spawnSync(join(root, 'bin', 'echo-brain'), ['person', ...argv], {
        stdio: 'inherit', env: { ...process.env, ECHO_CLIENT_UPDATE_DISPATCH: '1' },
      });
      return child.status ?? 1;
    }
    if (!['current', 'not_due', 'automatic_disabled', 'update_busy'].includes(result.status)) {
      process.stderr.write(`ECHO update: ${result.status}; continuing with ${result.installed_release}.\n`);
    }
  } catch {
    process.stderr.write('ECHO update check failed; continuing with the installed client.\n');
  }
  return undefined;
}
