import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalJson, federationId } from '@echo-brain/federation-protocol';
import {
  organizationAuthorityPinSha256,
  validateOrganizationAuthorityDescriptor,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import {
  inspectAuthorityDatabaseForServe,
  inspectAuthorityDatabaseReadOnly,
} from '../adapters/persistence/sqlite/read-only-inspection.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import { acquireAuthorityInitializationLock } from '../adapters/runtime/singleton-runtime-lock.js';
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
  type AuthorityRuntimeConfigV1,
  validateAuthorityRuntimeConfig,
  writeAuthorityRuntimeConfigExclusive,
} from './operator-config.js';

const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_INITIALIZATION_MANIFEST_BYTES = 128 * 1024;

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

export interface InspectedAuthorityState {
  config: AuthorityRuntimeConfigV1;
  identity: AuthorityIdentityRecordV1;
}

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
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > MAX_INITIALIZATION_MANIFEST_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error(
      'authority initialization manifest must be a bounded current-user 0600 canonical file',
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error(
        'authority initialization manifest changed while opening',
      );
    }
    const contents = readFileSync(file, 'utf8');
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
  } finally {
    closeSync(file);
  }
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
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > MAX_IDENTITY_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'authority identity must be a bounded current-user 0600 regular file',
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error('authority identity changed while opening');
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
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
  } finally {
    closeSync(file);
  }
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
  const inspected = await inspectInitializedAuthorityFiles(configPath, config);
  const database = inspectAuthorityDatabaseReadOnly(config.database_path);
  if (
    database.authority_id !== config.authority.authority_id ||
    database.organization_id !== config.organization.organization_id ||
    database.organization_display_name !== config.organization.display_name ||
    database.authority_pin_sha256 !== config.authority.authority_pin_sha256 ||
    canonicalJson(database.authority_descriptor) !==
      canonicalJson(inspected.identity.authority_descriptor)
  ) {
    throw new Error('authority database identity differs from config');
  }
  return inspected;
}

export async function inspectAuthorityServePreflight(
  configPath: string,
  config: AuthorityRuntimeConfigV1,
): Promise<InspectedAuthorityState> {
  const inspected = await inspectInitializedAuthorityFiles(configPath, config);
  const database = inspectAuthorityDatabaseForServe(config.database_path);
  if (
    database.authority_id !== config.authority.authority_id ||
    database.organization_id !== config.organization.organization_id ||
    database.organization_display_name !== config.organization.display_name ||
    database.authority_pin_sha256 !== config.authority.authority_pin_sha256 ||
    canonicalJson(database.authority_descriptor) !==
      canonicalJson(inspected.identity.authority_descriptor)
  ) {
    throw new Error('authority database identity differs from config');
  }
  return inspected;
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
