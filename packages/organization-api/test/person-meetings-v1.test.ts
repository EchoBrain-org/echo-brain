import { describe, expect, it } from 'vitest';
import { validatePersonMeetingRequestV2, validatePersonMeetingResultV2 } from '../src/person-meetings-v1.js';

const approval = `apr_${'a'.repeat(64)}`;
const projectA = 'prj_00000000-0000-4000-8000-000000000001';
const projectB = 'prj_00000000-0000-4000-8000-000000000002';
const digest = `sha256:${'b'.repeat(64)}`;
const review = { approval_id: approval, title: 'Pilot planning', project_ids: [projectA], status: 'pending', decided_on: null,
  first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z' } as const;
const request = (value: Record<string, unknown>) => ({ schema_version: 2, tool_id: 'granola', operation: 'review', approval_id: approval, command_id: 'review-1', snapshot_sha256: digest,
  action: 'approve', project_ids: [projectA], share_transcript: false, owners: [], ...value });

describe('person meetings v2', () => {
  it.each([
    ['more than twenty project ids', { project_ids: Array.from({ length: 21 }, (_, index) => `prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`) }],
    ['unsorted project ids', { project_ids: [projectB, projectA] }],
    ['duplicate project ids', { project_ids: [projectA, projectA] }],
    ['invalid project id', { project_ids: ['project'] }],
    ['more than forty owners', { owners: Array.from({ length: 41 }, (_, index) => ({ signal_id: `act-${index}`, owner: 'Rafael Moreno' })) }],
    ['duplicate owner signal ids', { owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }, { signal_id: 'act-1', owner: 'Ada Lovelace' }] }],
    ['empty owner signal id', { owners: [{ signal_id: '', owner: 'Rafael Moreno' }] }],
    ['too long owner signal id', { owners: [{ signal_id: 'a'.repeat(129), owner: 'Rafael Moreno' }] }],
    ['empty owner', { owners: [{ signal_id: 'act-1', owner: '' }] }],
    ['too long owner', { owners: [{ signal_id: 'act-1', owner: 'R'.repeat(121) }] }],
    ['untrimmed owner', { owners: [{ signal_id: 'act-1', owner: ' Rafael Moreno' }] }],
    ['control character owner', { owners: [{ signal_id: 'act-1', owner: 'Rafael\nMoreno' }] }],
    ['format control owner', { owners: [{ signal_id: 'act-1', owner: 'Rafael\u200e Moreno' }] }],
    ['reject with projects', { action: 'reject', project_ids: [projectA] }],
    ['reject sharing transcript', { action: 'reject', project_ids: [], share_transcript: true }],
    ['reject with owners', { action: 'reject', project_ids: [], owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] }],
  ])('rejects %s', (_name, value) => expect(() => validatePersonMeetingRequestV2(request(value))).toThrow());

  it('accepts a sorted multi-project approval with confirmed owners', () => {
    expect(validatePersonMeetingRequestV2(request({ project_ids: [projectA, projectB], owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] })))
      .toMatchObject({ schema_version: 2, project_ids: [projectA, projectB], owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] });
  });

  it.each([
    ['too many suggested projects', { review, snapshot_sha256: digest, content: 'Review', owners: [], suggested_projects: Array.from({ length: 21 }, () => ({ project_id: projectA, name: 'Project A' })) }],
    ['too many owner proposals', { review, snapshot_sha256: digest, content: 'Review', suggested_projects: [], owners: Array.from({ length: 41 }, (_, index) => ({ signal_id: `act-${index}`, action: 'Act', proposed: 'Rafael Moreno' })) }],
    ['an overlong owner proposal line', { review, snapshot_sha256: digest, content: 'Review', suggested_projects: [], owners: [{ signal_id: 'act-1', action: 'A'.repeat(301), proposed: 'Rafael Moreno' }] }],
    ['an overlong proposed owner result', { review, snapshot_sha256: digest, content: 'Review', suggested_projects: [], owners: [{ signal_id: 'act-1', action: 'Act', proposed: 'R'.repeat(301) }] }],
  ])('rejects review_open response with %s', (_name, value) => expect(() => validatePersonMeetingResultV2('review_open', value)).toThrow());

  it('allows independently bounded owner proposal lines', () => {
    expect(validatePersonMeetingResultV2('review_open', { review, snapshot_sha256: digest, content: 'Review', suggested_projects: [],
      owners: [{ signal_id: 'act-1', action: 'A'.repeat(300), proposed: 'R'.repeat(300) }] })).toMatchObject({ owners: [{ signal_id: 'act-1' }] });
  });

  it('requires the three new review fields', () => {
    expect(() => validatePersonMeetingResultV2('reviews', { reviews: [{ approval_id: approval, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null }] })).toThrow();
    expect(validatePersonMeetingResultV2('reviews', { reviews: [{ approval_id: approval, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null,
      first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z' }] }).reviews[0]!.action_count).toBe(2);
  });

  it.each([
    ['an empty first line', { first_line: '' }],
    ['a first line over 300 characters', { first_line: 'L'.repeat(301) }],
    ['a first line of two lines', { first_line: 'Launch the pilot.\nNext week.' }],
    ['a negative action count', { action_count: -1 }],
    ['an action count past the safe integers', { action_count: 2 ** 53 }],
    ['a fractional action count', { action_count: 1.5 }],
    ['an action count as text', { action_count: '2' }],
    ['a meeting time that is not a timestamp', { meeting_at: 'Oct 6' }],
    ['a meeting time without milliseconds', { meeting_at: '2026-10-06T16:00:00Z' }],
  ])('rejects a review row with %s, in reviews and review_open', (_name, value) => {
    expect(() => validatePersonMeetingResultV2('reviews', { reviews: [{ ...review, ...value }] })).toThrow();
    expect(() => validatePersonMeetingResultV2('review_open', { review: { ...review, ...value }, snapshot_sha256: digest, content: 'Review', owners: [], suggested_projects: [] })).toThrow();
  });

  it('accepts a review row without a decision line or meeting time, the bounds themselves, and more than 40 actions', () => {
    expect(validatePersonMeetingResultV2('reviews', { reviews: [{ ...review, first_line: null, action_count: 0, meeting_at: null },
      { ...review, first_line: 'L'.repeat(300), action_count: 41 }, { ...review, action_count: Number.MAX_SAFE_INTEGER }] }).reviews).toHaveLength(3);
    expect(() => validatePersonMeetingResultV2('review_open', { review: { ...review, first_line: null, action_count: 0, meeting_at: null }, snapshot_sha256: digest,
      content: 'Review', owners: [], suggested_projects: [] })).not.toThrow();
  });
});
