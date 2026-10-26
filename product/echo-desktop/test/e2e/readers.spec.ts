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
const place = (page: Page) => page.getByTestId('capture-place');
const lock = (page: Page) => page.getByTestId('capture-lock');
const list = (page: Page) => page.getByTestId('projects-list');
const tick = (page: Page, name: string) => list(page).getByRole('checkbox', { name, exact: true });

/** The place button and the lock sit on one row, and neither is cut off. */
async function oneRow(page: Page): Promise<void> {
  const boxes = await page.locator('.place-row > button').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const name = element.querySelector('.name') ?? element;
    return { top: Math.round(box.top), cut: name.scrollWidth - name.clientWidth > 1 };
  }));
  expect(boxes).toHaveLength(2);
  expect(new Set(boxes.map(box => box.top)).size).toBe(1);
  expect(boxes.filter(box => box.cut)).toEqual([]);
}

// ADR-0049: where it goes and who can read it, as the desktop sends them.
test('each place saves as it says: a project, a project under the lock, no project, and the organization', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);

  // From Home: no project, and so only you; the lock shows on and cannot be turned off.
  await page.getByTestId('write-button').click();
  await expect(place(page)).toHaveText('No project');
  await expect(lock(page)).toHaveText('Only me');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(lock(page)).toBeDisabled();
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');
  await page.getByTestId('compose-body').fill('Kickoff moved to Monday');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  expect(notes()[0]!.body).toMatchObject({ audience: { kind: 'only_me' }, association_project_ids: [] });

  // From a project: that project, unlocked, for its members.
  await page.getByTestId('sidebar-project').nth(0).click();
  await page.getByTestId('write-button').click();
  await expect(place(page)).toHaveText('Apollo');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(lock(page)).toBeEnabled();
  await expect(page.getByTestId('compose-readers')).toHaveText('Apollo members can read this.');
  await page.getByTestId('compose-body').fill('Weekly update');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo');
  expect(notes()[1]!.body).toMatchObject({ audience: { kind: 'project', project_id: APOLLO }, association_project_ids: [APOLLO] });

  // The lock on: still filed in Apollo, and only you can read it.
  await page.getByTestId('write-button').click();
  await lock(page).click();
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(place(page)).toHaveText('Apollo');
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');
  await page.getByTestId('compose-body').fill('My own reminder');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo · only you');
  expect(notes()[2]!.body).toMatchObject({ audience: { kind: 'only_me' }, association_project_ids: [APOLLO] });

  // Organization: everyone, filed in no project, and no lock to offer.
  await page.getByTestId('write-button').click();
  await place(page).click();
  await list(page).getByTestId('place-team').click();
  await expect(list(page)).toHaveCount(0);
  await expect(place(page)).toHaveText('Organization');
  await expect(lock(page)).toHaveCount(0);
  await expect(page.getByTestId('compose-readers')).toHaveText('Everyone in your org can read this.');
  await expect(page.getByTestId('compose-readers')).toHaveClass(/warning/);
  await page.getByTestId('compose-body').fill('All hands notes');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Shared with your organization');
  expect(notes()[3]!.body).toMatchObject({ audience: { kind: 'team' }, association_project_ids: [] });
  expect(notes()).toHaveLength(4);
});

test('the place and the lock are one row: Tab reaches each, Enter opens the list on its first project, Escape closes only it, and ⌘↩ saves', async () => {
  run = await launch();
  const { page, app } = run;
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(800, 560); });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([800, 560]);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await oneRow(page);
  await page.getByTestId('compose-body').fill('Kickoff moved to Monday');

  // From the note, Tab lands on the place; the lock of no project is not a stop.
  await page.keyboard.press('Tab');
  await expect(place(page)).toBeFocused();
  await expect(place(page)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeVisible();
  await expect(place(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(list(page).getByTestId('projects-row')).toHaveText(['Apollo', 'Beacon']);
  // Opening the list changes nothing yet: No project is still the place.
  await expect(list(page).getByTestId('place-none')).toHaveAttribute('aria-pressed', 'true');
  await expect(list(page).getByTestId('place-team')).toHaveAttribute('aria-pressed', 'false');
  await expect(tick(page, 'Apollo')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(tick(page, 'Apollo')).toBeChecked();
  await expect(place(page)).toHaveText('Apollo');
  await expect(list(page).getByTestId('place-none')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('compose-readers')).toHaveText('Apollo members can read this.');

  // Escape closes only the list, and the caret goes back to the place.
  await page.keyboard.press('Escape');
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId('compose')).toBeVisible();
  await expect(place(page)).toBeFocused();
  // A project's lock is off, and the next stop.
  await page.keyboard.press('Tab');
  await expect(lock(page)).toBeFocused();
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Space');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');
  await oneRow(page);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('compose-attach')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo · only you');
  expect(notes()).toHaveLength(1);
  expect(notes()[0]!.body).toMatchObject({ audience: { kind: 'only_me' }, association_project_ids: [APOLLO] });
});

