// Home (Home altitude v1, One place to look v1), against the fixture Authority's worlds. In `altitude`, Apollo is off track
// (Mina's ticket open nine days, a follow-up with no owner, Rafael's done), Beacon at risk (Rafael's page open four days, Ari's
// open today, which waits on Ari: Home's one Update), and two of Ari's wait on others. In `granola-review`, two follow-ups wait
// on Ari: ECHO-12, Mina's, changed since Ari sent it (Review), and Ari's own PRD page (Update).
import { expect, test, type Page } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let app: Launched;
test.afterEach(async () => { await app?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const BEACON = 'prj_44444444-4444-4444-8444-444444444444';
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

/** Pastes a meeting through Tools → Paste a meeting, then goes Home by the sidebar. */
async function paste(page: Page, title: string, decision: string) {
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="hand-in"]').getByTestId('tool-paste').click();
  const sheet = page.getByTestId('paste-sheet');
  await sheet.getByLabel('Title', { exact: true }).fill(title);
  await sheet.getByLabel('Date', { exact: true }).fill('2026-10-21');
  await sheet.getByLabel('Notes', { exact: true }).fill(`Decision: ${decision}\nAction: Mina sends the revised quote.`);
  await sheet.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByRole('status')).toHaveText('Added.');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-home').click();
}

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
});

test('My projects shows a mark only when a project is not on track, why, a grey bar of what is done and the oldest wait', async () => {
  const page = await myProjects();
  await expect(page.getByTestId('alt-group-head')).toHaveCount(0);
  const rows = page.getByTestId('alt-project');
  await expect(rows.nth(0)).toHaveAttribute('data-project', APOLLO);
  await expect(rows.nth(0).locator('.health-mark.off')).toHaveCount(1);
  // The follow-up needing attention longest, and whose it is.
  await expect(rows.nth(0).locator('.alt-reason')).toHaveText(/ · Mina Patel$/);
  await expect(rows.nth(0).locator('.alt-bar')).toHaveAttribute('title', '1 of 3 follow-ups done');
  await expect(rows.nth(0).locator('.alt-date')).toHaveText('9d');
  await expect(rows.nth(1)).toHaveAttribute('data-project', BEACON);
  await expect(rows.nth(1)).toHaveAccessibleName('Beacon, At risk');
  await expect(rows.nth(1).locator('.health-mark.risk')).toHaveCount(1);
  await expect(rows.nth(1).locator('.alt-reason')).toHaveText(/ · Rafael Moreno$/);
  await expect(rows.nth(1).locator('.alt-bar')).toHaveAttribute('title', '0 of 2 follow-ups done');
  await expect(rows.nth(1).locator('.alt-date')).toHaveText('4d');
  await expect(page.getByTestId('alt-projects')).not.toContainText('%');
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
  // The title row's project stop is lit on it.
  const stop = page.getByTestId('title').getByTestId('alt-stop').and(page.locator('[data-level="project"]'));
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await expect(stop).toHaveAccessibleName('Project, Apollo');
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

test('Home comes back from a page as it was left, but the sidebar’s Home opens its top', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-project').first().click();
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  await page.getByTestId('sidebar-project').filter({ hasText: 'Beacon' }).click();
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  // Escape on the project's page goes Home as it was left.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('alt-head')).toContainText('Apollo');
  await page.getByTestId('sidebar-project').filter({ hasText: 'Beacon' }).click();
  await expect(page.getByTestId('title')).toHaveText('Beacon');
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(top(page)).toBeVisible();
  // The project stop still names where Home was last zoomed.
  await expect(page.getByTestId('alt-stop').and(page.locator('[data-level="project"]'))).toHaveAccessibleName('Project, Apollo');
});

test('a reload opens the top, wherever Home was zoomed, and forgets where an older version kept it', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-project').first().click();
  await expect(page.getByTestId('alt-project-level')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('echo.home.altitude', JSON.stringify({ level: 'project', project_id: 'prj_11111111-1111-4111-8111-111111111111' })));
  await page.reload();
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(top(page)).toBeVisible();
  await expect(page.getByTestId('alt-project-level')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('echo.home.altitude'))).toBeNull();
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
  // Back out, the focus is on the project it came from, and ↓ moves to the next; ↑ twice reaches what needs you above.
  await expect(apollo).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('alt-project').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('need-row')).toBeFocused();
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

