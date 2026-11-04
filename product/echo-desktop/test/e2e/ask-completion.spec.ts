import { expect, test } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const readOnly = "Ask can read your sources, but it can't make changes or send messages. Nothing was changed or sent.";
for (const [question, gap] of [
  ['Mark action A1 Done.', readOnly],
  ['What changed during the unavailable search?', "I couldn't complete the search. Please try again."],
]) test(`project Ask explains and copies its partial result: ${question}`, async () => {
  run = await launch('ask-completion');
  const { page, app } = run;
  await page.getByTestId('sidebar-project').first().click();
  await page.getByTestId('ask-field').fill(question!);
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer-gap')).toHaveText(gap!);
  await expect(page.getByTestId('answer-empty')).toHaveCount(0);
  await expect(page.getByTestId('project-empty')).toHaveCount(0);
  await expect(page.getByTestId('ask-everywhere')).toHaveCount(0);
  await page.getByTestId('copy-answer').click();
  await expect.poll(() => app.evaluate(() => (globalThis as { echoTestClipboard?: string }).echoTestClipboard)).toBe(gap);
});

test('a completed project no-match result still offers an explicit wider search', async () => {
  run = await launch('ask-completion');
  const { page } = run;
  await page.getByTestId('sidebar-project').first().click();
  await page.getByTestId('ask-field').fill('Find the missing launch note.');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('project-empty')).toContainText('Nothing in Apollo matched.');
  await expect(page.getByTestId('ask-everywhere')).toBeVisible();
  await expect(page.getByTestId('answer-gap')).toHaveCount(0);
});

test('a mixed request keeps its factual answer and copies the unsupported-action explanation', async () => {
  run = await launch('ask-completion');
  const { page, app } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('What was decided? Mark action A1 Done.');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('statement-text')).toContainText('We agreed to ship Apollo');
  await expect(page.getByTestId('answer-gap')).toHaveText(readOnly);
  await page.getByTestId('copy-answer').click();
  await expect.poll(() => app.evaluate(() => (globalThis as { echoTestClipboard?: string }).echoTestClipboard)).toContain(readOnly);
});
