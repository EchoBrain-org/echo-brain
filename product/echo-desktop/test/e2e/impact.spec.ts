import { expect, test } from '@playwright/test';
import { addMeeting, approveFromHome, launch, type Launched } from './launch.js';
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

test('a further destination\'s check that did not finish is tried again on its own, beside the check that did', async () => {
  // granola-extra-failed: each record's check but the first fails until Try again.
  run = await launch('granola-extra-failed');
  const { page } = run;
  await addMeeting(page);
  await page.getByTestId('need-row').click();
  const card = page.getByTestId('decision');
  // The decision to Supplier review too: two destinations, so two records, each with its own check.
  await card.getByTestId('route-chip').nth(0).click();
  await card.getByTestId('route-menu').getByRole('checkbox', { name: 'Supplier review' }).check();
  await page.keyboard.press('Escape');
  await card.getByTestId('decision-approve').click();
  const row = page.getByTestId('need-row').filter({ hasText: 'the check did not finish' });
  await expect(row).toHaveAttribute('data-kind', 'failed', { timeout: 30_000 });
  await row.click();
  const decision = page.getByTestId('decision');
  const first = decision.getByRole('region', { name: 'Impact · Thermostat redesign +1' });
  const second = decision.getByRole('region', { name: 'Impact · Thermostat redesign', exact: true });
  await expect(first.getByTestId('impact-follow-ups')).toHaveText('Follow-ups · 4 not sent', { timeout: 30_000 });
  await expect(second.getByText('The impact check failed.')).toBeVisible();
  await second.getByRole('button', { name: 'Try again' }).click();
  // Its own check runs again, and finishes; the other's stays as it was.
  await expect.poll(() => run.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'retry').map(call => call.body?.run_id))
    .toEqual(['run_00000000-0000-4000-8000-000000000021']);
  await expect(second.getByTestId('impact-follow-ups')).toHaveText('Follow-ups · None', { timeout: 30_000 });
  await expect(second.getByText('The impact check failed.')).toHaveCount(0);
  await expect(first.getByTestId('impact-follow-ups')).toHaveText('Follow-ups · 4 not sent');
  await expect(decision.getByRole('heading', { name: 'What did it change?' })).toBeVisible();
});
