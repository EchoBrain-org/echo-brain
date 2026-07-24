// The Phase 5 rehearsal must be startable from a clean checkout. The ceremony
// driver loads workspace packages by bare specifier, and those specifiers
// resolve to compiled output the repository does not track, so every documented
// entry point has to build the workspace packages before the driver's module
// graph is loaded.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectExecutedModuleClosure } from '../../tools/lib/module-closure.mjs';
import { CEREMONY_ENTRY_POINTS } from '../../tools/phase5/run-one-machine.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const REHEARSAL_SCRIPT = 'organization:phase5-rehearse';
const REFERENCE_LANE = 'test:architecture';
const DRIVER_PATH = 'tools/phase5/run-one-machine.mjs';
const RUNBOOK_PATH = 'docs/runbooks/phase5-one-machine-rehearsal.md';
const BUILD_STEP = 'npm run build:workspaces';
const WORKSPACE_SPECIFIER = /from\s*["'](@echo-brain\/[^"']+)["']/g;
const SHELL_BLOCK = /```sh\n([\s\S]*?)```/g;

interface RootManifest {
  workspaces: string[];
  scripts: Record<string, string>;
}

interface WorkspaceManifest {
  name: string;
  main?: string;
  exports?: Record<string, { import?: string } | string>;
}

function repositoryFile(path: string): string {
  return readFileSync(join(REPO, path), 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(repositoryFile(path)) as T;
}

function commandSequence(script: string): string[] {
  return script
    .split('&&')
    .map((step) => step.trim())
    .filter((step) => step !== '');
}

function shellBlocks(markdown: string): string[] {
  return [...markdown.matchAll(SHELL_BLOCK)].map((match) => match[1]!);
}

// Every workspace package the ceremony entry points transitively load.
function ceremonyWorkspaceImports(): string[] {
  const closure = collectExecutedModuleClosure({
    projectRoot: REPO,
    entryPoints: CEREMONY_ENTRY_POINTS,
  });
  const specifiers = new Set<string>();
  for (const module of closure) {
    for (const match of repositoryFile(module).matchAll(WORKSPACE_SPECIFIER)) {
      specifiers.add(match[1]!.split('/').slice(0, 2).join('/'));
    }
  }
  return [...specifiers].sort();
}

function workspaceDirectories(): Map<string, string> {
  return new Map(
    readJson<RootManifest>('package.json').workspaces.map((directory) => [
      readJson<WorkspaceManifest>(posix.join(directory, 'package.json')).name,
      directory,
    ]),
  );
}

// The file a bare import of this workspace package resolves to.
function importEntry(directory: string): string | undefined {
  const manifest = readJson<WorkspaceManifest>(
    posix.join(directory, 'package.json'),
  );
  const exported = manifest.exports?.['.'];
  const declared =
    typeof exported === 'object' && exported !== null
      ? exported.import
      : undefined;
  const target = declared ?? manifest.main;
  return target === undefined ? undefined : posix.join(directory, target);
}

function isTracked(path: string): boolean {
  const listed = spawnSync('git', ['ls-files', '--', path], {
    cwd: REPO,
    encoding: 'utf8',
  });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.trim() !== '';
}

describe('phase 5 rehearsal entry points', () => {
  it('the ceremony driver loads a workspace package that only a build produces', () => {
    const specifiers = ceremonyWorkspaceImports();
    expect(specifiers).not.toEqual([]);
    const directories = workspaceDirectories();
    const unbuilt = specifiers.filter((specifier) => {
      const directory = directories.get(specifier);
      expect(directory, `${specifier} is not a declared workspace`).toBeTypeOf(
        'string',
      );
      const entry = importEntry(directory!);
      expect(entry, `${specifier} declares no import entry`).toBeTypeOf(
        'string',
      );
      return !isTracked(entry!);
    });
    expect(unbuilt).not.toEqual([]);
  });

  it('the rehearsal npm script builds the workspace packages before the driver runs', () => {
    const { scripts } = readJson<RootManifest>('package.json');
    const rehearsal = scripts[REHEARSAL_SCRIPT];
    expect(rehearsal, `${REHEARSAL_SCRIPT} is missing`).toBeTypeOf('string');
    const steps = commandSequence(rehearsal!);
    const driverStep = steps.findIndex((step) => step.includes(DRIVER_PATH));
    const buildStep = steps.findIndex((step) => step === BUILD_STEP);
    expect(driverStep).toBeGreaterThanOrEqual(0);
    expect(buildStep).toBeGreaterThanOrEqual(0);
    expect(buildStep).toBeLessThan(driverStep);
    // Same shape as every other workspace-consuming lane.
    expect(steps[0]).toBe(commandSequence(scripts[REFERENCE_LANE]!)[0]);
    expect(steps[0]).toBe(BUILD_STEP);
  });

  it('the runbook builds the workspace packages before its documented driver command', () => {
    const blocks = shellBlocks(repositoryFile(RUNBOOK_PATH));
    const driverBlock = blocks.findIndex((block) => block.includes(DRIVER_PATH));
    const buildBlock = blocks.findIndex((block) => block.includes(BUILD_STEP));
    expect(driverBlock).toBeGreaterThanOrEqual(0);
    expect(buildBlock).toBeGreaterThanOrEqual(0);
    expect(buildBlock).toBeLessThan(driverBlock);
  });
});
