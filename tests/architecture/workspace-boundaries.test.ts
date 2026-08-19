import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const REGISTRY = 'tools/workspace-source-boundaries.v1.json';
const PRODUCT_BOUNDARY = 'product/source-boundary.v1.json';
const tmpDirs: string[] = [];

afterAll(() =>
  tmpDirs.forEach((path) => rmSync(path, { recursive: true, force: true })),
);

interface Registry {
  registry_version: number;
  kind: string;
  manifests: string[];
}

interface LayerRule {
  name: string;
  from: string;
  allowed_imports: string[];
}

interface BoundaryManifest {
  name: string;
  workspace: boolean;
  boundary_root: string;
  entry_points: string[];
  owned_source_paths: string[];
  allowed_internal_paths: string[];
  allowed_workspace_packages: string[];
  allowed_external_packages: string[];
  allowed_node_builtins: string[];
  forbidden_repository_roots?: string[];
  runtime_assets?: string[];
  layer_rules: LayerRule[];
}

interface ProductBoundary {
  allowed_internal_paths: string[];
  runtime_assets: string[];
  layer_rules: LayerRule[];
}

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  files?: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO, path), 'utf8')) as T;
}

// Mirrors matchesGlob in tools/check-boundary.mjs. The tool runs main() at
// import time, so its matcher cannot be imported; a boundary pattern is
// compared against another pattern exactly as the tool compares it to a path.
function matchesGlob(path: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (!pattern.includes('*')) return path === pattern;
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`).test(path);
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

  // The local-organization refinement is governed by both the registry pass
  // and the product closure walk. Containment is asserted before a nested
  // manifest can permit an import the root product boundary rejects.
  it('keeps every nested boundary inside the product boundary', () => {
    const registry = readJson<Registry>(REGISTRY);
    const product = readJson<ProductBoundary>(PRODUCT_BOUNDARY);
    const violations: string[] = [];

    for (const manifestPath of registry.manifests) {
      const manifest = readJson<BoundaryManifest>(manifestPath);
      if (manifest.workspace) continue;
      for (const path of manifest.allowed_internal_paths) {
        if (
          !product.allowed_internal_paths.some((allowed) =>
            matchesGlob(path, allowed),
          )
        ) {
          violations.push(
            `${manifest.name}: allowed_internal_paths leaves the product boundary: ${path}`,
          );
        }
      }
      for (const rule of manifest.layer_rules) {
        const productRules = product.layer_rules.filter((candidate) =>
          matchesGlob(rule.from, candidate.from),
        );
        if (productRules.length !== 1) {
          violations.push(
            `${manifest.name}: layer rule '${rule.name}' matches ${productRules.length} product layer rules`,
          );
          continue;
        }
        const [productRule] = productRules;
        for (const path of rule.allowed_imports) {
          if (
            !productRule.allowed_imports.some((allowed) =>
              matchesGlob(path, allowed),
            )
          ) {
            violations.push(
              `${manifest.name}: layer rule '${rule.name}' allows an import product rule '${productRule.name}' rejects: ${path}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps product workspaces inside the governed product tree', () => {
    const registry = readJson<Registry>(REGISTRY);
    const product = readJson<ProductBoundary>(PRODUCT_BOUNDARY);
    const listed = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    const sourceFiles = listed.stdout
      .split('\0')
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path));
    const outsideProduct: string[] = [];

    for (const manifestPath of registry.manifests) {
      const manifest = readJson<BoundaryManifest>(manifestPath);
      if (
        !manifest.workspace ||
        !manifest.boundary_root.startsWith('src/product/')
      ) {
        continue;
      }
      for (const path of sourceFiles) {
        if (
          manifest.owned_source_paths.some((owned) => matchesGlob(path, owned)) &&
          !product.allowed_internal_paths.some((allowed) =>
            matchesGlob(path, allowed),
          )
        ) {
          outsideProduct.push(`${manifest.name}: ${path}`);
        }
      }
    }

    expect(outsideProduct).toEqual([]);
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
        '@echo-brain/organization-control-plane',
        '@echo-brain/organization-protocol',
        '@echo-brain/organization-record',
        '@echo-brain/organization-retrieval',
      ],
      '@echo-brain/organization-control-plane': [],
      '@echo-brain/organization-protocol': ['@echo-brain/federation-protocol'],
      '@echo-brain/organization-record': ['@echo-brain/federation-protocol'],
      '@echo-brain/organization-retrieval': [
        '@echo-brain/federation-protocol',
      ],
      'echo-brain/local-organization': [
        '@echo-brain/federation-protocol',
        '@echo-brain/organization-api',
        '@echo-brain/organization-authority',
        '@echo-brain/organization-protocol',
      ],
      '@echo-brain/person-client': [
        '@echo-brain/federation-protocol',
        '@echo-brain/organization-api',
        '@echo-brain/organization-protocol',
      ],
    });
  });

  it('keeps the Authority container closed over its workspace build and runtime dependencies', () => {
    const rootPackage = readJson<{ workspaces: string[] }>('package.json');
    const workspaceByName = new Map(
      rootPackage.workspaces.map((workspace) => [
        readJson<PackageManifest>(`${workspace}/package.json`).name,
        workspace,
      ]),
    );
    const dockerfile = readFileSync(
      join(REPO, 'deploy/organization-authority/Dockerfile'),
      'utf8',
    );

    const runtimeClosure = new Set<string>();
    const visit = (workspace: string): void => {
      if (runtimeClosure.has(workspace)) return;
      runtimeClosure.add(workspace);
      const manifest = readJson<PackageManifest>(`${workspace}/package.json`);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        const dependencyWorkspace = workspaceByName.get(dependency);
        if (dependencyWorkspace !== undefined) visit(dependencyWorkspace);
      }
    };
    visit('services/organization-authority');

    // npm ci reads every workspace manifest, but the server builder compiles
    // and receives source only for the Authority dependency closure.
    for (const workspace of rootPackage.workspaces) {
      const parent = workspace.split('/')[0]!;
      const manifestCopied =
        dockerfile.includes(`COPY ${workspace} ./${workspace}`) ||
        dockerfile.includes(`COPY ${parent} ./${parent}`) ||
        dockerfile.includes(
          `COPY ${workspace}/package.json ./${workspace}/package.json`,
        );
      expect(
        manifestCopied,
        `builder omits workspace manifest ${workspace}`,
      ).toBe(true);
    }
    for (const workspace of runtimeClosure) {
      const parent = workspace.split('/')[0]!;
      const sourceCopied =
        dockerfile.includes(`COPY ${workspace} ./${workspace}`) ||
        dockerfile.includes(`COPY ${parent} ./${parent}`);
      expect(sourceCopied, `builder omits workspace source ${workspace}`).toBe(
        true,
      );
    }
    expect(dockerfile).toContain(
      'npm run build --workspace @echo-brain/organization-authority',
    );
    expect(dockerfile).toContain(
      'npm ci --omit=dev --workspace @echo-brain/organization-authority --include-workspace-root=false',
    );
    expect(dockerfile).not.toContain('npm run build:workspaces');
    expect(dockerfile).not.toContain(
      'COPY src/product/person-client ./src/product/person-client',
    );

    // npm's workspace links resolve into these runtime directories. Every
    // reachable workspace therefore needs its package exports and compiled
    // code, and service packages that ship migrations need those immutable
    // filesystem assets beside dist.
    for (const workspace of [...runtimeClosure].sort()) {
      const manifest = readJson<PackageManifest>(`${workspace}/package.json`);
      expect(dockerfile).toContain(
        `COPY --from=build /app/${workspace}/package.json ./${workspace}/package.json`,
      );
      expect(dockerfile).toContain(
        `COPY --from=build /app/${workspace}/dist ./${workspace}/dist`,
      );
      if (manifest.files?.some((path) => path.startsWith('migrations/'))) {
        expect(dockerfile).toContain(
          `COPY --from=build /app/${workspace}/migrations ./${workspace}/migrations`,
        );
      }
    }
  });

  it('lists every SQL migration as a runtime asset', () => {
    for (const [root, manifestPath] of [
      [
        'services/organization-authority',
        'services/organization-authority/source-boundary.v1.json',
      ],
      [
        'services/organization-control-plane',
        'services/organization-control-plane/source-boundary.v1.json',
      ],
      ['src/product/storage', PRODUCT_BOUNDARY],
    ]) {
      const manifest = readJson<{ runtime_assets?: string[] }>(manifestPath);
      const migrations = readdirSync(join(REPO, root, 'migrations'))
        .filter((path) => path.endsWith('.sql'))
        .sort()
        .map((path) => `${root}/migrations/${path}`);
      expect(
        [...(manifest.runtime_assets ?? [])]
          .filter((path) => path.startsWith(`${root}/migrations/`))
          .sort(),
      ).toEqual(migrations);
    }
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
    // Punctuation between the loader and its call cannot hide the name.
    writeFileSync(entry, `require /* boundary */ ('@forbidden/pkg');\n`);
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
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

  it('rejects direct and disguised node:module loader capabilities', () => {
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
      'module loaders are forbidden',
    );

    // A node:module namespace exposes several loaders and is refused at the
    // import edge, before reflection or computed property access can hide which
    // loader is selected.
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
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        `const load = Module['createRequire'](import.meta.url);`,
        `load('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        `const make = Reflect.get(Module, 'createRequire');`,
        `make(import.meta.url)('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        `const { ['create' + 'Require']: make } = Module;`,
        `make(import.meta.url)('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `import { _load as load } from 'module';`,
        `load('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `const get = process['get' + 'BuiltinModule'];`,
        `get('module').createRequire(import.meta.url)('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `const { 'getBuiltinModule': get } = process;`,
        `const { 'createRequire': make } = get('module');`,
        `make(import.meta.url)('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        'let get;',
        '({ getBuiltinModule: get } = process);',
        'let make;',
        `({ createRequire: make } = get('module'));`,
        `make(import.meta.url)('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      ['const load = module._load;', `load('@forbidden/pkg');`, ''].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `const Module = Reflect.get(globalThis, 'module');`,
        `Module._load('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `import { 'getBuiltinModule' as get } from 'node:process';`,
        `get('module')._load('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );
  });

  it('rejects loader identifiers that escape direct call position', () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, 'packages/federation-protocol/src/index.ts');

    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        'const load = createRequire(import.meta.url);',
        'const indirect = load;',
        `indirect('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        'const load = createRequire(import.meta.url);',
        "const forward = (loader) => loader('@forbidden/pkg');",
        'forward(load);',
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );

    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        'const load = createRequire(import.meta.url);',
        'const expose = () => load;',
        `expose()('@forbidden/pkg');`,
        '',
      ].join('\n'),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );
  });

  // Tracking where a loader value travels is undecidable in general, and the
  // repository uses no loader anywhere, so the rule is refusal at the source:
  // naming a loader is the violation, whatever is done with it afterwards.
  it.each([
    [
      'direct call with an allowlisted target',
      [
        `import { createRequire } from 'node:module';`,
        `createRequire(import.meta.url)('@echo-brain/federation-protocol');`,
      ],
    ],
    [
      'assignment after a bare declaration',
      [
        `import { createRequire } from 'node:module';`,
        'let load;',
        'load = createRequire(import.meta.url);',
        `load('@forbidden/pkg');`,
      ],
    ],
    [
      'loader stored in an object',
      [
        `import { createRequire } from 'node:module';`,
        'const loaders = { load: createRequire(import.meta.url) };',
        `loaders.load('@forbidden/pkg');`,
      ],
    ],
    [
      'loader stored in an array',
      [
        `import { createRequire } from 'node:module';`,
        'const loaders = [createRequire(import.meta.url)];',
        `loaders[0]('@forbidden/pkg');`,
      ],
    ],
    [
      'loader returned from a function',
      [
        `import { createRequire } from 'node:module';`,
        'const make = () => createRequire(import.meta.url);',
        `make()('@forbidden/pkg');`,
      ],
    ],
    ['bare require call', [`require('@forbidden/pkg');`]],
  ])('rejects a module loader: %s', (_name, lines) => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, 'packages/federation-protocol/src/index.ts'),
      `${lines.join('\n')}\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'module loaders are forbidden',
    );
  });

  it('accepts loader words used only as declaration-only member names', () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, 'packages/federation-protocol/src/index.ts');

    // Every `require` / `createRequire` below sits in a member-name position:
    // it names a property and is never evaluated as a value. Modelling a
    // package.json exports entry is the ordinary reason to write these.
    writeFileSync(
      entry,
      [
        'export interface PackageEntryPoint {',
        '  require: string;',
        '  import: string;',
        '}',
        'export interface LoaderApi {',
        '  require(specifier: string): unknown;',
        '  createRequire: string;',
        '}',
        'export type ExportsMap = { require: string };',
        'export const entryPoint = {',
        `  exports: { require: './index.cjs', import: './index.mjs' },`,
        `  createRequire: 'documented',`,
        '};',
        'export const literalMembers = {',
        '  require() {',
        `    return 'name only';`,
        '  },',
        '  get createRequire() {',
        `    return 'name only';`,
        '  },',
        '};',
        'export class Manifest {',
        `  require = './index.cjs';`,
        '  createRequire(): string {',
        '    return this.require;',
        '  }',
        '}',
        'export class Accessors {',
        `  private value = './index.cjs';`,
        '  get require(): string {',
        '    return this.value;',
        '  }',
        '  set require(next: string) {',
        '    this.value = next;',
        '  }',
        '  get createRequire(): string {',
        '    return this.value;',
        '  }',
        '}',
        'export enum LoaderKind {',
        `  require = 'require',`,
        `  createRequire = 'createRequire',`,
        '}',
        '',
      ].join('\n'),
    );

    const result = runBoundary(fixture);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('still rejects loader words in evaluated property positions', () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, 'packages/federation-protocol/src/index.ts');

    // A computed name and a shorthand property both *evaluate* the identifier,
    // so the member-name exemption must not reach them.
    const escapes: ReadonlyArray<readonly [string, string]> = [
      [
        'object shorthand property',
        ['export const bundle = { require };', ''].join('\n'),
      ],
      [
        'computed object key',
        ['export const table = { [require]: 1 };', ''].join('\n'),
      ],
      [
        'computed object key via createRequire',
        [
          `import { createRequire } from 'node:module';`,
          'export const table = { [createRequire]: 1 };',
          '',
        ].join('\n'),
      ],
      [
        'computed class member',
        [
          `import { createRequire } from 'node:module';`,
          'export class Loaders {',
          '  [createRequire]() {',
          '    return 1;',
          '  }',
          '}',
          '',
        ].join('\n'),
      ],
      [
        'shorthand property carrying a createRequire alias',
        [
          `import { createRequire } from 'node:module';`,
          'const load = createRequire(import.meta.url);',
          'export const bundle = { load };',
          '',
        ].join('\n'),
      ],
    ];

    for (const [label, source] of escapes) {
      writeFileSync(entry, source);
      const result = runBoundary(fixture);
      expect(
        result.status,
        `${label}: ${result.stdout + result.stderr}`,
      ).not.toBe(0);
      expect(result.stdout + result.stderr, label).toContain(
        'module loaders are forbidden',
      );
    }
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

  it('rejects product source files that do not belong to a declared layer', () => {
    const fixture = fixtureRepository();
    const orphan = join(fixture, 'src/product/unlayered/orphan.ts');
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, 'export {};\n');
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'product source file has no layer rule',
    );
  });

  it('discovers adapter ids across all roots and rejects leaks in processing core', () => {
    const fixture = fixtureRepository();
    let result = runBoundary(fixture);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      discovered_adapter_ids: string[];
    };
    expect(report.discovered_adapter_ids).toEqual([
      'granola',
      'jsonl-outbox',
      'llm',
      'slack',
      'slack-reactions',
      'structured-text',
    ]);

    const probe = join(
      fixture,
      'services/organization-authority/src/processing/core/adapter-id-leak-probe.ts',
    );
    writeFileSync(probe, `export const leakedAdapterId = 'granola';\n`);
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "adapter id 'granola' leaked into tool-agnostic core module: services/organization-authority/src/processing/core/adapter-id-leak-probe.ts",
    );
  });

  it('rejects Authority composition imports into processing core', () => {
    const fixture = fixtureRepository();
    const compositionPath = join(
      fixture,
      'services/organization-authority/src/composition/config.ts',
    );
    writeFileSync(
      compositionPath,
      `${readFileSync(compositionPath, 'utf8')}\nexport * from '../processing/core/index.js';\n`,
    );

    const result = runBoundary(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "@echo-brain/organization-authority: layer rule 'authority-composition-may-wire-pre-processing-layers' rejects edge: services/organization-authority/src/composition/config.ts -> services/organization-authority/src/processing/core/index.ts",
    );
  });

  it('enforces every Authority processing layer against domain imports', () => {
    const fixture = fixtureRepository();
    const manifestPath =
      'services/organization-authority/source-boundary.v1.json';
    const domainErrors =
      'services/organization-authority/src/domain/errors.ts';
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    const processingRules = manifest.layer_rules.filter((rule) =>
      rule.name.startsWith('processing-'),
    );

    expect(processingRules.length).toBeGreaterThan(0);
    expect(existsSync(join(fixture, domainErrors))).toBe(true);

    // Mirror tools/lib/repository-files.mjs so a dead glob cannot pass by
    // selecting a path the checker itself never scans.
    const listed = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: fixture, encoding: 'buffer' },
    );
    expect(listed.status, listed.stderr?.toString('utf8')).toBe(0);
    const sourcePaths = listed.stdout
      .toString('utf8')
      .split('\0')
      .filter(
        (path) =>
          path !== '' &&
          /\.(?:[cm]?[jt]sx?)$/.test(path) &&
          existsSync(join(fixture, path)) &&
          lstatSync(join(fixture, path)).isFile(),
      )
      .sort();

    const probes = processingRules.map((rule) => {
      const sourcePath = sourcePaths.find((path) =>
        matchesGlob(path, rule.from),
      );
      if (sourcePath === undefined) {
        throw new Error(
          `processing layer rule '${rule.name}' matches no real source`,
        );
      }
      return { rule, sourcePath };
    });

    // The clean checker rejects overlapping rules; keep each mutation and
    // restoration unambiguous if the manifest ever regresses.
    expect(new Set(probes.map(({ sourcePath }) => sourcePath)).size).toBe(
      probes.length,
    );

    const baseline = runBoundary(fixture);
    expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);

    for (const { rule, sourcePath } of probes) {
      const absolutePath = join(fixture, sourcePath);
      const original = readFileSync(absolutePath, 'utf8');
      const relativeTarget = posix
        .relative(posix.dirname(sourcePath), domainErrors)
        .replace(/\.ts$/, '.js');
      const specifier = relativeTarget.startsWith('.')
        ? relativeTarget
        : `./${relativeTarget}`;

      try {
        writeFileSync(
          absolutePath,
          `${original}${original.endsWith('\n') ? '' : '\n'}import '${specifier}';\n`,
        );
        const result = runBoundary(fixture);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        const report = JSON.parse(result.stdout) as { errors: string[] };
        expect(report.errors, rule.name).toEqual([
          `@echo-brain/organization-authority: layer rule '${rule.name}' rejects edge: ${sourcePath} -> ${domainErrors}`,
        ]);
      } finally {
        writeFileSync(absolutePath, original);
      }
    }

    const restored = runBoundary(fixture);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
  });

  it('applies package and builtin allowlists to root product layers', () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, 'src/util/json.ts'),
      [
        `import '@echo-brain/organization-api';`,
        `import 'node:crypto';`,
        'export {};',
        '',
      ].join('\n'),
    );

    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'util-is-leaf-shared-code' rejects package @echo-brain/organization-api",
    );
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'util-is-leaf-shared-code' rejects Node builtin node:crypto",
    );

    writeFileSync(join(fixture, 'src/util/json.ts'), 'export {};\n');
    const forbiddenAdapterPath = '../../adapters/delivery-surfaces/jsonl-outbox/index.js';
    writeFileSync(
      join(fixture, 'src/product/approval/probe.ts'),
      `export * from '${forbiddenAdapterPath}';\n`,
    );
    const narrowDriverResult = runBoundary(fixture);
    expect(narrowDriverResult.status).not.toBe(0);
    expect(narrowDriverResult.stdout + narrowDriverResult.stderr).toContain(
      "layer rule 'approval-gates-use-the-retirement-fence' rejects edge",
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
    manifest.entry_points = ['src/product/index.ts'];
    writeFixtureJson(fixture, manifestPath, manifest);

    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('entry_points path leaves');
    expect(result.stdout + result.stderr).toContain(
      'source file is not covered by owned_source_paths',
    );
  });
});
