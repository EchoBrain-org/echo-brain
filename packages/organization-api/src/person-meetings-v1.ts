import { validateProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, assertExactKeys, assertTimestamp, utf8ByteLength, fail } from './validation.js';
import { PERSON_TOOL_REQUEST_MAX_BYTES_V1, type PersonToolHostV1 } from './person-tool-client.js';

export const PERSON_MEETINGS_PATH_V2 = '/v1/person/meetings';
export const PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1 = 48 * 1024;
/** Explicit content kinds; submitting notes never manufactures a transcript. */
export interface PersonSyntheticMeetingV1 {
  readonly id: string; readonly title: string; readonly notes: string; readonly transcript: string;
  readonly started_at?: string; readonly ended_at?: string; readonly time_zone?: string;
}
/**
 * What a source imports by itself: nothing, the meetings the person captured, or one folder's. A watch's project is only a
 * suggestion; it grants no read.
 */
export type PersonMeetingWatchV2 = 'off' | 'mine' | 'folder';
/** Custom submissions are reserved for the synthetic staging provider. */
export type PersonSubmittedMeetingV2 = PersonSyntheticMeetingV1;
export type PersonMeetingOperationV2 =
  | { readonly operation: 'home' }
  /** `folder_id` null browses the person's own recent meetings. */
  | { readonly operation: 'browse'; readonly folder_id: string | null } | { readonly operation: 'open'; readonly meeting_id: string }
  /** `folder_id` is set exactly for `folder`; `off` names no project. */
  | { readonly operation: 'watch'; readonly watch: PersonMeetingWatchV2; readonly folder_id: string | null; readonly project_id: string | null; readonly settings_sha256: string; readonly retain: true }
  | { readonly operation: 'import'; readonly meeting_id: string; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'submit'; readonly meeting: PersonSubmittedMeetingV2; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'cancel_import'; readonly source_key: string; readonly meeting_id: string };
