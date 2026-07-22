#!/usr/bin/env node

import { builtinModules } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import {
  collectModuleReferences,
  literalText,
} from '../lib/module-references.mjs';

const BUILTINS = new Set(
  builtinModules.flatMap((name) => {
    const plain = name.replace(/^node:/, '');
    return [plain, `node:${plain}`];
  }),
);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

class BoundaryError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'BoundaryError';
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {
    manifest: 'product/source-boundary.v1.json',
    output: undefined,
    projectRoot: process.cwd(),
    seedInventory: false,
    roots: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seed-inventory') {
      args.seedInventory = true;
    } else if (arg === '--manifest') {
      args.manifest = requireValue(argv, ++i, arg);
    } else if (arg === '--output') {
      args.output = requireValue(argv, ++i, arg);
    } else if (arg === '--project-root') {
      args.projectRoot = requireValue(argv, ++i, arg);
    } else if (arg === '--roots') {
      i += 1;
      while (i < argv.length && !argv[i].startsWith('--')) {
        args.roots.push(argv[i]);
        i += 1;
      }
      i -= 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage:',
          '  node tools/product/check-boundary.mjs [--manifest PATH] [--output PATH]',
          '  node tools/product/check-boundary.mjs --seed-inventory --roots PATH... [--output PATH]',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new BoundaryError(`unknown argument: ${arg}`);
    }
  }
  if (args.seedInventory && args.roots.length === 0) {
    throw new BoundaryError('--seed-inventory requires at least one path after --roots');
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new BoundaryError(`${flag} requires a value`);
  }
  return value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new BoundaryError(`cannot read JSON ${path}: ${error.message}`);
  }
}

function normalizeRelative(projectRoot, path) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  const rel = relative(projectRoot, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BoundaryError(`path is outside project root: ${path}`);
  }
  return rel.split(sep).join('/');
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function isInternalSpecifier(specifier) {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('src/')
  );
}

function globRegex(pattern) {
  let expression = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      expression += '.*';
      i += 1;
    } else if (char === '*') {
      expression += '[^/]*';
    } else if ('\\^$+?.()|{}[]'.includes(char)) {
      expression += `\\${char}`;
    } else {
      expression += char;
    }
  }
  return new RegExp(`${expression}$`);
}

function pathMatches(path, patterns) {
  return patterns.some((pattern) => globRegex(pattern).test(path));
}

