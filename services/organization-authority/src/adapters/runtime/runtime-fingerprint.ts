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

export interface AuthorityRuntimeFingerprintInput {
  state_directory: string;
  authority_id: string;
  organization_id: string;
  key_directory: string;
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

function signingKeyIdentity(path: string): {
  path: string;
  device: string;
  inode: string;
  content_sha256: `sha256:${string}`;
} {
  const state = lstatSync(path, { bigint: true });
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0n ||
    state.size > BigInt(MAXIMUM_FINGERPRINTED_KEY_BYTES) ||
    realpathSync(path) !== path
  ) {
    throw new Error(
      'authority runtime signing key must be a bounded canonical regular file',
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
      opened.size > BigInt(MAXIMUM_FINGERPRINTED_KEY_BYTES)
    ) {
      throw new Error('authority runtime signing key changed while opening');
    }
    const bytes = Buffer.alloc(MAXIMUM_FINGERPRINTED_KEY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const completed = fstatSync(file, { bigint: true });
    if (
      length === 0 ||
      length > MAXIMUM_FINGERPRINTED_KEY_BYTES ||
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== BigInt(length) ||
      completed.mtimeNs !== opened.mtimeNs ||
      completed.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error('authority runtime signing key changed while reading');
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
      signing_key_file: signingKeyIdentity(keyPath),
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
