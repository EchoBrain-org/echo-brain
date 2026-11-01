import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { UpdateState } from '../../src/shared/protocol.js';

const root = resolve(import.meta.dirname, '..', '..');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  home: string;
  /** Chromium's data and ECHO's diagnostic log. */
  userData: string;
  /** Requests the real person client sent to the fixture Authority, with the progress and answer layout an Ask asked for. */
  calls(): { method: string; path: string; query: string; body?: Record<string, unknown>; progress?: string; layout?: string }[];
  close(): Promise<void>;
}

/** Chromium's words when Electron cannot open the X display, before any of ECHO's code runs. */
const NO_X_SERVER = 'Missing X server or $DISPLAY';

/**
 * Electron on fresh private folders. On the Linux runner a launch has, rarely, failed to open the X display while every
 * launch around it connected, and the cause is not known. That failure alone is tried once more on new folders, with
 * the X server's state attached to the test and annotated, so a repeat can name its cause. Any other launch failure,
 * or a second one, fails the test.
 */
async function start(mode: string, files: Readonly<Record<string, string>>, env: Readonly<Record<string, string>>):
  Promise<{ app: ElectronApplication; home: string; userData: string }> {
  for (let attempt = 1; ; attempt += 1) {
    // The session store requires a canonical private folder (macOS /var is a link).
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-desktop-home-')));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(home, name), text);
    const userData = mkdtempSync(join(tmpdir(), 'echo-desktop-data-'));
    try {
      const app = await electron.launch({
        args: [
          // Hidden Linux windows otherwise delay Playwright's frame-based stability checks.
          ...(process.platform === 'linux' ? ['--disable-frame-rate-limit'] : []),
          join(root, 'build', 'main.cjs'),
        ],
        env: {
          ...process.env,
          ...env,
          ECHO_HOME: home,
          ECHO_DESKTOP_USER_DATA: userData,
          ECHO_DESKTOP_TEST_FIXTURES: join(root, 'test', 'fixtures'),
          ECHO_DESKTOP_TEST_MODE: mode,
          ECHO_DESKTOP_HIDDEN: '1',
        },
      });
      return { app, home, userData };
    } catch (error) {
      rmSync(home, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
      if (attempt > 1 || process.platform !== 'linux' || !String(error).includes(NO_X_SERVER)) throw error;
      const state = xServerState();
      await test.info().attach('x-server-state', { body: state, contentType: 'text/plain' });
      test.info().annotations.push({ type: 'x-server-launch-retried', description: state });
      console.warn(`electron.launch could not open the X display; trying once more.\n${state}`);
    }
  }
}

/** What the X server and the runner looked like when a launch could not open the display: each line stands alone. */
function xServerState(): string {
  const shell = (command: string) => {
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 5_000 });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || `(exit ${result.status ?? result.signal})`;
  };
  const auth = process.env.XAUTHORITY;
  return [
    `DISPLAY=${process.env.DISPLAY ?? '(unset)'} XAUTHORITY=${auth ?? '(unset)'} auth file: ${auth ? (existsSync(auth) ? 'present' : 'missing') : '-'}`,
    `Xvfb: ${shell('pgrep -a Xvfb || echo "not running"')}`,
    `X clients connected: ${shell(`ss -xp state connected 2>/dev/null | grep -c '"Xvfb"'`)}`,
    `Xvfb open files: ${shell('ls /proc/$(pgrep -n Xvfb)/fd 2>/dev/null | wc -l')}`,
    `display answers: ${shell('command -v xdpyinfo >/dev/null && { xdpyinfo >/dev/null 2>&1 && echo yes || echo "no (exit $?)"; } || echo "xdpyinfo not installed"')}`,
    // The brackets keep pgrep's own shell, whose command line holds the pattern, out of the count.
    `electron processes: ${shell('pgrep -fc "[e]lectron/dist/electron" || true')}`,
    `load: ${shell('cat /proc/loadavg')}; memory available: ${shell(`awk '/MemAvailable/{print $2" kB"}' /proc/meminfo`)}`,
  ].join('\n');
}

/**
 * The real app with a private temporary home: never the founder's session. `files` are written into that home before the
 * app starts, such as the fixture Authority's switches (`hold-live` holds every live read until the test removes it).
 * `env` adds to the app's environment, such as `TZ` for the time zone it and its person client run in.
 */
