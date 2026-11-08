import type {
  OrganizationRecordApprovalPayloadV1,
  OrganizationRecordDecisionBriefV1,
  OrganizationRecordSignalV1,
} from "./contracts.js";
import {
  asRecord,
  assertExactKeys,
  assertLiteral,
  assertTimestamp,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

/**
 * A brief with verbatim evidence spans routinely exceeds the shared 16 KiB
 * protocol default, so record documents carry an explicit exemption. Every
 * other organization protocol document keeps the 16 KiB default.
 */
export const MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES = 256 * 1024;

const MAX_RECORD_PARTICIPANTS = 10_000;
const MAX_RECORD_SIGNAL_LINKS = 1_000;
const MAX_RECORD_PARTICIPANT_IDENTITIES = 100;
const MAX_RECORD_PARTICIPANT_ROLES = 20;
const MAX_RECORD_METADATA_DEPTH = 32;
const SURFACE_PATTERN = /^[a-z][a-z0-9-]*$/;

const PARTICIPANT_IDENTITY_KINDS = [
  "source",
  "email",
  "phone",
  "other",
] as const;
const PARTICIPANT_ROLES = [
  "organizer",
  "host",
  "invitee",
  "attendee",
  "speaker",
  "note_taker",
  "bot",
] as const;
const PARTICIPANT_RESPONSE_STATUSES = [
  "accepted",
  "declined",
  "tentative",
  "unknown",
] as const;
const PARTICIPANT_ATTENDANCE = ["attended", "no_show", "unknown"] as const;
const DECISION_STATUSES = ["proposed", "decided", "unresolved"] as const;

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    organizationProtocolValidationFailure(`${label} must be a non-empty string`);
  }
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) assertNonEmptyString(value, label);
}

function assertOneOf(
  value: unknown,
  allowed: readonly string[],
  label: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    organizationProtocolValidationFailure(`${label} is invalid`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) assertTimestamp(value, label);
}

function assertArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value)) {
    organizationProtocolValidationFailure(`${label} must be an array`);
  }
  if ((value as unknown[]).length > maximum) {
    organizationProtocolValidationFailure(`${label} exceeds the safety limit`);
  }
  return value as unknown[];
}

/**
 * Metadata travels exactly as approved. Canonicalization already bounds its
 * bytes and rejects non-JSON values; only core's nesting limit is restated.
 */
