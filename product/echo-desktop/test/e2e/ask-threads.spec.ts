// Ask threads (ADR-0056), in the real app with the fixture Authority, whose `ask-threads` mode places a question among the
// threads its request carries: one thread on the page under its name, the list of them all, a jump, a merge and its Undo
// on this computer's file, a question that belongs elsewhere asked again where it belongs, "Which one?" between threads,
// and what of the threads a request carries.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
/** What the fixture's follow-up answers name as their question: a resolver's rewrite, which no one typed. */
const RESOLVED = 'Resolved:';

/** The Ask requests the person client sent to `/v7`, Ask's one route, with what each carried. */
const asks = () => run.calls().filter(call => call.path === '/v7/person/ask').map(call => call.body ?? {});

/** The account's Ask timeline as this computer's file holds it: each turn's typed words, id and thread. */
function file(): { id: string; text: string; thread?: string }[] {
  const folder = join(run.home, '.local', 'share', 'echo-brain', 'person', 'ask-timeline-v1');
  const [name] = existsSync(folder) ? readdirSync(folder).filter(each => each.endsWith('.json')) : [];
  return name === undefined ? [] : (JSON.parse(readFileSync(join(folder, name), 'utf8')) as { turns: { id: string; text: string; thread?: string }[] }).turns;
}
/** Which thread each question is filed in, by the question that started the thread. */
function filed(): Record<string, string | undefined> {
  const turns = file();
  return Object.fromEntries(turns.map(turn => [turn.text, turns.find(first => first.id === turn.thread)?.text]));
}

/** A question from the bar, answered in the thread Ask then shows: its turn is the newest in full, and nothing is on its way. */
async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText(question);
  await expect(page.getByTestId('asking')).toHaveCount(0);
}

/** Back from Ask to the page it was opened over. */
async function back(page: Page): Promise<void> {
  await page.getByTestId('back').click();
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
}

/** A question asked from Home's page, which starts or finds its thread. */
async function askAtHome(page: Page, question: string): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await ask(page, question);
}

/** A question asked from Apollo's page. */
async function askInApollo(page: Page, question: string): Promise<void> {
  await page.getByTestId('sidebar-project').nth(0).click();
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  await ask(page, question);
}

/** A picture of the window in each theme, kept only when ECHO_SCREENSHOTS names a folder for them. */
async function picture(page: Page, name: string): Promise<void> {
  const folder = process.env.ECHO_SCREENSHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: join(folder, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: null });
}

