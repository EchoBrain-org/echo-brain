// The Phase 5 ceremony attestation list is self-verifying:
// CEREMONY_SOURCE_PATHS must match, in both directions, the statically declared
// module closure from the driver's entry points under the no-loader policy.
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
  CEREMONY_ALLOWED_EXTERNAL_DYNAMIC_IMPORTS,
  CEREMONY_ALLOWED_EXTERNAL_PACKAGES,
  CEREMONY_ENTRY_POINTS,
  CEREMONY_SOURCE_PATHS,
} from '../../tools/phase5/run-one-machine.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const MODULE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];
const attestedModules = CEREMONY_SOURCE_PATHS.filter((path) =>
  MODULE_EXTENSIONS.some((extension) => path.endsWith(extension)),
);
const tmpDirs: string[] = [];
afterAll(() =>
  tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

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
      allowedExternalPackages: CEREMONY_ALLOWED_EXTERNAL_PACKAGES,
      allowedExternalDynamicImports: CEREMONY_ALLOWED_EXTERNAL_DYNAMIC_IMPORTS,
    });
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(() =>
      assertCeremonyAttestationClosure({
        projectRoot: REPO,
        entryPoints: CEREMONY_ENTRY_POINTS,
        attestedSourcePaths: attestedModules,
        allowedExternalPackages: CEREMONY_ALLOWED_EXTERNAL_PACKAGES,
        allowedExternalDynamicImports:
          CEREMONY_ALLOWED_EXTERNAL_DYNAMIC_IMPORTS,
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
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
      }),
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
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['escaper.mjs'],
      }),
    ).toThrow(/module loaders are forbidden/);
  });

  it.each([
    [
      'reflective node:module namespace access',
      [
        `import * as Module from 'node:module';`,
        `const make = Reflect.get(Module, 'createRequire');`,
        `make(import.meta.url)('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'computed node:module namespace access',
      [
        `import * as Module from 'node:module';`,
        `Module['create' + 'Require'](import.meta.url)('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'unsafe named node:module export',
      [`import { _load as load } from 'module';`, `load('./hidden.cjs');`].join(
        '\n',
      ),
    ],
    [
      'computed process.getBuiltinModule access',
      [
        `const get = process['get' + 'BuiltinModule'];`,
        `get('module').createRequire(import.meta.url)('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'string-named loader destructuring',
      [
        `const { 'getBuiltinModule': get } = process;`,
        `const { 'createRequire': make } = get('module');`,
        `make(import.meta.url)('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'loader destructuring assignment',
      [
        `let get;`,
        `({ getBuiltinModule: get } = process);`,
        `let make;`,
        `({ createRequire: make } = get('module'));`,
        `make(import.meta.url)('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'dynamic node:module namespace access',
      [
        `const Module = await import('node:module');`,
        `Module.createRequire(import.meta.url)('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'node:module namespace re-export',
      `export * as Module from 'node:module';`,
    ],
    [
      'string-named node:module import',
      [
        `import { 'createRequire' as make } from 'module';`,
        `make(import.meta.url)('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'ambient ESM module loader',
      [`const load = module._load;`, `load('./hidden.cjs');`].join('\n'),
    ],
    [
      'reflective ambient ESM module loader',
      [
        `const Module = Reflect.get(globalThis, 'module');`,
        `Module._load('./hidden.cjs');`,
      ].join('\n'),
    ],
    [
      'string-named node:process loader import',
      [
        `import { 'getBuiltinModule' as get } from 'node:process';`,
        `get('module')._load('./hidden.cjs');`,
      ].join('\n'),
    ],
  ])('fails closed at a disguised loader capability: %s', (_name, source) => {
    const dir = fixture({ 'driver.mjs': `${source}\n` });
    expect(() =>
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
      }),
    ).toThrow(/module loaders are forbidden/);
  });

  it('refuses CommonJS ceremony sources with ambient loader capabilities', () => {
    const dir = fixture({
      'driver.cjs': `module['requ' + 'ire']('./hidden.cjs');\n`,
    });
    expect(() =>
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.cjs'],
      }),
    ).toThrow(/module loaders are forbidden/);
  });

  it('does not treat type-only loader names as runtime capabilities', () => {
    const dir = fixture({
      'driver.ts': [
        `import type { createRequire } from 'node:module';`,
        `import type Module = require('module');`,
        `export type Loader = typeof import('node:module').createRequire;`,
        `export type Factory = typeof createRequire;`,
        '',
      ].join('\n'),
    });
    expect(
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.ts'],
      }),
    ).toEqual(['driver.ts']);
  });

  it('fails closed on a non-literal dynamic import', () => {
    const dir = fixture({
      'driver.mjs': "const target = './hidden.mjs';\nawait import(target);\n",
      'hidden.mjs': 'export const hidden = true;\n',
    });
    expect(() =>
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
      }),
    ).toThrow(/non-literal dynamic imports are forbidden/);
  });

  it('permits only an exact declared materialized-artifact import expression', () => {
    const dir = fixture({
      'driver.mjs': 'await import(verifiedArtifactUrl);\n',
    });
    const permission = {
      sourcePath: 'driver.mjs',
      expression: 'verifiedArtifactUrl',
    };
    expect(
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
        allowedExternalDynamicImports: [permission],
      }),
    ).toEqual(['driver.mjs']);
    expect(() =>
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
        allowedExternalDynamicImports: [
          { ...permission, expression: 'otherArtifactUrl' },
        ],
      }),
    ).toThrow(/non-literal dynamic imports are forbidden/);
  });

  it('rejects a bare package unless the attestation names it explicitly', () => {
    const dir = fixture({
      'driver.mjs': "import '@echo-brain/organization-api';\n",
    });
    expect(() =>
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
      }),
    ).toThrow(/bare package import is not attested/);
    expect(
      collectExecutedModuleClosure({
        projectRoot: dir,
        entryPoints: ['driver.mjs'],
        allowedExternalPackages: ['@echo-brain/organization-api'],
      }),
    ).toEqual(['driver.mjs']);
  });
});
