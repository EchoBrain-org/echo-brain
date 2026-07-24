// The Phase 5 ceremony attestation list is self-verifying: the committed
// CEREMONY_SOURCE_PATHS must match, in both directions, the module set the
// driver actually loads from its declared entry points.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertCeremonyAttestationClosure,
  collectExecutedModuleClosure,
  diffCeremonyAttestation,
} from '../../tools/lib/module-closure.mjs';
import {
  CEREMONY_ENTRY_POINTS,
  CEREMONY_SOURCE_PATHS,
} from '../../tools/phase5/run-one-machine.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const MODULE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];
const attestedModules = CEREMONY_SOURCE_PATHS.filter((path) =>
  MODULE_EXTENSIONS.some((extension) => path.endsWith(extension)),
);
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Assemble fixture module sources from fragments so the repository-local
// dependency scanner (tools/check-dependencies.mjs) does not read these
// fixture strings as real module edges of this test file.
const REL = `.${'/'}`;
function importsOf(...names: string[]): string {
  return names.map((name) => `import '${REL}${name}';\n`).join('');
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ceremony-closure-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe('phase 5 ceremony attestation closure', () => {
  it('the committed attestation matches the driver import closure exactly', () => {
    const diff = diffCeremonyAttestation({
      projectRoot: REPO,
      entryPoints: CEREMONY_ENTRY_POINTS,
      attestedSourcePaths: attestedModules,
    });
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(() =>
      assertCeremonyAttestationClosure({
        projectRoot: REPO,
        entryPoints: CEREMONY_ENTRY_POINTS,
        attestedSourcePaths: attestedModules,
      }),
    ).not.toThrow();
  });

  it('rejects an executed module that is missing from the attestation', () => {
    const dir = fixture({
      'driver.mjs': importsOf('helper.mjs'),
      'helper.mjs': `${importsOf('orphan.mjs')}export const helper = 1;\n`,
      'orphan.mjs': 'export const orphan = 1;\n',
    });
    expect(
      collectExecutedModuleClosure({ projectRoot: dir, entryPoints: ['driver.mjs'] }),
    ).toEqual(['driver.mjs', 'helper.mjs', 'orphan.mjs']);
    expect(() =>
      assertCeremonyAttestationClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
        attestedSourcePaths: ['driver.mjs', 'helper.mjs'],
      }),
    ).toThrow(/executed but unattested: orphan\.mjs/);
  });

  it('rejects an attested file the driver never executes', () => {
    const dir = fixture({
      'driver.mjs': importsOf('helper.mjs'),
      'helper.mjs': 'export const helper = 1;\n',
    });
    expect(() =>
      assertCeremonyAttestationClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
        attestedSourcePaths: ['driver.mjs', 'helper.mjs', 'ghost.mjs'],
      }),
    ).toThrow(/attested but never executed: ghost\.mjs/);
  });

  it('accepts an attestation that equals the closure', () => {
    const dir = fixture({
      'driver.mjs': importsOf('helper.mjs'),
      'helper.mjs': 'export const helper = 1;\n',
    });
    expect(() =>
      assertCeremonyAttestationClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
        attestedSourcePaths: ['driver.mjs', 'helper.mjs'],
      }),
    ).not.toThrow();
  });

  it('fails closed when a ceremony source names a module loader', () => {
    const dir = fixture({
      'escaper.mjs': 'const alias = require;\nexport const escaper = alias;\n',
    });
    expect(() =>
      collectExecutedModuleClosure({ projectRoot: dir, entryPoints: ['escaper.mjs'] }),
    ).toThrow(/module loaders are forbidden/);
  });
});
