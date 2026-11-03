import { describe, expect, it } from 'vitest';
import {
  PERSON_ASK_ANSWER_LAYOUT_HEADER_V1,
  PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V2,
  validatePersonAnswerBlocksV2,
  validatePersonAnswerResponseV8,
  validatePersonAskAnswerLayoutHeaderV2,
} from '../src/index.js';

const projectId = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' as const;
const project = { citation: { kind: 'project' as const, project_id: projectId }, kind: 'project' as const, label: 'Thermal recovery', visibility: 'project' as const, ref: `project:${projectId}` as const };
const tool = { citation: { kind: 'tool' as const, tool_id: 'jira' }, kind: 'tool' as const, label: 'Jira', visibility: 'team' as const, ref: 'tool:jira' as const };
const docs = { citation: { kind: 'tool' as const, tool_id: 'docs' }, kind: 'tool' as const, label: 'Docs', visibility: 'team' as const, ref: 'tool:docs' as const };
const citations = [project, tool, docs];
const statement = (text: string, citation_indexes: number[]) => ({ text, citation_indexes, private: false });
/** A THERM answer with every block: an answer, a timeline, a card, numbered steps, a table of one list statement and a quote. */
const statements = [
  statement('The soak passed, so PVT can start Nov 3.', [0]),
  statement('2026-10-20, Noor Haddad: Started the 72-hour soak.', [1]),
  statement('2026-10-23, Noor Haddad: The soak passed.', [1, 2]),
  statement('Ticket: THERM-48; Status: In review.', [1]),
  statement('Ticket: THERM-48; Owner: Tomas Okafor.', [1]),
  statement('Freeze the firmware.', [2]),
  statement('Ship the build to the line.', [2]),
  statement('2 actions are open: TRACE-01; DVT-R2.', [1, 2]),
  statement('Noor Haddad, Oct 23 review: “Start PVT once the soak passes.”', [0]),
];
const blocks = [
  { kind: 'answer', statements: [0] },
  { kind: 'timeline', title: 'This week', statements: [1, 2], events: [
    { date: '2026-10-20', text: 'Started the 72-hour soak.', who: 'Noor Haddad' }, { date: '2026-10-23', text: 'The soak passed.', who: 'Noor Haddad' },
  ] },
  { kind: 'card', title: 'THERM-48', entity: 'ticket', statements: [3, 4], facts: [{ label: 'Status', value: 'In review' }, { label: 'Owner', value: 'Tomas Okafor' }] },
  { kind: 'points', title: 'Before PVT', ordered: true, statements: [5, 6] },
  { kind: 'table', statements: [7], columns: ['Action', 'Due'], caption: '2 actions are open', rows: [
    { cells: ['TRACE-01', '2026-10-14'], citation_indexes: [1] },
    { cells: ['DVT-R2', ''], citation_indexes: [2] },
  ] },
  { kind: 'quote', statements: [8], text: 'Start PVT once the soak passes.', from: 'Noor Haddad, Oct 23 review' },
];
const response = (parts: Record<string, unknown> = {}) => ({
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations,
  parts: [{ question: 'Can PVT start?', status: 'answered' as const, statements, blocks, ...parts }],
});
const check = (value: unknown, of = statements) => validatePersonAnswerBlocksV2(value, of, citations.length);
/** `blocks` with the block at `place` changed by `fields` (a field set to undefined is left out). */
const changed = (place: number, fields: Record<string, unknown>) => blocks.map((block, at) => at !== place ? block
  : Object.fromEntries(Object.entries({ ...block, ...fields }).filter(([, value]) => value !== undefined)));
const two = [statement('One.', [0]), statement('Two.', [1])];

