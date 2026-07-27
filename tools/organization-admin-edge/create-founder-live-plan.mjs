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
import { basename, dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS } from "./validate-founder-live-evidence.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN =
  /^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*-[a-f0-9]{12}-[a-f0-9]{12}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_PATH_CHARACTERS = 4096;

function fail(message) {
  throw new Error(`admin-edge-create-founder-live-plan: ${message}`);
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

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readStableFile(
  path,
  label,
  {
    maximumBytes = MAX_INPUT_BYTES,
    privateFile = true,
    executable = false,
  } = {},
) {
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    realpathSync(path) !== path ||
    state.nlink !== 1 ||
    state.size > maximumBytes ||
    (uid !== undefined && state.uid !== uid && privateFile) ||
    (privateFile && (state.mode & 0o777) !== 0o600) ||
    (executable && (state.mode & 0o111) === 0) ||
    (executable && (state.mode & 0o022) !== 0)
  ) {
    fail(`${label} must be a canonical trusted bounded regular file`);
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
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function readStableJson(path, label) {
  const file = readStableFile(path, label);
  try {
    return {
      ...file,
      value: JSON.parse(file.bytes.toString("utf8")),
    };
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function assertPreparation(value) {
  const keys = [
    "schema_version",
    "kind",
    "prepared_at",
    "ok",
    "label",
    "observed_platform",
    "release_id",
    "source_sha",
    "version",
    "artifact_sha256",
    "artifact_manifest_sha256",
    "deployed_tree_sha256",
    "config_path",
    "config_sha256",
    "node_executable_path",
    "preflight_sha256",
    "plist_sha256",
    "node_executable_sha256",
    "preflight_record_path",
    "staged_plist_path",
  ];
  if (
    !hasExactKeys(value, keys) ||
    value.schema_version !== 1 ||
    value.kind !== "echo-organization-admin-edge-launchd-preparation" ||
    value.ok !== true ||
    value.label !== "com.echo.brain.organization-admin-edge.founder-live" ||
    !hasExactKeys(value.observed_platform, ["os", "architecture", "node"]) ||
    value.observed_platform.os !== "darwin" ||
    value.observed_platform.architecture !== "arm64" ||
    value.observed_platform.node !== "22.22.1" ||
    !isIsoUtc(value.prepared_at) ||
    typeof value.source_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.source_sha) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(value.version) ||
    typeof value.release_id !== "string" ||
    !RELEASE_ID_PATTERN.test(value.release_id) ||
    typeof value.config_path !== "string" ||
    normalizedAbsolutePath(value.config_path, "prepared config path") !==
      value.config_path ||
    typeof value.node_executable_path !== "string" ||
    normalizedAbsolutePath(
      value.node_executable_path,
      "prepared Node executable path",
    ) !== value.node_executable_path ||
    ![
      "artifact_sha256",
      "artifact_manifest_sha256",
      "deployed_tree_sha256",
      "config_sha256",
      "preflight_sha256",
      "plist_sha256",
      "node_executable_sha256",
    ].every(
      (key) =>
        typeof value[key] === "string" && SHA256_PATTERN.test(value[key]),
    ) ||
    typeof value.preflight_record_path !== "string" ||
    !isAbsolute(value.preflight_record_path) ||
    typeof value.staged_plist_path !== "string" ||
    !isAbsolute(value.staged_plist_path)
  ) {
    fail("preparation record does not match the fixed preparation contract");
  }
}

function assertPreparationArtifacts(preparation, preparationPath, label) {
  const attemptDirectory = dirname(preparationPath);
  assertPrivateCurrentUserDirectory(attemptDirectory, `${label} directory`);
  if (
    basename(preparationPath) !== "preparation.json" ||
    dirname(preparation.preflight_record_path) !== attemptDirectory ||
    basename(preparation.preflight_record_path) !== "preflight.json" ||
    dirname(preparation.staged_plist_path) !== attemptDirectory ||
    basename(preparation.staged_plist_path) !== "launch-agent.plist"
  ) {
    fail(`${label} files must share one exact private attempt directory`);
  }

  const preflight = readStableJson(
    preparation.preflight_record_path,
    `${label} preflight`,
  );
  if (
    preflight.sha256 !== preparation.preflight_sha256 ||
    !hasExactKeys(preflight.value.listener, ["host", "port"]) ||
    preflight.value.schema_version !== 1 ||
    preflight.value.kind !== "echo-organization-admin-edge-preflight" ||
    preflight.value.ok !== true ||
    preflight.value.release_platform_qualified !== true ||
    preflight.value.listener.host !== "127.0.0.1" ||
    preflight.value.listener.port !== 8443 ||
    preflight.value.failed_check !== undefined
  ) {
    fail(`${label} preflight bytes do not prove the fixed loopback listener`);
  }
  const plist = readStableFile(
    preparation.staged_plist_path,
    `${label} staged plist`,
  );
  if (plist.sha256 !== preparation.plist_sha256) {
    fail(`${label} staged plist differs from its preparation record`);
  }
  const config = readStableFile(preparation.config_path, `${label} config`);
  if (config.sha256 !== preparation.config_sha256) {
    fail(`${label} config differs from its preparation record`);
  }
  const nodeExecutable = readStableFile(
    preparation.node_executable_path,
    `${label} Node executable`,
    {
      maximumBytes: MAX_EXECUTABLE_BYTES,
      privateFile: false,
      executable: true,
    },
  );
  if (nodeExecutable.sha256 !== preparation.node_executable_sha256) {
    fail(`${label} Node executable differs from its preparation record`);
  }
}

function assertNetworkPolicy(value) {
  const keys = [
    "schema_version",
    "kind",
    "provider",
    "policy_id",
    "applied_at",
    "ingress_mode",
    "public_scope",
    "public_port",
    "forward_host",
    "forward_port",
    "tls_mode",
    "procedure_sha256",
  ];
  if (
    !hasExactKeys(value, keys) ||
    value.schema_version !== 1 ||
    value.kind !== "echo-organization-admin-edge-vpn-ingress-policy" ||
    typeof value.provider !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.provider) ||
    typeof value.policy_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.policy_id) ||
    !isIsoUtc(value.applied_at) ||
    value.ingress_mode !== "vpn-l4-forward-to-loopback" ||
    value.public_scope !== "private-vpn-only" ||
    value.public_port !== 443 ||
    value.forward_host !== "127.0.0.1" ||
    value.forward_port !== 8443 ||
    value.tls_mode !== "passthrough" ||
    typeof value.procedure_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.procedure_sha256)
  ) {
    fail("network policy does not match the fixed VPN ingress contract");
  }
}

