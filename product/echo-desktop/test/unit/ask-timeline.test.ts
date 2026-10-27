// The Ask timeline (ADR-0047), in the store and on the page: which turns show
// in full and which fold, the timeline kept through navigation and read again
// at sign-in; one check of the newest turns' sources when Ask opens, kept five
// minutes, quiet when it fails, turned into Changed tags, lit sentences and
// sentences left out; the earlier turn a follow-up or Ask again carries, and
// how it is trimmed; "Which one?"; the sidebar's dots with a project's New
// rows; and the earlier questions past the newest three folded into one line,
// with the sidebar's Ask going back to where you left Ask.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonAnswerCitationV8 } from '@echo-brain/organization-api';
import type { Answer, AnswerSource, AnswerStatement, AppStatus, AskPrevious, AskReceipt, AskScope, ListItem, TimelineTurn } from '../../src/shared/protocol.js';
import { MAX_ASK_BODY_BYTES, MAX_CHECK_ITEMS } from '../../src/shared/protocol.js';
import {
  allOmitted, answeredNow, askedAgain, askedSuggestions, checkedOf, checkPlan, followedTurn, markOf, previousOf, shownInFull, threadOf, turnChanged, turnGroups, turnNote,
  visibleTurns,
} from '../../src/renderer/timeline.js';
import { suggestedQuestions } from '../../src/renderer/bar.js';
import { askedWhen } from '../../src/renderer/format.js';
import {
  ACCOUNT, byTestId, elements, fail, fileOf, flush, Held, latestTurn, numbered, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text, timelineFiles,
  type Node,
} from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
// Components are called as plain functions below.
vi.mock('preact/hooks', original => plainHooks(original));

const NOW = new Date('2026-10-25T15:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const sha = (text: string) => `sha256:${[...text].map(character => character.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64)}` as const;
const apollo = project(1, 30, { name: 'Apollo' });
/** The window's own key for the sidebar, which no account's sign-out touches. */
const SIDEBAR = 'echo.sidebarOpen';

/** A ticket as an answer cites it: its source, with the citation as the response carried it and its evidence citation. */
function ticket(key: string, id: string, permalink = `https://example.atlassian.net/browse/${key}`): AnswerSource {
  const citation = { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: id, permalink, text_sha256: sha(key) } as const;
  const cited: PersonAnswerCitationV8 = { citation, kind: 'ticket', label: `${key} · Sensor drift`, visibility: 'only_me' };
  return { kind: 'ticket', tool_id: 'jira', label: `${key} · Sensor drift`, permalink, private: true, cited };
}
/** A Confluence page an answer cites, the team's to read. */
function page(id: string): AnswerSource {
  const citation = { kind: 'page', tool_id: 'confluence', external_scope_id: 'cloud-1', page_id: id, section_id: 'summary', version: '3',
    permalink: `https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${id}`, text_sha256: sha(id) } as const;
  const cited: PersonAnswerCitationV8 = { citation, kind: 'page', label: 'DVT plan', visibility: 'team' };
  return { kind: 'page', tool_id: 'confluence', label: 'DVT plan', permalink: citation.permalink, cited };
}
/** A follow-up an answer cites. */
function followUp(id: string): AnswerSource {
  const citation = { kind: 'follow_up', item_id: id } as const;
  const cited: PersonAnswerCitationV8 = { citation, kind: 'follow_up', label: 'Confirm the trace', visibility: 'team', ref: `follow_up:${id}` as `follow_up:itm_${string}` };
  return { kind: 'follow_up', label: 'Confirm the trace', item_id: id, cited };
}
/** A person, whom no check asks about. */
const mara: AnswerSource = { kind: 'person', label: 'Mara Lind', membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
  cited: { citation: { kind: 'person', membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' }, kind: 'person', label: 'Mara Lind', visibility: 'team' } };

const said = (text: string, citation_indexes: number[], sources: readonly AnswerSource[] = []): AnswerStatement =>
  ({ text, citation_indexes, private: citation_indexes.some(at => sources[at]?.private === true) });

/** An answer citing `sources`, one sentence per `statements`. */
function answerOf(question: string, sources: readonly AnswerSource[], statements: readonly [string, number[]][], extra: Partial<Answer> = {}): Answer {
  const shown = statements.map(([words, cited]) => said(words, cited, sources));
  return { text: shown.map(statement => statement.text).join('\n'), scope: { kind: 'global' }, sources: [...sources], outcome: 'answered',
    parts: [{ question, status: 'answered', statements: shown }], ...extra };
}

let ids = 0;
/** A turn kept on the timeline, asked `ago` before NOW. */
function turn(question: string, ago: number, answer: Answer, extra: Partial<TimelineTurn> = {}): TimelineTurn {
  ids += 1;
  return { id: `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`, asked_at: new Date(NOW.getTime() - ago).toISOString(), text: question, question,
    scope: answer.scope, answer, ...extra };
}

/** THERM's status, three sources: a ticket, the DVT plan and a follow-up. */
const status = () => answerOf('What is open on THERM?', [ticket('THERM-482', '20482'), page('31010'), followUp('itm_timeline-1')],
  [['THERM-482, Sensor drift, is open.', [0]], ['The DVT plan moved the retest to Oct 30.', [1]], ['Confirm the trace is still open.', [2]]]);

let held: Held;
let checks: ((items: readonly { citation: { kind: string }; marker?: string }[]) => unknown) | null;
let activity: (() => unknown) | null;
let feed: ListItem[];
let storage: Map<string, string>;
storeLifecycle(NOW);
beforeEach(() => {
  ids = 0;
  held = new Held();
  checks = null;
  activity = null;
  feed = [];
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
    removeItem: (key: string) => { storage.delete(key); }, key: (index: number) => [...storage.keys()][index] ?? null, get length() { return storage.size; },
  });
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'ask.run': params => ok(answerOf(String(params.question), [ticket('THERM-482', '20482')], [['THERM-482 is open.', [0]]])),
    'ask.check': params => (checks ? checks(params.items as never) : fail('not_supported')),
    'projects.activity': () => (activity ? activity() : ok({ items: [{ project_id: apollo.project_id, latest_at: null }] })),
    'list.page': () => ok({ items: feed, next_cursor: null, meetings_held: false }),
    'ask.record': () => fail('not_found'),
  }, () => ({ active: [apollo], archived: [] })));
});

const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);
const seed = (...turns: TimelineTurn[]) => { timelineFiles.set(fileOf(ACCOUNT), turns); };
const kept = () => timelineFiles.get(fileOf(ACCOUNT)) ?? [];
const classes = (node: Node | undefined) => String(node?.props.class ?? '').split(' ').filter(Boolean);
const click = (node: Node | undefined) => (node!.props.onClick as () => void)();
async function view() {
  const screens = await import('../../src/renderer/screens/ask.js');
  return (store: { getState(): unknown }) => render(screens.AskView({ state: store.getState() as never }));
}

describe('the timeline\'s rules', () => {
  it('shows the latest turn and those asked since Ask opened in full, and folds every other', () => {
    const [one, two, three] = [turn('One?', 3 * DAY, status()), turn('Two?', 2 * DAY, status()), turn('Three?', DAY, status())];
    const turns = [one!, two!, three!];
    expect(turns.map(each => shownInFull(each, turns, []))).toEqual([false, false, true]);
    expect(turns.map(each => shownInFull(each, turns, [one!.id]))).toEqual([true, false, true]);
  });

  it('continues the turn opened, or else the latest asked in the last hour, and nothing else', () => {
    const [old, recent] = [turn('Old?', 2 * DAY, status()), turn('Recent?', 59 * 60_000, status())];
    expect(followedTurn([old!, recent!], null, NOW.getTime())).toBe(recent);
    expect(followedTurn([old!, recent!], old!.id, NOW.getTime())).toBe(old);
    expect(followedTurn([old!, recent!], null, NOW.getTime() + 2 * 60_000)).toBeNull();
    expect(followedTurn([], null, NOW.getTime())).toBeNull();
  });

  it('says when a turn was asked as its row does: the time for today, the day before that, and the year of another year', () => {
    expect(askedWhen(new Date(NOW.getTime() - HOUR).toISOString(), NOW.getTime())).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/u);
    expect(askedWhen('2026-10-14T12:00:00.000Z', NOW.getTime())).toBe('Oct 14');
    expect(askedWhen('2025-10-14T12:00:00.000Z', NOW.getTime())).toBe('Oct 14, 2025');
  });

  it('suggests the questions of a place\'s thread, newest first, each once: Home\'s every one, a project\'s its own (ADR-0049)', () => {
    const inApollo = { ...status(), scope: { kind: 'project' as const, project_id: apollo.project_id } };
    const turns = [turn('When do we ship?', 3 * DAY, status()), turn('Who owns it?', 2 * DAY, inApollo, { scope: inApollo.scope }), turn('when do we ship?', DAY, status())];
    // As the empty bar offers them: each once, the newest.
    const asked = (scope: AskScope) => suggestedQuestions(askedSuggestions(turns, scope), [], 'What did we decide this week?').filter(each => each.turn !== undefined);
    expect(asked({ kind: 'global' })).toEqual([{ question: 'when do we ship?', turn: turns[2]!.id }, { question: 'Who owns it?', turn: turns[1]!.id }]);
    expect(asked(inApollo.scope)).toEqual([{ question: 'Who owns it?', turn: turns[1]!.id }]);
  });

  it('shows each place its own thread, and each question once: a turn asked again, or asked again word for word there, folds away', () => {
    const inApollo = { kind: 'project' as const, project_id: apollo.project_id };
    const first = turn('When do we ship?', 4 * DAY, status());
    const apolloTurn = turn('Who owns it?', 3 * DAY, status(), { scope: inApollo });
    const again = turn('When do we ship?', 2 * DAY, status(), { again_of: first.id });
    const typed = turn('who owns  IT?', DAY, status(), { scope: inApollo });
    const elsewhere = turn('Who owns it?', HOUR, status());
    const turns = [first, apolloTurn, again, typed, elsewhere];
    expect(threadOf(turns, { kind: 'global' })).toEqual(turns);
    expect(threadOf(turns, inApollo)).toEqual([apolloTurn, typed]);
    // Home's thread: the first was asked again, and Apollo's question was asked again there; the same words asked at Home stay.
    expect(visibleTurns(threadOf(turns, { kind: 'global' }))).toEqual([again, typed, elsewhere]);
    expect(visibleTurns(threadOf(turns, inApollo))).toEqual([typed]);
  });
});

