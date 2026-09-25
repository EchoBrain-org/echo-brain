import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
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
  calls(): { method: string; path: string; query: string; body?: Record<string, unknown> }[];
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

/** Test builds keep the Account menu the page last opened, and the tray's menu: no test can click a native menu. */
interface Menus { echoTestAccountMenu?: Electron.Menu; echoTestTrayMenu?: Electron.Menu }

/** Opens the Account menu the way a person does: the page asks main to pop it up. */
export async function openAccountMenu(run: Launched, opener: Locator): Promise<void> {
  await run.app.evaluate(() => { delete (globalThis as Menus).echoTestAccountMenu; });
  await opener.click();
  await expect.poll(() => run.app.evaluate(() => (globalThis as Menus).echoTestAccountMenu !== undefined)).toBe(true);
}

/** Opens the Account menu, then chooses one item from it. */
export async function chooseFromAccountMenu(run: Launched, opener: Locator, label: string): Promise<void> {
  await openAccountMenu(run, opener);
  await run.app.evaluate((_electron, wanted) => {
    const item = (globalThis as Menus).echoTestAccountMenu!.items.find(entry => entry.label === wanted);
    if (!item?.enabled || !item.visible) throw new Error(`${wanted} is not in the Account menu`);
    item.click();
  }, label);
}

/** What the Account menu the page last opened shows, or the tray's menu (its Account submenu inline). */
export function menuLabels(run: Launched, which: 'account' | 'tray' | 'tray-account'): Promise<string[]> {
  return run.app.evaluate((_electron, which) => {
    const menus = globalThis as Menus;
    const tray = menus.echoTestTrayMenu!;
    const menu = which === 'account' ? menus.echoTestAccountMenu!
      : which === 'tray' ? tray : tray.items.find(item => item.label === 'Account')!.submenu!;
    return menu.items.filter(item => item.type !== 'separator' && item.visible).map(item => item.label);
  }, which);
}

/** Chooses an item under the tray's Account submenu. */
export function chooseFromTray(run: Launched, label: string): Promise<void> {
  return run.app.evaluate((_electron, wanted) => {
    const account = (globalThis as Menus).echoTestTrayMenu!.items.find(item => item.label === 'Account')!.submenu!;
    const item = account.items.find(entry => entry.label === wanted);
    if (!item?.enabled) throw new Error(`${wanted} is not in the tray's Account menu`);
    item.click();
  }, label);
}

/**
 * Drops one file on a target, as a drag from Finder does. Playwright cannot
 * drag from the desktop, so a hidden file input makes a File with a real path
 * on disk; `null` drops a file made in the page, which has none.
 */
export async function drop(page: Page, target: Locator, path: string | null): Promise<void> {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  if (path) {
    await page.evaluate(() => {
      const input = Object.assign(document.createElement('input'), { type: 'file', id: 'drop-source', hidden: true });
      document.body.append(input);
    });
    await page.setInputFiles('#drop-source', path);
    await page.evaluate(dataTransfer => {
      const input = document.getElementById('drop-source') as HTMLInputElement;
      dataTransfer.items.add(input.files![0]!);
      input.remove();
    }, transfer);
  } else {
    await page.evaluate(dataTransfer => { dataTransfer.items.add(new File(['made in the page'], 'Made.txt', { type: 'text/plain' })); }, transfer);
  }
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
}