test('Ask shows one thread under its name; the name opens the list of them all, by home, and a row jumps to its thread at its place', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await expect(page.getByTestId('thread-name')).toHaveText('Who owns billing?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // A new subject: its own thread, alone on the page.
  await expect(page.getByTestId('thread-name')).toHaveText('When does the pilot start?');
  await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?']);
  await back(page);
  await askInApollo(page, 'Which tests fail?');
  // Each carried the threads it could be placed in, a list that goes even when empty. A project Ask carries only that
  // project's (R3): Apollo had none, so its list is empty though Home has two. Home's carried Home's.
  expect(asks().map(body => body.threads)).toEqual([[], [{ questions: ['Who owns billing?'], asked_at: expect.any(String) }], []]);
  expect(asks().map(body => 'previous' in body)).toEqual([false, false, false]);
  expect(asks()[2]).toMatchObject({ question: 'Which tests fail?', project_id: APOLLO });

  // The list: the open thread's home first, then no project, the newest first in each; the open one marked.
  const name = page.getByTestId('thread-name');
  const list = page.getByTestId('thread-list');
  const rows = list.getByTestId('thread-row');
  await name.click();
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByTestId('thread-group')).toHaveText(['Apollo', 'No project']);
  await expect(rows.locator('.name')).toHaveText(['Which tests fail?', 'When does the pilot start?', 'Who owns billing?']);
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(list.getByTestId('thread-find')).toBeFocused();
  // No merge crosses homes (R9): the open thread is Apollo's only one, so no row offers Merge.
  await expect(list.getByTestId('thread-merge')).toHaveCount(0);
  await picture(page, 'ask-thread-list');
  // Find a thread, by any question typed in it, in any case.
  await list.getByTestId('thread-find').fill('PILOT');
  await expect(rows.locator('.name')).toHaveText(['When does the pilot start?']);
  await expect(list.getByTestId('thread-group')).toHaveText(['No project']);
  // Escape closes the list and nothing else; so does a click elsewhere.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  await expect(name).toBeFocused();
  await name.click();
  await expect(list).toBeVisible();
  await page.getByTestId('ask-field').click();
  await expect(list).toHaveCount(0);
  // The open thread's row does nothing.
  await name.click();
  await rows.nth(0).click();
  await expect(list).toBeVisible();
  await expect(name).toHaveText('Which tests fail?');
  // The arrow keys move through the rows, and Return jumps: to the pilot's thread, at Home, where the bar asks all context.
  await page.keyboard.press('Escape');
  await name.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(name).toHaveText('When does the pilot start?');
  await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?']);
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  // From a thread with no project, only the other thread with no project offers Merge: Apollo's row has none.
  await name.click();
  await expect(list.locator('.thread-item').filter({ has: page.getByTestId('thread-merge') }).locator('.name')).toHaveText(['Who owns billing?']);
  // A click jumps to Apollo's thread, on Apollo's page: the chip names it, and a question typed there is asked in Apollo.
  await rows.filter({ hasText: 'Which tests fail?' }).click();
  await expect(name).toHaveText('Which tests fail?');
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');
  await ask(page, 'and who fixes them?');
  expect(asks().at(-1)).toMatchObject({ question: 'and who fixes them?', project_id: APOLLO, previous: { purpose: 'follow_up', question: 'Which tests fail?' } });
  // Still only Apollo's other threads ride on it, and it has none: nothing from Home does.
  expect(asks().at(-1)!.threads).toEqual([]);
  await expect.poll(filed).toEqual({ 'Who owns billing?': 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?',
    'Which tests fail?': 'Which tests fail?', 'and who fixes them?': 'Which tests fail?' });
  // With the bar widened by ×, Apollo's page asks all context, and is still not where a thread with no project lives: a
  // jump to one puts Home under Ask.
  await page.getByTestId('scope-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await name.click();
  await rows.filter({ hasText: 'Who owns billing?' }).click();
  await expect(name).toHaveText('Who owns billing?');
  await back(page);
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('sidebar-home')).toHaveAttribute('aria-current', 'page');
});

