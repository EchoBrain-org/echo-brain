import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFromAccountMenu, chooseFromTray, emit, launch, menuLabels, openAccountMenu, type Launched } from './launch.js';

let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const revocations = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v2/session/revocations');
const session = () => join(run.home, '.local', 'share', 'echo-brain', 'person', 'session.v1.json');

test('the Account menu names who is signed in, and the tray holds the same items', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  // Screen readers and voice control hear who is signed in, as the row shows it.
  await expect(page.getByRole('button', { name: 'Account, Ari, employee', exact: true })).toHaveAttribute('aria-haspopup', 'menu');
  await openAccountMenu(run, page.getByTestId('account-row'));
  const account = await menuLabels(run, 'account');
  expect(account.slice(0, 2)).toEqual(['Signed in as Ari · employee', 'Organization: https://authority.example']);
  expect(account.slice(3)).toEqual(['Switch account…', 'Sign out…', 'Connected tools…']);

  const tray = await menuLabels(run, 'tray');
  expect(tray.filter(label => !label.startsWith('Build '))).toEqual(['Open ECHO', 'Capture', 'Account', 'Quit ECHO']);
  // Releases share a version: the version line names the build, as the tray does ("ECHO 0.1.0-internal.1 · 038f099").
  const build = tray.find(label => label.startsWith('Build '))!.slice('Build '.length);
  expect(account[2]).toMatch(/^ECHO \S+ · [0-9a-f]{7}/);
  expect(account[2]!.endsWith(` · ${build}`)).toBe(true);
  expect(await menuLabels(run, 'tray-account')).toEqual(account);
  // The tray's items reach the window.
  await chooseFromTray(run, 'Sign out…');
  await expect(page.getByTestId('confirm')).toContainText('Sign out of this ECHO account?');
});

test('signed out shows "Sign in to use ECHO"; Sign in with Google… asks for the organization address', async () => {
  run = await launch('signed-out');
  const { page } = run;
  await expect(page.getByTestId('signed-out')).toContainText('Sign in to use ECHO');
  // The sidebar keeps only the Account entry, and nothing else can be used.
  await expect(page.getByTestId('account-row')).toHaveText('Account · Sign in');
  await expect(page.getByRole('button', { name: 'Account · Sign in', exact: true })).toBeVisible();
  await expect(page.getByTestId('signin-open')).toHaveAttribute('aria-haspopup', 'menu');
  await expect(page.getByTestId('sidebar-capture')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toHaveCount(0);

  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  expect(await menuLabels(run, 'account')).toEqual(['Not signed in', 'Sign in with Google…', 'Open invitation…']);
  await expect(page.getByTestId('signin-url')).toBeFocused();
  await expect(page.getByTestId('signin-button')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('signed-out')).toBeVisible();

  // The same menu from the sidebar.
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await expect(page.getByTestId('account-row')).toContainText('Ari');
});

test('a sign-in the organization refuses says so, writes no session, and can be tried again', async () => {
  run = await launch('signed-out-not-bound');
  const { page } = run;
  const begun = () => run.calls().filter(call => call.path === '/v2/session/oidc/begin').length;
  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('signin')).toContainText('Sign-in did not finish. Try again.');
  await expect(page.getByTestId('signin-button')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(0);
  expect(existsSync(session())).toBe(false);
  await page.getByTestId('signin-button').click();
  await expect.poll(begun).toBe(2);
});

test('sign out asks first, then shows sign-in; Cancel keeps you signed in', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Half a thought');
  await page.keyboard.press('Escape');

  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Sign out…');
  await expect(page.getByTestId('confirm')).toContainText('Ask and organization information will be cleared on this computer.');
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  expect(revocations()).toHaveLength(0);

  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Sign out…');
  await page.getByTestId('confirm-signout').click();
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(0);
  expect(revocations()).toHaveLength(1);
  expect(existsSync(session())).toBe(false);

  // Signing in again, even as the same person, starts clean.
  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-body')).toHaveValue('');
  await page.keyboard.press('Escape');
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Switch account…');
  await expect(page.getByTestId('confirm')).toContainText('ECHO will sign out before you choose the next organization account.');
  await page.getByTestId('confirm-signout').click();
  await expect(page.getByTestId('signin-url')).toBeFocused();
  expect(revocations()).toHaveLength(2);
});

test('Open invitation… signs in with the folder the owner sent, and the page never learns where it is', async () => {
  run = await launch('signed-out');
  const { page, app } = run;
  const choose = (path: string) => app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, path);
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'echo-empty-')));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ECHO-invitation-')));
  folders.push(empty, folder);
  // The owner's export: one private, canonical file inside the folder.
  const grant = Buffer.alloc(32, 7).toString('base64url');
  writeFileSync(join(folder, 'person-invitation.json'), `${JSON.stringify({
    authority_url: 'https://authority.example', expires_at: '2026-09-21T22:15:00.000Z',
    kind: 'echo-person-onboarding-invitation', login_grant: grant, schema_version: 1,
  })}\n`, { mode: 0o600 });

  await choose(empty);
  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Open invitation…');
  await expect(page.getByTestId('signin-error')).toHaveText('Choose the invitation folder your organization owner sent you.');

  await choose(folder);
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Open invitation…');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  const begun = run.calls().filter(call => call.path === '/v2/session/oidc/begin');
  expect(begun).toHaveLength(1);
  expect(begun[0]!.body).toMatchObject({ kind: 'identity_bootstrap', login_grant: grant });
  expect(await page.content()).not.toContain(folder);
  expect(readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')).not.toContain(folder);
});

test('a reply that lands after someone else signed in on this computer is never taken as the page\'s account, and nothing more goes out for it', async () => {
  run = await launch();
  const { page, home } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  type Reply = { ok: boolean; value?: unknown; failure?: { code: string; retryable?: boolean; mutation_outcome?: string } };
  const host = (method: string, params: object) => page.evaluate(([name, values]) =>
    (window as unknown as { echo: { rpc(method: string, params: object): Promise<Reply> } }).echo.rpc(name, values), [method, params] as const);
  const ari = { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' };
  const note = () => ({ expect: ari, request_id: crypto.randomUUID(), text: 'Offsite dates', audience: { kind: 'only-me' }, project_ids: [] });
  const saves = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates').length;
  // Kim signs in while a read is on its way: what it read is not shown as Ari's.
  writeFileSync(join(home, 'switch-on'), '/v1/person/list');
  expect(await host('list.page', { expect: ari, scope: { kind: 'only-me' } })).toEqual({ ok: false, failure: { code: 'account_changed', retryable: false } });
  // Now a write for Ari is refused before it is sent: it was not saved.
  expect(await host('notes.submit', note())).toMatchObject({ ok: false, failure: { code: 'account_changed', mutation_outcome: 'not_submitted' } });
  expect(saves()).toBe(0);
});

test('a save on its way when someone else signs in is never called saved or not', async () => {
  run = await launch();
  const { page, home } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  writeFileSync(join(home, 'switch-on'), '/v3/person/updates');
  const reply = await page.evaluate(() => (window as unknown as { echo: { rpc(method: string, params: object): Promise<unknown> } }).echo.rpc('notes.submit', {
    expect: { authority: 'https://authority.example', membership_id: 'mem_22222222-2222-4222-8222-222222222222' },
    request_id: crypto.randomUUID(), text: 'Offsite dates', audience: { kind: 'only-me' }, project_ids: [],
  }));
  expect(reply).toMatchObject({ ok: false, failure: { code: 'account_changed', retryable: false, mutation_outcome: 'unknown' } });
});
