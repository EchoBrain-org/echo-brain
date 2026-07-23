import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { assertFederationId } from '@echo-brain/federation-protocol';
import {
  authorityCredentialPath,
  readPrivateAuthorityCredential,
} from '../adapters/security/private-file-credentials.js';
import {
  assertConfiguredLeaseTtl,
  assertConfiguredRequestAge,
  assertDisplayName,
  MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS,
  MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS,
} from '../domain/rules.js';
import type { AuthorityServeConfig } from './config.js';

export const AUTHORITY_IDENTITY_FILENAME = 'authority-identity.v1.json';
export const AUTHORITY_INITIALIZATION_MANIFEST_FILENAME =
  'authority-initialization.v1.json';
export const AUTHORITY_DATABASE_FILENAME = 'authority.sqlite';
export const AUTHORITY_ADMIN_CREDENTIAL_FILENAME = 'admin-token';
export const AUTHORITY_PROXY_CREDENTIAL_FILENAME = 'trusted-proxy-token';

const MAX_CONFIG_BYTES = 64 * 1024;

export interface AuthorityRuntimeConfigV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-runtime-config';
  state_dir: string;
  organization: {
    organization_id: string;
    display_name: string;
  };
  authority: {
    authority_id: string;
    authority_pin_sha256: `sha256:${string}`;
  };
  signer: {
    adapter_id: 'development-file';
    key_directory: string;
  };
  database_path: string;
  listener: {
    host: '127.0.0.1' | '::1';
    port: number;
  };
  credentials: {
    admin_token_ref: string;
    trusted_proxy_token_ref: string;
  };
  access: {
    active_lease_ttl_ms: number;
    request_maximum_age_ms: number;
  };
}

export interface AuthorityStatePaths {
  state_directory: string;
  key_directory: string;
  credential_directory: string;
  admin_credential_path: string;
  proxy_credential_path: string;
  database_path: string;
  identity_path: string;
  initialization_manifest_path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function normalizedAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === resolve('/')
  ) {
    throw new Error(`${label} must be a normalized absolute path below root`);
  }
  return value;
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

export function assertAuthorityConfigStateSeparation(
  configPath: string,
  stateDirectory: string,
): void {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const state = normalizedAbsolutePath(
    stateDirectory,
    'authority state directory',
  );
  if (path === state || pathIsWithin(path, state)) {
    throw new Error('authority config must live outside mutable state');
  }
}

export function authorityStatePaths(
  stateDirectory: string,
): AuthorityStatePaths {
  const state = normalizedAbsolutePath(
    stateDirectory,
    'authority state directory',
  );
  const credentialDirectory = join(state, 'credentials');
  return Object.freeze({
    state_directory: state,
    key_directory: join(state, 'keys'),
    credential_directory: credentialDirectory,
    admin_credential_path: join(
      credentialDirectory,
      AUTHORITY_ADMIN_CREDENTIAL_FILENAME,
    ),
    proxy_credential_path: join(
      credentialDirectory,
      AUTHORITY_PROXY_CREDENTIAL_FILENAME,
    ),
    database_path: join(state, AUTHORITY_DATABASE_FILENAME),
    identity_path: join(state, AUTHORITY_IDENTITY_FILENAME),
    initialization_manifest_path: join(
      state,
      AUTHORITY_INITIALIZATION_MANIFEST_FILENAME,
    ),
  });
}

