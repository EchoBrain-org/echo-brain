import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

export interface CleanPersonRecordReadAuditEntryV1 {
  readonly read_mode: "layer1" | "layer2";
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly session_family_id: string;
  readonly result_count: number;
  readonly response_sha256: Sha256Digest;
  readonly checked_at: string;
}

/**
 * Appends one compact, immutable release witness. It intentionally stores no
 * bearer credential, query, or response body: the digest commits to the exact
 * released response while the Authority row binds the current Person tuple.
 */
export class SqliteCleanPersonRecordReadAuditV1 {
  constructor(private readonly database: Database.Database) {}

  append(entry: CleanPersonRecordReadAuditEntryV1): Sha256Digest {
    if (
      !Number.isSafeInteger(entry.result_count) ||
      entry.result_count < 0 ||
      entry.result_count > 100
    ) {
      throw new Error("clean Person record read result count is invalid");
    }
    if (new Date(entry.checked_at).toISOString() !== entry.checked_at) {
      throw new Error("clean Person record read audit time must be canonical UTC");
    }
    const body = {
      schema_version: 1,
      kind: "echo-clean-person-record-read-audit-v1",
      context_kind: "record_read",
      prompt_sha256: null,
      answer_sha256: null,
      read_mode: entry.read_mode,
      authority_id: entry.authority_id,
      organization_id: entry.organization_id,
      state_lineage_id: entry.state_lineage_id,
      principal_id: entry.principal_id,
      membership_id: entry.membership_id,
      session_family_id: entry.session_family_id,
      result_count: entry.result_count,
      response_sha256: entry.response_sha256,
      checked_at: entry.checked_at,
    } as const;
    const body_json = canonicalJson(body);
    const row_sha256 = canonicalSha256(body);
    this.database
      .prepare(
        `INSERT INTO authority_person_read_decision_audit_v2
         (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
         VALUES (?, ?, 'record_read', NULL, NULL, ?)`,
      )
      .run(row_sha256, body_json, entry.checked_at);
    return row_sha256;
  }
}
