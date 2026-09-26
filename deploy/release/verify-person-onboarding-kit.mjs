#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
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

function assertLinuxX64Elf(path) {
  const header = readFileSync(path).subarray(0, 20);
  // ELF64, little-endian, e_machine = EM_X86_64 (62).
  if (
    header.length < 20 ||
    !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header.readUInt16LE(18) !== 62
  ) fail('Node runtime must be a Linux x86_64 ELF executable');
}

function assertDarwinArm64MachO(path) {
  const header = readFileSync(path).subarray(0, 16);
  // Thin little-endian Mach-O 64, arm64 (all), MH_EXECUTE.
  if (
    header.length < 16 ||
    header.readUInt32LE(0) !== 0xfeedfacf ||
    header.readUInt32LE(4) !== 0x0100000c ||
    header.readUInt32LE(8) !== 0 ||
    header.readUInt32LE(12) !== 2
  ) fail('Node runtime must be a macOS arm64 Mach-O executable');
}

function verifyCliIdentity(path, release, manifest, target) {
  const raw = readFileSync(path, 'utf8');
  let identity;
  try {
    identity = JSON.parse(raw);
  } catch {
    fail('kit build identity is not valid JSON');
  }
  exactKeys(
    identity,
    ['architecture', 'kind', 'platform', 'product_version', 'release_id', 'schema_version', 'source_sha'],
    'kit build identity',
  );
  if (
    identity.schema_version !== 1 ||
    identity.kind !== 'echo-person-onboarding-kit-identity-v1' ||
    identity.platform !== target.platform ||
    identity.architecture !== target.architecture ||
    identity.release_id !== manifest.release_id ||
    release.release_id !== manifest.release_id ||
    identity.source_sha !== manifest.source_sha ||
    identity.source_sha !== release.source_sha ||
    identity.product_version !== release.person_client?.version
  ) fail('kit build identity does not match the release record');
  if (raw !== `${canonicalJson(identity)}\n`) fail('kit build identity is not canonical');
}

function verifyLinuxRuntime(root, manifest) {
  let executingNode;
  let bundledNode;
  try {
    executingNode = realpathSync(process.execPath);
    bundledNode = realpathSync(join(root, 'node'));
  } catch {
    fail('bundled Node runtime path cannot be resolved');
  }
  if (executingNode !== bundledNode) fail('Linux kit verifier must run with the bundled Node runtime');
  if (process.version !== manifest.runtime.version) fail('Node runtime version does not match the kit');
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail('this kit supports Linux x86_64 only');
  }
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
  if (typeof glibc !== 'string' || !/^\d+\.\d+/.test(glibc)) {
    fail('this kit requires Linux with glibc');
  }
}

function verifyMacCliRuntime(root, manifest) {
  let executingNode;
  let bundledNode;
  try {
    executingNode = realpathSync(process.execPath);
    bundledNode = realpathSync(join(root, 'node'));
  } catch {
    fail('bundled Node runtime path cannot be resolved');
  }
  if (executingNode !== bundledNode) fail('macOS CLI kit verifier must run with the bundled Node runtime');
  if (process.version !== manifest.runtime.version) fail('Node runtime version does not match the kit');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('this CLI kit supports macOS on Apple silicon only');
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
  const linux = (
    manifest !== null &&
    typeof manifest === 'object' &&
    !Array.isArray(manifest) &&
    manifest.schema_version === 2 &&
    manifest.kind === 'echo-person-onboarding-kit-v2'
  );
  const macCli = (
    manifest !== null &&
    typeof manifest === 'object' &&
    !Array.isArray(manifest) &&
    manifest.schema_version === 3 &&
    manifest.kind === 'echo-person-cli-kit-v1'
  );
  exactKeys(
    manifest,
    [
      'kind',
      'build_identity_sha256',
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
    typeof manifest.release_id !== 'string' ||
    typeof manifest.source_sha !== 'string' ||
    !SHA256.test(manifest.release_record_sha256) ||
    !SHA256.test(manifest.person_client_artifact_sha256) ||
    !SHA256.test(manifest.runtime.node_sha256) ||
    manifest.runtime.version !== 'v22.22.1' ||
    !SHA256.test(manifest.build_identity_sha256) ||
    (linux
      ? (
        manifest.runtime.platform !== 'linux' ||
        manifest.runtime.architecture !== 'x64'
      )
      : (
        !macCli ||
        manifest.runtime.platform !== 'darwin' ||
        manifest.runtime.architecture !== 'arm64'
      ))
  ) fail('manifest identity is invalid');
  if (raw !== `${canonicalJson(manifest)}\n`) fail('manifest is not canonical');
  if (linux) verifyLinuxRuntime(root, manifest);
  else verifyMacCliRuntime(root, manifest);
  if (sha256(releasePath) !== manifest.release_record_sha256) fail('release record digest does not match');
  if (sha256(clientPath) !== manifest.person_client_artifact_sha256) fail('Person-client digest does not match');
  if (sha256(nodePath) !== manifest.runtime.node_sha256) fail('Node runtime digest does not match');
  let release;
  try {
    release = JSON.parse(readFileSync(releasePath, 'utf8'));
  } catch {
    fail('release record is not valid JSON');
  }
  const identityPath = join(root, 'build-identity.v1.json');
  regularFile(identityPath, 'kit build identity');
  if (sha256(identityPath) !== manifest.build_identity_sha256) fail('kit build identity digest does not match');
  if (linux) assertLinuxX64Elf(nodePath);
  else assertDarwinArm64MachO(nodePath);
  verifyCliIdentity(identityPath, release, manifest, linux
    ? { platform: 'linux', architecture: 'x64' }
    : { platform: 'darwin', architecture: 'arm64' });
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