test('the list holds several projects: closed with none ticked it goes back to what it was, and two ticked are saved for both', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Pricing for both teams');

  await place(page).click();
  await expect(list(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
  // A click outside it (the list covers the note) with nothing ticked: still no project.
  await page.getByTestId('compose-readers').click();
  await expect(list(page)).toHaveCount(0);
  await expect(place(page)).toHaveText('No project');
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');

  await place(page).click();
  await tick(page, 'Beacon').click();
  await tick(page, 'Apollo').click();
  await expect(place(page)).toHaveText('Beacon +1');
  await expect(page.getByTestId('compose-readers')).toHaveText('Members of Beacon and Apollo can read this.');
  await list(page).getByTestId('projects-done').click();
  await expect(list(page)).toHaveCount(0);
  await expect(place(page)).toHaveAttribute('title', 'Beacon, Apollo');
  // The place again opens the list, and once more closes it.
  await place(page).click();
  await expect(list(page).getByRole('checkbox', { checked: true })).toHaveCount(2);
  await place(page).click();
  await expect(list(page)).toHaveCount(0);

  // Both unticked is a project choice with nothing to save: ⌘↩ waits, and closing the list goes back to both.
  await place(page).click();
  await tick(page, 'Beacon').click();
  await tick(page, 'Apollo').click();
  await expect(page.getByTestId('compose-readers')).toHaveText('Choose one or more projects.');
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('compose')).toBeVisible();
  expect(notes()).toHaveLength(0);
  await page.getByTestId('compose-readers').click();
  await expect(list(page)).toHaveCount(0);
  await expect(place(page)).toHaveText('Beacon +1');

  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon and Apollo');
  expect(notes()).toHaveLength(1);
  // Sorted, as the API takes them.
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'projects', project_ids: [APOLLO, BEACON] });
  expect(notes()[0]!.body?.association_project_ids).toEqual([APOLLO, BEACON]);
});

test('No project or Organization from the list closes it, unticks every project, and files the capture in none', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('sidebar-project').nth(0).click();
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Not for either team');
  await place(page).click();
  await expect(tick(page, 'Apollo')).toBeChecked();
  await tick(page, 'Beacon').click();
  await expect(place(page)).toHaveText('Apollo +1');

  await list(page).getByTestId('place-team').click();
  await expect(list(page)).toHaveCount(0);
  await expect(place(page)).toHaveText('Organization');
  await expect(lock(page)).toHaveCount(0);
  await place(page).click();
  await expect(list(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(list(page).getByTestId('place-team')).toHaveAttribute('aria-pressed', 'true');

  await list(page).getByTestId('place-none').click();
  await expect(list(page)).toHaveCount(0);
  await expect(place(page)).toHaveText('No project');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(lock(page)).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved for you');
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'only_me' });
  expect(notes()[0]!.body?.association_project_ids).toEqual([]);
});

test('⌘⇧E starts in no project, a drop on a row starts with it ticked, and Start over keeps the place and the lock', async () => {
  run = await launch('write-unavailable');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await emit(app, 'echo-test:capture');
  await expect(place(page)).toHaveText('No project');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);

  // Nothing was written: a drop on Beacon's row starts over, for Beacon, listed first.
  const folder = mkdtempSync(join(tmpdir(), 'echo-drop-'));
  folders.push(folder);
  writeFileSync(join(folder, 'Brief.md'), 'Annual pricing.');
  await drop(page, page.getByTestId('sidebar-project').nth(1), join(folder, 'Brief.md'));
  await expect(place(page)).toHaveText('Beacon');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'false');
  await place(page).click();
  await expect(list(page).getByTestId('projects-row')).toHaveText(['Beacon', 'Apollo']);
  await expect(tick(page, 'Beacon')).toBeChecked();
  await expect(tick(page, 'Apollo')).not.toBeChecked();
  await tick(page, 'Apollo').click();
  await list(page).getByTestId('projects-done').click();
  await lock(page).click();
  await page.getByTestId('compose-remove-file').click();
  await page.getByTestId('compose-body').fill('Both teams need this');
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('compose-unresolved')).toBeVisible();

  await page.getByTestId('compose-new').click();
  await page.getByTestId('compose-start-over').click();
  await expect(page.getByTestId('compose-body')).toHaveValue('');
  await expect(place(page)).toHaveText('Beacon +1');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Only you can read this.');
});

