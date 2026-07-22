import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 1;
const FIRST_MIGRATION_URL = new URL(
  '../../../../migrations/0001_single_org_authority.sql',
  import.meta.url,
);

export function migrateAuthorityDatabase(database: Database.Database): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.pragma('user_version', { simple: true }) as number;
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `authority database schema ${current} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    if (current === 0) {
      database.exec(readFileSync(FIRST_MIGRATION_URL, 'utf8'));
      database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
