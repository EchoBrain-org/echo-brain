#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, readCleanV1Release } from './clean-v1-release.mjs';
import { parseUpdateConfig, parseUpdateManifest, updateDigest, verifyUpdateEnvelope, UPDATE_ARTIFACT_LIMIT, UPDATE_METADATA_LIMIT } from '../src/product/person-client/dist/client-update-contract.js';
import { extractClientUpdateKit, validateClientUpdateRelease } from '../src/product/person-client/dist/client-update-kit.js';

const KIT_FILES = ['Start-ECHO.sh', 'node', 'release.json', 'kit-manifest.v1.json', 'person-client.tgz', 'build-identity.v1.json', 'verify-person-onboarding-kit.mjs', 'clean-v1-release.mjs'];
const KIT_TARGETS = {
  linux: {
    platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'cli-kit',
    schema_version: 2, kind: 'echo-person-onboarding-kit-v2',
    start_source: 'deploy/release/start-person-onboarding-kit-linux.sh',
  },
  macos: {
    platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit',
    schema_version: 3, kind: 'echo-person-cli-kit-v1',
    start_source: 'deploy/release/start-person-cli-kit-macos.sh',
  },
};

function fail(code) { throw new Error(code); }
function read(path, limit = UPDATE_METADATA_LIMIT) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size <= 0 || s.size > limit) fail('invalid_input_file');
  return readFileSync(path);
}
function json(path) { return JSON.parse(read(path).toString('utf8')); }
function save(path, value) { writeFileSync(path, `${canonicalJson(value)}\n`, { mode: 0o600, flag: 'wx' }); }

function sameTarget(left, right) {
  return left.platform === right.platform && left.architecture === right.architecture &&
    left.libc === right.libc && left.installation === right.installation;
}

