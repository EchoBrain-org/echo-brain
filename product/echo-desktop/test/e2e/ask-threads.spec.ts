// Ask memory (ADR-0056, ADR-0057), in the real app with the fixture Authority, whose `ask-threads` mode places a question
// among the conversations its request carries and labels the one it continues: one conversation on the page with nothing
// that names a thread, the door behind the title, a question ECHO moves and its Undo on this computer's file, a link that
// moves nothing, a thread a week of quiet ended, "Which one do you mean?", and what of the conversations a request carries.
import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Launched } from './launch.js';

let run: Launched;
test.afterEach(async () => { await run?.close(); });

const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
/** What the fixture's follow-up answers name as their question: a resolver's rewrite, which no one typed. */
const RESOLVED = 'Resolved:';
/** Where this computer keeps the fixture account's timeline, under the app's home. */
const TIMELINE_FOLDER = join('.local', 'share', 'echo-brain', 'person', 'ask-timeline-v1');
const TIMELINE_FILE = join(TIMELINE_FOLDER, `${createHash('sha256').update('https://authority.example mem_22222222-2222-4222-8222-222222222222').digest('hex')}.json`);

/** The Ask requests the person client sent to `/v7`, Ask's one route, with what each carried. */
const asks = () => run.calls().filter(call => call.path === '/v7/person/ask').map(call => call.body ?? {});

interface Kept { id: string; text: string; question?: string; thread?: string; continues?: string[]; label?: string; carried?: string[] }

/** The account's Ask timeline as this computer's file holds it. */
function file(): Kept[] {
  const folder = join(run.home, TIMELINE_FOLDER);
  const [name] = existsSync(folder) ? readdirSync(folder).filter(each => each.endsWith('.json')) : [];
  return name === undefined ? [] : (JSON.parse(readFileSync(join(folder, name), 'utf8')) as { turns: Kept[] }).turns;
}
/** Which thread each question is filed in, by the question that started the thread. */
function filed(): Record<string, string | undefined> {
  const turns = file();
  return Object.fromEntries(turns.map(turn => [turn.text, turns.find(first => first.id === turn.thread)?.text]));
}

/** A question from the bar, answered in the conversation Ask then shows: its turn is the newest in full, and nothing is on its way. */
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

/** A question asked from Home's page, which starts or finds its conversation. */
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

/** The door, opened from the title: its rows are the conversations. */
async function openDoor(page: Page) {
  await page.getByTestId('ask-title').click();
  const door = page.getByTestId('door');
  await expect(door.getByTestId('door-find')).toBeFocused();
  return door;
}

/** A picture of the window in each theme, kept only when ECHO_SCREENSHOTS names a folder for them. */
async function picture(page: Page, name: string): Promise<void> {
  const folder = process.env.ECHO_SCREENSHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.mouse.move(1, 1);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: join(folder, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: null });
}

