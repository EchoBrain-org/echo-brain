import { expect, test, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';
import { captureOpenExternal } from './native.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const RECORD = `sha256:${'5'.repeat(64)}`;
const recordReads = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v1/person/records');
const evidenceReads = () => run.calls().filter(call => call.path === '/v2/person/ask/source');
const questions = () => run.calls().filter(call => call.path === '/v5/person/ask').map(call => call.body?.question);

async function askFromHome(page: Page, question: string): Promise<void> {
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
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

test('global Ask reads Jira live and opens its ticket citation', async () => {
  run = await launch('ask-ticket');
  const { page, app } = run;
  const question = 'Open one Jira ticket I can access and tell me its title.';
  const permalink = 'https://example.atlassian.net/browse/ECHO-7';
  const opened = await captureOpenExternal(app);
  await askFromHome(page, question);
  await expect(page.getByTestId('answer')).toBeVisible();
  expect(run.calls().filter(call => /^\/v5\/person\/ask$/.test(call.path)).map(call => ({ path: call.path, body: call.body })))
    .toEqual([{ path: '/v5/person/ask', body: { schema_version: 3, question } }]);
  await expect(page.getByTestId('statement-text')).toHaveText('ECHO-7 is titled Jira launch.');
  await expect(page.getByTestId('private-mark')).toHaveCount(1);
  // The sources start as one closed line, a ticket named by its key; it opens onto their rows (ADR-0045).
  const sources = page.getByTestId('sources-toggle');
  await expect(sources).toHaveText(/^1 source\s*ECHO-7$/);
  await expect(sources).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('source-row')).toHaveCount(0);
  await sources.click();
  await expect(sources).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('source-row')).toHaveText(/^1\s*ECHO-7 · Jira launch$/);
  await page.getByTestId('citation').click();
  const pane = page.getByTestId('source-pane');
  await expect(pane).toContainText('Ticket');
  await expect(pane.getByTestId('open-ticket-source')).toHaveAttribute('title', permalink);
  expect(await opened()).toEqual([]);
  await pane.getByTestId('open-ticket-source').click();
  await expect.poll(opened).toEqual([permalink]);
  expect(evidenceReads()).toHaveLength(0);
  expect(recordReads()).toHaveLength(0);
  // The renderer cannot turn this narrow IPC method into an arbitrary URL opener, nor open a link by a kind no answer has.
  for (const [kind, url] of [['ticket', 'javascript:alert(1)'], ['ticket', 'file:///etc/passwd'], ['ticket', 'http://example.atlassian.net/browse/ECHO-7'],
    ['ticket', `${permalink}?redirect=evil`], ['slack', 'https://acme.slack.com/archives/C01ABCDEF/p1758873600000100']]) {
    expect(await page.evaluate(([kind, permalink]) =>
      (window as unknown as { echo: { rpc(method: string, params: object): Promise<unknown> } })
        .echo.rpc('source.openExternal', { kind, permalink }), [kind, url]))
      .toEqual({ ok: false, failure: { code: 'invalid_request', retryable: false } });
  }
  expect(await opened()).toEqual([permalink]);
});

for (const [tool, label] of [['notion', 'Notion'], ['knowledge-base', 'Knowledge Base']]) {
  test(`a ${tool} page uses its own provider label and the shared external opener`, async () => {
    run = await launch(`ask-page-${tool}`);
    const { page, app } = run;
    const permalink = `https://${tool}.example.test/pages/12345?view=current`;
    const opened = await captureOpenExternal(app);
    await askFromHome(page, 'When does the launch begin?');
    await page.getByTestId('citation').click();
    const pane = page.getByTestId('source-pane');
    await expect(pane).toContainText(`${label} · Page`);
    await expect(pane).not.toContainText('Confluence');
    await pane.getByRole('button', { name: `Open in ${label}` }).click();
    await expect.poll(opened).toEqual([permalink]);
    expect(evidenceReads()).toHaveLength(0);
  });
}

