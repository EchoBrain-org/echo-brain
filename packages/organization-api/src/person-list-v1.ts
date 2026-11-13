import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import {
  PERSON_DOCUMENT_MAX_ORIGINAL_BYTES,
  PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES,
  type PersonDocumentExtractionStateV1,
  type PersonDocumentMediaTypeV1,
} from './person-documents-v1.js';
import { PERSON_UPDATE_TEXT_MAX_BYTES } from './person-updates.js';
import { PROJECT_NAME_MAX_BYTES, validateProjectIdV1, type ProjectIdV1, type ProjectRoleV1 } from './project-context-v1.js';
import type { ProjectStatusV2 } from './project-context-v2.js';
import { asEnumerableRecord as object, assertExactKeys, assertTimestamp, fail, utf8ByteLength } from './validation.js';

/**
 * Model-free list and open (ADR-0024). A list page names what the caller can
 * read now, newest first, with no text and no counts; open releases one item
 * by ref. Refs never carry a source, revision or content hash.
 */
export const PERSON_LIST_PATH_V1 = '/v1/person/list';
export const PERSON_OPEN_PATH_V1 = '/v1/person/open';
export const PERSON_LIST_PAGE_SIZE_V1 = 25;
/** Equals the association cap, so a row never hides a joined project. */
const PERSON_LIST_ROW_PROJECTS_MAX_V1 = 20;
export const PERSON_LIST_TEXT_MAX_BYTES_V1 = 200;
export const PERSON_LIST_RESPONSE_MAX_BYTES_V1 = 320 * 1024;
export const PERSON_OPEN_RESPONSE_MAX_BYTES_V1 = 64 * 1024;
const PERSON_OPEN_DOCUMENT_CHUNKS_MAX_V1 = 8;
export const PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1 = 'meetings_unavailable';

export type PersonItemKindV1 = 'imported_meeting' | 'note' | 'document' | 'meeting';
export type PersonImportedMeetingRefV1 = `imported_meeting:cap_${string}`;
export type PersonNoteRefV1 = `note:ctx_${string}`;
export type PersonDocumentRefV1 = `document:doc_${string}`;
export type PersonMeetingRefV1 = `meeting:sha256:${string}`;
export type PersonItemRefV1 = PersonImportedMeetingRefV1 | PersonNoteRefV1 | PersonDocumentRefV1 | PersonMeetingRefV1;
/** What open reads. A listed meeting is read as its record (`GET /v1/person/records`); open of a meeting was retired on 2026-11-11. */
export type PersonOpenRefV1 = Exclude<PersonItemRefV1, PersonMeetingRefV1>;
export type PersonListVisibilityV1 = 'only_me' | 'team' | 'project';
export type PersonListNoticeV1 = 'meetings_unavailable';
/**
 * One project the caller belongs to, or only_me (ADR-0049): every item whose
 * only reader is the caller, filed in a project or not. These are the scopes the
 * desktop lists; the list has no global or mine scope.
 */
export type PersonListScopeV1 = { readonly kind: 'project'; readonly project_id: ProjectIdV1 } | { readonly kind: 'only_me' };

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
export interface PersonListImportedMeetingRowV1 extends PersonListRowBaseV1 { readonly kind: 'imported_meeting'; readonly ref: PersonImportedMeetingRefV1 }
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
export type PersonListRowV1 = PersonListImportedMeetingRowV1 | PersonListNoteRowV1 | PersonListDocumentRowV1 | PersonListMeetingRowV1;

/** Exactly one of project_id and only_me. */
export interface PersonListRequestV1 {
  readonly schema_version: 1;
  readonly project_id?: ProjectIdV1;
  readonly only_me?: true;
  readonly cursor?: string;
}
export interface PersonListProjectV1 {
  readonly project_id: ProjectIdV1;
  readonly name: string;
  readonly role: ProjectRoleV1;
  readonly status: ProjectStatusV2;
}
/**
 * The first project page may carry project; an only_me page carries no header.
 * Which page is first is known only to the caller.
 */
