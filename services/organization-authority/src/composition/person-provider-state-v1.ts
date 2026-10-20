import { chmodSync, existsSync, lstatSync } from 'node:fs';
import Database from 'better-sqlite3';
import { canonicalJson } from '@echo-brain/federation-protocol';

export function assertPrivatePersonProviderDatabaseV1(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Connector database is not a private regular file');
}

/**
 * Opens a person provider's own database in the Authority state directory, the same way for every
 * provider: a file that exists must already be a private regular file of this user (one that is not is
 * refused, never repaired), a new one is made 0600, and the shared pragmas apply before `bind`, the
 * provider's lineage binding where it has one. A database the caller supplies (tests, the staging
 * rehearsal's sidecar) skips the file checks; `close` leaves it open.
 */
export function openPersonProviderDatabaseV1(path: string, options: {
  readonly supplied?: Database.Database;
  readonly bind?: (database: Database.Database) => void;
} = {}): { readonly database: Database.Database; close(): void } {
  const owned = options.supplied === undefined;
  if (owned) assertPrivatePersonProviderDatabaseV1(path);
  const database = options.supplied ?? new Database(path);
  try {
    if (owned) chmodSync(path, 0o600);
    if (database.inTransaction) throw new Error('Connector store must own its transaction boundary');
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    options.bind?.(database);
  } catch (error) { if (owned) database.close(); throw error; }
  return Object.freeze({ database, close() { if (owned) database.close(); } });
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
