// `npm start`: the dev build with the fixture Authority in a throwaway home.
// It never reads or writes your real ECHO session.
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-desktop-home-')));
const userData = realpathSync(mkdtempSync(join(tmpdir(), 'echo-desktop-data-')));
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, [join(root, 'build', 'main.cjs')], {
  stdio: 'inherit',
  env: {
    ...process.env, ECHO_HOME: home, ECHO_DESKTOP_USER_DATA: userData,
    ECHO_DESKTOP_TEST_FIXTURES: join(root, 'test', 'fixtures'), ECHO_DESKTOP_TEST_MODE: process.argv[2] ?? '',
  },
});
child.on('exit', code => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
  process.exit(code ?? 0);
});
