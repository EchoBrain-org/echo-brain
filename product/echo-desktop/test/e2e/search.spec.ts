import { expect, test } from '@playwright/test';
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
const searches = (path: string) => run.calls().filter(call => call.method === 'POST' && call.path === path);
const noteSearches = () => searches('/v3/person/updates/search').length;

test('in a project the bar shows its matches as you type, a match reads in place, and ✕ widens without moving the page', async () => {
  run = await launch();
  const { page } = run;
  const field = page.getByTestId('ask-field');
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('scope-chip')).toHaveText('Apollo');
  await expect(field).toHaveAttribute('placeholder', 'Search or ask Apollo');

  await field.fill('ship');
  await expect(page.getByTestId('matches-head')).toHaveText('Matches in Apollo');
  await expect(page.getByTestId('match-row')).toHaveText([/Apollo update/]);
  await expect(page.getByTestId('match-ask')).toContainText('Ask Apollo about “ship”');
  expect(searches('/v2/person/projects/context/search').map(call => call.body)).toEqual([{ project_id: APOLLO, query: 'ship', limit: 10 }]);

  // A match reads in place; Back returns to the matches, the text still in the bar.
  await page.getByTestId('match-row').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await expect(page.getByTestId('matches')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('match-row')).toHaveCount(1);
  await expect(field).toHaveValue('ship');

  // ✕ widens to all context: the page stays, the placeholder and the matches follow.
  await page.getByTestId('scope-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(field).toHaveAttribute('placeholder', 'Search or ask ECHO');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await expect(page.getByTestId('feed-row')).toHaveCount(1);
  await expect(page.getByTestId('matches-head')).toHaveText('Matches in all context');
  await expect(page.getByTestId('match-ask')).toContainText('Ask ECHO about “ship”');
  await expect(page.getByTestId('match-row')).toHaveText([/Apollo update/]);
  expect(searches('/v3/person/updates/search').map(call => call.body)).toEqual([{ query: 'ship', limit: 10 }]);
  expect(searches('/v2/person/updates/search').map(call => call.body)).toEqual([{ query: 'ship', limit: 10 }]);
  await page.getByTestId('match-row').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  expect(run.calls().some(call => call.path.startsWith('/v2/person/updates/content/'))).toBe(true);
  await page.keyboard.press('Escape');

  // Return still asks, in the same scope, and the bar empties.
  await field.press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(field).toHaveValue('');
  const asks = run.calls().filter(call => call.path === '/v2/person/ask');
  expect(asks.map(call => call.body?.question)).toEqual(['ship']);
  expect(asks[0]!.body && 'project_id' in asks[0]!.body).toBe(false);
});

test('the Home search survives every way back in, and a sidebar click narrows it', async () => {
  run = await launch();
  const { page, app } = run;
  const field = page.getByTestId('ask-field');
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await field.fill('apollo');
  await expect(page.getByTestId('matches-head')).toHaveText('Matches in all context');
  // Newer notes first; one whose title does not match shows where its text does.
  await expect(page.getByTestId('match-row')).toHaveText([/Pricing decision from Tuesday sync · “Apollo moves to/, /Apollo update/]);
  await page.getByTestId('match-row').nth(0).click();
  await expect(page.getByTestId('reader-text')).toHaveText('Apollo moves to usage-based pricing tiers from October.');
  await expect(page.getByTestId('back')).toHaveText('Home');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('match-row')).toHaveCount(2);

  // Another app in front: the matches are covered, the text stays, and they are read again on return.
  const before = noteSearches();
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('matches')).toHaveCount(0);
  await expect(field).toHaveValue('apollo');
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('match-row')).toHaveCount(2);
  await expect.poll(noteSearches).toBe(before + 1);

  // ⌘⇧E, then a file dropped on a project row: each capture closes back to the same search.
  await emit(app, 'echo-test:capture');
  await expect(page.getByTestId('compose')).toBeVisible();
  await expect(page.getByTestId('matches')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('apollo');
  await expect(page.getByTestId('match-row')).toHaveCount(2);
  const folder = mkdtempSync(join(tmpdir(), 'echo-drop-'));
  folders.push(folder);
  writeFileSync(join(folder, 'Brief.md'), 'Annual pricing.');
  await drop(page, page.getByTestId('project-row').nth(1), join(folder, 'Brief.md'));
  await expect(page.getByTestId('readers-project')).toHaveText('Beacon');
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('apollo');
  await expect(page.getByTestId('match-row')).toHaveCount(2);

  // A sidebar click narrows the scope; the text stays and searches the project.
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('scope-chip')).toHaveText('Apollo');
  await expect(field).toHaveValue('apollo');
  await expect(page.getByTestId('matches-head')).toHaveText('Matches in Apollo');
  await expect(page.getByTestId('match-row')).toHaveText([/Apollo update/]);

  // Escape clears the text, then goes back.
  await field.focus();
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('');
  await expect(page.getByTestId('matches')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('title')).toHaveText('ECHO');
});

test('only a real change of access empties the bar: an outage keeps the text, a refused search empties it', async () => {
  run = await launch('search-fails');
  const { page } = run;
  const field = page.getByTestId('ask-field');
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await field.fill('apollo');
  await expect(page.getByTestId('matches-error')).toContainText('ECHO is unavailable right now. Try again.');
  await expect(field).toHaveValue('apollo');
  await page.getByTestId('matches-error').getByRole('button', { name: 'Try again' }).click();
  await expect.poll(noteSearches).toBe(2);
  await expect(field).toHaveValue('apollo');

  // The project refuses the search: the text and its matches go.
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(field).toHaveValue('');
  await expect(page.getByTestId('matches')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
});

test('a new role in a project is a change of access, and empties the bar', async () => {
  run = await launch('role-changes');
  const { page, app } = run;
  const field = page.getByTestId('ask-field');
  await expect(page.getByTestId('project-row').nth(0)).toContainText('Lead');
  await field.fill('apollo');
  await expect(page.getByTestId('match-row')).toHaveCount(2);
  await emit(app, 'echo-test:shown');
  await expect(page.getByTestId('project-row').nth(0)).not.toContainText('Lead');
  await expect(field).toHaveValue('');
  await expect(page.getByTestId('matches')).toHaveCount(0);
});
