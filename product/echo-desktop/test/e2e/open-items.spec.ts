import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
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
/** The sweeps the app asked for, by scope. */
const sweeps = () => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'sweep')
  .map(call => ({ scope: call.body?.scope, id: call.body?.id }));
/** The item pages the app read (not counts only), by scope and whether they asked for open items only. */
const itemPages = () => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'items' && call.body?.summary_only !== true)
  .map(call => ({ scope: call.body?.scope, open_only: call.body?.open_only === true }));
/** The fixture's Pilot planning record, and the project it was approved into. */
const PILOT_RECORD = `sha256:${createHash('sha256').update('record:Pilot planning').digest('hex')}`;
const THERMOSTAT = 'prj_11111111-1111-4111-8111-111111111111';
/** A day as the app writes it ("Oct 7"), in this computer's time zone, as the app's is. */
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
/** Pilot planning as Ari approved it in the checked modes, and as Mina approved it in the owner modes. */
const ARI_PILOT = `Pilot planning meeting, approved ${day('2026-10-07T10:00:00.000Z')}`;
const MINA_PILOT = `Pilot planning meeting, approved ${day('2026-10-06T18:00:00.000Z')}`;

test('the approver sends the impact to its owners from Home', async () => {
  app = await launch('granola');
  await approveFromHome(app);
  const send = app.page.getByTestId('need-row').filter({ hasText: 'need updating' });
  await expect(send).toBeVisible({ timeout: 20_000 });
  await expect(send).toContainText('owners Mina');
  await send.click();
  await expect(app.page.getByRole('heading', { name: 'Tell the owners?' })).toBeVisible();
  await expect(app.page.getByText('Untick anything that\'s wrong. Owners get it on their Home.')).toBeVisible();
  // What an item says now is covered while another app is in front, and the card comes back as it was.
  await emit(app.app, 'echo-test:conceal');
  await expect(app.page.getByTestId('concealed')).toBeVisible();
  await expect(app.page.locator('body')).not.toContainText('ECHO-12');
  await emit(app.app, 'echo-test:resume');
  await expect(app.page.getByRole('heading', { name: 'Tell the owners?' })).toBeVisible();
  await app.page.getByRole('button', { name: 'Pick a person: Thermostat PRD · Pilot scope' }).click();
  await app.page.getByRole('searchbox', { name: 'Find a person' }).fill('Raf');
  await app.page.getByRole('option', { name: 'Rafael Moreno' }).click();
  // Removing the pick names its item too.
  await expect(app.page.getByRole('button', { name: 'Remove Rafael from Thermostat PRD · Pilot scope', exact: true })).toBeVisible();
  await app.page.getByRole('button', { name: 'Send to Mina and Rafael' }).click();
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'need updating' })).toHaveCount(0);
  const sent = app.calls().find(call => call.path === '/v1/person/runs' && call.body?.operation === 'send')!;
  expect(sent.body?.items).toEqual(expect.arrayContaining([expect.objectContaining({ include: true, owner_membership_id: expect.any(String) })]));
  // Both items now wait on someone else.
  await expect(app.page.getByText('2 waiting on others')).toBeVisible();
});

