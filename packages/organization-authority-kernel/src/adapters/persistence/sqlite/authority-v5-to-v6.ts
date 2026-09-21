import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { applyAuthorityBaselineV5, applyAuthorityBaselineV6, authorityBaselineSha256V5, authorityBaselineSha256V6, AUTHORITY_BASELINE_APPLICATION_ID_V1 } from './baseline.js';
import { validateStateLineageDatabaseManifestV1 } from '../../../state-lineage/state-lineage-manifest-v1.js';

function schema(database: Database.Database) {
  return database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'echo_state_lineage_manifest' ORDER BY type, name`).all();
}

/** Explicit offline copy only: the V5 input is read-only and the V6 output must be absent/empty. */
export function copyAuthorityV5ToV6(source: Database.Database, target: Database.Database): void {
  if (!source.readonly || source.inTransaction || target.inTransaction ||
      source.pragma('user_version', { simple: true }) !== 5 ||
      source.pragma('application_id', { simple: true }) !== AUTHORITY_BASELINE_APPLICATION_ID_V1) throw new Error('offline transition requires a read-only Authority V5 snapshot and an empty output');
  const expected = new Database(':memory:');
  try {
    applyAuthorityBaselineV5(expected);
    if (canonicalJson(schema(source)) !== canonicalJson(schema(expected))) throw new Error('offline transition requires the exact pinned V5 schema');
  } finally { expected.close(); }
  if ((source.pragma('integrity_check') as { integrity_check: string }[]).some(row => row.integrity_check !== 'ok') || (source.pragma('foreign_key_check') as unknown[]).length !== 0) throw new Error('offline transition refuses corrupt V5 state');
  applyAuthorityBaselineV6(target);
  source.exec('BEGIN');
  try {
    target.transaction(() => {
      target.pragma('defer_foreign_keys = ON');
      // Runtime transition guards intentionally refuse inserting already-consumed
      // sessions or posting outboxes. This stopped-state copy restores final rows,
      // then reinstalls every exact V6 trigger before publishing the output.
      const triggers = target.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).all() as { name: string; sql: string }[];
      for (const trigger of triggers) target.exec(`DROP TRIGGER "${trigger.name}"`);
      const tables = source.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all() as { name: string }[];
      for (const { name } of tables) {
        if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unexpected V5 table');
        const rows = source.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
        if (name === 'echo_state_lineage_manifest') {
          if (rows.length !== 1) throw new Error('offline transition requires one Authority lineage manifest');
          const row = rows[0]!;
          const previous = validateStateLineageDatabaseManifestV1(JSON.parse(row.manifest_json as string));
          if (previous.role !== 'authority' || previous.database_schema_version !== 5 || previous.schema_sha256 !== authorityBaselineSha256V5() || canonicalSha256(previous) !== row.manifest_sha256 || canonicalJson(previous) !== row.manifest_json) throw new Error('offline transition lineage does not match V5');
          const next = { ...previous, database_schema_version: 6, schema_sha256: authorityBaselineSha256V6() };
          const create = source.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).pluck().get(name) as string;
          target.exec(create);
          target.prepare(`INSERT INTO echo_state_lineage_manifest VALUES (1, ?, ?)`).run(canonicalJson(next), canonicalSha256(next));
          continue;
        }
        if (rows.length === 0) continue;
        const columns = (target.pragma(`table_info("${name}")`) as { name: string }[]).map(column => column.name);
        const insert = target.prepare(`INSERT INTO "${name}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) insert.run(...columns.map(column => row[column]));
        if (canonicalJson(target.prepare(`SELECT * FROM "${name}"`).all()) !== canonicalJson(rows)) throw new Error('offline transition data preservation failed');
      }
      for (const trigger of triggers) target.exec(trigger.sql);
      if ((target.pragma('foreign_key_check') as unknown[]).length !== 0) throw new Error('offline transition foreign-key preservation failed');
    }).immediate();
  } finally { source.exec('ROLLBACK'); }
}
