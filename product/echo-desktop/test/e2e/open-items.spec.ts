import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let app: Launched;
test.afterEach(async () => { await app?.close(); });

/** Adds the fixture meeting through Granola, then the Approve row → Approve, for the project it suggests. */
async function approveFromHome(run: Launched) {
  const { page } = run;
  await page.getByTestId('sidebar-tools').click();
  await page.locator('[data-tool="granola"]').getByTestId('tool-manage').click();
  const meetings = page.getByRole('region', { name: 'Personal meetings' });
  await meetings.getByLabel('Granola folder').selectOption({ label: 'ECHO (1)' });
  await meetings.getByRole('button', { name: 'Pilot planning', exact: true }).click();
  await meetings.getByLabel('I allow ECHO to retain', { exact: false }).check();
  await meetings.getByRole('button', { name: 'Add to ECHO', exact: true }).click();
  await expect(meetings.getByRole('status')).toContainText('Added.');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('need-row').filter({ hasText: 'Pilot planning' }).click();
  await page.getByTestId('decision-approve').click();
  await expect(page.getByTestId('toast')).toContainText('Approved');
}

const runOperations = () => app.calls().filter(call => call.path === '/v1/person/runs').map(call => call.body?.operation);
/** A list's reads, in order: rows only, or live (" live"), by states, and " more" past the first page; never counts or a check's rows. */
const listReads = () => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'items' && !notificationScan(call.body) && call.body.read !== 'counts' && call.body.scope !== 'run')
  .map(call => `${(call.body!.states as string[]).join('+')}${call.body!.cursor === undefined ? '' : ' more'}${call.body!.read === 'rows' ? '' : ' live'}`);
const notificationScan = (body: Record<string, unknown>) => body.operation === 'items' && body.scope === 'mine' && body.read === 'rows' && (body.states as string[] | undefined)?.join() === 'open';
/** Foreground runs requests; notification discovery is checked independently. */
const requests = (operation: string) => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === operation && !notificationScan(call.body)).map(call => call.body!);
/** The sweeps the app asked for, by scope. */
const sweeps = () => requests('sweep').map(body => ({ scope: body.scope, id: body.id }));
/** The fixture's Pilot planning record, and the project it was approved into. */
const PILOT_RECORD = `sha256:${createHash('sha256').update('record:Pilot planning').digest('hex')}`;
const THERMOSTAT = 'prj_11111111-1111-4111-8111-111111111111';
/** A day as the app writes it ("Oct 7"), in this computer's time zone, as the app's is. */
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
/** What a live open of an item Ari cannot open would read: its key, title, link and assignee. */
const WITHHELD = ['ECHO-31', 'Trace sign-off', 'browse/ECHO-31', 'S. Okafor', 'ECHO-20', 'Vendor order', 'Rafael Moreno'];

/** A list's group of one status, and its rows. */
const group = (list: Locator, status: 'Not sent' | 'Open' | 'Done' | 'Dismissed') => list.getByRole('region', { name: status, exact: true });
const row = (scope: Locator, text: string) => scope.getByTestId('follow-up-row').filter({ hasText: text });

/** Picks a person under an owner chip that is open. */
async function pickOwner(page: Page, name: string, query?: string) {
  const picker = page.getByTestId('owner-picker');
  if (query !== undefined) await picker.getByRole('searchbox', { name: 'Find a person' }).fill(query);
  await picker.getByRole('option', { name, exact: true }).click();
}

