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
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function runToolchainPreflight(options) {
  const expectedNode = options.expectedNode;
  const expectedNpm = options.expectedNpm ?? '10.9.4';
  const nodedir = resolve(options.nodedir);
  const which = options.which ?? defaultWhich;
  const run = options.run ?? defaultRun;
  const exists = options.exists ?? existsSync;
  const read = options.read ?? ((path) => readFileSync(path, 'utf8'));
  const canonical = options.realpath ?? realpathSync;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const executingNodePath = options.executingNodePath ?? process.execPath;
  let npmVersion = '';
  let resolvedNodePath = null;
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
    if (name === 'node') resolvedNodePath = resolved;
    if (name === 'npm') npmVersion = firstLine(result.stdout || result.stderr);
  }

  let nodePathIdentity;
  try {
    const pathNode =
      resolvedNodePath === null ? null : canonical(resolvedNodePath);
    const executingNode = canonical(executingNodePath);
    nodePathIdentity =
      pathNode !== null && pathNode === executingNode
        ? {
            name: 'path-node-identity',
            status: 'pass',
            resolved: pathNode,
          }
        : {
            name: 'path-node-identity',
            status: 'fail',
            reason: `PATH node ${pathNode ?? 'unavailable'} does not match executing Node ${executingNode}`,
          };
  } catch (error) {
    nodePathIdentity = {
      name: 'path-node-identity',
      status: 'fail',
      reason: `could not canonicalize Node executables: ${error.message}`,
    };
  }
  checks.push(nodePathIdentity);

  checks.push(
    nodeVersion === expectedNode
      ? { name: 'executing-node-version', status: 'pass', version: nodeVersion }
      : {
          name: 'executing-node-version',
          status: 'fail',
          reason: `expected ${expectedNode}, received ${nodeVersion}`,
        },
  );
  checks.push(
    npmVersion === expectedNpm
      ? { name: 'executing-npm-version', status: 'pass', version: npmVersion }
      : {
          name: 'executing-npm-version',
          status: 'fail',
          reason: `expected ${expectedNpm}, received ${npmVersion || 'unavailable'}`,
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
    checks.push({
      name: 'header-node-version',
      status: 'fail',
      reason: 'marker missing',
    });
  } else {
    const headerVersion = read(markerPath).trim();
    checks.push(
      headerVersion === expectedNode && headerVersion === nodeVersion
        ? {
            name: 'header-node-version',
            status: 'pass',
            version: headerVersion,
          }
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
    executing_node_path: executingNodePath,
    expected_npm: expectedNpm,
    executing_npm: npmVersion,
    nodedir,
    checks,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      !['--nodedir', '--expected-node', '--expected-npm', '--output'].includes(
        flag,
      )
    ) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  if (!isAbsolute(args.nodedir ?? ''))
    throw new Error('--nodedir must be absolute');
  if (args['expected-node'] === undefined)
    throw new Error('--expected-node is required');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runToolchainPreflight({
    nodedir: args.nodedir,
    expectedNode: args['expected-node'],
    expectedNpm: args['expected-npm'] ?? '10.9.4',
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
