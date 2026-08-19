#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const repo = resolve(import.meta.dirname, '..');
const personClient = join(repo, 'src', 'product', 'person-client');
const compiledWorkspaces = [
  ['packages', 'federation-protocol'],
  ['packages', 'organization-protocol'],
  ['packages', 'organization-api'],
  ['services', 'organization-control-plane'],
  ['services', 'organization-record'],
  ['services', 'organization-retrieval'],
  ['services', 'organization-authority'],
  ['src', 'product', 'person-client'],
];
const personClientWorkspaces = [
  ['packages', 'federation-protocol'],
  ['packages', 'organization-protocol'],
  ['packages', 'organization-api'],
  ['src', 'product', 'person-client'],
];

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'git failed');
  return result.stdout.trim();
}

function repositorySource() {
  const sha = gitOutput(['rev-parse', 'HEAD']).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('git did not return a full lowercase source SHA');
  }
  return {
    sha,
    clean:
      gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) === '',
  };
}

function cleanBuildOutputs(workspaces = compiledWorkspaces) {
  rmSync(join(repo, 'dist'), { recursive: true, force: true });
  for (const workspace of workspaces) {
    rmSync(join(repo, ...workspace, 'dist'), { recursive: true, force: true });
  }
}

function writePersonBuildIdentity(source) {
  const manifest = JSON.parse(
    readFileSync(join(personClient, 'package.json'), 'utf8'),
  );
  writeFileSync(
    join(personClient, 'dist', 'build-identity.v1.json'),
    `${JSON.stringify({
      schema_version: 1,
      kind: 'echo-packaged-build-identity',
      product_version: manifest.version,
      source_sha: source.sha,
      source_kind: source.clean
        ? 'materialized-commit'
        : 'worktree-head-unverified',
    })}\n`,
  );
  chmodSync(join(personClient, 'dist', 'main.js'), 0o755);
}

function main() {
  if (process.argv.includes('--clean')) {
    cleanBuildOutputs();
    return;
  }

  const sourceBefore = repositorySource();
  const workspaces = process.argv.includes('--person-client')
    ? personClientWorkspaces
    : compiledWorkspaces;
  cleanBuildOutputs(workspaces);
  const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    throw new Error('TypeScript is not installed; run npm ci first.');
  }
  const compiled = spawnSync(
    process.execPath,
    [
      tsc,
      '-b',
      ...workspaces.map((workspace) => join(repo, ...workspace)),
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  if (compiled.status !== 0) {
    process.stdout.write(compiled.stdout);
    process.stderr.write(compiled.stderr);
    process.exitCode = compiled.status ?? 1;
    return;
  }

  const sourceAfter = repositorySource();
  writePersonBuildIdentity({
    sha: sourceBefore.sha,
    clean:
      sourceBefore.clean &&
      sourceAfter.clean &&
      sourceAfter.sha === sourceBefore.sha,
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
