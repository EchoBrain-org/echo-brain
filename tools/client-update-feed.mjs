#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, readCleanV1Release } from './clean-v1-release.mjs';
import { parseUpdateConfig, parseUpdateManifest, updateDigest, verifyUpdateEnvelope, UPDATE_ARTIFACT_LIMIT, UPDATE_METADATA_LIMIT } from '../src/product/person-client/dist/client-update-contract.js';
import { extractLinuxUpdateKit, validateLinuxUpdateRelease } from '../src/product/person-client/dist/client-update-linux.js';

function fail(code) { throw new Error(code); }
function read(path, limit = UPDATE_METADATA_LIMIT) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size <= 0 || s.size > limit) fail('invalid_input_file');
  return readFileSync(path);
}
function json(path) { return JSON.parse(read(path).toString('utf8')); }
function save(path, value) { writeFileSync(path, `${canonicalJson(value)}\n`, { mode: 0o600, flag: 'wx' }); }

function validateKit(archive, directory, manifest, release) {
  const temporary = mkdtempSync(join(directory, '.verify-'));
  const kit = join(temporary, 'kit');
  try {
    extractLinuxUpdateKit(archive, kit);
    validateLinuxUpdateRelease(kit, manifest);
    const m = json(join(kit, 'kit-manifest.v1.json'));
    if (m.schema_version !== 2 || m.kind !== 'echo-person-onboarding-kit-v2' ||
        m.release_id !== manifest.release_id || m.source_sha !== manifest.source_sha ||
        m.release_record_sha256 !== manifest.release_sha256 ||
        m.person_client_artifact_sha256 !== release.person_client.artifact_sha256 ||
        m.runtime?.platform !== 'linux' || m.runtime?.architecture !== 'x64' ||
        m.runtime?.node_sha256 !== updateDigest(read(join(kit, 'node'), UPDATE_ARTIFACT_LIMIT)) ||
        m.person_client_artifact_sha256 !== updateDigest(read(join(kit, 'person-client.tgz'), UPDATE_ARTIFACT_LIMIT)) ||
        m.build_identity_sha256 !== updateDigest(read(join(kit, 'build-identity.v1.json')))) fail('kit_identity_mismatch');
    const identity = JSON.parse(execFileSync('tar', ['-xOzf', join(kit, 'person-client.tgz'), 'package/dist/build-identity.v1.json'], { encoding: 'utf8', maxBuffer: 4096, timeout: 10_000 }));
    if (identity.source_kind !== 'materialized-commit' || identity.source_sha !== release.source_sha || identity.product_version !== release.person_client.version) fail('client_identity_mismatch');
    // Setup scripts are part of the reviewed release, not an independent payload.
    for (const [entry, source] of [['Start-ECHO.sh', 'deploy/release/start-person-onboarding-kit-linux.sh'], ['verify-person-onboarding-kit.mjs', 'deploy/release/verify-person-onboarding-kit.mjs'], ['clean-v1-release.mjs', 'tools/clean-v1-release.mjs']]) {
      const committed = execFileSync('git', ['show', `${release.source_sha}:${source}`], { cwd: resolve(import.meta.dirname, '..'), maxBuffer: 1024 * 1024 });
      if (!committed.equals(read(join(kit, entry), 1024 * 1024))) fail('installer_source_mismatch');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function prepareClientUpdateFeed({ configPath, releasePath, linuxKit, sequence, expiresAt, output, now = new Date().toISOString() }) {
  const config = parseUpdateConfig(json(configPath));
  const release = readCleanV1Release(releasePath);
  const bytes = read(linuxKit, UPDATE_ARTIFACT_LIMIT);
  const digest = updateDigest(bytes);
  const manifest = parseUpdateManifest({
    schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: config.channel, sequence,
    issued_at: now, expires_at: expiresAt, release_id: release.release_id,
    release_sha256: updateDigest(read(releasePath)), source_sha: release.source_sha,
    product_version: release.person_client.version,
    artifacts: [{ platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'cli-kit',
      url: new URL(`./artifacts/${digest}.zip`, config.feed_url).href, sha256: digest, bytes: bytes.length }],
  });
  if (sequence < config.minimum_sequence) fail('sequence_before_bootstrap');
  mkdirSync(output, { mode: 0o700 });
  try {
    validateKit(linuxKit, output, manifest, release);
    mkdirSync(join(output, 'artifacts'), { mode: 0o700 });
    writeFileSync(join(output, 'artifacts', `${digest}.zip`), bytes, { mode: 0o600, flag: 'wx' });
    save(join(output, 'manifest.json'), manifest);
    save(join(output, 'bootstrap-config.json'), config);
    copyFileSync(releasePath, join(output, 'release.json'));
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return { status: 'prepared', manifest_sha256: updateDigest(read(join(output, 'manifest.json'))), release_id: release.release_id };
}

export function sealClientUpdateFeed({ prepared, signaturePath, authorizationPath, now = Date.now() }) {
  const config = parseUpdateConfig(json(join(prepared, 'bootstrap-config.json')));
  const payload = read(join(prepared, 'manifest.json'));
  const signature = read(signaturePath, 64);
  if (signature.length !== 64) fail('invalid_signature');
  const envelope = { payload: payload.toString('base64'), signature: signature.toString('base64') };
  const { manifest } = verifyUpdateEnvelope(Buffer.from(JSON.stringify(envelope)), config, now);
  const release = readCleanV1Release(join(prepared, 'release.json'));
  const approval = json(authorizationPath);
  if (approval.kind !== 'echo-staging-release-founder-authorization-v1' ||
      approval.release_sha256 !== manifest.release_sha256 ||
      approval.person_client_sha256 !== release.person_client.artifact_sha256 ||
      ['slack_approved', 'person_records_passed', 'person_ask_passed', 'release_authorized'].some(k => approval[k] !== true)) fail('exact_release_authorization_required');
  if (updateDigest(read(join(prepared, 'release.json'))) !== manifest.release_sha256) fail('release_mismatch');
  for (const artifact of manifest.artifacts) {
    if (artifact.platform !== 'linux' || artifact.installation !== 'cli-kit') fail('publisher_adapter_unavailable');
    const path = join(prepared, 'artifacts', `${artifact.sha256}.zip`);
    const bytes = read(path, UPDATE_ARTIFACT_LIMIT);
    if (bytes.length !== artifact.bytes || updateDigest(bytes) !== artifact.sha256) fail('artifact_mismatch');
    validateKit(path, prepared, manifest, release);
  }
  // The signature authorizes these exact channel bytes and artifact hashes.
  // Upload immutable artifacts first, then atomically replace the feed last.
  save(join(prepared, 'feed.json'), envelope);
  return { status: 'sealed', channel: manifest.channel, sequence: manifest.sequence, release_id: manifest.release_id };
}

function main(argv) {
  const action = argv[0];
  const fields = action === 'prepare' ? ['config', 'release', 'linux-kit', 'sequence', 'expires', 'out'] : action === 'seal' ? ['prepared', 'signature', 'authorization'] : [];
  if (!fields.length) fail('usage: client-update-feed.mjs prepare --config FILE --release FILE --linux-kit ZIP --sequence N --expires ISO --out NEW_DIRECTORY | seal --prepared DIRECTORY --signature FILE --authorization FILE');
  const { values, positionals } = parseArgs({ args: argv.slice(1), options: Object.fromEntries(fields.map(f => [f, { type: 'string' }])), strict: true, allowPositionals: false });
  if (positionals.length || fields.some(f => !values[f])) fail('missing_argument');
  const result = action === 'prepare' ? prepareClientUpdateFeed({ configPath: resolve(values.config), releasePath: resolve(values.release), linuxKit: resolve(values['linux-kit']), sequence: Number(values.sequence), expiresAt: values.expires, output: resolve(values.out) }) : sealClientUpdateFeed({ prepared: resolve(values.prepared), signaturePath: resolve(values.signature), authorizationPath: resolve(values.authorization) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('ECHO update feed preparation failed; verify the inputs, signature, and exact release authorization.\n'); process.exitCode = 1; }
}
