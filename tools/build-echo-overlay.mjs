#!/usr/bin/env node

/** Build one dependency-free macOS-arm64 ECHO overlay application archive. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const repository = resolve(import.meta.dirname, '..');
const overlayRoot = join(repository, 'product', 'echo-overlay');
const source = join(overlayRoot, 'main.swift');
const plist = join(overlayRoot, 'Info.plist');
const SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`ECHO overlay: ${message}`);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') fail('identity contains an unsupported value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function regularFile(path, label) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!state.isFile() || state.isSymbolicLink()) fail(`${label} must be a regular file`);
}

function privateCanonicalDirectory(path) {
  const lexical = resolve(path);
  let state;
  let canonical;
  try {
    state = lstatSync(lexical);
    canonical = realpathSync(lexical);
  } catch {
    fail('output directory is missing');
  }
  const metadata = statSync(lexical);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    canonical !== lexical ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o700
  ) fail('output directory must be a canonical current-user-owned mode 0700 directory');
  return lexical;
}

function absent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  fail('output archive already exists');
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${label}: ${(result.stderr || result.stdout || 'command failed').trim()}`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function usage() {
  return 'usage: build-echo-overlay.mjs --source-sha <commit> --version <client-version> --output <new-ECHO.app.zip>';
}

function main(argv) {
  let sourceSha = '';
  let version = '';
  let output = '';
  while (argv.length > 0) {
    const option = argv.shift();
    const value = argv.shift();
    if (typeof value !== 'string') fail(usage());
    if (option === '--source-sha') sourceSha = value.toLowerCase();
    else if (option === '--version') version = value;
    else if (option === '--output') output = resolve(value);
    else fail(usage());
  }
  if (!SHA.test(sourceSha) || !/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/.test(version) || !output.endsWith('.zip')) {
    fail(usage());
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('build requires macOS on Apple silicon');
  }
  regularFile(source, 'Swift source');
  regularFile(plist, 'Info.plist');
  const parent = privateCanonicalDirectory(dirname(output));
  absent(output);

  const staging = mkdtempSync(join(parent, '.echo-overlay-build-'));
  chmodSync(staging, 0o700);
  const app = join(staging, 'ECHO.app');
  const contents = join(app, 'Contents');
  const executable = join(contents, 'MacOS', 'ECHO');
  const resources = join(contents, 'Resources');
  const pending = join(staging, 'ECHO.app.zip');
  try {
    mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
    mkdirSync(resources, { mode: 0o700 });
    copyFileSync(plist, join(contents, 'Info.plist'));
    const numericVersion = version.match(/[0-9]+\.[0-9]+\.[0-9]+/)?.[0] ?? '0.0.0';
    run(
      '/usr/bin/plutil',
      ['-replace', 'CFBundleShortVersionString', '-string', numericVersion, join(contents, 'Info.plist')],
      'could not stamp app version',
    );
    writeFileSync(
      join(resources, 'build-identity.v1.json'),
      `${canonicalJson({
        schema_version: 1,
        kind: 'echo-overlay-build-identity-v1',
        product_version: version,
        source_sha: sourceSha,
        platform: 'darwin',
        architecture: 'arm64',
      })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    run(
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-swift-version',
        '5',
        '-parse-as-library',
        '-warnings-as-errors',
        '-O',
        '-target',
        'arm64-apple-macos14.0',
        '-framework',
        'AppKit',
        '-framework',
        'Carbon',
        source,
        '-o',
        executable,
      ],
      'Swift compilation failed',
    );
    chmodSync(executable, 0o755);
    run(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', app],
      'ad hoc signing failed',
    );
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 'app signature verification failed');
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, pending], 'app archive creation failed');
    chmodSync(pending, 0o600);
    try {
      linkSync(pending, output);
    } catch (error) {
      fail(`output archive could not be published without replacement: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(`${JSON.stringify({
      app_archive_path: output,
      app_archive_sha256: sha256(output),
      source_sha: sourceSha,
      product_version: version,
      platform: 'darwin',
      architecture: 'arm64',
      signing: 'adhoc-hardened-runtime',
    })}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