test('Merge joins a thread to the open one in this computer\'s file, and Undo puts it back', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  await expect.poll(filed).toEqual({ 'Who owns billing?': 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?' });
  await page.getByTestId('thread-name').click();
  const billing = page.getByTestId('thread-list').locator('.thread-item').filter({ hasText: 'Who owns billing?' });
  // Merge shows on the row the pointer is on; the open thread's own row has none.
  await expect(page.getByTestId('thread-merge')).toHaveCount(1);
  await billing.hover();
  await expect(billing.getByTestId('thread-merge')).toHaveCSS('opacity', '1');
  await expect(billing.getByTestId('thread-merge')).toHaveAccessibleName('Merge into this thread');
  await picture(page, 'ask-thread-merge-row');
  await billing.getByTestId('thread-merge').click();
  await expect(page.getByTestId('thread-list')).toHaveCount(0);
  // One faint line says so. The thread keeps its name, and the merged question joins it in time order, above.
  const merged = page.getByTestId('thread-merged');
  await expect(merged).toHaveText(/^Merged with Who owns billing\?\s*Undo$/u);
  await expect(page.getByTestId('thread-name')).toHaveText('When does the pilot start?');
  await expect(page.getByTestId('timeline-question')).toHaveText(['Who owns billing?']);
  await picture(page, 'ask-thread-merged');
  await expect.poll(filed).toEqual({ 'Who owns billing?': 'When does the pilot start?', 'When does the pilot start?': 'When does the pilot start?' });
  // One thread is left to list.
  await page.getByTestId('thread-name').click();
  await expect(page.getByTestId('thread-row')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await merged.getByRole('button', { name: 'Undo' }).click();
  await expect(merged).toHaveCount(0);
  await expect(page.getByTestId('timeline-row')).toHaveCount(0);
  await expect.poll(filed).toEqual({ 'Who owns billing?': 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?' });
  await page.getByTestId('thread-name').click();
  await expect(page.getByTestId('thread-row')).toHaveCount(2);
});

test('a question that belongs to one other thread jumps there and is asked again in it, and no question a model wrote is ever sent as a thread\'s', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  // A follow-up: its answer names the full question the resolver wrote, which the folded line shows on this computer.
  await ask(page, 'and since when?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // Typed in the pilot's thread, a question about billing: Ask moves to billing's thread without asking, and asks it there.
  await page.getByTestId('ask-field').fill('who approves billing invoices?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('thread-name')).toHaveText('Who owns billing?');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText('who approves billing invoices?');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await expect(page.getByTestId('clarify')).toHaveCount(0);
  await expect(page.getByTestId('timeline-question')).toHaveText(['Who owns billing?']);
  const sent = asks();
  expect(sent.map(body => body.question)).toEqual(['Who owns billing?', 'and since when?', 'When does the pilot start?', 'who approves billing invoices?', 'who approves billing invoices?']);
  // The first time it carried the open thread's turn and the other thread, by the person's own words.
  expect(sent[3]).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' },
    threads: [{ questions: ['Who owns billing?', 'and since when?'] }] });
  // Asked again where it belongs: a plain follow-up of that thread, with its older turn, and no thread that could move it again.
  expect(sent[4]).toMatchObject({ previous: { purpose: 'follow_up', question: 'and since when?', earlier: [{ question: 'Who owns billing?' }] } });
  expect(sent[4]).not.toHaveProperty('threads');
  // The resolver's question was kept for the page, and never sent back as the person's (R2).
  expect(file().map(turn => (turn as { question?: string }).question).some(question => question?.startsWith(RESOLVED))).toBe(true);
  expect(JSON.stringify(sent.map(body => [body.threads ?? [], (body.previous as { earlier?: unknown } | undefined)?.earlier ?? []]))).not.toContain(RESOLVED);
  await expect.poll(filed).toMatchObject({ 'who approves billing invoices?': 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?' });

  // ECHO's own merge: a question the answer says is on billing's subject too joins that thread to this one, with Undo.
  await back(page);
  await page.getByTestId('sidebar-ask').click();
  await page.getByTestId('thread-name').click();
  await page.getByTestId('thread-row').filter({ hasText: 'When does the pilot start?' }).click();
  await ask(page, 'did the date slip, same as billing?');
  await expect(page.getByTestId('thread-merged')).toHaveText(/^Merged with Who owns billing\?\s*Undo$/u);
  await expect.poll(filed).toMatchObject({ 'Who owns billing?': 'When does the pilot start?', 'who approves billing invoices?': 'When does the pilot start?' });
  await page.getByTestId('thread-undo').click();
  await expect.poll(filed).toMatchObject({ 'Who owns billing?': 'Who owns billing?', 'did the date slip, same as billing?': 'When does the pilot start?' });
});

test('a question that could belong to several threads asks which one: a thread in a project names it, and picking it opens the project\'s page and asks there; "New question" starts a thread', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Is the ledger closed?');
  await back(page);
  // Apollo's own ledger thread: a project Ask carries no thread from outside, so nothing places it at Home.
  await askInApollo(page, 'Where is the Apollo ledger kept?');
  await back(page);
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('ask-field').fill('what changed in the ledger?');
  await page.getByTestId('ask-field').press('Enter');
  const clarify = page.getByTestId('clarify');
  await expect(clarify).toContainText('Which one?');
  // A button a thread, the one that lives in a project naming it, and "New question" last. Nothing was guessed (R4).
  const choices = clarify.getByTestId('choice');
  await expect(choices).toHaveText([/^Where is the Apollo ledger kept\?\s*Apollo$/u, 'Is the ledger closed?', 'New question']);
  await expect(choices.nth(0).getByTestId('choice-project')).toHaveText('Apollo');
  await expect(page.getByTestId('turn')).toHaveCount(0);
  expect(asks()).toHaveLength(3);
  expect(asks()[2]).toMatchObject({ question: 'what changed in the ledger?', threads: [{ questions: ['Where is the Apollo ledger kept?'] }, { questions: ['Is the ledger closed?'] }] });
  expect(asks()[2]).not.toHaveProperty('previous');
  await picture(page, 'ask-which-one-threads');
  // Never on its own in another home (R5): the pick moves to Apollo's page, its chip showing, and asks the words there.
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await choices.nth(0).click();
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');
  await expect(page.getByTestId('thread-name')).toHaveText('Where is the Apollo ledger kept?');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText('what changed in the ledger?');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  expect(asks()[3]).toMatchObject({ question: 'what changed in the ledger?', project_id: APOLLO, previous: { purpose: 'follow_up', question: 'Where is the Apollo ledger kept?' } });
  expect(asks()[3]).not.toHaveProperty('threads');
  await expect.poll(filed).toMatchObject({ 'what changed in the ledger?': 'Where is the Apollo ledger kept?' });
  // Back on Apollo's page under Ask: the project it was asked in.
  await back(page);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  // A question from Apollo's page carries Apollo's thread and no other (R3): Home's ledger thread stays out of it.
  await ask(page, 'Which tests fail?');
  expect(asks().at(-1)).toMatchObject({ question: 'Which tests fail?', project_id: APOLLO });
  expect(asks().at(-1)!.threads).toEqual([{ questions: ['Where is the Apollo ledger kept?', 'what changed in the ledger?'], asked_at: expect.any(String) }]);
  await expect(page.getByTestId('thread-name')).toHaveText('Which tests fail?');
  await back(page);

  // "New question": the same words, where they were typed, with nothing carried; the answer starts a thread.
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('ask-field').fill('who audits the ledger?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(clarify.getByTestId('choice')).toHaveCount(3);
  await clarify.getByTestId('choice').last().click();
  await expect(page.getByTestId('thread-name')).toHaveText('who audits the ledger?');
  await expect(page.getByTestId('question')).toHaveText(['who audits the ledger?']);
  await expect(clarify).toHaveCount(0);
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'who audits the ledger?' });
  await expect.poll(filed).toMatchObject({ 'who audits the ledger?': 'who audits the ledger?', 'Is the ledger closed?': 'Is the ledger closed?' });
});

test('a thread whose project the person can no longer ask in is never asked in from "Which one?": the pick says so, moves nothing, and "New question" stays', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await askInApollo(page, 'Where is the Apollo ledger kept?');
  await back(page);
  // Apollo is archived: its thread stays on this computer, and Apollo is no longer a project to ask in.
  await page.getByTestId('project-settings').click();
  await page.getByTestId('project-archive').click();
  await page.getByTestId('project-settings-confirm').click();
  await expect(page.getByTestId('sidebar-project')).toHaveCount(1);
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('ask-field').fill('what changed in the ledger?');
  await page.getByTestId('ask-field').press('Enter');
  const choices = page.getByTestId('clarify').getByTestId('choice');
  await expect(choices).toHaveText([/^Where is the Apollo ledger kept\?/u, 'New question']);
  const sent = asks().length;
  await choices.nth(0).click();
  // Nothing is asked outside the thread's home (R9), and the person is not moved to a page they did not choose.
  await expect(page.getByTestId('toast')).toHaveText('This is no longer available to you.');
  await expect(choices).toHaveText(['New question']);
  await expect(page.getByTestId('thread-name')).toHaveText('New thread');
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  expect(asks()).toHaveLength(sent);
  await choices.click();
  await expect(page.getByTestId('thread-name')).toHaveText('what changed in the ledger?');
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'what changed in the ledger?' });
  await expect.poll(filed).toEqual({ 'Where is the Apollo ledger kept?': 'Where is the Apollo ledger kept?', 'what changed in the ledger?': 'what changed in the ledger?' });
});