test('an owner without Granola closes an item from Home', async () => {
  app = await launch('granola-owner');
  const row = app.page.getByTestId('need-row').filter({ hasText: 'ECHO-12' });
  await expect(row).toContainText('ECHO-12 · Pilot launch doesn\'t match the decision yet');
  await expect(row).toContainText('Due Oct 30 → decision needs: launch next week');
  await expect(row).toContainText(`Jira ticket · ${MINA_PILOT}`);
  // Not changed since it was sent: an Update row that acts in place.
  await expect(row).toHaveAttribute('data-kind', 'update');
  expect(app.calls().some(call => call.path === '/v1/person/meetings')).toBe(false);
  await expect(row.getByRole('button', { name: 'Open in Jira: ECHO-12 · Pilot launch' })).toBeVisible();
  // The fixture's second item has no `current`: Ari cannot open it in Jira.
  const hidden = app.page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' });
  await expect(hidden).toContainText('A Jira ticket you can\'t open');
  await expect(hidden.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  await row.getByRole('button', { name: 'Mark updated: ECHO-12 · Pilot launch' }).click();
  await expect(row).toHaveCount(0);
  // The row leaves at once; the request follows.
  await expect.poll(() => app.calls().some(call => call.body?.operation === 'set_state' && call.body.state === 'done')).toBe(true);
});

/** What a live open of an item Ari cannot open would read: its key, title, link and assignee. */
const WITHHELD = ['ECHO-31', 'Trace sign-off', 'browse/ECHO-31', 'S. Okafor', 'ECHO-20', 'Vendor order', 'Rafael Moreno'];

test('a decision reader who cannot open an item sees what it is, never what it says', async () => {
  app = await launch('granola-owner');
  // Ari reads Pilot planning, but cannot open this ticket in Jira.
  const row = app.page.getByTestId('need-row').filter({ hasText: 'confirm the trace by Friday' });
  await expect(row).toContainText('A Jira ticket you can\'t open doesn\'t match the decision yet');
  await expect(row).toContainText('Decision needs: confirm the trace by Friday');
  await expect(row).toContainText(`Jira ticket · ${MINA_PILOT}`);
  await expect(row.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  // A decision Ari cannot read is never named: who sent the item is.
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' })).toContainText('Jira ticket · sent by Mina');
  await expect(app.page.getByTestId('needs')).not.toContainText('you own');
  // Two items Ari can't open would share a name: each Mark updated says what the decision requires of its item.
  await expect(row.getByRole('button', { name: 'Mark updated: A Jira ticket you can\'t open → confirm the trace by Friday', exact: true })).toBeVisible();
  await expect(app.page.getByRole('button', { name: 'Mark updated: A Jira ticket you can\'t open → order six weeks ahead', exact: true })).toBeVisible();
  const home = await app.page.content();
  for (const withheld of WITHHELD) expect(home).not.toContain(withheld);
  // The decision's items show it the same way.
  await app.page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  await app.page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' }).click();
  const impact = app.page.getByTestId('impact-line');
  await expect(impact).toContainText('Impact · 2 open');
  await impact.getByRole('button', { name: /Impact/ }).click();
  const items = app.page.getByTestId('open-item');
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: 'confirm the trace by Friday' })).toContainText('A Jira ticket you can\'t open');
  // No title, permalink or assignee of an item Ari cannot open reaches the page.
  const page = await app.page.content();
  for (const withheld of WITHHELD) expect(page).not.toContain(withheld);
});

test('a Home read that fails once keeps the rows it had', async () => {
  app = await launch('granola-home-fails-once');
  const rows = app.page.getByTestId('need-row');
  const homeReads = () => runOperations().filter(operation => operation === 'home').length;
  await expect(rows.filter({ hasText: 'ECHO-12' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  // Home is read again on coming forward once the project list is in.
  await expect(app.page.getByTestId('sidebar-project')).toHaveCount(2);
  // The window comes forward: Home is read again, and that read fails.
  await emit(app.app, 'echo-test:shown');
  await expect.poll(homeReads).toBe(2);
  await expect(app.page.getByTestId('needs')).toHaveAttribute('aria-busy', 'false');
  await expect(rows.filter({ hasText: 'ECHO-12' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(app.page.getByTestId('home-error')).toHaveCount(0);
  // The next read brings what changed meanwhile.
  await emit(app.app, 'echo-test:shown');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'A Jira ticket you can\'t open' })).toBeVisible();
});

test('an approved decision shows its Impact line and the project shows its open items', async () => {
  app = await launch('granola');
  await approveFromHome(app);
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'need updating' })).toBeVisible({ timeout: 20_000 });
  await app.page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  const line = app.page.getByTestId('project-line');
  await expect(line).toContainText('2 open items · from 1 decision');
  const decision = app.page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' });
  await expect(decision).toContainText('2 open');
  await decision.click();
  const impact = app.page.getByTestId('impact-line');
  await expect(impact).toContainText('Impact · 2 not sent');
  await expect(impact.getByRole('button', { name: 'Send' })).toBeVisible();
  // Nothing is open to check until the items are sent.
  await impact.getByRole('button', { name: 'Check now' }).click();
  await expect(impact).toContainText('Nothing open to check');
  expect(sweeps()).toEqual([{ scope: 'record', id: PILOT_RECORD }]);
  // The line read the decision's counts only; opening it lists the items.
  const recordReads = () => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'items' && call.body.scope === 'record')
    .map(call => call.body?.summary_only === true);
  expect(recordReads().length).toBeGreaterThan(0);
  expect(recordReads().every(counts => counts)).toBe(true);
  await impact.getByRole('button', { name: /Impact/ }).click();
  const items = app.page.getByTestId('open-items');
  await expect(items.getByRole('heading', { name: 'Open items' })).toBeVisible();
  await expect(items.getByTestId('open-item')).toHaveCount(2);
  await expect(items.getByRole('region', { name: 'Mina Patel' })).toContainText('ECHO-12 · Pilot launch');
  await expect(items.getByRole('region', { name: 'Ari' })).toContainText('Thermostat PRD · Pilot scope');
  expect(recordReads().filter(counts => !counts)).toHaveLength(1);
  // Back returns to the decision, then to the project, whose line opens its items too.
  await app.page.getByTestId('back').click();
  await expect(impact).toBeVisible();
  await app.page.getByTestId('back').click();
  await line.click();
  await expect(items.getByTestId('open-item')).toHaveCount(2);
});