test('follow-ups stack in a thread, newest at the bottom: earlier answers collapse, five at most, and Back leaves the thread', async () => {
  run = await launch();
  const { page } = run;
  await page.getByTestId('sidebar-project').nth(0).click();
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
  // Only the current answer lists its sources, on one line.
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^2 sources/);
  // Collapsed until clicked.
  await expect(earlier.nth(4)).toHaveAttribute('aria-expanded', 'false');
  await earlier.nth(4).click();
  await expect(earlier.nth(4)).toHaveAttribute('aria-expanded', 'true');
  await expect(earlier.nth(4)).toContainText('We agreed to ship Apollo with annual plans first.');
  // Every follow-up asked the project, as the chip said.
  const asks = run.calls().filter(call => call.path === '/v5/person/ask');
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
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
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
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^2 sources/);

  await field.fill('Second?');
  await field.press('Enter');
  await expect(page.getByTestId('asking')).toContainText('Thinking…');
  await expect(page.getByTestId('ask-timer')).toHaveText(/^\d+s$/);
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
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^2 sources/);

  // The third question fails: the first answer stays current, and Try again asks the third again.
  await field.press('Enter');
  await expect(page.getByTestId('ask-error')).toHaveText('ECHO is unavailable right now. Try again.');
  await expect(page.getByTestId('ask-failed')).toContainText('Third?');
  await expect(page.getByTestId('question')).toHaveText('First?');
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^2 sources/);
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
  const asks = () => run.calls().filter(call => /^\/v5\/person\/ask$/.test(call.path)).map(call => ({ question: call.body?.question, project: call.body?.project_id }));
  await page.getByTestId('sidebar-project').nth(0).click();
  await page.getByTestId('ask-field').fill('What did we agree on pricing?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer-gap')).toHaveText("I couldn't find this in the sources you can access.");
  await expect(page.getByTestId('statement-text')).toHaveCount(0);
  await expect(page.getByTestId('project-empty')).toContainText('Nothing in Apollo matched.');
  // What research did not find is the quiet note after the answer, and nothing is cited.
  await expect(page.getByTestId('coverage-note')).toHaveText("I couldn't find this in the sources you can access.");
  await expect(page.getByTestId('sources-toggle')).toHaveCount(0);
  // Nothing widened on its own: one question, to the project.
  expect(asks()).toEqual([{ question: 'What did we agree on pricing?', project: 'prj_11111111-1111-4111-8111-111111111111' }]);
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');

  await page.getByTestId('ask-everywhere').click();
  await expect(page.getByTestId('question')).toHaveText('What did we agree on pricing?');
  await expect(page.getByTestId('statement-text')).toHaveText('We agreed to ship Apollo with annual plans first.');
  await expect(page.getByTestId('project-empty')).toHaveCount(0);
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^2 sources/);
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
  await page.getByTestId('sidebar-project').nth(0).click();
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
  // The record is read once, so its chip names the meeting, on the sources' line and, opened, on its row.
  const chips = page.getByTestId('source-row');
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^2 sources\s*Tuesday sync · Apollo update$/);
  await page.getByTestId('sources-toggle').click();
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
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
});

