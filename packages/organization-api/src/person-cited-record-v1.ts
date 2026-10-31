import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonRecordListItemV1 } from './person-records-v1.js';
import { asRecord, assertDigest, assertExactKeys, fail, oneOf, utf8ByteLength } from './validation.js';

/**
 * One approved meeting record as an Ask citation of it reads: what
 * `person records --record-sha256 <digest> --brief` prints in place of the
 * signed envelope. Each decision, action and rationale carries the atom id Ask
 * citations carry, so a reader can light the ones an answer cites; the
 * envelope, its signal and participant ids, identities and provenance stay
 * behind. Texts are display text (controls and format characters as spaces,
 * trimmed, never empty), each no longer than the record it comes from.
 */
export const PERSON_CITED_RECORD_KIND_V1 = 'echo-person-cited-record-v1';
/** Items kept per section, and participants named; `more` says others were left out. */
export const PERSON_CITED_RECORD_ITEMS_MAX_V1 = 32;
/** Quotes kept per item: its first distinct ones. */
export const PERSON_CITED_RECORD_QUOTES_MAX_V1 = 3;
/** An action's owner the approver confirmed, in characters. */
const OWNER_MAX_CHARACTERS = 120;
const TEXT_MAX_BYTES = 256 * 1024;
const TIMEZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

export type PersonCitedRecordPolicyV1 = 'organization-member-readable-person-v2' | 'restricted-reviewer-person-v2' | 'project-members-readable-person-v1';
const POLICIES: readonly PersonCitedRecordPolicyV1[] = ['organization-member-readable-person-v2', 'restricted-reviewer-person-v2', 'project-members-readable-person-v1'];
const STATUSES = ['proposed', 'decided', 'unresolved'] as const;
type Kind = 'decision' | 'action' | 'rationale';

export interface PersonCitedRecordQuoteV1 { readonly quote: string; readonly started_at?: string }
export interface PersonCitedRecordItemV1 {
  readonly atom_id: Sha256Digest;
  readonly text: string;
  /** Only a decision has one. */
  readonly status?: (typeof STATUSES)[number];
  /** Only an action, and only as the approver confirmed it in the signed approval. */
  readonly owner?: string;
  readonly quotes: readonly PersonCitedRecordQuoteV1[];
}
export interface PersonCitedRecordSectionV1 { readonly items: readonly PersonCitedRecordItemV1[]; readonly more: boolean }
export interface PersonCitedRecordV1 {
  readonly schema_version: 1;
  readonly kind: typeof PERSON_CITED_RECORD_KIND_V1;
  readonly record_sha256: Sha256Digest;
  readonly policy_id: PersonCitedRecordPolicyV1;
  readonly title?: string;
  /** When the meeting started (ISO 8601), in which time zone, and whether it was all day. */
  readonly started_at?: string;
  readonly timezone?: string;
  readonly all_day: boolean;
  readonly approved_by?: string;
  readonly participants: readonly string[];
  readonly participants_more: boolean;
  readonly decisions: PersonCitedRecordSectionV1;
  readonly actions: PersonCitedRecordSectionV1;
  readonly rationales: PersonCitedRecordSectionV1;
}

/**
 * The id an Ask citation gives an approved record's decision, action or
 * rationale: the digest of its record and its signal's id. It is
 * organization-record's atom identity, which the Ask progress round trip
 * (tests/architecture) pins this to.
 */
export function personRecordAtomIdV1(recordSha256: string, signalId: string): Sha256Digest {
  return canonicalSha256({ kind: 'echo-organization-record-atom', record_hash: recordSha256, signal_id: signalId });
}

type Json = Readonly<Record<string, unknown>>;
function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}
/** Text as a reader shows it: controls and format characters as spaces, trimmed. Nothing left is none. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return text === '' ? undefined : text;
}
function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : undefined;
}
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Owners the approver confirmed, by action id, from the signed approval: the brief itself never has them. */
function confirmedOwners(entries: unknown): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const entry of Array.isArray(entries) ? entries.slice(0, 40) : []) {
    const found = object(entry);
    const owner = displayText(found?.owner);
    if (typeof found?.signal_id === 'string' && owner !== undefined && owner.length <= OWNER_MAX_CHARACTERS) owners.set(found.signal_id, owner);
  }
  return owners;
}

