#!/usr/bin/env node
// AC4 — Enforce the product boundary natively.
//
// Resolves the transitive internal module graph from the product entry points in
// product/source-boundary.v1.json against tracked target HEAD blobs. Rejects any
// edge outside allowed_internal_paths, into a forbidden_internal_root, or that
// escapes the repository; classifies node: / bare-core specifiers against the
// pinned Node 22 built-in set (never as npm rows); requires the full transitive
// closure to resolve locally. Bare npm imports/package CLIs are handed to
// check-dependencies.mjs (this tool only asserts they are declared external).
//
// Node builtins only; safe to run before `npm ci`.
import { spawnSync } from 'node:child_process';
import { dirname, posix } from 'node:path';
import process from 'node:process';

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

function git(...args) {
  const r = spawnSync('/usr/local/bin/git', ['-C', REPO, ...args], {
    encoding: 'buffer', maxBuffer: 1 << 28,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function headTree() {
  const out = git('ls-tree', '-rz', '--format=%(objectmode) %(objectname) %(path)', 'HEAD');
  const tree = new Map();
  for (const entry of out.toString('utf8').split('\0')) {
    if (!entry.trim()) continue;
    const [mode, oid, ...rest] = entry.split(' ');
    tree.set(rest.join(' '), { mode, oid });
  }
  return tree;
}

function blob(tree, path) {
  const e = tree.get(path);
  if (!e) return null;
  return git('cat-file', 'blob', e.oid).toString('utf8');
}

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
  const tree = headTree();
  const boundary = JSON.parse(blob(tree, 'product/source-boundary.v1.json'));
  const allowed = boundary.allowed_internal_paths;
  const forbidden = boundary.forbidden_internal_roots;
  const external = new Set(boundary.allowed_external_runtime_packages);
  const errors = [];

  const isAllowed = (p) => allowed.some((g) => matchesGlob(p, g));
  const isForbidden = (p) => forbidden.some((g) => matchesGlob(p, g));

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
    const text = blob(tree, p);
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
    errors,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}

main();