test('a cited record the person can no longer read says so, with no Try again that cannot work', async () => {
  run = await launch('record-gone');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  // The Authority answers with an empty list; the chip keeps its own name.
  const chips = page.getByTestId('source-row');
  await expect.poll(() => recordReads().length).toBe(1);
  await page.getByTestId('sources-toggle').click();
  await expect(chips.nth(0)).toHaveText(/^1\s*Approved record 1$/);
  await chips.nth(0).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.getByTestId('source-error')).toHaveText('This is no longer available to you.');
  await expect(pane.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(recordReads()).toHaveLength(2);
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
  await page.getByTestId('sources-toggle').click();
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
  await page.getByTestId('sources-toggle').click();
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

test('Copy answer copies the answer as Markdown and says so, and main takes no more than an answer holds', async () => {
  run = await launch();
  const { page, app } = run;
  const copied = () => app.evaluate(() => (globalThis as { echoTestClipboard?: string }).echoTestClipboard);
  const markdown = 'We agreed to ship Apollo with annual plans first. [1][2]\n\nSources\n\n1. Tuesday sync\n2. Apollo update';
  await askFromHome(page, 'What did we agree?');
  // Its sources numbered and named as the page shows them, once the meeting's record is read.
  await expect(page.getByTestId('sources-toggle')).toHaveText(/Tuesday sync/);
  const copy = page.getByTestId('copy-answer');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await copied()).toBe(markdown);
  await expect(copy).toHaveText('Copy answer');

  // An answer is at most 12,000 characters; the broker refuses more.
  const write = (text: string) => page.evaluate(value =>
    (window as unknown as { echo: { rpc(method: string, params: object): Promise<{ ok: boolean }> } }).echo.rpc('clipboard.writeText', { text: value }),
  text);
  expect(await write('x'.repeat(12_001))).toEqual({ ok: false, failure: { code: 'invalid_request', retryable: false } });
  expect(await copied()).toBe(markdown);
  // Counted in characters: 12,000 that each take two UTF-16 units still fit.
  expect((await write('𝄞'.repeat(12_000))).ok).toBe(true);
});

// Answer layout v1 (ADR-0045): `ask-layout`'s THERM answer, laid out because the Ask asked for it. Until the person
// client sends `x-echo-answer-layout: 1` on every Ask, the fixture answers it as it would an older client.
test.fixme('a laid-out answer reads as a document, and its table scrolls in its own box beside the pane', async () => {
  run = await launch('ask-layout');
  const { page } = run;
  await askFromHome(page, 'Can DVT-R2 run on the reduced test scope?');
  const answer = page.getByTestId('answer');
  await expect(answer).toBeVisible();
  expect(run.calls().filter(call => call.path === '/v7/person/ask').map(call => call.layout)).toEqual(['1']);
  await expect(answer.locator('.answer-lead [data-testid="statement-text"]')).toHaveText(['No, the reduced test scope was rejected.',
    'DVT-R2 retests TC-D-03 and TC-D-01, plus the regression subset QA approves.']);
  await expect(answer.locator('h3')).toHaveText(['Decisions', 'What has to happen first']);
  await expect(answer.locator('.answer-bullets li')).toHaveCount(3);
  await expect(answer.locator('th')).toHaveText(['Action', 'Owner', 'Due', 'Status']);
  const rows = page.getByTestId('answer-row');
  await expect(rows).toHaveCount(4);
  // Only your late row's due date is in the signal colour.
  await expect(answer.locator('td.late')).toHaveCount(1);
  await expect(rows.nth(0).locator('td.late time')).toHaveText('Oct 14');
  await expect(page.getByTestId('coverage-note')).toHaveText(
    'One of three THERM meetings in range was not read before the time limit. Who proposed the reduced scope was not found in the evidence read.');
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^6 sources\s*DVT failure review · Traceability · Gate reviews · TRACE-01 · HW-11 · DVT-R2$/);

  // A row's number opens its ticket beside the answer, lights the row, and opens the sources' rows.
  await rows.nth(0).getByTestId('citation').click();
  await expect(page.getByTestId('source-pane')).toContainText('Jira · Ticket');
  await expect(rows.nth(0)).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('sources-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('source-row').nth(3)).toHaveAttribute('aria-pressed', 'true');
  // Narrowed by the pane, the table scrolls in its own box; the thread and the page never scroll sideways.
  const widths = await page.evaluate(() => {
    const overflow = (element: Element | null) => element === null ? null : element.scrollWidth - element.clientWidth;
    return { table: overflow(document.querySelector('.answer-table')), thread: overflow(document.querySelector('.ask')), page: overflow(document.scrollingElement) };
  });
  expect(widths.table).toBeGreaterThan(0);
  expect(widths.thread).toBe(0);
  expect(widths.page).toBe(0);
});

// Ask progress and internal links v1 (ADR-0039). The fixture streams a search
// of meetings, documents and Jira and five reads (two of Tuesday sync's
// decisions), then waits for `release-ask`.
const opens = () => run.calls().filter(call => call.path === '/v1/person/open').map(call => call.body?.ref);
const progressSteps = (page: Page) => page.getByTestId('ask-steps').getByTestId('ask-step');
/** Opens the Ask's quiet line onto its rows, once it has some. */
async function openLine(page: Page): Promise<void> {
  const line = page.getByTestId('ask-line');
  await expect(line).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
  await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');
}

test('a long Ask shows one quiet line that opens onto what it looks through, names that open beside it while it keeps working, then a receipt', async () => {
  run = await launch('ask-progress');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  const asking = page.getByTestId('asking');
  // The first seconds look as Ask always did.
  await expect(asking).toContainText('Thinking…');
  await expect(page.getByTestId('ask-steps')).toHaveCount(0);
  await expect.poll(() => run.calls().filter(call => call.path === '/v5/person/ask').map(call => call.progress)).toEqual(['1']);

  // Then the line names the step now, and nothing more until it is opened: a place is named once, and the other places counted.
  await expect(page.getByTestId('ask-stage')).toHaveText('Reading Tuesday sync and 3 more', { timeout: 10_000 });
  await expect(page.getByTestId('ask-line')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('ask-steps')).toHaveCount(0);
  // The timer is not read out; a screen reader hears the stage instead.
  await expect(page.getByTestId('ask-timer')).toHaveText(/^\d+s$/);
  await expect(page.getByTestId('ask-timer')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('ask-announcement')).toHaveText('Reading');

  // Opened, every row: source kinds, never the words searched, and every place read, counting its items.
  await openLine(page);
  await expect(progressSteps(page)).toHaveText([
    'Searched meetings, documents and Jira · 3 found', 'Reading Tuesday sync ×2, Apollo update, Tuesday sync transcript, ECHO-7 · Jira launch',
  ]);
  await expect(page.getByTestId('ask-steps').getByTestId('ask-step-name').nth(0)).toHaveAccessibleName('Tuesday sync, 2 items');
  await expect(page.getByTestId('ask-view').locator('[aria-live="off"]')).toHaveCount(1);

  // A name opens beside Ask, and Ask keeps working: both decisions it stands for lit in their meeting, and no Open yet.
  const names = page.getByTestId('ask-steps').getByTestId('ask-step-name');
  await names.nth(0).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane).toContainText('Meeting · Approved record');
  await expect(pane.locator('.record-item.on')).toHaveText([/Keep monthly plans until November\./, /Ship Apollo with annual plans first\./]);
  await expect(names.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.getByTestId('source-open')).toHaveCount(0);
  await expect(asking).toBeVisible();
  // The transcript opens its meeting.
  await names.nth(2).click();
  await expect(pane).toContainText('Meeting · Transcript');
  await expect(pane.locator('h2')).toHaveText('Tuesday sync');
  expect(opens()).toEqual([`meeting:${RECORD}`]);
  await expect(asking).toBeVisible();

  // The answer: the line becomes one receipt above it, still open as the person left it, and the pane, still on the meeting, offers Open.
  writeFileSync(join(run.home, 'release-ask'), '');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(asking).toHaveCount(0);
  const receipt = page.getByTestId('ask-receipt');
  // Its time is the wait the page timed, never the fixture Authority's 48 s of research.
  await expect(receipt).toHaveText(/^Looked through 5 items · \d+s$/);
  await expect(receipt).not.toHaveText(/48s/);
  await expect(receipt).toHaveAttribute('aria-expanded', 'true');
  // Its rows, mounted with the answer, stay out of the thread's live region: a screen reader hears the answer, not the history again.
  await expect(page.getByTestId('receipt-rows')).toHaveAttribute('aria-live', 'off');
  await expect(pane).toContainText('Meeting · Transcript');
  await expect(pane.getByTestId('source-open')).toBeVisible();

  // The receipt lists every search and read the Authority audited, each name opening beside the answer.
  const rows = page.getByTestId('receipt-rows').getByTestId('ask-step');
  await expect(rows).toHaveText(['Searched meetings, documents and Jira · 3 found', 'Read Tuesday sync ×2, Apollo update, Tuesday sync transcript, ECHO-7 · Jira launch']);
  const named = page.getByTestId('receipt-rows').getByTestId('ask-step-name');
  // A ticket opens only in Jira: it has no page here.
  await named.nth(3).click();
  await expect(pane).toContainText('Jira · Ticket');
  await expect(pane.getByTestId('open-ticket-source')).toBeVisible();
  await expect(pane.getByTestId('source-open')).toHaveCount(0);
  // A note's cited passage, then its own page in place of Ask.
  await named.nth(1).click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  await pane.getByTestId('source-open').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('reader-text')).toHaveText('Apollo moves to usage-based pricing tiers from October.');
});

