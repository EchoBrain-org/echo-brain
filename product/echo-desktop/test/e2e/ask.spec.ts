import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';
import { captureOpenExternal } from './native.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const RECORD = `sha256:${'5'.repeat(64)}`;
const recordReads = () => run.calls().filter(call => call.method === 'GET' && call.path === '/v1/person/records');
const evidenceReads = () => run.calls().filter(call => call.path === '/v2/person/ask/source');

async function askFromHome(page: Page, question: string): Promise<void> {
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
}

test('global Ask reads Jira live and opens its ticket citation', async () => {
  run = await launch('ask-ticket');
  const { page, app } = run;
  const question = 'Open one Jira ticket I can access and tell me its title.';
  const permalink = 'https://example.atlassian.net/browse/ECHO-7';
  const opened = await captureOpenExternal(app);
  await askFromHome(page, question);
  await expect(page.getByTestId('answer')).toBeVisible();
  expect(run.calls().filter(call => call.path.endsWith('/person/ask')).map(call => ({ path: call.path, body: call.body })))
    .toEqual([{ path: '/v7/person/ask', body: { schema_version: 3, question } }]);
  await expect(page.getByTestId('statement-text')).toHaveText('ECHO-7 is titled Jira launch.');
  // No lock in the answer: ECHO reads the ticket with your own access (ADR-0049).
  await expect(page.getByTestId('answer').getByRole('img', { name: /only you/i })).toHaveCount(0);
  // The sources start as the one quiet line under the answer; it opens onto their rows (ADR-0045, ADR-0049).
  const sources = page.getByTestId('sources-toggle');
  await expect(sources).toHaveText(/^1 source$/);
  await expect(sources).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('source-row')).toHaveCount(0);
  await sources.click();
  await expect(sources).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('source-row')).toHaveText(/^1\s*ECHO-7 · Jira launch$/);
  await expect(page.getByTestId('source-lock')).toHaveCount(0);
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

test('an approved record opens beside the answer: who approved it, who was there, who can read it, and what was approved', async () => {
  run = await launch();
  const { page, app } = run;
  await askFromHome(page, 'What did we agree?');
  await expect(page.getByTestId('answer')).toBeVisible();
  // The record is read once, so its row names the meeting once the sources' line opens.
  const chips = page.getByTestId('source-row');
  await expect(page.getByTestId('sources-toggle')).toHaveText(/^2 sources$/);
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
  await expect(record).toContainText('VisibilityVisible to project members');
  await expect(record.getByTestId('record-decisions')).toContainText('Ship Apollo with annual plans first.“Annual plans first, monthly after launch.”');
  await expect(record.getByTestId('record-actions')).toContainText('Maya updates the pricing page.');
  await expect(record.getByTestId('record-rationales')).toContainText('Annual plans fund the launch.');
  await expect(pane).not.toContainText('private@example.test');
  await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
  expect(recordReads()).toHaveLength(1);

  // The original's verified evidence, in the same pane.
  await chips.nth(1).click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  await expect(pane.getByTestId('source-review-state')).toHaveCount(0);
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

test('a saved imported-note citation opens with a neutral title and refreshes its review badge without changing the citation', async () => {
  run = await launch('ask-imported-meeting');
  const { page } = run;
  const question = 'What do the pilot notes say?';
  await askFromHome(page, question);
  await expect(page.getByTestId('answer')).toBeVisible();
  const folder = join(run.home, '.local', 'share', 'echo-brain', 'person', 'ask-timeline-v1');
  let files: string[] = [];
  await expect.poll(() => { files = existsSync(folder) ? readdirSync(folder) : []; return files; }).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/u)]);
  expect(readFileSync(join(folder, files[0]!), 'utf8')).toContain('Imported meeting (unapproved): Pilot');
  // Open that saved answer from Home; opening a citation uses the current proof, not its saved label.
  await page.keyboard.press('Escape');
  await page.getByTestId('ask-field').click();
  await page.getByTestId('suggestion').filter({ hasText: question }).click();
  await page.getByTestId('citation').click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.locator('h2')).toHaveText('Imported meeting: Pilot');
  await expect(pane.getByTestId('source-review-state')).toHaveText('Not reviewed yet');
  await expect(pane.getByTestId('evidence-text')).toHaveText('The notes propose shipping the pilot.');
  await expect(pane).not.toContainText('(unapproved)');
  await expect(pane.getByTestId('source-error')).toHaveCount(0);
  const originalCitation = evidenceReads()[0]!.body!.citation;
  // The fixture records a completed review elsewhere. Reopening reads it afresh through the real client.
  writeFileSync(join(run.home, 'imported-reviewed'), '');
  await pane.getByTestId('source-close').click();
  await page.getByTestId('citation').click();
  await expect(pane.getByTestId('source-review-state')).toHaveText('Reviewed');
  await expect(pane.locator('h2')).toHaveText('Imported meeting: Pilot');
  await expect(pane.getByTestId('evidence-text')).toHaveText('The notes propose shipping the pilot.');
  await expect(pane).not.toContainText('(unapproved)');
  expect(evidenceReads().map(call => call.body!.citation)).toEqual([originalCitation, originalCitation]);
});

