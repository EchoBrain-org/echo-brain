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
import {
  validateStoredReadableSearchActiveGeneration,
} from '../../../application/readable-search-persistence.js';
import type { StoredReadableSearchActiveGeneration } from '../../../application/ports/authority-repository.js';
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
  'authority_oidc_identity_bindings',
  'authority_oidc_login_attempts',
  'authority_organization_member_recording_activation',
  'authority_person_login_grants',
  'authority_person_read_decision_audit',
  'authority_person_session_credentials',
  'authority_person_session_families',
  'authority_principals',
  'authority_processing_candidates',
  'authority_processing_delivery_receipts',
  'authority_processing_member_exclusions',
  'authority_processing_processed_markers',
  'authority_processing_resolutions',
  'authority_processing_slots',
  'authority_processing_source_cursors',
  'authority_processing_source_owner_bindings',
  'authority_query_decision_audit',
  'authority_readable_search_active_generation',
  'authority_readable_search_query_audit',
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
  record_marker_sha256: string | null;
  record_installed_at: string | null;
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
  /** The organization-record installation anchor; null before it is published. */
  record_marker_sha256: `sha256:${string}` | null;
  record_installed_at: string | null;
}

export interface AuthorityPermissionPilotAudienceInspection {
  membership_id: string;
  status: string;
  display_name: string;
}

/**
 * Reads the one active generation pointer through a read-only SQLite handle.
 * It rechecks authority identity in the same snapshot as the pointer so a
 * stopped operator command never needs the write-capable repository.
 */
export function readActiveReadableSearchGenerationReadOnly(
  databasePath: string,
  binding: { readonly authority_id: string; readonly organization_id: string },
): StoredReadableSearchActiveGeneration | null {
  const inspection = inspectAuthorityDatabaseReadOnly(databasePath);
  if (
    inspection.authority_id !== binding.authority_id ||
    inspection.organization_id !== binding.organization_id
  ) {
    throw new Error('readable-search authority database differs from config');
  }
  assertPrivateAuthorityDatabaseFile(databasePath);
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    database.exec('BEGIN');
    try {
      const metadata = database
        .prepare(
          `SELECT authority_id, organization_id
             FROM authority_metadata WHERE singleton = 1`,
        )
        .get() as
        | { authority_id: string; organization_id: string }
        | undefined;
      if (
        metadata === undefined ||
        metadata.authority_id !== binding.authority_id ||
        metadata.organization_id !== binding.organization_id
      ) {
        throw new Error(
          'readable-search authority database changed or differs from config',
        );
      }
      const row = database
        .prepare(
          `SELECT organization_id, generation_id, manifest_sha256,
                  retrieval_contract_sha256, record_head_position,
                  record_head_hash, published_at
             FROM authority_readable_search_active_generation
            WHERE singleton = 1`,
        )
        .get();
      const pointer =
        row === undefined
          ? null
          : validateStoredReadableSearchActiveGeneration(row);
      database.exec('COMMIT');
      return pointer;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
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
    const recordAnchorColumns =
      schemaVersion >= 5
        ? `record_marker_sha256, record_installed_at`
        : `NULL AS record_marker_sha256, NULL AS record_installed_at`;
    const metadata = database
      .prepare(
        `SELECT authority_id, organization_id, organization_display_name,
                authority_pin_sha256, descriptor_json,
                ${integrationAnchorColumns},
                ${recordAnchorColumns}
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
    const recordAnchorMissing =
      metadata.record_marker_sha256 === null &&
      metadata.record_installed_at === null;
    if (
      !recordAnchorMissing &&
      (metadata.record_marker_sha256 === null ||
        !/^sha256:[0-9a-f]{64}$/.test(metadata.record_marker_sha256) ||
        metadata.record_installed_at === null ||
        Number.isNaN(Date.parse(metadata.record_installed_at)))
    ) {
      throw new Error(
        'organization authority record installation anchor is invalid',
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
      record_marker_sha256:
        metadata.record_marker_sha256 as `sha256:${string}` | null,
      record_installed_at: metadata.record_installed_at,
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

/**
 * Reads only the two explicitly named pilot memberships. The caller owns
 * policy decisions such as active status and label equality; this adapter
 * proves the rows came from the expected current Authority database without
 * opening its write-capable repository or changing `last_observed_at`.
 */
export function inspectAuthorityPermissionPilotAudienceReadOnly(
  databasePath: string,
  binding: {
    authority_id: string;
    organization_id: string;
    membership_ids: readonly [string, string];
  },
): readonly AuthorityPermissionPilotAudienceInspection[] {
  const inspection = inspectAuthorityDatabaseReadOnly(databasePath);
  if (
    inspection.authority_id !== binding.authority_id ||
    inspection.organization_id !== binding.organization_id
  ) {
    throw new Error(
      'permission pilot activation authority database differs from config',
    );
  }
  assertPrivateAuthorityDatabaseFile(databasePath);
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    database.exec('BEGIN');
    try {
      const metadata = database
        .prepare(
          `SELECT authority_id, organization_id
           FROM authority_metadata WHERE singleton = 1`,
        )
        .get() as
        | { authority_id: string; organization_id: string }
        | undefined;
      if (
        metadata === undefined ||
        metadata.authority_id !== binding.authority_id ||
        metadata.organization_id !== binding.organization_id
      ) {
        throw new Error(
          'permission pilot activation authority database changed or differs from config',
        );
      }
      const rows = database
        .prepare(
          `SELECT m.membership_id, m.status, p.display_name
           FROM authority_memberships AS m
           JOIN authority_principals AS p
             ON p.principal_id = m.principal_id
            AND p.organization_id = m.organization_id
           WHERE m.organization_id = ?
             AND m.membership_id IN (?, ?)
           ORDER BY m.membership_id`,
        )
        .all(
          binding.organization_id,
          binding.membership_ids[0],
          binding.membership_ids[1],
        ) as AuthorityPermissionPilotAudienceInspection[];
      database.exec('COMMIT');
      return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
}

/** Accepts a valid v1-or-newer identity so serve can apply forward migrations. */
export function inspectAuthorityDatabaseForServe(
  databasePath: string,
): AuthorityDatabaseInspection {
  return inspectAuthorityDatabase(databasePath, true);
}