test('Ask shows one conversation and nothing that names a thread; its title opens the door, with Find, New question and every conversation, and a row jumps to its conversation at its place', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  // The page is the conversation and the bar: your message on the right, ECHO's reply on the left, and no list of anything.
  await expect(page.getByTestId('title')).toHaveText('Ask');
  await expect(page.getByTestId('door')).toHaveCount(0);
  await expect(page.locator('.msg.you')).toHaveText(['Who owns billing?']);
  await expect(page.getByTestId('answer').locator('.msg.echo')).toHaveCount(1);
  await expect(page.getByTestId('stamp')).toHaveText(/^Today \d{1,2}:\d{2} [AP]M$/u);
  await picture(page, 'ask-conversation');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // A new subject: its own conversation, alone on the page.
  await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?']);
  await back(page);
  await askInApollo(page, 'Which tests fail?');
  // Each carried the conversations it could be placed in, a list that goes even when empty, and reads labels. A project
  // Ask carries only that project's (R3): Apollo had none, so its list is empty though Home has two. Home's carried Home's.
  expect(asks().map(body => body.threads)).toEqual([[], [{ questions: ['Who owns billing?'], asked_at: expect.any(String) }], []]);
  expect(asks().map(body => 'previous' in body)).toEqual([false, false, false]);
  expect(asks().map(body => body.labels)).toEqual([true, true, true]);
  expect(asks()[2]).toMatchObject({ question: 'Which tests fail?', project_id: APOLLO });

  // The door: the title is a button that says what it opens only once it is open.
  const title = page.getByTestId('ask-title');
  const door = page.getByTestId('door');
  const rows = door.getByTestId('door-row');
  await expect(title).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await expect(title).not.toHaveAttribute('aria-controls');
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  const dialog = page.getByRole('dialog', { name: 'Conversations' });
  await expect(dialog).toHaveAttribute('id', (await title.getAttribute('aria-controls'))!);
  await expect(dialog.getByRole('searchbox', { name: 'Find a conversation' })).toBeFocused();
  // "New question" first, then a row a conversation, the one asked in most recently first: one flat list, no headings.
  await expect(dialog.getByRole('list')).toHaveCount(1);
  await expect(door.locator('.name')).toHaveText(['New question', 'Which tests fail?', 'When does the pilot start?', 'Who owns billing?']);
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  // Ask is in Apollo, where the shown conversation lives: the other two live in no project, so no row names one.
  await expect(door.getByTestId('door-project')).toHaveCount(0);
  await picture(page, 'ask-door');
  // Find, by any question typed, in any case.
  await door.getByTestId('door-find').fill('PILOT');
  await expect(rows.locator('.name')).toHaveText(['When does the pilot start?']);
  // Escape closes the door and nothing else, and the caret is back in the bar; so does a click elsewhere.
  await page.keyboard.press('Escape');
  await expect(door).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  await expect(page.getByTestId('ask-field')).toBeFocused();
  await title.click();
  await expect(door).toBeVisible();
  await page.getByTestId('ask-field').click();
  await expect(door).toHaveCount(0);
  // The up arrow in the empty bar opens it too, with nothing left in Find.
  await page.getByTestId('ask-field').press('ArrowUp');
  await expect(door.getByTestId('door-find')).toBeFocused();
  await expect(door.getByTestId('door-find')).toHaveValue('');
  // A click on the list's own edge keeps the keyboard in it: Escape still closes the door, and not Ask.
  await door.click({ position: { x: 3, y: 3 } });
  await expect(door).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(door).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  // The keyboard leaving closes it too.
  await title.click();
  await expect(door.getByTestId('door-find')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(door).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  // With the door closed, Escape is the window's again: Ask closes, and with it the title's button.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ask-view')).toHaveCount(0);
  await expect(page.getByTestId('ask-title')).toHaveCount(0);
  await page.getByTestId('sidebar-ask').click();
  await expect(page.getByTestId('question')).toHaveText(['Which tests fail?']);
  // The shown conversation's own row picks it: nothing moves, the door closes, and the caret is back in the bar.
  await openDoor(page);
  await rows.nth(0).click();
  await expect(door).toHaveCount(0);
  await expect(page.getByTestId('question')).toHaveText(['Which tests fail?']);
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');
  await expect(page.getByTestId('ask-field')).toBeFocused();
  // The arrow keys move through the rows, and Return jumps: to the pilot's conversation, at Home, where the bar asks all context.
  await openDoor(page);
  await page.keyboard.press('ArrowDown');
  await expect(door.getByTestId('door-new')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(door).toHaveCount(0);
  await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?']);
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  // From Home, the one conversation that lives in a project names it. A click jumps to it, on Apollo's page: the chip
  // names it, and a question typed there is asked in Apollo.
  await openDoor(page);
  await expect(rows.filter({ has: page.getByTestId('door-project') }).locator('.name')).toHaveText(['Which tests fail?']);
  await expect(door.getByTestId('door-project')).toHaveText(['Apollo']);
  await rows.filter({ hasText: 'Which tests fail?' }).click();
  await expect(page.getByTestId('question')).toHaveText(['Which tests fail?']);
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');
  await ask(page, 'and who fixes them?');
  expect(asks().at(-1)).toMatchObject({ question: 'and who fixes them?', project_id: APOLLO, previous: { purpose: 'follow_up', question: 'Which tests fail?' } });
  // Still only Apollo's other conversations ride on it, and it has none: nothing from Home does.
  expect(asks().at(-1)!.threads).toEqual([]);
  await expect.poll(filed).toEqual({ 'Who owns billing?': 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?',
    'Which tests fail?': 'Which tests fail?', 'and who fixes them?': 'Which tests fail?' });
  // Its label came back with the answer, made of words typed in it, and names its row from now on.
  await openDoor(page);
  await expect(rows.nth(0).locator('.name')).toHaveText('Which tests fail, and who fixes them');
  await page.keyboard.press('Escape');
  // With the bar widened by ×, Apollo's page asks all context, and is still not where a conversation with no project
  // lives: a jump to one puts Home under Ask.
  await page.getByTestId('scope-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await openDoor(page);
  await rows.filter({ hasText: 'Who owns billing?' }).click();
  await expect(page.getByTestId('question')).toHaveText(['Who owns billing?']);
  await back(page);
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('sidebar-home')).toHaveAttribute('aria-current', 'page');
});

test('"New question", behind the door, shows an empty chat, and the next question is asked with nothing carried and starts a conversation of its own', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'When does the pilot start?');
  const door = await openDoor(page);
  await door.getByTestId('door-new').click();
  await expect(door).toHaveCount(0);
  // An empty chat: no message, no line, and the caret in the bar.
  await expect(page.getByTestId('ask-view')).toBeVisible();
  await expect(page.locator('.msg')).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  // About the pilot, which ECHO would have placed there: asked fresh, nothing rides on it and nothing places it.
  await ask(page, 'is the pilot on track?');
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'is the pilot on track?', labels: true });
  await expect(page.getByTestId('question')).toHaveText(['is the pilot on track?']);
  await expect.poll(filed).toEqual({ 'When does the pilot start?': 'When does the pilot start?', 'is the pilot on track?': 'is the pilot on track?' });
  // Only that one question was fresh: the next continues the conversation it started.
  await ask(page, 'and who decides?');
  expect(asks().at(-1)).toMatchObject({ previous: { purpose: 'follow_up', question: 'is the pilot on track?' } });
});

