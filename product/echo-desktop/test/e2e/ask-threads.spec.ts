// Ask threads (ADR-0056), in the real app with the fixture Authority, whose `ask-threads` mode places a question among the
// threads its request carries: one thread on the page under its name, the list of them all, a jump, a merge and its Undo
// on this computer's file, a question that belongs elsewhere asked again where it belongs, "Which one?" between threads,
// and what of the threads a request carries.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  await expect(name).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await expect(name).not.toHaveAttribute('aria-controls');
  await name.click();
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  // What the name opens is what it says it controls: a dialog, a list a home, a row a button in it, the open thread's the current one.
  const dialog = page.getByRole('dialog', { name: 'Threads' });
  await expect(dialog).toHaveAttribute('id', (await name.getAttribute('aria-controls'))!);
  await expect(dialog.getByRole('searchbox', { name: 'Find a thread' })).toBeFocused();
  await expect(dialog.getByRole('list')).toHaveCount(2);
  await expect(dialog.getByRole('list', { name: 'Apollo' }).getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('list', { name: 'No project' }).getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByRole('list', { name: 'Apollo' }).getByRole('button', { name: /Which tests fail\?/u })).toHaveAttribute('aria-current', 'true');
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
  // A click on the list's own edge keeps the keyboard in it: Escape still closes the list, and not Ask.
  await name.click();
  await list.click({ position: { x: 3, y: 3 } });
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  // The keyboard leaving closes it too: back from the field to the name it stays, and past the name it is gone.
  await name.click();
  await expect(list.getByTestId('thread-find')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(name).toBeFocused();
  await expect(list).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  // With the list closed, Escape is the window's again: Ask closes.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await page.getByTestId('sidebar-ask').click();
  await expect(name).toHaveText('Which tests fail?');
  // The open thread's own row picks that thread: nothing moves, the list closes, and the caret is back in the bar.
  await name.click();
  await rows.nth(0).click();
  await expect(list).toHaveCount(0);
  await expect(name).toHaveText('Which tests fail?');
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');
  await expect(page.getByTestId('ask-field')).toBeFocused();
  // The arrow keys move through the rows, and Return jumps: to the pilot's thread, at Home, where the bar asks all context.
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

test('Merge joins a thread to the open one in this computer\'s file, and Undo puts it back; each, refused by this computer, moves nothing, says so, and can be tried again', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  const before = { 'Who owns billing?': 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?' };
  await expect.poll(filed).toEqual(before);
  // The timeline's folder becomes a link, which the host never writes through: the one move is refused, and moves nothing.
  const folder = join(run.home, '.local', 'share', 'echo-brain', 'person', 'ask-timeline-v1');
  const refusing = async (act: () => Promise<void>) => {
    renameSync(folder, `${folder}.kept`);
    symlinkSync(`${folder}.kept`, folder);
    try {
      await act();
    } finally {
      rmSync(folder);
      renameSync(`${folder}.kept`, folder);
    }
  };
  const refused = 'Some questions could not be moved on this computer, so they are where they were.';
  const billing = page.getByTestId('thread-list').locator('.thread-item').filter({ hasText: 'Who owns billing?' });
  await refusing(async () => {
    await page.getByTestId('thread-name').click();
    await billing.hover();
    await billing.getByTestId('thread-merge').click();
    await expect(page.getByTestId('toast')).toHaveText(refused);
    // The page shows no merge the file does not hold, and offers no Undo.
    await expect(page.getByTestId('thread-merged')).toHaveCount(0);
    await expect(page.getByTestId('timeline-row')).toHaveCount(0);
    await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?']);
    expect(filed()).toEqual(before);
  });
  // Nothing is left half done, and Ask is not left busy: the same merge goes through now. Merge shows on the row the
  // pointer is on; the open thread's own row has none.
  await page.getByTestId('thread-name').click();
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
  // Its Undo refused, the merge stays, and so do the line and its Undo, to be tried again.
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 15_000 });
  await refusing(async () => {
    await merged.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('toast')).toHaveText(refused);
    await expect(merged).toHaveText(/^Merged with Who owns billing\?\s*Undo$/u);
    await expect(page.getByTestId('thread-undo')).toBeEnabled();
    await expect(page.getByTestId('timeline-question')).toHaveText(['Who owns billing?']);
  });
  await merged.getByRole('button', { name: 'Undo' }).click();
  await expect(merged).toHaveCount(0);
  await expect(page.getByTestId('timeline-row')).toHaveCount(0);
  await expect.poll(filed).toEqual(before);
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

