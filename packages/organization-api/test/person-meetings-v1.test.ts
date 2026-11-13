import { describe, expect, it } from 'vitest';
import { validatePersonMeetingRequestV2, validatePersonMeetingResultV2 } from '../src/person-meetings-v1.js';

const projectA = 'prj_00000000-0000-4000-8000-000000000001';
const digest = `sha256:${'b'.repeat(64)}`;

describe('person meetings v2', () => {
  it('accepts an explicitly retained custom staging meeting', () => {
    const input = { schema_version: 2, tool_id: 'synthetic', operation: 'submit', retain: true, project_id: projectA,
      meeting: { id: 'synthetic-custom-dvt-review', title: 'DVT exception review', notes: '', transcript: 'Decision: begin PVT with DVT still on hold.' } };
    expect(validatePersonMeetingRequestV2(input)).toEqual(input);
  });
  it('refuses manual meeting submission and its receipt while preserving synthetic staging submission', () => {
    const meeting = { title: 'Planning', notes: 'Decide the release date.', transcript: '' };
    expect(() => validatePersonMeetingRequestV2({ schema_version: 2, tool_id: 'hand-in', operation: 'submit', retain: true, project_id: null, meeting })).toThrow();
    expect(() => validatePersonMeetingRequestV2({ schema_version: 2, tool_id: 'hand-in', operation: 'submit', retain: true, project_id: null,
      meeting: { id: 'synthetic-custom-planning', ...meeting } })).toThrow();
    expect(() => validatePersonMeetingResultV2('submit', { status: 'queued', meeting_id: `hand-in-${'a'.repeat(64)}` })).toThrow();
    expect(validatePersonMeetingResultV2('submit', { status: 'queued', meeting_id: 'synthetic-custom-planning' }))
      .toEqual({ status: 'queued', meeting_id: 'synthetic-custom-planning' });
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
