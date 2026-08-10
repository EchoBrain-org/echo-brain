import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  canonicalJson,
  canonicalSha256,
  federationId,
} from '@echo-brain/federation-protocol';
import {
  initializeOrganizationControlDatabase,
  inspectOrganizationControlDatabaseForServe,
  inspectOrganizationControlDatabaseReadOnly,
  openOrganizationControlDatabase,
  type OrganizationControlDatabaseIdentity,
} from '@echo-brain/organization-control-plane';
import {
  inspectOrganizationRecordDatabaseSchema,
  openOrganizationRecordDatabase,
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  ORGANIZATION_RECORD_LOG_DATABASE,
  OrganizationRecordDerivedStore,
  OrganizationRecordFollower,
  OrganizationRecordLogReader,
  OrganizationRecordLogStore,
  OrganizationPermissionPilotLog,
  assertOrganizationPermissionPilotActivationFresh,
  organizationPermissionPilotCommandSha256,
  validateOrganizationPermissionPilotActivationCommand,
  verifyOrganizationRecordChain,
} from '@echo-brain/organization-record';
import type {
  OrganizationPermissionPilotActivationCommandV1,
  OrganizationPermissionPilotActivationMarkerV1,
  OrganizationPermissionPilotPresentationV1,
} from '@echo-brain/organization-record';
import {
  organizationAuthorityPinSha256,
  validateOrganizationAuthorityDescriptor,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import {
  inspectAuthorityDatabaseForServe,
  inspectAuthorityDatabaseReadOnly,
  inspectAuthorityPermissionPilotAudienceReadOnly,
  type AuthorityDatabaseInspection,
} from '../adapters/persistence/sqlite/read-only-inspection.js';
import { openAuthorityDatabase } from '../adapters/persistence/sqlite/open-database.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  acquireAuthorityInitializationLock,
  acquireAuthorityRuntimeLock,
} from '../adapters/runtime/singleton-runtime-lock.js';
import { authorityMaintenanceFingerprint } from '../adapters/runtime/runtime-fingerprint.js';
import { AdminBearerAuthenticator } from '../adapters/security/admin-bearer-authenticator.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import {
  createPrivateAuthorityCredential,
  readPrivateAuthorityCredential,
} from '../adapters/security/private-file-credentials.js';
import { assertDisplayName } from '../domain/rules.js';
import { AuthenticatedProxyClientIdentityResolver } from '../presentation/trusted-proxy-client-identity.js';
import {
  assertAuthorityConfigStateSeparation,
  authorityStatePaths,
  createAuthorityRuntimeConfig,
  normalizedAbsolutePath,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
  type AuthorityRuntimeConfigV1,
  type AuthorityStatePaths,
  validateAuthorityRuntimeConfig,
  writeAuthorityRuntimeConfigExclusive,
} from './operator-config.js';
import type { AuthorityServeConfig } from './config.js';

const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_INITIALIZATION_MANIFEST_BYTES = 128 * 1024;
const MAX_INTEGRATIONS_INSTALLATION_MARKER_BYTES = 64 * 1024;
const MAX_RECORD_INSTALLATION_MARKER_BYTES = 64 * 1024;
const MAX_PERMISSION_PILOT_ACTIVATION_COMMAND_BYTES = 64 * 1024;

export interface AuthorityIdentityRecordV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-identity';
  authority_descriptor: OrganizationAuthorityDescriptorV1;
  authority_pin_sha256: `sha256:${string}`;
}

export interface AuthorityInitializationManifestV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-initialization-manifest';
  config_path: string;
  runtime_config: AuthorityRuntimeConfigV1;
}

export interface AuthorityIntegrationsInstallationMarkerV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-integrations-installation-marker';
  control_plane_id: string;
  organization_id: string;
  authority_id: string;
  authority_descriptor_sha256: `sha256:${string}`;
  integrations_database_path: string;
  database_created_at: string;
  installed_at: string;
}

interface AuthorityIntegrationsInstallationAnchor {
  control_plane_id: string;
  marker_sha256: `sha256:${string}`;
  installed_at: string;
}

/**
 * The state-directory half of the record-store installation proof.
 *
 * It names the two files it published so a marker restored beside a differently
 * configured state directory is refused rather than silently believed.
 */
export interface AuthorityRecordInstallationMarkerV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-record-installation-marker';
  organization_id: string;
  authority_id: string;
  record_log_database_path: string;
  record_derived_database_path: string;
  installed_at: string;
}

interface AuthorityRecordInstallationAnchor {
  marker_sha256: `sha256:${string}`;
  installed_at: string;
}

export interface InitializeDevelopmentAuthorityOptions {
  config_path: string;
  state_directory: string;
  organization_display_name: string;
  port?: number;
}

export interface DevelopmentAuthorityInitializationResult {
  schema_version: 1;
  kind: 'echo-organization-authority-development-initialization';
  created: boolean;
  config_path: string;
  state_dir: string;
  listener: { host: '127.0.0.1' | '::1'; port: number };
  authority_descriptor: OrganizationAuthorityDescriptorV1;
  authority_pin_sha256: `sha256:${string}`;
}

export interface AuthorityIntegrationsInstallationResult {
  schema_version: 1;
  kind: 'echo-organization-authority-integrations-installation';
  created: boolean;
  config_path: string;
  state_dir: string;
  integrations_database_path: string;
  control_plane_id: string;
  organization_id: string;
  authority_id: string;
}

export interface AuthorityRecordDerivedRebuildResult {
  schema_version: 1;
  kind: 'echo-organization-authority-record-derived-rebuild';
  config_path: string;
  record_derived_database_path: string;
  head_position: number;
  derived_content_sha256: `sha256:${string}`;
}

export interface AuthorityPermissionPilotActivationResult {
  schema_version: 1;
  kind: 'echo-organization-authority-permission-pilot-activation';
  created: boolean;
  config_path: string;
  state_dir: string;
  record_log_database_path: string;
  organization_id: string;
  authority_id: string;
  marker: OrganizationPermissionPilotActivationMarkerV1;
  presentation_descriptor: OrganizationPermissionPilotPresentationV1;
}

export interface ActivateOrganizationPermissionPilotOptions {
  /** Test seam; production callers use the canonical current UTC instant. */
  now?: () => string;
}

export type AuthorityIntegrationsInstallationFaultPoint =
  | 'after_authority_migration'
  | 'after_database_published'
  | 'after_marker_published'
  | 'after_anchor_committed'
  | 'after_record_databases_published'
  | 'after_record_marker_published';

export interface InstallAuthorityIntegrationsOptions {
  /** Test-only crash hook. A thrown error leaves durable publication for retry. */
  faultInjector?: (
    point: AuthorityIntegrationsInstallationFaultPoint,
  ) => void;
}

export interface InspectedAuthorityState {
  config: AuthorityRuntimeConfigV1;
  identity: AuthorityIdentityRecordV1;
}

type AuthorityDatabaseInspector = (
  path: string,
) => AuthorityDatabaseInspection;
type IntegrationsDatabaseInspector = (
  path: string,
) => OrganizationControlDatabaseIdentity;

