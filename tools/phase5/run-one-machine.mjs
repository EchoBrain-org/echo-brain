#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  generatePrivateRuntimeToken,
  initializeDevelopmentAuthority,
  reserveLoopbackPort,
  startAuthorityProcess,
} from "./authority-process.mjs";
import {
  adminGet,
  adminPost,
  assertIsolatedPaths,
  assertPrivateStatePermissions,
  corruptClosedOrganizationDatabase,
  runEmployeeProcess,
  scanFilesForKnownSecrets,
} from "./ceremony-support.mjs";
import { assertCeremonyAttestationClosure } from "../lib/module-closure.mjs";
import { installRehearsalArtifact } from "./install-rehearsal-artifact.mjs";
import {
  phase5ProxyClientId,
  startLoopbackAuthenticatedEdge,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from "./loopback-authenticated-edge.mjs";
import {
  createOneMachineRehearsalReport,
  PASSING_CHECK_IDS,
} from "./report.mjs";
import { validateOneMachineRehearsalReport } from "./validate-report.mjs";
import { verifyOrganizationAuthorityArtifact } from "../organization-authority/verify-artifact.mjs";
import {
  ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
} from "@echo-brain/organization-api";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIRECTORY, "../..");
const EMPLOYEE_PACKAGE = "echo-brain";
const AUTHORITY_PACKAGE = "@echo-brain/organization-authority";
const LEASE_TTL_MS = 5 * 60 * 1000;
const REQUEST_MAXIMUM_AGE_MS = 5 * 60 * 1000;
export const CEREMONY_SOURCE_PATHS = Object.freeze([
  "tools/lib/module-closure.mjs",
  "tools/lib/module-references.mjs",
  "tools/product/build-artifact.mjs",
  "tools/product/sync-shrinkwrap.mjs",
  "tools/release/artifact-builder.mjs",
  "tools/release/runtime-shrinkwrap.mjs",
  "tools/organization-authority/build-artifact.mjs",
  "tools/organization-authority/sync-shrinkwrap.mjs",
  "tools/organization-authority/verify-artifact.mjs",
  "tools/phase5/run-one-machine.mjs",
  "tools/phase5/authority-process.mjs",
  "tools/phase5/ceremony-support.mjs",
  "tools/phase5/development-file-installation-signer.mjs",
  "tools/phase5/employee-driver.mjs",
  "tools/phase5/install-rehearsal-artifact.mjs",
  "tools/phase5/loopback-authenticated-edge.mjs",
  "tools/phase5/report.mjs",
  "tools/phase5/validate-report.mjs",
  "release/organization-authority/package.template.json",
  "release/organization-authority/runtime-boundary.v1.json",
  "schemas/phase5/one-machine-rehearsal-report.v1.schema.json",
]);
export const CEREMONY_ENTRY_POINTS = Object.freeze([
  "tools/phase5/run-one-machine.mjs",
  "tools/phase5/employee-driver.mjs",
  "tools/product/build-artifact.mjs",
  "tools/product/sync-shrinkwrap.mjs",
  "tools/organization-authority/build-artifact.mjs",
  "tools/organization-authority/sync-shrinkwrap.mjs",
]);
const CEREMONY_MODULE_EXTENSIONS = [".mjs", ".cjs", ".js", ".mts", ".cts", ".ts"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertKnownSecretsAbsentFromBuffers(buffers, secretValues) {
  const secrets = secretValues.map((value) => Buffer.from(value));
  for (const bytes of buffers) {
    for (const secret of secrets) {
      if (secret.length > 0 && bytes.includes(secret)) {
        throw new Error("known bearer material entered sealed Phase 5 output");
      }
    }
  }
}

function run(command, arguments_, options = {}) {
  const spawnOptions = {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  };
  let result;
  if (command === "git") {
    result = spawnSync("git", arguments_, spawnOptions);
  } else if (command === process.execPath) {
    result = spawnSync(process.execPath, arguments_, spawnOptions);
  } else {
    throw new Error("Phase 5 command is outside the finite dispatcher");
  }
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} failed with code ${String(result.status)}${result.error === undefined ? "" : " before completion"}`,
    );
  }
  return result.stdout;
}

function gitText(arguments_) {
  return run("git", arguments_, { cwd: REPO_ROOT }).trim();
}

function parseArguments(argv) {
  const options = { acknowledgeUnsupportedHost: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--acknowledge-unsupported-host") {
      options.acknowledgeUnsupportedHost = true;
      continue;
    }
    if (!["--version", "--source-sha", "--out-dir"].includes(flag)) {
      throw new Error(`unknown Phase 5 argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    options[flag.slice(2)] = value;
  }
  if (
    !/^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(
      options.version ?? "",
    )
  ) {
    throw new Error("--version must be a valid prerelease version");
  }
  if (!/^[0-9a-f]{40}$/.test(options["source-sha"] ?? "")) {
    throw new Error("--source-sha must be one lowercase full commit SHA");
  }
  if (!isAbsolute(options["out-dir"] ?? "")) {
    throw new Error("--out-dir must be absolute");
  }
  return options;
}

