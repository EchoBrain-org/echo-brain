#!/usr/bin/env node

/** Build one exact macOS-arm64 or Linux-x64 employee kit with a pinned client and Node runtime. */
import { swiftSourceAssemblyV1, checkSwiftSourceDirectionsV1 } from '../../tools/lib/swift-source-assembly.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
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
const starter = join(releaseDirectory, 'start-person-onboarding-kit.sh');
const linuxStarter = join(releaseDirectory, 'start-person-onboarding-kit-linux.sh');
const uiBridge = join(releaseDirectory, 'person-onboarding-ui.mjs');
const overlayIdentityPath = 'ECHO.app/Contents/Resources/build-identity.v1.json';

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

function verifyOverlayIdentity(appArchive, release) {
  const listed = run('unzip', ['-Z1', appArchive], 'desktop app archive cannot be read');
  const entries = listed.split('\n').filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) =>
      entry.startsWith('/') ||
      entry.split('/').some((part) => part === '..') ||
      (!entry.startsWith('ECHO.app/') && entry !== 'ECHO.app')
    ) ||
    !entries.includes('ECHO.app/Contents/MacOS/ECHO') ||
    !entries.includes('ECHO.app/Contents/Info.plist') ||
    !entries.includes(overlayIdentityPath)
  ) fail('desktop app archive layout is invalid');
  let identity;
  try {
    identity = JSON.parse(
      run('unzip', ['-p', appArchive, overlayIdentityPath], 'desktop app identity cannot be read'),
    );
  } catch {
    fail('desktop app identity is invalid JSON');
  }
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    JSON.stringify(Object.keys(identity).sort()) !==
      JSON.stringify([
        'architecture',
        'kind',
        'platform',
        'product_version',
        'schema_version',
        'source_sha',
      ]) ||
    identity.schema_version !== 1 ||
    identity.kind !== 'echo-overlay-build-identity-v1' ||
    identity.product_version !== release.person_client.version ||
    identity.source_sha !== release.source_sha ||
    identity.platform !== 'darwin' ||
    identity.architecture !== 'arm64'
  ) fail('desktop app identity does not match the release record');
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

function runtimeIdentity(runtimeNode, target) {
  if (target === 'linux-x64') assertLinuxX64Elf(runtimeNode);
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
  return 'usage: create-person-onboarding-kit.mjs [--target darwin-arm64|linux-x64] --release <canonical-release.json> --artifact <exact-client.tgz> [--app <ECHO.app.zip>] [--runtime-node <node>] --output <new-kit.tar.gz|new-ECHO.zip>';
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

const graphicalAssemblyPath = 'product/echo-onboarding/source-assembly.v1.json';
function graphicalAssembly() {
  return swiftSourceAssemblyV1(JSON.parse(readFileSync(join(repository, graphicalAssemblyPath), 'utf8')));
}
function graphicalSource(release) {
  return committedSource(release, [
    graphicalAssemblyPath,
    'tools/lib/swift-source-assembly.mjs',
    ...graphicalAssembly().sources,
    'product/echo-onboarding/Info.plist',
    'deploy/release/person-onboarding-ui.mjs',
    'deploy/release/start-person-onboarding-kit.sh',
    'deploy/release/create-person-onboarding-kit.mjs',
    'deploy/release/verify-person-onboarding-kit.mjs',
    'deploy/release/release-artifact-validation.mjs',
    'tools/clean-v1-release.mjs',
  ], 'graphical kit');
}

function linuxSource(release) {
  return committedSource(release, [
    'tools/lib/swift-source-assembly.mjs',
    'deploy/release/start-person-onboarding-kit-linux.sh',
    'deploy/release/create-person-onboarding-kit.mjs',
    'deploy/release/verify-person-onboarding-kit.mjs',
    'deploy/release/release-artifact-validation.mjs',
    'tools/clean-v1-release.mjs',
  ], 'Linux kit');
}

function buildGraphicalKit({ kitRoot, stagingParent, pendingKit, release, sourceBytes }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('graphical kit build requires macOS arm64');
  const app = join(stagingParent, 'ECHO Setup.app');
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const executable = join(contents, 'MacOS', 'ECHO');
  mkdirSync(dirname(executable), { recursive: true, mode: 0o755 });
  mkdirSync(resources, { mode: 0o755 });
  const assembly = swiftSourceAssemblyV1(JSON.parse(sourceBytes[graphicalAssemblyPath].toString('utf8')));
  const swift = assembly.sources.map((path, index) => {
    const staged = join(stagingParent, String(index) + '-' + basename(path));
    writeFileSync(staged, sourceBytes[path]);
    return staged;
  });
  writeFileSync(join(contents, 'Info.plist'), sourceBytes['product/echo-onboarding/Info.plist']);
  cpSync(kitRoot, join(resources, 'kit'), { recursive: true });
  writeFileSync(join(resources, 'build-identity.v1.json'), canonicalJson({
    schema_version: 1,
    kind: 'echo-person-onboarding-app-v1',
    source_sha: release.source_sha,
    release_id: release.release_id,
    product_version: release.person_client.version,
    platform: 'darwin',
    architecture: 'arm64',
  }) + '\n');
  run('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', release.person_client.version.match(/[0-9]+\.[0-9]+\.[0-9]+/)?.[0] ?? '0.0.0', join(contents, 'Info.plist')], 'setup app version could not be stamped');
  checkSwiftSourceDirectionsV1(assembly, swift, run, stagingParent);
  run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-warnings-as-errors', '-O', '-target', 'arm64-apple-macos14.0', '-framework', 'AppKit', ...swift, '-o', executable], 'setup app compilation failed');
  chmodSync(executable, 0o755);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', app], 'setup app signing failed');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 'setup app signature verification failed');
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, pendingKit], 'setup app archive creation failed');
  const after = graphicalSource(release);
  for (const [path, bytes] of Object.entries(sourceBytes)) {
    if (!bytes.equals(after[path])) fail('setup source changed while building');
  }
}