function assertMetadata(value: unknown, label: string, depth = 0): void {
  if (depth > MAX_RECORD_METADATA_DEPTH) {
    organizationProtocolValidationFailure(
      `${label} exceeds the JSON depth limit`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertMetadata(item, `${label}[${index}]`, depth + 1),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assertMetadata(item, `${label}.${key}`, depth + 1);
  }
}

/** One field's check: its value, its label (`<object>.<key>`), and the object that holds it. */
type Check = (value: unknown, label: string, record: Record<string, unknown>) => void;

/**
 * Checks `value` is an object whose keys are among `checks`' (all of them when
 * `exact`), then runs each check in order on its field.
 */
function fields(
  value: unknown,
  label: string,
  checks: Readonly<Record<string, Check>>,
  exact = false,
): Record<string, unknown> {
  const record = asRecord(value, label);
  if (exact) assertExactKeys(record, Object.keys(checks), label);
  else if (Object.keys(record).some((key) => !Object.hasOwn(checks, key))) {
    organizationProtocolValidationFailure(`${label} has an unexpected shape`);
  }
  for (const [key, check] of Object.entries(checks)) check(record[key], `${label}.${key}`, record);
  return record;
}

const text: Check = (value, label) => assertNonEmptyString(value, label);
const optionalText: Check = (value, label) => assertOptionalNonEmptyString(value, label);
const optionalAt: Check = (value, label) => assertOptionalTimestamp(value, label);

function optionalAmong(allowed: readonly string[]): Check {
  return (value, label) => {
    if (value !== undefined) assertOneOf(value, allowed, label);
  };
}

/**
 * At most `maximum` items, each checked as `<label>[<index>]` (an array's holes
 * are skipped); an item whose `key` repeats an earlier one's is refused at once.
 */
function eachUnique<T>(
  value: unknown,
  label: string,
  maximum: number,
  check: (item: unknown, label: string) => void,
  key: (item: T) => unknown,
): void {
  const seen = new Set<unknown>();
  assertArray(value, label, maximum).forEach((item, index) => {
    check(item, `${label}[${index}]`);
    const id = key(item as T);
    if (seen.has(id)) {
      organizationProtocolValidationFailure(`${label} must be unique`);
    }
    seen.add(id);
  });
}

const MEETING_TIME_KEYS = [
  "scheduled_start_at",
  "scheduled_end_at",
  "actual_start_at",
  "actual_end_at",
] as const;

/** The four times, then both orders, then the timezone and the all-day flag. */
function assertMeetingTime(value: unknown, label: string): void {
  if (value === undefined) return;
  const time = asRecord(value, label);
  if (Object.keys(time).some((key) => ![...MEETING_TIME_KEYS, "timezone", "all_day"].includes(key))) {
    organizationProtocolValidationFailure(`${label} has an unexpected shape`);
  }
  for (const key of MEETING_TIME_KEYS) assertOptionalTimestamp(time[key], `${label}.${key}`);
  for (const which of ["scheduled", "actual"] as const) {
    const start = time[`${which}_start_at`];
    const end = time[`${which}_end_at`];
    if (typeof start === "string" && typeof end === "string" && start > end) {
      organizationProtocolValidationFailure(`${label} ${which} end precedes its start`);
    }
  }
  assertOptionalNonEmptyString(time.timezone, `${label}.timezone`);
  if (time.all_day !== undefined && typeof time.all_day !== "boolean") {
    organizationProtocolValidationFailure(`${label}.all_day must be a boolean`);
  }
}

const PARTICIPANT_CHECKS: Readonly<Record<string, Check>> = {
  id: text,
  display_name: optionalText,
  identities: (value, label) => {
    if (value === undefined) return;
    eachUnique(value, label, MAX_RECORD_PARTICIPANT_IDENTITIES, (item, itemLabel) => {
      fields(item, itemLabel, {
        kind: (kind, kindLabel) => assertOneOf(kind, PARTICIPANT_IDENTITY_KINDS, kindLabel),
        value: text,
      }, true);
    }, (identity: { readonly kind: unknown; readonly value: unknown }) => `${String(identity.kind)}:${String(identity.value)}`);
  },
  roles: (value, label) => {
    if (value === undefined) return;
    eachUnique(value, label, MAX_RECORD_PARTICIPANT_ROLES, (role, roleLabel) => assertOneOf(role, PARTICIPANT_ROLES, roleLabel), (role: unknown) => role);
  },
  response_status: optionalAmong(PARTICIPANT_RESPONSE_STATUSES),
  attendance: optionalAmong(PARTICIPANT_ATTENDANCE),
  organization: (value, label) => {
    if (value !== undefined) fields(value, label, { name: optionalText, domain: optionalText });
  },
  is_external: (value, label) => {
    if (value !== undefined && typeof value !== "boolean") {
      organizationProtocolValidationFailure(`${label} must be a boolean`);
    }
  },
  metadata: (value, label) => {
    if (value === undefined) return;
    asRecord(value, label);
    assertMetadata(value, label);
  },
};

function assertEvidence(
  value: unknown,
  label: string,
  meetingId: string,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    organizationProtocolValidationFailure(`${label} must not be empty`);
  }
  (value as unknown[]).forEach((item, index) => {
    fields(item, `${label}[${index}]`, {
      meeting_id: (id, idLabel) => {
        if (id !== meetingId) organizationProtocolValidationFailure(`${idLabel} does not match its meeting`);
      },
      block_id: text,
      quote: optionalText,
      started_at: optionalAt,
      ended_at: optionalAt,
    });
  });
}

function assertSignalArray(
  value: unknown,
  label: string,
  expectedKind: OrganizationRecordSignalV1["kind"],
  meetingId: string,
  ids: Set<string>,
): OrganizationRecordSignalV1[] {
  if (!Array.isArray(value)) {
    organizationProtocolValidationFailure(`${label} must be an array`);
  }
  return (value as unknown[]).map((item, index) => {
    const signal = asRecord(item, `${label}[${index}]`);
    assertNonEmptyString(signal.id, `${label}[${index}].id`);
    if (ids.has(signal.id)) {
      organizationProtocolValidationFailure("signal ids must be unique");
    }
    ids.add(signal.id);
    if (signal.kind !== expectedKind) {
      organizationProtocolValidationFailure(
        `${label}[${index}] is in the wrong signal collection`,
      );
    }
    const capabilityKeys =
      expectedKind === "decision"
        ? ["status"]
        : expectedKind === "action"
          ? ["owner", "due_at"]
          : ["supports_signal_ids"];
    assertExactKeys(
      signal,
      ["id", "kind", "text", "subject", "confidence", "evidence", ...capabilityKeys],
      `${label}[${index}]`,
    );
    assertNonEmptyString(signal.text, `${label}[${index}].text`);
    if (signal.subject !== null) {
      assertNonEmptyString(signal.subject, `${label}[${index}].subject`);
    }
    if (
      signal.confidence !== null &&
      !(
        typeof signal.confidence === "number" &&
        Number.isFinite(signal.confidence) &&
        signal.confidence >= 0 &&
        signal.confidence <= 1
      )
    ) {
      organizationProtocolValidationFailure(
        `${label}[${index}].confidence must be null or between 0 and 1`,
      );
    }
    assertEvidence(signal.evidence, `${label}[${index}].evidence`, meetingId);
    if (expectedKind === "decision") {
      assertOneOf(
        signal.status,
        DECISION_STATUSES,
        `${label}[${index}].status`,
      );
    } else if (expectedKind === "action") {
      if (signal.owner !== null) {
        assertNonEmptyString(signal.owner, `${label}[${index}].owner`);
      }
      if (signal.due_at !== null) {
        assertTimestamp(signal.due_at, `${label}[${index}].due_at`);
      }
    } else {
      const supports = assertArray(
        signal.supports_signal_ids,
        `${label}[${index}].supports_signal_ids`,
        MAX_RECORD_SIGNAL_LINKS,
      );
      supports.forEach((supported, supportedIndex) =>
        assertNonEmptyString(
          supported,
          `${label}[${index}].supports_signal_ids[${supportedIndex}]`,
        ),
      );
    }
    return signal as unknown as OrganizationRecordSignalV1;
  });
}

