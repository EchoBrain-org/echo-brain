// The Ask timeline (ADR-0047), in the real app with the fixture Authority:
// kept on this computer through navigation, earlier turns folded to lines
// that open as they were, what changed lit, Ask again with "Since", follow-ups
// resolved or asked "Which one?", and a project's dot with its New rows.
import { expect, test, type Page } from '@playwright/test';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

/** The Ask requests the person client sent to `/v7`, Ask's one route, with what each carried. */
const asks = () => run.calls().filter(call => call.path === '/v7/person/ask').map(call => call.body ?? {});

/** A question from the bar, answered: with Ask open it continues the conversation; from a page it opens Ask. */
async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
  // Answered: the newest turn in full is this one, and nothing is on its way.
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText(question);
  await expect(page.getByTestId('asking')).toHaveCount(0);
}

/** Back from Ask to the page it was opened over. */
async function back(page: Page): Promise<void> {
  await page.getByTestId('back').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
}

test('the timeline stays through navigation, on this computer only, and the bar reopens a question you asked at its turn', async () => {
  run = await launch();
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'What did we agree?');
  await back(page);
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await ask(page, 'What is left in Apollo?');
  // The turn Ask opened on stays in full, with the one asked now.
  await expect(page.getByTestId('question')).toHaveText(['What did we agree?', 'What is left in Apollo?']);
  await expect(page.getByTestId('timeline-row')).toHaveCount(0);
  await page.getByTestId('sidebar-home').click();
  await ask(page, 'Who approved it?');
  // An earlier day's turns are lines; this one folds as a line too, with no scope line or date under any question.
  const rows = page.getByTestId('timeline-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.getByTestId('timeline-question')).toHaveText('What did we agree?');
  await expect(rows).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('question')).toHaveText(['What is left in Apollo?', 'Who approved it?']);
  await expect(page.getByTestId('ask-view')).not.toContainText('All accessible context');
  // A line opens its answer as it was.
  await rows.click();
  await expect(rows).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('opened-turn')).toContainText('We agreed to ship Apollo with annual plans first.');
  await expect(page.getByTestId('opened-turn').getByTestId('ask-again')).toBeVisible();
  // Every question went alone: none carried an earlier turn from a page.
  expect(asks().map(body => 'previous' in body)).toEqual([false, false, false]);
  // Kept in one owner-only file for the account, beside the session.
  const folder = join(run.home, '.local', 'share', 'echo-brain', 'person', 'ask-timeline-v1');
  const files = readdirSync(folder);
  expect(files).toHaveLength(1);
  expect(statSync(folder).mode & 0o777).toBe(0o700);
  expect(statSync(join(folder, files[0]!)).mode & 0o777).toBe(0o600);

  // The empty bar suggests what you asked, newest first; one opens Ask at its turn without asking again.
  await back(page);
  await page.getByTestId('ask-field').click();
  const suggestions = page.getByTestId('suggestion');
  await expect(suggestions.first()).toHaveText('Who approved it?');
  await expect(page.locator('[data-testid="suggestion"][data-asked="true"]')).toHaveText(['Who approved it?', 'What did we agree?']);
  await page.locator('[data-testid="suggestion"]', { hasText: 'What did we agree?' }).click();
  await expect(page.getByTestId('opened-turn')).toContainText('We agreed to ship Apollo with annual plans first.');
  expect(asks()).toHaveLength(3);
});

test('a line tagged Changed opens with what changed lit and what you can no longer read left out', async () => {
  run = await launch('ask-timeline-changed');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'What is open on THERM?');
  await back(page);
  await ask(page, 'What else?');
  await back(page);
  await ask(page, 'Anything new?');
  // Opening Ask checked the newest turns' sources in one read: the DVT plan changed, the follow-up is no longer yours.
  const row = page.getByTestId('timeline-row').filter({ hasText: 'What is open on THERM?' });
  await expect(row.getByTestId('changed-tag')).toHaveText('Changed');
  await row.click();
  const opened = page.getByTestId('opened-turn');
  await expect(opened.getByTestId('statement-text')).toHaveText(['THERM-482, Sensor drift, is open.', 'The DVT plan moved the retest to Oct 30.']);
  await expect(opened.locator('[data-mark="changed"]')).toHaveText(/The DVT plan moved the retest to Oct 30\./u);
  // What you can no longer read is gone from its sources too, and the rest keep the numbers its sentences show.
  await expect(opened).not.toContainText('Confirm the trace');
  await expect(opened.getByTestId('sources-toggle')).toHaveText(/^2 sources\s*THERM-482 · DVT plan$/u);
  await expect(opened.getByTestId('citation')).toHaveText(['1', '2']);
  await expect(opened.getByTestId('again-note')).toHaveText(/^Highlighted parts changed since \d{1,2}:\d{2}\s?(AM|PM)$/u);
  const checks = run.calls().filter(call => call.path === '/v1/person/ask/check');
  expect(checks.length).toBeGreaterThan(0);
  expect(JSON.stringify(checks.map(call => call.body))).not.toContain('Sensor drift');
});

