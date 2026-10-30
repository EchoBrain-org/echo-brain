import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approveFromHome, clickNotice, emit, launch, notices, type Launched } from './launch.js';

let app: Launched;
test.afterEach(async () => { await app?.close(); });

const runOperations = () => app.calls().filter(call => call.path === '/v1/person/runs').map(call => call.body?.operation);
/** The change check's reads of the follow-ups Ari is involved in: open ones, and those closed since (desktop refresh and notifications v1). */
const notificationScan = (body: Record<string, unknown>) => body.operation === 'items' && (body.scope === 'involved' || body.scope === 'mine') && body.read === 'rows'
  && ((body.states as string[] | undefined)?.join() === 'open' || body.changed_since !== undefined);
/** Foreground runs requests; notification discovery is checked independently. */
const requests = (operation: string) => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === operation && !notificationScan(call.body)).map(call => call.body!);
/** The sweeps the app asked for, by scope. */
const sweeps = () => requests('sweep').map(body => ({ scope: body.scope, id: body.id }));
/** The fixture's Pilot planning record, and the project it was approved into. */
const PILOT_RECORD = `sha256:${createHash('sha256').update('record:Pilot planning').digest('hex')}`;
const THERMOSTAT = 'prj_11111111-1111-4111-8111-111111111111';
/** A day as the app writes it ("Oct 7"), in this computer's time zone, as the app's is. */
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** A list's rows of one status, wherever they show: current work in one list, a closed status in its fold. */
const ofState = (list: Locator, status: 'unsent' | 'open' | 'done' | 'not_relevant') => list.locator(`[data-testid="follow-up-row"][data-state="${status}"]`);
/** A closed status's fold at the end of a list. */
const fold = (list: Locator, status: 'Done' | 'Dismissed') => list.getByRole('region', { name: status, exact: true });
const row = (scope: Locator, text: string) => scope.getByTestId('follow-up-row').filter({ hasText: text });
/** One of these rows, by its text. */
const rowOf = (rows: Locator, text: string) => rows.filter({ hasText: text });
/** A list's owner line: its buttons' names, in order. */
const owners = (list: Locator) => list.getByRole('group', { name: 'Show follow-ups by owner' }).getByRole('button')
  .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));

/** Picks a person under an owner chip that is open. */
async function pickOwner(page: Page, name: string, query?: string) {
  const picker = page.getByTestId('owner-picker');
  if (query !== undefined) await picker.getByRole('searchbox', { name: 'Find a person' }).fill(query);
  await picker.getByRole('option', { name, exact: true }).click();
}

