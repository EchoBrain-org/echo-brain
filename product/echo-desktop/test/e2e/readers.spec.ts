import { expect, test } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const BEACON = 'prj_44444444-4444-4444-8444-444444444444';
const notes = () => run.calls().filter(call => call.method === 'POST' && call.path === '/v3/person/updates');

test('Who can read is one radio group: arrow keys move and pick, one Tab stop, and ⌘↩ saves from it', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('write-button').click();
  const radio = (name: string) => page.getByRole('radio', { name, exact: true });
  await expect(page.getByRole('radiogroup', { name: 'Who can read' }).getByRole('radio')).toHaveText(['Only me', 'Apollo', 'Beacon', 'Organization']);
  // Two projects need no search.
  await expect(page.getByTestId('readers-find')).toHaveCount(0);
  await page.getByTestId('compose-body').fill('Kickoff moved to Monday');

  // From the note, Tab lands on the chosen one only.
  await page.keyboard.press('Tab');
  await expect(radio('Only me')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(radio('Apollo')).toBeFocused();
  await expect(radio('Apollo')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('compose-readers')).toHaveText('Apollo members can read this.');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(radio('Organization')).toBeFocused();
  await expect(page.getByTestId('compose-readers')).toHaveText('Everyone in your org can read this.');
  await expect(page.getByTestId('compose-readers')).toHaveClass(/warning/);
  // The ends wrap round.
  await page.keyboard.press('ArrowRight');
  await expect(radio('Only me')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(radio('Beacon')).toBeFocused();
  await expect(page.getByRole('radio', { checked: true })).toHaveText('Beacon');
  await expect(page.getByRole('radio', { checked: false })).toHaveCount(3);

  // One Tab stop: the next Tab leaves the group, and Shift-Tab comes back to the chosen one.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('compose-attach')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(radio('Beacon')).toBeFocused();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('toast')).toHaveText('Saved to Beacon');
  expect(notes()).toHaveLength(1);
  expect(notes()[0]!.body?.audience).toEqual({ kind: 'project', project_id: BEACON });
  expect(notes()[0]!.body?.association_project_ids).toEqual([BEACON]);
});