/** One section of the brief. Every item must be of its kind, with its own id and some text, or the whole record is refused. */
function section(raw: unknown, kind: Kind, recordSha256: string, owners: ReadonlyMap<string, string>): PersonCitedRecordSectionV1 {
  if (!Array.isArray(raw)) fail(`Cited record ${kind}s are invalid`);
  const ids = new Set<string>();
  const items: PersonCitedRecordItemV1[] = [];
  for (const entry of raw) {
    const item = object(entry);
    const text = displayText(item?.text);
    if (item === undefined || item.kind !== kind || typeof item.id !== 'string' || item.id === '' || ids.has(item.id) || text === undefined) {
      fail(`Cited record ${kind} is invalid`);
    }
    ids.add(item.id);
    if (items.length === PERSON_CITED_RECORD_ITEMS_MAX_V1) continue;
    const quotes: PersonCitedRecordQuoteV1[] = [];
    for (const span of Array.isArray(item.evidence) ? item.evidence.slice(0, 32) : []) {
      const found = object(span);
      const quote = displayText(found?.quote);
      if (quote === undefined || quotes.some(seen => seen.quote === quote)) continue;
      quotes.push(Object.freeze({ quote, ...optional('started_at', isoTime(found?.started_at)) }));
      if (quotes.length === PERSON_CITED_RECORD_QUOTES_MAX_V1) break;
    }
    const status = kind === 'decision' && (STATUSES as readonly unknown[]).includes(item.status) ? item.status as PersonCitedRecordItemV1['status'] : undefined;
    items.push(Object.freeze({
      atom_id: personRecordAtomIdV1(recordSha256, item.id), text, ...optional('status', status),
      ...optional('owner', kind === 'action' ? owners.get(item.id) : undefined), quotes: Object.freeze(quotes),
    }));
  }
  return Object.freeze({ items: Object.freeze(items), more: raw.length > PERSON_CITED_RECORD_ITEMS_MAX_V1 });
}

/**
 * One record `person records --record-sha256` listed, as Ask cites it: only an
 * approved record, its own digest, under one of the three record policies.
 */
export function personCitedRecordV1(record: PersonRecordListItemV1): PersonCitedRecordV1 {
  const body = object(record.envelope.body);
  const event = object(body?.event);
  if (record.envelope.record_sha256 !== record.record_sha256 || body === undefined || event?.kind !== 'approved') fail('Cited record is not an approved record');
  const policy_id = oneOf(event.policy_id, POLICIES, 'Cited record policy_id');
  const brief = object(object(object(event.approved_snapshot)?.approved_payload)?.brief);
  const meeting = object(brief?.meeting);
  if (brief === undefined || meeting === undefined) fail('Cited record brief is invalid');
  const owners = confirmedOwners(object(body.human_act_resolution_ref)?.action_owners);
  const participants: string[] = [];
  let participants_more = false;
  for (const entry of Array.isArray(meeting.participants) ? meeting.participants.slice(0, 10_000) : []) {
    const name = displayText(object(entry)?.display_name);
    if (name === undefined || participants.includes(name)) continue;
    if (participants.length === PERSON_CITED_RECORD_ITEMS_MAX_V1) { participants_more = true; break; }
    participants.push(name);
  }
  const time = object(meeting.time) ?? {};
  return Object.freeze({
    schema_version: 1, kind: PERSON_CITED_RECORD_KIND_V1, record_sha256: record.record_sha256, policy_id,
    ...optional('title', displayText(meeting.title)),
    ...optional('started_at', isoTime(time.actual_start_at) ?? isoTime(time.scheduled_start_at)),
    ...optional('timezone', typeof time.timezone === 'string' && TIMEZONE.test(time.timezone) ? time.timezone : undefined),
    all_day: time.all_day === true,
    ...optional('approved_by', displayText(record.source_metadata?.record_approved_by?.display_name)),
    participants: Object.freeze(participants), participants_more,
    decisions: section(brief.decisions, 'decision', record.record_sha256, owners),
    actions: section(brief.actions, 'action', record.record_sha256, owners),
    rationales: section(brief.rationales, 'rationale', record.record_sha256, owners),
  });
}

function validText(value: unknown, label: string, maximumCharacters = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || displayText(value) !== value || utf8ByteLength(value) > TEXT_MAX_BYTES || [...value].length > maximumCharacters) fail(`${label} is invalid`);
  return value;
}
function validTime(value: unknown, label: string): string {
  if (isoTime(value) === undefined) fail(`${label} is invalid`);
  return value as string;
}
function validFlag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} is invalid`);
  return value;
}
function validList(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} is invalid`);
  return value;
}