test('ECHO moves a question to the conversation it belongs to and says so in one line; Undo takes its turn out of this computer\'s file and asks the words as a new question, and one this computer cannot write removes nothing and can be tried again', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  // A follow-up: its answer names the full question the resolver wrote, and the conversation's label.
  await ask(page, 'and since when?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // Typed in the pilot's conversation, a question about billing: Ask moves to billing's without asking, and asks it there.
  await page.getByTestId('ask-field').fill('who approves billing invoices?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText('who approves billing invoices?');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await expect(page.getByTestId('clarify')).toHaveCount(0);
  // The chat swapped in place: billing's own turns, and one faint line just above the moved question, with Undo.
  await expect(page.getByTestId('timeline-question')).toHaveText(['Who owns billing?']);
  await expect(page.getByTestId('question')).toHaveText(['and since when?', 'who approves billing invoices?']);
  const note = page.getByTestId('moved-note');
  await expect(note).toHaveText(/^Continuing Who owns billing, and since when, who approves billing invoices\s*·\s*Undo$/u);
  await picture(page, 'ask-moved');
  const sent = asks();
  expect(sent.map(body => body.question)).toEqual(['Who owns billing?', 'and since when?', 'When does the pilot start?', 'who approves billing invoices?', 'who approves billing invoices?']);
  // The first time it carried the shown conversation's turn and the other conversation, by the person's own words and its label.
  expect(sent[3]).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' },
    threads: [{ questions: ['Who owns billing?', 'and since when?'], label: 'Who owns billing, and since when' }] });
  // Asked again where it belongs: a plain follow-up of that conversation, with its older turn and its label, and no list
  // that could move it again.
  expect(sent[4]).toMatchObject({ previous: { purpose: 'follow_up', question: 'and since when?', earlier: [{ question: 'Who owns billing?' }], label: 'Who owns billing, and since when' } });
  expect(sent[4]).not.toHaveProperty('threads');
  // The resolver's question was kept for the page, and never sent back as the person's (R2).
  expect(file().map(turn => turn.question).some(question => question?.startsWith(RESOLVED))).toBe(true);
  expect(JSON.stringify(sent.map(body => [body.threads ?? [], (body.previous as { earlier?: unknown } | undefined)?.earlier ?? []]))).not.toContain(RESOLVED);
  const moved = { 'Who owns billing?': 'Who owns billing?', 'and since when?': 'Who owns billing?', 'When does the pilot start?': 'When does the pilot start?',
    'who approves billing invoices?': 'Who owns billing?' };
  await expect.poll(filed).toEqual(moved);

  // The timeline's folder becomes a link, which the host never writes through: Undo removes nothing, here or in the file,
  // says so as a warning, and is still offered.
  const folder = join(run.home, TIMELINE_FOLDER);
  renameSync(folder, `${folder}.kept`);
  symlinkSync(`${folder}.kept`, folder);
  try {
    await page.getByTestId('placed-undo').click();
    await expect(page.getByTestId('toast')).toHaveText('That question could not be taken back, so its answer is where it was.');
    await expect(page.getByTestId('question')).toHaveText(['and since when?', 'who approves billing invoices?']);
    await expect(page.getByTestId('placed-undo')).toBeEnabled();
  } finally {
    rmSync(folder);
    renameSync(`${folder}.kept`, folder);
  }
  expect(filed()).toEqual(moved);
  expect(asks()).toHaveLength(5);
  // Now it goes through: the turn leaves the file, and the same words are asked as a new question with nothing carried.
  await page.getByTestId('placed-undo').click();
  await expect(page.getByTestId('question')).toHaveText(['who approves billing invoices?']);
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await expect(page.getByTestId('moved-note')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'who approves billing invoices?', labels: true });
  await expect.poll(filed).toEqual({ ...moved, 'who approves billing invoices?': 'who approves billing invoices?' });
  expect(file().filter(turn => turn.text === 'who approves billing invoices?')).toHaveLength(1);
  // A new subject has no Undo.
  await expect(page.getByTestId('placed-undo')).toHaveCount(0);
});