test('one source pane keeps review badges with their exact revisions while loading and when reviewed and unreviewed notes are cited together', async () => {
  run = await launch('ask-imported-mixed', { 'hold-imported-newer': '' });
  const { page } = run;
  await askFromHome(page, 'What do the pilot notes say?');
  await page.getByTestId('citation').click();
  const pane = page.getByTestId('source-pane');
  await expect(pane.getByTestId('evidence-text')).toHaveText('The notes propose shipping the pilot.');
  await expect(pane.getByTestId('source-review-state')).toHaveText('Reviewed');
  await expect(pane.getByTestId('source-review-summary')).toHaveCount(0);
  await expect(pane).toContainText('Loading verified evidence…');
  unlinkSync(join(run.home, 'hold-imported-newer'));
  await expect(pane.getByTestId('evidence-text')).toHaveText(['The notes propose shipping the pilot.', 'The updated notes defer the pilot.']);
  await expect(pane.getByTestId('source-review-state')).toHaveText(['Reviewed', 'Not reviewed yet']);
  await expect(pane.getByTestId('source-review-summary')).toHaveCount(0);
  await expect(pane.locator('h2')).toHaveText('Imported meeting: Pilot');
  await expect(pane).not.toContainText('(unapproved)');
  expect(evidenceReads().map(call => (call.body!.citation as { revision_id: string }).revision_id)).toEqual(['rev-1', 'rev-2']);
});

test('Copy answer copies the answer as Markdown and says so, and main takes no more than an answer holds', async () => {
  run = await launch();
  const { page, app } = run;
  const copied = () => app.evaluate(() => (globalThis as { echoTestClipboard?: string }).echoTestClipboard);
  const markdown = 'We agreed to ship Apollo with annual plans first. [1][2]\n\nSources\n\n1. Tuesday sync\n2. Apollo update';
  await askFromHome(page, 'What did we agree?');
  // Its sources numbered and named as the page shows them, once the meeting's record is read.
  await expect.poll(() => recordReads().length).toBe(1);
  // On the line under the answer, it shows while the pointer is on the turn (ADR-0049).
  const copy = page.getByTestId('copy-answer');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await copied()).toBe(markdown);
  await expect(copy).toHaveText('Copy');

  // An answer is at most 12,000 characters; the broker refuses more.
  const write = (text: string) => page.evaluate(value =>
    (window as unknown as { echo: { rpc(method: string, params: object): Promise<{ ok: boolean }> } }).echo.rpc('clipboard.writeText', { text: value }),
  text);
  expect(await write('x'.repeat(12_001))).toEqual({ ok: false, failure: { code: 'invalid_request', retryable: false } });
  expect(await copied()).toBe(markdown);
  // Counted in characters: 12,000 that each take two UTF-16 units still fit.
  expect((await write('𝄞'.repeat(12_000))).ok).toBe(true);
});

