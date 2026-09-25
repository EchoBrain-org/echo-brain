import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drop, emit, launch, type Launched } from './launch.js';

let run: Launched;
const folders: string[] = [];
test.afterEach(async () => {
  await run?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const BEACON = 'prj_44444444-4444-4444-8444-444444444444';
const notes = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');
const radios = (page: Page) => page.getByRole('radiogroup', { name: 'Who can read' }).getByRole('radio');
const projects = (page: Page) => page.getByTestId('readers-projects');
const list = (page: Page) => page.getByTestId('projects-list');
const tick = (page: Page, name: string) => list(page).getByRole('checkbox', { name, exact: true });

/** The three choices sit on one row, and none is cut off. */
async function oneRow(page: Page): Promise<void> {
  const boxes = await radios(page).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const name = element.querySelector('.name') ?? element;
    return { top: Math.round(box.top), cut: name.scrollWidth - name.clientWidth > 1 };
  }));
  expect(boxes).toHaveLength(3);
  expect(new Set(boxes.map(box => box.top)).size).toBe(1);
  expect(boxes.filter(box => box.cut)).toEqual([]);
}

test('Who can read is Only me, Projects and Organization on one row: arrow keys move and pick, one Tab stop, and ⌘↩ saves', async () => {
  run = await launch();
  const { page, app } = run;
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(800, 560); });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([800, 560]);
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await expect(radios(page)).toHaveText(['Only me', 'Projects', 'Organization']);
  await oneRow(page);
  const radio = (name: string) => page.getByRole('radio', { name, exact: true });
  await page.getByTestId('compose-body').fill('Kickoff moved to Monday');

  // From the note, Tab lands on the chosen one only.
  await page.keyboard.press('Tab');
  await expect(radio('Only me')).toBeFocused();
  // Projects with nothing ticked is chosen, with nothing to save until one is.
  await page.keyboard.press('ArrowRight');
  await expect(projects(page)).toBeFocused();
  await expect(projects(page)).toHaveAttribute('aria-checked', 'true');
  await expect(radio('Only me')).toHaveAttribute('aria-checked', 'false');
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId('compose-readers')).toHaveText('Choose one or more projects.');
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  await page.keyboard.press('ArrowDown');
  await expect(radio('Organization')).toBeFocused();
  await expect(radio('Organization')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Everyone in your org can read this.');
  await expect(page.getByTestId('compose-readers')).toHaveClass(/warning/);
  // Leaving Organization for Projects leaves it: what has the caret is what is chosen, and ⌘↩ waits.
  await page.keyboard.press('ArrowLeft');
  await expect(projects(page)).toBeFocused();
  await expect(projects(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Choose one or more projects.');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('compose')).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  expect(notes()).toHaveLength(0);
  // The ends wrap round.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(radio('Only me')).toBeFocused();
  await expect(radio('Only me')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(radio('Organization')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(projects(page)).toBeFocused();

  // Enter chooses Projects and opens its list, with the caret on the first project.
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeVisible();
  await expect(projects(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Choose one or more projects.');
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  await expect(tick(page, 'Apollo')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(tick(page, 'Apollo')).toBeChecked();
  await expect(page.getByTestId('compose-readers')).toHaveText('Apollo members can read this.');
  await expect(projects(page)).toHaveText('Apollo');

  // Escape closes only the list, and the caret goes back to Projects.
  await page.keyboard.press('Escape');
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId('compose')).toBeVisible();
  await expect(projects(page)).toBeFocused();
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Apollo');
  await expect(page.getByRole('radio', { checked: false })).toHaveCount(2);

  // One Tab stop: the next Tab leaves the group, and Shift-Tab comes back to the chosen one.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('compose-attach')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(projects(page)).toBeFocused();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo');
  expect(notes()).toHaveLength(1);
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'project', project_id: APOLLO });
  expect(notes()[0]!.body?.association_project_ids).toEqual([APOLLO]);
});

test('Projects holds several: the list closes with nothing ticked back to what it was, and two ticked are saved for both', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Only me');
  await page.getByTestId('compose-body').fill('Pricing for both teams');

  await projects(page).click();
  await expect(list(page).getByTestId('projects-row')).toHaveText(['Apollo', 'Beacon']);
  await expect(list(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Projects');
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  // Nothing ticked is nothing to save: ⌘↩ waits.
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('compose')).toBeVisible();
  expect(notes()).toHaveLength(0);
  // A click outside closes it, and with nothing ticked the choice is Only me again.
  await page.getByTestId('compose-body').click();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Only me');
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');

  await projects(page).click();
  await tick(page, 'Beacon').click();
  await tick(page, 'Apollo').click();
  await expect(projects(page)).toHaveText('Beacon +1');
  await expect(page.getByTestId('compose-readers')).toHaveText('Members of Beacon and Apollo can read this.');
  await list(page).getByTestId('projects-done').click();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Beacon +1');
  await expect(projects(page)).toHaveAttribute('title', 'Beacon, Apollo');
  // Projects again opens the list, and Projects once more closes it.
  await projects(page).click();
  await expect(list(page).getByRole('checkbox', { checked: true })).toHaveCount(2);
  await projects(page).click();
  await expect(list(page)).toHaveCount(0);

  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon and Apollo');
  expect(notes()).toHaveLength(1);
  // Sorted, as the API takes them.
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'projects', project_ids: [APOLLO, BEACON] });
  expect(notes()[0]!.body?.association_project_ids).toEqual([APOLLO, BEACON]);
});

test('projects unticked in the list stay unticked when Only me or Organization is chosen next', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await page.getByTestId('compose-body').fill('Not for either team');
  const choose = async (names: string[]) => {
    await projects(page).click();
    for (const name of names) await tick(page, name).click();
  };
  await choose(['Apollo', 'Beacon']);
  await list(page).getByTestId('projects-done').click();
  await expect(projects(page)).toHaveText('Apollo +1');

  // Both unticked, then Organization: the list closes as it stands.
  await choose(['Apollo', 'Beacon']);
  await page.getByTestId('readers-team').click();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Organization');
  await expect(projects(page)).toHaveText('Projects');

  // The same with Only me, and nothing is filed in the project unticked.
  await choose(['Apollo']);
  await list(page).getByTestId('projects-done').click();
  await choose(['Apollo']);
  await page.getByTestId('readers-only-me').click();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Only me');
  await expect(projects(page)).toHaveText('Projects');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'only_me' });
  expect(notes()[0]!.body?.association_project_ids).toEqual([]);
});

