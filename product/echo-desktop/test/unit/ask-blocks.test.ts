// An answer the writer arranged in blocks (answer layout v2, ADR-0051), on the
// page: the answer in the lead's type, a title as its block's section heading,
// points as bullets or numbered steps, a table in its own box with only your
// late row in the signal colour, a timeline with each event's day down the
// side, a card headed by its kind, and a quote with its source under it. Each
// item is a sentence with its sources' numbers, lit on its own; a check leaves
// out what you can no longer read and lights what changed (ADR-0047), and a
// block left with nothing to show goes with its title. For every answer: the
// sources start as one closed line, partial-answer explanations remain
// visible, and Copy answer writes Markdown.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, ArrangedBlock, TimelineTurn } from '../../src/shared/protocol.js';
import { blocksAnswer } from '../fixtures/authority.js';
import { answerView } from '../../src/host/views.js';
import { Folder, KindMark, OnePerson, Ticket } from '../../src/renderer/screens/icons.js';
import {
  ACCOUNT, asking as askingWith, byClass, byTestId, byType, classes, click, elements, fail, fileOf, flush, Held, ok, paneTurn, plainHooks, render, rpcFor,
  startStore, storeLifecycle, text, timelineFiles, type Handler, type Node,
} from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
// Components are called as plain functions below.
vi.mock('preact/hooks', original => plainHooks(original));

const GLOBAL = { kind: 'global' } as const;
const QUESTION = 'Can THERM start PVT?';
/** The fixture's THERM answer, as the host hands it to the page: in its blocks, or as an Ask that did not ask for them gets it. */
const therm = (blocks = true): Answer => answerView({ ok: true, result: blocksAnswer(QUESTION, GLOBAL, blocks) }, GLOBAL);
/** An answer in blocks citing `count` Confluence pages, past ADR-0041's 40 (ADR-0051): the answer, then a point for each other page. */
function pagesAnswer(count: number): Answer {
  const citations = Array.from({ length: count }, (_, at) => ({ kind: 'page', label: `Page ${at + 1}`, visibility: 'team', citation: {
    kind: 'page', tool_id: 'confluence', external_scope_id: '22222222-3333-4444-8555-666666666666', page_id: String(41_000 + at), section_id: 'summary', version: '1',
    permalink: `https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${41_000 + at}`, text_sha256: `sha256:${'0'.repeat(64)}` } }));
  const statements = citations.map((_, at) => ({ text: `Page ${at + 1} applies.`, citation_indexes: [at], private: false }));
  return answerView({ ok: true, result: { schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: GLOBAL, outcome: 'answered', citations, parts: [{
    question: QUESTION, status: 'answered', statements,
    blocks: [{ kind: 'answer', statements: [0] }, { kind: 'points', ordered: false, statements: statements.slice(1).map((_, at) => at + 1) }],
  }] } }, GLOBAL);
}
/** The fixture's answer with its blocks changed by `change`. */
const changed = (change: (blocks: ArrangedBlock[]) => ArrangedBlock[], answer = therm()): Answer =>
  ({ ...answer, parts: [{ ...answer.parts[0]!, blocks: change([...answer.parts[0]!.blocks!]) }] });
const NOW = new Date(2026, 10, 2, 12);

let held: Held;
let checked: Handler | null;
// The fixture's days are this year's, and THERM-55's due date, Oct 30, has passed.
storeLifecycle(NOW);
beforeEach(() => {
  held = new Held();
  checked = null;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'clipboard.writeText': () => ok(null),
    'ask.check': params => (checked ? checked(params) : { ok: false, failure: { code: 'not_supported', retryable: false } }),
  }, () => ({ active: [], archived: [] })));
});

/** An Ask answered with `answer`: the store, and the thread as it shows now. */
async function answered(answer: Answer) {
  const { store, release, thread } = await askingWith(rpc, held, QUESTION);
  release(ok(answer));
  await flush();
  return { store, thread };
}

/** The answer an Ask answered with `answer` shows: the thread's latest. */
const shownAnswer = async (answer: Answer) => byTestId((await answered(answer)).thread(), 'answer').at(-1)!;

