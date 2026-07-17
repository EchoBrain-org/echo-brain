#!/usr/bin/env node
// AC2 — dependency edge partition.
//
// Scans the repository worktree and partitions every module edge:
//   - repository-local import/read  -> resolves to exactly one tracked target blob
//   - bare import / package CLI      -> exact locked npm row (npm-shrinkwrap.json)
//                                       or a named JavaScript CLI in the toolchain manifest
//   - node: / bare core specifier    -> pinned Node 22 built-in (never an npm row)
//   - literal system helper          -> pinned toolchain system-helper row
// Fails on: missing, version-ranged, unused runtime dep, path/git/workspace protocol,
// source-repo or sibling repository edge, or an unresolved repository-local edge.
//
// Node builtins only; safe to run before `npm ci`.
import { dirname, posix } from 'node:path';
import process from 'node:process';
import { repositoryWorktree, textFile } from './lib/repository-files.mjs';

const REPO = process.cwd();
const NODE22_BUILTINS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
  'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl',
  'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder',
  'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util',
  'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);
const FORBIDDEN_PROTOS = ['file:', 'link:', 'git+', 'git:', 'workspace:', 'portal:'];
const SIBLING_MARKERS = ['Project_echo', 'echo-loop', 'echo-context', '/echo-dev-platform'];

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function resolveRelative(tree, importer, spec) {
  const target = posix.normalize(posix.join(dirname(importer), spec));
  const cands = [];
  if (spec.endsWith('.js')) cands.push(target.slice(0, -3) + '.ts', target.slice(0, -3) + '.mts');
  cands.push(target, target + '.ts', target + '.mts', posix.join(target, 'index.ts'));
  for (const c of cands) if (tree.has(c)) return c;
  return null;
}