test('a meeting\'s follow-ups go to their owners from one list, and come back done', async ({}, testInfo) => {
  app = await launch('granola');
  const { page } = app;
  await approveFromHome(app);
  // The check runs by itself; its Send row opens the meeting's follow-ups.
  const send = page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' });
  await expect(send).toContainText('Launch the pilot next week — 4 follow-ups to send', { timeout: 20_000 });
  await expect(send).toContainText('owners Mina, Rafael');
  await send.click();
  const list = page.getByTestId('follow-ups');
  await expect(list.getByRole('heading', { name: 'Pilot planning' })).toBeVisible();
  await expect(list).toContainText(`Approved ${day('2026-10-07T10:00:00.000Z')} · 4 follow-ups`);
  // Not sent: the meeting's actions first, then what its check found; every row ticked, as one click sends them all.
  const unsent = group(list, 'Not sent');
  await expect(unsent.getByText('Not sent · 4')).toBeVisible();
  await expect(unsent.getByTestId('follow-up-row')).toHaveText([/^Send the revised quoteMeeting action/, /^Confirm the traceMeeting action/,
    /^ECHO-12 · Pilot launchJira ticket/, /^Thermostat PRD · Pilot scopeConfluence page/]);
  for (const name of ['Send the revised quote', 'Confirm the trace', 'ECHO-12 · Pilot launch', 'Thermostat PRD · Pilot scope']) {
    await expect(unsent.getByRole('checkbox', { name, exact: true })).toBeChecked();
  }
  await expect(row(unsent, 'Send the revised quote')).toContainText('Rafael');
  await expect(row(unsent, 'Confirm the trace')).toContainText('Mina');
  // ECHO matched no one for the PRD page: Pick owner.
  await expect(row(unsent, 'Thermostat PRD').getByRole('button', { name: 'Pick owner: Thermostat PRD · Pilot scope' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Send 4', exact: true })).toBeVisible();

  // Untick all but ECHO-12, and send it: it is Open with its owner, the rest still Not sent, and the list stays.
  for (const name of ['Send the revised quote', 'Confirm the trace', 'Thermostat PRD · Pilot scope']) await unsent.getByRole('checkbox', { name, exact: true }).uncheck();
  await list.getByRole('button', { name: 'Send 1', exact: true }).click();
  // The foot says what happened, and takes the focus from the button that went.
  const said = list.getByTestId('follow-ups-said');
  await expect(said).toHaveText('Sent to Mina');
  await expect(said).toBeFocused();
  await expect(row(group(list, 'Open'), 'ECHO-12')).toContainText('Mina');
  await expect(unsent.getByTestId('follow-up-row')).toHaveCount(3);
  await expect(unsent.getByRole('checkbox', { checked: true })).toHaveCount(0);
  expect(requests('send').map(body => body.items)).toEqual([[{ item_id: 'itm_00000000-0000-4000-8000-000000000031', include: true }]]);
  // Every group of a meeting's list, read together rows only, then live; the send read the list again, rows only.
  const all = 'unsent+open+done+not_relevant';
  expect(listReads()).toEqual([all, `${all} live`, all]);
  expect(requests('item')).toEqual([]);

  // An owner changed in place before sending: the PRD page goes to Rafael at once, still Not sent.
  await row(unsent, 'Thermostat PRD').getByRole('button', { name: 'Pick owner: Thermostat PRD · Pilot scope' }).click();
  await expect(page.getByTestId('owner-picker').getByRole('option').first()).toHaveAccessibleName('You');
  await pickOwner(page, 'Rafael Moreno', 'Raf');
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Owner changed to Rafael');
  await expect(row(unsent, 'Thermostat PRD')).toContainText('Rafael');
  // The picker closed: the focus is back on the row's owner.
  await expect(row(unsent, 'Thermostat PRD').getByRole('button', { name: /^Owner: Rafael/ })).toBeFocused();
  // And after sending: Confirm the trace goes to Mina, then to Rafael.
  await unsent.getByRole('checkbox', { name: 'Confirm the trace', exact: true }).check();
  await list.getByRole('button', { name: 'Send 1', exact: true }).click();
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Sent to Mina');
  const trace = row(group(list, 'Open'), 'Confirm the trace');
  await trace.getByRole('button', { name: /^Owner: Mina/ }).click();
  await pickOwner(page, 'Rafael Moreno', 'Raf');
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Owner changed to Rafael');
  await expect(trace).toContainText('Rafael');
  expect(requests('assign').map(body => body.item_id)).toEqual(['itm_00000000-0000-4000-8000-000000000032', 'itm_00000000-0000-4000-8000-000000000039']);

  // A Not sent row's page, and its meeting: back to this list, as it was, not a list of its own.
  await unsent.getByRole('checkbox', { name: 'Send the revised quote', exact: true }).check();
  const itemReads = requests('items').length;
  await row(unsent, 'Thermostat PRD').click();
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'Thermostat PRD · Pilot scope' })).toBeVisible();
  // What the page says now, and the tool's facts under it.
  await expect(item).toContainText('“starts after freeze”');
  // Once read live, the window is named as the page is, not by its kind.
  await expect(page.getByTestId('title')).toHaveText('Thermostat PRD · Pilot scope');
  await item.getByRole('button', { name: /^from Pilot planning/ }).click();
  await expect(list.getByRole('heading', { name: 'Pilot planning' })).toBeVisible();
  await expect(row(unsent, 'Thermostat PRD').locator('.follow-up-open')).toBeFocused();
  await expect(unsent.getByRole('checkbox', { name: 'Send the revised quote', exact: true })).toBeChecked();
  await expect(unsent.getByRole('checkbox', { name: 'Thermostat PRD · Pilot scope', exact: true })).not.toBeChecked();
  expect(requests('items')).toHaveLength(itemReads);
  // Dismiss moves a row to Dismissed; its page offers Send to its owner, which reopens it to them.
  await list.getByRole('button', { name: 'Dismiss 1', exact: true }).click();
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Dismissed');
  await row(group(list, 'Dismissed'), 'Send the revised quote').click();
  await expect(item.getByRole('heading', { name: 'Send the revised quote' })).toBeVisible();
  await expect(item.getByTestId('follow-up-state')).toHaveText('Dismissed');
  // A meeting's action: its line says where it came from; no section repeats it.
  await expect(item).toContainText('Meeting action · from Pilot planning');
  await expect(item.getByText('Why it\'s here')).toHaveCount(0);
  await expect(item.getByTestId('follow-up-history')).toContainText('Dismissed by you');
  await item.getByRole('button', { name: 'Send to Rafael', exact: true }).click();
  await expect(item.getByTestId('follow-up-said')).toHaveText('Sent to Rafael');
  await expect(item.getByTestId('follow-up-state')).toHaveText('Open');
  await expect(item.getByTestId('follow-up-history')).toContainText('Sent to Rafael Moreno by you');
  await expect(item.getByRole('button', { name: 'Mark done', exact: true })).toBeVisible();
  await expect(page.getByTestId('title')).toHaveText('Send the revised quote');
  // Back: the list as it is now, where it was, its row in focus.
  await page.getByTestId('back').click();
  await expect(row(group(list, 'Open'), 'Send the revised quote')).toBeVisible();
  await expect(row(group(list, 'Open'), 'Send the revised quote').locator('.follow-up-open')).toBeFocused();
  await expect(group(list, 'Dismissed')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Pilot planning');
  await page.screenshot({ path: testInfo.outputPath('follow-ups.png') });

  // The owner (Mina) marks ECHO-12 done. Ari sees it under Done in the Follow-ups page, with who did it.
  writeFileSync(join(app.home, 'mina-done'), '');
  await page.getByTestId('sidebar-follow-ups').click();
  await expect(page.getByTestId('sidebar-follow-ups')).toHaveAttribute('aria-current', 'page');
  const mine = page.getByTestId('follow-ups');
  await expect(mine.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
  // Yours keeps its closed groups closed until opened.
  await group(mine, 'Done').getByRole('button', { name: 'Done · 1' }).click();
  await row(group(mine, 'Done'), 'ECHO-12').click();
  await expect(item.getByTestId('follow-up-state')).toHaveText('Done');
  const history = item.getByTestId('follow-up-history');
  await expect(history).toContainText('Found');
  await expect(history).toContainText('Sent to Mina Patel by you');
  await expect(history).toContainText('Done by Mina Patel');
  await page.screenshot({ path: testInfo.outputPath('follow-up.png') });
  // Reopen, then Mark done and Undo it: each says what happened, in place.
  await item.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(item.getByTestId('follow-up-said')).toHaveText('Reopened');
  await expect(item.getByTestId('follow-up-state')).toHaveText('Open');
  await item.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(item.getByTestId('follow-up-said')).toHaveText('Done · Undo');
  await item.getByTestId('follow-up-said').getByRole('button', { name: 'Undo' }).click();
  await expect(item.getByTestId('follow-up-said')).toHaveText('Reopened');
  await expect(item.getByTestId('follow-up-state')).toHaveText('Open');
  expect(requests('set_state').map(body => body.state)).toEqual(['open', 'open', 'done', 'open']);
  // Back to the Follow-ups page, read again: ECHO-12 is open; then Back is Home.
  await page.getByTestId('back').click();
  await expect(row(group(mine, 'Open'), 'ECHO-12')).toBeVisible();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('needs')).toBeVisible();
});

/** Pilot planning as Ari approved it in the checked modes, and as Mina approved it in the owner modes. */
const ARI_PILOT = `Pilot planning meeting, approved ${day('2026-10-07T10:00:00.000Z')}`;
const MINA_PILOT = `Pilot planning meeting, approved ${day('2026-10-06T18:00:00.000Z')}`;

test('the owner opens a follow-up from Home and marks it done there', async () => {
  app = await launch('granola-owner');
  const { page } = app;
  const home = page.getByTestId('need-row').filter({ hasText: 'ECHO-12' });
  // Three lines: its title, what it says now against what the meeting needs, and what it is and where it came from.
  await expect(home).toHaveAttribute('data-kind', 'update');
  await expect(home).toContainText('ECHO-12 · Pilot launch');
  await expect(home).not.toContainText('doesn\'t match');
  await expect(home).toContainText('Due Oct 30 → decision needs: launch next week');
  await expect(home).toContainText(`Jira ticket · ${MINA_PILOT}`);
  // The row is one button: nothing on Home closes an item.
  await expect(home.getByRole('button')).toHaveCount(0);
  expect(app.calls().some(call => call.path === '/v1/person/meetings')).toBe(false);
  await home.click();
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'ECHO-12 · Pilot launch' })).toBeVisible();
  await expect(item.getByTestId('follow-up-state')).toHaveText('Open');
  await expect(item).toContainText(`Jira ticket · from Pilot planning, ${day('2026-10-06T18:00:00.000Z')}`);
  await expect(item.getByTestId('follow-up-history')).toContainText('Sent to you by Mina Patel');
  await expect(item.getByRole('complementary')).toContainText('You');
  // What it says now, and its tool's facts in one faint line.
  await expect(item).toContainText('“The pilot launch is planned for the end of the month.”');
  await expect(item.getByTestId('follow-up-facts')).toHaveText('In Progress · Due Oct 30 · Ari');
  await item.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(item.getByTestId('follow-up-said')).toHaveText('Done · Undo');
  await expect(item.getByTestId('follow-up-state')).toHaveText('Done');
  await expect(item.getByTestId('follow-up-history')).toContainText('Done by you');
  // Back on Home, read again: it no longer waits on Ari.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('need-row').filter({ hasText: 'ECHO-12' })).toHaveCount(0);
  expect(requests('set_state')).toEqual([expect.objectContaining({ item_id: 'itm_00000000-0000-4000-8000-000000000041', state: 'done' })]);
});