function assertPrivateDirectory(path: string, label: string): void {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${label} must be a current-user 0700 canonical directory`);
  }
}

function ensurePrivateDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  assertPrivateDirectory(path, label);
}

function assertPrivateParent(path: string, label: string): void {
  assertPrivateDirectory(dirname(path), label);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPrivateTextFile<T>(
  path: string,
  label: string,
  maximumBytes: number,
  canonical: boolean,
  parse: (contents: string) => T,
): T {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > maximumBytes ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600 ||
    (canonical && realpathSync(path) !== path)
  ) {
    throw new Error(
      `${label} must be a bounded current-user 0600 ${
        canonical ? 'canonical file' : 'regular file'
      }`,
    );
  }
  const file = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(file);
    if (
      opened.dev !== state.dev ||
      opened.ino !== state.ino ||
      opened.size !== state.size
    ) {
      throw new Error(`${label} changed while opening`);
    }
    const contents = readFileSync(file, 'utf8');
    const result = parse(contents);
    const completed = fstatSync(file);
    if (
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== opened.size ||
      completed.mtimeMs !== opened.mtimeMs ||
      completed.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return result;
  } finally {
    closeSync(file);
  }
}

function readPermissionPilotActivationCommand(
  commandPath: string,
  config: AuthorityRuntimeConfigV1,
): OrganizationPermissionPilotActivationCommandV1 {
  const path = normalizedAbsolutePath(
    commandPath,
    'permission pilot activation command path',
  );
  return readPrivateTextFile(
    path,
    'permission pilot activation command',
    MAX_PERMISSION_PILOT_ACTIVATION_COMMAND_BYTES,
    true,
    (contents) =>
      validateOrganizationPermissionPilotActivationCommand(
        JSON.parse(contents) as unknown,
        {
          authority_id: config.authority.authority_id,
          organization_id: config.organization.organization_id,
        },
      ),
  );
}

type AuthorityIntegrationsBindingConfig =
  | AuthorityRuntimeConfigV1
  | AuthorityServeConfig;

/**
 * Creates or re-opens both organization-record databases at their canonical
 * state-directory paths, applying migrations and binding each file to this
 * organization exactly once.
 *
 * Serve never calls this. Required production state is published by
 * initialization, which is the project's existing rule for `authority.sqlite`
 * and `integrations.sqlite`; a serve that silently created a fresh empty log
 * would look healthy while every previously issued receipt pointed at records
 * it no longer holds.
 */
function createRecordDatabases(
  paths: AuthorityStatePaths,
  organizationId: string,
  authorityId: string,
): void {
  const log = OrganizationRecordLogStore.open(paths.record_log_database_path, {
    organization_id: organizationId,
    authority_id: authorityId,
  });
  try {
    const derived = OrganizationRecordDerivedStore.open(
      paths.record_derived_database_path,
      { organization_id: organizationId },
    );
    derived.close();
  } finally {
    log.close();
  }
}

/**
 * Read-only proof that both record databases exist, carry the expected
 * application id and migration ledger, and belong to this organization. Never
 * creates, migrates, or writes.
 */
function inspectOpenRecordDatabase(
  database: ReturnType<typeof openOrganizationRecordDatabase>,
  definition:
    | typeof ORGANIZATION_RECORD_LOG_DATABASE
    | typeof ORGANIZATION_RECORD_DERIVED_DATABASE,
  label: string,
  config: AuthorityRuntimeConfigV1,
  allowOlderSchema: boolean,
): void {
  inspectOrganizationRecordDatabaseSchema(database, definition, {
    allowOlderSchema,
  });
  const metadata = database
    .prepare(
      definition === ORGANIZATION_RECORD_LOG_DATABASE
        ? `SELECT organization_id, authority_id
           FROM organization_record_log_metadata WHERE singleton = 1`
        : `SELECT organization_id, NULL AS authority_id
           FROM organization_derived_metadata WHERE singleton = 1`,
    )
    .get() as
    { organization_id: string; authority_id: string | null } | undefined;
  if (
    metadata === undefined ||
    metadata.organization_id !== config.organization.organization_id ||
    (metadata.authority_id !== null &&
      metadata.authority_id !== config.authority.authority_id)
  ) {
    throw new Error(
      `authority ${label} database belongs to a different organization or authority`,
    );
  }
}

function inspectRecordDatabase(
  path: string,
  definition:
    | typeof ORGANIZATION_RECORD_LOG_DATABASE
    | typeof ORGANIZATION_RECORD_DERIVED_DATABASE,
  label: string,
  config: AuthorityRuntimeConfigV1,
  allowOlderSchema: boolean,
): void {
  if (!existsSync(path)) {
    throw new Error(
      `authority ${label} database is missing; restore the published state directory`,
    );
  }
  const database = openOrganizationRecordDatabase(path, definition, {
    readonly: true,
  });
  try {
    database.pragma('query_only = ON');
    inspectOpenRecordDatabase(
      database,
      definition,
      label,
      config,
      allowOlderSchema,
    );
  } finally {
    database.close();
  }
}

function inspectRecordDatabases(
  paths: AuthorityStatePaths,
  config: AuthorityRuntimeConfigV1,
  allowOlderSchema: boolean,
): void {
  inspectRecordDatabase(
    paths.record_log_database_path,
    ORGANIZATION_RECORD_LOG_DATABASE,
    'record log',
    config,
    allowOlderSchema,
  );
  inspectRecordDatabase(
    paths.record_derived_database_path,
    ORGANIZATION_RECORD_DERIVED_DATABASE,
    'record derived',
    config,
    allowOlderSchema,
  );
}

function authorityIntegrationsBinding(
  config: AuthorityIntegrationsBindingConfig,
): {
  state_directory: string;
  integrations_database_path: string;
  organization_id: string;
  authority_id: string;
  authority_pin_sha256: `sha256:${string}`;
} {
  if ('state_dir' in config) {
    return {
      state_directory: config.state_dir,
      integrations_database_path: authorityStatePaths(config.state_dir)
        .integrations_database_path,
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
      authority_pin_sha256: config.authority.authority_pin_sha256,
    };
  }
  return config;
}

function assertIntegrationsIdentity(
  identity: OrganizationControlDatabaseIdentity,
  config: AuthorityIntegrationsBindingConfig,
): void {
  const binding = authorityIntegrationsBinding(config);
  if (
    identity.organization_id !== binding.organization_id ||
    identity.authority_id !== binding.authority_id ||
    identity.authority_descriptor_sha256 !==
      binding.authority_pin_sha256
  ) {
    throw new Error(
      'organization integrations database identity differs from config',
    );
  }
}

function integrationsInstallationMarker(
  config: AuthorityRuntimeConfigV1,
  identity: OrganizationControlDatabaseIdentity,
  installedAt: string,
): AuthorityIntegrationsInstallationMarkerV1 {
  assertIntegrationsIdentity(identity, config);
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-integrations-installation-marker',
    control_plane_id: identity.control_plane_id,
    organization_id: identity.organization_id,
    authority_id: identity.authority_id,
    authority_descriptor_sha256: identity.authority_descriptor_sha256,
    integrations_database_path: authorityStatePaths(config.state_dir)
      .integrations_database_path,
    database_created_at: identity.created_at,
    installed_at: installedAt,
  };
}

function readIntegrationsInstallationMarker(
  config: AuthorityIntegrationsBindingConfig,
): AuthorityIntegrationsInstallationMarkerV1 {
  const binding = authorityIntegrationsBinding(config);
  const paths = authorityStatePaths(binding.state_directory);
  const path = paths.integrations_installation_marker_path;
  if (!existsSync(path)) {
    throw new Error(
      'authority integrations installation marker is missing; a previously installed database must be restored, while a verified legacy state must use install-integrations',
    );
  }
  return readPrivateTextFile(
    path,
    'authority integrations installation marker',
    MAX_INTEGRATIONS_INSTALLATION_MARKER_BYTES,
    true,
    (contents) => {
      const parsed = JSON.parse(contents) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        'authority integrations installation marker must be an object',
      );
    }
    const marker = parsed as Record<string, unknown>;
    if (
      Object.keys(marker).sort().join(',') !==
        [
          'authority_descriptor_sha256',
          'authority_id',
          'control_plane_id',
          'database_created_at',
          'installed_at',
          'integrations_database_path',
          'kind',
          'organization_id',
          'schema_version',
        ]
          .sort()
          .join(',') ||
      marker.schema_version !== 1 ||
      marker.kind !==
        'echo-organization-authority-integrations-installation-marker' ||
      typeof marker.control_plane_id !== 'string' ||
      !/^ocp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        marker.control_plane_id,
      ) ||
      marker.organization_id !== binding.organization_id ||
      marker.authority_id !== binding.authority_id ||
      marker.authority_descriptor_sha256 !==
        binding.authority_pin_sha256 ||
      marker.integrations_database_path !==
        binding.integrations_database_path ||
      typeof marker.database_created_at !== 'string' ||
      Number.isNaN(Date.parse(marker.database_created_at)) ||
      typeof marker.installed_at !== 'string' ||
      Number.isNaN(Date.parse(marker.installed_at))
    ) {
      throw new Error(
        'authority integrations installation marker is invalid or differs from config',
      );
    }
    return Object.freeze({
      schema_version: 1,
      kind: 'echo-organization-authority-integrations-installation-marker',
      control_plane_id: marker.control_plane_id,
      organization_id: marker.organization_id,
      authority_id: marker.authority_id,
      authority_descriptor_sha256:
        marker.authority_descriptor_sha256 as `sha256:${string}`,
      integrations_database_path: marker.integrations_database_path,
      database_created_at: marker.database_created_at,
      installed_at: marker.installed_at,
    });
    },
  );
}

function integrationsInstallationAnchor(
  database: AuthorityDatabaseInspection,
): AuthorityIntegrationsInstallationAnchor | null {
  if (
    database.integrations_control_plane_id === null &&
    database.integrations_marker_sha256 === null &&
    database.integrations_installed_at === null
  ) {
    return null;
  }
  if (
    database.integrations_control_plane_id === null ||
    database.integrations_marker_sha256 === null ||
    database.integrations_installed_at === null
  ) {
    throw new Error(
      'organization authority integrations installation anchor is incomplete',
    );
  }
  return Object.freeze({
    control_plane_id: database.integrations_control_plane_id,
    marker_sha256: database.integrations_marker_sha256,
    installed_at: database.integrations_installed_at,
  });
}

function integrationsInstallationAnchorForMarker(
  marker: AuthorityIntegrationsInstallationMarkerV1,
): AuthorityIntegrationsInstallationAnchor {
  return Object.freeze({
    control_plane_id: marker.control_plane_id,
    marker_sha256: canonicalSha256(marker),
    installed_at: marker.installed_at,
  });
}

function recordIntegrationsInstallationAnchor(
  databasePath: string,
  marker: AuthorityIntegrationsInstallationMarkerV1,
): AuthorityIntegrationsInstallationAnchor {
  const requested = integrationsInstallationAnchorForMarker(marker);
  const database = openAuthorityDatabase(databasePath, {
    fileMustExist: true,
  });
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database
        .prepare(
          `SELECT integrations_control_plane_id, integrations_marker_sha256,
                  integrations_installed_at
           FROM authority_metadata WHERE singleton = 1`,
        )
        .get() as
        | {
            integrations_control_plane_id: string | null;
            integrations_marker_sha256: string | null;
            integrations_installed_at: string | null;
          }
        | undefined;
      if (existing === undefined) {
        throw new Error('organization authority database metadata is missing');
      }
      if (existing.integrations_control_plane_id !== null) {
        if (
          existing.integrations_control_plane_id !==
            requested.control_plane_id ||
          existing.integrations_marker_sha256 !== requested.marker_sha256 ||
          existing.integrations_installed_at !== requested.installed_at
        ) {
          throw new Error(
            'organization authority integrations installation anchor differs from the requested database',
          );
        }
      } else {
        if (
          existing.integrations_marker_sha256 !== null ||
          existing.integrations_installed_at !== null
        ) {
          throw new Error(
            'organization authority integrations installation anchor is incomplete',
          );
        }
        const update = database
          .prepare(
            `UPDATE authority_metadata
             SET integrations_control_plane_id = ?,
                 integrations_marker_sha256 = ?,
                 integrations_installed_at = ?
             WHERE singleton = 1
               AND integrations_control_plane_id IS NULL
               AND integrations_marker_sha256 IS NULL
               AND integrations_installed_at IS NULL`,
          )
          .run(
            requested.control_plane_id,
            requested.marker_sha256,
            requested.installed_at,
          );
        if (update.changes !== 1) {
          throw new Error(
            'organization authority integrations installation anchor could not be committed',
          );
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
  fsyncFile(databasePath);
  fsyncDirectory(dirname(databasePath));
  return Object.freeze(requested);
}

function assertIntegrationsInstallationBinding(
  identity: OrganizationControlDatabaseIdentity,
  marker: AuthorityIntegrationsInstallationMarkerV1,
  anchor: AuthorityIntegrationsInstallationAnchor,
  config: AuthorityIntegrationsBindingConfig,
): void {
  assertIntegrationsIdentity(identity, config);
  if (
    marker.control_plane_id !== identity.control_plane_id ||
    marker.organization_id !== identity.organization_id ||
    marker.authority_id !== identity.authority_id ||
    marker.authority_descriptor_sha256 !==
      identity.authority_descriptor_sha256 ||
    marker.database_created_at !== identity.created_at ||
    anchor.control_plane_id !== marker.control_plane_id ||
    anchor.marker_sha256 !== canonicalSha256(marker) ||
    anchor.installed_at !== marker.installed_at
  ) {
    throw new Error(
      'organization integrations database, marker, and authority installation anchor differ; restore the complete authority state',
    );
  }
}

type AuthorityRecordBindingConfig =
  | AuthorityRuntimeConfigV1
  | AuthorityServeConfig;

function authorityRecordBinding(config: AuthorityRecordBindingConfig): {
  state_directory: string;
  record_log_database_path: string;
  record_derived_database_path: string;
  organization_id: string;
  authority_id: string;
} {
  if ('state_dir' in config) {
    const paths = authorityStatePaths(config.state_dir);
    return {
      state_directory: paths.state_directory,
      record_log_database_path: paths.record_log_database_path,
      record_derived_database_path: paths.record_derived_database_path,
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
    };
  }
  return {
    state_directory: config.state_directory,
    record_log_database_path: config.record_log_database_path,
    record_derived_database_path: config.record_derived_database_path,
    organization_id: config.organization_id,
    authority_id: config.authority_id,
  };
}

function recordInstallationMarker(
  config: AuthorityRecordBindingConfig,
  installedAt: string,
): AuthorityRecordInstallationMarkerV1 {
  const binding = authorityRecordBinding(config);
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-record-installation-marker',
    organization_id: binding.organization_id,
    authority_id: binding.authority_id,
    record_log_database_path: binding.record_log_database_path,
    record_derived_database_path: binding.record_derived_database_path,
    installed_at: installedAt,
  };
}

function readRecordInstallationMarker(
  config: AuthorityRecordBindingConfig,
): AuthorityRecordInstallationMarkerV1 {
  const binding = authorityRecordBinding(config);
  const paths = authorityStatePaths(binding.state_directory);
  const path = paths.record_installation_marker_path;
  if (!existsSync(path)) {
    throw new Error(
      'authority record installation marker is missing; a previously installed record store must be restored, while a verified pre-record state must use install-integrations',
    );
  }
  return readPrivateTextFile(
    path,
    'authority record installation marker',
    MAX_RECORD_INSTALLATION_MARKER_BYTES,
    true,
    (contents) => {
      const parsed = JSON.parse(contents) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new Error(
          'authority record installation marker must be an object',
        );
      }
      const marker = parsed as Record<string, unknown>;
      if (
        Object.keys(marker).sort().join(',') !==
          [
            'authority_id',
            'installed_at',
            'kind',
            'organization_id',
            'record_derived_database_path',
            'record_log_database_path',
            'schema_version',
          ].join(',') ||
        marker.schema_version !== 1 ||
        marker.kind !==
          'echo-organization-authority-record-installation-marker' ||
        marker.organization_id !== binding.organization_id ||
        marker.authority_id !== binding.authority_id ||
        marker.record_log_database_path !==
          binding.record_log_database_path ||
        marker.record_derived_database_path !==
          binding.record_derived_database_path ||
        typeof marker.installed_at !== 'string' ||
        Number.isNaN(Date.parse(marker.installed_at))
      ) {
        throw new Error(
          'authority record installation marker is invalid or differs from config',
        );
      }
      return Object.freeze({
        schema_version: 1,
        kind: 'echo-organization-authority-record-installation-marker',
        organization_id: marker.organization_id,
        authority_id: marker.authority_id,
        record_log_database_path: marker.record_log_database_path,
        record_derived_database_path: marker.record_derived_database_path,
        installed_at: marker.installed_at,
      });
    },
  );
}

function recordInstallationAnchor(
  database: AuthorityDatabaseInspection,
): AuthorityRecordInstallationAnchor | null {
  if (
    database.record_marker_sha256 === null &&
    database.record_installed_at === null
  ) {
    return null;
  }
  if (
    database.record_marker_sha256 === null ||
    database.record_installed_at === null
  ) {
    throw new Error(
      'organization authority record installation anchor is incomplete',
    );
  }
  return Object.freeze({
    marker_sha256: database.record_marker_sha256,
    installed_at: database.record_installed_at,
  });
}

function recordInstallationAnchorForMarker(
  marker: AuthorityRecordInstallationMarkerV1,
): AuthorityRecordInstallationAnchor {
  return Object.freeze({
    marker_sha256: canonicalSha256(marker),
    installed_at: marker.installed_at,
  });
}

/**
 * Writes the record-store anchor into `authority.sqlite` exactly once.
 *
 * Re-running with the same marker is a no-op that re-validates, which is what
 * makes an interrupted installation retry-safe. A *different* marker is refused
 * by this code and again by the migration's immutability trigger: a second
 * anchor would mean a second record store, and the first one's receipts would
 * point at a log nobody is protecting any more.
 */
function commitRecordInstallationAnchor(
  databasePath: string,
  marker: AuthorityRecordInstallationMarkerV1,
): AuthorityRecordInstallationAnchor {
  const requested = recordInstallationAnchorForMarker(marker);
  const database = openAuthorityDatabase(databasePath, { fileMustExist: true });
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database
        .prepare(
          `SELECT record_marker_sha256, record_installed_at
           FROM authority_metadata WHERE singleton = 1`,
        )
        .get() as
        | {
            record_marker_sha256: string | null;
            record_installed_at: string | null;
          }
        | undefined;
      if (existing === undefined) {
        throw new Error('organization authority database metadata is missing');
      }
      if (existing.record_marker_sha256 !== null) {
        if (
          existing.record_marker_sha256 !== requested.marker_sha256 ||
          existing.record_installed_at !== requested.installed_at
        ) {
          throw new Error(
            'organization authority record installation anchor differs from the requested record store',
          );
        }
      } else {
        if (existing.record_installed_at !== null) {
          throw new Error(
            'organization authority record installation anchor is incomplete',
          );
        }
        const update = database
          .prepare(
            `UPDATE authority_metadata
             SET record_marker_sha256 = ?,
                 record_installed_at = ?
             WHERE singleton = 1
               AND record_marker_sha256 IS NULL
               AND record_installed_at IS NULL`,
          )
          .run(requested.marker_sha256, requested.installed_at);
        if (update.changes !== 1) {
          throw new Error(
            'organization authority record installation anchor could not be committed',
          );
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
  fsyncFile(databasePath);
  fsyncDirectory(dirname(databasePath));
  return requested;
}

function assertRecordInstallationBinding(
  marker: AuthorityRecordInstallationMarkerV1,
  anchor: AuthorityRecordInstallationAnchor,
  config: AuthorityRecordBindingConfig,
): void {
  const binding = authorityRecordBinding(config);
  if (
    marker.organization_id !== binding.organization_id ||
    marker.authority_id !== binding.authority_id ||
    marker.record_log_database_path !== binding.record_log_database_path ||
    marker.record_derived_database_path !==
      binding.record_derived_database_path ||
    anchor.marker_sha256 !== canonicalSha256(marker) ||
    anchor.installed_at !== marker.installed_at
  ) {
    throw new Error(
      'organization record marker and authority installation anchor differ; restore the complete authority state',
    );
  }
}

/**
 * The whole point of the anchor, in one function.
 *
 * Once an authority has published a record store, its log is the organization's
 * history, and the only honest answer to a missing log is to refuse. Serve
 * refuses here, maintenance refuses in `installAuthorityRecordStore`, and
 * neither will recreate the file — a fresh empty log would look healthy while
 * every receipt already in members' hands pointed at records it no longer
 * holds.
 */
function assertRecordInstallationBoundState(
  database: AuthorityDatabaseInspection,
  config: AuthorityRecordBindingConfig,
): void {
  const binding = authorityRecordBinding(config);
  const anchor = recordInstallationAnchor(database);
  if (anchor === null) {
    throw new Error(
      'organization authority record installation anchor is missing',
    );
  }
  for (const [path, label] of [
    [binding.record_log_database_path, 'record log'],
    [binding.record_derived_database_path, 'record derived'],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(
        `authority ${label} database is missing; restore the published state directory`,
      );
    }
  }
  assertRecordInstallationBinding(
    readRecordInstallationMarker(config),
    anchor,
    config,
  );
}

export function assertAuthorityRuntimeStateBinding(
  config: AuthorityServeConfig,
): void {
  const authority = inspectAuthorityDatabaseForServe(config.database_path);
  if (
    authority.authority_id !== config.authority_id ||
    authority.organization_id !== config.organization_id ||
    authority.organization_display_name !== config.organization_display_name ||
    authority.authority_pin_sha256 !== config.authority_pin_sha256
  ) {
    throw new Error('authority database identity differs from config');
  }
  const anchor = integrationsInstallationAnchor(authority);
  if (anchor === null) {
    throw new Error(
      'organization authority integrations installation anchor is missing',
    );
  }
  const marker = readIntegrationsInstallationMarker(config);
  assertIntegrationsInstallationBinding(
    inspectOrganizationControlDatabaseForServe(
      config.integrations_database_path,
    ),
    marker,
    anchor,
    config,
  );
  assertRecordInstallationBoundState(authority, config);
}

function inspectUnanchoredIntegrationsPair(
  config: AuthorityRuntimeConfigV1,
): {
  identity: OrganizationControlDatabaseIdentity;
  marker: AuthorityIntegrationsInstallationMarkerV1;
} {
  const paths = authorityStatePaths(config.state_dir);
  const marker = readIntegrationsInstallationMarker(config);
  const identity = inspectOrganizationControlDatabaseForServe(
    paths.integrations_database_path,
  );
  assertIntegrationsInstallationBinding(
    identity,
    marker,
    integrationsInstallationAnchorForMarker(marker),
    config,
  );
  return { identity, marker };
}

function migrateIntegrationsDatabase(
  config: AuthorityRuntimeConfigV1,
): OrganizationControlDatabaseIdentity {
  const databasePath = authorityStatePaths(
    config.state_dir,
  ).integrations_database_path;
  const before = inspectOrganizationControlDatabaseForServe(databasePath);
  assertIntegrationsIdentity(before, config);
  const database = openOrganizationControlDatabase(databasePath, {
    fileMustExist: true,
  });
  database.close();
  fsyncFile(databasePath);
  fsyncDirectory(dirname(databasePath));
  const after = inspectOrganizationControlDatabaseReadOnly(databasePath);
  assertIntegrationsIdentity(after, config);
  if (
    after.control_plane_id !== before.control_plane_id ||
    after.organization_id !== before.organization_id ||
    after.authority_id !== before.authority_id ||
    after.authority_descriptor_sha256 !==
      before.authority_descriptor_sha256 ||
    after.created_at !== before.created_at
  ) {
    throw new Error(
      'organization integrations database identity changed during migration',
    );
  }
  return after;
}

function migrateAuthorityForIntegrationsInstallation(
  config: AuthorityRuntimeConfigV1,
): AuthorityDatabaseInspection {
  const database = openAuthorityDatabase(config.database_path, {
    fileMustExist: true,
  });
  database.close();
  fsyncFile(config.database_path);
  fsyncDirectory(dirname(config.database_path));
  const inspected = inspectAuthorityDatabaseReadOnly(config.database_path);
  if (
    inspected.schema_version < 3 ||
    integrationsInstallationAnchor(inspected) !== null
  ) {
    throw new Error(
      'organization authority could not enter the unanchored integrations installation state',
    );
  }
  return inspected;
}

function publishPreparedFile(
  preparedPath: string,
  destinationPath: string,
  parentDirectory: string,
): void {
  linkSync(preparedPath, destinationPath);
  fsyncDirectory(parentDirectory);
  unlinkSync(preparedPath);
  fsyncDirectory(parentDirectory);
}

function removeUnanchoredIntegrationsMarker(
  config: AuthorityRuntimeConfigV1,
): void {
  const paths = authorityStatePaths(config.state_dir);
  // Read first so retry recovery never deletes an arbitrary or unsafe path
  // entry merely because it occupies the canonical marker name.
  readIntegrationsInstallationMarker(config);
  unlinkSync(paths.integrations_installation_marker_path);
  fsyncDirectory(paths.state_directory);
}

function writePrivateJsonExclusive(path: string, value: unknown): void {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    writeFileSync(file, `${canonicalJson(value)}\n`, 'utf8');
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function readInitializationManifest(
  stateDirectory: string,
): AuthorityInitializationManifestV1 {
  const paths = authorityStatePaths(stateDirectory);
  const path = paths.initialization_manifest_path;
  return readPrivateTextFile(
    path,
    'authority initialization manifest',
    MAX_INITIALIZATION_MANIFEST_BYTES,
    true,
    (contents) => {
    const parsed = JSON.parse(contents) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('authority initialization manifest must be an object');
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !==
        'config_path,kind,runtime_config,schema_version' ||
      record.schema_version !== 1 ||
      record.kind !== 'echo-organization-authority-initialization-manifest'
    ) {
      throw new Error(
        'authority initialization manifest has an unsupported shape',
      );
    }
    const configPath = normalizedAbsolutePath(
      record.config_path,
      'bound authority config path',
    );
    const runtimeConfig = validateAuthorityRuntimeConfig(record.runtime_config);
    assertAuthorityConfigStateSeparation(configPath, runtimeConfig.state_dir);
    if (runtimeConfig.state_dir !== paths.state_directory) {
      throw new Error(
        'authority initialization manifest belongs to a different state directory',
      );
    }
    const manifest: AuthorityInitializationManifestV1 = {
      schema_version: 1,
      kind: 'echo-organization-authority-initialization-manifest',
      config_path: configPath,
      runtime_config: runtimeConfig,
    };
    if (contents !== `${canonicalJson(manifest)}\n`) {
      throw new Error('authority initialization manifest is not canonical');
    }
    return manifest;
    },
  );
}

function assertInitializationBinding(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): AuthorityInitializationManifestV1 {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const manifest = readInitializationManifest(config.state_dir);
  if (
    manifest.config_path !== path ||
    canonicalJson(manifest.runtime_config) !== canonicalJson(config)
  ) {
    throw new Error(
      'authority config path or contents differ from the initialized intent',
    );
  }
  return manifest;
}

function readIdentity(path: string): AuthorityIdentityRecordV1 {
  return readPrivateTextFile(
    path,
    'authority identity',
    MAX_IDENTITY_BYTES,
    false,
    (contents) => {
      const parsed = JSON.parse(contents) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('authority identity must be an object');
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !==
        'authority_descriptor,authority_pin_sha256,kind,schema_version' ||
      record.schema_version !== 1 ||
      record.kind !== 'echo-organization-authority-identity' ||
      typeof record.authority_pin_sha256 !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(record.authority_pin_sha256)
    ) {
      throw new Error('authority identity has an unsupported shape');
    }
    const descriptor = validateOrganizationAuthorityDescriptor(
      record.authority_descriptor,
    );
    verifyOrganizationAuthorityPin(descriptor, record.authority_pin_sha256);
    return {
      schema_version: 1,
      kind: 'echo-organization-authority-identity',
      authority_descriptor: descriptor,
      authority_pin_sha256: record.authority_pin_sha256 as `sha256:${string}`,
    };
    },
  );
}

function initializationResult(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
  identity: AuthorityIdentityRecordV1,
  created: boolean,
): DevelopmentAuthorityInitializationResult {
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-development-initialization',
    created,
    config_path: configPath,
    state_dir: config.state_dir,
    listener: { ...config.listener },
    authority_descriptor: identity.authority_descriptor,
    authority_pin_sha256: identity.authority_pin_sha256,
  };
}

/** Verifies initialized files except SQLite, so serve may apply migrations. */
export async function inspectInitializedAuthorityFiles(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): Promise<InspectedAuthorityState> {
  const paths = authorityStatePaths(config.state_dir);
  assertPrivateDirectory(paths.state_directory, 'authority state directory');
  assertInitializationBinding(configPath, config);
  assertPrivateDirectory(paths.key_directory, 'authority key directory');
  assertPrivateDirectory(
    paths.credential_directory,
    'authority credential directory',
  );

  const signer = DevelopmentFileOrganizationAuthoritySigner.openExisting({
    directory: config.signer.key_directory,
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
  });
  const signerDescriptor = await signer.inspect();
  verifyOrganizationAuthorityPin(
    signerDescriptor,
    config.authority.authority_pin_sha256,
  );
  const identity = readIdentity(paths.identity_path);
  if (
    canonicalJson(identity.authority_descriptor) !==
      canonicalJson(signerDescriptor) ||
    identity.authority_pin_sha256 !== config.authority.authority_pin_sha256
  ) {
    throw new Error('authority identity differs from config or signing key');
  }

  const adminToken = readPrivateAuthorityCredential(
    config.credentials.admin_token_ref,
  );
  const trustedProxyToken = readPrivateAuthorityCredential(
    config.credentials.trusted_proxy_token_ref,
  );
  if (adminToken === trustedProxyToken) {
    throw new Error(
      'administrator and trusted proxy credentials must be distinct',
    );
  }
  new AdminBearerAuthenticator(adminToken);
  new AuthenticatedProxyClientIdentityResolver(trustedProxyToken);
  return { config, identity };
}

export async function inspectInitializedAuthorityState(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): Promise<InspectedAuthorityState> {
  return inspectBoundAuthorityState(
    configPath,
    config,
    inspectAuthorityDatabaseReadOnly,
    inspectOrganizationControlDatabaseReadOnly,
  );
}

function assertAuthorityDatabaseIdentity(
  database: AuthorityDatabaseInspection,
  config: AuthorityRuntimeConfigV1,
  identity: AuthorityIdentityRecordV1,
): void {
  if (
    database.authority_id !== config.authority.authority_id ||
    database.organization_id !== config.organization.organization_id ||
    database.organization_display_name !== config.organization.display_name ||
    database.authority_pin_sha256 !== config.authority.authority_pin_sha256 ||
    canonicalJson(database.authority_descriptor) !==
      canonicalJson(identity.authority_descriptor)
  ) {
    throw new Error('authority database identity differs from config');
  }
}

async function inspectBoundAuthorityState(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
  inspectAuthority: AuthorityDatabaseInspector,
  inspectIntegrations: IntegrationsDatabaseInspector,
): Promise<InspectedAuthorityState> {
  const inspected = await inspectInitializedAuthorityFiles(configPath, config);
  const database = inspectAuthority(config.database_path);
  assertAuthorityDatabaseIdentity(database, config, inspected.identity);
  const integrationsAnchor = integrationsInstallationAnchor(database);
  if (integrationsAnchor === null) {
    throw new Error(
      'organization authority integrations installation anchor is missing',
    );
  }
  const integrationsMarker = readIntegrationsInstallationMarker(config);
  assertIntegrationsInstallationBinding(
    inspectIntegrations(integrationsMarker.integrations_database_path),
    integrationsMarker,
    integrationsAnchor,
    config,
  );
  assertRecordInstallationBoundState(database, config);
  inspectRecordDatabases(
    authorityStatePaths(config.state_dir),
    config,
    inspectAuthority === inspectAuthorityDatabaseForServe,
  );
  return inspected;
}

export async function inspectAuthorityServePreflight(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): Promise<InspectedAuthorityState> {
  return inspectBoundAuthorityState(
    configPath,
    config,
    inspectAuthorityDatabaseForServe,
    inspectOrganizationControlDatabaseForServe,
  );
}

async function recoverCompleteState(
  options: InitializeDevelopmentAuthorityOptions,
  configPath: string,
  stateDirectory: string,
): Promise<DevelopmentAuthorityInitializationResult> {
  const paths = authorityStatePaths(stateDirectory);
  assertPrivateDirectory(stateDirectory, 'authority state directory');
  const manifest = readInitializationManifest(stateDirectory);
  const config = manifest.runtime_config;
  if (
    manifest.config_path !== configPath ||
    config.organization.display_name !== options.organization_display_name ||
    (options.port !== undefined && config.listener.port !== options.port)
  ) {
    throw new Error(
      'published authority state differs from the requested initialization',
    );
  }
  const identity = readIdentity(paths.identity_path);
  await inspectInitializedAuthorityState(configPath, config);
  writeAuthorityRuntimeConfigExclusive(configPath, config);
  return initializationResult(configPath, config, identity, false);
}

async function initializeDevelopmentAuthorityLocked(
  options: InitializeDevelopmentAuthorityOptions,
  configPath: string,
  stateDirectory: string,
): Promise<DevelopmentAuthorityInitializationResult> {
  if (existsSync(configPath)) {
    const config = readAuthorityRuntimeConfig(configPath);
    if (
      config.state_dir !== stateDirectory ||
      config.organization.display_name !== options.organization_display_name ||
      (options.port !== undefined && config.listener.port !== options.port)
    ) {
      throw new Error(
        'existing authority config differs from the requested initialization',
      );
    }
    const inspected = await inspectInitializedAuthorityState(
      configPath,
      config,
    );
    return initializationResult(configPath, config, inspected.identity, false);
  }
  if (existsSync(stateDirectory)) {
    try {
      return await recoverCompleteState(options, configPath, stateDirectory);
    } catch (error) {
      throw new Error(
        `existing authority state is incomplete or conflicts with initialization: ${
          error instanceof Error ? error.message : 'unknown state error'
        }`,
      );
    }
  }

  const stateParent = dirname(stateDirectory);
  const stagingDirectory = mkdtempSync(
    join(stateParent, `.${basename(stateDirectory)}.initializing-`),
  );
  chmodSync(stagingDirectory, 0o700);
  let published = false;
  try {
    const stagingPaths = authorityStatePaths(stagingDirectory);
    ensurePrivateDirectory(
      stagingPaths.key_directory,
      'authority key directory',
    );
    ensurePrivateDirectory(
      stagingPaths.credential_directory,
      'authority credential directory',
    );

    const organizationId = federationId('org');
    const authorityId = federationId('oau');
    const signer = DevelopmentFileOrganizationAuthoritySigner.initialize({
      directory: stagingPaths.key_directory,
      authority_id: authorityId,
      organization_id: organizationId,
    });
    const descriptor = await signer.inspect();
    const authorityPin = organizationAuthorityPinSha256(descriptor);
    const config = createAuthorityRuntimeConfig({
      state_directory: stateDirectory,
      organization_id: organizationId,
      organization_display_name: options.organization_display_name,
      authority_id: authorityId,
      authority_pin_sha256: authorityPin,
      ...(options.port === undefined ? {} : { port: options.port }),
    });

    const adminToken = createPrivateAuthorityCredential(
      stagingPaths.admin_credential_path,
    );
    const trustedProxyToken = createPrivateAuthorityCredential(
      stagingPaths.proxy_credential_path,
    );
    if (adminToken === trustedProxyToken) {
      throw new Error('generated authority credentials unexpectedly collide');
    }

    const repository = new SqliteOrganizationAuthorityRepository(
      stagingPaths.database_path,
    );
    try {
      repository.initialize({
        descriptor,
        authority_pin_sha256: authorityPin,
        organization_display_name: options.organization_display_name,
        maximum_active_lease_ttl_ms: config.access.active_lease_ttl_ms,
        initialized_at: new Date().toISOString(),
      });
    } finally {
      repository.close();
    }
    const integrationsIdentity = initializeOrganizationControlDatabase(
      stagingPaths.integrations_database_path,
      {
        organization_id: organizationId,
        authority_id: authorityId,
        authority_descriptor_sha256: authorityPin,
        created_at: new Date().toISOString(),
      },
    );
    createRecordDatabases(stagingPaths, organizationId, authorityId);
    const integrationsMarker = integrationsInstallationMarker(
      config,
      integrationsIdentity,
      new Date().toISOString(),
    );
    writePrivateJsonExclusive(
      stagingPaths.integrations_installation_marker_path,
      integrationsMarker,
    );
    recordIntegrationsInstallationAnchor(
      stagingPaths.database_path,
      integrationsMarker,
    );
    // A fresh authority is anchored from the first moment it exists, so the
    // "no anchor" state can only ever mean a directory published before the
    // record store did — the one case maintenance is allowed to bootstrap.
    const recordMarker = recordInstallationMarker(
      config,
      new Date().toISOString(),
    );
    writePrivateJsonExclusive(
      stagingPaths.record_installation_marker_path,
      recordMarker,
    );
    commitRecordInstallationAnchor(stagingPaths.database_path, recordMarker);
    const identity: AuthorityIdentityRecordV1 = {
      schema_version: 1,
      kind: 'echo-organization-authority-identity',
      authority_descriptor: descriptor,
      authority_pin_sha256: authorityPin,
    };
    writePrivateJsonExclusive(stagingPaths.identity_path, identity);
    const initializationManifest: AuthorityInitializationManifestV1 = {
      schema_version: 1,
      kind: 'echo-organization-authority-initialization-manifest',
      config_path: configPath,
      runtime_config: config,
    };
    writePrivateJsonExclusive(
      stagingPaths.initialization_manifest_path,
      initializationManifest,
    );
    fsyncDirectory(stagingPaths.key_directory);
    fsyncDirectory(stagingPaths.credential_directory);
    fsyncDirectory(stagingDirectory);
    renameSync(stagingDirectory, stateDirectory);
    published = true;
    fsyncDirectory(stateParent);
    writeAuthorityRuntimeConfigExclusive(configPath, config);
    return initializationResult(configPath, config, identity, true);
  } catch (error) {
    if (!published && existsSync(stagingDirectory)) {
      try {
        rmSync(stagingDirectory, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
}

export async function initializeDevelopmentAuthority(
  options: InitializeDevelopmentAuthorityOptions,
): Promise<DevelopmentAuthorityInitializationResult> {
  const configPath = normalizedAbsolutePath(
    options.config_path,
    'authority config path',
  );
  const stateDirectory = normalizedAbsolutePath(
    options.state_directory,
    'authority state directory',
  );
  assertAuthorityConfigStateSeparation(configPath, stateDirectory);
  assertDisplayName(options.organization_display_name);
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535)
  ) {
    throw new Error(
      'authority listener port must be an integer from 1 to 65535',
    );
  }
  assertPrivateParent(configPath, 'authority config parent');
  assertPrivateParent(stateDirectory, 'authority state parent');
  const release = await acquireAuthorityInitializationLock(
    configPath,
    stateDirectory,
  );
  try {
    return await initializeDevelopmentAuthorityLocked(
      options,
      configPath,
      stateDirectory,
    );
  } finally {
    await release();
  }
}

function integrationsInstallationResult(
  created: boolean,
  configPath: string,
  config: AuthorityRuntimeConfigV1,
  identity: OrganizationControlDatabaseIdentity,
): AuthorityIntegrationsInstallationResult {
  return Object.freeze({
    schema_version: 1,
    kind: 'echo-organization-authority-integrations-installation',
    created,
    config_path: configPath,
    state_dir: config.state_dir,
    integrations_database_path: authorityStatePaths(config.state_dir)
      .integrations_database_path,
    control_plane_id: identity.control_plane_id,
    organization_id: identity.organization_id,
    authority_id: identity.authority_id,
  });
}

async function installAuthorityIntegrationsLocked(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
  options: InstallAuthorityIntegrationsOptions,
): Promise<AuthorityIntegrationsInstallationResult> {
  const inspected = await inspectInitializedAuthorityFiles(configPath, config);
  const authorityBeforeInstallation = inspectAuthorityDatabaseForServe(
    config.database_path,
  );
  assertAuthorityDatabaseIdentity(
    authorityBeforeInstallation,
    config,
    inspected.identity,
  );

  const paths = authorityStatePaths(config.state_dir);
  const existingAnchor = integrationsInstallationAnchor(
    authorityBeforeInstallation,
  );
  let markerExists = existsSync(
    paths.integrations_installation_marker_path,
  );
  let databaseExists = existsSync(paths.integrations_database_path);
  if (existingAnchor !== null) {
    if (!markerExists || !databaseExists) {
      throw new Error(
        'organization integrations were previously installed but the database or marker is missing; restore the complete authority state instead of recreating it',
      );
    }
    const marker = readIntegrationsInstallationMarker(config);
    // An anchored installation may be on an authenticated older schema.
    // Validate it read-only here; serve applies pending migrations after it
    // acquires the same runtime singleton guard.
    const identity = inspectOrganizationControlDatabaseForServe(
      paths.integrations_database_path,
    );
    assertIntegrationsInstallationBinding(
      identity,
      marker,
      existingAnchor,
      config,
    );
    return integrationsInstallationResult(false, configPath, config, identity);
  }

  const legacyAuthority = authorityBeforeInstallation.schema_version < 3;
  if (legacyAuthority && markerExists !== databaseExists) {
    throw new Error(
      'legacy authority has only part of the integrations database-marker pair; refuse ambiguous state and restore a complete backup',
    );
  }

  if (markerExists && databaseExists) {
    const { marker } = inspectUnanchoredIntegrationsPair(config);
    migrateAuthorityForIntegrationsInstallation(config);
    options.faultInjector?.('after_authority_migration');
    const identity = migrateIntegrationsDatabase(config);
    assertIntegrationsInstallationBinding(
      identity,
      marker,
      integrationsInstallationAnchorForMarker(marker),
      config,
    );
    const anchor = recordIntegrationsInstallationAnchor(
      config.database_path,
      marker,
    );
    options.faultInjector?.('after_anchor_committed');
    assertIntegrationsInstallationBinding(identity, marker, anchor, config);
    return integrationsInstallationResult(false, configPath, config, identity);
  }

  migrateAuthorityForIntegrationsInstallation(config);
  options.faultInjector?.('after_authority_migration');

  if (markerExists && !databaseExists) {
    // With a current unanchored Authority, a marker by itself is conclusively
    // unpublished: an installed state is valid only after its database-marker
    // pair is durably bound by the Authority anchor. Validate before removal so
    // an unsafe or foreign path is never silently replaced.
    removeUnanchoredIntegrationsMarker(config);
    markerExists = false;
  }

  let created = false;
  let identity: OrganizationControlDatabaseIdentity;
  let preparedPath: string | undefined;
  const preparedMarkerPath = join(
    paths.state_directory,
    `.authority-integrations-installation.v1.json.installing-${randomBytes(
      16,
    ).toString('hex')}`,
  );
  try {
    if (databaseExists) {
      identity = migrateIntegrationsDatabase(config);
    } else {
      preparedPath = join(
        paths.state_directory,
        `.integrations.sqlite.installing-${randomBytes(16).toString('hex')}`,
      );
      identity = initializeOrganizationControlDatabase(preparedPath, {
        organization_id: config.organization.organization_id,
        authority_id: config.authority.authority_id,
        authority_descriptor_sha256: config.authority.authority_pin_sha256,
        created_at: new Date().toISOString(),
      });
      fsyncFile(preparedPath);
      publishPreparedFile(
        preparedPath,
        paths.integrations_database_path,
        paths.state_directory,
      );
      preparedPath = undefined;
      created = true;
      databaseExists = true;
      options.faultInjector?.('after_database_published');
    }

    const marker = integrationsInstallationMarker(
      config,
      identity,
      new Date().toISOString(),
    );
    writePrivateJsonExclusive(preparedMarkerPath, marker);
    publishPreparedFile(
      preparedMarkerPath,
      paths.integrations_installation_marker_path,
      paths.state_directory,
    );
    markerExists = true;
    options.faultInjector?.('after_marker_published');

    const installed = inspectUnanchoredIntegrationsPair(config);
    const anchor = recordIntegrationsInstallationAnchor(
      config.database_path,
      installed.marker,
    );
    options.faultInjector?.('after_anchor_committed');
    assertIntegrationsInstallationBinding(
      installed.identity,
      installed.marker,
      anchor,
      config,
    );
    return integrationsInstallationResult(
      created,
      configPath,
      config,
      installed.identity,
    );
  } finally {
    if (preparedPath !== undefined && existsSync(preparedPath)) {
      try {
        unlinkSync(preparedPath);
      } catch {}
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${preparedPath}${suffix}`;
        if (existsSync(sidecar)) {
          try {
            unlinkSync(sidecar);
          } catch {}
        }
      }
    }
    if (existsSync(preparedMarkerPath)) {
      try {
        unlinkSync(preparedMarkerPath);
      } catch {}
    }
    if (!markerExists || !databaseExists) {
      fsyncDirectory(paths.state_directory);
    }
  }
}

