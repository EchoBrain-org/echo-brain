#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MANIFEST_FILENAME = 'internal-live-release-manifest.v1.json';
const CHECKSUM_FILENAME = 'SHA256SUMS';
const RELEASE_KIND = 'echo-internal-live-release';
const RELEASE_CHANNEL = 'internal-live';
const WORKFLOW_FILENAME = 'internal-live-release.yml';
const INTERNAL_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-internal\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const DECIMAL_ID = /^[1-9]\d*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/;
const RUNTIME_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const MAX_PACKAGE_FILES = 4_096;
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has unexpected fields: ${actual.join(', ')}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function runtimeVersion(value, label) {
  if (typeof value !== 'string' || !RUNTIME_VERSION.test(value)) {
    fail(`${label} must be one exact X.Y.Z version`);
  }
  return value;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseInternalVersion(value) {
  if (typeof value !== 'string' || !INTERNAL_VERSION.test(value)) {
    fail(
      'release version must use exact MAJOR.MINOR.PATCH-internal.SEQUENCE form',
    );
  }
  return value;
}

function internalVersionTuple(value) {
  parseInternalVersion(value);
  const match = INTERNAL_VERSION.exec(value);
  if (match === null) fail('release version could not be parsed');
  return match.slice(1).map((component) => BigInt(component));
}

function compareInternalVersions(left, right) {
  const leftTuple = internalVersionTuple(left);
  const rightTuple = internalVersionTuple(right);
  for (let index = 0; index < leftTuple.length; index += 1) {
    if (leftTuple[index] !== rightTuple[index]) {
      return leftTuple[index] < rightTuple[index] ? -1 : 1;
    }
  }
  return 0;
}

function assertMonotonicVersion(options) {
  const releaseVersion = parseInternalVersion(
    requiredOption(options, 'release-version'),
  );
  const existingTagsPath = resolve(
    requiredOption(options, 'existing-tags-file'),
  );
  assertRegularFile(existingTagsPath, 'existing tag list');
  const tags = readFileSync(existingTagsPath, 'utf8')
    .split('\n')
    .filter((value) => value.length > 0);
  const versions = tags.map((tag) => {
    if (!tag.startsWith('internal-v')) {
      fail(`existing tag is outside the INTERNAL LIVE namespace: ${tag}`);
    }
    return parseInternalVersion(tag.slice('internal-v'.length));
  });
  const latest = versions.reduce(
    (current, candidate) =>
      current === undefined || compareInternalVersions(candidate, current) > 0
        ? candidate
        : current,
    undefined,
  );
  if (
    latest !== undefined &&
    compareInternalVersions(releaseVersion, latest) <= 0
  ) {
    fail(
      `release version ${releaseVersion} must be greater than existing INTERNAL LIVE version ${latest}`,
    );
  }
  return {
    release_version: releaseVersion,
    compared_versions: versions.length,
  };
}

function parseSourceSha(value) {
  if (!SOURCE_SHA.test(value)) {
    fail('source SHA must be a full lowercase Git commit SHA');
  }
  return value;
}

function parseRepository(value) {
  if (!REPOSITORY.test(value)) {
    fail('repository must have GitHub owner/name form');
  }
  return value;
}

function parseRunId(value) {
  if (!DECIMAL_ID.test(value)) {
    fail('workflow run ID must be a non-empty positive decimal string');
  }
  return value;
}

function parseRunAttempt(value) {
  if (!DECIMAL_ID.test(value)) {
    fail('workflow run attempt must be a positive integer');
  }
  return positiveSafeInteger(Number(value), 'workflow run attempt');
}

function parseOptions(values, allowed) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      fail('options must use --name value pairs');
    }
    const name = key.slice(2);
    if (!allowed.has(name)) fail(`unknown option: --${name}`);
    if (result.has(name)) fail(`duplicate option: --${name}`);
    result.set(name, value);
  }
  return result;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (value === undefined) fail(`missing required option: --${name}`);
  return value;
}

function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

