#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertOrganizationAdminEdgeReleasePlatform,
  ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL,
} from "./prepare-launchd.mjs";
import { deriveOrganizationAdminEdgeFounderLivePlan } from "./create-founder-live-plan.mjs";
import { verifyOrganizationAdminEdgeInstalledRelease } from "./install-release.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_PATH_CHARACTERS = 4096;

function fail(message) {
  throw new Error(`admin-edge-verify-founder-live-activation: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function isIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = new Date(milliseconds).toISOString();
  return value === normalized || value === normalized.replace(".000Z", "Z");
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

function assertPrivateCurrentUserDirectory(path, label) {
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    realpathSync(path) !== path ||
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o777) !== 0o700
  ) {
    fail(`${label} must be a canonical current-user mode-0700 directory`);
  }
}

function readStableJson(path, label, expectedModes = [0o400, 0o600]) {
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(path) !== path ||
    state.nlink !== 1 ||
    state.size > MAX_RECORD_BYTES ||
    (uid !== undefined && state.uid !== uid) ||
    !expectedModes.includes(state.mode & 0o777)
  ) {
    fail(`${label} must be a canonical private bounded regular file`);
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
    const after = fstatSync(descriptor);
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      fail(`${label} changed while reading`);
    }
    try {
      return {
        value: JSON.parse(bytes.toString("utf8")),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      fail(`${label} is not valid JSON`);
    }
  } finally {
    closeSync(descriptor);
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

function writeExclusivePrivate(path, bytes) {
  assertPrivateCurrentUserDirectory(
    dirname(path),
    "activation verification output parent",
  );
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function assertCommitment(commitment, planSha256, now) {
  if (
    !hasExactKeys(commitment, [
      "schema_version",
      "kind",
      "plan_sha256",
      "committed_at",
      "channel",
      "receipt_id",
    ]) ||
    commitment.schema_version !== 1 ||
    commitment.kind !==
      "echo-organization-admin-edge-founder-live-plan-commitment" ||
    commitment.plan_sha256 !== planSha256 ||
    !isIsoUtc(commitment.committed_at) ||
    Date.parse(commitment.committed_at) > Date.parse(now) ||
    typeof commitment.channel !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(commitment.channel) ||
    typeof commitment.receipt_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(commitment.receipt_id)
  ) {
    fail("independent plan commitment is invalid");
  }
}

export function verifyOrganizationAdminEdgeFounderLiveActivation(
  input,
  dependencies = {},
) {
  const observedPlatform = {
    platform: dependencies.observedPlatform?.platform ?? process.platform,
    architecture: dependencies.observedPlatform?.architecture ?? process.arch,
    node: dependencies.observedPlatform?.node ?? process.versions.node,
  };
  assertOrganizationAdminEdgeReleasePlatform(observedPlatform);
  const planPath = normalizedAbsolutePath(input.planPath, "plan");
  const commitmentPath = normalizedAbsolutePath(
    input.commitmentPath,
    "plan commitment",
  );
  const preparationPath = normalizedAbsolutePath(
    input.preparationPath,
    "preparation record",
  );
  const releaseDirectory = normalizedAbsolutePath(
    input.releaseDirectory,
    "release directory",
  );
  const outputPath = normalizedAbsolutePath(
    input.outputPath,
    "activation verification output",
  );
  const planRecord = readStableJson(planPath, "Founder Live plan", [0o400]);
  const commitmentRecord = readStableJson(
    commitmentPath,
    "Founder Live plan commitment",
  );
  const preparationRecord = readStableJson(
    preparationPath,
    "preparation record",
    [0o600],
  );
  const now = dependencies.now ?? new Date().toISOString();
  if (!isIsoUtc(now)) fail("activation verification time is invalid");
  assertCommitment(commitmentRecord.value, planRecord.sha256, now);
  if (
    !isPlainObject(planRecord.value) ||
    planRecord.value.kind !==
      "echo-organization-admin-edge-founder-live-plan" ||
    !isIsoUtc(planRecord.value.created_at) ||
    Date.parse(commitmentRecord.value.committed_at) <
      Date.parse(planRecord.value.created_at) ||
    preparationRecord.value.node_executable_path !==
      realpathSync(process.execPath)
  ) {
    fail("plan, commitment chronology, or exact Node path is invalid");
  }

  const expectedPlan = deriveOrganizationAdminEdgeFounderLivePlan({
    preparationPath,
    restoredPreparationPath: normalizedAbsolutePath(
      input.restoredPreparationPath,
      "restored preparation record",
    ),
    networkPolicyPath: normalizedAbsolutePath(
      input.networkPolicyPath,
      "network policy",
    ),
    networkProcedurePath: normalizedAbsolutePath(
      input.networkProcedurePath,
      "network procedure",
    ),
    recoveryMode: planRecord.value.recovery?.mode,
    now: planRecord.value.created_at,
  });
  if (!isDeepStrictEqual(planRecord.value, expectedPlan)) {
    fail(
      "current activation inputs differ from the independently committed plan",
    );
  }

  const installedRelease = (
    dependencies.verifyInstalledRelease ??
    verifyOrganizationAdminEdgeInstalledRelease
  )({
    releaseDirectory,
    expectedArtifactSha256: planRecord.value.candidate?.artifact_sha256,
  });
  if (
    installedRelease?.ok !== true ||
    installedRelease.release_directory !== releaseDirectory ||
    installedRelease.release_id !== planRecord.value.candidate?.release_id ||
    installedRelease.artifact?.source_sha !==
      planRecord.value.candidate?.source_sha ||
    installedRelease.artifact?.version !==
      planRecord.value.candidate?.version ||
    installedRelease.artifact?.sha256 !==
      planRecord.value.candidate?.artifact_sha256 ||
    installedRelease.artifact?.manifest_sha256 !==
      planRecord.value.candidate?.artifact_manifest_sha256 ||
    installedRelease.deployed_manifest_sha256 !==
      planRecord.value.candidate?.deployed_tree_sha256
  ) {
    fail("sealed release differs from the independently committed plan");
  }

  const record = {
    schema_version: 1,
    kind: "echo-organization-admin-edge-founder-live-activation-verification",
    ok: true,
    checked_at: now,
    plan_sha256: planRecord.sha256,
    commitment_receipt_sha256: commitmentRecord.sha256,
    release_id: installedRelease.release_id,
    artifact_sha256: installedRelease.artifact.sha256,
    config_sha256: planRecord.value.candidate.config_sha256,
    node_executable_sha256: planRecord.value.candidate.node_executable_sha256,
    supervisor_plist_sha256: planRecord.value.candidate.supervisor_plist_sha256,
    network_policy_sha256: planRecord.value.deployment.network_policy_sha256,
    network_procedure_sha256:
      planRecord.value.deployment.network_procedure_sha256,
    service_label: ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL,
  };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  writeExclusivePrivate(outputPath, bytes);
  return Object.freeze({
    ...record,
    record_path: outputPath,
    record_sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function parseArgs(argv) {
  const accepted = new Set([
    "--plan",
    "--commitment",
    "--preparation",
    "--restored-preparation",
    "--network-policy",
    "--network-procedure",
    "--release-dir",
    "--output",
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
      "required arguments are --plan, --commitment, --preparation, --restored-preparation, --network-policy, --network-procedure, --release-dir, and --output",
    );
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyOrganizationAdminEdgeFounderLiveActivation({
    planPath: normalizedAbsolutePath(args["--plan"], "plan"),
    commitmentPath: normalizedAbsolutePath(
      args["--commitment"],
      "plan commitment",
    ),
    preparationPath: normalizedAbsolutePath(
      args["--preparation"],
      "preparation record",
    ),
    restoredPreparationPath: normalizedAbsolutePath(
      args["--restored-preparation"],
      "restored preparation record",
    ),
    networkPolicyPath: normalizedAbsolutePath(
      args["--network-policy"],
      "network policy",
    ),
    networkProcedurePath: normalizedAbsolutePath(
      args["--network-procedure"],
      "network procedure",
    ),
    releaseDirectory: normalizedAbsolutePath(
      args["--release-dir"],
      "release directory",
    ),
    outputPath: normalizedAbsolutePath(args["--output"], "output"),
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: result.ok,
      record_path: result.record_path,
      record_sha256: result.record_sha256,
    })}\n`,
  );
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
