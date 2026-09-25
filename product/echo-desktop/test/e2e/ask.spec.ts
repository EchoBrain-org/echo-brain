import { expect, test, type Page } from '@playwright/test';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const RECORD = `sha256:${'5'.repeat(64)}`;
const recordReads = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v1/person/records');
const evidenceReads = () => run.calls().filter(call => call.path === '/v2/person/ask/source');

async function askFromHome(page: Page, question: string): Promise<void> {
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
}

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
