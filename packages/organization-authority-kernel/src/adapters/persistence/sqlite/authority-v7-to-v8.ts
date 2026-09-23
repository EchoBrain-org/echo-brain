import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  applyAuthorityBaselineV7, authorityBaselineSha256V7, authorityBaselineSha256V8,
  authorityBaselineSqlV8, AUTHORITY_BASELINE_APPLICATION_ID_V1,
} from './baseline.js';
import { validateStoredStateLineageDatabaseManifestV1 } from '../../../state-lineage/state-lineage-manifest-v1.js';

const MANIFEST_SQL = `CREATE TABLE echo_state_lineage_manifest (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`;

function schema(database: Database.Database) {
  return database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
}
function healthy(database: Database.Database): boolean {
  return (database.pragma('integrity_check') as { integrity_check: string }[]).every(row => row.integrity_check === 'ok') &&
    (database.pragma('foreign_key_check') as unknown[]).length === 0;
}

/**
 * Explicit stopped-state copy. The source is read-only; the target must be
 * empty. All target DDL, rows and lineage commit together, so any failure
 * rolls the target back to empty. This never publishes/replaces live state.
 */
export function copyAuthorityV7ToV8(source: Database.Database, target: Database.Database): void {
  if (!source.readonly || target.readonly || source.inTransaction || target.inTransaction ||
      source.pragma('user_version', { simple: true }) !== 7 ||
      source.pragma('application_id', { simple: true }) !== AUTHORITY_BASELINE_APPLICATION_ID_V1 ||
      target.pragma('user_version', { simple: true }) !== 0 ||
      target.pragma('application_id', { simple: true }) !== 0 ||
      target.prepare('SELECT count(*) FROM sqlite_master').pluck().get() !== 0) {
    throw new Error('offline transition requires a read-only Authority V7 snapshot and an empty output');
  }
  if (target.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('offline transition requires foreign keys enabled on the output');
  source.exec('BEGIN');
  try {
    const expected = new Database(':memory:');
    try {
      applyAuthorityBaselineV7(expected);
      expected.exec(MANIFEST_SQL);
      if (!isDeepStrictEqual(schema(source), schema(expected))) throw new Error('offline transition requires the exact pinned V7 schema and lineage table');
    } finally { expected.close(); }
    if (!healthy(source)) throw new Error('offline transition refuses corrupt V7 state');
    const manifests = source.prepare('SELECT singleton, manifest_json, manifest_sha256 FROM echo_state_lineage_manifest').all();
    if (manifests.length !== 1) throw new Error('offline transition requires one Authority lineage manifest');
    const previous = validateStoredStateLineageDatabaseManifestV1(manifests[0]).body;
    const metadata = source.prepare('SELECT authority_id, organization_id FROM authority_metadata WHERE singleton = 1').get() as { authority_id: string; organization_id: string } | undefined;
    if (previous.role !== 'authority' || previous.database_schema_version !== 7 || previous.schema_sha256 !== authorityBaselineSha256V7() ||
        metadata === undefined || previous.authority_id !== metadata.authority_id || previous.organization_id !== metadata.organization_id) {
      throw new Error('offline transition lineage does not match V7 custody');
    }
    target.exec('BEGIN IMMEDIATE');
    try {
      target.exec(authorityBaselineSqlV8());
      target.pragma(`application_id = ${AUTHORITY_BASELINE_APPLICATION_ID_V1}`);
      target.pragma('user_version = 8');
      target.pragma('defer_foreign_keys = ON');
      // Existing transitions may reject final rows such as consumed sessions.
      // Restore them offline, then reinstall every exact V8 trigger before commit.
      const triggers = target.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string; sql: string }[];
      for (const trigger of triggers) target.exec(`DROP TRIGGER "${trigger.name}"`);
      const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'echo_state_lineage_manifest' ORDER BY name").all() as { name: string }[];
      for (const { name } of tables) {
        if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unexpected V7 table');
        const columns = target.pragma(`table_info("${name}")`) as { name: string; pk: number }[];
        const keys = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
        if (keys.length === 0) throw new Error('V7 table has no preservation key');
        const insert = target.prepare(`INSERT INTO "${name}" (${columns.map(column => `"${column.name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        const read = target.prepare(`SELECT * FROM "${name}" WHERE ${keys.map(column => `"${column.name}" IS ?`).join(' AND ')}`).safeIntegers();
        let count = 0;
        for (const row of source.prepare(`SELECT * FROM "${name}"`).safeIntegers().iterate() as Iterable<Record<string, unknown>>) {
          insert.run(...columns.map(column => row[column.name]));
          // isDeepStrictEqual preserves BLOB identity and SQLite integer values;
          // JSON canonicalization would reject the retained PKCE sealed BLOBs.
          if (!isDeepStrictEqual(read.get(...keys.map(column => row[column.name])), row)) throw new Error('offline transition data preservation failed');
          count += 1;
        }
        if (target.prepare(`SELECT count(*) FROM "${name}"`).pluck().get() !== count) throw new Error('offline transition row count changed');
      }
      target.exec(MANIFEST_SQL);
      const next = { ...previous, database_schema_version: 8, schema_sha256: authorityBaselineSha256V8() };
      target.prepare('INSERT INTO echo_state_lineage_manifest VALUES (1, ?, ?)').run(canonicalJson(next), canonicalSha256(next));
      for (const trigger of triggers) target.exec(trigger.sql);
      if (!healthy(target)) throw new Error('offline transition V8 integrity preservation failed');
      target.exec('COMMIT');
    } catch (error) {
      try { target.exec('ROLLBACK'); } catch {}
      throw error;
    }
  } finally { source.exec('ROLLBACK'); }
}
