import { expect, test } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => {
  await run?.close();
});

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const searches = (path: string) => run.calls().filter(call => call.method === 'POST' && call.path === path);

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
  await field.fill('apollo');
  await expect(page.getByTestId('match-row')).toHaveText([/Pricing decision from Tuesday sync · “Apollo moves to/, /Apollo update/]);
  await field.fill('ship');
  await expect(page.getByTestId('match-row')).toHaveText([/Apollo update/]);
  await page.getByTestId('match-row').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  expect(run.calls().some(call => call.path === '/v1/person/open' && call.body?.ref === `note:ctx_${'a'.repeat(64)}`)).toBe(true);

  // Return asks over the open match, in the same scope, and the bar empties.
  await field.press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(field).toHaveValue('');
  const asks = run.calls().filter(call => call.path === '/v7/person/ask');
  expect(asks.map(call => call.body?.question)).toEqual(['ship']);
  expect(asks[0]!.body && 'project_id' in asks[0]!.body).toBe(false);
  await expect(page.getByTestId('back')).toHaveText('Back');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await expect(page.getByTestId('back')).toHaveText('Apollo');
  await page.getByTestId('back').click();
  await field.fill('apollo');
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await field.press('Escape');
  await expect(page.getByTestId('title').getByTestId('alt-stops')).toBeVisible();
});
