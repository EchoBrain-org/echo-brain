import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const RECORD = `sha256:${'5'.repeat(64)}`;
const recordReads = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v1/person/records');
const evidenceReads = () => run.calls().filter(call => call.path === '/v2/person/ask/source');
const questions = () => run.calls().filter(call => call.path === '/v2/person/ask').map(call => call.body?.question);

async function askFromHome(page: Page, question: string): Promise<void> {
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
}

/** A follow-up from the bar, answered. */
async function followUp(page: Page, question: string): Promise<void> {
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('question')).toHaveText(question);
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await expect(page.getByTestId('answer')).toBeVisible();
}

test('follow-ups stack in a thread, newest at the bottom: earlier answers collapse, five at most, and Back leaves the thread', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('project-row').nth(0).click();
  await page.getByTestId('ask-field').fill('Question 1');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.getByTestId('title')).toHaveText('Ask');
  await expect(page.getByTestId('back')).toHaveText('Apollo');
  for (let n = 2; n <= 7; n += 1) await followUp(page, `Question ${n}`);

  const earlier = page.getByTestId('earlier-turn');
  await expect(earlier.locator('.q')).toHaveText(['Question 2', 'Question 3', 'Question 4', 'Question 5', 'Question 6']);
  await expect(page.getByTestId('question')).toHaveText('Question 7');
  await expect(page.getByTestId('answer')).toBeInViewport();
  // Only the current answer has chips.
  await expect(page.getByTestId('source-chip')).toHaveCount(2);
  // Collapsed until clicked.
  await expect(earlier.nth(4)).toHaveAttribute('aria-expanded', 'false');
  await earlier.nth(4).click();
  await expect(earlier.nth(4)).toHaveAttribute('aria-expanded', 'true');
  await expect(earlier.nth(4)).toContainText('We agreed to ship Apollo with annual plans first.');
  // Every follow-up asked the project, as the chip said.
  const asks = run.calls().filter(call => call.path === '/v2/person/ask');
  expect(asks.map(call => call.body?.project_id)).toEqual(Array(7).fill('prj_11111111-1111-4111-8111-111111111111'));

  // Back leaves the thread; the next question starts a new one.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await followUp(page, 'Question 8');
  await expect(earlier).toHaveCount(0);
});

test('a follow-up can be cancelled and its late answer is dropped; one that fails leaves the answer before it, with Try again', async () => {
  run = await launch('ask-follow-ups');
  const { page } = run;
  const field = page.getByTestId('ask-field');
  const earlier = page.getByTestId('earlier-turn');
  await askFromHome(page, 'First?');
  await expect(page.getByTestId('source-chip')).toHaveCount(2);

  await field.fill('Second?');
  await field.press('Enter');
  await expect(page.getByTestId('asking')).toContainText('Thinking…');
  await expect(earlier.locator('.q')).toHaveText(['First?']);
  // One question at a time: the next waits in the bar.
  await field.fill('Third?');
  await field.press('Enter');
  await expect(field).toHaveValue('Third?');
  expect(questions()).toEqual(['First?', 'Second?']);

  // Cancel: the first answer is current again, with its sources.
  await page.getByTestId('ask-cancel').click();
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await expect(page.getByTestId('question')).toHaveText('First?');
  await expect(earlier).toHaveCount(0);
  await expect(page.getByTestId('source-chip')).toHaveCount(2);

  // The third question fails: the first answer stays current, and Try again asks the third again.
  await field.press('Enter');
  await expect(page.getByTestId('ask-error')).toHaveText('ECHO is unavailable right now. Try again.');
  await expect(page.getByTestId('ask-failed')).toContainText('Third?');
  await expect(page.getByTestId('question')).toHaveText('First?');
  await expect(page.getByTestId('source-chip')).toHaveCount(2);
  await expect(earlier).toHaveCount(0);
  await page.getByTestId('ask-retry').click();
  await expect(page.getByTestId('question')).toHaveText('Third?');
  await expect(page.getByTestId('answer')).toHaveText('We agreed to ship Apollo with annual plans first.');
  await expect(earlier.locator('.q')).toHaveText(['First?']);
  await expect(page.getByTestId('ask-failed')).toHaveCount(0);
  expect(questions()).toEqual(['First?', 'Second?', 'Third?', 'Third?']);

  // The second answer arrived after it was cancelled, and never showed.
  const answered = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8').match(/ask\.run ok/g)?.length ?? 0;
  await expect.poll(answered).toBe(3);
  // One more round trip through main: the late reply reached the page before it.
  await page.evaluate(() => (window as unknown as { echo: { rpc(method: string, params: object): Promise<unknown> } }).echo.rpc('app.status', {}));
  await expect(page.getByTestId('ask-view')).not.toContainText('A late answer.');
  await expect(page.getByTestId('question')).toHaveText('Third?');
});

