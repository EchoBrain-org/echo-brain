import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chooseFromAccountMenu, emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const refreshes = () => run.calls().filter(call => call.path === '/v2/session/refresh');

/** Sign in with the fixture's browser, which stands in for Google, and land on Home. */
async function signIn(page: Page) {
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  // Neither the sign-in address, the loopback receiver nor a token reaches the page.
  const html = await page.content();
  for (const secret of ['accounts.example', '127.0.0.1', 'A'.repeat(43), 'R'.repeat(43)]) expect(html).not.toContain(secret);
}

test('signing in lands on Home, and signing in again as the same person keeps the draft but not the bar', async () => {
  run = await launch('signed-out');
  const { page, app, home } = run;
  await signIn(page);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Half a thought');
  await page.keyboard.press('Escape');
  await page.getByTestId('ask-field').fill('apollo');
  await expect(page.getByTestId('match-row')).toHaveCount(2);
  // Signed out elsewhere, as the terminal's `person logout` does.
  rmSync(join(home, '.local', 'share', 'echo-brain', 'person', 'session.v1.json'));
  await emit(app, 'echo-test:shown');
  await signIn(page);
  // Signing out is a real change of access: the bar's text went with it.
  await expect(page.getByTestId('ask-field')).toHaveValue('');
  await expect(page.getByTestId('matches')).toHaveCount(0);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-body')).toHaveValue('Half a thought');
});

test('the weekly sign-in works from a session left under a refresh claim', async () => {
  run = await launch('expired-claim');
  await signIn(run.page);
});

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

test('a refresh that never left the machine keeps you signed in, and status alone never refreshes', async () => {
  run = await launch('refresh-offline');
  const { page, app } = run;
  await expect(page.getByTestId('home-error')).toContainText('ECHO cannot be reached. Check your connection');
  await expect(page.getByTestId('signed-out')).toHaveCount(0);
  // One refresh, and the call that needed it is not made.
  expect(run.calls().map(call => call.path)).toEqual(['/v2/session/refresh']);
  // Showing the window again re-reads status; it does not try the network.
  const statuses = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8').match(/app\.status ok/g)?.length ?? 0;
  const before = statuses();
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:resume');
  await expect.poll(statuses).toBe(before + 1);
  await expect(page.getByTestId('home-error')).toBeVisible();
  expect(refreshes()).toHaveLength(1);
});

for (const [mode, why] of [['refresh-refused', 'is refused'], ['refresh-fails', 'may have reached the Authority']] as const) {
  test(`a refresh that ${why} shows sign-in at once and is never replayed`, async () => {
    run = await launch(mode);
    const started = Date.now();
    await expect(run.page.getByTestId('signed-out')).toBeVisible();
    expect(Date.now() - started).toBeLessThan(2_500); // not the 3 s wait for a refresh elsewhere
    expect(refreshes()).toHaveLength(1);
  });
}

test('a host that keeps exiting is given up on, and the page says ECHO could not start', async () => {
  run = await launch('host-crash');
  const { page } = run;
  await expect(page.getByTestId('start-failed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('signed-out')).toHaveCount(0);
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

test('a note sent while quit waits out a refresh is asked about, once', async () => {
  run = await launch('refresh-hangs');
  const { app, page, home } = run;
  await expect.poll(() => refreshes().length).toBe(1);
  const asked = join(home, 'asked');
  const exited = new Promise(resolveExit => app.process().once('exit', resolveExit));
  await app.evaluate(({ app: electronApp, dialog }, file) => {
    dialog.showMessageBoxSync = () => { process.getBuiltinModule('node:fs').appendFileSync(file, 'asked\n'); return 0; }; // Quit Anyway
    electronApp.quit();
  }, asked);
  // The window stays open while quit waits, so a note can still be sent.
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Offsite dates');
  await page.getByTestId('compose-send').click();
  await exited;
  expect(existsSync(asked) && readFileSync(asked, 'utf8')).toBe('asked\n');
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