test('a conversation an answer names as the same thing is linked to the one the question lands in: the turn names it, no turn moves, and they are one conversation from then on', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await back(page);
  await askAtHome(page, 'Is the ledger closed?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // Typed in the pilot's conversation: it belongs to billing's, and the answer says the ledger's is the same thing.
  const question = 'who approves billing invoices, same as ledger?';
  await ask(page, question);
  // The words asked again in billing's continue its own turn, and the ledger's question rode on nothing.
  expect(asks().at(-1)).toMatchObject({ question, previous: { purpose: 'follow_up', question: 'Who owns billing?' } });
  expect(asks().at(-1)!.previous).not.toHaveProperty('earlier');
  // No turn moved (R16): each is in the thread it was asked in, and the turn that landed names the ledger's thread.
  await expect.poll(filed).toEqual({ 'Who owns billing?': 'Who owns billing?', 'Is the ledger closed?': 'Is the ledger closed?',
    'When does the pilot start?': 'When does the pilot start?', [question]: 'Who owns billing?' });
  const ledger = file().find(turn => turn.text === 'Is the ledger closed?')!;
  expect(file().find(turn => turn.text === question)!.continues).toEqual([ledger.id]);
  expect(file().filter(turn => turn.text !== question).every(turn => turn.continues === undefined)).toBe(true);
  // The page shows billing's own turns: the link put nothing of the ledger's on it, and said nothing of itself.
  await expect(page.getByTestId('question')).toHaveText(['Who owns billing?', question]);
  await expect(page.getByTestId('timeline-row')).toHaveCount(0);
  await expect(page.getByTestId('continues-note')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  // One conversation now: the door lists it once, beside the pilot's.
  const door = await openDoor(page);
  await expect(door.getByTestId('door-row')).toHaveCount(2);
  await page.keyboard.press('Escape');
  // And it goes to placement as one entry, with every question typed in it, oldest first.
  await back(page);
  await askAtHome(page, 'an unrelated one: what is for lunch?');
  expect((asks().at(-1)!.threads as { questions: string[] }[]).map(thread => thread.questions)).toEqual([
    ['Who owns billing?', 'Is the ledger closed?', question], ['When does the pilot start?']]);
});

test('a week of quiet ends a thread: a question in it starts a new chat that continues it, the line at its top opens the older part, and a question typed there goes on in the newest', async () => {
  // A conversation last asked in eight days ago, as this computer's file kept it.
  const old = '11111111-1111-4111-8111-111111111111';
  const asked = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
  const pilot = 'When does the pilot start?';
  run = await launch('ask-threads', { [TIMELINE_FILE]: JSON.stringify({ schema_version: 1, kind: 'echo-desktop-ask-timeline-v1', turns: [{
    id: old, asked_at: asked, text: pilot, question: pilot, typed: pilot, follows: null, thread: old, carried: [], scope: { kind: 'global' },
    answer: { scope: { kind: 'global' }, sources: [], outcome: 'not_found', parts: [{ question: pilot, status: 'not_found', statements: [] }] },
  }] }) });
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  // Picked behind the door, the person is in it. It looks as any conversation does: nothing says it has ended.
  await page.getByTestId('sidebar-ask').click();
  const door = await openDoor(page);
  await door.getByTestId('door-row').click();
  await expect(page.getByTestId('question')).toHaveText([pilot]);
  await expect(page.getByTestId('continues-note')).toHaveCount(0);
  // A question in it: a joined thread never changes (R12), so a new chat starts, with one line at its top (R13).
  await ask(page, 'who decided that?');
  await expect(page.getByTestId('question')).toHaveText(['who decided that?']);
  const note = page.getByTestId('continues-note');
  await expect(note).toHaveText(/^Continues\s*When does the pilot start\?\s*from \w{3} \d{1,2}(, \d{4})?\s*·\s*Undo$/u);
  await picture(page, 'ask-continues');
  // It was asked as a follow-up of the old turn, and its own turn names the old thread; the old turn is as it was.
  expect(asks().at(-1)).toMatchObject({ question: 'who decided that?', previous: { purpose: 'follow_up', question: pilot }, threads: [], labels: true });
  await expect.poll(() => file().map(turn => [turn.text, turn.thread === old, turn.continues])).toEqual([[pilot, true, undefined], ['who decided that?', false, [old]]]);
  expect(file()[0]).toMatchObject({ id: old, asked_at: asked, text: pilot });
  // One conversation behind the door, under the label that came back.
  await openDoor(page);
  await expect(door.getByTestId('door-row').locator('.name')).toHaveText(['When does the pilot start, who decided that']);
  await page.keyboard.press('Escape');
  // The line's label opens the older part. A question typed there goes on in the newest thread (R14): the chat swaps back.
  await note.getByTestId('continues-open').click();
  await expect(page.getByTestId('question')).toHaveText([pilot]);
  await ask(page, 'and when does it end?');
  await expect(page.getByTestId('question')).toHaveText(['who decided that?', 'and when does it end?']);
  await expect(page.getByTestId('moved-note')).toBeVisible();
  // It carried the whole conversation, oldest first, under its label.
  expect(asks().at(-1)).toMatchObject({ previous: { purpose: 'follow_up', question: 'who decided that?', earlier: [{ question: pilot }],
    label: 'When does the pilot start, who decided that' } });
  await expect.poll(() => file().length).toBe(3);
  const [, second, third] = file();
  expect(third).toMatchObject({ text: 'and when does it end?', thread: second!.thread });
  expect(third!.continues).toBeUndefined();
});

test('a label is kept only when every word of it was typed in the conversation: one a model made up is dropped, and the conversation keeps the name it had', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'When does the pilot start?');
  // The fixture labels this one with words no one typed.
  await ask(page, 'mislabel it: who runs the pilot?');
  await expect.poll(() => file().map(turn => turn.label)).toEqual([undefined, undefined]);
  const door = await openDoor(page);
  await expect(door.getByTestId('door-row').locator('.name')).toHaveText(['When does the pilot start?']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ask-view')).not.toContainText('Invented by the model');
  // The next one comes back in the person's own words, and is kept and sent from then on.
  await ask(page, 'and who pays?');
  await expect.poll(() => file().at(-1)?.label).toBe('When does the pilot start, and who pays');
  await ask(page, 'for how long?');
  expect(asks().at(-1)).toMatchObject({ previous: { label: 'When does the pilot start, and who pays' } });
});