describe('Answer layout v2 (ADR-0051)', () => {
  it('reads the header (ADR-0045, ADR-0051): absent is none, 1 is layout v1, 2 is layout v2, anything else is refused', () => {
    expect(PERSON_ASK_ANSWER_LAYOUT_HEADER_V1).toBe('x-echo-answer-layout');
    expect(PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V2).toBe('2');
    expect(validatePersonAskAnswerLayoutHeaderV2(undefined)).toBeUndefined();
    expect(validatePersonAskAnswerLayoutHeaderV2('1')).toBe(1);
    expect(validatePersonAskAnswerLayoutHeaderV2('2')).toBe(2);
    for (const value of ['0', '3', 'true', '', '1, 2', ['2'], 2]) expect(() => validatePersonAskAnswerLayoutHeaderV2(value)).toThrow();
  });

  it('accepts a V8 part whose blocks show every statement once, in order, and freezes them', () => {
    const accepted = validatePersonAnswerResponseV8(response());
    expect(accepted.parts[0]!.blocks).toEqual(blocks);
    expect(accepted.parts[0]).not.toHaveProperty('layout');
    expect(Object.isFrozen(accepted.parts[0]!.blocks![1])).toBe(true);
    expect(Object.isFrozen((accepted.parts[0]!.blocks![1] as { events: readonly object[] }).events[0])).toBe(true);
  });

  it('refuses blocks beside a v1 layout, or on a part with no statements', () => {
    expect(() => validatePersonAnswerResponseV8(response({ layout: [{ kind: 'paragraph', statements: statements.map((_, at) => at) }] }))).toThrow('blocks are invalid');
    expect(() => validatePersonAnswerResponseV8({ ...response({ status: 'not_found', statements: [], gap: 'None.' }), outcome: 'not_found', citations: [] })).toThrow('Ask response part blocks are invalid');
  });

  it('refuses no blocks, and blocks that leave out, repeat, reorder or go past the part\'s statements, and caps no count of blocks', () => {
    expect(() => check(blocks.slice(0, 5))).toThrow('leave a statement out');
    expect(() => check([{ kind: 'text', statements: [0, 0] }], two)).toThrow('duplicates');
    expect(() => check([{ kind: 'text', statements: [1] }, { kind: 'text', statements: [0] }], two)).toThrow('out of order');
    expect(() => check([{ kind: 'text', statements: [0, 1, 2] }], two)).toThrow();
    expect(() => check([], two)).toThrow();
    const eleven = Array.from({ length: 11 }, (_, at) => statement(`Fact ${at + 1}.`, [at % 3]));
    // How many blocks a part has is bounded only by its statements (ADR-0051): the part's own bound is the V8 answer's.
    expect(check(eleven.map((_, at) => ({ kind: 'text', statements: [at] })), eleven)).toHaveLength(11);
  });

  it('puts the answer first, with one or two statements, and only once', () => {
    expect(() => check([{ kind: 'text', statements: [0] }, { kind: 'answer', statements: [1] }], two)).toThrow('misplaced');
    expect(check([{ kind: 'answer', statements: [0, 1] }], two)[0]).toEqual({ kind: 'answer', statements: [0, 1] });
    const three = [...two, statement('Three.', [2])];
    expect(() => check([{ kind: 'answer', statements: [0, 1, 2] }], three)).toThrow();
    expect(() => check([{ kind: 'answer', title: 'No', statements: [0, 1] }], two)).toThrow('unexpected shape');
    // An answer may have no answer block: one whose writer left it out, or whose answer code could not keep.
    expect(check([{ kind: 'text', statements: [0, 1] }], two)).toHaveLength(1);
  });

  it('takes a title on text, points, a table and a timeline: one line, within its bytes', () => {
    expect(check([{ kind: 'text', title: 'Why', statements: [0, 1] }], two)[0]).toEqual({ kind: 'text', title: 'Why', statements: [0, 1] });
    for (const title of ['', ' Why', 'Two\nlines', 'x'.repeat(201)]) expect(() => check([{ kind: 'text', title, statements: [0, 1] }], two)).toThrow('title is invalid');
    expect(() => check([{ kind: 'text', statements: [0, 1], extra: true }], two)).toThrow('unexpected shape');
  });

  it('shows two or more points, ordered or not', () => {
    expect(check(changed(3, { ordered: false }))[3]).toMatchObject({ kind: 'points', ordered: false });
    expect(() => check(changed(3, { ordered: undefined }))).toThrow('unexpected shape');
    expect(() => check(changed(3, { ordered: 'yes' }))).toThrow('ordered is invalid');
    expect(() => check([{ kind: 'points', ordered: false, statements: [0] }, { kind: 'text', statements: [1] }], two)).toThrow();
  });

  it('checks a table as layout v1 does, with two or more rows, an optional title, and no cap on its columns', () => {
    expect(check(changed(4, { title: 'Open actions' }))[4]).toMatchObject({ kind: 'table', title: 'Open actions', caption: '2 actions are open' });
    const wide = Array.from({ length: 8 }, (_, at) => `Column ${at + 1}`);
    const cells = (first: string) => wide.map((_, at) => at === 0 ? first : `${at}`);
    expect(check(changed(4, { columns: wide, rows: [{ cells: cells('TRACE-01'), citation_indexes: [1] }, { cells: cells('DVT-R2'), citation_indexes: [2] }] }))[4]).toMatchObject({ kind: 'table', columns: wide });
    expect(() => check(changed(4, { rows: [{ cells: ['TRACE-01', '2026-10-14'], citation_indexes: [1, 2] }] }))).toThrow('rows is invalid');
    expect(() => check(changed(4, { columns: ['Action'] }))).toThrow('columns is invalid');
    expect(() => check(changed(4, { rows: [{ cells: ['TRACE-01', ''], citation_indexes: [0] }, { cells: ['DVT-R2', ''], citation_indexes: [2] }] }))).toThrow('cites what its statements do not');
    expect(() => check(changed(4, { rows: [{ cells: ['TRACE-01', ''], citation_indexes: [1] }, { cells: ['DVT-R2', ''], citation_indexes: [1] }] }))).toThrow('leave a citation of its statements out');
  });

  it('checks a timeline: one event a statement, each a real day, never going back', () => {
    const events = (blocks[1] as { events: readonly Record<string, unknown>[] }).events;
    expect(check(changed(1, { events: [{ date: '2026-10-20', text: 'Started the 72-hour soak.' }, events[1]] }))[1]).toMatchObject({ events: [{ date: '2026-10-20', text: 'Started the 72-hour soak.' }, events[1]] });
    expect(check(changed(1, { events: [events[0], { ...events[1], date: '2026-10-20' }] }))[1]).toMatchObject({ kind: 'timeline' });
    expect(() => check(changed(1, { events: [events[0]] }))).toThrow('events is invalid');
    expect(() => check(changed(1, { events: [events[1], events[0]] }))).toThrow('out of date order');
    for (const date of ['2026-02-30', '2026-10-2', 'Oct 20', '2026-10-20T00:00:00Z']) expect(() => check(changed(1, { events: [{ ...events[0], date }, events[1]] }))).toThrow('date is invalid');
    expect(() => check(changed(1, { events: [{ ...events[0], who: '' }, events[1]] }))).toThrow('who is invalid');
    expect(() => check(changed(1, { events: [{ ...events[0], link: 'x' }, events[1]] }))).toThrow('unexpected shape');
    expect(() => check([{ kind: 'timeline', statements: [0], events: [events[0]] }, { kind: 'text', statements: [1] }], two)).toThrow();
  });

  it('checks a card: its title, what it shows, and one fact a statement', () => {
    const facts = (blocks[2] as { facts: readonly Record<string, unknown>[] }).facts;
    for (const entity of ['person', 'project', 'ticket', 'decision']) expect(check(changed(2, { entity }))[2]).toMatchObject({ kind: 'card', entity });
    expect(() => check(changed(2, { entity: 'meeting' }))).toThrow('entity is invalid');
    expect(() => check(changed(2, { title: undefined }))).toThrow('unexpected shape');
    expect(() => check(changed(2, { facts: [facts[0]] }))).toThrow('facts is invalid');
    expect(() => check(changed(2, { facts: [{ label: 'Status', value: '' }, facts[1]] }))).toThrow('value is invalid');
    expect(() => check(changed(2, { facts: [{ label: 'Status' }, facts[1]] }))).toThrow('unexpected shape');
  });

  it('checks a quote: exactly one statement, its words, and where they come from', () => {
    expect(check(changed(5, { from: undefined }))[5]).toEqual({ kind: 'quote', statements: [8], text: 'Start PVT once the soak passes.' });
    expect(() => check(changed(5, { text: '' }))).toThrow('text is invalid');
    expect(() => check([{ kind: 'quote', statements: [0, 1], text: 'One. Two.' }], two)).toThrow();
  });

  it('refuses a block kind it does not know, and v1 kinds', () => {
    for (const kind of ['lead', 'heading', 'paragraph', 'bullets', 'chart']) expect(() => check([{ kind, statements: [0, 1] }], two)).toThrow();
  });
});