/**
 * The retrofit step for a state directory published before the record store
 * existed — and the guard that stops it from being anything else.
 *
 * The rule is one sentence: **serve refuses an unanchored record store**, so an
 * authority with no anchor cannot have accepted a single append, and an
 * authority with an anchor holds history that must never be recreated. Every
 * branch below follows from that.
 *
 * - Anchored: validate the marker and both databases, migrate in place, and
 *   refuse outright if any of the three is missing. This is the deletion case
 *   the anchor exists for, and it stays refused even when the marker and both
 *   databases were removed together.
 * - Unanchored with both databases present: adopt them. No append can have
 *   reached them, and destroying a pair an operator restored by hand would be
 *   worse than protecting it.
 * - Unanchored with exactly one database: ambiguous, refuse — the same rule the
 *   integrations database-marker pair follows.
 * - Unanchored with neither: the provably pre-record legacy state. Create,
 *   publish the marker, anchor.
 *
 * Publication is ordered databases → marker → anchor and every step is
 * idempotent, so an interruption anywhere resumes on the next run rather than
 * leaving a half-installed record store.
 */
function installAuthorityRecordStore(
  config: AuthorityRuntimeConfigV1,
  options: InstallAuthorityIntegrationsOptions,
): void {
  const paths = authorityStatePaths(config.state_dir);
  const inspected = inspectAuthorityDatabaseForServe(config.database_path);
  const anchor = recordInstallationAnchor(inspected);
  const createDatabases = (): void => {
    createRecordDatabases(
      paths,
      config.organization.organization_id,
      config.authority.authority_id,
    );
  };

  if (anchor !== null) {
    if (
      !existsSync(paths.record_installation_marker_path) ||
      !existsSync(paths.record_log_database_path) ||
      !existsSync(paths.record_derived_database_path)
    ) {
      throw new Error(
        'organization record store was already installed but its marker, log, or derived database is missing; restore the complete authority state instead of recreating it',
      );
    }
    const marker = readRecordInstallationMarker(config);
    assertRecordInstallationBinding(marker, anchor, config);
    // Idempotent: opening an existing pair only re-binds and migrates it.
    createDatabases();
    return;
  }

  const logExists = existsSync(paths.record_log_database_path);
  const derivedExists = existsSync(paths.record_derived_database_path);
  if (logExists !== derivedExists) {
    throw new Error(
      'organization authority has only part of the record log/derived pair; refuse ambiguous state and restore a complete backup',
    );
  }
  let markerExists = existsSync(paths.record_installation_marker_path);
  if (!logExists && markerExists) {
    // Conclusively unpublished: an unanchored marker beside no databases can
    // never have described a log anything appended to. Read it first so an
    // unsafe or foreign entry occupying the canonical name is refused rather
    // than silently deleted.
    readRecordInstallationMarker(config);
    unlinkSync(paths.record_installation_marker_path);
    fsyncDirectory(paths.state_directory);
    markerExists = false;
  }

  createDatabases();
  options.faultInjector?.('after_record_databases_published');
  const marker = markerExists
    ? readRecordInstallationMarker(config)
    : publishRecordInstallationMarker(config);
  options.faultInjector?.('after_record_marker_published');
  const committed = commitRecordInstallationAnchor(
    config.database_path,
    marker,
  );
  assertRecordInstallationBinding(marker, committed, config);
}

