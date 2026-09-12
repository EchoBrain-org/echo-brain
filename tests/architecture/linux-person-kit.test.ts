import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const nativeLinux = process.platform === "linux" && process.arch === "x64" && process.version === "v22.22.1";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux Person onboarding kit", () => {
  it("accepts only an ELF64 little-endian x86_64 runtime header", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-linux-person-verifier-"));
    roots.push(root);
    const sourceSha = "a".repeat(40);
    const releaseId = "clean-v1-linux-header";
    const runtime = join(root, "node");
    const identity = {
      schema_version: 1,
      kind: "echo-person-onboarding-kit-identity-v1",
      platform: "linux",
      architecture: "x64",
      product_version: "0.1.0-internal.1",
      release_id: releaseId,
      source_sha: sourceSha,
    };
    writeFileSync(join(root, "release.json"), JSON.stringify({
      release_id: releaseId,
      source_sha: sourceSha,
      person_client: { version: identity.product_version },
    }));
    writeFileSync(join(root, "person-client.tgz"), "fixture client\n");
    writeFileSync(join(root, "build-identity.v1.json"), `${canonical(identity)}\n`);
    const preload = join(root, "linux-process.cjs");
    writeFileSync(preload, [
      "Object.defineProperty(process, 'platform', { value: 'linux' });",
      "Object.defineProperty(process, 'arch', { value: 'x64' });",
      `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(runtime)} });`,
      "process.report.getReport = () => ({ header: { glibcVersionRuntime: '2.31' } });",
      "",
    ].join("\n"));
    const writeManifest = () => writeFileSync(join(root, "kit-manifest.v1.json"), `${canonical({
      schema_version: 2,
      kind: "echo-person-onboarding-kit-v2",
      release_id: releaseId,
      source_sha: sourceSha,
      release_record_sha256: sha256(join(root, "release.json")),
      person_client_artifact_sha256: sha256(join(root, "person-client.tgz")),
      build_identity_sha256: sha256(join(root, "build-identity.v1.json")),
      runtime: {
        version: "v22.22.1",
        platform: "linux",
        architecture: "x64",
        node_sha256: sha256(runtime),
      },
    })}\n`);
    const verify = () => run(process.execPath, [
      "--require", preload,
      join(REPO, "deploy/release/verify-person-onboarding-kit.mjs"),
      root,
    ]);
    const elf = Buffer.alloc(20);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(62, 18);
    writeFileSync(runtime, elf);
    writeManifest();
    const systemNode = run(process.execPath, [
      join(REPO, "deploy/release/verify-person-onboarding-kit.mjs"),
      root,
    ]);
    expect(systemNode.status).toBe(1);
    expect(systemNode.stderr).toContain("bundled Node runtime");
    expect(verify().status).toBe(0);

    elf.writeUInt16LE(3, 18);
    writeFileSync(runtime, elf);
    writeManifest();
    const wrongMachine = verify();
    expect(wrongMachine.status).toBe(1);
    expect(wrongMachine.stderr).toContain("Linux x86_64 ELF executable");

    writeFileSync(runtime, elf.subarray(0, 8));
    writeManifest();
    const truncated = verify();
    expect(truncated.status).toBe(1);
    expect(truncated.stderr).toContain("Linux x86_64 ELF executable");
  });

  it.skipIf(!nativeLinux)("builds a flat Linux kit and verifies the ELF runtime and kit identity", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-linux-person-kit-"));
    roots.push(root);
    const source = join(root, "source");
    const output = join(root, "output");
    const releaseDirectory = join(source, "deploy", "release");
    mkdirSync(releaseDirectory, { recursive: true });
    mkdirSync(join(source, "tools"), { recursive: true });
    mkdirSync(output, { mode: 0o700 });
    for (const path of [
      "deploy/release/create-person-onboarding-kit.mjs",
      "deploy/release/verify-person-onboarding-kit.mjs",
      "deploy/release/release-artifact-validation.mjs",
      "deploy/release/start-person-onboarding-kit-linux.sh",
      "tools/clean-v1-release.mjs",
      "tools/lib/swift-source-assembly.mjs",
    ]) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      copyFileSync(join(REPO, path), join(source, path));
    }
    chmodSync(join(releaseDirectory, "start-person-onboarding-kit-linux.sh"), 0o755);
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "-c", "user.name=Linux Kit Test", "-c", "user.email=linux-kit@example.test", "commit", "-qm", "fixture"]);
    const sourceSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const version = "0.1.0-internal.1";
    const packageRoot = join(root, "package", "dist");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "main.js"), "process.stdout.write('fixture\\n');\\n");
    writeFileSync(join(packageRoot, "build-identity.v1.json"), JSON.stringify({
      schema_version: 1,
      kind: "echo-packaged-build-identity",
      product_version: version,
      source_sha: sourceSha,
      source_kind: "materialized-commit",
    }));
    const artifact = join(root, "person-client.tgz");
    expect(run("tar", ["-czf", artifact, "-C", root, "package"]).status).toBe(0);
    const release = join(root, "release.json");
    writeFileSync(release, `${canonical({
      schema_version: 1,
      kind: "echo-clean-v1-release",
      release_id: "clean-v1-linux-kit",
      released_at: "2026-09-11T00:00:00Z",
      baseline_compatibility_class: "clean-v1",
      source_sha: sourceSha,
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"a".repeat(64)}` },
      person_client: {
        package: "@echo-brain/person-client",
        version,
        artifact_url: "https://downloads.example.test/person-client.tgz",
        artifact_sha256: sha256(artifact),
      },
      runtime_profile: {
        artifact_url: "https://downloads.example.test/runtime-profile.json",
        artifact_sha256: "b".repeat(64),
        profile_version: "clean-v1-profile-1",
      },
    })}\n`);
    const outputZip = join(output, "echo-linux-kit.zip");
    const built = run(process.execPath, [
      join(releaseDirectory, "create-person-onboarding-kit.mjs"),
      "--target", "linux-x64",
      "--release", release,
      "--artifact", artifact,
      "--runtime-node", process.execPath,
      "--output", outputZip,
    ], source);
    expect(built.status).toBe(0);
    const receipt = JSON.parse(built.stdout);
    expect(receipt.signing).toBeUndefined();
    expect(receipt.kit_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contents).toEqual([
      "echo-person-onboarding-kit/Start-ECHO.sh",
      "echo-person-onboarding-kit/node",
      "echo-person-onboarding-kit/kit-manifest.v1.json",
      "echo-person-onboarding-kit/release.json",
      "echo-person-onboarding-kit/person-client.tgz",
      "echo-person-onboarding-kit/verify-person-onboarding-kit.mjs",
      "echo-person-onboarding-kit/clean-v1-release.mjs",
      "echo-person-onboarding-kit/build-identity.v1.json",
    ]);
    const listed = run("unzip", ["-Z1", outputZip]).stdout.split("\n").filter(Boolean);
    expect(listed).toContain("echo-person-onboarding-kit/build-identity.v1.json");
    expect(listed.join("\n")).not.toMatch(/ECHO\.app\.zip|person-onboarding-ui\.mjs/);

    const extracted = join(root, "kit");
    mkdirSync(extracted);
    expect(run("unzip", ["-q", outputZip, "-d", extracted]).status).toBe(0);
    const kit = join(extracted, "echo-person-onboarding-kit");
    const verified = run(join(kit, "node"), [join(kit, "verify-person-onboarding-kit.mjs"), kit]);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, platform: "linux", architecture: "x64" });
    const systemNode = run(process.execPath, [join(kit, "verify-person-onboarding-kit.mjs"), kit]);
    expect(systemNode.status).toBe(1);
    expect(systemNode.stderr).toContain("bundled Node runtime");

    const appRejected = run(process.execPath, [
      join(releaseDirectory, "create-person-onboarding-kit.mjs"),
      "--target", "linux-x64",
      "--release", release,
      "--artifact", artifact,
      "--app", join(root, "unused-ECHO.app.zip"),
      "--runtime-node", process.execPath,
      "--output", join(output, "app-rejected.zip"),
    ], source);
    expect(appRejected.status).toBe(1);
    expect(appRejected.stderr).toContain("usage:");

    const badRuntime = join(root, "wrong-node");
    writeFileSync(badRuntime, Buffer.alloc(20));
    chmodSync(badRuntime, 0o755);
    const rejected = run(process.execPath, [
      join(releaseDirectory, "create-person-onboarding-kit.mjs"),
      "--target", "linux-x64",
      "--release", release,
      "--artifact", artifact,
      "--runtime-node", badRuntime,
      "--output", join(output, "bad.zip"),
    ], source);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Linux x86_64 ELF executable");
  });
});
