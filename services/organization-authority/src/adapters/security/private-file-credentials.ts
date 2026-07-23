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

function assertPrivateCredentialFile(path: string): Stats {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size < MINIMUM_CREDENTIAL_BYTES ||
    state.size > MAXIMUM_CREDENTIAL_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    fail('file must be a bounded current-user 0600 regular file');
  }
  return state;
}

export function readPrivateAuthorityCredential(reference: string): string {
  const path = authorityCredentialPath(reference);
  const state = assertPrivateCredentialFile(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      fail('file changed while opening');
    }
    const value = readFileSync(file, 'utf8');
    if (!/^[\x21-\x7e]{32,4096}$/.test(value)) {
      fail('value must be 32-4096 visible ASCII bytes');
    }
    return value;
  } finally {
    closeSync(file);
  }
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
