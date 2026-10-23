import { describe, expect, it } from 'vitest';
import {
  PERSON_ASK_ANSWER_LAYOUT_HEADER_V1,
  validatePersonAnswerLayoutV1,
  validatePersonAnswerResponseV7,
  validatePersonAnswerResponseV8,
  validatePersonAskAnswerLayoutHeaderV1,
} from '../src/index.js';

const projectId = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' as const;
const project = { citation: { kind: 'project' as const, project_id: projectId }, kind: 'project' as const, label: 'Thermal recovery', visibility: 'project' as const, ref: `project:${projectId}` as const };
const tool = { citation: { kind: 'tool' as const, tool_id: 'jira' }, kind: 'tool' as const, label: 'Jira', visibility: 'team' as const, ref: 'tool:jira' as const };
const docs = { citation: { kind: 'tool' as const, tool_id: 'docs' }, kind: 'tool' as const, label: 'Docs', visibility: 'team' as const, ref: 'tool:docs' as const };
const citations = [project, tool, docs];
const statement = (text: string, citation_indexes: number[]) => ({ text, citation_indexes, private: false });
/** The THERM answer's shape: a lead, a heading, two bullets, a heading and a two-row table of one statement. */
const statements = [
  statement('No: the reduced test scope was rejected.', [0]),
  statement('Hardware owns the BUG-412 fix.', [1]),
  statement('TC-D-06 reruns.', [2]),
  statement('2 actions are open: TRACE-01; DVT-R2.', [1, 2]),
];
const layout = [
  { kind: 'lead', statements: [0] },
  { kind: 'heading', text: 'Decisions' },
  { kind: 'bullets', statements: [1, 2] },
  { kind: 'heading', text: 'What has to happen first' },
  { kind: 'table', statements: [3], columns: ['Action', 'Due'], caption: '2 actions are open', rows: [
    { cells: ['TRACE-01', '2026-10-14'], citation_indexes: [1] },
    { cells: ['DVT-R2', ''], citation_indexes: [2] },
  ] },
];
const response = (parts: Record<string, unknown> = {}) => ({
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations,
  parts: [{ question: 'Can DVT-R2 run on the reduced test scope?', status: 'answered' as const, statements, layout, ...parts }],
});
const check = (blocks: unknown, of = statements) => validatePersonAnswerLayoutV1(blocks, of, citations.length);

