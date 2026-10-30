import { expect, test, type Page } from '@playwright/test';
import { addMeeting, approveFromHome, emit, launch, type Launched } from './launch.js';
import { captureOpenExternal } from './native.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const runOperations = () => run.calls().filter(call => call.path === '/v1/person/runs').map(call => call.body?.operation);
/** The runs started, oldest first, by run id. */
const startedRuns = () => run.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'start').map(call => String(call.body?.run_id));
/** The last check started has finished: a runs list was read after it (the fixture finds a running check done on its next list). */
const lastFinished = () => { const operations = runOperations(); return operations.includes('start') && operations.lastIndexOf('list') > operations.lastIndexOf('start'); };
/** Home's reads of what waits on you: Home makes them only while it shows. */
const homeReads = () => run.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'home' && call.body.read === 'rows').length;

/** Adds the fixture meeting and approves its decision to Supplier review too: two destinations, so two records, each with its own check. */
async function approveToTwo(page: Page): Promise<void> {
  await addMeeting(page);
  await page.getByTestId('need-row').click();
  const card = page.getByTestId('decision');
  await card.getByTestId('route-chip').nth(0).click();
  await card.getByTestId('route-menu').getByRole('checkbox', { name: 'Supplier review' }).check();
  await page.keyboard.press('Escape');
  await card.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toContainText('Approved');
}

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
  await list.getByTestId('follow-up-row').filter({ hasText: 'ECHO-12' }).locator('.follow-up-open').click();
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
  await approveToTwo(page);
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

test('a meeting approved to two places has both its checks started and finished while Follow-ups shows, with no Home read there', async () => {
  run = await launch('granola');
  const { page } = run;
  await approveToTwo(page);
  // Straight on to Follow-ups: the checks start there one after the other, oldest first, and finish.
  await page.getByTestId('sidebar-follow-ups').click();
  await expect(page.getByTestId('follow-ups')).toBeVisible();
  await expect.poll(() => startedRuns().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const away = homeReads();
  await expect.poll(() => startedRuns().length, { timeout: 30_000 }).toBe(2);
  await expect.poll(lastFinished, { timeout: 30_000 }).toBe(true);
  expect(new Set(startedRuns()).size).toBe(2);
  // Home's own reads waited: they happen once Home shows, which has what the checks found.
  expect(homeReads()).toBe(away);
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' })).toBeVisible();
  expect(homeReads()).toBeGreaterThan(away);
});

test('Home opened while a check runs takes over from the page before it, and starts no check twice', async () => {
  run = await launch('granola');
  const { page } = run;
  await approveToTwo(page);
  await page.getByTestId('sidebar-follow-ups').click();
  await expect.poll(() => startedRuns().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  // The first check goes; Home opens before the next starts.
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => startedRuns().length, { timeout: 30_000 }).toBe(2);
  await expect.poll(lastFinished, { timeout: 30_000 }).toBe(true);
  // Each check was started once, by whichever look came first.
  expect(new Set(startedRuns()).size).toBe(2);
});

for (const [where, away, back] of [
  ['another app is in front', 'echo-test:conceal', 'echo-test:resume'],
  ['the window is closed to the tray', 'echo-test:hidden', 'echo-test:shown'],
] as const) {
  test(`checks keep moving while ${where}, and Home reads what they found once it shows again`, async () => {
    run = await launch('granola');
    const { page, app } = run;
    await approveToTwo(page);
    await emit(app, away);
    await expect.poll(() => startedRuns().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const before = homeReads();
    await expect.poll(() => startedRuns().length, { timeout: 30_000 }).toBe(2);
    await expect.poll(lastFinished, { timeout: 30_000 }).toBe(true);
    expect(new Set(startedRuns()).size).toBe(2);
    // Nothing of Home was read meanwhile; back, it reads what the checks found.
    expect(homeReads()).toBe(before);
    await emit(app, back);
    await expect.poll(homeReads).toBeGreaterThan(before);
    await expect(page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' })).toBeVisible();
  });
}