test('an answer that cites your project, a person, a tool and a Jira project opens each by its kind (research tool contract v1)', async () => {
  run = await launch('ask-progress-workspace');
  const { page, app } = run;
  const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
  const permalink = 'https://example.atlassian.net/browse/APOLLO';
  const opened = await captureOpenExternal(app);
  await askFromHome(page, 'Who leads Apollo, and where is its Jira project?');
  // The newest route this Authority has, streamed in progress V3: never /v6 or /v5.
  await expect.poll(() => run.calls().filter(call => call.path === '/v7/person/ask').map(call => call.progress)).toEqual(['3']);
  expect(run.calls().filter(call => call.path === '/v6/person/ask' || call.path === '/v5/person/ask')).toEqual([]);
  // Your projects, people and tools, and Jira's projects, are kinds of source it searched; each item it read is named by its label.
  await expect(page.getByTestId('ask-stage')).toHaveText('Reading Apollo and 3 more', { timeout: 10_000 });
  await openLine(page);
  await expect(progressSteps(page)).toHaveText(['Searched projects, people, tools and Jira · 4 found', 'Reading Apollo, Mina Patel, Jira, Apollo delivery']);

  // A Jira project opens beside Ask, which keeps working: its tool and key, and Open in Jira, never a page of ECHO's.
  const names = page.getByTestId('ask-steps').getByTestId('ask-step-name');
  await names.nth(3).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane).toContainText('Jira · Project');
  await expect(pane.locator('h2')).toHaveText('Apollo delivery');
  await expect(pane.getByTestId('pane-container-meta')).toHaveText('Jira · APOLLO');
  await expect(pane.getByTestId('source-open')).toHaveCount(0);
  await pane.getByTestId('open-container-source').click();
  await expect.poll(opened).toEqual([permalink]);
  // A person is their name alone, with nowhere to go.
  await names.nth(1).click();
  await expect(pane).toContainText('Person');
  await expect(pane.getByTestId('pane-person')).toHaveText('Mina Patel');
  await expect(pane.getByTestId('source-open')).toHaveCount(0);
  await expect(page.getByTestId('asking')).toBeVisible();

  // The answer: each source row names its item, a Jira project with its tool and key; a tool's Open is Tools, in place of Ask.
  writeFileSync(join(run.home, 'release-ask'), '');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await page.getByTestId('sources-toggle').click();
  await expect(page.getByTestId('source-row')).toHaveText([/^1\s*Apollo$/, /^2\s*Mina Patel$/, /^3\s*Jira$/, /^4\s*Apollo delivery\s*Jira · APOLLO$/]);
  await expect(page.getByTestId('ask-receipt')).toHaveText(/^Looked through 4 items · \d+s$/);
  await page.getByTestId('source-row').nth(2).click();
  await expect(pane).toContainText('Tool');
  await expect(pane.getByTestId('pane-tool')).toContainText('Jira');
  await pane.getByTestId('source-open').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('tools')).toBeVisible();

  // Asked again, from Tools: a project's Open is the project, from its sidebar row, as the sidebar opens it.
  await page.getByTestId('ask-field').fill('Who leads Apollo?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('answer')).toBeVisible();
  await page.getByTestId('sources-toggle').click();
  await page.getByTestId('source-row').nth(0).click();
  await expect(pane).toContainText('Project');
  await expect(pane.getByTestId('pane-project')).toHaveText('Apollo');
  await pane.getByTestId('source-open').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('scope-chip')).toHaveText('Apollo');
  await expect.poll(() => run.calls().filter(call => call.path === '/v1/person/list').map(call => call.body?.project_id)).toContain(APOLLO);
  expect(run.calls().filter(call => call.path === '/v7/person/ask')).toHaveLength(2);
});