test('back in Ask from the sidebar a question is placed among every thread, the one shown included; asked in a thread it continues it', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  await back(page);
  // The sidebar's Ask shows the thread asked in last. Showing it is not being in it.
  await page.getByTestId('sidebar-ask').click();
  await expect(page.getByTestId('thread-name')).toHaveText('When does the pilot start?');
  await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?']);
  await page.getByTestId('ask-field').fill('what changed for billing and the pilot?');
  await page.getByTestId('ask-field').press('Enter');
  // It could be either thread, so the page asks: alone under "New thread", the thread that was showing among the buttons.
  const clarify = page.getByTestId('clarify');
  await expect(clarify.getByTestId('choice')).toHaveText(['When does the pilot start?', 'Who owns billing?', 'New question']);
  await expect(page.getByTestId('thread-name')).toHaveText('New thread');
  await expect(page.getByTestId('turn')).toHaveCount(0);
  await picture(page, 'ask-which-one-shown-thread');
  // It carried no earlier turn, and every thread it could be placed in, the one shown included.
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'what changed for billing and the pilot?', threads: [
    { questions: ['When does the pilot start?'], asked_at: expect.any(String) }, { questions: ['Who owns billing?'], asked_at: expect.any(String) }] });
  // Picked, the person is in the pilot's thread: the words are asked there, with nothing that could place them again.
  await clarify.getByTestId('choice').nth(0).click();
  await expect(page.getByTestId('thread-name')).toHaveText('When does the pilot start?');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText('what changed for billing and the pilot?');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  expect(asks().at(-1)).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' } });
  expect(asks().at(-1)).not.toHaveProperty('threads');
  // A question typed now, in the thread, continues it: the turn before it, and only the other thread.
  await ask(page, 'did that change?');
  expect(asks().at(-1)).toMatchObject({ question: 'did that change?', previous: { purpose: 'follow_up' } });
  expect(asks().at(-1)!.threads).toEqual([{ questions: ['Who owns billing?'], asked_at: expect.any(String) }]);
  await expect.poll(filed).toMatchObject({ 'did that change?': 'When does the pilot start?', 'what changed for billing and the pilot?': 'When does the pilot start?' });

  // Back again, a question about the one thread that is showing: asked with no earlier turn, it is placed there without
  // asking, and asked in it.
  await back(page);
  await page.getByTestId('sidebar-ask').click();
  await expect(page.getByTestId('thread-name')).toHaveText('When does the pilot start?');
  const before = asks().length;
  await ask(page, 'is the pilot still on?');
  await expect(page.getByTestId('thread-name')).toHaveText('When does the pilot start?');
  await expect(page.getByTestId('clarify')).toHaveCount(0);
  const [placed, again] = asks().slice(before);
  expect(placed).not.toHaveProperty('previous');
  expect((placed!.threads as { questions: string[] }[]).map(thread => thread.questions[0])).toEqual(['When does the pilot start?', 'Who owns billing?']);
  expect(again).toMatchObject({ question: 'is the pilot still on?', previous: { purpose: 'follow_up' } });
  expect(again).not.toHaveProperty('threads');
  expect(asks()).toHaveLength(before + 2);
  await expect.poll(filed).toMatchObject({ 'is the pilot still on?': 'When does the pilot start?' });
});

