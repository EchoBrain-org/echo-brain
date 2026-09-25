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
  await openAccountMenu(run, page.getByTestId('account-row'));
  const account = await menuLabels(run, 'account');
  expect(account.slice(0, 2)).toEqual(['Signed in as Ari · employee', 'Organization: https://authority.example']);
  expect(account[2]).toMatch(/^ECHO \S+$/);
  expect(account.slice(3)).toEqual(['Switch account…', 'Sign out…', 'Connected tools…']);

  const tray = await menuLabels(run, 'tray');
  expect(tray.filter(label => !label.startsWith('Build '))).toEqual(['Open ECHO', 'Capture', 'Account', 'Quit ECHO']);
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
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await expect(page.getByTestId('account-row')).toContainText('Ari');
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
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-body')).toHaveValue('');
});

test('switch account signs out, then asks for the next organization address', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Switch account…');
  await expect(page.getByTestId('confirm')).toContainText('ECHO will sign out before you choose the next organization account.');
  await page.getByTestId('confirm-signout').click();
  await expect(page.getByTestId('signin')).toBeVisible();
  await expect(page.getByTestId('signin-url')).toBeFocused();
  expect(revocations()).toHaveLength(1);
});

test('sign out waits for a save on its way', async () => {
  run = await launch('write-hangs');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Offsite dates');
  await page.getByTestId('compose-send').click();
  await expect.poll(() => run.calls().filter(call => call.path === '/v3/person/updates').length).toBe(1);
  await chooseFromTray(run, 'Sign out…');
  await expect(page.getByTestId('confirm')).toContainText('Finish the current save first.');
  await expect(page.getByTestId('confirm-signout')).toBeDisabled();
});

test('sign out waits until a save whose outcome is unknown is settled, so its retry is never lost', async () => {
  run = await launch('write-unavailable-once');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Offsite dates');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await page.keyboard.press('Escape');
  await chooseFromTray(run, 'Sign out…');
  await expect(page.getByTestId('confirm')).toContainText('A save may not have arrived. Check it in Capture first.');
  await expect(page.getByTestId('confirm-signout')).toBeDisabled();
  await page.getByTestId('confirm-cancel').click();

  // Checked, it did not arrive: now nothing is lost by signing out.
  await emit(app, 'echo-test:capture');
  await page.getByTestId('compose-check').click();
  await expect(page.getByTestId('compose-error')).toHaveText('It was not saved. Try again.');
  await page.keyboard.press('Escape');
  await chooseFromTray(run, 'Sign out…');
  await page.getByTestId('confirm-signout').click();
  await expect(page.getByTestId('signed-out')).toBeVisible();
  expect(revocations()).toHaveLength(1);
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
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  const begun = run.calls().filter(call => call.path === '/v2/session/oidc/begin');
  expect(begun).toHaveLength(1);
  expect(begun[0]!.body).toMatchObject({ kind: 'identity_bootstrap', login_grant: grant });
  expect(await page.content()).not.toContain(folder);
  expect(readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')).not.toContain(folder);
});

test('Connected tools… shows what your organization has enabled and whether you are linked', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Connected tools…');
  await expect(page.getByTestId('tools')).toContainText('Ari · https://authority.example');
  await expect(page.getByTestId('tool-row')).toHaveText([
    'SlackOrganization: enabled · Your link: Connected',
    'GranolaNot enabled for this organization. Ask an owner to connect it.',
  ]);
  // The external workspace and account ids never reach the page.
  expect(await page.content()).not.toMatch(/T0123ABCD|U0123ABCD/);
  expect(run.calls().filter(call => call.path === '/v3/person/tools')).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tools')).toHaveCount(0);
});

test('a sign-out still forgets everything when a status read showed sign-in first', async () => {
  run = await launch('signout-slow');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Half a thought');
  await page.keyboard.press('Escape');
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Sign out…');
  await page.getByTestId('confirm-signout').click();
  await expect.poll(() => revocations().length).toBe(1);
  // The window comes forward while the Authority is still ending the session.
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('signed-out')).toBeVisible();
  // Then its reply arrives.
  await expect.poll(() => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')).toMatch(/account\.signOut ok/);

  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-body')).toHaveValue('');
});

test('a sign-in begun while a sign-out is still finishing is left alone', async () => {
  run = await launch('signout-slow-browser');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await chooseFromAccountMenu(run, page.getByTestId('account-row'), 'Switch account…');
  await page.getByTestId('confirm-signout').click();
  await expect.poll(() => revocations().length).toBe(1);
  // The window comes forward while the Authority is still ending the session, and the person signs in again.
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await chooseFromAccountMenu(run, page.getByTestId('signin-open'), 'Sign in with Google…');
  await page.getByTestId('signin-url').fill('https://authority.example');
  await page.getByTestId('signin-button').click();
  await expect(page.getByTestId('signin-button')).toHaveText('Waiting for your browser');

  // The sign-out's reply arrives while the browser is still open: the sign-in still waits, so it cannot be begun twice.
  await expect.poll(() => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')).toMatch(/account\.signOut ok/);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('signin-button')).toBeDisabled({ timeout: 1_000 });
  await expect(page.getByTestId('signin-button')).toHaveText('Waiting for your browser');
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  expect(run.calls().filter(call => call.path === '/v2/session/oidc/begin')).toHaveLength(1);
});
