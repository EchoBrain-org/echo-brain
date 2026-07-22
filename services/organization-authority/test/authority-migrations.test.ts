import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openAuthorityDatabase } from '../src/adapters/persistence/sqlite/open-database.js';

const AUTHORITY_TABLES = [
  'authority_access_lease_requests',
  'authority_access_states',
  'authority_audit_log',
  'authority_enrollment_grants',
  'authority_enrollments',
  'authority_memberships',
  'authority_metadata',
  'authority_principals',
];
const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-authority-migration-'));
  temporaryDirectories.push(directory);
  return join(directory, 'authority.sqlite');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('organization authority database migrations', () => {
  it('installs the complete current schema on a fresh database', () => {
    const path = databasePath();
    openAuthorityDatabase(path).close();

    const database = new Database(path, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(1);
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(AUTHORITY_TABLES);
    database.close();
  });

  it('is idempotent at the current schema version', () => {
    const path = databasePath();
    openAuthorityDatabase(path).close();
    expect(() => openAuthorityDatabase(path).close()).not.toThrow();
  });

  it('rejects a database newer than this authority binary', () => {
    const path = databasePath();
    const future = new Database(path);
    future.pragma('user_version = 2');
    future.close();

    expect(() => openAuthorityDatabase(path)).toThrow(
      'newer than supported schema 1',
    );
  });
});
