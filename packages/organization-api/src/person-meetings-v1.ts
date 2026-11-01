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
  | { readonly operation: 'home' } | { readonly operation: 'reviews' }
  /** `folder_id` null browses the person's own recent meetings. */
  | { readonly operation: 'browse'; readonly folder_id: string | null } | { readonly operation: 'open'; readonly meeting_id: string }
  /** `folder_id` is set exactly for `folder`; `off` names no project. */
  | { readonly operation: 'watch'; readonly watch: PersonMeetingWatchV2; readonly folder_id: string | null; readonly project_id: string | null; readonly settings_sha256: string; readonly retain: true }
  | { readonly operation: 'import'; readonly meeting_id: string; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'submit'; readonly meeting: PersonSubmittedMeetingV2; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'cancel_import'; readonly source_key: string; readonly meeting_id: string }
  | { readonly operation: 'review_open'; readonly approval_id: string }
  | { readonly operation: 'review'; readonly approval_id: string; readonly command_id: string; readonly snapshot_sha256: string; readonly action: 'approve' | 'reject'; readonly routes: readonly PersonMeetingRouteV2[]; readonly owners: readonly { readonly signal_id: string; readonly owner: string }[] };
/**
 * Where one decision or action goes: null = not kept, [] = Only me, otherwise 1..20 project ids, sorted and unique.
 * `private: true` files it in those projects for the reviewer alone (ADR-0049); it needs a project and is sent only when true.
 */