describe('what a check asks, and what it says of a turn', () => {
  it('asks once per citation of a turn, newest turn first, with a ticket\'s baseline, at most 100 items', () => {
    const repeated = answerOf('Q?', [ticket('THERM-482', '20482'), ticket('THERM-482', '20482'), mara, page('31010')], [['A.', [0, 1]], ['B.', [2, 3]]]);
    const [older, newer] = [turn('Older?', 2 * DAY, status(), { markers: { 0: sha('m1') } }), turn('Newer?', DAY, repeated)];
    const plan = checkPlan([newer!, older!]);
    // The same ticket twice in a turn is asked about once; a person never.
    expect(plan.items.map(item => [item.citation.kind, item.asked_at, item.marker ?? null])).toEqual([
      ['ticket', newer!.asked_at, null], ['page', newer!.asked_at, null],
      ['ticket', older!.asked_at, sha('m1')], ['page', older!.asked_at, null], ['follow_up', older!.asked_at, null],
    ]);
    expect(plan.places).toEqual([{ turn: newer!.id, sources: [0, 1] }, { turn: newer!.id, sources: [3] }, { turn: older!.id, sources: [0] }, { turn: older!.id, sources: [1] },
      { turn: older!.id, sources: [2] }]);
    // A new answer's tickets alone, for their baseline.
    expect(checkPlan([newer!], source => source.kind === 'ticket').items).toHaveLength(1);
    // At most 100 items in all.
    const wide = answerOf('Wide?', Array.from({ length: 30 }, (_, at) => ticket(`T-${at}`, String(1000 + at))), [['All of them.', [0]]]);
    expect(checkPlan(Array.from({ length: 5 }, (_, at) => turn(`W${at}?`, at * HOUR, wide))).items).toHaveLength(MAX_CHECK_ITEMS);
  });

  it('turns the results into each turn\'s sources\' states and its tickets\' markers', () => {
    const one = turn('One?', DAY, status());
    const plan = checkPlan([one]);
    const found = checkedOf(plan, [{ state: 'same', marker: sha('m2') }, { state: 'changed' }, { state: 'unreadable' }]);
    expect(found).toEqual({ turns: { [one.id]: { 0: 'same', 1: 'changed', 2: 'unreadable' } }, markers: { [one.id]: { 0: sha('m2') } } });
  });

  it('lights a sentence a changed source supports, leaves out one whose source you can no longer read, and tags the turn unless asked again', () => {
    const one = turn('One?', DAY, status());
    const states = { 0: 'same', 1: 'changed', 2: 'unreadable' } as const;
    expect(one.answer.parts[0]!.statements.map(statement => markOf(statement.citation_indexes, states))).toEqual([null, 'changed', 'omitted']);
    // Unreadable wins: a sentence citing both is left out.
    expect(markOf([1, 2], states)).toBe('omitted');
    expect(markOf([1], undefined)).toBeNull();
    expect(turnChanged(one, states, askedAgain([one]))).toBe(true);
    expect(turnChanged(one, { 0: 'same', 1: 'unknown', 2: 'same' }, askedAgain([one]))).toBe(false);
    // Asked again later: no tag.
    expect(turnChanged(one, states, askedAgain([one, turn('One?', HOUR, status(), { again_of: one.id })]))).toBe(false);
    expect(allOmitted(one, { 0: 'unreadable', 1: 'unreadable', 2: 'unreadable' })).toBe(true);
    expect(allOmitted(one, states)).toBe(false);
  });
});

describe('the earlier turn an Ask carries (C3)', () => {
  it('carries the full question, when it was asked, and the sentences you can still read with their citations, renumbered', () => {
    const one = turn('What is open on THERM?', HOUR, status());
    const previous = previousOf(one, 'follow_up', { 0: 'same', 1: 'changed', 2: 'unreadable' }, 'Who owns it?', { kind: 'global' });
    expect(previous).toEqual({
      purpose: 'follow_up', question: 'What is open on THERM?', asked_at: one.asked_at,
      statements: [{ text: 'THERM-482, Sensor drift, is open.', citation_indexes: [0] }, { text: 'The DVT plan moved the retest to Oct 30.', citation_indexes: [1] }],
      citations: [one.answer.sources[0]!.cited, one.answer.sources[1]!.cited],
    });
    const texts = (known: Parameters<typeof previousOf>[2]) => previousOf(one, 'follow_up', known, 'Who owns it?', { kind: 'global' }).statements.map(statement => statement.text);
    // Only what is known to be readable now: a source a check could not tell about, or did not ask about, keeps its sentence back.
    expect(texts({ 0: 'same', 1: 'unknown', 2: 'same' })).toEqual(['THERM-482, Sensor drift, is open.', 'Confirm the trace is still open.']);
    expect(texts({ 0: 'same' })).toEqual(['THERM-482, Sensor drift, is open.']);
    // Nothing known: its question alone.
    expect(previousOf(one, 'follow_up', null, 'Who owns it?', { kind: 'global' })).toEqual({ purpose: 'follow_up', question: 'What is open on THERM?',
      asked_at: one.asked_at, statements: [], citations: [] });
    // A new turn's own answer read every source a check asks about; one no check asks about (a person) keeps nothing back.
    expect(texts(answeredNow(one))).toHaveLength(3);
    const named = turn('Who owns it?', HOUR, answerOf('Who owns it?', [ticket('THERM-482', '20482'), mara], [['Mara owns THERM-482.', [0, 1]]]));
    expect(answeredNow(named)).toEqual({ 0: 'same' });
    expect(previousOf(named, 'follow_up', { 0: 'same' }, 'And since?', { kind: 'global' }).statements).toHaveLength(1);
  });

  it('keeps eight sentences at most, each 400 characters and four citations, and twelve citations in all', () => {
    const sources = Array.from({ length: 16 }, (_, at) => ticket(`T-${at}`, String(2000 + at)));
    const long = 'x'.repeat(500);
    const answer = answerOf('Wide?', sources, [[long, [0, 1, 2, 3, 4]], ...Array.from({ length: 9 }, (_, at) => [`Sentence ${at}.`, [5 + at]] as [string, number[]])]);
    const wide = turn('Wide?', HOUR, answer);
    const previous = previousOf(wide, 'ask_again', answeredNow(wide), 'Wide?', { kind: 'global' });
    expect(previous.statements).toHaveLength(8);
    expect(previous.statements[0]!.text.length).toBeLessThanOrEqual(400);
    expect(previous.statements[0]!.text.endsWith('…')).toBe(true);
    expect(previous.statements[0]!.citation_indexes).toEqual([0, 1, 2, 3]);
    expect(previous.citations.length).toBeLessThanOrEqual(12);
    expect(previous.statements.flatMap(statement => statement.citation_indexes).every(at => at < previous.citations.length)).toBe(true);
  });

  it('sends each citation once, however many places of the answer cite it, and each sentence citing it once', () => {
    const same = ticket('THERM-482', '20482');
    const answer = answerOf('Twice?', [same, page('31010'), { ...same }], [['THERM-482 is open.', [0, 2]], ['The plan moved.', [1, 0]]]);
    const twice = turn('Twice?', HOUR, answer);
    const previous = previousOf(twice, 'follow_up', answeredNow(twice), 'Who owns it?', { kind: 'global' });
    expect(previous.citations).toEqual([same.cited, answer.sources[1]!.cited]);
    expect(previous.statements.map(statement => statement.citation_indexes)).toEqual([[0], [1, 0]]);
  });

  it('leaves sentences off the end until the whole Ask fits its 16 KiB', () => {
    const permalink = (at: number) => `https://example.atlassian.net/browse/${'L'.repeat(1_800)}${at}`;
    const sources = Array.from({ length: 12 }, (_, at) => ticket(`L-${at}`, String(3000 + at), permalink(at)));
    const answer = answerOf('Long?', sources, Array.from({ length: 8 }, (_, at) => [`${'y'.repeat(380)} ${at}.`, [at, at + 4 > 11 ? 11 : at + 4]] as [string, number[]]));
    const long = turn('Long?', HOUR, answer);
    const previous: AskPrevious = previousOf(long, 'follow_up', answeredNow(long), 'And then?', { kind: 'global' });
    const body = JSON.stringify({ schema_version: 3, question: 'And then?', previous });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_ASK_BODY_BYTES);
    expect(previous.statements.length).toBeGreaterThan(0);
    expect(previous.statements.length).toBeLessThan(8);
    // From the end: the first sentences stay.
    expect(previous.statements[0]!.text).toBe(answer.parts[0]!.statements[0]!.text);
  });
});

