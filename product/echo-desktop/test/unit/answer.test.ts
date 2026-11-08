import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AnswerSource, ArrangedBlock } from '../../src/shared/protocol.js';
import {
  answerMarkdown, answerSentences, answerText, documentName, externalSourceProvider, lateForYou, passageBlocks, sourceGroups, statementGroups, tableDay,
} from '../../src/renderer/answer.js';
import { blocksAnswer, paragraphs } from '../fixtures/authority.js';
import { answerView } from '../../src/host/views.js';

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
/** Copy answer's Markdown of an answer no check left anything out of: its sources numbered as the page numbers them. */
const markdown = (answer: Answer, names: readonly string[]) => answerMarkdown(answer, names, sourceGroups(answer.sources), () => true);
const original = (source: string, anchor: string, label = 'SCOUT-Hardware-Review-v0.1.md'): AnswerSource => ({
  kind: 'original', label,
  ref: { source_id: `source:${source.repeat(64)}`, revision_id: 'rev-1', source_sha256: digest('2'), representation_sha256: digest('3'), anchor_sha256: digest(anchor) },
});
const record = (digit: string): AnswerSource => ({
  kind: 'record', label: 'Approved record 1', record: { record_sha256: digest(digit), policy_id: 'project-members-readable-person-v1' }, atom_id: digest('a'),
});
const page = (id: string): AnswerSource => ({ kind: 'page', tool_id: 'confluence', label: 'Launch plan', permalink: `https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${id}` });

