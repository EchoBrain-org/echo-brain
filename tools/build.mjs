#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist');
const ARTIFACT_EVIDENCE_FILE = 'package-artifact-evidence.v1.json';
const COMPILED_WORKSPACE_PATHS = [
  ['packages', 'federation-protocol'],
  ['packages', 'organization-protocol'],
  ['packages', 'organization-api'],
  ['services', 'organization-control-plane'],
  ['services', 'organization-record'],
  ['services', 'organization-retrieval'],
  ['services', 'organization-authority'],
  ['src', 'product', 'person-client'],
];

function gitOutput(args, cwd = repo) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'git failed');
  }
  return result.stdout.trim();
}

export function inspectRepositorySource(repository) {
  const sourceSha = gitOutput(['rev-parse', 'HEAD'], repository).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('git did not return a full lowercase source SHA');
  }
  const status = gitOutput(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    repository,
  );
  return {
    sourceSha,
    sourceKind:
      status.length === 0
        ? 'materialized-commit'
        : 'worktree-head-unverified',
  };
}

export function cleanBuildOutputs(repository) {
  rmSync(join(repository, 'dist'), { recursive: true, force: true });
  for (const workspacePath of COMPILED_WORKSPACE_PATHS) {
    rmSync(join(repository, ...workspacePath, 'dist'), {
      recursive: true,
      force: true,
    });
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function packedPackageFiles() {
  const packed = spawnSync(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (packed.status !== 0) {
    throw new Error(
      packed.stderr.trim() ||
        packed.stdout.trim() ||
        'npm pack --dry-run failed',
    );
  }
  const result = JSON.parse(packed.stdout);
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    !Array.isArray(result[0].files)
  ) {
    throw new Error('npm pack --dry-run returned an unsupported file list');
  }
  const paths = result[0].files.map((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.includes('\\') ||
      entry.path
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error('npm pack --dry-run returned an unsafe package path');
    }
    return entry.path;
  });
  paths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (
    paths.length === 0 ||
    paths.length > 4_096 ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error('npm pack --dry-run returned an invalid package file set');
  }
  return paths.map((packagePath) => {
    const sourcePath = join(repo, ...packagePath.split('/'));
    const state = lstatSync(sourcePath);
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new Error(`packed package input is not a file: ${packagePath}`);
    }
    return {
      path: packagePath,
      size: state.size,
      sha256: sha256File(sourcePath),
    };
  });
}

function writeBuildIdentity({
  buildIdentityPath,
  packageVersion,
  sourceSha,
  sourceKind,
}) {
  writeFileSync(
    buildIdentityPath,
    `${JSON.stringify({
      schema_version: 1,
      kind: 'echo-packaged-build-identity',
      product_version: packageVersion,
      source_sha: sourceSha,
      source_kind: sourceKind,
    })}\n`,
  );
}

function writeBuildEvidence({
  packageName,
  packageVersion,
  sourceSha,
  sourceKind,
}) {
  writeBuildIdentity({
    buildIdentityPath: join(dist, 'product', 'build-identity.v1.json'),
    packageVersion,
    sourceSha,
    sourceKind,
  });

  const manifestPath = join(dist, ARTIFACT_EVIDENCE_FILE);
  rmSync(manifestPath, { force: true });
  const files = packedPackageFiles();
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schema_version: 1,
      kind: 'echo-package-artifact-evidence',
      package: packageName,
      version: packageVersion,
      source_sha: sourceSha,
      files,
    })}\n`,
  );
}

function main() {
  if (process.argv.includes('--clean')) {
    cleanBuildOutputs(repo);
    return;
  }

  const sourceAtStart = inspectRepositorySource(repo);
  cleanBuildOutputs(repo);

  const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    throw new Error('TypeScript is not installed; run npm ci first.');
  }

  const workspacesCompiled = spawnSync(
    process.execPath,
    [
      tsc,
      '-b',
      ...COMPILED_WORKSPACE_PATHS.map((workspacePath) =>
        join(repo, ...workspacePath),
      ),
    ],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );
  if (workspacesCompiled.status !== 0) {
    process.stdout.write(workspacesCompiled.stdout);
    process.stderr.write(workspacesCompiled.stderr);
    process.exitCode = workspacesCompiled.status ?? 1;
    return;
  }

  const compiled = spawnSync(
    process.execPath,
    [tsc, '-p', join(repo, 'tsconfig.build.json')],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );
  if (compiled.status !== 0) {
    process.stdout.write(compiled.stdout);
    process.stderr.write(compiled.stderr);
    process.exitCode = compiled.status ?? 1;
    return;
  }

  cpSync(
    join(repo, 'src', 'product', 'storage', 'migrations'),
    join(dist, 'product', 'storage', 'migrations'),
    {
      recursive: true,
    },
  );
  chmodSync(join(dist, 'product', 'cli.js'), 0o755);
  chmodSync(
    join(repo, 'src', 'product', 'person-client', 'dist', 'main.js'),
    0o755,
  );

  const packageManifest = JSON.parse(
    readFileSync(join(repo, 'package.json'), 'utf8'),
  );
  const personClientManifest = JSON.parse(
    readFileSync(
      join(repo, 'src', 'product', 'person-client', 'package.json'),
      'utf8',
    ),
  );
  const sourceAfterBuild = inspectRepositorySource(repo);
  const sourceKind =
    sourceAtStart.sourceKind === 'materialized-commit' &&
    sourceAfterBuild.sourceKind === 'materialized-commit' &&
    sourceAfterBuild.sourceSha === sourceAtStart.sourceSha
      ? 'materialized-commit'
      : 'worktree-head-unverified';
  writeBuildIdentity({
    buildIdentityPath: join(
      repo,
      'src',
      'product',
      'person-client',
      'dist',
      'build-identity.v1.json',
    ),
    packageVersion: personClientManifest.version,
    sourceSha: sourceAtStart.sourceSha,
    sourceKind,
  });
  writeBuildEvidence({
    packageName: packageManifest.name,
    packageVersion: packageManifest.version,
    sourceSha: sourceAtStart.sourceSha,
    sourceKind,
  });

  // If the repository changed while the evidence files were being created,
  // regenerate them as explicitly unverified.
  const sourceAtEnd = inspectRepositorySource(repo);
  if (
    sourceKind === 'materialized-commit' &&
    (sourceAtEnd.sourceKind !== 'materialized-commit' ||
      sourceAtEnd.sourceSha !== sourceAtStart.sourceSha)
  ) {
    writeBuildIdentity({
      buildIdentityPath: join(
        repo,
        'src',
        'product',
        'person-client',
        'dist',
        'build-identity.v1.json',
      ),
      packageVersion: personClientManifest.version,
      sourceSha: sourceAtStart.sourceSha,
      sourceKind: 'worktree-head-unverified',
    });
    writeBuildEvidence({
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
      sourceSha: sourceAtStart.sourceSha,
      sourceKind: 'worktree-head-unverified',
    });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