test('a meeting\'s follow-ups go to their owners from one list, and come back done', async ({}, testInfo) => {
  app = await launch('granola');
  const { page } = app;
  await approveFromHome(app.page);
  // The check runs by itself; its Send row opens the meeting's follow-ups.
  const send = page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' });
  await expect(send).toContainText('Launch the pilot next week — 4 follow-ups to send', { timeout: 20_000 });
  await expect(send).toContainText('owners Mina, Rafael');
  await send.click();
  const list = page.getByTestId('follow-ups');
  await expect(list.getByRole('heading', { name: 'Pilot planning' })).toBeVisible();
  // How far its follow-ups have come: none sent yet, of four.
  await expect(list).toContainText(`Approved ${day('2026-10-07T10:00:00.000Z')} · 0 of 4 sent · 0 done`);
  // One list of what is not done yet, each found weeks ago so each needs attention, longest waiting first (here, as found); its
  // owners above it, counted by what they hold open; every row ticked, as one click sends them all.
  const unsent = ofState(list, 'unsent');
  await expect(unsent).toHaveText([/^ECHO-12 · Pilot launch/, /^Thermostat PRD · Pilot scope/, /^Send the revised quote/, /^Confirm the trace/]);
  expect(await owners(list)).toEqual(['Every owner', 'Mina Patel, 0 open', 'Rafael Moreno, 0 open', 'No owner, 1']);
  for (const name of ['Send the revised quote', 'Confirm the trace', 'ECHO-12 · Pilot launch', 'Thermostat PRD · Pilot scope']) {
    await expect(list.getByRole('checkbox', { name, exact: true })).toBeChecked();
  }
  await expect(rowOf(unsent, 'Send the revised quote')).toContainText('Rafael');
  await expect(rowOf(unsent, 'Confirm the trace')).toContainText('Mina');
  // Not sent: the owner steps back, as the dashed mark does; each over a week old, solid orange.
  await expect(rowOf(unsent, 'Confirm the trace').locator('.follow-up-owner')).toHaveClass(/later/);
  await expect(rowOf(unsent, 'Confirm the trace').locator('.follow-up-state')).toHaveAttribute('data-tone', 'late');
  // What it is and where it came from are its hover.
  await expect(rowOf(unsent, 'ECHO-12')).toHaveAttribute('title', 'Jira ticket · from Pilot planning · For Mina, not sent yet');
  // ECHO matched no one for the PRD page: Pick owner.
  await expect(rowOf(unsent, 'Thermostat PRD').getByRole('button', { name: 'Pick owner: Thermostat PRD · Pilot scope' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Send 4', exact: true })).toBeVisible();

  // Untick all but ECHO-12, and send it: it is Open with its owner, the rest still Not sent, and the list stays.
  for (const name of ['Send the revised quote', 'Confirm the trace', 'Thermostat PRD · Pilot scope']) await list.getByRole('checkbox', { name, exact: true }).uncheck();
  await list.getByRole('button', { name: 'Send 1', exact: true }).click();
  // The foot says what happened, and takes the focus from the button that went.
  const said = list.getByTestId('follow-ups-said');
  await expect(said).toHaveText('Sent to Mina');
  await expect(said).toBeFocused();
  await expect(rowOf(ofState(list, 'open'), 'ECHO-12')).toContainText('Mina');
  await expect(unsent).toHaveCount(3);
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(0);
  expect(requests('send').map(body => body.items)).toEqual([[{ item_id: 'itm_00000000-0000-4000-8000-000000000031', include: true }]]);

  // An owner changed in place before sending: the PRD page goes to Rafael at once, still Not sent.
  await rowOf(unsent, 'Thermostat PRD').getByRole('button', { name: 'Pick owner: Thermostat PRD · Pilot scope' }).click();
  await expect(page.getByTestId('owner-picker').getByRole('option').first()).toHaveAccessibleName('You');
  await pickOwner(page, 'Rafael Moreno', 'Raf');
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Owner changed to Rafael');
  await expect(rowOf(unsent, 'Thermostat PRD')).toContainText('Rafael');
  // The picker closed: the focus is back on the row's owner.
  await expect(rowOf(unsent, 'Thermostat PRD').getByRole('button', { name: /^Owner: Rafael/ })).toBeFocused();
  // And after sending: Confirm the trace goes to Mina, then to Rafael.
  await list.getByRole('checkbox', { name: 'Confirm the trace', exact: true }).check();
  await list.getByRole('button', { name: 'Send 1', exact: true }).click();
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Sent to Mina');
  const trace = rowOf(ofState(list, 'open'), 'Confirm the trace');
  await trace.getByRole('button', { name: /^Owner: Mina/ }).click();
  await pickOwner(page, 'Rafael Moreno', 'Raf');
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Owner changed to Rafael');
  await expect(trace).toContainText('Rafael');
  expect(requests('assign').map(body => body.item_id)).toEqual(['itm_00000000-0000-4000-8000-000000000032', 'itm_00000000-0000-4000-8000-000000000039']);

  // A Not sent row's page, and its meeting: back to this list, as it was, not a list of its own.
  await list.getByRole('checkbox', { name: 'Send the revised quote', exact: true }).check();
  await rowOf(unsent, 'Thermostat PRD').locator('.follow-up-open').click();
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'Thermostat PRD · Pilot scope' })).toBeVisible();
  // What the page says now, and the tool's facts under it.
  await expect(item).toContainText('“starts after freeze”');
  // Once read live, the window is named as the page is, not by its kind.
  await expect(page.getByTestId('title')).toHaveText('Thermostat PRD · Pilot scope');
  await item.getByRole('button', { name: /^from Pilot planning/ }).click();
  await expect(list.getByRole('heading', { name: 'Pilot planning' })).toBeVisible();
  await expect(rowOf(unsent, 'Thermostat PRD').locator('.follow-up-open')).toBeFocused();
  await expect(list.getByRole('checkbox', { name: 'Send the revised quote', exact: true })).toBeChecked();
  await expect(list.getByRole('checkbox', { name: 'Thermostat PRD · Pilot scope', exact: true })).not.toBeChecked();
  // Dismiss moves a row to Dismissed, folded at the end (a meeting's starts open); its page offers Send to its owner, which reopens it to them.
  await list.getByRole('button', { name: 'Dismiss 1', exact: true }).click();
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Dismissed');
  await expect(fold(list, 'Dismissed').getByRole('button', { name: 'Dismissed · 1' })).toHaveAttribute('aria-expanded', 'true');
  await row(fold(list, 'Dismissed'), 'Send the revised quote').locator('.follow-up-open').click();
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
  await expect(rowOf(ofState(list, 'open'), 'Send the revised quote')).toBeVisible();
  await expect(rowOf(ofState(list, 'open'), 'Send the revised quote').locator('.follow-up-open')).toBeFocused();
  await expect(fold(list, 'Dismissed')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Pilot planning');
  await page.screenshot({ path: testInfo.outputPath('follow-ups.png') });

  // The owner (Mina) marks ECHO-12 done. Ari sees it under Done in the Follow-ups page, with who did it.
  writeFileSync(join(app.home, 'mina-done'), '');
  await page.getByTestId('sidebar-follow-ups').click();
  await expect(page.getByTestId('sidebar-follow-ups')).toHaveAttribute('aria-current', 'page');
  const mine = page.getByTestId('follow-ups');
  await expect(page.getByTestId('title')).toHaveText('Follow-ups');
  // Yours keeps its closed statuses folded until opened.
  await expect(fold(mine, 'Done').getByRole('button', { name: 'Done · 1' })).toHaveAttribute('aria-expanded', 'false');
  await fold(mine, 'Done').getByRole('button', { name: 'Done · 1' }).click();
  await expect(row(fold(mine, 'Done'), 'ECHO-12').locator('.follow-up-state')).toHaveAttribute('data-mark', 'done');
  await row(fold(mine, 'Done'), 'ECHO-12').locator('.follow-up-open').click();
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
  await expect(rowOf(ofState(mine, 'open'), 'ECHO-12')).toBeVisible();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('needs')).toBeVisible();
});