export async function launch(mode = '', files: Readonly<Record<string, string>> = {}, env: Readonly<Record<string, string>> = {}): Promise<Launched> {
  const { app, home, userData } = await start(mode, files, env);
  const context = app.context();
  let contextClosed = false;
  context.once('close', () => { contextClosed = true; });
  // Electron contexts need explicit tracing; the test runner's trace alone
  // contains assertion steps but no browser snapshots.
  if (process.env.CI) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await app.firstWindow();
  // A hidden window on a busy runner can take half a second to draw its first frame, and what the app puts off to a frame
  // waits with it: the caret going to the Ask bar at launch then takes the focus from wherever the test has moved it. A test
  // starts once the window has drawn.
  await page.locator('.app').first().waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  let closed = false;
  return {
    app, page, home, userData,
    calls() {
      const file = join(home, 'calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (process.env.CI) {
          const info = test.info();
          const failed = info.status !== info.expectedStatus;
          const path = failed ? info.outputPath(`electron-${basename(home)}.zip`) : undefined;
          try {
            // A closed renderer can leave this context alive in the tray.
            await context.tracing.stop({ path });
          } catch (error) {
            // An exited app has already lost its context. Still run cleanup,
            // and preserve the original test result rather than a trace error.
            if (!contextClosed) throw error;
            return;
          }
          if (path) await info.attach('electron-trace', { path, contentType: 'application/zip' });
        }
      } finally {
        // Answer the quit guard's native dialog (an unresolved save) with Quit Anyway.
        await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; }).catch(() => undefined);
        try {
          await app.close();
        } finally {
          rmSync(home, { recursive: true, force: true });
          rmSync(userData, { recursive: true, force: true });
        }
      }
    },
  };
}

export function emit(app: ElectronApplication, event: 'echo-test:capture' | 'echo-test:conceal' | 'echo-test:resume' | 'echo-test:kill-host' | 'echo-test:shown'
  | 'echo-test:hidden' | 'echo-test:wake') {
  return app.evaluate(({ app: electronApp }, name) => { electronApp.emit(name); }, event);
}

/** Test builds record the notifications main would show: no test puts one on the machine. */
interface Notices { echoTestNotices?: { title: string; body: string; target: unknown; click(): void }[] }

/** The notifications shown so far, oldest first: their title, text and what a click opens. */
export function notices(run: Launched): Promise<{ title: string; body: string; target: unknown }[]> {
  return run.app.evaluate(() => ((globalThis as Notices).echoTestNotices ?? []).map(({ title, body, target }) => ({ title, body, target })));
}

/** Clicks the notification at `index`, as a person does. */
export function clickNotice(run: Launched, index: number): Promise<void> {
  return run.app.evaluate((_electron, at) => { (globalThis as Notices).echoTestNotices![at]!.click(); }, index);
}

/** Test builds never run the updater: this sets the row it would show, and tells the page as main does. */
export function setUpdateState(run: Launched, state: UpdateState): Promise<void> {
  return run.app.evaluate(({ app: electronApp }, next) => { electronApp.emit('echo-test:update', next); }, state);
}

/** The releases the page asked update.install for, oldest first. A test build records them and never quits. */
export function updateInstalls(run: Launched): Promise<string[]> {
  return run.app.evaluate(() => [...(globalThis as { echoTestUpdateInstalls?: string[] }).echoTestUpdateInstalls ?? []]);
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

/** Adds the fixture meeting through Tools → Granola, so its decision reaches Home. */
export async function addMeeting(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await expect(meetings).toContainText('ari@example.test · EchoBrain');
  // Your recent meetings list as the sheet opens. Granola's label is the meeting's own day; an evening in Pacific time
  // is already the next day in UTC.
  await expect(meetings.getByRole('button', { name: 'Pilot planning', exact: true })).toContainText('Oct 6');
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  const add = meetings.getByRole('button', { name: 'Add to ECHO', exact: true });
  await expect(add).toBeDisabled();
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await add.click();
  await expect(meetings.getByRole('status')).toHaveText('Added.');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-home').click();
}

/**
 * Sends every item of an open decision card to one place from its All items place menu: Don't keep, or No project, where
 * only you read it (ADR-0049; the Only me lock beside a place is its own button).
 */
export async function routeAll(card: Locator, choice: 'No project' | 'Don\'t keep'): Promise<void> {
  await card.getByTestId('route-all').click();
  const menu = card.getByTestId('route-menu');
  // No project names who reads it beside it ("No project only you"); the menu closes on either.
  await (choice === 'No project' ? menu.getByRole('radio', { name: /^No project\b/ }) : menu.getByRole('radio', { name: choice, exact: true })).click();
}

/** Adds the fixture meeting, then approves it from Home: every item to the project it suggests, or to no project, only you. Returns Home's rows. */
export async function approveFromHome(page: Page, onlyMe = false): Promise<Locator> {
  await addMeeting(page);
  await page.getByTestId('need-row').filter({ hasText: 'Pilot planning' }).click();
  const card = page.getByTestId('decision');
  if (onlyMe) await routeAll(card, 'No project');
  await card.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toContainText('Approved');
  return page.getByTestId('need-row');
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