function validSection(value: unknown, kind: Kind): PersonCitedRecordSectionV1 {
  const label = `Person cited record ${kind}s`;
  const input = asRecord(value, label);
  assertExactKeys(input, ['items', 'more'], label);
  const items = validList(input.items, label, PERSON_CITED_RECORD_ITEMS_MAX_V1).map((entry) => {
    const item = asRecord(entry, `Person cited record ${kind}`);
    const extra = (kind === 'decision' ? ['status'] : kind === 'action' ? ['owner'] : []).filter((key) => Object.hasOwn(item, key));
    assertExactKeys(item, ['atom_id', 'text', 'quotes', ...extra], `Person cited record ${kind}`);
    assertDigest(item.atom_id, `Person cited record ${kind} atom_id`);
    const quotes = validList(item.quotes, `Person cited record ${kind} quotes`, PERSON_CITED_RECORD_QUOTES_MAX_V1).map((raw) => {
      const quote = asRecord(raw, 'Person cited record quote');
      assertExactKeys(quote, ['quote', ...(Object.hasOwn(quote, 'started_at') ? ['started_at'] : [])], 'Person cited record quote');
      return Object.freeze({ quote: validText(quote.quote, 'Person cited record quote'), ...optional('started_at', Object.hasOwn(quote, 'started_at') ? validTime(quote.started_at, 'Person cited record quote started_at') : undefined) });
    });
    if (new Set(quotes.map((quote) => quote.quote)).size !== quotes.length) fail(`Person cited record ${kind} quotes repeat`);
    return Object.freeze({
      atom_id: item.atom_id as Sha256Digest, text: validText(item.text, `Person cited record ${kind} text`),
      ...optional('status', Object.hasOwn(item, 'status') ? oneOf(item.status, STATUSES, 'Person cited record decision status') : undefined),
      ...optional('owner', Object.hasOwn(item, 'owner') ? validText(item.owner, 'Person cited record action owner', OWNER_MAX_CHARACTERS) : undefined),
      quotes: Object.freeze(quotes),
    });
  });
  return Object.freeze({ items: Object.freeze(items), more: validFlag(input.more, `${label} more`) });
}

export function validatePersonCitedRecordV1(value: unknown): PersonCitedRecordV1 {
  const input = asRecord(value, 'Person cited record');
  const optionalKeys = ['title', 'started_at', 'timezone', 'approved_by'].filter((key) => Object.hasOwn(input, key));
  assertExactKeys(input, ['schema_version', 'kind', 'record_sha256', 'policy_id', 'all_day', 'participants', 'participants_more', 'decisions', 'actions', 'rationales', ...optionalKeys],
    'Person cited record');
  if (input.schema_version !== 1 || input.kind !== PERSON_CITED_RECORD_KIND_V1) fail('Person cited record is invalid');
  assertDigest(input.record_sha256, 'Person cited record record_sha256');
  if (Object.hasOwn(input, 'timezone') && (typeof input.timezone !== 'string' || !TIMEZONE.test(input.timezone))) fail('Person cited record timezone is invalid');
  const participants = validList(input.participants, 'Person cited record participants', PERSON_CITED_RECORD_ITEMS_MAX_V1).map((name) => validText(name, 'Person cited record participant'));
  if (new Set(participants).size !== participants.length) fail('Person cited record participants repeat');
  return Object.freeze({
    schema_version: 1, kind: PERSON_CITED_RECORD_KIND_V1, record_sha256: input.record_sha256 as Sha256Digest,
    policy_id: oneOf(input.policy_id, POLICIES, 'Person cited record policy_id'),
    ...optional('title', Object.hasOwn(input, 'title') ? validText(input.title, 'Person cited record title') : undefined),
    ...optional('started_at', Object.hasOwn(input, 'started_at') ? validTime(input.started_at, 'Person cited record started_at') : undefined),
    ...optional('timezone', input.timezone as string | undefined),
    all_day: validFlag(input.all_day, 'Person cited record all_day'),
    ...optional('approved_by', Object.hasOwn(input, 'approved_by') ? validText(input.approved_by, 'Person cited record approved_by') : undefined),
    participants: Object.freeze(participants), participants_more: validFlag(input.participants_more, 'Person cited record participants_more'),
    decisions: validSection(input.decisions, 'decision'), actions: validSection(input.actions, 'action'), rationales: validSection(input.rationales, 'rationale'),
  });
}