describe('Ask on the timeline', () => {
  it('keeps the timeline through navigation, reads it at sign-in, and shows the latest in full and the others as lines', async () => {
    seed(turn('Two days ago?', 2 * DAY, status()), turn('Yesterday?', DAY, status()));
    const store = await startStore();
    expect(store.getState().timeline.turns.map(each => each.question)).toEqual(['Two days ago?', 'Yesterday?']);
    await store.ask('What now?');
    await flush();
    const thread = await view();
    expect(byTestId(thread(store), 'timeline-question').map(text)).toEqual(['Two days ago?']);
    expect(byTestId(thread(store), 'question').map(text)).toEqual(['Yesterday?', 'What now?']);
    // Today's line sits above the first of today's turns, under earlier days.
    const shown = elements(thread(store)).filter(node => node.props['data-testid'] === 'today' || node.props['data-testid'] === 'turn'
      || node.props['data-testid'] === 'timeline-row');
    expect(shown.map(node => node.props['data-testid'])).toEqual(['timeline-row', 'turn', 'today', 'turn']);
    expect(kept().map(each => each.text)).toEqual(['Two days ago?', 'Yesterday?', 'What now?']);
    // Navigation closes Ask, and keeps the timeline: the next Ask folds what this one asked but the latest.
    await store.openProject(apollo);
    expect(store.getState().ask).toBeNull();
    expect(store.getState().timeline.turns).toHaveLength(3);
    store.goHome();
    await store.ask('And next?');
    await flush();
    expect(byTestId(thread(store), 'timeline-question').map(text)).toEqual(['Two days ago?', 'Yesterday?']);
    expect(byTestId(thread(store), 'question').map(text)).toEqual(['What now?', 'And next?']);
  });

  it.each([
    [1, ['Yesterday?']],
    [2, []],
  ])('reads the timeline once more when the read at sign-in fails, and no more (%i failing)', async (failing, shown) => {
    let failures = failing;
    const timeline = rpcFor(held, {}, () => ({ active: [apollo], archived: [] }));
    rpc.mockImplementation((method: string, params: Record<string, unknown>) => (method === 'timeline.read' && failures-- > 0
      ? Promise.resolve(fail('failed', { retryable: true })) : timeline(method, params)));
    seed(turn('Yesterday?', DAY, status()));
    const store = await startStore();
    await flush();
    expect(calls('timeline.read')).toHaveLength(2);
    expect(store.getState().timeline.turns.map(each => each.question)).toEqual(shown);
  });

  it('keeps what the person typed for a turn in full, and the full question its answer answers for its line and Ask again', async () => {
    rpc.mockImplementation(rpcFor(held, {
      'ask.run': params => ok({ ...answerOf('Who owns THERM-482?', [ticket('THERM-482', '20482')], [['Dev owns THERM-482, since Oct 21.', [0]]]),
        ...(params.previous ? { question: 'Who owns THERM-482?' } : {}) }),
    }, () => ({ active: [apollo], archived: [] })));
    seed(turn('What is open on THERM?', 10 * 60_000, status()));
    const store = await startStore();
    await store.ask('What else?');
    await store.ask('who owns it?');
    await flush();
    const latest = latestTurn(store)!;
    expect(latest).toMatchObject({ text: 'who owns it?', question: 'Who owns THERM-482?' });
    const thread = await view();
    expect(byTestId(thread(store), 'question').map(text).at(-1)).toBe('who owns it?');
    // Ask opened again is on that turn, the latest, in full; once a later Ask folds it, its line says the full question.
    store.closeAsk();
    await store.ask('Unrelated?');
    await flush();
    expect(byTestId(thread(store), 'question').map(text)).toEqual(['who owns it?', 'Unrelated?']);
    store.closeAsk();
    await store.ask('Another?');
    await flush();
    expect(byTestId(thread(store), 'timeline-question').map(text)).toEqual(['What is open on THERM?', 'What else?', 'Who owns THERM-482?']);
  });

  it('checks the newest ten turns\' sources once when Ask opens, keeps that five minutes, and tags, lights and leaves out by it', async () => {
    const turns = Array.from({ length: 11 }, (_, at) => turn(`Turn ${at}?`, (11 - at) * DAY, status()));
    seed(...turns);
    checks = items => ok({ items: items.map(item => (item.citation.kind === 'page' ? { state: 'changed' } : item.citation.kind === 'follow_up'
      ? { state: 'unreadable' } : { state: 'same', marker: sha('m1') })) });
    const store = await startStore();
    await store.ask('What changed?');
    await flush();
    const [asked] = calls('ask.check');
    // The ten newest, newest first, three sources each.
    expect((asked!.items as unknown[]).length).toBe(30);
    expect((asked!.items as { asked_at: string }[])[0]!.asked_at).toBe(turns[10]!.asked_at);
    expect(Object.keys(store.getState().timeline.checks)).toHaveLength(10);
    // A ticket a check read for the first time keeps its marker as its baseline.
    expect(kept().find(each => each.id === turns[5]!.id)?.markers).toEqual({ 0: sha('m1') });
    const thread = await view();
    // Past the newest three, earlier questions fold into one line: opened, every line shows.
    store.toggleEarlier();
    const rows = byTestId(thread(store), 'timeline-row');
    // The oldest turn was not checked: no tag. The latest is in full.
    expect(rows.map(row => byTestId(row, 'changed-tag').length)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    store.toggleTurn(turns[3]!.id);
    const opened = byTestId(thread(store), 'opened-turn')[0]!;
    const statements = byTestId(opened, 'statement');
    expect(statements.map(node => text(byTestId(node, 'statement-text')))).toEqual(['THERM-482, Sensor drift, is open.', 'The DVT plan moved the retest to Oct 30.']);
    expect(statements.map(node => node.props['data-mark'] ?? null)).toEqual([null, 'changed']);
    expect(classes(byTestId(opened, 'answer')[0])).toContain('dimmed');
    expect(text(byTestId(opened, 'changed-since'))).toBe(`Changed since ${askedWhen(turns[3]!.asked_at, NOW.getTime())}`);
    expect(byTestId(opened, 'ask-again')).toHaveLength(1);
    // Within five minutes Ask opens on what that check said; after, it checks again. (Each new answer's ticket has its own baseline read.)
    const opening = () => calls('ask.check').filter(call => (call.items as unknown[]).length > 1);
    store.closeAsk();
    await store.ask('Again?');
    await flush();
    expect(opening()).toHaveLength(1);
    store.closeAsk();
    vi.setSystemTime(NOW.getTime() + 6 * 60_000);
    await store.ask('Later?');
    await flush();
    expect(opening()).toHaveLength(2);
  });

  it('leaves a source you can no longer read out of its turn\'s sources, the numbers of the page, its list and the pane agreeing', async () => {
    const one = turn('One?', 2 * DAY, status());
    // Out only when every citation of a place is unreadable; the rest keep their places among the answer's sources.
    expect(turnGroups(one.answer.sources, { 0: 'same', 1: 'changed', 2: 'unreadable' }).map(group => group.indexes)).toEqual([[0], [1]]);
    expect(turnGroups(one.answer.sources, undefined)).toHaveLength(3);
    const twice = [ticket('THERM-482', '20482'), page('31010'), page('31010')];
    expect(turnGroups(twice, { 1: 'unreadable', 2: 'same' }).map(group => group.indexes)).toEqual([[0], [1, 2]]);
    seed(one, turn('Two?', DAY, status()));
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'follow_up' ? 'unreadable' : 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    store.toggleSourceList(one.id);
    const thread = await view();
    const opened = byTestId(thread(store), 'opened-turn')[0]!;
    expect(text(byTestId(opened, 'sources-toggle'))).toMatch(/^2 sources/u);
    expect(byTestId(opened, 'source-row').map(text)).toEqual(['1THERM-482 · Sensor drift', '2DVT plan']);
    expect(byTestId(opened, 'citation').map(text)).toEqual(['1', '2']);
    // The second number opens the DVT plan, as the pane numbers it.
    click(byTestId(opened, 'citation')[1]);
    expect(store.getState().sources).toMatchObject({ turn: one.id, open: 1 });
    expect(store.paneTarget()).toMatchObject({ number: 1, sources: [one.answer.sources[1]] });
    expect(store.answerGroups()).toHaveLength(2);
  });

  it.each([1, 2])('keeps the selected source when a pending check removes a preceding group (%i)', async selected => {
    const one = turn('One?', DAY, answerOf('One?', [ticket('A', '1'), page('2'), page('3')], [['Three sources.', [0, 1, 2]]]));
    seed(one);
    const checked = held.hold('ask.check');
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    store.chooseSource(selected, '0.0', one.id);
    expect(store.paneTarget()?.sources).toEqual([one.answer.sources[selected]]);
    checked(ok({ items: [{ state: 'unreadable' }, { state: 'same' }, { state: 'same' }] }));
    await flush();
    expect(store.paneTarget()).toMatchObject({ number: selected - 1, sources: [one.answer.sources[selected]] });
    expect(store.getState().sources).toMatchObject({ open: selected - 1, focus: '0.0' });
  });

  it('closes the pane when the pending check removes its selected source', async () => {
    const one = turn('One?', DAY, answerOf('One?', [ticket('A', '1'), page('2'), page('3')], [['Three sources.', [0, 1, 2]]]));
    seed(one);
    const checked = held.hold('ask.check');
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    store.chooseSource(1, '0.0', one.id);
    checked(ok({ items: [{ state: 'same' }, { state: 'unreadable' }, { state: 'same' }] }));
    await flush();
    expect(store.paneTarget()).toBeNull();
    expect(store.getState().sources).toMatchObject({ open: null, focus: null, evidence: null });
  });

  it('keeps the selected source when a check restores a preceding group', async () => {
    const one = turn('One?', DAY, status(), { unreadable: [0] });
    seed(one);
    const checked = held.hold('ask.check');
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    store.chooseSource(0, null, one.id);
    expect(store.paneTarget()?.sources).toEqual([one.answer.sources[1]]);
    checked(ok({ items: [{ state: 'same' }, { state: 'same' }, { state: 'same' }] }));
    await flush();
    expect(store.paneTarget()).toMatchObject({ number: 1, sources: [one.answer.sources[1]] });
  });

  it.each(['pending', 'settled', 'removed'])('keeps or discards original evidence with its selected source (%s)', async reading => {
    const ref = {
      source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha('6'),
    } as const;
    const original: AnswerSource = { kind: 'original', label: 'Launch notes', ref,
      cited: { kind: 'note', label: 'Launch notes', visibility: 'only_me', citation: { kind: 'source_revision', ...ref } } };
    const one = turn('One?', DAY, answerOf('One?', [ticket('A', '1'), original, page('3')], [['Three sources.', [0, 1, 2]]]));
    seed(one);
    const checked = held.hold('ask.check');
    const evidence = held.hold('ask.source');
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    store.chooseSource(1, null, one.id);
    if (reading === 'settled') { evidence(ok({ label: 'Launch notes', text: 'We agreed to ship.' })); await flush(); }
    checked(ok({ items: [{ state: 'unreadable' }, { state: reading === 'removed' ? 'unreadable' : 'same' }, { state: 'same' }] }));
    await flush();
    if (reading !== 'settled') { evidence(ok({ label: 'Launch notes', text: 'We agreed to ship.' })); await flush(); }
    if (reading === 'removed') {
      expect(store.paneTarget()).toBeNull();
      expect(store.getState().sources).toMatchObject({ open: null, evidence: null });
      return;
    }
    expect(store.paneTarget()).toMatchObject({ number: 0, sources: [original] });
    expect(store.getState().sources?.evidence).toMatchObject({ group: 0, reads: { 1: { loading: false, value: { text: 'We agreed to ship.' } } } });
    const { SourcePane } = await import('../../src/renderer/screens/ask.js');
    const pane = render(SourcePane({ state: store.getState() }));
    expect(text(byTestId(pane, 'evidence-text'))).toBe('We agreed to ship.');
    expect(text(pane)).not.toContain('Loading verified evidence');
    expect(calls('ask.source')).toHaveLength(1);
  });

  it('says nothing when nothing changed (ADR-0049), and with every sentence left out shows only Ask again', async () => {
    const [one, two] = [turn('One?', 2 * DAY, status()), turn('Two?', DAY, status())];
    seed(one, two);
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    const thread = await view();
    expect(byTestId(thread(store), 'changed-since')).toEqual([]);
    expect(text(thread(store))).not.toContain('Nothing changed');
    checks = items => ok({ items: items.map(() => ({ state: 'unreadable' })) });
    store.closeAsk();
    vi.setSystemTime(NOW.getTime() + 6 * 60_000);
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    const opened = byTestId(thread(store), 'opened-turn')[0]!;
    expect(byTestId(opened, 'answer')).toEqual([]);
    expect(byTestId(opened, 'changed-since')).toEqual([]);
    expect(byTestId(opened, 'ask-again')).toHaveLength(1);
  });

  it('says nothing changed only when every source its sentences cite was checked and is the same, and nothing when the check could not tell', async () => {
    const [one, two] = [turn('One?', 2 * DAY, status()), turn('Two?', DAY, status())];
    seed(one, two);
    // The ticket and the follow-up are as they were; the DVT plan's tool could not be read.
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'page' ? 'unknown' : 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    const thread = await view();
    // No line under the turn opened, nor under the latest, asked before this Ask; Ask again stays, and nothing is tagged.
    const opened = byTestId(thread(store), 'opened-turn')[0]!;
    expect(byTestId(opened, 'changed-since')).toEqual([]);
    expect(byTestId(opened, 'ask-again')).toHaveLength(1);
    const latest = byTestId(thread(store), 'turn').find(node => node.props['data-turn'] === two.id)!;
    expect(byTestId(latest, 'changed-since')).toEqual([]);
    expect(byTestId(latest, 'ask-again')).toHaveLength(1);
    expect(byTestId(thread(store), 'changed-tag')).toEqual([]);
    // What the line says, sentence by sentence: the same only when every source they cite was checked and is the same.
    expect(turnNote(one, { 0: 'same', 1: 'same', 2: 'same' })).toBe('same');
    expect(turnNote(one, { 0: 'same', 1: 'unknown', 2: 'same' })).toBeNull();
    expect(turnNote(one, { 0: 'same', 2: 'same' })).toBeNull();
    expect(turnNote(one, undefined)).toBeNull();
    // Changed whenever a sentence it shows cites a source that changed, whatever else could not be told.
    expect(turnNote(one, { 0: 'unknown', 1: 'changed' })).toBe('changed');
    // A sentence left out says nothing: the rest are the same.
    expect(turnNote(one, { 0: 'same', 1: 'same', 2: 'unreadable' })).toBe('same');
    expect(turnNote(one, { 0: 'unreadable', 1: 'unreadable', 2: 'unreadable' })).toBeNull();
    // A source no check asks about (a person) is never known to be the same.
    const named = turn('Who owns it?', DAY, answerOf('Who owns it?', [ticket('THERM-482', '20482'), mara], [['Mara owns THERM-482.', [0, 1]]]));
    expect(turnNote(named, { 0: 'same' })).toBeNull();
  });

  it('shows no tag or line from a check once it is five minutes old, nor from one that fails then, and still hides what cites an unreadable source', async () => {
    const [one, two] = [turn('One?', 2 * DAY, status()), turn('Two?', DAY, status())];
    seed(one, two);
    let failing = false;
    checks = items => (failing ? fail('unavailable', { retryable: true }) : ok({ items: items.map(item => ({
      state: item.citation.kind === 'page' ? 'changed' : item.citation.kind === 'follow_up' ? 'unreadable' : 'same' })) }));
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    const thread = await view();
    const marks = () => byTestId(byTestId(thread(store), 'opened-turn')[0], 'statement').map(node => node.props['data-mark'] ?? null);
    // The line opened says it in the answer, not as a tag; so does the latest, asked before this Ask.
    expect(byTestId(thread(store), 'changed-tag')).toEqual([]);
    expect(byTestId(thread(store), 'changed-since')).toHaveLength(2);
    expect(marks()).toEqual([null, 'changed']);
    // Five minutes on, Ask still open: no tag, no line, nothing highlighted; the follow-up the check could not read stays out.
    vi.setSystemTime(NOW.getTime() + 5 * 60_000);
    expect(byTestId(thread(store), 'changed-tag')).toEqual([]);
    expect(byTestId(thread(store), 'changed-since')).toEqual([]);
    expect(marks()).toEqual([null, null]);
    expect(store.checksOf(one)).toEqual({ 2: 'unreadable' });
    // Ask opened again: its check fails, and what the last one said goes with it, but not what it could not read.
    store.closeAsk();
    failing = true;
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    expect(calls('ask.check')).toHaveLength(2);
    expect(store.getState().timeline.checks).toEqual({});
    expect(byTestId(thread(store), 'changed-tag')).toEqual([]);
    expect(marks()).toEqual([null, null]);
  });

  it('keeps what cites a source a check found unreadable hidden, in the file too, until a check finds it readable again', async () => {
    const [one, two] = [turn('One?', 2 * DAY, status()), turn('Two?', DAY, status())];
    seed(one, two);
    let followUp = 'unreadable';
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'follow_up' ? followUp : 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    const thread = await view();
    const said = () => byTestId(byTestId(thread(store), 'opened-turn')[0], 'statement').map(text);
    const trace = (lines: string[]) => lines.some(line => line.includes('Confirm the trace'));
    expect(trace(said())).toBe(false);
    expect(kept().find(each => each.id === one.id)?.unreadable).toEqual([2]);
    // Long past the five minutes a check is good for, and through a check that cannot tell, it stays out.
    followUp = 'unknown';
    vi.setSystemTime(NOW.getTime() + 60 * 60_000);
    store.closeAsk();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    expect(trace(said())).toBe(false);
    expect(kept().find(each => each.id === one.id)?.unreadable).toEqual([2]);
    // A check that reads it again shows it again, and the file lets it go.
    followUp = 'same';
    vi.setSystemTime(NOW.getTime() + 2 * 60 * 60_000);
    store.closeAsk();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    expect(trace(said())).toBe(true);
    expect(kept().find(each => each.id === one.id)).not.toHaveProperty('unreadable');
  });

  it('hides what the file says a check found unreadable before any check runs, as after a restart', async () => {
    const [one, two] = [turn('One?', 2 * DAY, status(), { unreadable: [2] }), turn('Two?', DAY, status())];
    seed(one, two);
    checks = () => fail('unavailable', { retryable: true });
    const store = await startStore();
    store.pickSuggestion({ question: 'One?', turn: one.id });
    await flush();
    const thread = await view();
    const opened = byTestId(thread(store), 'opened-turn')[0]!;
    expect(byTestId(opened, 'statement').map(text).some(line => line.includes('Confirm the trace'))).toBe(false);
    expect(byTestId(opened, 'statement')).toHaveLength(2);
    // Nothing it carries into a follow-up cites the source either.
    expect(store.checksOf(one)).toEqual({ 2: 'unreadable' });
  });

  it('clears what a check said when it goes stale, so the page stops showing it then', async () => {
    seed(turn('One?', 2 * DAY, status()), turn('Two?', DAY, status()));
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'page' ? 'changed' : 'same' })) });
    const store = await startStore();
    await store.ask('What changed?');
    await flush();
    expect(Object.keys(store.getState().timeline.checks)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(Object.keys(store.getState().timeline.checks)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().timeline.checks).toEqual({});
  });

  it('fails quietly, with no tags, and the next Ask opening checks again', async () => {
    seed(turn('One?', 2 * DAY, status()), turn('Two?', DAY, status()));
    const store = await startStore();
    await store.ask('What changed?');
    await flush();
    const thread = await view();
    expect(byTestId(thread(store), 'changed-tag')).toEqual([]);
    // The check of the newest turns, as Ask opened.
    const newest = () => calls('ask.check').filter(call => (call.items as unknown[]).length > 1);
    expect(newest()).toHaveLength(1);
    store.closeAsk();
    vi.setSystemTime(NOW.getTime() + 10 * 60_000);
    await store.ask('Still?');
    await flush();
    expect(newest()).toHaveLength(2);
    expect(byTestId(thread(store), 'changed-tag')).toEqual([]);
  });

  it('copies an old answer as the page shows it: nothing a check left out, its sources numbered as the page numbers them', async () => {
    const sources = [ticket('THERM-482', '20482'), followUp('itm_timeline-1'), page('31010')];
    const base = answerOf('What is open on THERM?', sources, [['THERM-482, Sensor drift, is open.', [0]], ['Confirm the trace is still open.', [1]],
      ['The DVT plan moved the retest to Oct 30.', [2]]]);
    const laidOut: Answer = { ...base, parts: [{ ...base.parts[0]!, layout: [
      { kind: 'lead', statements: [0] }, { kind: 'heading', text: 'Still to do' }, { kind: 'bullets', statements: [1] },
      { kind: 'table', statements: [0, 1, 2], columns: ['Item', 'Status'], rows: [{ cells: ['THERM-482', 'Open'], citation_indexes: [0] },
        { cells: ['Trace', 'Open'], citation_indexes: [1] }, { cells: ['DVT plan', 'Moved'], citation_indexes: [2] }] },
    ] }] };
    const long = 'x'.repeat(11_990);
    const plain = answerOf('Long?', sources, [[long, [0]], ['Confirm the trace is still open.', [1]]]);
    const [one, two] = [turn('What is open on THERM?', 2 * DAY, laidOut), turn('Long?', DAY, plain)];
    // The follow-up is no longer yours to read; the DVT plan changed.
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'follow_up' ? 'unreadable' : item.citation.kind === 'page' ? 'changed' : 'same' })) });
    const copied: string[] = [];
    rpc.mockImplementation(rpcFor(held, {
      'ask.check': params => checks!(params.items as never),
      'clipboard.writeText': params => { copied.push(String(params.text)); return ok(null); },
      'ask.record': () => fail('not_found'),
    }, () => ({ active: [apollo], archived: [] })));
    seed(one, two);
    const store = await startStore();
    store.pickSuggestion({ question: one.question, turn: one.id });
    await flush();
    expect(await store.copyAnswer(one.id)).toBe(true);
    expect(copied[0]).toBe([
      'THERM-482, Sensor drift, is open. [1]', '',
      '| Item | Status |', '| --- | --- |', '| THERM-482 [1] | Open |', '| DVT plan [2] | Moved |', '',
      'Sources', '', '1. THERM-482 · Sensor drift', '2. DVT plan',
    ].join('\n'));
    // Past what Copy answer takes, its plain text, without what was left out.
    expect(await store.copyAnswer(two.id)).toBe(true);
    expect(copied[1]).toBe(long);
  });

  it('copies Ask again\'s "Since" first, as the page shows it: with its numbers, "Nothing changed" for an empty one, and nothing a check left out', async () => {
    const sources = [ticket('THERM-482', '20482'), page('31010'), followUp('itm_timeline-1')];
    const answer = answerOf('What is open on THERM?', sources, [['THERM-482, Sensor drift, is open.', [0]]]);
    const earlier = turn('What is open on THERM?', 3 * DAY, answer);
    const again = turn('What is open on THERM?', 2 * DAY, answer, { again_of: earlier.id,
      since: [said('The DVT plan moved the retest to Oct 30.', [1], sources), said('Confirm the trace is still open.', [2], sources)] });
    const quiet = turn('What is open on THERM?', DAY, answer, { again_of: earlier.id, since: [] });
    // The follow-up is no longer yours to read: what cites it is left out of the copy as it is of the page.
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'follow_up' ? 'unreadable' : 'same' })) });
    const copied: string[] = [];
    rpc.mockImplementation(rpcFor(held, {
      'ask.check': params => checks!(params.items as never),
      'clipboard.writeText': params => { copied.push(String(params.text)); return ok(null); },
      'ask.record': () => fail('not_found'),
    }, () => ({ active: [apollo], archived: [] })));
    seed(earlier, again, quiet);
    const store = await startStore();
    store.pickSuggestion({ question: again.question, turn: again.id });
    await flush();
    const when = askedWhen(earlier.asked_at, NOW.getTime());
    expect(await store.copyAnswer(again.id)).toBe(true);
    expect(copied[0]).toBe([
      `**Since ${when}**`, '', '- The DVT plan moved the retest to Oct 30. [2]', '',
      'THERM-482, Sensor drift, is open. [1]', '',
      'Sources', '', '1. THERM-482 · Sensor drift', '2. DVT plan',
    ].join('\n'));
    expect(await store.copyAnswer(quiet.id)).toBe(true);
    expect(copied[1]!.startsWith(`Nothing changed since ${when}\n\nTHERM-482, Sensor drift, is open. [1]`)).toBe(true);
  });

  it('keeps of a turn only what the page reads back: its full question and "since" once, no receipt, and each source\'s citation once', async () => {
    const receipt: AskReceipt = { looked_through: 1, elapsed_ms: 4_000, rows: [{ type: 'read', items: [ticket('THERM-482', '20482')] }] };
    rpc.mockImplementation(rpcFor(held, {
      'ask.run': params => {
        const answer = answerOf(String(params.question), [ticket('THERM-482', '20482')], [['THERM-482 is in progress.', [0]]]);
        return ok({ ...answer, receipt, question: 'What is open on THERM?', since: [said('THERM-482 moved to In Progress.', [0], answer.sources)] });
      },
      'ask.check': params => ok({ items: (params.items as unknown[]).map(() => ({ state: 'same' })) }),
    }, () => ({ active: [apollo], archived: [] })));
    const one = turn('What is open on THERM?', 2 * DAY, status());
    seed(one);
    const store = await startStore();
    store.pickSuggestion({ question: one.question, turn: one.id });
    await flush();
    store.askAgain(one.id);
    await flush();
    const again = kept().at(-1)!;
    expect(again).toMatchObject({ again_of: one.id, question: 'What is open on THERM?', since: [{ text: 'THERM-482 moved to In Progress.' }] });
    for (const key of ['receipt', 'question', 'since', 'choices']) expect(again.answer).not.toHaveProperty(key);
    expect(again.answer.sources[0]).not.toHaveProperty('check');
    expect(again.answer.sources[0]!.cited).toEqual(ticket('THERM-482', '20482').cited);
    // What a check asks about comes from the citation the answer cited it by.
    store.closeAsk();
    vi.setSystemTime(NOW.getTime() + 6 * 60_000);
    await store.ask('Anything new?');
    await flush();
    const opening = calls('ask.check').find(call => (call.items as { asked_at: string }[]).some(item => item.asked_at === again.asked_at))!;
    expect((opening.items as { citation: unknown }[])[0]!.citation).toEqual(ticket('THERM-482', '20482').cited!.citation);
  });

  it('reads a new answer\'s tickets once, for the baseline a later check compares with', async () => {
    checks = items => ok({ items: items.map(() => ({ state: 'same', marker: sha('base') })) });
    const store = await startStore();
    await store.ask('What is open?');
    await flush();
    const [baseline] = calls('ask.check');
    expect(baseline!.items).toEqual([{ asked_at: latestTurn(store)!.asked_at, citation: ticket('THERM-482', '20482').cited!.citation }]);
    expect(kept()[0]!.markers).toEqual({ 0: sha('base') });
  });
});

