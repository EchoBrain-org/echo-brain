import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_BUNDLED_WORKSPACE_PACKAGES,
  productShrinkwrap,
} from '../../tools/product/sync-shrinkwrap.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

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
});
