import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonAnswerScopeV3, type PersonAnswerScopeV3 } from './person-answer-v3.js';
import {
  PERSON_DOCUMENT_MAX_ORIGINAL_BYTES,
  PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES,
  type PersonDocumentExtractionStateV1,
  type PersonDocumentMediaTypeV1,
} from './person-documents-v1.js';
import { PERSON_MEETING_TRANSCRIPT_MAX_TEXT_BYTES_V1 } from './person-meeting-transcript-v1.js';
import { PERSON_UPDATE_TEXT_MAX_BYTES } from './person-updates.js';
import { PROJECT_NAME_MAX_BYTES, validateProjectIdV1, type ProjectIdV1, type ProjectRoleV1 } from './project-context-v1.js';
import type { ProjectStatusV2 } from './project-context-v2.js';
import { asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, assertTimestamp, fail } from './validation.js';

/**
 * Model-free list and open (ADR-0024). A list page names what the caller can
 * read now, newest first, with no text and no counts; open releases one item
 * by ref. Refs never carry a source, revision or content hash.
 */
export const PERSON_LIST_PATH_V1 = '/v1/person/list';
export const PERSON_OPEN_PATH_V1 = '/v1/person/open';
export const PERSON_LIST_PAGE_SIZE_V1 = 25;
export const PERSON_LIST_HEADER_PROJECTS_MAX_V1 = 50;
/** Equals the association cap, so a row never hides a joined project. */
export const PERSON_LIST_ROW_PROJECTS_MAX_V1 = 20;
export const PERSON_LIST_CONNECTED_MAX_V1 = 32;
export const PERSON_LIST_TEXT_MAX_BYTES_V1 = 200;
export const PERSON_LIST_RESPONSE_MAX_BYTES_V1 = 320 * 1024;
export const PERSON_OPEN_RESPONSE_MAX_BYTES_V1 = 64 * 1024;
export const PERSON_OPEN_ATOMS_MAX_V1 = 25;
/** Server page budget for the canonical JSON of one page's atoms array. */
export const PERSON_OPEN_ATOMS_BUDGET_BYTES_V1 = 32 * 1024;
export const PERSON_OPEN_ATOM_PART_MAX_BYTES_V1 = 3 * 1024;
export const PERSON_OPEN_DOCUMENT_CHUNKS_MAX_V1 = 8;
export const PERSON_OPEN_PARTICIPANTS_MAX_V1 = 32;
export const PERSON_CURSOR_MAX_CHARACTERS_V1 = 512;
export const PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1 = 'meetings_unavailable';

export type PersonItemKindV1 = 'note' | 'document' | 'meeting';
export type PersonNoteRefV1 = `note:ctx_${string}`;
export type PersonDocumentRefV1 = `document:doc_${string}`;
export type PersonMeetingRefV1 = `meeting:sha256:${string}`;
export type PersonTranscriptRefV1 = `transcript:sha256:${string}`;
export type PersonItemRefV1 = PersonNoteRefV1 | PersonDocumentRefV1 | PersonMeetingRefV1;
export type PersonOpenRefV1 = PersonItemRefV1 | PersonTranscriptRefV1;
export type PersonListVisibilityV1 = 'only_me' | 'team' | 'project';
export type PersonListNoticeV1 = 'meetings_unavailable';

export interface PersonListProjectRefV1 { readonly project_id: ProjectIdV1; readonly name: string }
interface PersonListRowBaseV1 {
  readonly ref: PersonItemRefV1;
  readonly kind: PersonItemKindV1;
  readonly title: string;
  /** Canonical UTC milliseconds: received_at for originals, the receipt time for meetings. */
  readonly added_at: string;
  readonly visibility: PersonListVisibilityV1;
  /** The caller's joined projects only; never an audience roster. */
  readonly projects: readonly PersonListProjectRefV1[];
}
export interface PersonListNoteRowV1 extends PersonListRowBaseV1 { readonly kind: 'note'; readonly ref: PersonNoteRefV1 }
export interface PersonListDocumentRowV1 extends PersonListRowBaseV1 {
  readonly kind: 'document';
  readonly ref: PersonDocumentRefV1;
  readonly media_type: PersonDocumentMediaTypeV1;
  readonly extraction_state: PersonDocumentExtractionStateV1;
  readonly size_bytes: number;
}
export interface PersonListMeetingRowV1 extends PersonListRowBaseV1 {
  readonly kind: 'meeting';
  readonly ref: PersonMeetingRefV1;
  /** YYYY-MM-DD, a real calendar date. */
  readonly meeting_date?: string;
}
export type PersonListRowV1 = PersonListNoteRowV1 | PersonListDocumentRowV1 | PersonListMeetingRowV1;