function compilerOptions(projectRoot) {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) {
    return {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new BoundaryError(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
}

function collectBuiltinChildProcessAccesses(sourceFile) {
  const accesses = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getBuiltinModule'
    ) {
      const specifier = literalText(node.arguments[0] ?? node.expression);
      if (specifier?.replace(/^node:/, '') === 'child_process') {
        accesses.push({
          kind: 'getBuiltinModule',
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return accesses;
}

function resolveInternal(specifier, containingFile, projectRoot, options) {
  const normalizedSpecifier = specifier.startsWith('src/')
    ? resolve(projectRoot, specifier)
    : specifier;
  const resolvedModule = ts.resolveModuleName(
    normalizedSpecifier,
    containingFile,
    options,
    ts.sys,
  ).resolvedModule;
  let resolvedFile = resolvedModule?.resolvedFileName;
  if (resolvedFile === undefined && isAbsolute(normalizedSpecifier)) {
    for (const extension of ['', ...SOURCE_EXTENSIONS]) {
      const candidate = `${normalizedSpecifier}${extension}`;
      if (ts.sys.fileExists(candidate)) {
        resolvedFile = candidate;
        break;
      }
    }
  }
  if (resolvedFile === undefined) {
    throw new BoundaryError(
      `unresolved internal module '${specifier}' from ${normalizeRelative(projectRoot, containingFile)}`,
    );
  }
  const withoutDeclaration = resolvedFile.replace(/\.d\.(?:ts|mts|cts)$/, '.ts');
  const normalized = normalizeRelative(projectRoot, withoutDeclaration);
  if (!SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension))) {
    throw new BoundaryError(`internal module resolved to unsupported file: ${normalized}`);
  }
  return normalized;
}

function scanGraph({ projectRoot, roots, manifest }) {
  const options = compilerOptions(projectRoot);
  const queue = roots.map((path) => normalizeRelative(projectRoot, path));
  const visited = new Set();
  const externals = new Set();
  const violations = [];
  const allowedPaths = manifest?.allowed_internal_paths ?? [];
  const forbiddenRoots = manifest?.forbidden_internal_roots ?? [];
  const allowedPackages = new Set(manifest?.allowed_external_runtime_packages ?? []);
  const childProcessOwner = manifest?.child_process_owner ?? 'src/product/spawn-sanitized-child.ts';

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (manifest !== undefined) {
      if (!pathMatches(current, allowedPaths)) {
        violations.push(`${current}: path is outside allowed_internal_paths`);
      }
      if (
        forbiddenRoots.some(
          (root) => current === root.replace(/\/$/, '') || current.startsWith(root),
        )
      ) {
        violations.push(`${current}: path enters forbidden_internal_roots`);
      }
    }

    const absolute = resolve(projectRoot, current);
    let sourceText;
    try {
      sourceText = readFileSync(absolute, 'utf8');
    } catch (error) {
      violations.push(`${current}: cannot read source: ${error.message}`);
      continue;
    }
    const sourceFile = ts.createSourceFile(
      absolute,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const reference of collectModuleReferences(sourceFile)) {
      const label = `${current}:${reference.line} (${reference.kind})`;
      if (reference.specifier === null) {
        violations.push(`${label}: non-literal module loading is forbidden`);
        continue;
      }
      const specifier = reference.specifier;
      if (isInternalSpecifier(specifier)) {
        try {
          const resolvedPath = resolveInternal(specifier, absolute, projectRoot, options);
          queue.push(resolvedPath);
        } catch (error) {
          violations.push(`${label}: ${error.message}`);
        }
        continue;
      }
      if (BUILTINS.has(specifier)) {
        if (
          manifest !== undefined &&
          specifier.replace(/^node:/, '') === 'child_process' &&
          current !== childProcessOwner
        ) {
          violations.push(`${label}: child_process is restricted to ${childProcessOwner}`);
        }
        continue;
      }
      const external = packageName(specifier);
      externals.add(external);
      if (manifest !== undefined && !allowedPackages.has(external)) {
        violations.push(`${label}: external runtime package '${external}' is not allowlisted`);
      }
    }
  }

  if (violations.length > 0) {
    throw new BoundaryError('product source boundary rejected the module graph', violations.sort());
  }
  return {
    closure: [...visited].sort(),
    externalPackages: [...externals].sort(),
  };
}

function scanProductTestChildProcessAccess(projectRoot, childProcessOwner) {
  const testRoot = resolve(projectRoot, 'tests/product');
  const files = ts.sys.readDirectory(testRoot, SOURCE_EXTENSIONS, undefined, ['**/*']);
  const violations = [];

  for (const absolute of files) {
    const current = normalizeRelative(projectRoot, absolute);
    if (current === childProcessOwner) continue;
    const sourceFile = ts.createSourceFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const reference of collectModuleReferences(sourceFile)) {
      if (reference.specifier?.replace(/^node:/, '') === 'child_process') {
        violations.push(
          `${current}:${reference.line} (${reference.kind}): child_process is restricted to ${childProcessOwner}`,
        );
      }
    }
    for (const access of collectBuiltinChildProcessAccesses(sourceFile)) {
      violations.push(
        `${current}:${access.line} (${access.kind}): child_process is restricted to ${childProcessOwner}`,
      );
    }
  }

  if (violations.length > 0) {
    throw new BoundaryError(
      'product source boundary rejected direct child_process access in product tests',
      violations.sort(),
    );
  }
}

function validateManifest(manifest) {
  const requiredArrays = [
    'entry_points',
    'allowed_internal_paths',
    'forbidden_internal_roots',
    'allowed_external_runtime_packages',
  ];
  if (manifest?.boundary_version !== 1) {
    throw new BoundaryError('boundary manifest must set boundary_version to 1');
  }
  for (const field of requiredArrays) {
    if (
      !Array.isArray(manifest[field]) ||
      !manifest[field].every((value) => typeof value === 'string')
    ) {
      throw new BoundaryError(`boundary manifest field '${field}' must be an array of strings`);
    }
  }
  if (manifest.entry_points.length === 0) {
    throw new BoundaryError('boundary manifest must declare at least one entry point');
  }
  if (
    manifest.phase_1_platform?.os !== 'darwin' ||
    typeof manifest.phase_1_platform?.node !== 'string'
  ) {
    throw new BoundaryError('boundary manifest must declare phase_1_platform os=darwin and node');
  }
}

function writeResult(result, output, projectRoot) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output === undefined) {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = resolve(projectRoot, output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot);
  if (args.seedInventory) {
    const graph = scanGraph({ projectRoot, roots: args.roots });
    writeResult(
      {
        mode: 'seed-inventory',
        roots: args.roots.map((root) => normalizeRelative(projectRoot, root)).sort(),
        closure: graph.closure,
        external_packages: graph.externalPackages,
      },
      args.output,
      projectRoot,
    );
    return;
  }

  const manifestPath = resolve(projectRoot, args.manifest);
  const manifest = readJson(manifestPath);
  validateManifest(manifest);
  const graph = scanGraph({ projectRoot, roots: manifest.entry_points, manifest });
  scanProductTestChildProcessAccess(
    projectRoot,
    manifest.child_process_owner ?? 'src/product/spawn-sanitized-child.ts',
  );
  writeResult(
    {
      boundary_version: manifest.boundary_version,
      manifest: normalizeRelative(projectRoot, manifestPath),
      phase_1_platform: manifest.phase_1_platform,
      entry_points: [...manifest.entry_points].sort(),
      closure: graph.closure,
      external_packages: graph.externalPackages,
      runtime_assets: [...(manifest.runtime_assets ?? [])].sort(),
    },
    args.output,
    projectRoot,
  );
}

try {
  main();
} catch (error) {
  const details = error instanceof BoundaryError ? error.details : [];
  process.stderr.write(`boundary-error: ${error.message}\n`);
  for (const detail of details) process.stderr.write(`- ${detail}\n`);
  process.exitCode = 1;
}