export interface PersonMeetingRouteV2 { readonly signal_id: string; readonly project_ids: readonly string[] | null; readonly private?: true }
/** One published record of an approved meeting: its own approval id and its destination ([] = Only me; `private` as its route). */
export interface PersonMeetingRecordV2 { readonly approval_id: string; readonly project_ids: readonly string[]; readonly private?: true }
/** One decision or action of a review, in brief order (decisions first), with where it goes. */
export interface PersonMeetingReviewItemV2 {
  readonly signal_id: string; readonly kind: 'decision' | 'action'; readonly text: string; readonly subject: string | null;
  /** A decision's; null for an action. */
  readonly status: 'proposed' | 'decided' | 'unresolved' | null;
  /** An action's, as the meeting set it; null for a decision or when it set none. */
  readonly due_at: string | null;
  /** The meeting's own words. */
  readonly quotes: readonly string[];
  /** Pending: the owner the meeting proposes (editable). Decided: the owner the reviewer confirmed. */
  readonly owner: string | null; readonly owner_editable: boolean;
  /** Pending: the suggestion the reviewer can read now ([] = Only me). Decided: the chosen destination (null = not kept). */
  readonly project_ids: readonly string[] | null;
  /** Decided only: filed in `project_ids` for the reviewer alone. Present only when true. */
  readonly private?: true;
}
export interface PersonMeetingReviewReasonV2 { readonly signal_id: string; readonly text: string; readonly supports: readonly string[]; readonly quotes: readonly string[] }
export type PersonMeetingRequestV2 = PersonMeetingOperationV2 & { readonly schema_version: 2; readonly tool_id: string };
export interface PersonMeetingRowV2 { readonly id: string; readonly title: string; readonly date: string }
export interface PersonMeetingHomeV2 {
  readonly connected: boolean; readonly email: string | null; readonly workspace: string | null;
  readonly folders: readonly { readonly id: string; readonly title: string; readonly count: number }[]; readonly settings_sha256: string;
  /** `project_id` is the watch's suggested project. */
  readonly sources: readonly { readonly source_key: string; readonly watch: PersonMeetingWatchV2; readonly folder_id: string | null; readonly project_id: string | null; readonly baseline: boolean; readonly pending_imports: readonly string[]; readonly checked_at: string | null; readonly error: string | null }[];
}
export interface PersonMeetingReviewV2 {
  /** project_ids: pending, the suggestion the reviewer can read now; decided, every project the routes name. */
  readonly approval_id: string; readonly title: string; readonly project_ids: readonly string[];
  readonly status: 'pending' | 'publishing' | 'approved' | 'rejected' | 'superseded'; readonly decided_on: 'desktop' | 'slack' | null;
  /** The proposal's first decision, else its first action: one line of ECHO text, or null. */
  readonly first_line: string | null;
  readonly action_count: number;
  /** When the meeting started, when the meeting tool says. */
  readonly meeting_at: string | null;
  /** A whole-day meeting: `meeting_at`'s UTC date is its day, and it has no time of day to show. Never without `meeting_at`. */
  readonly all_day: boolean;
  /** The published records, one per destination: empty until the approval is published. */
  readonly records: readonly PersonMeetingRecordV2[];
}
export interface PersonMeetingResultsV2 {
  home: PersonMeetingHomeV2; browse: { readonly meetings: readonly PersonMeetingRowV2[] };
  open: { readonly id: string; readonly title: string; readonly notes: string; readonly summary: string; readonly truncated: boolean };
  watch: { readonly status: 'saved' }; import: { readonly status: 'queued' }; cancel_import: { readonly status: 'cancelled' };
  submit: { readonly status: 'queued'; readonly meeting_id: string };
  reviews: { readonly reviews: readonly PersonMeetingReviewV2[] };
  review_open: { readonly review: PersonMeetingReviewV2; readonly snapshot_sha256: string; readonly participants: readonly string[];
    readonly items: readonly PersonMeetingReviewItemV2[]; readonly reasons: readonly PersonMeetingReviewReasonV2[];
    /** Names for every project id the items name that the reviewer can read. */
    readonly suggested_projects: readonly { readonly project_id: string; readonly name: string }[];
    readonly records: readonly PersonMeetingRecordV2[] };
  review: { readonly status: 'publishing' | 'approved' | 'rejected'; readonly decided_on: 'desktop' | 'slack' };
}
const fields: Record<PersonMeetingOperationV2['operation'], readonly string[]> = {
  home: [], reviews: [], browse: ['folder_id'], open: ['meeting_id'],
  watch: ['watch', 'folder_id', 'project_id', 'settings_sha256', 'retain'], import: ['meeting_id', 'project_id', 'retain'],
  submit: ['meeting', 'project_id', 'retain'],
  cancel_import: ['source_key', 'meeting_id'], review_open: ['approval_id'],
  review: ['approval_id', 'command_id', 'snapshot_sha256', 'action', 'routes', 'owners'],
};
const label = 'Personal meeting request';
const WATCHES: readonly unknown[] = ['off', 'mine', 'folder'];
/** A watch names its folder exactly when it watches one, and stopping names no project. */
function watchShape(watch: unknown, folder: unknown, project: unknown): boolean { return WATCHES.includes(watch) && (watch === 'folder') === (folder !== null) && (watch !== 'off' || project === null); }
/** A signal id as records carry it. */
const SIGNAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** At most this many routes: one per decision and action of a meeting. */
const ROUTES_MAX = 500;
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
function projectIds(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 20) fail(label);
  let previous: string | undefined;
  for (const id of value) { validateProjectIdV1(id); if (previous !== undefined && previous >= id) fail(label); previous = id; }
}
/** A destination kept for the reviewer alone inside its projects says `private: true`, only then, and only with a project. */
function privateDestination(row: Record<string, unknown>, message: string): void {
  if (Object.hasOwn(row, 'private') && (row.private !== true || !Array.isArray(row.project_ids) || row.project_ids.length === 0)) fail(message);
}
function routes(value: unknown): asserts value is readonly PersonMeetingRouteV2[] {
  if (!Array.isArray(value) || value.length > ROUTES_MAX) fail(label);
  const seen = new Set<string>();
  for (const entry of value) {
    const route = asEnumerableRecord(entry, label);
    assertExactKeys(route, ['signal_id', 'project_ids', ...(Object.hasOwn(route, 'private') ? ['private'] : [])], label);
    if (typeof route.signal_id !== 'string' || !SIGNAL.test(route.signal_id) || seen.has(route.signal_id)) fail(label);
    seen.add(route.signal_id);
    if (route.project_ids !== null) projectIds(route.project_ids);
    privateDestination(route, label);
  }
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
/** The same review fields serve both the legacy meeting route and the person-owned review route. */
export type PersonMeetingReviewOperationV2 = Extract<PersonMeetingOperationV2, { readonly operation: 'reviews' | 'review_open' | 'review' }>;
function validateMeetingOperationFields(row: Record<string, unknown>, operation: PersonMeetingOperationV2['operation']): void {
  for (const key of fields[operation]) {
    const item = row[key];
    if (key === 'retain') { if (item !== true) fail('Meeting retention consent is required'); }
    else if (key === 'meeting') validatePersonSyntheticMeetingV1(item);
    else if (key === 'routes') routes(item);
    else if (key === 'owners') ownerChoices(item);
    else if (key === 'watch') { if (!WATCHES.includes(item)) fail(label); }
    else if ((key === 'project_id' || key === 'folder_id') && item === null) continue;
    else { text(item); if (key.endsWith('_sha256')) digest(item); }
  }
  if ('project_id' in row && row.project_id !== null) validateProjectIdV1(row.project_id);
  if (operation === 'submit' && row.tool_id !== 'synthetic') fail('Custom meeting submission is available only through the synthetic staging tool');
  if (operation === 'review') {
    const review = row as PersonMeetingRequestV2 & { readonly operation: 'review' };
    text(row.command_id, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(row.command_id) || (row.action !== 'approve' && row.action !== 'reject')) fail(label);
    // An approval keeps at least one item and names at most 20 projects; a rejection routes and owns nothing.
    if (review.action === 'reject' ? review.routes.length !== 0 || review.owners.length !== 0
      : review.routes.every(route => route.project_ids === null) || new Set(review.routes.flatMap(route => route.project_ids ?? [])).size > 20) fail(label);
  }
  if (operation === 'watch' && !watchShape(row.watch, row.folder_id, row.project_id)) fail(label);
}
export function validatePersonMeetingReviewOperationV2(value: unknown): PersonMeetingReviewOperationV2 {
  const row = asEnumerableRecord(value, label), operation = row.operation as PersonMeetingReviewOperationV2['operation'];
  if (!['reviews', 'review_open', 'review'].includes(operation)) fail(label);
  assertExactKeys(row, ['operation', ...fields[operation]], label);
  validateMeetingOperationFields(row, operation);
  return Object.freeze({ ...row }) as PersonMeetingReviewOperationV2;
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
    watch: ['status'], import: ['status'], submit: ['status','meeting_id'], cancel_import: ['status'], reviews: ['reviews'],
    review_open: ['review','snapshot_sha256','participants','items','reasons','suggested_projects','records'], review: ['status','decided_on'] };
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
  // The meeting's or the model's words: any text, line breaks included, bounded with the whole response.
  const words = (value: unknown, maximum = 20_000) => { if (typeof value !== 'string' || value.length === 0 || value.length > maximum) fail('Invalid meeting review text'); };
  const signal = (value: unknown) => { if (typeof value !== 'string' || !SIGNAL.test(value)) fail('Invalid meeting review signal'); };
  const quotes = (value: unknown) => { for (const quote of array(value, 200)) words(quote); };
  const records = (value: unknown) => {
    const seen = new Set<unknown>();
    for (const entry of array(value, ROUTES_MAX)) {
      const record = object(entry, ['approval_id','project_ids'], ['private']);
      if (typeof record.approval_id !== 'string' || !/^apr_[0-9a-f]{64}$/.test(record.approval_id) || seen.has(record.approval_id)) fail('Invalid meeting review record');
      seen.add(record.approval_id); projectIds(record.project_ids); privateDestination(record, 'Invalid meeting review record');
    }
  };
  const review = (value: unknown) => {
    const item = object(value, ['approval_id','title','project_ids','status','decided_on','first_line','action_count','meeting_at','all_day','records']); text(item.approval_id); text(item.title, 1024); projectIds(item.project_ids);
    if (!['pending','publishing','approved','rejected','superseded'].includes(String(item.status)) || ![null, 'desktop', 'slack'].includes(item.decided_on as string | null)) fail('Invalid meeting review state');
    if (item.first_line !== null) text(item.first_line, 300);
    if (!Number.isSafeInteger(item.action_count) || (item.action_count as number) < 0) fail('Invalid meeting review action count');
    if (item.meeting_at !== null) assertTimestamp(item.meeting_at, 'Meeting review time');
    if (typeof item.all_day !== 'boolean' || (item.all_day && item.meeting_at === null)) fail('Invalid meeting review time');
    records(item.records);
    if (item.status !== 'approved' && (item.records as unknown[]).length > 0) fail('Invalid meeting review record');
  };
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
  if (operation === 'reviews') for (const item of array(row.reviews, 100)) review(item);
  if (operation === 'review_open') {
    review(row.review); digest(row.snapshot_sha256); records(row.records);
    for (const name of array(row.participants, 500)) words(name, 1024);
    const items = new Set<unknown>();
    for (const value of array(row.items, ROUTES_MAX)) {
      const item = object(value, ['signal_id','kind','text','subject','status','due_at','quotes','owner','owner_editable','project_ids'], ['private']);
      signal(item.signal_id); if (items.has(item.signal_id)) fail('Invalid meeting review signal'); items.add(item.signal_id);
      words(item.text); if (item.subject !== null) words(item.subject); quotes(item.quotes);
      if (item.kind === 'decision' ? !['proposed','decided','unresolved'].includes(item.status as string) || item.due_at !== null
        : item.kind !== 'action' || item.status !== null) fail('Invalid meeting review item');
      if (item.due_at !== null) assertTimestamp(item.due_at, 'Meeting review due date');
      // An owner is an action's, one line of at most 120 characters; only a proposed one is editable.
      if (item.owner !== null && (item.kind !== 'action' || typeof item.owner !== 'string' || item.owner.length === 0 || item.owner.length > 120
        || item.owner.trim() !== item.owner || /[\p{Cc}\p{Cf}]/u.test(item.owner))) fail('Invalid meeting review owner');
      if (typeof item.owner_editable !== 'boolean' || (item.owner_editable && item.owner === null)) fail('Invalid meeting review owner');
      if (item.project_ids !== null) projectIds(item.project_ids);
      privateDestination(item, 'Invalid meeting review item');
    }
    for (const value of array(row.reasons, ROUTES_MAX)) {
      const item = object(value, ['signal_id','text','supports','quotes']); signal(item.signal_id); words(item.text); quotes(item.quotes);
      for (const supported of array(item.supports, 1000)) signal(supported);
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
    if (!/^synthetic-custom-[a-z0-9][a-z0-9-]*$/.test(row.meeting_id)) fail('Invalid submitted meeting id');
  }
  if (operation in statuses && !(statuses[operation as keyof typeof statuses] as readonly unknown[]).includes(row.status)) fail('Invalid meeting outcome');
  if (operation === 'review' && !['desktop', 'slack'].includes(String(row.decided_on))) fail('Invalid meeting decision surface');
  return Object.freeze({ ...row }) as unknown as PersonMeetingResultsV2[K];
}
export function personMeetingCommandV2<K extends PersonMeetingOperationV2['operation']>(host: PersonToolHostV1, request: PersonMeetingRequestV2 & { readonly operation: K }): Promise<PersonMeetingResultsV2[K]> {
  // A custom staging meeting is up to 48 KiB, past the ordinary 16 KiB request body.
  return host.withToolSession(session => session.transport.json({ path: PERSON_MEETINGS_PATH_V2, body: validatePersonMeetingRequestV2(request), validate_request: validatePersonMeetingRequestV2,
    validate_response: value => validatePersonMeetingResultV2(request.operation, value), maximum_request_bytes: PERSON_TOOL_REQUEST_MAX_BYTES_V1, maximum_response_bytes: 128 * 1024, timeout_ms: 75_000 }));
}