describe('follow-ups, "Which one?" and Ask again (C3)', () => {
  it('carries the latest turn asked in the last hour while Ask is open, the turn opened over it, and nothing from a page', async () => {
    const [old, recent] = [turn('Old?', 2 * DAY, status()), turn('Recent?', 30 * 60_000, status())];
    seed(old, recent);
    const store = await startStore();
    // From a page: asked on its own.
    await store.ask('First?');
    expect(calls('ask.run')[0]).not.toHaveProperty('previous');
    // Ask open: continues the latest, asked just now.
    await store.ask('who owns it?');
    expect(calls('ask.run')[1]!.previous).toMatchObject({ purpose: 'follow_up', question: 'First?' });
    // An earlier turn opened: continues that one.
    store.toggleTurn(old.id);
    await store.ask('and that one?');
    expect(calls('ask.run')[2]!.previous).toMatchObject({ purpose: 'follow_up', question: 'Old?', asked_at: old.asked_at });
    // Once a question about it is answered, the conversation goes on from that answer, though the turn stays open.
    await store.ask('and when is it due?');
    expect(calls('ask.run')[3]!.previous).toMatchObject({ purpose: 'follow_up', question: 'and that one?' });
    expect(store.getState().ask?.opened).toBe(old.id);
    // The latest asked over an hour ago, nothing opened: asked on its own.
    store.toggleTurn(old.id);
    vi.setSystemTime(NOW.getTime() + 2 * HOUR);
    await store.ask('Something new?');
    expect(calls('ask.run')[4]).not.toHaveProperty('previous');
  });

  it('continues a turn chosen from the bar\'s suggestions, the latest included, which stays in full', async () => {
    const [older, latest] = [turn('Older?', 3 * DAY, status()), turn('Latest?', 2 * DAY, status())];
    seed(older, latest);
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: 'Latest?', turn: latest.id });
    await flush();
    expect(store.getState().ask?.opened).toBe(latest.id);
    const thread = await view();
    expect(byTestId(thread(store), 'timeline-question').map(text)).toEqual(['Older?']);
    expect(byTestId(thread(store), 'question').map(text)).toEqual(['Latest?']);
    // Asked two days ago, so only because it was chosen does the next question continue it.
    await store.ask('who owns it?');
    expect(calls('ask.run')[0]!.previous).toMatchObject({ purpose: 'follow_up', question: 'Latest?', asked_at: latest.asked_at });
    // An earlier turn chosen the same way.
    store.closeAsk();
    store.pickSuggestion({ question: 'Older?', turn: older.id });
    await flush();
    await store.ask('and that one?');
    expect(calls('ask.run')[1]!.previous).toMatchObject({ purpose: 'follow_up', question: 'Older?', asked_at: older.asked_at });
  });

  it('checks a turn past the newest ten once it is opened, and a follow-up of it waits for that check', async () => {
    const turns = Array.from({ length: 12 }, (_, at) => turn(`Turn ${at}?`, (12 - at) * DAY, status()));
    seed(...turns);
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'page' ? 'changed' : item.citation.kind === 'follow_up' ? 'unreadable' : 'same' })) });
    const store = await startStore();
    await store.ask('What changed?');
    await flush();
    // The newest ten, when Ask opened: the oldest two were not checked.
    const [opening] = calls('ask.check');
    expect(new Set((opening!.items as { asked_at: string }[]).map(item => item.asked_at)).has(turns[0]!.asked_at)).toBe(false);
    const thread = await view();
    store.toggleEarlier();
    expect(byTestId(thread(store), 'timeline-row').map(row => byTestId(row, 'changed-tag').length)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // Opened: its own check, whose reply waits here.
    const release = held.hold('ask.check');
    store.toggleTurn(turns[0]!.id);
    await flush();
    const own = calls('ask.check').at(-1)!.items as { asked_at: string }[];
    expect(own.map(item => item.asked_at)).toEqual([turns[0]!.asked_at, turns[0]!.asked_at, turns[0]!.asked_at]);
    // A follow-up of it waits for that check, then carries only what you can still read.
    const asked = calls('ask.run').length;
    const following = store.ask('who owns it?');
    await flush();
    expect(calls('ask.run')).toHaveLength(asked);
    expect(store.getState().ask?.asking?.question).toBe('who owns it?');
    release(ok({ items: [{ state: 'same', marker: sha('m') }, { state: 'changed' }, { state: 'unreadable' }] }));
    await following;
    expect((calls('ask.run').at(-1)!.previous as AskPrevious).statements.map(statement => statement.text))
      .toEqual(['THERM-482, Sensor drift, is open.', 'The DVT plan moved the retest to Oct 30.']);
    // Opened, its line is its heading: what changed is said in the answer, not as a tag.
    expect(byTestId(thread(store), 'timeline-row').map(row => byTestId(row, 'changed-tag').length)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(byTestId(byTestId(thread(store), 'opened-turn')[0], 'changed-since')).toHaveLength(1);
  });

  it('opens a suggestion past the newest ten checked first, in the one check Ask opening makes', async () => {
    const turns = Array.from({ length: 12 }, (_, at) => turn(`Turn ${at}?`, (12 - at) * DAY, status()));
    seed(...turns);
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'page' ? 'changed' : 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: 'Turn 0?', turn: turns[0]!.id });
    await flush();
    const [opening] = calls('ask.check');
    expect(calls('ask.check')).toHaveLength(1);
    expect((opening!.items as { asked_at: string }[]).slice(0, 3).map(item => item.asked_at)).toEqual(Array(3).fill(turns[0]!.asked_at));
    expect((opening!.items as unknown[]).length).toBe(33);
    const opened = byTestId((await view())(store), 'opened-turn')[0]!;
    expect(byTestId(opened, 'statement').map(node => node.props['data-mark'] ?? null)).toEqual([null, 'changed', null]);
    expect(text(byTestId(opened, 'changed-since'))).toContain('Changed since');
  });

  it('carries no sentence of a turn whose sources no check could read now, only its question', async () => {
    const old = turn('What is open on THERM?', 2 * DAY, status());
    seed(old, turn('Since then?', DAY, status()));
    checks = () => fail('unavailable', { retryable: true });
    const store = await startStore();
    store.pickSuggestion({ question: old.question, turn: old.id });
    await flush();
    await store.ask('who owns it?');
    // Its own check failed, and so did the one the follow-up made: nothing it said is known to be readable now.
    const ofOld = () => calls('ask.check').filter(call => (call.items as { asked_at: string }[]).some(item => item.asked_at === old.asked_at));
    expect(ofOld()).toHaveLength(2);
    expect(calls('ask.run')[0]!.previous).toEqual({ purpose: 'follow_up', question: old.question, asked_at: old.asked_at, statements: [], citations: [] });
    // Ask again of it, the same.
    store.askAgain(old.id);
    await flush();
    expect(calls('ask.run')[1]!.previous).toMatchObject({ purpose: 'ask_again', statements: [], citations: [] });
  });

  it('asks which one, keeps nothing, and asks the chosen full question with the same earlier turn', async () => {
    const choices = [{ label: 'THERM-482 · Sensor drift', question: 'Who owns THERM-482?' }, { label: 'THERM-490 · DVT retest', question: 'Who owns THERM-490?' }];
    rpc.mockImplementation(rpcFor(held, {
      'ask.run': params => (params.question === 'who owns that ticket?'
        ? ok({ text: '', scope: { kind: 'global' }, sources: [], parts: [], outcome: 'clarify', choices })
        : ok({ ...answerOf(String(params.question), [ticket('THERM-482', '20482')], [['Dev owns THERM-482, since Oct 21.', [0]]]), question: String(params.question) })),
    }, () => ({ active: [apollo], archived: [] })));
    seed(turn('What is open on DVT?', 10 * 60_000, status()));
    const store = await startStore();
    await store.ask('Anything else?');
    await store.ask('who owns that ticket?');
    await flush();
    expect(store.getState().ask?.clarify).toMatchObject({ question: 'who owns that ticket?', choices });
    expect(kept()).toHaveLength(2);
    const thread = await view();
    const clarify = byTestId(thread(store), 'clarify')[0]!;
    expect(text(clarify)).toContain('Which one?');
    expect(byTestId(clarify, 'choice').map(text)).toEqual(['THERM-482 · Sensor drift', 'THERM-490 · DVT retest']);
    const previous = calls('ask.run')[1]!.previous;
    click(byTestId(clarify, 'choice')[0]);
    await flush();
    expect(calls('ask.run')[2]).toMatchObject({ question: 'Who owns THERM-482?', previous });
    expect(store.getState().ask?.clarify).toBeNull();
    expect(latestTurn(store)).toMatchObject({ text: 'Who owns THERM-482?', question: 'Who owns THERM-482?' });
  });

  // Every Authority takes the earlier turn (C3): a refused Ask fails as it is, and is never asked again without it.
  it.each(['invalid_request', 'not_supported'])('shows an Ask refused with its earlier turn (%s) as failed, and the next follow-up carries a turn again', async code => {
    rpc.mockImplementation(rpcFor(held, {
      'ask.run': params => (params.question === 'Bad?' ? fail(code) : ok(answerOf(String(params.question), [ticket('THERM-482', '20482')], [['Open.', [0]]]))),
    }, () => ({ active: [apollo], archived: [] })));
    seed(turn('What is open?', 10 * 60_000, status()));
    const store = await startStore();
    await store.ask('First?');
    await store.ask('Bad?');
    await flush();
    expect(calls('ask.run').slice(1).map(call => 'previous' in call)).toEqual([true]);
    expect(store.getState().ask?.failed).toMatchObject({ question: 'Bad?', failure: { code } });
    await store.ask('who owns it?');
    await flush();
    expect(calls('ask.run').slice(2).map(call => 'previous' in call)).toEqual([true]);
    expect(latestTurn(store)?.text).toBe('who owns it?');
  });

  it('asks a turn again with it, keeps the new answer at the end with what changed since, and the old one folds away (ADR-0049)', async () => {
    const one = turn('What is open on THERM?', 3 * DAY, status());
    checks = items => ok({ items: items.map(item => (item.citation.kind === 'page' ? { state: 'changed' } : { state: 'same' })) });
    rpc.mockImplementation(rpcFor(held, {
      'ask.run': params => {
        const answer = answerOf(String(params.question), [ticket('THERM-482', '20482')], [['THERM-482 is in progress.', [0]]]);
        const previous = params.previous as AskPrevious | undefined;
        return ok(previous?.purpose === 'ask_again' ? { ...answer, question: previous.question,
          since: params.question === 'Since then?' ? [] : [said('THERM-482 moved to In Progress.', [0], answer.sources)] } : answer);
      },
      'ask.check': params => (checks ? checks(params.items as never) : fail('not_supported')),
    }, () => ({ active: [apollo], archived: [] })));
    seed(one, turn('Since then?', 2 * DAY, status()));
    const store = await startStore();
    store.pickSuggestion({ question: one.question, turn: one.id });
    await flush();
    const thread = await view();
    expect(byTestId(byTestId(thread(store), 'opened-turn')[0], 'changed-since')).toHaveLength(1);
    store.askAgain(one.id);
    await flush();
    expect(calls('ask.run')[0]).toMatchObject({ question: 'What is open on THERM?', scope: { kind: 'global' },
      previous: { purpose: 'ask_again', question: 'What is open on THERM?', asked_at: one.asked_at } });
    expect(latestTurn(store)).toMatchObject({ again_of: one.id, since: [{ text: 'THERM-482 moved to In Progress.' }] });
    expect(store.getState().ask?.opened).toBeNull();
    const shown = thread(store);
    expect(byTestId(shown, 'changed-tag')).toEqual([]);
    // The question shows once: the old turn folds away, and the new answer stands for it.
    expect(byTestId(shown, 'timeline-question').map(text)).not.toContain(one.question);
    expect(byTestId(shown, 'question').map(text).filter(question => question === one.question)).toHaveLength(1);
    const since = byTestId(shown, 'since')[0]!;
    expect(text(byTestId(since, 'changed-since'))).toBe(`Changed since ${askedWhen(one.asked_at, NOW.getTime())}`);
    expect(byTestId(since, 'since-text').map(text)).toEqual(['THERM-482 moved to In Progress.']);
    // Nothing material changed: nothing is said, and the old turn folds away too.
    const quiet = store.getState().timeline.turns[1]!;
    store.askAgain(quiet.id);
    await flush();
    expect(byTestId(thread(store), 'since')).toHaveLength(1);
    expect(text(thread(store))).not.toContain('Nothing changed');
    expect(byTestId(thread(store), 'timeline-question').map(text)).not.toContain(quiet.question);
  });
});

