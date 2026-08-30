import { parseCanonicalJson } from "@echo-brain/federation-protocol";
import type { JsonObject, Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/**
 * The intentionally small permission-aware person-record read model.
 *
 * Authority has already authenticated the current Person session before this
 * query is called.  This reader makes the remaining record-side decision from
 * immutable facts only: every active Person may read member-readable records,
 * while a restricted record is visible only to the exact reviewer tuple that
 * resolved it.  Rejections produce no Person fact and consequently cannot be
 * returned by this query.
 */
export interface PersonRecordReaderV1Input {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly limit?: number;
}

export interface PersonReadableRecordV1 {
  readonly position: number;
  readonly approval_id: string;
  readonly record_sha256: Sha256Digest;
  readonly envelope: JsonObject;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function requiredText(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
}

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

/**
 * Reads only the exact immutable V4 rows admitted by a Person-v2 fact.
 * It intentionally has no write methods, no derived-store dependency, and no
 * fallback to historical record schemas.
 */
export class PersonRecordReaderV1 {
  constructor(private readonly database: Database.Database) {}

  list(
    input: PersonRecordReaderV1Input,
  ): readonly PersonReadableRecordV1[] {
    requiredText(input.authority_id, "clean Person record authority_id");
    requiredText(input.organization_id, "clean Person record organization_id");
    requiredText(
      input.state_lineage_id,
      "clean Person record state_lineage_id",
    );
    requiredText(input.principal_id, "clean Person record principal_id");
    requiredText(input.membership_id, "clean Person record membership_id");
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(
        `clean Person record limit must be an integer from 1 to ${MAX_LIMIT}`,
      );
    }

    const rows = this.database
      .prepare(
        `SELECT record.position, record.approval_id, record.record_sha256,
                record.canonical_envelope
           FROM organization_record_log AS record
          WHERE record.event_kind = 'approved'
            AND (
              EXISTS (
                SELECT 1
                  FROM organization_record_member_readable_person_fact AS member_fact
                 WHERE member_fact.record_position = record.position
                   AND member_fact.record_sha256 = record.record_sha256
                   AND member_fact.authority_id = ?
                   AND member_fact.organization_id = ?
                   AND member_fact.state_lineage_id = ?
              )
              OR EXISTS (
                SELECT 1
                  FROM organization_record_restricted_reviewer_person_fact AS reviewer_fact
                 WHERE reviewer_fact.record_position = record.position
                   AND reviewer_fact.record_sha256 = record.record_sha256
                   AND reviewer_fact.authority_id = ?
                   AND reviewer_fact.organization_id = ?
                   AND reviewer_fact.state_lineage_id = ?
                   AND reviewer_fact.reviewer_principal_id = ?
                   AND reviewer_fact.reviewer_membership_id = ?
              )
            )
          ORDER BY record.position DESC
          LIMIT ?`,
      )
      .all(
        input.authority_id,
        input.organization_id,
        input.state_lineage_id,
        input.authority_id,
        input.organization_id,
        input.state_lineage_id,
        input.principal_id,
        input.membership_id,
        limit,
      ) as Array<{
      readonly position: number;
      readonly approval_id: string;
      readonly record_sha256: Sha256Digest;
      readonly canonical_envelope: string;
    }>;

    return Object.freeze(
      rows.map((row) => {
        if (!Number.isSafeInteger(row.position) || row.position < 1) {
          throw new Error("clean Person readable record position is invalid");
        }
        requiredText(
          row.approval_id,
          "clean Person readable record approval_id",
        );
        return Object.freeze({
          position: row.position,
          approval_id: row.approval_id,
          record_sha256: row.record_sha256,
          envelope: asObject(
            parseCanonicalJson(row.canonical_envelope),
            "clean Person readable V4 envelope",
          ),
        });
      }),
    );
  }
}