test('a meeting\'s list shows one owner\'s follow-ups at a time, and Send sends only the ticked ones it shows', async () => {
  app = await launch('granola');
  const { page } = app;
  await approveFromHome(app.page);
  const send = page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' });
  await expect(send).toBeVisible({ timeout: 20_000 });
  await send.click();
  const list = page.getByTestId('follow-ups');
  const rows = list.getByTestId('follow-up-row');
  const line = list.getByRole('group', { name: 'Show follow-ups by owner' });
  await expect(rows).toHaveCount(4);
  await expect(list.getByRole('button', { name: 'Send 4', exact: true })).toBeVisible();
  // Mina's only: Rafael's and the PRD page's ticks go with them, so Send counts and sends only hers.
  await line.getByRole('button', { name: /^Mina Patel, / }).click();
  await expect(rows).toHaveText([/^ECHO-12 · Pilot launch/, /^Confirm the trace/]);
  await list.getByRole('button', { name: 'Send 2', exact: true }).click();
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Sent 2 to Mina');
  expect(requests('send').map(body => body.items)).toEqual([[
    { item_id: 'itm_00000000-0000-4000-8000-000000000031', include: true }, { item_id: 'itm_00000000-0000-4000-8000-000000000039', include: true },
  ]]);
  // Still hers, now open, and counted on her face.
  await expect(line.getByRole('button', { name: 'Mina Patel, 2 open' })).toHaveAttribute('aria-pressed', 'true');
  // Everyone's again: the other two are still not sent, and nothing came back ticked.
  await line.getByRole('button', { name: 'Every owner' }).click();
  await expect(ofState(list, 'unsent')).toHaveText([/^Thermostat PRD · Pilot scope/, /^Send the revised quote/]);
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(0);
  // No owner: the PRD page alone, whose Pick owner still works. Rafael's now, No owner holds nothing: everyone's again.
  await line.getByRole('button', { name: 'No owner, 1' }).click();
  await expect(rows).toHaveCount(1);
  await rowOf(rows, 'Thermostat PRD').getByRole('button', { name: 'Pick owner: Thermostat PRD · Pilot scope' }).click();
  await pickOwner(page, 'Rafael Moreno', 'Raf');
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Owner changed to Rafael');
  await expect(rows).toHaveCount(4);
  await expect(line.getByRole('button', { name: 'Every owner' })).toHaveAttribute('aria-pressed', 'true');
  await expect(line.getByRole('button', { name: 'No owner, 1' })).toHaveCount(0);
  await expect(rowOf(rows, 'Thermostat PRD').getByRole('button', { name: /^Owner: Rafael/ })).toBeFocused();
});