function validateKit(archive, directory, manifest, release, target) {
  const temporary = mkdtempSync(join(directory, '.verify-'));
  const kit = join(temporary, 'kit');
  try {
    // Both CLI kits use the deliberately flat, fixed eight-file ZIP contract.
    // The shared extractor enforces that contract without extracting attacker
    // controlled paths, independently of the target runtime.
    extractClientUpdateKit(archive, kit);
    validateClientUpdateRelease(kit, manifest);
    const m = json(join(kit, 'kit-manifest.v1.json'));
    if (m.schema_version !== target.schema_version || m.kind !== target.kind ||
        m.release_id !== manifest.release_id || m.source_sha !== manifest.source_sha ||
        m.release_record_sha256 !== manifest.release_sha256 ||
        m.person_client_artifact_sha256 !== release.person_client.artifact_sha256 ||
        m.runtime?.platform !== target.platform || m.runtime?.architecture !== target.architecture ||
        m.runtime?.node_sha256 !== updateDigest(read(join(kit, 'node'), UPDATE_ARTIFACT_LIMIT)) ||
        m.person_client_artifact_sha256 !== updateDigest(read(join(kit, 'person-client.tgz'), UPDATE_ARTIFACT_LIMIT)) ||
        m.build_identity_sha256 !== updateDigest(read(join(kit, 'build-identity.v1.json')))) fail('kit_identity_mismatch');
    const buildIdentityBytes = read(join(kit, 'build-identity.v1.json'));
    const buildIdentity = json(join(kit, 'build-identity.v1.json'));
    if (buildIdentity.schema_version !== 1 || buildIdentity.kind !== 'echo-person-onboarding-kit-identity-v1' ||
        buildIdentity.product_version !== release.person_client.version ||
        buildIdentity.release_id !== manifest.release_id || buildIdentity.source_sha !== release.source_sha ||
        buildIdentity.platform !== target.platform || buildIdentity.architecture !== target.architecture ||
        updateDigest(buildIdentityBytes) !== m.build_identity_sha256) fail('kit_identity_mismatch');
    const clientIdentity = JSON.parse(execFileSync('tar', ['-xOzf', join(kit, 'person-client.tgz'), 'package/dist/build-identity.v1.json'], { encoding: 'utf8', maxBuffer: 4096, timeout: 10_000 }));
    if (clientIdentity.schema_version !== 1 || clientIdentity.kind !== 'echo-packaged-build-identity' ||
        clientIdentity.source_kind !== 'materialized-commit' || clientIdentity.source_sha !== release.source_sha ||
        clientIdentity.product_version !== release.person_client.version) fail('client_identity_mismatch');
    // Setup scripts are part of the reviewed release, not an independent payload.
    for (const [entry, source] of [['Start-ECHO.sh', target.start_source], ['verify-person-onboarding-kit.mjs', 'deploy/release/verify-person-onboarding-kit.mjs'], ['clean-v1-release.mjs', 'tools/clean-v1-release.mjs']]) {
      const committed = execFileSync('git', ['show', `${release.source_sha}:${source}`], { cwd: resolve(import.meta.dirname, '..'), maxBuffer: 1024 * 1024 });
      if (!committed.equals(read(join(kit, entry), 1024 * 1024))) fail('installer_source_mismatch');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function prepareClientUpdateFeed({ configPath, releasePath, linuxKit, macosKit, sequence, expiresAt, output, now = new Date().toISOString() }) {
  const config = parseUpdateConfig(json(configPath));
  if (config.installation !== 'cli-kit') fail('publisher_adapter_unavailable');
  const release = readCleanV1Release(releasePath);
  const inputs = [
    linuxKit && { path: linuxKit, target: KIT_TARGETS.linux },
    macosKit && { path: macosKit, target: KIT_TARGETS.macos },
  ].filter(Boolean);
  if (!inputs.length) fail('missing_artifact');
  const artifacts = inputs.map(input => {
    const bytes = read(input.path, UPDATE_ARTIFACT_LIMIT);
    const sha256 = updateDigest(bytes);
    return { ...input, bytes, sha256, artifact: { platform: input.target.platform,
      architecture: input.target.architecture, libc: input.target.libc, installation: input.target.installation,
      url: new URL(`./artifacts/${sha256}.zip`, config.feed_url).href, sha256, bytes: bytes.length } };
  });
  if (new Set(artifacts.map(artifact => artifact.sha256)).size !== artifacts.length) fail('duplicate_artifact');
  const manifest = parseUpdateManifest({
    schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: config.channel, sequence,
    issued_at: now, expires_at: expiresAt, release_id: release.release_id,
    release_sha256: updateDigest(read(releasePath)), source_sha: release.source_sha,
    product_version: release.person_client.version,
    artifacts: artifacts.map(({ artifact }) => artifact),
  });
  if (sequence < config.minimum_sequence) fail('sequence_before_bootstrap');
  mkdirSync(output, { mode: 0o700 });
  try {
    for (const artifact of artifacts) validateKit(artifact.path, output, manifest, release, artifact.target);
    mkdirSync(join(output, 'artifacts'), { mode: 0o700 });
    for (const artifact of artifacts) writeFileSync(join(output, 'artifacts', `${artifact.sha256}.zip`), artifact.bytes, { mode: 0o600, flag: 'wx' });
    save(join(output, 'manifest.json'), manifest);
    save(join(output, 'bootstrap-config.json'), config);
    writeFileSync(join(output, 'release.json'), read(releasePath), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return { status: 'prepared', manifest_sha256: updateDigest(read(join(output, 'manifest.json'))), release_id: release.release_id, artifact_count: artifacts.length };
}

// Shared nonmutating release validation for the signer and bounded publisher.
// Private key handling and AWS writes belong to their separate operator tools.
function validationTime(manifest, now, allowExpired) {
  const issuedAt = Date.parse(manifest.issued_at);
  const expiresAt = Date.parse(manifest.expires_at);
  // Audit verification deliberately omits only expiry. It still judges a feed
  // against the real clock for future-issued metadata, then verifies the
  // signature at its final valid millisecond when the feed has expired.
  if (!Number.isFinite(now) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 5 * 60 * 1000) fail('expired_metadata');
  if (!allowExpired && expiresAt <= now) fail('expired_metadata');
  return allowExpired ? Math.min(now, expiresAt - 1) : now;
}

export function validatePreparedClientUpdateFeed({ prepared, authorizationPath, now = Date.now(), allowExpired = false }) {
  const config = parseUpdateConfig(json(join(prepared, 'bootstrap-config.json')));
  if (config.installation !== 'cli-kit') fail('publisher_adapter_unavailable');
  const payload = read(join(prepared, 'manifest.json'));
  const manifest = parseUpdateManifest(JSON.parse(payload.toString('utf8')));
  if (manifest.channel !== config.channel) fail('wrong_channel');
  validationTime(manifest, now, allowExpired);
  if (manifest.sequence < config.minimum_sequence) fail('stale_metadata');
  if (manifest.artifacts.some(a => new URL(a.url).origin !== new URL(config.feed_url).origin)) fail('wrong_artifact_origin');
  const release = readCleanV1Release(join(prepared, 'release.json'));
  const approval = json(authorizationPath);
  if (approval.kind !== 'echo-staging-release-founder-authorization-v1' ||
      approval.release_sha256 !== manifest.release_sha256 ||
      approval.person_client_sha256 !== release.person_client.artifact_sha256 ||
      ['slack_approved', 'person_records_passed', 'person_ask_passed', 'release_authorized'].some(k => approval[k] !== true)) fail('exact_release_authorization_required');
  if (updateDigest(read(join(prepared, 'release.json'))) !== manifest.release_sha256 ||
      release.release_id !== manifest.release_id || release.source_sha !== manifest.source_sha ||
      release.person_client.version !== manifest.product_version) fail('release_mismatch');
  for (const artifact of manifest.artifacts) {
    const target = Object.values(KIT_TARGETS).find(candidate => sameTarget(candidate, artifact));
    if (!target) fail('publisher_adapter_unavailable');
    const path = join(prepared, 'artifacts', `${artifact.sha256}.zip`);
    const bytes = read(path, UPDATE_ARTIFACT_LIMIT);
    if (bytes.length !== artifact.bytes || updateDigest(bytes) !== artifact.sha256) fail('artifact_mismatch');
    validateKit(path, prepared, manifest, release, target);
  }
  return { config, manifest, payload, release };
}

export function validateSealedClientUpdateFeed({ prepared, authorizationPath, now = Date.now(), allowExpired = false }) {
  const validated = validatePreparedClientUpdateFeed({ prepared, authorizationPath, now, allowExpired });
  const feedBytes = read(join(prepared, 'feed.json'));
  verifyUpdateEnvelope(feedBytes, validated.config, validationTime(validated.manifest, now, allowExpired));
  const envelope = JSON.parse(feedBytes.toString('utf8'));
  if (!Buffer.from(envelope.payload, 'base64').equals(validated.payload)) fail('prepared_manifest_mismatch');
  return { ...validated, feedBytes };
}

export function sealClientUpdateFeed({ prepared, signaturePath, authorizationPath, now = Date.now() }) {
  const { config, manifest, payload } = validatePreparedClientUpdateFeed({ prepared, authorizationPath, now });
  const signature = read(signaturePath, 64);
  if (signature.length !== 64) fail('invalid_signature');
  const envelope = { payload: payload.toString('base64'), signature: signature.toString('base64') };
  verifyUpdateEnvelope(Buffer.from(JSON.stringify(envelope)), config, now);
  // The signature authorizes these exact channel bytes and artifact hashes.
  // Upload immutable artifacts first, then atomically replace the feed last.
  save(join(prepared, 'feed.json'), envelope);
  return { status: 'sealed', channel: manifest.channel, sequence: manifest.sequence, release_id: manifest.release_id };
}

function main(argv) {
  const action = argv[0];
  const fields = action === 'prepare' ? ['config', 'release', 'linux-kit', 'macos-kit', 'sequence', 'expires', 'out'] : action === 'seal' ? ['prepared', 'signature', 'authorization'] : [];
  if (!fields.length) fail('usage: client-update-feed.mjs prepare --config FILE --release FILE [--linux-kit ZIP] [--macos-kit ZIP] --sequence N --expires ISO --out NEW_DIRECTORY | seal --prepared DIRECTORY --signature FILE --authorization FILE');
  const { values, positionals } = parseArgs({ args: argv.slice(1), options: Object.fromEntries(fields.map(f => [f, { type: 'string' }])), strict: true, allowPositionals: false });
  const required = action === 'prepare' ? ['config', 'release', 'sequence', 'expires', 'out'] : fields;
  if (positionals.length || required.some(f => !values[f]) || (action === 'prepare' && !values['linux-kit'] && !values['macos-kit'])) fail('missing_argument');
  const result = action === 'prepare' ? prepareClientUpdateFeed({ configPath: resolve(values.config), releasePath: resolve(values.release), linuxKit: values['linux-kit'] && resolve(values['linux-kit']), macosKit: values['macos-kit'] && resolve(values['macos-kit']), sequence: Number(values.sequence), expiresAt: values.expires, output: resolve(values.out) }) : sealClientUpdateFeed({ prepared: resolve(values.prepared), signaturePath: resolve(values.signature), authorizationPath: resolve(values.authorization) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('ECHO update feed preparation failed; verify the inputs, signature, and exact release authorization.\n'); process.exitCode = 1; }
}
