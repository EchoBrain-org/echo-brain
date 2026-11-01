import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
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
  await expect.poll(() => run.calls().filter(call => call.path === '/v7/person/ask').map(call => call.progress)).toEqual(['3']);

  // Then the line names the step now, and nothing more until it is opened: a place is named once, and the other places counted.
  await expect(page.getByTestId('ask-stage')).toHaveText('Reading Tuesday sync and 2 more', { timeout: 10_000 });
  await expect(page.getByTestId('ask-line')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('ask-steps')).toHaveCount(0);
  // The timer is not read out; a screen reader hears the stage instead.
  await expect(page.getByTestId('ask-timer')).toHaveText(/^\d+s$/);
  await expect(page.getByTestId('ask-timer')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('ask-announcement')).toHaveText('Reading');

  // Opened, every row: source kinds, never the words searched, and every place read, counting its items.
  await openLine(page);
  await expect(progressSteps(page)).toHaveText([
    'Searched meetings, documents and Jira · 3 found', 'Reading Tuesday sync ×2, Apollo update, ECHO-7 · Jira launch',
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

  // The answer: the line goes, and the one line under the answer says how many sources and how long it took (ADR-0049). The pane,
  // still on the meeting, offers Open.
  writeFileSync(join(run.home, 'release-ask'), '');
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(asking).toHaveCount(0);
  const foot = page.getByTestId('sources-toggle');
  // Its time is the wait the page timed, never the fixture Authority's 48 s of research.
  await expect(foot).toHaveText(/^2 sources · \d+s$/);
  await expect(foot).not.toHaveText(/48s/);
  await expect(foot).toHaveAttribute('aria-expanded', 'false');
  await expect(pane).toContainText('Meeting · Approved record');
  await expect(pane.getByTestId('source-open')).toBeVisible();

  // Opened: its sources, then every search and read the Authority audited, each name opening beside the answer. The rows stay out of
  // the thread's live region: a screen reader hears the answer, not the history again.
  await foot.click();
  await expect(page.getByTestId('source-row')).toHaveCount(2);
  await expect(page.locator('.foot-trail-head')).toHaveText('Looked through 4 items');
  await expect(page.getByTestId('receipt-rows')).toHaveAttribute('aria-live', 'off');
  const rows = page.getByTestId('receipt-rows').getByTestId('ask-step');
  await expect(rows).toHaveText(['Searched meetings, documents and Jira · 3 found', 'Read Tuesday sync ×2, Apollo update, ECHO-7 · Jira launch']);
  const named = page.getByTestId('receipt-rows').getByTestId('ask-step-name');
  // A ticket opens only in Jira: it has no page here.
  await named.nth(2).click();
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