function publishRecordInstallationMarker(
  config: AuthorityRuntimeConfigV1,
): AuthorityRecordInstallationMarkerV1 {
  const paths = authorityStatePaths(config.state_dir);
  const preparedPath = join(
    paths.state_directory,
    `.authority-record-installation.v1.json.installing-${randomBytes(
      16,
    ).toString('hex')}`,
  );
  try {
    const marker = recordInstallationMarker(config, new Date().toISOString());
    writePrivateJsonExclusive(preparedPath, marker);
    publishPreparedFile(
      preparedPath,
      paths.record_installation_marker_path,
      paths.state_directory,
    );
    return marker;
  } finally {
    if (existsSync(preparedPath)) {
      try {
        unlinkSync(preparedPath);
      } catch {}
    }
  }
}

export async function installAuthorityIntegrations(
  configPath: string,
  options: InstallAuthorityIntegrationsOptions = {},
): Promise<AuthorityIntegrationsInstallationResult> {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const config = readAuthorityRuntimeConfig(path);
  const releaseInitialization = await acquireAuthorityInitializationLock(
    path,
    config.state_dir,
  );
  try {
    const serveConfig = resolveAuthorityServeConfig(config);
    const runtimeLock = await acquireAuthorityRuntimeLock(
      config.state_dir,
      authorityMaintenanceFingerprint(serveConfig, 'install-integrations'),
    );
    try {
      const result = await installAuthorityIntegrationsLocked(
        path,
        config,
        options,
      );
      installAuthorityRecordStore(config, options);
      return result;
    } finally {
      await runtimeLock.release();
    }
  } finally {
    await releaseInitialization();
  }
}

