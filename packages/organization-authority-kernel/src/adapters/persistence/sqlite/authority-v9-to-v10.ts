import Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  applyAuthorityBaselineV9,
  authorityBaselineSha256V9,
  authorityBaselineSha256V10,
  authorityBaselineSqlV10,
  AUTHORITY_BASELINE_APPLICATION_ID_V1,
} from "./baseline.js";
import { validateStoredStateLineageDatabaseManifestV1 } from "../../../state-lineage/state-lineage-manifest-v1.js";

const MANIFEST_SQL = `CREATE TABLE echo_state_lineage_manifest (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`;

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

/**
 * Explicit stopped-state copy from the exact V9 custody schema to V10. The
 * source is read-only and the target is empty. Every retained row is copied
 * byte-for-byte except project lifecycle state, which V10 initializes to
 * `active` for every V9 project.
 */
export function copyAuthorityV9ToV10(source: Database.Database, target: Database.Database): void {
  if (!source.readonly || target.readonly || source.inTransaction || target.inTransaction ||
      source.pragma("user_version", { simple: true }) !== 9 ||
      source.pragma("application_id", { simple: true }) !== AUTHORITY_BASELINE_APPLICATION_ID_V1 ||
      target.pragma("user_version", { simple: true }) !== 0 ||
      target.pragma("application_id", { simple: true }) !== 0 ||
      target.prepare("SELECT count(*) FROM sqlite_master").pluck().get() !== 0) {
    throw new Error("offline transition requires a read-only Authority V9 snapshot and an empty output");
  }
  if (target.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("offline transition requires foreign keys enabled on the output");
  }
  source.exec("BEGIN");
  try {
    const expected = new Database(":memory:");
    try {
      applyAuthorityBaselineV9(expected);
      expected.exec(MANIFEST_SQL);
      if (!isDeepStrictEqual(schema(source), schema(expected))) {
        throw new Error("offline transition requires the exact pinned V9 schema and lineage table");
      }
    } finally { expected.close(); }
    if (!healthy(source)) throw new Error("offline transition refuses corrupt V9 state");
    const manifests = source.prepare("SELECT singleton, manifest_json, manifest_sha256 FROM echo_state_lineage_manifest").all();
    if (manifests.length !== 1) throw new Error("offline transition requires one Authority lineage manifest");
    const previous = validateStoredStateLineageDatabaseManifestV1(manifests[0]).body;
    const metadata = source.prepare("SELECT authority_id, organization_id FROM authority_metadata WHERE singleton = 1").get() as { authority_id: string; organization_id: string } | undefined;
    if (previous.role !== "authority" || previous.database_schema_version !== 9 || previous.schema_sha256 !== authorityBaselineSha256V9() ||
        metadata === undefined || previous.authority_id !== metadata.authority_id || previous.organization_id !== metadata.organization_id) {
      throw new Error("offline transition lineage does not match V9 custody");
    }

    target.exec("BEGIN IMMEDIATE");
    try {
      target.exec(authorityBaselineSqlV10());
      target.pragma(`application_id = ${AUTHORITY_BASELINE_APPLICATION_ID_V1}`);
      target.pragma("user_version = 10");
      target.pragma("defer_foreign_keys = ON");
      const triggers = target.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string; sql: string }[];
      for (const trigger of triggers) target.exec(`DROP TRIGGER \"${trigger.name}\"`);

      for (const name of tableNames(source)) {
        if (name !== "authority_projects_v1") copyExactTable(source, target, name);
      }
      const projects = source.prepare("SELECT project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type FROM authority_projects_v1").all() as Record<string, unknown>[];
      const insertProject = target.prepare("INSERT INTO authority_projects_v1 (project_id, organization_id, name, status, created_at, creator_principal_id, creator_membership_id, creator_membership_type) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)");
      const readProject = target.prepare("SELECT project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type FROM authority_projects_v1 WHERE project_id = ?").safeIntegers();
      for (const project of projects) {
        insertProject.run(project.project_id, project.organization_id, project.name, project.created_at, project.creator_principal_id, project.creator_membership_id, project.creator_membership_type);
        if (!isDeepStrictEqual(readProject.get(project.project_id), project)) {
          throw new Error("offline transition project preservation failed");
        }
      }
      if (target.prepare("SELECT count(*) FROM authority_projects_v1").pluck().get() !== projects.length) throw new Error("offline transition project row count changed");

      target.exec(MANIFEST_SQL);
      const next = { ...previous, database_schema_version: 10, schema_sha256: authorityBaselineSha256V10() };
      target.prepare("INSERT INTO echo_state_lineage_manifest VALUES (1, ?, ?)").run(canonicalJson(next), canonicalSha256(next));
      for (const trigger of triggers) target.exec(trigger.sql);
      rebuildVirtualTables(target);
      if (!healthy(target)) throw new Error("offline transition V10 integrity preservation failed");
      target.exec("COMMIT");
    } catch (error) {
      try { target.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    source.exec("ROLLBACK");
  }
}