test('rows show at once from ECHO\'s own fields, and what each says fills in once its live read answers', async () => {
  // Every live read waits (as a slow Jira would) until the test lets it go.
  app = await launch('granola-owner', { 'hold-live': '' });
  const { page } = app;
  const hold = () => writeFileSync(join(app.home, 'hold-live'), '');
  const release = () => rmSync(join(app.home, 'hold-live'));
  const rows = page.getByTestId('need-row');
  // Home's rows, before any live read answered: a document named by what it is and its meeting, faintly, while ECHO reads it.
  const pilot = rows.filter({ hasText: 'Decision needs: launch next week' });
  await expect(pilot).toContainText('Jira ticket · Pilot planning');
  await expect(pilot.locator('[data-reading]')).toHaveCount(1);
  await expect(page.getByTestId('needs')).toHaveAttribute('aria-busy', 'true');
  expect(await page.content()).not.toContain('ECHO-12');
  expect(requests('home').map(body => body.read === 'rows')).toEqual(expect.arrayContaining([true, false]));
  // The live read answers: titles and what each says now fill in, in place.
  release();
  await expect(pilot).toContainText('ECHO-12 · Pilot launch');
  await expect(pilot).toContainText('Due Oct 30 → decision needs: launch next week');
  await expect(page.getByTestId('needs')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-reading]')).toHaveCount(0);

  // The item page shows its row at once, with what Home read live of it: it is read again rows only.
  hold();
  await pilot.click();
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'ECHO-12 · Pilot launch' })).toBeVisible();
  await expect(item).toContainText('“The pilot launch is planned for the end of the month.”');
  expect(requests('item').map(body => body.read)).toEqual(['rows']);
  // Its meeting's list: its rows at once, read rows only, each document faintly named until its live read answers.
  await item.getByRole('button', { name: /^from Pilot planning/ }).click();
  const list = page.getByTestId('follow-ups');
  await expect(group(list, 'Open').getByTestId('follow-up-row')).toHaveCount(2);
  await expect(group(list, 'Open').locator('[data-reading]')).toHaveCount(2);
  await expect(row(list, 'Jira ticket · Pilot planning')).toHaveCount(2);
  release();
  await expect(row(list, 'ECHO-12 · Pilot launch')).toBeVisible();
  await expect(list.locator('[data-reading]')).toHaveCount(0);

  // A change reads its rows again rows only: what each says now stays, and nothing is read live for it.
  await row(list, 'ECHO-12').click();
  await expect(item).toHaveAttribute('aria-busy', 'false');
  const live = () => app.calls().filter(call => call.path === '/v1/person/runs' && ['item', 'items'].includes(call.body?.operation as string)
    && call.body!.read === undefined).length;
  const before = live();
  hold();
  await item.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(item.getByTestId('follow-up-said')).toHaveText('Done · Undo');
  await expect(item.getByTestId('follow-up-state')).toHaveText('Done');
  await expect(item.getByRole('heading', { name: 'ECHO-12 · Pilot launch' })).toBeVisible();
  await expect(item).toContainText('“The pilot launch is planned for the end of the month.”');
  await page.getByTestId('back').click();
  await expect(row(group(list, 'Done'), 'ECHO-12 · Pilot launch')).toBeVisible();
  expect(live()).toBe(before);
  expect(requests('item').at(-1)).toMatchObject({ read: 'rows' });
  release();
});

