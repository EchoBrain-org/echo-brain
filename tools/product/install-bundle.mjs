#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installOffline } from './install-offline.mjs';
import { verifyBundle } from './verify-bundle.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/;
const SOURCE_SHA_RE = /^[a-f0-9]{40}$/;
const LAUNCHER_MARKER = '# echo-brain managed launcher v1';
const INSTALL_ROOT_MANIFEST = 'install-root-manifest.json';
const INSTALL_LOCK = '.install.lock';

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function pathExists(path) {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function normalizedAbsolute(path, label) {
  if (
    typeof path !== 'string' ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return path;
}

function pathIsWithin(path, parent) {
  const rel = relative(parent, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function pathsOverlap(left, right) {
  return (
    left === right || pathIsWithin(left, right) || pathIsWithin(right, left)
  );
}

function requirePrivateDirectory(path, label) {
  const state = lstatSync(path);
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path
  ) {
    throw new Error(`${label} must be a canonical directory, not a symlink`);
  }
  const uid = process.getuid?.();
  if (uid === undefined || state.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  chmodSync(path, 0o700);
}

function ensurePrivateDirectory(path, label) {
  if (!pathExists(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  requirePrivateDirectory(path, label);
}

function assertPrivateDirectory(path, label) {
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path ||
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o077) !== 0
  ) {
    throw new Error(
      `${label} must be a private current-user-owned canonical directory`,
    );
  }
}

function installRootIdentity(installRoot, nodePath, identity) {
  return {
    schema_version: 1,
    kind: 'echo-product-install-root',
    install_root: installRoot,
    runtime: {
      os: identity.platform,
      architecture: identity.architecture,
      node: identity.nodeVersion,
      node_path: nodePath,
    },
  };
}

function prepareInstallRoot(installRoot, expected) {
  if (!pathExists(installRoot)) {
    mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  }
  const state = lstatSync(installRoot);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(installRoot) !== installRoot ||
    (uid !== undefined && state.uid !== uid)
  ) {
    throw new Error(
      'install root must be a current-user-owned canonical directory',
    );
  }
  const markerPath = join(installRoot, INSTALL_ROOT_MANIFEST);
  if (!pathExists(markerPath)) {
    if (readdirSync(installRoot).length !== 0) {
      throw new Error(
        'install root must be absent or empty unless it contains an Echo Brain install-root manifest',
      );
    }
    chmodSync(installRoot, 0o700);
    try {
      writeFileSync(markerPath, `${JSON.stringify(expected, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const markerState = lstatSync(markerPath);
  if (
    markerState.isSymbolicLink() ||
    !markerState.isFile() ||
    (uid !== undefined && markerState.uid !== uid) ||
    (markerState.mode & 0o077) !== 0
  ) {
    throw new Error(
      'install-root manifest must be a private current-user-owned file',
    );
  }
  const observed = readJson(markerPath, 'install-root manifest');
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(
      'install root belongs to a different runtime or Node executable; use its pinned installer',
    );
  }
  chmodSync(installRoot, 0o700);
  return markerPath;
}

function acquireInstallLock(installRoot) {
  const lockPath = join(installRoot, INSTALL_LOCK);
  const recoveryPath = `${lockPath}.recovery`;
  const token = `${String(process.pid)}-${randomBytes(16).toString('hex')}`;
  const content = `${JSON.stringify({ schema_version: 1, pid: process.pid, token })}\n`;

  function createExclusiveLock(path, bytes) {
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, bytes);
    } finally {
      closeSync(descriptor);
    }
  }

  function readOwnedLock(path, label) {
    const state = lstatSync(path);
    const uid = process.getuid?.();
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      (uid !== undefined && state.uid !== uid) ||
      (state.mode & 0o077) !== 0
    ) {
      throw new Error(`${label} is unsafe`);
    }
    const value = readJson(path, label);
    if (
      !isRecord(value) ||
      value.schema_version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.token !== 'string' ||
      !/^[1-9][0-9]*-[a-f0-9]{32}$/u.test(value.token)
    ) {
      throw new Error(`${label} has invalid ownership data`);
    }
    return { state, value };
  }

  try {
    createExclusiveLock(lockPath, content);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const recoveryToken = `${token}-recovery`;
    try {
      createExclusiveLock(
        recoveryPath,
        `${JSON.stringify({ schema_version: 1, token: recoveryToken })}\n`,
      );
    } catch (recoveryError) {
      if (recoveryError?.code === 'EEXIST') {
        throw new Error(
          `another installer is recovering ${lockPath}; retry after it finishes`,
        );
      }
      throw recoveryError;
    }
    try {
      const owner = readOwnedLock(lockPath, 'existing install lock');
      let active = true;
      try {
        process.kill(owner.value.pid, 0);
      } catch (probeError) {
        if (probeError?.code === 'ESRCH') active = false;
      }
      if (active) {
        throw new Error(
          `another install operation (pid ${String(owner.value.pid)}) owns ${lockPath}`,
        );
      }
      const unchanged = readOwnedLock(lockPath, 'existing install lock');
      if (
        unchanged.value.token !== owner.value.token ||
        unchanged.state.ino !== owner.state.ino
      ) {
        throw new Error('install lock changed during stale-lock recovery');
      }
      unlinkSync(lockPath);
      createExclusiveLock(lockPath, content);
    } finally {
      const recovery = readJson(recoveryPath, 'install lock recovery claim');
      if (recovery.token !== recoveryToken) {
        throw new Error('install lock recovery claim changed unexpectedly');
      }
      unlinkSync(recoveryPath);
    }
  }

  return () => {
    const observed = readOwnedLock(lockPath, 'active install lock');
    if (observed.value.token !== token) {
      throw new Error(
        'install lock ownership changed unexpectedly; refusing unsafe cleanup',
      );
    }
    unlinkSync(lockPath);
  };
}

function assertDirectDirectory(path, label) {
  const state = lstatSync(path);
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path
  ) {
    throw new Error(`${label} must be a canonical directory, not a symlink`);
  }
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function sanitizedEnvironment(nodePath) {
  return {
    PATH: `${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: realpathSync(tmpdir()),
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
    no_proxy: '',
  };
}

function defaultRunCli(nodePath, cliPath, args) {
  const result = spawnSync(nodePath, [cliPath, ...args], {
    encoding: 'utf8',
    env: sanitizedEnvironment(nodePath),
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireCliSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${(result.stderr || result.stdout || `exit ${String(result.status)}`).trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function boundedInstallFailure(installed) {
  if (Array.isArray(installed.preflight?.checks)) {
    const failures = installed.preflight.checks
      .filter((check) => check?.status === 'fail')
      .map(
        (check) =>
          `${String(check.name ?? 'check')}: ${String(check.reason ?? 'failed')}`,
      );
    if (failures.length > 0) return failures.join('; ').slice(0, 4_000);
  }
  return String(
    installed.npm_stderr || installed.npm_stdout || 'no diagnostic output',
  )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, 4_000);
}

function runCredentialFreeInstallSmoke(runCli) {
  const temporaryParent = realpathSync(tmpdir());
  const smokeRoot = realpathSync(
    mkdtempSync(join(temporaryParent, 'echo-brain-install-smoke-')),
  );
  const configPath = join(smokeRoot, 'runtime.json');
  const stateDirectory = join(smokeRoot, 'state');
  try {
    requireCliSuccess(
      runCli([
        'onboard',
        '--config',
        configPath,
        '--state-dir',
        stateDirectory,
      ]),
      'credential-free installation smoke onboarding',
    );
    return requireCliSuccess(
      runCli(['selftest', '--config', configPath]),
      'credential-free installation SQLite selftest',
    );
  } finally {
    if (
      dirname(smokeRoot) !== temporaryParent ||
      !basename(smokeRoot).startsWith('echo-brain-install-smoke-')
    ) {
      throw new Error('refusing to clean an unsafe installation smoke path');
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function parseManifestIdentity(manifest) {
  if (
    !isRecord(manifest) ||
    manifest.schema_version !== 1 ||
    manifest.package !== 'echo-brain' ||
    typeof manifest.version !== 'string' ||
    !VERSION_RE.test(manifest.version) ||
    typeof manifest.source_sha !== 'string' ||
    !SOURCE_SHA_RE.test(manifest.source_sha) ||
    !isRecord(manifest.declared_platform) ||
    typeof manifest.declared_platform.os !== 'string' ||
    typeof manifest.declared_platform.architecture !== 'string' ||
    typeof manifest.declared_platform.node !== 'string' ||
    !isRecord(manifest.artifact) ||
    typeof manifest.artifact.path !== 'string' ||
    manifest.artifact.path.includes('/') ||
    typeof manifest.artifact.sha256 !== 'string' ||
    !SHA256_RE.test(manifest.artifact.sha256) ||
    !Array.isArray(manifest.package_files)
  ) {
    throw new Error('artifact manifest identity is invalid');
  }
  return {
    version: manifest.version,
    sourceSha: manifest.source_sha,
    platform: manifest.declared_platform.os,
    architecture: manifest.declared_platform.architecture,
    nodeVersion: manifest.declared_platform.node,
    artifactName: manifest.artifact.path,
    artifactSha256: manifest.artifact.sha256,
    packageFiles: manifest.package_files,
    managedApiSha256: manifest.package_files.find(
      (entry) =>
        isRecord(entry) &&
        entry.path === 'dist/product/artifact-rollback.js' &&
        typeof entry.sha256 === 'string' &&
        SHA256_RE.test(entry.sha256),
    )?.sha256,
  };
}

function operationIdentifier(prefix, version, sourceSha, now, pid) {
  const instant = now()
    .replace(/[^0-9A-Za-z]/g, '')
    .slice(0, 17);
  return `${prefix}-${version}-${sourceSha.slice(0, 12)}-${instant}-${String(pid)}`;
}

function recoverInstallerSwitches(api, managedRoot, identity, releaseId, pin) {
  const expectedPrefix = `install-${identity.version}-${identity.sourceSha.slice(0, 12)}-`;
  for (const name of readdirSync(managedRoot)) {
    if (!name.startsWith('.release-switch-') || !name.endsWith('.json'))
      continue;
    const markerPath = join(managedRoot, name);
    const state = lstatSync(markerPath);
    const uid = process.getuid?.();
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      (uid !== undefined && state.uid !== uid) ||
      (state.mode & 0o077) !== 0
    ) {
      throw new Error('managed release switch marker is unsafe');
    }
    const marker = readJson(markerPath, 'managed release switch marker');
    if (marker.phase !== 'prepared' && marker.phase !== 'revert-failed') {
      continue;
    }
    const expectedName = `.release-switch-${String(marker.operation_id)}.json`;
    if (
      marker.schema_version !== 1 ||
      marker.kind !== 'echo-product-release-switch' ||
      name !== expectedName ||
      typeof marker.operation_id !== 'string' ||
      !marker.operation_id.startsWith(expectedPrefix) ||
      marker.release_id !== releaseId ||
      marker.previous_release_id !== null ||
      marker.source_sha !== identity.sourceSha ||
      marker.version !== identity.version ||
      marker.artifact_sha256 !== identity.artifactSha256 ||
      marker.artifact_manifest_sha256 !== pin.artifactManifestSha256 ||
      marker.deployed_tree_manifest_sha256 !== pin.deployedTreeManifestSha256
    ) {
      throw new Error(
        `incomplete managed release switch ${String(marker.operation_id ?? 'unknown')} is not owned by this exact first-install operation`,
      );
    }
    api.recoverManagedProductReleaseSwitch({
      managedReleasesRoot: managedRoot,
      operationId: marker.operation_id,
    });
  }
}

function releasePinFromManifest(
  path,
  identity,
  expectedArtifactManifestSha256,
) {
  const manifest = readJson(path, 'deployed-tree manifest');
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.artifact) ||
    manifest.release_id !==
      `${identity.version}-${identity.sourceSha.slice(0, 12)}` ||
    manifest.artifact.version !== identity.version ||
    manifest.artifact.source_sha !== identity.sourceSha ||
    manifest.artifact.sha256 !== identity.artifactSha256 ||
    typeof manifest.artifact.manifest_sha256 !== 'string' ||
    !SHA256_RE.test(manifest.artifact.manifest_sha256) ||
    manifest.artifact.manifest_sha256 !== expectedArtifactManifestSha256
  ) {
    throw new Error(
      'existing managed release does not match the supplied artifact',
    );
  }
  return {
    sourceSha: identity.sourceSha,
    version: identity.version,
    artifactSha256: identity.artifactSha256,
    artifactManifestSha256: manifest.artifact.manifest_sha256,
    deployedTreeManifestSha256: sha256File(path),
    qualificationReport: null,
  };
}

function assertInstalledProductMatchesArtifact(releaseDirectory, identity) {
  if (identity.managedApiSha256 === undefined) {
    throw new Error(
      'artifact manifest does not contain the managed-release API; build a new candidate with the bundled installer',
    );
  }
  const packageRoot = join(releaseDirectory, 'prefix/node_modules/echo-brain');
  assertDirectDirectory(packageRoot, 'installed product package');
  for (const entry of identity.packageFiles) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      entry.path === '' ||
      entry.path.includes('\\') ||
      isAbsolute(entry.path) ||
      entry.path
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..') ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_RE.test(entry.sha256)
    ) {
      throw new Error('artifact package inventory contains an unsafe entry');
    }
    const path = join(packageRoot, ...entry.path.split('/'));
    if (!pathExists(path)) {
      throw new Error(
        `installed product package entry is missing: ${entry.path}`,
      );
    }
    const state = lstatSync(path);
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      realpathSync(path) !== path ||
      state.size !== entry.size ||
      sha256File(path) !== entry.sha256
    ) {
      throw new Error(
        `installed product package entry does not match the artifact: ${entry.path}`,
      );
    }
  }
}

async function defaultLoadManagedReleaseApi(releaseDirectory) {
  const modulePath = join(
    releaseDirectory,
    'prefix/node_modules/echo-brain/dist/product/artifact-rollback.js',
  );
  if (!existsSync(modulePath)) {
    throw new Error(
      'installed artifact does not contain the managed-release API; build a new candidate with the bundled installer',
    );
  }
  return import(pathToFileURL(modulePath).href);
}

function removeUnsealedRelease(path) {
  if (!pathExists(path)) return;
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path ||
    (uid !== undefined && state.uid !== uid)
  ) {
    throw new Error('refusing to clean an unsafe release path');
  }
  const directories = [];
  function validateOwnedTree(directory) {
    const directoryState = lstatSync(directory);
    if (
      directoryState.isSymbolicLink() ||
      !directoryState.isDirectory() ||
      (uid !== undefined && directoryState.uid !== uid)
    ) {
      throw new Error('refusing to clean an unsafe release directory');
    }
    directories.push(directory);
    for (const name of readdirSync(directory)) {
      const entry = join(directory, name);
      const entryState = lstatSync(entry);
      if (uid !== undefined && entryState.uid !== uid) {
        throw new Error(
          'refusing to clean a release entry owned by another user',
        );
      }
      if (entryState.isSymbolicLink() || entryState.isFile()) continue;
      if (entryState.isDirectory()) validateOwnedTree(entry);
      else throw new Error('refusing to clean a special release entry');
    }
  }
  validateOwnedTree(path);
  for (const directory of directories) chmodSync(directory, 0o700);
  rmSync(path, { recursive: true, force: true });
}

function writeManagedLauncher(installRoot, managedRoot, nodePath) {
  const binDirectory = join(installRoot, 'bin');
  ensurePrivateDirectory(binDirectory, 'launcher directory');
  const launcherPath = join(binDirectory, 'echo-brain');
  const cliPath = join(
    managedRoot,
    'current/prefix/node_modules/echo-brain/dist/product/cli.js',
  );
  const content = [
    '#!/bin/sh',
    LAUNCHER_MARKER,
    `exec ${shellSingleQuote(nodePath)} ${shellSingleQuote(cliPath)} \"$@\"`,
    '',
  ].join('\n');
  if (pathExists(launcherPath)) {
    const state = lstatSync(launcherPath);
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      !readFileSync(launcherPath, 'utf8').includes(LAUNCHER_MARKER)
    ) {
      throw new Error(
        `refusing to replace an unmanaged launcher: ${launcherPath}`,
      );
    }
    if (
      (state.mode & 0o777) !== 0o700 ||
      readFileSync(launcherPath, 'utf8') !== content
    ) {
      throw new Error(
        `managed launcher does not match the install-root runtime pin: ${launcherPath}`,
      );
    }
    return { launcherPath, cliPath, changed: false };
  }
  const temporary = join(
    binDirectory,
    `.echo-brain-${String(process.pid)}.tmp`,
  );
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o700 });
  renameSync(temporary, launcherPath);
  chmodSync(launcherPath, 0o700);
  return { launcherPath, cliPath, changed: true };
}

function assertManagedLauncherAvailable(installRoot) {
  const launcherPath = join(installRoot, 'bin/echo-brain');
  if (!pathExists(launcherPath)) return;
  const state = lstatSync(launcherPath);
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    !readFileSync(launcherPath, 'utf8').includes(LAUNCHER_MARKER)
  ) {
    throw new Error(
      `refusing to replace an unmanaged launcher: ${launcherPath}`,
    );
  }
}

function selectedReleaseId(managedRoot) {
  const current = join(managedRoot, 'current');
  if (!pathExists(current)) return null;
  const state = lstatSync(current);
  if (!state.isSymbolicLink()) {
    throw new Error('managed current pointer must be a symlink or absent');
  }
  const releaseId = readlinkSync(current);
  if (
    releaseId === '' ||
    releaseId === '.' ||
    releaseId === '..' ||
    releaseId.includes('/') ||
    releaseId.includes('\\')
  ) {
    throw new Error('managed current pointer target is unsafe');
  }
  const releaseDirectory = join(managedRoot, releaseId);
  if (!pathExists(releaseDirectory)) {
    throw new Error('managed current pointer target does not exist');
  }
  assertDirectDirectory(releaseDirectory, 'selected managed release');
  return releaseId;
}

function existingOnboardState(configPath, stateDirectory) {
  if (!pathExists(configPath)) return false;
  const state = lstatSync(configPath);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(configPath) !== configPath ||
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o077) !== 0
  ) {
    throw new Error(
      'existing onboarding config must be a private current-user-owned regular file',
    );
  }
  const config = readJson(configPath, 'existing onboarding config');
  if (!isRecord(config) || config.state_dir !== stateDirectory) {
    throw new Error(
      'existing onboarding config uses a different state directory',
    );
  }
  if (!pathExists(stateDirectory)) {
    throw new Error('existing onboarding state directory is missing');
  }
  assertPrivateDirectory(stateDirectory, 'existing onboarding state directory');
  const credentialsDirectory = join(stateDirectory, 'credentials');
  if (!pathExists(credentialsDirectory)) {
    throw new Error('existing onboarding credentials directory is missing');
  }
  assertPrivateDirectory(
    credentialsDirectory,
    'existing onboarding credentials directory',
  );
  return true;
}

