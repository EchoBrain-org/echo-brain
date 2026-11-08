// What an answer could not do reaches the page only as a typed reason, and only because the real person client asks for
// typed reasons (x-echo-ask-gap-details): the fixture Authority sends them to no other request. Which reason the page and
// Copy answer show, in a project or not, is answer.test's and ask-timeline.test's.
import { expect, test } from '@playwright/test';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

test('a mixed request keeps its factual answer and copies the unsupported-action explanation', async () => {
  const readOnly = "Ask can read your sources, but it can't make changes or send messages. Nothing was changed or sent.";
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
