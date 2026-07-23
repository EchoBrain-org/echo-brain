import { assertFederationId } from '@echo-brain/federation-protocol';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS,
  MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS,
} from '../domain/rules.js';

export interface DevelopmentSignerConfig {
  authority_id: string;
  organization_id: string;
  key_directory: string;
}

export interface AuthorityServeConfig extends DevelopmentSignerConfig {
  state_directory: string;
  organization_display_name: string;
  authority_pin_sha256: `sha256:${string}`;
  database_path: string;
  admin_token: string;
  trusted_proxy_token: string;
  host: '127.0.0.1' | '::1';
  port: number;
  active_lease_ttl_ms: number;
  access_request_maximum_age_ms: number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

export function loadDevelopmentSignerConfig(
  environment: NodeJS.ProcessEnv,
): DevelopmentSignerConfig {
  if (
    environment.ECHO_ORGANIZATION_AUTHORITY_ALLOW_DEVELOPMENT_FILE_SIGNER !==
    'true'
  ) {
    throw new Error(
      'development file authority signer requires explicit ECHO_ORGANIZATION_AUTHORITY_ALLOW_DEVELOPMENT_FILE_SIGNER=true',
    );
  }
  const authorityId = required(environment, 'ECHO_ORGANIZATION_AUTHORITY_ID');
  const organizationId = required(environment, 'ECHO_ORGANIZATION_ID');
  assertFederationId(authorityId, 'oau', 'configured authority_id');
  assertFederationId(organizationId, 'org', 'configured organization_id');
  return {
    authority_id: authorityId,
    organization_id: organizationId,
    key_directory: required(
      environment,
      'ECHO_ORGANIZATION_AUTHORITY_DEVELOPMENT_KEY_DIRECTORY',
    ),
  };
}

export function loadAuthorityServeConfig(
  environment: NodeJS.ProcessEnv,
): AuthorityServeConfig {
  const signer = loadDevelopmentSignerConfig(environment);
  const pin = required(environment, 'ECHO_ORGANIZATION_AUTHORITY_PIN_SHA256');
  if (!/^sha256:[0-9a-f]{64}$/.test(pin)) {
    throw new Error(
      'ECHO_ORGANIZATION_AUTHORITY_PIN_SHA256 must be a canonical SHA-256 digest',
    );
  }
  const host = environment.ECHO_ORGANIZATION_AUTHORITY_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      'built-in authority HTTP must bind to loopback behind an authenticated TLS terminator',
    );
  }
  const databasePath = required(
    environment,
    'ECHO_ORGANIZATION_AUTHORITY_DATABASE_PATH',
  );
  assertPersistentAuthorityDatabasePath(databasePath);
  const stateDirectory =
    environment.ECHO_ORGANIZATION_AUTHORITY_STATE_DIRECTORY ??
    dirname(databasePath);
  const adminToken = required(
    environment,
    'ECHO_ORGANIZATION_AUTHORITY_ADMIN_TOKEN',
  );
  const trustedProxyToken = required(
    environment,
    'ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN',
  );
  assertIndependentAuthorityTokens(adminToken, trustedProxyToken);
  const config: AuthorityServeConfig = {
    ...signer,
    state_directory: stateDirectory,
    organization_display_name: required(
      environment,
      'ECHO_ORGANIZATION_DISPLAY_NAME',
    ),
    authority_pin_sha256: pin as `sha256:${string}`,
    database_path: databasePath,
    admin_token: adminToken,
    trusted_proxy_token: trustedProxyToken,
    host,
    port: integer(
      environment,
      'ECHO_ORGANIZATION_AUTHORITY_PORT',
      39479,
      1,
      65535,
    ),
    active_lease_ttl_ms: integer(
      environment,
      'ECHO_ORGANIZATION_AUTHORITY_ACTIVE_LEASE_TTL_MS',
      MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS,
      1,
      MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS,
    ),
    access_request_maximum_age_ms: integer(
      environment,
      'ECHO_ORGANIZATION_AUTHORITY_ACCESS_REQUEST_MAXIMUM_AGE_MS',
      MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS,
      1,
      MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS,
    ),
  };
  assertAuthorityServeStateBoundary(config);
  return config;
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
    'state_directory' | 'database_path' | 'key_directory'
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
}

export function assertPersistentAuthorityDatabasePath(
  databasePath: string,
): void {
  if (databasePath === ':memory:') {
    throw new Error(
      'ECHO_ORGANIZATION_AUTHORITY_DATABASE_PATH must use persistent storage when serving',
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
