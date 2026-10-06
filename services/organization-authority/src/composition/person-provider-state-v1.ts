import { existsSync, lstatSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { canonicalJson } from '@echo-brain/federation-protocol';

export function assertPrivatePersonProviderDatabaseV1(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Connector database is not a private regular file');
}
/** Binds metadata-only provider state to the exact Authority lineage and provider selection. */
export function bindPersonProviderStateV1(db: Database.Database, table: string, binding: unknown, mismatch: string): void {
  if (!/^authority_[a-z_0-9]+_binding_v1$/.test(table)) throw new Error('Invalid provider state binding table');
  const bytes = canonicalJson(binding);
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (singleton INTEGER PRIMARY KEY CHECK (singleton=1), binding_json TEXT NOT NULL) STRICT`);
    const current = db.prepare(`SELECT binding_json FROM ${table} WHERE singleton=1`).get() as { binding_json: string } | undefined;
    if (!current) db.prepare(`INSERT INTO ${table}(singleton,binding_json) VALUES (1,?)`).run(bytes);
    else if (current.binding_json !== bytes) throw new Error(mismatch);
  })();
}