test('an outage is not shown as lost access', async () => {
  app = await launch('granola-owner-outage');
  // Jira did not answer for this item just now: ECHO says so, and never that Ari lost access to it.
  const outage = app.page.getByTestId('need-row').filter({ hasText: 'A Jira ticket ECHO couldn\'t read just now' });
  await expect(outage).toBeVisible();
  await expect(outage).toContainText('A Jira ticket ECHO couldn\'t read just now doesn\'t match the decision yet');
  await expect(outage).toContainText('Decision needs: confirm the trace by Friday');
  await expect(outage.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  await expect(outage.getByRole('button', { name: 'Mark updated: A Jira ticket ECHO couldn\'t read just now', exact: true })).toBeVisible();
  // An item Ari truly cannot open still says so.
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' })).toContainText('A Jira ticket you can\'t open');
  const home = await app.page.content();
  for (const withheld of WITHHELD) expect(home).not.toContain(withheld);
});

test('the project line reads counts without listing items', async () => {
  app = await launch('granola');
  await approveFromHome(app);
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'need updating' })).toBeVisible({ timeout: 20_000 });
  await app.page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  const line = app.page.getByTestId('project-line');
  await expect(line).toContainText('2 open items · from 1 decision');
  await expect(app.page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' })).toContainText('2 open');
  // Counting opened nothing: every items read so far asked for the project's counts only.
  const itemReads = () => app.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'items')
    .map(call => ({ scope: call.body?.scope, counts: call.body?.summary_only === true }));
  expect(itemReads().length).toBeGreaterThan(0);
  expect(itemReads().every(read => read.scope === 'project' && read.counts)).toBe(true);
  // Opening the line lists its items.
  await line.click();
  await expect(app.page.getByTestId('open-items').getByTestId('open-item')).toHaveCount(2);
  expect(itemReads().filter(read => !read.counts)).toEqual([{ scope: 'project', counts: false }]);
});

test('Home sweeps by itself and shows what matches and what changed', async () => {
  app = await launch('granola-sweep');
  const rows = app.page.getByTestId('need-row');
  // Before the sweep the PRD page waits on Ari unchecked; after it, ECHO saw it change.
  await expect(rows.filter({ hasText: 'changed since you got it, still doesn\'t match' })).toBeVisible({ timeout: 20_000 });
  const foot = app.page.getByTestId('needs-foot');
  await expect(foot).toContainText('1 matches its decision now · 2 waiting on others · ECHO checked just now');
  // Home asked for one sweep of Ari's own items and started it; a sweep makes no Home row of its own.
  expect(sweeps()).toEqual([{ scope: 'mine', id: undefined }]);
  expect(runOperations().indexOf('start')).toBeGreaterThan(runOperations().indexOf('sweep'));
  await expect(rows).toHaveCount(1);
  await foot.getByRole('button', { name: 'View your open items' }).click();
  const status = app.page.getByTestId('item-status');
  await expect(status.getByRole('heading', { name: 'Your open items' })).toBeVisible();
  await expect(status).toContainText('3 open · ECHO checked just now');
  // It asked for your open items only (R51): closed ones are never opened to be left out.
  expect(itemPages()).toEqual([{ scope: 'mine', open_only: true }]);
  // One decision: one list, no header. A status view: no checkboxes, and one match is closed from its line.
  await expect(status.getByRole('checkbox')).toHaveCount(0);
  await expect(status.getByRole('button', { name: /^Close all/ })).toHaveCount(0);
  await status.getByRole('button', { name: 'Close: ECHO-12 · Pilot launch', exact: true }).click();
  await expect(status.getByTestId('status-item')).toHaveCount(2);
  await expect(status).toContainText('2 open · ECHO checked just now');
  const closed = app.calls().filter(call => call.body?.operation === 'set_state').map(call => ({ item: call.body?.item_id, state: call.body?.state }));
  expect(closed).toEqual([{ item: 'itm_00000000-0000-4000-8000-000000000031', state: 'done' }]);
  // Back on Home, read again: nothing matches now, and no second sweep was asked for.
  await app.page.getByTestId('back').click();
  await expect(foot).toContainText('1 waiting on others · ECHO checked just now');
  await expect(foot).not.toContainText('match');
  await expect(rows).toHaveCount(1);
  expect(sweeps()).toHaveLength(1);
});