/** project_id and mine are exclusive; neither means global. */
export interface PersonListRequestV1 {
  readonly schema_version: 1;
  readonly project_id?: ProjectIdV1;
  readonly mine?: true;
  readonly cursor?: string;
}
export interface PersonListMeV1 { readonly display_name: string; readonly membership_type: 'owner' | 'employee' }
export interface PersonListConnectedToolV1 {
  readonly tool: string;
  readonly status: 'unlinked' | 'linked' | 'revoked' | 'unavailable';
}
export interface PersonListProjectV1 {
  readonly project_id: ProjectIdV1;
  readonly name: string;
  readonly role: ProjectRoleV1;
  readonly status: ProjectStatusV2;
}
/**
 * The first global page carries me, connected, projects and projects_more
 * together; the first project page may carry project; mine pages carry no
 * header. Which page is first is known only to the caller.
 */
export interface PersonListResponseV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-list-v1';
  readonly scope: PersonAnswerScopeV3;
  readonly me?: PersonListMeV1;
  readonly connected?: readonly PersonListConnectedToolV1[];
  readonly projects?: readonly PersonListProjectV1[];
  readonly projects_more?: boolean;
  readonly project?: PersonListProjectV1;
  readonly items: readonly PersonListRowV1[];
  readonly next_cursor: string | null;
  readonly notice?: PersonListNoticeV1;
}

export interface PersonOpenRequestV1 {
  readonly schema_version: 1;
  readonly ref: PersonOpenRefV1;
  /** Never with a note ref. */
  readonly cursor?: string;
}
export interface PersonOpenDocumentChunkV1 {
  readonly anchor: { readonly kind: 'page' | 'paragraph'; readonly start: number };
  readonly text: string;
}
export interface PersonOpenMeetingDetailV1 {
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly timezone?: string;
  readonly all_day: boolean;
  /** Display names only. */
  readonly participants: readonly string[];
  readonly participants_more: boolean;
  /** The final approver's current directory display name. */
  readonly approved_by?: string;
}
/** An atom longer than one part is split, never dropped; its parts concatenate to the approved text. */
export interface PersonOpenMeetingAtomV1 {
  readonly kind: 'decision' | 'action' | 'rationale';
  readonly text: string;
  readonly status?: 'proposed' | 'decided' | 'unresolved';
  readonly owner?: string;
  readonly due_at?: string;
  readonly part?: { readonly index: number; readonly count: number };
}
interface PersonOpenBaseV1 { readonly schema_version: 1; readonly kind: 'echo-person-open-v1'; readonly next_cursor: string | null }
export interface PersonOpenNoteV1 extends PersonOpenBaseV1 {
  readonly ref: PersonNoteRefV1;
  readonly item: PersonListNoteRowV1;
  readonly text: string;
  readonly next_cursor: null;
}
export interface PersonOpenDocumentV1 extends PersonOpenBaseV1 {
  readonly ref: PersonDocumentRefV1;
  readonly item: PersonListDocumentRowV1;
  readonly filename: string;
  /** Empty while extracting or when the document has no text. */
  readonly chunks: readonly PersonOpenDocumentChunkV1[];
}
export interface PersonOpenMeetingV1 extends PersonOpenBaseV1 {
  readonly ref: PersonMeetingRefV1;
  readonly item: PersonListMeetingRowV1;
  /** Present iff the request had no cursor. */
  readonly meeting?: PersonOpenMeetingDetailV1;
  readonly atoms: readonly PersonOpenMeetingAtomV1[];
  /** First page only, and only when the approver shared the transcript. */
  readonly transcript_ref?: PersonTranscriptRefV1;
}
export interface PersonOpenTranscriptV1 extends PersonOpenBaseV1 {
  readonly ref: PersonTranscriptRefV1;
  readonly text: string;
}
export type PersonOpenResponseV1 = PersonOpenNoteV1 | PersonOpenDocumentV1 | PersonOpenMeetingV1 | PersonOpenTranscriptV1;