test('Ask again asks the same question with its turn, and the new answer opens with what is different since', async () => {
  run = await launch('ask-timeline');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'What is open on THERM?');
  await back(page);
  await page.getByTestId('ask-field').click();
  await page.getByTestId('suggestion').filter({ hasText: 'What is open on THERM?' }).click();
  // The latest turn, asked before this Ask: in full, with Ask again and what the check found.
  const turn = page.getByTestId('turn').filter({ hasText: 'What is open on THERM?' });
  await expect(turn.getByTestId('again-note')).toHaveText(/^Nothing changed since /u);
  await turn.getByTestId('ask-again').click();
  await expect(page.getByTestId('asking')).toHaveCount(0);
  const since = page.getByTestId('since');
  await expect(since).toContainText(/^Since \d{1,2}:\d{2}\s?(AM|PM)/u);
  await expect(since.getByTestId('since-text')).toHaveText(['THERM-482 moved to In Progress.']);
  await expect(since.getByTestId('citation')).toHaveText(['1']);
  const [, again] = asks();
  expect(again).toMatchObject({ question: 'What is open on THERM?', previous: { purpose: 'ask_again', question: 'What is open on THERM?' } });
});

test('a follow-up about the one ticket an answer named is answered at once, and its line later reads the full question', async () => {
  run = await launch('ask-timeline');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'What is open on THERM-482?');
  await ask(page, 'who owns it?');
  await expect(page.getByTestId('question').last()).toHaveText('who owns it?');
  await expect(page.getByTestId('turn').last().getByTestId('statement-text')).toHaveText('Dev owns THERM-482, since Oct 21.');
  const [, followUp] = asks();
  expect(followUp).toMatchObject({ question: 'who owns it?', previous: { purpose: 'follow_up', question: 'What is open on THERM-482?' } });
  expect((followUp!.previous as { citations: { label: string }[] }).citations.map(citation => citation.label)).toEqual(['THERM-482 · Sensor drift']);
  await back(page);
  await ask(page, 'What else?');
  await back(page);
  await ask(page, 'Anything more?');
  await expect(page.getByTestId('timeline-question')).toContainText(['Who owns THERM-482?']);
});

test('a follow-up that could mean two tickets asks which one, and a choice asks its full question with the same turn', async () => {
  run = await launch('ask-timeline');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'What is open on DVT?');
  await page.getByTestId('ask-field').fill('who owns that ticket?');
  await page.getByTestId('ask-field').press('Enter');
  const clarify = page.getByTestId('clarify');
  await expect(clarify).toContainText('Which one?');
  await expect(clarify.getByTestId('choice')).toHaveText(['THERM-482 · Sensor drift', 'THERM-490 · DVT retest']);
  await clarify.getByTestId('choice').nth(1).click();
  await expect(page.getByTestId('clarify')).toHaveCount(0);
  await expect(page.getByTestId('question').last()).toHaveText('Who owns THERM-490?');
  await expect(page.getByTestId('turn').last().getByTestId('statement-text')).toHaveText('Dev owns THERM-490, since Oct 21.');
  const [, which, chosen] = asks();
  expect(chosen).toMatchObject({ question: 'Who owns THERM-490?', previous: which!.previous });
});

test('a project with something new from someone else has a dot until you open it, and its new row says New for that visit', async () => {
  run = await launch('project-activity');
  const { page, app } = run;
  const apollo = page.getByTestId('sidebar-project').nth(0);
  await expect(apollo).toHaveText(/Apollo$/u);
  // Seen for the first time: no dot.
  await expect.poll(() => run.calls().filter(call => call.path === '/v1/person/project-activity').length).toBeGreaterThan(0);
  await expect(page.getByTestId('project-news')).toHaveCount(0);
  // Mina adds a note to Apollo; the next check reads it.
  writeFileSync(join(run.home, 'activity-arrived'), '');
  await emit(app, 'echo-test:wake');
  await expect(apollo.getByTestId('project-news')).toHaveCount(1);
  await expect(page.getByTestId('sidebar-project').nth(1).getByTestId('project-news')).toHaveCount(0);
  await apollo.click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await expect(page.getByTestId('project-news')).toHaveCount(0);
  const fresh = page.getByTestId('feed-row').filter({ hasText: 'Launch checklist v2' });
  await expect(fresh.getByTestId('item-new')).toHaveText('New');
  await expect(page.getByTestId('item-new')).toHaveCount(1);
  // The next visit: nothing new since.
  await page.getByTestId('sidebar-home').click();
  await apollo.click();
  await expect(page.getByTestId('feed-row').filter({ hasText: 'Launch checklist v2' })).toHaveCount(1);
  await expect(page.getByTestId('item-new')).toHaveCount(0);
});