function cleanupFailedOnboardScaffold(
  configPath,
  stateDirectory,
  stateExisted,
) {
  if (pathExists(configPath) || !pathExists(stateDirectory)) return;
  assertPrivateDirectory(stateDirectory, 'failed onboarding state directory');
  const names = readdirSync(stateDirectory);
  if (names.length === 1 && names[0] === 'credentials') {
    const credentials = join(stateDirectory, 'credentials');
    assertPrivateDirectory(
      credentials,
      'failed onboarding credentials directory',
    );
    if (readdirSync(credentials).length === 0) rmdirSync(credentials);
  }
  if (!stateExisted && readdirSync(stateDirectory).length === 0) {
    rmdirSync(stateDirectory);
  }
}

function defaultEvidencePath(installRoot, releaseId, now, pid) {
  const directory = join(installRoot, 'evidence', releaseId);
  ensurePrivateDirectory(directory, 'installation evidence directory');
  const instant = now()
    .replace(/[^0-9A-Za-z]/g, '')
    .slice(0, 17);
  const stem = `install-${instant}-${String(pid)}`;
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const path = join(
      directory,
      `${stem}${suffix === 0 ? '' : `-${String(suffix)}`}.json`,
    );
    if (!pathExists(path)) return path;
  }
  throw new Error('could not allocate a unique installation evidence path');
}