test('the Follow-ups page shows who owns what, keeps one owner\'s rows through a row\'s page and Back, and says when ECHO last checked', async ({}, testInfo) => {
  app = await launch('granola-checked');
  const { page } = app;
  // Home read what waits on you, and when ECHO last checked.
  await expect(page.getByTestId('need-row').first()).toBeVisible();
  await page.getByTestId('sidebar-follow-ups').click();
  const list = page.getByTestId('follow-ups');
  const rows = list.getByTestId('follow-up-row');
  const line = list.getByRole('group', { name: 'Show follow-ups by owner' });
  // No heading on the page: the title row names it, and a screen reader still hears one.
  await expect(page.getByTestId('title')).toHaveText('Follow-ups');
  await expect(list.locator('.follow-ups-head')).toHaveClass(/sr-only/);
  await expect(rows).toHaveCount(5);
  // Who owns what Ari sent: Ari, Mina and Rafael, each counted by what they hold open; each waited weeks, so each needs
  // attention, and they go by name.
  expect(await owners(list)).toEqual(['Every owner', 'You, 1 open', 'Mina Patel, 2 open', 'Rafael Moreno, 2 open']);
  await expect(line.getByRole('button', { name: 'Every owner' })).toHaveAttribute('aria-pressed', 'true');
  // A row: its mark (open for weeks, solid orange), its owner, its project's tile, how long it waited; the rest on hover.
  const echo12 = rowOf(rows, 'ECHO-12');
  await expect(echo12.locator('.follow-up-state')).toHaveAttribute('data-tone', 'late');
  await expect(echo12.locator('.follow-up-owner')).toHaveText(/Mina$/);
  await expect(echo12.locator('.follow-up-tile')).toHaveAttribute('title', 'Thermostat redesign');
  await expect(echo12.locator('.follow-up-age')).toHaveText(/^\d+d$/);
  await expect(echo12).toHaveAttribute('title', /^Jira ticket · from Pilot planning · Sent to Mina \d+ days ago · matches now$/);
  // When ECHO last checked one of yours, faint, under the list.
  await expect(list.getByTestId('follow-ups-checked')).toHaveText('ECHO checked 2 h ago');
  await page.screenshot({ path: testInfo.outputPath('follow-ups-page.png') });
  // Mina's only: her two. A row's page and Back keep the filter, and that row has the focus.
  await line.getByRole('button', { name: 'Mina Patel, 2 open' }).click();
  await expect(rows).toHaveText([/^ECHO-12 · Pilot launch/, /^Confirm the trace/]);
  await rowOf(rows, 'Confirm the trace').locator('.follow-up-open').click();
  await expect(page.getByTestId('follow-up').getByRole('heading', { name: 'Confirm the trace' })).toBeVisible();
  await page.getByTestId('back').click();
  await expect(rows).toHaveText([/^ECHO-12 · Pilot launch/, /^Confirm the trace/]);
  await expect(line.getByRole('button', { name: 'Mina Patel, 2 open' })).toHaveAttribute('aria-pressed', 'true');
  await expect(rowOf(rows, 'Confirm the trace').locator('.follow-up-open')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('follow-ups-filtered.png') });
  // Her face again: everyone's.
  await line.getByRole('button', { name: 'Mina Patel, 2 open' }).click();
  await expect(rows).toHaveCount(5);
  // Opened afresh from the sidebar, the page shows everyone's.
  await line.getByRole('button', { name: 'Rafael Moreno, 2 open' }).click();
  await expect(rows).toHaveCount(2);
  await page.getByTestId('sidebar-follow-ups').click();
  await expect(rows).toHaveCount(5);
  await expect(line.getByRole('button', { name: 'Every owner' })).toHaveAttribute('aria-pressed', 'true');
});

