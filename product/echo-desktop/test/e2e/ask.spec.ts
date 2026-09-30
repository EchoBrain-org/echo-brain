import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const RECORD = `sha256:${'5'.repeat(64)}`;
const recordReads = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v1/person/records');
const evidenceReads = () => run.calls().filter(call => call.path === '/v2/person/ask/source');
const questions = () => run.calls().filter(call => call.path === '/v3/person/ask').map(call => call.body?.question);

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
  // Only the current answer lists its sources.
  await expect(page.getByTestId('source-row')).toHaveCount(2);
  // Collapsed until clicked.
  await expect(earlier.nth(4)).toHaveAttribute('aria-expanded', 'false');
  await earlier.nth(4).click();
  await expect(earlier.nth(4)).toHaveAttribute('aria-expanded', 'true');
  await expect(earlier.nth(4)).toContainText('We agreed to ship Apollo with annual plans first.');
  // Every follow-up asked the project, as the chip said.
  const asks = run.calls().filter(call => call.path === '/v3/person/ask');
  expect(asks.map(call => call.body?.project_id)).toEqual(Array(7).fill('prj_11111111-1111-4111-8111-111111111111'));

  // Back leaves the thread; the next question starts a new one.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await followUp(page, 'Question 8');
  await expect(earlier).toHaveCount(0);
});

test('a question asked over an open match goes Back to that match', async () => {
  run = await launch();
  const { page } = run;
  const field = page.getByTestId('ask-field');
  await expect(page.getByTestId('project-row')).toHaveCount(2);
  await field.fill('ship');
  await page.getByTestId('match-row').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await field.press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.getByTestId('back')).toHaveText('Back');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('reader-text')).toHaveText('We agreed to ship.');
  await expect(page.getByTestId('back')).toHaveText('Home');
});

test('a follow-up can be cancelled and its late answer is dropped; one that fails leaves the answer before it, with Try again', async () => {
  run = await launch('ask-follow-ups');
  const { page } = run;
  const field = page.getByTestId('ask-field');
  const earlier = page.getByTestId('earlier-turn');
  await askFromHome(page, 'First?');
  await expect(page.getByTestId('source-row')).toHaveCount(2);

  await field.fill('Second?');
  await field.press('Enter');
  await expect(page.getByTestId('asking')).toContainText('Thinking…');
  await expect(earlier.locator('.q')).toHaveText(['First?']);
  // The pending state is rendered before its IPC request reaches the fixture.
  // Wait for that receipt before checking that a second follow-up is blocked.
  await expect.poll(questions).toEqual(['First?', 'Second?']);
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
  await expect(page.getByTestId('source-row')).toHaveCount(2);

  // The third question fails: the first answer stays current, and Try again asks the third again.
  await field.press('Enter');
  await expect(page.getByTestId('ask-error')).toHaveText('ECHO is unavailable right now. Try again.');
  await expect(page.getByTestId('ask-failed')).toContainText('Third?');
  await expect(page.getByTestId('question')).toHaveText('First?');
  await expect(page.getByTestId('source-row')).toHaveCount(2);
  await expect(earlier).toHaveCount(0);
  await page.getByTestId('ask-retry').click();
  await expect(page.getByTestId('question')).toHaveText('Third?');
  await expect(page.getByTestId('statement-text')).toHaveText('We agreed to ship Apollo with annual plans first.');
  await expect(earlier.locator('.q')).toHaveText(['First?']);
  await expect(page.getByTestId('ask-failed')).toHaveCount(0);
  expect(questions()).toEqual(['First?', 'Second?', 'Third?', 'Third?']);

  // Deliver the second answer only after cancellation and the successful retry.
  writeFileSync(join(run.home, 'release-follow-up'), '');
  const answered = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8').match(/ask\.run ok/g)?.length ?? 0;
  await expect.poll(answered).toBe(3);
  // One more round trip through main: the late reply reached the page before it.
  await page.evaluate(() => (window as unknown as { echo: { rpc(method: string, params: object): Promise<unknown> } }).echo.rpc('app.status', {}));
  await expect(page.getByTestId('ask-view')).not.toContainText('A late answer.');
  await expect(page.getByTestId('question')).toHaveText('Third?');
});

