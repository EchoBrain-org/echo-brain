import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, routeAll, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const lists = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v2/person/projects' &&
  new URLSearchParams(call.query).get('status') === 'active').length;

test('Back keeps the pages Home had loaded, and showing the window re-reads them once a project changed', async () => {
  run = await launch('many-projects');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(10);
  await page.getByTestId('sidebar-more').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
  await page.getByTestId('sidebar-project').nth(12).click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  // Renamed elsewhere: the change check says your projects moved, and every page is read again (to tell a project Ari was
  // added to), which fills both pages the sidebar shows: what shows is what the Authority has now; More stays gone.
  writeFileSync(join(run.home, 'renamed'), '');
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(13);
  await expect(page.getByTestId('sidebar-project').first()).toContainText('Project 1, renamed');
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
});

test('opening ECHO again while it runs brings the window forward, as Open ECHO does', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  // Home's reads of its rows: coming forward reads what shows again.
  const homeReads = () => run.calls().filter(call => call.path === '/v1/person/runs' && call.body?.operation === 'home' && call.body.read === 'rows').length;
  await expect.poll(homeReads).toBe(1);
  // What macOS sends when ECHO is opened from Spotlight or Finder while it runs.
  await app.evaluate(({ app: electronApp }) => { electronApp.emit('activate', {}, false); });
  await expect.poll(homeReads).toBe(2);
  await expect(page.getByTestId('ask-field')).toBeFocused();
});

test('a project created elsewhere reaches the sidebar when the window shows, without resetting an approval draft', async () => {
  run = await launch('granola-project-added');
  const { page, app } = run;
  await expect(page.getByTestId('need-row')).toContainText('Pilot planning');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(0);
  await page.getByTestId('need-row').click();
  const card = page.getByTestId('decision');
  // The review reads its suggestions fresh even though the sidebar's first list was empty.
  await expect(card.getByTestId('route-chip')).toHaveText(['Thermostat redesign', 'Thermostat redesign', 'Thermostat redesign']);
  await card.getByLabel('Owner for: Send the revised quote').fill('Rafael M.');
  await routeAll(card, 'No project');
  await card.getByTestId('route-chip').nth(2).click();
  await card.getByTestId('route-menu').getByRole('radio', { name: 'Don\'t keep', exact: true }).click();
  const before = lists();
  writeFileSync(join(run.home, 'project-created'), '');
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(1);
  await expect(page.getByTestId('sidebar-project')).toContainText('Thermostat redesign');
  // The full read that tells which projects Ari was added to, which also fills the sidebar.
  await expect.poll(lists).toBe(before + 1);
  await expect(card.getByLabel('Owner for: Send the revised quote')).toHaveValue('Rafael M.');
  await expect(card.getByTestId('route-chip')).toHaveText(['No project', 'No project', 'Don\'t keep']);
  expect(run.calls().filter(call => call.method === 'POST' && call.path === '/v1/person/projects')).toHaveLength(0);
  expect(run.calls().filter(call => call.body?.operation === 'review')).toHaveLength(0);
});

test('the ask bar has the caret at launch and whenever the window comes forward', async () => {
  run = await launch();
  const { page, app } = run;
  await expect(page.getByTestId('ask-field')).toBeFocused();
  await page.getByTestId('sidebar-project').nth(0).focus();
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('ask-field')).toBeFocused();
});

test('a source shows at most 2,000 characters', async () => {
  run = await launch('long-evidence');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('What did we agree?');
  await page.getByTestId('ask-field').press('Enter');
  await page.getByTestId('sources-toggle').click();
  await page.getByTestId('source-row').nth(1).click();
  await expect(page.getByTestId('evidence-text')).toHaveText(`${'x'.repeat(2_000)}…`);
});
