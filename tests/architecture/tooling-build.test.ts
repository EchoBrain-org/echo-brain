import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const BUILD_TOOL = join(REPO, 'tools', 'build.mjs');
const roots: string[] = [];

const workspaces = [
  'packages/federation-protocol',
  'packages/organization-protocol',
  'packages/organization-api',
  'src/product/person-client',
  'services/organization-authority',
  'packages/organization-control-plane',
  'packages/organization-record',
  'packages/organization-retrieval',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-tooling-build-'));
  roots.push(root);
  const tools = join(root, 'tools');
  const bin = join(root, 'bin');
  const ledger = join(root, 'git-ledger');
  const compilerMarker = join(root, 'compiler-called');
  mkdirSync(tools, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(BUILD_TOOL, join(tools, 'build.mjs'));
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ workspaces })}\n`);
  mkdirSync(join(root, 'src', 'product', 'person-client'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'product', 'person-client', 'package.json'),
    `${JSON.stringify({ version: '0.0.0-test' })}\n`,
  );

  const sentinels = [join(root, 'dist', 'sentinel')];
  for (const workspace of workspaces) {
    sentinels.push(join(root, workspace, 'dist', 'sentinel'));
  }
  for (const sentinel of sentinels) {
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'preserve me\n');
  }

  const git = join(bin, 'git');
  writeFileSync(
    git,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$BUILD_LEDGER"
if [ "$1" = 'rev-parse' ]; then printf '%s\\n' '${'a'.repeat(40)}'; exit 0; fi
if [ "$1" = 'status' ]; then exit 0; fi
exit 1
`,
  );
  chmodSync(git, 0o755);

  const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  mkdirSync(resolve(compiler, '..'), { recursive: true });
  writeFileSync(
    compiler,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
mkdirSync(join(root, 'src/product/person-client/dist'), { recursive: true });
writeFileSync(join(root, 'src/product/person-client/dist/main.js'), 'export {};\\n');
writeFileSync(process.env.BUILD_COMPILER_MARKER, 'called\\n');
`,
  );

  return { root, ledger, compilerMarker, sentinels };
}

function run(root: string, ledger: string, compilerMarker: string, argv: string[]) {
  return spawnSync(process.execPath, [join(root, 'tools', 'build.mjs'), ...argv], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      BUILD_LEDGER: ledger,
      BUILD_COMPILER_MARKER: compilerMarker,
    },
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('tools/build.mjs', () => {
  it('handles help and invalid arguments before source, compiler, or output work', () => {
    const input = fixture();
    const help = run(input.root, input.ledger, input.compilerMarker, ['--help']);

    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage: node tools/build.mjs');
    expect(help.stderr).toBe('');

    for (const argv of [
      ['--unknown'],
      ['--person-client', '--person-client'],
      ['--clean', '--person-client'],
      ['--help', '--person-client'],
    ]) {
      const result = run(input.root, input.ledger, input.compilerMarker, argv);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('usage: node tools/build.mjs');
    }

    for (const sentinel of input.sentinels) {
      expect(readFileSync(sentinel, 'utf8')).toBe('preserve me\n');
    }
    expect(existsSync(input.ledger)).toBe(false);
    expect(existsSync(input.compilerMarker)).toBe(false);
  });

  it('keeps --clean as the no-compiler output cleanup command', () => {
    const input = fixture();
    const result = run(input.root, input.ledger, input.compilerMarker, ['--clean']);

    expect(result.status).toBe(0);
    expect(input.sentinels.every((sentinel) => !existsSync(sentinel))).toBe(true);
    expect(existsSync(input.ledger)).toBe(false);
    expect(existsSync(input.compilerMarker)).toBe(false);
  });

  it('preserves the default clean artifact build behavior', () => {
    const input = fixture();
    const result = run(input.root, input.ledger, input.compilerMarker, []);

    expect(result.status).toBe(0);
    expect(input.sentinels.every((sentinel) => !existsSync(sentinel))).toBe(true);
    expect(existsSync(input.compilerMarker)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(
            input.root,
            'src/product/person-client/dist/build-identity.v1.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ source_kind: 'materialized-commit' });
  });
});
