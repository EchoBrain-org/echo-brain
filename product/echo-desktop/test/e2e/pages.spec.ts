import { expect, test } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

test('a refused read for the same account shows why instead of loading forever', async () => {
  run = await launch('feed-unauthorized');
  const { page } = run;
  await page.getByTestId('project-row').nth(0).click();
  await expect(page.getByText('Your access changed. Sign in again.')).toBeVisible();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
});

test('Back keeps the pages Home had loaded, and showing the window re-reads it', async () => {
  run = await launch('many-projects');
  const { page, app } = run;
  const lists = () => run.calls().filter(call => call.path === '/v1/person/projects').length;
  await expect(page.getByTestId('project-row')).toHaveCount(10);
  await page.getByTestId('more-projects').click();
  await expect(page.getByTestId('project-row')).toHaveCount(13);
  await page.getByTestId('project-row').nth(12).click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('project-row')).toHaveCount(13);
  expect(lists()).toBe(2);
  await emit(app, 'echo-test:shown');
  await expect.poll(lists).toBe(3);
  await expect(page.getByTestId('project-row')).toHaveCount(13);
});

test('the ask bar has the caret at launch and whenever the window comes forward', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('ask-field')).toBeFocused();
  await page.getByTestId('project-row').nth(0).focus();
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('ask-field')).toBeFocused();
});

test('an ask can be cancelled, and its late answer is dropped', async () => {
  run = await launch('ask-hangs');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('Where are we?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('asking')).toBeVisible();
  await page.getByTestId('ask-cancel').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('project-row')).toHaveCount(2);
});

test('a source shows at most 2,000 characters', async () => {
  run = await launch('long-evidence');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('What did we agree?');
  await page.getByTestId('ask-field').press('Enter');
  await page.getByTestId('source-chip').nth(1).click();
  await expect(page.getByTestId('evidence-text')).toHaveText(`${'x'.repeat(2_000)}…`);
});