/** Test builds record the notifications main would show: no test puts one on the machine. */
interface Notices { echoTestNotices?: { title: string; body: string; click(): void }[] }

test('a follow-up sent to you while ECHO runs comes as a notification that opens its page', async () => {
  app = await launch('granola-owner-later');
  const { page } = app;
  const notices = () => app.app.evaluate(() => ((globalThis as Notices).echoTestNotices ?? []).map(({ title, body }) => ({ title, body })));
  // Complete notification scans, independent of Home's bounded rows.
  const rowsReads = () => app.calls().filter(call => call.path === '/v1/person/runs' && call.body && notificationScan(call.body)).length;
  const homeIdle = () => expect(page.getByTestId('needs')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('need-row').filter({ hasText: 'ECHO-12' })).toBeVisible();
  // The first complete scan at sign-in only learns what already waits on Ari.
  await homeIdle();
  await expect.poll(rowsReads).toBe(1);
  // The page starts again on a clock the test moves: it learns again.
  await page.clock.install();
  await page.reload();
  await expect(page.getByTestId('need-row').filter({ hasText: 'ECHO-12' })).toBeVisible();
  await homeIdle();
  await expect.poll(rowsReads).toBe(2);
  // Mina sends Ari a ticket from a meeting Ari cannot read. Five minutes on, the next check tells of it.
  writeFileSync(join(app.home, 'mina-sends'), '');
  await page.clock.fastForward('05:00');
  await expect.poll(rowsReads).toBe(3);
  await expect.poll(notices).toEqual([{ title: 'ECHO', body: 'Mina sent you: Jira ticket' }]);
  // The quiet check starts no sweep or run.
  expect(requests('sweep')).toEqual([]);
  expect(requests('start')).toEqual([]);
  // Clicked with another app in front: its page opens over Home as ECHO comes forward.
  await emit(app.app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await app.app.evaluate(() => { (globalThis as Notices).echoTestNotices![0]!.click(); });
  await emit(app.app, 'echo-test:resume');
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'A Jira ticket you can\'t open' })).toBeVisible();
  await expect(item.getByTestId('follow-up-history')).toContainText('Sent to you by Mina Patel');
  // Its row from the check, read again rows only, then live.
  const read = { item_id: 'itm_00000000-0000-4000-8000-000000000042' };
  expect(requests('item')).toEqual([expect.objectContaining({ ...read, read: 'rows' }), expect.not.objectContaining({ read: 'rows' })]);
  expect(requests('item')[1]).toMatchObject(read);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('needs')).toBeVisible();
  // Told once: the next check finds nothing new.
  await homeIdle();
  const rows = rowsReads();
  await page.clock.fastForward('05:00');
  await homeIdle();
  await expect.poll(rowsReads).toBe(rows + 1);
  expect(await notices()).toHaveLength(1);
});