test('the owner\'s changed item opens before anything is closed', async () => {
  app = await launch('granola-checked');
  const row = app.page.getByTestId('need-row').filter({ hasText: 'Thermostat PRD' });
  // Ari's own page changed since Ari got it: still an Update row (R64), flagged by its third line.
  await expect(row).toHaveAttribute('data-kind', 'update');
  await expect(row.getByText('Update', { exact: true })).toBeVisible();
  await expect(row).toContainText('Thermostat PRD · Pilot scope doesn\'t match the decision yet');
  await expect(row).toContainText('Says "starts after freeze" → decision needs: pilot starts next week');
  await expect(row).toContainText(`Confluence page · ${ARI_PILOT} · changed since you got it, still doesn\'t match`);
  await expect(row).toContainText('Thermostat redesign');
  // The row is one button: nothing on Home closes the item.
  await expect(row.getByRole('button')).toHaveCount(0);
  const foot = app.page.getByTestId('needs-foot');
  await expect(foot).toContainText('1 matches its decision now · 2 waiting on others · ECHO checked 2 h ago');
  await expect(foot.getByRole('button', { name: 'View your open items' })).toBeVisible();
  await expect(app.page.getByTestId('needs')).not.toContainText(/landed|Check\b/);
  await row.click();
  const card = app.page.getByTestId('item-card');
  await expect(card.getByRole('heading', { name: 'Thermostat PRD · Pilot scope' })).toBeVisible();
  await expect(card).toContainText('Confluence page · yours to update');
  // Its main control has the focus, as on Tell the owners? and Your open items.
  await expect(card.getByRole('button', { name: 'Mark updated', exact: true })).toBeFocused();
  const decided = card.getByRole('region', { name: 'The decision', exact: true });
  await expect(decided).toContainText('Launch the pilot next week.');
  await expect(decided).toContainText(`Pilot planning meeting · approved ${day('2026-10-07T10:00:00.000Z')}`);
  await expect(card.getByRole('region', { name: 'Now', exact: true })).toContainText('Says "starts after freeze"');
  await expect(card.getByRole('region', { name: 'The decision needs', exact: true })).toContainText('pilot starts next week');
  // ECHO's check, with no person's name.
  await expect(card).toContainText('ECHO checked 2 h ago: it changed since it was sent, but still doesn\'t match.');
  await expect(card).not.toContainText('Mina');
  await expect(card.getByRole('button', { name: 'Open in Confluence: Thermostat PRD · Pilot scope' })).toBeVisible();
  expect(app.calls().some(call => call.body?.operation === 'set_state')).toBe(false);
  await card.getByRole('button', { name: 'No change needed', exact: true }).click();
  // Closed for everyone: its row leaves Home at once, and the empty Home keeps its footer (canvas 9.5).
  await expect(app.page.getByTestId('need-row')).toHaveCount(0);
  await expect(app.page.getByText('Nothing needs you')).toBeVisible();
  await expect(foot).toContainText('1 matches its decision now · 2 waiting on others · ECHO checked 2 h ago');
  await expect.poll(() => app.calls().filter(call => call.body?.operation === 'set_state').map(call => call.body?.state)).toEqual(['not_relevant']);
});