function assertProcedureArgv(value, label) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    value.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length < 1 ||
        argument.length > 512 ||
        /[\0\r\n]/.test(argument),
    ) ||
    !isAbsolute(value[0]) ||
    resolve(value[0]) !== value[0]
  ) {
    fail(`${label} must be bounded argv with one absolute executable`);
  }
}

function assertNetworkProcedure(value, policy) {
  const keys = [
    "schema_version",
    "kind",
    "provider",
    "policy_id",
    "executable_sha256",
    "apply_argv",
    "disable_argv",
    "verify_enabled_argv",
    "verify_disabled_argv",
  ];
  if (
    !hasExactKeys(value, keys) ||
    value.schema_version !== 1 ||
    value.kind !== "echo-organization-admin-edge-vpn-ingress-procedure" ||
    value.provider !== policy.provider ||
    value.policy_id !== policy.policy_id ||
    typeof value.executable_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.executable_sha256)
  ) {
    fail("network procedure does not match the fixed VPN policy identity");
  }
  const commandKeys = [
    "apply_argv",
    "disable_argv",
    "verify_enabled_argv",
    "verify_disabled_argv",
  ];
  for (const key of commandKeys) {
    assertProcedureArgv(value[key], `network procedure ${key}`);
  }
  const executablePath = value.apply_argv[0];
  if (commandKeys.some((key) => value[key][0] !== executablePath)) {
    fail("network procedure commands must use one exact executable");
  }
  const executable = readStableFile(
    executablePath,
    "network procedure executable",
    {
      maximumBytes: MAX_EXECUTABLE_BYTES,
      privateFile: false,
      executable: true,
    },
  );
  if (executable.sha256 !== value.executable_sha256) {
    fail("network procedure executable differs from its declared digest");
  }
}

function assertRecoveryIdentity(
  recoveryMode,
  preparation,
  preparationSha256,
  restoredPreparation,
  restoredPreparationSha256,
) {
  if (
    recoveryMode !== "disable_restore_same_candidate" &&
    recoveryMode !== "rollback_previous_release"
  ) {
    fail("recovery mode is invalid");
  }
  if (
    recoveryMode === "disable_restore_same_candidate" &&
    (restoredPreparationSha256 !== preparationSha256 ||
      restoredPreparation.release_id !== preparation.release_id ||
      restoredPreparation.artifact_sha256 !== preparation.artifact_sha256 ||
      restoredPreparation.plist_sha256 !== preparation.plist_sha256)
  ) {
    fail(
      "same-candidate recovery must use the exact candidate preparation record",
    );
  }
  if (
    recoveryMode === "rollback_previous_release" &&
    (restoredPreparationSha256 === preparationSha256 ||
      restoredPreparation.release_id === preparation.release_id ||
      restoredPreparation.artifact_sha256 === preparation.artifact_sha256 ||
      restoredPreparation.plist_sha256 === preparation.plist_sha256)
  ) {
    fail(
      "previous-release recovery must use a distinct re-verified preparation record",
    );
  }
}

function writeExclusivePrivate(path, bytes) {
  assertPrivateCurrentUserDirectory(dirname(path), "plan output parent");
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o400,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o400);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

