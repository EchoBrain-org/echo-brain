import { expect, test, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const runOperations = () => run.calls().filter(call => call.path === '/v1/person/runs').map(call => call.body?.operation);

/** Adds the fixture meeting through Granola and approves it from Home for Only me. */
async function approveFromHome(page: Page) {
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await meetings.getByLabel('Granola folder').selectOption({ label: 'ECHO (1)' });
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await meetings.getByRole('button', { name: 'Add to ECHO', exact: true }).click();
  await expect(meetings.getByRole('status')).toContainText('Added.');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('need-row').click();
  const card = page.getByTestId('decision');
  await card.getByRole('radio', { name: 'Only me' }).check();
  await card.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toContainText('Approved');
  return page.getByTestId('need-row');
}

async function approveMeeting(page: Page) {
  const row = await approveFromHome(page);
  // The check runs by itself; its row becomes Impact and opens the card.
  await expect(row).toHaveAttribute('data-kind', 'impact', { timeout: 30_000 });
  await row.click();
  return page.getByTestId('decision');
}

test('approving a meeting shows its impact card once the check finishes', async ({}, testInfo) => {
  run = await launch('granola');
  const { page, app } = run;
  const permalink = 'https://example.atlassian.net/browse/ECHO-12';
  await app.evaluate(({ shell }) => {
    (globalThis as { openedTickets?: string[] }).openedTickets = [];
    shell.openExternal = async url => { (globalThis as { openedTickets?: string[] }).openedTickets!.push(url); };
  });
  const meetings = await approveMeeting(page);
  const impact = meetings.getByRole('region', { name: 'Impact' });
  await expect(impact.getByRole('heading', { name: 'Affected items' })).toBeVisible({ timeout: 30_000 });
  await expect(impact.getByRole('heading', { name: 'What was decided' })).toBeVisible();
  await expect(impact).toContainText('Launch the pilot next week.');
  await expect(impact.getByText('Conflicts')).toBeVisible();
  await expect(impact.getByText('Confirms')).toBeVisible();
  await expect(impact).toContainText('Date at risk: Pilot launch, 2026-10-30');
  await expect(impact.getByRole('heading', { name: "Couldn't confirm" })).toBeVisible();
  await expect(impact.getByRole('heading', { name: 'People to tell' })).toBeVisible();
  await expect(impact).toContainText('Mina Patel · ECHO-12 · Pilot launch');
  await expect(impact.getByText('1 item you can no longer open is hidden.')).toBeVisible();
  // Only outside items open in their tool; ECHO's own records do not.
  await expect(impact.getByRole('button', { name: /^Open in / })).toHaveCount(1);
  await impact.getByRole('button', { name: 'Open in Jira' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as { openedTickets?: string[] }).openedTickets)).toEqual([permalink]);
  await impact.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('impact-card.png') });
  expect(runOperations()).toEqual(expect.arrayContaining(['list', 'start', 'view']));
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(1);
});

test('a publishing approval stays on Home until its impact run arrives and finishes', async () => {
  run = await launch('granola-publishing');
  const row = await approveFromHome(run.page);
  await expect(row).toContainText('publishing to ECHO');
  await expect(row).toHaveAttribute('data-kind', 'checking');
  await expect(run.page.getByTestId('home-clear')).toHaveCount(0);
  await expect(row).toHaveAttribute('data-kind', 'impact', { timeout: 30_000 });
  await row.click();
  await expect(run.page.getByRole('heading', { name: 'Affected items' })).toBeVisible();
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(1);
});

test('a failed check gives its reason and offers Try again', async () => {
  run = await launch('granola-run-failed');
  const meetings = await approveMeeting(run.page);
  const impact = meetings.getByRole('region', { name: 'Impact' });
  await expect(impact.getByText('The impact check failed.')).toBeVisible({ timeout: 30_000 });
  await impact.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(runOperations).toContain('retry');
  // Tried again, the check runs and finishes.
  await expect(impact.getByRole('heading', { name: 'Affected items' })).toBeVisible({ timeout: 30_000 });
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(2);
});
