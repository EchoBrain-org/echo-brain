// An answer laid out (answer layout v1, ADR-0045), on the page: its lead,
// headings, bullets and tables in the desktop's own type, each sentence and
// row with its sources' numbers and lit on its own; a part without a layout
// as it always read. For every answer: the sources start as one closed line,
// partial-answer explanations remain visible, and Copy answer writes
// Markdown.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AnswerBlock } from '../../src/shared/protocol.js';
import { layoutAnswer } from '../fixtures/authority.js';
import { answerView } from '../../src/host/views.js';
import {
  asking as askingWith, byClass, byTestId, byType, classes, click, elements, fail, flush, Held, ok, paneTurn, plainHooks, rpcFor, storeLifecycle, text, type Node,
} from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
// Components are called as plain functions below.
vi.mock('preact/hooks', original => plainHooks(original));

const GLOBAL = { kind: 'global' } as const;
const QUESTION = 'Can DVT-R2 run on the reduced test scope?';
/** The fixture's THERM answer, as the host hands it to the page: laid out, or as an Ask that did not ask for it gets it. */
const therm = (layout = true): Answer => answerView({ ok: true, result: layoutAnswer(QUESTION, GLOBAL, layout) }, GLOBAL);

let held: Held;
// The fixture's due dates are in October 2026: TRACE-01's (Oct 14) and Rafael's (Oct 9) have passed.
storeLifecycle(new Date(2026, 9, 23, 12));
beforeEach(() => {
  held = new Held();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, { 'clipboard.writeText': () => ok(null) }, () => ({ active: [], archived: [] })));
});

/** An Ask answered with `answer`: the store, and the thread as it shows now. */
async function answered(answer: Answer) {
  const { store, release, thread } = await askingWith(rpc, held, QUESTION);
  release(ok(answer));
  await flush();
  return { store, thread };
}

type Table = Extract<AnswerBlock, { kind: 'table' }>;