export function deriveOrganizationAdminEdgeFounderLivePlan(input) {
  const preparationPath = normalizedAbsolutePath(
    input.preparationPath,
    "preparation record",
  );
  const networkPolicyPath = normalizedAbsolutePath(
    input.networkPolicyPath,
    "network policy",
  );
  const networkProcedurePath = normalizedAbsolutePath(
    input.networkProcedurePath,
    "network procedure",
  );
  const restoredPreparationPath = normalizedAbsolutePath(
    input.restoredPreparationPath,
    "restored preparation record",
  );
  const preparationRecord = readStableJson(
    preparationPath,
    "preparation record",
  );
  const networkPolicyRecord = readStableJson(
    networkPolicyPath,
    "network policy",
  );
  const networkProcedureRecord = readStableJson(
    networkProcedurePath,
    "network procedure",
  );
  const restoredPreparationRecord = readStableJson(
    restoredPreparationPath,
    "restored preparation record",
  );
  assertPreparation(preparationRecord.value);
  assertNetworkPolicy(networkPolicyRecord.value);
  assertNetworkProcedure(
    networkProcedureRecord.value,
    networkPolicyRecord.value,
  );
  if (
    networkProcedureRecord.sha256 !== networkPolicyRecord.value.procedure_sha256
  ) {
    fail("network procedure digest differs from the applied policy");
  }
  assertPreparation(restoredPreparationRecord.value);
  assertPreparationArtifacts(
    preparationRecord.value,
    preparationPath,
    "candidate preparation",
  );
  assertPreparationArtifacts(
    restoredPreparationRecord.value,
    restoredPreparationPath,
    "restored preparation",
  );
  assertRecoveryIdentity(
    input.recoveryMode,
    preparationRecord.value,
    preparationRecord.sha256,
    restoredPreparationRecord.value,
    restoredPreparationRecord.sha256,
  );

  const now = input.now ?? new Date().toISOString();
  if (
    !isIsoUtc(now) ||
    Date.parse(now) < Date.parse(preparationRecord.value.prepared_at) ||
    Date.parse(now) < Date.parse(networkPolicyRecord.value.applied_at)
  ) {
    fail("plan creation time must follow preparation and policy application");
  }

  const plan = {
    schema_version: 1,
    kind: "echo-organization-admin-edge-founder-live-plan",
    created_at: now,
    preparation_record_sha256: preparationRecord.sha256,
    preflight_record_sha256: preparationRecord.value.preflight_sha256,
    observed_platform: preparationRecord.value.observed_platform,
    candidate: {
      source_sha: preparationRecord.value.source_sha,
      version: preparationRecord.value.version,
      artifact_sha256: preparationRecord.value.artifact_sha256,
      artifact_manifest_sha256:
        preparationRecord.value.artifact_manifest_sha256,
      deployed_tree_sha256: preparationRecord.value.deployed_tree_sha256,
      release_id: preparationRecord.value.release_id,
      config_sha256: preparationRecord.value.config_sha256,
      supervisor_plist_sha256: preparationRecord.value.plist_sha256,
      node_executable_sha256: preparationRecord.value.node_executable_sha256,
    },
    deployment: {
      ingress_mode: networkPolicyRecord.value.ingress_mode,
      network_policy_sha256: networkPolicyRecord.sha256,
      network_procedure_sha256: networkProcedureRecord.sha256,
      public_port: networkPolicyRecord.value.public_port,
      edge_listener_host: networkPolicyRecord.value.forward_host,
      edge_listener_port: networkPolicyRecord.value.forward_port,
      supervisor: "launchd",
      service_label: preparationRecord.value.label,
    },
    regime: {
      name: "founder-controlled-live",
      planned_run_count: 1,
      check_ids: [...ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS],
    },
    recovery: {
      mode: input.recoveryMode,
      restored_preparation_record_sha256: restoredPreparationRecord.sha256,
      restored_release_id: restoredPreparationRecord.value.release_id,
      restored_artifact_sha256: restoredPreparationRecord.value.artifact_sha256,
      restored_plist_sha256: restoredPreparationRecord.value.plist_sha256,
    },
  };
  return Object.freeze(plan);
}

export function createOrganizationAdminEdgeFounderLivePlan(input) {
  const outputPath = normalizedAbsolutePath(input.outputPath, "plan output");
  const plan = deriveOrganizationAdminEdgeFounderLivePlan(input);
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeExclusivePrivate(outputPath, bytes);
  return Object.freeze({
    ok: true,
    plan,
    plan_path: outputPath,
    plan_sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function parseArgs(argv) {
  const accepted = new Set([
    "--preparation",
    "--restored-preparation",
    "--network-policy",
    "--network-procedure",
    "--recovery-mode",
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
      "required arguments are --preparation, --restored-preparation, --network-policy, --network-procedure, --recovery-mode, and --output",
    );
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = createOrganizationAdminEdgeFounderLivePlan({
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
    recoveryMode: args["--recovery-mode"],
    outputPath: normalizedAbsolutePath(args["--output"], "plan output"),
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: result.ok,
      plan_path: result.plan_path,
      plan_sha256: result.plan_sha256,
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
