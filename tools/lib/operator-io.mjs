// Mechanics shared by the AWS operator tools: the local AWS CLI boundary and
// owner-only receipt files. Callers keep their own limits, error codes and
// receipt shapes. authority-staging-invitation-export.mjs pins this file's
// bytes in its receipts (sourceHash).
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const AMBIENT_AWS_CREDENTIAL_KEYS = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
]);
const AMBIENT_AWS_TRANSPORT_KEYS = Object.freeze([
  'AWS_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);
const fail = code => { throw new Error(code); };

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Pin every local AWS CLI call to the approved SSO profile and discard process
 * state that could redirect a call, such as an encrypted archive upload, to
 * another endpoint or proxy. The Cloudflare dynamic reference is resolved
 * separately by asm-exec; it never enters this environment.
 */
export function sanitizedAwsEnvironment(sourceEnvironment = process.env) {
  const environment = { ...sourceEnvironment };
  for (const key of AMBIENT_AWS_CREDENTIAL_KEYS) delete environment[key];
  for (const key of AMBIENT_AWS_TRANSPORT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (key === 'AWS_ENDPOINT_URL' || key.startsWith('AWS_ENDPOINT_URL_'))
      delete environment[key];
  }
  environment.AWS_PROFILE = 'echo-prod';
  environment.AWS_DEFAULT_PROFILE = 'echo-prod';
  // Ignore an endpoint_url inherited through the normal AWS config file too.
  environment.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
  return environment;
}

/** Add non-ambient safety controls to every local AWS CLI process. */
export function awsCliArguments(args) {
  return ['--no-cli-pager', '--profile', 'echo-prod', ...args];
}

/** The sanitized environment with AWS CLI retries off: one attempt per call. */
export function singleAttemptAwsEnvironment() {
  return { ...sanitizedAwsEnvironment(), AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' };
}

/** One bounded AWS CLI attempt returning stdout text; callers own parsing and error codes. */
export function runAwsCliOnce(args, { timeout, maxBuffer }) {
  return execFileSync('aws', awsCliArguments(args), {
    env: singleAttemptAwsEnvironment(),
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer,
  });
}

/** An owner-only (0700) real directory whose resolved path is outside this checkout. */
export function privateDirectory(path, insideCheckoutCode = 'receipt_inside_checkout') {
  const absolute = resolve(path);
  const state = lstatSync(absolute);
  if (state.isSymbolicLink() || !state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) fail('private_directory_required');
  // Resolve ancestors as well; receipts must not live inside a checkout.
  const real = realpathSync(absolute);
  if (real === REPO || real.startsWith(`${REPO}/`)) fail(insideCheckoutCode);
  return absolute;
}

/** The bytes of an owner-only (0600), single-link regular file within the size bounds. */
export function privateFile(path, maximum, minimum = 0) {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1 || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o600 || state.size < minimum || state.size > maximum) fail('private_file_required');
  return readFileSync(path);
}

/** Create (fresh) or atomically replace an owner-only file, then fsync it and its directory. */
export function writePrivateFile(path, bytes, fresh) {
  const destination = fresh ? path : `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(destination, 'wx', 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  if (!fresh) renameSync(destination, path);
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Run one synchronous receipt operation while holding its sibling lock directory. */
export function withReceiptLock(path, action) {
  privateDirectory(dirname(path));
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch { fail('receipt_locked'); }
  try { return action(); } finally { rmdirSync(lock); }
}
