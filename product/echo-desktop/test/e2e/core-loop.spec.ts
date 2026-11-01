import { expect, test } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';
import { quitPrompts } from './native.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const notes = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');

test('retry resends the identical request and then says where it went', async () => {
  run = await launch('write-unavailable-once');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Pricing call notes');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await expect(page.getByTestId('compose-retry')).toHaveText('Try again');
  await page.getByTestId('compose-retry').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  const posts = notes();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual(posts[0]!.body);
});

test('check status on an unconfirmed save learns it was not saved, then sends it', async () => {
  run = await launch('write-unavailable-once');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Security questionnaire sent');
  await page.getByTestId('compose-send').click();
  await page.getByTestId('compose-check').click();
  await expect(page.getByTestId('compose-error')).toHaveText('It was not saved. Try again.');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  const posts = notes();
  expect(posts[1]!.body?.request_id).toBe(posts[0]!.body?.request_id);
});

test('an unresolved save makes quitting ask first, comes back on capture, and write new asks once', async () => {
  run = await launch('write-unavailable');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Unsure');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  expect(await quitPrompts(run)).toEqual(['A note may not have been sent.']);
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await expect(page.getByTestId('compose-body')).toHaveValue('Unsure');
  await page.getByTestId('compose-new').click();
  await expect(page.getByTestId('compose-start-over')).toBeVisible();
  await page.getByTestId('compose-start-over').click();
  await expect(page.getByTestId('compose-body')).toHaveValue('');
  await expect(page.getByTestId('compose-unresolved')).toHaveCount(0);
});
