import {
  chmodSync,
  chownSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  localOverlay,
  localProjectName,
  validateStateDirectory,
} from "../../tools/authority-local.mjs";

const roots: string[] = [];
const REPO = resolve(import.meta.dirname, "../..");
const TOOL = join(REPO, "tools", "authority-local.mjs");

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "echo-authority-local-test-"));
  roots.push(root);
  return root;
}

function currentOwnership(path: string, mode: number) {
  chownSync(path, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
  chmodSync(path, mode);
}

function externalTuple(image = "authority:test") {
  return {
    image,
    ports: { http: 49600, https: 49601 },
    release_id: "clean-v1-test",
    runtime_profile_sha256: "profile-test",
    source_revision: "a".repeat(40),
  };
}

function completeOwnedState(root: string, tuple = externalTuple()) {
  const state = join(realpathSync(root), "state");
  mkdirSync(join(state, "private"), { recursive: true, mode: 0o700 });
  mkdirSync(join(state, "state", "onboarding"), {
    recursive: true,
    mode: 0o700,
  });
  for (const directory of [
    state,
    join(state, "private"),
    join(state, "state"),
    join(state, "state", "onboarding"),
  ]) {
    currentOwnership(directory, 0o700);
  }
  writeFileSync(
    join(state, ".echo-authority-local-v1.json"),
    `${JSON.stringify({
      kind: "echo-authority-local-v1",
      repository: realpathSync(REPO),
      state_directory: state,
      uid: process.getuid?.() ?? 0,
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(state, ".echo-authority-local-v1.tuple.json"),
    `${JSON.stringify(tuple)}\n`,
    { mode: 0o600 },
  );
  for (const name of [
    "reset.json",
    "private/oidc.json",
    "private/oidc-client-secret",
    "private/pkce-key",
    "state/onboarding/clean-founder-v1.json",
  ]) {
    const path = join(state, name);
    writeFileSync(path, "fixture\n", { mode: 0o600 });
    currentOwnership(path, 0o600);
  }
  currentOwnership(join(state, ".echo-authority-local-v1.json"), 0o600);
  currentOwnership(join(state, ".echo-authority-local-v1.tuple.json"), 0o600);
  return state;
}

function dockerTrap(root: string) {
  const bin = join(root, "bin");
  const calls = join(root, "docker-called");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env sh\ntouch ${JSON.stringify(calls)}\nexit 0\n`,
    { mode: 0o755 },
  );
  return { calls, path: `${bin}:${process.env.PATH}` };
}

function runTool(
  args: readonly string[],
  path: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, PATH: path, ...environment },
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Authority local harness", () => {
  it("uses a stable per-worktree and per-user Compose project", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "one"));
    mkdirSync(join(root, "two"));

    expect(localProjectName(join(root, "one"), 501, "/tmp/one")).toBe(
      localProjectName(join(root, "one"), 501, "/tmp/one"),
    );
    expect(localProjectName(join(root, "one"), 501, "/tmp/one")).not.toBe(
      localProjectName(join(root, "two"), 501, "/tmp/one"),
    );
    expect(localProjectName(join(root, "one"), 501, "/tmp/one")).not.toBe(
      localProjectName(join(root, "one"), 502, "/tmp/one"),
    );
    expect(localProjectName(join(root, "one"), 501, "/tmp/one")).not.toBe(
      localProjectName(join(root, "one"), 501, "/tmp/two"),
    );
  });

  it("rejects repository, production, and symlink state paths before Docker work", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    const productionData = join(root, "production", "clean-data");
    mkdirSync(repo);
    mkdirSync(join(root, "safe"));
    symlinkSync(join(root, "safe"), join(root, "symlink"));

    const options = { repo, productionData };
    expect(() => validateStateDirectory(repo, options)).toThrow(
      "outside this repository",
    );
    expect(() => validateStateDirectory(productionData, options)).toThrow(
      "outside this repository",
    );
    expect(() =>
      validateStateDirectory(join(root, "symlink", "state"), options),
    ).toThrow("symlink");
    expect(validateStateDirectory(join(root, "external-state"), options)).toBe(
      resolve(realpathSync(root), "external-state"),
    );
  });

  it("refuses an unowned state directory before it can invoke Docker", () => {
    const root = temporaryRoot();
    const bin = join(root, "bin");
    const calls = join(root, "docker-called");
    const state = join(root, "unowned-state");
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env sh\ntouch ${JSON.stringify(calls)}\nexit 0\n`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      process.execPath,
      [TOOL, "down", "--state-dir", state],
      {
        cwd: REPO,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing unowned state directory");
    expect(() => realpathSync(calls)).toThrow();
  });

  it("refuses a tuple change after down-like complete state before Docker", () => {
    const root = temporaryRoot();
    const state = completeOwnedState(root);
    const trap = dockerTrap(root);
    const result = runTool(
      [
        "up",
        "--state-dir",
        state,
        "--image",
        "authority:changed",
        "--source-revision",
        "a".repeat(40),
        "--release-id",
        "clean-v1-test",
        "--runtime-profile-sha256",
        "profile-test",
        "--no-build",
      ],
      trap.path,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different tuple; run reset");
    expect(() => realpathSync(trap.calls)).toThrow();
  });

  it("refuses a generated overlay symlink before Docker", () => {
    const root = temporaryRoot();
    const tuple = externalTuple();
    const state = completeOwnedState(root, tuple);
    const generated = join(state, "generated");
    mkdirSync(generated, { mode: 0o700 });
    currentOwnership(generated, 0o700);
    symlinkSync(join(root, "outside"), join(generated, "compose.local.yaml"));
    const trap = dockerTrap(root);
    const result = runTool(
      [
        "up",
        "--state-dir",
        state,
        "--image",
        tuple.image,
        "--source-revision",
        tuple.source_revision,
        "--release-id",
        tuple.release_id,
        "--runtime-profile-sha256",
        tuple.runtime_profile_sha256,
        "--no-build",
      ],
      trap.path,
      {
        ECHO_LOCAL_AUTHORITY_HTTP_PORT: String(tuple.ports.http),
        ECHO_LOCAL_AUTHORITY_HTTPS_PORT: String(tuple.ports.https),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated local Compose overlay");
    expect(() => realpathSync(trap.calls)).toThrow();
  });

  it("refuses a Caddy CA symlink before exposing its path", () => {
    const root = temporaryRoot();
    const state = completeOwnedState(root);
    symlinkSync(join(root, "outside"), join(state, "caddy-local-root-ca.crt"));
    const trap = dockerTrap(root);
    const result = runTool(["ca-path", "--state-dir", state], trap.path);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Caddy local root certificate");
    expect(() => realpathSync(trap.calls)).toThrow();
  });

  it("refuses an unsafe reset cleanup tree before Docker", () => {
    const root = temporaryRoot();
    const state = completeOwnedState(root);
    symlinkSync(join(root, "outside"), join(state, "state", "unexpected"));
    const trap = dockerTrap(root);
    const result = runTool(["reset", "--state-dir", state], trap.path);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "synthetic Authority state contains a symlink",
    );
    expect(() => realpathSync(trap.calls)).toThrow();
  });

  it("refuses an unsafe generated input record before Docker", () => {
    const root = temporaryRoot();
    const tuple = externalTuple();
    const state = completeOwnedState(root, tuple);
    const generated = join(state, "generated");
    mkdirSync(generated, { mode: 0o700 });
    currentOwnership(generated, 0o700);
    const overlay = join(generated, "compose.local.yaml");
    writeFileSync(
      overlay,
      localOverlay({
        state,
        ports: tuple.ports,
        localSource: tuple.source_revision,
      }),
      { mode: 0o600 },
    );
    currentOwnership(overlay, 0o600);
    symlinkSync(join(root, "outside"), join(generated, "local-input.json"));
    const trap = dockerTrap(root);
    const result = runTool(
      [
        "up",
        "--state-dir",
        state,
        "--image",
        tuple.image,
        "--source-revision",
        tuple.source_revision,
        "--release-id",
        tuple.release_id,
        "--runtime-profile-sha256",
        tuple.runtime_profile_sha256,
        "--no-build",
      ],
      trap.path,
      {
        ECHO_LOCAL_AUTHORITY_HTTP_PORT: String(tuple.ports.http),
        ECHO_LOCAL_AUTHORITY_HTTPS_PORT: String(tuple.ports.https),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated local input record");
    expect(() => realpathSync(trap.calls)).toThrow();
  });

  it("materializes a local overlay that replaces, rather than extends, state and ports", () => {
    const state =
      "/Users/example/.local/state/echo-brain/authority-local/example";
    const overlay = localOverlay({
      state,
      ports: { http: 45678, https: 45679 },
      localSource: "local-nonreleasable-example",
    });

    expect(overlay).toContain("volumes: !override");
    expect(overlay).toContain("ports: !override");
    expect(overlay).toContain(`\"${state}:/echo-clean\"`);
    expect(overlay).toContain('"127.0.0.1:45678:80"');
    expect(overlay).toContain('"127.0.0.1:45679:443"');
    expect(overlay).toContain("local-nonreleasable-example");
    expect(overlay).not.toContain("compose.clean-v1.ec2.yaml");
  });
});