test('the approver reviews an item someone else owns once it changed', async () => {
  app = await launch('granola-review');
  // ECHO-12 is Mina's, sent by Ari, and changed since: a Review row on Ari's Home (R64).
  const row = app.page.getByTestId('need-row').filter({ hasText: 'ECHO-12' });
  await expect(row).toHaveAttribute('data-kind', 'review');
  await expect(row.getByText('Review', { exact: true })).toBeVisible();
  await expect(row).toContainText('ECHO-12 · Pilot launch doesn\'t match the decision yet');
  await expect(row).toContainText('Due Oct 30 → decision needs: launch next week');
  await expect(row).toContainText(`Jira ticket · ${ARI_PILOT} · Mina's to update · changed since you sent it`);
  await expect(row.getByRole('button')).toHaveCount(0);
  // Ari's own changed page beside it stays an Update row.
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'Thermostat PRD' })).toHaveAttribute('data-kind', 'update');
  await expect(app.page.getByTestId('needs-foot')).toContainText('2 waiting on others · ECHO checked 2 h ago');
  await row.click();
  const card = app.page.getByTestId('item-card');
  await expect(card.getByRole('heading', { name: 'ECHO-12 · Pilot launch' })).toBeVisible();
  await expect(card).toContainText('Jira ticket · Mina\'s to update · now Mina Patel');
  await expect(card.getByRole('region', { name: 'Now', exact: true })).toContainText('Due Oct 30');
  await expect(card.getByRole('region', { name: 'The decision needs', exact: true })).toContainText('launch next week');
  await expect(card).toContainText('ECHO checked 2 h ago: it changed since it was sent, but still doesn\'t match.');
  await expect(card.getByRole('button', { name: 'Open in Jira: ECHO-12 · Pilot launch' })).toBeVisible();
  await card.getByRole('button', { name: 'Mark updated', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => app.calls().filter(call => call.body?.operation === 'set_state').map(call => ({ item: call.body?.item_id, state: call.body?.state })))
    .toEqual([{ item: 'itm_00000000-0000-4000-8000-000000000031', state: 'done' }]);
});

test('Check now on a decision checks only that decision', async () => {
  app = await launch('granola-checked');
  await app.page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  await app.page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' }).click();
  const impact = app.page.getByTestId('impact-line');
  // One open, one landed (handled), one ECHO could not read (canvas 9.6).
  await expect(impact).toContainText('Impact · 1 open · 1 handled · 1 couldn\'t read · checked 2 h ago');
  // The faint link the canvas draws (H6), as Home's Mark done is.
  await expect(impact.getByRole('button', { name: 'Check now' })).toHaveCSS('color', 'rgba(240, 236, 230, 0.5)');
  await impact.getByRole('button', { name: 'Check now' }).click();
  await expect(impact).toContainText('Checking…');
  const status = app.page.getByTestId('item-status');
  await expect(status.getByRole('heading', { name: 'Open items', exact: true })).toBeVisible({ timeout: 20_000 });
  expect(sweeps()).toEqual([{ scope: 'record', id: PILOT_RECORD }]);
  await expect(status).toContainText('3 open · ECHO checked just now');
  // The decision's open items only (R51); the Impact line read its counts alone.
  expect(itemPages()).toEqual([{ scope: 'record', open_only: true }]);
  await expect(status).toContainText('Launch the pilot next week.');
  // One list, no checkboxes: each item and what the decision needs, its status, its owner; matches first.
  const lines = status.getByTestId('status-item');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toContainText('ECHO-12 · Pilot launch · launch next week');
  await expect(lines.nth(0)).toContainText('Matches now');
  await expect(lines.nth(0)).toContainText('Mina');
  await expect(lines.nth(1)).toContainText('Thermostat PRD · Pilot scope · pilot starts next week');
  await expect(lines.nth(1)).toContainText('Changed, still doesn\'t match');
  await expect(lines.nth(2)).toContainText('A page you can\'t open · parts ordered for next week');
  await expect(lines.nth(2)).toContainText('ECHO couldn\'t read it');
  await expect(status.getByRole('checkbox')).toHaveCount(0);
  // Only a match closes from its line; one match, so no Close all.
  await expect(status.getByRole('button', { name: /^Close/ })).toHaveCount(1);
  await expect(status.getByRole('button', { name: 'Close: ECHO-12 · Pilot launch', exact: true })).toBeVisible();
  await expect(status).not.toContainText(/land/i);
  // The page Ari cannot open is never named.
  expect(await app.page.content()).not.toContain('Supplier brief');
});