function reservePrivateJson(path, value) {
  normalizedAbsolute(path, 'evidence path');
  ensurePrivateDirectory(dirname(path), 'evidence parent directory');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function replacePrivateJson(path, value) {
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (uid !== undefined && state.uid !== uid)
  ) {
    throw new Error('reserved evidence path is not a current-user-owned file');
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.tmp`,
  );
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function removeNewManagedLauncher(launcherPath) {
  if (!pathExists(launcherPath)) return;
  const state = lstatSync(launcherPath);
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    !readFileSync(launcherPath, 'utf8').includes(LAUNCHER_MARKER)
  ) {
    throw new Error(
      'refusing to clean an unsafe launcher after activation failure',
    );
  }
  unlinkSync(launcherPath);
}

/**
 * Verify, install, seal, and select one exact product bundle. This deliberately
 * stops before credentials, init, live adapters, or service installation.
 */
export async function installProductBundle(options, dependencies = {}) {
  const bundleRoot = normalizedAbsolute(
    resolve(options.bundleRoot),
    'bundle root',
  );
  const installRoot = normalizedAbsolute(
    resolve(options.installRoot),
    'install root',
  );
  if (
    typeof options.expectedArtifactSha256 !== 'string' ||
    !SHA256_RE.test(options.expectedArtifactSha256)
  ) {
    throw new Error('expected artifact SHA-256 is required in lowercase hex');
  }
  if (/\s/u.test(installRoot)) {
    throw new Error(
      'install root may not contain whitespace in installer v1 because native npm builds are not path-safe yet',
    );
  }
  const sourceArchive = options.sourceArchive;
  if (
    sourceArchive !== undefined &&
    (typeof sourceArchive.name !== 'string' ||
      sourceArchive.name === '' ||
      basename(sourceArchive.name) !== sourceArchive.name ||
      sourceArchive.name.includes('\\') ||
      typeof sourceArchive.sha256 !== 'string' ||
      !SHA256_RE.test(sourceArchive.sha256))
  ) {
    throw new Error('source archive identity is invalid');
  }
  const sourceArchiveEvidence =
    sourceArchive === undefined ? {} : { source_archive: sourceArchive };
  assertDirectDirectory(bundleRoot, 'bundle root');
  const artifactDirectory = join(bundleRoot, 'artifact');
  const supportDirectory = join(bundleRoot, 'qualification-support');
  assertDirectDirectory(artifactDirectory, 'artifact directory');
  assertDirectDirectory(supportDirectory, 'qualification support directory');

  const verify = dependencies.verifyBundle ?? verifyBundle;
  const verified = await verify({
    artifactDir: artifactDirectory,
    supportDir: supportDirectory,
  });
  if (!verified.ok) {
    throw new Error(
      `bundle verification failed: ${verified.errors.join('; ')}`,
    );
  }
  const identity = parseManifestIdentity(verified.artifact_manifest);
  if (options.expectedArtifactSha256 !== identity.artifactSha256) {
    throw new Error(
      'artifact checksum does not match --expected-artifact-sha256',
    );
  }
  const observedPlatform = dependencies.platform ?? process.platform;
  const observedArchitecture = dependencies.architecture ?? process.arch;
  const observedNodeVersion = dependencies.nodeVersion ?? process.versions.node;
  if (
    observedPlatform !== identity.platform ||
    observedArchitecture !== identity.architecture ||
    observedNodeVersion !== identity.nodeVersion
  ) {
    throw new Error(
      `bundle requires ${identity.platform}/${identity.architecture} Node ${identity.nodeVersion}; observed ${observedPlatform}/${observedArchitecture} Node ${observedNodeVersion}`,
    );
  }

  const onboard =
    options.onboard === undefined
      ? undefined
      : {
          configPath: normalizedAbsolute(
            resolve(options.onboard.configPath),
            'onboarding config path',
          ),
          stateDirectory: normalizedAbsolute(
            resolve(options.onboard.stateDirectory),
            'onboarding state directory',
          ),
        };
  let onboardAlreadyExists = false;
  if (onboard !== undefined) {
    if (
      onboard.configPath === onboard.stateDirectory ||
      pathIsWithin(onboard.configPath, onboard.stateDirectory)
    ) {
      throw new Error(
        'onboarding config must live outside the state directory',
      );
    }
    onboardAlreadyExists = existingOnboardState(
      onboard.configPath,
      onboard.stateDirectory,
    );
  }

  if (pathsOverlap(bundleRoot, installRoot)) {
    throw new Error('bundle root and managed install root must be disjoint');
  }
  if (onboard !== undefined) {
    for (const [path, label] of [
      [onboard.configPath, 'onboarding config'],
      [onboard.stateDirectory, 'onboarding state'],
    ]) {
      if (pathsOverlap(path, installRoot) || pathsOverlap(path, bundleRoot)) {
        throw new Error(
          `${label} must be disjoint from bundle and install roots`,
        );
      }
    }
  }

  const nodePath = normalizedAbsolute(
    resolve(dependencies.nodePath ?? process.execPath),
    'Node executable path',
  );
  const now = dependencies.now ?? (() => new Date().toISOString());
  assertManagedLauncherAvailable(installRoot);
  prepareInstallRoot(
    installRoot,
    installRootIdentity(installRoot, nodePath, identity),
  );
  const releaseInstallLock = acquireInstallLock(installRoot);
  try {
    const managedRoot = join(installRoot, 'releases');
    const evidenceRoot = join(installRoot, 'evidence');
    ensurePrivateDirectory(managedRoot, 'managed releases root');
    ensurePrivateDirectory(evidenceRoot, 'installation evidence root');
    const releaseId = `${identity.version}-${identity.sourceSha.slice(0, 12)}`;
    const currentReleaseId = selectedReleaseId(managedRoot);
    if (currentReleaseId !== null && currentReleaseId !== releaseId) {
      throw new Error(
        'installer v1 refuses in-place upgrades; use the controlled service-stop, backup, compatibility, and rollback workflow',
      );
    }
    if (currentReleaseId === null && onboardAlreadyExists) {
      throw new Error(
        'installer v1 will not adopt an existing onboarded state without a selected managed release',
      );
    }

    const evidencePath =
      options.evidencePath === undefined
        ? defaultEvidencePath(installRoot, releaseId, now, process.pid)
        : normalizedAbsolute(resolve(options.evidencePath), 'evidence path');
    if (!pathIsWithin(evidencePath, evidenceRoot)) {
      throw new Error('evidence path must be inside the managed evidence root');
    }
    if (pathExists(evidencePath)) {
      throw new Error(`evidence path already exists: ${evidencePath}`);
    }
    reservePrivateJson(evidencePath, {
      schema_version: 1,
      kind: 'echo-product-bundle-install-preparation',
      ok: false,
      phase: 'bundle-verified',
      ...sourceArchiveEvidence,
      release_id: releaseId,
      artifact_sha256: identity.artifactSha256,
    });

    const releaseDirectory = join(managedRoot, releaseId);
    const deployedManifestPath = join(
      releaseDirectory,
      'deployed-tree-manifest.json',
    );
    const artifactManifestPath = join(
      artifactDirectory,
      'artifact-manifest.json',
    );
    const artifactPath = join(artifactDirectory, identity.artifactName);
    const artifactChecksumPath = `${artifactPath}.sha256`;
    const retainedManifestPath = join(
      releaseDirectory,
      'artifact-manifest.json',
    );
    const retainedArtifactPath = join(releaseDirectory, identity.artifactName);
    const retainedChecksumPath = `${retainedArtifactPath}.sha256`;
    const prefix = join(releaseDirectory, 'prefix');
    const directCliPath = join(
      releaseDirectory,
      'prefix/node_modules/echo-brain/dist/product/cli.js',
    );
    const runCli =
      dependencies.runCli ??
      ((args) => defaultRunCli(nodePath, directCliPath, args));
    const loadManagedReleaseApi =
      dependencies.loadManagedReleaseApi ?? defaultLoadManagedReleaseApi;
    let pin;
    let api;
    let changed = false;
    let releaseCreated = false;
    let sealed = false;
    let installSummary = null;

    try {
      if (pathExists(releaseDirectory)) {
        try {
          if (!pathExists(deployedManifestPath)) {
            throw new Error('managed release is not sealed');
          }
          pin = releasePinFromManifest(
            deployedManifestPath,
            identity,
            verified.artifact_manifest_sha256,
          );
          assertInstalledProductMatchesArtifact(releaseDirectory, identity);
          api = await loadManagedReleaseApi(releaseDirectory);
          api.verifyManagedProductRelease({
            managedReleasesRoot: managedRoot,
            releaseId,
            expected: pin,
          });
          sealed = true;
        } catch (error) {
          if (currentReleaseId === releaseId) throw error;
          removeUnsealedRelease(releaseDirectory);
        }
      }
      if (!pathExists(releaseDirectory)) {
        mkdirSync(releaseDirectory, { mode: 0o700 });
        releaseCreated = true;
        requirePrivateDirectory(releaseDirectory, 'release directory');
        copyFileSync(
          artifactManifestPath,
          retainedManifestPath,
          constants.COPYFILE_EXCL,
        );
        copyFileSync(
          artifactPath,
          retainedArtifactPath,
          constants.COPYFILE_EXCL,
        );
        copyFileSync(
          artifactChecksumPath,
          retainedChecksumPath,
          constants.COPYFILE_EXCL,
        );
        chmodSync(retainedManifestPath, 0o600);
        chmodSync(retainedArtifactPath, 0o600);
        chmodSync(retainedChecksumPath, 0o600);

        const install = dependencies.installOffline ?? installOffline;
        const installed = await install({
          artifact: retainedArtifactPath,
          artifactManifest: retainedManifestPath,
          supportDir: supportDirectory,
          prefix,
        });
        installSummary = {
          ok: installed.ok,
          stage: installed.stage,
          npm_invoked: installed.npm_invoked,
          npm_status: installed.npm_status ?? null,
        };
        if (!installed.ok) {
          throw new Error(
            `offline installation failed at ${installed.stage}: ${boundedInstallFailure(installed)}`,
          );
        }
        // installOffline requires the authenticated checksum sidecar while it
        // re-verifies the staged artifact. The sealed managed-release schema
        // intentionally retains only the manifest, artifact, and prefix.
        unlinkSync(retainedChecksumPath);
        assertInstalledProductMatchesArtifact(releaseDirectory, identity);
        api = await loadManagedReleaseApi(releaseDirectory);
      }

      if (sealed) {
        recoverInstallerSwitches(api, managedRoot, identity, releaseId, pin);
      }

      const versionCheck = runCli(['--version']);
      if (
        versionCheck.status !== 0 ||
        versionCheck.stdout.trim() !== identity.version
      ) {
        throw new Error(
          `installed CLI version check failed: ${(versionCheck.stderr || versionCheck.stdout || `exit ${String(versionCheck.status)}`).trim()}`,
        );
      }
      runCredentialFreeInstallSmoke(runCli);

      if (!sealed) {
        const prepared = api.prepareManagedProductRelease({
          managedReleasesRoot: managedRoot,
          releaseId,
          expectedSourceSha: identity.sourceSha,
          expectedVersion: identity.version,
          expectedArtifactSha256: identity.artifactSha256,
          expectedArtifactManifestSha256: sha256File(retainedManifestPath),
        });
        pin = prepared.pin;
        sealed = true;
        changed = true;
      }
    } catch (error) {
      if (releaseCreated && !sealed) removeUnsealedRelease(releaseDirectory);
      try {
        replacePrivateJson(evidencePath, {
          schema_version: 1,
          kind: 'echo-product-bundle-install',
          ok: false,
          phase: 'release-preparation-failed',
          ...sourceArchiveEvidence,
          release_id: releaseId,
          artifact_sha256: identity.artifactSha256,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Preserve the primary installation error.
      }
      throw error;
    }

    replacePrivateJson(evidencePath, {
      schema_version: 1,
      kind: 'echo-product-bundle-install-preparation',
      ok: false,
      phase: 'activation-prepared',
      ...sourceArchiveEvidence,
      release_id: releaseId,
      artifact_sha256: identity.artifactSha256,
    });
    const launcherPreviouslyExisted = pathExists(
      join(installRoot, 'bin/echo-brain'),
    );
    let launcher;
    let switched;
    try {
      launcher = writeManagedLauncher(installRoot, managedRoot, nodePath);
      switched = api.switchManagedProductRelease({
        managedReleasesRoot: managedRoot,
        releaseId,
        expected: pin,
        operationId: operationIdentifier(
          'install',
          identity.version,
          identity.sourceSha,
          now,
          process.pid,
        ),
        switchedAt: now(),
      });
      changed = changed || switched.evidence.switched || launcher.changed;
    } catch (error) {
      if (!launcherPreviouslyExisted) {
        removeNewManagedLauncher(join(installRoot, 'bin/echo-brain'));
      }
      try {
        replacePrivateJson(evidencePath, {
          schema_version: 1,
          kind: 'echo-product-bundle-install',
          ok: false,
          phase: 'activation-failed',
          ...sourceArchiveEvidence,
          release_id: releaseId,
          artifact_sha256: identity.artifactSha256,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The managed switch journal remains the durable recovery authority.
      }
      throw error;
    }

    replacePrivateJson(evidencePath, {
      schema_version: 1,
      kind: 'echo-product-bundle-install',
      ok: true,
      phase: 'installed',
      ...sourceArchiveEvidence,
      release_id: releaseId,
      artifact_sha256: identity.artifactSha256,
      onboard_requested: onboard !== undefined,
    });

    let onboardChanged = false;
    let onboardResult = null;
    if (onboard !== undefined) {
      const stateExistedBefore = pathExists(onboard.stateDirectory);
      try {
        if (!onboardAlreadyExists) {
          onboardResult = requireCliSuccess(
            runCli([
              'onboard',
              '--config',
              onboard.configPath,
              '--state-dir',
              onboard.stateDirectory,
            ]),
            'secret-free onboarding',
          );
          onboardChanged = true;
        }
        requireCliSuccess(
          runCli(['validate-config', '--config', onboard.configPath]),
          'installed config validation',
        );
        requireCliSuccess(
          runCli(['selftest', '--config', onboard.configPath]),
          'installed offline selftest',
        );
      } catch (error) {
        if (!onboardAlreadyExists) {
          try {
            cleanupFailedOnboardScaffold(
              onboard.configPath,
              onboard.stateDirectory,
              stateExistedBefore,
            );
          } catch {
            // Leave unexpected user-visible paths intact for manual inspection.
          }
        }
        try {
          replacePrivateJson(evidencePath, {
            schema_version: 1,
            kind: 'echo-product-bundle-install',
            ok: false,
            install_ok: true,
            phase: 'onboarding-failed',
            ...sourceArchiveEvidence,
            release_id: releaseId,
            artifact_sha256: identity.artifactSha256,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The installed release and managed switch journal remain inspectable.
        }
        throw error;
      }
    }

    const result = {
      schema_version: 1,
      kind: 'echo-product-bundle-install',
      ok: true,
      maturity: 'DEV',
      changed: changed || onboardChanged,
      release_id: releaseId,
      artifact: {
        version: identity.version,
        source_sha: identity.sourceSha,
        sha256: identity.artifactSha256,
        manifest_sha256: verified.artifact_manifest_sha256,
      },
      ...sourceArchiveEvidence,
      runtime: {
        os: observedPlatform,
        architecture: observedArchitecture,
        node: observedNodeVersion,
        node_path: nodePath,
      },
      paths: {
        install_root: installRoot,
        release_dir: releaseDirectory,
        current: join(managedRoot, 'current'),
        cli: launcher.launcherPath,
        evidence: evidencePath,
      },
      install: installSummary,
      onboard: {
        requested: onboard !== undefined,
        changed: onboardChanged,
        ...(onboard === undefined
          ? {}
          : {
              config_path: onboard.configPath,
              state_dir: onboard.stateDirectory,
              credential_path:
                onboardResult?.credential_path ??
                join(onboard.stateDirectory, 'credentials/granola-api-key'),
            }),
      },
      upgrades_supported: false,
      live_contact: false,
      service_installed: false,
    };
    replacePrivateJson(evidencePath, result);
    return result;
  } finally {
    releaseInstallLock();
  }
}

function parseArgs(argv) {
  const args = {
    bundleRoot: undefined,
    installRoot: join(homedir(), '.local/share/echo-brain'),
    expectedArtifactSha256: undefined,
    evidencePath: undefined,
    sourceArchiveName: undefined,
    sourceArchiveSha256: undefined,
    onboard: false,
    configPath: join(homedir(), '.config/echo-brain/runtime.json'),
    stateDirectory: join(homedir(), '.local/state/echo-brain'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--onboard') {
      args.onboard = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(
        [
          'Usage:',
          '  install-bundle.mjs [--bundle-root PATH] [--install-root PATH]',
          '    [--expected-artifact-sha256 SHA256] [--evidence PATH]',
          '    [--onboard [--config PATH] [--state-dir PATH]]',
          '',
          'Installs and verifies exact product bytes without credentials, live vendor calls,',
          'initialization, or service activation.',
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
    const names = new Map([
      ['--bundle-root', 'bundleRoot'],
      ['--install-root', 'installRoot'],
      ['--expected-artifact-sha256', 'expectedArtifactSha256'],
      ['--evidence', 'evidencePath'],
      ['--source-archive-name', 'sourceArchiveName'],
      ['--source-archive-sha256', 'sourceArchiveSha256'],
      ['--config', 'configPath'],
      ['--state-dir', 'stateDirectory'],
    ]);
    const name = names.get(flag);
    if (name === undefined) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    args[name] = value;
  }
  if (args.bundleRoot === undefined) {
    const candidate = resolve(TOOL_DIR, '..');
    if (
      !existsSync(join(candidate, 'artifact')) ||
      !existsSync(join(candidate, 'qualification-support'))
    ) {
      throw new Error(
        '--bundle-root is required outside an extracted product bundle',
      );
    }
    args.bundleRoot = candidate;
  }
  if (
    args.expectedArtifactSha256 !== undefined &&
    !SHA256_RE.test(args.expectedArtifactSha256)
  ) {
    throw new Error(
      '--expected-artifact-sha256 must be a lowercase SHA-256 digest',
    );
  }
  if (
    (args.sourceArchiveName === undefined) !==
    (args.sourceArchiveSha256 === undefined)
  ) {
    throw new Error(
      '--source-archive-name and --source-archive-sha256 must be supplied together',
    );
  }
  if (
    args.sourceArchiveName !== undefined &&
    (basename(args.sourceArchiveName) !== args.sourceArchiveName ||
      args.sourceArchiveName.includes('\\') ||
      !SHA256_RE.test(args.sourceArchiveSha256))
  ) {
    throw new Error('source archive identity is invalid');
  }
  if (args.expectedArtifactSha256 === undefined) {
    throw new Error('--expected-artifact-sha256 is required in lowercase hex');
  }
  return {
    bundleRoot: resolve(args.bundleRoot),
    installRoot: resolve(args.installRoot),
    expectedArtifactSha256: args.expectedArtifactSha256,
    ...(args.evidencePath === undefined
      ? {}
      : { evidencePath: resolve(args.evidencePath) }),
    ...(args.sourceArchiveName === undefined
      ? {}
      : {
          sourceArchive: {
            name: args.sourceArchiveName,
            sha256: args.sourceArchiveSha256,
          },
        }),
    ...(args.onboard
      ? {
          onboard: {
            configPath: resolve(args.configPath),
            stateDirectory: resolve(args.stateDirectory),
          },
        }
      : {}),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await installProductBundle(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`install-bundle: ${error.message}\n`);
    process.exitCode = 1;
  });
}