test('a question a model wrote is sent again only while every turn its request carried is still readable, one from a linked conversation included', async () => {
  // In this mode the source check answers, and never finds the follow-up that an answer about what was drafted cites.
  run = await launch('ask-threads-checked');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'What was drafted last week?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  // A follow-up in the pilot's conversation: its answer names the full question a resolver wrote.
  await ask(page, 'and who decided?');
  const rewrite = `${RESOLVED} and who decided? (after "When does the pilot start?")`;
  // Everything in the conversation is readable: the next follow-up names that question in full, as it always did.
  await ask(page, 'and since when?');
  expect(asks().at(-1)).toMatchObject({ previous: { purpose: 'follow_up', question: rewrite, earlier: [{ question: 'When does the pilot start?' }] } });
  // An answer says the other conversation is the same thing, so its turn links it in. That one turn cites what this
  // person can no longer read, and it is now among the older turns of this conversation that ride on a follow-up.
  const before = asks().length;
  await ask(page, 'and by whom, same as week?');
  await ask(page, 'and why?');
  await ask(page, 'and then?');
  const [linking, first, second] = asks().slice(before) as { question: string; previous: { question: string; earlier: { question: string; statements: unknown[] }[] } }[];
  // The request that made the link carried only this conversation's own turns.
  expect(linking!.previous.earlier.map(each => each.question)).toEqual(['When does the pilot start?', 'and who decided?']);
  // So the turn it landed has a full question that may go: the next follow-up names it, and the linked turn rides with no sentence.
  expect(first!.previous.question).toBe(`${RESOLVED} and by whom, same as week? (after "${RESOLVED} and since when? (after "${rewrite}")")`);
  expect(first!.previous.earlier.map(each => [each.question, each.statements.length])).toEqual([
    ['What was drafted last week?', 0], ['When does the pilot start?', 1], ['and who decided?', 1], ['and since when?', 1]]);
  // That follow-up carried the linked turn: the next names it by the words typed for it, and nothing a model wrote from
  // the linked turn goes.
  expect(second!.previous.question).toBe('and why?');
  expect(JSON.stringify(second)).not.toContain(`${RESOLVED} and why?`);
  expect(JSON.stringify([linking, first, second])).not.toContain('Confirm the trace');
  const drafted = file().find(turn => turn.text === 'What was drafted last week?')!;
  expect(file().find(turn => turn.text === 'and why?')!.carried).toContain(drafted.id);
  // Nothing moved to make that so: the drafted turn is in the thread it started.
  expect(filed()['What was drafted last week?']).toBe('What was drafted last week?');
});