/** Pilot planning as Ari approved it in the checked modes. */
const ARI_PILOT = `Pilot planning meeting, approved ${day('2026-10-07T10:00:00.000Z')}`;

test('rows show at once from ECHO\'s own fields, and what each says fills in once its live read answers', async () => {
  // Every live read waits (as a slow Jira would) until the test lets it go.
  app = await launch('granola-owner', { 'hold-live': '' });
  const { page } = app;
  const rows = page.getByTestId('need-row');
  // Home's rows, before any live read answered: a document named by what it is and its meeting, faintly, while ECHO reads it.
  const pilot = rows.filter({ hasText: 'Needs: launch next week' });
  await expect(pilot).toContainText('Jira ticket · Pilot planning');
  await expect(pilot.locator('[data-reading]')).toHaveCount(1);
  await expect(page.getByTestId('needs')).toHaveAttribute('aria-busy', 'true');
  expect(await page.content()).not.toContain('ECHO-12');
  expect(requests('home').map(body => body.read === 'rows')).toEqual(expect.arrayContaining([true, false]));
  // The live read answers: titles and what each says now fill in, in place.
  rmSync(join(app.home, 'hold-live'));
  await expect(pilot).toContainText('ECHO-12 · Pilot launch');
  await expect(pilot).toContainText('Needs: launch next week · Now: In Progress, due Oct 30');
  await expect(page.getByTestId('needs')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-reading]')).toHaveCount(0);
});

test('a follow-up sent to you while ECHO runs comes as a notification within one check, and opens its page', async () => {
  app = await launch('granola-owner-later');
  const { page } = app;
  const changes = () => app.calls().filter(call => call.path === '/v1/person/changes').length;
  const scans = () => app.calls().filter(call => call.path === '/v1/person/runs' && call.body && notificationScan(call.body)).map(call => call.body!.scope);
  await expect(page.getByTestId('need-row').filter({ hasText: 'ECHO-12' })).toBeVisible();
  // The first check at sign-in only learns what already involves Ari.
  // Its open follow-ups, and those closed since just before it started.
  await expect.poll(scans).toEqual(['involved', 'involved']);
  expect(await notices(app)).toEqual([]);
  // Mina sends Ari a ticket from a meeting Ari cannot read; the window stays as it is. The next check (a wake's) tells of it.
  const before = changes();
  writeFileSync(join(app.home, 'mina-sends'), '');
  await emit(app.app, 'echo-test:wake');
  await expect.poll(() => notices(app)).toEqual([
    { title: 'ECHO', body: 'Mina handed you Jira ticket', target: { kind: 'item', item_id: 'itm_00000000-0000-4000-8000-000000000042' } },
  ]);
  expect(changes()).toBe(before + 1);
  // Home showed, so it was read again: the new row is there with no click.
  await expect(page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' })).toBeVisible();
  // The check starts no sweep or run.
  expect(requests('sweep')).toEqual([]);
  expect(requests('start')).toEqual([]);
  // Clicked with another app in front: its page opens over Home as ECHO comes forward.
  await emit(app.app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await clickNotice(app, 0);
  await emit(app.app, 'echo-test:resume');
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'A Jira ticket you can\'t open' })).toBeVisible();
  await expect(item.getByTestId('follow-up-history')).toContainText('Sent to you by Mina Patel');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('needs')).toBeVisible();
  // Told once: the checks after it find nothing new.
  const checked = changes();
  await emit(app.app, 'echo-test:wake');
  await expect.poll(changes).toBeGreaterThan(checked);
  expect(await notices(app)).toHaveLength(1);
});

