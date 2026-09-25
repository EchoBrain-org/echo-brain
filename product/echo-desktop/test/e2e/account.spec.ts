import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chooseFromAccountMenu, chooseFromTray, emit, launch, menuLabels, openAccountMenu, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

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
  expect(account.slice(3)).toEqual(['Switch account…', 'Sign out…']);

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
  expect(await menuLabels(run, 'account')).toEqual(['Not signed in', 'Sign in with Google…']);
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