/**
 * Reads the two named memberships from the stopped Authority without opening
 * its write-capable repository or changing `last_observed_at`.
 *
 * Extra active members are deliberately irrelevant here. Pilot slice 1 binds
 * exactly the two command members; membership outside that pair does not enter
 * the marker and can never satisfy the read policy.
 */
function assertPermissionPilotAudienceMemberships(
  config: AuthorityRuntimeConfigV1,
  command: OrganizationPermissionPilotActivationCommandV1,
): void {
  const membershipIds = [
    command.audience[0].membership_id,
    command.audience[1].membership_id,
  ] as const;
  const rows = inspectAuthorityPermissionPilotAudienceReadOnly(
    config.database_path,
    {
      authority_id: config.authority.authority_id,
      organization_id: config.organization.organization_id,
      membership_ids: membershipIds,
    },
  );
  if (rows.length !== 2 || rows.some((row) => row.status !== 'active')) {
    throw new Error(
      'permission pilot activation requires both named audience memberships to be active',
    );
  }
  const rowsByMembership = new Map(
    rows.map((row) => [row.membership_id, row] as const),
  );
  for (const audience of command.audience) {
    const membership = rowsByMembership.get(audience.membership_id);
    if (membership === undefined) {
      throw new Error(
        'permission pilot activation requires both named audience memberships to be active',
      );
    }
    assertDisplayName(membership.display_name);
    if (audience.label !== membership.display_name) {
      throw new Error(
        'permission pilot audience labels must equal current Authority principal display names',
      );
    }
  }
}

