// Home (Home altitude v1, One place to look v1), against the fixture Authority's worlds. In `altitude`, Apollo is off track
// (Mina's ticket open nine days, a follow-up with no owner, Rafael's done), Beacon at risk (Rafael's page open four days, Ari's
// open today, which waits on Ari: Home's one Update), and two of Ari's wait on others. In `granola-owner`, Mina sent Ari
// three to update, the oldest a ticket from a meeting Ari cannot read ("order six weeks ahead").
import { expect, test, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let app: Launched;
test.afterEach(async () => { await app?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const MINA = 'mem_77777777-7777-4777-8777-777777777777';
const RAFAEL = 'mem_88888888-8888-4888-8888-888888888888';

/** Home at its top in the `altitude` world, its projects read. */
async function myProjects() {
  app = await launch('altitude');
  const { page } = app;
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(page.getByTestId('alt-project')).toHaveCount(2);
  await expect(page.getByTestId('alt-project').first()).toHaveAccessibleName('Apollo, Off track');
  return page;
}

/** Home zoomed into one kind of what needs you, or at its top. */
const list = (page: Page) => page.locator('[data-testid="needs"][data-category]');
const top = (page: Page) => page.locator('[data-testid="needs"]:not([data-category])');

test('Home opens at its top: the stops in the title row, what needs you with no click, then your projects', async () => {
  const page = await myProjects();
  // The stops sit where ECHO was, My projects lit; there is no ⌖ and no footer.
  const title = page.getByTestId('title');
  await expect(title.getByTestId('alt-stops')).toBeVisible();
  await expect(title).toHaveText('My projects');
  await expect(page.getByTestId('alt-stop').and(page.locator('[data-level="projects"]'))).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('alt-stop').and(page.locator('[data-level="project"]'))).toBeDisabled();
  await expect(page.getByTestId('alt-me')).toHaveCount(0);
  await expect(page.getByTestId('needs-foot')).toHaveCount(0);
  await expect(page.getByTestId('back')).toHaveCount(0);
  // One Update is that row, by name; Needs you counts what the badge counts.
  const row = page.getByTestId('need-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-kind', 'update');
  await expect(row).toContainText('Order samples');
  await expect(page.getByTestId('needs-head')).toHaveText('Needs you1');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('1');
  // What needs you comes first, your projects under it.
  const needs = await top(page).boundingBox();
  const projects = await page.getByTestId('alt-projects').boundingBox();
  expect(needs!.y + needs!.height).toBeLessThanOrEqual(projects!.y);
  await expect(page.getByTestId('sidebar-follow-ups-count')).toHaveText('2');
  await expect(page.getByTestId('sidebar-follow-ups')).toHaveAccessibleName('Follow-ups, 2 waiting on others');
  const apollo = page.getByTestId('alt-project').first();
  await apollo.focus();
  await page.keyboard.press('Enter');
  const level = page.getByTestId('alt-project-level');
  await expect(level).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-alt-nav') ?? false)).toBe(true);
  expect(await level.getByTestId('alt-group').evaluateAll(groups => groups.map(group => group.getAttribute('data-group')))).toEqual(['decisions', MINA, 'none', RAFAEL]);
  await expect(level.getByTestId('alt-item').filter({ hasText: 'ECHO-61' })).toHaveCount(1);
  const stop = title.getByTestId('alt-stop').and(page.locator('[data-level="project"]'));
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await expect(stop).toHaveAccessibleName('Project, Apollo');
  await page.getByTestId('alt-owner').filter({ hasText: 'Mina Patel' }).click();
  const person = page.getByTestId('alt-person-level');
  await expect(person).toBeVisible();
  expect(await person.getByTestId('alt-group').evaluateAll(groups => groups.map(group => group.getAttribute('data-group')))).toEqual([APOLLO]);
  await expect(page.getByTestId('alt-stop').and(page.locator('[data-level="person"]'))).toHaveAccessibleName('Person, Mina Patel');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(apollo).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('alt-project').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(row).toBeFocused();
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
