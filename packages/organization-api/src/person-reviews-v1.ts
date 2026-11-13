import { validateProjectIdV1 } from './project-context-v1.js';
import { PERSON_TOOL_REQUEST_MAX_BYTES_V1, type PersonToolHostV1 } from './person-tool-client.js';
import { asEnumerableRecord, assertExactKeys, assertTimestamp, fail, utf8ByteLength } from './validation.js';

/**
 * Meeting reviews (ADR-0046) belong to the authenticated person, independently of connected or advertised source tools:
 * `reviews` lists the caller's, `review_open` opens one card, and `review` approves or rejects it.
 */
export const PERSON_REVIEWS_PATH_V1 = '/v1/person/reviews';
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

export type PersonReviewOperationV1 =
  | { readonly operation: 'reviews' }
  | { readonly operation: 'review_open'; readonly approval_id: string }
  | { readonly operation: 'review'; readonly approval_id: string; readonly command_id: string; readonly snapshot_sha256: string; readonly action: 'approve' | 'reject'; readonly routes: readonly PersonMeetingRouteV2[]; readonly owners: readonly { readonly signal_id: string; readonly owner: string }[] };
export type PersonReviewRequestV1 = PersonReviewOperationV1 & { readonly schema_version: 1 };
export interface PersonReviewResultsV1 {
  reviews: { readonly reviews: readonly PersonMeetingReviewV2[] };
  review_open: { readonly review: PersonMeetingReviewV2; readonly snapshot_sha256: string; readonly participants: readonly string[];
    readonly items: readonly PersonMeetingReviewItemV2[]; readonly reasons: readonly PersonMeetingReviewReasonV2[];
    /** Names for every project id the items name that the reviewer can read. */
    readonly suggested_projects: readonly { readonly project_id: string; readonly name: string }[];
    readonly records: readonly PersonMeetingRecordV2[] };
  review: { readonly status: 'publishing' | 'approved' | 'rejected'; readonly decided_on: 'desktop' | 'slack' };
}
const fields: Record<PersonReviewOperationV1['operation'], readonly string[]> = {
  reviews: [], review_open: ['approval_id'], review: ['approval_id', 'command_id', 'snapshot_sha256', 'action', 'routes', 'owners'],
};
const label = 'Personal review request';
/** A signal id as records carry it. */
const SIGNAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** At most this many routes: one per decision and action of a meeting. */
const ROUTES_MAX = 500;
function text(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(label);
}
function digest(value: unknown): asserts value is string { text(value); if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail('Invalid meeting digest'); }
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
export function validatePersonReviewRequestV1(value: unknown): PersonReviewRequestV1 {
  const row = asEnumerableRecord(value, label), operation = row.operation as PersonReviewOperationV1['operation'];
  if (row.schema_version !== 1) fail('Personal review request version is unsupported');
  if (typeof operation !== 'string' || !Object.hasOwn(fields, operation)) fail(label);
  assertExactKeys(row, ['schema_version', 'operation', ...fields[operation]], label);
  for (const key of fields[operation]) {
    const item = row[key];
    if (key === 'routes') routes(item);
    else if (key === 'owners') ownerChoices(item);
    else { text(item); if (key.endsWith('_sha256')) digest(item); }
  }
  if (operation === 'review') {
    const review = row as PersonReviewRequestV1 & { readonly operation: 'review' };
    text(row.command_id, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(row.command_id) || (row.action !== 'approve' && row.action !== 'reject')) fail(label);
    // An approval keeps at least one item and names at most 20 projects; a rejection routes and owns nothing.
    if (review.action === 'reject' ? review.routes.length !== 0 || review.owners.length !== 0
      : review.routes.every(route => route.project_ids === null) || new Set(review.routes.flatMap(route => route.project_ids ?? [])).size > 20) fail(label);
  }
  return Object.freeze({ ...row }) as PersonReviewRequestV1;
}
/** Transport and UTF-8 bounds apply before parsing; typed response checks also run at the Authority. */
export function validatePersonReviewResultV1<K extends keyof PersonReviewResultsV1>(operation: K, value: unknown): PersonReviewResultsV1[K] {
  if (typeof operation !== 'string' || !Object.hasOwn(fields, operation)) fail('Personal review response operation is invalid');
  const row = asEnumerableRecord(value, 'Personal review response');
  const keys = { reviews: ['reviews'], review_open: ['review','snapshot_sha256','participants','items','reasons','suggested_projects','records'], review: ['status','decided_on'] };
  assertExactKeys(row, keys[operation], 'Personal review response');
  if (utf8ByteLength(JSON.stringify(row)) > 120_000) fail('Personal review response exceeds its bound');
  const object = (value: unknown, keys: readonly string[], optional: readonly string[] = []) => {
    const item = asEnumerableRecord(value, 'Meeting response item');
    assertExactKeys(item, [...keys, ...optional.filter(key => Object.hasOwn(item, key))], 'Meeting response item');
    return item;
  };
  const array = (value: unknown, limit: number): unknown[] => { if (!Array.isArray(value) || value.length > limit) fail('Invalid meeting collection'); return value; };
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
  if (operation === 'review' && (!['publishing','approved','rejected'].includes(String(row.status)) || !['desktop', 'slack'].includes(String(row.decided_on)))) fail('Invalid meeting outcome');
  return Object.freeze({ ...row }) as unknown as PersonReviewResultsV1[K];
}
export function personReviewCommandV1<K extends PersonReviewOperationV1['operation']>(host: PersonToolHostV1, request: PersonReviewRequestV1 & { readonly operation: K }): Promise<PersonReviewResultsV1[K]> {
  const body = validatePersonReviewRequestV1(request);
  return host.withToolSession(session => session.transport.json({ path: PERSON_REVIEWS_PATH_V1, body, validate_request: validatePersonReviewRequestV1,
    validate_response: value => validatePersonReviewResultV1(request.operation, value), maximum_request_bytes: PERSON_TOOL_REQUEST_MAX_BYTES_V1, maximum_response_bytes: 128 * 1024, timeout_ms: 75_000 }));
}
