import { Buffer } from "node:buffer";
import type {
  OrganizationRecordApprovalPayloadV1,
  OrganizationRecordDecisionBriefV1,
  OrganizationRecordRejectionPayloadV1,
  OrganizationRecordSignalV1,
  OrganizationRecordSourceLocatorV1,
} from "./contracts.js";
import {
  asRecord,
  assertExactKeys,
  assertLiteral,
  assertTimestamp,
  canonicalSnapshot,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

/**
 * A brief with verbatim evidence spans routinely exceeds the shared 16 KiB
 * protocol default, so record documents carry an explicit exemption. Every
 * other organization protocol document keeps the 16 KiB default.
 */
export const MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES = 256 * 1024;

/** The rejection reason is organization-visible content, so it is bounded. */
export const MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES = 2 * 1024;

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
const MEETING_TIME_KEYS = [
  "scheduled_start_at",
  "scheduled_end_at",
  "actual_start_at",
  "actual_end_at",
] as const;

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

function assertMeetingTime(value: unknown, label: string): void {
  if (value === undefined) return;
  const time = asRecord(value, label);
  for (const key of Object.keys(time)) {
    if (
      !MEETING_TIME_KEYS.includes(key as (typeof MEETING_TIME_KEYS)[number]) &&
      key !== "timezone" &&
      key !== "all_day"
    ) {
      organizationProtocolValidationFailure(`${label} has an unexpected shape`);
    }
  }
  for (const key of MEETING_TIME_KEYS) {
    assertOptionalTimestamp(time[key], `${label}.${key}`);
  }
  if (
    typeof time.scheduled_start_at === "string" &&
    typeof time.scheduled_end_at === "string" &&
    time.scheduled_start_at > time.scheduled_end_at
  ) {
    organizationProtocolValidationFailure(
      `${label} scheduled end precedes its start`,
    );
  }
  if (
    typeof time.actual_start_at === "string" &&
    typeof time.actual_end_at === "string" &&
    time.actual_start_at > time.actual_end_at
  ) {
    organizationProtocolValidationFailure(
      `${label} actual end precedes its start`,
    );
  }
  assertOptionalNonEmptyString(time.timezone, `${label}.timezone`);
  if (time.all_day !== undefined && typeof time.all_day !== "boolean") {
    organizationProtocolValidationFailure(`${label}.all_day must be a boolean`);
  }
}

function assertParticipant(value: unknown, label: string): void {
  const participant = asRecord(value, label);
  for (const key of Object.keys(participant)) {
    if (
      ![
        "id",
        "display_name",
        "identities",
        "roles",
        "response_status",
        "attendance",
        "organization",
        "is_external",
        "metadata",
      ].includes(key)
    ) {
      organizationProtocolValidationFailure(`${label} has an unexpected shape`);
    }
  }
  assertNonEmptyString(participant.id, `${label}.id`);
  assertOptionalNonEmptyString(participant.display_name, `${label}.display_name`);
  if (participant.identities !== undefined) {
    const identities = assertArray(
      participant.identities,
      `${label}.identities`,
      MAX_RECORD_PARTICIPANT_IDENTITIES,
    );
    const seen = new Set<string>();
    identities.forEach((item, index) => {
      const identity = asRecord(item, `${label}.identities[${index}]`);
      assertExactKeys(
        identity,
        ["kind", "value"],
        `${label}.identities[${index}]`,
      );
      assertOneOf(
        identity.kind,
        PARTICIPANT_IDENTITY_KINDS,
        `${label}.identities[${index}].kind`,
      );
      assertNonEmptyString(
        identity.value,
        `${label}.identities[${index}].value`,
      );
      const key = `${String(identity.kind)}:${String(identity.value)}`;
      if (seen.has(key)) {
        organizationProtocolValidationFailure(
          `${label}.identities must be unique`,
        );
      }
      seen.add(key);
    });
  }
  if (participant.roles !== undefined) {
    const roles = assertArray(
      participant.roles,
      `${label}.roles`,
      MAX_RECORD_PARTICIPANT_ROLES,
    );
    const seen = new Set<unknown>();
    roles.forEach((role, index) => {
      assertOneOf(role, PARTICIPANT_ROLES, `${label}.roles[${index}]`);
      if (seen.has(role)) {
        organizationProtocolValidationFailure(`${label}.roles must be unique`);
      }
      seen.add(role);
    });
  }
  if (participant.response_status !== undefined) {
    assertOneOf(
      participant.response_status,
      PARTICIPANT_RESPONSE_STATUSES,
      `${label}.response_status`,
    );
  }
  if (participant.attendance !== undefined) {
    assertOneOf(
      participant.attendance,
      PARTICIPANT_ATTENDANCE,
      `${label}.attendance`,
    );
  }
  if (participant.organization !== undefined) {
    const organization = asRecord(
      participant.organization,
      `${label}.organization`,
    );
    for (const key of Object.keys(organization)) {
      if (key !== "name" && key !== "domain") {
        organizationProtocolValidationFailure(
          `${label}.organization has an unexpected shape`,
        );
      }
    }
    assertOptionalNonEmptyString(
      organization.name,
      `${label}.organization.name`,
    );
    assertOptionalNonEmptyString(
      organization.domain,
      `${label}.organization.domain`,
    );
  }
  if (
    participant.is_external !== undefined &&
    typeof participant.is_external !== "boolean"
  ) {
    organizationProtocolValidationFailure(
      `${label}.is_external must be a boolean`,
    );
  }
  if (participant.metadata !== undefined) {
    asRecord(participant.metadata, `${label}.metadata`);
    assertMetadata(participant.metadata, `${label}.metadata`);
  }
}

function assertEvidence(
  value: unknown,
  label: string,
  meetingId: string,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    organizationProtocolValidationFailure(`${label} must not be empty`);
  }
  (value as unknown[]).forEach((item, index) => {
    const span = asRecord(item, `${label}[${index}]`);
    for (const key of Object.keys(span)) {
      if (
        !["meeting_id", "block_id", "quote", "started_at", "ended_at"].includes(
          key,
        )
      ) {
        organizationProtocolValidationFailure(
          `${label}[${index}] has an unexpected shape`,
        );
      }
    }
    if (span.meeting_id !== meetingId) {
      organizationProtocolValidationFailure(
        `${label}[${index}].meeting_id does not match its meeting`,
      );
    }
    assertNonEmptyString(span.block_id, `${label}[${index}].block_id`);
    assertOptionalNonEmptyString(span.quote, `${label}[${index}].quote`);
    assertOptionalTimestamp(span.started_at, `${label}[${index}].started_at`);
    assertOptionalTimestamp(span.ended_at, `${label}[${index}].ended_at`);
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
 * Restates the `DecisionBrief` shape core validates. Core imports no packages,
 * so the two are pinned together by the shared golden payload fixtures rather
 * than by shared code, and this side is never looser than core's validator.
 */
function assertOrganizationRecordDecisionBrief(
  value: unknown,
  label: string,
): asserts value is OrganizationRecordDecisionBriefV1 {
  const brief = asRecord(value, label);
  assertExactKeys(
    brief,
    [
      "schema_version",
      "id",
      "meeting",
      "decisions",
      "actions",
      "rationales",
      "provenance",
    ],
    label,
  );
  assertLiteral(brief.schema_version, 1, `${label} schema_version`);
  assertNonEmptyString(brief.id, `${label}.id`);

  const meeting = asRecord(brief.meeting, `${label}.meeting`);
  for (const key of Object.keys(meeting)) {
    if (!["id", "title", "time", "participants"].includes(key)) {
      organizationProtocolValidationFailure(
        `${label}.meeting has an unexpected shape`,
      );
    }
  }
  assertNonEmptyString(meeting.id, `${label}.meeting.id`);
  assertOptionalNonEmptyString(meeting.title, `${label}.meeting.title`);
  assertMeetingTime(meeting.time, `${label}.meeting.time`);
  const participants = assertArray(
    meeting.participants,
    `${label}.meeting.participants`,
    MAX_RECORD_PARTICIPANTS,
  );
  // Deliberately stricter than core, which tolerates repeated participant ids.
  // Derive keys a participant observation by (meeting snapshot, participant),
  // so a duplicate id would either collide on insert or silently drop a
  // distinct observation. Every protocol-valid payload must be derivable.
  const participantIds = new Set<unknown>();
  participants.forEach((participant, index) => {
    const participantLabel = `${label}.meeting.participants[${index}]`;
    assertParticipant(participant, participantLabel);
    const id = (participant as Record<string, unknown>).id;
    if (participantIds.has(id)) {
      organizationProtocolValidationFailure(
        `${label}.meeting.participants must have unique ids`,
      );
    }
    participantIds.add(id);
  });

  const provenance = asRecord(brief.provenance, `${label}.provenance`);
  assertExactKeys(
    provenance,
    ["meeting_revision", "processor", "generated_at"],
    `${label}.provenance`,
  );
  assertNonEmptyString(
    provenance.meeting_revision,
    `${label}.provenance.meeting_revision`,
  );
  assertTimestamp(provenance.generated_at, `${label}.provenance.generated_at`);
  const processor = asRecord(
    provenance.processor,
    `${label}.provenance.processor`,
  );
  assertExactKeys(
    processor,
    ["kind", "adapter_id", "instance_id", "version"],
    `${label}.provenance.processor`,
  );
  assertLiteral(
    processor.kind,
    "decision-processor",
    `${label}.provenance.processor kind`,
  );
  assertNonEmptyString(
    processor.adapter_id,
    `${label}.provenance.processor.adapter_id`,
  );
  assertNonEmptyString(
    processor.instance_id,
    `${label}.provenance.processor.instance_id`,
  );
  assertNonEmptyString(
    processor.version,
    `${label}.provenance.processor.version`,
  );

  const meetingId = meeting.id as string;
  const ids = new Set<string>();
  assertRationaleLinks([
    ...assertSignalArray(
      brief.decisions,
      `${label}.decisions`,
      "decision",
      meetingId,
      ids,
    ),
    ...assertSignalArray(
      brief.actions,
      `${label}.actions`,
      "action",
      meetingId,
      ids,
    ),
    ...assertSignalArray(
      brief.rationales,
      `${label}.rationales`,
      "rationale",
      meetingId,
      ids,
    ),
  ]);
}

function assertOrganizationRecordSourceLocator(
  value: unknown,
  label: string,
): asserts value is OrganizationRecordSourceLocatorV1 {
  const locator = asRecord(value, label);
  assertExactKeys(
    locator,
    ["adapter_id", "instance_id", "external_id"],
    label,
  );
  assertNonEmptyString(locator.adapter_id, `${label}.adapter_id`);
  assertNonEmptyString(locator.instance_id, `${label}.instance_id`);
  assertNonEmptyString(locator.external_id, `${label}.external_id`);
}

export function assertOrganizationRecordApprovalPayload(
  value: unknown,
  label: string,
): asserts value is OrganizationRecordApprovalPayloadV1 {
  const payload = asRecord(value, label);
  assertExactKeys(
    payload,
    ["brief", "source", "alternatives", "links", "reviewed_at", "surface"],
    label,
  );
  assertOrganizationRecordDecisionBrief(payload.brief, `${label}.brief`);
  assertOrganizationRecordSourceLocator(payload.source, `${label}.source`);
  // Carried for shape stability; V1 derives nothing from either, so accepting
  // content nothing validates would put unreadable facts in an immutable log.
  if (!Array.isArray(payload.alternatives) || payload.alternatives.length > 0) {
    organizationProtocolValidationFailure(
      `${label}.alternatives must be an empty array in schema version 1`,
    );
  }
  if (payload.links !== null) {
    organizationProtocolValidationFailure(
      `${label}.links must be null in schema version 1`,
    );
  }
  assertTimestamp(payload.reviewed_at, `${label}.reviewed_at`);
  if (
    typeof payload.surface !== "string" ||
    !SURFACE_PATTERN.test(payload.surface)
  ) {
    organizationProtocolValidationFailure(
      `${label}.surface must be a canonical surface name`,
    );
  }
}

export function assertOrganizationRecordRejectionPayload(
  value: unknown,
  label: string,
): asserts value is OrganizationRecordRejectionPayloadV1 {
  const payload = asRecord(value, label);
  assertExactKeys(
    payload,
    ["source", "meeting_id", "rejected_at", "reason", "reconsider_after"],
    label,
  );
  assertOrganizationRecordSourceLocator(payload.source, `${label}.source`);
  assertNonEmptyString(payload.meeting_id, `${label}.meeting_id`);
  assertTimestamp(payload.rejected_at, `${label}.rejected_at`);
  if (payload.reason !== null) {
    assertNonEmptyString(payload.reason, `${label}.reason`);
    if (
      Buffer.byteLength(payload.reason as string, "utf8") >
      MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES
    ) {
      organizationProtocolValidationFailure(
        `${label}.reason must be at most ${MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES} UTF-8 bytes`,
      );
    }
  }
  if (payload.reconsider_after !== null) {
    assertTimestamp(payload.reconsider_after, `${label}.reconsider_after`);
  }
}

/**
 * Standalone brief validation for callers pinning the payload shape outside a
 * signed envelope, such as the shared golden payload fixtures.
 */
export function validateOrganizationRecordDecisionBrief(
  value: unknown,
): OrganizationRecordDecisionBriefV1 {
  const snapshot = canonicalSnapshot(
    value,
    "organization record decision brief",
    MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
  );
  assertOrganizationRecordDecisionBrief(
    snapshot,
    "organization record decision brief",
  );
  return snapshot;
}