function permissionPilotActivationResult(
  created: boolean,
  configPath: string,
  config: AuthorityRuntimeConfigV1,
  marker: OrganizationPermissionPilotActivationMarkerV1,
): AuthorityPermissionPilotActivationResult {
  const paths = authorityStatePaths(config.state_dir);
  return Object.freeze({
    schema_version: 1,
    kind: 'echo-organization-authority-permission-pilot-activation',
    created,
    config_path: configPath,
    state_dir: config.state_dir,
    record_log_database_path: paths.record_log_database_path,
    organization_id: config.organization.organization_id,
    authority_id: config.authority.authority_id,
    marker,
    presentation_descriptor: marker.presentation_descriptor,
  });
}

/**
 * Operator-confirmed, stopped-state activation for the fixed two-person pilot.
 *
 * Initialization ownership stabilizes config-to-state binding. Runtime
 * ownership proves the serving process is stopped and shares its singleton
 * fence with record append. Once the immutable marker exists, its exact
 * command id and digest are checked before freshness, membership, or log-head
 * state so an interrupted operator retry always returns the original durable
 * result.
 */
export async function activateOrganizationPermissionPilot(
  configPath: string,
  commandPath: string,
  options: ActivateOrganizationPermissionPilotOptions = {},
): Promise<AuthorityPermissionPilotActivationResult> {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const config = readAuthorityRuntimeConfig(path);
  const command = readPermissionPilotActivationCommand(commandPath, config);
  const commandSha256 = organizationPermissionPilotCommandSha256(command);
  const releaseInitialization = await acquireAuthorityInitializationLock(
    path,
    config.state_dir,
  );
  try {
    const serveConfig = resolveAuthorityServeConfig(config);
    const runtimeLock = await acquireAuthorityRuntimeLock(
      config.state_dir,
      authorityMaintenanceFingerprint(
        serveConfig,
        'activate-permission-pilot',
      ),
    );
    try {
      await inspectAuthorityServePreflight(path, config);
      const paths = authorityStatePaths(config.state_dir);
      const log = OrganizationPermissionPilotLog.open(
        paths.record_log_database_path,
        {
          organization_id: config.organization.organization_id,
          authority_id: config.authority.authority_id,
        },
      );
      try {
        const existing = log.activation();
        if (existing !== null) {
          if (
            existing.command_id !== command.command_id ||
            existing.command_sha256 !== commandSha256
          ) {
            throw new Error(
              'organization permission pilot was already activated by a different command',
            );
          }
          return permissionPilotActivationResult(
            false,
            path,
            config,
            existing,
          );
        }

        const activatedAt = (options.now ?? (() => new Date().toISOString()))();
        assertOrganizationPermissionPilotActivationFresh(
          command,
          activatedAt,
        );
        assertPermissionPilotAudienceMemberships(config, command);
        const activated = log.activate({
          command,
          command_sha256: commandSha256,
          activated_at: activatedAt,
        });
        return permissionPilotActivationResult(
          activated.created,
          path,
          config,
          activated.marker,
        );
      } finally {
        log.close();
      }
    } finally {
      await runtimeLock.release();
    }
  } finally {
    await releaseInitialization();
  }
}

