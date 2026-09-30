import type { JsonObject, Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_LIST_TEXT_MAX_BYTES_V1,
  PERSON_OPEN_ATOM_PART_MAX_BYTES_V1,
  PERSON_OPEN_PARTICIPANTS_MAX_V1,
  type PersonOpenMeetingAtomV1,
  type PersonOpenMeetingDetailV1,
} from "@echo-brain/organization-api";
import type { OrganizationRecordDecisionBriefV1, OrganizationRecordMeetingTimeV1 } from "@echo-brain/organization-protocol";
import type { RecordApproverProjectorV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { boundedTextV1 } from "./person-item-text-v1.js";

/**
 * Pure meeting presentation for the person list and open (ADR-0023). Every
 * value here is projected from an approved record the caller was already
 * admitted to; nothing here reads a database or decides access.
 */

const TIMEZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function metadataUnavailable(): never {
  throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
}

function day(value: string): string | undefined {
  return DAY.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value ? value : undefined;
}

function zonedDay(milliseconds: number, timezone: string | undefined): string | undefined {
  if (timezone === undefined) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(milliseconds));
    const part = (type: "year" | "month" | "day") => parts.find((entry) => entry.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return undefined;
  }
}

/**
 * The meeting's own calendar day: in its brief timezone when Intl accepts
 * the zone, as stored for an all-day meeting, and otherwise in UTC. The time
 * precedence is the desk label's.
 */
export function meetingDateV1(time: OrganizationRecordMeetingTimeV1 | undefined): string | undefined {
  const value = time?.actual_start_at ?? time?.scheduled_start_at ?? time?.actual_end_at ?? time?.scheduled_end_at;
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const local = time?.all_day === true ? value.slice(0, 10) : zonedDay(milliseconds, time?.timezone) ?? new Date(milliseconds).toISOString().slice(0, 10);
  return day(local);
}

/** Code-point-safe parts of at most 3,072 bytes; the parts join to the exact text. */
export function splitAtomTextV1(text: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const scalar of text) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > PERSON_OPEN_ATOM_PART_MAX_BYTES_V1 && current.length > 0) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += scalar;
    bytes += size;
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);
  return Object.freeze(parts);
}

/**
 * Owners an approver confirmed in the signed human act (ADR-0021), by signal
 * ID. The approved brief never carries an owner; the search text of an owned
 * action ends with " Owner: <name>." and must match exactly.
 */
export function confirmedOwners(reference: unknown): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  const entries = (reference as { readonly action_owners?: unknown }).action_owners;
  if (entries === undefined) return owners;
  if (!Array.isArray(entries)) metadataUnavailable();
  for (const entry of entries as readonly { readonly signal_id?: unknown; readonly owner?: unknown }[]) {
    if (typeof entry?.signal_id !== "string" || typeof entry.owner !== "string") metadataUnavailable();
    owners.set(entry.signal_id, entry.owner);
  }
  return owners;
}

/** One part of one approved signal, at its place in the brief's atom order. */
export interface MeetingAtomPartV1 {
  readonly atom_order: number;
  /** 1-based. */
  readonly part_index: number;
  readonly atom: PersonOpenMeetingAtomV1;
}

/**
 * Every approved signal in brief order (decisions, actions, rationales),
 * split into parts rather than dropped. Attributes sit on the first part
 * only; an owner comes only from the signed human act, never the brief.
 * Evidence spans are verbatim transcript quotes and are never released.
 */
export function meetingAtomsV1(brief: OrganizationRecordDecisionBriefV1, owners: ReadonlyMap<string, string>): readonly MeetingAtomPartV1[] {
  return Object.freeze([...brief.decisions, ...brief.actions, ...brief.rationales].flatMap((signal, atom_order) => {
    const texts = splitAtomTextV1(signal.text);
    const owner = signal.kind === "action" ? owners.get(signal.id) : undefined;
    const attributes = signal.kind === "decision" ? { status: signal.status }
      : signal.kind === "action" ? { ...(owner === undefined ? {} : { owner }), ...(signal.due_at === null ? {} : { due_at: signal.due_at }) }
      : {};
    return texts.map((text, index) => Object.freeze({
      atom_order,
      part_index: index + 1,
      atom: Object.freeze({
        kind: signal.kind, text, ...(index === 0 ? attributes : {}),
        ...(texts.length === 1 ? {} : { part: Object.freeze({ index: index + 1, count: texts.length }) }),
      }),
    }));
  }));
}

