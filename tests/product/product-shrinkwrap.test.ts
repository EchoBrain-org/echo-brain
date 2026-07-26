import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- the shipped installer is an executable plain-ESM tool.
import { rootInstallLock } from '../../tools/product/install-offline.mjs';
import {
  PRODUCT_BUNDLED_WORKSPACE_PACKAGES,
  productShrinkwrap,
} from '../../tools/product/sync-shrinkwrap.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const TEMPORARY_ROOT = mkdtempSync(
  join(tmpdir(), 'echo-product-install-lock-'),
);

type JsonObject = Record<string, unknown>;

type ProductTemplate = JsonObject & {
  bundleDependencies: string[];
};

type RootLock = JsonObject & {
  packages: Record<string, JsonObject & { version?: string }>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

afterAll(() => {
  rmSync(TEMPORARY_ROOT, { recursive: true, force: true });
});

describe('product shrinkwrap workspace bundles', () => {
  it('converts exactly the three promoted workspace links into in-bundle entries', () => {
    const template = readJson<ProductTemplate>('product/package.template.json');
    const productLock = productShrinkwrap(
      template,
      readJson<RootLock>('npm-shrinkwrap.json'),
    );
    const expectedPaths = PRODUCT_BUNDLED_WORKSPACE_PACKAGES.map(
      (name) => `node_modules/${name}`,
    ).sort();
    const bundledPaths = Object.entries(productLock.packages)
      .filter(([, metadata]) => metadata.inBundle === true)
      .map(([path]) => path)
      .sort();

    expect(productLock.packages[''].bundleDependencies).toEqual(
      PRODUCT_BUNDLED_WORKSPACE_PACKAGES,
    );
    expect(bundledPaths).toEqual(expectedPaths);
    expect(
      productLock.packages['node_modules/@echo-brain/organization-authority'],
    ).toBeUndefined();
    for (const path of bundledPaths) {
      expect(productLock.packages[path]).toMatchObject({
        version: '0.0.0-dev.0',
        inBundle: true,
      });
      expect(productLock.packages[path]).not.toHaveProperty('link');
      expect(productLock.packages[path]).not.toHaveProperty('resolved');
      expect(productLock.packages[path]).not.toHaveProperty('integrity');
    }
    for (const [path, metadata] of Object.entries(productLock.packages)) {
      if (path === '' || metadata.inBundle === true) continue;
      expect(metadata.link, path).not.toBe(true);
      expect(metadata.resolved, path).toEqual(expect.any(String));
      expect(metadata.integrity, path).toEqual(expect.any(String));
    }
  });

  it('rejects drift in the exact product bundle allowlist', () => {
    const template = readJson<ProductTemplate>('product/package.template.json');
    template.bundleDependencies = [
      ...template.bundleDependencies,
      '@echo-brain/organization-authority',
    ];

    expect(() =>
      productShrinkwrap(template, readJson<RootLock>('npm-shrinkwrap.json')),
    ).toThrow(/bundleDependencies must be exactly/);
  });

  it('rejects a template and workspace lock version mismatch', () => {
    const template = readJson<ProductTemplate>('product/package.template.json');
    const rootLock = clone(readJson<RootLock>('npm-shrinkwrap.json'));
    rootLock.packages['packages/organization-api'].version = '9.9.9';

    expect(() => productShrinkwrap(template, rootLock)).toThrow(
      /bundled workspace version mismatch for @echo-brain\/organization-api/,
    );
  });

  it('nests bundled workspace lock subtrees under the installed product', () => {
    const template = readJson<ProductTemplate>('product/package.template.json');
    const productLock = productShrinkwrap(
      template,
      readJson<RootLock>('npm-shrinkwrap.json'),
    );
    const bundledDescendant =
      'node_modules/@echo-brain/organization-api/node_modules/synthetic-child';
    productLock.packages[bundledDescendant] = {
      version: '1.0.0',
      resolved:
        'https://registry.npmjs.org/synthetic-child/-/synthetic-child-1.0.0.tgz',
      integrity: `sha512-${'a'.repeat(88)}`,
    };
    const artifact = join(TEMPORARY_ROOT, 'echo-brain-test.tgz');
    writeFileSync(artifact, 'synthetic product artifact\n');

    const rootLock = rootInstallLock(
      artifact,
      { version: productLock.version },
      productLock,
    ) as RootLock;
    expect(
      rootLock.packages['node_modules/echo-brain'].bundleDependencies,
    ).toEqual(PRODUCT_BUNDLED_WORKSPACE_PACKAGES);
    for (const name of PRODUCT_BUNDLED_WORKSPACE_PACKAGES) {
      const packagedPath = `node_modules/${name}`;
      const installedPath = `node_modules/echo-brain/${packagedPath}`;
      expect(rootLock.packages[installedPath]).toEqual(
        productLock.packages[packagedPath],
      );
      expect(rootLock.packages[packagedPath]).toBeUndefined();
    }
    expect(
      rootLock.packages[`node_modules/echo-brain/${bundledDescendant}`],
    ).toEqual(productLock.packages[bundledDescendant]);
    expect(rootLock.packages[bundledDescendant]).toBeUndefined();
    for (const externalPath of [
      'node_modules/ajv',
      'node_modules/rc/node_modules/strip-json-comments',
    ]) {
      expect(rootLock.packages[externalPath]).toEqual(
        productLock.packages[externalPath],
      );
    }
  });
});
