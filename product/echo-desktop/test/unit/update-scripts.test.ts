// The bash the app leaves behind when it quits for an update (ADR-0035), run
// with real bash against stand-in bundles, a `sleep` as the app, and fake
// pkexec, open and launcher scripts that record what they were given.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAUNCHER, SWAP_HELPER } from '../../src/main/update-scripts.js';

const RELEASE = 'clean-v1-release-b';
/** The app's id for this attempt, which every record of it carries. */
const ATTEMPT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ended = (status: string) => ({ schema_version: 1, release: RELEASE, attempt: ATTEMPT, status });
const folders: string[] = [];
const apps: ChildProcess[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.kill('SIGKILL');
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'echo-update-script-')));
  folders.push(path);
  return path;
}

/** A process standing in for the app: alive until the test ends it. */
function app(): ChildProcess {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  apps.push(child);
  return child;
}
async function quit(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  return path;
}
/** A command that writes its arguments, one per line, to `record`. */
const recorder = (path: string, record: string) => script(path, `for argument in "$@"; do printf '%s\\n' "$argument"; done > '${record}'`);

async function runScript(text: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; child: ChildProcess }> {
  const root = folder();
  const path = join(root, 'activate.sh');
  writeFileSync(path, text, { mode: 0o700 });
  const child = spawn('/bin/bash', [path, ...args], { stdio: 'ignore', env });
  const [code] = await once(child, 'exit') as [number | null];
  return { code, child };
}
const outcome = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown;
const until = async (check: () => boolean) => { await expect.poll(check, { timeout: 10_000, interval: 50 }).toBe(true); };

describe('the macOS swap helper', () => {
  function bundles() {
    const root = folder();
    const bundle = join(root, 'Applications', 'ECHO.app');
    const updater = join(root, 'desktop', 'updater');
    const staged = join(updater, 'staged', 'ECHO.app');
    for (const [path, marker] of [[bundle, 'old'], [staged, 'new']] as const) {
      mkdirSync(join(path, 'Contents'), { recursive: true });
      writeFileSync(join(path, 'Contents', 'release'), marker);
    }
    const opened = join(root, 'opened');
    const f = {
      bundle, staged, opened, outcome: join(updater, 'outcome.json'), previous: join(updater, 'previous', 'ECHO.app'),
      open: recorder(join(root, 'open'), opened),
      marker: (path: string) => readFileSync(join(path, 'Contents', 'release'), 'utf8'),
      args: (pid: number, release = RELEASE, attempt = ATTEMPT) => [String(pid), bundle, staged, f.previous, f.outcome, release, attempt, f.open],
    };
    return f;
  }

  it('waits for the app to quit, swaps the staged bundle in, keeps the old one and opens the new one', async () => {
    const f = bundles();
    const running = app();
    const swap = runScript(SWAP_HELPER, f.args(running.pid!));
    // Nothing moves while the app runs.
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(f.marker(f.bundle)).toBe('old');
    expect(existsSync(f.outcome)).toBe(false);
    await quit(running);
    expect((await swap).code).toBe(0);
    expect(f.marker(f.bundle)).toBe('new');
    expect(f.marker(f.previous)).toBe('old');
    expect(existsSync(f.staged)).toBe(false);
    expect(outcome(f.outcome)).toEqual(ended('installed'));
    expect(statSync(f.outcome).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.opened, 'utf8')).toBe(`${f.bundle}\n`);
  });

  it('puts the old bundle back and reopens it when the staged one cannot be moved in', async () => {
    const f = bundles();
    rmSync(f.staged, { recursive: true });
    const running = app();
    await quit(running);
    await runScript(SWAP_HELPER, f.args(running.pid!));
    expect(f.marker(f.bundle)).toBe('old');
    expect(existsSync(f.previous)).toBe(false);
    expect(outcome(f.outcome)).toEqual(ended('failed'));
    expect(readFileSync(f.opened, 'utf8')).toBe(`${f.bundle}\n`);
  });

  it('leaves both bundles alone and opens nothing when the app never quits', async () => {
    const f = bundles();
    const running = app();
    // The last argument shortens the two-minute wait.
    const { code } = await runScript(SWAP_HELPER, [...f.args(running.pid!), '1']);
    expect(code).not.toBe(0);
    expect(f.marker(f.bundle)).toBe('old');
    expect(f.marker(f.staged)).toBe('new');
    expect(outcome(f.outcome)).toEqual(ended('failed'));
    expect(existsSync(f.opened)).toBe(false);
  });

  it('refuses a release id or an attempt id that is not one', async () => {
    const f = bundles();
    const running = app();
    await quit(running);
    for (const [release, attempt] of [['release","status":"installed', ATTEMPT], [RELEASE, 'x","status":"installed'], [RELEASE, '']] as const) {
      const { code } = await runScript(SWAP_HELPER, f.args(running.pid!, release, attempt));
      expect(code).toBe(2);
      expect(f.marker(f.bundle)).toBe('old');
      expect(existsSync(f.outcome)).toBe(false);
    }
  });
});