test('⌘⇧E starts as Only me with nothing ticked, a drop on a row starts with it ticked, and Start over keeps the choice', async () => {
  run = await launch('write-unavailable');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Only me');
  await expect(projects(page)).toHaveText('Projects');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);

  // Nothing was written: a drop on Beacon's row starts over, for Beacon, listed first.
  const folder = mkdtempSync(join(tmpdir(), 'echo-drop-'));
  folders.push(folder);
  writeFileSync(join(folder, 'Brief.md'), 'Annual pricing.');
  await drop(page, page.getByTestId('project-row').nth(1), join(folder, 'Brief.md'));
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Beacon');
  await projects(page).click();
  await expect(list(page).getByTestId('projects-row')).toHaveText(['Beacon', 'Apollo']);
  await expect(tick(page, 'Beacon')).toBeChecked();
  await expect(tick(page, 'Apollo')).not.toBeChecked();
  await tick(page, 'Apollo').click();
  await list(page).getByTestId('projects-done').click();
  await page.getByTestId('compose-remove-file').click();
  await page.getByTestId('compose-body').fill('Both teams need this');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();

  await page.getByTestId('compose-new').click();
  await page.getByTestId('compose-start-over').click();
  await expect(page.getByTestId('compose-body')).toHaveValue('');
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Beacon +1');
  await expect(page.getByTestId('compose-readers')).toHaveText('Members of Beacon and Apollo can read this.');
});

test('an unconfirmed save to two projects is locked, and Try again resends the identical audience', async () => {
  run = await launch('write-unavailable-once');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await projects(page).click();
  await tick(page, 'Apollo').click();
  await tick(page, 'Beacon').click();
  await page.getByTestId('compose-body').fill('Renewal terms');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-error')).toHaveText('This may not have been sent.');
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await expect(projects(page)).toBeDisabled();
  await expect(page.getByTestId('readers-only-me')).toBeDisabled();

  await page.getByTestId('compose-retry').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo and Beacon');
  expect(notes()).toHaveLength(2);
  expect(notes()[1]!.body).toEqual(notes()[0]!.body);
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'projects', project_ids: [APOLLO, BEACON] });
  expect(notes()[0]!.body?.association_project_ids).toEqual([APOLLO, BEACON]);
});

