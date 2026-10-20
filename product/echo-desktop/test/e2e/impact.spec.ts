import { expect, test } from '@playwright/test';
import { approveFromHome, launch, type Launched } from './launch.js';
import { captureOpenExternal } from './native.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const runOperations = () => run.calls().filter(call => call.path === '/v1/person/runs').map(call => call.body?.operation);

test('a failed check gives its reason, offers Try again, and then its follow-ups', async ({}, testInfo) => {
  run = await launch('granola-run-failed');
  const { page, app } = run;
  const opened = await captureOpenExternal(app);
  const row = await approveFromHome(page, true);
  // A check that did not finish waits on you: its row opens the reason.
  await expect(row).toHaveAttribute('data-kind', 'failed', { timeout: 30_000 });
  await expect(row).toContainText('Approved · the check did not finish');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('1');
  await row.click();
  const impact = page.getByTestId('decision').getByRole('region', { name: 'Impact' });
  await expect(impact.getByText('The impact check failed.')).toBeVisible({ timeout: 30_000 });
  await impact.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(runOperations).toContain('retry');
  // Tried again, the check runs and finishes: its follow-ups in one line, the whole line a button, beside what was decided.
  const followUps = impact.getByTestId('impact-follow-ups');
  await expect(followUps).toHaveText('Follow-ups · 4 not sent', { timeout: 30_000 });
  await expect(page.getByTestId('decision')).toContainText('Launch the pilot next week.');
  await page.screenshot({ path: testInfo.outputPath('impact-card.png') });
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(2);
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
