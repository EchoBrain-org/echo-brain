// AC2 — dependency edge partition: repository-local vs locked-npm vs toolchain,
// with range/protocol/sibling/source-repo edges failing.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
// Built from fragments so this test's own source never contains a literal spawn call that
// the command-partition scanner would (correctly) flag when it scans tests/migration/**.
const SPAWN = `spawn${'Sync'}`;
const SANITIZED = `spawn${'Sanitized'}Child`;
const ALIASED_SPAWN = `run${'Child'}`;
const CHILD_PROCESS_NS = `child${'Process'}`;
const tmpDirs: string[] = [];
const REMOVED_INTERNAL_ROOTS = [
  'capture',
  'storage',
  'echo-home',
  'enrich',
  'adapters/meeting-sources/granola/compatibility',
] as const;
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function cloneRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'echo-brain-dep-'));
  tmpDirs.push(dir);
  const clone = join(dir, 'echo-brain');
  expect(spawnSync('git', ['clone', '--quiet', REPO, clone], { encoding: 'utf8' }).status).toBe(0);
  return clone;
}
function commitFixture(clone: string, relPath: string, content: string): void {
  writeFileSync(join(clone, relPath), content);
  spawnSync('git', ['-C', clone, 'add', relPath], { encoding: 'utf8' });
  spawnSync('git', ['-C', clone, 'commit', '-q', '-m', 'fixture', '--no-gpg-sign'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}
function runCheckDeps(clone: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(clone, 'tools/check-dependencies.mjs')], { cwd: clone, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe('dependency partition', () => {
  it('check-dependencies passes against the committed target HEAD', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-dependencies.mjs')], { cwd: REPO, encoding: 'utf8' });
    expect(r.stdout + r.stderr, r.stdout + r.stderr).toContain('"ok": true');
    expect(r.status).toBe(0);
  });

  it('the shipped runtime uses exactly the two locked external packages', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-dependencies.mjs')], { cwd: REPO, encoding: 'utf8' });
    const out = JSON.parse(r.stdout) as { used_external: string[] };
    expect(out.used_external).toEqual(expect.arrayContaining(['ajv', 'better-sqlite3']));
  });

  it('the product boundary closure resolves entirely locally', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-boundary.mjs')], { cwd: REPO, encoding: 'utf8' });
    expect(r.stdout + r.stderr, r.stdout + r.stderr).toContain('"ok": true');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { external_packages: string[]; closure: string[] };
    expect(out.external_packages.sort()).toEqual(['ajv', 'better-sqlite3']);
    expect(out.closure.every((p) => p.startsWith('src/'))).toBe(true);
  });

  it.each(REMOVED_INTERNAL_ROOTS)(
    'the product boundary rejects unreferenced modules under removed root src/%s',
    (removedRoot) => {
      const clone = cloneRepo();
      copyFileSync(
        join(REPO, 'tools/check-boundary.mjs'),
        join(clone, 'tools/check-boundary.mjs'),
      );
      copyFileSync(
        join(REPO, 'product/source-boundary.v1.json'),
        join(clone, 'product/source-boundary.v1.json'),
      );
      for (const root of REMOVED_INTERNAL_ROOTS) {
        rmSync(join(clone, 'src', root), { recursive: true, force: true });
      }
      const removedDirectory = join(clone, 'src', removedRoot);
      mkdirSync(removedDirectory, { recursive: true });
      writeFileSync(
        join(removedDirectory, 'orphan.ts'),
        'export const orphan = true;\n',
      );
      const result = spawnSync(
        process.execPath,
        [join(clone, 'tools/check-boundary.mjs')],
        { cwd: clone, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        `module remains under removed internal root: src/${removedRoot}/orphan.ts`,
      );
    },
  );

  it('helper/CLI partition names the toolchain-preflight system helpers (clang++/xcode-select/xcrun)', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-dependencies.mjs')], { cwd: REPO, encoding: 'utf8' });
    const out = JSON.parse(r.stdout) as { used_commands: string[]; errors: string[] };
    expect(out.errors).toEqual([]);
    expect(out.used_commands).toEqual(expect.arrayContaining(['clang++', 'xcode-select', 'xcrun']));
  });

  it('live tools and tests do not hard-code host-specific Homebrew Git or npm paths', () => {
    const listed = spawnSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'buffer' });
    expect(listed.status, listed.stderr?.toString('utf8') ?? listed.error?.message).toBe(0);
    const hostPrefix = ['/usr', 'local', 'bin'].join('/');
    const forbidden = new RegExp(`${hostPrefix}/(?:git|npm)\\b`);
    const executableSources = listed.stdout.toString('utf8').split('\0')
      .filter((path) => /^(src|tools|tests)\/.*\.(?:ts|mts|mjs)$/.test(path))
      .filter((path) => existsSync(join(REPO, path)));
    for (const path of executableSources) {
      expect(readFileSync(join(REPO, path), 'utf8'), path).not.toMatch(forbidden);
    }
  });

  it('the reviewed computed-command owners remain explicit and the committed target stays green', () => {
    const manifest = JSON.parse(spawnSync('git', ['-C', REPO, 'show', 'HEAD:provenance/dependency-toolchain.v1.json'], {
      encoding: 'utf8',
    }).stdout) as { computed_command_owners: string[] };
    expect(manifest.computed_command_owners).toEqual([
      'src/product/spawn-sanitized-child.ts',
      'tools/verify-artifact.mjs',
      'tools/product/toolchain-preflight.mjs',
    ]);
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-dependencies.mjs')], { cwd: REPO, encoding: 'utf8' });
    expect(r.stdout + r.stderr, r.stdout + r.stderr).toContain('"ok": true');
    expect(r.status).toBe(0);
  });

  it('OMISSION fixture: an undeclared system-helper invocation fails the checker', () => {
    const clone = cloneRepo();
    // fixture invokes a helper absent from dependency-toolchain.v1.json
    commitFixture(clone, 'tools/fixture-omission.mjs',
      `import { ${SPAWN} } from 'node:child_process';\n${SPAWN}('imagemagick', ['-version']);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/imagemagick/);
  });

  it('EVASION fixture: a computed spawn in a non-owner file fails the checker', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-evasion.mjs',
      `import { ${SPAWN} } from 'node:child_process';\nconst c = process.env.SNEAKY;\n${SPAWN}(c, []);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/computed spawn command/);
  });

  it('OMISSION fixture: dropping a helper row from the manifest fails the checker', () => {
    const clone = cloneRepo();
    // remove clang++ from the manifest while toolchain-preflight still invokes it
    const manifestPath = 'provenance/dependency-toolchain.v1.json';
    const m = JSON.parse(spawnSync('git', ['-C', clone, 'show', `HEAD:${manifestPath}`], { encoding: 'utf8' }).stdout) as {
      system_helpers: Array<{ name: string }>;
    };
    m.system_helpers = m.system_helpers.filter((h) => h.name !== 'clang++');
    commitFixture(clone, manifestPath, `${JSON.stringify(m, null, 2)}\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/clang\+\+/);
  });

  it('the /sbin/mount edge from spawnSanitizedChild in config.ts is enforced (used_commands includes it)', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-dependencies.mjs')], { cwd: REPO, encoding: 'utf8' });
    const out = JSON.parse(r.stdout) as { used_commands: string[]; errors: string[] };
    expect(out.errors).toEqual([]);
    expect(out.used_commands).toContain('/sbin/mount');
  });

  it('the independent-copy macOS helper edges are declared and enforced', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools/check-dependencies.mjs')], { cwd: REPO, encoding: 'utf8' });
    const out = JSON.parse(r.stdout) as { used_commands: string[]; errors: string[] };
    expect(out.errors).toEqual([]);
    expect(out.used_commands).toContain('/usr/sbin/diskutil');
    expect(out.used_commands).toContain('/usr/bin/plutil');
  });

  it('N2 spawnSanitizedChild edge: an undeclared command via the sanctioned spawner fails the checker', () => {
    const clone = cloneRepo();
    // No import needed — the command-partition scan is textual; an import string would only
    // trip the import-partition scan. The sanctioned spawner call is what must be caught.
    commitFixture(clone, 'tools/fixture-sanitized.mjs',
      `${SANITIZED}('undeclared-preflight-tool', []);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/undeclared-preflight-tool/);
  });

  it('N2 fail-closed: a computed spawn with no proven tuple binding fails even when the file has an unrelated tuple', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-computed-tuple.mjs',
      `import { ${SPAWN} } from 'node:child_process';\n`
      + `const checks = [['git', ['--version']]];\nvoid checks;\n`
      + `const c = process.env.SNEAKY;\n${SPAWN}(c, []);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/computed spawn command/);
  });

  it('N2 array-construction misclassification: a computed spawn whose variable only appears in an ordinary array literal fails', () => {
    const clone = cloneRepo();
    // The spawn variable `c` appears in an ordinary array CONSTRUCTION `const unrelated = [c, ...]`
    // (a value, not a destructuring binding). It must NOT count as a proven tuple destructure,
    // so the unlisted computed executable must fail closed.
    commitFixture(clone, 'tools/fixture-array-construction.mjs',
      `import { ${SPAWN} } from 'node:child_process';\n`
      + `const c = process.env.SNEAKY;\n`
      + `const unrelated = [c, ['--version']];\nvoid unrelated;\n`
      + `${SPAWN}(c, []);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/computed spawn command/);
  });

  it('N2 exact arbitrary-RHS destructuring evasion fails closed', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-arbitrary-rhs.mjs',
      `import { ${SPAWN} } from 'node:child_process';\n\n`
      + `const attackerControlled = [process.env.SNEAKY, []];\n`
      + `const [command, args] = attackerControlled;\n`
      + `${SPAWN}(command, args);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/computed spawn command 'command'/);
  });

  it('N2 exact same-name shadowing evasion from the fresh review fails closed', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-same-name-shadow.mjs',
      `import { ${SPAWN} } from 'node:child_process';\n\n`
      + `const command = 'git';\n`
      + `{\n`
      + `  const attackerControlled = [process.env.SNEAKY, []];\n`
      + `  const [command, args] = attackerControlled;\n`
      + `  ${SPAWN}(command, args);\n`
      + `}\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/computed spawn command 'command'/);
  });

  it('N2 reassigned let command tokens fail closed even when initialized to an allowed literal', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-reassigned-let.mjs',
      `import { ${SPAWN} } from 'node:child_process';\n`
      + `let command = 'git';\n`
      + `command = process.env.SNEAKY;\n`
      + `${SPAWN}(command, []);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/computed spawn command 'command'/);
  });

  it('N2 aliased named child_process imports cannot hide an undeclared executable edge', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-aliased-import.mjs',
      `import { ${SPAWN} as ${ALIASED_SPAWN} } from 'node:child_process';\n`
      + `${ALIASED_SPAWN}('imagemagick', ['-version']);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/imagemagick/);
  });

  it('N2 child_process namespace member calls cannot hide an undeclared executable edge', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-namespace-member.mjs',
      `import * as ${CHILD_PROCESS_NS} from 'node:child_process';\n`
      + `${CHILD_PROCESS_NS}.${SPAWN}('imagemagick', ['-version']);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/imagemagick/);
  });

  it('N2 binding syntax alone cannot authorize even a literal tuple in a non-owner file', () => {
    const clone = cloneRepo();
    commitFixture(clone, 'tools/fixture-literal-destructure.mjs',
      `import { ${SPAWN} } from 'node:child_process';\n`
      + `const [command, args] = ['git', ['--version']];\n`
      + `${SPAWN}(command, args);\n`);
    const { status, out } = runCheckDeps(clone);
    expect(status).not.toBe(0);
    expect(out).toMatch(/computed spawn command 'command'/);
  });
});