test('the person who sent a follow-up is told when its owner marks it done', async () => {
  app = await launch('granola-checked');
  const { page } = app;
  await expect(page.getByTestId('needs-foot')).toBeVisible();
  await expect.poll(() => app.calls().filter(call => call.path === '/v1/person/runs' && call.body && notificationScan(call.body)).length).toBe(2);
  // Mina marks done the two Ari sent her, ECHO-12 and "Confirm the trace": one notification for that check, counting them.
  writeFileSync(join(app.home, 'mina-done'), '');
  await emit(app.app, 'echo-test:wake');
  const counted = ['itm_00000000-0000-4000-8000-000000000031', 'itm_00000000-0000-4000-8000-000000000039'];
  await expect.poll(() => notices(app)).toEqual([{ title: 'ECHO', body: '2 follow-ups changed', target: { kind: 'items', item_ids: counted } }]);
  // Each left the open follow-ups Ari is involved in, and the read of those closed since settled it: none was read by its id.
  const itemReads = () => requests('item').map(body => body.item_id);
  expect(itemReads()).toEqual([]);
  // Clicked: a list of exactly those two, each read by its id, as Ari may see them now.
  await clickNotice(app, 0);
  const list = app.page.getByTestId('follow-ups');
  await expect(list.getByRole('heading', { name: 'Changed follow-ups' })).toBeVisible();
  await expect(fold(list, 'Done').getByTestId('follow-up-row')).toHaveCount(2);
  await expect(list.getByTestId('follow-up-row')).toHaveCount(2);
  expect(new Set(itemReads())).toEqual(new Set(counted));
});

test('a reader who cannot open an item sees what it is, never what it says', async () => {
  app = await launch('granola-owner');
  const { page } = app;
  // Ari reads Pilot planning, but cannot open this ticket in Jira.
  const home = page.getByTestId('need-row').filter({ hasText: 'confirm the trace by Friday' });
  await expect(home).toContainText('A Jira ticket you can\'t open');
  await expect(home).toContainText('Needs: confirm the trace by Friday');
  // A meeting Ari cannot read is never named: the row says what the decision needs; who sent it is on its page.
  const vendor = page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' });
  await expect(vendor).toContainText('Needs: order six weeks ahead');
  await expect(vendor).not.toContainText('Vendor review');
  await home.click();
  const item = page.getByTestId('follow-up');
  await expect(item.getByRole('heading', { name: 'A Jira ticket you can\'t open' })).toBeVisible();
  await expect(item).toContainText('You can\'t open it');
  await expect(item).toContainText('confirm the trace by Friday');
  await expect(item.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  // The item's meeting opens that meeting's follow-ups, which show it the same way.
  await item.getByRole('button', { name: /^from Pilot planning/ }).click();
  const list = page.getByTestId('follow-ups');
  await expect(ofState(list, 'open')).toHaveCount(2);
  await expect(row(list, 'A Jira ticket you can\'t open')).toBeVisible();
  // Back: the item page, then Home.
  await page.getByTestId('back').click();
  await expect(item.getByRole('heading', { name: 'A Jira ticket you can\'t open' })).toBeVisible();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('needs')).toBeVisible();
});