test('a click on a heading or empty space leaves the keyboard where it was', async () => {
  const page = await myProjects();
  await page.getByTestId('alt-projects-head').click();
  expect(await page.evaluate(() => document.activeElement?.classList.contains('alt-level') ?? false)).toBe(false);
});

test('a meeting that lands shows by name with no click; two are one Approve line, and Needs you counts what the badge does', async () => {
  app = await launch('hand-in');
  const { page } = app;
  await expect(page.getByTestId('home-clear')).toContainText('Nothing needs you');
  await paste(page, 'Supplier sync', 'move the pilot to Friday.');
  const row = page.getByTestId('need-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-kind', 'approve');
  await expect(row).toContainText('Supplier sync meeting, Oct 21');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('1');
  await expect(page.getByTestId('needs-head')).toHaveText('Needs you1');
  await paste(page, 'Weekly standup', 'ship the beta.');
  const line = page.getByTestId('need-category');
  await expect(line).toHaveAttribute('data-category', 'approve');
  await expect(line).toHaveText(/^Approve2(Supplier sync|Weekly standup)and 1 more/);
  await expect(line).toHaveAttribute('title', 'See all 2 to approve');
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('sidebar-badge')).toHaveText('2');
  await expect(page.getByTestId('needs-head')).toHaveText('Needs you2');
  // Its list: both meetings, each its row as Home always showed it.
  await line.click();
  await expect(list(page)).toHaveAttribute('data-category', 'approve');
  await expect(row).toHaveCount(2);
  await expect(row.filter({ hasText: 'Weekly standup meeting, Oct 21' })).toHaveAttribute('data-kind', 'approve');
});

test('a kind with two rows opens its list, Home zoomed in; Escape, the title row’s Home and the sidebar’s Home come back to the top', async () => {
  app = await launch('granola-review');
  const { page } = app;
  const line = page.getByTestId('need-category');
  await expect(line).toHaveAttribute('data-category', 'update');
  await expect(line).toContainText('Update2');
  await expect(line).toContainText('and 1 more');
  await expect(page.getByTestId('need-row')).toHaveCount(0);
  await expect(page.getByTestId('needs-head')).toHaveText('Needs you2');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('2');
  const open = async () => {
    await line.click();
    await expect(list(page)).toBeVisible();
    await expect(page.getByTestId('need-list-head')).toHaveText('Update2');
    await expect(page.getByTestId('need-row')).toHaveCount(2);
    // The title row keeps the stops, My projects lit, with its way back Home.
    await expect(page.getByTestId('alt-stop').and(page.locator('[data-level="projects"]'))).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('back')).toHaveText('Home');
    await expect(page.getByTestId('alt-projects')).toHaveCount(0);
  };
  await open();
  await page.keyboard.press('Escape');
  await expect(top(page)).toBeVisible();
  // Back out, the focus is on the line it came from.
  await expect(line).toBeFocused();
  await expect(page.getByTestId('back')).toHaveCount(0);
  await open();
  await page.getByTestId('back').click();
  await expect(top(page)).toBeVisible();
  await open();
  await page.getByTestId('sidebar-home').click();
  await expect(top(page)).toBeVisible();
  // A row's page, then Back: the list, as it was left.
  await open();
  await page.getByTestId('need-row').filter({ hasText: 'Thermostat PRD' }).click();
  await expect(page.getByTestId('follow-up')).toBeVisible();
  await page.getByTestId('back').click();
  await expect(list(page)).toBeVisible();
  await expect(page.getByTestId('need-row')).toHaveCount(2);
});

