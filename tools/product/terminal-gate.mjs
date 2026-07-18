#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--terminal-status' || !isAbsolute(argv[1])) {
    throw new Error('usage: terminal-gate --terminal-status <absolute-path>');
  }
  const terminal = JSON.parse(readFileSync(resolve(argv[1]), 'utf8'));
  process.stdout.write(`${JSON.stringify(terminal, null, 2)}\n`);
  if (terminal.ok !== true) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`terminal-gate: ${error.message}\n`);
    process.exitCode = 1;
  }
}