export type PersonMeetingRequestV2 = PersonMeetingOperationV2 & { readonly schema_version: 2; readonly tool_id: string };
export interface PersonMeetingRowV2 { readonly id: string; readonly title: string; readonly date: string }
export interface PersonMeetingHomeV2 {
  readonly connected: boolean; readonly email: string | null; readonly workspace: string | null;
  readonly folders: readonly { readonly id: string; readonly title: string; readonly count: number }[]; readonly settings_sha256: string;
  /** `project_id` is the watch's suggested project. */
  readonly sources: readonly { readonly source_key: string; readonly watch: PersonMeetingWatchV2; readonly folder_id: string | null; readonly project_id: string | null; readonly baseline: boolean; readonly pending_imports: readonly string[]; readonly checked_at: string | null; readonly error: string | null }[];
}
export interface PersonMeetingResultsV2 {
  home: PersonMeetingHomeV2; browse: { readonly meetings: readonly PersonMeetingRowV2[] };
  open: { readonly id: string; readonly title: string; readonly notes: string; readonly summary: string; readonly truncated: boolean };
  watch: { readonly status: 'saved' }; import: { readonly status: 'queued' }; cancel_import: { readonly status: 'cancelled' };
  submit: { readonly status: 'queued'; readonly meeting_id: string };
}
const fields: Record<PersonMeetingOperationV2['operation'], readonly string[]> = {
  home: [], browse: ['folder_id'], open: ['meeting_id'],
  watch: ['watch', 'folder_id', 'project_id', 'settings_sha256', 'retain'], import: ['meeting_id', 'project_id', 'retain'],
  submit: ['meeting', 'project_id', 'retain'],
  cancel_import: ['source_key', 'meeting_id'],
};
const label = 'Personal meeting request';
const WATCHES: readonly unknown[] = ['off', 'mine', 'folder'];
/** A watch names its folder exactly when it watches one, and stopping names no project. */
function watchShape(watch: unknown, folder: unknown, project: unknown): boolean { return WATCHES.includes(watch) && (watch === 'folder') === (folder !== null) && (watch !== 'off' || project === null); }
function text(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(label);
}
function digest(value: unknown): asserts value is string { text(value); if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail('Invalid meeting digest'); }
export function validatePersonSyntheticMeetingV1(value: unknown): PersonSyntheticMeetingV1 {
  const row = asEnumerableRecord(value, 'Synthetic meeting');
  assertExactKeys(row, ['id', 'title', 'notes', 'transcript', ...['started_at', 'ended_at', 'time_zone'].filter(key => Object.hasOwn(row, key))], 'Synthetic meeting');
  if (row.started_at !== undefined) assertTimestamp(row.started_at, 'Synthetic meeting start');
  if (row.ended_at !== undefined) {
    assertTimestamp(row.ended_at, 'Synthetic meeting end');
    if (row.started_at === undefined || Date.parse(row.ended_at as string) < Date.parse(row.started_at as string)) fail('Invalid synthetic meeting time range');
  }
  if (row.time_zone !== undefined) {
    text(row.time_zone, 100);
    if (row.started_at === undefined) fail('Synthetic meeting time zone requires a start');
    try { new Intl.DateTimeFormat('en', { timeZone: row.time_zone }); } catch { fail('Invalid synthetic meeting time zone'); }
  }
  text(row.id, 128); text(row.title, 200);
  if (!/^synthetic-custom-[a-z0-9][a-z0-9-]*$/.test(row.id) || row.title.trim() !== row.title ||
      typeof row.notes !== 'string' || typeof row.transcript !== 'string' ||
      (!row.notes.trim() && !row.transcript.trim()) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.notes + row.transcript) ||
      utf8ByteLength(JSON.stringify(row)) > PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1) fail('Invalid synthetic meeting');
  return Object.freeze({ ...row }) as unknown as PersonSyntheticMeetingV1;
}
function validateMeetingOperationFields(row: Record<string, unknown>, operation: PersonMeetingOperationV2['operation']): void {
  for (const key of fields[operation]) {
    const item = row[key];
    if (key === 'retain') { if (item !== true) fail('Meeting retention consent is required'); }
    else if (key === 'meeting') validatePersonSyntheticMeetingV1(item);
    else if (key === 'watch') { if (!WATCHES.includes(item)) fail(label); }
    else if ((key === 'project_id' || key === 'folder_id') && item === null) continue;
    else { text(item); if (key.endsWith('_sha256')) digest(item); }
  }
  if ('project_id' in row && row.project_id !== null) validateProjectIdV1(row.project_id);
  if (operation === 'submit' && row.tool_id !== 'synthetic') fail('Custom meeting submission is available only through the synthetic staging tool');
  if (operation === 'watch' && !watchShape(row.watch, row.folder_id, row.project_id)) fail(label);
}
export function validatePersonMeetingRequestV2(value: unknown): PersonMeetingRequestV2 {
  const row = asEnumerableRecord(value, label), operation = row.operation as PersonMeetingOperationV2['operation'];
  if (!Object.hasOwn(fields, operation) || row.schema_version !== 2) fail(label);
  assertExactKeys(row, ['schema_version', 'tool_id', 'operation', ...fields[operation]], label); text(row.tool_id, 64);
  validateMeetingOperationFields(row, operation);
  return Object.freeze({ ...row }) as PersonMeetingRequestV2;
}
/** Transport and UTF-8 bounds apply before parsing; typed response checks also run at the Authority. */
export function validatePersonMeetingResultV2<K extends keyof PersonMeetingResultsV2>(operation: K, value: unknown): PersonMeetingResultsV2[K] {
  const row = asEnumerableRecord(value, 'Personal meeting response');
  const keys = { home: ['connected','email','workspace','folders','settings_sha256','sources'], browse: ['meetings'], open: ['id','title','notes','summary','truncated'],
    watch: ['status'], import: ['status'], submit: ['status','meeting_id'], cancel_import: ['status'] };
  assertExactKeys(row, keys[operation], 'Personal meeting response');
  if (utf8ByteLength(JSON.stringify(row)) > 120_000) fail('Personal meeting response exceeds its bound');
  const object = (value: unknown, keys: readonly string[], optional: readonly string[] = []) => {
    const item = asEnumerableRecord(value, 'Meeting response item');
    assertExactKeys(item, [...keys, ...optional.filter(key => Object.hasOwn(item, key))], 'Meeting response item');
    return item;
  };
  const array = (value: unknown, limit: number): unknown[] => { if (!Array.isArray(value) || value.length > limit) fail('Invalid meeting collection'); return value; };
  const nullableText = (value: unknown) => { if (value !== null) text(value, 512); };
  const project = (value: unknown) => validateProjectIdV1(value);
  if (operation === 'home') {
    if (typeof row.connected !== 'boolean') fail('Invalid meeting connection');
    nullableText(row.email); nullableText(row.workspace); digest(row.settings_sha256);
    for (const value of array(row.folders, 200)) { const item = object(value, ['id','title','count']); text(item.id); text(item.title, 128); if (!Number.isSafeInteger(item.count) || (item.count as number) < 0) fail('Invalid folder count'); }
    for (const value of array(row.sources, 100)) {
      const item = object(value, ['source_key','watch','folder_id','project_id','baseline','pending_imports','checked_at','error']);
      text(item.source_key); nullableText(item.folder_id); if (item.project_id !== null) project(item.project_id); nullableText(item.error);
      if (!watchShape(item.watch, item.folder_id, item.project_id)) fail('Invalid meeting watch');
      if (typeof item.baseline !== 'boolean') fail('Invalid folder baseline'); if (item.checked_at !== null) assertTimestamp(item.checked_at, 'Meeting check timestamp');
      for (const id of array(item.pending_imports, 50)) text(id);
    }
  }
  if (operation === 'browse') for (const value of array(row.meetings, 50)) { const item = object(value, ['id','title','date']); text(item.id); text(item.title, 256); text(item.date, 128); }
  if (operation === 'open') {
    text(row.id); text(row.title, 256);
    if (typeof row.notes !== 'string' || row.notes.length > 8000 || typeof row.summary !== 'string' || row.summary.length > 8000 || typeof row.truncated !== 'boolean') fail('Invalid meeting preview');
  }
  const statuses = { watch: ['saved'], import: ['queued'], submit: ['queued'], cancel_import: ['cancelled'] };
  if (operation === 'submit') {
    text(row.meeting_id, 128);
    if (!/^synthetic-custom-[a-z0-9][a-z0-9-]*$/.test(row.meeting_id)) fail('Invalid submitted meeting id');
  }
  if (operation in statuses && !(statuses[operation as keyof typeof statuses] as readonly unknown[]).includes(row.status)) fail('Invalid meeting outcome');
  return Object.freeze({ ...row }) as unknown as PersonMeetingResultsV2[K];
}
export function personMeetingCommandV2<K extends PersonMeetingOperationV2['operation']>(host: PersonToolHostV1, request: PersonMeetingRequestV2 & { readonly operation: K }): Promise<PersonMeetingResultsV2[K]> {
  // A custom staging meeting is up to 48 KiB, past the ordinary 16 KiB request body.
  return host.withToolSession(session => session.transport.json({ path: PERSON_MEETINGS_PATH_V2, body: validatePersonMeetingRequestV2(request), validate_request: validatePersonMeetingRequestV2,
    validate_response: value => validatePersonMeetingResultV2(request.operation, value), maximum_request_bytes: PERSON_TOOL_REQUEST_MAX_BYTES_V1, maximum_response_bytes: 128 * 1024, timeout_ms: 75_000 }));
}
