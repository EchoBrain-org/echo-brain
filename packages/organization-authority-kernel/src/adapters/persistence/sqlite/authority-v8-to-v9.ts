import Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  applyAuthorityBaselineV8,
  authorityBaselineSha256V8,
  authorityBaselineSha256V9,
  authorityBaselineSqlV9,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
} from "./baseline.js";
import { validateStoredStateLineageDatabaseManifestV1 } from "../../../state-lineage/state-lineage-manifest-v1.js";

const MANIFEST_SQL = `CREATE TABLE echo_state_lineage_manifest (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`;

const REBUILT_TABLES = new Set([
  "authority_person_updates_v2",
  "authority_project_context_associations_v1",
  "authority_person_documents_v1",
  "authority_person_document_associations_v1",
]);

function schema(database: Database.Database) {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}

function healthy(database: Database.Database): boolean {
  return (database.pragma("integrity_check") as { integrity_check: string }[]).every((row) => row.integrity_check === "ok") &&
    (database.pragma("foreign_key_check") as unknown[]).length === 0;
}

function tableNames(database: Database.Database): string[] {
  const virtual = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name);
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'echo_state_lineage_manifest' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)
    // FTS virtual tables and their private shadow tables have no stable
    // preservation key. Their canonical input is the ordinary content table,
    // so the target rebuilds them after that content has been copied.
    .filter((name) => !virtual.some((table) => name === table || name.startsWith(`${table}_`)));
}

function rebuildVirtualTables(database: Database.Database): void {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name").all() as { name: string }[];
  for (const { name } of tables) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unexpected Authority virtual table");
    database.prepare(`INSERT INTO \"${name}\"(\"${name}\") VALUES ('rebuild')`).run();
  }
}

function columns(database: Database.Database, name: string): string[] {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unexpected Authority table");
  return (database.pragma(`table_info(\"${name}\")`) as { name: string }[]).map((column) => column.name);
}

