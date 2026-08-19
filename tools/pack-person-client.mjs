#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const repo = resolve(import.meta.dirname, '..');
const clientRoot = join(repo, 'src', 'product', 'person-client');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'git failed');
  return result.stdout.trim();
}

function runCleanBuild() {
  const result = spawnSync(
    process.execPath,
    [join(repo, 'tools', 'build.mjs')],
    {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || 'clean build failed',
    );
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function npmPack(stagingRoot, destination) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath === undefined ? 'npm' : process.execPath;
  const args = [
    ...(npmExecPath === undefined ? [] : [npmExecPath]),
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
  ];
  const result = spawnSync(command, args, {
    cwd: stagingRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || 'npm pack failed',
    );
  }
  const packed = JSON.parse(result.stdout);
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error('npm pack returned an unsupported result');
  }
  return packed[0];
}

function main() {
  const destination = resolve(process.argv[2] ?? process.cwd());
  if (!lstatSync(destination).isDirectory()) {
    throw new Error('Person-client pack destination must be a directory');
  }

  const sourceSha = gitOutput(['rev-parse', 'HEAD']).toLowerCase();
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) !== '') {
    throw new Error('Person-client artifact requires clean, committed source');
  }

  const clientManifest = readJson(join(clientRoot, 'package.json'));
  const filename = `${clientManifest.name
    .replace(/^@/, '')
    .replace('/', '-')}-${clientManifest.version}.tgz`;
  const artifactPath = join(destination, filename);
  if (existsSync(artifactPath)) {
    throw new Error(`Person-client artifact already exists: ${artifactPath}`);
  }

  runCleanBuild();
  const identity = readJson(join(clientRoot, 'dist', 'build-identity.v1.json'));
  if (
    identity.kind !== 'echo-packaged-build-identity' ||
    identity.product_version !== clientManifest.version ||
    identity.source_kind !== 'materialized-commit' ||
    identity.source_sha !== sourceSha ||
    gitOutput(['rev-parse', 'HEAD']).toLowerCase() !== sourceSha ||
    gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) !== ''
  ) {
    throw new Error('Person-client clean build provenance is invalid');
  }

  const rootManifest = readJson(join(repo, 'package.json'));
  const workspaceByName = new Map(
    rootManifest.workspaces.map((workspacePath) => {
      const manifest = readJson(join(repo, workspacePath, 'package.json'));
      return [manifest.name, workspacePath];
    }),
  );
  const bundled = [...clientManifest.bundleDependencies];
  const stagingParent = mkdtempSync(join(tmpdir(), 'echo-person-client-pack-'));
  chmodSync(stagingParent, 0o700);
  const stagingRoot = join(stagingParent, 'package');

  try {
    mkdirSync(join(stagingRoot, 'node_modules'), { recursive: true });
    cpSync(join(clientRoot, 'package.json'), join(stagingRoot, 'package.json'));
    cpSync(join(clientRoot, 'dist'), join(stagingRoot, 'dist'), {
      recursive: true,
    });
    rmSync(join(stagingRoot, 'dist', '.tsbuildinfo'), { force: true });
    for (const packageName of bundled) {
      const workspacePath = workspaceByName.get(packageName);
      if (workspacePath === undefined) {
        throw new Error(`Bundled dependency is not a workspace: ${packageName}`);
      }
      const dependencyRoot = join(repo, workspacePath);
      const destinationRoot = join(stagingRoot, 'node_modules', packageName);
      mkdirSync(destinationRoot, { recursive: true });
      cpSync(
        join(dependencyRoot, 'package.json'),
        join(destinationRoot, 'package.json'),
      );
      cpSync(join(dependencyRoot, 'dist'), join(destinationRoot, 'dist'), {
        recursive: true,
      });
      rmSync(join(destinationRoot, 'dist', '.tsbuildinfo'), { force: true });
    }

    const packed = npmPack(stagingRoot, destination);
    const actualBundled = [...(packed.bundled ?? [])].sort();
    const expectedBundled = [...bundled].sort();
    if (JSON.stringify(actualBundled) !== JSON.stringify(expectedBundled)) {
      rmSync(join(destination, packed.filename), { force: true });
      throw new Error(
        'Person-client artifact did not contain its bundled dependencies',
      );
    }
    const packedArtifactPath = join(destination, basename(packed.filename));
    process.stdout.write(
      `${JSON.stringify({
        artifact_path: packedArtifactPath,
        artifact_sha256: sha256File(packedArtifactPath),
        package: packed.name,
        version: packed.version,
        source_sha: sourceSha,
        bundled: actualBundled,
      })}\n`,
    );
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
