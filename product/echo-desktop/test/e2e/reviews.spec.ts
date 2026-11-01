import { expect, test } from '@playwright/test';
import { launch, routeAll, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const reviews = () => run.calls().filter(call => call.path === '/v1/person/reviews').map(call => call.body);

test('a staging approval remains reviewable without an advertised meeting source', async () => {
  run = await launch('synthetic-review');
  const { page } = run;
  const row = page.getByTestId('need-row').filter({ hasText: 'SYNTHETIC STAGING CANARY' });
  await expect(row).toBeVisible();
  expect(reviews()).toContainEqual({ schema_version: 1, operation: 'reviews' });
  await page.getByTestId('sidebar-tools').click();
  await expect(page.getByTestId('tools')).not.toContainText('Paste a meeting');
  await expect(page.getByTestId('tools')).not.toContainText('Synthetic staging meetings');
  await expect(page.locator('[data-tool="slack"]')).toContainText('Slack (approval notifications)');
  await expect(page.locator('[data-tool="granola"]')).toContainText('Not turned on');
  await page.getByTestId('sidebar-home').click();
  await row.click();
  const card = page.getByTestId('decision');
  await expect(card.getByRole('heading', { name: 'SYNTHETIC STAGING CANARY' })).toBeVisible();
  await routeAll(card, 'No project');
  await card.getByTestId('decision-approve').click();
  await expect.poll(() => reviews().filter(body => body?.operation === 'review').length).toBe(1);
  expect(reviews()).toEqual(expect.arrayContaining([
    expect.objectContaining({ schema_version: 1, operation: 'review_open' }),
    expect.objectContaining({ schema_version: 1, operation: 'review', action: 'approve' }),
  ]));
  expect(reviews().every(body => body !== undefined && !('tool_id' in body))).toBe(true);
  expect(run.calls().some(call => call.path === '/v1/person/meetings')).toBe(false);
});
