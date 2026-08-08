import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { DEVELOPMENT_AUTHORITY_KEY_FILENAME } from '../security/development-file-authority-signer.js';

const MAXIMUM_FINGERPRINTED_KEY_BYTES = 8 * 1024;
const MAXIMUM_FINGERPRINTED_INSTALLATION_MARKER_BYTES = 64 * 1024;
const INTEGRATIONS_INSTALLATION_MARKER_FILENAME =
  'authority-integrations-installation.v1.json';

export interface AuthorityRuntimeFingerprintInput {
  state_directory: string;
  authority_id: string;
  organization_id: string;
  key_directory: string;
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
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fileIdentity(
  path: string,
  label: string,
): {
  path: string;
  device: string;
  inode: string;
} {
  const state = lstatSync(path, { bigint: true });
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(path) !== path
  ) {
    throw new Error(`${label} must be a canonical regular file`);
  }
  return {
    path,
    device: state.dev.toString(),
    inode: state.ino.toString(),
  };
}

function contentFileIdentity(
  path: string,
  label: string,
  maximumBytes: number,
  requirePrivateOwner = false,
): {
  path: string;
  device: string;
  inode: string;
  content_sha256: `sha256:${string}`;
} {
  const state = lstatSync(path, { bigint: true });
  const currentUid = process.getuid?.();
  const privateFileInvalid =
    requirePrivateOwner &&
    ((currentUid !== undefined && state.uid !== BigInt(currentUid)) ||
      (state.mode & 0o777n) !== 0o600n);
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0n ||
    state.size > BigInt(maximumBytes) ||
    realpathSync(path) !== path ||
    privateFileInvalid
  ) {
    throw new Error(
      `${label} must be a bounded ${
        requirePrivateOwner ? 'current-user 0600 canonical file' : 'canonical regular file'
      }`,
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file, { bigint: true });
    if (
      opened.dev !== state.dev ||
      opened.ino !== state.ino ||
      !opened.isFile() ||
      opened.size <= 0n ||
      opened.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const completed = fstatSync(file, { bigint: true });
    if (
      length === 0 ||
      length > maximumBytes ||
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== BigInt(length) ||
      completed.mtimeNs !== opened.mtimeNs ||
      completed.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return {
      path,
      device: completed.dev.toString(),
      inode: completed.ino.toString(),
      content_sha256: sha256(bytes.subarray(0, length)),
    };
  } finally {
    closeSync(file);
  }
}

/**
 * Secret values are represented only by digests. File identity binds status
 * to the exact database/key inodes the runtime was composed against.
 */
export function authorityRuntimeFingerprint(
  config: AuthorityRuntimeFingerprintInput,
): `sha256:${string}` {
  const keyPath = join(
    config.key_directory,
    DEVELOPMENT_AUTHORITY_KEY_FILENAME,
  );
  return sha256(
    canonicalJson({
      schema_version: 1,
      kind: 'echo-organization-authority-runtime-fingerprint-material',
      state_directory: config.state_directory,
      authority_id: config.authority_id,
      organization_id: config.organization_id,
      organization_display_name: config.organization_display_name,
      authority_pin_sha256: config.authority_pin_sha256,
      database_file: fileIdentity(
        config.database_path,
        'authority runtime database',
      ),
      integrations_database_file: fileIdentity(
        config.integrations_database_path,
        'authority integrations runtime database',
      ),
      record_log_database_file: fileIdentity(
        config.record_log_database_path,
        'authority record log runtime database',
      ),
      record_derived_database_file: fileIdentity(
        config.record_derived_database_path,
        'authority record derived runtime database',
      ),
      integrations_installation_marker_file:
        contentFileIdentity(
          join(
            config.state_directory,
            INTEGRATIONS_INSTALLATION_MARKER_FILENAME,
          ),
          'authority integrations installation marker',
          MAXIMUM_FINGERPRINTED_INSTALLATION_MARKER_BYTES,
          true,
        ),
      signing_key_file: contentFileIdentity(
        keyPath,
        'authority runtime signing key',
        MAXIMUM_FINGERPRINTED_KEY_BYTES,
      ),
      listener: { host: config.host, port: config.port },
      access: {
        active_lease_ttl_ms: config.active_lease_ttl_ms,
        request_maximum_age_ms: config.access_request_maximum_age_ms,
      },
      credentials: {
        admin_token_sha256: sha256(config.admin_token),
        trusted_proxy_token_sha256: sha256(config.trusted_proxy_token),
      },
    }),
  );
}

export function authorityMaintenanceFingerprint(
  config: AuthorityRuntimeFingerprintInput,
  purpose: 'install-integrations',
): `sha256:${string}` {
  const keyPath = join(
    config.key_directory,
    DEVELOPMENT_AUTHORITY_KEY_FILENAME,
  );
  return sha256(
    canonicalJson({
      schema_version: 1,
      kind: 'echo-organization-authority-maintenance-fingerprint-material',
      purpose,
      state_directory: config.state_directory,
      authority_id: config.authority_id,
      organization_id: config.organization_id,
      authority_pin_sha256: config.authority_pin_sha256,
      database_file: fileIdentity(
        config.database_path,
        'authority maintenance database',
      ),
      signing_key_file: contentFileIdentity(
        keyPath,
        'authority runtime signing key',
        MAXIMUM_FINGERPRINTED_KEY_BYTES,
      ),
    }),
  );
}
