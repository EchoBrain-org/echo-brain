import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIRECTORY_URL = new URL('../../migrations/', import.meta.url);
const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;
const APPLICATION_ID = 0x45434f50; // "ECOP"

export interface OrganizationControlMigration {
  version: number;
  filename: string;
  sql: string;
  sha256: string;
}

interface MigrationLedgerRow {
  version: number;
  filename: string;
  migration_sha256: string;
  schema_sha256: string;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function organizationControlMigrations(): readonly OrganizationControlMigration[] {
  const migrations = readdirSync(MIGRATIONS_DIRECTORY_URL)
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = MIGRATION_FILE_PATTERN.exec(filename);
      if (match === null) {
        throw new Error(
          `invalid organization control migration filename: ${filename}`,
        );
      }
      const sql = readFileSync(
        new URL(filename, MIGRATIONS_DIRECTORY_URL),
        'utf8',
      );
      return {
        version: Number.parseInt(match[1]!, 10),
        filename,
        sql,
        sha256: sha256(sql),
      };
    })
    .sort((left, right) => left.version - right.version);

  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `organization control migrations must be contiguous from 0001; expected ${expected}, found ${migration.version}`,
      );
    }
  }
  if (migrations.length === 0) {
    throw new Error('organization control database has no migrations');
  }
  return migrations;
}

function installMigrationLedger(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS organization_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      filename TEXT NOT NULL UNIQUE,
      migration_sha256 TEXT NOT NULL,
      schema_sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS organization_schema_migrations_immutable_update
    BEFORE UPDATE ON organization_schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'organization schema migration ledger is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS organization_schema_migrations_immutable_delete
    BEFORE DELETE ON organization_schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'organization schema migration ledger cannot be deleted');
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
  return sha256(JSON.stringify(objects));
}

function verifyMigrationLedger(
  database: Database.Database,
  migrations: readonly OrganizationControlMigration[],
  currentVersion: number,
): void {
  const ledgerTable = database
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'organization_schema_migrations'`,
    )
    .get();
  if (ledgerTable === undefined) {
    throw new Error(
      'organization control migration ledger does not match user_version',
    );
  }
  const rows = database
    .prepare(
      `SELECT version, filename, migration_sha256, schema_sha256
       FROM organization_schema_migrations
       ORDER BY version`,
    )
    .all() as MigrationLedgerRow[];
  if (rows.length !== currentVersion) {
    throw new Error(
      'organization control migration ledger does not match user_version',
    );
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
        `organization control migration ${row.version} identity or checksum is invalid`,
      );
    }
  }
  const currentRow = rows.at(-1);
  if (
    currentRow !== undefined &&
    currentRow.schema_sha256 !== currentSchemaSha256(database)
  ) {
    throw new Error('organization control database schema fingerprint is invalid');
  }
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error('organization control database integrity check failed');
  }
  const foreignKeyFailures = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error('organization control database has foreign-key violations');
  }
}

export function inspectOrganizationControlDatabaseSchema(
  database: Database.Database,
  options: { allowOlderSchema?: boolean } = {},
): number {
  const migrations = organizationControlMigrations();
  const expectedVersion = migrations.length;
  const currentVersion = database.pragma('user_version', {
    simple: true,
  }) as number;
  const applicationId = database.pragma('application_id', {
    simple: true,
  }) as number;
  if (
    applicationId !== APPLICATION_ID ||
    currentVersion < 1 ||
    currentVersion > expectedVersion ||
    (!(options.allowOlderSchema ?? false) &&
      currentVersion !== expectedVersion)
  ) {
    throw new Error(
      `organization control database schema ${currentVersion} is not accepted by supported schema ${expectedVersion}`,
    );
  }
  verifyMigrationLedger(database, migrations, currentVersion);
  return currentVersion;
}

export function organizationControlApplicationId(): number {
  return APPLICATION_ID;
}

export function currentOrganizationControlSchemaVersion(): number {
  return organizationControlMigrations().length;
}

export function migrateOrganizationControlDatabase(
  database: Database.Database,
): void {
  migrateOrganizationControlDatabaseWithMigrations(
    database,
    organizationControlMigrations(),
  );
}

/**
 * Internal migration-runner seam used to exercise future upgrades in tests.
 * It is deliberately not exported from the workspace entry point.
 */
export function migrateOrganizationControlDatabaseWithMigrations(
  database: Database.Database,
  migrations: readonly OrganizationControlMigration[],
): void {
  const currentSchemaVersion = migrations.length;

  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.pragma('user_version', { simple: true }) as number;
    const applicationId = database.pragma('application_id', {
      simple: true,
    }) as number;
    if (current > currentSchemaVersion) {
      throw new Error(
        `organization control database schema ${current} is newer than supported schema ${currentSchemaVersion}`,
      );
    }
    if (
      (current > 0 && applicationId !== APPLICATION_ID) ||
      (applicationId !== 0 && applicationId !== APPLICATION_ID)
    ) {
      throw new Error('database is not an organization control-plane database');
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
          'refusing to claim a non-empty uninitialized database',
        );
      }
    }
    if (current === 0 && applicationId === 0) {
      database.pragma(`application_id = ${APPLICATION_ID}`);
    }

    if (current === 0) {
      installMigrationLedger(database);
    } else {
      // Authenticate the current database before any pending migration can
      // rewrite its schema and record a new fingerprint over prior tampering.
      verifyMigrationLedger(database, migrations, current);
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      database.exec(migration.sql);
      const schemaSha256 = currentSchemaSha256(database);
      database
        .prepare(
          `INSERT INTO organization_schema_migrations (
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
      verifyMigrationLedger(database, migrations, migration.version);
    }
    verifyMigrationLedger(database, migrations, currentSchemaVersion);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
