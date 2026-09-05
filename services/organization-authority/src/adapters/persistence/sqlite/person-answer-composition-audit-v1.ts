import {
  canonicalJson,
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

/** Local persistence shape: this adapter deliberately does not depend on answer composition. */
export interface PersonAnswerCompositionAuditEntryV1 {
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
  readonly outcome:
    | "answered"
    | "insufficient_evidence"
    | "authorship_unsupported";
  readonly retrieval: {
    readonly planned_query_count: number;
    readonly released_atom_count: number;
    readonly context_atom_count: number;
    readonly query_hit_counts: readonly number[];
  };
  readonly checked_at: string;
  /** Optional commitment for a caller-supplied opaque operation binding. */
  readonly operation_correlation_sha256?: Sha256Digest;
}

function validSha256Digest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

/** Writes the already-provisioned answer_composition variant of the one audit table. */
export class SqlitePersonAnswerCompositionAuditV1 {
  constructor(private readonly database: Database.Database) {}

  append(entry: PersonAnswerCompositionAuditEntryV1): Sha256Digest {
    if (
      !Number.isSafeInteger(entry.citation_count) ||
      entry.citation_count < 0 ||
      entry.citation_count > 16 ||
      (entry.outcome !== "answered" &&
        entry.outcome !== "insufficient_evidence" &&
        entry.outcome !== "authorship_unsupported") ||
      !Number.isSafeInteger(entry.retrieval.planned_query_count) ||
      entry.retrieval.planned_query_count < 1 ||
      entry.retrieval.planned_query_count > 4 ||
      !Number.isSafeInteger(entry.retrieval.released_atom_count) ||
      entry.retrieval.released_atom_count < 0 ||
      entry.retrieval.released_atom_count > 40 ||
      !Number.isSafeInteger(entry.retrieval.context_atom_count) ||
      entry.retrieval.context_atom_count < 0 ||
      entry.retrieval.context_atom_count > entry.retrieval.released_atom_count ||
      !Array.isArray(entry.retrieval.query_hit_counts) ||
      entry.retrieval.query_hit_counts.length !== entry.retrieval.planned_query_count ||
      entry.retrieval.query_hit_counts.some(
        (count) => !Number.isSafeInteger(count) || count < 0 || count > 10,
      ) ||
      (entry.operation_correlation_sha256 !== undefined &&
        !validSha256Digest(entry.operation_correlation_sha256)) ||
      new Date(entry.checked_at).toISOString() !== entry.checked_at
    ) {
      throw new Error("Person answer composition audit entry is invalid");
    }
    const bodyV1 = {
      schema_version: 1,
      kind: "echo-person-answer-composition-audit-v1",
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
      outcome: entry.outcome,
      retrieval: entry.retrieval,
      checked_at: entry.checked_at,
    } as const;
    const body = entry.operation_correlation_sha256 === undefined
      ? bodyV1
      : {
          ...bodyV1,
          schema_version: 2 as const,
          kind: "echo-person-answer-composition-audit-v2" as const,
          operation_correlation_sha256: entry.operation_correlation_sha256,
        };
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