test('at most twenty projects: past eight a field finds one, More projects reads on, and the rest are off with a line saying so', async () => {
  run = await launch('over-twenty-projects');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(10);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Quarterly numbers');
  await projects(page).click();
  const rows = list(page).getByTestId('projects-row');
  await expect(rows).toHaveCount(10);
  const find = list(page).getByTestId('projects-find');
  await expect(find).toBeFocused();
  // More projects reads Home's next pages, into the list Home and the sidebar share.
  await list(page).getByTestId('projects-more').click();
  await expect(rows).toHaveCount(20);
  await list(page).getByTestId('projects-more').click();
  await expect(rows).toHaveCount(22);
  await expect(list(page).getByTestId('projects-more')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(22);

  await find.fill('Apollo');
  await expect(list(page).getByTestId('projects-none')).toHaveText('No project matches.');
  // Enter ticks the first match.
  await find.fill('7');
  await expect(rows).toHaveText(['Project 7', 'Project 17']);
  await find.press('Enter');
  await expect(tick(page, 'Project 7')).toBeChecked();
  await find.fill('');
  await expect(rows).toHaveCount(22);
  // The line about the limit shows in a live region that is already there, so a screen reader says it.
  const live = list(page).locator('[aria-live="polite"]');
  await expect(live).toHaveCount(1);
  await expect(live).toHaveText('');
  for (let number = 1; number <= 20; number += 1) if (number !== 7) await tick(page, `Project ${number}`).click();
  await expect(list(page).getByRole('checkbox', { checked: true })).toHaveCount(20);
  await expect(live.getByTestId('projects-limit')).toHaveText('Up to 20 projects.');
  await expect(tick(page, 'Project 21')).toBeDisabled();
  await expect(tick(page, 'Project 22')).toBeDisabled();
  await expect(tick(page, 'Project 20')).toBeEnabled();
  await expect(projects(page)).toHaveText('Project 7 +19');
  await expect(page.getByTestId('compose-readers')).toHaveText('Members of Project 7, Project 1 and 18 more can read this.');
  // One unticked makes room again.
  await tick(page, 'Project 1').click();
  await expect(list(page).getByTestId('projects-limit')).toHaveCount(0);
  await tick(page, 'Project 21').click();
  await expect(tick(page, 'Project 22')).toBeDisabled();

  // ⌘↩ from the list saves.
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Project 7, Project 2 and 18 more');
  const ids = Array.from({ length: 20 }, (_, index) => `prj_${String(index + 2).padStart(8, '0')}-3333-4333-8333-333333333333`);
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'projects', project_ids: ids });
  expect(notes()[0]!.body?.association_project_ids).toEqual(ids);
});

test('the list read again while Capture is open moves no project: one new to it joins at the end', async () => {
  run = await launch('project-added');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Pilot notes');
  await projects(page).click();
  const rows = list(page).getByTestId('projects-row');
  await expect(rows).toHaveText(['Apollo', 'Beacon']);

  // The window comes forward with Capture open: Home reads its list again, and Comet, the newest, leads it.
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('project-row')).toHaveCount(3);
  await expect(page.getByTestId('project-row').first()).toContainText('Comet');
  // In Capture every project stays where it was, so a click lands where it was aimed.
  await expect(rows).toHaveText(['Apollo', 'Beacon', 'Comet']);
  await tick(page, 'Beacon').click();
  await list(page).getByTestId('projects-done').click();
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon');
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'project', project_id: BEACON });

  // A new capture places them afresh, in the list's order.
  await page.getByTestId('write-button').click();
  await projects(page).click();
  await expect(rows).toHaveText(['Comet', 'Apollo', 'Beacon']);
});

test('at the smallest window a very long name is cut off in Projects only, and the list stays in the window', async () => {
  run = await launch('long-project-names');
  const { page, app } = run;
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(800, 560); });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([800, 560]);
  await expect(page.getByTestId('project-row')).toHaveCount(10);
  await page.getByTestId('write-button').click();
  await projects(page).click();
  await list(page).getByTestId('projects-more').click();
  const rows = list(page).getByTestId('projects-row');
  await expect(rows).toHaveCount(20);

  // Every name in the list is whole: a long one wraps.
  const long = 'A project whose name is far too long to fit on one line of the Capture sheet, however wide the window is made';
  expect(await rows.evaluateAll(labels => labels.filter(label => label.scrollWidth - label.clientWidth > 1).length)).toBe(0);
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const shown = await box(list(page));
  expect(shown.y).toBeGreaterThanOrEqual(0);
  expect(shown.y + shown.height).toBeLessThanOrEqual(560);
  await tick(page, long).click();
  await tick(page, 'Upload validation d92c717 Beta').click();
  await list(page).getByTestId('projects-done').click();

  // Only the name is cut off: +1 and the other two choices are whole, on one row, and Save is in the window.
  await expect(projects(page)).toHaveText(`${long} +1`);
  await expect(projects(page)).toHaveAttribute('title', `${long}, Upload validation d92c717 Beta`);
  const cut = await projects(page).locator('.name').evaluate(name => name.scrollWidth - name.clientWidth > 1);
  expect(cut).toBe(true);
  const pill = await box(projects(page));
  const count = await box(projects(page).locator('.count'));
  expect(count.x + count.width).toBeLessThanOrEqual(pill.x + pill.width);
  const tops = await radios(page).evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  for (const name of ['Only me', 'Organization']) {
    expect(await page.getByRole('radio', { name, exact: true }).evaluate(element => element.scrollWidth - element.clientWidth > 1)).toBe(false);
  }
  await expect(page.getByTestId('compose-send')).toBeInViewport({ ratio: 1 });
  const sheet = await box(page.getByTestId('compose'));
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(560);

  // One ticked: its full name is the tooltip and what a screen reader says.
  await projects(page).click();
  await tick(page, 'Upload validation d92c717 Beta').click();
  await list(page).getByTestId('projects-done').click();
  await expect(page.getByRole('radio', { name: long, exact: true })).toHaveAttribute('title', long);
  await expect(page.getByTestId('compose-readers')).toHaveText(`${long} members can read this.`);
});