const NOTE_REF = /^note:ctx_[0-9a-f]{64}$/;
const DOCUMENT_REF = /^document:doc_[0-9a-f]{64}$/;
const MEETING_REF = /^meeting:sha256:[0-9a-f]{64}$/;
const TRANSCRIPT_REF = /^transcript:sha256:[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIMEZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const TOOL_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Project names and upload filenames may hold interior line and paragraph separators (project-context-v1.ts, person-documents-v1.ts). */
const C0_C1_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const BODY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const VISIBILITIES: readonly string[] = ['only_me', 'team', 'project'];
// Keyed by the documents contract's unions: a new media type or extraction state fails to compile here until it is listed.
const MEDIA_TYPES: readonly string[] = Object.keys({
  'text/plain': true, 'text/markdown': true, 'application/pdf': true, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
} satisfies Record<PersonDocumentMediaTypeV1, true>);
const EXTRACTION_STATES: readonly string[] = Object.keys({
  extracting: true, ready: true, partial: true, no_text: true, encrypted: true, malformed: true, limit_exceeded: true, timed_out: true, unsupported: true, unavailable: true,
} satisfies Record<PersonDocumentExtractionStateV1, true>);
const TOOL_STATUSES: readonly string[] = ['unlinked', 'linked', 'revoked', 'unavailable'];
const ATOM_KINDS: readonly string[] = ['decision', 'action', 'rationale'];
const DECISION_STATUSES: readonly string[] = ['proposed', 'decided', 'unresolved'];
const GLOBAL_HEADER = ['me', 'connected', 'projects', 'projects_more'] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, label);
  return asRecord(value, label);
}

function optionalKeys(input: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((key) => Object.hasOwn(input, key));
}

function utf8Bytes(value: string): number {
  return [...value].reduce((total, character) => {
    const point = character.codePointAt(0)!;
    return total + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
  }, 0);
}

/** One trimmed NFC display line. */
function line(value: unknown, label: string, maximumBytes: number, controls = LINE_CONTROLS): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value || value !== value.normalize('NFC') ||
    controls.test(value) || LONE_SURROGATE.test(value) || utf8Bytes(value) > maximumBytes
  ) fail(`${label} is invalid`);
}

/** Released text keeps its exact bytes, so it is neither trimmed nor normalized. */
function body(value: unknown, label: string, maximumBytes: number): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || BODY_CONTROLS.test(value) || LONE_SURROGATE.test(value) ||
    utf8Bytes(value) > maximumBytes
  ) fail(`${label} is invalid`);
}

function cursor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CURSOR.test(value)) fail(`${label} is invalid`);
  return value;
}

function day(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DAY.test(value)) fail(`${label} is invalid`);
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) fail(`${label} is invalid`);
}

function bounded<T>(result: T, maximumBytes: number, label: string): T {
  if (canonicalJsonBytes(result).byteLength > maximumBytes) fail(`${label} exceeds JSON byte bound`);
  return Object.freeze(result);
}

export function validatePersonItemRefV1(value: unknown, label = 'Person item ref'): PersonItemRefV1 {
  if (typeof value !== 'string' || !(NOTE_REF.test(value) || DOCUMENT_REF.test(value) || MEETING_REF.test(value))) fail(`${label} is invalid`);
  return value as PersonItemRefV1;
}

/** A transcript ref is only ever handed out by an open meeting page or an Ask citation. */
export function validatePersonOpenRefV1(value: unknown, label = 'Person open ref'): PersonOpenRefV1 {
  if (typeof value === 'string' && TRANSCRIPT_REF.test(value)) return value as PersonTranscriptRefV1;
  return validatePersonItemRefV1(value, label);
}

