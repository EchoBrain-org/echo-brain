import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { inspectOrganizationControlDatabaseSchema } from './migrate.js';

export interface OrganizationControlDatabaseIdentity {
  readonly schema_version: number;
  readonly control_plane_id: string;
  readonly organization_id: string;
  readonly authority_id: string;
  readonly authority_descriptor_sha256: `sha256:${string}`;
  readonly created_at: string;
}

interface IdentityRow {
  control_plane_id: string;
  organization_id: string;
  authority_id: string;
  authority_descriptor_sha256: string;
  created_at: string;
}

function identity(
  database: Database.Database,
  allowOlderSchema: boolean,
): OrganizationControlDatabaseIdentity {
  const schemaVersion = inspectOrganizationControlDatabaseSchema(database, {
    allowOlderSchema,
  });
  const row = database
    .prepare(
      `SELECT control_plane_id, organization_id, authority_id,
              authority_descriptor_sha256, created_at
       FROM organization_control_plane_metadata
       WHERE singleton = 1`,
    )
    .get() as IdentityRow | undefined;
  if (
    row === undefined ||
    !/^ocp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      row.control_plane_id,
    ) ||
    !/^org_/.test(row.organization_id) ||
    !/^oau_/.test(row.authority_id) ||
    !/^sha256:[0-9a-f]{64}$/.test(row.authority_descriptor_sha256) ||
    Number.isNaN(Date.parse(row.created_at))
  ) {
    throw new Error(
      'organization control database identity is missing or invalid',
    );
  }
  return Object.freeze({
    schema_version: schemaVersion,
    control_plane_id: row.control_plane_id,
    organization_id: row.organization_id,
    authority_id: row.authority_id,
    authority_descriptor_sha256:
      row.authority_descriptor_sha256 as `sha256:${string}`,
    created_at: row.created_at,
  });
}

function assertPrivateDatabaseFile(path: string): Readonly<{ dev: number; ino: number }> {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'organization control database must be a current-user 0600 canonical file',
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error('organization control database changed while opening');
    }
    const header = Buffer.alloc(16);
    if (
      readSync(file, header, 0, header.length, 0) !== header.length ||
      header.toString('binary') !== 'SQLite format 3\0'
    ) {
      throw new Error('organization control database header is invalid');
    }
  } finally {
    closeSync(file);
  }
  return Object.freeze({ dev: state.dev, ino: state.ino });
}

function inspectReadOnly(
  path: string,
  allowOlderSchema: boolean,
): OrganizationControlDatabaseIdentity {
  assertPrivateDatabaseFile(path);
  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    database.pragma('foreign_keys = ON');
    return identity(database, allowOlderSchema);
  } finally {
    database.close();
  }
}

export function inspectOpenOrganizationControlDatabase(
  database: Database.Database,
): OrganizationControlDatabaseIdentity {
  return identity(database, false);
}

export function inspectOrganizationControlDatabaseReadOnly(
  path: string,
): OrganizationControlDatabaseIdentity {
  return inspectReadOnly(path, false);
}

export function inspectOrganizationControlDatabaseForServe(
  path: string,
): OrganizationControlDatabaseIdentity {
  return inspectReadOnly(path, true);
}

/**
 * Opens an already-current control-plane database without migrations or any
 * durable pragma. Callers receive a query-only handle after the canonical
 * private-file and exact current-schema identity have both been verified.
 */
export function openOrganizationControlDatabaseReadOnly(
  path: string,
): Database.Database {
  const before = assertPrivateDatabaseFile(path);
  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    identity(database, false);
    const after = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error('organization control database changed while opening');
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