test('a reader who cannot open an item sees what it is, never what it says', async () => {
  app = await launch('granola-owner');
  const { page } = app;
  // Ari reads Pilot planning, but cannot open this ticket in Jira.
  const home = page.getByTestId('need-row').filter({ hasText: 'confirm the trace by Friday' });
  await expect(home).toContainText('A Jira ticket you can\'t open');
  await expect(home).toContainText('Decision needs: confirm the trace by Friday');
  // A meeting Ari cannot read is never named: who sent the item is.
  await expect(page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' })).toContainText('Jira ticket · sent by Mina');
  for (const withheld of WITHHELD) expect(await page.content()).not.toContain(withheld);
  await home.click();
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'A Jira ticket you can\'t open' })).toBeVisible();
  await expect(item).toContainText('You can\'t open it');
  await expect(item).toContainText('confirm the trace by Friday');
  await expect(item.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  for (const withheld of WITHHELD) expect(await page.content()).not.toContain(withheld);
  // The item's meeting opens that meeting's follow-ups, which show it the same way.
  await item.getByRole('button', { name: /^from Pilot planning/ }).click();
  const list = page.getByTestId('follow-ups');
  await expect(group(list, 'Open').getByTestId('follow-up-row')).toHaveCount(2);
  await expect(row(list, 'A Jira ticket you can\'t open')).toBeVisible();
  for (const withheld of WITHHELD) expect(await page.content()).not.toContain(withheld);
  // Back: the item page, then Home.
  await page.getByTestId('back').click();
  await expect(item.getByRole('heading', { name: 'A Jira ticket you can\'t open' })).toBeVisible();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('needs')).toBeVisible();
});