test('Check now on a project shows how its items stand', async () => {
  app = await launch('granola-checked');
  await app.page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  const line = app.page.getByTestId('project-line');
  await expect(line).toContainText('4 open items · from 2 decisions · checked 2 h ago');
  await line.getByRole('button', { name: 'Check now' }).click();
  await expect(line).toContainText('Checking…');
  const status = app.page.getByTestId('item-status');
  await expect(status.getByRole('heading', { name: 'Open items · Thermostat redesign' })).toBeVisible({ timeout: 20_000 });
  // Pilot planning's three open items and Kickoff review's three.
  await expect(status).toContainText('6 open · ECHO checked just now');
  expect(sweeps()).toEqual([{ scope: 'project', id: THERMOSTAT }]);
  expect(itemPages()).toEqual([{ scope: 'project', open_only: true }]);
  // A project is not one decision: no decided line, and one list with no decision headers.
  await expect(status).not.toContainText('Launch the pilot next week.');
  await expect(status.getByTestId('status-group-head')).toHaveCount(0);
  await expect(status.getByTestId('status-item').first()).toContainText('Matches now');
  // Back returns to the project, whose line was read again.
  await app.page.getByTestId('back').click();
  await expect(line).toContainText('4 open items · from 2 decisions · checked just now');
  await expect(line.getByRole('button', { name: 'Check now' })).toBeVisible();
});

test('a decision\'s row counts what its Impact line calls open, and the project line sums its rows (canvas 9.7)', async () => {
  app = await launch('granola-checked');
  await app.page.getByTestId('sidebar-project').filter({ hasText: 'Thermostat redesign' }).click();
  // Pilot planning's three sent items: one still open, one landed, one ECHO could not read. Kickoff review's three are open.
  const pilot = app.page.getByTestId('feed-row').filter({ hasText: 'Pilot planning' });
  await expect(pilot.getByTestId('item-open')).toHaveText('1 open');
  await expect(app.page.getByTestId('feed-row').filter({ hasText: 'Kickoff review' }).getByTestId('item-open')).toHaveText('3 open');
  await expect(app.page.getByTestId('project-line')).toContainText('4 open items · from 2 decisions · checked 2 h ago');
  // The same count as the decision's own Impact line.
  await pilot.click();
  await expect(app.page.getByTestId('impact-line')).toContainText('Impact · 1 open · 1 handled · 1 couldn\'t read · checked 2 h ago');
});

test('Tell the owners? names apart items whose titles nothing tells apart', async () => {
  app = await launch('granola-alike');
  await app.page.getByTestId('need-row').filter({ hasText: 'need updating' }).click();
  await expect(app.page.getByRole('heading', { name: 'Tell the owners?' })).toBeVisible();
  await expect(app.page.getByRole('checkbox')).toHaveCount(6);
  // Two pages Ari cannot open, with the same expected phrase, and two tickets ECHO couldn't read just now, with none.
  for (const name of [
    'A page you can\'t open → parts ordered for next week (1)', 'A page you can\'t open → parts ordered for next week (2)',
    'A Jira ticket ECHO couldn\'t read just now (1)', 'A Jira ticket ECHO couldn\'t read just now (2)',
  ]) {
    await expect(app.page.getByRole('checkbox', { name, exact: true })).toBeChecked();
    await expect(app.page.getByRole('button', { name: `Pick a person: ${name}`, exact: true })).toBeVisible();
  }
  const page = await app.page.content();
  for (const withheld of ['Supplier brief', 'ECHO-41', 'ECHO-42']) expect(page).not.toContain(withheld);
});

test('Home starts its sweep again when an attempt goes back to the queue', async () => {
  app = await launch('granola-sweep-requeued');
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'changed since you got it, still doesn\'t match' })).toBeVisible({ timeout: 30_000 });
  // One sweep, asked for once and started twice: the attempt that went back to the queue, then the one that finished.
  expect(sweeps()).toEqual([{ scope: 'mine', id: undefined }]);
  expect(runOperations().filter(operation => operation === 'start')).toHaveLength(2);
});