test('a kind’s list stays while one row is left, and goes back to the top by itself once its last is dealt with', async () => {
  app = await launch('granola-review');
  const { page } = app;
  await page.getByTestId('need-category').click();
  const rows = page.getByTestId('need-row');
  await expect(rows).toHaveCount(2);
  const done = async (name: string) => {
    await rows.filter({ hasText: name }).click();
    await page.getByTestId('follow-up').getByRole('button', { name: 'Mark done', exact: true }).click();
    await expect(page.getByTestId('follow-up-said')).toHaveText('Done · Undo');
    await page.getByTestId('back').click();
  };
  await done('ECHO-12');
  await expect(list(page)).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId('need-list-head')).toHaveText('Update1');
  await done('Thermostat PRD');
  await expect(top(page)).toBeVisible();
  await expect(page.getByTestId('home-clear')).toHaveText('Nothing needs you');
  await expect(page.getByTestId('alt-projects')).toBeVisible();
  await expect(page.getByTestId('back')).toHaveCount(0);
});

test('leaving a kind’s list down to one row puts the focus on that row on the top, not on the row above it', async () => {
  app = await launch('granola-review-paste');
  const { page } = app;
  await paste(page, 'Supplier sync', 'move the pilot to Friday.');
  // One meeting to approve, its own row, above the two to update, one line.
  const rows = page.getByTestId('need-row');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute('data-kind', 'approve');
  await page.getByTestId('need-category').click();
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: 'ECHO-12' }).click();
  await page.getByTestId('follow-up').getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(page.getByTestId('follow-up-said')).toHaveText('Done · Undo');
  await page.getByTestId('back').click();
  await expect(rows).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(top(page)).toBeVisible();
  // The top shows the one left as its row, in place of its kind's line: it has the focus.
  await expect(page.getByTestId('need-category')).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Thermostat PRD' })).toBeFocused();
});

test('back from a row’s page the focus is on that row, and once that row is dealt with and read away, on the row in its place', async () => {
  app = await launch('granola-review');
  const { page } = app;
  await page.getByTestId('need-category').click();
  const rows = page.getByTestId('need-row');
  const echo = rows.filter({ hasText: 'ECHO-12' });
  const prd = rows.filter({ hasText: 'Thermostat PRD' });
  await expect(rows).toHaveCount(2);
  await expect(echo).toBeFocused();
  // The second row's page, then Back: that row, not the first.
  await page.keyboard.press('ArrowDown');
  await expect(prd).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('follow-up')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list(page)).toBeVisible();
  await expect(prd).toBeFocused();
  // The first row's page, Mark done, then Back: Home reads its row away, and the focus moves to the row now in its place.
  await page.keyboard.press('ArrowUp');
  await expect(echo).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByTestId('follow-up').getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(page.getByTestId('follow-up-said')).toHaveText('Done · Undo');
  await page.keyboard.press('Escape');
  await expect(rows).toHaveCount(1);
  await expect(prd).toBeFocused();
});

test('nothing needs you: one quiet line, with your projects below it', async () => {
  app = await launch();
  const { page } = app;
  await expect(page.getByTestId('home-clear')).toHaveText('Nothing needs you');
  await expect(page.getByTestId('needs-head')).toHaveCount(0);
  await expect(page.getByTestId('alt-project')).toHaveCount(2);
  await expect(page.getByTestId('sidebar-badge')).toHaveCount(0);
});

test('the sidebar counts what waits on others, in grey, and Follow-ups and Only me open with no back link', async () => {
  const page = await myProjects();
  const followUps = page.getByTestId('sidebar-follow-ups');
  await expect(followUps.getByTestId('sidebar-follow-ups-count')).toHaveText('2');
  await expect(followUps).toHaveAccessibleName('Follow-ups, 2 waiting on others');
  await expect(followUps.getByTestId('sidebar-follow-ups-count')).toHaveAttribute('title', '2 waiting on others');
  await expect(page.getByTestId('sidebar').locator('.side-row')).toHaveText(['Home1', 'Ask', /Capture/, 'Follow-ups2', 'Only me', 'Tools']);
  await page.getByTestId('sidebar-only-me').click();
  await expect(page.getByTestId('title')).toHaveText('Only me');
  await expect(page.getByTestId('sidebar-only-me')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('sidebar-home')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('back')).toHaveCount(0);
  // Escape still goes Home.
  await page.keyboard.press('Escape');
  await expect(top(page)).toBeVisible();
  await followUps.click();
  await expect(page.getByTestId('title')).toHaveText('Follow-ups');
  await expect(followUps).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('back')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(top(page)).toBeVisible();
});
