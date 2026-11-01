import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approveFromHome, clickNotice, emit, launch, notices, type Launched } from './launch.js';

let app: Launched;
test.afterEach(async () => { await app?.close(); });
/** The change check's reads of the follow-ups Ari is involved in: open ones, and those closed since (desktop refresh and notifications v1). */
const notificationScan = (body: Record<string, unknown>) => body.operation === 'items' && (body.scope === 'involved' || body.scope === 'mine') && body.read === 'rows'
  && ((body.states as string[] | undefined)?.join() === 'open' || body.changed_since !== undefined);
/** Foreground runs requests; notification discovery is checked independently. */
const requests = (operation: string) => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === operation && !notificationScan(call.body)).map(call => call.body!);
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
  expect(await owners(list)).toEqual(['All owners', 'Mina Patel, 0 open', 'Rafael Moreno, 0 open', 'No owner, 1']);
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
  await emit(app.app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('ECHO-12');
  await emit(app.app, 'echo-test:resume');
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
  // Back to the Follow-ups page, read again: ECHO-12 is open. The page has no link back Home; Escape goes there.
  await page.getByTestId('back').click();
  await expect(rowOf(ofState(mine, 'open'), 'ECHO-12')).toBeVisible();
  await expect(page.getByTestId('back')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('needs')).toBeVisible();
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
  // Home showed, so it was read again: with no click, the two to update are one line, naming the new one; its list shows it.
  const updates = page.getByTestId('need-category');
  await expect(updates).toContainText('Update2A Jira ticket you can\'t openand 1 more');
  await updates.click();
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

test('an owner change whose reply was lost shows the item as it is now, and holds nothing', async () => {
  app = await launch('granola-review-assign-lost');
  const { page } = app;
  await page.getByTestId('need-category').and(page.locator('[data-category="update"]')).click();
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
