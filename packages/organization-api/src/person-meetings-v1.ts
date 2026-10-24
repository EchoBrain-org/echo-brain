import { validateProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, assertExactKeys, assertTimestamp, utf8ByteLength, fail } from './validation.js';
import { PERSON_TOOL_REQUEST_MAX_BYTES_V1, type PersonToolHostV1 } from './person-tool-client.js';

export const PERSON_MEETINGS_PATH_V2 = '/v1/person/meetings';
export const PERSON_SYNTHETIC_MEETING_MAX_BYTES_V1 = 48 * 1024;
/** The tool every member hands a meeting in through, whatever tool recorded it. */
export const PERSON_HAND_IN_TOOL_ID_V1 = 'hand-in';
/** A handed-in meeting's JSON: with the request around it, it stays inside the Authority's 64 KiB provider-route body. */
export const PERSON_HAND_IN_MEETING_MAX_BYTES_V1 = 60 * 1024;
/** The id the Authority derives from a handed-in meeting's content: `hand-in-` and the hex of its canonical digest. */
export const PERSON_HAND_IN_MEETING_ID_V1 = /^hand-in-[a-f0-9]{64}$/;
/** Explicit content kinds; submitting notes never manufactures a transcript. */
export interface PersonSyntheticMeetingV1 {
  readonly id: string; readonly title: string; readonly notes: string; readonly transcript: string;
  readonly started_at?: string; readonly ended_at?: string; readonly time_zone?: string;
}
/**
 * A meeting handed in from any tool. It has no id: the Authority derives one from its content, so the same meeting
 * handed in twice is one meeting. Its text is canonical (`personHandInTextV1`). Its time is a start, with an optional end
 * and zone, or a whole day: the date at noon UTC with `all_day`. Notes or a transcript may be empty, not both.
 */
export interface PersonHandInMeetingV1 {
  readonly title: string; readonly notes: string; readonly transcript: string;
  readonly started_at?: string; readonly ended_at?: string; readonly time_zone?: string; readonly all_day?: true;
}
/** What `submit` carries: a synthetic meeting for the staging synthetic tool, a handed-in meeting for the hand-in tool. */
export type PersonSubmittedMeetingV2 = PersonSyntheticMeetingV1 | PersonHandInMeetingV1;
export type PersonMeetingOperationV2 =
  | { readonly operation: 'home' } | { readonly operation: 'reviews' }
  | { readonly operation: 'browse'; readonly folder_id: string } | { readonly operation: 'open'; readonly meeting_id: string }
  | { readonly operation: 'watch'; readonly folder_id: string | null; readonly project_id: string | null; readonly settings_sha256: string; readonly retain: true }
  | { readonly operation: 'import'; readonly meeting_id: string; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'submit'; readonly meeting: PersonSubmittedMeetingV2; readonly project_id: string | null; readonly retain: true }
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
/** Text as a handed-in meeting keeps it: line feeds only, NFC, no edge whitespace. Clients send it, so equal text derives one id. */
export function personHandInTextV1(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}
const handInLabel = 'Handed-in meeting';
/** Canonical text with no control but tab and line feed; a title is also one line of 1 to `maximum` code units. */
function handInText(value: unknown, maximum?: number): asserts value is string {
  if (typeof value !== 'string' || value !== personHandInTextV1(value) || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) ||
      (maximum !== undefined && (value.length === 0 || value.length > maximum || /[\t\n]/.test(value)))) fail(`Invalid ${handInLabel.toLowerCase()} text`);
}
export function validatePersonHandInMeetingV1(value: unknown): PersonHandInMeetingV1 {
  const row = asEnumerableRecord(value, handInLabel);
  assertExactKeys(row, ['title', 'notes', 'transcript', ...['started_at', 'ended_at', 'time_zone', 'all_day'].filter(key => Object.hasOwn(row, key))], handInLabel);
  handInText(row.title, 200); handInText(row.notes); handInText(row.transcript);
  if (row.notes === '' && row.transcript === '') fail('A handed-in meeting needs notes or a transcript');
  if (utf8ByteLength(JSON.stringify(row)) > PERSON_HAND_IN_MEETING_MAX_BYTES_V1) fail('Handed-in meeting exceeds its bound');
  if (row.started_at !== undefined) assertTimestamp(row.started_at, 'Handed-in meeting start');
  // A whole day is its date at noon UTC, the same calendar day from UTC-11 to UTC+11, so a reader that shows it in local
  // time keeps the day. It has no end or zone: one way to say it, so one id.
  if (row.all_day !== undefined && (row.all_day !== true || typeof row.started_at !== 'string' || !row.started_at.endsWith('T12:00:00.000Z') ||
      row.ended_at !== undefined || row.time_zone !== undefined)) fail('Invalid handed-in whole-day meeting');
  if (row.ended_at !== undefined) {
    assertTimestamp(row.ended_at, 'Handed-in meeting end');
    if (row.started_at === undefined || Date.parse(row.ended_at) < Date.parse(row.started_at as string)) fail('Invalid handed-in meeting time range');
  }
  if (row.time_zone !== undefined) {
    if (typeof row.time_zone !== 'string' || row.time_zone.length === 0 || row.time_zone.length > 100 || row.started_at === undefined) fail('Invalid handed-in meeting time zone');
    try { new Intl.DateTimeFormat('en', { timeZone: row.time_zone }); } catch { fail('Invalid handed-in meeting time zone'); }
  }
  return Object.freeze({ ...row }) as unknown as PersonHandInMeetingV1;
}
/**
 * The meeting a hand-in sends, from text as a person gave it: canonical text, and either a start (a UTC timestamp, with
 * its zone) or a whole day's date (YYYY-MM-DD). Throws when the result is not a valid handed-in meeting.
 */