describe('the sidebar\'s dots, and a project\'s New rows (C2)', () => {
  const at = (ago: number) => new Date(NOW.getTime() - ago).toISOString();
  const note = (title: string, added: string): ListItem => ({ ref: { kind: 'note', id: `ctx_${title.length.toString(16).padStart(64, '0')}` }, title, added_at: added,
    visibility: 'project', projects: ['Apollo'] });
  const key = () => [...storage.keys()].find(name => name.startsWith('echo.projectSeen.'))!;

  it('sees a project the first time with no dot, dots it when someone else adds to it, and opening it clears the dot and marks what is new', async () => {
    let latest: string | null = at(DAY);
    activity = () => ok({ items: [{ project_id: apollo.project_id, latest_at: latest }] });
    const store = await startStore();
    await flush();
    expect(store.getState().news.size).toBe(0);
    // Remembered per account, by a hash of who it is, never the account itself.
    expect(key()).toMatch(/^echo\.projectSeen\.[0-9a-f]{16}$/u);
    expect(key()).not.toContain(ACCOUNT.membership_id);
    const first = JSON.parse(storage.get(key())!)[apollo.project_id] as string;
    expect(Date.parse(first)).toBe(NOW.getTime());
    // Mina adds a note an hour later; the next check reads it.
    vi.setSystemTime(NOW.getTime() + HOUR);
    latest = new Date(NOW.getTime() + HOUR - 60_000).toISOString();
    feed = [note('Launch checklist v2', latest), note('Pricing memo', at(2 * DAY))];
    (await import('../../src/renderer/freshness.js')).woke();
    await flush();
    expect([...store.getState().news]).toEqual([apollo.project_id]);
    const { Sidebar } = await import('../../src/renderer/screens/sidebar.js');
    expect(byTestId(render(Sidebar({ state: store.getState() })), 'project-news')).toHaveLength(1);
    await store.openProject(apollo);
    await flush();
    expect(store.getState().news.size).toBe(0);
    expect(store.getState().visit).toEqual({ project_id: apollo.project_id, since: first });
    const { Project } = await import('../../src/renderer/screens/project.js');
    const rows = byTestId(render(Project({ state: store.getState(), project: apollo })), 'feed-row');
    expect(rows.map(row => byTestId(row, 'item-new').length)).toEqual([1, 0]);
    // Opened again later, nothing new since this visit.
    store.goHome();
    await store.openProject(apollo);
    await flush();
    expect(byTestId(render(Project({ state: store.getState(), project: apollo })), 'item-new')).toEqual([]);
  });

  it('reads what arrived on the first check, a return or a wake, and otherwise at most every two minutes', async () => {
    activity = () => ok({ items: [{ project_id: apollo.project_id, latest_at: at(DAY) }] });
    await startStore();
    await flush();
    expect(calls('projects.activity')).toHaveLength(1);
    const freshness = await import('../../src/renderer/freshness.js');
    // A page opened a minute later checks for changes; the activity read waits.
    vi.setSystemTime(NOW.getTime() + 60_000);
    freshness.navigated();
    await flush();
    expect(calls('projects.activity')).toHaveLength(1);
    // A wake is a check you would expect it from.
    vi.setSystemTime(NOW.getTime() + 70_000);
    freshness.woke();
    await flush();
    expect(calls('projects.activity')).toHaveLength(2);
    // Two minutes on, a page's check reads it again.
    vi.setSystemTime(NOW.getTime() + 70_000 + 120_000);
    freshness.navigated();
    await flush();
    expect(calls('projects.activity')).toHaveLength(3);
  });

  it('forgets when an account last opened its projects at our own sign-out, and every other account\'s when one signs in', async () => {
    const other = { ...ACCOUNT, membership_id: 'another-member' };
    let app: AppStatus = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    activity = () => ok({ items: [{ project_id: apollo.project_id, latest_at: at(DAY) }] });
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok(app),
      'account.signOut': () => { app = { signed_in: false, account: null, client_version: 'test' }; return ok(app); },
      'projects.activity': () => activity!(),
    }, () => ({ active: [apollo], archived: [] })));
    // An account that signed in here before left its times behind.
    storage.set('echo.projectSeen.0123456789abcdef', '{}');
    storage.set(SIDEBAR, 'false');
    const store = await startStore();
    await flush();
    const seenKeys = () => [...storage.keys()].filter(name => name.startsWith('echo.projectSeen.'));
    const of = (account: { authority: string; membership_id: string }) => `echo.projectSeen.${store.accountHash(account)}`;
    // As the host keeps only the signed-in account's timeline, only its times are kept; nothing else in storage is touched.
    expect(seenKeys()).toEqual([of(ACCOUNT)]);
    expect(storage.get(SIDEBAR)).toBe('false');
    // Another account signs in: the last one's times go.
    app = { signed_in: true, account: other, client_version: 'test' };
    await store.refreshStatus();
    await flush();
    expect(seenKeys()).toEqual([of(other)]);
    // Our own sign-out: its times go with its timeline.
    store.accountCommand('signout');
    await store.signOut();
    expect(store.getState().status?.signed_in).toBe(false);
    expect(seenKeys()).toEqual([]);
    // A session that merely ended keeps them, as it keeps the timeline.
    app = { signed_in: true, account: ACCOUNT, client_version: 'test' };
    await store.refreshStatus();
    await flush();
    expect(seenKeys()).toEqual([of(ACCOUNT)]);
    app = { signed_in: false, account: null, client_version: 'test' };
    await store.refreshStatus();
    expect(seenKeys()).toEqual([of(ACCOUNT)]);
  });

  it('reads what arrived only when the change check reached the Authority: one that cannot reach it sends nothing more', async () => {
    let reachable = false;
    activity = () => ok({ items: [{ project_id: apollo.project_id, latest_at: at(DAY) }] });
    rpc.mockImplementation(rpcFor(held, {
      'changes.read': () => (reachable ? ok({ kind: 'echo-person-changes-v1', check_again_after_seconds: 60,
        areas: { projects: `sha256:${'1'.repeat(64)}`, follow_ups: `sha256:${'2'.repeat(64)}`, reviews: `sha256:${'3'.repeat(64)}` } }) : fail('unavailable', { retryable: true })),
      'projects.activity': () => activity!(),
      'ask.check': () => fail('unavailable', { retryable: true }),
      'list.page': () => ok({ items: feed, next_cursor: null, meetings_held: false }),
    }, () => ({ active: [apollo], archived: [] })));
    await startStore();
    await flush();
    expect(calls('projects.activity')).toHaveLength(0);
    const freshness = await import('../../src/renderer/freshness.js');
    reachable = true;
    vi.setSystemTime(NOW.getTime() + 60_000);
    freshness.woke();
    await flush();
    expect(calls('projects.activity')).toHaveLength(1);
  });

  it('keeps the dots when an activity read fails, and reads again at the next check you would expect it from', async () => {
    let answer: () => unknown = () => ok({ items: [{ project_id: apollo.project_id, latest_at: at(DAY) }] });
    activity = () => answer();
    const store = await startStore();
    await flush();
    const freshness = await import('../../src/renderer/freshness.js');
    // Mina adds a note an hour later; a wake's check reads it.
    vi.setSystemTime(NOW.getTime() + HOUR);
    answer = () => ok({ items: [{ project_id: apollo.project_id, latest_at: at(-HOUR + 60_000) }] });
    freshness.woke();
    await flush();
    expect([...store.getState().news]).toEqual([apollo.project_id]);
    // The next read fails, a 404 as any other (ADR-0048): the dot stays, and the next wake reads again.
    answer = () => fail('not_found');
    freshness.woke();
    await flush();
    expect([...store.getState().news]).toEqual([apollo.project_id]);
    freshness.woke();
    await flush();
    expect(calls('projects.activity')).toHaveLength(4);
  });
});

