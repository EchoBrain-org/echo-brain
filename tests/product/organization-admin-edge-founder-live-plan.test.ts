import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";
import { createOrganizationAdminEdgeFounderLivePlan } from "../../tools/organization-admin-edge/create-founder-live-plan.mjs";
import { verifyOrganizationAdminEdgeFounderLiveActivation } from "../../tools/organization-admin-edge/verify-founder-live-activation.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const temporaryRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "echo-admin-edge-founder-plan-")),
);
const releaseId = `0.1.0-founder-live.1-${"a".repeat(12)}-${"b".repeat(12)}`;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createFixture(root: string) {
  mkdirSync(root, { mode: 0o700 });
  const attemptDirectory = join(root, "attempt");
  mkdirSync(attemptDirectory, { mode: 0o700 });
  const configPath = join(root, "config.json");
  const preflightPath = join(attemptDirectory, "preflight.json");
  const plistPath = join(attemptDirectory, "launch-agent.plist");
  const preparationPath = join(attemptDirectory, "preparation.json");
  const networkProcedurePath = join(root, "network-procedure.json");
  const networkPolicyPath = join(root, "network-policy.json");
  const outputPath = join(root, "plan.json");
  const networkExecutablePath = join(root, "provider-cli");
  writeJson(configPath, { private_refs_only: true });
  writeJson(preflightPath, {
    schema_version: 1,
    kind: "echo-organization-admin-edge-preflight",
    ok: true,
    release_platform_qualified: true,
    listener: { host: "127.0.0.1", port: 8443 },
  });
  writeFileSync(plistPath, '<plist version="1.0"/>\n', { mode: 0o600 });
  writeFileSync(networkExecutablePath, "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  const nodePath = realpathSync(process.execPath);
  const preparation = {
    schema_version: 1,
    kind: "echo-organization-admin-edge-launchd-preparation",
    prepared_at: "2026-07-27T18:00:00.000Z",
    ok: true,
    label: "com.echo.brain.organization-admin-edge.founder-live",
    observed_platform: {
      os: "darwin",
      architecture: "arm64",
      node: "22.22.1",
    },
    release_id: releaseId,
    source_sha: "a".repeat(40),
    version: "0.1.0-founder-live.1",
    artifact_sha256: "b".repeat(64),
    artifact_manifest_sha256: "c".repeat(64),
    deployed_tree_sha256: "d".repeat(64),
    config_path: configPath,
    config_sha256: sha256File(configPath),
    node_executable_path: nodePath,
    node_executable_sha256: sha256File(nodePath),
    preflight_sha256: sha256File(preflightPath),
    plist_sha256: sha256File(plistPath),
    preflight_record_path: preflightPath,
    staged_plist_path: plistPath,
  };
  writeJson(preparationPath, preparation);
  const networkProcedure = {
    schema_version: 1,
    kind: "echo-organization-admin-edge-vpn-ingress-procedure",
    provider: "test-vpn",
    policy_id: "founder-live/admin-edge",
    executable_sha256: sha256File(networkExecutablePath),
    apply_argv: [networkExecutablePath, "apply"],
    disable_argv: [networkExecutablePath, "disable"],
    verify_enabled_argv: [networkExecutablePath, "verify-enabled"],
    verify_disabled_argv: [networkExecutablePath, "verify-disabled"],
  };
  writeJson(networkProcedurePath, networkProcedure);
  const networkPolicy = {
    schema_version: 1,
    kind: "echo-organization-admin-edge-vpn-ingress-policy",
    provider: "test-vpn",
    policy_id: "founder-live/admin-edge",
    applied_at: "2026-07-27T18:00:30.000Z",
    ingress_mode: "vpn-l4-forward-to-loopback",
    public_scope: "private-vpn-only",
    public_port: 443,
    forward_host: "127.0.0.1",
    forward_port: 8443,
    tls_mode: "passthrough",
    procedure_sha256: sha256File(networkProcedurePath),
  };
  writeJson(networkPolicyPath, networkPolicy);
  return {
    preparation,
    preparationPath,
    networkPolicy,
    networkPolicyPath,
    networkProcedurePath,
    networkExecutablePath,
    outputPath,
    plistPath,
  };
}

afterAll(() => {
  chmodSync(temporaryRoot, 0o700);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("organization administrator edge Founder Live plan", () => {
  it("writes one read-only plan binding preparation, network, checks, and recovery", () => {
    const fixture = createFixture(join(temporaryRoot, "valid"));
    const result = createOrganizationAdminEdgeFounderLivePlan({
      preparationPath: fixture.preparationPath,
      restoredPreparationPath: fixture.preparationPath,
      networkPolicyPath: fixture.networkPolicyPath,
      networkProcedurePath: fixture.networkProcedurePath,
      recoveryMode: "disable_restore_same_candidate",
      outputPath: fixture.outputPath,
      now: "2026-07-27T18:01:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      plan_path: fixture.outputPath,
      plan: {
        created_at: "2026-07-27T18:01:00.000Z",
        preflight_record_sha256: fixture.preparation.preflight_sha256,
        candidate: {
          release_id: releaseId,
          supervisor_plist_sha256: fixture.preparation.plist_sha256,
          node_executable_sha256: fixture.preparation.node_executable_sha256,
        },
        deployment: {
          ingress_mode: "vpn-l4-forward-to-loopback",
          network_procedure_sha256: sha256File(fixture.networkProcedurePath),
          edge_listener_host: "127.0.0.1",
          edge_listener_port: 8443,
        },
        regime: { planned_run_count: 1 },
        recovery: {
          mode: "disable_restore_same_candidate",
          restored_preparation_record_sha256: sha256File(
            fixture.preparationPath,
          ),
        },
      },
    });
    expect(result.plan_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lstatSync(fixture.outputPath).mode & 0o777).toBe(0o400);
    expect(JSON.parse(readFileSync(fixture.outputPath, "utf8"))).toEqual(
      result.plan,
    );
    expect(() =>
      createOrganizationAdminEdgeFounderLivePlan({
        preparationPath: fixture.preparationPath,
        restoredPreparationPath: fixture.preparationPath,
        networkPolicyPath: fixture.networkPolicyPath,
        networkProcedurePath: fixture.networkProcedurePath,
        recoveryMode: "disable_restore_same_candidate",
        outputPath: fixture.outputPath,
        now: "2026-07-27T18:01:00.000Z",
      }),
    ).toThrow(/EEXIST|file already exists/);
  });

  it("rejects a non-loopback policy and validates the public evidence schema", () => {
    const fixture = createFixture(join(temporaryRoot, "invalid-network"));
    writeJson(fixture.networkPolicyPath, {
      ...fixture.networkPolicy,
      forward_host: "0.0.0.0",
    });
    expect(() =>
      createOrganizationAdminEdgeFounderLivePlan({
        preparationPath: fixture.preparationPath,
        restoredPreparationPath: fixture.preparationPath,
        networkPolicyPath: fixture.networkPolicyPath,
        networkProcedurePath: fixture.networkProcedurePath,
        recoveryMode: "disable_restore_same_candidate",
        outputPath: fixture.outputPath,
        now: "2026-07-27T18:01:00.000Z",
      }),
    ).toThrow(/fixed VPN ingress contract/);

    const schema = JSON.parse(
      readFileSync(
        join(
          REPO_ROOT,
          "schemas/organization-admin-edge-founder-live-evidence.v1.schema.json",
        ),
        "utf8",
      ),
    );
    expect(() =>
      new Ajv2020({ strict: true, allErrors: true }).compile(schema),
    ).not.toThrow();
  });

  it("rejects replaced preparation bytes and a no-op previous-release rollback", () => {
    const tampered = createFixture(join(temporaryRoot, "tampered"));
    writeFileSync(tampered.plistPath, "<plist>changed</plist>\n");
    expect(() =>
      createOrganizationAdminEdgeFounderLivePlan({
        preparationPath: tampered.preparationPath,
        restoredPreparationPath: tampered.preparationPath,
        networkPolicyPath: tampered.networkPolicyPath,
        networkProcedurePath: tampered.networkProcedurePath,
        recoveryMode: "disable_restore_same_candidate",
        outputPath: tampered.outputPath,
        now: "2026-07-27T18:01:00.000Z",
      }),
    ).toThrow(/staged plist differs/);

    const noOp = createFixture(join(temporaryRoot, "no-op-rollback"));
    expect(() =>
      createOrganizationAdminEdgeFounderLivePlan({
        preparationPath: noOp.preparationPath,
        restoredPreparationPath: noOp.preparationPath,
        networkPolicyPath: noOp.networkPolicyPath,
        networkProcedurePath: noOp.networkProcedurePath,
        recoveryMode: "rollback_previous_release",
        outputPath: noOp.outputPath,
        now: "2026-07-27T18:01:00.000Z",
      }),
    ).toThrow(/distinct re-verified preparation/);

    const changedExecutable = createFixture(
      join(temporaryRoot, "changed-network-executable"),
    );
    writeFileSync(
      changedExecutable.networkExecutablePath,
      "#!/bin/sh\nexit 1\n",
      { mode: 0o700 },
    );
    expect(() =>
      createOrganizationAdminEdgeFounderLivePlan({
        preparationPath: changedExecutable.preparationPath,
        restoredPreparationPath: changedExecutable.preparationPath,
        networkPolicyPath: changedExecutable.networkPolicyPath,
        networkProcedurePath: changedExecutable.networkProcedurePath,
        recoveryMode: "disable_restore_same_candidate",
        outputPath: changedExecutable.outputPath,
        now: "2026-07-27T18:01:00.000Z",
      }),
    ).toThrow(/executable differs from its declared digest/);
  });

  it("rechecks every committed input immediately before activation", () => {
    const fixture = createFixture(join(temporaryRoot, "activation"));
    const created = createOrganizationAdminEdgeFounderLivePlan({
      preparationPath: fixture.preparationPath,
      restoredPreparationPath: fixture.preparationPath,
      networkPolicyPath: fixture.networkPolicyPath,
      networkProcedurePath: fixture.networkProcedurePath,
      recoveryMode: "disable_restore_same_candidate",
      outputPath: fixture.outputPath,
      now: "2026-07-27T18:01:00.000Z",
    });
    const commitmentPath = join(
      dirname(fixture.outputPath),
      "plan-commitment.json",
    );
    writeJson(commitmentPath, {
      schema_version: 1,
      kind: "echo-organization-admin-edge-founder-live-plan-commitment",
      plan_sha256: created.plan_sha256,
      committed_at: "2026-07-27T18:01:30.000Z",
      channel: "test-append-only-channel",
      receipt_id: "receipt/activation-test",
    });
    const releaseDirectory = join(dirname(fixture.outputPath), "release");
    mkdirSync(releaseDirectory, { mode: 0o700 });
    const outputPath = join(
      dirname(fixture.outputPath),
      "activation-verification.json",
    );
    const candidate = created.plan.candidate as Record<string, string>;
    const result = verifyOrganizationAdminEdgeFounderLiveActivation(
      {
        planPath: fixture.outputPath,
        commitmentPath,
        preparationPath: fixture.preparationPath,
        restoredPreparationPath: fixture.preparationPath,
        networkPolicyPath: fixture.networkPolicyPath,
        networkProcedurePath: fixture.networkProcedurePath,
        releaseDirectory,
        outputPath,
      },
      {
        now: "2026-07-27T18:02:00.000Z",
        observedPlatform: {
          platform: "darwin",
          architecture: "arm64",
          node: "22.22.1",
        },
        verifyInstalledRelease: () => ({
          ok: true,
          changed: false,
          release_id: candidate.release_id,
          release_directory: releaseDirectory,
          package_directory: join(releaseDirectory, "runtime/package"),
          edge_cli_path: join(
            releaseDirectory,
            "runtime/package/bin/echo-organization-admin-edge.mjs",
          ),
          artifact: {
            target: "organization-admin-edge",
            package: "@echo-brain/organization-admin-edge",
            source_sha: candidate.source_sha,
            version: candidate.version,
            sha256: candidate.artifact_sha256,
            manifest_sha256: candidate.artifact_manifest_sha256,
          },
          deployed_manifest_sha256: candidate.deployed_tree_sha256,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      plan_sha256: created.plan_sha256,
      release_id: candidate.release_id,
      record_path: outputPath,
    });
    expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);

    const tampered = createFixture(join(temporaryRoot, "activation-tampered"));
    const tamperedPlan = createOrganizationAdminEdgeFounderLivePlan({
      preparationPath: tampered.preparationPath,
      restoredPreparationPath: tampered.preparationPath,
      networkPolicyPath: tampered.networkPolicyPath,
      networkProcedurePath: tampered.networkProcedurePath,
      recoveryMode: "disable_restore_same_candidate",
      outputPath: tampered.outputPath,
      now: "2026-07-27T18:01:00.000Z",
    });
    const tamperedCommitment = join(
      dirname(tampered.outputPath),
      "plan-commitment.json",
    );
    writeJson(tamperedCommitment, {
      schema_version: 1,
      kind: "echo-organization-admin-edge-founder-live-plan-commitment",
      plan_sha256: tamperedPlan.plan_sha256,
      committed_at: "2026-07-27T18:01:30.000Z",
      channel: "test-append-only-channel",
      receipt_id: "receipt/tamper-test",
    });
    writeJson(tampered.preparation.config_path, {
      private_refs_only: false,
    });
    const tamperedRelease = join(dirname(tampered.outputPath), "release");
    mkdirSync(tamperedRelease, { mode: 0o700 });
    expect(() =>
      verifyOrganizationAdminEdgeFounderLiveActivation(
        {
          planPath: tampered.outputPath,
          commitmentPath: tamperedCommitment,
          preparationPath: tampered.preparationPath,
          restoredPreparationPath: tampered.preparationPath,
          networkPolicyPath: tampered.networkPolicyPath,
          networkProcedurePath: tampered.networkProcedurePath,
          releaseDirectory: tamperedRelease,
          outputPath: join(
            dirname(tampered.outputPath),
            "activation-verification.json",
          ),
        },
        {
          now: "2026-07-27T18:02:00.000Z",
          observedPlatform: {
            platform: "darwin",
            architecture: "arm64",
            node: "22.22.1",
          },
        },
      ),
    ).toThrow(/config differs/);
  });
});