test('a project question that finds nothing says so and offers, never makes, one tap to ask across everything', async () => {
  run = await launch('ask-project-empty');
  const { page } = run;
  const asks = () => run.calls().filter(call => call.path === '/v3/person/ask').map(call => ({ question: call.body?.question, project: call.body?.project_id }));
  await page.getByTestId('project-row').nth(0).click();
  await page.getByTestId('ask-field').fill('What did we agree on pricing?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer-gap')).toHaveText("I couldn't find this in the sources you can access.");
  await expect(page.getByTestId('statement-text')).toHaveCount(0);
  await expect(page.getByTestId('project-empty')).toContainText('Nothing in Apollo matched.');
  await expect(page.getByTestId('source-row')).toHaveCount(0);
  // Nothing widened on its own: one question, to the project.
  expect(asks()).toEqual([{ question: 'What did we agree on pricing?', project: 'prj_11111111-1111-4111-8111-111111111111' }]);
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');

  await page.getByTestId('ask-everywhere').click();
  await expect(page.getByTestId('question')).toHaveText('What did we agree on pricing?');
  await expect(page.getByTestId('statement-text')).toHaveText('We agreed to ship Apollo with annual plans first.');
  await expect(page.getByTestId('project-empty')).toHaveCount(0);
  await expect(page.getByTestId('source-row')).toHaveCount(2);
  // The project answer stays in the thread; the bar widened with the question.
  await expect(page.getByTestId('earlier-turn').locator('.q')).toHaveText(['What did we agree on pricing?']);
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  expect(asks()).toEqual([
    { question: 'What did we agree on pricing?', project: 'prj_11111111-1111-4111-8111-111111111111' },
    { question: 'What did we agree on pricing?', project: undefined },
  ]);
});

test('a project question about another subject offers no wider ask', async () => {
  run = await launch('ask-project-empty');
  const { page } = run;
  await page.getByTestId('project-row').nth(0).click();
  await page.getByTestId('ask-field').fill('What is the weather in Lisbon?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer-off-scope')).toHaveText('The accessible evidence may be about a different subject.');
  await expect(page.getByTestId('project-empty')).toHaveCount(0);
  await expect(page.getByTestId('ask-everywhere')).toHaveCount(0);
});

test('an approved record opens beside the answer: who approved it, who was there, who can read it, and what was approved', async () => {
  run = await launch();
  const { page, app } = run;
  await askFromHome(page, 'What did we agree?');
  await expect(page.getByTestId('answer')).toBeVisible();
  // The record is read once, so its chip names the meeting.
  const chips = page.getByTestId('source-row');
  await expect(chips).toHaveText([/^1\s*Tuesday sync$/, /^2\s*Apollo update$/]);
  expect(recordReads().map(call => call.query)).toEqual([`?record_sha256=${RECORD}`]);
  await expect(page.getByTestId('source-pane')).toHaveCount(0);

  await chips.nth(0).click();
  const pane = page.getByTestId('source-pane');
  const record = pane.getByTestId('record');
  await expect(pane).toContainText('Meeting · Approved record');
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

  // × closes the pane; a sentence's number opens it again on that source, and lights the sentence.
  await pane.getByTestId('source-close').click();
  await expect(pane).toHaveCount(0);
  const markers = page.getByTestId('citation');
  await expect(markers).toHaveText(['1', '2']);
  await expect(page.getByTestId('statement')).not.toHaveClass(/\bon\b/);
  await markers.nth(1).click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  await expect(markers.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('statement')).toHaveClass(/\bon\b/);

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

test('a cited record the person can no longer read says so, with no Try again that cannot work', async () => {
  run = await launch('record-gone');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  // The Authority answers with an empty list; the chip keeps its own name.
  const chips = page.getByTestId('source-row');
  await expect.poll(() => recordReads().length).toBe(1);
  await expect(chips.nth(0)).toHaveText(/^1\s*Approved record 1$/);
  await chips.nth(0).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.getByTestId('source-error')).toHaveText('This is no longer available to you.');
  await expect(pane.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(recordReads()).toHaveLength(2);
});

test('a Slack citation survives the client and IPC, keeps its label, and opens only its Slack permalink', async () => {
  run = await launch('ask-slack');
  const { page, app } = run;
  const permalink = 'https://acme.slack.com/archives/C01ABCDEF/p1758873600000100?thread_ts=1758873600.000100';
  // The actual main-process opener runs, but its browser call is captured by the test.
  await app.evaluate(({ shell }) => {
    (globalThis as { openedSlack?: string[] }).openedSlack = [];
    shell.openExternal = async url => { (globalThis as { openedSlack?: string[] }).openedSlack!.push(url); };
  });
  const opened = () => app.evaluate(() => (globalThis as { openedSlack?: string[] }).openedSlack);
  await askFromHome(page, 'What did Maya confirm?');
  await expect(page.getByTestId('statement-text')).toHaveText([
    'We agreed to ship Apollo with annual plans first.', 'Maya confirmed the launch in Slack.',
  ]);
  const chips = page.getByTestId('source-row');
  await expect(chips).toHaveText([/^1\s*Tuesday sync$/, /^2\s*Apollo update$/, /^3\s*#launch · Maya$/]);
  await expect(page.getByTestId('private-mark')).toHaveCount(1);
  // The Slack sentence's own number is the third source's.
  await expect(page.getByTestId('citation')).toHaveText(['1', '2', '3']);
  await page.getByTestId('citation').nth(2).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane).toContainText('Slack message');
  await expect(pane.locator('h2')).toHaveText('#launch · Maya');
  await expect(pane.getByTestId('open-slack-source')).toHaveAttribute('title', permalink);
  expect(evidenceReads()).toHaveLength(0);
  expect(await opened()).toEqual([]);
  await pane.getByTestId('open-slack-source').click();
  await expect.poll(opened).toEqual([permalink]);
  // Selecting a Slack source never sends its coordinates to the original-source endpoint.
  expect(evidenceReads()).toHaveLength(0);
  expect(recordReads()).toHaveLength(1);
  // The renderer cannot turn this narrow IPC method into an arbitrary URL opener.
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://example.com',
    'https://acme.slack.com.evil.test/archives/C01ABCDEF/p1758873600000100']) {
    expect(await page.evaluate(permalink =>
      (window as unknown as { echo: { rpc(method: string, params: object): Promise<unknown> } })
        .echo.rpc('source.openSlack', { permalink }), url))
      .toEqual({ ok: false, failure: { code: 'invalid_request', retryable: false } });
  }
  expect(await opened()).toEqual([permalink]);
  await chips.nth(1).click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
});

test('passages of one file are one source: one number, one row, and a pane that shows each cited passage as the document reads', async () => {
  run = await launch('ask-passages');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  await expect(page.getByTestId('statement-text')).toHaveText([
    'We agreed to ship Apollo with annual plans first.', 'Monthly plans follow the launch.',
  ]);
  // Three citations, two sources: the file is named once, as a person says it, its version apart.
  const rows = page.getByTestId('source-row');
  await expect(rows).toHaveText([/^1\s*Tuesday sync$/, /^2\s*Apollo launch plan\s*v2 · 2 passages$/]);
  const markers = page.getByTestId('citation');
  await expect(markers).toHaveText(['1', '2', '2']);
  expect(evidenceReads()).toHaveLength(0);

  // The second sentence's number: both passages, the one it cites lit, and the sentence lit.
  await markers.nth(2).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.locator('h2')).toHaveText('Apollo launch plan');
  await expect(pane.getByTestId('source-meta')).toHaveText('v2 · 2 passages cited');
  const passages = pane.getByTestId('evidence-text');
  await expect(passages).toHaveCount(2);
  await expect(passages.nth(0)).toHaveText('We agreed to ship.');
  // Markdown reads as the document does, without the file name the evidence starts with.
  await expect(passages.nth(1).locator('h3')).toHaveText('Pricing');
  await expect(passages.nth(1).locator('li')).toHaveText('Monthly plans follow the launch.');
  await expect(passages.nth(1).locator('strong')).toHaveText('Monthly');
  await expect(pane).not.toContainText('Apollo-launch-plan-v2.md');
  await expect(pane.locator('.passage.on')).toHaveCount(1);
  await expect(passages.nth(1)).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('statement').nth(1)).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('statement').nth(0)).not.toHaveClass(/\bon\b/);
  expect(evidenceReads()).toHaveLength(2);

  // Its row opens the same source with no sentence in particular.
  await rows.nth(1).click();
  await expect(passages).toHaveCount(2);
  await expect(pane.locator('.passage.on')).toHaveCount(0);
  await expect(page.locator('[data-testid="statement"].on')).toHaveCount(0);
});

