#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safeRelativePath(path) {
  return (
    typeof path === 'string' &&
    path !== '' &&
    !path.includes('\\') &&
    !posix.isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  );
}

function directFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const state = lstatSync(path);
      if (state.isSymbolicLink()) {
        throw new Error(
          `support bundle contains a symlink: ${relative(root, path)}`,
        );
      }
      if (state.isDirectory()) visit(path);
      else if (state.isFile())
        files.push(relative(root, path).split(sep).join('/'));
      else
        throw new Error(
          `support bundle contains a non-file entry: ${relative(root, path)}`,
        );
    }
  }
  visit(root);
  return files.sort();
}

export function verifyBundle({ artifactDir, supportDir }) {
  const errors = [];
  const artifactManifestPath = join(artifactDir, 'artifact-manifest.json');
  const artifactManifest = readJson(artifactManifestPath);
  if (
    !safeRelativePath(artifactManifest.artifact?.path) ||
    artifactManifest.artifact.path.includes('/')
  ) {
    throw new Error('artifact manifest path must be one safe filename');
  }
  const artifactPath = join(artifactDir, artifactManifest.artifact.path);
  const checksumPath = `${artifactPath}.sha256`;
  const expectedArtifactPaths = [
    'artifact-manifest.json',
    artifactManifest.artifact.path,
    `${artifactManifest.artifact.path}.sha256`,
  ].sort();
  if (
    JSON.stringify(directFiles(artifactDir)) !==
    JSON.stringify(expectedArtifactPaths)
  ) {
    errors.push('artifact directory contains missing or unmanifested files');
  }
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    errors.push(`artifact is missing: ${artifactManifest.artifact.path}`);
  } else {
    if (statSync(artifactPath).size !== artifactManifest.artifact.size) {
      errors.push('artifact size mismatch');
    }
    if (sha256(artifactPath) !== artifactManifest.artifact.sha256) {
      errors.push('artifact SHA-256 mismatch');
    }
  }
  if (!existsSync(checksumPath)) {
    errors.push('artifact checksum sidecar is missing');
  } else if (
    readFileSync(checksumPath, 'utf8') !==
    `${artifactManifest.artifact.sha256}  ${artifactManifest.artifact.path}\n`
  ) {
    errors.push('artifact checksum sidecar mismatch');
  }

  const supportManifest = readJson(join(supportDir, 'support-manifest.json'));
  if (!Array.isArray(supportManifest.entries)) {
    throw new Error('support manifest entries must be an array');
  }
  const expectedSupportPaths = new Set();
  for (const entry of supportManifest.entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !safeRelativePath(entry.path) ||
      expectedSupportPaths.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error('support manifest contains an unsafe or duplicate entry');
    }
    expectedSupportPaths.add(entry.path);
    const path = join(supportDir, entry.path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      errors.push(`support entry is missing: ${entry.path}`);
    } else if (
      statSync(path).size !== entry.size ||
      sha256(path) !== entry.sha256
    ) {
      errors.push(`support entry hash mismatch: ${entry.path}`);
    }
  }
  const actualSupportPaths = directFiles(supportDir).filter(
    (path) => path !== 'support-manifest.json',
  );
  if (
    actualSupportPaths.length !== expectedSupportPaths.size ||
    actualSupportPaths.some((path) => !expectedSupportPaths.has(path))
  ) {
    errors.push('support bundle contains missing or unmanifested files');
  }
  if (
    supportManifest.dependency_lock_sha256 !==
    artifactManifest.dependency_lock_sha256
  ) {
    errors.push('artifact/support dependency-lock mismatch');
  }
  return {
    ok: errors.length === 0,
    errors: errors.sort(),
    artifact_manifest: artifactManifest,
    artifact_manifest_sha256: sha256(artifactManifestPath),
    support_manifest_sha256: sha256(join(supportDir, 'support-manifest.json')),
    artifact_path: artifactPath,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--artifact-dir', '--support-dir', '--output'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  for (const flag of ['artifact-dir', 'support-dir']) {
    if (!isAbsolute(args[flag] ?? ''))
      throw new Error(`--${flag} must be absolute`);
  }
  if (args.output !== undefined && !isAbsolute(args.output)) {
    throw new Error('--output must be absolute');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyBundle({
    artifactDir: resolve(args['artifact-dir']),
    supportDir: resolve(args['support-dir']),
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output === undefined) process.stdout.write(serialized);
  else writeFileSync(resolve(args.output), serialized);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`verify-bundle: ${error.message}\n`);
    process.exitCode = 1;
  }
}
