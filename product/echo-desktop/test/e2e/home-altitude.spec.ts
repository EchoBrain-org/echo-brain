// Home (Home altitude v1, One place to look v1), against the fixture Authority's worlds. In `altitude`, Apollo is off track
// (Mina's ticket open nine days, a follow-up with no owner, Rafael's done), Beacon at risk (Rafael's page open four days, Ari's
// open today, which waits on Ari: Home's one Update), and two of Ari's wait on others. In `granola-owner`, Mina sent Ari
// three to update, the oldest a ticket from a meeting Ari cannot read ("order six weeks ahead").
import { expect, test, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let app: Launched;
test.afterEach(async () => { await app?.close(); });

/** Home at its top in the `altitude` world, its projects read. */
async function myProjects() {
  app = await launch('altitude');
  const { page } = app;
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(page.getByTestId('alt-project')).toHaveCount(2);
  await expect(page.getByTestId('alt-project').first()).toHaveAccessibleName('Apollo, Off track');
  return page;
}

/** Home zoomed into one kind of what needs you. */
const list = (page: Page) => page.locator('[data-testid="needs"][data-category]');

// What each altitude shows (the stops, Needs you above the projects, a project's groups, a person's) is altitude-screens.test's;
// here, the keys and the focus, which only a real window has.
test('Home moves the focus with the keys: Enter zooms on a project with the focus in it, Escape goes back to the row it left, the arrows go row to row', async () => {
  const page = await myProjects();
  const apollo = page.getByTestId('alt-project').first();
  await apollo.focus();
  await page.keyboard.press('Enter');
  const level = page.getByTestId('alt-project-level');
  await expect(level).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-alt-nav') ?? false)).toBe(true);
  await page.getByTestId('alt-owner').filter({ hasText: 'Mina Patel' }).click();
  await expect(page.getByTestId('alt-person-level')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(apollo).toBeFocused();
  // Back into Apollo, the focus starts on its first row, not on Mina from the zoom before.
  await page.keyboard.press('Enter');
  await expect(level).toBeVisible();
  await expect(level.getByTestId('alt-decision').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(apollo).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('alt-project').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('need-row')).toBeFocused();
});

test('back on a row that Home’s read then moves to the top, the focus stays on that row and the arrows go on from there', async () => {
  app = await launch('granola-owner');
  const { page } = app;
  await page.getByTestId('need-category').and(page.locator('[data-category="update"]')).click();
  const rows = page.getByTestId('need-row');
  const vendor = rows.filter({ hasText: 'order six weeks ahead' });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('order six weeks ahead');
  // The last row's page: Mark done, then Undo, which makes it the newest to update.
  await vendor.click();
  const item = page.getByTestId('follow-up');
  await item.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(page.getByTestId('follow-up-said')).toHaveText('Done · Undo');
  await page.getByTestId('follow-up-said').getByRole('button', { name: 'Undo', exact: true }).click();
  // Settled: Escape does nothing while a change is on its way, and the line empties as soon as Undo starts.
  await expect(page.getByTestId('follow-up-said')).toHaveText('Reopened');
  // Back: the list as it was left, that row focused; Home's read then moves it to the top, and it keeps the focus.
  await page.keyboard.press('Escape');
  await expect(list(page)).toBeVisible();
  await expect(rows.first()).toContainText('order six weeks ahead');
  await expect(vendor).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
});
