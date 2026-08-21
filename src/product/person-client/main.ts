#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runPersonClientCli } from './commands.js';

function packageVersion(): string {
  const value = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    ),
  ) as { version?: unknown };
  if (typeof value.version !== 'string') {
    throw new Error('Person client package version is invalid');
  }
  return value.version;
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(`${packageVersion()}\n`);
} else if (argv.length === 1 && argv[0] === '--help') {
  process.stdout.write('usage: echo-brain person <command> [options]\n');
} else if (argv[0] !== 'person') {
  process.stderr.write('usage: echo-brain person <command> [options]\n');
  process.exitCode = 2;
} else {
  process.exitCode = await runPersonClientCli(argv.slice(1));
}
