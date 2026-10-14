#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, readCleanV1Release } from './clean-v1-release.mjs';
import { parseUpdateConfig, parseUpdateManifest, updateDigest, verifyUpdateEnvelope, UPDATE_ARTIFACT_LIMIT, UPDATE_METADATA_LIMIT } from '../src/product/person-client/dist/client-update-contract.js';
import { extractClientUpdateKit, validateClientUpdateRelease } from '../src/product/person-client/dist/client-update-kit.js';
import { checkDesktopDeb } from '../product/echo-desktop/scripts/check-deb.mjs';

const REPO = resolve(import.meta.dirname, '..');
// Archive tools get a bound well above a ~130 MB app's extraction time.
const TOOL_TIMEOUT_MS = 120_000;
const DESKTOP_IDENTITY = 'echo-desktop-identity.v1.json';

// ADR-0035: every release carries exactly these four targets. Every prepare
// option, object key, local path, URL and content type derives from this table.
export const RELEASE_TARGETS = Object.freeze([
  { option: 'linux-kit', platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'cli-kit', extension: 'zip', content_type: 'application/zip',
    kit: { schema_version: 2, kind: 'echo-person-onboarding-kit-v2', start_source: 'deploy/release/start-person-onboarding-kit-linux.sh' } },
  { option: 'macos-kit', platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit', extension: 'zip', content_type: 'application/zip',
    kit: { schema_version: 3, kind: 'echo-person-cli-kit-v1', start_source: 'deploy/release/start-person-cli-kit-macos.sh' } },
  { option: 'macos-app', platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron', extension: 'zip', content_type: 'application/zip' },
  { option: 'linux-deb', platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'electron', extension: 'deb', content_type: 'application/vnd.debian.binary-package' },
].map(target => Object.freeze(target)));

function fail(code) { throw new Error(code); }
function regular(path, limit) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size <= 0 || s.size > limit) fail('invalid_input_file');
}
function read(path, limit = UPDATE_METADATA_LIMIT) { regular(path, limit); return readFileSync(path); }
function json(path) { return JSON.parse(read(path).toString('utf8')); }
function save(path, value) { writeFileSync(path, `${canonicalJson(value)}\n`, { mode: 0o600, flag: 'wx' }); }

function sameTarget(left, right) {
  return left.platform === right.platform && left.architecture === right.architecture &&
    left.libc === right.libc && left.installation === right.installation;
}
/** The table row for a manifest artifact, or undefined for a target no release carries. */
export function releaseTarget(artifact) { return RELEASE_TARGETS.find(target => artifact && sameTarget(target, artifact)); }
/** The artifact's object key, which is also its path under a prepared directory. `code` names the refusal. */
export function artifactKey(artifact, code = 'publisher_adapter_unavailable') {
  const target = releaseTarget(artifact);
  if (!target || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) fail(code);
  return `artifacts/${artifact.sha256}.${target.extension}`;
}

// Every new release moves the CLI kits and both desktop apps together.
// Historical feed validation deliberately does not apply this requirement.
export function requireReleaseTargets(manifest) {
  const artifacts = manifest?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== RELEASE_TARGETS.length ||
      !RELEASE_TARGETS.every(target => artifacts.some(artifact => artifact && sameTarget(artifact, target)))) {
    fail('all_release_targets_required');
  }
}

