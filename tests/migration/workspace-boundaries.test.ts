import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const REGISTRY = 'tools/workspace-source-boundaries.v1.json';
const tmpDirs: string[] = [];

afterAll(() => tmpDirs.forEach((path) => rmSync(path, { recursive: true, force: true })));

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
  const cloned = spawnSync('git', ['clone', '--quiet', REPO, clone], { encoding: 'utf8' });
  expect(cloned.status, cloned.stdout + cloned.stderr).toBe(0);

  for (const directory of ['packages', 'services']) {
    mkdirSync(join(clone, directory), { recursive: true });
    cpSync(join(REPO, directory), join(clone, directory), { recursive: true, force: true });
  }
  mkdirSync(join(clone, 'src/product/organization'), { recursive: true });
  cpSync(join(REPO, 'src/product/organization'), join(clone, 'src/product/organization'), {
    recursive: true,
    force: true,
  });
  for (const path of [
    'package.json',
    'product/source-boundary.v1.json',
    'tools/check-boundary.mjs',
    'tools/workspace-source-boundaries.v1.json',
    'tools/lib/module-references.mjs',
    'tools/lib/repository-files.mjs',
    'src/product/storage/migrations/0005_organization_access.sql',
  ]) {
    mkdirSync(join(clone, path, '..'), { recursive: true });
    cpSync(join(REPO, path), join(clone, path), { force: true });
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

function runBoundary(fixture: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(fixture, 'tools/check-boundary.mjs')], {
    cwd: fixture,
    encoding: 'utf8',
  });
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
    const manifests = registry.manifests.map((path) => readJson<BoundaryManifest>(path));
    const workspaceRoots = manifests
      .filter((manifest) => manifest.workspace)
      .map((manifest) => manifest.boundary_root)
      .sort();

    expect(registry).toMatchObject({
      registry_version: 1,
      kind: 'echo-workspace-source-boundary-registry',
    });
    expect(workspaceRoots).toEqual([...rootPackage.workspaces].sort());
    expect(new Set(manifests.map((manifest) => manifest.name)).size).toBe(manifests.length);
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
      'echo-brain/local-organization': [
        '@echo-brain/federation-protocol',
        '@echo-brain/organization-api',
        '@echo-brain/organization-protocol',
      ],
    });
  });

  it('passes the repository boundary checker with the scaffold present', () => {
    const result = spawnSync(process.execPath, [join(REPO, 'tools/check-boundary.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      workspace_boundaries: Array<{ name: string }>;
    };
    expect(output.ok).toBe(true);
    expect(output.workspace_boundaries.map((boundary) => boundary.name)).toEqual([
      '@echo-brain/federation-protocol',
      '@echo-brain/organization-api',
      '@echo-brain/organization-authority',
      '@echo-brain/organization-protocol',
      'echo-brain/local-organization',
    ]);
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

    writeFileSync(entry, `export { value } from /* boundary */ '@forbidden/pkg';\n`);
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('external import @forbidden/pkg is not allowed');
  });

  it('rejects commented require syntax and non-literal module loading', () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, 'packages/federation-protocol/src/index.ts');
    writeFileSync(entry, `require /* boundary */ ('@forbidden/pkg');\n`);
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('external import @forbidden/pkg is not allowed');

    writeFileSync(entry, `const target = '@forbidden/pkg';\nvoid import(target);\n`);
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('non-literal module loading is forbidden');
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
    expect(result.stdout + result.stderr).toContain('external import @forbidden/pkg is not allowed');

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
    expect(result.stdout + result.stderr).toContain('external import @forbidden/pkg is not allowed');
  });

  it('rejects workspace deep imports that are not package exports', () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, 'packages/organization-protocol/src/index.ts'),
      `export { value } from '@echo-brain/federation-protocol/private';\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('workspace deep import is not exported');
  });

  it('rejects owned source files that do not belong to a declared layer', () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, 'services/organization-authority/src/unlayered.ts'),
      'export {};\n',
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('owned source file has no layer rule');
  });

  it('applies builtin and external allowlists at the matching layer', () => {
    const fixture = fixtureRepository();
    const manifestPath = 'services/organization-authority/source-boundary.v1.json';
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    manifest.allowed_node_builtins = ['process'];
    manifest.allowed_external_packages = ['ajv'];
    writeFixtureJson(fixture, manifestPath, manifest);
    const packagePath = 'services/organization-authority/package.json';
    const packageJson = readFixtureJson<{ dependencies: Record<string, string> }>(fixture, packagePath);
    packageJson.dependencies.ajv = '8.17.1';
    writeFixtureJson(fixture, packagePath, packageJson);
    writeFileSync(
      join(fixture, 'services/organization-authority/src/domain/probe.ts'),
      [`import process from 'node:process';`, `import Ajv from 'ajv';`, 'void process;', 'void Ajv;', ''].join('\n'),
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
    const manifestPath = 'services/organization-authority/source-boundary.v1.json';
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    manifest.owned_source_paths = ['services/organization-authority/src/domain/**'];
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
