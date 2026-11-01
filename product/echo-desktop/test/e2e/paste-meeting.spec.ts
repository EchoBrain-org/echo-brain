import { expect, test } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
/** What the person client sent to hand meetings in. */
const submits = () => run.calls().filter(call => call.path === '/v1/person/meetings' && call.body?.operation === 'submit').map(call => call.body);
const reviewReads = () => run.calls().filter(call => call.path === '/v1/person/meetings' && call.body?.operation === 'reviews').map(call => call.body?.tool_id);

test('a meeting pasted from any tool reaches Home as a decision to approve', async ({}, testInfo) => {
  run = await launch('hand-in');
  const { page } = run;
  await expect(page.getByTestId('home-clear')).toContainText('Nothing needs you');
  // Granola is not turned on here: Home reads the reviews through Paste a meeting.
  await expect.poll(reviewReads).toContain('hand-in');
  await page.getByTestId('sidebar-tools').click();
  const row = page.locator('[data-tool="hand-in"]');
  await expect(row).toHaveText('PPaste a meetingPaste');
  // Nothing to connect, manage or disconnect.
  await expect(row.getByTestId('tool-connect')).toHaveCount(0);
  await expect(row.getByTestId('tool-manage')).toHaveCount(0);
  await row.getByTestId('tool-paste').click();
  const sheet = page.getByTestId('paste-sheet');
  await expect(sheet.getByRole('heading', { name: 'Paste a meeting' })).toBeVisible();
  await expect(sheet.getByLabel('Title', { exact: true })).toBeFocused();
  const add = sheet.getByRole('button', { name: 'Add', exact: true });
  await sheet.getByLabel('Title', { exact: true }).fill('Supplier sync');
  await sheet.getByLabel('Date', { exact: true }).fill('2026-10-21');
  // Pasted from another tool: a Windows line ending, a line separator, and a control character no one sees.
  await sheet.getByLabel('Notes', { exact: true }).fill('Decision: move the pilot to Friday.\r\nAction: Mina sends\u0007 the revised quote.\u2028');
  // The transcript is folded away until it is asked for.
  await expect(sheet.getByLabel('Transcript', { exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Add a transcript' }).click();
  await sheet.getByLabel('Transcript', { exact: true }).fill('Mina Patel: I will send the revised quote.');
  await sheet.getByRole('combobox', { name: 'Suggest project' }).selectOption({ label: 'Apollo' });
  await expect(add).toBeDisabled();
  await sheet.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await page.screenshot({ path: testInfo.outputPath('paste-meeting.png') });
  await add.click();
  await expect(sheet.getByRole('status')).toHaveText('Added.');
  // What was added clears; the project and the consent stay for the next one.
  await expect(sheet.getByLabel('Title', { exact: true })).toHaveValue('');
  await expect(sheet.getByRole('combobox', { name: 'Suggest project' })).toHaveValue(APOLLO);
  // Canonical text, a whole day, retention and the suggestion; the text travelled in files, never in arguments.
  expect(submits()).toEqual([{ schema_version: 2, tool_id: 'hand-in', operation: 'submit', retain: true, project_id: APOLLO, meeting: {
    title: 'Supplier sync', notes: 'Decision: move the pilot to Friday.\nAction: Mina sends the revised quote.', transcript: 'Mina Patel: I will send the revised quote.',
    started_at: '2026-10-21T12:00:00.000Z', all_day: true } }]);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.getByTestId('sidebar-home').click();
  const need = page.getByTestId('need-row');
  await expect(need).toHaveCount(1);
  await expect(need).toHaveAttribute('data-kind', 'approve');
  await expect(need).toContainText('Decision: move the pilot to Friday');
  // A whole day keeps its day wherever Home shows it.
  await expect(need).toContainText('Supplier sync meeting, Oct 21');
  await expect(page.getByTestId('sidebar-badge')).toHaveText('1');
});

test('Paste a meeting keeps what was typed under the cover, sends a start time, and starts empty once closed', async () => {
  run = await launch('hand-in');
  const { page, app } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="hand-in"]').getByTestId('tool-paste').click();
  const sheet = page.getByTestId('paste-sheet');
  await sheet.getByLabel('Title', { exact: true }).fill('Supplier sync');
  await sheet.getByLabel('Notes', { exact: true }).fill('Decision: move the pilot to Friday.');
  // Another app in front, where the rest is copied from: the cover takes the sheet away, and it comes back as it was.
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(sheet.getByLabel('Title', { exact: true })).toHaveValue('Supplier sync');
  await expect(sheet.getByLabel('Notes', { exact: true })).toHaveValue('Decision: move the pilot to Friday.');
  await expect(sheet.getByLabel('Time', { exact: true })).toBeDisabled();
  await sheet.getByLabel('Date', { exact: true }).fill('2026-10-21');
  await sheet.getByLabel('Time', { exact: true }).fill('15:30');
  await sheet.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByRole('status')).toHaveText('Added.');
  // The start is this computer's local time, sent in UTC with its time zone.
  expect(submits()).toEqual([{ schema_version: 2, tool_id: 'hand-in', operation: 'submit', retain: true, project_id: null, meeting: {
    title: 'Supplier sync', notes: 'Decision: move the pilot to Friday.', transcript: '',
    started_at: new Date('2026-10-21T15:30').toISOString(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone } }]);
  // Pasting the same meeting again is the same meeting.
  await sheet.getByLabel('Title', { exact: true }).fill('Supplier sync');
  await sheet.getByLabel('Notes', { exact: true }).fill('Decision: move the pilot to Friday.');
  await sheet.getByLabel('Date', { exact: true }).fill('2026-10-21');
  await sheet.getByLabel('Time', { exact: true }).fill('15:30');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByRole('status')).toHaveText('Added.');
  expect(submits()).toHaveLength(2);
  await sheet.getByLabel('Title', { exact: true }).fill('Draft to drop');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  await page.locator('[data-tool="hand-in"]').getByTestId('tool-paste').click();
  await expect(sheet.getByLabel('Title', { exact: true })).toHaveValue('');
  await expect(sheet.getByLabel('I allow ECHO to retain', { exact: false })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('need-row')).toHaveCount(1);
});

test('a pasted whole day opens its card on its day, east of UTC+11 too, through Paste a meeting', async ({}, testInfo) => {
  // UTC+14, where noon UTC on Oct 21 is 2 AM on Oct 22: the meeting is still on Oct 21.
  run = await launch('hand-in', {}, { TZ: 'Pacific/Kiritimati' });
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="hand-in"]').getByTestId('tool-paste').click();
  const sheet = page.getByTestId('paste-sheet');
  await sheet.getByLabel('Title', { exact: true }).fill('Supplier sync');
  await sheet.getByLabel('Date', { exact: true }).fill('2026-10-21');
  await sheet.getByLabel('Notes', { exact: true }).fill('Decision: move the pilot to Friday.\nAction: Mina sends the revised quote.');
  await sheet.getByRole('combobox', { name: 'Suggest project' }).selectOption({ label: 'Apollo' });
  await sheet.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByRole('status')).toHaveText('Added.');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-home').click();
  const need = page.getByTestId('need-row');
  await expect(need).toContainText('Supplier sync meeting, Oct 21');
  await need.click();
  const card = page.getByTestId('decision');
  await expect(card.getByRole('heading', { name: 'Supplier sync' })).toBeVisible();
  // Its day alone: no time of day, and not the next day.
  await expect(card.locator('.card-top')).toHaveText('Approve· Meeting · Oct 21');
  await expect(card).toContainText('1 decision · 1 action');
  await expect(card).toContainText('Action: Mina sends the revised quote.');
  // Each item starts at the project the paste suggested.
  await expect(card.getByTestId('route-chip')).toHaveText(['Apollo', 'Apollo']);
  await expect(card.getByTestId('route-summary')).toHaveText('2 to Apollo');
  await page.screenshot({ path: testInfo.outputPath('paste-meeting-card.png') });
  // The card reads through the tool Home reads reviews through: Paste a meeting, with Granola not turned on.
  expect(run.calls().filter(call => call.path === '/v1/person/meetings' && call.body?.operation === 'review_open').map(call => call.body?.tool_id)).toEqual(['hand-in']);
});

