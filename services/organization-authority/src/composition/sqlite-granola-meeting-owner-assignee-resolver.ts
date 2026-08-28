import type Database from "better-sqlite3";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import { isCanonicalPersonEmail } from "../domain/person-session-rules.js";
import type { GranolaMeetingOwnerObservationV1 } from "./granola-meeting-owner-observation.js";

export interface CleanMeetingOwnerAssigneeV1 {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner" | "employee";
}

interface AssigneeRow {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner" | "employee";
}

interface OwnDataProperty {
  readonly present: boolean;
  readonly value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataProperty(value: object, key: string): OwnDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? { present: true, value: descriptor.value }
    : { present: false, value: undefined };
}

/**
 * Extracts only the exact, canonical email carried by the narrow Granola
 * calendar-organizer observation. It intentionally does not normalize or
 * recover a malformed observation: the observation is evidence, not input
 * from which to infer ownership.
 */
function observedOrganizerEmail(
  observation: GranolaMeetingOwnerObservationV1,
): string | undefined {
  const value: unknown = observation;
  if (!isPlainObject(value)) return undefined;

  const provider = ownDataProperty(value, "provider");
  const relationship = ownDataProperty(value, "relationship");
  const assurance = ownDataProperty(value, "assurance");
  const sourcePath = ownDataProperty(value, "source_path");
  const subject = ownDataProperty(value, "subject");
  if (
    provider.value !== "granola" ||
    relationship.value !== "calendar_organizer" ||
    assurance.value !== "provider_calendar_organizer_email_observed" ||
    (sourcePath.value !==
      "meeting.extensions.granola.calendar_event.organizer" &&
      sourcePath.value !==
        "meeting.extensions.granola.calendar_event.organiser") ||
    !subject.present ||
    !isPlainObject(subject.value)
  ) {
    return undefined;
  }

  const subjectKind = ownDataProperty(subject.value, "kind");
  const subjectValue = ownDataProperty(subject.value, "value");
  return subjectKind.value === "email" && isCanonicalPersonEmail(subjectValue.value)
    ? subjectValue.value
    : undefined;
}

/**
 * Resolves a provider-observed Granola calendar organizer to one current
 * Authority membership. The only accepted bridge is a completed initial OIDC
 * login grant for exactly that email and membership. No email or source data
 * is persisted or logged here.
 *
 * Multiple active identity bindings are harmless only when they prove the
 * same exact Authority tuple. Any ambiguity fails closed.
 */
export function resolveGranolaMeetingOwnerAssigneeV1(input: {
  readonly authority_database: Database.Database;
  readonly organization_id: string;
  readonly observation: GranolaMeetingOwnerObservationV1;
}): CleanMeetingOwnerAssigneeV1 | undefined {
  const email = observedOrganizerEmail(input.observation);
  if (email === undefined || typeof input.organization_id !== "string") {
    return undefined;
  }

  const emailSha256 = personLoginGrantExpectedEmailSha256(email);
  const rows = input.authority_database
    .prepare(
      `SELECT DISTINCT membership.principal_id, membership.membership_id,
                       membership.membership_type
         FROM authority_memberships AS membership
         JOIN authority_oidc_identity_bindings AS identity_binding
           ON identity_binding.organization_id = membership.organization_id
          AND identity_binding.principal_id = membership.principal_id
          AND identity_binding.membership_id = membership.membership_id
          AND identity_binding.membership_type = membership.membership_type
         JOIN authority_person_login_grants AS login_grant
           ON login_grant.login_grant_sha256 =
                identity_binding.initial_login_grant_sha256
          AND login_grant.organization_id = identity_binding.organization_id
          AND login_grant.principal_id = identity_binding.principal_id
          AND login_grant.membership_id = identity_binding.membership_id
          AND login_grant.membership_type = identity_binding.membership_type
        WHERE membership.organization_id = ?
          AND membership.status = 'active'
          AND identity_binding.status = 'active'
          AND login_grant.consumed_at = identity_binding.bound_at
          AND login_grant.expected_email_sha256 = ?
          AND (
            (membership.membership_type = 'owner'
             AND membership.employee_email IS NULL
             AND membership.employee_email_sha256 IS NULL)
            OR
            (membership.membership_type = 'employee'
             AND membership.employee_email_sha256 = login_grant.expected_email_sha256)
          )`,
    )
    .all(input.organization_id, emailSha256) as AssigneeRow[];

  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (
    row === undefined ||
    typeof row.principal_id !== "string" ||
    typeof row.membership_id !== "string" ||
    (row.membership_type !== "owner" && row.membership_type !== "employee")
  ) {
    return undefined;
  }

  return Object.freeze({
    principal_id: row.principal_id,
    membership_id: row.membership_id,
    membership_type: row.membership_type,
  });
}
