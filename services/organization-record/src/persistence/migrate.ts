import { readdirSync, readFileSync } from 'node:fs';
import { sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type { OrganizationRecordDatabaseDefinition } from './database-definition.js';

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;

export interface OrganizationRecordMigration {
  readonly version: number;
  readonly filename: string;
  readonly sql: string;
  readonly sha256: string;
}

interface MigrationLedgerRow {
  version: number;
  filename: string;
  migration_sha256: string;
  schema_sha256: string;
}

export function organizationRecordMigrations(
  definition: OrganizationRecordDatabaseDefinition,
): readonly OrganizationRecordMigration[] {
  const migrations = readdirSync(definition.migrations_directory)
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = MIGRATION_FILE_PATTERN.exec(filename);
      if (match === null) {
        throw new Error(`invalid ${definition.label} migration filename: ${filename}`);
      }
      const sql = readFileSync(
        new URL(filename, definition.migrations_directory),
        'utf8',
      );
      return {
        version: Number.parseInt(match[1]!, 10),
        filename,
        sql,
        sha256: sha256Digest(sql) as string,
      };
    })
    .sort((left, right) => left.version - right.version);

  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `${definition.label} migrations must be contiguous from 0001; expected ${expected}, found ${migration.version}`,
      );
    }
  }
  if (migrations.length === 0) {
    throw new Error(`${definition.label} database has no migrations`);
  }
  return migrations;
}

function installMigrationLedger(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS organization_record_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      filename TEXT NOT NULL UNIQUE,
      migration_sha256 TEXT NOT NULL,
      schema_sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS organization_record_schema_migrations_immutable_update
    BEFORE UPDATE ON organization_record_schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'organization record schema migration ledger is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS organization_record_schema_migrations_immutable_delete
    BEFORE DELETE ON organization_record_schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'organization record schema migration ledger cannot be deleted');
    END;
  `);
}

function currentSchemaSha256(database: Database.Database): string {
  const objects = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all();
  return sha256Digest(JSON.stringify(objects)) as string;
}

function verifyMigrationLedger(
  database: Database.Database,
  definition: OrganizationRecordDatabaseDefinition,
  migrations: readonly OrganizationRecordMigration[],
  currentVersion: number,
): void {
  const ledgerTable = database
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'organization_record_schema_migrations'`,
    )
    .get();
  if (ledgerTable === undefined) {
    throw new Error(`${definition.label} migration ledger does not match user_version`);
  }
  const rows = database
    .prepare(
      `SELECT version, filename, migration_sha256, schema_sha256
       FROM organization_record_schema_migrations
       ORDER BY version`,
    )
    .all() as MigrationLedgerRow[];
  if (rows.length !== currentVersion) {
    throw new Error(`${definition.label} migration ledger does not match user_version`);
  }
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      row.version !== migration.version ||
      row.filename !== migration.filename ||
      row.migration_sha256 !== migration.sha256
    ) {
      throw new Error(
        `${definition.label} migration ${row.version} identity or checksum is invalid`,
      );
    }
  }
  const currentRow = rows.at(-1);
  if (
    currentRow !== undefined &&
    currentRow.schema_sha256 !== currentSchemaSha256(database)
  ) {
    throw new Error(`${definition.label} database schema fingerprint is invalid`);
  }
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error(`${definition.label} database integrity check failed`);
  }
  const foreignKeyFailures = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error(`${definition.label} database has foreign-key violations`);
  }
}

export function inspectOrganizationRecordDatabaseSchema(
  database: Database.Database,
  definition: OrganizationRecordDatabaseDefinition,
  options: { allowOlderSchema?: boolean } = {},
): number {
  const migrations = organizationRecordMigrations(definition);
  const expectedVersion = migrations.length;
  const currentVersion = database.pragma('user_version', { simple: true }) as number;
  const applicationId = database.pragma('application_id', { simple: true }) as number;
  if (
    applicationId !== definition.application_id ||
    currentVersion < 1 ||
    currentVersion > expectedVersion ||
    (!(options.allowOlderSchema ?? false) && currentVersion !== expectedVersion)
  ) {
    throw new Error(
      `${definition.label} database schema ${currentVersion} is not accepted by supported schema ${expectedVersion}`,
    );
  }
  verifyMigrationLedger(database, definition, migrations, currentVersion);
  return currentVersion;
}

export function currentOrganizationRecordSchemaVersion(
  definition: OrganizationRecordDatabaseDefinition,
): number {
  return organizationRecordMigrations(definition).length;
}

export function migrateOrganizationRecordDatabase(
  database: Database.Database,
  definition: OrganizationRecordDatabaseDefinition,
): void {
  migrateOrganizationRecordDatabaseWithMigrations(
    database,
    definition,
    organizationRecordMigrations(definition),
  );
}

/**
 * Internal migration-runner seam used to exercise future upgrades in tests.
 * It is deliberately not exported from the workspace entry point.
 */
export function migrateOrganizationRecordDatabaseWithMigrations(
  database: Database.Database,
  definition: OrganizationRecordDatabaseDefinition,
  migrations: readonly OrganizationRecordMigration[],
): void {
  const currentSchemaVersion = migrations.length;

  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.pragma('user_version', { simple: true }) as number;
    const applicationId = database.pragma('application_id', { simple: true }) as number;
    if (
      (current > 0 && applicationId !== definition.application_id) ||
      (applicationId !== 0 && applicationId !== definition.application_id)
    ) {
      throw new Error(`database is not an ${definition.label} database`);
    }
    if (current > currentSchemaVersion) {
      throw new Error(
        `${definition.label} database schema ${current} is newer than supported schema ${currentSchemaVersion}`,
      );
    }
    if (current === 0) {
      const existingObject = database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%'
           LIMIT 1`,
        )
        .get();
      if (existingObject !== undefined) {
        throw new Error(
          `refusing to claim a non-empty uninitialized ${definition.label} database`,
        );
      }
      database.pragma(`application_id = ${definition.application_id}`);
      installMigrationLedger(database);
    } else {
      // Authenticate the current database before any pending migration can
      // rewrite its schema and record a new fingerprint over prior tampering.
      verifyMigrationLedger(database, definition, migrations, current);
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      database.exec(migration.sql);
      const schemaSha256 = currentSchemaSha256(database);
      database
        .prepare(
          `INSERT INTO organization_record_schema_migrations (
             version, filename, migration_sha256, schema_sha256, applied_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.filename,
          migration.sha256,
          schemaSha256,
          new Date().toISOString(),
        );
      database.pragma(`user_version = ${migration.version}`);
      verifyMigrationLedger(database, definition, migrations, migration.version);
    }
    verifyMigrationLedger(database, definition, migrations, currentSchemaVersion);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