/** Validates a CLI kit and returns its release-bound person-client.tgz bytes. */
function validateKit(archive, target, manifest, release, config, directory) {
  const temporary = mkdtempSync(join(directory, '.verify-'));
  const kit = join(temporary, 'kit');
  try {
    // Both CLI kits use the deliberately flat, fixed eight-file ZIP contract.
    // The shared extractor enforces that contract without extracting attacker
    // controlled paths, independently of the target runtime.
    extractClientUpdateKit(archive, kit);
    validateClientUpdateRelease(kit, manifest);
    const m = json(join(kit, 'kit-manifest.v1.json'));
    const client = read(join(kit, 'person-client.tgz'), UPDATE_ARTIFACT_LIMIT);
    if (m.schema_version !== target.kit.schema_version || m.kind !== target.kit.kind ||
        m.release_id !== manifest.release_id || m.source_sha !== manifest.source_sha ||
        m.release_record_sha256 !== manifest.release_sha256 ||
        m.person_client_artifact_sha256 !== release.person_client.artifact_sha256 ||
        m.runtime?.platform !== target.platform || m.runtime?.architecture !== target.architecture ||
        m.runtime?.node_sha256 !== updateDigest(read(join(kit, 'node'), UPDATE_ARTIFACT_LIMIT)) ||
        m.person_client_artifact_sha256 !== updateDigest(client) ||
        m.build_identity_sha256 !== updateDigest(read(join(kit, 'build-identity.v1.json')))) fail('kit_identity_mismatch');
    // Older kits without a bootstrap stay auditable. A rollback, as a new
    // write, can only target a release that carries all four targets.
    if (target.platform === 'linux' && Object.hasOwn(m, 'update_bootstrap')) {
      const bootstrap = parseUpdateConfig(m.update_bootstrap);
      if (!bootstrap.automatic || canonicalJson(bootstrap) !== canonicalJson(config)) fail('kit_bootstrap_mismatch');
    }
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
    for (const [entry, source] of [['Start-ECHO.sh', target.kit.start_source], ['verify-person-onboarding-kit.mjs', 'deploy/release/verify-person-onboarding-kit.mjs'], ['clean-v1-release.mjs', 'tools/clean-v1-release.mjs']]) {
      if (!committed(release, source).equals(read(join(kit, entry), 1024 * 1024))) fail('installer_source_mismatch');
    }
    return client;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
function committed(release, source) {
  return execFileSync('git', ['show', `${release.source_sha}:${source}`], { cwd: REPO, maxBuffer: 1024 * 1024 });
}

// Desktop artifacts (ADR-0035 "Desktop release identity"). The ZIP is read
// with archive tools and only named members are extracted, into a private
// folder; every member of the .deb is read from its headers.
const APP = 'ECHO.app/';
const APP_RESOURCES = 'ECHO.app/Contents/Resources/';
const DEB_RESOURCES = './opt/ECHO/resources/';
function tool(command, args, options = {}) {
  return execFileSync(command, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...options });
}

/** The identity package.mjs writes for this target, which must match byte for byte. */
function checkDesktopIdentity(bytes, target, manifest, release, config) {
  let identity;
  try { identity = JSON.parse(bytes.toString('utf8')); } catch { fail('desktop_identity_mismatch'); }
  // The app pins this bootstrap on first run, so only the installation may differ.
  const bootstrap = { ...config, installation: 'electron' };
  if (canonicalJson(identity?.update_bootstrap ?? null) !== canonicalJson(bootstrap)) fail('desktop_bootstrap_mismatch');
  const expected = {
    schema_version: 1, kind: 'echo-desktop-identity-v1', release_id: manifest.release_id,
    release_record_sha256: manifest.release_sha256, source_sha: release.source_sha,
    product_version: release.person_client.version, person_client_artifact_sha256: release.person_client.artifact_sha256,
    platform: target.platform, architecture: target.architecture, libc: target.libc, installation: target.installation,
    update_bootstrap: bootstrap,
  };
  if (!bytes.equals(Buffer.from(`${canonicalJson(expected)}\n`))) fail('desktop_identity_mismatch');
}

/** Relative entries of a tree; a symlink or special file is refused, never followed. */
function treeEntries(root) {
  const entries = [];
  const walk = relative => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = join(relative, name);
      const state = lstatSync(join(root, path));
      if (state.isDirectory()) { entries.push(`${path}/`); walk(path); }
      else if (state.isFile()) entries.push(path);
      else fail('desktop_client_mismatch');
    }
  };
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) fail('desktop_client_mismatch');
  walk('');
  return entries;
}
function requireSameTree(embedded, client) {
  const entries = treeEntries(embedded);
  if (canonicalJson(entries) !== canonicalJson(treeEntries(client))) fail('desktop_client_mismatch');
  for (const entry of entries) {
    if (!entry.endsWith('/') && !readFileSync(join(embedded, entry)).equals(readFileSync(join(client, entry)))) fail('desktop_client_mismatch');
  }
}

