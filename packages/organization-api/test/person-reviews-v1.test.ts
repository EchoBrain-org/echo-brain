import { describe, expect, it, vi } from 'vitest';
import { personReviewCommandV1, validatePersonReviewRequestV1, validatePersonReviewResultV1 } from '../src/person-reviews-v1.js';
import { validatePersonMeetingRequestV2 } from '../src/person-meetings-v1.js';

const decision = { schema_version: 1, operation: 'review', approval_id: 'apr_123', command_id: 'review-once', snapshot_sha256: `sha256:${'a'.repeat(64)}`,
  action: 'reject', routes: [], owners: [] };
const approval = `apr_${'a'.repeat(64)}`;
const projectA = 'prj_00000000-0000-4000-8000-000000000001';
const projectB = 'prj_00000000-0000-4000-8000-000000000002';
const digest = `sha256:${'b'.repeat(64)}`;
const review = { approval_id: approval, title: 'Pilot planning', project_ids: [projectA], status: 'pending', decided_on: null,
  first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z', all_day: false, records: [] } as const;
const routes = (...destinations: (readonly string[] | null)[]) => destinations.map((project_ids, index) => ({ signal_id: `sig-${index + 1}`, project_ids }));
const request = (value: Record<string, unknown>) => ({ schema_version: 1, operation: 'review', approval_id: approval, command_id: 'review-1', snapshot_sha256: digest,
  action: 'approve', routes: routes([projectA], null, []), owners: [], ...value });
const item = { signal_id: 'decision:sha256:1', kind: 'decision', text: 'Launch the pilot\nnext week.', subject: null, status: 'decided', due_at: null,
  quotes: ['[09:01] Mina: Launch it.\n\nActions'], owner: null, owner_editable: false, project_ids: [projectA] } as const;
const action = { signal_id: 'action:sha256:2', kind: 'action', text: 'Send the plan.', subject: 'THERM-48', status: null, due_at: '2026-10-20T00:00:00.000Z',
  quotes: [], owner: 'Rafael Moreno', owner_editable: true, project_ids: [] } as const;
const opened = (value: Record<string, unknown> = {}) => ({ review, snapshot_sha256: digest, participants: ['Mina Patel'], items: [item, action],
  reasons: [{ signal_id: 'rationale:sha256:3', text: 'The freeze lifts.', supports: ['decision:sha256:1'], quotes: ['It lifts Friday.'] }],
  suggested_projects: [{ project_id: projectA, name: 'Project A' }], records: [], ...value });

describe('person-owned review contract', () => {
  it('accepts review operations without a provider, and only on its own route', () => {
    for (const request of [{ schema_version: 1, operation: 'reviews' }, { schema_version: 1, operation: 'review_open', approval_id: 'apr_123' }, decision]) {
      expect(validatePersonReviewRequestV1(request)).toEqual(request);
      expect(() => validatePersonReviewRequestV1({ ...request, tool_id: 'granola' })).toThrow();
    }
    expect(() => validatePersonReviewRequestV1({ schema_version: 1, operation: 'home' })).toThrow();
    expect(() => validatePersonReviewRequestV1({ schema_version: 2, operation: 'reviews' })).toThrow();
    // The meetings route knows no review operation.
    for (const { schema_version: _version, ...operation } of [{ schema_version: 1, operation: 'reviews' }, { schema_version: 1, operation: 'review_open', approval_id: 'apr_123' }, decision]) {
      expect(() => validatePersonMeetingRequestV2({ ...operation, schema_version: 2, tool_id: 'meeting-fixture' })).toThrow();
    }
  });
  it('keeps the decision field constraints and validates released results', () => {
    for (const invalid of [{ ...decision, command_id: 'bad command' }, { ...decision, action: 'approve' }, { ...decision, owners: [{ signal_id: 'act-1', owner: 'Someone' }] }, { ...decision, snapshot_sha256: 'bad' }]) {
      expect(() => validatePersonReviewRequestV1(invalid)).toThrow();
    }
    expect(validatePersonReviewResultV1('reviews', { reviews: [] })).toEqual({ reviews: [] });
    expect(() => validatePersonReviewResultV1('reviews', { reviews: [], tool_id: 'hidden' })).toThrow();
  });
  it('refuses provider-selected requests before opening a session', () => {
    const withToolSession = vi.fn();
    expect(() => personReviewCommandV1({ withToolSession }, { schema_version: 1, operation: 'reviews', tool_id: 'granola' } as never)).toThrow();
    expect(withToolSession).not.toHaveBeenCalled();
  });

  it.each([
    ['more than twenty project ids in a route', { routes: routes(Array.from({ length: 21 }, (_, index) => `prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)) }],
    ['more than twenty project ids in all', { routes: routes(...Array.from({ length: 21 }, (_, index) => [`prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`])) }],
    ['unsorted project ids', { routes: routes([projectB, projectA]) }],
    ['duplicate project ids', { routes: routes([projectA, projectA]) }],
    ['invalid project id', { routes: routes(['project']) }],
    ['a route without its destination', { routes: [{ signal_id: 'sig-1' }] }],
    ['a route with an extra key', { routes: [{ signal_id: 'sig-1', project_ids: [], share: true }] }],
    ['a route naming no signal', { routes: [{ signal_id: '', project_ids: [] }] }],
    ['a route with an invalid signal', { routes: [{ signal_id: 'sig 1', project_ids: [] }] }],
    ['a signal routed twice', { routes: [{ signal_id: 'sig-1', project_ids: [] }, { signal_id: 'sig-1', project_ids: null }] }],
    ['routes that are not a list', { routes: { 'sig-1': [] } }],
    ['more than 500 routes', { routes: Array.from({ length: 501 }, (_, index) => ({ signal_id: `sig-${index}`, project_ids: [] })) }],
    ['an approval that keeps nothing', { routes: routes(null, null) }],
    ['an approval with no routes', { routes: [] }],
    ['the retired audience', { project_ids: [projectA] }],
    ['the retired transcript choice', { share_transcript: false }],
    ['more than forty owners', { owners: Array.from({ length: 41 }, (_, index) => ({ signal_id: `act-${index}`, owner: 'Rafael Moreno' })) }],
    ['duplicate owner signal ids', { owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }, { signal_id: 'act-1', owner: 'Ada Lovelace' }] }],
    ['empty owner signal id', { owners: [{ signal_id: '', owner: 'Rafael Moreno' }] }],
    ['too long owner signal id', { owners: [{ signal_id: 'a'.repeat(129), owner: 'Rafael Moreno' }] }],
    ['empty owner', { owners: [{ signal_id: 'act-1', owner: '' }] }],
    ['too long owner', { owners: [{ signal_id: 'act-1', owner: 'R'.repeat(121) }] }],
    ['untrimmed owner', { owners: [{ signal_id: 'act-1', owner: ' Rafael Moreno' }] }],
    ['control character owner', { owners: [{ signal_id: 'act-1', owner: 'Rafael\nMoreno' }] }],
    ['format control owner', { owners: [{ signal_id: 'act-1', owner: 'Rafael\u200e Moreno' }] }],
    ['reject with routes', { action: 'reject', routes: routes(null) }],
    ['reject with owners', { action: 'reject', routes: [], owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] }],
    ['a private route with no project (Only me is already private)', { routes: [{ signal_id: 'sig-1', project_ids: [], private: true }] }],
    ['a private route that keeps nothing', { routes: [{ signal_id: 'sig-1', project_ids: null, private: true }, { signal_id: 'sig-2', project_ids: [] }] }],
    ['a route that says private: false', { routes: [{ signal_id: 'sig-1', project_ids: [projectA], private: false }] }],
    ['a route that says private any other way', { routes: [{ signal_id: 'sig-1', project_ids: [projectA], private: 'true' }] }],
  ])('rejects %s', (_name, value) => expect(() => validatePersonReviewRequestV1(request(value))).toThrow());

  it('accepts an item kept private inside its projects, said only as true, beside routes that keep their shape', () => {
    const mixed = [{ signal_id: 'sig-1', project_ids: [projectA, projectB], private: true }, { signal_id: 'sig-2', project_ids: [projectA] }, { signal_id: 'sig-3', project_ids: [] }];
    const validated = validatePersonReviewRequestV1(request({ routes: mixed })) as { readonly routes: readonly object[] };
    expect(validated.routes).toEqual(mixed);
    expect(Object.keys(validated.routes[1]!).sort()).toEqual(['project_ids', 'signal_id']);
  });

  it('accepts mixed destinations with confirmed owners, and a reject with nothing routed', () => {
    const mixed = routes([projectA, projectB], [projectA], null, []);
    expect(validatePersonReviewRequestV1(request({ routes: mixed, owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] })))
      .toMatchObject({ schema_version: 1, routes: mixed, owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] });
    expect(validatePersonReviewRequestV1(request({ action: 'reject', routes: [] }))).toMatchObject({ action: 'reject', routes: [] });
    expect(validatePersonReviewRequestV1(request({ routes: routes(null, []) }))).toMatchObject({ routes: routes(null, []) });
  });

  it('accepts a review_open of items, reasons, names and records, with any line breaks in the meeting\'s words', () => {
    expect(validatePersonReviewResultV1('review_open', opened())).toEqual(opened());
    const records = [{ approval_id: `apr_${'c'.repeat(64)}`, project_ids: [projectA] }, { approval_id: `apr_${'d'.repeat(64)}`, project_ids: [] }];
    expect(validatePersonReviewResultV1('review_open', opened({ review: { ...review, status: 'approved', records }, records })).records).toEqual(records);
    expect(validatePersonReviewResultV1('review_open', opened({ items: [{ ...item, project_ids: null }, { ...action, owner_editable: false }] })).items).toHaveLength(2);
    // A decided item and its record kept private inside a project say so.
    const kept = [{ approval_id: `apr_${'e'.repeat(64)}`, project_ids: [projectA], private: true }, ...records];
    const decided = opened({ review: { ...review, status: 'approved', records: kept }, records: kept, items: [{ ...item, private: true }, { ...action, owner_editable: false }] });
    expect(validatePersonReviewResultV1('review_open', decided)).toEqual(decided);
    expect(validatePersonReviewResultV1('reviews', { reviews: [{ ...review, status: 'approved', records: kept }] }).reviews[0]!.records).toEqual(kept);
  });

  it.each([
    ['the retired proposal text', { content: 'Review' }],
    ['the retired owner proposals', { owners: [] }],
    ['no records', { records: undefined }],
    ['too many suggested projects', { suggested_projects: Array.from({ length: 21 }, () => ({ project_id: projectA, name: 'Project A' })) }],
    ['an item of another kind', { items: [{ ...item, kind: 'rationale' }] }],
    ['a decision without its status', { items: [{ ...item, status: null }] }],
    ['an action with a status', { items: [{ ...action, status: 'decided' }] }],
    ['a decision with a due date', { items: [{ ...item, due_at: '2026-10-20T00:00:00.000Z' }] }],
    ['a due date that is not a timestamp', { items: [{ ...action, due_at: 'Friday' }] }],
    ['an empty text', { items: [{ ...item, text: '' }] }],
    ['an empty quote', { items: [{ ...item, quotes: [''] }] }],
    ['an owner of a decision', { items: [{ ...item, owner: 'Rafael Moreno' }] }],
    ['an editable owner that is not there', { items: [{ ...action, owner: null, owner_editable: true }] }],
    ['an overlong owner', { items: [{ ...action, owner: 'R'.repeat(121) }] }],
    ['an owner on two lines', { items: [{ ...action, owner: 'Rafael\nMoreno' }] }],
    ['an unsorted destination', { items: [{ ...item, project_ids: [projectB, projectA] }] }],
    ['a signal shown twice', { items: [item, item] }],
    ['a reason supporting a non-identifier', { reasons: [{ signal_id: 'rationale:sha256:3', text: 'Why.', supports: ['a b'], quotes: [] }] }],
    ['a record whose id is not apr_*', { review: { ...review, status: 'approved', records: [{ approval_id: 'rec_1', project_ids: [] }] }, records: [{ approval_id: 'rec_1', project_ids: [] }] }],
    ['a record before the approval is published', { review: { ...review, status: 'publishing', records: [{ approval_id: `apr_${'c'.repeat(64)}`, project_ids: [] }] } }],
    ['one record twice', { records: [{ approval_id: `apr_${'c'.repeat(64)}`, project_ids: [] }, { approval_id: `apr_${'c'.repeat(64)}`, project_ids: [projectA] }] }],
    ['a private record in no project', { records: [{ approval_id: `apr_${'c'.repeat(64)}`, project_ids: [], private: true }] }],
    ['a record that says private: false', { records: [{ approval_id: `apr_${'c'.repeat(64)}`, project_ids: [projectA], private: false }] }],
    ['a private item not kept', { items: [{ ...item, project_ids: null, private: true }] }],
    ['a private item kept for Only me', { items: [{ ...item, project_ids: [], private: true }] }],
  ])('rejects review_open response with %s', (_name, value) => {
    const body: Record<string, unknown> = opened(value);
    for (const [key, entry] of Object.entries(value)) if (entry === undefined) delete body[key];
    expect(() => validatePersonReviewResultV1('review_open', body)).toThrow();
  });

  it('requires the review row fields, the whole-day flag and records included', () => {
    expect(() => validatePersonReviewResultV1('reviews', { reviews: [{ approval_id: approval, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null }] })).toThrow();
    expect(() => validatePersonReviewResultV1('reviews', { reviews: [{ approval_id: approval, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null,
      first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z', all_day: false }] })).toThrow();
    expect(() => validatePersonReviewResultV1('reviews', { reviews: [{ approval_id: approval, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null,
      first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z', records: [] }] })).toThrow();
    expect(validatePersonReviewResultV1('reviews', { reviews: [{ approval_id: approval, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null,
      first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z', all_day: false, records: [] }] }).reviews[0]!.action_count).toBe(2);
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
    ['a whole-day flag as text', { all_day: 'true' }],
    ['no whole-day flag', { all_day: null }],
    ['a whole day without its time', { all_day: true, meeting_at: null }],
  ])('rejects a review row with %s, in reviews and review_open', (_name, value) => {
    expect(() => validatePersonReviewResultV1('reviews', { reviews: [{ ...review, ...value }] })).toThrow();
    expect(() => validatePersonReviewResultV1('review_open', opened({ review: { ...review, ...value } }))).toThrow();
  });

  it('accepts a review row without a decision line or meeting time, a whole day, the bounds themselves, and more than 40 actions', () => {
    expect(validatePersonReviewResultV1('reviews', { reviews: [{ ...review, first_line: null, action_count: 0, meeting_at: null },
      { ...review, first_line: 'L'.repeat(300), action_count: 41 }, { ...review, action_count: Number.MAX_SAFE_INTEGER },
      { ...review, meeting_at: '2026-10-21T12:00:00.000Z', all_day: true }] }).reviews).toHaveLength(4);
    expect(() => validatePersonReviewResultV1('review_open', opened({ review: { ...review, first_line: null, action_count: 0, meeting_at: null } }))).not.toThrow();
  });

});
