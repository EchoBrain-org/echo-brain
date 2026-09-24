import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientUpdateError, UPDATE_METADATA_LIMIT } from './client-update-contract.js';
import { readUpdateFile } from './client-update-files.js';
import { configureClientUpdates, detectUpdatePlatform, readClientUpdateConfig, runClientUpdate } from './client-update.js';

const HELP = 'usage: echo-brain update [--check | --status | --if-due | configure --file <trusted-config.json>]\n';

export function installedUpdateRoot(moduleUrl = import.meta.url): string | undefined {
  const releaseRoot = resolve(dirname(fileURLToPath(moduleUrl)), '../..');
  if (!existsSync(join(releaseRoot, '.echo-owned-release-v1')) || dirname(releaseRoot).split(/[\\/]/).at(-1) !== 'releases') return undefined;
  return dirname(dirname(releaseRoot));
}

export async function runClientUpdateCli(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(HELP); return 0; }
  const configure = argv.length === 3 && argv[0] === 'configure' && argv[1] === '--file';
  if (!configure && !(argv.length === 0 || (argv.length === 1 && ['--check', '--status', '--if-due'].includes(argv[0])))) {
    process.stderr.write(HELP); return 2;
  }
  try {
    const root = installedUpdateRoot();
    if (!root) throw new ClientUpdateError('installed_client_required');
    if (configure) {
      if (!argv[2].startsWith('/')) throw new ClientUpdateError('absolute_config_path_required');
      configureClientUpdates(root, JSON.parse(readUpdateFile(argv[2], UPDATE_METADATA_LIMIT).toString('utf8')));
      process.stdout.write(`${JSON.stringify({ kind: 'echo-client-update-result-v1', status: 'configured' })}\n`);
      return 0;
    }
    const config = readClientUpdateConfig(root);
    const platform = detectUpdatePlatform(config?.installation ?? (process.platform === 'linux' ? 'cli-kit' : 'electron'));
    const mode = argv[0] === '--status' ? 'status' : argv[0] === '--check' ? 'check' : argv[0] === '--if-due' ? 'automatic' : 'apply';
    const result = await runClientUpdate(mode, { root, platform });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return mode === 'status' || ['updated', 'current', 'available', 'not_due', 'automatic_disabled'].includes(result.status) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof ClientUpdateError ? error.code : 'update_failed' })}\n`);
    return 1;
  }
}

/** Runs before Person command dispatch, so no submitted operation is replayed. */
export async function updateBeforePersonCommand(argv: readonly string[]): Promise<number | undefined> {
  if (process.env.ECHO_CLIENT_UPDATE_DISPATCH === '1') return undefined;
  const root = installedUpdateRoot();
  if (!root) return undefined;
  try {
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
