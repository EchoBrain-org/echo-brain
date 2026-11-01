import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, launch, menuLabels, type Launched } from './launch.js';

let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const writes = (method: string) => run.calls().filter(call => call.method === method && call.path === '/v1/person/employees').map(call => call.body);

/** Main's save dialog answers with a new folder in a private temporary place, and remembers what it suggested. */
async function saveInto(name: string): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), 'echo-invite-'));
  folders.push(parent);
  const folder = join(parent, name);
  await run.app.evaluate(({ dialog }, path) => {
    const suggested: string[] = [];
    dialog.showSaveDialog = (async (_window: unknown, options: { defaultPath?: string }) => {
      suggested.push(options.defaultPath ?? '');
      return { canceled: false, filePath: path };
    }) as never;
    (globalThis as { echoTestSuggested?: string[] }).echoTestSuggested = suggested;
  }, folder);
  return folder;
}

test('People & invites: typing narrows the list, Invite saves a private folder main made, and Undo revokes only that invite', async () => {
  run = await launch('owner');
  const { page, app } = run;
  await page.getByTestId('sidebar-organization').click();
  await expect(page.getByTestId('title')).toHaveText('People & invites');
  const rows = page.getByTestId('employee-row');
  await expect(page.getByTestId('employee-standing')).toHaveText(['Active · Onboarded', 'Active · Awaiting sign-in', 'Revoked · Invitation expired']);
  await expect(page.getByTestId('employees-count')).toHaveText('3 employees.');

  // Search, then Invite: the name typed narrows the list.
  await page.getByTestId('invite-name').fill('raj');
  await expect(rows).toHaveCount(1);
  await page.getByTestId('invite-name').fill('Kim Lee');
  await expect(page.getByTestId('employees-none')).toBeVisible();
  await page.getByTestId('invite-email').fill(' Kim@Example.com');
  const folder = await saveInto('ECHO invitation for Kim Lee');
  await page.getByTestId('invite').click();
  await expect(page.getByTestId('org-saved')).toContainText('Invitation for Kim Lee saved.');
  expect(writes('POST')).toEqual([{ name: 'Kim Lee', email: 'kim@example.com' }]);
  expect(await app.evaluate(() => (globalThis as { echoTestSuggested?: string[] }).echoTestSuggested)).toEqual(['ECHO invitation for Kim Lee']);
  // Only you can open the folder or the invitation in it.
  const file = join(folder, 'person-invitation.json');
  expect(statSync(folder).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
    kind: 'echo-person-onboarding-invitation', authority_url: 'https://authority.example', expected_email: 'kim@example.com',
  });
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toContainText('Kim Lee');

  // Show invitation in Finder: main shows the file; the page never held where it is, and the log names no path.
  await page.getByTestId('invitation-show').click();
  await expect.poll(() => app.evaluate(() => (globalThis as { echoTestShown?: string }).echoTestShown)).toBe(realpathSync(file));
  expect(await page.content()).not.toContain('echo-invite-');
  expect(readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8')).not.toContain('echo-invite-');

  // Undo revokes only the employee that invite added, at once.
  await page.getByTestId('invite-undo').click();
  await expect(rows.nth(3).getByTestId('employee-standing')).toHaveText('Revoked · Invitation expired');
  expect(writes('DELETE')).toEqual([{ email: 'kim@example.com' }]);
  await expect(page.getByTestId('org-saved')).toHaveCount(0);
  await rows.nth(1).getByTestId('employee-more').click();
  await saveInto('New invitation');
  await page.getByTestId('employee-reissue').click();
  await expect(page.getByTestId('org-saved')).toContainText('New invitation for Raj Kumar saved; the previous one no longer works.');
  await expect(page.getByTestId('invite-undo')).toHaveCount(0);
  expect(writes('PUT')).toEqual([{ email: 'raj@example.com' }]);
});

test('owners also reach People & invites from the tray, under Organization', async () => {
  run = await launch('owner');
  const { page } = run;
  await expect(page.getByTestId('sidebar-organization')).toBeVisible();
  const tray = await menuLabels(run, 'tray');
  expect(tray.filter(label => !label.startsWith('Build '))).toEqual(['Open ECHO', 'Capture', 'Account', 'Organization', 'Quit ECHO']);
  const labels = await run.app.evaluate(() => {
    const menu = (globalThis as { echoTestTrayMenu?: Electron.Menu }).echoTestTrayMenu!;
    const organization = menu.items.find(item => item.label === 'Organization')!.submenu!;
    organization.items[0]!.click();
    return organization.items.map(item => item.label);
  });
  expect(labels).toEqual(['People & invites…']);
  await expect(page.getByTestId('title')).toHaveText('People & invites');
  await expect(page.getByTestId('employee-row')).toHaveCount(3);

  // Chosen with another app in front, as a tray click is: it is there once ECHO is.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('title').getByTestId('alt-stops')).toBeVisible();
  await emit(run.app, 'echo-test:conceal');
  await run.app.evaluate(() => {
    const menu = (globalThis as { echoTestTrayMenu?: Electron.Menu }).echoTestTrayMenu!;
    menu.items.find(item => item.label === 'Organization')!.submenu!.items[0]!.click();
  });
  await expect(page.getByTestId('concealed')).toBeVisible();
  await emit(run.app, 'echo-test:resume');
  await expect(page.getByTestId('title')).toHaveText('People & invites');
  await expect(page.getByTestId('employee-row')).toHaveCount(3);
});
