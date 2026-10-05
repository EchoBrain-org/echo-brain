import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const { checkProviderOwnership } = await import(pathToFileURL(resolve(import.meta.dirname, '../../tools/lib/provider-ownership.mjs')).href);
type Tree = Map<string, { bytes: Buffer }>;

function fixture(shared = true) {
  const tree: Tree = new Map();
  const source = (path: string, content: string) => tree.set(path, { bytes: Buffer.from(content) });
  const json = (path: string, value: unknown) => source(path, JSON.stringify(value));
  const roots = ['packages/contracts', 'providers/alpha', 'providers/beta', 'services/authority', ...(shared ? ['providers/shared', 'providers/common'] : [])];
  const name = (root: string) => `@fixture/${root.split('/')[1]}`;
  json('package.json', { workspaces: roots });
  json('tools/workspace-source-boundaries.v1.json', { manifests: roots.map(root => `${root}/source-boundary.json`) });
  for (const root of roots) {
    json(`${root}/package.json`, { name: name(root), exports: { '.': './dist/index.js' } });
    json(`${root}/tsconfig.json`, { compilerOptions: { rootDir: 'src', outDir: 'dist' } });
    json(`${root}/source-boundary.json`, { name: name(root), boundary_root: root, source_root: `${root}/src`, package_json: `${root}/package.json` });
    source(`${root}/src/index.ts`, 'export const value = 1;');
  }
  const architecture = {
    ownership_version: 1,
    provider_roots: ['providers/alpha', 'providers/beta'],
    ...(shared ? { shared_provider_roots: ['providers/shared', 'providers/common'] } : {}),
    bootstrap_entrypoints: ['services/authority/src/index.ts'],
    source_assemblies: [],
  };
  return {
    import(from: string, target: string) { source(`${from}/src/index.ts`, `import '${name(target)}';`); },
    check() {
      const errors: string[] = [];
      const report = checkProviderOwnership(tree, architecture, (files: Tree, importer: string, specifier: string) => {
        const target = posix.join(posix.dirname(importer), specifier);
        return [target, target.replace(/\.js$/, '.ts')].find(path => files.has(path)) ?? null;
      }, errors);
      return { errors, report };
    },
  };
}

describe('shared provider library ownership', () => {
  it('allows concrete providers to share adapters while shared libraries depend only inward', () => {
    const repository = fixture();
    repository.import('services/authority', 'providers/alpha');
    repository.import('providers/alpha', 'providers/shared');
    repository.import('providers/shared', 'providers/common');
    repository.import('providers/common', 'packages/contracts');
    const { errors, report } = repository.check();
    expect(errors).toEqual([]);
    expect(report.shared_provider_roots).toEqual(['providers/common', 'providers/shared']);
    expect(report.workspace_edges).toBe(4);
  });

  it('refuses the reverse dependency from a shared library to a concrete provider', () => {
    const repository = fixture();
    repository.import('providers/shared', 'providers/alpha');
    expect(repository.check().errors).toEqual([
      'shared provider library imports a concrete provider or application: providers/shared/src/index.ts -> providers/alpha/src/index.ts',
    ]);
  });

  it('keeps neutral libraries unaware of shared provider implementations', () => {
    const repository = fixture();
    repository.import('packages/contracts', 'providers/shared');
    expect(repository.check().errors).toEqual([
      'neutral module reaches shared-provider: packages/contracts/src/index.ts -> providers/shared/src/index.ts',
    ]);
  });

  it('refuses shared library dependencies on a service bootstrap', () => {
    const repository = fixture();
    repository.import('providers/shared', 'services/authority');
    expect(repository.check().errors).toEqual([
      'provider imports the composing service: providers/shared/src/index.ts -> services/authority/src/index.ts',
    ]);
  });

  it('preserves the concrete-to-concrete provider prohibition', () => {
    const repository = fixture();
    repository.import('providers/alpha', 'providers/beta');
    expect(repository.check().errors).toEqual([
      'cross-provider dependency: providers/alpha/src/index.ts -> providers/beta/src/index.ts',
    ]);
  });

  it('defaults the optional shared-root declaration to an empty list', () => {
    const { errors, report } = fixture(false).check();
    expect(errors).toEqual([]);
    expect(report.shared_provider_roots).toEqual([]);
  });
});
