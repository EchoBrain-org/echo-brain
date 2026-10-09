import { expect, test } from '@playwright/test';
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
  await app.page.getByRole('button', { name: 'Send to Mina and Rafael' }).click();
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'need updating' })).toHaveCount(0);
  const sent = app.calls().find(call => call.path === '/v1/person/runs' && call.body?.operation === 'send')!;
  expect(sent.body?.items).toEqual(expect.arrayContaining([expect.objectContaining({ include: true, owner_membership_id: expect.any(String) })]));
  // Both items now wait on someone else.
  await expect(app.page.getByText('2 with others')).toBeVisible();
});

test('an owner closes an item from Home', async () => {
  app = await launch('granola-owner');
  const row = app.page.getByTestId('need-row').filter({ hasText: 'ECHO-12' });
  await expect(row).toContainText('due Oct 30 → launch next week');
  await expect(row.getByRole('button', { name: 'Open in Jira: ECHO-12 · Pilot launch' })).toBeVisible();
  // The fixture's second item has no `current`: Ari cannot open it in Jira.
  const hidden = app.page.getByTestId('need-row').filter({ hasText: 'order six weeks ahead' });
  await expect(hidden).toContainText('A Jira ticket you can\'t open');
  await expect(hidden.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  await row.getByRole('button', { name: 'Done: ECHO-12 · Pilot launch' }).click();
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
  await expect(row).toContainText('A Jira ticket you can\'t open → confirm the trace by Friday');
  await expect(row).toContainText('Jira ticket you own · from Pilot planning');
  await expect(row.getByRole('button', { name: /^Open in / })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Done: A Jira ticket you can\'t open' })).toBeVisible();
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
  // The line opens the decision's items, grouped by owner.
  await impact.getByRole('button', { name: /Impact/ }).click();
  const items = app.page.getByTestId('open-items');
  await expect(items.getByRole('heading', { name: 'Open items' })).toBeVisible();
  await expect(items.getByTestId('open-item')).toHaveCount(2);
  await expect(items.getByRole('region', { name: 'Mina Patel' })).toContainText('ECHO-12 · Pilot launch');
  await expect(items.getByRole('region', { name: 'Ari' })).toContainText('Thermostat PRD · Pilot scope');
  // Back returns to the decision, then to the project, whose line opens its items too.
  await app.page.getByTestId('back').click();
  await expect(impact).toBeVisible();
  await app.page.getByTestId('back').click();
  await line.click();
  await expect(items.getByTestId('open-item')).toHaveCount(2);
});