test('a question that could belong to several conversations asks which one: one in a project names it, and picking it opens the project\'s page and asks there; "New question" starts a conversation', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Is the ledger closed?');
  await back(page);
  // Apollo's own ledger conversation: a project Ask carries none from outside, so nothing places it at Home.
  await askInApollo(page, 'Where is the Apollo ledger kept?');
  await back(page);
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('ask-field').fill('what changed in the ledger?');
  await page.getByTestId('ask-field').press('Enter');
  // ECHO asks, as a reply, with a quick reply a conversation, the one that lives in a project naming it, and "New
  // question" last. Nothing was guessed (R4).
  const clarify = page.getByTestId('clarify');
  await expect(clarify.locator('.msg.echo')).toHaveText('Which one do you mean?');
  const choices = clarify.getByTestId('choice');
  await expect(choices).toHaveText([/^Where is the Apollo ledger kept\?\s*Apollo$/u, 'Is the ledger closed?', 'New question']);
  await expect(choices.nth(0).getByTestId('choice-project')).toHaveText('Apollo');
  await expect(page.getByTestId('turn')).toHaveCount(0);
  expect(asks()).toHaveLength(3);
  expect(asks()[2]).toMatchObject({ question: 'what changed in the ledger?', threads: [{ questions: ['Where is the Apollo ledger kept?'] }, { questions: ['Is the ledger closed?'] }] });
  expect(asks()[2]).not.toHaveProperty('previous');
  await picture(page, 'ask-which-one');
  // Never on its own in another home (R5): the pick moves to Apollo's page, its chip showing, and asks the words there.
  // The person placed it, so no line offers an Undo.
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await choices.nth(0).click();
  await expect(page.getByTestId('scope-chip')).toContainText('Apollo');
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText('what changed in the ledger?');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  await expect(page.getByTestId('question')).toHaveText(['Where is the Apollo ledger kept?', 'what changed in the ledger?']);
  await expect(page.getByTestId('placed-undo')).toHaveCount(0);
  expect(asks()[3]).toMatchObject({ question: 'what changed in the ledger?', project_id: APOLLO, previous: { purpose: 'follow_up', question: 'Where is the Apollo ledger kept?' } });
  expect(asks()[3]).not.toHaveProperty('threads');
  await expect.poll(filed).toMatchObject({ 'what changed in the ledger?': 'Where is the Apollo ledger kept?' });
  // Back on Apollo's page under Ask: the project it was asked in.
  await back(page);
  await expect(page.getByTestId('title')).toHaveText('Apollo');
  // A question from Apollo's page carries Apollo's conversation and no other (R3): Home's ledger one stays out of it.
  await ask(page, 'Which tests fail?');
  expect(asks().at(-1)).toMatchObject({ question: 'Which tests fail?', project_id: APOLLO });
  expect(asks().at(-1)!.threads).toEqual([{ questions: ['Where is the Apollo ledger kept?', 'what changed in the ledger?'], asked_at: expect.any(String) }]);
  await expect(page.getByTestId('question')).toHaveText(['Which tests fail?']);
  await back(page);

  // "New question": the same words, where they were typed, with nothing carried; the answer starts a conversation.
  await page.getByTestId('sidebar-home').click();
  await page.getByTestId('ask-field').fill('who audits the ledger?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(clarify.getByTestId('choice')).toHaveCount(3);
  await clarify.getByTestId('choice').last().click();
  await expect(page.getByTestId('question')).toHaveText(['who audits the ledger?']);
  await expect(clarify).toHaveCount(0);
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'who audits the ledger?', labels: true });
  await expect.poll(filed).toMatchObject({ 'who audits the ledger?': 'who audits the ledger?', 'Is the ledger closed?': 'Is the ledger closed?' });
});

test('a conversation whose project the person can no longer ask in is never asked in from "Which one do you mean?": the pick says so, moves nothing, and "New question" stays', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await askInApollo(page, 'Where is the Apollo ledger kept?');
  await back(page);
  // Apollo is archived: its conversation stays on this computer, and Apollo is no longer a project to ask in.
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
  // Nothing is asked outside the conversation's home (R9), and the person is not moved to a page they did not choose.
  await expect(page.getByTestId('toast')).toHaveText('This is no longer available to you.');
  await expect(choices).toHaveText(['New question']);
  await expect(page.getByTestId('question')).toHaveText(['what changed in the ledger?']);
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  expect(asks()).toHaveLength(sent);
  await choices.click();
  await expect(page.getByTestId('turn').getByTestId('question')).toHaveText(['what changed in the ledger?']);
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'what changed in the ledger?', labels: true });
  await expect.poll(filed).toEqual({ 'Where is the Apollo ledger kept?': 'Where is the Apollo ledger kept?', 'what changed in the ledger?': 'what changed in the ledger?' });
});