export function personRefKindV1(ref: PersonOpenRefV1): 'note' | 'document' | 'meeting' | 'transcript' {
  const valid = validatePersonOpenRefV1(ref);
  return valid.slice(0, valid.indexOf(':')) as 'note' | 'document' | 'meeting' | 'transcript';
}

/** The text after the first colon: a context_id, a document_id, or a record digest. */
export function personRefIdV1(ref: PersonOpenRefV1): string {
  const valid = validatePersonOpenRefV1(ref);
  return valid.slice(valid.indexOf(':') + 1);
}

function projectName(value: unknown, label: string): asserts value is string {
  line(value, label, PROJECT_NAME_MAX_BYTES, C0_C1_CONTROLS);
}

function rowProject(value: unknown): PersonListProjectRefV1 {
  const input = object(value, 'Person list row project');
  assertExactKeys(input, ['project_id', 'name'], 'Person list row project');
  const project_id = validateProjectIdV1(input.project_id, 'Person list row project_id');
  projectName(input.name, 'Person list row project name');
  return Object.freeze({ project_id, name: input.name });
}

function row(value: unknown, label: string): PersonListRowV1 {
  const input = object(value, label);
  const ref = validatePersonItemRefV1(input.ref, `${label} ref`);
  const kind = personRefKindV1(ref) as PersonItemKindV1;
  if (input.kind !== kind) fail(`${label} kind is inconsistent with its ref`);
  const extra = kind === 'document' ? ['media_type', 'extraction_state', 'size_bytes'] : kind === 'meeting' ? optionalKeys(input, ['meeting_date']) : [];
  assertExactKeys(input, ['ref', 'kind', 'title', 'added_at', 'visibility', 'projects', ...extra], label);
  line(input.title, `${label} title`, PERSON_LIST_TEXT_MAX_BYTES_V1);
  assertTimestamp(input.added_at, `${label} added_at`);
  if (!VISIBILITIES.includes(input.visibility as string)) fail(`${label} visibility is invalid`);
  if (!Array.isArray(input.projects) || input.projects.length > PERSON_LIST_ROW_PROJECTS_MAX_V1) fail(`${label} projects is invalid`);
  const projects = input.projects.map(rowProject);
  if (new Set(projects.map((project) => project.project_id)).size !== projects.length) fail(`${label} projects contains duplicates`);
  const base = { title: input.title, added_at: input.added_at, visibility: input.visibility as PersonListVisibilityV1, projects: Object.freeze(projects) };
  if (kind === 'document') {
    if (!MEDIA_TYPES.includes(input.media_type as string)) fail(`${label} media_type is invalid`);
    if (!EXTRACTION_STATES.includes(input.extraction_state as string)) fail(`${label} extraction_state is invalid`);
    if (!Number.isSafeInteger(input.size_bytes) || (input.size_bytes as number) < 1 || (input.size_bytes as number) > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES) fail(`${label} size_bytes is invalid`);
    return Object.freeze({
      ref: ref as PersonDocumentRefV1, kind, ...base,
      media_type: input.media_type as PersonDocumentMediaTypeV1,
      extraction_state: input.extraction_state as PersonDocumentExtractionStateV1,
      size_bytes: input.size_bytes as number,
    });
  }
  if (kind === 'meeting') {
    if (Object.hasOwn(input, 'meeting_date')) day(input.meeting_date, `${label} meeting_date`);
    return Object.freeze({
      ref: ref as PersonMeetingRefV1, kind, ...base,
      ...(Object.hasOwn(input, 'meeting_date') ? { meeting_date: input.meeting_date as string } : {}),
    });
  }
  return Object.freeze({ ref: ref as PersonNoteRefV1, kind, ...base });
}

function listProject(value: unknown, label: string): PersonListProjectV1 {
  const input = object(value, label);
  assertExactKeys(input, ['project_id', 'name', 'role', 'status'], label);
  const project_id = validateProjectIdV1(input.project_id, `${label} project_id`);
  projectName(input.name, `${label} name`);
  if (input.role !== 'lead' && input.role !== 'member') fail(`${label} role is invalid`);
  if (input.status !== 'active' && input.status !== 'archived') fail(`${label} status is invalid`);
  return Object.freeze({ project_id, name: input.name, role: input.role, status: input.status });
}