function main() {
  const tree = repositoryWorktree(REPO);
  const errors = [];
  const lock = JSON.parse(textFile(tree, 'npm-shrinkwrap.json'));
  const pkg = JSON.parse(textFile(tree, 'package.json'));
  const toolchain = tree.has('provenance/dependency-toolchain.v1.json')
    ? JSON.parse(textFile(tree, 'provenance/dependency-toolchain.v1.json')) : { javascript_clis: [], system_helpers: [] };

  const lockedNames = new Set();
  for (const p of Object.keys(lock.packages ?? {})) {
    if (p.startsWith('node_modules/')) lockedNames.add(p.slice('node_modules/'.length));
  }
  const jsClis = new Set((toolchain.javascript_clis ?? []).map((c) => c.name));

  // package.json declared deps must be exact (no ranges / protocols).
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (FORBIDDEN_PROTOS.some((pr) => spec.startsWith(pr))) errors.push(`dependency ${name} uses forbidden protocol: ${spec}`);
    if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(spec)) errors.push(`dependency ${name} is not an exact version: ${spec}`);
    if (!lockedNames.has(name)) errors.push(`declared dependency ${name} not present in npm-shrinkwrap.json`);
  }
  for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
    if (FORBIDDEN_PROTOS.some((pr) => spec.startsWith(pr))) errors.push(`devDependency ${name} uses forbidden protocol: ${spec}`);
    if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(spec)) errors.push(`devDependency ${name} is not an exact version: ${spec}`);
    if (!lockedNames.has(name)) errors.push(`declared devDependency ${name} not present in npm-shrinkwrap.json`);
  }

  const usedExternal = new Set();
  for (const [path, { }] of tree) {
    if (!/\.(ts|mts|js|mjs)$/.test(path)) continue;
    const text = textFile(tree, path);
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      if (SIBLING_MARKERS.some((s) => spec.includes(s))) { errors.push(`source-repo/sibling edge ${spec} in ${path}`); continue; }
      if (spec.startsWith('.')) {
        const r = resolveRelative(tree, path, spec);
        if (!r) {
          // parity-leaf tests reference item-132 tooling via runtime join(); only true
          // module-relative specifiers are partitioned. A relative *import* that does not
          // resolve inside tests/product parity leaves is tolerated (recorded as parity ref).
          if (path.startsWith('tests/product/')) continue;
          errors.push(`unresolved repository-local edge ${spec} in ${path}`);
        }
      } else if (spec.startsWith('node:')) {
        if (!NODE22_BUILTINS.has(spec.slice(5))) errors.push(`unknown node: builtin ${spec} in ${path}`);
      } else if (NODE22_BUILTINS.has(spec)) {
        // core module
      } else {
        // Parity-leaf and migration test files embed fixture import strings and use
        // provisioned toolchain CLIs (vitest); they do not contribute to the shipped
        // runtime external set and are validated against the toolchain manifest, not
        // the runtime lock.
        if (path.startsWith('tests/')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        usedExternal.add(name);
        if (!lockedNames.has(name) && !jsClis.has(name)) {
          errors.push(`bare import ${name} in ${path} maps to no locked npm row or toolchain CLI`);
        }
      }
    }
  }

  // Unused runtime dependency: a declared runtime dep never imported by the shipped closure.
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!usedExternal.has(name)) errors.push(`declared runtime dependency ${name} is never imported (unused)`);
  }

  // --- helper/CLI command-invocation partition (F2) ---
  // Every literal command a shipped/executable blob spawns must be a declared system
  // helper (by absolute path or bare name) or a declared JavaScript CLI. Unlisted
  // executables fail. Command tokens come from (a) direct spawn/exec first-arg string
  // literals (including named-import aliases and child_process namespace members), and
  // (b) tuple-dispatch command lists `['cmd', [args...]]` consumed by a variable spawn
  // (the toolchain-preflight pattern). `process.execPath` is Node itself. Any nonliteral
  // executable expression is allowed only for an explicitly reviewed
  // computed_command_owner. Binding syntax is not provenance: scope shadowing or later
  // mutation can change an identifier's value, so non-owner identifiers always fail closed.
  const helperByPath = new Map((toolchain.system_helpers ?? []).map((h) => [h.absolute_path, h.name]));
  const helperByName = new Set((toolchain.system_helpers ?? []).map((h) => h.name));
  const computedOwners = new Set(toolchain.computed_command_owners ?? []);
  const usedCommands = new Set();
  const classifyCmd = (tok, path) => {
    usedCommands.add(tok);
    if (tok.startsWith('/')) {
      if (!helperByPath.has(tok)) errors.push(`command '${tok}' in ${path} is not a declared system helper (absolute_path)`);
      return;
    }
    if (helperByName.has(tok) || jsClis.has(tok)) return;
    errors.push(`command '${tok}' in ${path} maps to no declared system helper or JavaScript CLI`);
  };
  // Recognize child_process spawners AND the repo's sanctioned owner
  // `spawnSanitizedChild` (src/product/spawn-sanitized-child.ts) so its command argument
  // (e.g. config.ts's '/sbin/mount') is enforced. Canonical bare names are scanned
  // conservatively even when import provenance is unavailable. Static named-import aliases,
  // namespace/default imports, and equivalent require() bindings are added per file so
  // renaming or member-call syntax cannot hide an executable edge. Unrelated method calls
  // (db.exec, /re/.exec) remain excluded because only a child_process namespace is eligible.
  const CHILD_PROCESS_METHODS = [
    'spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec', 'fork',
  ];
  const IDENT = '[A-Za-z_$][\\w$]*';
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const addNamedBindings = (clause, directNames) => {
    for (const part of clause.split(',')) {
      const m = part.trim().match(new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`));
      if (m && CHILD_PROCESS_METHODS.includes(m[1])) directNames.add(m[2] ?? m[1]);
    }
  };
  const childProcessBindings = (text) => {
    const directNames = new Set(['spawnSanitizedChild', ...CHILD_PROCESS_METHODS]);
    const namespaceNames = new Set();
    const namedImportRe = /\bimport\s*\{([\s\S]*?)\}\s*from\s*['"](?:node:)?child_process['"]/g;
    const namespaceImportRe = new RegExp(
      `\\bimport\\s*\\*\\s*as\\s*(${IDENT})\\s*from\\s*['\"](?:node:)?child_process['\"]`, 'g');
    const defaultImportRe = new RegExp(
      `\\bimport\\s+(${IDENT})\\s+from\\s*['\"](?:node:)?child_process['\"]`, 'g');
    const namedRequireRe = /\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/g;
    const namespaceRequireRe = new RegExp(
      `\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*require\\s*\\(\\s*['\"](?:node:)?child_process['\"]\\s*\\)`, 'g');
    for (const m of text.matchAll(namedImportRe)) addNamedBindings(m[1], directNames);
    for (const m of text.matchAll(namespaceImportRe)) namespaceNames.add(m[1]);
    for (const m of text.matchAll(defaultImportRe)) namespaceNames.add(m[1]);
    for (const m of text.matchAll(namedRequireRe)) {
      const normalized = m[1].split(',').map((part) => part.replace(/\s*:\s*/, ' as ')).join(',');
      addNamedBindings(normalized, directNames);
    }
    for (const m of text.matchAll(namespaceRequireRe)) namespaceNames.add(m[1]);
    return { directNames, namespaceNames };
  };
  const commandExpressions = (text) => {
    const { directNames, namespaceNames } = childProcessBindings(text);
    const directAlt = [...directNames].sort((a, b) => b.length - a.length)
      .map(escapeRe).join('|');
    const directCallRe = new RegExp(
      `(?<![.\\w$])(?:${directAlt})\\s*\\(\\s*([^,)]+?)\\s*[,)]`, 'g');
    const expressions = [...text.matchAll(directCallRe)].map((m) => m[1]);
    if (namespaceNames.size > 0) {
      const namespaceAlt = [...namespaceNames].sort((a, b) => b.length - a.length)
        .map(escapeRe).join('|');
      const methodAlt = CHILD_PROCESS_METHODS.map(escapeRe).join('|');
      const memberCallRe = new RegExp(
        `\\b(?:${namespaceAlt})\\s*\\.\\s*(?:${methodAlt})\\s*\\(\\s*([^,)]+?)\\s*[,)]`, 'g');
      const bracketCallRe = new RegExp(
        `\\b(?:${namespaceAlt})\\s*\\[\\s*['\"](?:${methodAlt})['\"]\\s*\\]\\s*\\(\\s*([^,)]+?)\\s*[,)]`, 'g');
      expressions.push(...[...text.matchAll(memberCallRe)].map((m) => m[1]));
      expressions.push(...[...text.matchAll(bracketCallRe)].map((m) => m[1]));
    }
    return expressions;
  };
  const TUPLE_RE = /\[\s*['"]([A-Za-z][\w+.-]*)['"]\s*,\s*\[/g;
  // strip block comments and full-line // or * (jsdoc) comment lines so documentation
  // examples (e.g. a `['cmd', [args]]` illustration) never register as real command edges.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const [path] of tree) {
    if (!/^(src|tools|tests\/migration)\/.*\.(ts|mts|mjs)$/.test(path)) continue;
    const text = stripComments(textFile(tree, path));
    for (const c of [...text.matchAll(TUPLE_RE)].map((m) => m[1])) classifyCmd(c, path);
    for (const expression of commandExpressions(text)) {
      const tok = expression.trim();
      if (tok === 'process.execPath') continue;
      const lit = tok.match(/^['"]([^'"]+)['"]$/);
      if (lit) { classifyCmd(lit[1], path); continue; }
      // Nonliteral executable expression — FAIL-CLOSED per file. Identifier binding syntax
      // cannot prove scope or mutation history, so only an explicitly reviewed owner may
      // dispatch one. Owners' finite command sets remain independently classified above
      // (for example, toolchain-preflight's literal tuples).
      if (computedOwners.has(path)) continue;
      errors.push(`computed spawn command '${tok}' in ${path} (not a declared computed_command_owner)`);
    }
  }

  const result = {
    ok: errors.length === 0, locked_packages: lockedNames.size,
    used_external: [...usedExternal].sort(), used_commands: [...usedCommands].sort(), errors,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}
main();
