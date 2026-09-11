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
  const value = readPrivateCredentialFile(reference, minimumBytes);
  if (!/^[\x21-\x7e]+$/.test(value)) {
    fail('value must contain only bounded visible ASCII bytes');
  }
  return value;
}

function readPrivateCredentialFile(
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
      value.length > MAXIMUM_CREDENTIAL_BYTES
    ) {
      fail('file must contain a bounded credential value');
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

/**
 * Slack signing secrets are provider credentials, not configuration values.
 * Keep their filesystem validation identical to other Authority secrets while
 * accepting Slack's visible-ASCII secret representation without logging it.
 */
export function readPrivateAuthoritySlackSigningSecret(
  reference: string,
): string {
  return readPrivateVisibleAsciiCredential(
    reference,
    MINIMUM_CREDENTIAL_BYTES,
  );
}

export interface SlackBrowserOauthConfigurationV1 {
  readonly client_id: string;
  readonly client_secret: string;
}

/** Keeps the optional Slack browser OAuth secret in process memory only. */
export function readPrivateAuthoritySlackBrowserOauthConfiguration(
  reference: string,
): SlackBrowserOauthConfigurationV1 {
  const value = readPrivateCredentialFile(reference, 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail('Slack browser OAuth configuration must be valid JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'client_id,client_secret'
  ) {
    fail('Slack browser OAuth configuration has an unexpected shape');
  }
  const record = parsed as Record<string, unknown>;
  const clientId = record.client_id;
  const clientSecret = record.client_secret;
  if (
    typeof clientId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(clientId) ||
    typeof clientSecret !== 'string' ||
    clientSecret.length === 0 ||
    clientSecret.length > MAXIMUM_CREDENTIAL_BYTES ||
    !/^[\x21-\x7e]+$/.test(clientSecret)
  ) {
    fail('Slack browser OAuth configuration is invalid');
  }
  return Object.freeze({ client_id: clientId, client_secret: clientSecret });
}

/** Missing configuration deliberately retains the existing Slack DM flow. */
export function readOptionalPrivateAuthoritySlackBrowserOauthConfiguration(
  reference: string,
): SlackBrowserOauthConfigurationV1 | undefined {
  const path = authorityCredentialPath(reference);
  try {
    lstatSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return readPrivateAuthoritySlackBrowserOauthConfiguration(reference);
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