async function inspectAuthorityRecordRebuildPreflight(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): Promise<void> {
  const inspected = await inspectInitializedAuthorityFiles(configPath, config);
  const database = inspectAuthorityDatabaseReadOnly(config.database_path);
  assertAuthorityDatabaseIdentity(database, config, inspected.identity);
  const anchor = recordInstallationAnchor(database);
  if (anchor === null) {
    throw new Error(
      'organization authority record installation anchor is missing',
    );
  }
  assertRecordInstallationBinding(
    readRecordInstallationMarker(config),
    anchor,
    config,
  );
}

function assertReplaceableRecordDerivedPath(path: string): void {
  let state: ReturnType<typeof lstatSync>;
  try {
    state = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(path) !== path ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'authority record derived database must be absent or a current-user 0600 canonical file',
    );
  }
}

function assertNoSqliteSidecars(databasePath: string, label: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = `${databasePath}${suffix}`;
    try {
      lstatSync(sidecar);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(
      `${label} has SQLite sidecar ${basename(sidecar)}; investigate or restore the stopped state before rebuilding`,
    );
  }
}

function assertRecordRebuildPaths(paths: AuthorityStatePaths): void {
  assertNoSqliteSidecars(paths.record_log_database_path, 'record log database');
  assertNoSqliteSidecars(
    paths.record_derived_database_path,
    'record derived database',
  );
  assertReplaceableRecordDerivedPath(paths.record_derived_database_path);
}

