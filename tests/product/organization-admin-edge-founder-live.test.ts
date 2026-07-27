import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  installOrganizationAdminEdgeRelease,
  verifyOrganizationAdminEdgeInstalledRelease,
} from "../../tools/organization-admin-edge/install-release.mjs";
import {
  assertOrganizationAdminEdgeReleasePlatform,
  ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL,
  parseSuccessfulPreflight,
  prepareOrganizationAdminEdgeLaunchd,
  renderOrganizationAdminEdgeLaunchAgent,
} from "../../tools/organization-admin-edge/prepare-launchd.mjs";
import {
  ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS,
  validateOrganizationAdminEdgeFounderLiveEvidence,
} from "../../tools/organization-admin-edge/validate-founder-live-evidence.mjs";
import { spawnSanitizedChildSync } from "../../src/product/spawn-sanitized-child.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const temporaryRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "echo-admin-edge-founder-live-")),
);

interface BuiltCandidate {
  readonly artifactDirectory: string;
  readonly artifactSha256: string;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSanitizedChildSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function checkedRun(
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  const result = run(command, args, cwd);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

function linkBuildDependencies(fixture: string): void {
  const installed = join(REPO_ROOT, "node_modules");
  const target = join(fixture, "node_modules");
  mkdirSync(target);
  for (const entry of readdirSync(installed, { withFileTypes: true })) {
    if (
      entry.name === "@echo-brain" ||
      entry.name === ".bin" ||
      entry.name === ".package-lock.json"
    ) {
      continue;
    }
    symlinkSync(
      join(installed, entry.name),
      join(target, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
}

function repositoryPaths(): string[] {
  return checkedRun(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    REPO_ROOT,
  )
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((path) => {
      if (
        path.includes("\\") ||
        posix.isAbsolute(path) ||
        posix.normalize(path) !== path ||
        path === ".." ||
        path.startsWith("../")
      ) {
        throw new Error(`unsafe repository fixture path: ${path}`);
      }
      return path;
    });
}

function overlayCurrentWorktree(fixture: string): void {
  for (const path of repositoryPaths()) {
    const source = join(REPO_ROOT, path);
    const destination = join(fixture, path);
    if (!existsSync(source)) {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    const state = lstatSync(source);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    if (state.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), destination);
    } else if (state.isFile()) {
      cpSync(source, destination, { force: true, preserveTimestamps: true });
      chmodSync(destination, state.mode & 0o777);
    } else {
      throw new Error(`unsupported repository fixture entry: ${path}`);
    }
  }
}

function buildCandidate(): BuiltCandidate {
  const fixture = join(temporaryRoot, "source");
  checkedRun(
    "git",
    ["clone", "--quiet", "--no-hardlinks", REPO_ROOT, fixture],
    temporaryRoot,
  );
  overlayCurrentWorktree(fixture);
  checkedRun("git", ["add", "-A"], fixture);
  checkedRun(
    "git",
    [
      "-c",
      "user.name=ECHO Founder Live Test",
      "-c",
      "user.email=founder-live-test@echo.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: materialize current Founder Live candidate",
    ],
    fixture,
  );
  linkBuildDependencies(fixture);
  const sha = checkedRun("git", ["rev-parse", "HEAD"], fixture).trim();
  const artifactDirectory = join(temporaryRoot, "candidate");
  const output = checkedRun(
    process.execPath,
    [
      join(fixture, "tools/organization-admin-edge/build-artifact.mjs"),
      "--version",
      "0.1.0-founder-live.test",
      "--source-sha",
      sha,
      "--out-dir",
      artifactDirectory,
    ],
    fixture,
  );
  const built = JSON.parse(output) as { sha256: string };
  return { artifactDirectory, artifactSha256: built.sha256 };
}

let builtCandidate: BuiltCandidate | undefined;
function candidate(): BuiltCandidate {
  builtCandidate ??= buildCandidate();
  return builtCandidate;
}

function preflightRecord(): string {
  return `${JSON.stringify({
    schema_version: 1,
    kind: "echo-organization-admin-edge-preflight",
    ok: true,
    release_platform_qualified: true,
    listener: { host: "127.0.0.1", port: 8443 },
    public_origin: "https://admin.echo.test",
    employee_authority_base_url: "https://authority.echo.test",
    authority_origin: "http://127.0.0.1:39479",
    allowed_admin_client_count: 1,
    checked_at: "2026-07-27T18:00:00.000Z",
    server_certificate_not_before: "2026-07-27T00:00:00.000Z",
    server_certificate_not_after: "2026-10-27T00:00:00.000Z",
    client_ca_certificate_count: 1,
  })}\n`;
}

function evidence(status: "not_run" | "pass" | "fail" = "not_run") {
  const digest =
    status === "pass"
      ? "a".repeat(64)
      : status === "fail"
        ? "b".repeat(64)
        : null;
  const candidateIdentity = {
    source_sha: "a".repeat(40),
    version: "0.1.0-founder-live.1",
    artifact_sha256: "b".repeat(64),
    artifact_manifest_sha256: "c".repeat(64),
    deployed_tree_sha256: "d".repeat(64),
    release_id: `0.1.0-founder-live.1-${"a".repeat(12)}-${"b".repeat(12)}`,
    config_sha256: "e".repeat(64),
    supervisor_plist_sha256: "1".repeat(64),
    node_executable_sha256: "2".repeat(64),
  };
  const deploymentIdentity = {
    ingress_mode: "vpn-l4-forward-to-loopback",
    network_policy_sha256: status === "pass" ? "3".repeat(64) : null,
    network_procedure_sha256: status === "pass" ? "4".repeat(64) : null,
    public_port: 443,
    edge_listener_host: "127.0.0.1",
    edge_listener_port: 8443,
    supervisor: "launchd",
    service_label: ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL,
  };
  const report = {
    schema_version: 1,
    kind: "echo-organization-admin-edge-founder-live-evidence",
    recorded_at: "2026-07-27T18:04:00.000Z",
    started_at: status === "pass" ? "2026-07-27T18:01:00.000Z" : null,
    completed_at: status === "pass" ? "2026-07-27T18:03:00.000Z" : null,
    plan: null as null | {
      record_sha256: string;
      created_at: string;
      committed_at: string;
      commitment_receipt_sha256: string;
      planned_run_count: number;
      completed_run_count: number;
    },
    candidate: candidateIdentity,
    observed_platform: {
      os: "darwin",
      architecture: "arm64",
      node: "22.22.1",
    },
    deployment: deploymentIdentity,
    preflight: {
      ok: status === "pass",
      release_platform_qualified: status === "pass",
      record_sha256: status === "pass" ? "f".repeat(64) : null,
    },
    acceptance: Object.fromEntries(
      ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS.map((id, index) => [
        id,
        {
          status,
          evidence_sha256: digest,
          observed_at:
            status === "pass" || status === "fail"
              ? new Date(
                  Date.parse("2026-07-27T18:01:00.000Z") + (index + 1) * 1_000,
                ).toISOString()
              : null,
        },
      ]),
    ),
    recovery: {
      mode: status === "pass" ? "disable_restore_same_candidate" : null,
      disable_status: status,
      rollback_preflight_status: status,
      restore_status: status,
      service_restored: status === "pass",
      restored_preparation_record_sha256:
        status === "pass" ? "5".repeat(64) : null,
      restored_release_id:
        status === "pass" ? candidateIdentity.release_id : null,
      restored_artifact_sha256:
        status === "pass" ? candidateIdentity.artifact_sha256 : null,
      restored_plist_sha256:
        status === "pass" ? candidateIdentity.supervisor_plist_sha256 : null,
    },
    failure_codes: status === "fail" ? ["supervisor_failure"] : [],
    known_limitations: [
      "authority_development_file_signer",
      "certificate_lifecycle_manual",
      "phase5_physical_gate_open",
      "founder_pilot_only",
    ],
    maturity: status === "pass" ? "FOUNDER LIVE" : "DEV",
    result:
      status === "pass" ? "pass" : status === "fail" ? "fail" : "incomplete",
  };
  if (status === "pass") {
    const plan = {
      schema_version: 1,
      kind: "echo-organization-admin-edge-founder-live-plan",
      created_at: "2026-07-27T18:00:00.000Z",
      preparation_record_sha256: "5".repeat(64),
      preflight_record_sha256: "f".repeat(64),
      observed_platform: {
        os: "darwin",
        architecture: "arm64",
        node: "22.22.1",
      },
      candidate: candidateIdentity,
      deployment: deploymentIdentity,
      regime: {
        name: "founder-controlled-live",
        planned_run_count: 1,
        check_ids: [...ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS],
      },
      recovery: {
        mode: "disable_restore_same_candidate",
        restored_preparation_record_sha256: "5".repeat(64),
        restored_release_id: candidateIdentity.release_id,
        restored_artifact_sha256: candidateIdentity.artifact_sha256,
        restored_plist_sha256: candidateIdentity.supervisor_plist_sha256,
      },
    };
    const planSha256 = createHash("sha256")
      .update(`${JSON.stringify(plan, null, 2)}\n`)
      .digest("hex");
    const commitment = {
      schema_version: 1,
      kind: "echo-organization-admin-edge-founder-live-plan-commitment",
      plan_sha256: planSha256,
      committed_at: "2026-07-27T18:00:30.000Z",
      channel: "test-append-only-channel",
      receipt_id: "receipt/founder-live-test",
    };
    const commitmentSha256 = createHash("sha256")
      .update(`${JSON.stringify(commitment, null, 2)}\n`)
      .digest("hex");
    report.plan = {
      record_sha256: planSha256,
      created_at: plan.created_at,
      committed_at: commitment.committed_at,
      commitment_receipt_sha256: commitmentSha256,
      planned_run_count: 1,
      completed_run_count: 1,
    };
    return {
      report,
      planContext: {
        plan,
        sha256: planSha256,
        commitment,
        commitmentSha256,
      },
    };
  }
  return { report, planContext: null };
}

afterAll(() => {
  function makeWritable(path: string): void {
    const state = lstatSync(path);
    if (state.isSymbolicLink()) return;
    if (state.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) {
        makeWritable(join(path, entry));
      }
    } else if (state.isFile()) {
      chmodSync(path, 0o600);
    }
  }
  makeWritable(temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("organization administrator edge immutable Founder Live release", () => {
  it("requires the out-of-band artifact hash and installs one sealed idempotent release", () => {
    const build = candidate();
    const installParent = join(temporaryRoot, "install-parent");
    mkdirSync(installParent, { mode: 0o700 });
    const installRoot = join(installParent, "admin-edge");

    expect(() =>
      installOrganizationAdminEdgeRelease({
        artifactDirectory: build.artifactDirectory,
        expectedArtifactSha256: "0".repeat(64),
        installRoot,
      }),
    ).toThrow(/out-of-band expectation/);
    expect(existsSync(installRoot)).toBe(false);

    const installed = installOrganizationAdminEdgeRelease({
      artifactDirectory: build.artifactDirectory,
      expectedArtifactSha256: build.artifactSha256,
      installRoot,
    });
    expect(installed).toMatchObject({
      ok: true,
      changed: true,
      artifact: { sha256: build.artifactSha256 },
    });
    expect(installed.edge_cli_path).toBe(
      join(
        installed.release_directory,
        "runtime/package/bin/echo-organization-admin-edge.mjs",
      ),
    );
    expect(lstatSync(installed.release_directory).mode & 0o777).toBe(0o500);
    expect(lstatSync(installed.edge_cli_path).mode & 0o777).toBe(0o500);

    const repeated = installOrganizationAdminEdgeRelease({
      artifactDirectory: build.artifactDirectory,
      expectedArtifactSha256: build.artifactSha256,
      installRoot,
    });
    expect(repeated).toMatchObject({
      ok: true,
      changed: false,
      release_id: installed.release_id,
      deployed_manifest_sha256: installed.deployed_manifest_sha256,
    });
  }, 300_000);

  it("detects a changed installed file or sealed mode", () => {
    const build = candidate();
    const installParent = join(temporaryRoot, "tamper-parent");
    mkdirSync(installParent, { mode: 0o700 });
    const installed = installOrganizationAdminEdgeRelease({
      artifactDirectory: build.artifactDirectory,
      expectedArtifactSha256: build.artifactSha256,
      installRoot: join(installParent, "admin-edge"),
    });
    chmodSync(installed.edge_cli_path, 0o700);
    expect(() =>
      verifyOrganizationAdminEdgeInstalledRelease({
        releaseDirectory: installed.release_directory,
        expectedArtifactSha256: build.artifactSha256,
      }),
    ).toThrow(/mode changed/);
  }, 300_000);
});

describe("organization administrator edge LaunchAgent preparation", () => {
  it("renders only the exact serve command and escapes plist paths", () => {
    const plist = renderOrganizationAdminEdgeLaunchAgent({
      nodePath: "/opt/echo & node/bin/node",
      edgeCliPath: "/opt/echo & edge/bin/echo-organization-admin-edge.mjs",
      configPath: "/Users/echo/config/admin-edge.json",
      workingDirectory: "/Users/echo/state",
      stdoutPath: "/Users/echo/state/logs/stdout.log",
      stderrPath: "/Users/echo/state/logs/stderr.log",
    });
    expect(plist).toContain(ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL);
    expect(plist).toContain("/opt/echo &amp; node/bin/node");
    expect(plist).toContain(
      "/opt/echo &amp; edge/bin/echo-organization-admin-edge.mjs",
    );
    expect(plist).toContain("<string>serve</string>");
    expect(plist).not.toContain("preflight");
    expect(plist).not.toContain("acknowledge-unsupported-host");
    expect(plist).not.toContain("EnvironmentVariables");
    expect(plist).toContain("<key>Umask</key>");
    expect(plist).toContain("<integer>63</integer>");
  });

  it("runs the exact installed candidate preflight before writing a private plist", () => {
    const build = candidate();
    const installParent = join(temporaryRoot, "prepare-install-parent");
    mkdirSync(installParent, { mode: 0o700 });
    const installed = installOrganizationAdminEdgeRelease({
      artifactDirectory: build.artifactDirectory,
      expectedArtifactSha256: build.artifactSha256,
      installRoot: join(installParent, "admin-edge"),
    });
    const privateRoot = join(temporaryRoot, "prepare-private");
    const stateDirectory = join(privateRoot, "state");
    const logsDirectory = join(stateDirectory, "logs");
    const preparationsDirectory = join(stateDirectory, "preparations");
    mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(preparationsDirectory, { mode: 0o700 });
    chmodSync(privateRoot, 0o700);
    chmodSync(stateDirectory, 0o700);
    chmodSync(logsDirectory, 0o700);
    const configPath = join(privateRoot, "admin-edge.json");
    writeFileSync(configPath, '{"private_refs_only":true}\n', {
      mode: 0o600,
    });
    const observedCalls: unknown[] = [];

    const result = prepareOrganizationAdminEdgeLaunchd(
      {
        releaseDirectory: installed.release_directory,
        expectedArtifactSha256: build.artifactSha256,
        configPath,
        stateDirectory,
      },
      {
        observedPlatform: {
          platform: "darwin",
          architecture: "arm64",
          node: "22.22.1",
        },
        runPreflight: (input: unknown) => {
          observedCalls.push(input);
          return { status: 0, stdout: preflightRecord(), stderr: "" };
        },
      },
    );
    expect(observedCalls).toEqual([
      {
        edgeCliPath: installed.edge_cli_path,
        configPath,
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      release_id: installed.release_id,
      artifact_sha256: build.artifactSha256,
    });
    expect(result.node_executable_sha256).toMatch(/^[a-f0-9]{64}$/);
    const preflightOutputPath = result.preflight_record_path;
    const plistOutputPath = result.staged_plist_path;
    expect(dirname(preflightOutputPath)).toBe(dirname(plistOutputPath));
    expect(dirname(dirname(preflightOutputPath))).toBe(preparationsDirectory);
    expect(lstatSync(preflightOutputPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(plistOutputPath).mode & 0o777).toBe(0o600);
    const plist = readFileSync(plistOutputPath, "utf8");
    expect(plist).toContain(installed.edge_cli_path);
    expect(plist).toContain(configPath);
    expect(plist).not.toContain("acknowledge-unsupported-host");
    expect(readFileSync(configPath, "utf8")).toBe(
      '{"private_refs_only":true}\n',
    );
  }, 300_000);

  it("retains a failed preflight record but never renders the service", () => {
    const root = join(temporaryRoot, "failed-prepare");
    const stateDirectory = join(root, "state");
    const logsDirectory = join(stateDirectory, "logs");
    const preparationsDirectory = join(stateDirectory, "preparations");
    mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(preparationsDirectory, { mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(stateDirectory, 0o700);
    chmodSync(logsDirectory, 0o700);
    const configPath = join(root, "config.json");
    const cliPath = join(root, "bin", "echo-organization-admin-edge.mjs");
    mkdirSync(dirname(cliPath), { mode: 0o700 });
    writeFileSync(cliPath, "#!/usr/bin/env node\n", { mode: 0o700 });
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    expect(() =>
      prepareOrganizationAdminEdgeLaunchd(
        {
          releaseDirectory: "/release",
          expectedArtifactSha256: "a".repeat(64),
          configPath,
          stateDirectory,
        },
        {
          observedPlatform: {
            platform: "darwin",
            architecture: "arm64",
            node: "22.22.1",
          },
          verifyInstalledRelease: () => ({
            ok: true,
            changed: false,
            release_id: "0.1.0-founder-live.1-aaaaaaaaaaaa-bbbbbbbbbbbb",
            release_directory: "/release",
            package_directory: root,
            edge_cli_path: cliPath,
            artifact: {
              target: "organization-admin-edge",
              package: "@echo-brain/organization-admin-edge",
              source_sha: "a".repeat(40),
              version: "0.1.0-founder-live.1",
              sha256: "a".repeat(64),
              manifest_sha256: "b".repeat(64),
            },
            deployed_manifest_sha256: "b".repeat(64),
          }),
          runPreflight: () => ({
            status: 1,
            stdout: `${JSON.stringify({
              schema_version: 1,
              kind: "echo-organization-admin-edge-preflight",
              ok: false,
              release_platform_qualified: true,
              failed_check: "runtime_material",
            })}\n`,
            stderr: "",
          }),
        },
      ),
    ).toThrow(/packaged preflight failed/);
    const [failedAttempt] = readdirSync(preparationsDirectory);
    const preflightOutputPath = join(
      preparationsDirectory,
      failedAttempt,
      "preflight.json",
    );
    const plistOutputPath = join(
      preparationsDirectory,
      failedAttempt,
      "launch-agent.plist",
    );
    expect(existsSync(preflightOutputPath)).toBe(true);
    expect(existsSync(plistOutputPath)).toBe(false);

    expect(() =>
      prepareOrganizationAdminEdgeLaunchd(
        {
          releaseDirectory: "/release",
          expectedArtifactSha256: "a".repeat(64),
          configPath,
          stateDirectory,
        },
        {
          observedPlatform: {
            platform: "darwin",
            architecture: "arm64",
            node: "22.22.1",
          },
          verifyInstalledRelease: () => ({
            ok: true,
            changed: false,
            release_id: "0.1.0-founder-live.1-aaaaaaaaaaaa-bbbbbbbbbbbb",
            release_directory: "/release",
            package_directory: root,
            edge_cli_path: cliPath,
            artifact: {
              target: "organization-admin-edge",
              package: "@echo-brain/organization-admin-edge",
              source_sha: "a".repeat(40),
              version: "0.1.0-founder-live.1",
              sha256: "a".repeat(64),
              manifest_sha256: "b".repeat(64),
            },
            deployed_manifest_sha256: "b".repeat(64),
          }),
          runPreflight: () => ({
            status: 1,
            stdout: `${JSON.stringify({
              schema_version: 1,
              kind: "echo-organization-admin-edge-preflight",
              ok: false,
              release_platform_qualified: true,
              failed_check: "runtime_material",
            })}\n`,
            stderr: "",
          }),
        },
      ),
    ).toThrow(/packaged preflight failed/);
    expect(readdirSync(preparationsDirectory)).toHaveLength(2);
  });

  it("rejects unsupported platform evidence and non-qualifying preflight JSON", () => {
    expect(() =>
      assertOrganizationAdminEdgeReleasePlatform({
        platform: "darwin",
        architecture: "x64",
        node: "22.22.1",
      }),
    ).toThrow(/requires darwin\/arm64/);
    expect(() =>
      parseSuccessfulPreflight(
        JSON.stringify({
          schema_version: 1,
          kind: "echo-organization-admin-edge-preflight",
          ok: false,
          release_platform_qualified: false,
          failed_check: "release_platform",
        }),
      ),
    ).toThrow(/qualifying success/);
    expect(() =>
      parseSuccessfulPreflight(
        JSON.stringify({
          schema_version: 1,
          kind: "echo-organization-admin-edge-preflight",
          ok: true,
          release_platform_qualified: true,
          listener: { host: "0.0.0.0", port: 8443 },
        }),
      ),
    ).toThrow(/qualifying success/);
  });
});

describe("organization administrator edge Founder Live evidence gate", () => {
  it("accepts a DEV/incomplete draft without overclaiming promotion", () => {
    const draft = evidence();
    expect(
      validateOrganizationAdminEdgeFounderLiveEvidence(draft.report),
    ).toEqual({ ok: true, errors: [] });
  });

  it("promotes only a complete pass and treats declared limitations separately", () => {
    const complete = evidence("pass");
    expect(
      validateOrganizationAdminEdgeFounderLiveEvidence(
        complete.report,
        complete.planContext,
      ),
    ).toEqual({ ok: true, errors: [] });

    const overclaimed = structuredClone(complete.report);
    overclaimed.acceptance.listener_ready.status = "not_run";
    overclaimed.acceptance.listener_ready.evidence_sha256 = null;
    overclaimed.acceptance.listener_ready.observed_at = null;
    const rejected = validateOrganizationAdminEdgeFounderLiveEvidence(
      overclaimed,
      complete.planContext,
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toContain(
      "a passing report requires every planned check within the live run",
    );

    const outOfOrder = structuredClone(complete.report);
    outOfOrder.acceptance.target_preflight.observed_at =
      outOfOrder.acceptance.artifact_verified.observed_at;
    expect(
      validateOrganizationAdminEdgeFounderLiveEvidence(
        outOfOrder,
        complete.planContext,
      ).errors,
    ).toContain(
      "a passing report requires acceptance observations in planned order",
    );

    const hiddenLimitation = structuredClone(complete.report);
    hiddenLimitation.known_limitations =
      hiddenLimitation.known_limitations.filter(
        (value) => value !== "certificate_lifecycle_manual",
      );
    expect(
      validateOrganizationAdminEdgeFounderLiveEvidence(
        hiddenLimitation,
        complete.planContext,
      ).errors,
    ).toContain(
      "a passing report must declare the exact four known limitations",
    );
  });
});