test('back in Ask from the sidebar a question is placed among every conversation, the one shown included; asked in one it continues it, and one placed where it already shows has no line', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await back(page);
  await askAtHome(page, 'When does the pilot start?');
  await back(page);
  // The sidebar's Ask shows the conversation asked in last. Showing it is not being in it.
  await page.getByTestId('sidebar-ask').click();
  await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?']);
  await page.getByTestId('ask-field').fill('what changed for billing and the pilot?');
  await page.getByTestId('ask-field').press('Enter');
  // It could be either, so the page asks: the question alone, the conversation that was showing among the quick replies.
  const clarify = page.getByTestId('clarify');
  await expect(clarify.getByTestId('choice')).toHaveText(['When does the pilot start?', 'Who owns billing?', 'New question']);
  await expect(page.getByTestId('question')).toHaveText(['what changed for billing and the pilot?']);
  await expect(page.getByTestId('turn')).toHaveCount(0);
  await picture(page, 'ask-which-one-shown');
  // It carried no earlier turn, and every conversation it could be placed in, the one shown included.
  expect(asks().at(-1)).toEqual({ schema_version: 3, question: 'what changed for billing and the pilot?', labels: true, threads: [
    { questions: ['When does the pilot start?'], asked_at: expect.any(String) }, { questions: ['Who owns billing?'], asked_at: expect.any(String) }] });
  // Picked, the person is in the pilot's conversation: the words are asked there, with nothing that could place them again.
  await clarify.getByTestId('choice').nth(0).click();
  await expect(page.getByTestId('turn').last().getByTestId('question')).toHaveText('what changed for billing and the pilot?');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  expect(asks().at(-1)).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' } });
  expect(asks().at(-1)).not.toHaveProperty('threads');
  // A question typed now, in the conversation, continues it: the turn before it, and only the other conversation.
  await ask(page, 'did that change?');
  expect(asks().at(-1)).toMatchObject({ question: 'did that change?', previous: { purpose: 'follow_up' } });
  expect(asks().at(-1)!.threads).toEqual([{ questions: ['Who owns billing?'], asked_at: expect.any(String) }]);
  await expect.poll(filed).toMatchObject({ 'did that change?': 'When does the pilot start?', 'what changed for billing and the pilot?': 'When does the pilot start?' });

  // Back again, a question about the one conversation that is showing: asked with no earlier turn, it is placed there
  // without asking, and asked in it. Nothing moved, so no line says so and nothing offers an Undo.
  await back(page);
  await page.getByTestId('sidebar-ask').click();
  await expect(page.getByTestId('question')).toHaveText(['did that change?']);
  const before = asks().length;
  await ask(page, 'is the pilot still on?');
  await expect(page.getByTestId('clarify')).toHaveCount(0);
  await expect(page.getByTestId('moved-note')).toHaveCount(0);
  await expect(page.getByTestId('placed-undo')).toHaveCount(0);
  const [placed, again] = asks().slice(before);
  expect(placed).not.toHaveProperty('previous');
  expect((placed!.threads as { questions: string[] }[]).map(thread => thread.questions[0])).toEqual(['When does the pilot start?', 'Who owns billing?']);
  expect(again).toMatchObject({ question: 'is the pilot still on?', previous: { purpose: 'follow_up' } });
  expect(again).not.toHaveProperty('threads');
  expect(asks()).toHaveLength(before + 2);
  await expect.poll(filed).toMatchObject({ 'is the pilot still on?': 'When does the pilot start?' });

  // Back once more, and the conversation that is showing is picked behind the door, by Return on it as the one found:
  // the person is in it, so the next question continues it, in one request.
  await back(page);
  await page.getByTestId('sidebar-ask').click();
  const door = await openDoor(page);
  await door.getByTestId('door-find').fill('PILOT');
  await expect(door.getByTestId('door-row')).toHaveCount(1);
  await expect(door.getByTestId('door-row')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Enter');
  await expect(door).toHaveCount(0);
  await expect(page.getByTestId('ask-field')).toBeFocused();
  const picked = asks().length;
  await ask(page, 'and who runs it?');
  expect(asks()).toHaveLength(picked + 1);
  expect(asks().at(-1)).toMatchObject({ question: 'and who runs it?', previous: { purpose: 'follow_up', question: 'is the pilot still on?' } });
  await expect.poll(filed).toMatchObject({ 'and who runs it?': 'When does the pilot start?' });
});