export interface PersonListResponseV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-list-v1';
  readonly scope: PersonListScopeV1;
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
interface PersonOpenBaseV1 { readonly schema_version: 1; readonly kind: 'echo-person-open-v1'; readonly next_cursor: string | null }
export interface PersonOpenImportedMeetingV1 extends PersonOpenBaseV1 { readonly ref: PersonImportedMeetingRefV1; readonly item: PersonListImportedMeetingRowV1; readonly text: string }
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
export type PersonOpenResponseV1 = PersonOpenImportedMeetingV1 | PersonOpenNoteV1 | PersonOpenDocumentV1;

const IMPORTED_REF = /^imported_meeting:cap_[0-9a-f]{64}$/;
const NOTE_REF = /^note:ctx_[0-9a-f]{64}$/;
const DOCUMENT_REF = /^document:doc_[0-9a-f]{64}$/;
const MEETING_REF = /^meeting:sha256:[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
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

function optionalKeys(input: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((key) => Object.hasOwn(input, key));
}

/** One trimmed NFC display line. */
function line(value: unknown, label: string, maximumBytes: number, controls = LINE_CONTROLS): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value || value !== value.normalize('NFC') ||
    controls.test(value) || LONE_SURROGATE.test(value) || utf8ByteLength(value) > maximumBytes
  ) fail(`${label} is invalid`);
}

/** Released text keeps its exact bytes, so it is neither trimmed nor normalized. */
function body(value: unknown, label: string, maximumBytes: number, allowEmpty = false): asserts value is string {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) || BODY_CONTROLS.test(value) || LONE_SURROGATE.test(value) ||
    utf8ByteLength(value) > maximumBytes
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
  if (typeof value !== 'string' || !(IMPORTED_REF.test(value) || NOTE_REF.test(value) || DOCUMENT_REF.test(value) || MEETING_REF.test(value))) fail(`${label} is invalid`);
  return value as PersonItemRefV1;
}

export function personRefKindV1(ref: PersonItemRefV1): PersonItemKindV1 {
  const valid = validatePersonItemRefV1(ref);
  return valid.slice(0, valid.indexOf(':')) as PersonItemKindV1;
}

/** The text after the first colon: a context_id, a document_id, or a record digest. */
export function personRefIdV1(ref: PersonItemRefV1): string {
  const valid = validatePersonItemRefV1(ref);
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
  const kind = personRefKindV1(ref);
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
  if (kind === 'imported_meeting') return Object.freeze({ ref: ref as PersonImportedMeetingRefV1, kind, ...base });
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

function listScope(value: unknown): PersonListScopeV1 {
  const input = object(value, 'Person list scope');
  if (input.kind === 'project') {
    assertExactKeys(input, ['kind', 'project_id'], 'Person list scope');
    return Object.freeze({ kind: 'project' as const, project_id: validateProjectIdV1(input.project_id, 'Person list scope project_id') });
  }
  if (input.kind !== 'only_me') fail('Person list scope is invalid');
  assertExactKeys(input, ['kind'], 'Person list scope');
  return Object.freeze({ kind: 'only_me' as const });
}

export function validatePersonListRequestV1(value: unknown): PersonListRequestV1 {
  const input = object(value, 'Person list request');
  assertExactKeys(input, ['schema_version', ...optionalKeys(input, ['project_id', 'only_me', 'cursor'])], 'Person list request');
  if (input.schema_version !== 1) fail('Person list request schema_version is unsupported');
  if (Object.hasOwn(input, 'only_me') && input.only_me !== true) fail('Person list request only_me is invalid');
  if (optionalKeys(input, ['project_id', 'only_me']).length !== 1) fail('Person list request scope is invalid');
  return Object.freeze({
    schema_version: 1 as const,
    ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Person list request project_id') } : {}),
    ...(Object.hasOwn(input, 'only_me') ? { only_me: true as const } : {}),
    ...(Object.hasOwn(input, 'cursor') ? { cursor: cursor(input.cursor, 'Person list request cursor') } : {}),
  });
}

export function validatePersonListResponseV1(value: unknown): PersonListResponseV1 {
  const input = object(value, 'Person list response');
  const scope = listScope(input.scope);
  if (Object.hasOwn(input, 'project') && scope.kind !== 'project') fail('Person list header is invalid');
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'items', 'next_cursor', ...optionalKeys(input, ['project', 'notice'])], 'Person list response');
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
  if (Object.hasOwn(input, 'notice') && input.notice !== PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1) fail('Person list notice is invalid');
  return bounded<PersonListResponseV1>({
    schema_version: 1, kind: 'echo-person-list-v1', scope, ...(project === undefined ? {} : { project }),
    items: Object.freeze(items), next_cursor: input.next_cursor === null ? null : cursor(input.next_cursor, 'Person list next_cursor'),
    ...(Object.hasOwn(input, 'notice') ? { notice: PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1 } : {}),
  }, PERSON_LIST_RESPONSE_MAX_BYTES_V1, 'Person list response');
}

