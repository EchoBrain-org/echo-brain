import { validateProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, assertExactKeys, assertTimestamp, utf8ByteLength, fail } from './validation.js';
import type { PersonToolHostV1 } from './person-tool-client.js';

export const PERSON_MEETINGS_PATH_V2 = '/v1/person/meetings';
export const PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1 = 48 * 1024;
/** Explicit content kinds; submitting notes never manufactures a transcript. */
export interface PersonSyntheticMeetingV1 {
  readonly id: string; readonly title: string; readonly notes: string; readonly transcript: string;
}
export type PersonMeetingOperationV2 =
  | { readonly operation: 'home' } | { readonly operation: 'reviews' }
  | { readonly operation: 'browse'; readonly folder_id: string } | { readonly operation: 'open'; readonly meeting_id: string }
  | { readonly operation: 'watch'; readonly folder_id: string | null; readonly project_id: string | null; readonly settings_sha256: string; readonly retain: true }
  | { readonly operation: 'import'; readonly meeting_id: string; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'submit'; readonly meeting: PersonSyntheticMeetingV1; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'cancel_import'; readonly source_key: string; readonly meeting_id: string }
  | { readonly operation: 'review_open'; readonly approval_id: string }
  | { readonly operation: 'review'; readonly approval_id: string; readonly command_id: string; readonly snapshot_sha256: string; readonly action: 'approve' | 'reject'; readonly project_ids: readonly string[]; readonly share_transcript: boolean; readonly owners: readonly { readonly signal_id: string; readonly owner: string }[] };