export function createAuthorityRuntimeConfig(input: {
  state_directory: string;
  organization_id: string;
  organization_display_name: string;
  authority_id: string;
  authority_pin_sha256: `sha256:${string}`;
  host?: '127.0.0.1' | '::1';
  port?: number;
}): AuthorityRuntimeConfigV1 {
  const paths = authorityStatePaths(input.state_directory);
  return validateAuthorityRuntimeConfig({
    schema_version: 1,
    kind: 'echo-organization-authority-runtime-config',
    state_dir: paths.state_directory,
    organization: {
      organization_id: input.organization_id,
      display_name: input.organization_display_name,
    },
    authority: {
      authority_id: input.authority_id,
      authority_pin_sha256: input.authority_pin_sha256,
    },
    signer: {
      adapter_id: 'development-file',
      key_directory: paths.key_directory,
    },
    database_path: paths.database_path,
    listener: {
      host: input.host ?? '127.0.0.1',
      port: input.port ?? 39479,
    },
    credentials: {
      admin_token_ref: `file:${paths.admin_credential_path}`,
      trusted_proxy_token_ref: `file:${paths.proxy_credential_path}`,
    },
    access: {
      active_lease_ttl_ms: MAX_AUTHORITY_ACTIVE_LEASE_TTL_MS,
      request_maximum_age_ms: MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS,
    },
  });
}

export function validateAuthorityRuntimeConfig(
  value: unknown,
): AuthorityRuntimeConfigV1 {
  const root = record(value, 'authority runtime config');
  exactKeys(
    root,
    [
      'schema_version',
      'kind',
      'state_dir',
      'organization',
      'authority',
      'signer',
      'database_path',
      'listener',
      'credentials',
      'access',
    ],
    'authority runtime config',
  );
  if (
    root.schema_version !== 1 ||
    root.kind !== 'echo-organization-authority-runtime-config'
  ) {
    throw new Error('authority runtime config identity is unsupported');
  }
  const stateDirectory = normalizedAbsolutePath(
    root.state_dir,
    'authority state_dir',
  );
  const paths = authorityStatePaths(stateDirectory);

  const organization = record(root.organization, 'config organization');
  exactKeys(
    organization,
    ['organization_id', 'display_name'],
    'config organization',
  );
  if (
    typeof organization.organization_id !== 'string' ||
    typeof organization.display_name !== 'string'
  ) {
    throw new Error('config organization fields must be strings');
  }
  assertFederationId(
    organization.organization_id,
    'org',
    'configured organization_id',
  );
  assertDisplayName(organization.display_name);

  const authority = record(root.authority, 'config authority');
  exactKeys(
    authority,
    ['authority_id', 'authority_pin_sha256'],
    'config authority',
  );
  if (typeof authority.authority_id !== 'string') {
    throw new Error('configured authority_id must be a string');
  }
  assertFederationId(authority.authority_id, 'oau', 'configured authority_id');
  if (
    typeof authority.authority_pin_sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(authority.authority_pin_sha256)
  ) {
    throw new Error('configured authority pin must be a canonical SHA-256');
  }

  const signer = record(root.signer, 'config signer');
  exactKeys(signer, ['adapter_id', 'key_directory'], 'config signer');
  if (
    signer.adapter_id !== 'development-file' ||
    normalizedAbsolutePath(signer.key_directory, 'signer key_directory') !==
      paths.key_directory
  ) {
    throw new Error(
      'Phase 1 signer must use the initialized development-file key directory',
    );
  }
  if (
    normalizedAbsolutePath(root.database_path, 'authority database_path') !==
    paths.database_path
  ) {
    throw new Error('authority database_path must use the initialized layout');
  }

  const listener = record(root.listener, 'config listener');
  exactKeys(listener, ['host', 'port'], 'config listener');
  if (listener.host !== '127.0.0.1' && listener.host !== '::1') {
    throw new Error('authority listener must bind to loopback');
  }
  if (
    !Number.isSafeInteger(listener.port) ||
    (listener.port as number) < 1 ||
    (listener.port as number) > 65_535
  ) {
    throw new Error(
      'authority listener port must be an integer from 1 to 65535',
    );
  }

  const credentials = record(root.credentials, 'config credentials');
  exactKeys(
    credentials,
    ['admin_token_ref', 'trusted_proxy_token_ref'],
    'config credentials',
  );
  if (
    typeof credentials.admin_token_ref !== 'string' ||
    typeof credentials.trusted_proxy_token_ref !== 'string' ||
    authorityCredentialPath(credentials.admin_token_ref) !==
      paths.admin_credential_path ||
    authorityCredentialPath(credentials.trusted_proxy_token_ref) !==
      paths.proxy_credential_path
  ) {
    throw new Error(
      'authority credential refs must use the initialized private files',
    );
  }

  const access = record(root.access, 'config access');
  exactKeys(
    access,
    ['active_lease_ttl_ms', 'request_maximum_age_ms'],
    'config access',
  );
  assertConfiguredLeaseTtl(access.active_lease_ttl_ms as number);
  assertConfiguredRequestAge(access.request_maximum_age_ms as number);

  return {
    schema_version: 1,
    kind: 'echo-organization-authority-runtime-config',
    state_dir: stateDirectory,
    organization: {
      organization_id: organization.organization_id,
      display_name: organization.display_name,
    },
    authority: {
      authority_id: authority.authority_id,
      authority_pin_sha256:
        authority.authority_pin_sha256 as `sha256:${string}`,
    },
    signer: {
      adapter_id: 'development-file',
      key_directory: paths.key_directory,
    },
    database_path: paths.database_path,
    listener: {
      host: listener.host,
      port: listener.port as number,
    },
    credentials: {
      admin_token_ref: credentials.admin_token_ref,
      trusted_proxy_token_ref: credentials.trusted_proxy_token_ref,
    },
    access: {
      active_lease_ttl_ms: access.active_lease_ttl_ms as number,
      request_maximum_age_ms: access.request_maximum_age_ms as number,
    },
  };
}

