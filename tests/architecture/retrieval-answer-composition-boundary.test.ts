import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(REPO, path), 'utf8');
const ANSWER_ROOT = 'packages/organization-authority-kernel/src/answer-composition';
// Agentic Ask is the only Ask (ADR-0022); the V1/V2 routes and their audit adapter were retired.
const ANSWER_V3_ROUTE = 'services/organization-authority/src/composition/person-answer-v3-route.ts';
const SOURCE_EVIDENCE_ROUTE = 'services/organization-authority/src/composition/person-source-evidence-route.ts';
const AGENTIC_AUDIT = 'services/organization-authority/src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.ts';
function files(root: string): string[] {
  return readdirSync(join(REPO, root)).flatMap(name => {
    const path = posix.join(root, name);
    return statSync(join(REPO, path)).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}
// Use the production whole-module graph, including public workspace exports.
// The loader's bypass mutations live once in workspace-boundaries.test.ts.
const { repositoryWorktree } = await import(pathToFileURL(join(REPO, 'tools/lib/repository-files.mjs')).href);
const { providerModuleGraph } = await import(pathToFileURL(join(REPO, 'tools/lib/provider-module-graph.mjs')).href);
const errors: string[] = [];
const graph: { targets(path: string): ReadonlySet<string> } = providerModuleGraph(repositoryWorktree(REPO), (_tree: unknown, importer: string, specifier: string) => {
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}/index.ts`].find(path => existsSync(join(REPO, path))) ?? null;
}, errors);

describe('retrieval and answer-composition boundaries', () => {
  it('keeps released read/search closures independent from provider and model implementations', () => {
    expect(errors).toEqual([]);
    const pending = [
      ...files('packages/organization-record/src/retrieve'), ...files('packages/organization-retrieval/src'),
      'packages/organization-authority-kernel/src/application/readable-search-authorization-fence.ts',
      ...['person-record-read-route', 'person-record-search-route', 'person-meeting-items-v1', 'person-item-text-v1'].map(name => `services/organization-authority/src/composition/${name}.ts`),
      'services/organization-authority/src/application/ports/person-original-context-retrieval-v1.ts',
      'services/organization-authority/src/adapters/persistence/sqlite/person-original-context-retrieval-v1.ts',
      'services/organization-authority/src/composition/person-evidence-desk-v1.ts',
      'services/organization-authority/src/application/ports/person-list-v1.ts',
      'services/organization-authority/src/adapters/persistence/sqlite/person-original-items-v1.ts',
      'services/organization-authority/src/adapters/persistence/sqlite/person-original-access-v1.ts',
    ];
    const visited = new Set<string>();
    while (pending.length) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(path).not.toMatch(/^providers\/|^packages\/organization-processing\/src\/llm\/|^packages\/organization-authority-kernel\/src\/answer-composition\//);
      pending.push(...graph.targets(path));
    }
    expect(visited.size).toBeGreaterThan(10);
  });
  it('keeps answer composition behind released contracts without direct record, retrieval or storage access', () => {
    const implementation = [...files(ANSWER_ROOT), ANSWER_V3_ROUTE, SOURCE_EVIDENCE_ROUTE];
    expect(implementation.length).toBeGreaterThan(1);
    for (const path of implementation) for (const target of graph.targets(path)) {
      if (target === AGENTIC_AUDIT) continue; // The route may write its dedicated audit event.
      expect(relative(REPO, join(REPO, target))).not.toMatch(/^packages\/organization-(?:record|retrieval)\/|\/(?:adapters\/persistence|storage)\//);
    }
    expect(read(AGENTIC_AUDIT)).toContain('"answer_composition"');
  });
  it('keeps the entire answer kernel closure free of provider, record and storage implementations', () => {
    // Route composition may bind the desk and audit adapters. The kernel and
    // every helper it imports may consume only their released contracts.
    const pending = files(ANSWER_ROOT);
    const visited = new Set<string>();
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(path).not.toMatch(/^providers\/|^services\/|^packages\/organization-(?:record|retrieval)\/|\/(?:adapters\/persistence|storage)\//);
      pending.push(...graph.targets(path));
    }
    expect(visited.size).toBeGreaterThan(files(ANSWER_ROOT).length);
  });
  it('keeps the answer kernel free of undeclared agent modules and all Ask paths non-streaming', () => {
    const implementation = files(ANSWER_ROOT);
    expect(implementation.length).toBeGreaterThan(0);
    for (const path of implementation) {
      if (!path.endsWith('/agentic-ask-v1.ts')) expect(path).not.toMatch(/\/(?:agents?|tools?|memory|iterations?|vector|hybrid|rerank(?:ing)?|streaming)(?:[\/_\-.]|$)/i);
      expect(read(path)).not.toMatch(/ReadableStream|text\/event-stream|stream\s*:\s*true/);
    }
  });
});