describe('a laid-out part reads as its blocks', () => {
  it('opens with the lead, its first sentence heavier, then each heading, the bullets and a table with a header cell per column', async () => {
    const { thread } = await answered(therm());
    const answer = byTestId(thread(), 'answer')[0]!;
    const [layout] = byClass(answer, 'answer-layout');
    // In the layout's order: lead, heading, bullets, heading, table.
    const blocks = (layout!.props.children as Node[]).flat().filter(Boolean).map(node => node.type === 'p' || node.type === 'h3' || node.type === 'ul' ? `${node.type}.${classes(node)[0]}` : classes(node)[0]);
    expect(blocks).toEqual(['p.answer-lead', 'h3.answer-heading', 'ul.answer-bullets', 'h3.answer-heading', 'answer-table']);
    const [lead] = byClass(layout, 'answer-lead');
    expect(byTestId(lead, 'statement-text').map(text)).toEqual(['No, the reduced test scope was rejected.',
      'DVT-R2 retests TC-D-03 and TC-D-01, plus the regression subset QA approves.']);
    expect(byTestId(lead, 'statement').map(classes)).toEqual([['claim'], ['claim']]);
    expect(byType(layout, 'h3').map(text)).toEqual(['Decisions', 'What has to happen first']);
    const [bullets] = byClass(layout, 'answer-bullets');
    expect(byType(bullets, 'li').map(node => node.props['data-testid'])).toEqual(['statement', 'statement', 'statement']);
    // A table shows its statements as rows: the sentences shown are the lead's and the bullets'.
    expect(byTestId(layout, 'statement-text')).toHaveLength(5);
    const ths = byType(layout, 'th');
    expect(ths.map(text)).toEqual(['Action', 'Owner', 'Due', 'Status']);
    expect(ths.map(node => node.props.scope)).toEqual(['col', 'col', 'col', 'col']);
    // Its own box scrolls; the page never does.
    const [box] = byClass(layout, 'answer-table');
    expect(box!.props).toMatchObject({ role: 'region', tabIndex: 0, 'aria-label': 'What has to happen first' });
    expect(byType(box, 'table')).toHaveLength(1);
  });

  it('puts each row\'s numbers in its first cell, shows dates as "Oct 14" in mono, and marks only your own late row', async () => {
    const { thread } = await answered(therm());
    const rows = byTestId(thread(), 'answer-row');
    expect(rows).toHaveLength(4);
    const cells = rows.map(row => byType(row, 'td'));
    expect(cells.map(row => text(byTestId(row[0], 'citation')))).toEqual(['4', '3', '5', '6']);
    expect(cells.map(row => text(row[0]).replace(/\d+$/u, ''))).toEqual(['Confirm TC-D-03 traces to MRD-01 (TRACE-01)', 'Send the regression-scope proposal to the PM',
      'Fix BUG-412 on the board (HW-11)', 'Run DVT-R2 and publish the report']);
    // No lock beside a row's number, though the ticket only you can read is cited (ADR-0049): a lock is only ever on a source's own row.
    expect(elements(byTestId(thread(), 'answer')).filter(node => /only you/iu.test(String(node.props['aria-label'] ?? '')))).toEqual([]);
    const due = cells.map(row => row[2]!);
    expect(due.map(cell => text(byType(cell, 'time')))).toEqual(['Oct 14', 'Oct 9', 'Oct 28', 'Oct 30']);
    expect(due.map(cell => byType(cell, 'time')[0]!.props.dateTime)).toEqual(['2026-10-14', '2026-10-09', '2026-10-28', '2026-10-30']);
    expect(due.every(cell => classes(cell).includes('day'))).toBe(true);
    // Yours and late: in the signal colour, and said, not by colour alone. Rafael's late row stays grey.
    expect(due.map(cell => classes(cell).includes('late'))).toEqual([true, false, false, false]);
    expect(text(due[0])).toBe('Oct 14, overdue');
    expect(classes(cells[0]![1])).toContain('you');
    expect(classes(cells[1]![1])).not.toContain('you');
  });

  it('locks only the source row of what ECHO keeps for you alone: never a row of the answer, never a ticket read live (ADR-0049)', async () => {
    const base = therm();
    const [part] = base.parts;
    // A team page, a ticket only you can read (read live, with your access) and an approved record only you can read.
    const mine: Answer['sources'][number] = { kind: 'record', label: 'My release review',
      record: { record_sha256: 'a'.repeat(64), policy_id: 'restricted-reviewer-person-v2' }, atom_id: 'b'.repeat(64), private: true };
    const sources = [base.sources[0]!, base.sources[3]!, mine];
    const answer: Answer = { ...base, sources, parts: [{ ...part!,
      statements: [{ text: '3 items are open: DVT failure review, TRACE-01 and my release review.', citation_indexes: [0, 1, 2], private: true }],
      layout: [{ kind: 'table', statements: [0], columns: ['Item', 'Status'], caption: '3 items are open', rows: [
        { cells: ['DVT failure review', 'Open'], citation_indexes: [0] }, { cells: ['TRACE-01', 'Open'], citation_indexes: [1] },
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
    const base = therm();
    const [part] = base.parts;
    const table = part!.layout![4]! as Table;
    const rows = [{ ...table.rows[0]!, cells: ['Confirm the trace', 'Fixture', '2026-10-14', 'To Do'] }, { ...table.rows[1]!, cells: ['Send the proposal', 'You', '2026-10-09', 'Done'] },
      ...table.rows.slice(2)];
    const { thread } = await answered({ ...base, parts: [{ ...part!, layout: [...part!.layout!.slice(0, 4), { ...table, rows }] }] });
    const due = byTestId(thread(), 'answer-row').map(row => byType(row, 'td')[2]!);
    expect(due.map(cell => classes(cell).includes('late'))).toEqual([true, false, false, false]);
  });

  it('lights a row, and only that row, when its number opens the pane, and the pane knows the row\'s citations', async () => {
    const { store, thread } = await answered(therm());
    const [row] = byTestId(thread(), 'answer-row');
    click(byTestId(row, 'citation')[0]);
    expect(store.getState().sources).toMatchObject({ open: 3, focus: '0.t4.0', listed: [] });
    expect(store.paneTarget()?.number).toBe(3);
    const rows = byTestId(thread(), 'answer-row');
    expect(rows.map(node => classes(node).includes('on'))).toEqual([true, false, false, false]);
    expect(byTestId(thread(), 'statement').filter(node => classes(node).includes('on'))).toEqual([]);
    // A bullet's number lights that bullet.
    click(byTestId(byTestId(thread(), 'statement')[2], 'citation')[0]);
    expect(store.getState().sources?.focus).toBe('0.2');
    expect(byTestId(thread(), 'statement').map(node => classes(node).includes('on'))).toEqual([false, false, true, false, false]);
  });

  it('shows the caption of a table that opens the answer in the lead\'s type, and none above a later table, which it names (ADR-0049)', async () => {
    const base = therm();
    const [part] = base.parts;
    const table: Table = { ...part!.layout![4]! as Table, caption: 'Four steps before DVT-R2' };
    const opening = { ...base, parts: [{ ...part!, statements: part!.statements.slice(5), layout: [{ ...table, statements: [0, 1, 2, 3] }] }] } as Answer;
    const first = byTestId((await answered(opening)).thread(), 'answer')[0]!;
    expect(byClass(first, 'answer-lead').map(text)).toEqual(['Four steps before DVT-R2']);
    expect(byClass(first, 'answer-table')[0]!.props['aria-label']).toBe('Four steps before DVT-R2');
    const later = { ...base, parts: [{ ...part!, layout: [...part!.layout!.slice(0, 4), table] }] };
    // Asked in the same Ask, it is the latest turn: the last answer shown.
    const shown = byTestId((await answered(later)).thread(), 'answer').at(-1)!;
    expect(text(shown)).not.toContain('Four steps before DVT-R2');
    expect(byClass(shown, 'answer-table')[0]!.props['aria-label']).toBe('Four steps before DVT-R2');
    expect(byClass(shown, 'answer-lead')).toHaveLength(1);
  });

  it('reads a part without a layout exactly as before: a paragraph per sentence', async () => {
    const { thread } = await answered(therm(false));
    const answer = byTestId(thread(), 'answer')[0]!;
    expect(byClass(answer, 'answer-layout')).toEqual([]);
    const statements = byTestId(answer, 'statement');
    expect(statements).toHaveLength(9);
    expect(statements.every(node => node.type === 'p' && classes(node).includes('answer-statement'))).toBe(true);
    expect(byType(answer, 'table')).toEqual([]);
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
    expect(byTestId(thread(), 'source-row').map(text)).toEqual(['1DVT failure review', '2Traceability', '3Gate reviews',
      '4TRACE-01 · Confirm TC-D-03 traces to MRD-01', '5HW-11 · Fix BUG-412 on the board', '6DVT-R2 · Run DVT-R2']);
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
    void store.ask('And the gate review?');
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
  it('hides legacy partial coverage prose without adding a coverage banner or retry button', async () => {
    const { thread } = await answered(therm());
    const answer = byTestId(thread(), 'answer')[0]!;
    expect(text(thread())).not.toContain('THERM meetings in range');
    expect(byTestId(thread(), 'answer-gap')).toHaveLength(0);
    for (const gone of ['coverage-note', 'answer-notice', 'answer-assumption', 'answer-off-scope', 'ask-again']) expect(byTestId(thread(), gone)).toEqual([]);
    expect(byClass(answer, 'answer-banner')).toEqual([]);
  });

  it('keeps typed missing-part explanations and heads the factual parts with their questions', async () => {
    const base = therm(false);
    const answer: Answer = { ...base, parts: [base.parts[0]!, { question: 'Who proposed it?', status: 'not_found', statements: [],
      gap: 'Not found: its proposer. Some sentences did not fit.', gap_details: { not_found: 'Not found: its proposer.' } }] };
    const shown = byTestId((await answered(answer)).thread(), 'answer')[0]!;
    expect(byClass(shown, 'answer-part')).toHaveLength(1);
    expect(byClass(shown, 'section-label').map(text)).toEqual(['Can DVT-R2 run on the reduced test scope?']);
    expect(text(shown)).toContain('Not found: its proposer.');
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

  // An answer is never blank: one that says nothing, whose only explanation is an untyped diagnostic the page hides, says
  // that nothing matched in what was read, since a partial answer did not read everything, and Copy writes the same.
  it.each([
    { what: 'a status selection over a list not read to its end',
      gap: 'Not found: tickets that have status Blocked. The list of tickets could not be read to its end, so more may exist.' },
    { what: 'a due-date window over follow-ups some of which have no due date', gap: 'Not found: follow-ups due Oct 23–29. 2 follow-ups have no due date.' },
    { what: 'an unfinished search answered by an Authority that sends no typed reasons', gap: "I couldn't complete the search. Please try again." },
  ])('says and copies that nothing matched in what was read for an empty partial answer: $what', async ({ gap }) => {
    const base = therm(false);
    const { thread } = await answered({ ...base, sources: [], outcome: 'partial', parts: [{ question: QUESTION, status: 'not_found', statements: [], gap }] });
    expect(byTestId(thread(), 'answer-gap')).toHaveLength(0);
    expect(text(thread())).not.toContain(gap);
    expect(byTestId(thread(), 'answer-empty').map(text)).toEqual(['Nothing matched in what I could read.']);
    click(byTestId(thread(), 'copy-answer')[0]);
    await flush();
    expect(rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').at(-1)?.[1]).toEqual({ text: 'Nothing matched in what I could read.' });
  });

  it('says and copies that nothing you can see matched for a completed answer that says and explains nothing', async () => {
    const base = therm(false);
    const { thread } = await answered({ ...base, sources: [], outcome: 'not_found', parts: [{ question: QUESTION, status: 'not_found', statements: [] }] });
    expect(byTestId(thread(), 'answer-gap')).toHaveLength(0);
    expect(byTestId(thread(), 'answer-empty').map(text)).toEqual(['Nothing you can see matched.']);
    click(byTestId(thread(), 'copy-answer')[0]);
    await flush();
    expect(rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').at(-1)?.[1]).toEqual({ text: 'Nothing you can see matched.' });
  });
});

describe('Copy answer', () => {
  const copied = () => rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').map(([, params]) => (params as { text: string }).text);

  it('copies the answer as Markdown, its sources numbered and named as the page shows them', async () => {
    const { store } = await answered(therm());
    expect(await store.copyAnswer(paneTurn(store))).toBe(true);
    const [markdown] = copied();
    expect(markdown).toMatch(/^No, the reduced test scope was rejected\. \[2\] /u);
    expect(markdown).toContain('\n### Decisions\n');
    expect(markdown).toContain('\n| Confirm TC-D-03 traces to MRD-01 (TRACE-01) [4] | You | 2026-10-14 | To Do |\n');
    expect(markdown).toMatch(/\nSources\n\n1\. DVT failure review\n2\. Traceability\n3\. Gate reviews\n4\. TRACE-01 · Confirm TC-D-03 traces to MRD-01\n5\. HW-11 · Fix BUG-412 on the board\n6\. DVT-R2 · Run DVT-R2$/u);
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
    const { store } = await answered({ ...base, text: long, outcome: 'answered', parts: [{ question: QUESTION, status: 'answered', statements: [{ text: long, citation_indexes: [0], private: false }] }] });
    expect(await store.copyAnswer(paneTurn(store))).toBe(true);
    expect(copied()).toEqual([long]);
  });
});
