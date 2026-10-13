// ADR-0035: the sidebar's one row for a new version. Test builds never run the
// updater: main shows the row a test sets, and records what a click installs.
import { expect, test } from '@playwright/test';
import { emit, launch, setUpdateState, updateInstalls, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const RELEASE = 'clean-v1-release-b';

test('no row without a new version; New version · Restart installs it and shows Updating', async () => {
  run = await launch();
  const { page } = run;
  const row = page.getByTestId('sidebar-update');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await expect(row).toHaveCount(0);

  await setUpdateState(run, { state: 'available', release: RELEASE });
  await expect(row).toHaveText('New version · Restart');
  await expect(row).toHaveRole('button');
  // Directly above the account row.
  await expect(page.locator('.update-rows + .account-row')).toHaveCount(1);
  await row.click();
  await expect.poll(() => updateInstalls(run)).toEqual([RELEASE]);
  await expect(row).toContainText('Updating');
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toBeFocused();
  await expect(row.locator('.asking')).toBeVisible();

  // It failed: Try again asks again.
  await setUpdateState(run, { state: 'failed', release: RELEASE, reason: 'failed' });
  await expect(row).toHaveText('Couldn\'t update · Try again');
  await row.click();
  await expect.poll(() => updateInstalls(run)).toEqual([RELEASE, RELEASE]);
  await expect(row).toContainText('Updating');

  await setUpdateState(run, { state: 'none' });
  await expect(row).toHaveCount(0);
});

test('a save whose outcome is unknown holds the restart, in sign out\'s words, until it is settled', async () => {
  run = await launch('write-unavailable-once');
  const { page, app } = run;
  const row = page.getByTestId('sidebar-update');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Offsite dates');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();
  await page.keyboard.press('Escape');

  await setUpdateState(run, { state: 'available', release: RELEASE });
  await row.click();
  await expect(page.getByTestId('sidebar-update-note')).toHaveText('A save may not have arrived. Check it in Capture first.');
  expect(await updateInstalls(run)).toEqual([]);

  // Checked, it did not arrive: nothing is lost by restarting.
  await emit(app, 'echo-test:capture');
  await page.getByTestId('compose-check').click();
  await expect(page.getByTestId('compose-error')).toHaveText('It was not saved. Try again.');
  await page.keyboard.press('Escape');
  // Nothing is held now, so the line goes rather than say something untrue.
  await expect(page.getByTestId('sidebar-update-note')).toHaveCount(0);
  await row.click();
  await expect.poll(() => updateInstalls(run)).toEqual([RELEASE]);
  await expect(page.getByTestId('sidebar-update-note')).toHaveCount(0);
  await expect(row).toHaveText('Updating');
});

test('outside Applications the row only says where ECHO must be', async () => {
  run = await launch();
  const { page } = run;
  const row = page.getByTestId('sidebar-update');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await setUpdateState(run, { state: 'failed', release: RELEASE, reason: 'location' });
  await expect(row).toHaveText('Move ECHO to Applications to update');
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  // Playwright refuses an unavailable control; a person can still press it.
  await row.click({ force: true });
  // Any install the click sent reaches main before this later change shows.
  await setUpdateState(run, { state: 'available', release: RELEASE });
  await expect(row).toHaveText('New version · Restart');
  expect(await updateInstalls(run)).toEqual([]);
});

test('newer files already installed: New version · Restart restarts into them', async () => {
  run = await launch();
  const { page } = run;
  const row = page.getByTestId('sidebar-update');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await setUpdateState(run, { state: 'restart', release: RELEASE });
  await expect(row).toHaveText('New version · Restart');
  await row.click();
  await expect.poll(() => updateInstalls(run)).toEqual([RELEASE]);
});

test('the row shows under ECHO could not start, so a release whose host cannot start still installs its fix', async () => {
  run = await launch('host-crash');
  const { page } = run;
  const row = page.getByTestId('sidebar-update');
  await expect(page.getByTestId('start-failed')).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveCount(0);
  await setUpdateState(run, { state: 'available', release: RELEASE });
  await expect(row).toBeVisible();
  await expect(row).toHaveText('New version · Restart');
  await expect(page.getByTestId('start-retry')).toBeVisible();
  await row.click();
  await expect.poll(() => updateInstalls(run)).toEqual([RELEASE]);
  await expect(row).toContainText('Updating');
  await expect(page.getByTestId('start-failed')).toBeVisible();
});

test('the row shows signed out, and a reload reads it from main again', async () => {
  run = await launch('signed-out');
  const { page } = run;
  const row = page.getByTestId('sidebar-update');
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await setUpdateState(run, { state: 'available', release: RELEASE });
  await expect(row).toHaveText('New version · Restart');
  await expect(page.locator('.update-rows + .account-row')).toHaveText('Account · Sign in');

  await page.reload();
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await expect(row).toHaveText('New version · Restart');
  await row.click();
  await expect.poll(() => updateInstalls(run)).toEqual([RELEASE]);
  await expect(row).toContainText('Updating');
});
