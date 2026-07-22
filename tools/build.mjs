#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import process from 'node:process';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist');

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'git failed\n');
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function clean() {
  rmSync(dist, { recursive: true, force: true });
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

clean();

const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  process.stderr.write('TypeScript is not installed; run npm ci first.\n');
  process.exit(1);
}

const workspacesCompiled = spawnSync(
  process.execPath,
  [
    tsc,
    '-b',
    join(repo, 'packages', 'federation-protocol'),
    join(repo, 'packages', 'organization-protocol'),
    join(repo, 'packages', 'organization-api'),
  ],
  {
    cwd: repo,
    encoding: 'utf8',
  },
);
if (workspacesCompiled.status !== 0) {
  process.stdout.write(workspacesCompiled.stdout);
  process.stderr.write(workspacesCompiled.stderr);
  process.exit(workspacesCompiled.status ?? 1);
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
  process.exit(compiled.status ?? 1);
}

cpSync(
  join(repo, 'src', 'product', 'storage', 'migrations'),
  join(dist, 'product', 'storage', 'migrations'),
  { recursive: true },
);
cpSync(
  join(repo, 'src', 'experimental', 'n2', 'authority', 'migrations'),
  join(dist, 'experimental', 'n2', 'authority', 'migrations'),
  { recursive: true },
);
cpSync(
  join(
    repo,
    'src',
    'experimental',
    'n2',
    'organization',
    'organization-sync-schema.sql',
  ),
  join(
    dist,
    'experimental',
    'n2',
    'organization',
    'organization-sync-schema.sql',
  ),
);
cpSync(
  join(repo, 'src', 'experimental', 'n2', 'schemas'),
  join(dist, 'experimental', 'n2', 'schemas'),
  { recursive: true },
);
const packageVersion = JSON.parse(
  readFileSync(join(repo, 'package.json'), 'utf8'),
).version;
const sourceSha = gitOutput(['rev-parse', 'HEAD']).toLowerCase();
if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
  process.stderr.write('git did not return a full lowercase source SHA\n');
  process.exit(1);
}
writeFileSync(
  join(dist, 'product', 'build-identity.v1.json'),
  `${JSON.stringify({
    schema_version: 1,
    kind: 'echo-packaged-build-identity',
    product_version: packageVersion,
    source_sha: sourceSha,
    source_kind: 'worktree-head-unverified',
  })}\n`,
);
chmodSync(join(dist, 'product', 'cli.js'), 0o755);
