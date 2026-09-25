import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

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
});

test('Revoke access is asked first, and Reissue saves a new invitation for someone still to sign in', async () => {
  run = await launch('owner');
  const { page } = run;
  await page.getByTestId('sidebar-organization').click();
  const raj = page.getByTestId('employee-row').nth(1);
  // Someone onboarded has no invitation to reissue; someone revoked has nothing left to do.
  await page.getByTestId('employee-row').nth(0).getByTestId('employee-more').click();
  await expect(page.getByTestId('employee-reissue')).toHaveCount(0);
  await expect(page.getByTestId('employee-revoke')).toBeVisible();
  await expect(page.getByTestId('employee-row').nth(2).getByTestId('employee-more')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('employee-menu')).toHaveCount(0);

  await raj.getByTestId('employee-more').click();
  await saveInto('New invitation');
  await page.getByTestId('employee-reissue').click();
  await expect(page.getByTestId('org-saved')).toContainText('New invitation for Raj Kumar saved; the previous one no longer works.');
  await expect(page.getByTestId('invite-undo')).toHaveCount(0);
  expect(writes('PUT')).toEqual([{ email: 'raj@example.com' }]);

  await raj.getByTestId('employee-more').click();
  await page.getByTestId('employee-revoke').click();
  await expect(page.getByTestId('revoke-confirm')).toContainText('Revoke access for Raj Kumar?');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('revoke-confirm')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('People & invites');
  expect(writes('DELETE')).toHaveLength(0);
  await raj.getByTestId('employee-more').click();
  await page.getByTestId('employee-revoke').click();
  await page.getByTestId('revoke-confirm-go').click();
  await expect(page.getByTestId('org-notice')).toHaveText('Access revoked.');
  await expect(raj.getByTestId('employee-standing')).toHaveText('Revoked · Invitation expired');
  expect(writes('DELETE')).toEqual([{ email: 'raj@example.com' }]);
});

test('an invite whose reply was lost is never called done: the list goes until it is read again', async () => {
  run = await launch('owner-write-lost');
  const { page, app } = run;
  await page.getByTestId('sidebar-organization').click();
  await expect(page.getByTestId('employee-row')).toHaveCount(3);
  await page.getByTestId('invite-name').fill('Kim Lee');
  await page.getByTestId('invite-email').fill('kim@example.com');
  await saveInto('Kim');
  await page.getByTestId('invite').click();
  const mayHave = 'The invitation may already have been issued. Refresh before trying again.';
  await expect(page.getByTestId('org-notice')).toHaveText(mayHave);
  await expect(page.getByTestId('employee-row')).toHaveCount(0);
  await expect(page.getByTestId('invite')).toBeDisabled();
  await expect(page.getByTestId('invitation-show')).toHaveCount(0);
  // Typing does not hide why the list is gone.
  await page.getByTestId('invite-name').fill('Kim');
  await page.getByTestId('invite-name').fill('Kim Lee');
  await expect(page.getByTestId('org-notice')).toHaveText(mayHave);

  // Another app in front covers the page; coming back reads the list again, which settles it.
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.getByTestId('organization')).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('employees-count')).toHaveText('4 employees.');
  await expect(page.getByTestId('org-notice')).toHaveCount(0);
  // The name typed is kept, and it finds them: the invite did arrive, so a second one is not offered.
  await expect(page.getByTestId('employee-row')).toHaveCount(1);
  await expect(page.getByTestId('employee-standing')).toHaveText('Active · Awaiting sign-in');
  await page.getByTestId('invite').click();
  await expect(page.getByTestId('org-notice')).toHaveText('This employee already has an invitation. Reissue it from their ⋯ menu.');
  expect(writes('POST')).toHaveLength(1);
  const lists = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v1/person/employees').length;
  const before = lists();
  await page.getByTestId('employees-refresh').click();
  await expect.poll(lists).toBe(before + 1);

  // An invite's Undo lasts only while ECHO stays in front.
  await page.getByTestId('invite-name').fill('Sam Wu');
  await page.getByTestId('invite-email').fill('sam@example.com');
  await saveInto('Sam');
  await page.getByTestId('invite').click();
  await expect(page.getByTestId('invite-undo')).toBeVisible();
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('employees-count')).toHaveText('5 employees.');
  await expect(page.getByTestId('invite-undo')).toHaveCount(0);
  expect(writes('DELETE')).toHaveLength(0);
});

test('a list read sent before a change never settles it, and Refresh stays in reach', async () => {
  run = await launch('owner-write-lost-slow-list');
  const { page } = run;
  await page.getByTestId('sidebar-organization').click();
  const raj = page.getByTestId('employee-row').nth(1);
  await expect(raj.getByTestId('employee-standing')).toHaveText('Active · Awaiting sign-in');
  // Refresh is still on its way when Raj's access is revoked, and answers only after the revoke's reply was lost.
  await page.getByTestId('employees-refresh').click();
  await raj.getByTestId('employee-more').click();
  await page.getByTestId('employee-revoke').click();
  await page.getByTestId('revoke-confirm-go').click();
  const mayHave = 'Access may already have been revoked. Refresh before trying again.';
  await expect(page.getByTestId('org-notice')).toHaveText(mayHave);
  // What the late read shows may predate the revoke: it settles nothing, and Refresh comes back.
  await expect(page.getByTestId('employees-refresh')).toBeEnabled();
  await expect(page.getByTestId('org-notice')).toHaveText(mayHave);
  await expect(page.getByTestId('employee-row')).toHaveCount(0);
  await page.getByTestId('employees-refresh').click();
  await expect(raj.getByTestId('employee-standing')).toHaveText('Revoked · Invitation expired');
  await expect(page.getByTestId('org-notice')).toHaveCount(0);
  expect(writes('DELETE')).toEqual([{ email: 'raj@example.com' }]);
});
