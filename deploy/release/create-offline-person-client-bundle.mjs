#!/usr/bin/env node

/**
 * Create one private, offline employee-install archive from reviewed release
 * inputs. The output contains no deployment material or credentials.
 */
import { spawnSync } from 'node:child_process';
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
const offlineInstaller = join(releaseDirectory, 'install-offline-person-client-bundle.sh');
const clientInstaller = join(releaseDirectory, 'install-person-client-clean-v1.sh');
const deploymentValidator = join(releaseDirectory, 'clean-v1-release.py');

function fail(message) {
  throw new Error(`offline Person-client bundle: ${message}`);
}

function regularFile(path, description) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${description} is missing`);
  }
  if (!state.isFile() || state.isSymbolicLink()) fail(`${description} must be a regular file`);
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
  if (!state.isDirectory() || state.isSymbolicLink() || canonical !== lexical) {
    fail('output directory must be a canonical real directory');
  }
  const metadata = statSync(lexical);
  if (metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700) {
    fail('output directory must be current-user-owned mode 0700');
  }
  return lexical;
}

function publishNoReplace(source, destination, description) {
  try {
    linkSync(source, destination);
  } catch (error) {
    fail(`${description} could not be published without replacing an existing file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command, args, description, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    fail(`${description}: ${(result.stderr || result.stdout || 'command failed').trim()}`);
  }
  return result.stdout;
}

function usage() {
  return 'usage: create-offline-person-client-bundle.mjs --release <canonical-release.json> --artifact <exact-client.tgz> --output <new-bundle.tar.gz>';
}

function main(argv) {
  let releasePath = '';
  let artifactPath = '';
  let outputPath = '';
  while (argv.length > 0) {
    const option = argv.shift();
    const value = argv.shift();
    if (typeof value !== 'string') fail(usage());
    if (option === '--release') releasePath = resolve(value);
    else if (option === '--artifact') artifactPath = resolve(value);
    else if (option === '--output') outputPath = resolve(value);
    else fail(usage());
  }
  if (!releasePath || !artifactPath || !outputPath || !outputPath.endsWith('.tar.gz')) fail(usage());
  regularFile(releasePath, 'release record');
  regularFile(artifactPath, 'client artifact');
  regularFile(offlineInstaller, 'offline installer');
  regularFile(clientInstaller, 'client installer');
  regularFile(deploymentValidator, 'release validator');
  const outputParent = privateCanonicalOutputDirectory(dirname(outputPath));
  const digestPath = `${outputPath}.sha256`;
  absentPath(outputPath, 'output bundle');
  absentPath(digestPath, 'output bundle digest');

  const release = readValidatedPersonClientReleaseArtifact({
    artifactPath,
    releasePath,
    releaseValidator,
    nodeExecutable: process.execPath,
    run,
    fail,
    artifactIdentityReadDescription: 'client artifact build identity cannot be read',
  });

  const stagingParent = mkdtempSync(join(outputParent, '.echo-offline-person-client-bundle-'));
  chmodSync(stagingParent, 0o700);
  const bundleName = `echo-brain-person-client-${release.release_id}`;
  const bundleRoot = join(stagingParent, bundleName);
  const pendingBundle = join(stagingParent, 'bundle.tar.gz');
  const pendingDigest = join(stagingParent, 'bundle.tar.gz.sha256');
  try {
    mkdirSync(bundleRoot, { mode: 0o700 });
    copyFileSync(releasePath, join(bundleRoot, 'release.json'));
    copyFileSync(artifactPath, join(bundleRoot, 'person-client.tgz'));
    copyFileSync(deploymentValidator, join(bundleRoot, 'clean-v1-release.py'));
    copyFileSync(clientInstaller, join(bundleRoot, 'install-person-client-clean-v1.sh'));
    copyFileSync(offlineInstaller, join(bundleRoot, 'install.sh'));
    chmodSync(join(bundleRoot, 'release.json'), 0o600);
    chmodSync(join(bundleRoot, 'person-client.tgz'), 0o600);
    chmodSync(join(bundleRoot, 'clean-v1-release.py'), 0o755);
    chmodSync(join(bundleRoot, 'install-person-client-clean-v1.sh'), 0o755);
    chmodSync(join(bundleRoot, 'install.sh'), 0o755);
    run('tar', ['-czf', pendingBundle, '-C', stagingParent, bundleName], 'could not create bundle');
    chmodSync(pendingBundle, 0o600);
    const bundleSha256 = sha256File(pendingBundle);
    writeFileSync(pendingDigest, `${bundleSha256}  ${basename(outputPath)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    publishNoReplace(pendingDigest, digestPath, 'output bundle digest');
    publishNoReplace(pendingBundle, outputPath, 'output bundle');
    process.stdout.write(`${JSON.stringify({
      bundle_path: outputPath,
      bundle_sha256: bundleSha256,
      bundle_sha256_path: digestPath,
      release_id: release.release_id,
      source_sha: release.source_sha,
      artifact_sha256: release.person_client.artifact_sha256,
      contents: [
        `${bundleName}/install.sh`,
        `${bundleName}/release.json`,
        `${bundleName}/person-client.tgz`,
        `${bundleName}/clean-v1-release.py`,
        `${bundleName}/install-person-client-clean-v1.sh`,
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