function openRef(value: unknown, label: string): PersonOpenRefV1 {
  const ref = validatePersonItemRefV1(value, label);
  if (personRefKindV1(ref) === 'meeting') fail(`${label} is invalid`);
  return ref as PersonOpenRefV1;
}

export function validatePersonOpenRequestV1(value: unknown): PersonOpenRequestV1 {
  const input = object(value, 'Person open request');
  assertExactKeys(input, ['schema_version', 'ref', ...optionalKeys(input, ['cursor'])], 'Person open request');
  if (input.schema_version !== 1) fail('Person open request schema_version is unsupported');
  const ref = openRef(input.ref, 'Person open request ref');
  if (Object.hasOwn(input, 'cursor') && personRefKindV1(ref) === 'note') fail('Person open request cursor is invalid');
  return Object.freeze({ schema_version: 1 as const, ref, ...(Object.hasOwn(input, 'cursor') ? { cursor: cursor(input.cursor, 'Person open request cursor') } : {}) });
}

function openItem(value: unknown, ref: PersonItemRefV1): PersonListRowV1 {
  const item = row(value, 'Person open item');
  if (item.ref !== ref) fail('Person open item is inconsistent with its ref');
  return item;
}

/**
 * The stored upload filename, released as V2 document metadata releases it: the
 * upload rules (person-documents-v1.ts) do not require it to be trimmed.
 */
function filename(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') || C0_C1_CONTROLS.test(value) ||
    LONE_SURROGATE.test(value) || utf8ByteLength(value) > 255 || /[\\/]/.test(value) || value === '.' || value === '..'
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
    utf8ByteLength(input.text) > PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES
  ) fail('Person open document chunk text is invalid');
  return Object.freeze({ anchor: Object.freeze({ kind: anchor.kind, start: anchor.start as number }), text: input.text });
}

export function validatePersonOpenResponseV1(value: unknown): PersonOpenResponseV1 {
  const input = object(value, 'Person open response');
  const ref = openRef(input.ref, 'Person open response ref');
  const kind = personRefKindV1(ref) as Exclude<PersonItemKindV1, 'meeting'>;
  const keys = kind === 'document' ? ['item', 'filename', 'chunks'] : ['item', 'text'];
  assertExactKeys(input, ['schema_version', 'kind', 'ref', 'next_cursor', ...keys], 'Person open response');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-open-v1') fail('Person open response is invalid');
  const next_cursor = input.next_cursor === null ? null : cursor(input.next_cursor, 'Person open response next_cursor');
  const base = { schema_version: 1 as const, kind: 'echo-person-open-v1' as const };
  switch (kind) {
    case 'imported_meeting': {
      const item = openItem(input.item, ref as PersonImportedMeetingRefV1) as PersonListImportedMeetingRowV1;
      // A meeting tool's import can contain only a transcript, which is never
      // released, so its imported-notes text is empty.
      body(input.text, 'Imported meeting notes', 8192, true);
      return bounded<PersonOpenImportedMeetingV1>({ ...base, ref: ref as PersonImportedMeetingRefV1, item, text: input.text, next_cursor }, PERSON_OPEN_RESPONSE_MAX_BYTES_V1, 'Person open response');
    }
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
  }
}