function assertCommittedCeremony(sourceSha) {
  const head = gitText(["rev-parse", "HEAD"]).toLowerCase();
  if (head !== sourceSha) {
    throw new Error("Phase 5 source SHA is not the current HEAD");
  }
  assertCeremonyAttestationClosure({
    projectRoot: REPO_ROOT,
    entryPoints: CEREMONY_ENTRY_POINTS,
    attestedSourcePaths: CEREMONY_SOURCE_PATHS.filter((path) =>
      CEREMONY_MODULE_EXTENSIONS.some((extension) => path.endsWith(extension)),
    ),
  });
  const entries = [];
  for (const path of CEREMONY_SOURCE_PATHS) {
    const local = readFileSync(join(REPO_ROOT, path));
    const committed = run("git", ["show", `${sourceSha}:${path}`], {
      cwd: REPO_ROOT,
      encoding: "buffer",
    });
    if (!Buffer.from(local).equals(Buffer.from(committed))) {
      throw new Error(`Phase 5 ceremony source differs from HEAD: ${path}`);
    }
    entries.push({ path, sha256: sha256(local) });
  }
  return sha256(stableJson(entries));
}

function safeRemoveTemporary(path, parent) {
  const relation = relative(parent, path);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    !basename(path).startsWith(".") ||
    !basename(path).includes(".phase5-")
  ) {
    throw new Error("refusing to remove an unsafe Phase 5 temporary path");
  }
  rmSync(path, { recursive: true, force: true });
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writePrivateJson(path, value) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requireEmployeeSuccess(result, label) {
  if (result?.ok !== true || result.result === undefined) {
    throw new Error(`${label} did not succeed`);
  }
  return result.result;
}

function requireEmployeeFailure(result, errorCode, label) {
  if (result?.ok !== false || result.error_code !== errorCode) {
    throw new Error(`${label} did not fail with ${errorCode}`);
  }
}

