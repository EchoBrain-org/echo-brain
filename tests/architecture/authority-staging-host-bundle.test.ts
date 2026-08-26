import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const BUILDER = join(REPO, "tools", "build-authority-staging-host-bundle.mjs");
const BOOTSTRAP = join(
  REPO,
  "deploy/organization-authority/bootstrap-ubuntu-arm64.sh",
);
const UNIT = join(
  REPO,
  "deploy/organization-authority/cloudflared-echo-authority.service",
);
const INSTALLER = join(
  REPO,
  "deploy/organization-authority/install-cloudflare-tunnel-token.sh",
);
const ONBOARD = join(REPO, "deploy/organization-authority/onboard-clean-v1.sh");
const UPDATER = join(REPO, "deploy/organization-authority/update-clean-v1.sh");
const RESTORER = join(
  REPO,
  "deploy/organization-authority/restore-clean-v1-host.sh",
);
const RELEASE_VALIDATOR = join(REPO, "deploy/release/clean-v1-release.py");
const RUNTIME_PROFILE_VALIDATOR = join(
  REPO,
  "deploy/release/clean-v1-runtime-profile.py",
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "echo-staging-host-bundle-"));
  roots.push(root);
  const authority = join(root, "deploy", "organization-authority");
  const release = join(root, "deploy", "release");
  const output = mkdtempSync(join(tmpdir(), "echo-staging-host-output-"));
  roots.push(output);
  mkdirSync(authority, { recursive: true, mode: 0o700 });
  mkdirSync(release, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const bootstrap = readFileSync(BOOTSTRAP);
  writeFileSync(join(authority, "bootstrap-ubuntu-arm64.sh"), bootstrap, {
    mode: 0o755,
  });
  writeFileSync(
    join(authority, "cloudflared-echo-authority.service"),
    readFileSync(UNIT),
    { mode: 0o644 },
  );
  for (const [name, source, mode, destination] of [
    ["onboard-clean-v1.sh", ONBOARD, 0o755, authority],
    ["update-clean-v1.sh", UPDATER, 0o755, authority],
    ["restore-clean-v1-host.sh", RESTORER, 0o755, authority],
    ["clean-v1-release.py", RELEASE_VALIDATOR, 0o755, release],
    ["clean-v1-runtime-profile.py", RUNTIME_PROFILE_VALIDATOR, 0o755, release],
  ] as const) {
    writeFileSync(join(destination, name), readFileSync(source), {
      mode,
    });
  }
  writeFileSync(
    join(authority, "install-cloudflare-tunnel-token.sh"),
    readFileSync(INSTALLER),
    { mode: 0o755 },
  );
  writeFileSync(join(root, ".env.clean-v1"), "must-not-be-packaged=true\n", {
    mode: 0o600,
  });
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Bundle Test",
    "-c",
    "user.email=bundle@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  return { root, output };
}

function build(sourceRoot: string, output: string) {
  return spawnSync(
    process.execPath,
    [BUILDER, "--source-root", sourceRoot, "--output", output],
    { encoding: "utf8" },
  );
}

