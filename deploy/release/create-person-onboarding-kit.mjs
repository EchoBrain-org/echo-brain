#!/usr/bin/env node

/** Build one macOS-arm64 employee kit with an exact client and Node runtime. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

const releaseDirectory = resolve(import.meta.dirname);
const repository = resolve(releaseDirectory, '..', '..');
const releaseValidator = join(repository, 'tools', 'clean-v1-release.mjs');
const verifier = join(releaseDirectory, 'verify-person-onboarding-kit.mjs');
const starter = join(releaseDirectory, 'start-person-onboarding-kit.sh');
const overlayIdentityPath = 'ECHO.app/Contents/Resources/build-identity.v1.json';

function fail(message) {
  throw new Error(`Person onboarding kit: ${message}`);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') fail('manifest contains an unsupported value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function regularFile(path, description, executable = false) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${description} is missing`);
  }
  if (!state.isFile() || state.isSymbolicLink()) fail(`${description} must be a regular file`);
  if (executable && (state.mode & 0o111) === 0) fail(`${description} must be executable`);
}

function absentPath(path, description) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  fail(`${description} already exists`);
}

function privateCanonicalOutputDirectory(path) {
  const lexical = resolve(path);
  let state;
  let canonical;
  try {
    state = lstatSync(lexical);
    canonical = realpathSync(lexical);
  } catch {
    fail('output directory is missing');
  }
  const metadata = statSync(lexical);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    canonical !== lexical ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o700
  ) fail('output directory must be a canonical current-user-owned mode 0700 directory');
  return lexical;
}

function publishNoReplace(source, destination, description) {
  try {
    linkSync(source, destination);
  } catch (error) {
    fail(`${description} could not be published without replacement: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command, args, description) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${description}: ${(result.stderr || result.stdout || 'command failed').trim()}`);
  }
  return result.stdout;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseCanonicalRelease(path) {
  const canonical = run(process.execPath, [releaseValidator, 'validate', path], 'release record is invalid');
  try {
    return JSON.parse(canonical);
  } catch {
    fail('release validator returned invalid JSON');
  }
}

function verifyArtifactIdentity(artifact, release) {
  const listed = run('tar', ['-tzf', artifact], 'client artifact cannot be read');
  const entries = listed.split('\n').filter(Boolean);
  if (!entries.includes('package/dist/build-identity.v1.json')) {
    fail('client artifact lacks its packaged build identity');
  }
  let identity;
  try {
    identity = JSON.parse(
      run('tar', ['-xOzf', artifact, 'package/dist/build-identity.v1.json'], 'client artifact identity cannot be read'),
    );
  } catch {
    fail('client artifact build identity is invalid JSON');
  }
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    JSON.stringify(Object.keys(identity).sort()) !==
      JSON.stringify(['kind', 'product_version', 'schema_version', 'source_kind', 'source_sha']) ||
    identity.schema_version !== 1 ||
    identity.kind !== 'echo-packaged-build-identity' ||
    identity.product_version !== release.person_client.version ||
    identity.source_kind !== 'materialized-commit' ||
    identity.source_sha !== release.source_sha
  ) fail('client artifact build identity does not match the release record');
}

function verifyOverlayIdentity(appArchive, release) {
  const listed = run('unzip', ['-Z1', appArchive], 'desktop app archive cannot be read');
  const entries = listed.split('\n').filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) =>
      entry.startsWith('/') ||
      entry.split('/').some((part) => part === '..') ||
      (!entry.startsWith('ECHO.app/') && entry !== 'ECHO.app')
    ) ||
    !entries.includes('ECHO.app/Contents/MacOS/ECHO') ||
    !entries.includes('ECHO.app/Contents/Info.plist') ||
    !entries.includes(overlayIdentityPath)
  ) fail('desktop app archive layout is invalid');
  let identity;
  try {
    identity = JSON.parse(
      run('unzip', ['-p', appArchive, overlayIdentityPath], 'desktop app identity cannot be read'),
    );
  } catch {
    fail('desktop app identity is invalid JSON');
  }
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    JSON.stringify(Object.keys(identity).sort()) !==
      JSON.stringify([
        'architecture',
        'kind',
        'platform',
        'product_version',
        'schema_version',
        'source_sha',
      ]) ||
    identity.schema_version !== 1 ||
    identity.kind !== 'echo-overlay-build-identity-v1' ||
    identity.product_version !== release.person_client.version ||
    identity.source_sha !== release.source_sha ||
    identity.platform !== 'darwin' ||
    identity.architecture !== 'arm64'
  ) fail('desktop app identity does not match the release record');
}

function runtimeIdentity(runtimeNode) {
  let value;
  try {
    value = JSON.parse(
      run(
        runtimeNode,
        ['-p', 'JSON.stringify({version:process.version,platform:process.platform,architecture:process.arch})'],
        'Node runtime identity cannot be read',
      ),
    );
  } catch {
    fail('Node runtime identity is invalid');
  }
  if (
    value.version !== 'v22.22.1' ||
    value.platform !== 'darwin' ||
    value.architecture !== 'arm64'
  ) fail('Node runtime must be v22.22.1 for macOS arm64');
  return value;
}

function usage() {
  return 'usage: create-person-onboarding-kit.mjs --release <canonical-release.json> --artifact <exact-client.tgz> --app <ECHO.app.zip> [--runtime-node <node>] --output <new-kit.tar.gz>';
}

function main(argv) {
  let releasePath = '';
  let artifactPath = '';
  let appPath = '';
  let runtimeNode = process.execPath;
  let outputPath = '';
  while (argv.length > 0) {
    const option = argv.shift();
    const value = argv.shift();
    if (typeof value !== 'string') fail(usage());
    if (option === '--release') releasePath = resolve(value);
    else if (option === '--artifact') artifactPath = resolve(value);
    else if (option === '--app') appPath = resolve(value);
    else if (option === '--runtime-node') runtimeNode = resolve(value);
    else if (option === '--output') outputPath = resolve(value);
    else fail(usage());
  }
  if (!releasePath || !artifactPath || !appPath || !outputPath || !outputPath.endsWith('.tar.gz')) fail(usage());
  regularFile(releasePath, 'release record');
  regularFile(artifactPath, 'client artifact');
  regularFile(appPath, 'desktop app archive');
  regularFile(runtimeNode, 'Node runtime', true);
  regularFile(releaseValidator, 'release validator');
  regularFile(verifier, 'kit verifier');
  regularFile(starter, 'kit starter');
  const outputParent = privateCanonicalOutputDirectory(dirname(outputPath));
  const digestPath = `${outputPath}.sha256`;
  absentPath(outputPath, 'output kit');
  absentPath(digestPath, 'output kit digest');

  const release = parseCanonicalRelease(releasePath);
  if (sha256(artifactPath) !== release.person_client.artifact_sha256) {
    fail('client artifact SHA-256 does not match the release record');
  }
  verifyArtifactIdentity(artifactPath, release);
  verifyOverlayIdentity(appPath, release);
  const runtime = runtimeIdentity(runtimeNode);
  const manifest = {
    schema_version: 1,
    kind: 'echo-person-onboarding-kit-v1',
    release_id: release.release_id,
    source_sha: release.source_sha,
    release_record_sha256: sha256(releasePath),
    person_client_artifact_sha256: sha256(artifactPath),
    desktop_app_archive_sha256: sha256(appPath),
    runtime: {
      version: runtime.version,
      platform: runtime.platform,
      architecture: runtime.architecture,
      node_sha256: sha256(runtimeNode),
    },
  };

  const stagingParent = mkdtempSync(join(outputParent, '.echo-person-onboarding-kit-'));
  chmodSync(stagingParent, 0o700);
  const kitName = `echo-person-onboarding-${release.release_id}`;
  const kitRoot = join(stagingParent, kitName);
  const pendingKit = join(stagingParent, 'kit.tar.gz');
  const pendingDigest = join(stagingParent, 'kit.tar.gz.sha256');
  try {
    mkdirSync(kitRoot, { mode: 0o700 });
    copyFileSync(starter, join(kitRoot, 'Start ECHO.command'));
    copyFileSync(releasePath, join(kitRoot, 'release.json'));
    copyFileSync(artifactPath, join(kitRoot, 'person-client.tgz'));
    copyFileSync(appPath, join(kitRoot, 'ECHO.app.zip'));
    copyFileSync(runtimeNode, join(kitRoot, 'node'));
    copyFileSync(releaseValidator, join(kitRoot, 'clean-v1-release.mjs'));
    copyFileSync(verifier, join(kitRoot, 'verify-person-onboarding-kit.mjs'));
    writeFileSync(join(kitRoot, 'kit-manifest.v1.json'), `${canonicalJson(manifest)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    for (const executable of [
      'Start ECHO.command',
      'node',
      'clean-v1-release.mjs',
      'verify-person-onboarding-kit.mjs',
    ]) chmodSync(join(kitRoot, executable), 0o755);
    for (const privateFile of ['release.json', 'person-client.tgz', 'ECHO.app.zip', 'kit-manifest.v1.json']) {
      chmodSync(join(kitRoot, privateFile), 0o600);
    }
    run('tar', ['-czf', pendingKit, '-C', stagingParent, kitName], 'could not create onboarding kit');
    chmodSync(pendingKit, 0o600);
    const kitSha256 = sha256(pendingKit);
    writeFileSync(pendingDigest, `${kitSha256}  ${basename(outputPath)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    publishNoReplace(pendingDigest, digestPath, 'output kit digest');
    publishNoReplace(pendingKit, outputPath, 'output kit');
    process.stdout.write(`${JSON.stringify({
      kit_path: outputPath,
      kit_sha256: kitSha256,
      kit_sha256_path: digestPath,
      release_id: release.release_id,
      source_sha: release.source_sha,
      client_version: release.person_client.version,
      platform: runtime.platform,
      architecture: runtime.architecture,
      node_version: runtime.version,
      contents: [
        `${kitName}/Start ECHO.command`,
        `${kitName}/release.json`,
        `${kitName}/kit-manifest.v1.json`,
        `${kitName}/person-client.tgz`,
        `${kitName}/ECHO.app.zip`,
        `${kitName}/node`,
        `${kitName}/clean-v1-release.mjs`,
        `${kitName}/verify-person-onboarding-kit.mjs`,
      ],
    })}\n`);
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
