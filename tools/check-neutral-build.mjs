#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const fixture = mkdtempSync(join(tmpdir(), 'echo-neutral-build-'));
try {
  const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const workspaces = root.workspaces.filter(path => path.startsWith('packages/'));
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', workspaces }));
  for (const file of readdirSync(repo).filter(path => /^tsconfig.*\.json$/.test(path))) {
    cpSync(join(repo, file), join(fixture, file));
  }
  for (const workspace of workspaces) {
    cpSync(join(repo, workspace), join(fixture, workspace), {
      recursive: true,
      filter: path => !/(?:^|\/)(?:dist|node_modules|test)(?:\/|$)/.test(path),
    });
  }
  // Link installed external dependencies only. Every workspace resolves into
  // this fixture; none can escape through the original workspace symlinks.
  const modules = join(fixture, 'node_modules');
  mkdirSync(join(modules, '@echo-brain'), { recursive: true });
  for (const entry of readdirSync(join(repo, 'node_modules'))) {
    if (entry === '@echo-brain') continue;
    symlinkSync(join(repo, 'node_modules', entry), join(modules, entry));
  }
  for (const workspace of workspaces) {
    const pkg = JSON.parse(readFileSync(join(fixture, workspace, 'package.json'), 'utf8'));
    symlinkSync(join(fixture, workspace), join(modules, pkg.name));
  }
  const result = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-b', ...workspaces], {
    cwd: fixture, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  process.stdout.write(JSON.stringify({ ok: true, neutral_workspaces: workspaces.length, provider_workspaces: 0, service_workspaces: 0, prebuilt_workspace_outputs: 0 }) + '\n');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
