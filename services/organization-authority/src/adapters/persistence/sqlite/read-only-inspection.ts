import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import {
  canonicalJson,
  parseCanonicalJson,
} from '@echo-brain/federation-protocol';
import {
  validateOrganizationAuthorityDescriptor,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { currentAuthoritySchemaVersion } from './migrate.js';

const AUTHORITY_TABLES = Object.freeze([
  'authority_access_lease_requests',
  'authority_access_states',
  'authority_audit_log',
  'authority_enrollment_grants',
  'authority_enrollments',
  'authority_memberships',
  'authority_metadata',
  'authority_principals',
]);

interface MetadataRow {
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  authority_pin_sha256: string;
  descriptor_json: string;
}

export interface AuthorityDatabaseInspection {
  schema_version: number;
  tables: readonly string[];
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  authority_pin_sha256: string;
  authority_descriptor: OrganizationAuthorityDescriptorV1;
}

export function assertPrivateAuthorityDatabaseFile(path: string): void {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'organization authority database must be a current-user 0600 regular file',
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error('organization authority database changed while opening');
    }
    const header = Buffer.alloc(16);
    if (
      readSync(file, header, 0, header.length, 0) !== header.length ||
      header.toString('binary') !== 'SQLite format 3\0'
    ) {
      throw new Error('organization authority database header is invalid');
    }
  } finally {
    closeSync(file);
  }
}

/** Opens SQLite read-only and never creates, migrates, checkpoints, or writes. */
function inspectAuthorityDatabase(
  databasePath: string,
  allowOlderSchema: boolean,
): AuthorityDatabaseInspection {
  assertPrivateAuthorityDatabaseFile(databasePath);
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    const schemaVersion = database.pragma('user_version', {
      simple: true,
    }) as number;
    const expectedSchemaVersion = currentAuthoritySchemaVersion();
    if (
      schemaVersion < 1 ||
      schemaVersion > expectedSchemaVersion ||
      (!allowOlderSchema && schemaVersion !== expectedSchemaVersion)
    ) {
      throw new Error(
        `organization authority database schema ${schemaVersion} is not accepted by supported schema ${expectedSchemaVersion}`,
      );
    }
    const tables = (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    if (
      schemaVersion === expectedSchemaVersion &&
      canonicalJson(tables) !== canonicalJson(AUTHORITY_TABLES)
    ) {
      throw new Error('organization authority database table set is invalid');
    }
    const metadata = database
      .prepare(
        `SELECT authority_id, organization_id, organization_display_name,
                authority_pin_sha256, descriptor_json
         FROM authority_metadata WHERE singleton = 1`,
      )
      .get() as MetadataRow | undefined;
    if (metadata === undefined) {
      throw new Error('organization authority database metadata is missing');
    }
    const descriptor = validateOrganizationAuthorityDescriptor(
      parseCanonicalJson(metadata.descriptor_json),
    );
    verifyOrganizationAuthorityPin(descriptor, metadata.authority_pin_sha256);
    if (
      metadata.authority_id !== descriptor.authority_id ||
      metadata.organization_id !== descriptor.organization_id ||
      canonicalJson(descriptor) !== metadata.descriptor_json
    ) {
      throw new Error(
        'organization authority database metadata differs from its descriptor',
      );
    }
    return Object.freeze({
      schema_version: schemaVersion,
      tables: Object.freeze([...tables]),
      authority_id: metadata.authority_id,
      organization_id: metadata.organization_id,
      organization_display_name: metadata.organization_display_name,
      authority_pin_sha256: metadata.authority_pin_sha256,
      authority_descriptor: descriptor,
    });
  } finally {
    database.close();
  }
}

export function inspectAuthorityDatabaseReadOnly(
  databasePath: string,
): AuthorityDatabaseInspection {
  return inspectAuthorityDatabase(databasePath, false);
}

/** Accepts a valid v1-or-newer identity so serve can apply forward migrations. */
export function inspectAuthorityDatabaseForServe(
  databasePath: string,
): AuthorityDatabaseInspection {
  return inspectAuthorityDatabase(databasePath, true);
}
