import { expect, test, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';
import { captureOpenExternal } from './native.js';

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

/** The finished check's Send row: it opens the meeting's follow-ups. */
async function openFollowUps(page: Page) {
  const row = page.getByTestId('need-row');
  await expect(row).toHaveAttribute('data-kind', 'send', { timeout: 30_000 });
  await expect(row).toContainText('4 follow-ups to send');
  await row.click();
  const list = page.getByTestId('follow-ups');
  await expect(list.getByRole('region', { name: 'Not sent', exact: true }).getByTestId('follow-up-row')).toHaveCount(4);
  return list;
}

test('approving a meeting checks what it changes, and its follow-ups wait on Home', async () => {
  run = await launch('granola');
  const { page } = run;
  await approveFromHome(page);
  // The check runs by itself; what it found, and the meeting's own actions, wait on Home to be sent.
  const list = await openFollowUps(page);
  // The meeting's approval opens its decision over the list; its follow-ups line goes back to the list, as it was.
  await list.getByRole('button', { name: /^Approved / }).click();
  const decision = page.getByTestId('decision');
  await expect(decision.getByRole('heading', { name: 'What did it change?' })).toBeVisible();
  await expect(page.getByTestId('title')).toHaveText('Decision');
  const reads = runOperations().filter(operation => operation === 'items').length;
  const line = decision.getByTestId('impact-follow-ups');
  await expect(line).toHaveText('Follow-ups · 4 not sent');
  await line.click();
  await expect(list.getByRole('heading', { name: 'Pilot planning' })).toBeVisible();
  await expect(list.getByRole('region', { name: 'Not sent', exact: true }).getByRole('checkbox', { checked: true })).toHaveCount(4);
  // Counted once for the line; the list was not read again.
  expect(runOperations().filter(operation => operation === 'items')).toHaveLength(reads);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('need-row')).toHaveAttribute('data-kind', 'send');
  expect(runOperations()).toEqual(expect.arrayContaining(['list', 'start', 'home', 'items']));
  expect(runOperations()).not.toContain('view');
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(1);
});

test('a publishing approval stays on Home until its impact run arrives and finishes', async () => {
  run = await launch('granola-publishing');
  const row = await approveFromHome(run.page);
  await expect(row).toContainText('publishing to ECHO');
  await expect(row).toHaveAttribute('data-kind', 'checking');
  await expect(run.page.getByTestId('home-clear')).toHaveCount(0);
  await openFollowUps(run.page);
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(1);
});

test('a failed check gives its reason, offers Try again, and then its follow-ups', async ({}, testInfo) => {
  run = await launch('granola-run-failed');
  const { page, app } = run;
  const opened = await captureOpenExternal(app);
  const row = await approveFromHome(page);
  // A check that did not finish waits on you: its row opens the reason.
  await expect(row).toHaveAttribute('data-kind', 'failed', { timeout: 30_000 });
  await expect(row).toContainText('Approved · the check did not finish');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('1');
  await row.click();
  const impact = page.getByTestId('decision').getByRole('region', { name: 'Impact' });
  await expect(impact.getByText('The impact check failed.')).toBeVisible({ timeout: 30_000 });
  await impact.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(runOperations).toContain('retry');
  // Tried again, the check runs and finishes: its follow-ups in one line, the whole line a button. What was decided is the
  // proposal's own section, said once.
  const followUps = impact.getByTestId('impact-follow-ups');
  await expect(followUps).toHaveText('Follow-ups · 4 not sent', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'What was decided' })).toHaveCount(0);
  await expect(page.getByTestId('decision')).toContainText('Launch the pilot next week.');
  for (const gone of ['Affected items', 'People to tell', 'Couldn\'t confirm']) await expect(impact).not.toContainText(gone);
  await page.screenshot({ path: testInfo.outputPath('impact-card.png') });
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(2);
  expect(runOperations()).not.toContain('view');
  // The line opens the meeting's list, over the decision; Back returns to it.
  await followUps.click();
  const list = page.getByTestId('follow-ups');
  await expect(list.getByRole('heading', { name: 'Pilot planning' })).toBeVisible();
  // An item opened for you opens in its tool from its page.
  await list.getByTestId('follow-up-row').filter({ hasText: 'ECHO-12' }).click();
  await page.getByTestId('follow-up').getByRole('button', { name: 'Open in Jira' }).click();
  await expect.poll(opened).toEqual(['https://example.atlassian.net/browse/ECHO-12']);
  await page.getByTestId('back').click();
  // Its "Approved" goes back to the decision it was opened from.
  await list.getByRole('button', { name: /^Approved / }).click();
  await expect(followUps).toBeVisible();
  await expect(list).toHaveCount(0);
});