function requireId(value, prefix, label) {
  if (
    typeof value !== "string" ||
    !new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    ).test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireProtocolHash(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSequence(decision, sequence, permitted, status, label) {
  if (
    decision.sequence !== sequence ||
    decision.permitted !== permitted ||
    decision.status !== status ||
    !/^sha256:[0-9a-f]{64}$/.test(decision.state_payload_sha256 ?? "")
  ) {
    throw new Error(`${label} returned an unexpected access state`);
  }
  return decision;
}

async function authorityRuntimeSummary(origin, adminToken) {
  const overview = await adminGet({
    origin,
    adminToken,
    path: ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
  });
  const descriptor = await adminGet({
    origin,
    adminToken,
    path: ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  });
  return {
    authority_id: overview.authority_id,
    organization_id: overview.organization_id,
    authority_pin_sha256: overview.authority_pin_sha256,
    descriptor_sha256: sha256(stableJson(descriptor.authority_descriptor)),
    memberships: overview.counts.memberships,
    enrollments: overview.counts.active_installations,
  };
}

async function startEdges({ targetOrigin, proxyToken, runId, faults = {} }) {
  const admin = await startLoopbackAuthenticatedEdge({
    targetOrigin,
    proxyToken,
    clientId: phase5ProxyClientId(`${runId}:admin`),
    role: "admin",
  });
  try {
    const installationA = await startLoopbackAuthenticatedEdge({
      targetOrigin,
      proxyToken,
      clientId: phase5ProxyClientId(`${runId}:installation-a`),
      role: "employee",
      faults: {
        dropEnrollmentResponseOnce: faults.dropEnrollmentResponseOnce === true,
      },
    });
    try {
      const installationB = await startLoopbackAuthenticatedEdge({
        targetOrigin,
        proxyToken,
        clientId: phase5ProxyClientId(`${runId}:installation-b`),
        role: "employee",
        faults: {
          tamperAccessStateResponseOnce:
            faults.tamperAccessStateResponseOnce === true,
        },
      });
      return { admin, installationA, installationB };
    } catch (error) {
      await installationA.close();
      throw error;
    }
  } catch (error) {
    await admin.close();
    throw error;
  }
}

async function closeEdges(edges) {
  if (edges === null) return;
  await Promise.all([
    edges.admin.close(),
    edges.installationA.close(),
    edges.installationB.close(),
  ]);
}

async function proveEdgeBoundary(edges, descriptor) {
  const response = await fetch(
    new URL("/v1/authority-descriptor", edges.installationA.origin),
    {
      headers: {
        [TRUSTED_PROXY_AUTHORIZATION_HEADER]:
          "Echo-Proxy caller-controlled-spoof-value",
        [TRUSTED_PROXY_CLIENT_ID_HEADER]: phase5ProxyClientId("spoofed"),
      },
    },
  );
  const value = await response.json();
  if (
    response.status !== 200 ||
    stableJson(value.authority_descriptor) !== stableJson(descriptor)
  ) {
    throw new Error("employee edge did not overwrite spoofed proxy identity");
  }
  const forbidden = await fetch(
    new URL("/v1/admin/memberships", edges.installationA.origin),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  await forbidden.arrayBuffer();
  if (forbidden.status !== 403) {
    throw new Error("employee edge did not block administrator routes");
  }
  if (
    new Set([
      edges.admin.clientId,
      edges.installationA.clientId,
      edges.installationB.clientId,
    ]).size !== 3
  ) {
    throw new Error("Phase 5 edges do not have distinct identities");
  }
  const securityState = edges.installationA.securityState();
  if (
    securityState.strippedCredentialHeaderCount < 2 ||
    securityState.forwardedRequestCount < 1 ||
    securityState.configuredClientIdentityForwardCount < 1 ||
    securityState.spoofedClientIdentityReplacementCount < 1 ||
    securityState.outboundIdentityMismatchCount !== 0
  ) {
    throw new Error("employee edge did not record credential replacement");
  }
  return securityState;
}

async function provisionEmployee(origin, adminToken, label) {
  const membership = await adminPost({
    origin,
    adminToken,
    path: "/v1/admin/memberships",
    body: {
      command_id: `adm_${randomUUID()}`,
      display_name: `Phase 5 Employee ${label}`,
      membership_type: "employee",
    },
  });
  const membershipId = requireId(
    membership.membership_id,
    "mem",
    `${label} membership ID`,
  );
  const principalId = requireId(
    membership.principal_id,
    "prn",
    `${label} principal ID`,
  );
  const enrollmentGrant = randomBytes(32);
  const enrollmentGrantSha256 = `sha256:${createHash("sha256")
    .update(enrollmentGrant)
    .digest("hex")}`;
  const grant = await adminPost({
    origin,
    adminToken,
    path: `/v1/admin/memberships/${membershipId}/enrollment-grants`,
    body: {
      command_id: `adm_${randomUUID()}`,
      enrollment_grant_sha256: enrollmentGrantSha256,
      lifetime_seconds: 3600,
    },
  });
  if (
    grant.membership_id !== membershipId ||
    grant.principal_id !== principalId ||
    grant.enrollment_grant_sha256 !== enrollmentGrantSha256
  ) {
    throw new Error(`${label} enrollment grant response is invalid`);
  }
  return {
    membershipId,
    principalId,
    grant: enrollmentGrant.toString("base64url"),
  };
}

function employeeInput(runtime, command, origin, onboarding) {
  const base = {
    command,
    package_root: runtime.packageRoot,
    database_path: runtime.databasePath,
    key_directory: runtime.keyDirectory,
    base_url: origin,
  };
  if (command !== "enroll") return base;
  return {
    ...base,
    authority_descriptor: onboarding.authorityDescriptor,
    authority_pin_sha256: onboarding.authorityPin,
    enrollment_grant_base64url: onboarding.grant,
    principal_id: onboarding.principalId,
    membership_id: onboarding.membershipId,
    installation_id: runtime.installationId,
  };
}

function assertBuildIdentity(packageRoot, kind, sourceSha, version) {
  const path =
    kind === "employee"
      ? join(packageRoot, "dist/product/build-identity.v1.json")
      : join(packageRoot, "dist/build-identity.v1.json");
  const identity = readJson(path);
  if (
    identity.source_sha !== sourceSha ||
    (identity.product_version ?? identity.version) !== version ||
    identity.source_kind !== "materialized-commit"
  ) {
    throw new Error(`${kind} packaged build identity is invalid`);
  }
  return sha256(readFileSync(path));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceSha = options["source-sha"];
  const outDir = resolve(options["out-dir"]);
  if (existsSync(outDir)) throw new Error("--out-dir must not already exist");
  if (process.platform !== "darwin" || process.arch !== "x64") {
    throw new Error(
      "this one-machine rehearsal contract is scoped to darwin/x64",
    );
  }
  if (options.acknowledgeUnsupportedHost !== true) {
    throw new Error(
      "--acknowledge-unsupported-host is required because this is not the declared darwin/arm64 release cell",
    );
  }

  const ceremonyDriverSha256 = assertCommittedCeremony(sourceSha);
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${basename(outDir)}.phase5-`));
  chmodSync(temporary, 0o700);
  const previousUmask = process.umask(0o077);
  const startedAt = new Date().toISOString();
  const runId = `p5r_${randomUUID()}`;
  let authority = null;
  let edges = null;
  let promoted = false;
  let retainStaging = false;
  const evidence = {};
  const observe = (id, facts) => {
    if (!PASSING_CHECK_IDS.includes(id) || evidence[id] !== undefined) {
      throw new Error(`invalid or duplicate Phase 5 observation: ${id}`);
    }
    const record = {
      check_id: id,
      observed_at: new Date().toISOString(),
      facts,
    };
    evidence[id] = record;
    return record;
  };

  try {
    process.stderr.write(
      "phase5: building exact employee and authority artifacts\n",
    );
    const artifactsRoot = join(temporary, "artifacts");
    const employeeArtifactRoot = join(artifactsRoot, "employee");
    const authorityArtifactRoot = join(artifactsRoot, "authority");
    run(
      process.execPath,
      [
        "tools/product/build-artifact.mjs",
        "--version",
        options.version,
        "--source-sha",
        sourceSha,
        "--out-dir",
        employeeArtifactRoot,
      ],
      { cwd: REPO_ROOT },
    );
    run(
      process.execPath,
      [
        "tools/organization-authority/build-artifact.mjs",
        "--version",
        options.version,
        "--source-sha",
        sourceSha,
        "--out-dir",
        authorityArtifactRoot,
      ],
      { cwd: REPO_ROOT },
    );
    const authorityVerification = verifyOrganizationAuthorityArtifact({
      artifactDir: authorityArtifactRoot,
    });
    if (!authorityVerification.ok) {
      throw new Error("authority artifact verification failed");
    }

    process.stderr.write(
      "phase5: installing exact artifact bytes into isolated roots\n",
    );
    const npmCache = join(REPO_ROOT, ".npm-cache");
    const installsRoot = join(temporary, "installs");
    const employeeAInstall = installRehearsalArtifact({
      artifactDirectory: employeeArtifactRoot,
      prefix: join(installsRoot, "employee-a"),
      cacheDirectory: npmCache,
      expectedPackage: EMPLOYEE_PACKAGE,
      acknowledgeUnsupportedHost: true,
    });
    const employeeBInstall = installRehearsalArtifact({
      artifactDirectory: employeeArtifactRoot,
      prefix: join(installsRoot, "employee-b"),
      cacheDirectory: npmCache,
      expectedPackage: EMPLOYEE_PACKAGE,
      acknowledgeUnsupportedHost: true,
    });
    const authorityInstall = installRehearsalArtifact({
      artifactDirectory: authorityArtifactRoot,
      prefix: join(installsRoot, "authority"),
      cacheDirectory: npmCache,
      expectedPackage: AUTHORITY_PACKAGE,
      expectedTarget: "organization-authority",
      acknowledgeUnsupportedHost: true,
    });
    const productIdentityHash = assertBuildIdentity(
      employeeAInstall.packageRoot,
      "employee",
      sourceSha,
      options.version,
    );
    const secondProductIdentityHash = assertBuildIdentity(
      employeeBInstall.packageRoot,
      "employee",
      sourceSha,
      options.version,
    );
    const authorityIdentityHash = assertBuildIdentity(
      authorityInstall.packageRoot,
      "authority",
      sourceSha,
      options.version,
    );
    if (productIdentityHash !== secondProductIdentityHash) {
      throw new Error(
        "employee package copies have different build identities",
      );
    }
    if (
      stableJson(employeeAInstall.toolchain) !==
        stableJson(employeeBInstall.toolchain) ||
      stableJson(employeeAInstall.toolchain) !==
        stableJson(authorityInstall.toolchain)
    ) {
      throw new Error("rehearsal installs used different native toolchains");
    }
    observe("P5-ART-001", {
      target: "employee",
      artifact_sha256: employeeAInstall.artifactSha256,
      copy_count: 2,
      install_toolchain: employeeAInstall.toolchain,
    });
    observe("P5-ART-002", {
      target: "organization-authority",
      artifact_sha256: authorityInstall.artifactSha256,
      verifier: "pass",
      install_toolchain: authorityInstall.toolchain,
    });
    if (
      employeeAInstall.sourceSha !== sourceSha ||
      employeeBInstall.sourceSha !== sourceSha ||
      authorityInstall.sourceSha !== sourceSha ||
      employeeAInstall.dependencyLockSha256 !==
        authorityInstall.dependencyLockSha256
    ) {
      throw new Error("artifact source identities differ");
    }
    observe("P5-ART-003", {
      source_sha: sourceSha,
      artifact_count: 2,
      dependency_lock_sha256: employeeAInstall.dependencyLockSha256,
    });
    observe("P5-ART-004", {
      employee_build_identity_sha256: productIdentityHash,
      authority_build_identity_sha256: authorityIdentityHash,
    });

    const privateRoot = join(temporary, "private-state");
    const authorityRoot = privateDirectory(join(privateRoot, "authority"));
    const installationARoot = privateDirectory(
      join(privateRoot, "installation-a"),
    );
    const installationBRoot = privateDirectory(
      join(privateRoot, "installation-b"),
    );
    const divergentRoot = privateDirectory(join(privateRoot, "divergent"));
    const corruptRoot = privateDirectory(join(privateRoot, "corrupt-copy"));
    for (const root of [
      authorityRoot,
      installationARoot,
      installationBRoot,
      divergentRoot,
      corruptRoot,
    ]) {
      privateDirectory(join(root, "keys"));
      privateDirectory(join(root, "home"));
      privateDirectory(join(root, "tmp"));
    }
    assertIsolatedPaths([
      join(installsRoot, "employee-a"),
      join(installsRoot, "employee-b"),
      installationARoot,
      installationBRoot,
    ]);
    observe("P5-ISO-001", {
      install_roots: 2,
      state_roots: 2,
      overlap_count: 0,
      symlink_count: 0,
    });

    const authorityId = `oau_${randomUUID()}`;
    const organizationId = `org_${randomUUID()}`;
    const installationIdA = `ins_${randomUUID()}`;
    const installationIdB = `ins_${randomUUID()}`;
    const divergentInstallationId = `ins_${randomUUID()}`;
    const authorityDatabasePath = join(authorityRoot, "authority.sqlite");
    const authorityKeyDirectory = join(authorityRoot, "keys");
    const adminToken = generatePrivateRuntimeToken();
    const proxyToken = generatePrivateRuntimeToken();
    if (adminToken === proxyToken) throw new Error("runtime tokens collided");
    const authorityBase = {
      packageRoot: authorityInstall.packageRoot,
      authorityId,
      organizationId,
      keyDirectory: authorityKeyDirectory,
      homeDirectory: join(authorityRoot, "home"),
      temporaryDirectory: join(authorityRoot, "tmp"),
    };
    const initialized = await initializeDevelopmentAuthority(authorityBase);
    const authorityPin = requireProtocolHash(
      initialized.authority_pin_sha256,
      "authority pin",
    );
    const authorityDescriptor = initialized.authority_descriptor;
    if (
      authorityDescriptor.authority_id !== authorityId ||
      authorityDescriptor.organization_id !== organizationId
    ) {
      throw new Error("initialized authority identity is inconsistent");
    }
    const authorityPort = await reserveLoopbackPort();
    const authorityServe = {
      ...authorityBase,
      authorityPin,
      databasePath: authorityDatabasePath,
      adminToken,
      trustedProxyToken: proxyToken,
      organizationDisplayName: "Phase 5 One Organization",
      port: authorityPort,
      activeLeaseTtlMs: LEASE_TTL_MS,
      accessRequestMaximumAgeMs: REQUEST_MAXIMUM_AGE_MS,
    };
    authority = await startAuthorityProcess({
      ...authorityServe,
      generation: 1,
    });
    edges = await startEdges({
      targetOrigin: authority.origin,
      proxyToken,
      runId,
      faults: {
        dropEnrollmentResponseOnce: true,
        tamperAccessStateResponseOnce: true,
      },
    });
    const edgeProof = await proveEdgeBoundary(edges, authorityDescriptor);
    observe("P5-EDGE-001", {
      edge_count: 3,
      identity_count: 3,
      stripped_spoofed_credential_header_count:
        edgeProof.strippedCredentialHeaderCount,
      configured_client_identity_forward_count:
        edgeProof.configuredClientIdentityForwardCount,
      spoofed_client_identity_replacement_count:
        edgeProof.spoofedClientIdentityReplacementCount,
      outbound_identity_mismatch_count: edgeProof.outboundIdentityMismatchCount,
      authority_accept_status: 200,
      employee_admin_route_status: 403,
    });

    const onboardingA = await provisionEmployee(
      edges.admin.origin,
      adminToken,
      "A",
    );
    const onboardingB = await provisionEmployee(
      edges.admin.origin,
      adminToken,
      "B",
    );
    Object.assign(onboardingA, { authorityDescriptor, authorityPin });
    Object.assign(onboardingB, { authorityDescriptor, authorityPin });
    const employeeA = {
      packageRoot: employeeAInstall.packageRoot,
      databasePath: join(installationARoot, "echo.sqlite"),
      keyDirectory: join(installationARoot, "keys"),
      installationId: installationIdA,
    };
    const employeeB = {
      packageRoot: employeeBInstall.packageRoot,
      databasePath: join(installationBRoot, "echo.sqlite"),
      keyDirectory: join(installationBRoot, "keys"),
      installationId: installationIdB,
    };
    const divergent = {
      packageRoot: employeeAInstall.packageRoot,
      databasePath: join(divergentRoot, "echo.sqlite"),
      keyDirectory: join(divergentRoot, "keys"),
      installationId: divergentInstallationId,
    };

    process.stderr.write("phase5: exercising enrollment retry and isolation\n");
    const firstA = await runEmployeeProcess(
      employeeInput(
        employeeA,
        "enroll",
        edges.installationA.origin,
        onboardingA,
      ),
      join(installationARoot, "tmp"),
    );
    requireEmployeeFailure(
      firstA,
      "TRANSPORT_FAILED",
      "lost A enrollment response",
    );
    const pendingA = requireEmployeeSuccess(
      await runEmployeeProcess(
        employeeInput(employeeA, "inspect", edges.installationA.origin),
        join(installationARoot, "tmp"),
      ),
      "pending A inspection",
    );
    if (
      pendingA.enrollment_status !== "pending" ||
      pendingA.accepted_sequence !== 0
    ) {
      throw new Error("A did not retain a pending enrollment request");
    }
    const enrolledA = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(
            employeeA,
            "enroll",
            edges.installationA.origin,
            onboardingA,
          ),
          join(installationARoot, "tmp"),
        ),
        "A enrollment retry",
      ),
      1,
      true,
      "active",
      "A enrollment retry",
    );
    const inspectedA = requireEmployeeSuccess(
      await runEmployeeProcess(
        employeeInput(employeeA, "inspect", edges.installationA.origin),
        join(installationARoot, "tmp"),
      ),
      "enrolled A inspection",
    );
    if (
      inspectedA.enrollment_status !== "enrolled" ||
      inspectedA.request_payload_sha256 !== pendingA.request_payload_sha256
    ) {
      throw new Error("A exact enrollment retry changed its retained request");
    }
    if (!edges.installationA.faultState().dropEnrollmentResponseOnce.consumed) {
      throw new Error("A enrollment response-drop fault was not consumed");
    }
    observe("P5-ENR-001", {
      retained_request_payload_sha256: inspectedA.request_payload_sha256,
      accepted_sequence: enrolledA.sequence,
      restart_count: 1,
    });

    const divergentResult = await runEmployeeProcess(
      employeeInput(
        divergent,
        "enroll",
        edges.installationA.origin,
        onboardingA,
      ),
      join(divergentRoot, "tmp"),
    );
    requireEmployeeFailure(
      divergentResult,
      "UNAUTHORIZED",
      "divergent consumed-grant reuse",
    );
    observe("P5-ENR-003", {
      divergent_installation_id: divergentInstallationId,
      rejection_code: "UNAUTHORIZED",
    });

    const enrolledB = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(
            employeeB,
            "enroll",
            edges.installationB.origin,
            onboardingB,
          ),
          join(installationBRoot, "tmp"),
        ),
        "B enrollment",
      ),
      1,
      true,
      "active",
      "B enrollment",
    );
    const inspectedB = requireEmployeeSuccess(
      await runEmployeeProcess(
        employeeInput(employeeB, "inspect", edges.installationB.origin),
        join(installationBRoot, "tmp"),
      ),
      "B inspection",
    );
    observe("P5-ENR-002", {
      request_payload_sha256: inspectedB.request_payload_sha256,
      accepted_sequence: enrolledB.sequence,
    });
    if (
      installationIdA === installationIdB ||
      inspectedA.installation_key_id === inspectedB.installation_key_id ||
      onboardingA.membershipId === onboardingB.membershipId ||
      onboardingA.principalId === onboardingB.principalId
    ) {
      throw new Error("A and B identities are not independent");
    }
    observe("P5-ISO-002", {
      distinct_installation_ids: true,
      distinct_installation_key_ids: true,
      distinct_memberships: true,
      distinct_principals: true,
    });

    process.stderr.write(
      "phase5: exercising signed access-state transitions\n",
    );
    const refreshedA2 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeA, "refresh", edges.installationA.origin),
          join(installationARoot, "tmp"),
        ),
        "A sequence-2 refresh",
      ),
      2,
      true,
      "active",
      "A sequence-2 refresh",
    );
    const tamperedB = await runEmployeeProcess(
      employeeInput(employeeB, "refresh", edges.installationB.origin),
      join(installationBRoot, "tmp"),
    );
    requireEmployeeFailure(
      tamperedB,
      "SIGNED_STATE_REJECTED",
      "B tampered refresh",
    );
    const afterTamperB = requireEmployeeSuccess(
      await runEmployeeProcess(
        employeeInput(employeeB, "inspect", edges.installationB.origin),
        join(installationBRoot, "tmp"),
      ),
      "B post-tamper inspection",
    );
    if (
      afterTamperB.accepted_sequence !== 1 ||
      !edges.installationB.faultState().tamperAccessStateResponseOnce.consumed
    ) {
      throw new Error("B advanced after accepting a tampered signed state");
    }
    observe("P5-ACC-002", {
      previous_sequence: 1,
      retained_sequence: afterTamperB.accepted_sequence,
      rejection_code: "SIGNED_STATE_REJECTED",
    });
    const staleConflictsBefore = edges.installationB.responseCount(
      "POST",
      "/v1/access-leases",
      409,
    );
    const recoveredB2 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeB, "refresh", edges.installationB.origin),
          join(installationBRoot, "tmp"),
        ),
        "B stale-state recovery",
      ),
      2,
      true,
      "active",
      "B stale-state recovery",
    );
    const staleConflictsAfter = edges.installationB.responseCount(
      "POST",
      "/v1/access-leases",
      409,
    );
    if (staleConflictsAfter !== staleConflictsBefore + 1) {
      throw new Error("B stale-state recovery did not traverse HTTP 409");
    }
    observe("P5-ACC-003", {
      previous_sequence: 1,
      recovered_sequence: recoveredB2.sequence,
      observed_authority_status: 409,
      observed_conflict_count: staleConflictsAfter - staleConflictsBefore,
    });
    observe("P5-ACC-001", {
      installation_a_sequence: refreshedA2.sequence,
      installation_b_sequence: recoveredB2.sequence,
      monotonic: true,
    });

    process.stderr.write(
      "phase5: restarting the full local process topology\n",
    );
    const beforeRestart = await authorityRuntimeSummary(
      edges.admin.origin,
      adminToken,
    );
    await closeEdges(edges);
    edges = null;
    await authority.stop();
    authority = null;
    const reinitialized = await initializeDevelopmentAuthority(authorityBase);
    if (
      reinitialized.authority_pin_sha256 !== authorityPin ||
      stableJson(reinitialized.authority_descriptor) !==
        stableJson(authorityDescriptor)
    ) {
      throw new Error("authority identity changed across restart");
    }
    authority = await startAuthorityProcess({
      ...authorityServe,
      generation: 2,
    });
    edges = await startEdges({
      targetOrigin: authority.origin,
      proxyToken,
      runId,
    });
    const afterRestart = await authorityRuntimeSummary(
      edges.admin.origin,
      adminToken,
    );
    if (
      beforeRestart.authority_pin_sha256 !==
        afterRestart.authority_pin_sha256 ||
      beforeRestart.descriptor_sha256 !== afterRestart.descriptor_sha256 ||
      afterRestart.enrollments !== 2 ||
      afterRestart.memberships !== 2
    ) {
      throw new Error("authority state did not persist across restart");
    }
    observe("P5-RST-001", {
      restart_generation: 2,
      membership_count: afterRestart.memberships,
      enrollment_count: afterRestart.enrollments,
      descriptor_sha256: afterRestart.descriptor_sha256,
    });
    const currentA2 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeA, "current", edges.installationA.origin),
          join(installationARoot, "tmp"),
        ),
        "fresh A current access",
      ),
      2,
      true,
      "active",
      "fresh A current access",
    );
    const currentB2 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeB, "current", edges.installationB.origin),
          join(installationBRoot, "tmp"),
        ),
        "fresh B current access",
      ),
      2,
      true,
      "active",
      "fresh B current access",
    );
    observe("P5-RST-002", {
      installation_a_sequence: currentA2.sequence,
      installation_b_sequence: currentB2.sequence,
      fresh_process_count: 2,
    });
    const refreshedA3 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeA, "refresh", edges.installationA.origin),
          join(installationARoot, "tmp"),
        ),
        "A post-restart refresh",
      ),
      3,
      true,
      "active",
      "A post-restart refresh",
    );
    const refreshedB3 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeB, "refresh", edges.installationB.origin),
          join(installationBRoot, "tmp"),
        ),
        "B post-restart refresh",
      ),
      3,
      true,
      "active",
      "B post-restart refresh",
    );
    observe("P5-RST-003", {
      installation_a_sequence: refreshedA3.sequence,
      installation_b_sequence: refreshedB3.sequence,
      restart_generation: 2,
    });

    const corruptDatabasePath = join(corruptRoot, "echo-corrupt.sqlite");
    await corruptClosedOrganizationDatabase({
      source: employeeA.databasePath,
      destination: corruptDatabasePath,
      packageRoot: employeeA.packageRoot,
    });
    const corruptResult = await runEmployeeProcess(
      {
        command: "current",
        package_root: employeeA.packageRoot,
        database_path: corruptDatabasePath,
        key_directory: employeeA.keyDirectory,
        base_url: edges.installationA.origin,
      },
      join(corruptRoot, "tmp"),
    );
    requireEmployeeFailure(
      corruptResult,
      "STATE_CORRUPT",
      "corrupt state copy",
    );
    observe("P5-STO-001", {
      corrupted_copy_rejection_code: "STATE_CORRUPT",
      production_state_untouched: true,
    });

    process.stderr.write(
      "phase5: exercising installation and membership revocation\n",
    );
    const revokedAResponse = await adminPost({
      origin: edges.admin.origin,
      adminToken,
      path: `/v1/admin/installations/${installationIdA}/revocations`,
      body: { reason: "Phase 5 installation revocation rehearsal" },
    });
    if (
      revokedAResponse.installation_id !== installationIdA ||
      revokedAResponse.access_state?.access_state_sequence !== 4
    ) {
      throw new Error("A installation revocation response is invalid");
    }
    const revokedA4 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeA, "refresh", edges.installationA.origin),
          join(installationARoot, "tmp"),
        ),
        "A terminal refresh",
      ),
      4,
      false,
      "revoked",
      "A terminal refresh",
    );
    if (revokedA4.revocation_reason !== "installation_revoked") {
      throw new Error("A received the wrong revocation reason");
    }
    observe("P5-REV-001", {
      installation_id: installationIdA,
      terminal_sequence: revokedA4.sequence,
      reason_code: revokedA4.revocation_reason,
    });
    const restartedRevokedA = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeA, "current", edges.installationA.origin),
          join(installationARoot, "tmp"),
        ),
        "restarted A terminal access",
      ),
      4,
      false,
      "revoked",
      "restarted A terminal access",
    );
    observe("P5-REV-002", {
      terminal_sequence: restartedRevokedA.sequence,
      fresh_process_denied: true,
    });
    const activeB4 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeB, "refresh", edges.installationB.origin),
          join(installationBRoot, "tmp"),
        ),
        "B after A revocation",
      ),
      4,
      true,
      "active",
      "B after A revocation",
    );
    observe("P5-REV-003", {
      installation_a_status: "revoked",
      installation_b_status: activeB4.status,
      installation_b_sequence: activeB4.sequence,
    });
    const revokedMembershipB = await adminPost({
      origin: edges.admin.origin,
      adminToken,
      path: `/v1/admin/memberships/${onboardingB.membershipId}/revocations`,
      body: { reason: "Phase 5 membership revocation rehearsal" },
    });
    if (
      revokedMembershipB.membership?.membership_id !==
        onboardingB.membershipId ||
      revokedMembershipB.membership?.status !== "revoked"
    ) {
      throw new Error("B membership revocation response is invalid");
    }
    const revokedB5 = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeB, "refresh", edges.installationB.origin),
          join(installationBRoot, "tmp"),
        ),
        "B membership terminal refresh",
      ),
      5,
      false,
      "revoked",
      "B membership terminal refresh",
    );
    const restartedRevokedB = requireSequence(
      requireEmployeeSuccess(
        await runEmployeeProcess(
          employeeInput(employeeB, "current", edges.installationB.origin),
          join(installationBRoot, "tmp"),
        ),
        "restarted B terminal access",
      ),
      5,
      false,
      "revoked",
      "restarted B terminal access",
    );
    if (
      revokedB5.revocation_reason !== "membership_revoked" ||
      restartedRevokedB.revocation_reason !== "membership_revoked"
    ) {
      throw new Error("B received the wrong membership revocation reason");
    }
    observe("P5-REV-004", {
      membership_id: onboardingB.membershipId,
      terminal_sequence: restartedRevokedB.sequence,
      reason_code: restartedRevokedB.revocation_reason,
      fresh_process_denied: true,
    });

    await closeEdges(edges);
    edges = null;
    await authority.stop();
    authority = null;

    process.stderr.write(
      "phase5: validating private state and sealed evidence\n",
    );
    const permissionRoots = [
      authorityRoot,
      installationARoot,
      installationBRoot,
      divergentRoot,
      corruptRoot,
    ];
    const permissionFileCount = assertPrivateStatePermissions(permissionRoots);
    observe("P5-SEC-001", {
      private_root_count: permissionRoots.length,
      private_file_count: permissionFileCount,
      directory_mode: "0700",
      file_mode: "0600",
    });
    const knownSecrets = [
      adminToken,
      proxyToken,
      onboardingA.grant,
      onboardingB.grant,
    ];
    const scannedStateFileCount = scanFilesForKnownSecrets(
      permissionRoots,
      knownSecrets,
    );
    const securityEvidence = {
      check_id: "P5-SEC-002",
      observed_at: new Date().toISOString(),
      facts: {
        known_bearer_state_scan: "pass",
        state_file_count: scannedStateFileCount,
        sealed_output_validation: "required-before-binding",
      },
    };
    const candidateEvidence = {
      ...evidence,
      "P5-SEC-002": securityEvidence,
    };

    if (Object.keys(candidateEvidence).length !== PASSING_CHECK_IDS.length) {
      throw new Error("Phase 5 ceremony did not observe every passing check");
    }
    const completedAt = new Date().toISOString();
    const passingEvidence = Object.fromEntries(
      PASSING_CHECK_IDS.map((id) => [
        id,
        {
          observed_at: candidateEvidence[id].observed_at,
          evidence_sha256: sha256(stableJson(candidateEvidence[id])),
        },
      ]),
    );
    const report = createOneMachineRehearsalReport({
      source_sha: sourceSha,
      run_id: runId,
      started_at: startedAt,
      completed_at: completedAt,
      host: {
        os: process.platform,
        architecture: process.arch,
        node: process.versions.node,
      },
      artifacts: {
        employee: {
          version: employeeAInstall.version,
          source_sha: employeeAInstall.sourceSha,
          artifact_sha256: employeeAInstall.artifactSha256,
          manifest_sha256: employeeAInstall.manifestSha256,
        },
        authority: {
          version: authorityInstall.version,
          source_sha: authorityInstall.sourceSha,
          artifact_sha256: authorityInstall.artifactSha256,
          manifest_sha256: authorityInstall.manifestSha256,
        },
        ceremony_driver: {
          source_sha: sourceSha,
          sha256: ceremonyDriverSha256,
        },
      },
      topology: {
        mode: "one-machine-isolated",
        authority_id: authorityId,
        organization_id: organizationId,
        installations: [
          {
            label: "A",
            principal_id: onboardingA.principalId,
            membership_id: onboardingA.membershipId,
            installation_id: installationIdA,
            installation_key_id: inspectedA.installation_key_id,
          },
          {
            label: "B",
            principal_id: onboardingB.principalId,
            membership_id: onboardingB.membershipId,
            installation_id: installationIdB,
            installation_key_id: inspectedB.installation_key_id,
          },
        ],
      },
      passing_evidence: passingEvidence,
    });
    const validation = validateOneMachineRehearsalReport(report);
    if (!validation.ok) {
      throw new Error("Phase 5 report contract validation failed");
    }

    const evidenceDocument = {
      schema_version: 1,
      kind: "echo-phase5-one-machine-evidence",
      source_sha: sourceSha,
      run_id: runId,
      checks: PASSING_CHECK_IDS.map((id) => candidateEvidence[id]),
    };
    assertKnownSecretsAbsentFromBuffers(
      [
        Buffer.from(JSON.stringify(evidenceDocument)),
        Buffer.from(JSON.stringify(report)),
      ],
      knownSecrets,
    );
    // Bind the security attestation only after the exact candidate evidence
    // and report bytes have passed both the closed report contract and the
    // generated-bearer scan. The report already names this record's hash.
    evidence["P5-SEC-002"] = securityEvidence;

    const evidenceRoot = privateDirectory(join(temporary, "evidence"));
    const evidencePath = join(evidenceRoot, "one-machine-evidence.v1.json");
    const reportPath = join(evidenceRoot, "one-machine-report.v1.json");
    writePrivateJson(evidencePath, evidenceDocument);
    writePrivateJson(reportPath, report);
    const persistedValidation = validateOneMachineRehearsalReport(
      readJson(reportPath),
    );
    if (!persistedValidation.ok) {
      throw new Error("persisted Phase 5 report failed validation");
    }
    assertPrivateStatePermissions([...permissionRoots, evidenceRoot]);
    scanFilesForKnownSecrets([...permissionRoots, evidenceRoot], knownSecrets);

    if (existsSync(outDir)) {
      throw new Error("Phase 5 output directory appeared during the run");
    }
    renameSync(temporary, outDir);
    promoted = true;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        result: report.result,
        phase5_gate: report.phase5_gate,
        run_id: runId,
        passing_checks: PASSING_CHECK_IDS.length,
        blocked_checks: report.checks.filter(
          (check) => check.status === "blocked",
        ).length,
        report: "evidence/one-machine-report.v1.json",
      })}\n`,
    );
  } catch (error) {
    if (error?.code === "OWNED_PROCESS_EXIT_UNCONFIRMED") {
      retainStaging = true;
    }
    throw error;
  } finally {
    let cleanupFailure = false;
    try {
      await closeEdges(edges);
    } catch {
      cleanupFailure = true;
      retainStaging = true;
    }
    try {
      await authority?.stop();
    } catch {
      cleanupFailure = true;
      retainStaging = true;
    }
    process.umask(previousUmask);
    if (!promoted && !retainStaging && existsSync(temporary)) {
      safeRemoveTemporary(temporary, parent);
    }
    if (cleanupFailure) {
      const error = new Error(
        "Phase 5 cleanup could not be confirmed; private staging was retained for quarantine",
      );
      error.code = "OWNED_PROCESS_EXIT_UNCONFIRMED";
      throw error;
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `phase5-one-machine: ${error instanceof Error ? error.message : "rehearsal failed"}\n`,
    );
    process.exitCode = 1;
  }
}
