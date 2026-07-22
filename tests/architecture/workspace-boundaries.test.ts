import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const REGISTRY = 'tools/workspace-source-boundaries.v1.json';
const tmpDirs: string[] = [];

afterAll(() =>
  tmpDirs.forEach((path) => rmSync(path, { recursive: true, force: true })),
);

interface Registry {
  registry_version: number;
  kind: string;
  manifests: string[];
}

interface BoundaryManifest {
  name: string;
  workspace: boolean;
  boundary_root: string;
  entry_points: string[];
  owned_source_paths: string[];
  allowed_workspace_packages: string[];
  allowed_external_packages: string[];
  allowed_node_builtins: string[];
  forbidden_repository_roots: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO, path), 'utf8')) as T;
}

function fixtureRepository(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'echo-workspace-boundary-'));
  tmpDirs.push(fixture);
  const clone = join(fixture, 'repo');
  const cloned = spawnSync('git', ['clone', '--quiet', REPO, clone], {
    encoding: 'utf8',
  });
  expect(cloned.status, cloned.stdout + cloned.stderr).toBe(0);

  // Negative boundary tests must mutate one coherent repository snapshot. A
  // hand-picked overlay can silently mix committed source with current
  // manifests, which makes the guard report stale or missing imports instead
  // of the violation under test.
  const workingTreeDiff = spawnSync(
    'git',
    ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.'],
    { cwd: REPO, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  expect(workingTreeDiff.status, workingTreeDiff.stderr?.toString('utf8')).toBe(
    0,
  );
  if (workingTreeDiff.stdout.length > 0) {
    const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: clone,
      input: workingTreeDiff.stdout,
      encoding: 'utf8',
    });
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
  }

  const untracked = spawnSync(
    'git',
    ['ls-files', '-z', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'buffer' },
  );
  expect(untracked.status, untracked.stderr?.toString('utf8')).toBe(0);
  for (const path of untracked.stdout.toString('utf8').split('\0')) {
    if (path === '') continue;
    const source = join(REPO, path);
    if (!lstatSync(source).isFile()) continue;
    const destination = join(clone, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { force: true });
  }
  symlinkSync(join(REPO, 'node_modules'), join(clone, 'node_modules'), 'dir');
  return clone;
}

function readFixtureJson<T>(fixture: string, path: string): T {
  return JSON.parse(readFileSync(join(fixture, path), 'utf8')) as T;
}

function writeFixtureJson(fixture: string, path: string, value: unknown): void {
  writeFileSync(join(fixture, path), `${JSON.stringify(value, null, 2)}\n`);
}

