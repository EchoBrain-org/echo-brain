#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyOrganizationAdminEdgeArtifact } from "./verify-artifact.mjs";

const RELEASE_ID_PATTERN =
  /^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*-[a-f0-9]{12}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_PATH_CHARACTERS = 4096;
const DEPLOYED_MANIFEST = "deployed-tree-manifest.json";
const ARTIFACT_DIRECTORY = "artifact";
const RUNTIME_DIRECTORY = "runtime";
const PACKAGE_DIRECTORY = "package";
const EDGE_LAUNCHER = "bin/echo-organization-admin-edge.mjs";
const PUBLICATION_WAIT_MILLISECONDS = 10;
const PUBLICATION_WAIT_ATTEMPTS = 100;
const PUBLICATION_WAIT_WORD = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

function fail(message) {
  throw new Error(`admin-edge-install-release: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_CHARACTERS ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === resolve("/")
  ) {
    fail(`${label} must be a normalized absolute path below root`);
  }
  return value;
}

function assertSafeSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be one lowercase SHA-256 digest`);
  }
  return value;
}

function assertCanonicalDirectory(path, label, mode) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is unavailable`);
  }
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path ||
    (uid !== undefined && state.uid !== uid) ||
    (mode !== undefined && (state.mode & 0o777) !== mode)
  ) {
    fail(
      `${label} must be a canonical current-user directory${mode === undefined ? "" : ` with mode ${mode.toString(8).padStart(4, "0")}`}`,
    );
  }
  return state;
}

function ensurePrivateDirectory(path, label) {
  if (!existsSync(path)) {
    const parent = dirname(path);
    assertCanonicalDirectory(parent, `${label} parent`);
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(parent);
  }
  assertCanonicalDirectory(path, label, 0o700);
}

function waitForSealedPublishedRelease(path) {
  for (let attempt = 0; attempt < PUBLICATION_WAIT_ATTEMPTS; attempt += 1) {
    const state = assertCanonicalDirectory(path, "published release");
    const mode = state.mode & 0o777;
    if (mode === 0o500) return;
    if (mode !== 0o700) {
      fail("published release has an invalid intermediate mode");
    }
    if (attempt + 1 < PUBLICATION_WAIT_ATTEMPTS) {
      Atomics.wait(PUBLICATION_WAIT_WORD, 0, 0, PUBLICATION_WAIT_MILLISECONDS);
    }
  }
  fail("published release did not reach its sealed mode");
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncRegularFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readRegularFile(path, label, maximumBytes = 1024 * 1024) {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isFile() || state.size > maximumBytes) {
    fail(`${label} must be a bounded regular file`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== state.dev ||
      opened.ino !== state.ino ||
      opened.size !== state.size
    ) {
      fail(`${label} changed while opening`);
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length !== opened.size) fail(`${label} changed while reading`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path, content, mode) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
}

function collectTree(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const state = lstatSync(path);
      const relativePath = relative(root, path).split(sep).join("/");
      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith("../")
      ) {
        fail("installed package path escaped its release");
      }
      if (state.isSymbolicLink()) {
        fail(`installed package contains a symbolic link: ${relativePath}`);
      }
      if (state.isDirectory()) {
        const uid = process.getuid?.();
        if (uid !== undefined && state.uid !== uid) {
          fail(
            `installed package contains a directory owned by another user: ${relativePath}`,
          );
        }
        entries.push({
          path: relativePath,
          type: "directory",
          mode: state.mode & 0o777,
        });
        visit(path);
      } else if (state.isFile()) {
        if (state.nlink !== 1) {
          fail(
            `installed package contains a hard-linked file: ${relativePath}`,
          );
        }
        const uid = process.getuid?.();
        if (uid !== undefined && state.uid !== uid) {
          fail(
            `installed package contains a file owned by another user: ${relativePath}`,
          );
        }
        const bytes = readRegularFile(
          path,
          `installed package file ${relativePath}`,
          16 * 1024 * 1024,
        );
        entries.push({
          path: relativePath,
          type: "file",
          mode: state.mode & 0o777,
          size: bytes.length,
          sha256: sha256(bytes),
          device: state.dev,
          inode: state.ino,
        });
      } else {
        fail(`installed package contains a special file: ${relativePath}`);
      }
    }
  }
  visit(root);
  const fileIdentities = new Set();
  for (const entry of entries.filter(
    (candidate) => candidate.type === "file",
  )) {
    const identity = `${entry.device}:${entry.inode}`;
    if (fileIdentities.has(identity)) {
      fail("installed package contains hard-linked file entries");
    }
    fileIdentities.add(identity);
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function expectedPackageFiles(artifactManifest) {
  return artifactManifest.package_files.map((entry) => ({
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
  }));
}

function expectedPackageDirectories(packageFiles) {
  const directories = new Set();
  for (const entry of packageFiles) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories].sort();
}

function assertExtractedPackage(packageDirectory, artifactManifest) {
  const entries = collectTree(packageDirectory);
  const files = entries
    .filter((entry) => entry.type === "file")
    .map(({ path, size, sha256: digest }) => ({
      path,
      size,
      sha256: digest,
    }));
  if (
    JSON.stringify(files) !==
    JSON.stringify(expectedPackageFiles(artifactManifest))
  ) {
    fail("extracted package differs from the verified artifact manifest");
  }
  const directories = entries
    .filter((entry) => entry.type === "directory")
    .map(({ path }) => path);
  if (
    JSON.stringify(directories) !==
    JSON.stringify(
      expectedPackageDirectories(expectedPackageFiles(artifactManifest)),
    )
  ) {
    fail("extracted package contains an unmanifested directory");
  }
  return entries;
}

function sealTree(root) {
  const entries = collectTree(root).sort(
    (left, right) =>
      right.path.split("/").length - left.path.split("/").length ||
      (right.path < left.path ? -1 : right.path > left.path ? 1 : 0),
  );
  for (const entry of entries) {
    const path = join(root, entry.path);
    chmodSync(
      path,
      entry.type === "directory" ||
        entry.path ===
          `${RUNTIME_DIRECTORY}/${PACKAGE_DIRECTORY}/${EDGE_LAUNCHER}`
        ? 0o500
        : 0o400,
    );
  }
}

function fsyncSealedTree(root) {
  const entries = collectTree(root);
  for (const entry of entries.filter(
    (candidate) => candidate.type === "file",
  )) {
    fsyncRegularFile(join(root, entry.path));
  }
  const directories = entries
    .filter((entry) => entry.type === "directory")
    .sort(
      (left, right) =>
        right.path.split("/").length - left.path.split("/").length ||
        (right.path < left.path ? -1 : right.path > left.path ? 1 : 0),
    );
  for (const entry of directories) {
    fsyncDirectory(join(root, entry.path));
  }
  fsyncDirectory(root);
}

function makeStagingTreeRemovable(path, releasesRoot) {
  const relativePath = relative(releasesRoot, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    !basename(path).startsWith(".staging-")
  ) {
    fail("refusing to unseal an unsafe staging path");
  }
  function visit(directory) {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const state = lstatSync(child);
      if (state.isDirectory() && !state.isSymbolicLink()) visit(child);
      else if (state.isFile() && !state.isSymbolicLink())
        chmodSync(child, 0o600);
    }
  }
  visit(path);
}

function removeFailedPublishedRelease(path, releasesRoot, releaseId) {
  const expectedPath = join(releasesRoot, releaseId);
  if (
    path !== expectedPath ||
    relative(releasesRoot, path) !== releaseId ||
    basename(path) !== releaseId
  ) {
    fail("refusing to remove an unexpected published release path");
  }
  assertCanonicalDirectory(path, "failed published release");
  function visit(directory) {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const state = lstatSync(child);
      if (state.isDirectory() && !state.isSymbolicLink()) visit(child);
      else if (state.isFile() && !state.isSymbolicLink())
        chmodSync(child, 0o600);
    }
  }
  visit(path);
  rmSync(path, { recursive: true, force: true });
  fsyncDirectory(releasesRoot);
}

function releaseIdFor(manifest) {
  const releaseId = `${manifest.version}-${manifest.source_sha.slice(0, 12)}-${manifest.artifact.sha256.slice(0, 12)}`;
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    fail("artifact identity cannot form a safe release ID");
  }
  return releaseId;
}

function deployedManifestFor(
  artifactManifest,
  artifactManifestSha256,
  releaseId,
) {
  return {
    schema_version: 1,
    kind: "echo-organization-admin-edge-installed-release",
    release_id: releaseId,
    artifact: {
      target: "organization-admin-edge",
      package: "@echo-brain/organization-admin-edge",
      source_sha: artifactManifest.source_sha,
      version: artifactManifest.version,
      sha256: artifactManifest.artifact.sha256,
      manifest_sha256: artifactManifestSha256,
    },
    layout: {
      artifact_directory: ARTIFACT_DIRECTORY,
      package_directory: `${RUNTIME_DIRECTORY}/${PACKAGE_DIRECTORY}`,
      launcher: `${RUNTIME_DIRECTORY}/${PACKAGE_DIRECTORY}/${EDGE_LAUNCHER}`,
    },
    package_files: expectedPackageFiles(artifactManifest),
    sealed_modes: {
      directory: "0500",
      file: "0400",
      launcher: "0500",
    },
  };
}

function parseDeployedManifest(path) {
  let parsed;
  try {
    parsed = JSON.parse(
      readRegularFile(path, "deployed-tree manifest").toString("utf8"),
    );
  } catch {
    fail("deployed-tree manifest is not valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schema_version !== 1 ||
    parsed.kind !== "echo-organization-admin-edge-installed-release" ||
    typeof parsed.release_id !== "string" ||
    !RELEASE_ID_PATTERN.test(parsed.release_id) ||
    parsed.artifact?.target !== "organization-admin-edge" ||
    parsed.artifact?.package !== "@echo-brain/organization-admin-edge" ||
    typeof parsed.artifact?.source_sha !== "string" ||
    !SOURCE_SHA_PATTERN.test(parsed.artifact.source_sha) ||
    typeof parsed.artifact?.version !== "string" ||
    !SHA256_PATTERN.test(parsed.artifact?.sha256 ?? "") ||
    !SHA256_PATTERN.test(parsed.artifact?.manifest_sha256 ?? "") ||
    parsed.layout?.artifact_directory !== ARTIFACT_DIRECTORY ||
    parsed.layout?.package_directory !==
      `${RUNTIME_DIRECTORY}/${PACKAGE_DIRECTORY}` ||
    parsed.layout?.launcher !==
      `${RUNTIME_DIRECTORY}/${PACKAGE_DIRECTORY}/${EDGE_LAUNCHER}` ||
    !Array.isArray(parsed.package_files) ||
    JSON.stringify(parsed.sealed_modes) !==
      JSON.stringify({
        directory: "0500",
        file: "0400",
        launcher: "0500",
      })
  ) {
    fail("deployed-tree manifest identity is invalid");
  }
  return parsed;
}

export function verifyOrganizationAdminEdgeInstalledRelease({
  releaseDirectory,
  expectedArtifactSha256,
}) {
  const release = normalizedAbsolutePath(releaseDirectory, "release directory");
  assertCanonicalDirectory(release, "release directory", 0o500);
  const deployedPath = join(release, DEPLOYED_MANIFEST);
  const deployed = parseDeployedManifest(deployedPath);
  if (
    expectedArtifactSha256 !== undefined &&
    deployed.artifact.sha256 !==
      assertSafeSha256(expectedArtifactSha256, "expected artifact SHA-256")
  ) {
    fail("installed release artifact SHA-256 does not match expectation");
  }
  if (basename(release) !== deployed.release_id) {
    fail("installed release directory does not match its release ID");
  }

  const verification = verifyOrganizationAdminEdgeArtifact({
    artifactDir: join(release, ARTIFACT_DIRECTORY),
  });
  if (!verification.ok) fail("retained artifact verification failed");
  if (
    verification.artifact_manifest.source_sha !==
      deployed.artifact.source_sha ||
    verification.artifact_manifest.version !== deployed.artifact.version ||
    verification.artifact_manifest.artifact.sha256 !==
      deployed.artifact.sha256 ||
    verification.artifact_manifest_sha256 !==
      deployed.artifact.manifest_sha256 ||
    JSON.stringify(expectedPackageFiles(verification.artifact_manifest)) !==
      JSON.stringify(deployed.package_files)
  ) {
    fail("installed release identity differs from its retained artifact");
  }

  const packageDirectory = join(release, RUNTIME_DIRECTORY, PACKAGE_DIRECTORY);
  const entries = collectTree(packageDirectory);
  const expectedFiles = deployed.package_files;
  const actualFiles = entries
    .filter((entry) => entry.type === "file")
    .map(({ path, size, sha256: digest }) => ({
      path,
      size,
      sha256: digest,
    }));
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail("sealed installed package differs from its deployed-tree manifest");
  }
  const actualDirectories = entries
    .filter((entry) => entry.type === "directory")
    .map(({ path }) => path);
  if (
    JSON.stringify(actualDirectories) !==
    JSON.stringify(expectedPackageDirectories(expectedFiles))
  ) {
    fail("sealed installed package contains an unmanifested directory");
  }
  for (const entry of entries) {
    const expectedMode =
      entry.type === "directory" || entry.path === EDGE_LAUNCHER
        ? 0o500
        : 0o400;
    if (entry.mode !== expectedMode) {
      fail(`sealed installed package mode changed: ${entry.path}`);
    }
  }

  const releaseEntries = readdirSync(release).sort();
  if (
    JSON.stringify(releaseEntries) !==
    JSON.stringify(
      [ARTIFACT_DIRECTORY, DEPLOYED_MANIFEST, RUNTIME_DIRECTORY].sort(),
    )
  ) {
    fail("installed release contains an unexpected top-level entry");
  }
  const runtimeEntries = readdirSync(join(release, RUNTIME_DIRECTORY)).sort();
  if (JSON.stringify(runtimeEntries) !== JSON.stringify([PACKAGE_DIRECTORY])) {
    fail("installed release runtime contains an unexpected entry");
  }
  for (const directory of [
    join(release, ARTIFACT_DIRECTORY),
    join(release, RUNTIME_DIRECTORY),
    packageDirectory,
  ]) {
    assertCanonicalDirectory(directory, "sealed release directory", 0o500);
  }
  if ((lstatSync(deployedPath).mode & 0o777) !== 0o400) {
    fail("deployed-tree manifest mode changed");
  }

  return Object.freeze({
    ok: true,
    changed: false,
    release_id: deployed.release_id,
    release_directory: release,
    package_directory: packageDirectory,
    edge_cli_path: join(packageDirectory, EDGE_LAUNCHER),
    artifact: Object.freeze({ ...deployed.artifact }),
    deployed_manifest_sha256: sha256(
      readRegularFile(deployedPath, "deployed-tree manifest"),
    ),
  });
}

function copyRetainedArtifact(sourceDirectory, targetDirectory, manifest) {
  mkdirSync(targetDirectory, { mode: 0o700 });
  const filenames = [
    "artifact-manifest.json",
    manifest.artifact.path,
    `${manifest.artifact.path}.sha256`,
  ];
  for (const filename of filenames) {
    copyFileSync(
      join(sourceDirectory, filename),
      join(targetDirectory, filename),
      constants.COPYFILE_EXCL,
    );
    chmodSync(join(targetDirectory, filename), 0o400);
    fsyncRegularFile(join(targetDirectory, filename));
  }
}

function safeManifestPackagePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function readTarEntry(artifactPath, packagePath) {
  const result = spawnSync(
    "/usr/bin/tar",
    ["-xOf", artifactPath, `package/${packagePath}`],
    {
      encoding: "buffer",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    fail(`verified artifact entry could not be read: ${packagePath}`);
  }
  return Buffer.from(result.stdout ?? []);
}

function materializeArtifactPackage(
  artifactPath,
  stagingDirectory,
  artifactManifest,
) {
  const packageDirectory = join(
    stagingDirectory,
    RUNTIME_DIRECTORY,
    PACKAGE_DIRECTORY,
  );
  mkdirSync(packageDirectory, { recursive: true, mode: 0o700 });
  for (const entry of artifactManifest.package_files) {
    if (!safeManifestPackagePath(entry.path)) {
      fail("verified artifact manifest contains an unsafe package path");
    }
    const bytes = readTarEntry(artifactPath, entry.path);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      fail(`verified artifact entry changed while installing: ${entry.path}`);
    }
    const target = join(packageDirectory, ...entry.path.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeExclusive(target, bytes, 0o600);
  }
}

export function installOrganizationAdminEdgeRelease(
  { artifactDirectory, expectedArtifactSha256, installRoot },
  dependencies = {},
) {
  const artifactRoot = normalizedAbsolutePath(
    artifactDirectory,
    "artifact directory",
  );
  const root = normalizedAbsolutePath(installRoot, "install root");
  const expectedSha256 = assertSafeSha256(
    expectedArtifactSha256,
    "expected artifact SHA-256",
  );
  const verification = verifyOrganizationAdminEdgeArtifact({
    artifactDir: artifactRoot,
  });
  if (!verification.ok) fail("artifact verification failed");
  if (verification.artifact_manifest.artifact.sha256 !== expectedSha256) {
    fail("artifact SHA-256 does not match the out-of-band expectation");
  }

  ensurePrivateDirectory(root, "install root");
  const releasesRoot = join(root, "releases");
  ensurePrivateDirectory(releasesRoot, "releases root");
  const releaseId = releaseIdFor(verification.artifact_manifest);
  const releaseDirectory = join(releasesRoot, releaseId);
  if (existsSync(releaseDirectory)) {
    waitForSealedPublishedRelease(releaseDirectory);
    return verifyOrganizationAdminEdgeInstalledRelease({
      releaseDirectory,
      expectedArtifactSha256: expectedSha256,
    });
  }

  const stagingDirectory = mkdtempSync(
    join(releasesRoot, `.staging-${releaseId}-`),
  );
  chmodSync(stagingDirectory, 0o700);
  let publishedByThisCall = false;
  try {
    const retainedArtifactDirectory = join(
      stagingDirectory,
      ARTIFACT_DIRECTORY,
    );
    copyRetainedArtifact(
      artifactRoot,
      retainedArtifactDirectory,
      verification.artifact_manifest,
    );
    const retainedVerification = verifyOrganizationAdminEdgeArtifact({
      artifactDir: retainedArtifactDirectory,
    });
    if (
      !retainedVerification.ok ||
      retainedVerification.artifact_manifest_sha256 !==
        verification.artifact_manifest_sha256 ||
      retainedVerification.artifact_manifest.artifact.sha256 !== expectedSha256
    ) {
      fail("retained artifact changed while staging");
    }
    materializeArtifactPackage(
      retainedVerification.artifact_path,
      stagingDirectory,
      retainedVerification.artifact_manifest,
    );
    const packageDirectory = join(
      stagingDirectory,
      RUNTIME_DIRECTORY,
      PACKAGE_DIRECTORY,
    );
    assertExtractedPackage(packageDirectory, verification.artifact_manifest);

    const deployed = deployedManifestFor(
      verification.artifact_manifest,
      verification.artifact_manifest_sha256,
      releaseId,
    );
    writeExclusive(
      join(stagingDirectory, DEPLOYED_MANIFEST),
      `${JSON.stringify(deployed, null, 2)}\n`,
      0o600,
    );
    sealTree(stagingDirectory);
    fsyncSealedTree(stagingDirectory);
    // Descendants are already sealed. Keep only the private staging root at
    // 0700 through rename because macOS may reject renaming a 0500 directory.
    // At the final path, 0700 means publication is still in progress; readers
    // wait for the immediate 0500 seal and never verify the intermediate state.
    try {
      renameSync(stagingDirectory, releaseDirectory);
      publishedByThisCall = true;
      const sealPublishedReleaseRoot =
        dependencies.sealPublishedReleaseRoot ??
        ((path) => {
          chmodSync(path, 0o500);
          fsyncDirectory(path);
        });
      sealPublishedReleaseRoot(releaseDirectory);
    } catch (error) {
      if (
        (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") &&
        existsSync(releaseDirectory)
      ) {
        makeStagingTreeRemovable(stagingDirectory, releasesRoot);
        rmSync(stagingDirectory, { recursive: true, force: true });
        waitForSealedPublishedRelease(releaseDirectory);
        const concurrentlyInstalled =
          verifyOrganizationAdminEdgeInstalledRelease({
            releaseDirectory,
            expectedArtifactSha256: expectedSha256,
          });
        fsyncDirectory(releasesRoot);
        return Object.freeze({ ...concurrentlyInstalled, changed: false });
      }
      throw error;
    }
    fsyncDirectory(releasesRoot);
    const installed = verifyOrganizationAdminEdgeInstalledRelease({
      releaseDirectory,
      expectedArtifactSha256: expectedSha256,
    });
    return Object.freeze({ ...installed, changed: true });
  } catch (error) {
    if (existsSync(stagingDirectory)) {
      makeStagingTreeRemovable(stagingDirectory, releasesRoot);
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
    if (publishedByThisCall && existsSync(releaseDirectory)) {
      removeFailedPublishedRelease(releaseDirectory, releasesRoot, releaseId);
    }
    throw error;
  }
}

function parseArgs(argv) {
  const accepted = new Set([
    "--artifact-dir",
    "--expected-artifact-sha256",
    "--install-root",
  ]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      !accepted.has(flag) ||
      value === undefined ||
      value.startsWith("--") ||
      args[flag] !== undefined
    ) {
      fail("invalid arguments");
    }
    args[flag] = value;
  }
  if (
    argv.length !== accepted.size * 2 ||
    [...accepted].some((flag) => args[flag] === undefined)
  ) {
    fail(
      "required arguments are --artifact-dir, --expected-artifact-sha256, and --install-root",
    );
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = installOrganizationAdminEdgeRelease({
    artifactDirectory: args["--artifact-dir"],
    expectedArtifactSha256: args["--expected-artifact-sha256"],
    installRoot: args["--install-root"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
