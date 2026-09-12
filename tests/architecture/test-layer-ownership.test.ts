import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const { collectModuleReferences } = await import(pathToFileURL(
  resolve(REPOSITORY_ROOT, 'tools/lib/module-references.mjs'),
).href) as {
  collectModuleReferences: (source: ts.SourceFile, options: { includeTypeQueries: boolean }) =>
    Array<{ specifier: string | null; expression: string }>;
};
const workspaces: string[] = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8')).workspaces;
const neutralWorkspaces = workspaces.filter((path) => path.startsWith('packages/'));
const neutralPackages = new Set(neutralWorkspaces.map((path) =>
  `workspace:${JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path, 'package.json'), 'utf8')).name}`,
));

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function repositoryImports(path: string, content = readFileSync(path, 'utf8')): string[] {
  const parsed = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  return collectModuleReferences(parsed, { includeTypeQueries: true }).flatMap(
    ({ specifier, expression }) => {
      if (specifier === null) return [`unbounded-import:${expression}`];
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
  ...neutralWorkspaces.filter((path) => existsSync(resolve(REPOSITORY_ROOT, path, 'test'))).map((workspace) => ({
    root: `${workspace}/test`,
    allows: (path: string) => neutralPackages.has(path) ||
      neutralWorkspaces.some((neutral) => path.startsWith(`${neutral}/src/`)) ||
      path.startsWith(`${workspace}/test/`) || path.startsWith('tests/support/'),
  })),
  {
    root: 'tests/support',
    allows: (path) => neutralPackages.has(path) || path.startsWith('tests/support/'),
  },
  {
    root: 'services/organization-authority/test/processing/core',
    allows: (path) =>
      path.startsWith('packages/organization-processing/src/core/') ||
      path === 'workspace:@echo-brain/organization-processing' ||
      path.startsWith('tests/support/'),
  },
  {
    root: 'tests/person-client',
    allows: (path) =>
      path.startsWith('src/product/person-client/') ||
      path === 'workspace:@echo-brain/person-client' ||
      path === 'workspace:@echo-brain/federation-protocol' ||
      path === 'workspace:@echo-brain/organization-api' ||
      path === 'workspace:@echo-brain/organization-protocol' ||
      path === 'workspace:@echo-brain/provider-slack-client',
  },
];

describe('test layer ownership', () => {
  it.each([
    'import "@echo-brain/provider-fixture";',
    'export * as adapter from "@echo-brain/provider-fixture";',
    'type Adapter = import("@echo-brain/provider-fixture").Adapter;',
    'import type Adapter = require("@echo-brain/provider-fixture");',
    'await import(`@echo-brain/provider-fixture`);',
    'import "../../../providers/fixture/src/index.js";',
    'await import(selectedProvider);',
  ])('recognizes forbidden test dependencies: %s', (content) => {
    const path = resolve(REPOSITORY_ROOT, 'packages/organization-processing/test/probe.ts');
    const rule = rules.find((entry) => entry.root === 'packages/organization-processing/test')!;
    const imports = repositoryImports(path, content);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((entry) => !rule.allows(entry))).toBe(true);
  });

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
