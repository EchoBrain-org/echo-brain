import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|mts)$/.test(entry.name) ? [path] : [];
  });
}

function repositoryImports(path: string): string[] {
  return [...readFileSync(path, 'utf8').matchAll(IMPORT_PATTERN)].flatMap(
    (match) => {
      const specifier = match[1]!;
      if (!specifier.startsWith('.')) {
        if (!specifier.startsWith('@echo-brain/')) return [];
        return [`workspace:${specifier.split('/').slice(0, 2).join('/')}`];
      }
      return [
        relative(REPOSITORY_ROOT, resolve(dirname(path), specifier))
          .split(sep)
          .join('/'),
      ];
    },
  );
}

interface TestLayerRule {
  root: string;
  allows: (resolvedImport: string) => boolean;
}

const rules: readonly TestLayerRule[] = [
  {
    root: 'tests/adapters',
    allows: (path) =>
      path === 'workspace:@echo-brain/organization-authority' ||
      path.startsWith('src/adapters/') ||
      path.startsWith('src/infrastructure/') ||
      path.startsWith('tests/support/'),
  },
  {
    root: 'tests/infrastructure',
    allows: (path) =>
      path.startsWith('src/infrastructure/') ||
      path.startsWith('tools/') ||
      path === 'workspace:@echo-brain/federation-protocol',
  },
  {
    root: 'tests/product',
    allows: (path) => !path.startsWith('services/'),
  },
];

describe('test layer ownership', () => {
  it.each(rules)('$root imports only its owned production layers', (rule) => {
    const violations = sourceFiles(resolve(REPOSITORY_ROOT, rule.root)).flatMap(
      (path) =>
        repositoryImports(path)
          .filter((imported) => !rule.allows(imported))
          .map(
            (imported) =>
              `${relative(REPOSITORY_ROOT, path).split(sep).join('/')} -> ${imported}`,
          ),
    );
    expect(violations).toEqual([]);
  });
});
