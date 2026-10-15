import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFromAccountMenu, drop, emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const refreshes = () => run.calls().filter(call => call.path === '/v2/session/refresh');

/**
 * Both startup lists, Home's tools read and the quiet follow-ups check fail before sending; a known-not-sent refresh
 * preserves the session for the next call.
 */
async function expectOfflineStartup(): Promise<void> {
  const completedLists = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')
    .match(/(projects\.list|account\.tools|runs) transport_failed/g)?.length ?? 0;
  await expect.poll(completedLists).toBe(4);
  expect(run.calls().map(call => call.path)).toEqual(Array(4).fill('/v2/session/refresh'));
}

/** Sign in with the fixture's browser, which stands in for Google, and land on Home. */
async function signIn(page: Page) {
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
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

test('a session left under a refresh claim by the weekly expiry shows sign-in at once, and signing in works', async () => {
  run = await launch('expired-claim');
  await expect(run.page.getByTestId('signed-out')).toBeVisible({ timeout: 2500 });
  await signIn(run.page);
});

test('an expired access token is refreshed once, before the calls that need it', async () => {
  run = await launch('refresh-ok');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
  await page.getByTestId('ask-field').fill('What did we agree?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  expect(refreshes()).toHaveLength(1);
});

test('ten minutes of sign-in serve the reads as they are, and an upload that may take twelve refreshes first', async () => {
  // The fixture's token has ten minutes left: a read needs 45 s plus a minute, an upload 12 minutes plus one.
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  expect(refreshes()).toHaveLength(0);
  writeFileSync(join(run.userData, 'Brief.md'), 'Annual pricing.');
  await drop(page, page.getByTestId('sidebar-project').nth(1), join(run.userData, 'Brief.md'));
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon · Extracting text');
  const paths = run.calls().map(call => call.path);
  expect(refreshes()).toHaveLength(1);
  expect(paths.indexOf('/v2/session/refresh')).toBeLessThan(paths.findIndex(path => path.startsWith('/v2/person/documents/')));
});

test('an offline foreground refresh keeps you signed in, and a note is not sent when refreshing still cannot leave the machine', async () => {
  run = await launch('refresh-offline');
  const { page, app } = run;
  await expect(page.getByTestId('home-error')).toContainText('ECHO cannot be reached. Check your connection');
  await expect(page.getByTestId('signed-out')).toHaveCount(0);
  // Active and archived lists each try once; neither list reaches the Authority.
  await expectOfflineStartup();
  // Returning to ECHO reads local status, then retries the sidebar's active list.
  // The failed Home read still waits for its explicit retry.
  const statuses = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8').match(/app\.status ok/g)?.length ?? 0;
  const before = statuses();
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:resume');
  await expect.poll(statuses).toBe(before + 1);
  await expect(page.getByTestId('home-error')).toBeVisible();
  await expect.poll(() => refreshes().length).toBe(5);
  await expect(page.getByTestId('sidebar-projects-error').getByRole('button', { name: 'Try again' })).toBeEnabled();
  await expect(page.getByTestId('signed-out')).toHaveCount(0);

  // A note written while the refresh cannot leave the machine: that call refreshes again.
  const startupRefreshes = refreshes().length;
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Offline note');
  await page.getByTestId('compose-send').click();
  // Not sent, so not unknown: nothing went out, and the note stays editable.
  await expect(page.getByTestId('compose-error')).toContainText('ECHO cannot be reached');
  await expect(page.getByTestId('compose-unresolved')).toHaveCount(0);
  await expect(page.getByTestId('compose-body')).not.toHaveAttribute('readonly', '');
  expect(run.calls().some(call => call.path === '/v3/person/updates')).toBe(false);
  expect(refreshes()).toHaveLength(startupRefreshes + 1);
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
  // quit open. macOS reports the app inactive after its window has closed:
  // conceal, through the handler that report reaches, must skip the closed window.
  await app.evaluate(({ app: electronApp, BrowserWindow }, threw) => {
    BrowserWindow.getAllWindows()[0]!.once('closed', () => {
      try { electronApp.emit('echo-test:conceal'); } catch { process.getBuiltinModule('node:fs').writeFileSync(threw, ''); }
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

test('an invitation no host took leaves no folder behind, so saving one under the same name works again', async () => {
  run = await launch('host-crash');
  const { app, page, home } = run;
  await expect.poll(() => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8'), { timeout: 10_000 }).toContain('host gave-up');
  const folder = join(home, 'ECHO invitation for Kim');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as never; }, folder);
  type Reply = { ok: boolean; value?: { handle: string }; failure?: { code: string; mutation_outcome?: string } };
  const invite = () => page.evaluate(async () => {
    const { rpc } = (window as unknown as { echo: { rpc(method: string, params: object): Promise<Reply> } }).echo;
    const chosen = await rpc('dialog.saveInvitation', { name: 'Kim' });
    const expect = { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' };
    return { chosen, invited: chosen.value && await rpc('employees.invite', { expect, name: 'Kim', email: 'kim@example.com', invitation_handle: chosen.value.handle }) };
  });
  const first = await invite();
  expect(first.invited).toMatchObject({ ok: false, failure: { code: 'host_failed', mutation_outcome: 'not_submitted' } });
  expect(existsSync(folder)).toBe(false);
  // Not 'file_exists': nothing was issued, so the folder was never kept.
  expect((await invite()).chosen).toMatchObject({ ok: true });
});

test('pressing Quit again while quit waits out a refresh asks once, after the wait, and Cancel keeps ECHO open', async () => {
  run = await launch('refresh-hangs');
  const { app, page, home } = run;
  await expect.poll(() => refreshes().length).toBe(1);
  const asked = join(home, 'asked');
  const askedAt = () => existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n').map(Number) : [];
  const answer = (choice: number) => app.evaluate(({ dialog }, [file, chosen]) => {
    dialog.showMessageBoxSync = () => { process.getBuiltinModule('node:fs').appendFileSync(file, `${Date.now()}\n`); return chosen; };
  }, [asked, choice] as const);
  // A save whose outcome is unknown, so quitting asks.
  await page.evaluate(() => (window as unknown as { echo: { rpc(method: string, params: object): Promise<unknown> } }).echo
    .rpc('app.setUnresolved', { unresolved: true }));
  await answer(1); // Cancel
  const quitAt = Date.now();
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); electronApp.quit(); });
  // The second press joins the first wait: asked once, when the 5 s cap ends it.
  await expect.poll(() => askedAt().length, { timeout: 10_000 }).toBe(1);
  expect(askedAt()[0]! - quitAt).toBeGreaterThanOrEqual(4_500);
  // Cancelled: no wait left over asks again, or quits with the host mid-refresh.
  await new Promise(resolveWait => setTimeout(resolveWait, quitAt + 12_000 - Date.now()));
  expect(askedAt()).toHaveLength(1);
  expect(app.process().exitCode).toBeNull();
  // A later Quit waits again from the start, then asks, and Quit Anyway quits.
  await answer(0);
  const exited = new Promise(resolveExit => app.process().once('exit', resolveExit));
  const againAt = Date.now();
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
  await exited;
  expect(askedAt()).toHaveLength(2);
  expect(askedAt()[1]! - againAt).toBeGreaterThanOrEqual(4_500);
});

test('a starting host leaves a note folder another host may be sending from, and removes an hour-old one', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'echo-note-'));
  const stale = mkdtempSync(join(tmpdir(), 'echo-note-'));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(stale, twoHoursAgo, twoHoursAgo);
  try {
    run = await launch();
    await expect(run.page.getByTestId('sidebar-project')).toHaveCount(2);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});

test('a crashed page reloads and reads status again', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(); });
  // Playwright drops a crashed page, so look from main at the reloaded one.
  // (A script sent to the dead page never settles, so each look is capped.)
  const rows = () => app.evaluate(({ BrowserWindow }) => Promise.race([
    BrowserWindow.getAllWindows()[0]!.webContents
      .executeJavaScript('document.querySelectorAll("[data-testid=sidebar-project]").length').catch(() => -1),
    new Promise(resolveLook => setTimeout(() => resolveLook(-1), 500)),
  ]));
  await expect.poll(rows, { timeout: 10_000 }).toBe(2);
  const log = readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
  expect(log).toMatch(/renderer gone (crashed|killed)/);
});