test('a field you go to as the sheet opens keeps the caret, however slowly the window draws', async () => {
  run = await launch('hand-in');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  // A busy machine can take half a second to draw the next frame while scripts run at full speed.
  await page.evaluate(() => { window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 500); });
  // The sheet opens and Notes takes the caret within the same moment: whatever the sheet put off to a frame comes after.
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-tool="hand-in"] [data-testid="tool-paste"]')!.click();
    let notes: HTMLTextAreaElement | null = null;
    while (!(notes = document.querySelector('[data-testid="paste-sheet"] textarea'))) await new Promise(resolveTick => setTimeout(resolveTick, 0));
    notes.focus();
  });
  await page.waitForTimeout(700);
  await page.keyboard.type('Decision: move the pilot to Friday.');
  const sheet = page.getByTestId('paste-sheet');
  await expect(sheet.getByLabel('Notes', { exact: true })).toHaveValue('Decision: move the pilot to Friday.');
  await expect(sheet.getByLabel('Title', { exact: true })).toHaveValue('');
});

test('a meeting names at most 20 projects across its items: past that, each chip offers only the projects it names, and says why', async () => {
  // Twenty-two projects, ten a page.
  run = await launch('hand-in-many-projects');
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="hand-in"]').getByTestId('tool-paste').click();
  const sheet = page.getByTestId('paste-sheet');
  await sheet.getByLabel('Title', { exact: true }).fill('Supplier sync');
  await sheet.getByLabel('Date', { exact: true }).fill('2026-10-21');
  await sheet.getByLabel('Notes', { exact: true }).fill('Decision: move the pilot to Friday.\nAction: Mina sends the revised quote.');
  await sheet.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByRole('status')).toHaveText('Added.');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('need-row').click();
  const card = page.getByTestId('decision');
  const chips = card.getByTestId('route-chip');
  const menu = card.getByTestId('route-menu');
  const box = (n: number) => menu.getByRole('checkbox', { name: `Project ${n}`, exact: true });
  const limit = menu.getByTestId('projects-limit');
  // Every project listed, then the decision to nineteen of them and the action to a twentieth.
  await chips.nth(0).click();
  await menu.getByTestId('projects-more').click();
  await expect(box(20)).toBeVisible();
  await menu.getByTestId('projects-more').click();
  await expect(box(22)).toBeVisible();
  for (let n = 1; n <= 19; n += 1) await box(n).check();
  await expect(limit).toHaveCount(0);
  await page.keyboard.press('Escape');
  await chips.nth(1).click();
  await box(20).check();
  // Twenty in all: the action's chip offers only the projects the meeting names, and says why.
  await expect(limit).toHaveText('Up to 20 projects.');
  await expect(box(21)).toBeDisabled();
  await expect(box(1)).toBeEnabled();
  await page.keyboard.press('Escape');
  // So does the decision's, though it has nineteen: the action's project is open to it, the others are not.
  await chips.nth(0).click();
  await expect(limit).toHaveText('Up to 20 projects.');
  await expect(box(21)).toBeDisabled();
  await expect(box(22)).toBeDisabled();
  await box(20).check();
  await expect(chips.nth(0)).toHaveText('Project 1 +19');
  // A project only the decision named, ticked off, leaves room again.
  await box(1).uncheck();
  await expect(limit).toHaveCount(0);
  await expect(box(21)).toBeEnabled();
  await expect(card.getByTestId('route-summary')).toHaveText('1 to Project 2 +18 · 1 to Project 20');
});
