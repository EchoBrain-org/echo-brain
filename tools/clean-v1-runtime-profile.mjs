#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const SOURCE_SHA = /^[0-9a-f]{40}$/;

export const RUNTIME_PROFILE_FILES = Object.freeze([
  'Caddyfile.clean-v1',
  'Caddyfile.clean-v1.ec2',
  'compose.clean-v1.ec2.yaml',
  'compose.clean-v1.yaml',
]);

function fail(message) {
  throw new Error(`clean-v1 runtime profile: ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${path} must contain exactly: ${expected.join(', ')}`);
}

function sourceSha(value, path = 'source_sha') {
  if (typeof value !== 'string' || !SOURCE_SHA.test(value)) fail(`${path} is invalid`);
  return value;
}

function utf8(value, path) {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) {
    fail(`${path} must be UTF-8 text no larger than 64 KiB`);
  }
  return value;
}

/** RFC 8785 key ordering is sufficient for this string-only profile. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = object(value, '$');
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function validateRuntimeProfile(value) {
  const profile = object(value, '$');
  exactKeys(profile, ['files', 'kind', 'schema_version', 'source_sha'], '$');
  if (!Number.isInteger(profile.schema_version) || profile.schema_version !== 1) fail('schema_version must equal integer 1');
  if (profile.kind !== 'echo-clean-v1-runtime-profile') fail('kind must be echo-clean-v1-runtime-profile');
  const files = object(profile.files, 'files');
  exactKeys(files, RUNTIME_PROFILE_FILES, 'files');
  const validatedFiles = {};
  for (const filename of RUNTIME_PROFILE_FILES) validatedFiles[filename] = utf8(files[filename], `files.${filename}`);
  return Object.freeze({
    schema_version: 1,
    kind: 'echo-clean-v1-runtime-profile',
    source_sha: sourceSha(profile.source_sha),
    files: Object.freeze(validatedFiles),
  });
}

function regularFile(path, label, maxBytes) {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isFile() || state.size < 0 || state.size > maxBytes) {
    fail(`${label} must be a regular non-symlink file no larger than ${Math.floor(maxBytes / 1024)} KiB`);
  }
  return state;
}

function utf8File(path, label) {
  regularFile(path, label, MAX_FILE_BYTES);
  const bytes = readFileSync(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8 text`);
  }
}

function gitSourceSha(directory) {
  const runGit = (args) => {
    try {
      return execFileSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      fail('source directory must be inside a Git worktree with a resolved HEAD and tracked profile files');
    }
  };
  for (const filename of RUNTIME_PROFILE_FILES) {
    runGit(['ls-files', '--error-unmatch', '--', filename]);
  }
  const dirty = runGit([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...RUNTIME_PROFILE_FILES,
  ]);
  if (dirty !== '') fail('source profile files must be tracked and clean at HEAD');
  const sha = runGit(['rev-parse', 'HEAD']).trim();
  return sourceSha(sha);
}

export function buildRuntimeProfile(sourceDirectory) {
  const directory = resolve(sourceDirectory);
  const directoryState = lstatSync(directory);
  if (directoryState.isSymbolicLink() || !directoryState.isDirectory()) fail('source directory must be a non-symlink directory');
  const files = {};
  for (const filename of RUNTIME_PROFILE_FILES) files[filename] = utf8File(resolve(directory, filename), `source file ${filename}`);
  return validateRuntimeProfile({
    schema_version: 1,
    kind: 'echo-clean-v1-runtime-profile',
    source_sha: gitSourceSha(directory),
    files,
  });
}

export function readRuntimeProfile(path) {
  const absolute = resolve(path);
  regularFile(absolute, 'profile', MAX_PROFILE_BYTES);
  const rawBytes = readFileSync(absolute);
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    fail('profile is not valid UTF-8 text');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('profile is not valid JSON');
  }
  const profile = validateRuntimeProfile(parsed);
  if (raw !== `${canonicalJson(profile)}\n`) fail('profile bytes are not canonical JSON followed by one newline');
  return profile;
}

export function runtimeProfileDigest(path) {
  readRuntimeProfile(path);
  return createHash('sha256').update(readFileSync(resolve(path))).digest('hex');
}

function createProfile(sourceDirectory, output) {
  const profile = buildRuntimeProfile(sourceDirectory);
  const target = resolve(output);
  if (basename(target) === '.' || basename(target) === '..') fail('output path is unsafe');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(target, `${canonicalJson(profile)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    fail(`could not create canonical profile: ${error instanceof Error ? error.message : String(error)}`);
  }
  return target;
}

function usage() {
  return 'usage: clean-v1-runtime-profile.mjs <create|validate|digest> <source-dir-or-profile> [new-output]';
}

function main(argv) {
  const [command, path, output] = argv;
  if (!['create', 'validate', 'digest'].includes(command) || typeof path !== 'string' || (command === 'create' && typeof output !== 'string') || (command !== 'create' && output !== undefined)) fail(usage());
  if (command === 'create') {
    process.stdout.write(`${createProfile(path, output)}\n`);
  } else if (command === 'validate') {
    process.stdout.write(`${canonicalJson(readRuntimeProfile(path))}\n`);
  } else {
    process.stdout.write(`${runtimeProfileDigest(path)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