test('an Ask that only listed rows says it looked through every row, and its receipt opens onto its searches alone (ADR-0043)', async () => {
  run = await launch('ask-progress-listed');
  const { page } = run;
  await askFromHome(page, 'Which Jira tickets are open?');
  await expect.poll(() => run.calls().filter(call => call.path === '/v7/person/ask').map(call => call.progress)).toEqual(['3']);
  // Jira's 30 rows came as a page of 25, then the other 5: one search, as a person reads it.
  await openLine(page);
  await expect(progressSteps(page)).toHaveText(['Searched Jira · 30 found']);

  // Nothing was read in full, and the receipt still counts all 30 rows it looked through, with no line about names.
  writeFileSync(join(run.home, 'release-ask'), '');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.getByTestId('ask-receipt')).toHaveText(/^Looked through 30 items · \d+s$/);
  await expect(page.getByTestId('receipt-rows').getByTestId('ask-step')).toHaveText(['Searched Jira · 30 found']);
});

test('an opened line\'s new row follows a person at the bottom of Ask, and never pulls one who scrolled up back down', async () => {
  run = await launch('ask-progress');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  await openLine(page);
  await expect(progressSteps(page)).toHaveCount(2);
  writeFileSync(join(run.home, 'release-ask'), '');
  await expect(page.getByTestId('answer')).toBeVisible();
  // A follow-up that waits again, under an earlier answer tall enough to scroll. Its line starts closed.
  rmSync(join(run.home, 'release-ask'));
  await page.getByTestId('ask-field').fill('And the pricing page?');
  await page.getByTestId('ask-field').press('Enter');
  await page.getByTestId('earlier-turn').evaluate(element => { (element as HTMLElement).style.minHeight = '2000px'; });
  const view = page.getByTestId('ask-view');
  const fromBottom = () => view.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  await openLine(page);
  await expect(progressSteps(page)).toHaveCount(2);
  expect(await view.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1_000);
  // At the bottom, the rows the line opened onto are followed.
  await expect.poll(fromBottom).toBeLessThan(2);

  // Scrolled up to read the earlier answer, a new row leaves the view where the person put it.
  await view.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => view.evaluate(element => element.scrollTop)).toBe(0);
  writeFileSync(join(run.home, 'more-steps'), '');
  await expect(progressSteps(page)).toHaveCount(3);
  await expect(progressSteps(page).last()).toHaveText('Searched Jira · nothing new');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await view.evaluate(element => element.scrollTop)).toBe(0);

  // The answer itself still brings the view down to it.
  writeFileSync(join(run.home, 'release-ask'), '');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await expect.poll(fromBottom).toBeLessThan(2);
});

