import { expect, test, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const runOperations = () => run.calls().filter(call => call.path === '/v1/person/runs').map(call => call.body?.operation);

/** Opens the Granola sheet, imports the fixture meeting and approves it for Only me. */
async function approveMeeting(page: Page) {
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await meetings.getByLabel('Granola folder').selectOption({ label: 'ECHO (1)' });
  await meetings.getByRole('button', { name: 'Browse meetings' }).click();
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await meetings.getByRole('button', { name: 'Add to ECHO', exact: true }).click();
  await expect(meetings.getByRole('button', { name: 'Pilot planning', exact: true })).toHaveCount(2);
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).last().click();
  await meetings.getByRole('radio', { name: 'Only me' }).check();
  await meetings.getByRole('button', { name: 'Approve', exact: true }).click();
  return meetings;
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
  await expect(impact.getByText('Impact check queued.').or(impact.getByText('Checking what this changes. This can take a few minutes.'))).toBeVisible();
  await expect(impact.getByRole('heading', { name: 'Affected items' })).toBeVisible({ timeout: 20_000 });
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

test('a failed check gives its reason and offers Try again', async () => {
  run = await launch('granola-run-failed');
  const meetings = await approveMeeting(run.page);
  const impact = meetings.getByRole('region', { name: 'Impact' });
  await expect(impact.getByText('The impact check failed.')).toBeVisible({ timeout: 20_000 });
  await impact.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(runOperations).toContain('retry');
  // Tried again, the check runs and finishes.
  await expect(impact.getByRole('heading', { name: 'Affected items' })).toBeVisible({ timeout: 20_000 });
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(2);
});
