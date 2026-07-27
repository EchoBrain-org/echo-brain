#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
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
import { verifyOrganizationAdminEdgeInstalledRelease } from "./install-release.mjs";

export const ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL =
  "com.echo.brain.organization-admin-edge.founder-live";
export const ORGANIZATION_ADMIN_EDGE_RELEASE_PLATFORM = Object.freeze({
  os: "darwin",
  architecture: "arm64",
  node: "22.22.1",
});

const MAX_PREFLIGHT_OUTPUT_BYTES = 64 * 1024;
const MAX_PATH_CHARACTERS = 4096;
const PREFLIGHT_TIMEOUT_MS = 20_000;

function fail(message) {
  throw new Error(`admin-edge-prepare-launchd: ${message}`);
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

function assertCanonicalRegularFile(path, label, executable = false) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(path) !== path ||
    (executable && (state.mode & 0o111) === 0)
  ) {
    fail(
      `${label} must be a canonical${executable ? " executable" : ""} regular file`,
    );
  }
}

function assertCanonicalDirectory(path, label) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path
  ) {
    fail(`${label} must be a canonical directory`);
  }
}

function assertPrivateCurrentUserDirectory(path, label) {
  assertCanonicalDirectory(path, label);
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o777) !== 0o700
  ) {
    fail(`${label} must be current-user-owned with mode 0700`);
  }
}