export function personHandInMeetingV1(input: {
  readonly title: string; readonly notes: string; readonly transcript: string;
  readonly started_at?: string; readonly time_zone?: string; readonly date?: string;
}): PersonHandInMeetingV1 {
  if (input.date !== undefined && (input.started_at !== undefined || input.time_zone !== undefined || !/^\d{4}-\d{2}-\d{2}$/.test(input.date))) {
    fail('A handed-in meeting takes a start or a whole day');
  }
  return validatePersonHandInMeetingV1({
    title: personHandInTextV1(input.title), notes: personHandInTextV1(input.notes), transcript: personHandInTextV1(input.transcript),
    ...(input.date === undefined ? {} : { started_at: `${input.date}T12:00:00.000Z`, all_day: true }),
    ...(input.started_at === undefined ? {} : { started_at: input.started_at }),
    ...(input.time_zone === undefined ? {} : { time_zone: input.time_zone }),
  });
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
    else if (key === 'meeting') (row.tool_id === PERSON_HAND_IN_TOOL_ID_V1 ? validatePersonHandInMeetingV1 : validatePersonSyntheticMeetingV1)(item);
    else if (key === 'share_transcript') { if (typeof item !== 'boolean') fail(label); }
    else if (key === 'project_ids') projectIds(item);
    else if (key === 'owners') ownerChoices(item);
    else if ((key === 'project_id' || (key === 'folder_id' && operation === 'watch')) && item === null) continue;
    else { text(item); if (key.endsWith('_sha256')) digest(item); }
  }
  if ('project_id' in row && row.project_id !== null) validateProjectIdV1(row.project_id);
  if (operation === 'submit' && row.tool_id !== 'synthetic' && row.tool_id !== PERSON_HAND_IN_TOOL_ID_V1) fail('Meetings are submitted through the hand-in tool');
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
  if (operation === 'submit') {
    text(row.meeting_id, 128);
    if (!/^synthetic-custom-[a-z0-9][a-z0-9-]*$/.test(row.meeting_id) && !PERSON_HAND_IN_MEETING_ID_V1.test(row.meeting_id)) fail('Invalid submitted meeting id');
  }
  if (operation in statuses && !(statuses[operation as keyof typeof statuses] as readonly unknown[]).includes(row.status)) fail('Invalid meeting outcome');
  if (operation === 'review' && !['desktop', 'slack'].includes(String(row.decided_on))) fail('Invalid meeting decision surface');
  return Object.freeze({ ...row }) as unknown as PersonMeetingResultsV2[K];
}
export function personMeetingCommandV2<K extends PersonMeetingOperationV2['operation']>(host: PersonToolHostV1, request: PersonMeetingRequestV2 & { readonly operation: K }): Promise<PersonMeetingResultsV2[K]> {
  // A handed-in meeting is up to 60 KiB, past the ordinary 16 KiB request body.
  return host.withToolSession(session => session.transport.json({ path: PERSON_MEETINGS_PATH_V2, body: validatePersonMeetingRequestV2(request), validate_request: validatePersonMeetingRequestV2,
    validate_response: value => validatePersonMeetingResultV2(request.operation, value), maximum_request_bytes: PERSON_TOOL_REQUEST_MAX_BYTES_V1, maximum_response_bytes: 128 * 1024, timeout_ms: 75_000 }));
}