export type PersonMeetingRequestV2 = PersonMeetingOperationV2 & { readonly schema_version: 2; readonly tool_id: string };
export interface PersonMeetingRowV2 { readonly id: string; readonly title: string; readonly date: string }
export interface PersonMeetingHomeV2 {
  readonly connected: boolean; readonly email: string | null; readonly workspace: string | null;
  readonly folders: readonly { readonly id: string; readonly title: string; readonly count: number }[]; readonly settings_sha256: string;
  readonly sources: readonly { readonly source_key: string; readonly folder_id: string | null; readonly folder_project_id: string | null; readonly baseline: boolean; readonly pending_imports: readonly string[]; readonly checked_at: string | null; readonly error: string | null }[];
}
export interface PersonMeetingReviewV2 {
  readonly approval_id: string; readonly title: string; readonly project_ids: readonly string[];
  readonly status: 'pending' | 'publishing' | 'approved' | 'rejected' | 'superseded'; readonly decided_on: 'desktop' | 'slack' | null;
  /** The proposal's first decision, else its first action: one line of ECHO text, or null. */
  readonly first_line: string | null;
  readonly action_count: number;
  /** When the meeting started, when the meeting tool says. */
  readonly meeting_at: string | null;
}
export interface PersonMeetingResultsV2 {
  home: PersonMeetingHomeV2; browse: { readonly meetings: readonly PersonMeetingRowV2[] };
  open: { readonly id: string; readonly title: string; readonly notes: string; readonly summary: string; readonly truncated: boolean };
  watch: { readonly status: 'saved' }; import: { readonly status: 'queued' }; cancel_import: { readonly status: 'cancelled' };
  submit: { readonly status: 'queued'; readonly meeting_id: string };
  reviews: { readonly reviews: readonly PersonMeetingReviewV2[] };
  review_open: { readonly review: PersonMeetingReviewV2; readonly snapshot_sha256: string; readonly content: string; readonly owners: readonly { readonly signal_id: string; readonly action: string; readonly proposed: string }[]; readonly suggested_projects: readonly { readonly project_id: string; readonly name: string }[] };
  review: { readonly status: 'publishing' | 'approved' | 'rejected'; readonly decided_on: 'desktop' | 'slack' };
}
const fields: Record<PersonMeetingOperationV2['operation'], readonly string[]> = {
  home: [], reviews: [], browse: ['folder_id'], open: ['meeting_id'],
  watch: ['folder_id', 'project_id', 'settings_sha256', 'retain'], import: ['meeting_id', 'project_id', 'retain'],
  submit: ['meeting', 'project_id', 'retain'],
  cancel_import: ['source_key', 'meeting_id'], review_open: ['approval_id'],
  review: ['approval_id', 'command_id', 'snapshot_sha256', 'action', 'project_ids', 'share_transcript', 'owners'],
};
const label = 'Personal meeting request';
function text(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(label);
}
function digest(value: unknown): asserts value is string { text(value); if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail('Invalid meeting digest'); }
export function validatePersonSyntheticMeetingV1(value: unknown): PersonSyntheticMeetingV1 {
  const row = asEnumerableRecord(value, 'Synthetic meeting');
  assertExactKeys(row, ['id', 'title', 'notes', 'transcript'], 'Synthetic meeting');
  text(row.id, 128); text(row.title, 200);
  if (!/^synthetic-custom-[a-z0-9][a-z0-9-]*$/.test(row.id) || row.title.trim() !== row.title ||
      typeof row.notes !== 'string' || typeof row.transcript !== 'string' ||
      (!row.notes.trim() && !row.transcript.trim()) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.notes + row.transcript) ||
      utf8ByteLength(JSON.stringify(row)) > PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1) fail('Invalid synthetic meeting');
  return Object.freeze({ ...row }) as unknown as PersonSyntheticMeetingV1;
}
function projectIds(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 20) fail(label);
  let previous: string | undefined;
  for (const id of value) { validateProjectIdV1(id); if (previous !== undefined && previous >= id) fail(label); previous = id; }
}
function ownerChoices(input: unknown): asserts input is readonly { readonly signal_id: string; readonly owner: string }[] {
  if (!Array.isArray(input) || input.length > 40) fail(label);
  const seen = new Set<string>();
  for (const value of input) {
    const item = asEnumerableRecord(value, label);
    assertExactKeys(item, ['signal_id', 'owner'], label);
    text(item.signal_id, 128); text(item.owner, 120);
    if (item.owner.trim() !== item.owner || /[\p{Cc}\p{Cf}]/u.test(item.owner) || seen.has(item.signal_id)) fail(label);
    seen.add(item.signal_id);
  }
}
export function validatePersonMeetingRequestV2(value: unknown): PersonMeetingRequestV2 {
  const row = asEnumerableRecord(value, label), operation = row.operation as PersonMeetingOperationV2['operation'];
  if (!Object.hasOwn(fields, operation) || row.schema_version !== 2) fail(label);
  assertExactKeys(row, ['schema_version', 'tool_id', 'operation', ...fields[operation]], label); text(row.tool_id, 64);
  for (const key of fields[operation]) {
    const item = row[key];
    if (key === 'retain') { if (item !== true) fail('Meeting retention consent is required'); }
    else if (key === 'meeting') validatePersonSyntheticMeetingV1(item);
    else if (key === 'share_transcript') { if (typeof item !== 'boolean') fail(label); }
    else if (key === 'project_ids') projectIds(item);
    else if (key === 'owners') ownerChoices(item);
    else if ((key === 'project_id' || (key === 'folder_id' && operation === 'watch')) && item === null) continue;
    else { text(item); if (key.endsWith('_sha256')) digest(item); }
  }
  if ('project_id' in row && row.project_id !== null) validateProjectIdV1(row.project_id);
  if (operation === 'submit' && row.tool_id !== 'synthetic') fail('Custom meetings require the synthetic staging tool');
  if (operation === 'review') {
    const review = row as PersonMeetingRequestV2 & { readonly operation: 'review' };
    text(row.command_id, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(row.command_id) || (row.action !== 'approve' && row.action !== 'reject')) fail(label);
    if (review.action === 'reject' && (review.project_ids.length !== 0 || review.share_transcript !== false || review.owners.length !== 0)) fail(label);
  }
  if (operation === 'watch' && (row.folder_id === null) !== (row.project_id === null)) fail(label);
  return Object.freeze({ ...row }) as PersonMeetingRequestV2;
}
/** Transport and UTF-8 bounds apply before parsing; typed response checks also run at the Authority. */
export function validatePersonMeetingResultV2<K extends keyof PersonMeetingResultsV2>(operation: K, value: unknown): PersonMeetingResultsV2[K] {
  const row = asEnumerableRecord(value, 'Personal meeting response');
  const keys = { home: ['connected','email','workspace','folders','settings_sha256','sources'], browse: ['meetings'], open: ['id','title','notes','summary','truncated'],
    watch: ['status'], import: ['status'], submit: ['status','meeting_id'], cancel_import: ['status'], reviews: ['reviews'], review_open: ['review','snapshot_sha256','content','owners','suggested_projects'], review: ['status','decided_on'] };
  assertExactKeys(row, keys[operation], 'Personal meeting response');
  if (utf8ByteLength(JSON.stringify(row)) > 120_000) fail('Personal meeting response exceeds its bound');
  const object = (value: unknown, keys: readonly string[]) => { const item = asEnumerableRecord(value, 'Meeting response item'); assertExactKeys(item, keys, 'Meeting response item'); return item; };
  const array = (value: unknown, limit: number): unknown[] => { if (!Array.isArray(value) || value.length > limit) fail('Invalid meeting collection'); return value; };
  const nullableText = (value: unknown) => { if (value !== null) text(value, 512); };
  const project = (value: unknown) => validateProjectIdV1(value);
  const review = (value: unknown) => {
    const item = object(value, ['approval_id','title','project_ids','status','decided_on','first_line','action_count','meeting_at']); text(item.approval_id); text(item.title, 1024); projectIds(item.project_ids);
    if (!['pending','publishing','approved','rejected','superseded'].includes(String(item.status)) || ![null, 'desktop', 'slack'].includes(item.decided_on as string | null)) fail('Invalid meeting review state');
    if (item.first_line !== null) text(item.first_line, 300);
    if (!Number.isSafeInteger(item.action_count) || (item.action_count as number) < 0) fail('Invalid meeting review action count');
    if (item.meeting_at !== null) assertTimestamp(item.meeting_at, 'Meeting review time');
  };
  if (operation === 'home') {
    if (typeof row.connected !== 'boolean') fail('Invalid meeting connection');
    nullableText(row.email); nullableText(row.workspace); digest(row.settings_sha256);
    for (const value of array(row.folders, 200)) { const item = object(value, ['id','title','count']); text(item.id); text(item.title, 128); if (!Number.isSafeInteger(item.count) || (item.count as number) < 0) fail('Invalid folder count'); }
    for (const value of array(row.sources, 100)) {
      const item = object(value, ['source_key','folder_id','folder_project_id','baseline','pending_imports','checked_at','error']);
      text(item.source_key); nullableText(item.folder_id); if (item.folder_project_id !== null) project(item.folder_project_id); nullableText(item.error);
      if (typeof item.baseline !== 'boolean') fail('Invalid folder baseline'); if (item.checked_at !== null) assertTimestamp(item.checked_at, 'Meeting check timestamp');
      for (const id of array(item.pending_imports, 50)) text(id);
    }
  }
  if (operation === 'browse') for (const value of array(row.meetings, 50)) { const item = object(value, ['id','title','date']); text(item.id); text(item.title, 256); text(item.date, 128); }
  if (operation === 'reviews') for (const item of array(row.reviews, 100)) review(item);
  if (operation === 'review_open') {
    review(row.review); digest(row.snapshot_sha256); if (typeof row.content !== 'string') fail('Invalid review content');
    for (const value of array(row.owners, 40)) {
      const item = object(value, ['signal_id','action','proposed']); text(item.signal_id, 128); text(item.action, 300); text(item.proposed, 300);
    }
    for (const value of array(row.suggested_projects, 20)) { const item = object(value, ['project_id','name']); project(item.project_id); text(item.name, 256); }
  }
  if (operation === 'open') {
    text(row.id); text(row.title, 256);
    if (typeof row.notes !== 'string' || row.notes.length > 8000 || typeof row.summary !== 'string' || row.summary.length > 8000 || typeof row.truncated !== 'boolean') fail('Invalid meeting preview');
  }
  const statuses = { watch: ['saved'], import: ['queued'], submit: ['queued'], cancel_import: ['cancelled'], review: ['publishing','approved','rejected'] };
  if (operation === 'submit') { text(row.meeting_id, 128); if (!/^synthetic-custom-[a-z0-9][a-z0-9-]*$/.test(row.meeting_id)) fail('Invalid synthetic meeting id'); }
  if (operation in statuses && !(statuses[operation as keyof typeof statuses] as readonly unknown[]).includes(row.status)) fail('Invalid meeting outcome');
  if (operation === 'review' && !['desktop', 'slack'].includes(String(row.decided_on))) fail('Invalid meeting decision surface');
  return Object.freeze({ ...row }) as unknown as PersonMeetingResultsV2[K];
}
export function personMeetingCommandV2<K extends PersonMeetingOperationV2['operation']>(host: PersonToolHostV1, request: PersonMeetingRequestV2 & { readonly operation: K }): Promise<PersonMeetingResultsV2[K]> {
  return host.withToolSession(session => session.transport.json({ path: PERSON_MEETINGS_PATH_V2, body: validatePersonMeetingRequestV2(request), validate_request: validatePersonMeetingRequestV2,
    validate_response: value => validatePersonMeetingResultV2(request.operation, value), maximum_response_bytes: 128 * 1024, timeout_ms: 75_000 }));
}
