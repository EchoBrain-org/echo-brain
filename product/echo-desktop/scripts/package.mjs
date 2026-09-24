#!/usr/bin/env node
// Packages ECHO from a clean commit: the person client packed exactly as the
// kit ships it, release bundles with the test hook compiled out, then
// electron-builder. Prints where the app is.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '..', '..');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

if (run('git', ['status', '--porcelain'], repository).trim() !== '' && !process.argv.includes('--allow-dirty')) {
  console.error('Refusing to package: commit your changes first (or pass --allow-dirty for a local try).');
  process.exit(1);
}

const packed = mkdtempSync(join(tmpdir(), 'echo-person-client-'));
try {
  const result = JSON.parse(run('node', ['tools/pack-person-client.mjs', packed], repository).trim().split('\n').pop());
  run('node', ['scripts/build.mjs', '--release']);
  const target = join(root, 'build', 'person-client');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  run('tar', ['-xzf', result.artifact_path, '-C', target]);
  rmSync(join(root, 'dist-app'), { recursive: true, force: true });
  execFileSync('npx', ['electron-builder', '--config', 'electron-builder.config.cjs', '--mac', '--arm64', '--publish', 'never'], { cwd: root, stdio: 'inherit' });
  console.log(JSON.stringify({ app: join(root, 'dist-app', 'mac-arm64', 'ECHO.app'), person_client: result.source_sha }));
} finally {
  rmSync(packed, { recursive: true, force: true });
}
