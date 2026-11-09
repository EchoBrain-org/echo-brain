import { describe, expect, it } from 'vitest';
import type { AnswerSource, AskReceipt } from '../../src/shared/protocol.js';
import {
  ANNOUNCE_MS, announceAfter, announcement, duration, headline, namedPlaces, placeLabel, lookedThrough, startProgress, withStep, type AskProgress,
} from '../../src/renderer/progress.js';

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const decision = (atom: string, label = 'Tuesday sync'): AnswerSource =>
  ({ kind: 'record', label, record: { record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' }, atom_id: sha(atom) });
const ticket = (key: string): AnswerSource => ({ kind: 'ticket', tool_id: 'jira', label: key, permalink: `https://example.atlassian.net/browse/${key}` });
const passage = (anchor: string, label = 'Launch plan.md'): AnswerSource => ({ kind: 'original', label, ref: {
  source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha(anchor) } });
/** A place's name as the line says it: its first item read stands for it, and all of its items read go with it. */
const place = (...items: AnswerSource[]) => ({ source: items[0]!, items });

const steps = (...events: Parameters<typeof withStep>[1][]): AskProgress => events.reduce(withStep, startProgress(0));

describe('the line', () => {
  it('say the stage ECHO is in, and what Ask always said before any step came', () => {
    expect(headline(null)).toBe('Thinking…');
    expect(headline(startProgress(0))).toBe('Thinking…');
    expect(['searching', 'reading', 'checking_access', 'writing'].map(stage => headline(steps({ type: 'stage', stage: stage as 'reading' }))))
      .toEqual(['Searching', 'Reading', 'Checking access', 'Writing the answer']);
  });

  it('while it reads, say how many items before their names come, then the first place of the read and how many other places', () => {
    expect(headline(steps({ type: 'stage', stage: 'reading', pending: 3 }))).toBe('Reading 3 items');
    expect(headline(steps({ type: 'stage', stage: 'reading', pending: 1 }))).toBe('Reading 1 item');
    // Two decisions of one meeting are one place, as the row names them: two other places.
    const reading = steps({ type: 'searched' }, { type: 'stage', stage: 'reading', pending: 4 },
      { type: 'read', items: [decision('1'), decision('2'), ticket('THERM-48'), passage('6')] });
    expect(headline(reading)).toBe('Reading Tuesday sync and 2 more');
    // A file is named as a person says it, and a read of one place names it alone.
    expect(headline(steps({ type: 'stage', stage: 'reading', pending: 2 }, { type: 'read', items: [passage('6'), passage('7')] }))).toBe('Reading Launch plan');
    // The names came for a read before the search after it: nothing to name yet.
    expect(headline(withStep(withStep(reading, { type: 'searched' }), { type: 'stage', stage: 'reading' }))).toBe('Reading');
    expect(placeLabel(passage('6', 'launch_plan_v2.md'))).toBe('launch plan');
    expect(placeLabel(decision('1'))).toBe('Tuesday sync');
    // Your project, and a Jira project, are places of their own, named by their labels (research tool contract v1).
    const project: AnswerSource = { kind: 'project', label: 'Thermal recovery', project_id: 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' };
    const jira: AnswerSource = { kind: 'container', tool_id: 'jira', label: 'Thermal', permalink: 'https://example.atlassian.net/browse/THERM', container: 'jira_project', key: 'THERM' };
    expect(headline(steps({ type: 'stage', stage: 'reading', pending: 2 }, { type: 'read', items: [project, jira] }))).toBe('Reading Thermal recovery and 1 more');
  });

  it('keep every item read since the last search, and start over at the next search', () => {
    const progress = steps(
      { type: 'searched' },
      { type: 'stage', stage: 'reading', pending: 4 },
      { type: 'read', items: [decision('1'), ticket('THERM-48')] },
      // The Authority names each citation once: two the page shows alike (two sections of one page) are two items read.
      { type: 'read', items: [ticket('THERM-48'), ticket('THERM-46')] },
    );
    expect(progress.read).toEqual([decision('1'), ticket('THERM-48'), ticket('THERM-48'), ticket('THERM-46')]);
    // Every name the reads promised came.
    expect(progress.pending).toBe(0);
    // A stage keeps them; a search starts the names over, and a read with no items names nothing new.
    expect(withStep(progress, { type: 'stage', stage: 'checking_access' }).read).toEqual(progress.read);
    const searched = withStep(progress, { type: 'searched' });
    expect(searched.read).toEqual([]);
    expect(withStep(searched, { type: 'read', items: [] }).read).toEqual([]);
  });

  it('name a place once, with how many of its items were read: two items of one meeting, or two sections of one page, are one name', () => {
    // Two sections of one page come as one link: the host keeps no section.
    const page: AnswerSource = { kind: 'page', tool_id: 'confluence', label: 'Launch plan', permalink: 'https://example.atlassian.net/wiki/x/1' };
    const progress = steps(
      { type: 'stage', stage: 'reading', pending: 5 },
      { type: 'read', items: [decision('1'), decision('2'), page, ticket('THERM-48'), page] },
    );
    // Each item read stays, so its count is the Authority's; its names are its places.
    expect(progress.read).toEqual([decision('1'), decision('2'), page, ticket('THERM-48'), page]);
    expect(progress.pending).toBe(0);
    expect(namedPlaces(progress.read)).toEqual([place(decision('1'), decision('2')), place(page, page), place(ticket('THERM-48'))]);
    // Reading 7 items of two places: the names account for all seven.
    const seven = [decision('1'), decision('2'), decision('3'), decision('4'), passage('6'), passage('7'), passage('8')];
    expect(namedPlaces(seven)).toEqual([place(...seven.slice(0, 4)), place(...seven.slice(4))]);
  });
});

describe('the receipt', () => {
  const receipt: AskReceipt = { looked_through: 14 };
  it('says how many items it looked through and how long the person waited', () => {
    // The wait is the page's own, as its timer counted it, not the Authority's shorter research time.
    expect(lookedThrough(receipt)).toBe('Looked through 14 items');
    expect(lookedThrough({ ...receipt, looked_through: 1 })).toBe('Looked through 1 item');
    expect(duration(52_900)).toBe('52s');
    expect(duration(72_400)).toBe('1m 12s');
    // As the live timer shows it: whole seconds gone.
    expect(duration(72_000)).toBe('1m 12s');
    expect(duration(33_900)).toBe('33s');
    expect(duration(400)).toBe('0s');
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