test('evidence that could not be read says so, and Try again reads it again', async () => {
  run = await launch('evidence-fails-once');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  await page.getByTestId('source-row').nth(1).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.getByTestId('source-error')).toHaveText('ECHO is unavailable right now. Try again.');
  await expect(pane.getByTestId('evidence-text')).toHaveCount(0);
  // One word for every recovery: Try again.
  await expect(pane.getByTestId('retry-evidence')).toHaveText('Try again');
  await pane.getByTestId('retry-evidence').click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  expect(evidenceReads()).toHaveLength(2);
});

test('Copy answer copies the answer and says so, and main takes no more than an answer holds', async () => {
  run = await launch();
  const { page, app } = run;
  const copied = () => app.evaluate(() => (globalThis as { echoTestClipboard?: string }).echoTestClipboard);
  await askFromHome(page, 'What did we agree?');
  const copy = page.getByTestId('copy-answer');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await copied()).toBe('We agreed to ship Apollo with annual plans first.');
  await expect(copy).toHaveText('Copy answer');

  // An answer is at most 12,000 characters; the broker refuses more.
  const write = (text: string) => page.evaluate(value =>
    (window as unknown as { echo: { rpc(method: string, params: object): Promise<{ ok: boolean }> } }).echo.rpc('clipboard.writeText', { text: value }),
  text);
  expect(await write('x'.repeat(12_001))).toEqual({ ok: false, failure: { code: 'invalid_request', retryable: false } });
  expect(await copied()).toBe('We agreed to ship Apollo with annual plans first.');
  // Counted in characters: 12,000 that each take two UTF-16 units still fit.
  expect((await write('𝄞'.repeat(12_000))).ok).toBe(true);
});
