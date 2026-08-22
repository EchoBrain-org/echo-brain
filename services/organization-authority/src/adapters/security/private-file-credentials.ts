import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const MINIMUM_CREDENTIAL_BYTES = 32;
const MAXIMUM_CREDENTIAL_BYTES = 4096;

function fail(message: string): never {
  throw new Error(`authority credential: ${message}`);
}

export function authorityCredentialPath(reference: string): string {
  if (!reference.startsWith('file:')) {
    fail('reference must use the file: scheme');
  }
  const path = reference.slice('file:'.length);
  if (
    path.length === 0 ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    fail('file reference must contain a normalized absolute path');
  }
  return path;
}

function assertPrivateCredentialFile(
  path: string,
  minimumBytes = MINIMUM_CREDENTIAL_BYTES,
): Stats {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size < minimumBytes ||
    state.size > MAXIMUM_CREDENTIAL_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    fail('file must be a bounded current-user 0600 regular file');
  }
  return state;
}

function readPrivateVisibleAsciiCredential(
  reference: string,
  minimumBytes: number,
): string {
  const path = authorityCredentialPath(reference);
  const state = assertPrivateCredentialFile(path, minimumBytes);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      fail('file changed while opening');
    }
    const value = readFileSync(file, 'utf8');
    if (
      value.length < minimumBytes ||
      value.length > MAXIMUM_CREDENTIAL_BYTES ||
      !/^[\x21-\x7e]+$/.test(value)
    ) {
      fail('value must contain only bounded visible ASCII bytes');
    }
    return value;
  } finally {
    closeSync(file);
  }
}

export function readPrivateAuthorityCredential(reference: string): string {
  return readPrivateVisibleAsciiCredential(
    reference,
    MINIMUM_CREDENTIAL_BYTES,
  );
}

export function readPrivateAuthorityGranolaOrganizationCredential(
  reference: string,
): string {
  const value = readPrivateVisibleAsciiCredential(
    reference,
    MINIMUM_CREDENTIAL_BYTES,
  );
  if (!/^grn_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('Granola organization credential has an invalid format');
  }
  return value;
}

export function readPrivateAuthorityGranolaOwnerEmail(
  reference: string,
): string {
  const value = readPrivateVisibleAsciiCredential(reference, 3);
  const [local, domain, extra] = value.split('@');
  if (
    value !== value.trim().toLowerCase() ||
    value.length > 254 ||
    /\s/u.test(value) ||
    local === undefined ||
    local.length === 0 ||
    domain === undefined ||
    domain.length === 0 ||
    extra !== undefined
  ) {
    fail('Granola owner email must be canonical lowercase email');
  }
  return value;
}

export function readPrivateAuthorityOrganizationCredentialScope(
  reference: string,
): 'organization' {
  const value = readPrivateVisibleAsciiCredential(reference, 1);
  if (value !== 'organization') {
    fail('provider credential scope must be organization');
  }
  return value;
}

/** Reads the exact 32-byte Person-session PKCE key from canonical base64url. */
export function readPrivateAuthorityPersonSessionPkceKey(
  reference: string,
): Uint8Array {
  const encoded = readPrivateVisibleAsciiCredential(reference, 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    fail('Person-session PKCE key must be canonical base64url');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
    fail('Person-session PKCE key must decode to exactly 32 bytes');
  }
  return Uint8Array.from(key);
}

/** Provider-owned client-secret lengths vary; visible ASCII and file privacy do not. */
export function readPrivateAuthorityOidcClientSecret(
  reference: string,
): string {
  return readPrivateVisibleAsciiCredential(reference, 1);
}

export function createPrivateAuthorityCredential(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    fail('creation path must be a normalized absolute path');
  }
  const value = randomBytes(32).toString('base64url');
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    writeFileSync(file, value, 'utf8');
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  return value;
}
