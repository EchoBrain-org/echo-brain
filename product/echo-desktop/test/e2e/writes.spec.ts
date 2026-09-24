import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const posts = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');

test('capture after switching away from a project starts as Only me', async () => {
  run = await launch();
  const { page, app } = run;
  await page.getByTestId('project-row').nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await emit(app, 'echo-test:conceal');
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-to')).toHaveText('Only me');
  await expect(page.getByTestId('compose-body')).toBeFocused();
});

test('a retry refused for a known reason still says the first try may have arrived', async () => {
  run = await launch('write-unavailable-then-refused');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Budget moved');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await page.getByTestId('compose-retry').click();
  await expect(posts()).toHaveLength(2);
  await expect(page.getByTestId('compose-error')).toHaveText('This may not have been sent.');
  await expect(page.getByTestId('compose-body')).toHaveAttribute('readonly', '');
});

test('if the host dies mid-save the note is unconfirmed, and check status finds it saved', async () => {
  run = await launch('write-hangs');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Hiring plan');
  await page.getByTestId('compose-send').click();
  await expect.poll(() => posts().length).toBe(1);
  await emit(app, 'echo-test:kill-host');
  await expect(page.getByTestId('compose-error')).toHaveText('This may not have been sent.');
  await expect(page.getByTestId('compose-body')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('compose-check')).toBeEnabled();
  await expect(async () => {
    await page.getByTestId('compose-check').click();
    await expect(page.getByTestId('sent')).toContainText('Saved for you', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  expect(posts()).toHaveLength(1);
});

test('quitting while a note is sending asks first', async () => {
  run = await launch('write-hangs');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Offsite dates');
  await page.getByTestId('compose-send').click();
  await expect.poll(() => posts().length).toBe(1);
  const prompts = await app.evaluate(async ({ app: electronApp, dialog }) => {
    let asked = 0;
    dialog.showMessageBoxSync = () => { asked += 1; return 1; }; // Cancel
    electronApp.quit();
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    return asked;
  });
  expect(prompts).toBe(1);
  await expect(page.getByTestId('compose')).toBeVisible();
});

test('a note and a file are never sent together', async () => {
  run = await launch();
  const { page, app } = run;
  const folder = mkdtempSync(join(tmpdir(), 'echo-doc-'));
  const file = join(folder, 'Pricing.txt');
  writeFileSync(file, 'Annual pricing.');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, file);
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Some words');
  await page.getByTestId('compose-attach').click();
  await expect(page.getByTestId('compose-notice')).toHaveText('Send this note before attaching a document.');
  await expect(page.getByTestId('compose-file')).toHaveCount(0);
  await page.getByTestId('compose-body').fill('');
  await page.getByTestId('compose-attach').click();
  await expect(page.getByTestId('compose-file')).toHaveText('Pricing.txt');
  await expect(page.getByTestId('compose-body')).toHaveCount(0);
  await page.getByTestId('compose-remove-file').click();
  await expect(page.getByTestId('compose-body')).toBeVisible();
  rmSync(folder, { recursive: true, force: true });
});

test('Everyone warns before it is sent', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await expect(page.getByTestId('compose-warning')).toHaveCount(0);
  await page.getByTestId('compose-to').click();
  await page.getByTestId('compose-target').last().click();
  await expect(page.getByTestId('compose-warning')).toHaveText('Everyone in your organization will be able to read this.');
});

test('saving to the project on screen adds to its feed and leaves the rest of the page alone', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').nth(0).click();
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
  await page.getByTestId('scope-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await page.getByTestId('write-button').click();
  await expect(page.getByTestId('compose-to')).toHaveText('Apollo');
  await page.getByTestId('compose-body').fill('Launch moved to Friday');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('sent')).toContainText('Sent to Apollo');
  await expect(page.getByTestId('compose-done')).toBeFocused();
  await expect.poll(() => run.calls().filter(call => call.path === '/v2/person/projects/context/feed').length).toBe(2);
  await page.getByTestId('compose-done').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
});
