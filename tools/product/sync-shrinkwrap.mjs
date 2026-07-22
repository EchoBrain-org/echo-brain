#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runtimeShrinkwrap } from '../release/runtime-shrinkwrap.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const PRODUCT_BUNDLED_WORKSPACE_PACKAGES = Object.freeze([
  '@echo-brain/federation-protocol',
  '@echo-brain/organization-protocol',
  '@echo-brain/organization-api',
]);

export function productShrinkwrap(template, rootLock) {
  return runtimeShrinkwrap(template, rootLock, {
    bundledWorkspacePackages: PRODUCT_BUNDLED_WORKSPACE_PACKAGES,
  });
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
