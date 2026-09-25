import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const refreshes = () => run.calls().filter(call => call.path === '/v2/session/refresh');

test('an expired access token is refreshed once, before the calls that need it', async () => {
  run = await launch('refresh-ok');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('project-row').nth(0).click();
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
  await page.getByTestId('ask-field').fill('What did we agree?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  expect(refreshes()).toHaveLength(1);
});

test('a failed refresh shows sign-in at once, and status alone never refreshes', async () => {
  run = await launch('refresh-fails');
  const { page, app } = run;
  const started = Date.now();
  await expect(page.getByTestId('signin')).toBeVisible();
  expect(Date.now() - started).toBeLessThan(2_500); // not the 3 s wait for a refresh elsewhere
  expect(refreshes()).toHaveLength(1);
  // Showing the window again re-reads status; it does not try the network.
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('signin')).toBeVisible();
  expect(refreshes()).toHaveLength(1);
});

test('a host that keeps exiting is given up on, and the page says ECHO could not start', async () => {
  run = await launch('host-crash');
  const { page } = run;
  await expect(page.getByTestId('start-failed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('signin')).toHaveCount(0);
  const log = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
  await expect.poll(log, { timeout: 10_000 }).toContain('host gave-up');
  expect(log().match(/host exit/g)).toHaveLength(3);
  await expect(page.getByTestId('start-failed')).toBeVisible();
});

test('quit waits out a refresh with the window open, and never touches the closed window', async () => {
  run = await launch('refresh-hangs');
  const { app, home } = run;
  await expect.poll(() => refreshes().length).toBe(1);
  // Any throw while quitting raises Electron's error box, which can hold the
  // quit open. macOS reports the app inactive after its window has closed.
  await app.evaluate(({ app: electronApp, BrowserWindow }, threw) => {
    BrowserWindow.getAllWindows()[0]!.once('closed', () => {
      try { electronApp.emit('did-resign-active'); } catch { process.getBuiltinModule('node:fs').writeFileSync(threw, ''); }
    });
  }, join(home, 'threw'));
  const exited = new Promise(resolveExit => app.process().once('exit', resolveExit));
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
  // Electron's own listeners throw on late notices to a closed window, so the
  // window closes only as the app exits.
  await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await exited; // the 5 s cap, not the refresh, ends the wait
  expect(existsSync(join(home, 'threw'))).toBe(false);
});

test('a crashed page reloads and reads status again', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(); });
  // Playwright drops a crashed page, so look from main at the reloaded one.
  // (A script sent to the dead page never settles, so each look is capped.)
  const rows = () => app.evaluate(({ BrowserWindow }) => Promise.race([
    BrowserWindow.getAllWindows()[0]!.webContents
      .executeJavaScript('document.querySelectorAll("[data-testid=project-row]").length').catch(() => -1),
    new Promise(resolveLook => setTimeout(() => resolveLook(-1), 500)),
  ]));
  await expect.poll(rows, { timeout: 10_000 }).toBe(2);
  const log = readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
  expect(log).toMatch(/renderer gone (crashed|killed)/);
});
