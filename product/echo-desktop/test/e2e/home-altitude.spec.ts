// Home's altitudes (Home altitude v1), against the fixture Authority's `altitude` world: Apollo is off track (Mina's ticket open
// nine days, a follow-up with no owner, Rafael's done), Beacon at risk (Rafael's page open four days, Ari's open today).
import { expect, test } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let app: Launched;
test.afterEach(async () => { await app?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const BEACON = 'prj_44444444-4444-4444-8444-444444444444';
const MINA = 'mem_77777777-7777-4777-8777-777777777777';
const RAFAEL = 'mem_88888888-8888-4888-8888-888888888888';

async function myProjects() {
  app = await launch('altitude');
  const { page } = app;
  await page.getByTestId('alt-stops').getByRole('button', { name: 'My projects' }).click();
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(page.getByTestId('alt-project')).toHaveCount(2);
  return page;
}

test('Home opens on Me: Needs you as it was, under the stops', async () => {
  app = await launch('altitude');
  const { page } = app;
  await expect(page.getByTestId('alt-stops')).toBeVisible();
  await expect(page.getByTestId('alt-me')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('needs')).toBeVisible();
  await expect(page.getByTestId('alt-stop').and(page.locator('[data-level="project"]'))).toBeDisabled();
});

test('My projects shows each project’s health, what needs attention and its longest wait', async () => {
  const page = await myProjects();
  await expect(page.getByTestId('alt-group-head')).toHaveText(['Off track1', 'At risk1']);
  const rows = page.getByTestId('alt-project');
  await expect(rows.nth(0)).toHaveAttribute('data-project', APOLLO);
  await expect(rows.nth(0)).toHaveAccessibleName('Apollo, Off track');
  await expect(rows.nth(0).locator('.alt-need')).toHaveText('2');
  await expect(rows.nth(0).locator('.alt-date')).toHaveText('9d');
  await expect(rows.nth(1)).toHaveAttribute('data-project', BEACON);
  await expect(rows.nth(1)).toHaveAccessibleName('Beacon, At risk');
});

test('a project shows its decisions and its owners, needing attention first; Escape zooms back out', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-project').first().click();
  const level = page.getByTestId('alt-project-level');
  await expect(level).toBeVisible();
  await expect(level.getByTestId('alt-group')).toHaveCount(4);
  expect(await level.getByTestId('alt-group').evaluateAll(groups => groups.map(group => group.getAttribute('data-group')))).toEqual(['decisions', MINA, 'none', RAFAEL]);
  // Its ticket's title came from a live read, as the project's follow-ups list reads it.
  await expect(level.getByTestId('alt-item').filter({ hasText: 'ECHO-61' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('alt-projects')).toBeVisible();
});

test('a person shows their follow-ups across your projects', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-project').first().click();
  await page.getByTestId('alt-owner').filter({ hasText: 'Mina Patel' }).click();
  const level = page.getByTestId('alt-person-level');
  await expect(level).toBeVisible();
  expect(await level.getByTestId('alt-group').evaluateAll(groups => groups.map(group => group.getAttribute('data-group')))).toEqual([APOLLO]);
  await expect(page.getByTestId('alt-stop').and(page.locator('[data-level="person"]'))).toHaveAccessibleName('Person, Mina Patel');
});

test('Escape clears the Ask bar’s text first, and stays on the project', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-project').first().click();
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  await page.getByTestId('ask-field').fill('x');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ask-field')).toHaveValue('');
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
});

test('Home comes back at the altitude it was left at', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-project').first().click();
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  await page.getByTestId('sidebar-project').filter({ hasText: 'Beacon' }).click();
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  await expect(page.getByTestId('alt-head')).toContainText('Apollo');
});

test('the keyboard zooms in and out without losing its place', async () => {
  const page = await myProjects();
  const apollo = page.getByTestId('alt-project').first();
  await apollo.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  // The focus lands on the new level's first row, so the arrows keep working.
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-alt-nav') ?? false)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  // Back out, the focus is on the project it came from, and ↓ moves to the next.
  await expect(apollo).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('alt-project').nth(1)).toBeFocused();
});

test('a trackpad pinch zooms: spread over a project to go in, pinch to come out', async () => {
  const page = await myProjects();
  const pinch = (selector: string, deltaY: number) => page.locator(selector).first().evaluate((node, delta) => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, ctrlKey: true, bubbles: true, cancelable: true }));
  }, deltaY);
  await pinch('[data-testid="alt-project"]', -120);
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  await page.waitForTimeout(450);
  await pinch('[data-testid="alt-project-level"]', 120);
  await expect(page.getByTestId('alt-projects')).toBeVisible();
});

test('zooming into a project puts the focus on its first row, not on someone from an earlier zoom', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-project').first().click();
  await page.getByTestId('alt-owner').filter({ hasText: 'Mina Patel' }).click();
  await expect(page.getByTestId('alt-person-level')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('alt-project').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  await expect(page.getByTestId('alt-decision').first()).toBeFocused();
});