// What each block draws, the numbers each item keeps and how Copy answer writes them are ask-blocks.test's and
// answer.test's; here, that every kind of block reaches the real window through the client and host, and that it never
// scrolls sideways.
test('an answer the writer arranged in blocks draws every block in the window, and the page never scrolls sideways', async () => {
  run = await launch('ask-blocks');
  const { page } = run;
  await askFromHome(page, 'Can THERM start PVT?');
  const answer = page.getByTestId('answer');
  await expect(answer.locator('.answer-lead').getByTestId('statement-text')).toHaveText('Yes, PVT can start: the 72-hour soak passed on Oct 23.');
  await expect(answer.locator('h3.answer-heading')).toHaveText(['Soak test', 'Before PVT', 'Open risk']);
  for (const block of ['.answer-table', '.answer-timeline', '.answer-card', 'ol.answer-steps', '.answer-quote']) await expect(answer.locator(block).first()).toBeVisible();
  // A table keeps its own box.
  expect(await page.evaluate(() => document.querySelector('.ask')!.scrollWidth <= document.querySelector('.ask')!.clientWidth)).toBe(true);
});
test('a long Ask shows one quiet line that names what it looks through while it works, then how many sources and how long', async () => {
  run = await launch('ask-progress');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  const asking = page.getByTestId('asking');
  // The first seconds look as Ask always did.
  await expect(asking).toContainText('Thinking…');
  await expect.poll(() => run.calls().filter(call => call.path === '/v7/person/ask').length).toBe(1);

  // Then the line names the step now, and opens onto nothing: a place is named once, and the other places counted.
  await expect(page.getByTestId('ask-stage')).toHaveText('Reading Tuesday sync and 2 more', { timeout: 10_000 });
  await expect(asking.getByRole('button')).toHaveText(['Cancel']);
  // The timer is not read out; a screen reader hears the stage instead.
  await expect(page.getByTestId('ask-timer')).toHaveText(/^\d+s$/);
  await expect(page.getByTestId('ask-timer')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('ask-announcement')).toHaveText('Reading');
  await expect(page.getByTestId('ask-view').locator('[aria-live="off"]')).toHaveCount(1);

  // The answer: the line goes, and the one line under the answer says how many sources and how long it took (ADR-0049).
  writeFileSync(join(run.home, 'release-ask'), '');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(asking).toHaveCount(0);
  const foot = page.getByTestId('sources-toggle');
  // Its time is the wait the page timed, never the fixture Authority's 48 s of research.
  await expect(foot).toHaveText(/^2 sources · \d+s$/);
  await expect(foot).not.toHaveText(/48s/);
  await expect(foot).toHaveAttribute('aria-expanded', 'false');

  // Opened: its sources, and nothing of what it searched or read. A row opens beside the answer: the meeting with the decision the
  // answer cites lit, then the note's cited passage, and its own page in place of Ask.
  await foot.click();
  const rows = page.getByTestId('source-row');
  await expect(rows).toHaveText([/^1\s*Tuesday sync$/, /^2\s*Apollo update$/]);
  await expect(page.getByTestId('turn-foot')).not.toContainText(/Looked through|Searched|Jira launch/u);
  await rows.nth(0).click();
  const pane = page.getByTestId('source-pane');
  await expect(pane).toContainText('Meeting · Approved record');
  await expect(pane.locator('.record-item.on')).toHaveText([/Ship Apollo with annual plans first\./]);
  await expect(pane.getByTestId('source-open')).toBeVisible();
  await rows.nth(1).click();
  await expect(pane.getByTestId('evidence-text')).toHaveText('We agreed to ship.');
  await pane.getByTestId('source-open').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('reader-text')).toHaveText('Apollo moves to usage-based pricing tiers from October.');
});

test('Cancel stops a long Ask in the client, so the Authority stops researching and no answer comes', async () => {
  run = await launch('ask-progress');
  const { page } = run;
  await askFromHome(page, 'What did we agree?');
  await expect(page.getByTestId('ask-stage')).toHaveText('Reading Tuesday sync and 2 more', { timeout: 10_000 });
  await page.getByTestId('ask-cancel').click();
  // Asked from Home with nothing before it, Ask closes.
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  // The host stopped the client's request: the Authority saw it end before answering, and the run ended without an answer.
  await expect.poll(() => existsSync(join(run.home, 'ask-stopped'))).toBe(true);
  expect(readFileSync(join(run.home, 'ask-stopped'), 'utf8')).toBe('What did we agree?');
  const runs = () => readFileSync(join(run.userData, 'logs', 'desktop.log'), 'utf8').match(/ask\.run \S+/g) ?? [];
  await expect.poll(runs).toHaveLength(1);
  expect(runs()).not.toEqual(['ask.run ok']);
});
