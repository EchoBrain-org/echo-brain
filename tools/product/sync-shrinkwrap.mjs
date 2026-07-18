#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

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
  throw new Error(`root lock does not resolve '${dependency}' from '${fromPath || '<root>'}'`);
}

export function productShrinkwrap(template, rootLock) {
  if (rootLock.lockfileVersion !== 3 || rootLock.packages?.[''] === undefined) {
    throw new Error('root npm-shrinkwrap.json must use lockfileVersion 3');
  }
  const packages = rootLock.packages;
  const selected = new Set();
  const queue = Object.keys(template.dependencies ?? {}).map((dependency) =>
    resolveLockedDependency(packages, '', dependency),
  );

  while (queue.length > 0) {
    const path = queue.shift();
    if (selected.has(path)) continue;
    selected.add(path);
    const metadata = packages[path];
    if (metadata === undefined) throw new Error(`root lock is missing '${path}'`);
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
      dependencies: template.dependencies,
      bin: template.bin,
      engines: template.engines,
    },
  };
  for (const path of [...selected].sort()) packageEntries[path] = packages[path];
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
    if (!allowed.has(argument)) throw new Error(`unknown argument: ${argument}`);
    if (argument === '--output') index += 1;
  }
  if (outputAt !== -1 && !isAbsolute(output ?? '')) {
    throw new Error('--output must be an absolute path');
  }
  if (check && output !== undefined) throw new Error('--check and --output are mutually exclusive');
  const root = resolve(process.cwd());
  const templatePath = resolve(root, 'product/package.template.json');
  const rootLockPath = resolve(root, 'npm-shrinkwrap.json');
  const expected = `${JSON.stringify(
    productShrinkwrap(readJson(templatePath), readJson(rootLockPath)),
    null,
    2,
  )}\n`;
  if (check) {
    process.stdout.write('runtime dependency closure resolves from the root shrinkwrap\n');
    return;
  }
  if (output === undefined) throw new Error('usage: sync-shrinkwrap --check | --output <absolute-path>');
  writeFileSync(output, expected);
  process.stdout.write(`wrote runtime shrinkwrap to ${output}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`sync-shrinkwrap: ${error.message}\n`);
    process.exitCode = 1;
  }
}
