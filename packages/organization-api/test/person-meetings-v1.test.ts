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
  it('accepts an explicitly retained custom staging meeting', () => {
    const input = { schema_version: 2, tool_id: 'synthetic', operation: 'submit', retain: true, project_id: projectA,
      meeting: { id: 'synthetic-custom-dvt-review', title: 'DVT exception review', notes: '', transcript: 'Decision: begin PVT with DVT still on hold.' } };
    expect(validatePersonMeetingRequestV2(input)).toEqual(input);
  });
  it.each([
    { tool_id: 'granola' }, { retain: false }, { retain: undefined }, { project_id: 'invalid' },
    { meeting: { id: 'synthetic-release-canary', title: 'Test', notes: 'Test', transcript: '' } },
    { meeting: { id: 'synthetic-custom-one', title: 'Test', notes: '', transcript: ' ' } },
    { meeting: { id: 'synthetic-custom-one', title: 'Test', notes: 'Test', transcript: '', provenance: {} } },
    { meeting: { id: 'synthetic-custom-one', title: 'Test', notes: '界'.repeat(17000), transcript: '' } },
  ])('refuses unsafe or ambiguous custom submission: %j', overrides => {
    expect(() => validatePersonMeetingRequestV2({ schema_version: 2, tool_id: 'synthetic', operation: 'submit', retain: true, project_id: projectA,
      meeting: { id: 'synthetic-custom-one', title: 'Test', notes: 'Test', transcript: '' }, ...overrides })).toThrow();
  });
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

  const folder = '00000000-0000-4000-8000-000000000011';
  const watch = (value: Record<string, unknown>) => ({ schema_version: 2, tool_id: 'granola', operation: 'watch', watch: 'mine', folder_id: null, project_id: null,
    settings_sha256: digest, retain: true, ...value });
  it.each([
    ['my meetings with no project', {}],
    ['my meetings suggesting a project', { project_id: projectA }],
    ['one folder', { watch: 'folder', folder_id: folder }],
    ['one folder suggesting a project', { watch: 'folder', folder_id: folder, project_id: projectA }],
    ['stopping', { watch: 'off' }],
  ])('accepts a watch of %s', (_name, value) => expect(validatePersonMeetingRequestV2(watch(value))).toEqual(watch(value)));
  it.each([
    ['an unknown watch', { watch: 'everything' }],
    ['no watch', { watch: undefined }],
    ['a folder watch without its folder', { watch: 'folder' }],
    ['a folder outside a folder watch', { folder_id: folder }],
    ['a stop that suggests a project', { watch: 'off', project_id: projectA }],
    ['an invalid suggested project', { project_id: 'project' }],
    ['no retention consent', { retain: false }],
    ['the former folder-and-project shape', { watch: undefined, folder_id: folder, project_id: projectA }],
  ])('refuses a watch with %s', (_name, value) => {
    const input = watch(value) as Record<string, unknown>;
    for (const key of Object.keys(value)) if ((value as Record<string, unknown>)[key] === undefined) delete input[key];
    expect(() => validatePersonMeetingRequestV2(input)).toThrow();
  });
  it('browses the person\'s own recent meetings with no folder, or one folder', () => {
    for (const folder_id of [null, folder]) expect(validatePersonMeetingRequestV2({ schema_version: 2, tool_id: 'granola', operation: 'browse', folder_id })).toMatchObject({ folder_id });
    expect(() => validatePersonMeetingRequestV2({ schema_version: 2, tool_id: 'granola', operation: 'browse' })).toThrow();
    expect(() => validatePersonMeetingRequestV2({ schema_version: 2, tool_id: 'granola', operation: 'browse', folder_id: '' })).toThrow();
  });
  const home = (source: Record<string, unknown>) => ({ connected: true, email: 'maya@example.test', workspace: 'Lumen', folders: [{ id: folder, title: 'Pump', count: 3 }],
    settings_sha256: digest, sources: [{ source_key: 'pms_fixture', watch: 'mine', folder_id: null, project_id: projectA, baseline: true, pending_imports: [], checked_at: null, error: null, ...source }] });
  it('returns each source\'s watch and suggested project on home', () => {
    expect(validatePersonMeetingResultV2('home', home({})).sources[0]).toMatchObject({ watch: 'mine', folder_id: null, project_id: projectA });
    expect(validatePersonMeetingResultV2('home', home({ watch: 'folder', folder_id: folder, project_id: null })).sources[0]).toMatchObject({ watch: 'folder', folder_id: folder });
    expect(validatePersonMeetingResultV2('home', home({ watch: 'off', project_id: null })).sources[0]).toMatchObject({ watch: 'off' });
    for (const source of [{ watch: 'folder' }, { folder_id: folder }, { watch: 'off' }, { watch: 'all' }, { project_id: 'project' }]) {
      expect(() => validatePersonMeetingResultV2('home', home(source))).toThrow();
    }
    const { watch: _watch, ...unwatched } = home({}).sources[0]!;
    expect(() => validatePersonMeetingResultV2('home', { ...home({}), sources: [{ ...unwatched, folder_project_id: projectA }] })).toThrow();
  });
});