describe('an answer cites sources, not passages', () => {
  it('keeps external source identity in grouping and uses the actual tool label', () => {
    const source = { kind: 'page' as const, tool_id: 'notion', label: 'Launch', permalink: 'https://wiki.example.test/launch' };
    expect(externalSourceProvider(source)).toBe('Notion');
    expect(externalSourceProvider({ ...source, tool_id: 'knowledge-base' })).toBe('Knowledge Base');
    expect(externalSourceProvider(source, [{ tool_id: 'notion', name: 'Product Wiki', status: 'linked' }])).toBe('Product Wiki');
    expect(sourceGroups([source, { ...source, tool_id: 'confluence' }, { ...source }])).toEqual([{ indexes: [0, 2] }, { indexes: [1] }]);
  });
  it('groups repeated ticket citations by link while keeping another item distinct', () => {
    const ticket: AnswerSource = { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7', permalink: 'https://example.test/tickets/7' };
    expect(sourceGroups([ticket, page('12345'), { ...ticket, label: 'ECHO-7 updated title' }])).toEqual([{ indexes: [0, 2] }, { indexes: [1] }]);
  });
  it('groups the passages of one document, the items of one meeting record, and keeps each page apart, in first-cited order', () => {
    const sources = [original('a', '4'), original('b', '5', 'SCOUT-Software-Review-v0.1.md'), original('a', '6'), record('7'), record('7'),
      page('12345'), page('12346'), original('b', '8', 'SCOUT-Software-Review-v0.1.md')];
    expect(sourceGroups(sources)).toEqual([{ indexes: [0, 2] }, { indexes: [1, 7] }, { indexes: [3, 4] }, { indexes: [5] }, { indexes: [6] }]);
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

const GLOBAL = { kind: 'global' } as const;
const NOW = new Date(2026, 9, 23, 12).getTime();
/** An answer of `statements`, each its own paragraph, citing the sources given by place. */
const paragraphed = (statements: readonly [string, number[]][], extra: Partial<Answer> = {}): Answer => ({
  scope: GLOBAL, outcome: 'answered', sources: [page('1'), page('2'), page('3')],
  parts: [{ question: 'Q?', status: 'answered', statements: statements.map(([text, citation_indexes]) => ({ text, citation_indexes, private: false })),
    ...(statements.length === 0 ? {} : { blocks: paragraphs(statements) }) }], ...extra,
});

describe('a table\'s dates read as dates, and only your late row is marked', () => {
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

describe('Copy answer writes Markdown', () => {
  it('writes the direct answer, then each text block as a paragraph, numbered as the page numbers its sources', () => {
    const answer = paragraphed([['We ship annual plans first.', [0, 2]], ['Monthly plans follow.', [1]]], {
      direct: { text: 'Yes.', citation_indexes: [2], private: false },
    });
    expect(markdown(answer, ['Launch plan', 'Pricing', 'Board'])).toBe(
      'Yes. [3]\n\nWe ship annual plans first. [1][3]\n\nMonthly plans follow. [2]\n\nSources\n\n1. Launch plan\n2. Pricing\n3. Board');
  });

  it('heads factual parts with their questions and includes partial explanations', () => {
    const answer: Answer = { ...paragraphed([['Annual first.', [0]]]), sources: [page('1')], outcome: 'partial', parts: [
      { question: 'What did we agree?', status: 'answered', statements: [{ text: 'Annual first.', citation_indexes: [0], private: false }], blocks: [{ kind: 'text', statements: [0] }] },
      { question: 'Who approved it?', status: 'not_found', statements: [], gap: 'This was not found. An unchecked row did not fit.', gap_details: { not_found: 'This was not found.' } },
    ] };
    expect(markdown(answer, ['Launch plan'])).toBe(
      '## What did we agree?\n\nAnnual first. [1]\n\nThis was not found.\n\nSources\n\n1. Launch plan');
  });

  it('keeps fixed messages but hides source-derived absence when any cited source becomes unreadable', () => {
    const gap = "Ask can read your sources, but it can't make changes or send messages. Nothing was changed or sent.";
    const answer: Answer = { ...paragraphed([['Annual first.', [0]]]), sources: [page('1'), page('2')], outcome: 'partial', parts: [
      { question: 'What was decided, and update it?', status: 'partial', statements: [{ text: 'Annual first.', citation_indexes: [0], private: false }], blocks: [{ kind: 'text', statements: [0] }], gap: `${gap} An unchecked row did not fit.`, gap_details: { unsupported_action: true, interrupted: true, not_found: 'Not found: the confidential reviewer.' } },
    ] };
    expect(markdown(answer, ['Launch', 'Review'])).toContain(gap);
    expect(answerText(answer, () => true)).toBe(`Annual first.\n${gap}\nI couldn't complete the search. Please try again.\nNot found: the confidential reviewer.`);
    const shows = (ids: readonly number[]) => !ids.includes(1);
    expect(answerMarkdown(answer, ['Launch'], [{ indexes: [0] }], shows)).toContain(gap);
    expect(answerMarkdown(answer, ['Launch'], [{ indexes: [0] }], shows)).not.toContain('confidential reviewer');
    expect(answerText(answer, shows)).toBe(`Annual first.\n${gap}\nI couldn't complete the search. Please try again.`);
    // A sentence citing what a check found unreadable is left out of the plain text too, as from the page.
    expect(answerText(paragraphed([['Shown.', [0]], ['Hidden.', [1]]]), ids => !ids.includes(1))).toBe('Shown.');
  });

  it('copies only typed actionable explanations when diagnostic gaps also include formatting and coverage notes', () => {
    const notFound = 'Not found: the reviewer.';
    const answer: Answer = { ...paragraphed([['Annual first.', [0]]]), outcome: 'partial', parts: [{
      question: 'Who reviewed this? Publish it.', status: 'partial', statements: [{ text: 'Annual first.', citation_indexes: [0], private: false }], blocks: [{ kind: 'text', statements: [0] }],
      gap: 'The list did not reach the end. Unchecked rows and sentences did not fit. Dropped a sentence.',
      gap_details: { unsupported_action: true, interrupted: true, not_found: notFound },
    }] };
    const visible = ["Ask can read your sources, but it can't make changes or send messages. Nothing was changed or sent.",
      "I couldn't complete the search. Please try again.", notFound];
    expect(answerText(answer, () => true)).toBe(['Annual first.', ...visible].join('\n'));
    const copied = markdown(answer, ['Launch']);
    for (const line of visible) expect(copied).toContain(line);
    expect(copied).not.toContain(answer.parts[0]!.gap);
  });

  it('writes that nothing matched, in Markdown and in the long-answer plain text alike, for an answer that says nothing and whose explanation is hidden', () => {
    const answer: Answer = { ...paragraphed([]), sources: [], outcome: 'partial', parts: [{ question: 'Which tickets are blocked?', status: 'not_found', statements: [],
      gap: 'Not found: tickets that have status Blocked. The list of tickets could not be read to its end, so more may exist.' }] };
    // A partial answer did not read everything: nothing matched in what it read.
    expect(answerMarkdown(answer, [], [], () => true)).toBe('Nothing matched in what I could read.');
    expect(answerText(answer, () => true)).toBe('Nothing matched in what I could read.');
    // Any other: nothing you can see matched; and the line the page gives its turn, such as its project's, is written as given.
    const completed: Answer = { ...answer, outcome: 'not_found', parts: [{ question: 'Which tickets are blocked?', status: 'not_found', statements: [] }] };
    expect(answerMarkdown(completed, [], [], () => true)).toBe('Nothing you can see matched.');
    expect(answerText(completed, () => true)).toBe('Nothing you can see matched.');
    expect(answerMarkdown(completed, [], [], () => true, undefined, 'Nothing in Apollo matched.')).toBe('Nothing in Apollo matched.');
    expect(answerText(completed, () => true, undefined, 'Nothing in Apollo matched.')).toBe('Nothing in Apollo matched.');
    // A shown explanation, or anything said, takes its place.
    const typed: Answer = { ...answer, parts: [{ ...answer.parts[0]!, gap_details: { interrupted: true } }] };
    expect(answerText(typed, () => true)).toBe("I couldn't complete the search. Please try again.");
    expect(answerText(paragraphed([['Annual first.', [0]]]), () => true)).toBe('Annual first.');
  });

  it('keeps a table cell\'s pipes and backslashes as text, and a line that would start a list as a sentence', () => {
    const base = paragraphed([['- dash first', [0]], ['A | B', [1]]]);
    const answer: Answer = { ...base, parts: [{ ...base.parts[0]!, blocks: [
      { kind: 'text', statements: [0] },
      { kind: 'table', statements: [1], columns: ['Name', 'Path'], caption: 'Two paths', rows: [{ cells: ['A | B', 'C:\\temp'], citation_indexes: [1] }] },
    ] }] };
    expect(markdown(answer, ['One', 'Two', 'Three'])).toBe(
      '\\- dash first [1]\n\nTwo paths\n\n| Name | Path |\n| --- | --- |\n| A \\| B [2] | C:\\\\temp |\n\nSources\n\n1. One\n2. Two\n3. Three');
  });
});

describe('a done row is never late, and only an owner column says whose a row is', () => {
  const late = (status: string, owner = 'Owner') => lateForYou(['Action', owner, 'Due', 'Status'], ['Confirm the trace', 'You', '2026-10-14', status], null, NOW);

  it('reads every status of finished work as done, in any case and with either apostrophe', () => {
    for (const status of ['Done', 'closed', 'Resolved', 'complete', 'Completed', 'Cancelled', 'canceled', "Won't do", 'Won’t do', "won't fix", 'WON’T FIX', 'Duplicate',
      'rejected', 'Obsolete']) expect(late(status), status).toBe(false);
    for (const status of ['To Do', 'Open', 'In Progress', 'Blocked', '']) expect(late(status), status).toBe(true);
  });

  it('takes a row as yours only under a column named Owner, Assignee or Assigned to', () => {
    for (const owner of ['Owner', 'assignee', 'Assigned to', ' OWNER ']) expect(late('To Do', owner), owner).toBe(true);
    for (const owner of ['Assigned by', 'Owners', 'Reviewer', 'Who']) expect(late('To Do', owner), owner).toBe(false);
  });
});

describe('Copy answer\'s Markdown keeps the text as it was written', () => {
  const PROBE = 'Second | with pipe\nand a newline\n- not a list';

  it('keeps a sentence of several lines on one line, its punctuation as text, and its numbers on its claim', () => {
    const answer = paragraphed([[PROBE, [0]], ['1. step', [1]], ['Doc *one*', [2]]]);
    expect(markdown(answer, ['Doc *one*', '[draft] plan_v2', '# notes'])).toBe([
      'Second \\| with pipe and a newline - not a list [1]', '', '1\\. step [2]', '', 'Doc \\*one\\* [3]', '', 'Sources', '',
      '1. Doc \\*one\\*', '2. \\[draft\\] plan\\_v2', '3. \\# notes',
    ].join('\n'));
  });

  it('escapes bullets, table cells, headings and captions alike', () => {
    const base = paragraphed([[PROBE, [0]], ['1. step', [1]], ['- item <b>', [2]], ['hidden', [1]]]);
    const answer: Answer = { ...base, parts: [{ ...base.parts[0]!, blocks: [
      { kind: 'text', statements: [0] },
      { kind: 'points', title: 'Steps `now`', ordered: false, statements: [1, 2] },
      { kind: 'table', statements: [3], columns: ['Name', 'Note_1'], caption: '+ two > one', rows: [{ cells: ['Doc *one* <b>', '1. step'], citation_indexes: [1] }] },
    ] }] };
    expect(markdown(answer, ['One', 'Two', 'Three'])).toBe([
      'Second \\| with pipe and a newline - not a list [1]', '',
      '### Steps \\`now\\`', '',
      '- 1\\. step [2]', '- \\- item \\<b\\> [3]', '',
      '\\+ two \\> one', '',
      '| Name | Note\\_1 |', '| --- | --- |', '| Doc \\*one\\* \\<b\\> [2] | 1\\. step |', '',
      'Sources', '', '1. One', '2. Two', '3. Three',
    ].join('\n'));
  });
});

// Answer layout v2 (ADR-0051): the fixture's THERM answer in its blocks, as the host hands it to the page.
const BLOCKS_QUESTION = 'Can THERM start PVT?';
const arranged = (): Answer => answerView({ ok: true, result: blocksAnswer(BLOCKS_QUESTION, GLOBAL) }, GLOBAL);
/** The fixture's arranged answer with its blocks changed by `change`. */
const rearranged = (change: (blocks: ArrangedBlock[]) => ArrangedBlock[]): Answer => {
  const base = arranged();
  return { ...base, parts: [{ ...base.parts[0]!, blocks: change([...base.parts[0]!.blocks!]) }] };
};
const BLOCK_NAMES = ['Soak test plan', 'Soak test report', 'PVT readiness review', 'THERM-48 · Soak sign-off', 'THERM-52 · Thermal pad supplier', 'THERM-55 · Line fixture'];
const BLOCK_SOURCES = ['Sources', '', ...BLOCK_NAMES.map((name, at) => `${at + 1}. ${name}`)];

describe('an arranged answer (answer layout v2, ADR-0051)', () => {
  // The timeline's days are this year's.
  beforeEach(() => { vi.useFakeTimers({ now: NOW }); });
  afterEach(() => { vi.useRealTimers(); });

  it('names each table row by its part, its table\'s place among its blocks and its own, with the row\'s own citations, after the part\'s statements', () => {
    const sentences = answerSentences(arranged());
    expect(sentences.map(([id]) => id)).toEqual(['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '0.t1.0', '0.t1.1']);
    expect(Object.fromEntries(sentences.filter(([id]) => id.includes('t')))).toEqual({
      '0.t1.0': { text: 'THERM-52 · Thermal pad supplier · In Progress · Tomas Okafor · 2026-11-04', citation_indexes: [4] },
      '0.t1.1': { text: 'THERM-55 · Line fixture · To Do · You · 2026-10-30', citation_indexes: [5] },
    });
    // An event, a fact and a quote are the part's own sentences, as the Authority wrote them from their blocks.
    expect(sentences.filter(([id]) => ['0.2', '0.4', '0.9'].includes(id)).map(([, statement]) => statement.text)).toEqual([
      '2026-10-20, Noor Haddad: Approved the soak plan.', 'Ticket: THERM-48; Status: In review.', 'Noor Haddad, Oct 23 review: “Start PVT once the soak passes.”']);
    // Its plain reading is its sentences, one a line: a row is not read again.
    expect(answerText(arranged(), () => true)).toBe(arranged().parts[0]!.statements.map(statement => statement.text).join('\n'));
  });

  it('writes its blocks as Markdown in the page\'s order, each item followed by its sentence\'s numbers', () => {
    expect(markdown(arranged(), BLOCK_NAMES)).toBe([
      'Yes, PVT can start: the 72-hour soak passed on Oct 23. [2]',
      '',
      '2 Jira tickets are open',
      '',
      '| Item | Status | Owner | Due |',
      '| --- | --- | --- | --- |',
      '| THERM-52 · Thermal pad supplier [5] | In Progress | Tomas Okafor | 2026-11-04 |',
      '| THERM-55 · Line fixture [6] | To Do | You | 2026-10-30 |',
      '',
      '### Soak test',
      '',
      '- Oct 20, Noor Haddad: Approved the soak plan. [1]',
      '- Oct 23, Noor Haddad: The 72-hour soak passed. [2]',
      '',
      '**Ticket: THERM-48**',
      '',
      '- Status: In review [4]',
      '- Owner: Tomas Okafor [4]',
      '',
      '### Before PVT',
      '',
      '1. Freeze the firmware at 1.4.2. [3]',
      '2. Ship the build to the line. [3]',
      '',
      '### Open risk',
      '',
      'Sensor self-heating is still unexplained, so the soak report keeps it on the PVT watch list. [2]',
      '',
      '> Start PVT once the soak passes. [3]',
      '>',
      '> Noor Haddad, Oct 23 review',
      '',
      ...BLOCK_SOURCES,
    ].join('\n'));
  });

  it('writes points that are not steps as bullets, a table\'s title as its heading, an event no one is named for from its day alone, and a quote with no source as its words', () => {
    const answer = rearranged(blocks => blocks.map(block => {
      if (block.kind === 'points') return { ...block, ordered: false };
      if (block.kind === 'table') return { ...block, title: 'Open tickets' };
      if (block.kind === 'timeline') return { ...block, events: [{ date: '2025-12-30', text: 'Wrote the soak plan.' }, block.events[1]!] };
      return block.kind === 'quote' ? { kind: 'quote', statements: block.statements, text: block.text } : block;
    }));
    const written = markdown(answer, BLOCK_NAMES);
    expect(written).toContain('\n\n### Open tickets\n\n2 Jira tickets are open\n\n| Item |');
    expect(written).toContain('\n\n- Dec 30, 2025: Wrote the soak plan. [1]\n- Oct 23, Noor Haddad: The 72-hour soak passed. [2]\n\n');
    expect(written).toContain('\n\n### Before PVT\n\n- Freeze the firmware at 1.4.2. [3]\n- Ship the build to the line. [3]\n\n');
    expect(written).toContain('\n\n> Start PVT once the soak passes. [3]\n\nSources\n');
  });

  it('leaves out what the page does not show: an item a check left out, a table row, and a block left with nothing to show, with its title', () => {
    // The soak plan, the readiness review, THERM-48 and THERM-55 are not shown: one event and one row go, and the card, the steps and the quote
    // with all they say.
    const hidden = new Set([0, 2, 3, 5]);
    const answer = arranged();
    const written = answerMarkdown(answer, BLOCK_NAMES, sourceGroups(answer.sources), citations => !citations.some(at => hidden.has(at)));
    expect(written).toBe([
      'Yes, PVT can start: the 72-hour soak passed on Oct 23. [2]', '',
      '2 Jira tickets are open', '', '| Item | Status | Owner | Due |', '| --- | --- | --- | --- |',
      '| THERM-52 · Thermal pad supplier [5] | In Progress | Tomas Okafor | 2026-11-04 |', '',
      '### Soak test', '', '- Oct 23, Noor Haddad: The 72-hour soak passed. [2]', '',
      '### Open risk', '', 'Sensor self-heating is still unexplained, so the soak report keeps it on the PVT watch list. [2]', '',
      ...BLOCK_SOURCES,
    ].join('\n'));
  });

  it('keeps a title, a card, a fact and a quote as text: their punctuation escaped, a start that would make a list a sentence again', () => {
    const answer = rearranged(blocks => blocks.map(block => {
      if (block.kind === 'timeline') return { ...block, title: '# Soak *draft*', events: block.events.map(event => ({ ...event, who: 'Noor | QA' })) };
      if (block.kind === 'card') return { ...block, title: 'THERM-48 <b>', facts: [{ label: '1. Owner_1', value: '- Tomas' }, block.facts[1]!] };
      return block.kind === 'quote' ? { ...block, text: 'Start `now`, not [later].', from: 'Noor_H' } : block;
    }));
    const written = markdown(answer, BLOCK_NAMES);
    expect(written).toContain('\n\n### \\# Soak \\*draft\\*\n\n- Oct 20, Noor \\| QA: Approved the soak plan. [1]\n');
    expect(written).toContain('\n\n**Ticket: THERM-48 \\<b\\>**\n\n- 1\\. Owner\\_1: \\- Tomas [4]\n- Owner: Tomas Okafor [4]\n\n');
    expect(written).toContain('\n\n> Start \\`now\\`, not \\[later\\]. [3]\n>\n> Noor\\_H\n\n');
  });
});