describe('one thread per place (ADR-0049)', () => {
  const inApollo = { kind: 'project' as const, project_id: apollo.project_id };
  /** The opening checks: each asks about more than a new answer's own ticket. */
  const opening = () => calls('ask.check').filter(call => (call.items as unknown[]).length > 1).map(call => (call.items as { asked_at: string }[]).map(item => item.asked_at));

  it('checks each place\'s newest turns when Ask opens there, each place on its own five minutes', async () => {
    // Apollo's one turn is older than Home's newest ten, so Home's opening check leaves it out.
    const apolloTurn = turn('What is left in Apollo?', 20 * DAY, status(), { scope: inApollo });
    const homeTurns = Array.from({ length: 10 }, (_, at) => turn(`Home ${at}?`, (10 - at) * DAY, status()));
    seed(apolloTurn, ...homeTurns);
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    const store = await startStore();
    await store.ask('Anything new?');
    await flush();
    expect(opening()).toHaveLength(1);
    expect(opening()[0]).not.toContain(apolloTurn.asked_at);
    // A minute on, Ask opens in Apollo: Apollo's thread has not been checked, so it is now.
    store.closeAsk();
    vi.setSystemTime(NOW.getTime() + 60_000);
    await store.openProject(apollo);
    await store.ask('And now?');
    await flush();
    expect(opening()).toHaveLength(2);
    expect(opening()[1]).toContain(apolloTurn.asked_at);
    expect(store.checksOf(apolloTurn)).toBeDefined();
    // Within its five minutes, Ask opening in Apollo again checks nothing more.
    store.closeAsk();
    await store.ask('Once more?');
    await flush();
    expect(opening()).toHaveLength(2);
  });

  it('checks Home\'s thread when × widens an Ask open in a project', async () => {
    const homeTurn = turn('What did we agree?', 2 * DAY, status());
    const apolloTurn = turn('What is left in Apollo?', DAY, status(), { scope: inApollo });
    seed(homeTurn, apolloTurn);
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    const store = await startStore();
    await store.openProject(apollo);
    await store.ask('Anything new in Apollo?');
    await flush();
    expect(opening().flat()).not.toContain(homeTurn.asked_at);
    store.widenScope();
    await flush();
    expect(opening().at(-1)).toContain(homeTurn.asked_at);
    expect(store.checksOf(homeTurn)).toBeDefined();
  });

  it('shows no sources for a turn with every sentence left out, though some of its sources are still readable', async () => {
    // Each sentence cites the ticket, which you can no longer read; the page and the follow-up you still can.
    const both = answerOf('What is open on THERM?', [ticket('THERM-482', '20482'), page('31010'), followUp('itm_timeline-1')],
      [['THERM-482 waits on the DVT plan.', [0, 1]], ['THERM-482 has a follow-up.', [0, 2]]]);
    const one = turn('What is open on THERM?', 2 * DAY, both);
    seed(one, turn('Two?', DAY, status()));
    checks = items => ok({ items: items.map(item => ({ state: item.citation.kind === 'ticket' ? 'unreadable' : 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: one.question, turn: one.id });
    await flush();
    const opened = byTestId((await view())(store), 'opened-turn')[0]!;
    expect(byTestId(opened, 'answer')).toEqual([]);
    expect(byTestId(opened, 'sources-toggle')).toEqual([]);
    expect(byTestId(opened, 'copy-answer')).toEqual([]);
    expect(byTestId(opened, 'ask-again')).toHaveLength(1);
  });

  it('never suggests a turn folded away, even one an Ask again asked in other words', () => {
    const first = turn('When do we ship?', 2 * DAY, status());
    const again = turn('When do we ship Apollo?', DAY, status(), { again_of: first.id });
    expect(askedSuggestions([first, again], { kind: 'global' })).toEqual([{ question: again.question, turn: again.id }]);
  });

  it('keeps a turn asked in Mine before it went on Home\'s thread: asked again at Home, and folded by the same question there', async () => {
    const mine = turn('What did I note?', 2 * DAY, status(), { scope: { kind: 'mine' } });
    seed(mine);
    checks = items => ok({ items: items.map(() => ({ state: 'same' })) });
    const store = await startStore();
    store.pickSuggestion({ question: mine.question, turn: mine.id });
    await flush();
    store.askAgain(mine.id);
    await flush();
    expect(calls('ask.run')[0]).toMatchObject({ question: 'What did I note?', scope: { kind: 'global' } });
    const asked = turn('what did I note?', HOUR, status());
    expect(visibleTurns([mine, asked])).toEqual([asked]);
  });
});

describe('the earlier questions folded into one line, and the sidebar\'s Ask', () => {
  /** `count` turns a day apart, the oldest first, the newest a day ago. */
  const days = (count: number) => Array.from({ length: count }, (_, at) => turn(`Turn ${at}?`, (count - at) * DAY, status()));
  const line = (shown: unknown) => byTestId(shown, 'earlier-toggle')[0];
  const lines = (shown: unknown) => byTestId(shown, 'timeline-question').map(text);
  beforeEach(() => { checks = items => ok({ items: items.map(() => ({ state: 'same' })) }); });

  it('shows the newest three earlier questions as lines, the rest folded into one line that opens them in place, folded again the next time Ask opens', async () => {
    seed(...days(12));
    const store = await startStore();
    await store.ask('What now?');
    await flush();
    const thread = await view();
    // Turn 11 was the latest when Ask opened, so it stays in full with the answer: the other eleven fold, the newest three as lines.
    expect(lines(thread(store))).toEqual(['Turn 8?', 'Turn 9?', 'Turn 10?']);
    expect(text(line(thread(store)))).toBe('8 earlier questions');
    expect(line(thread(store))?.props['aria-expanded']).toBe(false);
    expect(byTestId(thread(store), 'question').map(text)).toEqual(['Turn 11?', 'What now?']);
    click(line(thread(store)));
    expect(lines(thread(store))).toEqual(Array.from({ length: 11 }, (_, at) => `Turn ${at}?`));
    expect(line(thread(store))?.props['aria-expanded']).toBe(true);
    expect(text(line(thread(store)))).toBe('8 earlier questions');
    // Those it opens are kept out of Ask's live region, so a screen reader does not read them all out.
    const live = elements(thread(store)).filter(node => classes(node).includes('folded-turn')).map(node => node.props['aria-live'] ?? null);
    expect(live).toEqual([...Array.from({ length: 8 }, () => 'off'), null, null, null]);
    click(line(thread(store)));
    expect(lines(thread(store))).toEqual(['Turn 8?', 'Turn 9?', 'Turn 10?']);
    // Left open, it is folded again the next time Ask opens.
    click(line(thread(store)));
    store.closeAsk();
    await store.ask('And next?');
    await flush();
    expect(line(thread(store))?.props['aria-expanded']).toBe(false);
    expect(lines(thread(store))).toEqual(['Turn 9?', 'Turn 10?', 'Turn 11?']);
    expect(text(line(thread(store)))).toBe('9 earlier questions');
  });

  it('needs no line for three earlier questions or fewer, and names one in the singular', async () => {
    seed(...days(4));
    const store = await startStore();
    await store.ask('What now?');
    await flush();
    const thread = await view();
    expect(byTestId(thread(store), 'earlier-toggle')).toEqual([]);
    expect(lines(thread(store))).toEqual(['Turn 0?', 'Turn 1?', 'Turn 2?']);
    store.closeAsk();
    await store.ask('And next?');
    await flush();
    expect(text(line(thread(store)))).toBe('1 earlier question');
    expect(lines(thread(store))).toEqual(['Turn 1?', 'Turn 2?', 'Turn 3?']);
  });

  it('folds Today\'s line away with the first of today\'s questions, and shows it there once the line opens', async () => {
    // Six questions on earlier days, then six this morning, by this computer's own day.
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    const ago = (time: number) => NOW.getTime() - time;
    seed(...Array.from({ length: 12 }, (_, at) => turn(`Turn ${at}?`, ago(at < 6 ? midnight.getTime() - (6 - at) * DAY : midnight.getTime() + (at - 5) * HOUR), status())));
    vi.setSystemTime(midnight.getTime() + 12 * HOUR);
    const store = await startStore();
    await store.ask('What now?');
    await flush();
    const thread = await view();
    const shown = () => elements(thread(store)).filter(node => node.props['data-testid'] === 'today' || node.props['data-testid'] === 'timeline-row')
      .map(node => (node.props['data-testid'] === 'today' ? 'Today' : text(byTestId(node, 'timeline-question')[0])));
    expect(shown()).toEqual(['Turn 8?', 'Turn 9?', 'Turn 10?']);
    click(line(thread(store)));
    expect(shown()).toEqual(['Turn 0?', 'Turn 1?', 'Turn 2?', 'Turn 3?', 'Turn 4?', 'Turn 5?', 'Today', 'Turn 6?', 'Turn 7?', 'Turn 8?', 'Turn 9?', 'Turn 10?']);
  });

  it('opens the line when a suggestion opens a question folded into it, so that question shows where it is', async () => {
    const turns = days(12);
    seed(...turns);
    const store = await startStore();
    store.pickSuggestion({ question: 'Turn 2?', turn: turns[2]!.id });
    await flush();
    expect(store.getState().ask).toMatchObject({ opened: turns[2]!.id, focus: turns[2]!.id, earlier: true });
    const thread = await view();
    expect(lines(thread(store))).toHaveLength(11);
    expect(byTestId(thread(store), 'opened-turn')).toHaveLength(1);
    // One of the newest three opens with the line still folded.
    store.closeAsk();
    store.pickSuggestion({ question: 'Turn 9?', turn: turns[9]!.id });
    await flush();
    expect(store.getState().ask).toMatchObject({ opened: turns[9]!.id, earlier: false });
    expect(lines(thread(store))).toEqual(['Turn 8?', 'Turn 9?', 'Turn 10?']);
    expect(byTestId(thread(store), 'opened-turn')).toHaveLength(1);
  });

  it('folds a question opened among them when the line folds them again, so a follow-up never continues one out of sight', async () => {
    const turns = days(12);
    seed(...turns);
    const store = await startStore();
    await store.ask('What now?');
    await flush();
    store.toggleEarlier();
    store.toggleTurn(turns[2]!.id);
    expect(store.getState().ask?.opened).toBe(turns[2]!.id);
    store.toggleEarlier();
    expect(store.getState().ask).toMatchObject({ earlier: false, opened: null });
    // One of the newest three stays open through it.
    store.toggleEarlier();
    store.toggleTurn(turns[9]!.id);
    store.toggleEarlier();
    expect(store.getState().ask).toMatchObject({ earlier: false, opened: turns[9]!.id });
  });

  it('opens the line when × widens Ask to Home\'s thread and puts the turn opened behind it, so a follow-up never continues one out of sight', async () => {
    const inApollo = { kind: 'project' as const, project_id: apollo.project_id };
    const old = turn('What was Apollo\'s plan?', 20 * DAY, status(), { scope: inApollo });
    seed(old, ...Array.from({ length: 5 }, (_, at) => turn(`Home ${at}?`, (5 - at) * DAY, status())), turn('What is left in Apollo?', HOUR, status(), { scope: inApollo }));
    const store = await startStore();
    await store.openProject(apollo);
    store.pickSuggestion({ question: old.question, turn: old.id });
    await flush();
    // On Apollo's thread it is the one earlier line: nothing is behind the line.
    expect(store.getState().ask).toMatchObject({ opened: old.id, earlier: false });
    store.widenScope();
    await flush();
    expect(store.getState().ask).toMatchObject({ opened: old.id, earlier: true });
    expect(byTestId((await view())(store), 'opened-turn')).toHaveLength(1);
  });

  it('goes back to Ask where you left it, from any page: Home\'s thread for a question asked at Home, its answer at the bottom', async () => {
    seed(turn('What did we agree?', DAY, status()));
    const store = await startStore();
    await store.ask('Who approved it?');
    await flush();
    await store.openProject(apollo);
    expect(store.getState().ask).toBeNull();
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.getState().barScope).toEqual({ kind: 'global' });
    expect(store.getState().ask).toMatchObject({ latest: latestTurn(store)!.id, asked: [], opened: null, focus: null, earlier: false });
    const thread = await view();
    expect(byTestId(thread(store), 'question').map(text)).toEqual(['Who approved it?']);
    expect(lines(thread(store))).toEqual(['What did we agree?']);
    // Open already, it stays as it is.
    const open = store.getState().ask;
    expect(store.returnToAsk()).toBe(true);
    expect(store.getState().ask).toBe(open);
  });

  it('goes back to a project\'s Ask for a question asked there', async () => {
    const inApollo = { kind: 'project' as const, project_id: apollo.project_id };
    seed(turn('What is left in Apollo?', DAY, status(), { scope: inApollo }));
    const store = await startStore();
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: apollo.project_id } });
    expect(store.getState().barScope).toEqual(inApollo);
    expect(byTestId((await view())(store), 'question').map(text)).toEqual(['What is left in Apollo?']);
  });

  it('goes back to Home\'s thread for a question asked in a project that is no longer one of yours', async () => {
    seed(turn('What was left?', DAY, status(), { scope: { kind: 'project', project_id: 'prj_99999999-1111-4111-8111-111111111111' } }));
    const store = await startStore();
    await store.openProject(apollo);
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(byTestId((await view())(store), 'question').map(text)).toEqual(['What was left?']);
  });

  it('opens Ask over the page it is on when that page\'s bar asks the thread already', async () => {
    seed(turn('What did we agree?', DAY, status()));
    const store = await startStore();
    const route = store.getState().route;
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.getState().route).toBe(route);
    expect(store.getState().ask).toMatchObject({ latest: latestTurn(store)!.id, asked: [] });
  });

  it('narrows a widened bar back on the project\'s own page, without reading the page again', async () => {
    const inApollo = { kind: 'project' as const, project_id: apollo.project_id };
    seed(turn('What did we agree?', 2 * DAY, status()), turn('What is left in Apollo?', DAY, status(), { scope: inApollo }));
    const store = await startStore();
    await store.openProject(apollo);
    store.widenScope();
    const route = store.getState().route;
    const reads = calls('list.page').length;
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.getState().route).toBe(route);
    expect(calls('list.page')).toHaveLength(reads);
    expect(store.getState().barScope).toEqual(inApollo);
    expect(byTestId((await view())(store), 'question').map(text)).toEqual(['What is left in Apollo?']);
  });

  it('keeps Ask open when a question asked in it is cancelled, though the sidebar\'s Ask opened it', async () => {
    seed(turn('What did we agree?', DAY, status()));
    const store = await startStore();
    expect(store.returnToAsk()).toBe(true);
    await flush();
    held.hold('ask.run');
    void store.ask('And then?');
    await flush();
    expect(store.getState().ask?.asking).not.toBeNull();
    store.cancelAsk();
    expect(store.getState().ask).toMatchObject({ asking: null, asked: [] });
    expect(byTestId((await view())(store), 'question').map(text)).toEqual(['What did we agree?']);
    // Ask opened from a page for a question still closes with it.
    store.closeAsk();
    held.hold('ask.run');
    void store.ask('Something else?');
    await flush();
    store.cancelAsk();
    expect(store.getState().ask).toBeNull();
  });

  it('opens nothing with nothing asked yet, for the bar to take the cursor', async () => {
    const store = await startStore();
    expect(store.returnToAsk()).toBe(false);
    expect(store.getState().ask).toBeNull();
  });

  it('reads a project the sidebar has not loaded by its id, and goes back to that project\'s Ask', async () => {
    // Twelve projects: the sidebar shows the first page of ten, and the latest question was asked in the twelfth.
    const many = numbered(12);
    const later = many[11]!;
    rpc.mockImplementation(rpcFor(held, { 'projects.read': params => ok(many.find(item => item.project_id === params.project_id)) }, () => ({ active: many, archived: [] })));
    seed(turn('What is left?', DAY, status(), { scope: { kind: 'project', project_id: later.project_id } }));
    const store = await startStore();
    expect(store.getState().projects.items.map(item => item.project_id)).not.toContain(later.project_id);
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(calls('projects.read')).toEqual([expect.objectContaining({ project_id: later.project_id })]);
    expect(store.getState().route).toMatchObject({ page: 'project', project: { project_id: later.project_id } });
    expect(store.getState().barScope).toEqual({ kind: 'project', project_id: later.project_id });
    expect(byTestId((await view())(store), 'question').map(text)).toEqual(['What is left?']);
  });

  it('goes to Home\'s thread for an unloaded project you no longer have, and says why when it cannot be read', async () => {
    const many = numbered(12);
    let reply = fail('not_found');
    rpc.mockImplementation(rpcFor(held, { 'projects.read': () => reply }, () => ({ active: many, archived: [] })));
    seed(turn('What was left?', DAY, status(), { scope: { kind: 'project', project_id: 'prj_99999999-1111-4111-8111-111111111111' } }));
    const store = await startStore();
    await store.openProject(many[0]!);
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(byTestId((await view())(store), 'question').map(text)).toEqual(['What was left?']);
    // Any other failure opens nothing, and says why.
    store.closeAsk();
    await store.openProject(many[0]!);
    reply = fail('unavailable', { retryable: true });
    expect(store.returnToAsk()).toBe(true);
    await flush();
    expect(store.getState().ask).toBeNull();
    expect(store.getState().toast).toBe('ECHO is unavailable right now. Try again.');
  });
});
