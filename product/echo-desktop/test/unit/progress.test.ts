import { describe, expect, it } from 'vitest';
import type { AnswerSource, AskReceipt } from '../../src/shared/protocol.js';
import {
  ANNOUNCE_MS, announceAfter, announcement, duration, liveRows, listWords, namedPlaces, receiptUnnamed, receiptWords, rowNames, searchedWords, stageWords, startProgress, withStep,
  type AskProgress,
} from '../../src/renderer/progress.js';

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const decision = (atom: string, label = 'Tuesday sync'): AnswerSource =>
  ({ kind: 'record', label, record: { record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' }, atom_id: sha(atom) });
const ticket = (key: string): AnswerSource => ({ kind: 'ticket', tool_id: 'jira', label: key, permalink: `https://example.atlassian.net/browse/${key}` });
const passage = (anchor: string, label = 'Launch plan.md'): AnswerSource => ({ kind: 'original', label, ref: {
  source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha(anchor) } });
/** A place's name as a row shows it: its first item read stands for it, and all of its items read go with it. */
const place = (...items: AnswerSource[]) => ({ source: items[0]!, items });

const steps = (...events: Parameters<typeof withStep>[1][]): AskProgress => events.reduce(withStep, startProgress(0));

describe('the live line and its rows', () => {
  it('say only the stage ECHO is in, and what Ask always said before any step came', () => {
    expect(stageWords(null)).toBe('Thinking…');
    expect(stageWords(startProgress(0))).toBe('Thinking…');
    expect(['searching', 'reading', 'checking_access', 'writing'].map(stage => stageWords(steps({ type: 'stage', stage: stage as 'reading' }))))
      .toEqual(['Searching', 'Reading', 'Checking access', 'Writing']);
  });

  it('merge neighbours of a type as the receipt does, and keep every item read', () => {
    const progress = steps(
      { type: 'searched', sources: [{ kind: 'meetings' }], found: 4 },
      { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'tickets', tool_id: 'jira' }], found: 2 },
      { type: 'stage', stage: 'reading', pending: 4 },
      { type: 'read', items: [decision('1'), ticket('THERM-48')] },
      // The Authority names each citation once: two the page shows alike (two sections of one page) are two items read.
      { type: 'read', items: [ticket('THERM-48'), ticket('THERM-46')] },
    );
    expect(progress.rows).toEqual([
      { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'tickets', tool_id: 'jira' }], found: 6 },
      { type: 'read', items: [decision('1'), ticket('THERM-48'), ticket('THERM-48'), ticket('THERM-46')] },
    ]);
    // Every name the reads promised came.
    expect(progress.pending).toBe(0);
  });

  it('show a read going on while the model reads, done once the stage moves on, and how many are still to be named', () => {
    const reading = steps(
      { type: 'searched', sources: [{ kind: 'meetings' }], found: 22 },
      { type: 'stage', stage: 'reading', pending: 2 },
      { type: 'read', items: [decision('1')] },
    );
    expect(liveRows(reading)).toEqual([
      { type: 'searched', row: reading.rows[0] },
      { type: 'read', row: reading.rows[1], done: true },
      { type: 'pending', count: 1, more: true },
    ]);
    const named = withStep(reading, { type: 'read', items: [ticket('THERM-48')] });
    expect(liveRows(named).at(-1)).toEqual({ type: 'read', row: named.rows[1], done: false });
    const writing = withStep(named, { type: 'stage', stage: 'writing' });
    expect(liveRows(writing).at(-1)).toMatchObject({ type: 'read', done: true });
    // Before any name: "Reading 3 items".
    expect(liveRows(steps({ type: 'stage', stage: 'reading', pending: 3 }))).toEqual([{ type: 'pending', count: 3, more: false }]);
  });

  it('keep three rows: the oldest fold away', () => {
    const progress = steps(
      { type: 'searched', sources: [{ kind: 'meetings' }], found: 1 }, { type: 'read', items: [decision('1')] },
      { type: 'searched', sources: [{ kind: 'documents' }], found: 2 }, { type: 'read', items: [decision('2')] },
      { type: 'stage', stage: 'reading', pending: 4 },
    );
    expect(liveRows(progress).map(row => row.type)).toEqual(['searched', 'read', 'pending']);
  });

  it('name sources as a person says them, never the words searched, and the first names of a read with +N', () => {
    expect(searchedWords({ type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'slack' }, { kind: 'tickets', tool_id: 'jira' }], found: 22 }))
      .toBe('Searched meetings, Slack and Jira · 22 found');
    expect(searchedWords({ type: 'searched', sources: [{ kind: 'pages', tool_id: 'knowledge-base' }], found: 0 })).toBe('Searched Knowledge Base · nothing new');
    expect(searchedWords({ type: 'searched', sources: [{ kind: 'pages', tool_id: 'confluence' }], found: 1 }, [{ tool_id: 'confluence', name: 'Wiki', status: 'linked' }]))
      .toBe('Searched Wiki · 1 found');
    expect(listWords(['meetings', 'documents'])).toBe('meetings and documents');
    const items = [decision('1', 'THERM DVT recovery sync'), ticket('THERM-48'), ticket('THERM-46'), ticket('THERM-44'), ticket('THERM-41')];
    expect(rowNames(items)).toEqual({ names: items.slice(0, 3).map(item => place(item)), more: 2 });
    expect(rowNames(items.slice(0, 2))).toEqual({ names: items.slice(0, 2).map(item => place(item)), more: 0 });
  });

  it('name a place once, with how many of its items were read: two items of one meeting, or two sections of one page, are one name', () => {
    // Two sections of one page come as one link: the host keeps no section.
    const page: AnswerSource = { kind: 'page', tool_id: 'confluence', label: 'Launch plan', permalink: 'https://example.atlassian.net/wiki/x/1' };
    const progress = steps(
      { type: 'stage', stage: 'reading', pending: 5 },
      { type: 'read', items: [decision('1'), decision('2'), page, ticket('THERM-48'), page] },
    );
    // Each item read stays in the row, so its count is the Authority's; its names are its places.
    expect(progress.rows).toEqual([{ type: 'read', items: [decision('1'), decision('2'), page, ticket('THERM-48'), page] }]);
    expect(progress.pending).toBe(0);
    const [row] = progress.rows;
    expect(namedPlaces(row?.type === 'read' ? row.items : [])).toEqual([place(decision('1'), decision('2')), place(page, page), place(ticket('THERM-48'))]);
    // "+N" counts items too: three decisions shown as one name, then one ticket, and two more tickets.
    expect(rowNames([decision('1'), decision('2'), decision('3'), ticket('THERM-48'), ticket('THERM-46'), ticket('THERM-44')], 2))
      .toEqual({ names: [place(decision('1'), decision('2'), decision('3')), place(ticket('THERM-48'))], more: 2 });
    // Reading 7 items of two places: the names account for all seven.
    const seven = [decision('1'), decision('2'), decision('3'), decision('4'), passage('6'), passage('7'), passage('8')];
    expect(rowNames(seven)).toEqual({ names: [place(...seven.slice(0, 4)), place(...seven.slice(4))], more: 0 });
  });
});