function assertRationaleLinks(
  signals: readonly OrganizationRecordSignalV1[],
): void {
  const ids = new Set(signals.map((signal) => signal.id));
  for (const signal of signals) {
    if (
      signal.kind === "rationale" &&
      signal.supports_signal_ids.some(
        (supported) => supported === signal.id || !ids.has(supported),
      )
    ) {
      organizationProtocolValidationFailure(
        "rationale links must reference another signal in the same brief",
      );
    }
  }
}

/**
 * Restates the `DecisionBrief` shape processing core produces. Neither package
 * may import the other, so this package owns its own validator, exercised by
 * the test-only payload conformance fixture.
 */
function assertOrganizationRecordDecisionBrief(
  value: unknown,
  label: string,
): asserts value is OrganizationRecordDecisionBriefV1 {
  const brief = asRecord(value, label);
  assertExactKeys(brief, ["schema_version", "id", "meeting", "decisions", "actions", "rationales", "provenance"], label);
  assertLiteral(brief.schema_version, 1, `${label} schema_version`);
  assertNonEmptyString(brief.id, `${label}.id`);

  const meeting = fields(brief.meeting, `${label}.meeting`, {
    id: text,
    title: optionalText,
    time: (time, timeLabel) => assertMeetingTime(time, timeLabel),
    // Deliberately stricter than core, which tolerates repeated participant ids.
    // Derive keys a participant observation by (meeting snapshot, participant),
    // so a duplicate id would either collide on insert or silently drop a
    // distinct observation. Every protocol-valid payload must be derivable.
    participants: (participants, participantsLabel) => {
      const participantIds = new Set<unknown>();
      assertArray(participants, participantsLabel, MAX_RECORD_PARTICIPANTS).forEach((participant, index) => {
        fields(participant, `${participantsLabel}[${index}]`, PARTICIPANT_CHECKS);
        const id = (participant as Record<string, unknown>).id;
        if (participantIds.has(id)) {
          organizationProtocolValidationFailure(`${participantsLabel} must have unique ids`);
        }
        participantIds.add(id);
      });
    },
  });

  fields(brief.provenance, `${label}.provenance`, {
    meeting_revision: text,
    generated_at: (generatedAt, generatedAtLabel) => assertTimestamp(generatedAt, generatedAtLabel),
    processor: (processor, processorLabel) => {
      fields(processor, processorLabel, {
        kind: (kind) => assertLiteral(kind, "decision-processor", `${processorLabel} kind`),
        adapter_id: text,
        instance_id: text,
        version: text,
      }, true);
    },
  }, true);

  const meetingId = meeting.id as string;
  const ids = new Set<string>();
  assertRationaleLinks([
    ...assertSignalArray(brief.decisions, `${label}.decisions`, "decision", meetingId, ids),
    ...assertSignalArray(brief.actions, `${label}.actions`, "action", meetingId, ids),
    ...assertSignalArray(brief.rationales, `${label}.rationales`, "rationale", meetingId, ids),
  ]);
}

export function assertOrganizationRecordApprovalPayload(
  value: unknown,
  label: string,
): asserts value is OrganizationRecordApprovalPayloadV1 {
  fields(value, label, {
    brief: (brief, briefLabel) => assertOrganizationRecordDecisionBrief(brief, briefLabel),
    source: (source, sourceLabel) => {
      fields(source, sourceLabel, { adapter_id: text, instance_id: text, external_id: text }, true);
    },
    // Carried for shape stability; V1 derives nothing from either, so accepting
    // content nothing validates would put unreadable facts in an immutable log.
    alternatives: (alternatives, alternativesLabel) => {
      if (!Array.isArray(alternatives) || alternatives.length > 0) {
        organizationProtocolValidationFailure(`${alternativesLabel} must be an empty array in schema version 1`);
      }
    },
    links: (links, linksLabel) => {
      if (links !== null) organizationProtocolValidationFailure(`${linksLabel} must be null in schema version 1`);
    },
    reviewed_at: (reviewedAt, reviewedAtLabel) => assertTimestamp(reviewedAt, reviewedAtLabel),
    surface: (surface, surfaceLabel) => {
      if (typeof surface !== "string" || !SURFACE_PATTERN.test(surface)) {
        organizationProtocolValidationFailure(`${surfaceLabel} must be a canonical surface name`);
      }
    },
  }, true);
}