function readArchiveJson(archivePath, archiveEntry, label) {
  const bytes = readArchiveBytes(archivePath, archiveEntry, label);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readArchiveBytes(archivePath, archiveEntry, label) {
  const extracted = spawnSync(
    'tar',
    ['-xOzf', archivePath, archiveEntry],
    {
      encoding: null,
      maxBuffer: MAX_PACKAGE_FILE_BYTES,
    },
  );
  if (extracted.status !== 0) {
    fail(
      `${label} is missing from the package: ${extracted.stderr.toString('utf8').trim() || 'tar failed'}`,
    );
  }
  return extracted.stdout;
}

function safeEvidencePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    value === 'dist/package-artifact-evidence.v1.json'
  ) {
    fail(`${label} is unsafe or reserved`);
  }
  return value;
}

function archiveEntries(artifactPath) {
  const listed = spawnSync('tar', ['-tzf', artifactPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const verbose = spawnSync('tar', ['-tvzf', artifactPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0 || verbose.status !== 0) {
    fail('artifact archive could not be inspected');
  }
  const names = listed.stdout.trimEnd().split('\n').filter(Boolean);
  const detail = verbose.stdout.trimEnd().split('\n').filter(Boolean);
  if (
    names.length === 0 ||
    names.length !== detail.length ||
    names.length > MAX_PACKAGE_FILES * 2
  ) {
    fail('artifact archive has an unsupported entry set');
  }
  const files = [];
  const seen = new Set();
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const type = detail[index]?.[0];
    if (
      name === undefined ||
      !name.startsWith('package/') ||
      name.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      name.split('/').some((part) => part === '.' || part === '..') ||
      seen.has(name)
    ) {
      fail('artifact archive contains an unsafe or duplicate entry');
    }
    seen.add(name);
    if (name.endsWith('/')) {
      if (type !== 'd') fail('artifact archive directory has an invalid type');
      continue;
    }
    if (type !== '-') {
      fail('artifact archive may contain only regular files and directories');
    }
    files.push(name);
  }
  return files;
}

function validateEvidenceFiles(artifactPath, files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_PACKAGE_FILES) {
    fail('embedded package evidence must contain a bounded non-empty file set');
  }
  const validated = files.map((candidate, index) => {
    const label = `embedded package evidence file ${index}`;
    exactKeys(candidate, ['path', 'size', 'sha256'], label);
    const path = safeEvidencePath(candidate.path, `${label} path`);
    if (
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0 ||
      candidate.size > MAX_PACKAGE_FILE_BYTES ||
      typeof candidate.sha256 !== 'string' ||
      !SHA256.test(candidate.sha256)
    ) {
      fail(`${label} has invalid size or digest`);
    }
    return { path, size: candidate.size, sha256: candidate.sha256 };
  });
  const sorted = [...validated].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  if (
    validated.some((entry, index) => entry.path !== sorted[index]?.path) ||
    new Set(validated.map((entry) => entry.path)).size !== validated.length
  ) {
    fail('embedded package evidence files must be unique and byte-sorted');
  }
  for (const expected of validated) {
    const bytes = readArchiveBytes(
      artifactPath,
      `package/${expected.path}`,
      `package/${expected.path}`,
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== expected.size || digest !== expected.sha256) {
      fail(`package evidence does not match artifact bytes: ${expected.path}`);
    }
  }
  const expectedArchiveFiles = [
    ...validated.map((entry) => `package/${entry.path}`),
    'package/dist/package-artifact-evidence.v1.json',
  ].sort();
  const actualArchiveFiles = archiveEntries(artifactPath).sort();
  if (JSON.stringify(actualArchiveFiles) !== JSON.stringify(expectedArchiveFiles)) {
    fail('artifact file set does not match embedded package evidence');
  }
}

function validateEmbeddedEvidence(artifactPath, expected) {
  const packageManifest = readArchiveJson(
    artifactPath,
    'package/package.json',
    'package.json',
  );
  if (!isRecord(packageManifest)) fail('package.json must be an object');
  if (packageManifest.name !== expected.packageName) {
    fail('package.json name does not match the release manifest');
  }
  if (packageManifest.version !== expected.releaseVersion) {
    fail('package.json version does not match the release version');
  }
  if (!isRecord(packageManifest.engines)) {
    fail('package.json engines must be an object');
  }
  if (packageManifest.engines.node !== expected.nodeVersion) {
    fail('package.json Node version does not match the release manifest');
  }
  if (packageManifest.engines.npm !== expected.npmVersion) {
    fail('package.json npm version does not match the release manifest');
  }

  const identity = readArchiveJson(
    artifactPath,
    'package/dist/product/build-identity.v1.json',
    'embedded build identity',
  );
  exactKeys(
    identity,
    ['schema_version', 'kind', 'product_version', 'source_sha', 'source_kind'],
    'embedded build identity',
  );
  if (
    identity.schema_version !== 1 ||
    identity.kind !== 'echo-packaged-build-identity' ||
    identity.product_version !== expected.releaseVersion ||
    identity.source_sha !== expected.sourceSha ||
    identity.source_kind !== 'materialized-commit'
  ) {
    fail('embedded build identity does not match the materialized release source');
  }

  const evidence = readArchiveJson(
    artifactPath,
    'package/dist/package-artifact-evidence.v1.json',
    'embedded package evidence',
  );
  exactKeys(
    evidence,
    ['schema_version', 'kind', 'package', 'version', 'source_sha', 'files'],
    'embedded package evidence',
  );
  if (
    evidence.schema_version !== 1 ||
    evidence.kind !== 'echo-package-artifact-evidence' ||
    evidence.package !== expected.packageName ||
    evidence.version !== expected.releaseVersion ||
    evidence.source_sha !== expected.sourceSha ||
    !Array.isArray(evidence.files)
  ) {
    fail('embedded package evidence does not match the release source');
  }
  validateEvidenceFiles(artifactPath, evidence.files);
}

function releaseTag(releaseVersion) {
  return `internal-v${releaseVersion}`;
}

function downloadUrl(repository, tag, filename) {
  const encodedTag = tag.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repository}/releases/download/${encodedTag}/${encodeURIComponent(filename)}`;
}

function validateManifest(value, expected) {
  exactKeys(
    value,
    [
      'schema_version',
      'kind',
      'channel',
      'release_version',
      'release_tag',
      'source',
      'artifact',
      'compatibility',
      'build',
    ],
    'release manifest',
  );
  exactKeys(value.source, ['sha', 'kind'], 'release manifest source');
  exactKeys(
    value.artifact,
    ['package', 'filename', 'download_url', 'size_bytes', 'sha256'],
    'release manifest artifact',
  );
  exactKeys(
    value.compatibility,
    ['os', 'arch', 'node', 'npm'],
    'release manifest compatibility',
  );
  exactKeys(
    value.build,
    ['repository', 'workflow', 'run_id', 'run_attempt'],
    'release manifest build',
  );

  if (
    value.schema_version !== 1 ||
    value.kind !== RELEASE_KIND ||
    value.channel !== RELEASE_CHANNEL
  ) {
    fail('release manifest identity is invalid');
  }
  parseInternalVersion(nonEmptyString(value.release_version, 'release version'));
  parseSourceSha(nonEmptyString(value.source.sha, 'source SHA'));
  if (value.source.kind !== 'materialized-commit') {
    fail('release manifest source must be a materialized commit');
  }
  if (value.release_tag !== releaseTag(value.release_version)) {
    fail('release tag does not match the release version');
  }

  const packageName = nonEmptyString(value.artifact.package, 'artifact package');
  const filename = nonEmptyString(value.artifact.filename, 'artifact filename');
  if (basename(filename) !== filename || !SAFE_ARCHIVE_NAME.test(filename)) {
    fail('artifact filename is unsafe');
  }
  positiveSafeInteger(value.artifact.size_bytes, 'artifact size');
  if (!SHA256.test(value.artifact.sha256)) {
    fail('artifact SHA-256 must be 64 lowercase hexadecimal characters');
  }

  const repository = parseRepository(
    nonEmptyString(value.build.repository, 'build repository'),
  );
  if (value.build.workflow !== WORKFLOW_FILENAME) {
    fail('build workflow identity is invalid');
  }
  parseRunId(nonEmptyString(value.build.run_id, 'workflow run ID'));
  positiveSafeInteger(value.build.run_attempt, 'workflow run attempt');
  if (
    value.artifact.download_url !==
    downloadUrl(repository, value.release_tag, filename)
  ) {
    fail('artifact download URL does not match repository, tag, and filename');
  }
  if (value.compatibility.os !== 'darwin' || value.compatibility.arch !== 'arm64') {
    fail('minimum INTERNAL LIVE supports only darwin/arm64');
  }
  runtimeVersion(value.compatibility.node, 'compatible Node version');
  runtimeVersion(value.compatibility.npm, 'compatible npm version');

  if (value.release_version !== expected.releaseVersion) {
    fail('release manifest version does not match the requested version');
  }
  if (value.source.sha !== expected.sourceSha) {
    fail('release manifest source SHA does not match the requested source');
  }
  if (repository !== expected.repository) {
    fail('release manifest repository does not match the requested repository');
  }
  if (value.build.run_id !== expected.runId) {
    fail('release manifest run ID does not match the requested workflow run');
  }
  if (value.build.run_attempt !== expected.runAttempt) {
    fail('release manifest run attempt does not match the requested workflow run');
  }

  return {
    packageName,
    filename,
    nodeVersion: value.compatibility.node,
    npmVersion: value.compatibility.npm,
  };
}

function assertRegularFile(path, label) {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
  return state;
}

function createBundle(options) {
  const artifactPath = resolve(requiredOption(options, 'artifact'));
  const outputDirectory = resolve(requiredOption(options, 'output-dir'));
  const releaseVersion = parseInternalVersion(
    requiredOption(options, 'release-version'),
  );
  const sourceSha = parseSourceSha(requiredOption(options, 'source-sha'));
  const repository = parseRepository(requiredOption(options, 'repository'));
  const runId = parseRunId(requiredOption(options, 'workflow-run-id'));
  const runAttempt = parseRunAttempt(
    requiredOption(options, 'workflow-run-attempt'),
  );
  if (dirname(artifactPath) !== outputDirectory) {
    fail('artifact must already be directly inside the output directory');
  }
  const filename = basename(artifactPath);
  if (!SAFE_ARCHIVE_NAME.test(filename)) fail('artifact filename is unsafe');
  const artifactState = assertRegularFile(artifactPath, 'artifact');

  const packageManifest = readArchiveJson(
    artifactPath,
    'package/package.json',
    'package.json',
  );
  if (!isRecord(packageManifest) || packageManifest.name !== 'echo-brain') {
    fail('artifact must contain the echo-brain package');
  }
  if (packageManifest.version !== releaseVersion) {
    fail('artifact package version does not match the requested release version');
  }
  if (!isRecord(packageManifest.engines)) {
    fail('artifact package must declare Node and npm engines');
  }
  const nodeVersion = runtimeVersion(packageManifest.engines.node, 'Node engine');
  const npmVersion = runtimeVersion(packageManifest.engines.npm, 'npm engine');

  validateEmbeddedEvidence(artifactPath, {
    packageName: packageManifest.name,
    releaseVersion,
    sourceSha,
    nodeVersion,
    npmVersion,
  });

  const tag = releaseTag(releaseVersion);
  const manifest = {
    schema_version: 1,
    kind: RELEASE_KIND,
    channel: RELEASE_CHANNEL,
    release_version: releaseVersion,
    release_tag: tag,
    source: {
      sha: sourceSha,
      kind: 'materialized-commit',
    },
    artifact: {
      package: packageManifest.name,
      filename,
      download_url: downloadUrl(repository, tag, filename),
      size_bytes: artifactState.size,
      sha256: sha256File(artifactPath),
    },
    compatibility: {
      os: 'darwin',
      arch: 'arm64',
      node: nodeVersion,
      npm: npmVersion,
    },
    build: {
      repository,
      workflow: WORKFLOW_FILENAME,
      run_id: runId,
      run_attempt: runAttempt,
    },
  };
  validateManifest(manifest, {
    releaseVersion,
    sourceSha,
    repository,
    runId,
    runAttempt,
  });

  const manifestPath = join(outputDirectory, MANIFEST_FILENAME);
  const checksumPath = join(outputDirectory, CHECKSUM_FILENAME);
  let manifestHandle;
  let checksumHandle;
  try {
    manifestHandle = openSync(manifestPath, 'wx', 0o644);
    checksumHandle = openSync(checksumPath, 'wx', 0o644);
    writeFileSync(manifestHandle, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      checksumHandle,
      `${manifest.artifact.sha256}  ${manifest.artifact.filename}\n`,
    );
  } finally {
    if (manifestHandle !== undefined) closeSync(manifestHandle);
    if (checksumHandle !== undefined) closeSync(checksumHandle);
  }
  return manifest;
}

function verifyBundle(options) {
  const bundleDirectory = resolve(requiredOption(options, 'bundle-dir'));
  const expected = {
    releaseVersion: parseInternalVersion(
      requiredOption(options, 'release-version'),
    ),
    sourceSha: parseSourceSha(requiredOption(options, 'source-sha')),
    repository: parseRepository(requiredOption(options, 'repository')),
    runId: parseRunId(requiredOption(options, 'workflow-run-id')),
    runAttempt: parseRunAttempt(requiredOption(options, 'workflow-run-attempt')),
  };
  const entries = readdirSync(bundleDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail('release bundle may contain only regular files');
  }
  const names = entries.map((entry) => entry.name).sort();
  const archives = names.filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) {
    fail('release bundle must contain exactly one tgz artifact');
  }
  const expectedNames = [CHECKSUM_FILENAME, MANIFEST_FILENAME, archives[0]].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail('release bundle contains unexpected files');
  }

  const manifestPath = join(bundleDirectory, MANIFEST_FILENAME);
  const checksumPath = join(bundleDirectory, CHECKSUM_FILENAME);
  assertRegularFile(manifestPath, 'release manifest');
  assertRegularFile(checksumPath, 'checksum file');
  const manifest = readJson(manifestPath, 'release manifest');
  const validated = validateManifest(manifest, expected);
  if (validated.filename !== archives[0]) {
    fail('release manifest names a different artifact');
  }
  const artifactPath = join(bundleDirectory, validated.filename);
  const artifactState = assertRegularFile(artifactPath, 'artifact');
  const actualSha256 = sha256File(artifactPath);
  if (
    artifactState.size !== manifest.artifact.size_bytes ||
    actualSha256 !== manifest.artifact.sha256
  ) {
    fail('artifact bytes do not match the release manifest');
  }
  const expectedChecksum = `${actualSha256}  ${validated.filename}\n`;
  if (readFileSync(checksumPath, 'utf8') !== expectedChecksum) {
    fail('SHA256SUMS does not exactly match the release artifact');
  }
  validateEmbeddedEvidence(artifactPath, {
    packageName: validated.packageName,
    releaseVersion: expected.releaseVersion,
    sourceSha: expected.sourceSha,
    nodeVersion: validated.nodeVersion,
    npmVersion: validated.npmVersion,
  });
  return manifest;
}

function main(argv) {
  const [command, ...optionValues] = argv;
  const common = new Set([
    'release-version',
    'source-sha',
    'repository',
    'workflow-run-id',
    'workflow-run-attempt',
  ]);
  let result;
  if (command === 'create') {
    const manifest = createBundle(
      parseOptions(optionValues, new Set([...common, 'artifact', 'output-dir'])),
    );
    result = {
      ok: true,
      command,
      release_version: manifest.release_version,
      release_tag: manifest.release_tag,
      source_sha: manifest.source.sha,
      artifact_sha256: manifest.artifact.sha256,
    };
  } else if (command === 'verify') {
    const manifest = verifyBundle(
      parseOptions(optionValues, new Set([...common, 'bundle-dir'])),
    );
    result = {
      ok: true,
      command,
      release_version: manifest.release_version,
      release_tag: manifest.release_tag,
      source_sha: manifest.source.sha,
      artifact_sha256: manifest.artifact.sha256,
    };
  } else if (command === 'assert-monotonic') {
    const monotonic = assertMonotonicVersion(
      parseOptions(
        optionValues,
        new Set(['release-version', 'existing-tags-file']),
      ),
    );
    result = { ok: true, command, ...monotonic };
  } else {
    fail(
      'usage: internal-live-release.mjs <create|verify|assert-monotonic> [options]',
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export {
  CHECKSUM_FILENAME,
  MANIFEST_FILENAME,
  createBundle,
  verifyBundle,
};
