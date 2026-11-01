import { Buffer } from 'node:buffer';
import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  PERSON_LIST_PATH_V1,
  PERSON_LIST_RESPONSE_MAX_BYTES_V1,
  PERSON_OPEN_ATOMS_BUDGET_BYTES_V1,
  PERSON_OPEN_PATH_V1,
  PERSON_OPEN_RESPONSE_MAX_BYTES_V1,
  personRefIdV1,
  personRefKindV1,
  validatePersonAnswerScopeV3,
  validatePersonItemRefV1,
  validatePersonListRequestV1,
  validatePersonListResponseV1,
  validatePersonOpenRequestV1,
  validatePersonOpenResponseV1,
} from '../src/index.js';

// Valid fields cannot reach the list byte bound (see the worst-case page
// below), so one test stubs the byte count to prove the check still runs.
vi.mock('@echo-brain/federation-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-brain/federation-protocol')>();
  return { ...actual, canonicalJsonBytes: vi.fn(actual.canonicalJsonBytes) };
});

const PROJECT_A = 'prj_00000000-0000-4000-8000-000000000001';
const PROJECT_B = 'prj_00000000-0000-4000-8000-000000000002';
const projectId = (index: number) => `prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const hex = (index: number) => index.toString(16).padStart(64, '0');
const NOTE = `note:ctx_${'a'.repeat(64)}`;
const IMPORTED = `imported_meeting:cap_${'d'.repeat(64)}`;
const DOCUMENT = `document:doc_${'b'.repeat(64)}`;
const MEETING = `meeting:sha256:${'c'.repeat(64)}`;
/** The retired transcript ref (ADR-0046): no list, open or Ask contract accepts it. */
const TRANSCRIPT = `transcript:sha256:${'c'.repeat(64)}`;

const noteRow = { ref: NOTE, kind: 'note', title: 'Pricing notes', added_at: '2026-09-21T22:00:00.000Z', visibility: 'only_me', projects: [] };
const importedRow = { ref: IMPORTED, kind: 'imported_meeting', title: 'Imported meeting (unapproved): Pricing review', added_at: '2026-09-21T22:00:00.000Z', visibility: 'only_me', projects: [] };
const documentRow = {
  ref: DOCUMENT, kind: 'document', title: 'Pricing memo', added_at: '2026-09-21T21:30:00.000Z', visibility: 'project',
  projects: [{ project_id: PROJECT_A, name: 'Apollo' }], media_type: 'application/pdf', extraction_state: 'ready', size_bytes: 1_245_184,
};
const meetingRow = { ref: MEETING, kind: 'meeting', title: 'Pricing review', added_at: '2026-09-21T18:00:00.000Z', visibility: 'team', projects: [], meeting_date: '2026-09-21' };
const page = (fields: Record<string, unknown> = {}) => ({
  schema_version: 1, kind: 'echo-person-list-v1', scope: { kind: 'only_me' }, items: [noteRow, documentRow, meetingRow], next_cursor: null, ...fields,
});
const withRow = (index: number, fields: Record<string, unknown>) =>
  page({ items: [noteRow, documentRow, meetingRow].map((row, at) => (at === index ? { ...row, ...fields } : row)) });
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const noteRows = (count: number) => Array.from({ length: count }, (_, index) => ({ ...noteRow, ref: `note:ctx_${hex(index)}` }));

const NEVER_FIELDS = [
  'text', 'excerpt', 'excerpts', 'author', 'uploader', 'approver', 'approved_by', 'request_id', 'sha256', 'original_sha256',
  'position', 'log_position', 'record_position', 'count', 'total', 'audience', 'audience_project_ids', 'association_project_ids',
  'project_id', 'policy_id', 'approval_id',
];

const openNote = { schema_version: 1, kind: 'echo-person-open-v1', ref: NOTE, item: noteRow, text: 'Annual plans first.\n', next_cursor: null };
const openImportedMeeting = { schema_version: 1, kind: 'echo-person-open-v1', ref: IMPORTED, item: importedRow, text: '', next_cursor: null };
const openDocument = {
  schema_version: 1, kind: 'echo-person-open-v1', ref: DOCUMENT, item: documentRow, filename: 'pricing-memo.pdf',
  chunks: [{ anchor: { kind: 'page', start: 1 }, text: 'Pricing memo\n' }], next_cursor: 'AnR3',
};
const meetingDetail = { started_at: '2026-09-21T20:00:00.000Z', timezone: 'America/Los_Angeles', all_day: false, participants: ['Ari', 'Maya Chen'], participants_more: false, approved_by: 'Ari' };
/** An undefined field is left out, so a test can drop a default key. */
const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
const openMeeting = (fields: Record<string, unknown> = {}) => defined({
  schema_version: 1, kind: 'echo-person-open-v1', ref: MEETING, item: meetingRow, meeting: meetingDetail,
  atoms: [
    { kind: 'decision', text: 'Annual plans first.', status: 'decided' },
    { kind: 'action', text: 'Draft the ', owner: 'Maya Chen', due_at: '2026-10-01', part: { index: 1, count: 2 } },
    { kind: 'action', text: 'pricing page.', part: { index: 2, count: 2 } },
  ],
  next_cursor: null, ...fields,
});
const withAtom = (fields: Record<string, unknown>) => openMeeting({ atoms: [fields] });
const openTranscript = { schema_version: 1, kind: 'echo-person-open-v1', ref: TRANSCRIPT, text: 'Ari: annual first.', next_cursor: 'AAA' };

describe('Person list and open public contracts', () => {
  it('names the model-free routes', () => {
    expect(PERSON_LIST_PATH_V1).toBe('/v1/person/list');
    expect(PERSON_OPEN_PATH_V1).toBe('/v1/person/open');
  });

  it('accepts exactly one scope, a project or only_me, and an opaque cursor, and nothing else', () => {
    for (const request of [
      { schema_version: 1, project_id: PROJECT_A }, { schema_version: 1, only_me: true },
      { schema_version: 1, project_id: PROJECT_A, cursor: 'A'.repeat(512) }, { schema_version: 1, only_me: true, cursor: 'AnR3_-9' },
    ]) expect(validatePersonListRequestV1(request)).toEqual(request);
    // No scope was the retired global list: a request names its project or only_me.
    for (const request of [{ schema_version: 1 }, { schema_version: 1, cursor: 'AnR3_-9' }, { schema_version: 1, only_me: true, project_id: PROJECT_A }]) {
      expect(() => validatePersonListRequestV1(request)).toThrow('Person list request scope is invalid');
    }
    for (const request of [
      // The retired mine scope, alone or with another.
      { schema_version: 1, mine: true }, { schema_version: 1, mine: true, cursor: 'A'.repeat(512) },
      { schema_version: 1, project_id: PROJECT_A, mine: true }, { schema_version: 1, only_me: true, mine: true },
      { schema_version: 1, only_me: true, mine: true, project_id: PROJECT_A },
      { schema_version: 1, only_me: false }, { schema_version: 1, only_me: 'true' }, { schema_version: 1, onlyMe: true },
      { schema_version: 1, only_me: true, kind: 'note' }, { schema_version: 1, only_me: true, limit: 25 }, { schema_version: 1, only_me: true, query: 'pricing' },
      { schema_version: 1, only_me: true, since: '2026-09-01' }, { schema_version: 1, scope: { kind: 'global' } }, { schema_version: 1, scope: { kind: 'only_me' } },
      { schema_version: 1, only_me: true, cursor: '' }, { schema_version: 1, only_me: true, cursor: 'A'.repeat(513) },
      { schema_version: 1, only_me: true, cursor: 'AnR3=' }, { schema_version: 1, project_id: PROJECT_A, cursor: 'An+R3' }, { schema_version: 1, project_id: PROJECT_A, cursor: 'An/R3' },
      { schema_version: 2, only_me: true }, { schema_version: 1, project_id: 'prj_not-a-project' },
    ]) expect(() => validatePersonListRequestV1(request)).toThrow();
  });

  it('parses the ref grammars and refuses every near miss', () => {
    for (const ref of [NOTE, IMPORTED, DOCUMENT, MEETING]) expect(validatePersonItemRefV1(ref)).toBe(ref);
    expect([NOTE, IMPORTED, DOCUMENT, MEETING].map((ref) => personRefKindV1(ref as never))).toEqual(['note', 'imported_meeting', 'document', 'meeting']);
    expect(personRefIdV1(NOTE as never)).toBe(`ctx_${'a'.repeat(64)}`);
    expect(personRefIdV1(MEETING as never)).toBe(`sha256:${'c'.repeat(64)}`);
    for (const ref of [
      `note:ctx_${'A'.repeat(64)}`, `document:doc_${'b'.repeat(63)}`, `meeting:sha256:${'c'.repeat(65)}`, TRANSCRIPT,
      `record:sha256:${'c'.repeat(64)}`, `ctx_${'a'.repeat(64)}`, ` ${NOTE}`, `${MEETING} `, `${DOCUMENT}\n`, 42, null,
    ]) expect(() => validatePersonItemRefV1(ref)).toThrow();
    expect(validatePersonOpenRequestV1({ schema_version: 1, ref: DOCUMENT, cursor: 'AnR3' })).toEqual({ schema_version: 1, ref: DOCUMENT, cursor: 'AnR3' });
    for (const request of [
      { schema_version: 1, ref: TRANSCRIPT },
      { schema_version: 1, ref: NOTE, cursor: 'AnR3' }, { schema_version: 1, ref: MEETING, scope: { kind: 'global' } },
      { schema_version: 1, ref: MEETING, project_id: PROJECT_A }, { schema_version: 1, ref: MEETING, mine: true },
      { schema_version: 1, ref: MEETING, cursor: 'An=' }, { schema_version: 2, ref: MEETING },
    ]) expect(() => validatePersonOpenRequestV1(request)).toThrow();
  });

  it('carries the project header on a project page only, and has no global or mine page', () => {
    const project = { project_id: PROJECT_A, name: 'Apollo', role: 'lead', status: 'active' };
    expect(validatePersonListResponseV1(page({ scope: { kind: 'project', project_id: PROJECT_A }, project })).project).toEqual(project);
    expect(validatePersonListResponseV1(page({ scope: { kind: 'project', project_id: PROJECT_A } }))).not.toHaveProperty('project');
    expect(() => validatePersonListResponseV1(page({ scope: { kind: 'project', project_id: PROJECT_B }, project }))).toThrow('inconsistent');
    expect(() => validatePersonListResponseV1(page({ scope: { kind: 'only_me' }, project }))).toThrow('header is invalid');
    // The retired global and mine scopes, and the global page's me, connected and projects header, are refused on every page.
    for (const scope of [{ kind: 'global' }, { kind: 'mine' }, { kind: 'mine', project_id: PROJECT_A }]) {
      expect(() => validatePersonListResponseV1(page({ scope }))).toThrow('Person list scope is invalid');
    }
    const retired = { me: { display_name: 'Maya Chen', membership_type: 'employee' }, connected: [{ tool: 'slack', status: 'linked' }], projects: [project], projects_more: false };
    for (const scope of [{ kind: 'only_me' }, { kind: 'project', project_id: PROJECT_A }]) {
      expect(() => validatePersonListResponseV1(page({ scope, ...retired }))).toThrow('unexpected shape');
      for (const [key, value] of Object.entries(retired)) expect(() => validatePersonListResponseV1(page({ scope, [key]: value }))).toThrow('unexpected shape');
    }
  });

  it('echoes only_me, a scope the list alone takes, exactly (ADR-0049)', () => {
    expect(validatePersonListResponseV1(page({ scope: { kind: 'only_me' }, next_cursor: 'AnR3' })).scope).toEqual({ kind: 'only_me' });
    for (const scope of [{ kind: 'only_me', project_id: PROJECT_A }, { kind: 'only_me', mine: true }, { kind: 'only-me' }, { kind: 'onlyMe' }, 'only_me', null]) {
      expect(() => validatePersonListResponseV1(page({ scope }))).toThrow('Person list scope');
    }
    // Ask's scope is unchanged: it never takes only_me.
    expect(() => validatePersonAnswerScopeV3({ kind: 'only_me' })).toThrow();
  });

  it('validates rows exactly, newest first, with the three-token visibility', () => {
    const accepted = validatePersonListResponseV1(page({ next_cursor: 'AnR3', notice: 'meetings_unavailable' }));
    expect(accepted.items.map((item) => item.kind)).toEqual(['note', 'document', 'meeting']);
    expect(accepted.notice).toBe('meetings_unavailable');
    expect(validatePersonListResponseV1(page({ items: noteRows(25) })).items).toHaveLength(25);
    expect(() => validatePersonListResponseV1(page({ items: noteRows(26) }))).toThrow('items is invalid');
    expect(() => validatePersonListResponseV1(page({ items: [noteRow, noteRow] }))).toThrow('duplicates');
    expect(() => validatePersonListResponseV1(page({ items: [noteRow, documentRow, { ...noteRow, added_at: '2026-09-21T01:00:00.000Z' }] }))).toThrow('duplicates');
    expect(() => validatePersonListResponseV1(page({ items: [meetingRow, noteRow] }))).toThrow('out of order');
    const tie = noteRows(2).map((row) => ({ ...row, added_at: '2026-09-21T22:00:00.000Z' }));
    expect(validatePersonListResponseV1(page({ items: tie })).items).toHaveLength(2);
    expect(() => validatePersonListResponseV1(page({ items: tie.reverse() }))).toThrow('out of order');
    for (const visibility of ['projects', 'approver_only', 'everyone']) expect(() => validatePersonListResponseV1(withRow(0, { visibility }))).toThrow('visibility');
    const rowProjects = (count: number) => Array.from({ length: count }, (_, index) => ({ project_id: projectId(index + 1), name: `Project ${index}` }));
    expect(validatePersonListResponseV1(withRow(1, { projects: rowProjects(20) })).items[1]!.projects).toHaveLength(20);
    expect(() => validatePersonListResponseV1(withRow(1, { projects: rowProjects(21) }))).toThrow('projects is invalid');
    expect(() => validatePersonListResponseV1(withRow(1, { projects: [...rowProjects(1), ...rowProjects(1)] }))).toThrow('duplicates');
    expect(() => validatePersonListResponseV1(withRow(1, { projects: [{ project_id: PROJECT_A, name: 'Apollo', role: 'lead' }] }))).toThrow();
    expect(() => validatePersonListResponseV1(withRow(0, { kind: 'document' }))).toThrow('inconsistent');
    expect(() => validatePersonListResponseV1(withRow(2, { ref: NOTE }))).toThrow('inconsistent');
    for (const [index, fields] of [
      [0, { media_type: 'application/pdf', extraction_state: 'ready', size_bytes: 1 }], [2, { media_type: 'application/pdf' }],
      [1, { meeting_date: '2026-09-21' }], [0, { meeting_date: '2026-09-21' }],
    ] as const) expect(() => validatePersonListResponseV1(withRow(index, fields))).toThrow('unexpected shape');
    expect(() => validatePersonListResponseV1(withRow(1, { size_bytes: 0 }))).toThrow('size_bytes');
    expect(() => validatePersonListResponseV1(withRow(1, { media_type: 'application/msword' }))).toThrow('media_type');
    expect(() => validatePersonListResponseV1(withRow(1, { extraction_state: 'queued' }))).toThrow('extraction_state');
    // Every media type and extraction state the documents contract names is a valid row.
    for (const media_type of ['text/plain', 'text/markdown', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
      expect(validatePersonListResponseV1(withRow(1, { media_type })).items[1]).toMatchObject({ media_type });
    }
    for (const extraction_state of ['extracting', 'ready', 'partial', 'no_text', 'encrypted', 'malformed', 'limit_exceeded', 'timed_out', 'unsupported', 'unavailable']) {
      expect(validatePersonListResponseV1(withRow(1, { extraction_state })).items[1]).toMatchObject({ extraction_state });
    }
    expect(validatePersonListResponseV1(page({ items: [without(meetingRow, 'meeting_date')] })).items[0]).not.toHaveProperty('meeting_date');
    for (const meeting_date of ['2026-02-30', '2026-13-01', '2026-9-21', '2026-09-21T00:00:00.000Z']) {
      expect(() => validatePersonListResponseV1(withRow(2, { meeting_date }))).toThrow('meeting_date');
    }
    expect(validatePersonListResponseV1(withRow(0, { title: 'é'.repeat(100) })).items[0]!.title).toBe('é'.repeat(100));
    for (const title of ['é'.repeat(100) + 'x', 'Two\nlines', ' Leading', 'Trailing ', 'e\u0301', 'Split\u2028line', 'Bell\u0007', '\uD800', '']) {
      expect(() => validatePersonListResponseV1(withRow(0, { title }))).toThrow('title');
    }
    expect(() => validatePersonListResponseV1(withRow(0, { projects_more: false }))).toThrow('unexpected shape');
    for (const added_at of ['2026-09-21T22:00:00Z', '2026-09-21T22:00:00.000+00:00', '2026-09-21 22:00:00.000Z', '2026-02-30T22:00:00.000Z']) {
      expect(() => validatePersonListResponseV1(withRow(0, { added_at }))).toThrow('added_at');
    }
    for (const notice of ['Meetings are catching up.', 'meetings_held', null]) expect(() => validatePersonListResponseV1(page({ notice }))).toThrow('notice');
    expect(() => validatePersonListResponseV1(page({ next_cursor: 'An=' }))).toThrow('next_cursor');
  });

  it('accepts any project name and document filename that the existing project and upload rules accept', () => {
    // Project create/rename and document upload allow these; refusing them would fail whole pages.
    const name = 'Apollo\u2028Beta';
    expect(validatePersonListResponseV1(withRow(1, { projects: [{ project_id: PROJECT_A, name }] })).items[1]!.projects[0]!.name).toBe(name);
    expect(validatePersonListResponseV1(page({ scope: { kind: 'project', project_id: PROJECT_A }, project: { project_id: PROJECT_A, name, role: 'member', status: 'active' } })).project!.name).toBe(name);
    for (const bad of [' Apollo', 'Apollo\n', 'A'.repeat(201)]) {
      expect(() => validatePersonListResponseV1(withRow(1, { projects: [{ project_id: PROJECT_A, name: bad }] }))).toThrow('name');
    }
    for (const filename of [' memo.pdf', 'memo.pdf ', 'memo\u2028v2.pdf']) {
      expect(validatePersonOpenResponseV1({ ...openDocument, filename })).toMatchObject({ filename });
    }
    for (const filename of ['../memo.pdf', 'a\\memo.pdf', '.', '..', 'memo\n.pdf', 'e\u0301.pdf', `${'m'.repeat(252)}.pdf`, '']) {
      expect(() => validatePersonOpenResponseV1({ ...openDocument, filename })).toThrow('filename');
    }
  });

  it('rejects every never-released field on a row, an open item, and the page', () => {
    for (const key of NEVER_FIELDS) {
      for (const index of [0, 1, 2]) expect(() => validatePersonListResponseV1(withRow(index, { [key]: 'x' }))).toThrow('unexpected shape');
      expect(() => validatePersonOpenResponseV1({ ...openNote, item: { ...noteRow, [key]: 'x' } })).toThrow('unexpected shape');
      expect(() => validatePersonOpenResponseV1({ ...openDocument, item: { ...documentRow, [key]: 'x' } })).toThrow('unexpected shape');
      expect(() => validatePersonOpenResponseV1(openMeeting({ item: { ...meetingRow, [key]: 'x' } }))).toThrow('unexpected shape');
    }
    for (const key of ['count', 'total', 'position', 'generation_id']) {
      expect(() => validatePersonListResponseV1(page({ [key]: 0 }))).toThrow('unexpected shape');
      expect(() => validatePersonOpenResponseV1({ ...openNote, [key]: 0 })).toThrow('unexpected shape');
      expect(() => validatePersonOpenResponseV1(openMeeting({ [key]: 0 }))).toThrow('unexpected shape');
    }
    for (const key of ['excerpts', 'evidence', 'title', 'participant_ids']) {
      expect(() => validatePersonOpenResponseV1(openMeeting({ meeting: { ...meetingDetail, [key]: [] } }))).toThrow('unexpected shape');
    }
    expect(() => validatePersonOpenResponseV1(withAtom({ kind: 'decision', text: 'Annual first.', excerpts: [] }))).toThrow('unexpected shape');
  });

  it('opens a note whole and bounded', () => {
    expect(validatePersonOpenResponseV1(openNote)).toEqual(openNote);
    expect(validatePersonOpenResponseV1({ ...openNote, text: 'x'.repeat(8 * 1024) })).toHaveProperty('text');
    expect(() => validatePersonOpenResponseV1({ ...openNote, text: 'x'.repeat(8 * 1024 + 1) })).toThrow('text');
    expect(() => validatePersonOpenResponseV1({ ...openNote, text: 'Form\ffeed' })).toThrow('text');
    expect(() => validatePersonOpenResponseV1({ ...openNote, next_cursor: 'AnR3' })).toThrow('next_cursor');
    expect(() => validatePersonOpenResponseV1({ ...openNote, item: { ...noteRow, ref: `note:ctx_${'d'.repeat(64)}` } })).toThrow('inconsistent');
    expect(() => validatePersonOpenResponseV1({ ...openNote, item: documentRow })).toThrow('inconsistent');
  });

  it('opens a transcript-only imported meeting with an empty notes representation', () => {
    expect(validatePersonOpenResponseV1(openImportedMeeting)).toEqual(openImportedMeeting);
    expect(() => validatePersonOpenResponseV1({ ...openImportedMeeting, item: noteRow })).toThrow('inconsistent');
    expect(() => validatePersonOpenResponseV1({ ...openNote, text: '' })).toThrow('text');
  });

  it('opens a document page of at most eight anchored chunks', () => {
    expect(validatePersonOpenResponseV1(openDocument)).toEqual(openDocument);
    expect(validatePersonOpenResponseV1({ ...openDocument, chunks: [], next_cursor: null })).toMatchObject({ chunks: [] });
    // Extraction keeps every character but NUL, and read-v2 releases chunks as stored.
    expect(validatePersonOpenResponseV1({ ...openDocument, chunks: [{ anchor: { kind: 'page', start: 2 }, text: '\fPage two\u0007' }] })).toHaveProperty('chunks');
    const chunk = (index: number) => ({ anchor: { kind: 'paragraph', start: index + 1 }, text: `Paragraph ${index}` });
    expect(validatePersonOpenResponseV1({ ...openDocument, chunks: Array.from({ length: 8 }, (_, index) => chunk(index)) })).toHaveProperty(['chunks', 'length'], 8);
    expect(() => validatePersonOpenResponseV1({ ...openDocument, chunks: Array.from({ length: 9 }, (_, index) => chunk(index)) })).toThrow('chunks is invalid');
    for (const anchor of [{ kind: 'page', start: 0 }, { kind: 'page', start: 1.5 }, { kind: 'line', start: 1 }, { kind: 'page' }]) {
      expect(() => validatePersonOpenResponseV1({ ...openDocument, chunks: [{ anchor, text: 'x' }] })).toThrow('anchor');
    }
    for (const text of ['', 'x'.repeat(3 * 1024 + 1), '\uDC00']) {
      expect(() => validatePersonOpenResponseV1({ ...openDocument, chunks: [{ anchor: { kind: 'page', start: 1 }, text }] })).toThrow('chunk text');
    }
    expect(() => validatePersonOpenResponseV1({ ...openDocument, item: meetingRow })).toThrow('inconsistent');
  });

  it('opens a meeting as detail plus split atoms, never as the envelope', () => {
    expect(validatePersonOpenResponseV1(openMeeting())).toEqual(openMeeting());
    const next = validatePersonOpenResponseV1(openMeeting({ meeting: undefined, next_cursor: 'AnR3' }));
    expect(next).not.toHaveProperty('meeting');
    expect(validatePersonOpenResponseV1(openMeeting({ atoms: [] }))).toMatchObject({ atoms: [] });
    expect(() => validatePersonOpenResponseV1(openMeeting({ atoms: [], next_cursor: 'AnR3' }))).toThrow('atoms is invalid');
    expect(() => validatePersonOpenResponseV1(openMeeting({ meeting: undefined, atoms: [] }))).toThrow('atoms is invalid');
    for (const atom of [
      { kind: 'action', text: 'Ship it.', status: 'decided' }, { kind: 'decision', text: 'Ship it.', owner: 'Ari' },
      { kind: 'rationale', text: 'Because.', due_at: '2026-10-01' }, { kind: 'decision', text: 'Ship it.', status: 'maybe' },
      { kind: 'action', text: 'Rest.', owner: 'Ari', part: { index: 2, count: 2 } }, { kind: 'decision', text: 'Rest.', status: 'decided', part: { index: 2, count: 3 } },
      { kind: 'action', text: 'Whole.', part: { index: 1, count: 1 } }, { kind: 'action', text: 'Past.', part: { index: 3, count: 2 } },
      { kind: 'action', text: 'Zero.', part: { index: 0, count: 2 } }, { kind: 'action', text: 'Extra.', part: { index: 1, count: 2, atom_order: 0 } },
      { kind: 'signal', text: 'Unknown kind.' }, { kind: 'action', text: 'x'.repeat(3 * 1024 + 1) }, { kind: 'action', text: 'Bell\u0007' },
      { kind: 'action', text: 'Owner.', owner: ' Ari' },
    ]) expect(() => validatePersonOpenResponseV1(withAtom(atom))).toThrow('atom');
    const atoms = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'rationale', text: `Reason ${index}.` }));
    expect(validatePersonOpenResponseV1(openMeeting({ atoms: atoms(25) }))).toHaveProperty(['atoms', 'length'], 25);
    expect(() => validatePersonOpenResponseV1(openMeeting({ atoms: atoms(26) }))).toThrow('atoms is invalid');
    // The retired transcript_ref (ADR-0046) is an unknown field.
    expect(() => validatePersonOpenResponseV1(openMeeting({ transcript_ref: TRANSCRIPT }))).toThrow('unexpected shape');
    expect(() => validatePersonOpenResponseV1(openMeeting({ item: { ...meetingRow, ref: `meeting:sha256:${'d'.repeat(64)}` } }))).toThrow('inconsistent');
    const detail = (fields: Record<string, unknown>) => openMeeting({ meeting: defined({ ...meetingDetail, ...fields }) });
    const names = (count: number) => Array.from({ length: count }, (_, index) => `Person ${index}`);
    expect(validatePersonOpenResponseV1(detail({ participants: names(32), participants_more: true }))).toHaveProperty(['meeting', 'participants', 'length'], 32);
    for (const fields of [
      { participants: names(33) }, { participants: [{ display_name: 'Ari', id: 'U1' }] }, { participants: ['Ari', 'Ari'] },
      { participants: [' Ari'] }, { all_day: 'false' }, { participants_more: undefined }, { timezone: 'America/Los Angeles' },
      { started_at: 'soon' }, { ended_at: 'x'.repeat(65) }, { approved_by: '' },
    ]) expect(() => validatePersonOpenResponseV1(detail(fields))).toThrow();
  });

  it('refuses a transcript page, the retired open kind (ADR-0046)', () => {
    expect(() => validatePersonOpenResponseV1(openTranscript)).toThrow('ref is invalid');
  });

  it('fits a worst-case list page inside the list bound and refuses anything larger', () => {
    const quotes = (bytes: number) => '"'.repeat(bytes);
    const projects = Array.from({ length: 20 }, (_, index) => ({ project_id: projectId(index + 1), name: quotes(200) }));
    const items = Array.from({ length: 25 }, (_, index) => ({
      ref: `document:doc_${hex(index)}`, kind: 'document', title: quotes(200), added_at: '2026-09-21T21:30:00.000Z', visibility: 'project', projects,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extraction_state: 'limit_exceeded', size_bytes: 25 * 1024 * 1024,
    }));
    // A first project page carries the largest header there is: the project.
    const worst = {
      schema_version: 1, kind: 'echo-person-list-v1', scope: { kind: 'project', project_id: PROJECT_A },
      project: { project_id: PROJECT_A, name: quotes(200), role: 'member', status: 'archived' },
      items, next_cursor: 'A'.repeat(512), notice: 'meetings_unavailable',
    };
    const response = validatePersonListResponseV1(worst);
    expect(response.items).toHaveLength(25);
    expect(canonicalJsonBytes(response).byteLength).toBeLessThanOrEqual(PERSON_LIST_RESPONSE_MAX_BYTES_V1);
    vi.mocked(canonicalJsonBytes).mockReturnValueOnce(Buffer.alloc(PERSON_LIST_RESPONSE_MAX_BYTES_V1 + 1));
    expect(() => validatePersonListResponseV1(page())).toThrow('exceeds JSON byte bound');
  });

  it('fits a worst-case first meeting page inside the open bound and refuses anything larger', () => {
    const quotes = (bytes: number) => '"'.repeat(bytes);
    // 32 distinct 200-byte names that each double under JSON escaping.
    const participants = Array.from({ length: 32 }, (_, index) => index.toString(2).padStart(5, '0').replace(/0/g, '"').replace(/1/g, '\\') + quotes(195));
    const atoms: Record<string, unknown>[] = [];
    for (let index = 0; ; index += 1) {
      const next = index % 3 === 0
        ? { kind: 'decision', text: quotes(3 * 1024), status: 'unresolved' }
        : index % 3 === 1
          ? { kind: 'action', text: quotes(3 * 1024), owner: quotes(512), due_at: quotes(128) }
          : { kind: 'rationale', text: quotes(3 * 1024) };
      if (canonicalJsonBytes([...atoms, next]).byteLength > PERSON_OPEN_ATOMS_BUDGET_BYTES_V1) break;
      atoms.push(next);
    }
    const worst = openMeeting({
      item: { ...meetingRow, title: quotes(200), projects: Array.from({ length: 20 }, (_, index) => ({ project_id: projectId(index + 1), name: quotes(200) })) },
      meeting: {
        started_at: '2026-09-21T20:00:00.000Z', ended_at: '2026-09-21T21:00:00.000Z', timezone: 'A'.repeat(64), all_day: false,
        participants, participants_more: true, approved_by: quotes(200),
      },
      atoms, next_cursor: 'A'.repeat(512),
    });
    expect(canonicalJsonBytes(atoms).byteLength).toBeGreaterThan(PERSON_OPEN_ATOMS_BUDGET_BYTES_V1 - 8 * 1024);
    expect(canonicalJsonBytes(validatePersonOpenResponseV1(worst)).byteLength).toBeLessThanOrEqual(PERSON_OPEN_RESPONSE_MAX_BYTES_V1);
    const oversized = Array.from({ length: 25 }, () => ({ kind: 'rationale', text: quotes(3 * 1024) }));
    expect(() => validatePersonOpenResponseV1(openMeeting({ atoms: oversized }))).toThrow('exceeds JSON byte bound');
  });
});
