import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSanitizedChild } from '../../src/product/spawn-sanitized-child.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CHECK_BOUNDARY = join(REPO_ROOT, 'tools/product/check-boundary.mjs');
const temporaryDirectories: string[] = [];

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(
  files: Record<string, string>,
  overrides: Record<string, unknown> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-product-fence-'));
  temporaryDirectories.push(root);
  write(
    join(root, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } })}\n`,
  );
  for (const [path, content] of Object.entries(files))
    write(join(root, path), content);
  write(
    join(root, 'boundary.json'),
    `${JSON.stringify(
      {
        boundary_version: 1,
        entry_points: ['src/product/index.ts'],
        allowed_internal_paths: ['src/product/**'],
        forbidden_internal_roots: ['src/daemon/'],
        allowed_external_runtime_packages: [],
        child_process_owner: 'src/product/spawn-sanitized-child.ts',
        phase_1_platform: { os: 'darwin', node: '22.22.1' },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

async function run(
  args: readonly string[],
  cwd = REPO_ROOT,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawnSanitizedChild(
    process.execPath,
    [CHECK_BOUNDARY, ...args],
    { cwd },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', resolveStatus);
  });
  return { status, stdout, stderr };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('product transitive import fence', () => {
  it('accepts the real graph and emits a stable sorted closure', async () => {
    const first = await run([]);
    const second = await run([]);
    expect(first.status, first.stderr).toBe(0);
    expect(second).toEqual(first);
    const result = JSON.parse(first.stdout) as {
      closure: string[];
      external_packages: string[];
    };
    expect(result.closure).toEqual([...result.closure].sort());
    expect(result.external_packages).toEqual([
      '@echo-brain/federation-protocol',
      '@echo-brain/organization-api',
      '@echo-brain/organization-protocol',
      'ajv',
      'better-sqlite3',
    ]);
    expect(result.closure.some((path) => path.startsWith('src/capture/'))).toBe(
      false,
    );
    expect(result.closure).not.toContain('src/brain/brain.ts');
    expect(result.closure).not.toContain('src/cli/commands/brief.ts');
  });

  it.each([
    {
      name: 'forbidden root',
      files: {
        'src/product/index.ts': "import '../daemon/no.js';\n",
        'src/daemon/no.ts': 'export const no = true;\n',
      },
      overrides: { allowed_internal_paths: ['src/**'] },
      expected: 'forbidden_internal_roots',
    },
    {
      name: 'unlisted internal module',
      files: {
        'src/product/index.ts': "import '../shared.js';\n",
        'src/shared.ts': 'export const shared = true;\n',
      },
      expected: 'outside allowed_internal_paths',
    },
    {
      name: 'unlisted package',
      files: {
        'src/product/index.ts':
          "import leftPad from 'left-pad';\nvoid leftPad;\n",
      },
      expected: "package 'left-pad' is not allowlisted",
    },
    {
      name: 'opaque dynamic import',
      files: {
        'src/product/index.ts':
          "const name = './safe.js';\nvoid import(name);\n",
      },
      expected: 'non-literal module loading',
    },
    {
      name: 'opaque require',
      files: {
        'src/product/index.ts': "const name = './safe.js';\nrequire(name);\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'opaque createRequire',
      files: {
        'src/product/index.ts':
          "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst name = './safe.js';\nload(name);\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'direct createRequire loader',
      files: {
        'src/product/index.ts':
          "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'namespace createRequire loader',
      files: {
        'src/product/index.ts':
          "import * as Module from 'node:module';\nconst load = Module.createRequire(import.meta.url);\nload('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'literal element-access createRequire loader',
      files: {
        'src/product/index.ts':
          "import * as Module from 'node:module';\nconst load = Module['createRequire'](import.meta.url);\nload('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'reflective createRequire loader',
      files: {
        'src/product/index.ts':
          "import * as Module from 'node:module';\nconst make = Reflect.get(Module, 'createRequire');\nmake(import.meta.url)('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'computed destructured createRequire loader',
      files: {
        'src/product/index.ts':
          "import * as Module from 'node:module';\nconst { ['create' + 'Require']: make } = Module;\nmake(import.meta.url)('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'unsafe named node module loader',
      files: {
        'src/product/index.ts':
          "import { _load as load } from 'module';\nload('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'dynamic node module namespace',
      files: {
        'src/product/index.ts':
          "const Module = await import('node:module');\nModule.createRequire(import.meta.url)('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'computed process builtin loader',
      files: {
        'src/product/index.ts':
          "const get = process['get' + 'BuiltinModule'];\nget('module').createRequire(import.meta.url)('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'string-named process builtin loader destructuring',
      files: {
        'src/product/index.ts':
          "const { 'getBuiltinModule': get } = process;\nconst { 'createRequire': make } = get('module');\nmake(import.meta.url)('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'process builtin loader destructuring assignment',
      files: {
        'src/product/index.ts':
          "let get;\n({ getBuiltinModule: get } = process);\nlet make;\n({ createRequire: make } = get('module'));\nmake(import.meta.url)('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'ambient ESM module loader',
      files: {
        'src/product/index.ts':
          "const load = module._load;\nload('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'reflective ambient ESM module loader',
      files: {
        'src/product/index.ts':
          "const Module = Reflect.get(globalThis, 'module');\nModule._load('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'string-named process builtin loader import',
      files: {
        'src/product/index.ts':
          "import { 'getBuiltinModule' as get } from 'node:process';\nget('module')._load('left-pad');\n",
      },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'ambient CommonJS loader',
      files: {
        'src/product/index.cjs': "module['requ' + 'ire']('left-pad');\n",
      },
      overrides: { entry_points: ['src/product/index.cjs'] },
      expected: 'module loaders are forbidden',
    },
    {
      name: 'direct child process import',
      files: {
        'src/product/index.ts':
          "import { spawn } from 'node:child_process';\nvoid spawn;\n",
      },
      expected: 'child_process is restricted',
    },
    {
      name: 'direct child process import in a product test',
      files: {
        'src/product/index.ts': 'export const ok = true;\n',
        'tests/product/direct-spawn.test.ts':
          "import { spawnSync } from 'node:child_process';\nvoid spawnSync;\n",
      },
      expected: 'direct child_process access in product tests',
    },
  ])('rejects $name', async ({ files, overrides = {}, expected }) => {
    const root = fixture(files as unknown as Record<string, string>, overrides);
    const result = await run([
      '--project-root',
      root,
      '--manifest',
      'boundary.json',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  // Loader edges used to be resolved and followed when the specifier was a
  // literal. They are refused now: a transparent loader is indistinguishable at
  // the syntax level from one whose target is decided elsewhere, and the
  // repository reaches every module by static import or import() instead.
  it('refuses loader edges even when every specifier is literal', async () => {
    const root = fixture({
      'src/product/index.ts':
        "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nrequire('./a.js');\nload('./b.js');\n",
      'src/product/a.ts': 'export const a = true;\n',
      'src/product/b.ts': 'export const b = true;\n',
    });
    const result = await run([
      '--project-root',
      root,
      '--manifest',
      'boundary.json',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('module loaders are forbidden');
  });

  // node:module is not banned outright. A small positive list of non-loading
  // named exports remains available; the product needs syncBuiltinESMExports in
  // spawn-sanitized-child.ts.
  it('accepts node:module imports that are not the loader factory', async () => {
    const root = fixture({
      'src/product/index.ts':
        "import { syncBuiltinESMExports } from 'node:module';\nsyncBuiltinESMExports();\n",
    });
    const result = await run([
      '--project-root',
      root,
      '--manifest',
      'boundary.json',
    ]);
    expect(result.status, result.stderr).toBe(0);
  });

  it('emits deterministic seed inventories', async () => {
    const root = fixture({
      'src/product/index.ts':
        "export * from './z.js';\nexport * from './a.js';\n",
      'src/product/a.ts': 'export const a = true;\n',
      'src/product/z.ts': 'export const z = true;\n',
    });
    const args = [
      '--project-root',
      root,
      '--seed-inventory',
      '--roots',
      'src/product/index.ts',
    ];
    const first = await run(args);
    const second = await run(args);
    expect(first.status, first.stderr).toBe(0);
    expect(second).toEqual(first);
    expect(JSON.parse(first.stdout).closure).toEqual([
      'src/product/a.ts',
      'src/product/index.ts',
      'src/product/z.ts',
    ]);
  });

  it('can write the sorted closure manifest to an explicit path', async () => {
    const root = fixture({
      'src/product/index.ts': 'export const ok = true;\n',
    });
    const result = await run([
      '--project-root',
      root,
      '--manifest',
      'boundary.json',
      '--output',
      'out/closure.json',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(
      JSON.parse(readFileSync(join(root, 'out/closure.json'), 'utf8')).closure,
    ).toEqual(['src/product/index.ts']);
  });
});
