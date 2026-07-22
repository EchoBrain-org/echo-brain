#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const PRODUCT_BUNDLED_WORKSPACE_PACKAGES = Object.freeze([
  '@echo-brain/federation-protocol',
  '@echo-brain/organization-protocol',
  '@echo-brain/organization-api',
]);

function resolveLockedDependency(packages, fromPath, dependency) {
  let current = fromPath;
  for (;;) {
    const candidate = current
      ? `${current}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    if (packages[candidate] !== undefined) return candidate;
    if (current === '') break;
    const nestedAt = current.lastIndexOf('/node_modules/');
    current = nestedAt === -1 ? '' : current.slice(0, nestedAt);
  }
  throw new Error(
    `root lock does not resolve '${dependency}' from '${fromPath || '<root>'}'`,
  );
}

function assertExactBundledWorkspacePackages(template) {
  const declared = template.bundleDependencies;
  if (
    !Array.isArray(declared) ||
    declared.some((name) => typeof name !== 'string')
  ) {
    throw new Error(
      'product package template must declare bundleDependencies as package names',
    );
  }
  if (new Set(declared).size !== declared.length) {
    throw new Error(
      'product package template bundleDependencies must not contain duplicates',
    );
  }
  const expected = [...PRODUCT_BUNDLED_WORKSPACE_PACKAGES].sort();
  const actual = [...declared].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `product bundleDependencies must be exactly: ${PRODUCT_BUNDLED_WORKSPACE_PACKAGES.join(', ')}`,
    );
  }
  for (const dependency of declared) {
    if (typeof template.dependencies?.[dependency] !== 'string') {
      throw new Error(
        `bundled workspace package must be a product dependency: ${dependency}`,
      );
    }
  }
  return declared;
}

function bundledWorkspaceMetadata(packages, dependency, expectedVersion) {
  const installPath = resolveLockedDependency(packages, '', dependency);
  const link = packages[installPath];
  if (link?.link !== true || typeof link.resolved !== 'string') {
    throw new Error(
      `bundled workspace package is not a root lock workspace link: ${dependency}`,
    );
  }
  if (
    link.resolved.startsWith('/') ||
    link.resolved.split('/').includes('..')
  ) {
    throw new Error(
      `bundled workspace package has an unsafe lock target: ${dependency}`,
    );
  }
  const source = packages[link.resolved];
  if (
    source === undefined ||
    source.name !== dependency ||
    typeof source.version !== 'string'
  ) {
    throw new Error(
      `root lock is missing workspace metadata for bundled package: ${dependency}`,
    );
  }
  if (source.version !== expectedVersion) {
    throw new Error(
      `bundled workspace version mismatch for ${dependency}: template=${expectedVersion} lock=${source.version}`,
    );
  }

  const metadata = { version: source.version };
  for (const field of [
    'license',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'bin',
    'engines',
    'os',
    'cpu',
  ]) {
    if (source[field] !== undefined) metadata[field] = source[field];
  }
  metadata.inBundle = true;
  return { installPath, sourcePath: link.resolved, metadata };
}

export function productShrinkwrap(template, rootLock) {
  if (rootLock.lockfileVersion !== 3 || rootLock.packages?.[''] === undefined) {
    throw new Error('root npm-shrinkwrap.json must use lockfileVersion 3');
  }
  const packages = rootLock.packages;
  const bundled = assertExactBundledWorkspacePackages(template);
  const bundledSet = new Set(bundled);
  const bundleEntries = new Map();
  const selected = new Set();
  const queue = [];

  for (const dependency of Object.keys(template.dependencies ?? {}).sort()) {
    if (!bundledSet.has(dependency)) {
      queue.push(resolveLockedDependency(packages, '', dependency));
      continue;
    }
    const workspace = bundledWorkspaceMetadata(
      packages,
      dependency,
      template.dependencies[dependency],
    );
    bundleEntries.set(workspace.installPath, workspace.metadata);
    for (const transitive of [
      ...Object.keys(workspace.metadata.dependencies ?? {}),
      ...Object.keys(workspace.metadata.optionalDependencies ?? {}),
    ].sort()) {
      if (!bundledSet.has(transitive)) {
        queue.push(
          resolveLockedDependency(packages, workspace.sourcePath, transitive),
        );
      }
    }
  }

  while (queue.length > 0) {
    const path = queue.shift();
    if (selected.has(path)) continue;
    selected.add(path);
    const metadata = packages[path];
    if (metadata === undefined)
      throw new Error(`root lock is missing '${path}'`);
    if (metadata.link === true) {
      throw new Error(
        `unbundled workspace link entered the product dependency closure: ${path}`,
      );
    }
    for (const dependency of [
      ...Object.keys(metadata.dependencies ?? {}),
      ...Object.keys(metadata.optionalDependencies ?? {}),
    ].sort()) {
      queue.push(resolveLockedDependency(packages, path, dependency));
    }
  }

  const packageEntries = {
    '': {
      name: template.name,
      version: template.version,
      license: template.license,
      dependencies: template.dependencies,
      bundleDependencies: bundled,
      bin: template.bin,
      engines: template.engines,
    },
  };
  for (const [path, metadata] of [...bundleEntries].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    packageEntries[path] = metadata;
  }
  for (const path of [...selected].sort())
    packageEntries[path] = packages[path];
  return {
    name: template.name,
    version: template.version,
    lockfileVersion: 3,
    requires: true,
    packages: packageEntries,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const outputAt = argv.indexOf('--output');
  const output = outputAt === -1 ? undefined : argv[outputAt + 1];
  const allowed = new Set(['--check', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument))
      throw new Error(`unknown argument: ${argument}`);
    if (argument === '--output') index += 1;
  }
  if (outputAt !== -1 && !isAbsolute(output ?? '')) {
    throw new Error('--output must be an absolute path');
  }
  if (check && output !== undefined)
    throw new Error('--check and --output are mutually exclusive');
  const root = resolve(process.cwd());
  const templatePath = resolve(root, 'product/package.template.json');
  const rootLockPath = resolve(root, 'npm-shrinkwrap.json');
  const expected = `${JSON.stringify(
    productShrinkwrap(readJson(templatePath), readJson(rootLockPath)),
    null,
    2,
  )}\n`;
  if (check) {
    process.stdout.write(
      'runtime dependency closure resolves from the root shrinkwrap\n',
    );
    return;
  }
  if (output === undefined)
    throw new Error(
      'usage: sync-shrinkwrap --check | --output <absolute-path>',
    );
  writeFileSync(output, expected);
  process.stdout.write(`wrote runtime shrinkwrap to ${output}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`sync-shrinkwrap: ${error.message}\n`);
    process.exitCode = 1;
  }
}