function me(value: unknown): PersonListMeV1 {
  const input = object(value, 'Person list me');
  assertExactKeys(input, ['display_name', 'membership_type'], 'Person list me');
  line(input.display_name, 'Person list me display_name', PERSON_LIST_TEXT_MAX_BYTES_V1);
  if (input.membership_type !== 'owner' && input.membership_type !== 'employee') fail('Person list me membership_type is invalid');
  return Object.freeze({ display_name: input.display_name, membership_type: input.membership_type });
}

function connected(value: unknown): readonly PersonListConnectedToolV1[] {
  if (!Array.isArray(value) || value.length > PERSON_LIST_CONNECTED_MAX_V1) fail('Person list connected is invalid');
  const tools = value.map((item) => {
    const input = object(item, 'Person list connected tool');
    assertExactKeys(input, ['tool', 'status'], 'Person list connected tool');
    if (typeof input.tool !== 'string' || !TOOL_ID.test(input.tool)) fail('Person list connected tool is invalid');
    if (!TOOL_STATUSES.includes(input.status as string)) fail('Person list connected tool status is invalid');
    return Object.freeze({ tool: input.tool, status: input.status as PersonListConnectedToolV1['status'] });
  });
  if (new Set(tools.map((tool) => tool.tool)).size !== tools.length) fail('Person list connected contains duplicates');
  return Object.freeze(tools);
}

function headerProjects(value: unknown): readonly PersonListProjectV1[] {
  if (!Array.isArray(value) || value.length > PERSON_LIST_HEADER_PROJECTS_MAX_V1) fail('Person list projects is invalid');
  const projects = value.map((item) => listProject(item, 'Person list project'));
  if (new Set(projects.map((project) => project.project_id)).size !== projects.length) fail('Person list projects contains duplicates');
  if (projects.some((project, index) => index > 0 && project.status === 'active' && projects[index - 1]!.status === 'archived')) {
    fail('Person list projects are out of order');
  }
  return Object.freeze(projects);
}

export function validatePersonListRequestV1(value: unknown): PersonListRequestV1 {
  const input = object(value, 'Person list request');
  assertExactKeys(input, ['schema_version', ...optionalKeys(input, ['project_id', 'mine', 'cursor'])], 'Person list request');
  if (input.schema_version !== 1) fail('Person list request schema_version is unsupported');
  if (Object.hasOwn(input, 'mine') && input.mine !== true) fail('Person list request mine is invalid');
  if (Object.hasOwn(input, 'mine') && Object.hasOwn(input, 'project_id')) fail('Person list request scope is invalid');
  return Object.freeze({
    schema_version: 1 as const,
    ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Person list request project_id') } : {}),
    ...(Object.hasOwn(input, 'mine') ? { mine: true as const } : {}),
    ...(Object.hasOwn(input, 'cursor') ? { cursor: cursor(input.cursor, 'Person list request cursor') } : {}),
  });
}