function assertPrivateConfigFile(path: string): Stats {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > MAX_CONFIG_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error(
      'authority config must be a bounded current-user 0600 canonical file',
    );
  }
  return state;
}

export function readAuthorityRuntimeConfig(
  configPath: string,
): AuthorityRuntimeConfigV1 {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const state = assertPrivateConfigFile(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error('authority config changed while opening');
    }
    const config = validateAuthorityRuntimeConfig(
      JSON.parse(readFileSync(file, 'utf8')) as unknown,
    );
    assertAuthorityConfigStateSeparation(path, config.state_dir);
    return config;
  } finally {
    closeSync(file);
  }
}

export function writeAuthorityRuntimeConfigExclusive(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): void {
  const path = normalizedAbsolutePath(configPath, 'authority config path');
  const validated = validateAuthorityRuntimeConfig(config);
  assertAuthorityConfigStateSeparation(path, validated.state_dir);
  const parent = dirname(path);
  const parentState = lstatSync(parent);
  const currentUid = process.getuid?.();
  if (
    parentState.isSymbolicLink() ||
    !parentState.isDirectory() ||
    realpathSync(parent) !== parent ||
    (currentUid !== undefined && parentState.uid !== currentUid) ||
    (parentState.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      'authority config parent must be a current-user 0700 canonical directory',
    );
  }
  const preparedPath = join(
    parent,
    `.${basename(path)}.publishing-${randomBytes(16).toString('hex')}`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(
    preparedPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    writeFileSync(file, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    try {
      unlinkSync(preparedPath);
    } catch {}
    throw error;
  }
  closeSync(file);
  try {
    linkSync(preparedPath, path);
    const directory = openSync(parent, fsConstants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(preparedPath);
    } catch {}
  }
}

export function resolveAuthorityServeConfig(
  config: AuthorityRuntimeConfigV1,
): AuthorityServeConfig {
  const adminToken = readPrivateAuthorityCredential(
    config.credentials.admin_token_ref,
  );
  const trustedProxyToken = readPrivateAuthorityCredential(
    config.credentials.trusted_proxy_token_ref,
  );
  return {
    state_directory: config.state_dir,
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
    key_directory: config.signer.key_directory,
    organization_display_name: config.organization.display_name,
    authority_pin_sha256: config.authority.authority_pin_sha256,
    database_path: config.database_path,
    admin_token: adminToken,
    trusted_proxy_token: trustedProxyToken,
    host: config.listener.host,
    port: config.listener.port,
    active_lease_ttl_ms: config.access.active_lease_ttl_ms,
    access_request_maximum_age_ms: config.access.request_maximum_age_ms,
  };
}
