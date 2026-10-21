import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';

/** Non-secret operator selection. Only the unmodified Claude binary reads its own sign-in. */
export interface ClaudeAccountProfileV1 {
  readonly home_directory: string;
  readonly executable_path: string;
}

export interface PersonalClaudeResearchV1 extends ClaudeAccountProfileV1 {
  readonly membership_id: string;
}

export function assertPersonalClaudeResearchV1(value: PersonalClaudeResearchV1): void {
  if (!/^mem_[a-zA-Z0-9-]{1,100}$/u.test(value.membership_id) ||
      ![value.home_directory, value.executable_path].every(path => isAbsolute(path) && !/[\x00-\x1f]/u.test(path))) {
    throw new Error('Personal Claude research selection is invalid');
  }
}

/** Fail closed rather than silently charging a cached API key or the service account. */
export async function claudeAccountEnvironmentV1(profile: ClaudeAccountProfileV1, signal: AbortSignal): Promise<Record<string, string>> {
  const config = join(profile.home_directory, '.claude');
  const env = {
    // Setting CLAUDE_CONFIG_DIR, even to the default, selects a different macOS Keychain entry.
    HOME: profile.home_directory, USER: userInfo().username,
    XDG_CONFIG_HOME: join(profile.home_directory, '.config'), XDG_DATA_HOME: join(profile.home_directory, '.local/share'),
    XDG_STATE_HOME: join(profile.home_directory, '.local/state'),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  try {
    signal.throwIfAborted();
    const directory = await lstat(config);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) !== 0 || directory.uid !== process.getuid?.()) throw new Error('unsafe profile');
    const { stdout } = await promisify(execFile)(profile.executable_path, ['auth', 'status', '--json'], {
      env, cwd: profile.home_directory, signal, timeout: 15_000, maxBuffer: 64 * 1024,
    });
    const status: unknown = JSON.parse(stdout);
    if (status === null || typeof status !== 'object' || !('loggedIn' in status) || status.loggedIn !== true ||
        !('authMethod' in status) || status.authMethod !== 'claude.ai') throw new Error('not a Claude account');
    return env;
  } catch {
    signal.throwIfAborted();
    // Native diagnostics can contain account details; never attach the child error or stdout.
    throw new Error('Personal Claude sign-in is unavailable');
  }
}
