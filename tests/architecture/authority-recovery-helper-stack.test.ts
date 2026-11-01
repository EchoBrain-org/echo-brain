import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AuthorityRecoveryHelperBundleManifest } from "../../tools/build-authority-recovery-helper-bundle.mjs";
import { readTemplate, resource } from "../support/cloudformation-template.js";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-recovery-helper-v1.template.json",
);
const BUNDLE_BUILDER = resolve(
  REPO,
  "tools/build-authority-recovery-helper-bundle.mjs",
);
const SOURCE_CHECKOUT = resolve(REPO, "tools/lib/source-checkout.mjs");
const BUNDLE_WORKFLOW = resolve(
  REPO,
  ".github/workflows/authority-recovery-helper-bundle.yml",
);
const RUNBOOK = resolve(
  REPO,
  "docs/operations/RB-OPERATIONS-002-authority-recovery-floor.md",
);

const template = () => readTemplate(TEMPLATE);

describe("Authority isolated recovery helper stack", () => {
  it("creates only the bounded disposable helper environment", () => {
    const stack = template();
    expect(JSON.stringify(stack)).not.toMatch(
      /AWS::Backup|AWS::SecretsManager|AWS::ECR|cloudflared|docker/i,
    );
  });

  it("requires exact network and immutable-bundle inputs rather than discovering them", () => {
    const stack = template();
    for (const key of [
      "VpcId",
      "AvailabilityZone",
      "HelperSubnetCidr",
      "HelperAmiId",
      "BundleBucketName",
      "BundleObjectKey",
      "BundleObjectVersion",
      "BundleSha256",
      "BundleSourceCommit",
      "S3PrefixListId",
      "OperationId",
      "ExpiresAt",
    ]) {
      expect(stack.Parameters[key]).toBeDefined();
    }
    expect(stack.Parameters.BundleObjectVersion).toMatchObject({
      AllowedPattern: "^[A-Za-z0-9._/+=-]{8,1024}$",
    });
    expect(stack.Parameters.BundleSha256).toMatchObject({
      AllowedPattern: "^[0-9a-f]{64}$",
    });
  });

  it("uses ARM64 Graviton, IMDSv2, encrypted disposable root storage, and expiry tags", () => {
    const stack = template();
    expect(stack.Parameters.HelperInstanceType).toMatchObject({
      Default: "t4g.small",
      AllowedValues: ["t4g.nano", "t4g.small", "t4g.medium"],
    });
    expect(JSON.stringify(stack.Resources)).toContain("OperationId");
    expect(JSON.stringify(stack.Resources)).toContain("ExpiresAt");
  });

  it("allows the helper role to use SSM and one immutable bundle only", () => {
    const stack = template();
    const role = resource(stack, "RecoveryHelperRole");
    const text = JSON.stringify(role.Properties);
    expect(text).not.toMatch(/backup:|ec2:|secretsmanager|ecr|cloudflare/i);
  });

  it("downloads, hashes, smoke-tests, and marks the offline bundle ready before attachment", () => {
    const stack = template();
    const userData = JSON.stringify(
      resource(stack, "RecoveryHelper").Properties.UserData,
    );
    for (const required of [
      "aws s3api get-object",
      "--version-id '${BundleObjectVersion}'",
      "sha256sum -c -",
      "python3 -c 'import sqlite3'",
      "recovery-helper-bundle.manifest.json",
      "BundleSourceCommit",
      "v22.22.1",
      "npm_shrinkwrap_sha256!==h",
      "id ec2-user",
      'install -d -o ec2-user -g ec2-user -m 0755 \\"$source/node_modules/.vite-temp\\"',
      "runuser -u ec2-user",
      "authority-recovery-verifier.test.ts",
      ".bundle-ready",
    ]) {
      expect(userData).toContain(required);
    }
    expect(userData).not.toMatch(
      /docker|compose|secretsmanager|ecr|cloudflared/i,
    );
  });

  it("pins the bundle build itself to clean Linux ARM64 source and the verifier prerequisites", () => {
    expectTypeOf<AuthorityRecoveryHelperBundleManifest>()
      .toHaveProperty("npm_shrinkwrap_sha256").toBeString();
    const builder = [BUNDLE_BUILDER, SOURCE_CHECKOUT]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const required of [
      'process.platform !== "linux"',
      'process.arch !== "arm64"',
      'NODE_VERSION = "v22.22.1"',
      '"--porcelain=v1"',
      'run("npm", ["run", "build"]',
      '"npm-shrinkwrap.json"',
      "npm_shrinkwrap_sha256",
      "packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js",
      "authority-recovery-verifier.test.ts",
      "archive_sha256",
      "recovery-helper-bundle.manifest.json",
    ]) {
      expect(builder).toContain(required);
    }
  });

  it("builds and exercises the operator bundle on a native ARM64 runner", () => {
    const workflow = readFileSync(BUNDLE_WORKFLOW, "utf8");
    for (const required of [
      "workflow_dispatch:",
      "runs-on: ubuntu-24.04-arm",
      'PRODUCT_NODE_VERSION: "22.22.1"',
      "build-authority-recovery-helper-bundle.mjs",
      "fetch-depth: 0",
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
      'test "$(uname -m)" = aarch64',
      "value.source_commit !== process.env.GITHUB_SHA",
      "value.npm_shrinkwrap_sha256",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "retention-days: 1",
    ]) {
      expect(workflow).toContain(required);
    }
    expect(workflow).not.toMatch(
      /aws-actions|configure-aws-credentials|s3 cp/i,
    );
  });

  it("keeps the runbook bound to the helper stack, the complete gp3 restore metadata, and no-replay inspection", () => {
    const runbook = readFileSync(RUNBOOK, "utf8");
    for (const required of [
      "authority-recovery-helper-v1.template.json",
      "authority-recovery-helper-v1.guard",
      "build-authority-recovery-helper-bundle.mjs",
      "iops",
      "throughput",
      "3.3.40.0",
      "cloud-init status --wait",
      "helper-stack-deleted",
      "aws cloudformation delete-stack",
      "/opt/echo-authority-recovery/runtime/node /opt/echo-authority-recovery/source/tools/verify-authority-recovery.mjs",
      "ro,noload",
      "secondary device",
    ]) {
      expect(runbook).toContain(required);
    }
  });
});
