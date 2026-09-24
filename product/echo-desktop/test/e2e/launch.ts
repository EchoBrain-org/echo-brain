import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  home: string;
  /** Chromium's data and ECHO's diagnostic log. */
  userData: string;
  /** Requests the real person client sent to the fixture Authority. */
  calls(): { method: string; path: string; body?: Record<string, unknown> }[];
  close(): Promise<void>;
}

/** The real app with a private temporary home: never the founder's session. */
export async function launch(mode = ''): Promise<Launched> {
  // The session store requires a canonical private folder (macOS /var is a link).
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-desktop-home-')));
  const userData = mkdtempSync(join(tmpdir(), 'echo-desktop-data-'));
  const app = await electron.launch({
    args: [join(root, 'build', 'main.cjs')],
    env: {
      ...process.env,
      ECHO_HOME: home,
      ECHO_DESKTOP_USER_DATA: userData,
      ECHO_DESKTOP_TEST_FIXTURES: join(root, 'test', 'fixtures'),
      ECHO_DESKTOP_TEST_MODE: mode,
      ECHO_DESKTOP_HIDDEN: '1',
    },
  });
  const page = await app.firstWindow();
  return {
    app, page, home, userData,
    calls() {
      const file = join(home, 'calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async close() {
      // Answer the quit guard's native dialog (an unresolved save) with Quit Anyway.
      await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; }).catch(() => undefined);
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

export function emit(app: ElectronApplication, event: 'echo-test:capture' | 'echo-test:conceal' | 'echo-test:resume' | 'echo-test:kill-host' | 'echo-test:shown') {
  return app.evaluate(({ app: electronApp }, name) => { electronApp.emit(name); }, event);
}
