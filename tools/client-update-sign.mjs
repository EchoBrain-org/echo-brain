#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson } from './clean-v1-release.mjs';
import { validatePreparedClientUpdateFeed } from './client-update-feed.mjs';
import { UPDATE_ARTIFACT_LIMIT, UPDATE_METADATA_LIMIT, updateDigest } from '../src/product/person-client/dist/client-update-contract.js';

const PRIVATE_KEY = 'private-key.pkcs8.der';
const METADATA = 'signer.json';

function fail(code) { throw new Error(code); }
function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path)) fail('absolute_canonical_path_required');
  return path;
}
function directory(path, privateDirectory = false) {
  absolute(path);
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const state = lstatSync(current);
    if (state.isSymbolicLink() || !state.isDirectory()) fail('real_directory_required');
  }
  const state = lstatSync(path);
  if (privateDirectory && (state.uid !== process.getuid() || (state.mode & 0o7777) !== 0o700)) fail('private_directory_required');
  return state;
}
function outsideCheckout(path) {
  let current = path;
  while (true) {
    if (existsSync(join(current, '.git'))) fail('signer_outside_checkout_required');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function readPrivate(path, limit = UPDATE_METADATA_LIMIT) {
  absolute(path);
  directory(dirname(path), true);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() ||
        (before.mode & 0o7777) !== 0o600 || before.size <= 0 || before.size > limit) fail('private_file_required');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const named = lstatSync(path);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) fail('input_changed');
    return bytes;
  } finally { closeSync(descriptor); }
}
function writePrivate(path, bytes) {
  absolute(path);
  directory(dirname(path), true);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid() || (state.mode & 0o7777) !== 0o600) fail('private_file_required');
  } finally { closeSync(descriptor); }
}
function signerMetadata(publicKey) {
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' });
  return { schema_version: 1, kind: 'echo-client-update-signer-v1',
    public_key_spki: publicBytes.toString('base64'), public_key_sha256: updateDigest(publicBytes) };
}

export function initializeClientUpdateSigner({ directory: signerDirectory }) {
  absolute(signerDirectory);
  directory(dirname(signerDirectory), true);
  outsideCheckout(dirname(signerDirectory));
  // mkdir is deliberately exclusive: a failed or partial initialization is
  // retained for inspection and never replaces an existing signing identity.
  mkdirSync(signerDirectory, { mode: 0o700 });
  directory(signerDirectory, true);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateBytes = privateKey.export({ format: 'der', type: 'pkcs8' });
  try { writePrivate(join(signerDirectory, PRIVATE_KEY), privateBytes); }
  finally { privateBytes.fill(0); }
  const metadata = signerMetadata(publicKey);
  writePrivate(join(signerDirectory, METADATA), Buffer.from(`${canonicalJson(metadata)}\n`));
  return { status: 'initialized', ...metadata };
}

export function signClientUpdateFeed({ directory: signerDirectory, prepared, authorizationPath, signaturePath, approveManifest, now = Date.now() }) {
  directory(signerDirectory, true);
  outsideCheckout(signerDirectory);
  directory(prepared, true);
  absolute(signaturePath);
  directory(dirname(signaturePath), true);
  if (existsSync(signaturePath)) fail('signature_already_exists');
  const metadataBytes = readPrivate(join(signerDirectory, METADATA));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  // Validate ownership and modes before passing non-secret inputs to the shared
  // release validator. The validator binds authorization, release and kit bytes.
  const payload = readPrivate(join(prepared, 'manifest.json'));
  const configBytes = readPrivate(join(prepared, 'bootstrap-config.json'));
  const releaseBytes = readPrivate(join(prepared, 'release.json'));
  const authorization = readPrivate(authorizationPath);
  const parsed = JSON.parse(payload.toString('utf8'));
  if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length > 12) fail('invalid_manifest');
  for (const artifact of parsed.artifacts) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) fail('invalid_artifact');
    readPrivate(join(prepared, 'artifacts', `${artifact.sha256}.zip`), UPDATE_ARTIFACT_LIMIT);
  }
  const validated = validatePreparedClientUpdateFeed({ prepared, authorizationPath, now });
  if (!validated.payload.equals(payload) || !readPrivate(join(prepared, 'bootstrap-config.json')).equals(configBytes) ||
      !readPrivate(join(prepared, 'release.json')).equals(releaseBytes) || !readPrivate(authorizationPath).equals(authorization)) fail('input_changed');
  const manifestDigest = updateDigest(payload);
  const keyBytes = readPrivate(join(signerDirectory, PRIVATE_KEY), 4096);
  let key;
  try { key = createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' }); }
  finally { keyBytes.fill(0); }
  if (key.asymmetricKeyType !== 'ed25519') fail('invalid_signer');
  const actualMetadata = signerMetadata(createPublicKey(key));
  if (canonicalJson(actualMetadata) !== canonicalJson(metadata) || validated.config.public_key_spki !== actualMetadata.public_key_spki) fail('signer_pin_mismatch');
  const summary = { manifest_sha256: manifestDigest, release_id: validated.manifest.release_id, public_key_sha256: actualMetadata.public_key_sha256 };
  if (approveManifest === undefined) return { status: 'ready_to_sign', ...summary };
  if (!/^[a-f0-9]{64}$/.test(approveManifest) || approveManifest !== manifestDigest) fail('exact_manifest_approval_required');
  // Sign the original file bytes, including their terminal newline, never a
  // parsed/reserialized equivalent. Private key material stays in this process.
  const signature = sign(null, payload, key);
  if (signature.length !== 64 || !readPrivate(join(prepared, 'manifest.json')).equals(payload) ||
      !readPrivate(join(signerDirectory, METADATA)).equals(metadataBytes)) fail('input_changed');
  writePrivate(signaturePath, signature);
  return { status: 'signed', ...summary, signature_sha256: updateDigest(signature) };
}

function main(argv) {
  const action = argv[0];
  const fields = action === 'init' ? ['directory'] : action === 'sign' ? ['directory', 'prepared', 'authorization', 'signature', 'approve-manifest'] : [];
  if (!fields.length) fail('usage: client-update-sign.mjs init --directory NEW_ABSOLUTE_DIRECTORY | sign --directory ABSOLUTE_DIRECTORY --prepared ABSOLUTE_DIRECTORY --authorization ABSOLUTE_FILE --signature NEW_ABSOLUTE_FILE [--approve-manifest SHA256]');
  const { values } = parseArgs({ args: argv.slice(1), options: Object.fromEntries(fields.map(field => [field, { type: 'string' }])), strict: true, allowPositionals: false });
  if (fields.filter(field => field !== 'approve-manifest').some(field => !values[field])) fail('missing_argument');
  const result = action === 'init' ? initializeClientUpdateSigner({ directory: values.directory }) : signClientUpdateFeed({ directory: values.directory, prepared: values.prepared, authorizationPath: values.authorization, signaturePath: values.signature, approveManifest: values['approve-manifest'] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('ECHO release signing failed; verify private file permissions, the pinned signer, and exact approved release inputs.\n'); process.exitCode = 1; }
}