test('a Home read that fails once keeps the rows it had, and a live read that fails keeps what each row said', async () => {
  app = await launch('granola-home-fails-once');
  const rows = app.page.getByTestId('need-row');
  // Home's reads of its rows (no quiet check reads them within five minutes of sign-in), and its live reads.
  const rowsReads = () => requests('home').filter(body => body.read === 'rows').length;
  const liveReads = () => requests('home').filter(body => body.read !== 'rows').length;
  await expect(rows.filter({ hasText: 'ECHO-12 · Pilot launch' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  // Home is read again on coming forward once the project list is in.
  await expect(app.page.getByTestId('sidebar-project')).toHaveCount(2);
  // The window comes forward: Home's rows are read again, and that read fails, so nothing of it is read live.
  await emit(app.app, 'echo-test:shown');
  await expect.poll(rowsReads).toBe(2);
  await expect(app.page.getByTestId('needs')).toHaveAttribute('aria-busy', 'false');
  await expect(rows.filter({ hasText: 'ECHO-12 · Pilot launch' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(app.page.getByTestId('home-error')).toHaveCount(0);
  expect(liveReads()).toBe(1);
  // The next read brings what changed meanwhile, and its live read fails: ECHO-12 keeps what it said, and the new row says ECHO
  // couldn't read it just now.
  await emit(app.app, 'echo-test:shown');
  await expect(rows).toHaveCount(2);
  await expect.poll(liveReads).toBe(2);
  await expect(rows.filter({ hasText: 'A Jira ticket ECHO couldn\'t read just now' })).toBeVisible();
  await expect(rows.filter({ hasText: 'ECHO-12 · Pilot launch' })).toBeVisible();
  await expect(app.page.getByTestId('needs')).toHaveAttribute('aria-busy', 'false');
  await expect(app.page.getByTestId('home-error')).toHaveCount(0);
  // Read again, live: the ticket Ari cannot open says so.
  await emit(app.app, 'echo-test:shown');
  await expect(rows.filter({ hasText: 'A Jira ticket you can\'t open' })).toBeVisible();
  await expect(rows).toHaveCount(2);
});

test('an approved meeting counts its follow-ups by status, and its project counts what is open', async () => {
  app = await launch('granola');
  const { page } = app;
  await approveFromHome(app);
  await expect(page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  const line = page.getByTestId('project-line');
  // Counted by status as a meeting is (F7); never "open" for not sent and open together: two documents and the meeting's two actions.
  await expect(line).toHaveText('Follow-ups · 4 not sent');
  const meeting = page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' });
  await expect(meeting.getByTestId('item-follow-ups')).toHaveText('4 follow-ups');
  // Counting opened nothing: every items read so far asked for the project's counts only.
  const itemReads = () => requests('items').map(body => ({ scope: body.scope, counts: body.read === 'counts', ...(body.read === 'counts' ? {} : { rows: body.read === 'rows' }) }));
  expect(itemReads().every(read => read.scope === 'project' && read.counts)).toBe(true);
  await meeting.click();
  const impact = page.getByTestId('impact-line');
  await expect(impact).toHaveText('Follow-ups · 4 not sent');
  await expect(impact.getByRole('button')).toHaveCount(1);
  await impact.getByRole('button', { name: /Follow-ups/ }).click();
  const list = page.getByTestId('follow-ups');
  await expect(group(list, 'Not sent').getByTestId('follow-up-row')).toHaveCount(4);
  await expect(row(list, 'ECHO-12')).toBeVisible();
  // Every group together, rows only; then the rows that show, read live.
  expect(itemReads().filter(read => !read.counts)).toEqual([{ scope: 'record', counts: false, rows: true }, { scope: 'record', counts: false, rows: false }]);
  // Nothing is open to check until something is sent: no Check now.
  await expect(list.getByRole('button', { name: 'Check now' })).toHaveCount(0);
  expect(sweeps()).toEqual([]);
  // What a follow-up says now is covered while another app is in front, and the list comes back as it was.
  await emit(app.app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('ECHO-12');
  await emit(app.app, 'echo-test:resume');
  await expect(group(list, 'Not sent').getByTestId('follow-up-row')).toHaveCount(4);
  // Its approval opens the decision over the list, which counts them by its check; Back is the list again.
  await list.getByRole('button', { name: /^Approved / }).click();
  await expect(page.getByTestId('decision').getByTestId('impact-follow-ups')).toHaveText('Follow-ups · 4 not sent');
  await page.getByTestId('back').click();
  await expect(group(list, 'Not sent').getByTestId('follow-up-row')).toHaveCount(4);
  // Back: the meeting, its line counting by its record again, then the project, whose line opens the project's follow-ups.
  await page.getByTestId('back').click();
  await expect(impact).toHaveText('Follow-ups · 4 not sent');
  await expect(impact.getByRole('button', { name: /Follow-ups/ })).toBeVisible();
  await page.getByTestId('back').click();
  await line.getByRole('button').click();
  await expect(list.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
  await expect(list).toContainText('Thermostat redesign');
  // Spanning meetings, each row names its meeting.
  await expect(row(list, 'ECHO-12')).toContainText('Jira ticket · Pilot planning');
  expect(itemReads().filter(read => !read.counts).map(read => `${read.scope} ${read.rows ? 'rows' : 'live'}`))
    .toEqual(['record rows', 'record live', 'project rows', 'project live']);
});

test('a list reads current work first, past older closed follow-ups, each part with its own More, and keeps its place', async () => {
  app = await launch('granola-paged');
  const { page } = app;
  await page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  const line = page.getByTestId('project-line');
  await expect(line).toHaveText('Follow-ups · 5 open · 3 done');
  await line.getByRole('button').click();
  const list = page.getByTestId('follow-ups');
  const open = group(list, 'Open');
  const done = group(list, 'Done');
  // Kickoff review's three done follow-ups are the project's oldest, yet the first page (two rows here) is current work.
  await expect(open.getByTestId('follow-up-row')).toHaveCount(2);
  await expect(open.getByText('Open · 5', { exact: true })).toBeVisible();
  await expect(done).toHaveCount(0);
  await list.getByTestId('follow-ups-more').click();
  await expect(open.getByTestId('follow-up-row')).toHaveCount(4);
  await list.getByTestId('follow-ups-more').click();
  // Current work read to its end: the closed part follows, closed on a project's list ("Done · 3"), with a More of its own once open.
  await expect(open.getByTestId('follow-up-row')).toHaveCount(5);
  await expect(done.getByText('Done · 3', { exact: true })).toBeVisible();
  await expect(done.getByTestId('follow-up-row')).toHaveCount(0);
  await expect(list.getByTestId('follow-ups-more-closed')).toHaveCount(0);
  await expect(list.getByTestId('follow-ups-more')).toHaveCount(0);
  // No row is still being read live.
  await expect(list.locator('[data-reading]')).toHaveCount(0);
  // Closed rows are read only once their group opens.
  expect(listReads().filter(read => read.startsWith('done'))).toEqual([]);
  await done.getByRole('button', { name: 'Done · 3' }).click();
  await expect(done.getByTestId('follow-up-row')).toHaveCount(2);
  await expect(row(done, 'ECHO-')).toHaveCount(2);
  await list.getByTestId('follow-ups-more-closed').click();
  await expect(done.getByTestId('follow-up-row')).toHaveCount(3);
  await expect(row(done, 'ECHO-')).toHaveCount(3);
  await expect(list.locator('[data-reading]')).toHaveCount(0);
  await expect(list.getByTestId('follow-ups-more-closed')).toHaveCount(0);
  // Each page rows only, then live, one page at a time, as far as what shows: current work's (its last page holds only a meeting
  // action, never read live), then Done's on its own.
  expect(listReads().filter(read => !read.endsWith(' live'))).toEqual(['unsent+open', 'unsent+open more', 'unsent+open more', 'done', 'done more']);
  expect(listReads().filter(read => read.endsWith(' live'))).toEqual(['unsent+open live', 'unsent+open more live', 'done live', 'done more live']);
  // Scrolled to its end, a row's page and Back: the same place, and that row in focus. Another app in front changes neither.
  await app.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(900, 560); });
  const last = row(done, 'ECHO-9');
  await expect.poll(() => list.evaluate(column => column.scrollHeight > column.clientHeight)).toBe(true);
  const top = await list.evaluate(column => { column.scrollTop = column.scrollHeight; return column.scrollTop; });
  expect(top).toBeGreaterThan(0);
  await last.click();
  await expect(page.getByTestId('follow-up').getByRole('heading', { name: 'ECHO-9 · Firmware sign-off' })).toBeVisible();
  await page.getByTestId('back').click();
  await expect(last.locator('.follow-up-open')).toBeFocused();
  expect(await list.evaluate(column => column.scrollTop)).toBe(top);
  await emit(app.app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await emit(app.app, 'echo-test:resume');
  await expect(last).toBeVisible();
  expect(await list.evaluate(column => column.scrollTop)).toBe(top);
});

test('an outage is not shown as lost access', async () => {
  app = await launch('granola-owner-outage');
  // Jira did not answer for this item just now: ECHO says so, and never that Ari lost access to it.
  const outage = app.page.getByTestId('need-row').filter({ hasText: 'A Jira ticket ECHO couldn\'t read just now' });
  await expect(outage).toContainText('Decision needs: confirm the trace by Friday');
  await outage.click();
  const item = app.page.getByTestId('follow-up');
  await expect(item).toContainText('ECHO couldn\'t read it just now');
  await expect(item.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  // An item Ari truly cannot open still says so.
  await app.page.getByTestId('back').click();
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' })).toContainText('A Jira ticket you can\'t open');
  for (const withheld of WITHHELD) expect(await app.page.content()).not.toContain(withheld);
});

test('Home sweeps by itself, and the Follow-ups page lists everything you sent or own', async () => {
  app = await launch('granola-sweep');
  const { page } = app;
  const foot = page.getByTestId('needs-foot');
  // The sweep found the PRD page changed: it waits on Ari, who owns it.
  await expect(foot).toContainText('4 waiting on others · ECHO checked just now', { timeout: 20_000 });
  await expect(foot).not.toContainText('match');
  // Home asked for one sweep of Ari's own items and started it; a sweep makes no Home row of its own.
  expect(sweeps()).toEqual([{ scope: 'mine', id: undefined }]);
  expect(runOperations().indexOf('start')).toBeGreaterThan(runOperations().indexOf('sweep'));
  await expect(page.getByTestId('need-row')).toHaveCount(1);
  await foot.getByRole('button', { name: 'Follow-ups' }).click();
  const list = page.getByTestId('follow-ups');
  await expect(list.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
  // Every status, current work first; the meeting's actions first; a match says so, faintly.
  const open = group(list, 'Open');
  await expect(open.getByTestId('follow-up-row')).toHaveCount(5);
  await expect(open.getByTestId('follow-up-row').first()).toContainText('Send the revised quote');
  await expect(row(open, 'ECHO-12')).toContainText('Jira ticket · Pilot planning · matches now');
  // Current work rows only, then live: yours keeps its closed groups closed, and unread.
  expect(listReads()).toEqual(['unsent+open', 'unsent+open live']);
  expect(requests('items').filter(body => body.read !== 'counts').every(body => body.scope === 'mine')).toBe(true);
  await expect(list.getByRole('checkbox')).toHaveCount(0);
  // Back is Home, read again; no second sweep was asked for.
  await page.getByTestId('back').click();
  await expect(foot).toContainText('4 waiting on others');
  expect(sweeps()).toHaveLength(1);
});

test('every Home row opens its follow-up\'s page', async () => {
  app = await launch('granola-review');
  const { page } = app;
  const rows = page.getByTestId('need-row');
  // ECHO-12 is Mina's, sent by Ari, and changed since: a Review row (R64). Ari's own changed page stays an Update row.
  const review = rows.filter({ hasText: 'ECHO-12' });
  await expect(review).toHaveAttribute('data-kind', 'review');
  await expect(review).toContainText(`Jira ticket · ${ARI_PILOT} · Mina's to update`);
  await expect(review).not.toContainText('changed');
  const update = rows.filter({ hasText: 'Thermostat PRD' });
  await expect(update).toHaveAttribute('data-kind', 'update');
  for (const [name, owner] of [['ECHO-12 · Pilot launch', 'Mina'], ['Thermostat PRD · Pilot scope', 'You']] as const) {
    await rows.filter({ hasText: name }).click();
    const item = page.getByTestId('follow-up');
    await expect(item.getByRole('heading', { name })).toBeVisible();
    await expect(item.getByRole('complementary')).toContainText(owner);
    // ECHO's last check, in one faint line naming no one.
    await expect(item.getByTestId('follow-up-check')).toHaveText('Checked 2 h ago · changed, still doesn\'t match');
    await page.getByTestId('back').click();
    await expect(page.getByTestId('needs')).toBeVisible();
  }
  // The approver closes the item someone else owns from its page; Home, read again, no longer shows it.
  await review.click();
  await page.getByTestId('follow-up').getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(page.getByTestId('follow-up-said')).toHaveText('Done · Undo');
  await page.getByTestId('back').click();
  await expect(review).toHaveCount(0);
  expect(requests('set_state')).toEqual([expect.objectContaining({ item_id: 'itm_00000000-0000-4000-8000-000000000031', state: 'done' })]);
});

test('an owner change whose reply was lost shows the item as it is now, and holds nothing', async () => {
  app = await launch('granola-review-assign-lost');
  const { page } = app;
  await page.getByTestId('need-row').filter({ hasText: 'ECHO-12' }).click();
  const item = page.getByTestId('follow-up');
  await item.getByRole('button', { name: /^Owner: Mina/ }).click();
  // Escape closes the picker first, then the page; the focus goes back to the owner.
  await expect(page.getByTestId('owner-picker').getByRole('searchbox', { name: 'Find a person' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('owner-picker')).toHaveCount(0);
  await expect(item).toBeVisible();
  await expect(item.getByRole('button', { name: /^Owner: Mina/ })).toBeFocused();
  await item.getByRole('button', { name: /^Owner: Mina/ }).click();
  await pickOwner(page, 'Rafael Moreno', 'Raf');
  // The reply was lost, but the change was made: the item, read again, says so.
  await expect(item.getByTestId('follow-up-said')).toHaveText('Owner changed to Rafael');
  await expect(item.getByRole('complementary')).toContainText('Rafael');
  await expect(item.getByTestId('follow-up-history')).toContainText('Owner set to Rafael Moreno by you');
  expect(requests('assign')).toHaveLength(1);
  expect(requests('item').map(body => body.item_id).at(-1)).toBe('itm_00000000-0000-4000-8000-000000000031');
});

test('Check now on a meeting checks only that meeting, and its list says what matches', async () => {
  app = await launch('granola-checked');
  const { page } = app;
  await page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  await page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' }).click();
  const impact = page.getByTestId('impact-line');
  // A check's verdict never takes an item out of a count (F7).
  await expect(impact).toHaveText('Follow-ups · 5 open');
  await impact.getByRole('button').click();
  const list = page.getByTestId('follow-ups');
  const check = list.getByRole('button', { name: 'Check now' });
  // The faint link the canvas draws (H6).
  await expect(check).toHaveCSS('color', 'rgba(240, 236, 230, 0.5)');
  await check.click();
  await expect(list).toContainText('Checking…');
  await expect(list.getByRole('button', { name: 'Check now' })).toBeVisible({ timeout: 20_000 });
  expect(sweeps()).toEqual([{ scope: 'record', id: PILOT_RECORD }]);
  await expect(row(list, 'ECHO-12')).toContainText('matches now');
  await expect(row(list, 'Thermostat PRD')).not.toContainText('matches now');
  // The page Ari cannot open is never named.
  expect(await page.content()).not.toContain('Supplier brief');
});

test('Check now on a project checks its follow-ups, and its line counts each meeting\'s', async () => {
  app = await launch('granola-checked');
  const { page } = app;
  await page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  // Pilot planning's five open follow-ups and Kickoff review's three.
  await expect(page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' }).getByTestId('item-follow-ups')).toHaveText('5 follow-ups');
  await expect(page.getByTestId('feed-row').filter({ hasText: 'Kickoff review' }).getByTestId('item-follow-ups')).toHaveText('3 follow-ups');
  const line = page.getByTestId('project-line');
  await expect(line).toHaveText('Follow-ups · 8 open');
  await line.getByRole('button').click();
  const list = page.getByTestId('follow-ups');
  await list.getByRole('button', { name: 'Check now' }).click();
  await expect(list.getByRole('button', { name: 'Check now' })).toBeVisible({ timeout: 20_000 });
  expect(sweeps()).toEqual([{ scope: 'project', id: THERMOSTAT }]);
  await expect(row(list, 'ECHO-12')).toContainText('Jira ticket · Pilot planning · matches now');
  await expect(row(list, 'ECHO-7')).toContainText('Jira ticket · Kickoff review');
  await page.getByTestId('back').click();
  await expect(line).toHaveText('Follow-ups · 8 open');
});

test('a meeting\'s list names apart follow-ups whose titles nothing tells apart', async () => {
  app = await launch('granola-alike');
  await app.page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' }).click();
  const list = app.page.getByTestId('follow-ups');
  await expect(list.getByRole('checkbox')).toHaveCount(8);
  // ECHO matched no one for the four alike items and the PRD page.
  await expect(list.getByRole('button', { name: /^Pick owner: / })).toHaveCount(5);
  // Two pages Ari cannot open, with the same expected phrase, and two tickets ECHO couldn't read just now, with none.
  for (const name of [
    'A page you can\'t open → parts ordered for next week (1)', 'A page you can\'t open → parts ordered for next week (2)',
    'A Jira ticket ECHO couldn\'t read just now (1)', 'A Jira ticket ECHO couldn\'t read just now (2)',
  ]) {
    await expect(list.getByRole('checkbox', { name, exact: true })).toBeChecked();
    await expect(list.getByRole('button', { name: `Pick owner: ${name}`, exact: true })).toBeVisible();
  }
  for (const withheld of ['Supplier brief', 'ECHO-41', 'ECHO-42']) expect(await app.page.content()).not.toContain(withheld);
  // Picking yourself claims an item that only fell back to you: Pick owner gives way to you.
  await list.getByRole('button', { name: 'Pick owner: A Jira ticket ECHO couldn\'t read just now (1)', exact: true }).click();
  await pickOwner(app.page, 'You');
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Owner changed to you');
  await expect(list.getByRole('button', { name: /^Pick owner: / })).toHaveCount(4);
  await expect(list.getByRole('button', { name: 'Owner: You. Change owner of A Jira ticket ECHO couldn\'t read just now (1)', exact: true })).toBeVisible();
  expect(requests('assign')).toEqual([expect.objectContaining({ item_id: 'itm_00000000-0000-4000-8000-000000000036', owner_membership_id: 'mem_22222222-2222-4222-8222-222222222222' })]);
});

test('Home starts its sweep again when an attempt goes back to the queue', async () => {
  app = await launch('granola-sweep-requeued');
  // One sweep, asked for once and started twice: the attempt that went back to the queue, then the one that finished.
  await expect.poll(() => runOperations().filter(operation => operation === 'start').length, { timeout: 30_000 }).toBe(2);
  await expect(app.page.getByTestId('needs-foot')).toContainText('ECHO checked just now', { timeout: 30_000 });
  expect(sweeps()).toEqual([{ scope: 'mine', id: undefined }]);
});

test('an empty Home with no projects still leads to the Follow-ups page', async () => {
  app = await launch('no-projects');
  const { page } = app;
  const empty = page.getByTestId('home-empty');
  await expect(empty.getByTestId('empty-new-project')).toBeVisible();
  await empty.getByTestId('your-follow-ups').click();
  const list = page.getByTestId('follow-ups');
  await expect(list.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
  await expect(list).toContainText('No follow-ups');
  await expect(page.getByTestId('title')).toHaveText('Follow-ups');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('home-empty')).toBeVisible();
});