function runBoundary(fixture: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [join(fixture, 'tools/check-boundary.mjs')],
    {
      cwd: fixture,
      encoding: 'utf8',
    },
  );
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('workspace source boundaries', () => {
  it('matches every declared workspace to one checked boundary', () => {
    const rootPackage = readJson<{ workspaces: string[] }>('package.json');
    const registry = readJson<Registry>(REGISTRY);
    const manifests = registry.manifests.map((path) =>
      readJson<BoundaryManifest>(path),
    );
    const workspaceRoots = manifests
      .filter((manifest) => manifest.workspace)
      .map((manifest) => manifest.boundary_root)
      .sort();

    expect(registry).toMatchObject({
      registry_version: 1,
      kind: 'echo-workspace-source-boundary-registry',
    });
    expect(workspaceRoots).toEqual([...rootPackage.workspaces].sort());
    expect(new Set(manifests.map((manifest) => manifest.name)).size).toBe(
      manifests.length,
    );
    for (const manifest of manifests) {
      for (const entryPoint of manifest.entry_points) {
        expect(existsSync(join(REPO, entryPoint)), entryPoint).toBe(true);
      }
    }
  });

  it('locks the one-way workspace dependency graph', () => {
    const registry = readJson<Registry>(REGISTRY);
    const graph = Object.fromEntries(
      registry.manifests.map((path) => {
        const manifest = readJson<BoundaryManifest>(path);
        return [manifest.name, [...manifest.allowed_workspace_packages].sort()];
      }),
    );

    expect(graph).toEqual({
      '@echo-brain/federation-protocol': [],
      '@echo-brain/organization-api': [
        '@echo-brain/federation-protocol',
        '@echo-brain/organization-protocol',
      ],
      '@echo-brain/organization-authority': [
        '@echo-brain/federation-protocol',
        '@echo-brain/organization-api',
        '@echo-brain/organization-protocol',
      ],
      '@echo-brain/organization-protocol': ['@echo-brain/federation-protocol'],
      'echo-brain/stable-federation': ['@echo-brain/federation-protocol'],
      'echo-brain/local-organization': [
        '@echo-brain/federation-protocol',
        '@echo-brain/organization-api',
        '@echo-brain/organization-protocol',
      ],
    });
  });

  it('parses real module syntax without treating comments or strings as imports', () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, 'packages/federation-protocol/src/index.ts');
    writeFileSync(
      entry,
      [
        `const example = "require('@forbidden/pkg')";`,
        `/* import '@forbidden/pkg'; */`,
        'void example;',
        'export {};',
        '',
      ].join('\n'),
    );
    const passingResult = runBoundary(fixture);
    expect(
      passingResult.status,
      passingResult.stdout + passingResult.stderr,
    ).toBe(0);

    writeFileSync(
      entry,
      `export { value } from /* boundary */ '@forbidden/pkg';\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'external import @forbidden/pkg is not allowed',
    );
  });

  it('rejects commented require syntax and non-literal module loading', () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, 'packages/federation-protocol/src/index.ts');
    writeFileSync(entry, `require /* boundary */ ('@forbidden/pkg');\n`);
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'external import @forbidden/pkg is not allowed',
    );

    writeFileSync(
      entry,
      `const target = '@forbidden/pkg';\nvoid import(target);\n`,
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'non-literal module loading is forbidden',
    );
  });

  it('rejects direct and namespace createRequire loader forms', () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, 'packages/federation-protocol/src/index.ts');
    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        `createRequire(import.meta.url)('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'external import @forbidden/pkg is not allowed',
    );

    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        'const load = Module.createRequire(import.meta.url);',
        `load('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'external import @forbidden/pkg is not allowed',
    );
  });

  it('rejects workspace deep imports that are not package exports', () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, 'packages/organization-protocol/src/index.ts'),
      `export { value } from '@echo-brain/federation-protocol/private';\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'workspace deep import is not exported',
    );
  });

  it('rejects owned source files that do not belong to a declared layer', () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, 'services/organization-authority/src/unlayered.ts'),
      'export {};\n',
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'owned source file has no layer rule',
    );
  });

  it('applies package and builtin allowlists to root product layers', () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, 'src/core/index.ts'),
      [
        `import '@echo-brain/organization-api';`,
        `import 'node:fs';`,
        'export {};',
        '',
      ].join('\n'),
    );

    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'core-is-tool-agnostic' rejects package @echo-brain/organization-api",
    );
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'core-is-tool-agnostic' rejects Node builtin node:fs",
    );

    writeFileSync(join(fixture, 'src/core/index.ts'), 'export {};\n');
    const forbiddenAdapterPath =
      '../../delivery-surfaces/slack/index.js';
    writeFileSync(
      join(
        fixture,
        'src/adapters/decision-processors/llm/anthropic-client.ts',
      ),
      `export * from '${forbiddenAdapterPath}';\n`,
    );
    const narrowDriverResult = runBoundary(fixture);
    expect(narrowDriverResult.status).not.toBe(0);
    expect(narrowDriverResult.stdout + narrowDriverResult.stderr).toContain(
      "layer rule 'llm-provider-drivers-own-only-transport' rejects edge",
    );
  });

  it('applies builtin and external allowlists at the matching layer', () => {
    const fixture = fixtureRepository();
    const manifestPath =
      'services/organization-authority/source-boundary.v1.json';
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    manifest.allowed_node_builtins = ['process'];
    manifest.allowed_external_packages = ['ajv'];
    writeFixtureJson(fixture, manifestPath, manifest);
    const packagePath = 'services/organization-authority/package.json';
    const packageJson = readFixtureJson<{
      dependencies: Record<string, string>;
    }>(fixture, packagePath);
    packageJson.dependencies.ajv = '8.17.1';
    writeFixtureJson(fixture, packagePath, packageJson);
    writeFileSync(
      join(fixture, 'services/organization-authority/src/domain/probe.ts'),
      [
        `import process from 'node:process';`,
        `import Ajv from 'ajv';`,
        'void process;',
        'void Ajv;',
        '',
      ].join('\n'),
    );

    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'authority-domain-is-pure' rejects Node builtin node:process",
    );
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'authority-domain-is-pure' rejects external import ajv",
    );
  });

  it('rejects manifests that narrow ownership or point outside their boundary', () => {
    const fixture = fixtureRepository();
    const manifestPath =
      'services/organization-authority/source-boundary.v1.json';
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    manifest.owned_source_paths = [
      'services/organization-authority/src/domain/**',
    ];
    manifest.entry_points = ['src/core/index.ts'];
    writeFixtureJson(fixture, manifestPath, manifest);

    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('entry_points path leaves');
    expect(result.stdout + result.stderr).toContain(
      'source file is not covered by owned_source_paths',
    );
  });
});