async function rebuildAuthorityDerivedRecordStoreLocked(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): Promise<AuthorityRecordDerivedRebuildResult> {
  await inspectAuthorityRecordRebuildPreflight(configPath, config);
  const paths = authorityStatePaths(config.state_dir);
  assertRecordRebuildPaths(paths);
  if (!existsSync(paths.record_log_database_path)) {
    throw new Error(
      'authority record log database is missing; restore the published state directory',
    );
  }

  const organizationId = config.organization.organization_id;
  const preparedPath = join(
    paths.state_directory,
    `.record-derived.sqlite.rebuilding-${randomBytes(16).toString('hex')}`,
  );
  let rebuilt: OrganizationRecordDerivedStore | undefined;
  try {
    const logDatabase = openOrganizationRecordDatabase(
      paths.record_log_database_path,
      ORGANIZATION_RECORD_LOG_DATABASE,
      { readonly: true },
    );
    let headPosition: number;
    let contentDigest: `sha256:${string}`;
    try {
      logDatabase.pragma('query_only = ON');
      logDatabase.exec('BEGIN');
      inspectOpenRecordDatabase(
        logDatabase,
        ORGANIZATION_RECORD_LOG_DATABASE,
        'record log',
        config,
        false,
      );
      const reader = new OrganizationRecordLogReader(logDatabase);
      const verification = verifyOrganizationRecordChain({
        organization_id: organizationId,
        authority_id: config.authority.authority_id,
        rows: () => reader.readAfter(0, Number.MAX_SAFE_INTEGER),
      });
      if (verification.failures.length > 0) {
        const detail = verification.failures
          .map(
            (failure) =>
              `${failure.position}:${failure.kind}:${failure.detail}`,
          )
          .join('; ');
        throw new Error(
          `organization record log chain verification failed: ${detail}`,
        );
      }
      headPosition = verification.head_position ?? 0;

      rebuilt = OrganizationRecordDerivedStore.open(preparedPath, {
        organization_id: organizationId,
      });
      const follower = new OrganizationRecordFollower({
        logReader: reader,
        derived: rebuilt,
      });
      const progress = await follower.drain();
      if (progress.halted) {
        const cause = follower.haltCause;
        throw new Error(
          `organization record derive halted while rebuilding at cursor ${progress.cursor_position}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause === null ? undefined : { cause },
        );
      }
      if (
        progress.cursor_position !== headPosition ||
        progress.records_derived !== headPosition
      ) {
        throw new Error(
          `organization record rebuild derived ${progress.records_derived} records to cursor ${progress.cursor_position} instead of the verified log head ${headPosition}`,
        );
      }
      contentDigest = rebuilt.contentDigest();

      rebuilt.close();
      rebuilt = undefined;
      inspectRecordDatabase(
        preparedPath,
        ORGANIZATION_RECORD_DERIVED_DATABASE,
        'rebuilt record derived',
        config,
        false,
      );
      assertNoSqliteSidecars(preparedPath, 'rebuilt record derived database');
      fsyncFile(preparedPath);
      assertRecordRebuildPaths(paths);
      renameSync(preparedPath, paths.record_derived_database_path);
      fsyncDirectory(paths.state_directory);
    } finally {
      if (logDatabase.inTransaction) {
        try {
          logDatabase.exec('ROLLBACK');
        } catch {}
      }
      logDatabase.close();
    }

    return Object.freeze({
      schema_version: 1,
      kind: 'echo-organization-authority-record-derived-rebuild',
      config_path: configPath,
      record_derived_database_path: paths.record_derived_database_path,
      head_position: headPosition,
      derived_content_sha256: contentDigest,
    });
  } finally {
    try {
      rebuilt?.close();
    } catch {}
    let removed = false;
    for (const suffix of ['-shm', '-wal', '-journal', '']) {
      const abandoned = `${preparedPath}${suffix}`;
      if (!existsSync(abandoned)) continue;
      try {
        unlinkSync(abandoned);
        removed = true;
      } catch {}
    }
    if (removed) fsyncDirectory(paths.state_directory);
  }
}

/**
 * The stopped-state derived-store rebuild.
 *
 * It takes the same authenticated singleton ownership `install-integrations`
 * takes, under its own maintenance purpose, so a running authority refuses the
 * rebuild instead of having the file it is serving replaced underneath it.
 */
export async function rebuildAuthorityDerivedRecordStore(
  configPath: string,
): Promise<AuthorityRecordDerivedRebuildResult> {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const config = readAuthorityRuntimeConfig(path);
  const releaseInitialization = await acquireAuthorityInitializationLock(
    path,
    config.state_dir,
  );
  try {
    const serveConfig = resolveAuthorityServeConfig(config);
    const runtimeLock = await acquireAuthorityRuntimeLock(
      config.state_dir,
      authorityMaintenanceFingerprint(serveConfig, 'rebuild-derived'),
    );
    try {
      return await rebuildAuthorityDerivedRecordStoreLocked(path, config);
    } finally {
      await runtimeLock.release();
    }
  } finally {
    await releaseInitialization();
  }
}