function meetingTime(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * Names only: never participant ids, identities, roles, organizations,
 * metadata, the meeting or brief id, provenance, subjects or confidence.
 */
export function meetingDetailV1(brief: OrganizationRecordDecisionBriefV1, approved_by?: string): PersonOpenMeetingDetailV1 {
  const time = brief.meeting.time;
  const participants: string[] = [];
  let more = false;
  for (const participant of brief.meeting.participants) {
    const name = boundedTextV1(participant.display_name, PERSON_LIST_TEXT_MAX_BYTES_V1);
    if (name === undefined || participants.includes(name)) continue;
    if (participants.length === PERSON_OPEN_PARTICIPANTS_MAX_V1) { more = true; break; }
    participants.push(name);
  }
  const started_at = meetingTime(time?.actual_start_at ?? time?.scheduled_start_at);
  const ended_at = meetingTime(time?.actual_end_at ?? time?.scheduled_end_at);
  return Object.freeze({
    ...(started_at === undefined ? {} : { started_at }),
    ...(ended_at === undefined ? {} : { ended_at }),
    ...(time?.timezone !== undefined && TIMEZONE.test(time.timezone) ? { timezone: time.timezone } : {}),
    all_day: time?.all_day === true,
    participants: Object.freeze(participants),
    participants_more: more,
    ...(approved_by === undefined ? {} : { approved_by }),
  });
}

export interface RecordCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

export interface RecordApproverTupleV1 {
  readonly principal_id: string;
  readonly membership_id: string;
}

/** Resolves only the approver named by a record already released to this reader. */
export interface ApproverMembershipsV1 {
  membership(id: string): {
    readonly organization_id: string;
    readonly principal_id: string;
    readonly membership_id: string;
    readonly display_name: string;
  } | undefined;
}

/**
 * The final approver of an already-admitted record, from the composed
 * projectors. Server-only: it is compared or named, never released as ids.
 */
export function approverTupleV1(
  envelope: JsonObject,
  approval_id: string,
  coordinates: RecordCoordinatesV1,
  projector: RecordApproverProjectorV1 | undefined,
): RecordApproverTupleV1 | undefined {
  const actor = projector?.(envelope);
  if (
    actor === undefined ||
    actor.authority_id !== coordinates.authority_id ||
    actor.organization_id !== coordinates.organization_id ||
    actor.state_lineage_id !== coordinates.state_lineage_id ||
    actor.approval_id !== approval_id ||
    typeof actor.principal_id !== "string" ||
    typeof actor.membership_id !== "string"
  ) return undefined;
  return Object.freeze({ principal_id: actor.principal_id, membership_id: actor.membership_id });
}

export function approverDisplayNameV1(
  envelope: JsonObject,
  approval_id: string,
  coordinates: RecordCoordinatesV1,
  projector: RecordApproverProjectorV1 | undefined,
  memberships: ApproverMembershipsV1 | undefined,
): string | undefined {
  const approver = approverTupleV1(envelope, approval_id, coordinates, projector);
  if (approver === undefined) return undefined;
  const membership = memberships?.membership(approver.membership_id);
  if (
    membership === undefined ||
    membership.organization_id !== coordinates.organization_id ||
    membership.principal_id !== approver.principal_id ||
    membership.membership_id !== approver.membership_id
  ) return undefined;
  // A revoked membership can still identify a historical approver. It never
  // authorizes this read. Names are current directory labels, not job titles.
  const name = membership.display_name.trim();
  if (name.length === 0 || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name)) return undefined;
  return name;
}

/** Immutable per-record facts read at query time (ADR-0023, D11). */
export interface RecordMetadataV1 {
  readonly envelope_sha256: Sha256Digest;
  /** The signed receipt's issue time, canonical. */
  readonly added_at?: string;
  /** null: no approver projects, so the record is nobody's mine. */
  readonly approver?: RecordApproverTupleV1 | null;
  readonly presentation?: Readonly<{ title: string | null; meeting_date?: string }>;
}

const RECORD_METADATA_CACHE_ENTRIES = 1_024;

/**
 * A bounded cache keyed by the immutable record digest. It decorates or
 * filters records a reader was already admitted to; it never admits one.
 */
export class RecordMetadataCacheV1 {
  private readonly entries = new Map<Sha256Digest, RecordMetadataV1>();

  get(record_sha256: Sha256Digest, envelope_sha256: Sha256Digest): RecordMetadataV1 | undefined {
    const entry = this.entries.get(record_sha256);
    if (entry !== undefined && entry.envelope_sha256 !== envelope_sha256) metadataUnavailable();
    return entry;
  }

  merge(record_sha256: Sha256Digest, envelope_sha256: Sha256Digest, fields: Omit<RecordMetadataV1, "envelope_sha256">): RecordMetadataV1 {
    const current = this.get(record_sha256, envelope_sha256);
    if (current === undefined && this.entries.size >= RECORD_METADATA_CACHE_ENTRIES) this.entries.clear();
    const next: RecordMetadataV1 = Object.freeze({ ...current, ...fields, envelope_sha256 });
    this.entries.set(record_sha256, next);
    return next;
  }
}