describe('the receipt', () => {
  const receipt: AskReceipt = { looked_through: 14, elapsed_ms: 48_400, rows: [
    { type: 'searched', sources: [{ kind: 'meetings' }], found: 9 }, { type: 'read', items: [decision('1'), ticket('THERM-48')] },
  ] };
  it('says how many items it looked through and how long, and how many it does not name', () => {
    expect(receiptWords(receipt)).toBe('Looked through 14 items · 48s');
    expect(receiptWords({ ...receipt, looked_through: 1 })).toBe('Looked through 1 item · 48s');
    expect(receiptUnnamed(receipt)).toBe(12);
    expect(duration(72_000)).toBe('1m 12s');
    expect(duration(400)).toBe('0s');
  });

  it('accounts for every item it looked through: the names\' counts, and those it does not name', () => {
    const read = [decision('1'), decision('2'), decision('3'), decision('4'), passage('6'), passage('7'), passage('8'), ticket('THERM-48'), ticket('THERM-46')];
    const shown: AskReceipt = { looked_through: 9, elapsed_ms: 31_000, rows: [{ type: 'searched', sources: [{ kind: 'meetings' }], found: 9 }, { type: 'read', items: read }] };
    expect(receiptWords(shown)).toBe('Looked through 9 items · 31s');
    expect(namedPlaces(read)).toEqual([place(...read.slice(0, 4)), place(...read.slice(4, 7)), place(ticket('THERM-48')), place(ticket('THERM-46'))]);
    expect(receiptUnnamed(shown)).toBe(0);
    // Past its bound of names, the rest are counted, not named.
    const bounded = { ...shown, looked_through: 14 };
    expect(namedPlaces(read).reduce((total, named) => total + named.items.length, 0) + receiptUnnamed(bounded)).toBe(14);
  });
});

describe('a screen reader hears the stage at most every few seconds', () => {
  it('announces at once the first time, then after the wait, the latest only, and never the same twice', () => {
    expect(announcement(null)).toBe('');
    expect(announcement(steps({ type: 'stage', stage: 'reading', pending: 3 }))).toBe('Reading 3 items');
    expect(announcement(steps({ type: 'stage', stage: 'checking_access' }))).toBe('Checking access');
    expect(announceAfter('Searching', null, 1_000)).toBe(0);
    expect(announceAfter('Reading', { text: 'Searching', at: 1_000 }, 2_000)).toBe(ANNOUNCE_MS - 1_000);
    expect(announceAfter('Reading', { text: 'Searching', at: 1_000 }, 1_000 + ANNOUNCE_MS + 1)).toBe(0);
    expect(announceAfter('Reading', { text: 'Reading', at: 1_000 }, 9_000)).toBeNull();
    expect(announceAfter('', null, 0)).toBeNull();
  });
});