test('the door stays shut while a question is on its way, and opens after with nothing left to find', async () => {
  // This Authority holds each answer until the test lets it go.
  run = await launch('ask-progress');
  const { page } = run;
  const release = join(run.home, 'release-ask');
  writeFileSync(release, '');
  await ask(page, 'When does the pilot start?');
  await back(page);
  rmSync(release);
  await page.getByTestId('ask-field').fill('Who owns billing?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('asking')).toBeVisible();
  // On its way, neither the title nor the up arrow opens it: nothing can jump while an answer has yet to land.
  await page.getByTestId('ask-title').click();
  await page.getByTestId('ask-field').press('ArrowUp');
  await expect(page.getByTestId('door')).toHaveCount(0);
  writeFileSync(release, '');
  await expect(page.getByTestId('asking')).toHaveCount(0);
  const door = await openDoor(page);
  await expect(door.getByTestId('door-find')).toHaveValue('');
  await expect(door.getByTestId('door-row')).toHaveCount(2);
});

test('Capture opened by its shortcut over the door keeps its own Escape and the keyboard', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'Who owns billing?');
  await openDoor(page);
  // An Escape from the find field as Capture comes up over Ask, as if pressed before Capture takes the keyboard. Whether
  // Capture has already taken it depends on the platform (Linux moves it before this observer runs, macOS after), so the
  // Escape is sent from the find field while the field is still there, and from wherever the keyboard is otherwise.
  const landed = page.evaluate(() => new Promise<string | null>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="compose"]')) return;
      observer.disconnect();
      const target = (document.querySelector('[data-testid="door-find"]') ?? document.activeElement) as HTMLElement | null;
      target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      resolve(target?.getAttribute('data-testid') ?? null);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }));
  // What ⌘⇧E has main send the page.
  await run.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.send('event', { name: 'capture.open', payload: {} }); });
  expect(['door-find', 'compose-body']).toContain(await landed);
  // The door did not take it: it was Capture's, which closed, leaving Ask as it was.
  await expect(page.getByTestId('compose')).toHaveCount(0);
  await expect(page.getByTestId('ask-view')).toBeVisible();
  await expect(page.getByTestId('question')).toHaveText(['Who owns billing?']);
});

test('an answer that does not say where a question asked with the conversations belongs is refused, and nothing of it is kept', async () => {
  // This Authority names the question and leaves out its place: with no previous turn there is no thread that could mean (T2).
  run = await launch('ask-threads-unplaced');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await page.getByTestId('ask-field').fill('When does the pilot start?');
  await page.getByTestId('ask-field').press('Enter');
  await expect(page.getByTestId('ask-error')).toHaveText('ECHO sent back something this app could not read. Try again, or update the app.');
  await expect(page.getByTestId('turn')).toHaveCount(0);
  expect(asks()).toEqual([{ schema_version: 3, question: 'When does the pilot start?', threads: [], labels: true }]);
  expect(file()).toEqual([]);
});

test('from a person\'s only conversation a new subject starts a second one: the question carries an empty list', async () => {
  run = await launch('ask-threads');
  const { page } = run;
  await expect(page.getByTestId('sidebar-project')).toHaveCount(2);
  await ask(page, 'When does the pilot start?');
  // The first question ever is one to be placed too: its list is empty.
  expect(asks()[0]).toEqual({ schema_version: 3, question: 'When does the pilot start?', threads: [], labels: true });
  // In that conversation, a question about it continues it.
  await ask(page, 'who decided that?');
  expect(asks()[1]).toMatchObject({ previous: { purpose: 'follow_up', question: 'When does the pilot start?' }, threads: [] });
  await expect(page.getByTestId('question')).toHaveText(['When does the pilot start?', 'who decided that?']);
  // An unrelated one, typed in the same conversation: the list still goes, empty, so the answer can say the subject is
  // new. A new subject has no line and no Undo.
  await ask(page, 'an unrelated one: what is for lunch?');
  expect(asks()[2]).toMatchObject({ question: 'an unrelated one: what is for lunch?', previous: { purpose: 'follow_up' }, threads: [] });
  await expect(page.getByTestId('question')).toHaveText(['an unrelated one: what is for lunch?']);
  await expect(page.getByTestId('placed-undo')).toHaveCount(0);
  await expect(page.locator('.note:not(.stamp)')).toHaveCount(0);
  await expect.poll(filed).toEqual({ 'When does the pilot start?': 'When does the pilot start?', 'who decided that?': 'When does the pilot start?',
    'an unrelated one: what is for lunch?': 'an unrelated one: what is for lunch?' });
  // Two conversations behind the door now, the first under the label its follow-up brought.
  const door = await openDoor(page);
  await expect(door.getByTestId('door-row').locator('.name')).toHaveText(['an unrelated one: what is for lunch?', 'When does the pilot start, who decided that']);
});
