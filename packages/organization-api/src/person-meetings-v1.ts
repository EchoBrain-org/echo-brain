import { validateProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, assertExactKeys, assertTimestamp, utf8ByteLength, fail } from './validation.js';
import type { PersonToolHostV1 } from './person-tool-client.js';

export const PERSON_MEETINGS_PATH_V1 = '/v1/person/meetings';
export type PersonMeetingOperationV1 =
  | { readonly operation: 'home' }
  | { readonly operation: 'reviews' }
  | { readonly operation: 'browse'; readonly folder_id: string }
  | { readonly operation: 'open'; readonly meeting_id: string }
  | { readonly operation: 'watch'; readonly folder_id: string | null; readonly project_id: string | null; readonly settings_sha256: string; readonly retain: true }
  | { readonly operation: 'import'; readonly meeting_id: string; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'cancel_import'; readonly source_key: string; readonly meeting_id: string }
  | { readonly operation: 'review_open'; readonly approval_id: string }
  | { readonly operation: 'review'; readonly approval_id: string; readonly command_id: string; readonly snapshot_sha256: string; readonly action: 'approve' | 'reject'; readonly project_id: string | null; readonly share_transcript: boolean };
export type PersonMeetingRequestV1 = PersonMeetingOperationV1 & { readonly schema_version: 1; readonly tool_id: string };
export interface PersonMeetingRowV1 { readonly id: string; readonly title: string; readonly date: string }
export interface PersonMeetingHomeV1 {
  readonly connected: boolean; readonly email: string | null; readonly workspace: string | null;
  readonly folders: readonly { readonly id: string; readonly title: string; readonly count: number }[];
  readonly settings_sha256: string;
  readonly sources: readonly { readonly source_key: string; readonly folder_id: string | null; readonly project_id: string | null; readonly baseline: boolean; readonly pending_imports: readonly string[]; readonly checked_at: string | null; readonly error: string | null }[];
}
export interface PersonMeetingReviewV1 {
  readonly approval_id: string; readonly title: string; readonly project_id: string | null;
  readonly status: 'pending' | 'publishing' | 'approved' | 'rejected' | 'superseded';
}
export interface PersonMeetingResultsV1 {
  home: PersonMeetingHomeV1;
  browse: { readonly meetings: readonly PersonMeetingRowV1[] };
  open: { readonly id: string; readonly title: string; readonly notes: string; readonly summary: string; readonly truncated: boolean };
  watch: { readonly status: 'saved' };
  import: { readonly status: 'queued' };
  cancel_import: { readonly status: 'cancelled' };
  reviews: { readonly reviews: readonly PersonMeetingReviewV1[] };
  review_open: { readonly review: PersonMeetingReviewV1; readonly snapshot_sha256: string; readonly content: string };
  review: { readonly status: 'publishing' | 'approved' | 'rejected' };
}
const fields: Record<PersonMeetingOperationV1['operation'], readonly string[]> = {
  home: [], reviews: [], browse: ['folder_id'], open: ['meeting_id'],
  watch: ['folder_id', 'project_id', 'settings_sha256', 'retain'], import: ['meeting_id', 'project_id', 'retain'],
  cancel_import: ['source_key', 'meeting_id'], review_open: ['approval_id'],
  review: ['approval_id', 'command_id', 'snapshot_sha256', 'action', 'project_id', 'share_transcript'],
};
const label = 'Personal meeting request';
function text(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(label);
}
export function validatePersonMeetingRequestV1(value: unknown): PersonMeetingRequestV1 {
  const row = asEnumerableRecord(value, label);
  const operation = row.operation as PersonMeetingOperationV1['operation'];
  if (!Object.hasOwn(fields, operation) || row.schema_version !== 1) fail(label);
  assertExactKeys(row, ['schema_version', 'tool_id', 'operation', ...fields[operation]], label);
  text(row.tool_id, 64);
  for (const key of fields[operation]) {
    const item = row[key];
    if (key === 'retain') { if (item !== true) fail('Meeting retention consent is required'); }
    else if (key === 'share_transcript') { if (typeof item !== 'boolean') fail(label); }
    else if ((key === 'project_id' || (key === 'folder_id' && operation === 'watch')) && item === null) continue;
    else { text(item); if (key.endsWith('_sha256') && !/^sha256:[a-f0-9]{64}$/.test(item)) fail(label); }
  }
  if ('project_id' in row && row.project_id !== null) validateProjectIdV1(row.project_id);
  if (operation === 'review') {
    text(row.command_id, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(row.command_id)) fail(label);
  }
  if (operation === 'watch' && (row.folder_id === null) !== (row.project_id === null)) fail(label);
  if (operation === 'review' && (row.action !== 'approve' && row.action !== 'reject')) fail(label);
  if (operation === 'review' && row.action === 'reject' && (row.project_id !== null || row.share_transcript !== false)) fail(label);
  return Object.freeze({ ...row }) as PersonMeetingRequestV1;
}
/** Transport and UTF-8 bounds apply before parsing; typed response checks also run at the Authority. */
export function validatePersonMeetingResultV1<K extends keyof PersonMeetingResultsV1>(operation: K, value: unknown): PersonMeetingResultsV1[K] {
  const row = asEnumerableRecord(value, 'Personal meeting response');
  const keys = { home: ['connected','email','workspace','folders','settings_sha256','sources'], browse: ['meetings'], open: ['id','title','notes','summary','truncated'],
    watch: ['status'], import: ['status'], cancel_import: ['status'], reviews: ['reviews'], review_open: ['review','snapshot_sha256','content'], review: ['status'] };
  assertExactKeys(row, keys[operation], 'Personal meeting response');
  if (utf8ByteLength(JSON.stringify(row)) > 120_000) fail('Personal meeting response exceeds its bound');
  const object = (value: unknown, keys: readonly string[]) => { const item = asEnumerableRecord(value, 'Meeting response item'); assertExactKeys(item, keys, 'Meeting response item'); return item; };
  const array = (value: unknown, limit: number): unknown[] => { if (!Array.isArray(value) || value.length > limit) fail('Invalid meeting collection'); return value; };
  const nullableText = (value: unknown) => { if (value !== null) text(value, 512); };
  const project = (value: unknown) => { if (value !== null) validateProjectIdV1(value); };
  const digest = (value: unknown) => { text(value); if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail('Invalid meeting digest'); };
  const review = (value: unknown) => {
    const item = object(value, ['approval_id','title','project_id','status']); text(item.approval_id); text(item.title, 1024); project(item.project_id);
    if (!['pending','publishing','approved','rejected','superseded'].includes(String(item.status))) fail('Invalid meeting review state');
  };
  if (operation === 'home') {
    if (typeof row.connected !== 'boolean') fail('Invalid meeting connection');
    nullableText(row.email); nullableText(row.workspace); digest(row.settings_sha256);
    for (const value of array(row.folders, 200)) {
      const item = object(value, ['id','title','count']); text(item.id); text(item.title, 128);
      if (!Number.isSafeInteger(item.count) || (item.count as number) < 0) fail('Invalid folder count');
    }
    for (const value of array(row.sources, 100)) {
      const item = object(value, ['source_key','folder_id','project_id','baseline','pending_imports','checked_at','error']);
      text(item.source_key); nullableText(item.folder_id); project(item.project_id); nullableText(item.error);
      if (typeof item.baseline !== 'boolean') fail('Invalid folder baseline');
      if (item.checked_at !== null) assertTimestamp(item.checked_at, 'Meeting check timestamp');
      for (const id of array(item.pending_imports, 50)) text(id);
    }
  }
  if (operation === 'browse') for (const value of array(row.meetings, 50)) {
    const item = object(value, ['id','title','date']); text(item.id); text(item.title, 256); text(item.date, 128);
  }
  if (operation === 'reviews') for (const item of array(row.reviews, 100)) review(item);
  if (operation === 'review_open') { review(row.review); digest(row.snapshot_sha256); if (typeof row.content !== 'string') fail('Invalid review content'); }
  if (operation === 'open') {
    text(row.id); text(row.title, 256);
    if (typeof row.notes !== 'string' || row.notes.length > 8000 || typeof row.summary !== 'string' || row.summary.length > 8000 || typeof row.truncated !== 'boolean') fail('Invalid meeting preview');
  }
  const statuses = { watch: ['saved'], import: ['queued'], cancel_import: ['cancelled'], review: ['publishing','approved','rejected'] };
  if (operation in statuses && !(statuses[operation as keyof typeof statuses] as readonly unknown[]).includes(row.status)) fail('Invalid meeting outcome');
  return Object.freeze({ ...row }) as unknown as PersonMeetingResultsV1[K];
}
export function personMeetingCommandV1<K extends PersonMeetingOperationV1['operation']>(host: PersonToolHostV1, request: PersonMeetingRequestV1 & { readonly operation: K }): Promise<PersonMeetingResultsV1[K]> {
  return host.withToolSession(session => session.transport.json({ path: PERSON_MEETINGS_PATH_V1, body: validatePersonMeetingRequestV1(request), validate_request: validatePersonMeetingRequestV1,
    validate_response: value => validatePersonMeetingResultV1(request.operation, value), maximum_response_bytes: 128 * 1024, timeout_ms: 75_000 }));
}