function assertSafeLogPath(path, label) {
  if (!existsSync(path)) return;
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(path) !== path ||
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    fail(`${label} must be a canonical current-user mode-0600 regular file`);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertStrictDescendant(path, root, label) {
  const pathFromRoot = relative(root, path);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    fail(`${label} must remain below the private state directory`);
  }
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderOrganizationAdminEdgeLaunchAgent(input) {
  const nodePath = normalizedAbsolutePath(input.nodePath, "Node path");
  const edgeCliPath = normalizedAbsolutePath(
    input.edgeCliPath,
    "administrator edge CLI path",
  );
  const configPath = normalizedAbsolutePath(input.configPath, "config path");
  const workingDirectory = normalizedAbsolutePath(
    input.workingDirectory,
    "working directory",
  );
  const stdoutPath = normalizedAbsolutePath(
    input.stdoutPath,
    "standard-output log path",
  );
  const stderrPath = normalizedAbsolutePath(
    input.stderrPath,
    "standard-error log path",
  );
  if (stdoutPath === stderrPath) {
    fail("standard-output and standard-error log paths must be distinct");
  }
  if (
    basename(edgeCliPath) !== "echo-organization-admin-edge.mjs" ||
    basename(dirname(edgeCliPath)) !== "bin"
  ) {
    fail(
      "administrator edge CLI must be the exact packaged bin/echo-organization-admin-edge.mjs launcher",
    );
  }

  const arguments_ = [nodePath, edgeCliPath, "serve", "--config", configPath];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...arguments_.map((argument) => `    <string>${xml(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(workingDirectory)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${xml(stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(stderrPath)}</string>`,
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ExitTimeOut</key>",
    "  <integer>15</integer>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function assertOrganizationAdminEdgeReleasePlatform(observed = {}) {
  const platform = observed.platform ?? process.platform;
  const architecture = observed.architecture ?? process.arch;
  const node = observed.node ?? process.versions.node;
  const expected = ORGANIZATION_ADMIN_EDGE_RELEASE_PLATFORM;
  if (
    platform !== expected.os ||
    architecture !== expected.architecture ||
    node !== expected.node
  ) {
    fail(
      `Founder Live preparation requires ${expected.os}/${expected.architecture} Node ${expected.node}; observed ${platform}/${architecture} Node ${node}`,
    );
  }
}

export function parseSuccessfulPreflight(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("packaged preflight did not emit JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schema_version !== 1 ||
    parsed.kind !== "echo-organization-admin-edge-preflight" ||
    parsed.ok !== true ||
    parsed.release_platform_qualified !== true ||
    parsed.listener?.host !== "127.0.0.1" ||
    parsed.listener?.port !== 8443 ||
    parsed.failed_check !== undefined
  ) {
    fail("packaged preflight did not produce a qualifying success record");
  }
  return parsed;
}

function runPackagedPreflight({ edgeCliPath, configPath }) {
  const result = spawnSync(
    process.execPath,
    [edgeCliPath, "preflight", "--config", configPath],
    {
      encoding: "utf8",
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      maxBuffer: MAX_PREFLIGHT_OUTPUT_BYTES,
      timeout: PREFLIGHT_TIMEOUT_MS,
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (Buffer.byteLength(stdout, "utf8") > MAX_PREFLIGHT_OUTPUT_BYTES) {
    fail("packaged preflight output exceeded its evidence bound");
  }
  if (result.error !== undefined && result.error.code === "ETIMEDOUT") {
    fail("packaged preflight timed out");
  }
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
  };
}

function writeExclusivePrivate(path, content) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const state = fstatSync(descriptor);
    if (
      !state.isFile() ||
      state.size !== Buffer.byteLength(content, "utf8") ||
      (state.mode & 0o777) !== 0o600
    ) {
      fail("private output verification failed");
    }
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function sha256FileStable(path, label) {
  const before = lstatSync(path);
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.length !== after.size
  ) {
    fail(`${label} changed while hashing`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function prepareOrganizationAdminEdgeLaunchd(input, dependencies = {}) {
  const observedPlatform = {
    platform: dependencies.observedPlatform?.platform ?? process.platform,
    architecture: dependencies.observedPlatform?.architecture ?? process.arch,
    node: dependencies.observedPlatform?.node ?? process.versions.node,
  };
  assertOrganizationAdminEdgeReleasePlatform(observedPlatform);

  const nodePath = realpathSync(process.execPath);
  const releaseDirectory = normalizedAbsolutePath(
    input.releaseDirectory,
    "release directory",
  );
  const expectedArtifactSha256 =
    typeof input.expectedArtifactSha256 === "string"
      ? input.expectedArtifactSha256
      : "";
  const installedRelease = (
    dependencies.verifyInstalledRelease ??
    verifyOrganizationAdminEdgeInstalledRelease
  )({
    releaseDirectory,
    expectedArtifactSha256,
  });
  if (
    installedRelease?.ok !== true ||
    installedRelease.release_directory !== releaseDirectory ||
    typeof installedRelease.edge_cli_path !== "string" ||
    typeof installedRelease.release_id !== "string" ||
    installedRelease.artifact?.target !== "organization-admin-edge" ||
    installedRelease.artifact?.package !==
      "@echo-brain/organization-admin-edge" ||
    !/^[a-f0-9]{40}$/.test(installedRelease.artifact?.source_sha ?? "") ||
    typeof installedRelease.artifact?.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(installedRelease.artifact?.sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(installedRelease.artifact?.manifest_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(installedRelease.deployed_manifest_sha256 ?? "")
  ) {
    fail("installed release verification did not return the expected identity");
  }
  const edgeCliPath = normalizedAbsolutePath(
    installedRelease.edge_cli_path,
    "administrator edge CLI path",
  );
  const configPath = normalizedAbsolutePath(input.configPath, "config path");
  const stateDirectory = normalizedAbsolutePath(
    input.stateDirectory,
    "state directory",
  );
  const logsDirectory = join(stateDirectory, "logs");
  const preparationsDirectory = join(stateDirectory, "preparations");
  const stdoutPath = join(logsDirectory, "admin-edge.stdout.log");
  const stderrPath = join(logsDirectory, "admin-edge.stderr.log");

  assertCanonicalRegularFile(nodePath, "Node path", true);
  assertCanonicalRegularFile(edgeCliPath, "administrator edge CLI path", true);
  assertCanonicalRegularFile(configPath, "config path");
  assertPrivateCurrentUserDirectory(stateDirectory, "state directory");
  assertPrivateCurrentUserDirectory(logsDirectory, "logs directory");
  assertPrivateCurrentUserDirectory(
    preparationsDirectory,
    "preparations directory",
  );
  assertSafeLogPath(stdoutPath, "standard-output log");
  assertSafeLogPath(stderrPath, "standard-error log");

  const attemptDirectory = realpathSync(
    mkdtempSync(join(preparationsDirectory, "attempt-")),
  );
  chmodSync(attemptDirectory, 0o700);
  fsyncDirectory(preparationsDirectory);
  assertPrivateCurrentUserDirectory(attemptDirectory, "attempt directory");
  assertStrictDescendant(attemptDirectory, stateDirectory, "attempt directory");
  const preflightOutputPath = join(attemptDirectory, "preflight.json");
  const plistOutputPath = join(attemptDirectory, "launch-agent.plist");
  const preparationOutputPath = join(attemptDirectory, "preparation.json");

  const configSha256Before = sha256FileStable(configPath, "config");
  const plist = renderOrganizationAdminEdgeLaunchAgent({
    nodePath,
    edgeCliPath,
    configPath,
    workingDirectory: stateDirectory,
    stdoutPath,
    stderrPath,
  });
  const runPreflight = dependencies.runPreflight ?? runPackagedPreflight;
  const preflight = runPreflight({ edgeCliPath, configPath });
  if (
    typeof preflight.stdout !== "string" ||
    Buffer.byteLength(preflight.stdout, "utf8") > MAX_PREFLIGHT_OUTPUT_BYTES
  ) {
    fail("packaged preflight output exceeded its evidence bound");
  }
  writeExclusivePrivate(preflightOutputPath, preflight.stdout);
  if (preflight.status !== 0 || preflight.stderr !== "") {
    fail(
      `packaged preflight failed; evidence was retained at ${preflightOutputPath} and the LaunchAgent was not rendered`,
    );
  }
  parseSuccessfulPreflight(preflight.stdout);
  const configSha256After = sha256FileStable(configPath, "config");
  if (configSha256After !== configSha256Before) {
    fail("config changed while preparing the LaunchAgent");
  }
  writeExclusivePrivate(plistOutputPath, plist);

  const preflightSha256 = createHash("sha256")
    .update(preflight.stdout)
    .digest("hex");
  const plistSha256 = createHash("sha256").update(plist).digest("hex");
  const nodeExecutableSha256 = sha256FileStable(nodePath, "Node executable");
  const preparation = {
    schema_version: 1,
    kind: "echo-organization-admin-edge-launchd-preparation",
    prepared_at: new Date().toISOString(),
    ok: true,
    label: ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL,
    observed_platform: {
      os: observedPlatform.platform,
      architecture: observedPlatform.architecture,
      node: observedPlatform.node,
    },
    release_id: installedRelease.release_id,
    source_sha: installedRelease.artifact.source_sha,
    version: installedRelease.artifact.version,
    artifact_sha256: installedRelease.artifact.sha256,
    artifact_manifest_sha256: installedRelease.artifact.manifest_sha256,
    deployed_tree_sha256: installedRelease.deployed_manifest_sha256,
    config_path: configPath,
    config_sha256: configSha256After,
    node_executable_path: nodePath,
    preflight_sha256: preflightSha256,
    plist_sha256: plistSha256,
    node_executable_sha256: nodeExecutableSha256,
    preflight_record_path: preflightOutputPath,
    staged_plist_path: plistOutputPath,
  };
  const preparationBytes = `${JSON.stringify(preparation, null, 2)}\n`;
  writeExclusivePrivate(preparationOutputPath, preparationBytes);
  return Object.freeze({
    ...preparation,
    preparation_record_path: preparationOutputPath,
    preparation_record_sha256: createHash("sha256")
      .update(preparationBytes)
      .digest("hex"),
  });
}

function parseArgs(argv) {
  const accepted = new Set([
    "--release-dir",
    "--expected-artifact-sha256",
    "--config",
    "--state-dir",
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
      "required arguments are --release-dir, --expected-artifact-sha256, --config, and --state-dir",
    );
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = prepareOrganizationAdminEdgeLaunchd({
    releaseDirectory: args["--release-dir"],
    expectedArtifactSha256: args["--expected-artifact-sha256"],
    configPath: args["--config"],
    stateDirectory: args["--state-dir"],
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