// macOS: ECHO.app as electron-builder zips it. Frameworks inside carry
// symlinks, so only entry names are policed bundle-wide. Names are printable
// ASCII without '?': depending on locale, unzip's listing prints other bytes
// as '?', so a non-ASCII name cannot be compared with the path a Mac installs.
function zipEntryName(name) {
  const segments = name.split('/');
  return name.startsWith(APP) && /^[\x20-\x7e]+$/.test(name) && !/[\\?]/.test(name) &&
    segments.every((segment, index) => !['.', '..'].includes(segment) && (segment || index === segments.length - 1));
}
// APFS and the updater's `ditto -x -k` fold case, so a later entry spelled
// with other case lands on, or inside, a path checked here and replaces it.
// Every entry, and every directory its name implies, must own its path
// ignoring case: one spelling, one kind (a file never shares a directory's path).
function zipPathsDistinct(names) {
  const paths = new Map();
  const claim = (path, kind) => {
    const owner = `${kind}:${path}`;
    if ((paths.get(path.toLowerCase()) ?? owner) !== owner) return false;
    paths.set(path.toLowerCase(), owner);
    return true;
  };
  return new Set(names).size === names.length && names.every(name =>
    [...name.matchAll(/\//g)].every(slash => claim(name.slice(0, slash.index), 'directory')) &&
    (name.endsWith('/') || claim(name, 'file')));
}
function zipMember(archive, name, limit) {
  // -p prints a symlink entry's target, so the member itself must be a file.
  if (!/^-[^\n]* \S+\n$/.test(tool('unzip', ['-Z', '-s', archive, name], { encoding: 'utf8' }))) fail('desktop_archive_invalid');
  return tool('unzip', ['-p', archive, name], { maxBuffer: limit });
}
// XML plist read as text, since prepare may run on Linux. Comments, CDATA and
// character references could hide what a plist parser sees, so they are refused.
function bundleIdentifier(plist) {
  const text = plist.toString('utf8');
  const keys = text.split('<key>CFBundleIdentifier</key>').length - 1;
  const value = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  if (!text.startsWith('<?xml') || /<!--|<!\[CDATA\[|&#/.test(text) || keys !== 1) fail('desktop_bundle_mismatch');
  return value;
}
function macosEmbeddedClient(archive, directory, target, manifest, release, config) {
  const listing = tool('unzip', ['-Z1', archive], { encoding: 'utf8' });
  const names = listing.endsWith('\n') ? listing.slice(0, -1).split('\n') : [];
  if (!names.length || !names.every(zipEntryName) || !zipPathsDistinct(names)) fail('desktop_archive_invalid');
  if (bundleIdentifier(zipMember(archive, 'ECHO.app/Contents/Info.plist', 1024 * 1024)) !== 'org.echobrain.echo-desktop') fail('desktop_bundle_mismatch');
  checkDesktopIdentity(zipMember(archive, APP_RESOURCES + DESKTOP_IDENTITY, UPDATE_METADATA_LIMIT), target, manifest, release, config);
  tool('unzip', ['-qq', '-n', archive, `${APP_RESOURCES}person-client/*`, '-d', directory]);
  return join(directory, APP_RESOURCES, 'person-client');
}

// Linux: check-deb.mjs first refuses anything dpkg would run or place as root
// that is not reviewed source at release.source_sha, and anything outside the
// app's footprint. Then the identity, and the embedded client written out for
// the file-for-file comparison.
function debEmbeddedClient(path, directory, target, manifest, release, config) {
  const members = checkDesktopDeb(read(path, UPDATE_ARTIFACT_LIMIT), source => committed(release, source));
  const identity = members.get(DEB_RESOURCES + DESKTOP_IDENTITY);
  if (identity?.type !== 'file') fail('desktop_identity_mismatch');
  checkDesktopIdentity(identity.bytes, target, manifest, release, config);
  const prefix = `${DEB_RESOURCES}person-client`;
  const client = join(directory, 'person-client');
  // Members come parents first, with checked relative paths.
  for (const [name, member] of members) {
    if (name !== prefix && !name.startsWith(`${prefix}/`)) continue;
    const into = join(client, name.slice(prefix.length));
    if (member.type === 'directory') mkdirSync(into, { mode: 0o700 });
    else if (member.type === 'file') writeFileSync(into, member.bytes, { mode: 0o600, flag: 'wx' });
    else fail('desktop_client_mismatch');
  }
  return client;
}

/** Checks an ECHO.app ZIP or .deb: identity, bootstrap, platform metadata and embedded client. */
function validateDesktopArtifact(path, target, manifest, release, config, releaseClientTgz) {
  regular(path, UPDATE_ARTIFACT_LIMIT);
  if (updateDigest(read(releaseClientTgz, UPDATE_ARTIFACT_LIMIT)) !== release.person_client.artifact_sha256) fail('client_identity_mismatch');
  const temporary = mkdtempSync(join(tmpdir(), 'echo-desktop-verify-'));
  try {
    const client = join(temporary, 'release-client');
    const unpacked = join(temporary, 'artifact');
    mkdirSync(client, { mode: 0o700 });
    mkdirSync(unpacked, { mode: 0o700 });
    tool('tar', ['-xzf', releaseClientTgz, '-C', client]);
    const embedded = (target.platform === 'darwin' ? macosEmbeddedClient : debEmbeddedClient)(path, unpacked, target, manifest, release, config);
    requireSameTree(embedded, client);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

// Kits first: each desktop artifact's embedded client is compared, file for
// file, with the person-client.tgz that a kit in the same bundle was validated to carry.
function validateArtifacts(entries, directory, manifest, release, config) {
  const temporary = mkdtempSync(join(directory, '.client-'));
  const client = join(temporary, 'person-client.tgz');
  const kit = entry => entry.target.installation === 'cli-kit';
  try {
    for (const { path, target } of entries.filter(kit)) {
      const bytes = validateKit(path, target, manifest, release, config, directory);
      if (!existsSync(client)) writeFileSync(client, bytes, { mode: 0o600, flag: 'wx' });
    }
    for (const { path, target } of entries.filter(entry => !kit(entry))) {
      if (!existsSync(client)) fail('desktop_client_unavailable');
      validateDesktopArtifact(path, target, manifest, release, config, client);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function prepareClientUpdateFeed({ configPath, releasePath, artifactPaths, sequence, expiresAt, output, now = new Date().toISOString() }) {
  const config = parseUpdateConfig(json(configPath));
  if (config.installation !== 'cli-kit') fail('publisher_adapter_unavailable');
  const release = readCleanV1Release(releasePath);
  const inputs = RELEASE_TARGETS.filter(target => artifactPaths[target.option]).map(target => ({ path: artifactPaths[target.option], target }));
  requireReleaseTargets({ artifacts: inputs.map(input => input.target) });
  const artifacts = inputs.map(input => {
    const bytes = read(input.path, UPDATE_ARTIFACT_LIMIT);
    const sha256 = updateDigest(bytes);
    const { platform, architecture, libc, installation } = input.target;
    const artifact = { platform, architecture, libc, installation, sha256, bytes: bytes.length };
    const key = artifactKey(artifact);
    return { ...input, bytes, sha256, key, artifact: { ...artifact, url: new URL(`./${key}`, config.feed_url).href } };
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
    validateArtifacts(artifacts, output, manifest, release, config);
    mkdirSync(join(output, 'artifacts'), { mode: 0o700 });
    for (const artifact of artifacts) writeFileSync(join(output, artifact.key), artifact.bytes, { mode: 0o600, flag: 'wx' });
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
  const entries = manifest.artifacts.map(artifact => {
    // The key, and so the served content type, follows the target: a .deb is
    // never accepted under a .zip URL, or the reverse.
    const key = artifactKey(artifact);
    if (artifact.url !== new URL(`./${key}`, config.feed_url).href) fail('artifact_mismatch');
    const path = join(prepared, key);
    const bytes = read(path, UPDATE_ARTIFACT_LIMIT);
    if (bytes.length !== artifact.bytes || updateDigest(bytes) !== artifact.sha256) fail('artifact_mismatch');
    return { path, target: releaseTarget(artifact) };
  });
  validateArtifacts(entries, prepared, manifest, release, config);
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

function sealClientUpdateFeed({ prepared, signaturePath, authorizationPath, now = Date.now() }) {
  const { config, manifest, payload } = validatePreparedClientUpdateFeed({ prepared, authorizationPath, now });
  requireReleaseTargets(manifest);
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
  const artifactOptions = RELEASE_TARGETS.map(target => target.option);
  const fields = action === 'prepare' ? ['config', 'release', ...artifactOptions, 'sequence', 'expires', 'out'] : action === 'seal' ? ['prepared', 'signature', 'authorization'] : [];
  if (!fields.length) fail('usage: client-update-feed.mjs prepare --config FILE --release FILE --linux-kit ZIP --macos-kit ZIP --macos-app ZIP --linux-deb DEB --sequence N --expires ISO --out NEW_DIRECTORY | seal --prepared DIRECTORY --signature FILE --authorization FILE');
  const { values, positionals } = parseArgs({ args: argv.slice(1), options: Object.fromEntries(fields.map(f => [f, { type: 'string' }])), strict: true, allowPositionals: false });
  if (positionals.length || fields.some(f => !values[f])) fail('missing_argument');
  const result = action === 'prepare'
    ? prepareClientUpdateFeed({ configPath: resolve(values.config), releasePath: resolve(values.release), artifactPaths: Object.fromEntries(artifactOptions.map(option => [option, resolve(values[option])])), sequence: Number(values.sequence), expiresAt: values.expires, output: resolve(values.out) })
    : sealClientUpdateFeed({ prepared: resolve(values.prepared), signaturePath: resolve(values.signature), authorizationPath: resolve(values.authorization) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const code = /^[a-z_]+$/.test(error?.message ?? '') ? ` (${error.message})` : '';
    process.stderr.write(`ECHO update feed preparation failed${code}; verify the inputs, signature, and exact release authorization.\n`);
    process.exitCode = 1;
  }
}
