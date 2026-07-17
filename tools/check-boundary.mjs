#!/usr/bin/env node
// AC4 — Enforce the product boundary natively.
//
// Resolves the transitive internal module graph from the product entry points in
// product/source-boundary.v1.json against the repository worktree. Rejects any
// edge outside allowed_internal_paths, into a forbidden_internal_root, or that
// escapes the repository; classifies node: / bare-core specifiers against the
// pinned Node 22 built-in set (never as npm rows); requires the full transitive
// closure to resolve locally. Bare npm imports/package CLIs are handed to
// check-dependencies.mjs (this tool only asserts they are declared external).
//
// Node builtins only; safe to run before `npm ci`.
import { dirname, posix } from 'node:path';
import process from 'node:process';
import { repositoryWorktree, textFile } from './lib/repository-files.mjs';

const REPO = process.cwd();

// Pinned Node 22 core module set (bare + node: forms both classify here).
const NODE22_BUILTINS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
  'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path',
  'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers',
  'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers',
  'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types',
  'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function matchesGlob(path, pattern) {
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  return path === pattern;
}

function resolveRelative(tree, importer, spec) {
  const base = dirname(importer);
  const target = posix.normalize(posix.join(base, spec));
  const cands = [];
  if (spec.endsWith('.js')) {
    cands.push(target.slice(0, -3) + '.ts', target.slice(0, -3) + '.mts');
  }
  cands.push(target, target + '.ts', target + '.mts', posix.join(target, 'index.ts'));
  for (const c of cands) if (tree.has(c)) return c;
  return null;
}

function main() {
  const tree = repositoryWorktree(REPO);
  const boundary = JSON.parse(textFile(tree, 'product/source-boundary.v1.json'));
  const allowed = boundary.allowed_internal_paths;
  const forbidden = boundary.forbidden_internal_roots;
  const removed = boundary.removed_internal_roots ?? [];
  const external = new Set(boundary.allowed_external_runtime_packages);
  const layerRules = boundary.layer_rules ?? [];
  const adapterArchitecture = boundary.adapter_architecture;
  const errors = [];
  const runtimeAssets = boundary.runtime_assets ?? [];
  for (const asset of runtimeAssets) {
    if (!tree.has(asset)) errors.push(`runtime asset missing from worktree: ${asset}`);
  }

  const isAllowed = (p) => allowed.some((g) => matchesGlob(p, g));
  const isForbidden = (p) => forbidden.some((g) => matchesGlob(p, g));

  for (const [path] of tree) {
    if (removed.some((root) => matchesGlob(path, root))) {
      errors.push(`module remains under removed internal root: ${path}`);
    }
  }

  const discoveredAdapterIds = new Set();
  if (adapterArchitecture?.forbid_discovered_adapter_ids_in_core === true) {
    for (const [path] of tree) {
      if (!path.startsWith(adapterArchitecture.adapters_root)) continue;
      const relative = path.slice(adapterArchitecture.adapters_root.length);
      const parts = relative.split('/');
      if (parts.length >= 3) discoveredAdapterIds.add(parts[1]);
    }
    for (const [path] of tree) {
      if (
        !matchesGlob(path, adapterArchitecture.core_root) ||
        !/\.(?:ts|mts|js|mjs)$/.test(path)
      ) continue;
      const source = textFile(tree, path).toLowerCase();
      for (const adapterId of discoveredAdapterIds) {
        // Word-boundary match: a bare substring check false-positives on short
        // ids (e.g. 'llm' inside 'pullMs') while a genuine leak always appears
        // as a standalone token ('llm', "llm", llm-adapter, ...).
        const escaped = adapterId.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(source)) {
          errors.push(`adapter id '${adapterId}' leaked into tool-agnostic core module: ${path}`);
        }
      }
    }
  }

  // Layer rules apply to every matching worktree module, not only modules that
  // happen to be reachable from today's public entry points. This makes the
  // dependency direction durable as new core files are added.
  for (const [path] of tree) {
    const matchingRules = layerRules.filter((rule) => matchesGlob(path, rule.from));
    if (matchingRules.length === 0 || !/\.(?:ts|mts|js|mjs)$/.test(path)) continue;
    const source = textFile(tree, path);
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec?.startsWith('.')) continue;
      const resolved = resolveRelative(tree, path, spec);
      if (resolved === null) continue;
      for (const rule of matchingRules) {
        if (!rule.allowed_imports.some((pattern) => matchesGlob(resolved, pattern))) {
          errors.push(`layer rule '${rule.name}' rejects edge: ${path} -> ${resolved}`);
        }
      }
    }
  }

  const seen = new Set();
  const work = [...boundary.entry_points];
  const closure = new Set();
  const externalSeen = new Set();

  while (work.length) {
    const p = work.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    if (!tree.has(p)) { errors.push(`entry/edge not tracked in target HEAD: ${p}`); continue; }
    if (isForbidden(p)) { errors.push(`closure module in forbidden root: ${p}`); continue; }
    if (!isAllowed(p) && !boundary.entry_points.includes(p)) {
      errors.push(`closure module outside allowlist: ${p}`);
      continue;
    }
    closure.add(p);
    const text = textFile(tree, p);
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      if (spec.startsWith('.')) {
        const r = resolveRelative(tree, p, spec);
        if (!r) { errors.push(`unresolved repository-local edge ${spec} from ${p}`); continue; }
        if (r.startsWith('../') || !r.startsWith('src/')) {
          errors.push(`edge escapes source tree: ${spec} from ${p} -> ${r}`);
          continue;
        }
        if (isForbidden(r)) { errors.push(`edge into forbidden root: ${p} -> ${r}`); continue; }
        if (!isAllowed(r)) { errors.push(`edge outside allowlist: ${p} -> ${r}`); continue; }
        work.push(r);
      } else if (spec.startsWith('node:')) {
        const bare = spec.slice(5);
        if (!NODE22_BUILTINS.has(bare)) errors.push(`unknown node: builtin ${spec} from ${p}`);
      } else if (NODE22_BUILTINS.has(spec)) {
        // bare core module — classified as builtin, never an npm row
      } else {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        externalSeen.add(pkg);
        if (!external.has(pkg)) errors.push(`undeclared external package ${pkg} from ${p}`);
      }
    }
  }

  const result = {
    ok: errors.length === 0,
    entry_points: boundary.entry_points,
    closure: [...closure].sort(),
    external_packages: [...externalSeen].sort(),
    runtime_assets: runtimeAssets,
    removed_internal_roots: removed,
    layer_rules: layerRules.map((rule) => rule.name),
    discovered_adapter_ids: [...discoveredAdapterIds].sort(),
    errors,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}

main();