/** A turn kept on the timeline `days` before NOW, `question` answered with `answer`. */
function kept(id: string, answer: Answer, days = 1, question = QUESTION): TimelineTurn {
  return { id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`, asked_at: new Date(NOW.getTime() - days * 24 * 60 * 60_000).toISOString(), text: question,
    question, scope: GLOBAL, answer };
}

/** A check that finds each source in `states` (by its page or ticket id) as it says, and every other the same. */
const finding = (states: Readonly<Record<string, string>>): Handler => params => ok({ items: (params.items as { citation: Record<string, unknown> }[]).map(({ citation }) =>
  ({ state: states[String(citation.page_id ?? citation.ticket_id)] ?? 'same' })) });

/** Ask opened on `turns`' latest, each check request answered by `check`: the store, and the thread as it shows now. */
async function reopenedWith(check: Handler, ...turns: TimelineTurn[]) {
  timelineFiles.set(fileOf(ACCOUNT), turns);
  checked = check;
  const store = await startStore();
  store.pickSuggestion({ question: QUESTION, turn: turns.at(-1)!.id });
  await flush();
  const screens = await import('../../src/renderer/screens/ask.js');
  return { store, thread: () => render(screens.AskView({ state: store.getState() })) };
}

/** Ask opened on `turns`' latest, after a check that found each source in `states` as it says and every other the same. */
const reopened = (states: Readonly<Record<string, string>>, ...turns: TimelineTurn[]) => reopenedWith(finding(states), ...turns);

/** What a part's blocks show, in order: each block's title, then the block, as its element and first class. */
const drawn = (layout: Node | undefined) => ([layout!.props.children].flat(6) as unknown[])
  .filter((node): node is Node => typeof node === 'object' && node !== null && 'props' in node).map(node => `${String(node.type)}.${classes(node)[0]}`);
/** An item's words, without its numbers. */
const words = (node: Node) => text(byTestId(node, 'statement-text'));
/** An icon's drawing, to tell one from another. */
const shape = (tree: unknown) => elements(tree).map(node => `${String(node.type)}:${String(node.props.d ?? node.props.r ?? '')}`).join(' ');
/** The drawing of a card's kind's icon. */
const iconOf = (card: Node | undefined) => shape(byClass(card, 'answer-card-icon')[0]!.props.children);

describe('an arranged part reads as its blocks', () => {
  it('draws each block in the writer\'s order under its title: the answer, a table, a timeline, a card, numbered steps, text and a quote', async () => {
    const { thread } = await answered(therm());
    const answer = byTestId(thread(), 'answer')[0]!;
    const [layout] = byClass(answer, 'answer-layout');
    expect(drawn(layout)).toEqual(['p.answer-lead', 'div.answer-table', 'h3.answer-heading', 'ol.answer-timeline', 'div.answer-card', 'h3.answer-heading',
      'ol.answer-bullets', 'h3.answer-heading', 'p.answer-paragraph', 'figure.answer-quote']);
    expect(byType(layout, 'h3').map(text)).toEqual(['Soak test', 'Before PVT', 'Open risk']);
    // The answer reads as the lead, in the answer's own size.
    expect(byClass(layout, 'answer-lead').map(node => words(node))).toEqual(['Yes, PVT can start: the 72-hour soak passed on Oct 23.']);
    expect(byTestId(byClass(layout, 'answer-lead')[0], 'statement').map(classes)).toEqual([['claim']]);
    expect(byClass(layout, 'answer-paragraph').map(node => words(node))).toEqual(['Sensor self-heating is still unexplained, so the soak report keeps it on the PVT watch list.']);
    // Every sentence is one item: the answer, two events, two facts, two steps, the text and the quote; the list statement is its table's rows.
    expect(byTestId(layout, 'statement')).toHaveLength(9);
    expect(byTestId(layout, 'answer-row')).toHaveLength(2);
  });

  it('gives every item its sentence\'s numbers and lights only the one whose number opened the pane, a row by its own id', async () => {
    const { store, thread } = await answered(therm());
    const items = () => byTestId(thread(), 'statement');
    // Its sources' numbers, as the page numbers them: the soak plan, its report, the review, then THERM-48, -52 and -55.
    expect(items().map(node => text(byTestId(node, 'citation')))).toEqual(['2', '1', '2', '4', '4', '3', '3', '2', '3']);
    expect(byTestId(thread(), 'answer-row').map(row => text(byTestId(row, 'citation')))).toEqual(['5', '6']);
    // A fact's number lights that fact, and the pane knows it by its sentence's place.
    const facts = () => byClass(thread(), 'answer-fact');
    click(byTestId(facts()[1], 'citation')[0]);
    expect(store.getState().sources).toMatchObject({ open: 3, focus: '0.5' });
    expect(facts().map(node => classes(node).includes('on'))).toEqual([false, true]);
    expect(items().filter(node => classes(node).includes('on'))).toHaveLength(1);
    // An event's, a step's and the quote's light theirs.
    for (const [at, id] of [[1, '0.2'], [5, '0.6'], [8, '0.9']] as const) {
      click(byTestId(items()[at], 'citation')[0]);
      expect(store.getState().sources?.focus).toBe(id);
      expect(items().map(node => classes(node).includes('on'))).toEqual(items().map((_, place) => place === at));
    }
    // A row's lights the row alone, by its table's place among the blocks.
    click(byTestId(byTestId(thread(), 'answer-row')[1], 'citation')[0]);
    expect(store.getState().sources).toMatchObject({ open: 5, focus: '0.t1.1' });
    expect(byTestId(thread(), 'answer-row').map(row => classes(row).includes('on'))).toEqual([false, true]);
    expect(items().filter(node => classes(node).includes('on'))).toEqual([]);
  });

  it('numbers points as steps when their order matters, and bullets them when it does not', async () => {
    const { thread } = await answered(therm());
    const [steps] = byClass(thread(), 'answer-steps');
    expect(steps!.type).toBe('ol');
    expect(classes(steps)).toEqual(['answer-bullets', 'answer-steps', 'selectable']);
    expect(byType(steps, 'li').map(node => words(node))).toEqual(['Freeze the firmware at 1.4.2.', 'Ship the build to the line.']);
    const unordered = changed(blocks => blocks.map(block => block.kind === 'points' ? { ...block, ordered: false } : block));
    const shown = await shownAnswer(unordered);
    expect(byClass(shown, 'answer-steps')).toEqual([]);
    expect(byClass(shown, 'answer-bullets').map(node => [node.type, byType(node, 'li').length])).toEqual([['ul', 2]]);
  });

  it('shows each event\'s day as a person reads it, in a <time> of its date, then what happened and who', async () => {
    const { thread } = await answered(therm());
    const [timeline] = byClass(thread(), 'answer-timeline');
    const events = byType(timeline, 'li');
    expect(events.map(node => text(byType(node, 'time')))).toEqual(['Oct 20', 'Oct 23']);
    expect(events.map(node => byType(node, 'time')[0]!.props.dateTime)).toEqual(['2026-10-20', '2026-10-23']);
    expect(events.map(node => words(node))).toEqual(['Approved the soak plan.', 'The 72-hour soak passed.']);
    expect(events.map(node => text(byClass(node, 'event-who')))).toEqual(['Noor Haddad', 'Noor Haddad']);
    // A day of another year says its year, and an event the evidence names nobody for has no one under it.
    const earlier = changed(blocks => blocks.map(block => block.kind !== 'timeline' ? block
      : { ...block, events: [{ date: '2025-12-30', text: 'Wrote the soak plan.' }, block.events[1]!] }));
    const [other] = byClass(await shownAnswer(earlier), 'answer-timeline');
    expect(byType(other, 'time').map(text)).toEqual(['Dec 30, 2025', 'Oct 23']);
    expect(byType(other, 'li').map(node => byClass(node, 'event-who').length)).toEqual([0, 1]);
  });

  it('heads a card with its kind\'s icon, its kind and its title, and shows its facts as label and value rows', async () => {
    const { thread } = await answered(therm());
    const [card] = byClass(thread(), 'answer-card');
    expect(card!.props).toMatchObject({ role: 'group', 'aria-label': 'Ticket THERM-48' });
    expect(text(byClass(card, 'answer-card-kind'))).toBe('Ticket');
    expect(text(byClass(card, 'answer-card-title'))).toBe('THERM-48');
    expect(iconOf(card)).toBe(shape(render(Ticket())));
    const facts = byClass(card, 'answer-fact');
    expect(facts.map(node => text(byType(node, 'dt')))).toEqual(['Status', 'Owner']);
    expect(facts.map(node => words(node))).toEqual(['In review', 'Tomas Okafor']);
    // The card's title names it: it is no section heading.
    expect(byType(thread(), 'h3').map(text)).not.toContain('THERM-48');
    // Each kind its own icon and word: a person, a project's folder, and a decision's diamond, as Home marks one.
    for (const [entity, word, icon] of [['person', 'Person', OnePerson()], ['project', 'Project', Folder()], ['decision', 'Decision', KindMark({ kind: 'approve' })]] as const) {
      const other = changed(blocks => blocks.map(block => block.kind === 'card' ? { ...block, entity } : block));
      const [drawnCard] = byClass(await shownAnswer(other), 'answer-card');
      expect(text(byClass(drawnCard, 'answer-card-kind'))).toBe(word);
      expect(iconOf(drawnCard)).toBe(shape(render(icon)));
    }
  });

  it('sets a quote apart with its source under it, and none when it names none', async () => {
    const { thread } = await answered(therm());
    const [quote] = byClass(thread(), 'answer-quote');
    expect(quote!.type).toBe('figure');
    expect(words(byType(quote, 'blockquote')[0]!)).toBe('Start PVT once the soak passes.');
    expect(byType(quote, 'figcaption').map(text)).toEqual(['Noor Haddad, Oct 23 review']);
    const unsourced = changed(blocks => blocks.map(block => block.kind === 'quote' ? { kind: 'quote', statements: block.statements, text: block.text } : block));
    const [other] = byClass(await shownAnswer(unsourced), 'answer-quote');
    expect(byType(other, 'figcaption')).toEqual([]);
  });

  it('widens a table of more than six columns in its own scroll box: the writer has no column cap (ADR-0051)', async () => {
    const columns = ['Item', 'Status', 'Owner', 'Due', 'Priority', 'Area', 'Build', 'Risk'];
    const wide = changed(blocks => blocks.map(block => block.kind !== 'table' ? block
      : { ...block, columns, rows: block.rows.map(row => ({ ...row, cells: columns.map((_, at) => row.cells[at] ?? `x${at}`) })) }));
    const [box] = byClass(byTestId((await answered(wide)).thread(), 'answer').at(-1), 'answer-table');
    expect(byType(box, 'table')[0]!.props.style).toEqual({ minWidth: '800px' });
    const [plain] = byClass((await answered(therm())).thread(), 'answer-table');
    expect(byType(plain, 'table')[0]!.props.style).toBeUndefined();
  });

  it('draws a table in its own box with a header cell per column, its title as the heading above it and its region\'s label, its caption only when it opens the answer', async () => {
    const { thread } = await answered(therm());
    const [box] = byClass(thread(), 'answer-table');
    // After the answer its caption would say the answer again (ADR-0049): it only names the table.
    expect(text(thread())).not.toContain('2 Jira tickets are open');
    expect(box!.props).toMatchObject({ role: 'region', tabIndex: 0, 'aria-label': '2 Jira tickets are open' });
    expect(byType(box, 'th').map(node => [text(node), node.props.scope])).toEqual([['Item', 'col'], ['Status', 'col'], ['Owner', 'col'], ['Due', 'col']]);
    const rows = byTestId(box, 'answer-row').map(row => byType(row, 'td'));
    expect(rows.map(row => text(byType(row[3], 'time')))).toEqual(['Nov 4', 'Oct 30']);
    // Your late row's due date alone is in the signal colour, and says so.
    expect(rows.map(row => classes(row[3]).includes('late'))).toEqual([false, true]);
    expect(classes(rows[1]![2])).toContain('you');
    // Titled, with no caption: the title is the heading above it and names it.
    const titled = changed(blocks => blocks.map(block => block.kind === 'table' ? { kind: 'table', title: 'Open tickets', statements: block.statements, columns: block.columns,
      rows: block.rows } : block));
    const later = await shownAnswer(titled);
    expect(drawn(byClass(later, 'answer-layout')[0]).slice(0, 3)).toEqual(['p.answer-lead', 'h3.answer-heading', 'div.answer-table']);
    expect(byType(later, 'h3')[0]!.props.children).toBe('Open tickets');
    expect(byClass(later, 'answer-table')[0]!.props['aria-label']).toBe('Open tickets');
    // Opening the answer, its caption says what the rows are, in the lead's type.
    const base = therm();
    const [part] = base.parts;
    const table = part!.blocks![1]!;
    const opening: Answer = { ...base, parts: [{ ...part!, statements: [part!.statements[1]!], blocks: [{ ...table, statements: [0] } as ArrangedBlock] }] };
    const first = await shownAnswer(opening);
    expect(byClass(first, 'answer-lead').map(text)).toEqual(['2 Jira tickets are open']);
  });

  it('puts each row\'s numbers in its first cell, shows dates as "Oct 14" in mono, and marks only your own late row', async () => {
    // Tomas's THERM-52 is late too.
    const { thread } = await answered(changed(blocks => blocks.map(block => block.kind !== 'table' ? block
      : { ...block, rows: [{ ...block.rows[0]!, cells: ['THERM-52 · Thermal pad supplier', 'In Progress', 'Tomas Okafor', '2026-10-28'] }, block.rows[1]!] })));
    const cells = byTestId(thread(), 'answer-row').map(row => byType(row, 'td'));
    expect(cells.map(row => text(byTestId(row[0], 'citation')))).toEqual(['5', '6']);
    expect(cells.map(row => text(row[0]).replace(/\d+$/u, ''))).toEqual(['THERM-52 · Thermal pad supplier', 'THERM-55 · Line fixture']);
    // No lock beside a row's number, though the tickets only you can read are cited (ADR-0049): a lock is only ever on a source's own row.
    expect(elements(byTestId(thread(), 'answer')).filter(node => /only you/iu.test(String(node.props['aria-label'] ?? '')))).toEqual([]);
    const due = cells.map(row => row[3]!);
    expect(due.map(cell => text(byType(cell, 'time')))).toEqual(['Oct 28', 'Oct 30']);
    expect(due.map(cell => byType(cell, 'time')[0]!.props.dateTime)).toEqual(['2026-10-28', '2026-10-30']);
    expect(due.every(cell => classes(cell).includes('day'))).toBe(true);
    // Yours and late: in the signal colour, and said, not by colour alone. Tomas's late row stays grey.
    expect(due.map(cell => classes(cell).includes('late'))).toEqual([false, true]);
    expect(text(due[1])).toBe('Oct 30, overdue');
    expect(classes(cells[1]![2])).toContain('you');
    expect(classes(cells[0]![2])).not.toContain('you');
  });

  it('locks only the source row of what ECHO keeps for you alone: never a row of the answer, never a ticket read live (ADR-0049)', async () => {
    const base = therm();
    const [part] = base.parts;
    // A team page, a ticket only you can read (read live, with your access) and an approved record only you can read.
    const mine: Answer['sources'][number] = { kind: 'record', label: 'My release review',
      record: { record_sha256: 'a'.repeat(64), policy_id: 'restricted-reviewer-person-v2' }, atom_id: 'b'.repeat(64), private: true };
    const sources = [base.sources[0]!, base.sources[3]!, mine];
    const answer: Answer = { ...base, sources, parts: [{ ...part!,
      statements: [{ text: '3 items are open: Soak test plan, THERM-48 and my release review.', citation_indexes: [0, 1, 2], private: true }],
      blocks: [{ kind: 'table', statements: [0], columns: ['Item', 'Status'], caption: '3 items are open', rows: [
        { cells: ['Soak test plan', 'Open'], citation_indexes: [0] }, { cells: ['THERM-48', 'Open'], citation_indexes: [1] },
        { cells: ['My release review', 'Open'], citation_indexes: [2] },
      ] }] }] };
    // The record is read for its name, as every cited meeting is; here it cannot be, and keeps its label.
    rpc.mockImplementation(rpcFor(held, { 'ask.record': () => fail('not_found') }, () => ({ active: [], archived: [] })));
    const { thread } = await answered(answer);
    expect(byTestId(thread(), 'answer-row').map(row => elements(row).filter(node => /only you/iu.test(String(node.props['aria-label'] ?? ''))).length)).toEqual([0, 0, 0]);
    click(byTestId(thread(), 'sources-toggle')[0]);
    expect(byTestId(thread(), 'source-row').map(row => byTestId(row, 'source-lock').length)).toEqual([0, 0, 1]);
  });

  it('marks a row yours by your name too, and never a row that is done', async () => {
    const answer = changed(blocks => blocks.map(block => block.kind !== 'table' ? block : { ...block, rows: [
      { ...block.rows[0]!, cells: ['THERM-52 · Thermal pad supplier', 'In Progress', 'Fixture', '2026-10-28'] },
      { ...block.rows[1]!, cells: ['THERM-55 · Line fixture', 'Done', 'You', '2026-10-30'] },
    ] }));
    const due = byTestId(await shownAnswer(answer), 'answer-row').map(row => byType(row, 'td')[3]!);
    expect(due.map(cell => classes(cell).includes('late'))).toEqual([true, false]);
  });

  it('reads a part without blocks exactly as before: a paragraph per sentence', async () => {
    const { thread } = await answered(therm(false));
    const answer = byTestId(thread(), 'answer')[0]!;
    expect(byClass(answer, 'answer-layout')).toEqual([]);
    const statements = byTestId(answer, 'statement');
    expect(statements).toHaveLength(10);
    expect(statements.every(node => node.type === 'p' && classes(node).includes('answer-statement'))).toBe(true);
    expect(statements.map(node => words(node))[2]).toBe('2026-10-20, Noor Haddad: Approved the soak plan.');
  });
});

describe('a check of an arranged answer (ADR-0047)', () => {
  it('leaves out an item whose source you can no longer read, and lights one whose source changed, each on its own', async () => {
    // The soak plan and THERM-55 are no longer yours to read; THERM-48 changed.
    const { thread } = await reopened({ 31020: 'unreadable', 20055: 'unreadable', 20048: 'changed' }, kept('1', therm()));
    const answer = byTestId(thread(), 'answer')[0]!;
    const [timeline] = byClass(answer, 'answer-timeline');
    expect(byType(timeline, 'li').map(node => [text(byType(node, 'time')), words(node)])).toEqual([['Oct 23', 'The 72-hour soak passed.']]);
    expect(byClass(answer, 'answer-fact').map(node => [node.props['data-mark'], classes(node)])).toEqual([
      ['changed', ['answer-fact', 'changed']], ['changed', ['answer-fact', 'changed']]]);
    // A row is judged by what it cites itself: THERM-52's stays.
    expect(byTestId(answer, 'answer-row').map(row => text(byType(row, 'td')[0]).replace(/\d+$/u, ''))).toEqual(['THERM-52 · Thermal pad supplier']);
    // The title of a block with something left to show stays; nothing else is marked.
    expect(byType(answer, 'h3').map(text)).toEqual(['Soak test', 'Before PVT', 'Open risk']);
    expect(byTestId(answer, 'statement').filter(node => node.props['data-mark'] !== undefined)).toHaveLength(2);
  });

  it('takes away a block left with nothing to show, and its title with it', async () => {
    // The readiness review and THERM-48 are no longer yours to read: the steps, the quote and the card cite nothing else.
    const { thread } = await reopened({ 31022: 'unreadable', 20048: 'unreadable' }, kept('2', therm()));
    const answer = byTestId(thread(), 'answer')[0]!;
    expect(drawn(byClass(answer, 'answer-layout')[0])).toEqual(['p.answer-lead', 'div.answer-table', 'h3.answer-heading', 'ol.answer-timeline', 'h3.answer-heading',
      'p.answer-paragraph']);
    expect(byType(answer, 'h3').map(text)).toEqual(['Soak test', 'Open risk']);
    expect(text(answer)).not.toContain('THERM-48');
  });

  it('asks about every source of an answer past the 100 one check request takes, and leaves out what cites one past them you can no longer read', async () => {
    // 104 pages, each a point of its own after the answer: the 104th is no longer yours to read.
    const { store, thread } = await reopened({ 41103: 'unreadable' }, kept('1', pagesAnswer(104)));
    expect(rpc.mock.calls.filter(([name]) => name === 'ask.check').map(([, params]) => (params as { items: unknown[] }).items.length)).toEqual([100, 4]);
    const answer = byTestId(thread(), 'answer')[0]!;
    expect(byTestId(answer, 'statement').map(words)).toHaveLength(103);
    expect(text(answer)).not.toContain('Page 104');
    expect(await store.copyAnswer(store.getState().timeline.turns.at(-1)!.id)).toBe(true);
    const [markdown] = rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').map(([, params]) => (params as { text: string }).text);
    expect(markdown).toContain('Page 103 applies.');
    expect(markdown).not.toContain('Page 104');
  });

  it('keeps hidden what a request found you can no longer read when a later request of the check fails, and speaks for no turn', async () => {
    // 104 pages, two requests: the first finds page 1 no longer yours to read, and the second fails.
    const sent: number[] = [];
    const first = finding({ 41000: 'unreadable' });
    const { store, thread } = await reopenedWith(params => {
      sent.push((params.items as unknown[]).length);
      return sent.length === 1 ? first(params) : { ok: false, failure: { code: 'unavailable', retryable: true } };
    }, kept('1', pagesAnswer(104)));
    expect(sent).toEqual([100, 4]);
    const id = store.getState().timeline.turns.at(-1)!.id;
    expect(text(byTestId(thread(), 'answer')[0])).not.toContain('Page 1 applies.');
    expect(await store.copyAnswer(id)).toBe(true);
    const [markdown] = rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').map(([, params]) => (params as { text: string }).text);
    expect(markdown).toContain('Page 2 applies.');
    expect(markdown).not.toContain('Page 1 applies.');
    // The turn keeps page 1 unreadable, and nothing says it is current: no check is kept for it, so the next one asks again.
    expect(store.getState().timeline.turns.at(-1)!.unreadable).toEqual([0]);
    expect(store.getState().timeline.checks[id]).toBeUndefined();
  });

  it('hides at once what such a check found unreadable, over a check of the turn still good that found it readable', async () => {
    // An earlier turn citing 50 pages and the latest citing 60: Ask opening checks both, in two requests.
    const older = kept('1', pagesAnswer(50), 2, 'Which pages apply?');
    const latest = kept('2', pagesAnswer(60));
    const failing: number[] = [];
    let fails = false;
    const same = finding({});
    const { store } = await reopenedWith(params => {
      if (!fails) return same(params);
      const items = params.items as { asked_at: string; citation: Record<string, unknown> }[];
      failing.push(items.length);
      return failing.length > 1 ? { ok: false, failure: { code: 'unavailable', retryable: true } }
        : ok({ items: items.map(({ asked_at, citation }) => ({ state: asked_at === older.asked_at && citation.page_id === '41000' ? 'unreadable' : 'same' })) });
    }, older, latest);
    // Five and a half minutes on, opening the earlier turn checks it alone: its page 1 is readable.
    vi.setSystemTime(NOW.getTime() + 5.5 * 60_000);
    store.toggleTurn(older.id);
    await flush();
    expect(store.getState().timeline.checks[older.id]?.states[0]).toBe('same');
    // Half a minute later Ask opens again and checks both: its first request finds that page 1 unreadable, and its second fails.
    vi.setSystemTime(NOW.getTime() + 6 * 60_000);
    fails = true;
    store.closeAsk();
    store.pickSuggestion({ question: QUESTION, turn: latest.id });
    await flush();
    expect(failing).toEqual([100, 10]);
    expect(store.getState().timeline.checks[older.id]?.states[0]).toBe('unreadable');
    expect(store.getState().timeline.turns.find(turn => turn.id === older.id)!.unreadable).toEqual([0]);
    expect(await store.copyAnswer(older.id)).toBe(true);
    const markdown = rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').map(([, params]) => (params as { text: string }).text).at(-1)!;
    expect(markdown).toContain('Page 2 applies.');
    expect(markdown).not.toContain('Page 1 applies.');
  });
});

describe('every answer\'s sources start closed, as the one quiet line under it (ADR-0049)', () => {
  it('says how many on one line, closed, with no names, and opens onto a row per source on a click', async () => {
    const { store, thread } = await answered(therm());
    const [toggle] = byTestId(thread(), 'sources-toggle');
    expect(toggle!.props['aria-expanded']).toBe(false);
    // Answered at once: no time to say.
    expect(text(toggle)).toBe('6 sources');
    expect(byTestId(thread(), 'source-row')).toEqual([]);
    click(toggle);
    expect(byTestId(thread(), 'sources-toggle')[0]!.props['aria-expanded']).toBe(true);
    expect(byTestId(thread(), 'source-row').map(text)).toEqual(['1Soak test plan', '2Soak test report', '3PVT readiness review', '4THERM-48 · Soak sign-off',
      '5THERM-52 · Thermal pad supplier', '6THERM-55 · Line fixture']);
    click(byTestId(thread(), 'sources-toggle')[0]);
    expect(byTestId(thread(), 'source-row')).toEqual([]);
    expect(store.getState().sources?.listed).toEqual([]);
  });

  it('keeps the source list choice when citations open, and the next answer\'s starts closed beside it', async () => {
    const { store, thread } = await answered(therm(false));
    click(byTestId(thread(), 'citation')[0]);
    expect(byTestId(thread(), 'source-row')).toHaveLength(0);
    store.closeSources();
    expect(byTestId(thread(), 'source-row')).toHaveLength(0);
    click(byTestId(thread(), 'sources-toggle')[0]);
    click(byTestId(thread(), 'citation')[0]);
    expect(byTestId(thread(), 'source-row')).toHaveLength(6);
    store.closeSources();
    expect(byTestId(thread(), 'source-row')).toHaveLength(6);
    const again = held.hold('ask.run');
    void store.ask('And the soak report?');
    await flush();
    again(ok(therm()));
    await flush();
    // Both answers show in full, each with its own list: the earlier one stays open, the new one starts closed.
    expect(byTestId(thread(), 'sources-toggle').map(toggle => toggle.props['aria-expanded'])).toEqual([true, false]);
    expect(byTestId(thread(), 'source-row')).toHaveLength(6);
    click(byTestId(thread(), 'sources-toggle')[1]);
    expect(byTestId(thread(), 'source-row')).toHaveLength(12);
  });

  it('says "1 source" for one', async () => {
    const base = therm(false);
    const single: Answer = { ...base, sources: base.sources.slice(0, 1), parts: [{ ...base.parts[0]!, statements: [{ text: 'One.', citation_indexes: [0], private: false }] }] };
    const { thread } = await answered(single);
    expect(text(byTestId(thread(), 'sources-toggle')[0])).toBe('1 source');
  });
});

describe('only actionable answer explanations are shown', () => {
  it('hides legacy partial coverage prose after its blocks without adding a coverage banner or retry button', async () => {
    const result = blocksAnswer(QUESTION, GLOBAL, true) as { parts: Record<string, unknown>[] };
    // Research stopped short: the answer says what it did not cover, and its part, as prose with no typed details, what was not found.
    const partial = answerView({ ok: true, result: { ...result, outcome: 'partial', notice: 'One of three THERM meetings in range was not read before the time limit.',
      parts: [{ ...result.parts[0], status: 'partial', gap: 'Who signs off PVT was not found in the evidence read.' }] } }, GLOBAL);
    const { thread } = await answered(partial);
    const answer = byTestId(thread(), 'answer')[0]!;
    expect(text(thread())).not.toContain('THERM meetings in range');
    expect(byTestId(thread(), 'answer-gap')).toHaveLength(0);
    for (const gone of ['coverage-note', 'answer-notice', 'answer-assumption', 'answer-off-scope', 'ask-again']) expect(byTestId(thread(), gone)).toEqual([]);
    expect(byClass(answer, 'answer-banner')).toEqual([]);
  });

  it('keeps typed missing-part explanations and heads the factual parts with their questions', async () => {
    const base = therm(false);
    const answer: Answer = { ...base, outcome: 'partial', parts: [base.parts[0]!, { question: 'Who signs off PVT?', status: 'not_found', statements: [],
      gap: 'Not found: its sign-off. Some sentences did not fit.', gap_details: { not_found: 'Not found: its sign-off.' } }] };
    const shown = await shownAnswer(answer);
    expect(byClass(shown, 'answer-part')).toHaveLength(1);
    expect(byClass(shown, 'section-label').map(text)).toEqual([QUESTION]);
    expect(text(shown)).toContain('Not found: its sign-off.');
    expect(text(shown)).not.toContain('Some sentences did not fit.');
  });

  it.each([
    { message: "Ask can read your sources, but it can't make changes or send messages. Nothing was changed or sent.", details: { unsupported_action: true as const } },
    { message: "I couldn't complete the search. Please try again.", details: { interrupted: true as const } },
  ])('shows and copies an empty partial answer explanation: $message', async ({ message, details }) => {
    const base = therm(false);
    const { thread } = await answered({ ...base, sources: [], outcome: 'partial', parts: [{ question: QUESTION, status: 'not_found', statements: [],
      gap: 'Unchecked entries and sentences did not fit.', gap_details: details }] });
    expect(byTestId(thread(), 'answer-gap').map(text)).toEqual([message]);
    expect(byTestId(thread(), 'answer-empty')).toHaveLength(0);
    click(byTestId(thread(), 'copy-answer')[0]);
    await flush();
    expect(rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').at(-1)?.[1]).toEqual({ text: message });
  });

  it('shows a completed not-found explanation, including a saved answer without typed details', async () => {
    const base = therm(false);
    const { thread } = await answered({ ...base, sources: [], outcome: 'not_found', parts: [{ question: QUESTION, status: 'not_found', statements: [], gap: 'Not found.' }] });
    expect(byTestId(thread(), 'answer-gap').map(text)).toEqual(['Not found.']);
    expect(byTestId(thread(), 'answer-empty')).toHaveLength(0);
  });

  it('does not call an empty technical partial answer a completed no-match search', async () => {
    const base = therm(false);
    const { thread } = await answered({ ...base, sources: [], outcome: 'partial', parts: [{ question: QUESTION, status: 'not_found', statements: [], gap: 'Some list rows did not fit.' }] });
    expect(byTestId(thread(), 'answer-gap')).toHaveLength(0);
    expect(byTestId(thread(), 'answer-empty')).toHaveLength(0);
  });
});

describe('Copy answer', () => {
  const copied = () => rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').map(([, params]) => (params as { text: string }).text);

  it('copies an arranged answer as Markdown, in the page\'s order, its sources numbered and named as the page shows them', async () => {
    const { store } = await answered(therm());
    expect(await store.copyAnswer(paneTurn(store))).toBe(true);
    const [markdown] = copied();
    expect(markdown).toMatch(/^Yes, PVT can start: the 72-hour soak passed on Oct 23\. \[2\]\n\n2 Jira tickets are open\n\n\| Item \| Status \| Owner \| Due \|\n/u);
    expect(markdown).toContain('\n### Soak test\n\n- Oct 20, Noor Haddad: Approved the soak plan. [1]\n- Oct 23, Noor Haddad: The 72-hour soak passed. [2]\n');
    expect(markdown).toContain('\n**Ticket: THERM-48**\n\n- Status: In review [4]\n- Owner: Tomas Okafor [4]\n');
    expect(markdown).toContain('\n### Before PVT\n\n1. Freeze the firmware at 1.4.2. [3]\n2. Ship the build to the line. [3]\n');
    expect(markdown).toContain('\n> Start PVT once the soak passes. [3]\n>\n> Noor Haddad, Oct 23 review\n');
    expect(markdown).toMatch(/\nSources\n\n1\. Soak test plan\n2\. Soak test report\n3\. PVT readiness review\n4\. THERM-48 · Soak sign-off\n5\. THERM-52 · Thermal pad supplier\n6\. THERM-55 · Line fixture$/u);
  });

  it('keeps only visible typed explanations when long Markdown falls back to plain text', async () => {
    const base = therm(false);
    const long = 'x'.repeat(11_850);
    const missing = 'Not found: the person who approved the launch.';
    const { store, thread } = await answered({ ...base, text: long, outcome: 'partial', parts: [{ question: QUESTION, status: 'partial',
      statements: [{ text: long, citation_indexes: [0], private: false }],
      gap: `${missing} Some unchecked entries did not fit.`, gap_details: { not_found: missing } }] });
    expect(byTestId(thread(), 'answer-gap').map(text)).toEqual([missing]);
    expect(await store.copyAnswer(paneTurn(store))).toBe(true);
    expect(copied()).toEqual([`${long}\n${missing}`]);
  });

  it('copies the plain text when the Markdown is past what Copy answer takes', async () => {
    const base = therm(false);
    const long = 'x'.repeat(11_990);
    const { store } = await answered({ ...base, text: long, parts: [{ question: QUESTION, status: 'answered', statements: [{ text: long, citation_indexes: [0], private: false }] }] });
    expect(await store.copyAnswer(paneTurn(store))).toBe(true);
    expect(copied()).toEqual([long]);
  });

  it('copies an old answer as the page shows it after its check: what it left out and the blocks it emptied gone, the rest renumbered', async () => {
    const { store } = await reopened({ 31022: 'unreadable', 20048: 'unreadable' }, kept('2', therm()));
    expect(await store.copyAnswer(store.getState().timeline.turns.at(-1)!.id)).toBe(true);
    const [markdown] = copied();
    for (const gone of ['Before PVT', 'THERM-48', '> Start PVT']) expect(markdown).not.toContain(gone);
    expect(markdown).toContain('\n### Open risk\n\nSensor self-heating is still unexplained, so the soak report keeps it on the PVT watch list. [2]\n\nSources\n\n'
      + '1. Soak test plan\n2. Soak test report\n3. THERM-52 · Thermal pad supplier\n4. THERM-55 · Line fixture');
  });
});
