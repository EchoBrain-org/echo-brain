#!/usr/bin/env node

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function firstLine(value) {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

function defaultWhich(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function runToolchainPreflight(options) {
  const expectedNode = options.expectedNode;
  const nodedir = resolve(options.nodedir);
  const which = options.which ?? defaultWhich;
  const run = options.run ?? defaultRun;
  const exists = options.exists ?? existsSync;
  const read = options.read ?? ((path) => readFileSync(path, 'utf8'));
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const checks = [];

  const commandChecks = [
    ['python3', ['--version']],
    ['make', ['--version']],
    ['clang', ['--version']],
    ['clang++', ['--version']],
    ['xcode-select', ['-p']],
    ['xcrun', ['--show-sdk-path']],
    ['node', ['--version']],
    ['npm', ['--version']],
  ];
  for (const [name, args] of commandChecks) {
    const resolved = which(name);
    if (resolved === null) {
      checks.push({ name, status: 'fail', reason: 'executable not found' });
      continue;
    }
    const result = run(resolved, args);
    if (result.status !== 0) {
      checks.push({
        name,
        status: 'fail',
        resolved,
        reason: firstLine(result.stderr) || `exit ${String(result.status)}`,
      });
      continue;
    }
    checks.push({
      name,
      status: 'pass',
      resolved,
      version: firstLine(result.stdout || result.stderr),
    });
  }

  checks.push(
    nodeVersion === expectedNode
      ? { name: 'executing-node-version', status: 'pass', version: nodeVersion }
      : {
          name: 'executing-node-version',
          status: 'fail',
          reason: `expected ${expectedNode}, received ${nodeVersion}`,
        },
  );

  const headerFiles = [
    'include/node/node.h',
    'include/node/common.gypi',
    'include/node/config.gypi',
  ];
  for (const relativePath of headerFiles) {
    checks.push(
      exists(join(nodedir, relativePath))
        ? { name: `header:${relativePath}`, status: 'pass' }
        : { name: `header:${relativePath}`, status: 'fail', reason: 'missing' },
    );
  }
  const markerPath = join(nodedir, 'node-version.txt');
  if (!exists(markerPath)) {
    checks.push({ name: 'header-node-version', status: 'fail', reason: 'marker missing' });
  } else {
    const headerVersion = read(markerPath).trim();
    checks.push(
      headerVersion === expectedNode && headerVersion === nodeVersion
        ? { name: 'header-node-version', status: 'pass', version: headerVersion }
        : {
            name: 'header-node-version',
            status: 'fail',
            reason: `headers=${headerVersion} runtime=${nodeVersion} expected=${expectedNode}`,
          },
    );
  }

  return {
    schema_version: 1,
    ok: checks.every((check) => check.status === 'pass'),
    expected_node: expectedNode,
    executing_node: nodeVersion,
    nodedir,
    checks,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--nodedir', '--expected-node', '--output'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  if (!isAbsolute(args.nodedir ?? '')) throw new Error('--nodedir must be absolute');
  if (args['expected-node'] === undefined) throw new Error('--expected-node is required');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runToolchainPreflight({
    nodedir: args.nodedir,
    expectedNode: args['expected-node'],
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output === undefined) process.stdout.write(output);
  else writeFileSync(resolve(args.output), output);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`toolchain-preflight: ${error.message}\n`);
    process.exitCode = 1;
  }
}
