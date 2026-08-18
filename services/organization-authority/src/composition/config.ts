import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OrganizationRecordingPolicyV1 } from '../application/organization-recording-policy.js';
import type { ResolvedAuthorityPersonSessionRuntimeV1 } from './person-session-runtime-config.js';
export type { OrganizationRecordingPolicyV1 } from '../application/organization-recording-policy.js';

export interface DevelopmentSignerConfig {
  authority_id: string;
  organization_id: string;
  key_directory: string;
}

export interface OrganizationMemberRecordingActivationBindingV1 {
  schema_version: 1;
  kind: 'organization-member-recording-activation-binding-v1';
  command_sha256: `sha256:${string}`;
  activation_sha256: `sha256:${string}`;
  initialized_runtime_config_sha256: `sha256:${string}`;
  initialization_manifest_sha256: `sha256:${string}`;
  activated_at: string;
  audit_sequence: number;
}

export interface AuthorityServeConfig extends DevelopmentSignerConfig {
  state_directory: string;
  organization_display_name: string;
  authority_pin_sha256: `sha256:${string}`;
  database_path: string;
  integrations_database_path: string;
  record_log_database_path: string;
  record_derived_database_path: string;
  admin_token: string;
  trusted_proxy_token: string;
  host: '127.0.0.1' | '::1';
  port: number;
  active_lease_ttl_ms: number;
  access_request_maximum_age_ms: number;
  /**
   * Optional while the Job B admission family is not configured. Its absence
   * deliberately leaves the existing runtime and fingerprint unchanged.
   */
  organization_recording_policy_v1?: OrganizationRecordingPolicyV1;
  /** Verified additive overlay; absent when the immutable config owns policy. */
  organization_member_recording_activation_v1?:
    OrganizationMemberRecordingActivationBindingV1;
  /** Optional fixed-path overlay; absence leaves every Person route disabled. */
  person_session_runtime_v1?: ResolvedAuthorityPersonSessionRuntimeV1;
}

function normalizedAbsolute(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes('\0') &&
    isAbsolute(path) &&
    resolve(path) === path
  );
}

function pathIsWithin(path: string, parent: string): boolean {
  const difference = relative(parent, path);
  return (
    difference !== '' &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

export function assertAuthorityServeStateBoundary(
  config: Pick<
    AuthorityServeConfig,
    | 'state_directory'
    | 'database_path'
    | 'integrations_database_path'
    | 'record_log_database_path'
    | 'record_derived_database_path'
    | 'key_directory'
  >,
): void {
  if (
    !normalizedAbsolute(config.state_directory) ||
    config.state_directory === resolve('/')
  ) {
    throw new Error(
      'authority state directory must be a normalized absolute path',
    );
  }
  if (
    !normalizedAbsolute(config.database_path) ||
    !pathIsWithin(config.database_path, config.state_directory) ||
    config.database_path !== join(config.state_directory, 'authority.sqlite')
  ) {
    throw new Error(
      'authority database must use the canonical state-directory path',
    );
  }
  if (
    !normalizedAbsolute(config.key_directory) ||
    !pathIsWithin(config.key_directory, config.state_directory) ||
    config.key_directory !== join(config.state_directory, 'keys')
  ) {
    throw new Error(
      'authority key directory must use the canonical state-directory path',
    );
  }
  if (
    !normalizedAbsolute(config.integrations_database_path) ||
    !pathIsWithin(
      config.integrations_database_path,
      config.state_directory,
    ) ||
    config.integrations_database_path !==
      join(config.state_directory, 'integrations.sqlite')
  ) {
    throw new Error(
      'authority integrations database must use the canonical state-directory path',
    );
  }
  // The record log and the derived graph are separate files by charter, so the
  // boundary check refuses a configuration that would let them collide with
  // each other or with `authority.sqlite`.
  for (const [path, filename, label] of [
    [config.record_log_database_path, 'record-log.sqlite', 'record log'],
    [
      config.record_derived_database_path,
      'record-derived.sqlite',
      'record derived',
    ],
  ] as const) {
    if (
      !normalizedAbsolute(path) ||
      !pathIsWithin(path, config.state_directory) ||
      path !== join(config.state_directory, filename)
    ) {
      throw new Error(
        `authority ${label} database must use the canonical state-directory path`,
      );
    }
  }
}

export function assertPersistentAuthorityDatabasePath(
  databasePath: string,
): void {
  if (databasePath === ':memory:') {
    throw new Error(
      'authority config database_path must use persistent storage when serving',
    );
  }
}

export function assertIndependentAuthorityTokens(
  adminToken: string,
  trustedProxyToken: string,
): void {
  if (adminToken === trustedProxyToken) {
    throw new Error(
      'administrator and trusted proxy tokens must be distinct credentials',
    );
  }
}
