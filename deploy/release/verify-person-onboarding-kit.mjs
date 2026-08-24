#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`ECHO onboarding kit: ${message}`);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') fail('manifest contains an unsupported value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has unexpected fields`);
  }
}

function regularFile(path, label) {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink()) fail(`${label} must be a regular file`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const root = resolve(process.argv[2] ?? import.meta.dirname);
  const manifestPath = join(root, 'kit-manifest.v1.json');
  const releasePath = join(root, 'release.json');
  const clientPath = join(root, 'person-client.tgz');
  const nodePath = join(root, 'node');
  for (const [path, label] of [
    [manifestPath, 'kit manifest'],
    [releasePath, 'release record'],
    [clientPath, 'Person-client artifact'],
    [nodePath, 'Node runtime'],
  ]) regularFile(path, label);

  const raw = readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    fail('manifest is not valid JSON');
  }
  exactKeys(
    manifest,
    [
      'kind',
      'person_client_artifact_sha256',
      'release_id',
      'release_record_sha256',
      'runtime',
      'schema_version',
      'source_sha',
    ],
    'manifest',
  );
  exactKeys(
    manifest.runtime,
    ['architecture', 'node_sha256', 'platform', 'version'],
    'runtime',
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== 'echo-person-onboarding-kit-v1' ||
    typeof manifest.release_id !== 'string' ||
    typeof manifest.source_sha !== 'string' ||
    !SHA256.test(manifest.release_record_sha256) ||
    !SHA256.test(manifest.person_client_artifact_sha256) ||
    manifest.runtime.version !== 'v22.22.1' ||
    manifest.runtime.platform !== 'darwin' ||
    manifest.runtime.architecture !== 'arm64' ||
    !SHA256.test(manifest.runtime.node_sha256)
  ) fail('manifest identity is invalid');
  if (raw !== `${canonicalJson(manifest)}\n`) fail('manifest is not canonical');
  if (process.version !== manifest.runtime.version) fail('Node runtime version does not match the kit');
  if (process.platform !== manifest.runtime.platform || process.arch !== manifest.runtime.architecture) {
    fail('this kit supports macOS on Apple silicon only');
  }
  if (sha256(releasePath) !== manifest.release_record_sha256) fail('release record digest does not match');
  if (sha256(clientPath) !== manifest.person_client_artifact_sha256) fail('Person-client digest does not match');
  if (sha256(nodePath) !== manifest.runtime.node_sha256) fail('Node runtime digest does not match');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    release_id: manifest.release_id,
    source_sha: manifest.source_sha,
    platform: manifest.runtime.platform,
    architecture: manifest.runtime.architecture,
    node_version: manifest.runtime.version,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