export function validatePersonListResponseV1(value: unknown): PersonListResponseV1 {
  const input = object(value, 'Person list response');
  const scope = validatePersonAnswerScopeV3(input.scope, 'Person list scope');
  const header = optionalKeys(input, GLOBAL_HEADER);
  if (header.length !== 0 && (scope.kind !== 'global' || header.length !== GLOBAL_HEADER.length)) fail('Person list header is invalid');
  if (Object.hasOwn(input, 'project') && scope.kind !== 'project') fail('Person list header is invalid');
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'items', 'next_cursor', ...header, ...optionalKeys(input, ['project', 'notice'])], 'Person list response');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-list-v1') fail('Person list response is invalid');
  if (!Array.isArray(input.items) || input.items.length > PERSON_LIST_PAGE_SIZE_V1) fail('Person list items is invalid');
  const items = input.items.map((item) => row(item, 'Person list row'));
  if (new Set(items.map((item) => item.ref)).size !== items.length) fail('Person list items contains duplicates');
  for (let index = 1; index < items.length; index += 1) {
    const before = items[index - 1]!;
    const after = items[index]!;
    if (!(before.added_at > after.added_at || (before.added_at === after.added_at && before.ref < after.ref))) fail('Person list items are out of order');
  }
  let project: PersonListProjectV1 | undefined;
  if (Object.hasOwn(input, 'project')) {
    project = listProject(input.project, 'Person list scope project');
    if (scope.kind !== 'project' || project.project_id !== scope.project_id) fail('Person list scope project is inconsistent');
  }
  let globalHeader: Pick<PersonListResponseV1, 'me' | 'connected' | 'projects' | 'projects_more'> = {};
  if (header.length !== 0) {
    const projects = headerProjects(input.projects);
    if (typeof input.projects_more !== 'boolean' || (input.projects_more && projects.length !== PERSON_LIST_HEADER_PROJECTS_MAX_V1)) fail('Person list projects_more is invalid');
    globalHeader = { me: me(input.me), connected: connected(input.connected), projects, projects_more: input.projects_more };
  }
  if (Object.hasOwn(input, 'notice') && input.notice !== PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1) fail('Person list notice is invalid');
  return bounded<PersonListResponseV1>({
    schema_version: 1, kind: 'echo-person-list-v1', scope, ...globalHeader, ...(project === undefined ? {} : { project }),
    items: Object.freeze(items), next_cursor: input.next_cursor === null ? null : cursor(input.next_cursor, 'Person list next_cursor'),
    ...(Object.hasOwn(input, 'notice') ? { notice: PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1 } : {}),
  }, PERSON_LIST_RESPONSE_MAX_BYTES_V1, 'Person list response');
}

export function validatePersonOpenRequestV1(value: unknown): PersonOpenRequestV1 {
  const input = object(value, 'Person open request');
  assertExactKeys(input, ['schema_version', 'ref', ...optionalKeys(input, ['cursor'])], 'Person open request');
  if (input.schema_version !== 1) fail('Person open request schema_version is unsupported');
  const ref = validatePersonOpenRefV1(input.ref, 'Person open request ref');
  if (Object.hasOwn(input, 'cursor') && personRefKindV1(ref) === 'note') fail('Person open request cursor is invalid');
  return Object.freeze({ schema_version: 1 as const, ref, ...(Object.hasOwn(input, 'cursor') ? { cursor: cursor(input.cursor, 'Person open request cursor') } : {}) });
}

function openItem(value: unknown, ref: PersonItemRefV1): PersonListRowV1 {
  const item = row(value, 'Person open item');
  if (item.ref !== ref) fail('Person open item is inconsistent with its ref');
  return item;
}

/**
 * The stored upload filename, released as documents read-v2 releases it: the
 * upload rules (person-documents-v1.ts) do not require it to be trimmed.
 */
function filename(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') || C0_C1_CONTROLS.test(value) ||
    LONE_SURROGATE.test(value) || utf8Bytes(value) > 255 || /[\\/]/.test(value) || value === '.' || value === '..'
  ) fail('Person open document filename is invalid');
}

/**
 * Extraction keeps every character but NUL, and read-v2 releases stored chunks
 * as they are, so a chunk is only non-empty, well-formed and byte-bounded. The
 * server's canonical page budget absorbs JSON escaping of any control.
 */
function chunk(value: unknown): PersonOpenDocumentChunkV1 {
  const input = object(value, 'Person open document chunk');
  assertExactKeys(input, ['anchor', 'text'], 'Person open document chunk');
  const anchor = object(input.anchor, 'Person open document chunk anchor');
  assertExactKeys(anchor, ['kind', 'start'], 'Person open document chunk anchor');
  if ((anchor.kind !== 'page' && anchor.kind !== 'paragraph') || !Number.isSafeInteger(anchor.start) || (anchor.start as number) < 1) {
    fail('Person open document chunk anchor is invalid');
  }
  if (
    typeof input.text !== 'string' || input.text.length === 0 || LONE_SURROGATE.test(input.text) ||
    utf8Bytes(input.text) > PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES
  ) fail('Person open document chunk text is invalid');
  return Object.freeze({ anchor: Object.freeze({ kind: anchor.kind, start: anchor.start as number }), text: input.text });
}

