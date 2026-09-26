#!/usr/bin/env node

/** Build one exact macOS-arm64 or Linux-x64 command-line kit with a pinned client and Node runtime. */
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
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { readValidatedPersonClientReleaseArtifact, sha256File } from './release-artifact-validation.mjs';

const releaseDirectory = resolve(import.meta.dirname);
const repository = resolve(releaseDirectory, '..', '..');
const releaseValidator = join(repository, 'tools', 'clean-v1-release.mjs');
const verifier = join(releaseDirectory, 'verify-person-onboarding-kit.mjs');
const linuxStarter = join(releaseDirectory, 'start-person-onboarding-kit-linux.sh');
const macCliStarter = join(releaseDirectory, 'start-person-cli-kit-macos.sh');

function fail(message) {
  throw new Error(`Person onboarding kit: ${message}`);
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

function regularFile(path, description, executable = false) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${description} is missing`);
  }
  if (!state.isFile() || state.isSymbolicLink()) fail(`${description} must be a regular file`);
  if (executable && (state.mode & 0o111) === 0) fail(`${description} must be executable`);
}

function absentPath(path, description) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  fail(`${description} already exists`);
}

function privateCanonicalOutputDirectory(path) {
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

function publishNoReplace(source, destination, description) {
  try {
    linkSync(source, destination);
  } catch (error) {
    fail(`${description} could not be published without replacement: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command, args, description, cwd = repository) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${description}: ${(result.stderr || result.stdout || 'command failed').trim()}`);
  }
  return result.stdout;
}

function assertLinuxX64Elf(runtimeNode) {
  const header = readFileSync(runtimeNode).subarray(0, 20);
  // ELF64, little-endian, e_machine = EM_X86_64 (62).
  if (
    header.length < 20 ||
    !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header.readUInt16LE(18) !== 62
  ) fail('Node runtime must be a Linux x86_64 ELF executable');
}

function assertDarwinArm64MachO(runtimeNode) {
  const header = readFileSync(runtimeNode).subarray(0, 16);
  // Thin little-endian Mach-O 64, arm64 (all), MH_EXECUTE.
  if (
    header.length < 16 ||
    header.readUInt32LE(0) !== 0xfeedfacf ||
    header.readUInt32LE(4) !== 0x0100000c ||
    header.readUInt32LE(8) !== 0 ||
    header.readUInt32LE(12) !== 2
  ) fail('Node runtime must be a macOS arm64 Mach-O executable');
}

function runtimeIdentity(runtimeNode, target) {
  if (target === 'linux-x64') assertLinuxX64Elf(runtimeNode);
  else assertDarwinArm64MachO(runtimeNode);
  let value;
  try {
    value = JSON.parse(
      run(
        runtimeNode,
        ['-p', 'JSON.stringify({version:process.version,platform:process.platform,architecture:process.arch,glibc:process.report?.getReport()?.header?.glibcVersionRuntime})'],
        'Node runtime identity cannot be read',
      ),
    );
  } catch {
    fail('Node runtime identity is invalid');
  }
  if (target === 'darwin-arm64') {
    if (
      value.version !== 'v22.22.1' ||
      value.platform !== 'darwin' ||
      value.architecture !== 'arm64'
    ) fail('Node runtime must be v22.22.1 for macOS arm64');
  } else if (
    value.version !== 'v22.22.1' ||
    value.platform !== 'linux' ||
    value.architecture !== 'x64' ||
    typeof value.glibc !== 'string' ||
    !/^\d+\.\d+/.test(value.glibc)
  ) fail('Node runtime must be v22.22.1 for Linux x86_64 with glibc');
  return value;
}

function usage() {
  return 'usage: create-person-onboarding-kit.mjs ([--target darwin-arm64] --installation cli-kit | --target linux-x64) --release <canonical-release.json> --artifact <exact-client.tgz> [--runtime-node <node>] --output <new-kit.zip>';
}

function committedSource(release, paths, description) {
  const head = run('git', ['rev-parse', 'HEAD'], 'source identity is unavailable').trim();
  const dirty = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], 'source status is unavailable');
  if (dirty || head !== release.source_sha) fail(`${description} requires clean committed source matching the release`);
  return Object.fromEntries(paths.map(path => {
    const bytes = Buffer.from(run('git', ['show', `${head}:${path}`], 'committed setup source is unavailable'));
    if (!bytes.equals(readFileSync(join(repository, path)))) fail('setup source does not match its committed source');
    return [path, bytes];
  }));
}

function linuxSource(release) {
  return committedSource(release, [
    'deploy/release/start-person-onboarding-kit-linux.sh',
    'deploy/release/create-person-onboarding-kit.mjs',
    'deploy/release/verify-person-onboarding-kit.mjs',
    'deploy/release/release-artifact-validation.mjs',
    'tools/clean-v1-release.mjs',
  ], 'Linux kit');
}

function macCliSource(release) {
  return committedSource(release, [
    'deploy/release/start-person-cli-kit-macos.sh',
    'deploy/release/create-person-onboarding-kit.mjs',
    'deploy/release/verify-person-onboarding-kit.mjs',
    'deploy/release/release-artifact-validation.mjs',
    'tools/clean-v1-release.mjs',
  ], 'macOS CLI kit');
}

function main(argv) {
  let releasePath = '';
  let artifactPath = '';
  let runtimeNode = process.execPath;
  let outputPath = '';
  let target = 'darwin-arm64';
  let installation = '';
  while (argv.length > 0) {
    const option = argv.shift();
    const value = argv.shift();
    if (typeof value !== 'string') fail(usage());
    if (option === '--release') releasePath = resolve(value);
    else if (option === '--artifact') artifactPath = resolve(value);
    else if (option === '--runtime-node') runtimeNode = resolve(value);
    else if (option === '--output') outputPath = resolve(value);
    else if (option === '--target') target = value;
    else if (option === '--installation') installation = value;
    else fail(usage());
  }
  if (target !== 'darwin-arm64' && target !== 'linux-x64') fail(usage());
  const linux = target === 'linux-x64';
  // macOS builds only the command-line kit, so it must be named explicitly.
  if (linux ? installation !== '' : installation !== 'cli-kit') fail(usage());
  if (!releasePath || !artifactPath || !outputPath || !outputPath.endsWith('.zip')) fail(usage());
  regularFile(releasePath, 'release record');
  regularFile(artifactPath, 'client artifact');
  regularFile(runtimeNode, 'Node runtime', true);
  regularFile(releaseValidator, 'release validator');
  regularFile(verifier, 'kit verifier');
  regularFile(linux ? linuxStarter : macCliStarter, 'kit starter');
  const outputParent = privateCanonicalOutputDirectory(dirname(outputPath));
  const digestPath = `${outputPath}.sha256`;
  absentPath(outputPath, 'output kit');
  absentPath(digestPath, 'output kit digest');

  const release = readValidatedPersonClientReleaseArtifact({
    artifactPath,
    releasePath,
    releaseValidator,
    nodeExecutable: process.execPath,
    run,
    fail,
  });
  const runtime = runtimeIdentity(runtimeNode, target);
  const starterSource = linux ? 'deploy/release/start-person-onboarding-kit-linux.sh' : 'deploy/release/start-person-cli-kit-macos.sh';
  const sourceBytes = linux ? linuxSource(release) : macCliSource(release);
  const buildIdentity = {
    schema_version: 1,
    kind: 'echo-person-onboarding-kit-identity-v1',
    platform: linux ? 'linux' : 'darwin',
    architecture: linux ? 'x64' : 'arm64',
    product_version: release.person_client.version,
    release_id: release.release_id,
    source_sha: release.source_sha,
  };
  const buildIdentityBytes = Buffer.from(`${canonicalJson(buildIdentity)}\n`);
  const manifest = {
    schema_version: linux ? 2 : 3,
    kind: linux ? 'echo-person-onboarding-kit-v2' : 'echo-person-cli-kit-v1',
    release_id: release.release_id,
    source_sha: release.source_sha,
    release_record_sha256: sha256File(releasePath),
    person_client_artifact_sha256: sha256File(artifactPath),
    build_identity_sha256: createHash('sha256').update(buildIdentityBytes).digest('hex'),
    runtime: {
      version: runtime.version,
      platform: runtime.platform,
      architecture: runtime.architecture,
      node_sha256: sha256File(runtimeNode),
    },
  };

  const stagingParent = mkdtempSync(join(outputParent, '.echo-person-onboarding-kit-'));
  chmodSync(stagingParent, 0o700);
  const kitName = 'echo-person-onboarding-kit';
  const kitRoot = join(stagingParent, kitName);
  const pendingKit = join(stagingParent, 'ECHO.zip');
  const pendingDigest = join(stagingParent, 'kit.sha256');
  try {
    mkdirSync(kitRoot, { mode: 0o700 });
    writeFileSync(join(kitRoot, 'Start-ECHO.sh'), sourceBytes[starterSource], { mode: 0o700, flag: 'wx' });
    copyFileSync(releasePath, join(kitRoot, 'release.json'));
    copyFileSync(artifactPath, join(kitRoot, 'person-client.tgz'));
    copyFileSync(runtimeNode, join(kitRoot, 'node'));
    writeFileSync(join(kitRoot, 'clean-v1-release.mjs'), sourceBytes['tools/clean-v1-release.mjs'], { mode: 0o700, flag: 'wx' });
    writeFileSync(join(kitRoot, 'verify-person-onboarding-kit.mjs'), sourceBytes['deploy/release/verify-person-onboarding-kit.mjs'], { mode: 0o700, flag: 'wx' });
    writeFileSync(join(kitRoot, 'build-identity.v1.json'), buildIdentityBytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(kitRoot, 'kit-manifest.v1.json'), `${canonicalJson(manifest)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    for (const executable of [
      'Start-ECHO.sh',
      'node',
      'clean-v1-release.mjs',
      'verify-person-onboarding-kit.mjs',
    ]) chmodSync(join(kitRoot, executable), 0o755);
    for (const privateFile of [
      'release.json',
      'person-client.tgz',
      'build-identity.v1.json',
      'kit-manifest.v1.json',
    ]) {
      chmodSync(join(kitRoot, privateFile), 0o600);
    }
    const copiedSources = {
      'Start-ECHO.sh': starterSource,
      'verify-person-onboarding-kit.mjs': 'deploy/release/verify-person-onboarding-kit.mjs',
      'clean-v1-release.mjs': 'tools/clean-v1-release.mjs',
    };
    for (const [name, path] of Object.entries(copiedSources)) {
      if (!readFileSync(join(kitRoot, name)).equals(sourceBytes[path])) fail('embedded setup source does not match the committed source');
    }
    const after = linux ? linuxSource(release) : macCliSource(release);
    for (const [path, bytes] of Object.entries(sourceBytes)) {
      if (!bytes.equals(after[path])) fail('setup source changed while building');
    }
    run('zip', ['-qr', pendingKit, kitName], `could not create ${linux ? 'Linux' : 'macOS CLI'} onboarding kit`, stagingParent);
    chmodSync(pendingKit, 0o600);
    const kitSha256 = sha256File(pendingKit);
    writeFileSync(pendingDigest, `${kitSha256}  ${basename(outputPath)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    publishNoReplace(pendingDigest, digestPath, 'output kit digest');
    publishNoReplace(pendingKit, outputPath, 'output kit');
    process.stdout.write(`${JSON.stringify({
      kit_path: outputPath,
      kit_sha256: kitSha256,
      kit_sha256_path: digestPath,
      release_id: release.release_id,
      source_sha: release.source_sha,
      client_version: release.person_client.version,
      platform: runtime.platform,
      architecture: runtime.architecture,
      node_version: runtime.version,
      contents: [
        `${kitName}/Start-ECHO.sh`,
        `${kitName}/node`,
        `${kitName}/kit-manifest.v1.json`,
        `${kitName}/release.json`,
        `${kitName}/person-client.tgz`,
        `${kitName}/verify-person-onboarding-kit.mjs`,
        `${kitName}/clean-v1-release.mjs`,
        `${kitName}/build-identity.v1.json`,
      ],
    })}\n`);
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
