import { readdirSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIRECTORY_URL = new URL(
  '../../../../migrations/',
  import.meta.url,
);
const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;

interface AuthorityMigration {
  version: number;
  filename: string;
}

function authorityMigrations(): readonly AuthorityMigration[] {
  const migrations = readdirSync(MIGRATIONS_DIRECTORY_URL)
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = MIGRATION_FILE_PATTERN.exec(filename);
      if (match === null) {
        throw new Error(`invalid authority migration filename: ${filename}`);
      }
      return { version: Number.parseInt(match[1]!, 10), filename };
    })
    .sort((left, right) => left.version - right.version);
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `authority migrations must be contiguous from 0001; expected ${expected}, found ${migration.version}`,
      );
    }
  }
  if (migrations.length === 0) {
    throw new Error('authority database has no migrations');
  }
  return migrations;
}

export function currentAuthoritySchemaVersion(): number {
  return authorityMigrations().length;
}

export function migrateAuthorityDatabase(database: Database.Database): void {
  const migrations = authorityMigrations();
  const currentSchemaVersion = migrations.length;
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.pragma('user_version', { simple: true }) as number;
    if (current > currentSchemaVersion) {
      throw new Error(
        `authority database schema ${current} is newer than supported schema ${currentSchemaVersion}`,
      );
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      database.exec(
        readFileSync(
          new URL(migration.filename, MIGRATIONS_DIRECTORY_URL),
          'utf8',
        ),
      );
      database.pragma(`user_version = ${migration.version}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