function main(argv) {
  let releasePath = '';
  let artifactPath = '';
  let appPath = '';
  let runtimeNode = process.execPath;
  let outputPath = '';
  let target = 'darwin-arm64';
  while (argv.length > 0) {
    const option = argv.shift();
    const value = argv.shift();
    if (typeof value !== 'string') fail(usage());
    if (option === '--release') releasePath = resolve(value);
    else if (option === '--artifact') artifactPath = resolve(value);
    else if (option === '--app') appPath = resolve(value);
    else if (option === '--runtime-node') runtimeNode = resolve(value);
    else if (option === '--output') outputPath = resolve(value);
    else if (option === '--target') target = value;
    else fail(usage());
  }
  if (target !== 'darwin-arm64' && target !== 'linux-x64') fail(usage());
  const linux = target === 'linux-x64';
  const zipOutput = outputPath.endsWith('.zip');
  const graphical = !linux && zipOutput;
  if (
    !releasePath ||
    !artifactPath ||
    !outputPath ||
    (linux ? (Boolean(appPath) || !zipOutput) : (!appPath || (!graphical && !outputPath.endsWith('.tar.gz'))))
  ) fail(usage());
  regularFile(releasePath, 'release record');
  regularFile(artifactPath, 'client artifact');
  if (!linux) regularFile(appPath, 'desktop app archive');
  regularFile(runtimeNode, 'Node runtime', true);
  regularFile(releaseValidator, 'release validator');
  regularFile(verifier, 'kit verifier');
  regularFile(linux ? linuxStarter : starter, 'kit starter');
  if (!linux) regularFile(uiBridge, 'setup bridge');
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
  if (!linux) verifyOverlayIdentity(appPath, release);
  const runtime = runtimeIdentity(runtimeNode, target);
  const sourceBytes = linux ? linuxSource(release) : (graphical ? graphicalSource(release) : undefined);
  const buildIdentity = linux ? {
    schema_version: 1,
    kind: 'echo-person-onboarding-kit-identity-v1',
    platform: 'linux',
    architecture: 'x64',
    product_version: release.person_client.version,
    release_id: release.release_id,
    source_sha: release.source_sha,
  } : undefined;
  const buildIdentityBytes = buildIdentity ? Buffer.from(`${canonicalJson(buildIdentity)}\n`) : undefined;
  const manifest = {
    schema_version: linux ? 2 : 1,
    kind: linux ? 'echo-person-onboarding-kit-v2' : 'echo-person-onboarding-kit-v1',
    release_id: release.release_id,
    source_sha: release.source_sha,
    release_record_sha256: sha256File(releasePath),
    person_client_artifact_sha256: sha256File(artifactPath),
    ...(linux
      ? { build_identity_sha256: createHash('sha256').update(buildIdentityBytes).digest('hex') }
      : { desktop_app_archive_sha256: sha256File(appPath) }),
    runtime: {
      version: runtime.version,
      platform: runtime.platform,
      architecture: runtime.architecture,
      node_sha256: sha256File(runtimeNode),
    },
  };

  const stagingParent = mkdtempSync(join(outputParent, '.echo-person-onboarding-kit-'));
  chmodSync(stagingParent, 0o700);
  const kitName = linux ? 'echo-person-onboarding-kit' : `echo-person-onboarding-${release.release_id}`;
  const kitRoot = join(stagingParent, kitName);
  const pendingKit = join(stagingParent, linux || graphical ? 'ECHO.zip' : 'kit.tar.gz');
  const pendingDigest = join(stagingParent, 'kit.sha256');
  try {
    mkdirSync(kitRoot, { mode: 0o700 });
    if (linux) {
      writeFileSync(join(kitRoot, 'Start-ECHO.sh'), sourceBytes['deploy/release/start-person-onboarding-kit-linux.sh'], { mode: 0o700, flag: 'wx' });
    } else {
      copyFileSync(starter, join(kitRoot, 'Start ECHO.command'));
      copyFileSync(uiBridge, join(kitRoot, 'person-onboarding-ui.mjs'));
    }
    copyFileSync(releasePath, join(kitRoot, 'release.json'));
    copyFileSync(artifactPath, join(kitRoot, 'person-client.tgz'));
    if (!linux) copyFileSync(appPath, join(kitRoot, 'ECHO.app.zip'));
    copyFileSync(runtimeNode, join(kitRoot, 'node'));
    if (linux) {
      writeFileSync(join(kitRoot, 'clean-v1-release.mjs'), sourceBytes['tools/clean-v1-release.mjs'], { mode: 0o700, flag: 'wx' });
      writeFileSync(join(kitRoot, 'verify-person-onboarding-kit.mjs'), sourceBytes['deploy/release/verify-person-onboarding-kit.mjs'], { mode: 0o700, flag: 'wx' });
      writeFileSync(join(kitRoot, 'build-identity.v1.json'), buildIdentityBytes, { mode: 0o600, flag: 'wx' });
    } else {
      copyFileSync(releaseValidator, join(kitRoot, 'clean-v1-release.mjs'));
      copyFileSync(verifier, join(kitRoot, 'verify-person-onboarding-kit.mjs'));
    }
    writeFileSync(join(kitRoot, 'kit-manifest.v1.json'), `${canonicalJson(manifest)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    for (const executable of [
      linux ? 'Start-ECHO.sh' : 'Start ECHO.command',
      ...(!linux ? ['person-onboarding-ui.mjs'] : []),
      'node',
      'clean-v1-release.mjs',
      'verify-person-onboarding-kit.mjs',
    ]) chmodSync(join(kitRoot, executable), 0o755);
    for (const privateFile of [
      'release.json',
      'person-client.tgz',
      ...(!linux ? ['ECHO.app.zip'] : ['build-identity.v1.json']),
      'kit-manifest.v1.json',
    ]) {
      chmodSync(join(kitRoot, privateFile), 0o600);
    }
    if (linux) {
      const copiedSources = {
        'Start-ECHO.sh': 'deploy/release/start-person-onboarding-kit-linux.sh',
        'verify-person-onboarding-kit.mjs': 'deploy/release/verify-person-onboarding-kit.mjs',
        'clean-v1-release.mjs': 'tools/clean-v1-release.mjs',
      };
      for (const [name, path] of Object.entries(copiedSources)) {
        if (!readFileSync(join(kitRoot, name)).equals(sourceBytes[path])) fail('embedded setup source does not match the committed source');
      }
      const after = linuxSource(release);
      for (const [path, bytes] of Object.entries(sourceBytes)) {
        if (!bytes.equals(after[path])) fail('setup source changed while building');
      }
      run('zip', ['-qr', pendingKit, kitName], 'could not create Linux onboarding kit', stagingParent);
    } else if (graphical) {
      const copiedSources = {
        'Start ECHO.command': 'deploy/release/start-person-onboarding-kit.sh',
        'person-onboarding-ui.mjs': 'deploy/release/person-onboarding-ui.mjs',
        'verify-person-onboarding-kit.mjs': 'deploy/release/verify-person-onboarding-kit.mjs',
        'clean-v1-release.mjs': 'tools/clean-v1-release.mjs',
      };
      for (const [name, path] of Object.entries(copiedSources)) {
        if (!readFileSync(join(kitRoot, name)).equals(sourceBytes[path])) fail('embedded setup source does not match the committed source');
      }
      buildGraphicalKit({ kitRoot, stagingParent, pendingKit, release, sourceBytes });
    } else {
      run('tar', ['-czf', pendingKit, '-C', stagingParent, kitName], 'could not create onboarding kit');
    }
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
      ...(graphical ? { signing: 'adhoc-hardened-runtime', distribution: 'private-cohort' } : {}),
      contents: linux ? [
        `${kitName}/Start-ECHO.sh`,
        `${kitName}/node`,
        `${kitName}/kit-manifest.v1.json`,
        `${kitName}/release.json`,
        `${kitName}/person-client.tgz`,
        `${kitName}/verify-person-onboarding-kit.mjs`,
        `${kitName}/clean-v1-release.mjs`,
        `${kitName}/build-identity.v1.json`,
      ] : (graphical ? ['ECHO Setup.app'] : [
        `${kitName}/Start ECHO.command`,
        `${kitName}/person-onboarding-ui.mjs`,
        `${kitName}/release.json`,
        `${kitName}/kit-manifest.v1.json`,
        `${kitName}/person-client.tgz`,
        `${kitName}/ECHO.app.zip`,
        `${kitName}/node`,
        `${kitName}/clean-v1-release.mjs`,
        `${kitName}/verify-person-onboarding-kit.mjs`,
      ]),
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
