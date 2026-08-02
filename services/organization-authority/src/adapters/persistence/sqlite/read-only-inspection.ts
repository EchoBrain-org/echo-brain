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
  'authority_internal_live_releases',
  'authority_internal_live_update_receipts',
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
  integrations_control_plane_id: string | null;
  integrations_marker_sha256: string | null;
  integrations_installed_at: string | null;
}

export interface AuthorityDatabaseInspection {
  schema_version: number;
  tables: readonly string[];
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  authority_pin_sha256: string;
  authority_descriptor: OrganizationAuthorityDescriptorV1;
  integrations_control_plane_id: string | null;
  integrations_marker_sha256: `sha256:${string}` | null;
  integrations_installed_at: string | null;
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
    const integrationAnchorColumns =
      schemaVersion >= 3
        ? `integrations_control_plane_id, integrations_marker_sha256,
           integrations_installed_at`
        : `NULL AS integrations_control_plane_id,
           NULL AS integrations_marker_sha256,
           NULL AS integrations_installed_at`;
    const metadata = database
      .prepare(
        `SELECT authority_id, organization_id, organization_display_name,
                authority_pin_sha256, descriptor_json,
                ${integrationAnchorColumns}
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
    const integrationAnchorMissing =
      metadata.integrations_control_plane_id === null &&
      metadata.integrations_marker_sha256 === null &&
      metadata.integrations_installed_at === null;
    if (
      !integrationAnchorMissing &&
      (metadata.integrations_control_plane_id === null ||
        !/^ocp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          metadata.integrations_control_plane_id,
        ) ||
        metadata.integrations_marker_sha256 === null ||
        !/^sha256:[0-9a-f]{64}$/.test(
          metadata.integrations_marker_sha256,
        ) ||
        metadata.integrations_installed_at === null ||
        Number.isNaN(Date.parse(metadata.integrations_installed_at)))
    ) {
      throw new Error(
        'organization authority integrations installation anchor is invalid',
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
      integrations_control_plane_id:
        metadata.integrations_control_plane_id,
      integrations_marker_sha256:
        metadata.integrations_marker_sha256 as `sha256:${string}` | null,
      integrations_installed_at: metadata.integrations_installed_at,
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