test('an unconfirmed save to two projects under the lock is locked, and Try again resends the identical audience', async () => {
  run = await launch('write-unavailable-once');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await place(page).click();
  await tick(page, 'Apollo').click();
  await tick(page, 'Beacon').click();
  await lock(page).click();
  await page.getByTestId('compose-body').fill('Renewal terms');
  await page.getByTestId('compose-send').click();
  // Kept for yourself: it may not have been saved.
  await expect(page.getByTestId('compose-error')).toHaveText('This may not have been saved.');
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await expect(place(page)).toBeDisabled();
  await expect(lock(page)).toBeDisabled();

  await page.getByTestId('compose-retry').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Apollo and Beacon · only you');
  expect(notes()).toHaveLength(2);
  expect(notes()[1]!.body).toEqual(notes()[0]!.body);
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'only_me' });
  expect(notes()[0]!.body?.association_project_ids).toEqual([APOLLO, BEACON]);
});

test('at most twenty projects: past eight a field finds one, More projects reads on, and the rest are off with a line saying so', async () => {
  run = await launch('over-twenty-projects');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(10);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Quarterly numbers');
  await place(page).click();
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
  await expect(place(page)).toHaveText('Project 7 +19');
  await expect(page.getByTestId('compose-readers')).toHaveText('Members of Project 7, Project 1 and 18 more can read this.');
  // One unticked makes room again.
  await tick(page, 'Project 1').click();
  await expect(list(page).getByTestId('projects-limit')).toHaveCount(0);
  await tick(page, 'Project 21').click();
  await expect(tick(page, 'Project 22')).toBeDisabled();

  // ⌘↩ from the list saves.
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Project 7, Project 2 and 18 more');
  const ids = Array.from({ length: 20 }, (_, index) => `prj_${String(index + 2).padStart(8, '0')}-3333-4333-8333-333333333333`);
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'projects', project_ids: ids });
  expect(notes()[0]!.body?.association_project_ids).toEqual(ids);
});

test('the list read again while Capture is open moves no project: one new to it joins at the end', async () => {
  run = await launch('project-added');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  await page.getByTestId('compose-body').fill('Pilot notes');
  await place(page).click();
  const rows = list(page).getByTestId('projects-row');
  await expect(rows).toHaveText(['Apollo', 'Beacon']);

  // Added to Comet elsewhere; the window comes forward with Capture open: the list is read again, and Comet, the newest, leads it.
  writeFileSync(join(run.home, 'project-added'), '');
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(3);
  await expect(page.getByTestId('sidebar-project').first()).toContainText('Comet');
  // In Capture every project stays where it was, so a click lands where it was aimed.
  await expect(rows).toHaveText(['Apollo', 'Beacon', 'Comet']);
  await tick(page, 'Beacon').click();
  await list(page).getByTestId('projects-done').click();
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon');
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'project', project_id: BEACON });

  // A new capture places them afresh, in the list's order.
  await page.getByTestId('write-button').click();
  await place(page).click();
  await expect(rows).toHaveText(['Comet', 'Apollo', 'Beacon']);
});

test('at the smallest window a very long name is cut off in the place only, and the list stays in the window', async () => {
  run = await launch('long-project-names');
  const { page, app } = run;
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(800, 560); });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([800, 560]);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(10);
  await page.getByTestId('write-button').click();
  await place(page).click();
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

  // Only the name is cut off: +1 and the lock are whole, on one row, and Save is in the window.
  await expect(place(page)).toHaveText(`${long} +1`);
  await expect(place(page)).toHaveAttribute('title', `${long}, Upload validation d92c717 Beta`);
  const cut = await place(page).locator('.name').evaluate(name => name.scrollWidth - name.clientWidth > 1);
  expect(cut).toBe(true);
  const button = await box(place(page));
  const count = await box(place(page).locator('.count'));
  expect(count.x + count.width).toBeLessThanOrEqual(button.x + button.width);
  const tops = await page.locator('.place-row > button').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
  expect(tops).toHaveLength(2);
  expect(new Set(tops).size).toBe(1);
  expect(await lock(page).evaluate(element => element.scrollWidth - element.clientWidth > 1)).toBe(false);
  await expect(page.getByTestId('compose-send')).toBeInViewport({ ratio: 1 });
  const sheet = await box(page.getByTestId('compose'));
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(560);

  // One ticked: its full name is the tooltip.
  await place(page).click();
  await tick(page, 'Upload validation d92c717 Beta').click();
  await list(page).getByTestId('projects-done').click();
  await expect(place(page)).toHaveAttribute('title', long);
  await expect(page.getByTestId('compose-readers')).toHaveText(`${long} members can read this.`);
});