describe('Answer layout v1 (ADR-0045)', () => {
  it('reads the header: absent is no, its value is yes, anything else is refused', () => {
    expect(PERSON_ASK_ANSWER_LAYOUT_HEADER_V1).toBe('x-echo-answer-layout');
    expect(validatePersonAskAnswerLayoutHeaderV1(undefined)).toBe(false);
    expect(validatePersonAskAnswerLayoutHeaderV1('1')).toBe(true);
    for (const value of ['0', 'true', '', ['1']]) expect(() => validatePersonAskAnswerLayoutHeaderV1(value)).toThrow();
  });

  it('accepts a V8 part whose layout shows every statement once, in order, and freezes it', () => {
    const accepted = validatePersonAnswerResponseV8(response());
    expect(accepted.parts[0]!.layout).toEqual(layout);
    expect(Object.isFrozen(accepted.parts[0]!.layout![4])).toBe(true);
    const plain = response();
    const { layout: _, ...withoutLayout } = plain.parts[0]!;
    expect(validatePersonAnswerResponseV8({ ...plain, parts: [withoutLayout] }).parts[0]).not.toHaveProperty('layout');
  });

  it('keeps V7 closed to layout, and refuses one on a part with no statements', () => {
    expect(() => validatePersonAnswerResponseV7({ ...response(), schema_version: 7, kind: 'echo-clean-person-answer-v7', citations: [] })).toThrow();
    expect(() => validatePersonAnswerResponseV8({ ...response({ status: 'not_found', statements: [], gap: 'None.' }), outcome: 'not_found', citations: [] })).toThrow();
  });

  it('refuses a layout that leaves out, repeats or reorders a statement', () => {
    expect(() => check([{ kind: 'lead', statements: [0] }, { kind: 'bullets', statements: [1, 2] }])).toThrow('leaves a statement out');
    expect(() => check([{ kind: 'paragraph', statements: [0, 0, 1, 2] }])).toThrow('duplicates');
    expect(() => check([{ kind: 'paragraph', statements: [0, 1] }, { kind: 'paragraph', statements: [1, 2, 3] }])).toThrow('out of order');
    expect(() => check([{ kind: 'paragraph', statements: [1, 0, 2, 3] }])).toThrow('out of order');
    expect(() => check([{ kind: 'paragraph', statements: [0, 1, 2, 3, 4] }])).toThrow();
  });

  it('puts a lead first, with at most two statements, and a heading before a block that is not a heading', () => {
    expect(() => check([{ kind: 'paragraph', statements: [0] }, { kind: 'lead', statements: [1] }, { kind: 'paragraph', statements: [2, 3] }])).toThrow('lead is misplaced');
    expect(() => check([{ kind: 'lead', statements: [0, 1, 2] }, { kind: 'paragraph', statements: [3] }])).toThrow();
    expect(() => check([{ kind: 'paragraph', statements: [0, 1, 2, 3] }, { kind: 'heading', text: 'Next' }])).toThrow('heading is misplaced');
    expect(() => check([{ kind: 'heading', text: 'A' }, { kind: 'heading', text: 'B' }, { kind: 'paragraph', statements: [0, 1, 2, 3] }])).toThrow('heading is misplaced');
    expect(() => check([{ kind: 'heading', text: 'Two\nlines' }, { kind: 'paragraph', statements: [0, 1, 2, 3] }])).toThrow();
    expect(() => check([{ kind: 'heading', text: 'Notes' }, { kind: 'paragraph', statements: [0, 1, 2, 3], extra: true }])).toThrow();
  });

  it('refuses one bullet, which is a paragraph', () => {
    expect(() => check([{ kind: 'bullets', statements: [0] }, { kind: 'paragraph', statements: [1, 2, 3] }])).toThrow();
  });

  it('checks a table: its columns, one cell each, and rows that cite exactly what its statements cite', () => {
    const table = (fields: Record<string, unknown>) => check([{ kind: 'paragraph', statements: [0, 1, 2] }, { kind: 'table', statements: [3], columns: ['Action', 'Due'], rows: [
      { cells: ['TRACE-01', '2026-10-14'], citation_indexes: [1] }, { cells: ['DVT-R2', ''], citation_indexes: [2] }], ...fields }]);
    expect(table({})[1]).not.toHaveProperty('caption');
    expect(() => table({ columns: ['Action'] })).toThrow('columns is invalid');
    expect(() => table({ columns: ['Action', 'Action'] })).toThrow('duplicates');
    expect(() => table({ rows: [{ cells: ['TRACE-01'], citation_indexes: [1] }, { cells: ['DVT-R2', ''], citation_indexes: [2] }] })).toThrow('cells is invalid');
    expect(() => table({ rows: [{ cells: ['', ''], citation_indexes: [1] }, { cells: ['DVT-R2', ''], citation_indexes: [2] }] })).toThrow('row is empty');
    // Row 1 cites the project, which statement 3 does not.
    expect(() => table({ rows: [{ cells: ['TRACE-01', ''], citation_indexes: [0] }, { cells: ['DVT-R2', ''], citation_indexes: [2] }] })).toThrow('cites what its statements do not');
    expect(() => table({ rows: [{ cells: ['TRACE-01', ''], citation_indexes: [1] }] })).toThrow('leave a citation of its statements out');
    expect(() => table({ rows: [{ cells: ['TRACE-01', ''], citation_indexes: [] }, { cells: ['DVT-R2', ''], citation_indexes: [1, 2] }] })).toThrow();
    expect(() => table({ caption: '' })).toThrow();
  });
});
