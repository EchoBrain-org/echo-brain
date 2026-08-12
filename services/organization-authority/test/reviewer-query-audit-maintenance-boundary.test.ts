import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';

/**
 * The stopped-only reviewer query-audit capability, checked as a property of
 * the source graph rather than of one call site.
 *
 * The boundary manifest's layer rules constrain what a module may import, not
 * who may import it, so the "stopped-state only" half of this contract is
 * asserted here: exactly one production module may reach the maintenance
 * repository, and it is the operator-state composition that runs against a
 * stopped authority.
 */

const SOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src',
);

const MAINTENANCE_MODULE = join(
  SOURCE_ROOT,
  'adapters/persistence/sqlite/reviewer-query-audit-maintenance.ts',
);

/** The one production module allowed to construct stopped-state maintenance. */
const ALLOWED_IMPORTERS = ['composition/operator-state.ts'];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

function relativeImports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const specifiers: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    specifiers.push(match[1]!);
    match = pattern.exec(source);
  }
  return specifiers;
}

/** Every production module that imports `target`, as repository paths. */
function importersOf(target: string): string[] {
  const importers = new Set<string>();
  for (const path of sourceFiles(SOURCE_ROOT)) {
    if (path === target) continue;
    for (const specifier of relativeImports(path)) {
      const resolved = resolve(dirname(path), specifier).replace(/\.js$/, '.ts');
      if (resolved === target) importers.add(relative(SOURCE_ROOT, path));
    }
  }
  return [...importers].sort();
}

describe('reviewer query audit maintenance boundary', () => {
  it('is imported by no production module other than operator-state', () => {
    // The scan is proved to resolve real edges first, so an empty result below
    // means "nothing imports it" rather than "the scanner found nothing".
    expect(
      importersOf(
        join(SOURCE_ROOT, 'adapters/persistence/sqlite/sqlite-authority-repository.ts'),
      ),
    ).toContain('composition/runtime.ts');

    expect(importersOf(MAINTENANCE_MODULE)).toEqual(ALLOWED_IMPORTERS);
  });

  it('is not reachable from the runtime repository the served authority holds', () => {
    const surface = new Set<string>();
    let prototype: object | null =
      SqliteOrganizationAuthorityRepository.prototype;
    while (prototype !== null && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        surface.add(name);
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    expect([...surface].sort()).not.toContain('maintainReviewerQueryAudit');
    // The served contract is exactly initialize/read/write/close plus the one
    // linearizing write. Nothing on it scans, expires, or writes a receipt.
    for (const method of [
      'maintainReviewerQueryAudit',
      'authorizeExport',
      'expire',
      'auditBetween',
      'dueForExpiry',
      'expireDueEntries',
      'appendControlEvent',
      'reviewerQueryAuditControlEventByCommand',
    ]) {
      expect(surface.has(method)).toBe(false);
    }
  });

  it('keeps the runtime composition free of the stopped-only module', () => {
    const runtime = readFileSync(join(SOURCE_ROOT, 'composition/runtime.ts'), 'utf8');
    expect(runtime).not.toContain('reviewer-query-audit-maintenance');
    const httpApplication = readFileSync(
      join(SOURCE_ROOT, 'presentation/organization-authority-http-application.ts'),
      'utf8',
    );
    expect(httpApplication).not.toContain('reviewer-query-audit-maintenance');
  });
});