describe('the Linux relauncher', () => {
  function seat(pkexecBody: string) {
    const root = folder();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // macOS has no setsid: a stand-in that runs the command, as setsid does.
    if (process.platform !== 'linux') script(join(bin, 'setsid'), 'exec "$@"');
    const called = join(root, 'pkexec-args');
    const launched = join(root, 'launched');
    const updater = join(root, 'updater');
    mkdirSync(updater, { mode: 0o700 });
    const launcher = recorder(join(root, 'echo-desktop'), launched);
    // macOS checks a new executable on its first run, which can take longer
    // than the wait below: run the stand-ins once so a launch shows at once.
    if (process.platform !== 'linux') execFileSync(join(bin, 'setsid'), ['true']);
    execFileSync(launcher);
    rmSync(launched);
    return {
      called, launched,
      progress: join(updater, 'progress'), outcome: join(updater, 'outcome.json'),
      feed: join(updater, 'staged', 'feed.json'), deb: join(updater, 'staged', 'echo-desktop.deb'),
      pkexec: script(join(root, 'pkexec'), `printf '%s\\n' "$@" > '${called}'\npid="\${@: -1}"\n${pkexecBody}`),
      helper: '/opt/ECHO/resources/echo-desktop-update-helper',
      launcher,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    };
  }
  /** As the real helper: it waits for the app to quit before installing. */
  const waitForApp = 'while kill -0 "$pid" 2> /dev/null; do sleep 0.05; done';
  const args = (f: ReturnType<typeof seat>, pid: number, attempt = ATTEMPT) => [String(pid), f.feed, f.deb, f.progress, f.outcome, RELEASE, attempt, f.pkexec, f.helper, f.launcher];
  /** The progress file: the attempt first, so the app never takes another attempt's verified for its own. */
  const progress = (helper: string) => `attempt ${ATTEMPT}\n${helper}`;

  it('runs the helper under pkexec, reports verified, and reopens ECHO once the app has quit, installed or not', async () => {
    for (const [code, status] of [[0, 'installed'], [5, 'failed']] as const) {
      const f = seat(`echo verified\n${waitForApp}\nexit ${code}`);
      const running = app();
      const relaunch = runScript(RELAUNCHER, args(f, running.pid!), f.env);
      await until(() => existsSync(f.progress) && readFileSync(f.progress, 'utf8') === progress('verified\n'));
      expect(existsSync(f.outcome)).toBe(false);
      await quit(running);
      expect((await relaunch).code).toBe(0);
      expect(readFileSync(f.called, 'utf8').split('\n').slice(0, -1))
        .toEqual([f.helper, 'install', '--feed', f.feed, '--deb', f.deb, '--wait-pid', String(running.pid)]);
      expect(outcome(f.outcome)).toEqual(ended(status));
      expect(statSync(f.outcome).mode & 0o777).toBe(0o600);
      await until(() => existsSync(f.launched));
      expect(readFileSync(f.launched, 'utf8')).toBe('');
    }
  });

  it('records a cancelled prompt, or refused authentication as failed, and leaves the running app alone', async () => {
    for (const [code, status] of [[126, 'cancelled'], [127, 'failed']] as const) {
      const f = seat(`exit ${code}`);
      const running = app();
      await runScript(RELAUNCHER, args(f, running.pid!), f.env);
      expect(outcome(f.outcome)).toEqual(ended(status));
      expect(readFileSync(f.progress, 'utf8')).toBe(progress(''));
      await new Promise(resolve => setTimeout(resolve, 1_000));
      expect(existsSync(f.launched)).toBe(false);
      expect(running.exitCode).toBeNull();
    }
  });

  it('runs nothing without all its arguments, or with an attempt id that is not one', async () => {
    const f = seat('exit 0');
    for (const given of [args(f, process.pid).slice(0, 9), args(f, process.pid, 'x","status":"installed'), args(f, process.pid, ATTEMPT.toUpperCase())]) {
      const { code } = await runScript(RELAUNCHER, given, f.env);
      expect(code).toBe(2);
      expect(existsSync(f.called)).toBe(false);
      expect(existsSync(f.progress)).toBe(false);
      expect(existsSync(f.outcome)).toBe(false);
    }
  });
});
