import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFromAccountMenu, drop, emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const refreshes = () => run.calls().filter(call => call.path === '/v2/session/refresh');
/** Waits until no refresh has gone out for half a second: what returning read again has all failed, each having tried one. */
async function refreshesSettled(): Promise<void> {
  let last = -1;
  await expect.poll(() => { const now = refreshes().length; const still = now === last; last = now; return still; }, { intervals: [500], timeout: 15_000 }).toBe(true);
}

/**
 * The startup reads, the change check among them, fail before sending; a known-not-sent refresh preserves the session for the
 * next call.
 */
async function expectOfflineStartup(): Promise<void> {
  await expect.poll(() => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')).toMatch(/changes\.read \w+/);
  expect(new Set(run.calls().map(call => call.path))).toEqual(new Set(['/v2/session/refresh']));
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
  // The weekly sign-in is a week away: nothing says so yet.
  await expect(page.getByTestId('sidebar-sign-in-again')).toHaveCount(0);
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
  // Nothing reaches the Authority.
  await expectOfflineStartup();
  // Returning to ECHO reads local status, Home and the change check again. Each still fails before sending.
  const statuses = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8').match(/app\.status ok/g)?.length ?? 0;
  const before = statuses();
  const tried = refreshes().length;
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:resume');
  await expect.poll(statuses).toBe(before + 1);
  await expect(page.getByTestId('home-error')).toBeVisible();
  await expect.poll(() => refreshes().length).toBeGreaterThan(tried);
  await expect(page.getByTestId('sidebar-projects-error').getByRole('button', { name: 'Try again' })).toBeEnabled();
  await expect(page.getByTestId('signed-out')).toHaveCount(0);

  // A note written while the refresh cannot leave the machine: that call refreshes again. What returning read again is
  // waited out first, since each of those reads tries a refresh too.
  await refreshesSettled();
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

test('past the weekly sign-in, ECHO asks to sign in again in plain words, never that the account changed, and Sign in again works', async () => {
  run = await launch('weekly-passed');
  const { page, app, userData } = run;
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await expect(page.getByTestId('signed-out')).toContainText('Sign in again to use ECHO');
  await expect(page.getByTestId('signin-reason')).toHaveText('ECHO asks you to sign in once a week.');
  // The client knew the week was over: no refresh went out, so no refresh token was spent.
  expect(refreshes()).toHaveLength(0);
  // The call that asked for the refresh says why; the calls waiting behind it say signed out. None says the account changed.
  const log = () => readFileSync(join(userData, 'logs', 'desktop.log'), 'utf8');
  await expect.poll(log).toMatch(/ reauthentication_required \d+ms/);
  expect(log()).not.toContain('account_changed');
  // The host says so on its own: status names why and where, and a call made as the old account says signed out.
  type Reply = { ok: boolean; value?: Record<string, unknown>; failure?: { code: string } };
  const host = (method: string, params: object) => page.evaluate(([name, values]) =>
    (window as unknown as { echo: { rpc(method: string, params: object): Promise<Reply> } }).echo.rpc(name, values), [method, params] as const);
  expect(await host('app.status', {})).toMatchObject({
    ok: true, value: { signed_in: false, session_ended: { reason: 'reauthentication_required', authority: 'https://authority.example' } },
  });
  const ari = { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' };
  expect(await host('changes.read', { expect: ari })).toMatchObject({ ok: false, failure: { code: 'reauthentication_required' } });
  // The client keeps why: a host started again (or ECHO restarted) still says so, and still offers the same organization.
  await emit(app, 'echo-test:kill-host');
  await expect.poll(async () => (await host('app.status', {})).value?.session_ended, { timeout: 10_000 })
    .toEqual({ reason: 'reauthentication_required', authority: 'https://authority.example' });
  await expect(page.getByTestId('signin-reason')).toHaveText('ECHO asks you to sign in once a week.');
  // One click: Google in the browser (the fixture's), for the same organization, and a new week.
  await page.getByTestId('signin-again').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await expect(page.getByTestId('signin-reason')).toHaveCount(0);
  expect((await host('app.status', {})).value).not.toHaveProperty('session_ended');
});

test('a host that keeps exiting is given up on, the page says ECHO could not start, and an invitation no host took leaves no folder behind', async () => {
  run = await launch('host-crash');
  const { app, page, home } = run;
  await expect(page.getByTestId('start-failed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('signed-out')).toHaveCount(0);
  const log = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8');
  await expect.poll(log, { timeout: 10_000 }).toContain('host gave-up');
  expect(log().match(/host exit/g)).toHaveLength(3);
  await expect(page.getByTestId('start-failed')).toBeVisible();
  // Saving an invitation under the same name works again.
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

test('quit waits out a refresh with the window open; a note sent meanwhile, or Quit pressed again, asks once, after the wait; Cancel keeps ECHO open', async () => {
  run = await launch('refresh-hangs');
  const { app, page, home } = run;
  await expect.poll(() => refreshes().length).toBe(1);
  const asked = join(home, 'asked');
  const askedAt = () => existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n').map(Number) : [];
  const answer = (choice: number) => app.evaluate(({ dialog }, [file, chosen]) => {
    dialog.showMessageBoxSync = () => { process.getBuiltinModule('node:fs').appendFileSync(file, `${Date.now()}\n`); return chosen; };
  }, [asked, choice] as const);
  // Any throw while quitting raises Electron's error box, which can hold the
  // quit open. macOS reports the app inactive after its window has closed:
  // conceal, through the handler that report reaches, must skip the closed window.
  await app.evaluate(({ app: electronApp, BrowserWindow }, threw) => {
    BrowserWindow.getAllWindows()[0]!.once('closed', () => {
      try { electronApp.emit('echo-test:conceal'); } catch { process.getBuiltinModule('node:fs').writeFileSync(threw, ''); }
    });
  }, join(home, 'threw'));
  await answer(1); // Cancel
  const quitAt = Date.now();
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); electronApp.quit(); });
  // The window stays open while quit waits, so a note can still be sent: its outcome unknown, quitting asks.
  await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Offsite dates');
  await page.getByTestId('compose-send').click();
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
  await exited; // the 5 s cap, not the refresh, ends the wait
  expect(askedAt()).toHaveLength(2);
  expect(askedAt()[1]! - againAt).toBeGreaterThanOrEqual(4_500);
  expect(existsSync(join(home, 'threw'))).toBe(false);
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
