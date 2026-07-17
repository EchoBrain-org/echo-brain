#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import process from 'node:process';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist');

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

const compiled = spawnSync(process.execPath, [tsc, '-p', join(repo, 'tsconfig.build.json')], {
  cwd: repo,
  encoding: 'utf8',
});
if (compiled.status !== 0) {
  process.stdout.write(compiled.stdout);
  process.stderr.write(compiled.stderr);
  process.exit(compiled.status ?? 1);
}

cpSync(join(repo, 'src', 'storage', 'migrations'), join(dist, 'storage', 'migrations'), {
  recursive: true,
});
chmodSync(join(dist, 'product', 'cli.js'), 0o755);

