import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";

type AuditTableV1 =
  | "authority_person_read_decision_audit_v2"
  | "authority_project_read_audit_v1"
  | "authority_person_upload_read_audit_v1"
  | "authority_person_document_read_audit_v1";

/**
 * Appends one immutable audit row: the body's canonical JSON keyed by its
 * digest, which is the receipt. `columns` fills a table's own extra columns
 * (the read-decision audit's context kind and digests).
 */
export function appendAuditRowV1(
  database: Database.Database,
  table: AuditTableV1,
  body: object,
  recorded_at: string,
  columns: Readonly<Record<string, string | null>> = {},
): Sha256Digest {
  const row_sha256 = canonicalSha256(body);
  const names = ["row_sha256", "body_json", ...Object.keys(columns), "recorded_at"];
  database.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(row_sha256, canonicalJson(body), ...Object.values(columns), recorded_at);
  return row_sha256;
}
