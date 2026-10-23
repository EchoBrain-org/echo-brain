// An answer laid out (answer layout v1, ADR-0045), on the page: its lead,
// headings, bullets and tables in the desktop's own type, each sentence and
// row with its sources' numbers and lit on its own; a part without a layout
// as it always read. For every answer: the sources start as one closed line,
// what research did not cover is one quiet note after the answer, and Copy
// answer writes Markdown.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AnswerBlock } from '../../src/shared/protocol.js';
import { layoutAnswer } from '../../src/host/test-authority.js';
import { answerView } from '../../src/host/views.js';
import { asking as askingWith, byTestId, elements, flush, Held, ok, plainHooks, rpcFor, storeLifecycle, text, type Node } from './harness.js';

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

const byClass = (tree: unknown, name: string) => elements(tree).filter(node => typeof node.props.class === 'string' && node.props.class.split(' ').includes(name));
const byType = (tree: unknown, type: string) => elements(tree).filter(node => node.type === type);
const classes = (node: Node | undefined) => String(node?.props.class ?? '').split(' ').filter(Boolean);
const click = (node: Node | undefined) => (node!.props.onClick as () => void)();
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
    // A ticket only you can read: the lock beside the row's number.
    expect(byTestId(cells[0]![0], 'private-mark')).toHaveLength(1);
    expect(byTestId(cells[1]![0], 'private-mark')).toHaveLength(0);
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
    expect(store.getState().sources).toMatchObject({ open: 3, focus: '0.t4.0', listed: true });
    expect(store.paneTarget()?.number).toBe(3);
    const rows = byTestId(thread(), 'answer-row');
    expect(rows.map(node => classes(node).includes('on'))).toEqual([true, false, false, false]);
    expect(byTestId(thread(), 'statement').filter(node => classes(node).includes('on'))).toEqual([]);
    // A bullet's number lights that bullet.
    click(byTestId(byTestId(thread(), 'statement')[2], 'citation')[0]);
    expect(store.getState().sources?.focus).toBe('0.2');
    expect(byTestId(thread(), 'statement').map(node => classes(node).includes('on'))).toEqual([false, false, true, false, false]);
  });

  it('shows the caption of a table that opens the answer in the lead\'s type, and a later table\'s as a caption above it', async () => {
    const base = therm();
    const [part] = base.parts;
    const table: Table = { ...part!.layout![4]! as Table, caption: 'Four steps before DVT-R2' };
    const opening = { ...base, parts: [{ ...part!, statements: part!.statements.slice(5), layout: [{ ...table, statements: [0, 1, 2, 3] }] }] } as Answer;
    const first = byTestId((await answered(opening)).thread(), 'answer')[0]!;
    expect(byClass(first, 'answer-lead').map(text)).toEqual(['Four steps before DVT-R2']);
    expect(byClass(first, 'answer-table')[0]!.props['aria-label']).toBe('Four steps before DVT-R2');
    const later = { ...base, parts: [{ ...part!, layout: [...part!.layout!.slice(0, 4), table] }] };
    const shown = byTestId((await answered(later)).thread(), 'answer')[0]!;
    expect(byClass(shown, 'answer-caption').map(text)).toEqual(['Four steps before DVT-R2']);
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

describe('every answer\'s sources start closed, as one line', () => {
  it('names how many and which on one line, closed, and opens onto a row per source on a click', async () => {
    const { store, thread } = await answered(therm());
    const [toggle] = byTestId(thread(), 'sources-toggle');
    expect(toggle!.props['aria-expanded']).toBe(false);
    expect(text(byClass(toggle, 'count'))).toBe('6 sources');
    // Each name up to its first " · ": a ticket by its key.
    expect(text(byClass(toggle, 'names'))).toBe('DVT failure review · Traceability · Gate reviews · TRACE-01 · HW-11 · DVT-R2');
    expect(byTestId(thread(), 'source-row')).toEqual([]);
    click(toggle);
    expect(byTestId(thread(), 'sources-toggle')[0]!.props['aria-expanded']).toBe(true);
    expect(byTestId(thread(), 'source-row').map(text)).toEqual(['1DVT failure review', '2Traceability', '3Gate reviews',
      '4TRACE-01 · Confirm TC-D-03 traces to MRD-01', '5HW-11 · Fix BUG-412 on the board', '6DVT-R2 · Run DVT-R2']);
    click(byTestId(thread(), 'sources-toggle')[0]);
    expect(byTestId(thread(), 'source-row')).toEqual([]);
    expect(store.getState().sources?.listed).toBe(false);
  });

  it('opens when a number opens the pane, stays open when the pane closes, and starts closed again for the next answer', async () => {
    const { store, thread } = await answered(therm(false));
    click(byTestId(thread(), 'citation')[0]);
    expect(byTestId(thread(), 'source-row')).toHaveLength(6);
    store.closeSources();
    expect(byTestId(thread(), 'source-row')).toHaveLength(6);
    const again = held.hold('ask.run');
    void store.ask('And the gate review?');
    await flush();
    again(ok(therm()));
    await flush();
    expect(byTestId(thread(), 'sources-toggle')[0]!.props['aria-expanded']).toBe(false);
    expect(byTestId(thread(), 'source-row')).toEqual([]);
  });

  it('says "1 source" for one', async () => {
    const base = therm(false);
    const single: Answer = { ...base, sources: base.sources.slice(0, 1), parts: [{ ...base.parts[0]!, statements: [{ text: 'One.', citation_indexes: [0], private: false }] }] };
    const { thread } = await answered(single);
    expect(text(byClass(byTestId(thread(), 'sources-toggle')[0], 'count'))).toBe('1 source');
  });
});

describe('what research did not cover is one quiet note after the answer', () => {
  it('joins the notice and the gap after the last block, never as a banner over the answer', async () => {
    const { thread } = await answered(therm());
    const answer = byTestId(thread(), 'answer')[0]!;
    const children = (answer.props.children as unknown[]).flat(2).filter(Boolean) as Node[];
    const note = children.at(-1)!;
    expect(note.props['data-testid']).toBe('coverage-note');
    expect(text(byTestId(note, 'answer-notice'))).toBe('One of three THERM meetings in range was not read before the time limit.');
    expect(text(byTestId(note, 'answer-gap'))).toBe('Who proposed the reduced scope was not found in the evidence read.');
    expect(text(note)).toBe('One of three THERM meetings in range was not read before the time limit. Who proposed the reduced scope was not found in the evidence read.');
    expect(byClass(answer, 'answer-banner')).toEqual([]);
  });

  it('keeps the assumption and the off-scope line on top, and gives each part\'s gap its question when there are several', async () => {
    const base = therm(false);
    const answer: Answer = { ...base, assumption: 'Assuming THERM means the thermal test plan.', parts: [
      base.parts[0]!, { question: 'Who proposed it?', status: 'not_found', statements: [], gap: 'This was not found.' },
    ] };
    const shown = byTestId((await answered(answer)).thread(), 'answer')[0]!;
    const children = (shown.props.children as unknown[]).flat(2).filter(Boolean) as Node[];
    expect(children[0]!.props['data-testid']).toBe('answer-assumption');
    const note = children.at(-1)!;
    expect(byTestId(note, 'answer-gap').map(text)).toEqual(['Who proposed the reduced scope was not found in the evidence read.', 'This was not found.']);
    expect(text(note)).toBe('One of three THERM meetings in range was not read before the time limit. Can DVT-R2 run on the reduced test scope? '
      + 'Who proposed the reduced scope was not found in the evidence read. Who proposed it? This was not found.');
  });

  it('shows no note when research covered everything', async () => {
    const base = therm(false);
    const { notice: _notice, ...rest } = base;
    const { thread } = await answered({ ...rest, outcome: 'answered', parts: [{ ...base.parts[0]!, status: 'answered', gap: undefined }] });
    expect(byTestId(thread(), 'coverage-note')).toEqual([]);
  });
});

describe('Copy answer', () => {
  const copied = () => rpc.mock.calls.filter(([name]) => name === 'clipboard.writeText').map(([, params]) => (params as { text: string }).text);

  it('copies the answer as Markdown, its sources numbered and named as the page shows them', async () => {
    const { store } = await answered(therm());
    expect(await store.copyAnswer()).toBe(true);
    const [markdown] = copied();
    expect(markdown).toMatch(/^No, the reduced test scope was rejected\. \[2\] /u);
    expect(markdown).toContain('\n### Decisions\n');
    expect(markdown).toContain('\n| Confirm TC-D-03 traces to MRD-01 (TRACE-01) [4] | You | 2026-10-14 | To Do |\n');
    expect(markdown).toMatch(/\nSources\n\n1\. DVT failure review\n2\. Traceability\n3\. Gate reviews\n4\. TRACE-01 · Confirm TC-D-03 traces to MRD-01\n5\. HW-11 · Fix BUG-412 on the board\n6\. DVT-R2 · Run DVT-R2$/u);
  });

  it('copies the plain text when the Markdown is past what Copy answer takes', async () => {
    const base = therm(false);
    const long = 'x'.repeat(11_990);
    const { store } = await answered({ ...base, text: long, parts: [{ ...base.parts[0]!, statements: [{ text: long, citation_indexes: [0], private: false }] }] });
    expect(await store.copyAnswer()).toBe(true);
    expect(copied()).toEqual([long]);
  });
});