describe("Authority staging host bundle", () => {
  it("packages exactly the host and non-secret deployment controls with deterministic private receipts", () => {
    const subject = fixture();
    const first = join(subject.output, "first.tar.gz");
    const second = join(subject.output, "second.tar.gz");

    const one = build(subject.root, first);
    const two = build(subject.root, second);

    expect(one.status).toBe(0);
    expect(two.status).toBe(0);
    expect(one.stderr).toBe("");
    expect(sha256(first)).toBe(sha256(second));
    expect(lstatSync(first).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${first}.manifest.json`).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(`${first}.manifest.json`, "utf8"));
    expect(manifest).toMatchObject({
      schema_version: 1,
      kind: "echo-authority-staging-host-bundle-v1",
      source_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      archive_sha256: sha256(first),
    });
    expect(manifest.files).toEqual([
      expect.objectContaining({
        path: "deploy/organization-authority/bootstrap-ubuntu-arm64.sh",
        mode: "0755",
      }),
      expect.objectContaining({
        path: "deploy/organization-authority/cloudflared-echo-authority.service",
        mode: "0644",
      }),
      expect.objectContaining({
        path: "deploy/organization-authority/install-cloudflare-tunnel-token.sh",
        mode: "0755",
      }),
      expect.objectContaining({
        path: "deploy/organization-authority/onboard-clean-v1.sh",
        mode: "0755",
      }),
      expect.objectContaining({
        path: "deploy/organization-authority/restore-clean-v1-host.sh",
        mode: "0755",
      }),
      expect.objectContaining({
        path: "deploy/organization-authority/update-clean-v1.sh",
        mode: "0755",
      }),
      expect.objectContaining({
        path: "deploy/release/clean-v1-release.py",
        mode: "0644",
      }),
      expect.objectContaining({
        path: "deploy/release/clean-v1-runtime-profile.py",
        mode: "0644",
      }),
    ]);
    const listed = execFileSync("tar", ["-tzf", first], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(listed).toEqual([
      "bootstrap-ubuntu-arm64.sh",
      "clean-v1-release.py",
      "clean-v1-runtime-profile.py",
      "cloudflared-echo-authority.service",
      "install-cloudflare-tunnel-token.sh",
      "onboard-clean-v1.sh",
      "restore-clean-v1-host.sh",
      "update-clean-v1.sh",
    ]);
    // The archive sources may name retained paths in their validation code;
    // the tar member allowlist above is the boundary proving no state file is
    // an artifact member.
  });

  it("has a closed allowlist: control code is present, but environment, records, runtime files, state, and credentials are absent", () => {
    const subject = fixture();
    const output = join(subject.output, "bundle.tar.gz");
    const result = build(subject.root, output);

    expect(result.status).toBe(0);
    const listed = execFileSync("tar", ["-tzf", output], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(listed).toEqual(expect.arrayContaining([
      "onboard-clean-v1.sh",
      "update-clean-v1.sh",
      "restore-clean-v1-host.sh",
      "clean-v1-release.py",
      "clean-v1-runtime-profile.py",
    ]));
    for (const forbidden of [
      ".env.clean-v1",
      "clean-data",
      "current.clean-v1.json",
      "candidate.clean-v1.json",
      "runtime-profile.active",
      "oidc-client-secret",
      "slack-bot-token",
      "granola-credential-source",
      "llm-credential-source",
    ]) {
      expect(listed).not.toContain(forbidden);
    }
  });

  it("refuses an unclean source, existing output, and non-private output directory", () => {
    const subject = fixture();
    const output = join(subject.output, "bundle.tar.gz");
    writeFileSync(join(subject.root, "untracked.txt"), "dirty\n");
    const dirty = build(subject.root, output);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain(
      "source root must have no tracked or untracked changes",
    );

    rmSync(join(subject.root, "untracked.txt"));
    const clean = build(subject.root, output);
    expect(clean.status).toBe(0);
    const existing = build(subject.root, output);
    expect(existing.status).toBe(1);
    expect(existing.stderr).toContain(
      "output and its manifest must be new paths",
    );

    const publicOutput = mkdtempSync(join(tmpdir(), "echo-public-output-"));
    roots.push(publicOutput);
    chmodSync(publicOutput, 0o755);
    const mode = build(subject.root, join(publicOutput, "private.tar.gz"));
    expect(mode.status).toBe(1);
    expect(mode.stderr).toContain("output directory must not be accessible");
  });

  it("rejects a symlinked required asset before it can be archived", () => {
    const subject = fixture();
    const installer = join(
      subject.root,
      "deploy/organization-authority/install-cloudflare-tunnel-token.sh",
    );
    rmSync(installer);
    symlinkSync("bootstrap-ubuntu-arm64.sh", installer);
    execFileSync("git", ["-C", subject.root, "add", "-A"]);
    execFileSync("git", [
      "-C",
      subject.root,
      "-c",
      "user.name=Bundle Test",
      "-c",
      "user.email=bundle@example.test",
      "commit",
      "-qm",
      "symlink",
    ]);

    const result = build(subject.root, join(subject.output, "bundle.tar.gz"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "install-cloudflare-tunnel-token.sh must be a regular file, not a symlink",
    );
  });
});
