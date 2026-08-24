import {
  canonicalJson,
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/** Local persistence shape: this adapter deliberately does not depend on Layer 4. */
export interface CleanPersonAnswerCompositionAuditEntryV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly session_family_id: string;
  readonly release_id: Sha256Digest;
  readonly generation_id: Sha256Digest;
  readonly record_head: {
    readonly position: number;
    readonly record_sha256: Sha256Digest | null;
  };
  readonly released_atoms_sha256: Sha256Digest;
  readonly prompt_sha256: Sha256Digest;
  readonly answer_sha256: Sha256Digest;
  readonly response_sha256: Sha256Digest;
  readonly citation_count: number;
  readonly checked_at: string;
}

/** Writes the already-provisioned answer_composition variant of the one audit table. */
export class SqliteCleanPersonAnswerCompositionAuditV1 {
  constructor(private readonly database: Database.Database) {}

  append(entry: CleanPersonAnswerCompositionAuditEntryV1): Sha256Digest {
    if (
      !Number.isSafeInteger(entry.citation_count) ||
      entry.citation_count < 0 ||
      entry.citation_count > 16 ||
      new Date(entry.checked_at).toISOString() !== entry.checked_at
    ) {
      throw new Error("clean Person answer composition audit entry is invalid");
    }
    const body = {
      schema_version: 1,
      kind: "echo-clean-person-answer-composition-audit-v1",
      context_kind: "answer_composition",
      prompt_sha256: entry.prompt_sha256,
      answer_sha256: entry.answer_sha256,
      authority_id: entry.authority_id,
      organization_id: entry.organization_id,
      state_lineage_id: entry.state_lineage_id,
      principal_id: entry.principal_id,
      membership_id: entry.membership_id,
      session_family_id: entry.session_family_id,
      release_id: entry.release_id,
      generation_id: entry.generation_id,
      record_head: entry.record_head,
      released_atoms_sha256: entry.released_atoms_sha256,
      response_sha256: entry.response_sha256,
      citation_count: entry.citation_count,
      checked_at: entry.checked_at,
    } as const;
    const body_json = canonicalJson(body);
    const row_sha256 = canonicalSha256(body);
    this.database
      .prepare(
        `INSERT INTO authority_person_read_decision_audit_v2
         (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
         VALUES (?, ?, 'answer_composition', ?, ?, ?)`,
      )
      .run(
        row_sha256,
        body_json,
        entry.prompt_sha256,
        entry.answer_sha256,
        entry.checked_at,
      );
    return row_sha256;
  }
}