function meetingTime(value: unknown, label: string): asserts value is string {
  line(value, label, 64);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} is invalid`);
}

function meetingDetail(value: unknown): PersonOpenMeetingDetailV1 {
  const input = object(value, 'Person open meeting');
  const optional = optionalKeys(input, ['started_at', 'ended_at', 'timezone', 'approved_by']);
  assertExactKeys(input, ['all_day', 'participants', 'participants_more', ...optional], 'Person open meeting');
  if (Object.hasOwn(input, 'started_at')) meetingTime(input.started_at, 'Person open meeting started_at');
  if (Object.hasOwn(input, 'ended_at')) meetingTime(input.ended_at, 'Person open meeting ended_at');
  if (Object.hasOwn(input, 'timezone') && (typeof input.timezone !== 'string' || !TIMEZONE.test(input.timezone))) fail('Person open meeting timezone is invalid');
  if (typeof input.all_day !== 'boolean' || typeof input.participants_more !== 'boolean') fail('Person open meeting is invalid');
  if (!Array.isArray(input.participants) || input.participants.length > PERSON_OPEN_PARTICIPANTS_MAX_V1) fail('Person open meeting participants is invalid');
  const participants = input.participants.map((participant) => {
    line(participant, 'Person open meeting participant', PERSON_LIST_TEXT_MAX_BYTES_V1);
    return participant;
  });
  if (new Set(participants).size !== participants.length) fail('Person open meeting participants contains duplicates');
  if (Object.hasOwn(input, 'approved_by')) line(input.approved_by, 'Person open meeting approved_by', PERSON_LIST_TEXT_MAX_BYTES_V1);
  return Object.freeze({
    ...(Object.hasOwn(input, 'started_at') ? { started_at: input.started_at as string } : {}),
    ...(Object.hasOwn(input, 'ended_at') ? { ended_at: input.ended_at as string } : {}),
    ...(Object.hasOwn(input, 'timezone') ? { timezone: input.timezone as string } : {}),
    all_day: input.all_day, participants: Object.freeze(participants), participants_more: input.participants_more,
    ...(Object.hasOwn(input, 'approved_by') ? { approved_by: input.approved_by as string } : {}),
  });
}

function atom(value: unknown): PersonOpenMeetingAtomV1 {
  const input = object(value, 'Person open meeting atom');
  const optional = optionalKeys(input, ['status', 'owner', 'due_at', 'part']);
  assertExactKeys(input, ['kind', 'text', ...optional], 'Person open meeting atom');
  if (!ATOM_KINDS.includes(input.kind as string)) fail('Person open meeting atom kind is invalid');
  body(input.text, 'Person open meeting atom text', PERSON_OPEN_ATOM_PART_MAX_BYTES_V1);
  if (Object.hasOwn(input, 'status') && (input.kind !== 'decision' || !DECISION_STATUSES.includes(input.status as string))) fail('Person open meeting atom status is invalid');
  if (Object.hasOwn(input, 'owner')) {
    if (input.kind !== 'action') fail('Person open meeting atom owner is invalid');
    line(input.owner, 'Person open meeting atom owner', 512);
  }
  if (Object.hasOwn(input, 'due_at')) {
    if (input.kind !== 'action') fail('Person open meeting atom due_at is invalid');
    line(input.due_at, 'Person open meeting atom due_at', 128);
  }
  let part: PersonOpenMeetingAtomV1['part'];
  if (Object.hasOwn(input, 'part')) {
    const raw = object(input.part, 'Person open meeting atom part');
    assertExactKeys(raw, ['index', 'count'], 'Person open meeting atom part');
    if (!Number.isSafeInteger(raw.count) || (raw.count as number) < 2 || !Number.isSafeInteger(raw.index) || (raw.index as number) < 1 || (raw.index as number) > (raw.count as number)) {
      fail('Person open meeting atom part is invalid');
    }
    part = Object.freeze({ index: raw.index as number, count: raw.count as number });
    if (part.index > 1 && optional.some((key) => key !== 'part')) fail('Person open meeting atom attributes belong to its first part');
  }
  return Object.freeze({
    kind: input.kind as PersonOpenMeetingAtomV1['kind'], text: input.text,
    ...(Object.hasOwn(input, 'status') ? { status: input.status as PersonOpenMeetingAtomV1['status'] } : {}),
    ...(Object.hasOwn(input, 'owner') ? { owner: input.owner as string } : {}),
    ...(Object.hasOwn(input, 'due_at') ? { due_at: input.due_at as string } : {}),
    ...(part === undefined ? {} : { part }),
  });
}

export function validatePersonOpenResponseV1(value: unknown): PersonOpenResponseV1 {
  const input = object(value, 'Person open response');
  const ref = validatePersonOpenRefV1(input.ref, 'Person open response ref');
  const kind = personRefKindV1(ref);
  const keys = kind === 'note' ? ['item', 'text']
    : kind === 'document' ? ['item', 'filename', 'chunks']
    : kind === 'meeting' ? ['item', 'atoms', ...optionalKeys(input, ['meeting', 'transcript_ref'])]
    : ['text'];
  assertExactKeys(input, ['schema_version', 'kind', 'ref', 'next_cursor', ...keys], 'Person open response');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-open-v1') fail('Person open response is invalid');
  const next_cursor = input.next_cursor === null ? null : cursor(input.next_cursor, 'Person open response next_cursor');
  const base = { schema_version: 1 as const, kind: 'echo-person-open-v1' as const };
  switch (kind) {
    case 'note': {
      if (next_cursor !== null) fail('Person open note next_cursor is invalid');
      const item = openItem(input.item, ref as PersonNoteRefV1) as PersonListNoteRowV1;
      body(input.text, 'Person open note text', PERSON_UPDATE_TEXT_MAX_BYTES);
      return bounded<PersonOpenNoteV1>({ ...base, ref: ref as PersonNoteRefV1, item, text: input.text, next_cursor }, PERSON_OPEN_RESPONSE_MAX_BYTES_V1, 'Person open response');
    }
    case 'document': {
      const item = openItem(input.item, ref as PersonDocumentRefV1) as PersonListDocumentRowV1;
      filename(input.filename);
      if (!Array.isArray(input.chunks) || input.chunks.length > PERSON_OPEN_DOCUMENT_CHUNKS_MAX_V1) fail('Person open document chunks is invalid');
      return bounded<PersonOpenDocumentV1>({
        ...base, ref: ref as PersonDocumentRefV1, item, filename: input.filename, chunks: Object.freeze(input.chunks.map(chunk)), next_cursor,
      }, PERSON_OPEN_RESPONSE_MAX_BYTES_V1, 'Person open response');
    }
    case 'meeting': {
      const item = openItem(input.item, ref as PersonMeetingRefV1) as PersonListMeetingRowV1;
      const meeting = Object.hasOwn(input, 'meeting') ? meetingDetail(input.meeting) : undefined;
      if (!Array.isArray(input.atoms) || input.atoms.length > PERSON_OPEN_ATOMS_MAX_V1) fail('Person open meeting atoms is invalid');
      const atoms = input.atoms.map(atom);
      // A cursor page always carries at least one part; only a zero-signal record's first page is empty.
      if (atoms.length === 0 && (meeting === undefined || next_cursor !== null)) fail('Person open meeting atoms is invalid');
      if (Object.hasOwn(input, 'transcript_ref') && (meeting === undefined || input.transcript_ref !== `transcript:${ref.slice('meeting:'.length)}`)) {
        fail('Person open meeting transcript_ref is invalid');
      }
      return bounded<PersonOpenMeetingV1>({
        ...base, ref: ref as PersonMeetingRefV1, item, ...(meeting === undefined ? {} : { meeting }), atoms: Object.freeze(atoms),
        ...(Object.hasOwn(input, 'transcript_ref') ? { transcript_ref: input.transcript_ref as PersonTranscriptRefV1 } : {}), next_cursor,
      }, PERSON_OPEN_RESPONSE_MAX_BYTES_V1, 'Person open response');
    }
    case 'transcript': {
      body(input.text, 'Person open transcript text', PERSON_MEETING_TRANSCRIPT_MAX_TEXT_BYTES_V1);
      return bounded<PersonOpenTranscriptV1>({ ...base, ref: ref as PersonTranscriptRefV1, text: input.text, next_cursor }, PERSON_OPEN_RESPONSE_MAX_BYTES_V1, 'Person open response');
    }
  }
}