function copyExactTable(source: Database.Database, target: Database.Database, name: string): void {
  const sourceColumns = columns(source, name);
  const targetColumns = columns(target, name);
  if (!isDeepStrictEqual(sourceColumns, targetColumns) || sourceColumns.length === 0) {
    throw new Error(`offline transition table shape differs: ${name}`);
  }
  const insert = target.prepare(`INSERT INTO \"${name}\" (${targetColumns.map((column) => `\"${column}\"`).join(",")}) VALUES (${targetColumns.map(() => "?").join(",")})`);
  const keys = (target.pragma(`table_info(\"${name}\")`) as { name: string; pk: number }[])
    .filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
  if (keys.length === 0) throw new Error(`offline transition table has no preservation key: ${name}`);
  const read = target.prepare(`SELECT * FROM \"${name}\" WHERE ${keys.map((column) => `\"${column.name}\" IS ?`).join(" AND ")}`).safeIntegers();
  let count = 0;
  for (const row of source.prepare(`SELECT * FROM \"${name}\"`).safeIntegers().iterate() as Iterable<Record<string, unknown>>) {
    insert.run(...targetColumns.map((column) => row[column]));
    if (!isDeepStrictEqual(read.get(...keys.map((column) => row[column.name])), row)) {
      throw new Error(`offline transition data preservation failed: ${name}`);
    }
    count += 1;
  }
  if (target.prepare(`SELECT count(*) FROM \"${name}\"`).pluck().get() !== count) {
    throw new Error(`offline transition row count changed: ${name}`);
  }
}

function legacyAssociation(projectID: unknown): string {
  return canonicalJson(typeof projectID === "string" ? [projectID] : []);
}

function legacyAudience(kind: unknown, projectID: unknown): string {
  if (kind === "project" && typeof projectID === "string") return canonicalJson([projectID]);
  return canonicalJson([]);
}

/**
 * Explicit stopped-state copy from the exact V8 custody schema to V9. The
 * source is read-only and the target is empty. Legacy scalar project fields
 * are retained unchanged; V9 derives immutable request snapshots and audience
 * grant rows from them, while retaining current mutable associations as rows.
 */
export function copyAuthorityV8ToV9(source: Database.Database, target: Database.Database): void {
  if (!source.readonly || target.readonly || source.inTransaction || target.inTransaction ||
      source.pragma("user_version", { simple: true }) !== 8 ||
      source.pragma("application_id", { simple: true }) !== AUTHORITY_BASELINE_APPLICATION_ID_V1 ||
      target.pragma("user_version", { simple: true }) !== 0 ||
      target.pragma("application_id", { simple: true }) !== 0 ||
      target.prepare("SELECT count(*) FROM sqlite_master").pluck().get() !== 0) {
    throw new Error("offline transition requires a read-only Authority V8 snapshot and an empty output");
  }
  if (target.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("offline transition requires foreign keys enabled on the output");
  }
  source.exec("BEGIN");
  try {
    const expected = new Database(":memory:");
    try {
      applyAuthorityBaselineV8(expected);
      expected.exec(MANIFEST_SQL);
      if (!isDeepStrictEqual(schema(source), schema(expected))) {
        throw new Error("offline transition requires the exact pinned V8 schema and lineage table");
      }
    } finally { expected.close(); }
    if (!healthy(source)) throw new Error("offline transition refuses corrupt V8 state");
    const manifests = source.prepare("SELECT singleton, manifest_json, manifest_sha256 FROM echo_state_lineage_manifest").all();
    if (manifests.length !== 1) throw new Error("offline transition requires one Authority lineage manifest");
    const previous = validateStoredStateLineageDatabaseManifestV1(manifests[0]).body;
    const metadata = source.prepare("SELECT authority_id, organization_id FROM authority_metadata WHERE singleton = 1").get() as { authority_id: string; organization_id: string } | undefined;
    if (previous.role !== "authority" || previous.database_schema_version !== 8 || previous.schema_sha256 !== authorityBaselineSha256V8() ||
        metadata === undefined || previous.authority_id !== metadata.authority_id || previous.organization_id !== metadata.organization_id) {
      throw new Error("offline transition lineage does not match V8 custody");
    }

    target.exec("BEGIN IMMEDIATE");
    try {
      target.exec(authorityBaselineSqlV9());
      target.pragma(`application_id = ${AUTHORITY_BASELINE_APPLICATION_ID_V1}`);
      target.pragma("user_version = 9");
      target.pragma("defer_foreign_keys = ON");
      const triggers = target.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string; sql: string }[];
      for (const trigger of triggers) target.exec(`DROP TRIGGER \"${trigger.name}\"`);

      const textRows = source.prepare("SELECT organization_id, principal_id, membership_id, membership_type, request_id, context_id, payload_sha256, title, text, audience_kind, audience_project_id, project_id, received_at FROM authority_person_updates_v2").all() as Record<string, unknown>[];
      const insertText = target.prepare("INSERT INTO authority_person_updates_v2 (organization_id, principal_id, membership_id, membership_type, request_id, request_version, context_id, payload_sha256, title, text, audience_kind, audience_project_id, submitted_association_project_ids_json, audience_project_ids_json, project_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertTextAudience = target.prepare("INSERT INTO authority_person_update_audience_projects_v1 (context_id, project_id, organization_id) VALUES (?, ?, ?)");
      for (const row of textRows) {
        const submitted = legacyAssociation(row.project_id);
        const audience = legacyAudience(row.audience_kind, row.audience_project_id);
        insertText.run(row.organization_id, row.principal_id, row.membership_id, row.membership_type, row.request_id, 2, row.context_id, row.payload_sha256, row.title, row.text, row.audience_kind, row.audience_project_id, submitted, audience, row.project_id, row.received_at);
        if (row.audience_kind === "project" && typeof row.audience_project_id === "string") {
          insertTextAudience.run(row.context_id, row.audience_project_id, row.organization_id);
        }
      }
      if (target.prepare("SELECT count(*) FROM authority_person_updates_v2").pluck().get() !== textRows.length) throw new Error("offline transition text row count changed");

      const documentRows = source.prepare("SELECT document_id, organization_id, principal_id, membership_id, membership_type, request_id, filename, title, detected_media_type, original_size, original_sha256, payload_sha256, audience_kind, audience_project_id, project_id, received_at FROM authority_person_documents_v1").all() as Record<string, unknown>[];
      const insertDocument = target.prepare("INSERT INTO authority_person_documents_v1 (document_id, organization_id, principal_id, membership_id, membership_type, request_id, request_version, filename, title, detected_media_type, original_size, original_sha256, payload_sha256, audience_kind, audience_project_id, submitted_association_project_ids_json, audience_project_ids_json, project_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertDocumentAudience = target.prepare("INSERT INTO authority_person_document_audience_projects_v1 (document_id, project_id, organization_id) VALUES (?, ?, ?)");
      for (const row of documentRows) {
        const submitted = legacyAssociation(row.project_id);
        const audience = legacyAudience(row.audience_kind, row.audience_project_id);
        insertDocument.run(row.document_id, row.organization_id, row.principal_id, row.membership_id, row.membership_type, row.request_id, 1, row.filename, row.title, row.detected_media_type, row.original_size, row.original_sha256, row.payload_sha256, row.audience_kind, row.audience_project_id, submitted, audience, row.project_id, row.received_at);
        if (row.audience_kind === "project" && typeof row.audience_project_id === "string") {
          insertDocumentAudience.run(row.document_id, row.audience_project_id, row.organization_id);
        }
      }
      if (target.prepare("SELECT count(*) FROM authority_person_documents_v1").pluck().get() !== documentRows.length) throw new Error("offline transition document row count changed");

      for (const name of tableNames(source)) {
        if (!REBUILT_TABLES.has(name)) copyExactTable(source, target, name);
      }
      copyExactTable(source, target, "authority_project_context_associations_v1");
      copyExactTable(source, target, "authority_person_document_associations_v1");

      target.exec(MANIFEST_SQL);
      const next = { ...previous, database_schema_version: 9, schema_sha256: authorityBaselineSha256V9() };
      target.prepare("INSERT INTO echo_state_lineage_manifest VALUES (1, ?, ?)").run(canonicalJson(next), canonicalSha256(next));
      for (const trigger of triggers) target.exec(trigger.sql);
      rebuildVirtualTables(target);
      if (!healthy(target)) throw new Error("offline transition V9 integrity preservation failed");
      target.exec("COMMIT");
    } catch (error) {
      try { target.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    source.exec("ROLLBACK");
  }
}
