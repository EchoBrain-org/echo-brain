import { expect, test, type Locator } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const BEACON = 'prj_44444444-4444-4444-8444-444444444444';
const notes = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');

test('Who can read is one radio group: arrow keys move and pick, one Tab stop, and ⌘↩ saves from it', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  const radio = (name: string) => page.getByRole('radio', { name, exact: true });
  await expect(page.getByRole('radiogroup', { name: 'Who can read' }).getByRole('radio')).toHaveText(['Only me', 'Apollo', 'Beacon', 'Organization']);
  // Two projects need no search.
  await expect(page.getByTestId('readers-find')).toHaveCount(0);
  await page.getByTestId('compose-body').fill('Kickoff moved to Monday');

  // From the note, Tab lands on the chosen one only.
  await page.keyboard.press('Tab');
  await expect(radio('Only me')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(radio('Apollo')).toBeFocused();
  await expect(radio('Apollo')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Apollo members can read this.');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(radio('Organization')).toBeFocused();
  await expect(page.getByTestId('compose-readers')).toHaveText('Everyone in your org can read this.');
  await expect(page.getByTestId('compose-readers')).toHaveClass(/warning/);
  // The ends wrap round.
  await page.keyboard.press('ArrowRight');
  await expect(radio('Only me')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(radio('Beacon')).toBeFocused();
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Beacon');
  await expect(page.getByRole('radio', { checked: false })).toHaveCount(3);

  // One Tab stop: the next Tab leaves the group, and Shift-Tab comes back to the chosen one.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('compose-attach')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(radio('Beacon')).toBeFocused();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon');
  expect(notes()).toHaveLength(1);
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'project', project_id: BEACON });
  expect(notes()[0]!.body?.association_project_ids).toEqual([BEACON]);
});

test('the list read again while Capture is open moves no pill: a project new to it joins at the end', async () => {
  run = await launch('project-added');
  const { page, app } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  const radios = page.getByRole('radiogroup', { name: 'Who can read' }).getByRole('radio');
  await expect(radios).toHaveText(['Only me', 'Apollo', 'Beacon', 'Organization']);
  await page.getByTestId('compose-body').fill('Pilot notes');

  // The window comes forward with Capture open: Home reads its list again, and Comet, the newest, leads it.
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('project-row')).toHaveCount(3);
  await expect(page.getByTestId('project-row').first()).toContainText('Comet');
  // In Capture every pill stays where it was, so a click lands where it was aimed.
  await expect(radios).toHaveText(['Only me', 'Apollo', 'Beacon', 'Comet', 'Organization']);
  await page.getByRole('radio', { name: 'Beacon', exact: true }).click();
  await page.getByTestId('compose-send').click();
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon');
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'project', project_id: BEACON });

  // A new capture places them afresh, in the list's order.
  await page.getByTestId('write-button').click();
  await expect(radios).toHaveText(['Only me', 'Comet', 'Apollo', 'Beacon', 'Organization']);
});

test('past eight projects a field finds one: Enter picks the first match, ⌘↩ still saves and Escape still closes', async () => {
  run = await launch('many-projects');
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(10);
  await page.getByTestId('write-button').click();
  const find = page.getByTestId('readers-find');
  await expect(find).toHaveAttribute('placeholder', 'Find a project');
  await expect(page.getByTestId('readers-project')).toHaveCount(10);
  await page.getByTestId('compose-body').fill('Numbers for the first one');

  await find.fill('7');
  await expect(page.getByRole('radio')).toHaveText(['Only me', 'Project 7', 'Organization']);
  await find.press('Enter');
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Project 7');
  await expect(page.getByTestId('compose-readers')).toHaveText('Project 7 members can read this.');
  await find.fill('project 1');
  await expect(page.getByTestId('readers-project')).toHaveText(['Project 1', 'Project 10']);
  await find.press('Enter');
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Project 1');
  await expect(find).toBeFocused();

  // Escape puts Capture away with the draft, even from the field.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await page.getByTestId('write-button').click();
  await expect(page.getByTestId('compose-body')).toHaveValue('Numbers for the first one');
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Project 1');

  // More projects reads the next page, into the list Home and the sidebar share.
  await page.getByTestId('readers-more-projects').click();
  await expect(page.getByTestId('readers-project')).toHaveCount(13);
  await expect(page.getByTestId('readers-more-projects')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  await find.fill('13');
  await find.press('Enter');
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Project 13');
  await find.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Project 13');
  const project13 = 'prj_00000013-1111-4111-8111-111111111111';
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'project', project_id: project13 });
  expect(notes()[0]!.body?.association_project_ids).toEqual([project13]);
});

test('at the smallest window every name that fits is whole, and twenty projects scroll above Save', async () => {
  run = await launch('long-project-names');
  const { page, app } = run;
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(800, 560); });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([800, 560]);
  await expect(page.getByTestId('project-row')).toHaveCount(10);
  await page.getByTestId('write-button').click();
  await page.getByTestId('readers-more-projects').click();
  await expect(page.getByTestId('readers-project')).toHaveCount(20);

  const pills = await page.getByRole('radio').evaluateAll(radios => radios.map(radio => ({
    name: radio.textContent, cut: radio.scrollWidth - radio.clientWidth > 1, title: radio.getAttribute('title'),
  })));
  const long = 'A project whose name is far too long to fit on one line of the Capture sheet, however wide the window is made';
  // Only the name wider than the whole sheet is cut off; it keeps its whole name, as its name and its tooltip.
  expect(pills.filter(pill => pill.cut)).toEqual([{ name: long, cut: true, title: long }]);
  expect(pills.filter(pill => pill.title !== null)).toHaveLength(1);
  await expect(page.getByRole('radio', { name: long, exact: true })).toHaveCount(1);
  await expect(page.getByRole('radio', { name: 'Upload validation d92c717 Beta', exact: true })).toBeVisible();

  // The pills scroll in their own room: Save and the paperclip stay whole, below them, in the window.
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const room = await box(page.locator('.reader-pills'));
  const save = await box(page.getByTestId('compose-send'));
  const attach = await box(page.getByTestId('compose-attach'));
  const sheet = await box(page.getByTestId('compose'));
  expect(await page.locator('.reader-pills').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(room.y + room.height).toBeLessThanOrEqual(Math.min(save.y, attach.y));
  expect(sheet.y).toBeGreaterThanOrEqual(0);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(560);
  await expect(page.getByTestId('compose-send')).toBeInViewport({ ratio: 1 });

  // The last pill is reached by scrolling, and one click picks it.
  await page.getByRole('radio', { name: 'Organization' }).click();
  await expect(page.getByTestId('compose-readers')).toHaveText('Everyone in your org can read this.');
  await page.getByRole('radio', { name: long }).click();
  await expect(page.getByTestId('compose-readers')).toHaveText(`${long} members can read this.`);
  await expect(page.getByTestId('compose-send')).toBeInViewport({ ratio: 1 });

  // Put away and opened again, the chosen pill is in sight.
  await page.getByRole('radio', { name: 'Finance' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await page.getByTestId('write-button').click();
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Finance');
  await expect(page.getByRole('radio', { name: 'Finance' })).toBeInViewport({ ratio: 1 });
});