test('a quick Ask shows nothing more, and its source opens the cited decision lit in its meeting, then the meeting\'s page', async () => {
  run = await launch('ask-progress-quick');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.getByTestId('ask-receipt')).toHaveCount(0);
  await page.getByTestId('sources-toggle').click();
  await page.getByTestId('source-row').nth(0).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.locator('.record-item.on')).toHaveCount(1);
  await expect(pane.locator('.record-item.on')).toContainText('Ship Apollo with annual plans first.');
  // Lit by more than colour: a screen reader hears which item is cited, and only that one.
  await expect(pane.locator('.record-item.on')).toHaveText(/^Cited: Ship Apollo with annual plans first\./);
  await expect(pane.getByTestId('record').getByText('Cited:')).toHaveCount(1);
  await pane.getByTestId('source-open').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  const reader = page.getByTestId('reader');
  await expect(reader.locator('h1')).toHaveText('Tuesday sync');
  // Its page lights the very decision the pane lit, the meeting's second, though the page's record carries no atom ids.
  const decisions = reader.getByTestId('record-decisions').locator('.record-item');
  await expect(decisions).toHaveCount(2);
  await expect(decisions.nth(1)).toHaveClass(/\bon\b/);
  await expect(reader.locator('.record-item.on')).toHaveCount(1);
  await expect(reader.locator('.record-item.on')).toHaveText(/^Cited: Ship Apollo with annual plans first\./);
  expect(opens()).toEqual([`meeting:${RECORD}`]);
});

test('an empty bar offers what to ask once you go to it: Up lights one, Return asks it, Escape only closes them, and typing hides them', async () => {
  run = await launch();
  const { page } = run;
  const field = page.getByTestId('ask-field');
  const offered = page.getByTestId('suggestions');
  const suggestions = page.getByTestId('suggestion');
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  // The caret only waiting in the bar offers nothing.
  await expect(offered).toHaveCount(0);

  // In a project, a click on the empty bar offers its questions; Escape closes them and the page stays.
  await page.getByTestId('sidebar-project').first().click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await field.click();
  await expect(offered).toContainText('Try asking');
  await expect(suggestions.last()).toHaveText(/\?$/);
  const count = await suggestions.count();
  expect(count).toBeGreaterThanOrEqual(1);
  expect(count).toBeLessThanOrEqual(3);
  await field.press('Escape');
  await expect(offered).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('Apollo');

  // Up goes into them from the bar, to the row nearest it; Return asks it in the project.
  await field.press('ArrowUp');
  await expect(suggestions.last()).toHaveAttribute('aria-selected', 'true');
  await expect(field).toHaveAttribute('aria-activedescendant', `ask-suggestion-${count - 1}`);
  const chosen = (await suggestions.last().textContent())!;
  await field.press('Enter');
  await expect(page.getByTestId('question')).toHaveText(chosen);
  await expect.poll(questions).toEqual([chosen]);
  await expect(offered).toHaveCount(0);

  // Back on the project, what was asked there comes first; typing hides the suggestions.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await field.click();
  await expect(suggestions.first()).toHaveText(chosen);
  await field.pressSequentially('sh');
  await expect(offered).toHaveCount(0);
});
