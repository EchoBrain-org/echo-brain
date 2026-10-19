import type { PersonMeetingRefV1 } from './person-list-v1.js';
import type { PersonOpenItemKindV1, PersonOpenItemStateV1, PersonOpenItemVerdictV1 } from './person-runs-v1.js';
import { asEnumerableRecord, assertDigest, assertExactKeys, assertTimestamp, fail } from './validation.js';

/**
 * A shared follow-up (an open item, ADR-0033) as Ask evidence (ADR-0040).
 * The citation names the item and nothing else: what the item says is read
 * again, under the viewer's own access, wherever it is shown.
 */
export interface PersonFollowUpCitationV1 {
  readonly kind: 'follow_up';
  /** The open item's id, as the runs API names it. */
  readonly item_id: string;
}

/**
 * Opens the follow-up's item page: the runs API's `item` operation reads it
 * under the viewer's access. Not a person-open (ADR-0024) ref.
 */
export type PersonFollowUpRefV1 = `follow_up:itm_${string}`;

/**
 * The bounds of a follow-up's fields: the open items API's bounds for the
 * same values (names, decided lines, `expected`, an item's status and due
 * date), and a title of one line as long as an item's `says_now`.
 */
export const PERSON_FOLLOW_UP_EVIDENCE_LIMITS_V1 = Object.freeze({ title_chars: 300, owner_chars: 200, due_chars: 128, expected_chars: 120, decision_title_chars: 200, first_line_chars: 300 });

/** The latest check of a follow-up: its verdict and when it was made. Who made it is not read. */
export interface PersonFollowUpCheckV1 {
  readonly verdict: PersonOpenItemVerdictV1;
  readonly checked_at: string;
}

/** The follow-up's decision, only for an asker who reads that decision now. */
export interface PersonFollowUpDecisionV1 {
  readonly title: string;
  /** The impact card's first decided line, when it has one. */
  readonly first_line?: string;
  /** The approved meeting the decision is in. Server-held, like every desk ref: never shown to a model. */
  readonly ref: PersonMeetingRefV1;
}

/**
 * Everything Ask reads of one follow-up (ADR-0040). Each field is one the
 * open-items policy shows this asker:
 * - `title`: the item's current title in its tool when the asker opened it
 *   there in this request, else ECHO's `expected` phrase, else `Follow-up`;
 * - `owner`, `status`, `check` and `expected`: ECHO's own row facts;
 * - `created_at`, `sent_at` and `reassigned_at`: ECHO's own dates, which the
 *   runs API shows whoever sees the row (research tool contract v1);
 * - `due_at`: from the item's tool, only with a title read from it;
 * - `decision`: only for an asker who reads the decision now.
 */
export interface PersonFollowUpEvidenceV1 {
  readonly item_id: string;
  readonly kind: PersonOpenItemKindV1;
  readonly title: string;
  /** The owner's current directory display name. */
  readonly owner: string;
  readonly status: PersonOpenItemStateV1;
  /**
   * When ECHO created it: the open item's `created_at`. ECHO's follow-ups source always sets it; evidence built without it
   * (as before research tool contract v1) still validates, and its desk item then has no created date.
   */
  readonly created_at?: string;
  /** When Send sent it: the open item's `sent_at`; absent while it is unsent. */
  readonly sent_at?: string;
  /** When its owner was last picked or reassigned: the open item's `owner_set_at`; absent while ECHO's own match stands. */
  readonly reassigned_at?: string;
  readonly due_at?: string;
  /** Absent when nobody has checked the item yet. */
  readonly check?: PersonFollowUpCheckV1;
  readonly decision?: PersonFollowUpDecisionV1;
  /** What the decision requires of the item; absent when it is the title. */
  readonly expected?: string;
}

const ITEM_ID = /^itm_[A-Za-z0-9-]{4,60}$/;
const FOLLOW_UP_REF = /^follow_up:itm_[A-Za-z0-9-]{4,60}$/;
const KINDS: readonly string[] = Object.keys({ action: true, ticket: true, page: true, slack_message: true, record: true, document: true } satisfies Record<PersonOpenItemKindV1, true>);
const STATES: readonly string[] = Object.keys({ unsent: true, open: true, done: true, not_relevant: true } satisfies Record<PersonOpenItemStateV1, true>);
const VERDICTS: readonly string[] = Object.keys({ landed: true, still_open: true, changed: true, unreadable: true } satisfies Record<PersonOpenItemVerdictV1, true>);
const LIMITS = PERSON_FOLLOW_UP_EVIDENCE_LIMITS_V1;

