import { describe, expect, it } from 'vitest';
import { describeAgenticEvidenceItemV1, citationOfAgenticEvidenceItemV1 } from '../../src/answer-composition/agentic-evidence-bundle-v1.js';
import { agenticWriterListMemberV1 } from '../../src/answer-composition/agentic-list-evidence-v1.js';
import { record } from './fixtures/agentic-scenarios.js';

const meeting = {
  ...record('night-handoff', 'Approved: use the blue verification phrase.'),
  label: 'Handoff (2026-10-17)',
  list_label: 'Use the blue verification phrase (Handoff, 2026-10-17)',
  // The real desk's legacy date has already lost the timestamp and zone.
  occurred_at: '2026-10-17', date_kind: 'occurred' as const,
  dates: { occurred: '2026-10-17T00:20:00.000Z' },
};

describe('client-local evidence presentation', () => {
  it('converts the actual desk shape consistently without changing the stored record', () => {
    const before = JSON.stringify(meeting);
    const entry = { short: 'E1', source: 'meetings', item: meeting };
    const view = describeAgenticEvidenceItemV1(entry, 'America/Los_Angeles');
    expect(view).toMatchObject({ title: 'Handoff (2026-10-16)', date: '2026-10-16',
      dates: { occurred: '2026-10-16T17:20:00.000-07:00' } });
    expect(view).not.toHaveProperty('calendar_date');
    const row = agenticWriterListMemberV1(entry, true, 'America/Los_Angeles');
    expect(row).toMatchObject({ title: 'Use the blue verification phrase (Handoff, 2026-10-16)',
      date: '2026-10-16', dates: view.dates });
    expect(citationOfAgenticEvidenceItemV1(meeting, 'America/Los_Angeles')).toMatchObject({
      label: 'Handoff (2026-10-16)', citation: meeting.citation,
    });
    expect(JSON.stringify(meeting)).toBe(before);
  });

  it.each([
    ['Asia/Tokyo', '2026-10-17T00:20:00.000Z', '2026-10-17T09:20:00.000+09:00', '2026-10-17'],
    ['Asia/Tokyo', '2026-10-16T23:30:00.000Z', '2026-10-17T08:30:00.000+09:00', '2026-10-17'],
    ['America/Los_Angeles', '2026-03-08T09:59:00.000Z', '2026-03-08T01:59:00.000-08:00', '2026-03-08'],
    ['America/Los_Angeles', '2026-03-08T10:00:00.000Z', '2026-03-08T03:00:00.000-07:00', '2026-03-08'],
    ['America/Los_Angeles', '2026-11-01T09:00:00.000Z', '2026-11-01T01:00:00.000-08:00', '2026-11-01'],
    ['UTC', '2026-10-17T00:20:00.000Z', '2026-10-17T00:20:00.000Z', '2026-10-17'],
  ])('converts %s timestamps, including day and daylight-saving boundaries', (zone, stamp, local, day) => {
    const item = { ...meeting, dates: { occurred: stamp }, occurred_at: stamp.slice(0, 10) };
    const view = describeAgenticEvidenceItemV1({ short: 'E1', source: 'meetings', item }, zone);
    expect(view).toMatchObject({ dates: { occurred: local }, date: day });
    expect(Date.parse(local)).toBe(Date.parse(stamp));
  });

  it('keeps all-day dates and source titles, and does not invent a missing event date', () => {
    const item = { ...meeting, label: 'Handoff planning for 2026-10-17', dates: { occurred: '2026-10-17', due: '2026-10-18' } };
    expect(describeAgenticEvidenceItemV1({ short: 'E1', source: 'meetings', item }, 'America/Los_Angeles'))
      .toMatchObject({ title: item.label, date: '2026-10-17', dates: item.dates });
    const unknown = { ...meeting, occurred_at: undefined, date_kind: undefined, dates: { received: '2026-10-17T00:20:00.000Z' } };
    expect(describeAgenticEvidenceItemV1({ short: 'E1', source: 'meetings', item: unknown }, 'America/Los_Angeles')).not.toHaveProperty('date');
    // Background task renderers have no client time zone and keep their existing projection.
    expect(describeAgenticEvidenceItemV1({ short: 'E1', source: 'meetings', item: meeting })).toMatchObject({
      title: meeting.label, date: meeting.occurred_at, dates: meeting.dates,
    });
  });

  it('uses the timestamp of the same meaning for page revisions and due times', () => {
    const item = { ...meeting, date_kind: 'version_created' as const,
      dates: { created: '2026-10-15', updated: '2026-10-17T00:20:00.000Z', due: '2026-10-18T01:00:00.000Z' },
      attributes: { due_at: '2026-10-18T01:00:00.000Z' } };
    const entry = { short: 'E1', source: 'pages', item };
    const local = { date: '2026-10-16', date_kind: 'version_created',
      dates: { created: '2026-10-15', updated: '2026-10-16T17:20:00.000-07:00', due: '2026-10-17T18:00:00.000-07:00' } };
    expect(describeAgenticEvidenceItemV1(entry, 'America/Los_Angeles')).toMatchObject({ ...local,
      attributes: { due_at: '2026-10-17T18:00:00.000-07:00' } });
    expect(agenticWriterListMemberV1(entry, false, 'America/Los_Angeles')).toMatchObject({ ...local,
      due: '2026-10-17T18:00:00.000-07:00' });
    const invalid = { ...meeting, dates: { occurred: 'not-a-time', created: '2026-02-30' } };
    const view = describeAgenticEvidenceItemV1({ ...entry, item: invalid }, 'America/Los_Angeles');
    expect(view).not.toHaveProperty('dates');
    expect(view).not.toHaveProperty('date');
  });
});