test('the threads on the subject of the one a question jumps to join it first, then the words are asked there, continuing its own turn, and the merge has no Undo', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await back(page);
  await askAtHome(page, 'Is the ledger closed?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // Typed in the pilot's thread: it belongs to billing's, and the answer says the ledger's is on the same subject.
  const question = 'who approves billing invoices, same as ledger?';
  await page.getByTestId('ask-field').fill(question);
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('thread-name')).toHaveText('Who owns billing?');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText(question);
  await expect(page.getByTestId('asking')).toHaveCount(0);
  // The ledger's thread joined billing's first; the words asked again there continue billing's own turn, and the
  // ledger's question, newer than it, rode on nothing.
  expect(asks().at(-1)).toMatchObject({ question, previous: { purpose: 'follow_up', question: 'Who owns billing?' } });
  expect(asks().at(-1)!.previous).not.toHaveProperty('earlier');
  await expect.poll(filed).toMatchObject({ 'Is the ledger closed?': 'Who owns billing?', [question]: 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?' });
  // The ledger's question joined as an earlier line, between billing's own turn and the answer, both in full.
  await expect(page.getByTestId('timeline-question')).toHaveText(['Is the ledger closed?']);
  await expect(page.getByTestId('question')).toHaveText(['Who owns billing?', question]);
  // The words were the next question after the merge, and could build on what joined: the merge has no Undo (R10), and
  // a note says it was made.
  await expect(page.getByTestId('thread-merged')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveText('Merged with Is the ledger closed?');
});

test('a question a model wrote is sent again only while every turn its request carried is still readable, one a merge brought in included', async () => {
  // In this mode the source check answers, and never finds the follow-up that an answer about what was drafted cites.
  run = await launch('ask-threads-checked');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'What was drafted last week?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // A follow-up in the pilot's thread: its answer names the full question a resolver wrote.
  await ask(page, 'and who decided?');
  const rewrite = `${RESOLVED} and who decided? (after "When does the pilot start?")`;
  // Everything in the thread is readable: the next follow-up names that question in full, as it always did.
  await ask(page, 'and since when?');
  expect(asks().at(-1)).toMatchObject({ previous: { purpose: 'follow_up', question: rewrite, earlier: [{ question: 'When does the pilot start?' }] } });
  // The other thread joins by hand. Its one turn cites what this person can no longer read, and it is now among the older
  // turns of this thread that ride on a follow-up.
  await page.getByTestId('thread-name').click();
  const drafted = page.getByTestId('thread-list').locator('.thread-item').filter({ hasText: 'What was drafted last week?' });
  await drafted.hover();
  await drafted.getByTestId('thread-merge').click();
  await expect(page.getByTestId('thread-merged')).toBeVisible();
  const before = asks().length;
  await ask(page, 'and by whom?');
  await ask(page, 'and why?');
  const [first, second] = asks().slice(before) as { previous: { question: string; earlier: { question: string; statements: unknown[] }[] } }[];
  // The turn the first continues was asked before the merge: its request carried only this thread's own turns, as its
  // record says, so its full question goes. The merged turn rides with no sentence.
  expect(first!.previous.question).toBe(`${RESOLVED} and since when? (after "${rewrite}")`);
  expect(first!.previous.earlier.map(each => [each.question, each.statements.length])).toEqual([
    ['What was drafted last week?', 0], ['When does the pilot start?', 1], ['and who decided?', 1]]);
  // That first follow-up carried the merged turn: the next names it by the words typed for it, and nothing a model wrote
  // from the merged turn goes.
  expect(second!.previous.question).toBe('and by whom?');
  expect(JSON.stringify(second)).not.toContain(`${RESOLVED} and by whom?`);
  expect(JSON.stringify([first, second])).not.toContain('Confirm the trace');
  const carried = (file().find(turn => turn.text === 'and by whom?') as { carried?: string[] } | undefined)?.carried ?? [];
  expect(carried).toContain(file().find(turn => turn.text === 'What was drafted last week?')!.id);
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

  // Back once more, and the thread that is showing is picked from the list, by Return on it as the one found: the
  // person is in it, so the next question continues it, in one request.
  await back(page);
  await page.getByTestId('sidebar-ask').click();
  await page.getByTestId('thread-name').click();
  await page.getByTestId('thread-find').fill('PILOT');
  await expect(page.getByTestId('thread-row')).toHaveCount(1);
  await expect(page.getByTestId('thread-row')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('thread-list')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  const picked = asks().length;
  await ask(page, 'and who runs it?');
  expect(asks()).toHaveLength(picked + 1);
  expect(asks().at(-1)).toMatchObject({ question: 'and who runs it?', previous: { purpose: 'follow_up', question: 'is the pilot still on?' } });
  await expect.poll(filed).toMatchObject({ 'and who runs it?': 'When does the pilot start?' });
});

test('the thread list closes when Ask shows another thread under it, and opens again with nothing to find', async () => {
  // This Authority holds each answer until the test lets it go.
  run = await launch('ask-progress');
  const { page } = run;
  const release = join(run.home, 'release-ask');
  writeFileSync(release, '');
  await ask(page, 'When does the pilot start?');
  await back(page);
  // A second question, from the page: on its way it belongs to no thread yet, and the list can be opened meanwhile.
  rmSync(release);
  await page.getByTestId('ask-field').fill('Who owns billing?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('asking')).toBeVisible();
  const name = page.getByTestId('thread-name');
  const list = page.getByTestId('thread-list');
  await expect(name).toHaveText('New thread');
  await name.click();
  await list.getByTestId('thread-find').fill('pilot');
  await expect(list.getByTestId('thread-row')).toHaveCount(1);
  // While the question is on its way no row moves Ask.
  await expect(list.getByTestId('thread-row')).toBeDisabled();
  // The answer lands in a thread of its own: Ask shows that thread now, and the list that was of the other is gone. The
  // keyboard was in it: the caret is back in the bar, not lost to the page.
  await expect(list.getByTestId('thread-find')).toBeFocused();
  writeFileSync(release, '');
  await expect(name).toHaveText('Who owns billing?');
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  await name.click();
  await expect(list.getByTestId('thread-find')).toHaveValue('');
  await expect(list.getByTestId('thread-row')).toHaveCount(2);
});

test('Capture opened by its shortcut over the thread list keeps its own Escape and the keyboard', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  const list = page.getByTestId('thread-list');
  await page.getByTestId('thread-name').click();
  await expect(list.getByTestId('thread-find')).toBeFocused();
  // An Escape from the find field as Capture comes up over Ask, as if pressed before Capture takes the keyboard. Whether
  // Capture has already taken it depends on the platform (Linux moves it before this observer runs, macOS after), so the
  // Escape is sent from the find field while the field is still there, and from wherever the keyboard is otherwise.
  const landed = page.evaluate(() => new Promise<string | null>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="compose"]')) return;
      observer.disconnect();
      const target = (document.querySelector('[data-testid="thread-find"]') ?? document.activeElement) as HTMLElement | null;
      target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      resolve(target?.getAttribute('data-testid') ?? null);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }));
  // What ⌘⇧E has main send the page.
  await run.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.send('event', { name: 'capture.open', payload: {} }); });
  expect(['thread-find', 'compose-body']).toContain(await landed);
  // The list did not take it: it was Capture's, which closed, leaving Ask as it was.
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  await expect(page.getByTestId('thread-name')).toHaveText('Who owns billing?');
});

test('an answer that does not say where a question asked with the threads belongs is refused, and nothing of it is kept', async () => {
  // This Authority names the question and leaves out its place: with no previous turn there is no thread that could mean (T2).
  run = await launch('ask-threads-unplaced');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('When does the pilot start?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('ask-error')).toHaveText('ECHO sent back something this app could not read. Try again, or update the app.');
  await expect(page.getByTestId('turn')).toHaveCount(0);
  expect(asks()).toEqual([{ schema_version: 3, question: 'When does the pilot start?', threads: [] }]);
  expect(file()).toEqual([]);
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