test('an approved record opens beside the answer: who approved it, who was there, who can read it, and what was approved', async () => {
  run = await launch();
  const { page, app } = run;
  await askFromHome(page, 'What did we agree?');
  await expect(page.getByTestId('answer')).toBeVisible();
  // The record is read once, so its chip names the meeting.
  const chips = page.getByTestId('source-chip');
  await expect(chips).toHaveText([/^1\s*Tuesday sync$/, /^2\s*Apollo update$/]);
  expect(recordReads().map(call => call.query)).toEqual([`?record_sha256=${RECORD}`]);
  await expect(page.getByTestId('source-pane')).toHaveCount(0);

  await chips.nth(0).click();
  const pane = page.getByTestId('source-pane');
  const record = pane.getByTestId('record');
  await expect(record).toContainText('Meeting · Approved record');
  await expect(record.locator('h2')).toHaveText('Tuesday sync');
  await expect(record).toContainText('Record approved byMaya Chen');
  await expect(record).toContainText('ParticipantsMaya Chen, Ari');
  await expect(record).toContainText('VisibilityVisible to active organization members');
  await expect(record.getByTestId('record-decisions')).toContainText('Ship Apollo with annual plans first.“Annual plans first, monthly after launch.”');
  await expect(record.getByTestId('record-actions')).toContainText('Maya updates the pricing page.');
  await expect(record.getByTestId('record-rationales')).toContainText('Annual plans fund the launch.');
  await expect(pane).not.toContainText('private@example.test');
  await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
  expect(recordReads()).toHaveLength(1);

  // The original's verified evidence, in the same pane.
  await chips.nth(1).click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');

  // Sources (2) closes the pane, and opens it again on the same source.
  const toggle = page.getByTestId('sources-toggle');
  await expect(toggle).toHaveText('Sources (2)');
  await toggle.click();
  await expect(pane).toHaveCount(0);
  await toggle.click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');

  // Another app in front: the pane closes and forgets what it read; back in ECHO the record is read again.
  await emit(app, 'echo-test:conceal');
  await expect(page.getByTestId('concealed')).toBeVisible();
  await expect(pane).toHaveCount(0);
  await emit(app, 'echo-test:resume');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(pane).toHaveCount(0);
  await expect.poll(() => recordReads().length).toBe(2);
  await expect(chips.nth(0)).toHaveText(/Tuesday sync/);

  // Escape leaves the answer, and its sources with it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('project-row')).toHaveCount(2);
});

test('evidence that could not be read says so, and Retry evidence reads it again', async () => {
  run = await launch('evidence-fails-once');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  await page.getByTestId('source-chip').nth(1).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.getByTestId('source-error')).toHaveText('ECHO is unavailable right now. Try again.');
  await expect(pane.getByTestId('evidence-text')).toHaveCount(0);
  await pane.getByTestId('retry-evidence').click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  expect(evidenceReads()).toHaveLength(2);
});
