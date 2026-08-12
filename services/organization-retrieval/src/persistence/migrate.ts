import { readdirSync, readFileSync } from 'node:fs';
import { sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type { ReadableSearchPlaneDefinition } from './database-definition.js';

const MIGRATION_FILENAME = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;

interface Migration {
  readonly version: number;
  readonly filename: string;
  readonly sql: string;
  readonly sha256: string;
}

function migrations(definition: ReadableSearchPlaneDefinition): readonly Migration[] {
  const values = readdirSync(definition.migrations_directory)
    .map((filename) => {
      const match = MIGRATION_FILENAME.exec(filename);
      if (match === null) throw new Error(`invalid readable-search ${definition.plane} migration filename`);
      const sql = readFileSync(new URL(filename, definition.migrations_directory), 'utf8');
      return { version: Number(match[1]), filename, sql, sha256: sha256Digest(sql) as string };
    })
    .sort((left, right) => left.version - right.version);
  if (values.length === 0) throw new Error(`readable-search ${definition.plane} has no migrations`);
  values.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`readable-search ${definition.plane} migrations must be contiguous`);
    }
  });
  return values;
}

function schemaSha256(database: Database.Database): string {
  return sha256Digest(JSON.stringify(database.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`,
  ).all())) as string;
}

function verify(database: Database.Database, definition: ReadableSearchPlaneDefinition): void {
  const all = migrations(definition);
  const version = database.pragma('user_version', { simple: true }) as number;
  const applicationId = database.pragma('application_id', { simple: true }) as number;
  if (version !== all.length || applicationId !== definition.application_id) {
    throw new Error(`readable-search ${definition.plane} schema identity is invalid`);
  }
  const rows = database.prepare(
    'SELECT version, filename, migration_sha256, schema_sha256 FROM retrieval_schema_migrations ORDER BY version',
  ).all() as { version: number; filename: string; migration_sha256: string; schema_sha256: string }[];
  if (rows.length !== all.length) throw new Error(`readable-search ${definition.plane} migration ledger is invalid`);
  rows.forEach((row, index) => {
    const migration = all[index]!;
    if (row.version !== migration.version || row.filename !== migration.filename || row.migration_sha256 !== migration.sha256) {
      throw new Error(`readable-search ${definition.plane} migration ledger is invalid`);
    }
  });
  if (rows.at(-1)?.schema_sha256 !== schemaSha256(database)) {
    throw new Error(`readable-search ${definition.plane} schema fingerprint is invalid`);
  }
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error(`readable-search ${definition.plane} integrity check failed`);
  }
  if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new Error(`readable-search ${definition.plane} foreign-key check failed`);
  }
}

export function migrateReadableSearchPlane(
  database: Database.Database,
  definition: ReadableSearchPlaneDefinition,
): void {
  const all = migrations(definition);
  database.exec('BEGIN IMMEDIATE');
  try {
    const existingVersion = database.pragma('user_version', { simple: true }) as number;
    const existingApplicationId = database.pragma('application_id', { simple: true }) as number;
    if (existingVersion > 0 && existingApplicationId !== definition.application_id) {
      throw new Error(`database is not a readable-search ${definition.plane} plane`);
    }
    if (existingVersion > all.length) throw new Error(`readable-search ${definition.plane} is newer than supported`);
    if (existingVersion === 0) database.pragma(`application_id = ${definition.application_id}`);
    for (const migration of all) {
      if (migration.version <= existingVersion) continue;
      database.exec(migration.sql);
      database.prepare(
        `INSERT INTO retrieval_schema_migrations
         (version, filename, migration_sha256, schema_sha256, applied_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(migration.version, migration.filename, migration.sha256, schemaSha256(database), new Date().toISOString());
      database.pragma(`user_version = ${migration.version}`);
    }
    verify(database, definition);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function inspectReadableSearchPlane(
  database: Database.Database,
  definition: ReadableSearchPlaneDefinition,
): void {
  verify(database, definition);
}
