#!/usr/bin/env node
// Offline compatibility artifact: never replaces the input or starts a runtime.
import { chmodSync, existsSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { copyAuthorityV5ToV6 } from '../packages/organization-authority-kernel/dist/adapters/persistence/sqlite/authority-v5-to-v6.js';

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error('usage: node tools/copy-authority-v5-to-v6.mjs <stopped-snapshot-authority.sqlite> <absent-output.sqlite>');
const sourcePath = resolve(args[0]);
const outputPath = resolve(args[1]);
if (existsSync(outputPath)) throw new Error('offline output must not already exist');
const staging = mkdtempSync(join(dirname(outputPath), '.authority-v6-'));
chmodSync(staging, 0o700);
let source;
let target;
try {
  source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const staged = join(staging, 'authority.sqlite');
  target = new Database(staged);
  target.pragma('foreign_keys = ON');
  target.pragma('synchronous = FULL');
  copyAuthorityV5ToV6(source, target);
  target.close(); target = undefined;
  source.close(); source = undefined;
  chmodSync(staged, 0o600);
  linkSync(staged, outputPath);
  process.stdout.write('Authority V6 snapshot created; input preserved. Live conversion and release remain separate operator work.\n');
} finally {
  target?.close(); source?.close();
  rmSync(staging, { recursive: true, force: true });
}
