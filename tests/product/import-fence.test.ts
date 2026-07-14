import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function fixture(files: Record<string, string>, overrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-product-fence-'));
  temporaryDirectories.push(root);
  write(
    join(root, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } })}\n`,
  );
  for (const [path, content] of Object.entries(files)) write(join(root, path), content);
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
  const child = spawnSanitizedChild(process.execPath, [CHECK_BOUNDARY, ...args], { cwd });
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
    const result = JSON.parse(first.stdout) as { closure: string[]; external_packages: string[] };
    expect(result.closure).toEqual([...result.closure].sort());
    expect(result.external_packages).toEqual(['ajv', 'better-sqlite3']);
    expect(result.closure).not.toContain('src/capture/sources.ts');
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
      files: { 'src/product/index.ts': "import leftPad from 'left-pad';\nvoid leftPad;\n" },
      expected: "package 'left-pad' is not allowlisted",
    },
    {
      name: 'opaque dynamic import',
      files: { 'src/product/index.ts': "const name = './safe.js';\nvoid import(name);\n" },
      expected: 'non-literal module loading',
    },
    {
      name: 'opaque require',
      files: { 'src/product/index.ts': "const name = './safe.js';\nrequire(name);\n" },
      expected: 'non-literal module loading',
    },
    {
      name: 'opaque createRequire',
      files: {
        'src/product/index.ts':
          "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst name = './safe.js';\nload(name);\n",
      },
      expected: 'non-literal module loading',
    },
    {
      name: 'direct child process import',
      files: {
        'src/product/index.ts': "import { spawn } from 'node:child_process';\nvoid spawn;\n",
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
    const result = await run(['--project-root', root, '--manifest', 'boundary.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it('resolves literal require and createRequire edges transitively', async () => {
    const root = fixture({
      'src/product/index.ts':
        "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nrequire('./a.js');\nload('./b.js');\n",
      'src/product/a.ts': 'export const a = true;\n',
      'src/product/b.ts': 'export const b = true;\n',
    });
    const result = await run(['--project-root', root, '--manifest', 'boundary.json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).closure).toEqual([
      'src/product/a.ts',
      'src/product/b.ts',
      'src/product/index.ts',
    ]);
  });

  it('emits deterministic seed inventories', async () => {
    const root = fixture({
      'src/product/index.ts': "export * from './z.js';\nexport * from './a.js';\n",
      'src/product/a.ts': 'export const a = true;\n',
      'src/product/z.ts': 'export const z = true;\n',
    });
    const args = ['--project-root', root, '--seed-inventory', '--roots', 'src/product/index.ts'];
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
    const root = fixture({ 'src/product/index.ts': 'export const ok = true;\n' });
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
    expect(JSON.parse(readFileSync(join(root, 'out/closure.json'), 'utf8')).closure).toEqual([
      'src/product/index.ts',
    ]);
  });
});