test('from a person\'s only thread a new subject starts a second thread: the question carries an empty list', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'When does the pilot start?');
  // The first question ever is one to be placed too: its list is empty.
  expect(asks()[0]).toEqual({ schema_version: 3, question: 'When does the pilot start?', threads: [] });
  // In that thread, a question about it continues it.
  await ask(page, 'who decided that?');
  expect(asks()[1]).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' }, threads: [] });
  await expect(page.getByTestId('thread-name')).toHaveText('When does the pilot start?');
  // An unrelated one, typed in the same thread: the list still goes, empty, so the answer can say the subject is new.
  await ask(page, 'an unrelated one: what is for lunch?');
  expect(asks()[2]).toMatchObject({ question: 'an unrelated one: what is for lunch?', previous: { purpose: 'follow_up' }, threads: [] });
  await expect(page.getByTestId('thread-name')).toHaveText('an unrelated one: what is for lunch?');
  await expect(page.getByTestId('question')).toHaveText(['an unrelated one: what is for lunch?']);
  await expect.poll(filed).toEqual({ 'When does the pilot start?': 'When does the pilot start?', 'who decided that?': 'When does the pilot start?',
    'an unrelated one: what is for lunch?': 'an unrelated one: what is for lunch?' });
  // Two threads to list now.
  await page.getByTestId('thread-name').click();
  await expect(page.getByTestId('thread-row').locator('.name')).toHaveText(['an unrelated one: what is for lunch?', 'When does the pilot start?']);
});
