import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

const FILENAME_PATTERN = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/;

export interface Migration {
  version: number;
  filename: string;
  sql: string;
}

export function loadMigrations(migrationsDir: string): Migration[] {
  const entries = readdirSync(migrationsDir);
  const migrations: Migration[] = [];
  for (const filename of entries) {
    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) continue;
    const version = Number.parseInt(match[1]!, 10);
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    migrations.push({ version, filename, sql });
  }
  migrations.sort((a, b) => a.version - b.version);

  for (const [i, m] of migrations.entries()) {
    const expected = i + 1;
    if (m.version !== expected) {
      throw new Error(
        `migration sequence error: expected version ${expected} but found ${m.version} (${m.filename})`,
      );
    }
  }
  return migrations;
}

export function migrate(db: Database.Database, migrationsDir: string): number {
  const migrations = loadMigrations(migrationsDir);
  // Serialize the version read and every schema change. Reading user_version
  // before taking the write lock lets two first-start processes both decide
  // to apply the same CREATE statements from a stale version snapshot.
  db.exec('BEGIN IMMEDIATE');
  try {
    let applied = db.pragma('user_version', { simple: true }) as number;
    for (const m of migrations) {
      if (m.version <= applied) continue;
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
      applied = m.version;
    }
    db.exec('COMMIT');
    return applied;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the migration failure if SQLite already rolled back.
    }
    throw error;
  }
}
