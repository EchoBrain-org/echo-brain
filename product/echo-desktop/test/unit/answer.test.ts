import { describe, expect, it } from 'vitest';
import type { Answer, AnswerSource } from '../../src/shared/protocol.js';
import {
  answerMarkdown, answerSentences, coverage, documentName, externalSourceProvider, lateForYou, passageBlocks, sourceGroups, statementGroups, tableDay,
} from '../../src/renderer/answer.js';
import { layoutAnswer } from '../../src/host/test-authority.js';
import { answerView } from '../../src/host/views.js';

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const original = (source: string, anchor: string, label = 'SCOUT-Hardware-Review-v0.1.md'): AnswerSource => ({
  kind: 'original', label,
  ref: { source_id: `source:${source.repeat(64)}`, revision_id: 'rev-1', source_sha256: digest('2'), representation_sha256: digest('3'), anchor_sha256: digest(anchor) },
});
const record = (digit: string): AnswerSource => ({
  kind: 'record', label: 'Approved record 1', record: { record_sha256: digest(digit), policy_id: 'organization-member-readable-person-v2' }, atom_id: digest('a'),
});
const page = (id: string): AnswerSource => ({ kind: 'page', tool_id: 'confluence', label: 'Launch plan', permalink: `https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${id}` });

describe('an answer cites sources, not passages', () => {
  it('keeps external source identity in grouping and uses the actual tool label', () => {
    const source = { kind: 'page' as const, tool_id: 'notion', label: 'Launch', permalink: 'https://wiki.example.test/launch' };
    expect(externalSourceProvider(source)).toBe('Notion');
    expect(externalSourceProvider({ ...source, tool_id: 'knowledge-base' })).toBe('Knowledge Base');
    expect(externalSourceProvider(source, [{ tool_id: 'notion', name: 'Product Wiki', status: 'linked' }])).toBe('Product Wiki');
    expect(sourceGroups([source, { ...source, tool_id: 'confluence' }, { ...source }])).toEqual([
      { kind: 'page', indexes: [0, 2] }, { kind: 'page', indexes: [1] },
    ]);
  });
  it('groups repeated ticket citations by link while keeping another item distinct', () => {
    const ticket: AnswerSource = { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7', permalink: 'https://example.test/tickets/7' };
    expect(sourceGroups([ticket, page('12345'), { ...ticket, label: 'ECHO-7 updated title' }])).toEqual([
      { kind: 'ticket', indexes: [0, 2] }, { kind: 'page', indexes: [1] },
    ]);
  });
  it('groups the passages of one document, the items of one meeting record, and keeps each page apart, in first-cited order', () => {
    const sources = [original('a', '4'), original('b', '5', 'SCOUT-Software-Review-v0.1.md'), original('a', '6'), record('7'), record('7'),
      page('12345'), page('12346'), original('b', '8', 'SCOUT-Software-Review-v0.1.md')];
    expect(sourceGroups(sources)).toEqual([
      { kind: 'original', indexes: [0, 2] },
      { kind: 'original', indexes: [1, 7] },
      { kind: 'record', indexes: [3, 4] },
      { kind: 'page', indexes: [5] },
      { kind: 'page', indexes: [6] },
    ]);
  });

  it('gives a sentence one marker per source it cites, in source order', () => {
    const groups = sourceGroups([original('a', '4'), original('b', '5'), original('a', '6')]);
    expect(statementGroups([2, 1, 0], groups)).toEqual([0, 1]);
    expect(statementGroups([1], groups)).toEqual([1]);
    // An index the answer does not have is not a source.
    expect(statementGroups([9], groups)).toEqual([]);
  });
});

describe('a file name reads as a name', () => {
  it('drops the extension, reads dashes as spaces in a name without spaces, and keeps a trailing version apart', () => {
    expect(documentName('SCOUT-Hardware-Review-v0.1.md')).toEqual({ name: 'SCOUT Hardware Review', version: 'v0.1' });
    expect(documentName('launch_plan_v2.docx')).toEqual({ name: 'launch plan', version: 'v2' });
    expect(documentName('Pre-launch checklist.pdf')).toEqual({ name: 'Pre-launch checklist' });
    expect(documentName('Apollo update')).toEqual({ name: 'Apollo update' });
    expect(documentName('Transcript: Tuesday sync')).toEqual({ name: 'Transcript: Tuesday sync' });
    // A title someone wrote keeps its version: only a file name's is set apart.
    expect(documentName('Pricing v2')).toEqual({ name: 'Pricing v2' });
    // A version needs a name before it; a name that is only an extension is left as it came.
    expect(documentName('v2.md')).toEqual({ name: 'v2' });
    expect(documentName('.md')).toEqual({ name: '.md' });
  });
});

describe('a passage reads as its document does', () => {
  it('turns headings, lists and bold into blocks, and keeps other lines as they are', () => {
    const text = [
      '### Concerns',
      '- "Unobstructed" in **PRD-07** excludes lab clutter.',
      '- Floor transitions are unspecified.',
      '',
      '## 3. Stopping, e-stop',
      '1. Stop first.',
      '2) Report after.',
      '---',
      'Jules: I will publish the dashboard',
      'Maya: `v2` ships Friday',
    ].join('\n');
    expect(passageBlocks(text, 'SCOUT-Hardware-Review-v0.1.md')).toEqual([
      { kind: 'heading', text: [{ text: 'Concerns' }] },
      { kind: 'list', ordered: false, items: [
        [{ text: '"Unobstructed" in ' }, { text: 'PRD-07', bold: true }, { text: ' excludes lab clutter.' }],
        [{ text: 'Floor transitions are unspecified.' }],
      ] },
      { kind: 'heading', text: [{ text: '3. Stopping, e-stop' }] },
      { kind: 'list', ordered: true, items: [[{ text: 'Stop first.' }], [{ text: 'Report after.' }]] },
      { kind: 'paragraph', text: [{ text: 'Jules: I will publish the dashboard\nMaya: ' }, { text: 'v2', code: true }, { text: ' ships Friday' }] },
    ]);
  });

  it('drops the file name the evidence starts with, since the pane already names it', () => {
    expect(passageBlocks('SCOUT-Hardware-Review-v0.1.md docking approach is an OPEN-01 input.', 'SCOUT-Hardware-Review-v0.1.md'))
      .toEqual([{ kind: 'paragraph', text: [{ text: 'docking approach is an OPEN-01 input.' }] }]);
    expect(passageBlocks('We agreed to ship.', 'Apollo update')).toEqual([{ kind: 'paragraph', text: [{ text: 'We agreed to ship.' }] }]);
  });

  it('leaves unmatched markers as text', () => {
    expect(passageBlocks('A **half bold and a `tick', 'x')).toEqual([{ kind: 'paragraph', text: [{ text: 'A **half bold and a `tick' }] }]);
  });
});

// Answer layout v1 (ADR-0045): the fixture's THERM answer, as the host hands it to the page.
const GLOBAL = { kind: 'global' } as const;
const QUESTION = 'Can DVT-R2 run on the reduced test scope?';
const therm = (layout = true): Answer => answerView({ ok: true, result: layoutAnswer(QUESTION, GLOBAL, layout) }, GLOBAL);
const THERM_NAMES = ['DVT failure review', 'Traceability', 'Gate reviews', 'TRACE-01 · Confirm TC-D-03 traces to MRD-01', 'HW-11 · Fix BUG-412 on the board',
  'DVT-R2 · Run DVT-R2'];
/** A plain answer of `statements`, each citing the sources given by place. */
const plain = (statements: readonly [string, number[]][], extra: Partial<Answer> = {}): Answer => ({
  text: statements.map(([text]) => text).join('\n'), scope: GLOBAL, outcome: 'answered', sources: [page('1'), page('2'), page('3')],
  parts: [{ question: 'Q?', status: 'answered', statements: statements.map(([text, citation_indexes]) => ({ text, citation_indexes, private: false })) }], ...extra,
});

describe('a laid-out answer\'s rows are sentences the pane can light', () => {
  it('names each table row by its part, its table and its place, with the row\'s own citations, after the part\'s statements', () => {
    const sentences = answerSentences(therm());
    expect(sentences.map(([id]) => id)).toEqual(['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.t4.0', '0.t4.1', '0.t4.2', '0.t4.3']);
    expect(Object.fromEntries(sentences.filter(([id]) => id.includes('t')).map(([id, row]) => [id, row]))).toEqual({
      '0.t4.0': { text: 'Confirm TC-D-03 traces to MRD-01 (TRACE-01) · You · 2026-10-14 · To Do', citation_indexes: [3], private: true },
      '0.t4.1': { text: 'Send the regression-scope proposal to the PM · Rafael Moreno · 2026-10-09 · Open', citation_indexes: [2], private: false },
      '0.t4.2': { text: 'Fix BUG-412 on the board (HW-11) · Tomas Okafor · 2026-10-28 · In Progress', citation_indexes: [4], private: true },
      '0.t4.3': { text: 'Run DVT-R2 and publish the report · QA · 2026-10-30 · To Do', citation_indexes: [5], private: true },
    });
    // Without a layout there are no rows.
    expect(answerSentences(therm(false)).map(([id]) => id)).toEqual(['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8']);
  });
});

describe('a table\'s dates read as dates, and only your late row is marked', () => {
  const NOW = new Date(2026, 9, 23, 12).getTime();
  const COLUMNS = ['Action', 'Owner', 'Due', 'Status'];

  it('shows an ISO date as "Oct 14", with its year when it is not this year\'s, and leaves any other text alone', () => {
    expect(tableDay('2026-10-14', NOW)).toBe('Oct 14');
    expect(tableDay('2025-12-01', NOW)).toBe('Dec 1, 2025');
    for (const text of ['To Do', '14 Oct', '2026-13-01', '2026-10-14 maybe', '']) expect(tableDay(text, NOW)).toBeNull();
  });

  it('marks a row only when it is yours, its due date has passed and it is not done', () => {
    expect(lateForYou(COLUMNS, ['Confirm the trace', 'You', '2026-10-14', 'To Do'], null, NOW)).toBe(true);
    // Yours by your name as well, in any case.
    expect(lateForYou(COLUMNS, ['Confirm the trace', 'ari', '2026-10-14', 'To Do'], 'Ari', NOW)).toBe(true);
    // Someone else's late row, a row due today or later, a done row, or a table that says no owner or due date: never.
    expect(lateForYou(COLUMNS, ['Send the proposal', 'Rafael Moreno', '2026-10-09', 'Open'], 'Ari', NOW)).toBe(false);
    expect(lateForYou(COLUMNS, ['Confirm the trace', 'You', '2026-10-23', 'To Do'], null, NOW)).toBe(false);
    expect(lateForYou(COLUMNS, ['Confirm the trace', 'You', '2026-10-14', 'Done'], null, NOW)).toBe(false);
    expect(lateForYou(['Ticket', 'Due', 'Status'], ['TRACE-01', '2026-10-14', 'To Do'], null, NOW)).toBe(false);
    expect(lateForYou(['Item', 'Owner'], ['TRACE-01', 'You'], null, NOW)).toBe(false);
    expect(lateForYou(COLUMNS, ['Confirm the trace', 'You', 'Friday', 'To Do'], null, NOW)).toBe(false);
  });
});

describe('Copy answer writes Markdown (ADR-0045)', () => {
  it('writes a laid-out answer as it reads: the lead, headings, bullets, a table, each claim with its sources\' numbers, then the note and the sources', () => {
    expect(answerMarkdown(therm(), THERM_NAMES)).toBe([
      'No, the reduced test scope was rejected. [2] DVT-R2 retests TC-D-03 and TC-D-01, plus the regression subset QA approves. [2]',
      '',
      '### Decisions',
      '',
      '- A narrower run cannot exit DVT: the retest must cover the failed bar TC-D-03, TC-D-01 and a QA-approved regression subset. [3]',
      '- Hardware owns the BUG-412 fix (HW-11); the failure review made sensor self-heating the likely cause. [1]',
      '- TC-D-06 reruns too: its pass predates the approved two-decimal display. [3]',
      '',
      '### What has to happen first',
      '',
      '| Action | Owner | Due | Status |',
      '| --- | --- | --- | --- |',
      '| Confirm TC-D-03 traces to MRD-01 (TRACE-01) [4] | You | 2026-10-14 | To Do |',
      '| Send the regression-scope proposal to the PM [3] | Rafael Moreno | 2026-10-09 | Open |',
      '| Fix BUG-412 on the board (HW-11) [5] | Tomas Okafor | 2026-10-28 | In Progress |',
      '| Run DVT-R2 and publish the report [6] | QA | 2026-10-30 | To Do |',
      '',
      'One of three THERM meetings in range was not read before the time limit. Who proposed the reduced scope was not found in the evidence read.',
      '',
      'Sources',
      '',
      '1. DVT failure review',
      '2. Traceability',
      '3. Gate reviews',
      '4. TRACE-01 · Confirm TC-D-03 traces to MRD-01',
      '5. HW-11 · Fix BUG-412 on the board',
      '6. DVT-R2 · Run DVT-R2',
    ].join('\n'));
  });

  it('writes a part without a layout as a paragraph per sentence, numbered as the page numbers its sources', () => {
    const answer = plain([['We ship annual plans first.', [0, 2]], ['Monthly plans follow.', [1]]], {
      direct: { text: 'Yes.', citation_indexes: [2], private: false },
    });
    expect(answerMarkdown(answer, ['Launch plan', 'Pricing', 'Board'])).toBe(
      'Yes. [3]\n\nWe ship annual plans first. [1][3]\n\nMonthly plans follow. [2]\n\nSources\n\n1. Launch plan\n2. Pricing\n3. Board');
  });

  it('heads what each part says with its question when there are several, and puts each part\'s gap after its question in the note', () => {
    const answer: Answer = { ...plain([['Annual first.', [0]]]), sources: [page('1')], outcome: 'partial', parts: [
      { question: 'What did we agree?', status: 'answered', statements: [{ text: 'Annual first.', citation_indexes: [0], private: false }] },
      { question: 'Who approved it?', status: 'not_found', statements: [], gap: 'This was not found.' },
    ] };
    expect(coverage(answer)).toEqual({ gaps: [{ question: 'Who approved it?', text: 'This was not found.' }] });
    expect(answerMarkdown(answer, ['Launch plan'])).toBe(
      '## What did we agree?\n\nAnnual first. [1]\n\nWho approved it? This was not found.\n\nSources\n\n1. Launch plan');
  });

  it('keeps a table cell\'s pipes and backslashes as text, and a line that would start a list as a sentence', () => {
    const base = plain([['- dash first', [0]], ['A | B', [1]]]);
    const answer: Answer = { ...base, parts: [{ ...base.parts[0]!, layout: [
      { kind: 'paragraph', statements: [0] },
      { kind: 'table', statements: [1], columns: ['Name', 'Path'], caption: 'Two paths', rows: [{ cells: ['A | B', 'C:\\temp'], citation_indexes: [1] }] },
    ] }] };
    expect(answerMarkdown(answer, ['One', 'Two', 'Three'])).toBe(
      '\\- dash first [1]\n\nTwo paths\n\n| Name | Path |\n| --- | --- |\n| A \\| B [2] | C:\\\\temp |\n\nSources\n\n1. One\n2. Two\n3. Three');
  });
});