test('an approved meeting counts its follow-ups by status, and its project counts what is open', async () => {
  app = await launch('granola');
  const { page } = app;
  await approveFromHome(app.page);
  await expect(page.getByTestId('need-row').filter({ hasText: 'follow-ups to send' })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  const line = page.getByTestId('project-line');
  // Counted by status as a meeting is (F7); never "open" for not sent and open together: two documents and the meeting's two actions.
  await expect(line).toHaveText('Follow-ups · 4 not sent');
  const meeting = page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' });
  await expect(meeting.getByTestId('item-follow-ups')).toHaveText('4 follow-ups');
  await meeting.click();
  const impact = page.getByTestId('impact-line');
  await expect(impact).toHaveText('Follow-ups · 4 not sent');
  await expect(impact.getByRole('button')).toHaveCount(1);
  await impact.getByRole('button', { name: /Follow-ups/ }).click();
  const list = page.getByTestId('follow-ups');
  await expect(ofState(list, 'unsent')).toHaveCount(4);
  await expect(row(list, 'ECHO-12')).toBeVisible();
  // Nothing is open to check until something is sent: no Check now.
  await expect(list.getByRole('button', { name: 'Check now' })).toHaveCount(0);
  expect(sweeps()).toEqual([]);
  // What a follow-up says now is covered while another app is in front, and the list comes back as it was.
  await emit(app.app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('ECHO-12');
  await emit(app.app, 'echo-test:resume');
  await expect(ofState(list, 'unsent')).toHaveCount(4);
  // Its approval opens the decision over the list, which counts them by its check; Back is the list again.
  await list.getByRole('button', { name: /^Approved / }).click();
  await expect(page.getByTestId('decision').getByTestId('impact-follow-ups')).toHaveText('Follow-ups · 4 not sent');
  await page.getByTestId('back').click();
  await expect(ofState(list, 'unsent')).toHaveCount(4);
  // Back: the meeting, its line counting by its record again, then the project, whose line opens the project's follow-ups.
  await page.getByTestId('back').click();
  await expect(impact).toHaveText('Follow-ups · 4 not sent');
  await expect(impact.getByRole('button', { name: /Follow-ups/ })).toBeVisible();
  await page.getByTestId('back').click();
  await line.getByRole('button').click();
  await expect(list.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
  await expect(list).toContainText('Thermostat redesign');
  // Each row names its meeting on hover, and shows its project's tile.
  await expect(row(list, 'ECHO-12')).toHaveAttribute('title', /^Jira ticket · from Pilot planning · /);
  await expect(row(list, 'ECHO-12').locator('.follow-up-tile')).toHaveAttribute('title', 'Thermostat redesign');
});

test('a list reads current work first, past older closed follow-ups, each part with its own More, and keeps its place', async () => {
  app = await launch('granola-paged');
  const { page } = app;
  await page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  const line = page.getByTestId('project-line');
  await expect(line).toHaveText('Follow-ups · 5 open · 3 done');
  await line.getByRole('button').click();
  const list = page.getByTestId('follow-ups');
  const open = ofState(list, 'open');
  const done = fold(list, 'Done');
  // Kickoff review's three done follow-ups are the project's oldest, yet the first page (two rows here) is current work.
  await expect(open).toHaveCount(2);
  await expect(done).toHaveCount(0);
  await list.getByTestId('follow-ups-more').click();
  await expect(open).toHaveCount(4);
  await list.getByTestId('follow-ups-more').click();
  // Current work read to its end: the closed part follows, folded on a project's list ("Done 3"), with a More of its own once open.
  await expect(open).toHaveCount(5);
  await expect(done.getByRole('button', { name: 'Done · 3', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(done.getByTestId('follow-up-row')).toHaveCount(0);
  await expect(list.getByTestId('follow-ups-more-closed')).toHaveCount(0);
  await expect(list.getByTestId('follow-ups-more')).toHaveCount(0);
  // No row is still being read live.
  await expect(list.locator('[data-reading]')).toHaveCount(0);
  await done.getByRole('button', { name: 'Done · 3' }).click();
  await expect(done.getByTestId('follow-up-row')).toHaveCount(2);
  await expect(row(done, 'ECHO-')).toHaveCount(2);
  await list.getByTestId('follow-ups-more-closed').click();
  await expect(done.getByTestId('follow-up-row')).toHaveCount(3);
  await expect(row(done, 'ECHO-')).toHaveCount(3);
  await expect(list.locator('[data-reading]')).toHaveCount(0);
  await expect(list.getByTestId('follow-ups-more-closed')).toHaveCount(0);
  // Scrolled to its end, a row's page and Back: the same place, and that row in focus. Another app in front changes neither.
  await app.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(900, 560); });
  const last = row(done, 'ECHO-9');
  await expect.poll(() => list.evaluate(column => column.scrollHeight > column.clientHeight)).toBe(true);
  const top = await list.evaluate(column => { column.scrollTop = column.scrollHeight; return column.scrollTop; });
  expect(top).toBeGreaterThan(0);
  await last.locator('.follow-up-open').click();
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

test('Home sweeps by itself, and the Follow-ups page lists everything you sent or own', async () => {
  app = await launch('granola-sweep');
  const { page } = app;
  const foot = page.getByTestId('needs-foot');
  // The sweep found the PRD page changed: it waits on Ari, who owns it.
  await expect(foot).toContainText('4 waiting on others · Only me · ECHO checked just now', { timeout: 20_000 });
  await expect(foot).not.toContainText('match');
  // Home asked for one sweep of Ari's own items and started it; a sweep makes no Home row of its own.
  expect(sweeps()).toEqual([{ scope: 'mine', id: undefined }]);
  expect(runOperations().indexOf('start')).toBeGreaterThan(runOperations().indexOf('sweep'));
  await expect(page.getByTestId('need-row')).toHaveCount(1);
  // The footer's first link is named for what waits on others, and opens Follow-ups.
  await foot.getByRole('button', { name: '4 waiting on others', exact: true }).click();
  const list = page.getByTestId('follow-ups');
  await expect(page.getByTestId('title')).toHaveText('Follow-ups');
  // Current work as one list, longest waiting first (each sent at once, so as found); a match says so on hover.
  const open = ofState(list, 'open');
  await expect(open).toHaveCount(5);
  await expect(open.first()).toContainText('ECHO-12');
  await expect(rowOf(open, 'ECHO-12')).toHaveAttribute('title', /^Jira ticket · from Pilot planning · Sent to Mina .+ · matches now$/);
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
  await expect(review).toContainText('Needs: launch next week · Now: In Progress, due Oct 30 · Mina\'s to update');
  // Where it came from is on its page, not on Home's row.
  await expect(review).not.toContainText(ARI_PILOT);
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

test('Check now on a meeting checks only that meeting, and on a project its follow-ups; each list says what matches', async () => {
  app = await launch('granola-checked');
  const { page } = app;
  await page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  // Pilot planning's five open follow-ups and Kickoff review's three.
  await expect(page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' }).getByTestId('item-follow-ups')).toHaveText('5 follow-ups');
  await expect(page.getByTestId('feed-row').filter({ hasText: 'Kickoff review' }).getByTestId('item-follow-ups')).toHaveText('3 follow-ups');
  const line = page.getByTestId('project-line');
  await expect(line).toHaveText('Follow-ups · 8 open');
  await page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' }).click();
  const impact = page.getByTestId('impact-line');
  // A check's verdict never takes an item out of a count (F7).
  await expect(impact).toHaveText('Follow-ups · 5 open');
  await impact.getByRole('button').click();
  const list = page.getByTestId('follow-ups');
  await list.getByRole('button', { name: 'Check now' }).click();
  await expect(list).toContainText('Checking…');
  await expect(list.getByRole('button', { name: 'Check now' })).toBeVisible({ timeout: 20_000 });
  expect(sweeps()).toEqual([{ scope: 'record', id: PILOT_RECORD }]);
  await expect(row(list, 'ECHO-12')).toHaveAttribute('title', /· matches now$/);
  await expect(row(list, 'Thermostat PRD')).not.toHaveAttribute('title', /matches now/);
  // Back to the meeting, then its project, whose line opens the project's follow-ups.
  await page.getByTestId('back').click();
  await page.getByTestId('back').click();
  await line.getByRole('button').click();
  await list.getByRole('button', { name: 'Check now' }).click();
  await expect(list.getByRole('button', { name: 'Check now' })).toBeVisible({ timeout: 20_000 });
  expect(sweeps()).toEqual([{ scope: 'record', id: PILOT_RECORD }, { scope: 'project', id: THERMOSTAT }]);
  await expect(row(list, 'ECHO-12')).toHaveAttribute('title', /^Jira ticket · from Pilot planning · .+ · matches now$/);
  await expect(row(list, 'ECHO-7')).toHaveAttribute('title', /^Jira ticket · from Kickoff review · /);
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
  // Picking yourself claims an item that only fell back to you: Pick owner gives way to you.
  await list.getByRole('button', { name: 'Pick owner: A Jira ticket ECHO couldn\'t read just now (1)', exact: true }).click();
  await pickOwner(app.page, 'You');
  await expect(list.getByTestId('follow-ups-said')).toHaveText('Owner changed to you');
  await expect(list.getByRole('button', { name: /^Pick owner: / })).toHaveCount(4);
  await expect(list.getByRole('button', { name: 'Owner: You. Change owner of A Jira ticket ECHO couldn\'t read just now (1)', exact: true })).toBeVisible();
  expect(requests('assign')).toEqual([expect.objectContaining({ item_id: 'itm_00000000-0000-4000-8000-000000000036', owner_membership_id: 'mem_22222222-2222-4222-8222-222222222222' })]);
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