/** One trimmed NFC line of 1 to `maximum` characters, as the open items API bounds its lines. */
function line(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value !== value.normalize('NFC') ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || [...value].length > maximum) fail(`${label} is invalid`);
  return value;
}
function itemId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ITEM_ID.test(value)) fail(`${label} is invalid`);
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly string[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is invalid`);
  return value as T;
}
function optional(entry: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter(key => Object.hasOwn(entry, key));
}

export function validatePersonFollowUpCitationV1(value: unknown): PersonFollowUpCitationV1 {
  const entry = asEnumerableRecord(value, 'Follow-up citation');
  assertExactKeys(entry, ['kind', 'item_id'], 'Follow-up citation');
  if (entry.kind !== 'follow_up') fail('Follow-up citation kind is invalid');
  return Object.freeze({ kind: 'follow_up', item_id: itemId(entry.item_id, 'Follow-up citation item_id') });
}

export function validatePersonFollowUpRefV1(value: unknown, label = 'Follow-up ref'): PersonFollowUpRefV1 {
  if (typeof value !== 'string' || !FOLLOW_UP_REF.test(value)) fail(`${label} is invalid`);
  return value as PersonFollowUpRefV1;
}

/** The ref that opens the follow-up a citation names. */
export function personFollowUpRefV1(citation: Pick<PersonFollowUpCitationV1, 'item_id'>): PersonFollowUpRefV1 {
  return validatePersonFollowUpRefV1(`follow_up:${citation.item_id}`);
}

export function validatePersonFollowUpEvidenceV1(value: unknown): PersonFollowUpEvidenceV1 {
  const entry = asEnumerableRecord(value, 'Follow-up evidence');
  assertExactKeys(entry, ['item_id', 'kind', 'title', 'owner', 'status', ...optional(entry, ['created_at', 'sent_at', 'reassigned_at', 'due_at', 'check', 'decision', 'expected'])], 'Follow-up evidence');
  const title = line(entry.title, 'Follow-up title', LIMITS.title_chars);
  for (const key of ['created_at', 'sent_at', 'reassigned_at'] as const) if (Object.hasOwn(entry, key)) assertTimestamp(entry[key], `Follow-up ${key}`);
  let check: PersonFollowUpCheckV1 | undefined;
  if (Object.hasOwn(entry, 'check')) {
    const raw = asEnumerableRecord(entry.check, 'Follow-up check');
    assertExactKeys(raw, ['verdict', 'checked_at'], 'Follow-up check');
    assertTimestamp(raw.checked_at, 'Follow-up checked_at');
    check = Object.freeze({ verdict: oneOf<PersonOpenItemVerdictV1>(raw.verdict, VERDICTS, 'Follow-up check verdict'), checked_at: raw.checked_at });
  }
  let decision: PersonFollowUpDecisionV1 | undefined;
  if (Object.hasOwn(entry, 'decision')) {
    const raw = asEnumerableRecord(entry.decision, 'Follow-up decision');
    assertExactKeys(raw, ['title', 'ref', ...optional(raw, ['first_line'])], 'Follow-up decision');
    if (typeof raw.ref !== 'string' || !raw.ref.startsWith('meeting:')) fail('Follow-up decision ref is invalid');
    assertDigest(raw.ref.slice('meeting:'.length), 'Follow-up decision ref');
    decision = Object.freeze({
      title: line(raw.title, 'Follow-up decision title', LIMITS.decision_title_chars),
      ...(Object.hasOwn(raw, 'first_line') ? { first_line: line(raw.first_line, 'Follow-up decision first line', LIMITS.first_line_chars) } : {}),
      ref: raw.ref as PersonMeetingRefV1,
    });
  }
  const expected = Object.hasOwn(entry, 'expected') ? line(entry.expected, 'Follow-up expected', LIMITS.expected_chars) : undefined;
  if (expected === title) fail('Follow-up expected repeats its title');
  return Object.freeze({
    item_id: itemId(entry.item_id, 'Follow-up item_id'),
    kind: oneOf<PersonOpenItemKindV1>(entry.kind, KINDS, 'Follow-up kind'),
    title,
    owner: line(entry.owner, 'Follow-up owner', LIMITS.owner_chars),
    status: oneOf<PersonOpenItemStateV1>(entry.status, STATES, 'Follow-up status'),
    ...(Object.hasOwn(entry, 'created_at') ? { created_at: entry.created_at as string } : {}),
    ...(Object.hasOwn(entry, 'sent_at') ? { sent_at: entry.sent_at as string } : {}),
    ...(Object.hasOwn(entry, 'reassigned_at') ? { reassigned_at: entry.reassigned_at as string } : {}),
    ...(Object.hasOwn(entry, 'due_at') ? { due_at: line(entry.due_at, 'Follow-up due date', LIMITS.due_chars) } : {}),
    ...(check === undefined ? {} : { check }),
    ...(decision === undefined ? {} : { decision }),
    ...(expected === undefined ? {} : { expected }),
  });
}
