import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalJsonForTest as canonical,
  sha256FileForTest as digest,
} from "../support/test-canonical-json.js";

const REPO = resolve(import.meta.dirname, "../..");
const INSTALLER = join(REPO, "deploy/release/start-person-cli-kit-macos.sh");
const roots: string[] = [];
const nativeMac = process.platform === "darwin" && process.arch === "arm64" && process.version === "v22.22.1";

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "echo-mac-cli-kit-"));
  roots.push(root);
  const home = join(root, "home with spaces");
  const kit = join(root, "echo-person-onboarding-kit");
  for (const path of [home, kit]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(kit, "Start-ECHO.sh"), readFileSync(INSTALLER), { mode: 0o755 });
  writeFileSync(join(kit, "node"), readFileSync(process.execPath), { mode: 0o755 });
  writeFileSync(join(kit, "verify-person-onboarding-kit.mjs"), "if (process.env.REJECT_KIT) process.exit(1);\n");
  writeFileSync(join(kit, "clean-v1-release.mjs"), `import {readFileSync} from 'node:fs';
const record=JSON.parse(readFileSync(process.argv[3]));
if(process.argv[2] === 'field') console.log(record[process.argv[4]] ?? record.person_client[process.argv[4] === 'client-version' ? 'version' : '']);
else if(process.argv[2] !== 'validate') process.exit(1);
`);
  writeFileSync(join(kit, "kit-manifest.v1.json"), "{}\n");
  writeFileSync(join(kit, "build-identity.v1.json"), "{}\n");

  function prepare(release: number) {
    const releaseId = `clean-v1-macos-${release}`;
    const version = `0.1.${release}`;
    const sourceSha = String(release).repeat(40);
    writeFileSync(join(kit, "release.json"), JSON.stringify({
      "release-id": releaseId,
      "client-version": version,
      release_id: releaseId,
      source_sha: sourceSha,
      person_client: { version },
    }));
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "dist", "main.js"), `if(process.argv[2] === '--version') console.log('${version}'); else console.log(JSON.stringify({client_build:{source_sha:'${sourceSha}'}}));\n`);
    execFileSync("tar", ["-czf", join(kit, "person-client.tgz"), "package"], { cwd: root });
    rmSync(packageRoot, { recursive: true });
  }
  let prepared: number | undefined;
  function run(release: number, args: string[] = ["--install-only"]) {
    if (prepared !== release) {
      prepare(release);
      prepared = release;
    }
    return spawnSync("bash", [join(kit, "Start-ECHO.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
  }
  const cliRoot = join(home, "Library/Application Support/ECHO/cli");
  return { root, home, kit, cliRoot, run, prepare };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!nativeMac)("macOS arm64 Person CLI kit", () => {
  it("bootstraps A then activates B without touching native-app or Person session sentinels", () => {
    const subject = fixture();
    const first = subject.run(1);
    expect(first.status, first.stderr).toBe(0);
    const wrapper = join(subject.cliRoot, "bin/echo-brain");
    expect(execFileSync(wrapper, ["--version"], { encoding: "utf8" }).trim()).toBe("0.1.1");

    const appSentinel = join(subject.home, "Applications/ECHO.app/sentinel");
    const sessionSentinel = join(subject.home, ".local/share/echo-brain/person/session.json");
    const legacyWrapper = join(subject.home, ".local/share/echo/person/bin/echo-brain");
    mkdirSync(resolve(appSentinel, ".."), { recursive: true, mode: 0o700 });
    mkdirSync(resolve(sessionSentinel, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(appSentinel, "native app remains untouched", { mode: 0o600 });
    writeFileSync(sessionSentinel, "existing Person session remains untouched", { mode: 0o600 });
    mkdirSync(resolve(legacyWrapper, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(legacyWrapper, "legacy CLI remains untouched", { mode: 0o700 });

    const update = subject.run(2);
    expect(update.status, update.stderr).toBe(0);
    expect(execFileSync(wrapper, ["--version"], { encoding: "utf8" }).trim()).toBe("0.1.2");
    expect(readFileSync(appSentinel, "utf8")).toBe("native app remains untouched");
    expect(readFileSync(sessionSentinel, "utf8")).toBe("existing Person session remains untouched");
    expect(readFileSync(legacyWrapper, "utf8")).toBe("legacy CLI remains untouched");
    expect(existsSync(join(subject.cliRoot, "releases/clean-v1-macos-1"))).toBe(true);
    expect(existsSync(join(subject.cliRoot, "releases/clean-v1-macos-2"))).toBe(true);
  });

  it("rejects a raced wrapper and a broken B archive while A remains active", () => {
    const subject = fixture();
    expect(subject.run(1).status).toBe(0);
    const wrapper = join(subject.cliRoot, "bin/echo-brain");
    const before = execFileSync("shasum", ["-a", "256", wrapper], { encoding: "utf8" }).split(" ")[0];
    expect(subject.run(2).status).toBe(0);
    subject.prepare(3);
    const raced = subject.run(3, ["--install-only", "--expected-wrapper-sha256", before]);
    expect(raced.status).toBe(1);
    expect(raced.stderr).toContain("changed during download");
    expect(existsSync(join(subject.cliRoot, "releases/clean-v1-macos-3"))).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toContain("clean-v1-macos-2");

    subject.prepare(4);
    writeFileSync(join(subject.kit, "person-client.tgz"), "broken archive");
    const failed = spawnSync("bash", [join(subject.kit, "Start-ECHO.sh"), "--install-only"], {
      encoding: "utf8",
      env: { ...process.env, HOME: subject.home },
    });
    expect(failed.status).toBe(1);
    expect(readFileSync(wrapper, "utf8")).toContain("clean-v1-macos-2");
    expect(existsSync(join(subject.cliRoot, "releases/clean-v1-macos-4"))).toBe(false);
  });

  it("verifies an exact schema-v3 macOS CLI kit with its bundled arm64 Mach-O runtime", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "echo-mac-cli-verify-"));
    roots.push(root);
    const releaseId = "clean-v1-macos-verify";
    const sourceSha = "a".repeat(40);
    const version = "0.1.1";
    copyFixtureRuntime(root);
    const release = { release_id: releaseId, source_sha: sourceSha, person_client: { version } };
    const identity = { schema_version: 1, kind: "echo-person-onboarding-kit-identity-v1", platform: "darwin", architecture: "arm64", product_version: version, release_id: releaseId, source_sha: sourceSha };
    writeFileSync(join(root, "release.json"), `${canonical(release)}\n`);
    writeFileSync(join(root, "person-client.tgz"), "fixture client\n");
    writeFileSync(join(root, "build-identity.v1.json"), `${canonical(identity)}\n`);
    const manifest = { schema_version: 3, kind: "echo-person-cli-kit-v1", release_id: releaseId, source_sha: sourceSha, release_record_sha256: digest(join(root, "release.json")), person_client_artifact_sha256: digest(join(root, "person-client.tgz")), build_identity_sha256: digest(join(root, "build-identity.v1.json")), runtime: { version: process.version, platform: process.platform, architecture: process.arch, node_sha256: digest(join(root, "node")) } };
    writeFileSync(join(root, "kit-manifest.v1.json"), `${canonical(manifest)}\n`);
    const result = spawnSync(join(root, "node"), [join(root, "verify-person-onboarding-kit.mjs"), root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, platform: "darwin", architecture: "arm64" });
  });

  it("builds a flat schema-3 CLI kit from clean committed source and verifies it with the bundled runtime", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "echo-mac-cli-build-"));
    roots.push(root);
    const source = join(root, "source");
    const output = join(root, "output");
    mkdirSync(output, { mode: 0o700 });
    for (const path of [
      "deploy/release/create-person-onboarding-kit.mjs",
      "deploy/release/verify-person-onboarding-kit.mjs",
      "deploy/release/release-artifact-validation.mjs",
      "deploy/release/start-person-cli-kit-macos.sh",
      "tools/clean-v1-release.mjs",
    ]) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      copyFileSync(join(REPO, path), join(source, path));
    }
    chmodSync(join(source, "deploy/release/start-person-cli-kit-macos.sh"), 0o755);
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "-c", "user.name=Mac Kit Test", "-c", "user.email=mac-kit@example.test", "commit", "-qm", "fixture"]);
    const sourceSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const version = "0.1.0-internal.1";
    const packageRoot = join(root, "package", "dist");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "main.js"), "process.stdout.write('fixture\\n');\n");
    writeFileSync(join(packageRoot, "build-identity.v1.json"), JSON.stringify({
      schema_version: 1, kind: "echo-packaged-build-identity", product_version: version, source_sha: sourceSha, source_kind: "materialized-commit",
    }));
    const artifact = join(root, "person-client.tgz");
    execFileSync("tar", ["-czf", artifact, "-C", root, "package"]);
    const release = join(root, "release.json");
    writeFileSync(release, `${canonical({
      schema_version: 1,
      kind: "echo-clean-v1-release",
      release_id: "clean-v1-macos-cli-kit",
      released_at: "2026-09-25T00:00:00Z",
      baseline_compatibility_class: "clean-v1",
      source_sha: sourceSha,
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"a".repeat(64)}` },
      person_client: { package: "@echo-brain/person-client", version, artifact_url: "https://downloads.example.test/person-client.tgz", artifact_sha256: digest(artifact) },
      runtime_profile: { artifact_url: "https://downloads.example.test/runtime-profile.json", artifact_sha256: "b".repeat(64), profile_version: "clean-v1-profile-1" },
    })}\n`);

    const outputZip = join(output, "ECHO-cli-macos-arm64.zip");
    const built = spawnSync(process.execPath, [
      join(source, "deploy/release/create-person-onboarding-kit.mjs"),
      "--target", "darwin-arm64", "--installation", "cli-kit",
      "--release", release, "--artifact", artifact,
      "--runtime-node", process.execPath, "--output", outputZip,
    ], { cwd: source, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    const receipt = JSON.parse(built.stdout);
    expect(receipt).toMatchObject({ release_id: "clean-v1-macos-cli-kit", source_sha: sourceSha, platform: "darwin", architecture: "arm64", node_version: "v22.22.1" });
    expect(readFileSync(`${outputZip}.sha256`, "utf8")).toBe(`${receipt.kit_sha256}  ECHO-cli-macos-arm64.zip\n`);
    const files = ["Start-ECHO.sh", "node", "kit-manifest.v1.json", "release.json", "person-client.tgz", "verify-person-onboarding-kit.mjs", "clean-v1-release.mjs", "build-identity.v1.json"];
    expect(receipt.contents).toEqual(files.map((file) => `echo-person-onboarding-kit/${file}`));
    const listed = execFileSync("unzip", ["-Z1", outputZip], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(listed.sort()).toEqual(["echo-person-onboarding-kit/", ...files.map((file) => `echo-person-onboarding-kit/${file}`)].sort());

    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    execFileSync("unzip", ["-q", outputZip, "-d", extracted]);
    const kit = join(extracted, "echo-person-onboarding-kit");
    const manifest = JSON.parse(readFileSync(join(kit, "kit-manifest.v1.json"), "utf8"));
    expect(manifest).toMatchObject({ schema_version: 3, kind: "echo-person-cli-kit-v1", release_id: "clean-v1-macos-cli-kit", source_sha: sourceSha });
    expect(Object.keys(manifest).sort()).toEqual(["build_identity_sha256", "kind", "person_client_artifact_sha256", "release_id", "release_record_sha256", "runtime", "schema_version", "source_sha"]);
    expect(readFileSync(join(kit, "Start-ECHO.sh"))).toEqual(readFileSync(INSTALLER));
    const verified = spawnSync(join(kit, "node"), [join(kit, "verify-person-onboarding-kit.mjs"), kit], { encoding: "utf8" });
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, release_id: "clean-v1-macos-cli-kit", platform: "darwin", architecture: "arm64" });
    const systemNode = spawnSync(process.execPath, [join(kit, "verify-person-onboarding-kit.mjs"), kit], { encoding: "utf8" });
    expect(systemNode.status).toBe(1);
    expect(systemNode.stderr).toContain("must run with the bundled Node runtime");

    writeFileSync(join(source, "deploy/release/start-person-cli-kit-macos.sh"), "#!/usr/bin/env bash\n# uncommitted\n");
    const dirty = spawnSync(process.execPath, [
      join(source, "deploy/release/create-person-onboarding-kit.mjs"),
      "--installation", "cli-kit", "--release", release, "--artifact", artifact,
      "--runtime-node", process.execPath, "--output", join(output, "dirty.zip"),
    ], { cwd: source, encoding: "utf8" });
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("macOS CLI kit requires clean committed source matching the release");
    expect(existsSync(join(output, "dirty.zip"))).toBe(false);
  });
});

function copyFixtureRuntime(root: string) {
  writeFileSync(join(root, "node"), readFileSync(process.execPath), { mode: 0o755 });
  writeFileSync(join(root, "verify-person-onboarding-kit.mjs"), readFileSync(join(REPO, "deploy/release/verify-person-onboarding-kit.mjs")), { mode: 0o755 });
}
