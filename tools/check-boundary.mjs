#!/usr/bin/env node
// AC4 — Enforce the product boundary natively.
//
// Resolves the transitive internal module graph from the product entry points in
// product/source-boundary.v1.json against the repository worktree. Rejects any
// edge outside allowed_internal_paths, into a forbidden_internal_root, or that
// escapes the repository; classifies node: / bare-core specifiers against the
// pinned Node 22 built-in set (never as npm rows); requires the full transitive
// closure to resolve locally and enforces product-wide and per-layer package
// and Node-builtin allowlists.
//
import { dirname, posix } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { collectModuleReferences } from './lib/module-references.mjs';
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

const WORKSPACE_BOUNDARY_REGISTRY = 'tools/workspace-source-boundaries.v1.json';
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;

function matchesGlob(path, pattern) {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (!pattern.includes('*')) return path === pattern;
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

function isRepositoryPath(path) {
  return (
    typeof path === 'string' &&
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    posix.normalize(path) === path &&
    path !== '..' &&
    !path.startsWith('../')
  );
}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function moduleReferences(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return collectModuleReferences(sourceFile);
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

function parseJsonFile(tree, path, errors) {
  const source = textFile(tree, path);
  if (source === null) {
    errors.push(`workspace boundary file is missing: ${path}`);
    return null;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(`workspace boundary JSON is invalid at ${path}: ${error.message}`);
    return null;
  }
}

function packageName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

function runtimeDependencies(packageJson) {
  return new Map(
    Object.entries({
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
      ...(packageJson.peerDependencies ?? {}),
    }),
  );
}

function exportPatternMatches(subpath, pattern) {
  if (pattern === subpath) return true;
  const star = pattern.indexOf('*');
  if (star === -1) return false;
  return (
    subpath.startsWith(pattern.slice(0, star)) &&
    subpath.endsWith(pattern.slice(star + 1))
  );
}

function isPublicWorkspaceSpecifier(specifier, workspaceName, packageJson) {
  const subpath = specifier === workspaceName ? '.' : `.${specifier.slice(workspaceName.length)}`;
  const exports = packageJson.exports;
  if (typeof exports === 'string') return subpath === '.';
  if (exports === null || typeof exports !== 'object' || Array.isArray(exports)) return false;
  const keys = Object.keys(exports);
  if (keys.every((key) => !key.startsWith('.'))) return subpath === '.';
  return keys.some((key) => exportPatternMatches(subpath, key));
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkWorkspaceBoundaries(tree, errors) {
  const registry = parseJsonFile(tree, WORKSPACE_BOUNDARY_REGISTRY, errors);
  if (registry === null) return [];
  if (
    registry.registry_version !== 1 ||
    registry.kind !== 'echo-workspace-source-boundary-registry' ||
    !Array.isArray(registry.manifests)
  ) {
    errors.push(`invalid workspace boundary registry: ${WORKSPACE_BOUNDARY_REGISTRY}`);
    return [];
  }
  if (new Set(registry.manifests).size !== registry.manifests.length) {
    errors.push(`workspace boundary registry contains duplicate manifest paths`);
  }

  const boundaries = [];
  for (const manifestPath of registry.manifests) {
    if (!isRepositoryPath(manifestPath)) {
      errors.push('workspace boundary registry contains a non-string manifest path');
      continue;
    }
    const manifest = parseJsonFile(tree, manifestPath, errors);
    if (manifest === null) continue;
    if (
      manifest.boundary_version !== 1 ||
      manifest.kind !== 'echo-workspace-source-boundary' ||
      typeof manifest.name !== 'string' ||
      typeof manifest.workspace !== 'boolean' ||
      typeof manifest.boundary_root !== 'string' ||
      typeof manifest.source_root !== 'string' ||
      (manifest.workspace === true && typeof manifest.package_json !== 'string') ||
      !isStringArray(manifest.entry_points) ||
      !isStringArray(manifest.owned_source_paths) ||
      !isStringArray(manifest.allowed_internal_paths) ||
      !isStringArray(manifest.allowed_workspace_packages) ||
      !isStringArray(manifest.allowed_external_packages) ||
      !isStringArray(manifest.allowed_node_builtins) ||
      !isStringArray(manifest.forbidden_repository_roots ?? []) ||
      !isStringArray(manifest.runtime_assets ?? []) ||
      !Array.isArray(manifest.layer_rules)
    ) {
      errors.push(`invalid workspace source boundary manifest: ${manifestPath}`);
      continue;
    }
    if (manifest.name === '' || manifest.entry_points.length === 0 || manifest.owned_source_paths.length === 0) {
      errors.push(`${manifestPath}: boundary name, entry_points, and owned_source_paths must be non-empty`);
    }
    if (!isRepositoryPath(manifest.boundary_root)) {
      errors.push(`${manifest.name}: boundary_root is not a normalized repository path`);
    }
    if (
      !isRepositoryPath(manifest.source_root) ||
      !isWithin(manifest.source_root, manifest.boundary_root)
    ) {
      errors.push(`${manifest.name}: source_root must be contained by boundary_root`);
    }
    if (
      manifest.workspace === true &&
      (!isRepositoryPath(manifest.package_json) ||
        !isWithin(manifest.package_json, manifest.boundary_root))
    ) {
      errors.push(`${manifest.name}: package_json must be contained by boundary_root`);
    }
    if (manifest.workspace === false && manifest.package_json !== undefined) {
      errors.push(`${manifest.name}: non-workspace boundaries must not claim a package_json`);
    }
    for (const [field, paths, containmentRoot] of [
      ['entry_points', manifest.entry_points, manifest.source_root],
      ['owned_source_paths', manifest.owned_source_paths, manifest.source_root],
      ['runtime_assets', manifest.runtime_assets ?? [], manifest.boundary_root],
    ]) {
      for (const path of paths) {
        if (!isRepositoryPath(path) || !isWithin(path, containmentRoot)) {
          errors.push(`${manifest.name}: ${field} path leaves ${containmentRoot}: ${path}`);
        }
      }
    }
    for (const [field, paths] of [
      ['allowed_internal_paths', manifest.allowed_internal_paths],
      ['forbidden_repository_roots', manifest.forbidden_repository_roots ?? []],
    ]) {
      for (const path of paths) {
        if (!isRepositoryPath(path)) {
          errors.push(`${manifest.name}: ${field} contains a non-normalized path: ${path}`);
        }
      }
    }
    let layerRulesAreValid = true;
    const layerRuleNames = new Set();
    for (const rule of manifest.layer_rules) {
      if (
        rule === null ||
        typeof rule !== 'object' ||
        typeof rule.name !== 'string' ||
        typeof rule.from !== 'string' ||
        !isStringArray(rule.allowed_imports) ||
        !isStringArray(rule.allowed_workspace_packages) ||
        !isStringArray(rule.allowed_external_packages) ||
        !isStringArray(rule.allowed_node_builtins)
      ) {
        errors.push(`${manifest.name}: invalid layer rule in ${manifestPath}`);
        layerRulesAreValid = false;
        continue;
      }
      if (layerRuleNames.has(rule.name)) {
        errors.push(`${manifest.name}: duplicate layer rule name '${rule.name}'`);
      }
      layerRuleNames.add(rule.name);
      if (!isRepositoryPath(rule.from) || !isWithin(rule.from, manifest.source_root)) {
        errors.push(`${manifest.name}: layer rule '${rule.name}' leaves source_root`);
      }
      for (const path of rule.allowed_imports) {
        if (!isRepositoryPath(path)) {
          errors.push(
            `${manifest.name}: layer rule '${rule.name}' contains a non-normalized import path: ${path}`,
          );
        }
      }
    }
    if (!layerRulesAreValid) continue;
    boundaries.push({ manifestPath, manifest });
  }

  const rootPackage = parseJsonFile(tree, 'package.json', errors);
  const workspaceBoundaries = boundaries.filter(({ manifest }) => manifest.workspace === true);
  const declaredWorkspaces = Array.isArray(rootPackage?.workspaces)
    ? [...rootPackage.workspaces].sort()
    : [];
  const manifestWorkspaces = workspaceBoundaries
    .map(({ manifest }) => manifest.boundary_root)
    .sort();
  if (JSON.stringify(declaredWorkspaces) !== JSON.stringify(manifestWorkspaces)) {
    errors.push(
      `root workspaces do not match checked workspace boundaries: declared=${JSON.stringify(declaredWorkspaces)} checked=${JSON.stringify(manifestWorkspaces)}`,
    );
  }

  const workspaceByName = new Map();
  const boundaryNames = new Set();
  for (const { manifest } of boundaries) {
    if (boundaryNames.has(manifest.name)) errors.push(`duplicate boundary name: ${manifest.name}`);
    boundaryNames.add(manifest.name);
  }
  for (let index = 0; index < boundaries.length; index += 1) {
    for (let other = index + 1; other < boundaries.length; other += 1) {
      const left = boundaries[index].manifest;
      const right = boundaries[other].manifest;
      if (isWithin(left.source_root, right.source_root) || isWithin(right.source_root, left.source_root)) {
        errors.push(
          `workspace boundary source roots overlap: ${left.name} (${left.source_root}) and ${right.name} (${right.source_root})`,
        );
      }
    }
  }
  for (const boundary of workspaceBoundaries) {
    const packageJson = parseJsonFile(tree, boundary.manifest.package_json, errors);
    boundary.packageJson = packageJson;
    if (packageJson === null) continue;
    if (packageJson.name !== boundary.manifest.name) {
      errors.push(
        `workspace package name mismatch: ${boundary.manifest.package_json} declares ${packageJson.name} but boundary declares ${boundary.manifest.name}`,
      );
      continue;
    }
    if (workspaceByName.has(packageJson.name)) {
      errors.push(`duplicate workspace package name: ${packageJson.name}`);
      continue;
    }
    workspaceByName.set(packageJson.name, boundary);
  }

  for (const boundary of boundaries) {
    if (boundary.manifest.workspace !== true) boundary.packageJson = rootPackage;
  }

  for (const [path] of tree) {
    if (!SOURCE_FILE_RE.test(path)) continue;
    const owners = boundaries.filter(({ manifest }) =>
      manifest.owned_source_paths.some((pattern) => matchesGlob(path, pattern)),
    );
    if (owners.length > 1) {
      errors.push(
        `source file has overlapping workspace boundary owners: ${path} (${owners.map(({ manifest }) => manifest.name).join(', ')})`,
      );
    }
    for (const { manifest } of boundaries) {
      if (
        isWithin(path, manifest.source_root) &&
        !manifest.owned_source_paths.some((pattern) => matchesGlob(path, pattern))
      ) {
        errors.push(`${manifest.name}: source file is not covered by owned_source_paths: ${path}`);
      }
    }
  }

  for (const boundary of boundaries) {
    const { manifest } = boundary;
    const packageJson =
      boundary.packageJson ?? parseJsonFile(tree, manifest.package_json, errors);
    boundary.packageJson = packageJson;
    const allowedWorkspacePackages = new Set(manifest.allowed_workspace_packages);
    const allowedExternalPackages = new Set(manifest.allowed_external_packages);
    const allowedBuiltins = new Set(
      manifest.allowed_node_builtins.map((name) => name.replace(/^node:/, '')),
    );
    const forbiddenRoots = manifest.forbidden_repository_roots ?? [];
    const layerRules = manifest.layer_rules ?? [];
    const dependencies = runtimeDependencies(packageJson ?? {});

    for (const dependency of allowedWorkspacePackages) {
      if (!workspaceByName.has(dependency)) {
        errors.push(`${manifest.name}: allowed workspace package does not exist: ${dependency}`);
      } else if (dependency === manifest.name) {
        errors.push(`${manifest.name}: boundary cannot allow a workspace dependency on itself`);
      } else if (manifest.workspace === true && !dependencies.has(dependency)) {
        errors.push(`${manifest.name}: allowed workspace package is not a declared dependency: ${dependency}`);
      }
    }
    for (const dependency of allowedExternalPackages) {
      if (!dependencies.has(dependency)) {
        errors.push(`${manifest.name}: allowed external package is not a declared dependency: ${dependency}`);
      }
    }
    for (const builtin of allowedBuiltins) {
      if (!NODE22_BUILTINS.has(builtin)) {
        errors.push(`${manifest.name}: boundary allowlists unknown Node builtin: ${builtin}`);
      }
    }
    for (const rule of layerRules) {
      for (const dependency of rule.allowed_workspace_packages) {
        if (!allowedWorkspacePackages.has(dependency)) {
          errors.push(
            `${manifest.name}: layer rule '${rule.name}' allows workspace package outside boundary allowlist: ${dependency}`,
          );
        }
      }
      for (const path of rule.allowed_imports) {
        if (!manifest.allowed_internal_paths.some((pattern) => matchesGlob(path, pattern))) {
          errors.push(
            `${manifest.name}: layer rule '${rule.name}' allows internal path outside boundary allowlist: ${path}`,
          );
        }
      }
      for (const dependency of rule.allowed_external_packages) {
        if (!allowedExternalPackages.has(dependency)) {
          errors.push(
            `${manifest.name}: layer rule '${rule.name}' allows external package outside boundary allowlist: ${dependency}`,
          );
        }
      }
      for (const builtin of rule.allowed_node_builtins.map((name) => name.replace(/^node:/, ''))) {
        if (!allowedBuiltins.has(builtin)) {
          errors.push(
            `${manifest.name}: layer rule '${rule.name}' allows Node builtin outside boundary allowlist: ${builtin}`,
          );
        }
      }
    }

    for (const entryPoint of manifest.entry_points) {
      if (!tree.has(entryPoint)) {
        errors.push(`${manifest.name}: boundary entry point is missing: ${entryPoint}`);
      } else if (!manifest.owned_source_paths.some((pattern) => matchesGlob(entryPoint, pattern))) {
        errors.push(`${manifest.name}: boundary entry point is not owned: ${entryPoint}`);
      }
    }
    for (const asset of manifest.runtime_assets ?? []) {
      if (!tree.has(asset)) errors.push(`${manifest.name}: runtime asset is missing: ${asset}`);
    }

    if (manifest.workspace === true && packageJson !== null) {
      for (const [dependency, version] of dependencies) {
        const target = workspaceByName.get(dependency);
        if (target !== undefined) {
          if (!allowedWorkspacePackages.has(dependency)) {
            errors.push(`${manifest.name}: undeclared workspace dependency direction to ${dependency}`);
          }
          if (version !== target.packageJson?.version) {
            errors.push(
              `${manifest.name}: workspace dependency ${dependency} must exactly match version ${target.packageJson?.version ?? '<missing>'}`,
            );
          }
        } else if (!allowedExternalPackages.has(dependency)) {
          errors.push(`${manifest.name}: external dependency ${dependency} is not boundary-allowlisted`);
        }
      }
    }

    for (const [path] of tree) {
      if (
        !SOURCE_FILE_RE.test(path) ||
        !manifest.owned_source_paths.some((pattern) => matchesGlob(path, pattern))
      ) {
        continue;
      }
      const source = textFile(tree, path);
      const matchingLayerRules = layerRules.filter((rule) => matchesGlob(path, rule.from));
      if (matchingLayerRules.length === 0) {
        errors.push(`${manifest.name}: owned source file has no layer rule: ${path}`);
      } else if (matchingLayerRules.length > 1) {
        errors.push(
          `${manifest.name}: owned source file matches multiple layer rules: ${path} (${matchingLayerRules.map((rule) => rule.name).join(', ')})`,
        );
      }
      for (const reference of moduleReferences(path, source)) {
        const specifier = reference.specifier;
        if (reference.kind === 'module-loader') {
          errors.push(
            `${manifest.name}: module loaders are forbidden; use a static import or import() in ${path}:${reference.line}`,
          );
          continue;
        }
        if (specifier === null) {
          errors.push(
            `${manifest.name}: non-literal module loading is forbidden in ${path}:${reference.line} (${reference.kind})`,
          );
          continue;
        }
        if (specifier.startsWith('.')) {
          const resolved = resolveRelative(tree, path, specifier);
          if (resolved === null) {
            errors.push(`${manifest.name}: unresolved repository edge ${specifier} from ${path}`);
            continue;
          }
          if (forbiddenRoots.some((root) => matchesGlob(resolved, root))) {
            errors.push(`${manifest.name}: edge enters forbidden root: ${path} -> ${resolved}`);
          }
          if (!manifest.allowed_internal_paths.some((pattern) => matchesGlob(resolved, pattern))) {
            errors.push(`${manifest.name}: edge leaves allowed source boundary: ${path} -> ${resolved}`);
          }
          for (const rule of matchingLayerRules) {
            if (!(rule.allowed_imports ?? []).some((pattern) => matchesGlob(resolved, pattern))) {
              errors.push(`${manifest.name}: layer rule '${rule.name}' rejects edge: ${path} -> ${resolved}`);
            }
          }
          continue;
        }

        const builtin = specifier.replace(/^node:/, '');
        if (specifier.startsWith('node:') || NODE22_BUILTINS.has(specifier)) {
          if (!NODE22_BUILTINS.has(builtin)) {
            errors.push(`${manifest.name}: unknown Node builtin ${specifier} from ${path}`);
          } else if (!allowedBuiltins.has(builtin)) {
            errors.push(`${manifest.name}: Node builtin ${specifier} is not boundary-allowlisted in ${path}`);
          }
          for (const rule of matchingLayerRules) {
            const layerBuiltins = (rule.allowed_node_builtins ?? []).map((name) =>
              name.replace(/^node:/, ''),
            );
            if (!layerBuiltins.includes(builtin)) {
              errors.push(
                `${manifest.name}: layer rule '${rule.name}' rejects Node builtin ${specifier} in ${path}`,
              );
            }
          }
          continue;
        }

        const importedPackage = packageName(specifier);
        const workspace = workspaceByName.get(importedPackage);
        if (workspace !== undefined) {
          if (!allowedWorkspacePackages.has(importedPackage)) {
            errors.push(`${manifest.name}: workspace import ${importedPackage} is not allowed in ${path}`);
          }
          if (!dependencies.has(importedPackage)) {
            errors.push(`${manifest.name}: workspace import ${importedPackage} is not a declared dependency`);
          }
          if (!isPublicWorkspaceSpecifier(specifier, importedPackage, workspace.packageJson ?? {})) {
            errors.push(`${manifest.name}: workspace deep import is not exported: ${specifier} in ${path}`);
          }
          for (const rule of matchingLayerRules) {
            if (!(rule.allowed_workspace_packages ?? []).includes(importedPackage)) {
              errors.push(
                `${manifest.name}: layer rule '${rule.name}' rejects workspace import ${importedPackage} in ${path}`,
              );
            }
          }
        } else {
          if (!allowedExternalPackages.has(importedPackage)) {
            errors.push(`${manifest.name}: external import ${importedPackage} is not allowed in ${path}`);
          }
          if (!dependencies.has(importedPackage)) {
            errors.push(`${manifest.name}: external import ${importedPackage} is not a declared dependency`);
          }
          for (const rule of matchingLayerRules) {
            if (!(rule.allowed_external_packages ?? []).includes(importedPackage)) {
              errors.push(
                `${manifest.name}: layer rule '${rule.name}' rejects external import ${importedPackage} in ${path}`,
              );
            }
          }
        }
      }
    }
  }

  return boundaries
    .map(({ manifest }) => ({
      name: manifest.name,
      root: manifest.boundary_root,
      entry_points: [...manifest.entry_points].sort(),
      allowed_workspace_packages: [...manifest.allowed_workspace_packages].sort(),
      layer_rules: (manifest.layer_rules ?? []).map((rule) => rule.name).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
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
  const workspaceBoundaries = checkWorkspaceBoundaries(tree, errors);
  const runtimeAssets = boundary.runtime_assets ?? [];
  for (const asset of runtimeAssets) {
    if (!tree.has(asset)) errors.push(`runtime asset missing from worktree: ${asset}`);
  }

  const isAllowed = (p) => allowed.some((g) => matchesGlob(p, g));
  const isForbidden = (p) => forbidden.some((g) => matchesGlob(p, g));

  for (const rule of layerRules) {
    if (
      !isStringArray(rule.allowed_imports) ||
      !isStringArray(rule.allowed_packages) ||
      !isStringArray(rule.allowed_node_builtins)
    ) {
      errors.push(`layer rule '${String(rule.name)}' has an invalid allowlist`);
      continue;
    }
    for (const dependency of rule.allowed_packages) {
      if (!external.has(dependency)) {
        errors.push(
          `layer rule '${rule.name}' allows package outside the product boundary: ${dependency}`,
        );
      }
    }
    for (const builtin of rule.allowed_node_builtins.map((name) =>
      name.replace(/^node:/, ''),
    )) {
      if (!NODE22_BUILTINS.has(builtin)) {
        errors.push(
          `layer rule '${rule.name}' allows unknown Node builtin: ${builtin}`,
        );
      }
    }
  }

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
        !SOURCE_FILE_RE.test(path)
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
    if (!SOURCE_FILE_RE.test(path)) continue;
    const matchingRules = layerRules.filter((rule) => matchesGlob(path, rule.from));
    if (matchingRules.length === 0) {
      if (isAllowed(path)) {
        errors.push(`product source file has no layer rule: ${path}`);
      }
      continue;
    }
    const source = textFile(tree, path);
    for (const reference of moduleReferences(path, source)) {
      const spec = reference.specifier;
      if (spec === null) {
        errors.push(
          `layer rule rejects non-literal module loading from ${path}:${reference.line}`,
        );
        continue;
      }
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(tree, path, spec);
        if (resolved === null) continue;
        for (const rule of matchingRules) {
          if (
            !rule.allowed_imports.some((pattern) =>
              matchesGlob(resolved, pattern),
            )
          ) {
            errors.push(
              `layer rule '${rule.name}' rejects edge: ${path} -> ${resolved}`,
            );
          }
        }
        continue;
      }

      const builtin = spec.replace(/^node:/, '');
      if (spec.startsWith('node:') || NODE22_BUILTINS.has(spec)) {
        for (const rule of matchingRules) {
          if (
            !(rule.allowed_node_builtins ?? [])
              .map((name) => name.replace(/^node:/, ''))
              .includes(builtin)
          ) {
            errors.push(
              `layer rule '${rule.name}' rejects Node builtin ${spec} in ${path}`,
            );
          }
        }
        continue;
      }

      const importedPackage = packageName(spec);
      for (const rule of matchingRules) {
        if (!(rule.allowed_packages ?? []).includes(importedPackage)) {
          errors.push(
            `layer rule '${rule.name}' rejects package ${importedPackage} in ${path}`,
          );
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
    for (const reference of moduleReferences(p, text)) {
      const spec = reference.specifier;
      if (spec === null) {
        errors.push(`non-literal module loading from ${p}:${reference.line} (${reference.kind})`);
        continue;
      }
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
    workspace_boundaries: workspaceBoundaries,
    errors,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}

main();
