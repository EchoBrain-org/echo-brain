import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TOOL = join(REPO, "tools", "clean-v1-release.mjs");
const DEPLOY_TOOL = join(REPO, "deploy", "release", "clean-v1-release.py");
const RUNTIME_PROFILE_TOOL = join(
  REPO,
  "tools",
  "clean-v1-runtime-profile.mjs",
);
const DEPLOY_RUNTIME_PROFILE_TOOL = join(
  REPO,
  "deploy",
  "release",
  "clean-v1-runtime-profile.py",
);
const UPDATE = join(REPO, "deploy", "organization-authority", "update-clean-v1.sh");
const INSTALL = join(REPO, "deploy", "release", "install-person-client-clean-v1.sh");
const BUNDLE = join(REPO, "deploy", "release", "create-offline-person-client-bundle.mjs");
const ONBOARDING_KIT = join(
  REPO,
  "deploy",
  "release",
  "create-person-onboarding-kit.mjs",
);
const DOCKERFILE = join(REPO, "deploy", "organization-authority", "Dockerfile");
const AUTHORITY_IMAGE_BUILD = join(REPO, "tools", "build-authority-image.mjs");
const roots: string[] = [];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    kind: "echo-clean-v1-release",
    release_id: "clean-v1-20260822-001",
    released_at: "2026-08-22T20:00:00Z",
    baseline_compatibility_class: "clean-v1",
    source_sha: "a".repeat(40),
    authority_image: {
      reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"b".repeat(64)}`,
    },
    person_client: {
      package: "@echo-brain/person-client",
      version: "0.1.0-internal.1",
      artifact_url: "https://downloads.example.test/echo-brain-person-client.tgz",
      artifact_sha256: "c".repeat(64),
    },
    runtime_profile: {
      artifact_url:
        "https://downloads.example.test/echo-brain-authority-runtime-profile.json",
      artifact_sha256: "e".repeat(64),
      profile_version: "clean-v1-profile-1",
    },
    ...overrides,
  };
}

function runtimeProfile(path: string, profileVersion = "clean-v1-profile-1") {
  return {
    artifact_url:
      "https://downloads.example.test/echo-brain-authority-runtime-profile.json",
    artifact_sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    profile_version: profileVersion,
  };
}

function writeRuntimeProfile(
  sourceSha = "a".repeat(40),
  marker = "",
): string {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-runtime-profile-"));
  roots.push(root);
  const profile = join(root, "runtime-profile.json");
  const deployment = join(REPO, "deploy", "organization-authority");
  const names = [
    "Caddyfile.clean-v1",
    "Caddyfile.clean-v1.ec2",
    "compose.clean-v1.ec2.yaml",
    "compose.clean-v1.yaml",
  ];
  const files = Object.fromEntries(
    names.map((name) => [
      name,
      `${readFileSync(join(deployment, name), "utf8")}${
        name === "Caddyfile.clean-v1" ? marker : ""
      }`,
    ]),
  );
  writeFileSync(
    profile,
    `${canonical({
      schema_version: 1,
      kind: "echo-clean-v1-runtime-profile",
      source_sha: sourceSha,
      files,
    })}\n`,
    { mode: 0o600 },
  );
  return profile;
}

function prepareRuntimeConfig(root: string, profile: string): string {
  const target = join(root, "runtime-config");
  const materialized = run("python3", [
    DEPLOY_RUNTIME_PROFILE_TOOL,
    "materialize",
    profile,
    target,
  ]);
  expect(materialized.status).toBe(0);
  return target;
}

function releaseWithRuntimeProfile(
  profilePath: string,
  overrides: Record<string, unknown> = {},
) {
  return record({
    runtime_profile: runtimeProfile(profilePath),
    ...overrides,
  });
}

function activeRuntimeProfile(state: string): string {
  return join(state, "runtime-profile.active");
}

function acceptedRuntimeProfile(state: string, releaseId: string): string {
  return join(state, "runtime-profiles", `${releaseId}.profile`);
}

function acceptedRuntimeEnvironment(state: string, releaseId: string): string {
  return join(state, "runtime-environments", `${releaseId}.env`);
}

function canaryReceiptPath(state: string, releaseId: string): string {
  return join(state, "canary-receipts", `${releaseId}.json`);
}

function writeCanaryReceipt(
  state: string,
  releaseId: string,
  outcome: "staged" | "delivery_pending" = "staged",
): string {
  const path = canaryReceiptPath(state, releaseId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${canonical({
      schema_version: 1,
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
      release_id: releaseId,
      approval_outcome: outcome,
      approval_id: "approval-canary",
    })}\n`,
    { mode: 0o600 },
  );
  return path;
}

function tupleEnvironment(release: ReturnType<typeof record>): string {
  return `ECHO_CLEAN_AUTHORITY_IMAGE=${release.authority_image.reference}
ECHO_CLEAN_AUTHORITY_HOST=authority.example.test
ECHO_CLEAN_RELEASE_ID=${release.release_id}
ECHO_CLEAN_RELEASE_SOURCE_SHA=${release.source_sha}
ECHO_CLEAN_RUNTIME_PROFILE_SHA256=${release.runtime_profile.artifact_sha256}
ECHO_CLEAN_RUNTIME_PROFILE_VERSION=${release.runtime_profile.profile_version}
`;
}

function installActiveTuple(
  state: string,
  environmentFile: string,
  release: ReturnType<typeof record>,
  profile: string,
) {
  const environment = tupleEnvironment(release);
  mkdirSync(join(state, "runtime-profiles"), { recursive: true });
  mkdirSync(join(state, "runtime-environments"), { recursive: true });
  copyFileSync(profile, acceptedRuntimeProfile(state, release.release_id));
  copyFileSync(profile, activeRuntimeProfile(state));
  writeFileSync(acceptedRuntimeEnvironment(state, release.release_id), environment, {
    mode: 0o600,
  });
  writeFileSync(environmentFile, environment, { mode: 0o600 });
}

function writeCurrentStateLineage(stateDirectory: string) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const roles = [
    "authority",
    "control-plane",
    "record-log",
    "record-derived",
    "retrieval-facts",
    "retrieval-lexical",
    "retrieval-content",
  ];
  writeFileSync(
    join(stateDirectory, "state-lineage-root.v1.json"),
    JSON.stringify({
      schema_version: 1,
      kind: "echo-state-lineage-root-manifest-v1",
      databases: roles.map((role) => ({ role })),
    }),
  );
  const created = spawnSync(
    "python3",
    [
      "-c",
      [
        "import pathlib, sqlite3, sys",
        "root = pathlib.Path(sys.argv[1])",
        "for name, version in {'authority.sqlite': 3, 'integrations.sqlite': 2, 'record-log.sqlite': 2, 'record-derived.sqlite': 1}.items():",
        "  connection = sqlite3.connect(root / name)",
        "  connection.execute(f'PRAGMA user_version = {version}')",
        "  connection.commit()",
        "  connection.close()",
      ].join("\n"),
      stateDirectory,
    ],
    { encoding: "utf8" },
  );
  expect(created.status).toBe(0);
}

function writeRecord(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-release-"));
  roots.push(root);
  const path = join(root, "release.json");
  writeFileSync(path, `${canonical(value)}\n`);
  return path;
}

function run(
  command: string,
  args: string[],
  environment: Record<string, string | undefined> = {},
) {
  return spawnSync(command, args, {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Organization Authority clean-v1 release record", () => {
  it("accepts the same canonical non-secret record in build and operator tools", () => {
    const path = writeRecord(record());
    const node = run(process.execPath, [TOOL, "validate", path]);
    const python = run("python3", [DEPLOY_TOOL, "validate", path]);

    expect(node.status).toBe(0);
    expect(python.status).toBe(0);
    expect(node.stdout).toBe(python.stdout);
    expect(node.stdout).toContain('"baseline_compatibility_class":"clean-v1"');
    expect(node.stdout).not.toMatch(/token|secret|grant|session/i);
  });

  it("creates one canonical record without overwriting a prior release record", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-release-create-"));
    roots.push(root);
    const draft = join(root, "draft.json");
    const output = join(root, "release.json");
    writeFileSync(draft, JSON.stringify(record(), null, 2));

    expect(run(process.execPath, [TOOL, "create", draft, output]).status).toBe(0);
    expect(run(process.execPath, [TOOL, "validate", output]).status).toBe(0);
    expect(run(process.execPath, [TOOL, "create", draft, output]).status).toBe(1);
  });

  it("rejects floating images, noncanonical bytes, and a non-clean compatibility class", () => {
    const floating = writeRecord({
      ...record(),
      authority_image: { reference: "registry.example.test/echo/authority:latest" },
    });
    expect(run(process.execPath, [TOOL, "validate", floating]).status).toBe(1);

    const wrongBaseline = writeRecord({
      ...record(),
      baseline_compatibility_class: "legacy-v1",
    });
    expect(run("python3", [DEPLOY_TOOL, "validate", wrongBaseline]).status).toBe(1);

    const noncanonical = writeRecord(record());
    writeFileSync(noncanonical, `${JSON.stringify(record())}\n`);
    expect(run(process.execPath, [TOOL, "validate", noncanonical]).status).toBe(1);
  });

  it.each([
    ["boolean schema version", (source: string) => source.replace('"schema_version":1', '"schema_version":true')],
    ["floating schema version", (source: string) => source.replace('"schema_version":1', '"schema_version":1.5')],
    ["lexical float schema version", (source: string) => source.replace('"schema_version":1', '"schema_version":1.0')],
    ["impossible timestamp", (source: string) => source.replace("2026-08-22T20:00:00Z", "2026-02-30T20:00:00Z")],
  ])("keeps Node and Python validation in parity for %s", (_name, mutate) => {
    const path = writeRecord(record());
    writeFileSync(path, mutate(readFileSync(path, "utf8")));
    expect(run(process.execPath, [TOOL, "validate", path]).status).toBe(1);
    expect(run("python3", [DEPLOY_TOOL, "validate", path]).status).toBe(1);
  });

  it("requires one digest-bound runtime profile artifact and exposes its metadata", () => {
    const profile = writeRuntimeProfile();
    const release = writeRecord(releaseWithRuntimeProfile(profile));

    const nodeProfile = run(process.execPath, [
      RUNTIME_PROFILE_TOOL,
      "validate",
      profile,
    ]);
    const pythonProfile = run("python3", [
      DEPLOY_RUNTIME_PROFILE_TOOL,
      "validate",
      profile,
    ]);
    expect(nodeProfile.status).toBe(0);
    expect(pythonProfile.status).toBe(0);
    expect(nodeProfile.stdout).toBe(pythonProfile.stdout);

    const node = run(process.execPath, [TOOL, "validate", release]);
    const python = run("python3", [DEPLOY_TOOL, "validate", release]);
    expect(node.status).toBe(0);
    expect(python.status).toBe(0);
    expect(node.stdout).toBe(python.stdout);
    expect(node.stdout).toContain('"runtime_profile"');
    expect(
      run("python3", [DEPLOY_TOOL, "field", release, "runtime-profile-sha256"])
        .stdout.trim(),
    ).toBe(runtimeProfile(profile).artifact_sha256);
    expect(
      run("python3", [DEPLOY_TOOL, "field", release, "runtime-profile-version"])
        .stdout.trim(),
    ).toBe("clean-v1-profile-1");

    const { runtime_profile: _runtimeProfile, ...withoutRuntimeProfile } =
      record();
    const missing = writeRecord(withoutRuntimeProfile);
    const missingNode = run(process.execPath, [TOOL, "validate", missing]);
    const missingPython = run("python3", [DEPLOY_TOOL, "validate", missing]);
    expect(missingNode.status).toBe(1);
    expect(missingPython.status).toBe(1);
    expect(missingNode.stderr).toContain("runtime_profile");
    expect(missingPython.stderr).toContain("runtime_profile");
  });

  it.each([
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "\udc00"],
  ])("keeps runtime-profile validators in parity for %s", (_name, surrogate) => {
    const profile = writeRuntimeProfile();
    const value = JSON.parse(readFileSync(profile, "utf8")) as { files: Record<string, string> };
    value.files["Caddyfile.clean-v1"] = surrogate;
    writeFileSync(profile, `${canonical(value)}\n`);

    expect(run(process.execPath, [RUNTIME_PROFILE_TOOL, "validate", profile]).status).toBe(1);
    expect(run("python3", [DEPLOY_RUNTIME_PROFILE_TOOL, "validate", profile]).status).toBe(1);
  });

  it("keeps runtime-profile validators in parity for valid supplementary Unicode", () => {
    const profile = writeRuntimeProfile("a".repeat(40), "# valid emoji: 😀\n");
    const node = run(process.execPath, [RUNTIME_PROFILE_TOOL, "validate", profile]);
    const python = run("python3", [DEPLOY_RUNTIME_PROFILE_TOOL, "validate", profile]);

    expect(node.status).toBe(0);
    expect(python.status).toBe(0);
    expect(node.stdout).toBe(python.stdout);
  });

  it("materializes a runtime profile only into a new directory", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-profile-target-"));
    roots.push(root);
    const profile = writeRuntimeProfile();
    const target = join(root, "already-present");
    mkdirSync(target, { mode: 0o700 });

    const result = run("python3", [
      DEPLOY_RUNTIME_PROFILE_TOOL,
      "materialize",
      profile,
      target,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("target directory must not already exist");
    expect(readdirSync(target)).toEqual([]);
  });

  it("keeps the bounded staging canary private, release-bound, and separate from promotion", () => {
    const syntax = run("bash", ["-n", UPDATE]);
    expect(syntax.status).toBe(0);
    const source = readFileSync(UPDATE, "utf8");
    expect(source).toContain("--canary-passed");
    expect(source).toContain("update-clean-v1.sh canary");
    expect(source).toContain("run_staging_private_dm_canary");
    expect(source).toContain("authority-staging.echobrain.org");
    expect(source).toContain("compose_clean exec -T authority node");
    expect(source).toContain("staging-private-dm-canary --release-id");
    expect(source).toContain("validate_staging_canary_receipt");
    expect(source).not.toContain("onboard-clean-v1.sh resume");
    expect(source).toContain("candidate baseline is not compatible");
    expect(source).toContain("@sha256:");
    expect(source).toContain(".authority-operation-lock");
    expect(source).not.toContain("imageTag");
  });

  it("serializes release commands with Authority credential activation", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-operation-lock-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const lock = join(root, ".authority-operation-lock");
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    mkdirSync(bin);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner-pid"), `${process.pid}\n`, {
      mode: 0o600,
    });
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(
      envFile,
      `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`,
      { mode: 0o600 },
    );

    const result = run("bash", [UPDATE, "status"], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "another Authority activation or release operation is already in progress",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps a dead-owner release lock fail-closed for deliberate recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-stale-lock-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const lock = join(root, ".authority-operation-lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner-pid"), "99999999\n", {
      mode: 0o600,
    });
    writeFileSync(
      envFile,
      `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`,
      { mode: 0o600 },
    );

    const result = run("bash", [UPDATE, "status"], {
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "another Authority activation or release operation is already in progress",
    );
    expect(result.stderr).toContain("README operation-lock recovery");
    expect(existsSync(lock)).toBe(true);
  });

  it("refuses a symlinked runtime-profile state directory before Docker or outside writes", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-state-symlink-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const outside = join(root, "outside");
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const candidate = writeRecord(releaseWithRuntimeProfile(profile));
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    mkdirSync(bin);
    symlinkSync(outside, join(state, "runtime-profiles"), "dir");
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(
      envFile,
      "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\n",
      { mode: 0o600 },
    );

    const result = run(
      "bash",
      [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile],
      {
        PATH: `${bin}:${process.env.PATH}`,
        ECHO_CLEAN_ENV_FILE: envFile,
        ECHO_CLEAN_RELEASE_STATE_DIR: state,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release-state directories are missing or unsafe");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("binds Authority image source to the OCI revision label before startup", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const update = readFileSync(UPDATE, "utf8");
    expect(dockerfile).toContain("ARG ECHO_SOURCE_SHA");
    expect(dockerfile).toContain('org.opencontainers.image.revision="${ECHO_SOURCE_SHA}"');
    expect(dockerfile).toContain(
      'org.echobrain.authority.state-capability.staging-synthetic-meeting-canary-v1="true"',
    );
    expect(update).toContain("org.opencontainers.image.revision");
    expect(update).toContain("image_source_matches \"$expected\" \"$expected_source\"");
  });

  it("builds an Authority image only from one clean committed source", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-image-build-"));
    roots.push(root);
    const repository = join(root, "repository");
    const tools = join(repository, "tools");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const dockerLog = join(root, "docker.log");
    mkdirSync(tools, { recursive: true });
    mkdirSync(bin);
    copyFileSync(AUTHORITY_IMAGE_BUILD, join(tools, "build-authority-image.mjs"));
    writeFileSync(join(repository, "tracked.txt"), "clean\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: repository }).status).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: repository }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        [
          "-c",
          "user.name=Echo Test",
          "-c",
          "user.email=echo@example.test",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: repository },
      ).status,
    ).toBe(0);
    const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ECHO_DOCKER_LOG"
if [[ "$1" == image && "$2" == inspect ]]; then
  printf '%s\\n' "$ECHO_FAKE_SOURCE_SHA"
fi
`,
    );
    chmodSync(docker, 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_DOCKER_LOG: dockerLog,
      ECHO_FAKE_SOURCE_SHA: sourceSha,
    };
    const clean = spawnSync(
      process.execPath,
      [join(tools, "build-authority-image.mjs"), "echo-authority:test"],
      { cwd: repository, encoding: "utf8", env: { ...process.env, ...environment } },
    );
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({
      image: "echo-authority:test",
      source_sha: sourceSha,
    });
    expect(readFileSync(dockerLog, "utf8")).toContain(
      `ECHO_SOURCE_SHA=${sourceSha}`,
    );

    const callsBeforeDirtyAttempt = readFileSync(dockerLog, "utf8");
    writeFileSync(join(repository, "tracked.txt"), "dirty\n");
    const dirty = spawnSync(
      process.execPath,
      [join(tools, "build-authority-image.mjs"), "echo-authority:test"],
      { cwd: repository, encoding: "utf8", env: { ...process.env, ...environment } },
    );
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("build requires clean, committed source");
    expect(readFileSync(dockerLog, "utf8")).toBe(callsBeforeDirtyAttempt);
  });

  it("refuses an Authority image whose OCI revision label differs before startup", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-image-source-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const up = join(root, "up-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const runtimeConfig = prepareRuntimeConfig(root, profile);
    const candidate = writeRecord(releaseWithRuntimeProfile(profile, {
      release_id: "clean-v1-20260822-002",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}` },
    }));
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"f".repeat(40)}'; exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then touch "${up}"; fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(envFile, "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\n");
    chmodSync(envFile, 0o600);

    const result = run("bash", [
      UPDATE,
      "stage",
      "--release",
      candidate,
      "--runtime-profile",
      profile,
    ], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
    });
    expect(result.status).toBe(1);
    expect(existsSync(up)).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("d".repeat(64));
  });

  it("verifies an exact artifact before installing it and uses the product status surface", () => {
    expect(run("bash", ["-n", INSTALL]).status).toBe(0);
    const source = readFileSync(INSTALL, "utf8");
    expect(source.indexOf("actual_sha")).toBeLessThan(source.lastIndexOf("npm install"));
    expect(source).toContain("--ignore-scripts");
    expect(source).toContain("--no-audit");
    expect(source).toContain("--no-fund");
    expect(source).toContain("--offline");
    expect(source).toContain('prefix="$HOME/.local"');
    expect(source).toContain("export PATH=");
    expect(source).toContain('"$prefix/bin/echo-brain" person status');
    expect(source).not.toContain("git clone");
    expect(source).not.toContain("session-install");
  });

  it("refuses an artifact digest mismatch before npm can install anything", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-install-"));
    roots.push(root);
    const archive = join(root, "client.tgz");
    const prefix = join(root, "prefix");
    const marker = join(root, "npm-called");
    const bin = join(root, "bin");
    const npm = join(bin, "npm");
    const node = join(bin, "node");
    const release = writeRecord(record());
    writeFileSync(archive, "not the recorded artifact");
    mkdirSync(bin);
    writeFileSync(npm, `#!/usr/bin/env bash\nif [[ "$1" == --version ]]; then printf '10.9.4\\n'; exit 0; fi\ntouch "${marker}"\n`);
    writeFileSync(node, "#!/usr/bin/env bash\nprintf 'v22.22.1\\n'\n");
    chmodSync(npm, 0o755);
    chmodSync(node, 0o755);

    const result = run(
      "bash",
      [INSTALL, "--release", release, "--prefix", prefix, "--artifact", archive],
      { PATH: `${bin}:${process.env.PATH}`, ECHO_TEST_NPM_MARKER: marker },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-256");
    expect(existsSync(marker)).toBe(false);
  });

  it("binds the installed package build identity to the release source commit", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-install-identity-"));
    roots.push(root);
    const archive = join(root, "client.tgz");
    const prefix = join(root, "prefix");
    const bin = join(root, "bin");
    const npm = join(bin, "npm");
    const node = join(bin, "node");
    const bytes = "correct artifact bytes";
    const artifactSha = createHash("sha256").update(bytes).digest("hex");
    const release = writeRecord(record({ person_client: { ...record().person_client, artifact_sha256: artifactSha } }));
    writeFileSync(archive, bytes);
    mkdirSync(bin);
    writeFileSync(node, "#!/usr/bin/env bash\nprintf 'v22.22.1\\n'\n");
    writeFileSync(
      npm,
      `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then printf '10.9.4\\n'; exit 0; fi
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" == --prefix ]]; then j=$((i + 1)); prefix="\${!j}"; fi
done
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@echo-brain/person-client/dist"
printf '#!/usr/bin/env bash\\nif [[ "$1" == --version ]]; then printf "0.1.0-internal.1\\\\n"; else printf "{}\\\\n"; fi\\n' > "$prefix/bin/echo-brain"
chmod 0755 "$prefix/bin/echo-brain"
printf '%s\\n' '{"schema_version":1,"kind":"echo-packaged-build-identity","product_version":"0.1.0-internal.1","source_sha":"${"f".repeat(40)}","source_kind":"materialized-commit"}' > "$prefix/lib/node_modules/@echo-brain/person-client/dist/build-identity.v1.json"
`,
    );
    chmodSync(node, 0o755);
    chmodSync(npm, 0o755);

    const result = run("bash", [INSTALL, "--release", release, "--prefix", prefix, "--artifact", archive], {
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build identity does not match");
    expect(result.stdout).not.toContain("a".repeat(40));
  });

  it("creates a zero-argument offline bundle and preserves an existing employee session on reinstall", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-clean-v1-offline-bundle-")));
    roots.push(root);
    const sourceSha = "a".repeat(40);
    const version = "0.1.0-internal.1";
    const artifact = join(root, "client.tgz");
    const output = join(root, "employee-bundle.tar.gz");
    const extracted = join(root, "extracted");
    const packageRoot = join(root, "package", "dist");
    const home = join(root, "employee-home");
    const session = join(home, ".local", "share", "echo-brain", "person", "session.v1.json");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "build-identity.v1.json"), JSON.stringify({
      schema_version: 1,
      kind: "echo-packaged-build-identity",
      product_version: version,
      source_sha: sourceSha,
      source_kind: "materialized-commit",
    }));
    expect(run("tar", ["-czf", artifact, "-C", root, "package"]).status).toBe(0);
    const artifactSha = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    const release = writeRecord(record({
      source_sha: sourceSha,
      person_client: { ...record().person_client, version, artifact_sha256: artifactSha },
    }));

    const bundled = run(process.execPath, [BUNDLE, "--release", release, "--artifact", artifact, "--output", output]);
    expect(bundled.status).toBe(0);
    const bundleReceipt = JSON.parse(bundled.stdout);
    expect(readFileSync(`${output}.sha256`, "utf8")).toBe(`${bundleReceipt.bundle_sha256}  ${basename(output)}\n`);
    mkdirSync(extracted);
    expect(run("tar", ["-xzf", output, "-C", extracted]).status).toBe(0);
    const members = run("tar", ["-tzf", output]).stdout.split("\n").filter(Boolean);
    expect([...members].sort()).toEqual([
      "echo-brain-person-client-clean-v1-20260822-001/",
      "echo-brain-person-client-clean-v1-20260822-001/clean-v1-release.py",
      "echo-brain-person-client-clean-v1-20260822-001/install.sh",
      "echo-brain-person-client-clean-v1-20260822-001/install-person-client-clean-v1.sh",
      "echo-brain-person-client-clean-v1-20260822-001/person-client.tgz",
      "echo-brain-person-client-clean-v1-20260822-001/release.json",
    ].sort());
    expect(members.join("\n")).not.toMatch(/authority|credential|secret|provider/i);

    mkdirSync(dirname(session), { recursive: true });
    writeFileSync(session, "existing-private-session");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const node = join(bin, "node");
    const npm = join(bin, "npm");
    writeFileSync(node, "#!/usr/bin/env bash\nprintf 'v22.22.1\\n'\n");
    writeFileSync(npm, [
      "#!/usr/bin/env bash",
      "if [[ \"$1\" == --version ]]; then printf '10.9.4\\n'; exit 0; fi",
      "for ((i=1; i<=$#; i++)); do",
      "  if [[ \"${!i}\" == --prefix ]]; then j=$((i + 1)); prefix=\"${!j}\"; fi",
      "done",
      "mkdir -p \"$prefix/bin\" \"$prefix/lib/node_modules/@echo-brain/person-client/dist\"",
      `printf '#!/usr/bin/env bash\\nif [[ \"$1\" == --version ]]; then printf \"${version}\\\\n\"; else printf \"{}\\\\n\"; fi\\n' > \"$prefix/bin/echo-brain\"`,
      "chmod 0755 \"$prefix/bin/echo-brain\"",
      `printf '%s\\n' '{\"schema_version\":1,\"kind\":\"echo-packaged-build-identity\",\"product_version\":\"${version}\",\"source_sha\":\"${sourceSha}\",\"source_kind\":\"materialized-commit\"}' > \"$prefix/lib/node_modules/@echo-brain/person-client/dist/build-identity.v1.json\"`,
      "",
    ].join("\n"));
    chmodSync(node, 0o755);
    chmodSync(npm, 0o755);
    const installed = run("bash", [join(extracted, "echo-brain-person-client-clean-v1-20260822-001", "install.sh")], {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
    });
    expect(installed.status).toBe(0);
    expect(readFileSync(session, "utf8")).toBe("existing-private-session");
  });

  it("creates one macOS-arm64 install-to-ready kit with a pinned Node runtime and no npm prerequisite", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "echo-person-onboarding-kit-")),
    );
    roots.push(root);
    const sourceSha = "a".repeat(40);
    const version = "0.1.0-internal.1";
    const artifact = join(root, "client.tgz");
    const output = join(root, "employee-kit.tar.gz");
    const runtime = join(root, "node");
    const packageRoot = join(root, "package", "dist");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "build-identity.v1.json"),
      JSON.stringify({
        schema_version: 1,
        kind: "echo-packaged-build-identity",
        product_version: version,
        source_sha: sourceSha,
        source_kind: "materialized-commit",
      }),
    );
    writeFileSync(join(packageRoot, "main.js"), "process.stdout.write('fixture\\n');\n");
    expect(run("tar", ["-czf", artifact, "-C", root, "package"]).status).toBe(0);
    const artifactSha = createHash("sha256")
      .update(readFileSync(artifact))
      .digest("hex");
    const release = writeRecord(
      record({
        source_sha: sourceSha,
        person_client: {
          ...record().person_client,
          version,
          artifact_sha256: artifactSha,
        },
      }),
    );
    writeFileSync(
      runtime,
      "#!/usr/bin/env bash\nprintf '%s\\n' '{\"version\":\"v22.22.1\",\"platform\":\"darwin\",\"architecture\":\"arm64\"}'\n",
    );
    chmodSync(runtime, 0o755);

    const built = run(process.execPath, [
      ONBOARDING_KIT,
      "--release",
      release,
      "--artifact",
      artifact,
      "--runtime-node",
      runtime,
      "--output",
      output,
    ]);
    expect(built.status).toBe(0);
    const receipt = JSON.parse(built.stdout);
    expect(receipt).toMatchObject({
      release_id: "clean-v1-20260822-001",
      client_version: version,
      platform: "darwin",
      architecture: "arm64",
      node_version: "v22.22.1",
    });
    expect(readFileSync(`${output}.sha256`, "utf8")).toBe(
      `${receipt.kit_sha256}  ${basename(output)}\n`,
    );
    const members = run("tar", ["-tzf", output]).stdout
      .split("\n")
      .filter(Boolean);
    expect(members).toContain(
      "echo-person-onboarding-clean-v1-20260822-001/Start ECHO.command",
    );
    expect(members).toContain(
      "echo-person-onboarding-clean-v1-20260822-001/node",
    );
    expect(members).toContain(
      "echo-person-onboarding-clean-v1-20260822-001/kit-manifest.v1.json",
    );
    const start = run("tar", [
      "-xOzf",
      output,
      "echo-person-onboarding-clean-v1-20260822-001/Start ECHO.command",
    ]).stdout;
    expect(start).toContain("person start");
    expect(start).toContain("Choose your ECHO invitation file");
    expect(start).not.toContain("npm ");
    expect(start).not.toContain("export PATH");
    expect(members.join("\n")).not.toMatch(
      /server-state|slack-bot|granola-credential|llm-credential/i,
    );
  });

  it("rejects an employee-kit runtime for the wrong platform before publishing", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-person-kit-runtime-")));
    roots.push(root);
    const runtime = join(root, "node");
    const artifact = join(root, "client.tgz");
    const output = join(root, "employee-kit.tar.gz");
    const packageRoot = join(root, "package", "dist");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "build-identity.v1.json"),
      JSON.stringify({
        schema_version: 1,
        kind: "echo-packaged-build-identity",
        product_version: "0.1.0-internal.1",
        source_sha: "a".repeat(40),
        source_kind: "materialized-commit",
      }),
    );
    expect(run("tar", ["-czf", artifact, "-C", root, "package"]).status).toBe(0);
    const artifactSha = createHash("sha256")
      .update(readFileSync(artifact))
      .digest("hex");
    const release = writeRecord(
      record({
        person_client: {
          ...record().person_client,
          artifact_sha256: artifactSha,
        },
      }),
    );
    writeFileSync(
      runtime,
      "#!/usr/bin/env bash\nprintf '%s\\n' '{\"version\":\"v22.22.1\",\"platform\":\"linux\",\"architecture\":\"x64\"}'\n",
    );
    chmodSync(runtime, 0o755);
    const rejected = run(process.execPath, [
      ONBOARDING_KIT,
      "--release",
      release,
      "--artifact",
      artifact,
      "--runtime-node",
      runtime,
      "--output",
      output,
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("v22.22.1 for macOS arm64");
    expect(existsSync(output)).toBe(false);
  });

  it("refuses noncanonical, digest-mismatched, and source-mismatched offline bundle inputs", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-clean-v1-offline-bundle-reject-")));
    roots.push(root);
    const artifact = join(root, "client.tgz");
    const output = join(root, "employee-bundle.tar.gz");
    const packageRoot = join(root, "package", "dist");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "build-identity.v1.json"), JSON.stringify({
      schema_version: 1,
      kind: "echo-packaged-build-identity",
      product_version: "0.1.0-internal.1",
      source_sha: "b".repeat(40),
      source_kind: "materialized-commit",
    }));
    expect(run("tar", ["-czf", artifact, "-C", root, "package"]).status).toBe(0);
    const artifactSha = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    const release = writeRecord(record({ person_client: { ...record().person_client, artifact_sha256: artifactSha } }));
    const badSource = run(process.execPath, [BUNDLE, "--release", release, "--artifact", artifact, "--output", output]);
    expect(badSource.status).toBe(1);
    expect(badSource.stderr).toContain("build identity does not match");
    expect(existsSync(output)).toBe(false);

    const noncanonical = writeRecord(record());
    writeFileSync(noncanonical, `${JSON.stringify(record())}\n`);
    expect(run(process.execPath, [BUNDLE, "--release", noncanonical, "--artifact", artifact, "--output", output]).status).toBe(1);
    expect(existsSync(output)).toBe(false);

    const badDigest = writeRecord(record({ person_client: { ...record().person_client, artifact_sha256: "d".repeat(64) } }));
    const digest = run(process.execPath, [BUNDLE, "--release", badDigest, "--artifact", artifact, "--output", output]);
    expect(digest.status).toBe(1);
    expect(digest.stderr).toContain("SHA-256");
    expect(existsSync(output)).toBe(false);
  });

  it("refuses symlinked or already-present output paths without replacing their targets", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-clean-v1-offline-output-")));
    roots.push(root);
    const targetDirectory = join(root, "target");
    const symlinkDirectory = join(root, "symlink");
    const protectedTarget = join(targetDirectory, "bundle.tar.gz");
    const existing = join(root, "existing.tar.gz");
    mkdirSync(targetDirectory, { mode: 0o700 });
    writeFileSync(protectedTarget, "do-not-replace");
    symlinkSync(targetDirectory, symlinkDirectory);
    writeFileSync(existing, "untrusted-input");
    const symlinked = run(process.execPath, [BUNDLE, "--release", existing, "--artifact", existing, "--output", join(symlinkDirectory, "bundle.tar.gz")]);
    expect(symlinked.status).toBe(1);
    expect(symlinked.stderr).toContain("canonical real directory");
    expect(readFileSync(protectedTarget, "utf8")).toBe("do-not-replace");

    chmodSync(targetDirectory, 0o755);
    const nonPrivate = run(process.execPath, [BUNDLE, "--release", existing, "--artifact", existing, "--output", join(targetDirectory, "new.tar.gz")]);
    expect(nonPrivate.status).toBe(1);
    expect(nonPrivate.stderr).toContain("current-user-owned mode 0700");
    chmodSync(targetDirectory, 0o700);

    const noReplace = run(process.execPath, [BUNDLE, "--release", existing, "--artifact", existing, "--output", existing]);
    expect(noReplace.status).toBe(1);
    expect(noReplace.stderr).toContain("already exists");
    expect(readFileSync(existing, "utf8")).toBe("untrusted-input");
  });

  it("checks the exact Node and npm versions before creating the install prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-install-version-"));
    roots.push(root);
    const prefix = join(root, "prefix");
    const bin = join(root, "bin");
    const node = join(bin, "node");
    const npm = join(bin, "npm");
    const release = writeRecord(record());
    mkdirSync(bin);
    writeFileSync(node, "#!/usr/bin/env bash\nprintf 'v20.0.0\\n'\n");
    writeFileSync(npm, "#!/usr/bin/env bash\nprintf '10.9.4\\n'\n");
    chmodSync(node, 0o755);
    chmodSync(npm, 0o755);

    const result = run("bash", [INSTALL, "--release", release, "--prefix", prefix, "--artifact", release], {
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node.js v22.22.1");
    expect(existsSync(prefix)).toBe(false);
  });

  it("refuses a baseline-mismatched candidate before Docker can mutate the deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-baseline-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const current = writeRecord(releaseWithRuntimeProfile(profile));
    const candidate = writeRecord({ ...record(), baseline_compatibility_class: "clean-v2" });
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(current, join(state, "current.clean-v1.json"));

    const result = run("bash", [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(envFile, "utf8")).toContain(record().authority_image.reference);
  });

  it("runs the candidate lineage verifier before mutating a malformed version-matching state", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-lineage-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const releaseState = join(root, "release-state");
    const stateDirectory = join(root, "state");
    const verifier = join(root, "lineage-verifier-called");
    const activation = join(root, "compose-activation-called");
    const dockerLog = join(root, "docker.log");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const candidate = writeRecord(
      releaseWithRuntimeProfile(profile, {
        release_id: "clean-v1-20260822-002",
        authority_image: {
          reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
        },
      }),
    );
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    // Its root has the old partial shape but all SQLite user_versions match.
    // The updater must delegate that malformed lineage to the candidate image,
    // rather than treating a version-only mirror as sufficient.
    writeCurrentStateLineage(stateDirectory);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dockerLog}"
if [[ "$1" == pull ]]; then exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then
  printf '%s\\n' '${"a".repeat(40)}'
  exit 0
fi
if [[ "$1" == run ]]; then touch "${verifier}"; exit 1; fi
if [[ "$1" == compose && ( "$*" == *" up "* || "$*" == *" restart "* ) ]]; then
  touch "${activation}"
fi
`,
    );
    chmodSync(docker, 0o755);
    const initialEnvironment = [
      `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}`,
      "ECHO_CLEAN_AUTHORITY_UID=1000",
      "ECHO_CLEAN_AUTHORITY_GID=1000",
      "",
    ].join("\n");
    writeFileSync(
      envFile,
      initialEnvironment,
      { mode: 0o600 },
    );

    const malformed = run(
      "bash",
      [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile],
      {
        PATH: `${bin}:${process.env.PATH}`,
        ECHO_CLEAN_ENV_FILE: envFile,
        ECHO_CLEAN_RELEASE_STATE_DIR: releaseState,
        ECHO_CLEAN_STATE_DIR: stateDirectory,
      },
    );
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("candidate Authority image rejected persisted state lineage");
    expect(existsSync(verifier)).toBe(true);
    expect(existsSync(activation)).toBe(false);
    expect(existsSync(join(releaseState, "candidate.clean-v1.json"))).toBe(false);
    expect(readdirSync(join(releaseState, "runtime-profiles"))).toEqual([]);
    expect(readdirSync(join(releaseState, "runtime-environments"))).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe(initialEnvironment);
    expect(readFileSync(candidate, "utf8")).toContain('"release_id":"clean-v1-20260822-002"');
    const dockerCalls = readFileSync(dockerLog, "utf8");
    expect(dockerCalls).toContain(
      "run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --workdir /app --entrypoint node",
    );
    expect(dockerCalls).toContain(
      `--mount type=bind,src=${stateDirectory},dst=/echo-clean/state,readonly`,
    );
    expect(dockerCalls).toContain("--input-type=module -e");
    expect(dockerCalls).toContain("verify-authority-state-lineage.js");
    expect(dockerCalls).toContain('verifyAuthorityStateLineage("/echo-clean/state")');
    expect(dockerCalls.indexOf("pull ")).toBeLessThan(
      dockerCalls.indexOf("run "),
    );
  });

  it("rejects a runtime-profile digest mismatch before Docker can mutate the deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-runtime-profile-mismatch-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const profile = writeRuntimeProfile();
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const candidate = writeRecord(
      releaseWithRuntimeProfile(profile, {
        release_id: "clean-v1-20260822-002",
        authority_image: {
          reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
        },
      }),
    );
    const changedProfile = writeRuntimeProfile(
      "a".repeat(40),
      "\n# changed after the release record was created\n",
    );
    copyFileSync(changedProfile, profile);
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(
      envFile,
      "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\nECHO_CLEAN_AUTHORITY_HOST=authority.example.test\n",
    );
    chmodSync(envFile, 0o600);

    const result = run("bash", [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: root,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime profile SHA-256 does not match the release record");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
  });

  it("stages and promotes the first deployment without a manually installed current record", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-first-deploy-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const started = join(root, "started");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const candidateRecord = releaseWithRuntimeProfile(profile, {
      release_id: "clean-v1-20260822-002",
      authority_image: {
        reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
      },
    });
    const candidate = writeRecord(candidateRecord);
    const runtimeConfig = prepareRuntimeConfig(root, profile);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then
  [[ -f "${started}" ]] && printf 'authority-container\\n'
  exit 0
fi
if [[ "$1" == compose && "$*" == *" ps -q proxy"* ]]; then printf 'proxy-container\\n'; exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then touch "${started}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.release-id'* ]]; then sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.runtime-profile-sha256'* ]]; then sed -n 's/^ECHO_CLEAN_RUNTIME_PROFILE_SHA256=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"e".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${candidateRecord.authority_image.reference}'; exit 0; fi
if [[ "$1" == compose && "$*" == *"staging-private-dm-canary"* ]]; then
  release_id="$(sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}")"
  printf '{"schema_version":1,"kind":"echo-staging-synthetic-private-dm-canary-receipt-v1","release_id":"%s","approval_outcome":"staged","approval_id":"approval-canary"}\\n' "$release_id"
  exit 0
fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(envFile, "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\nECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org\n");
    chmodSync(envFile, 0o600);

    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
    };
    const staged = run("bash", [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile], environment);
    expect(staged.status).toBe(0);
    expect(staged.stdout).toContain('"accepted_release_present":false');
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    expect(existsSync(join(state, "current.clean-v1.json"))).toBe(false);
    expect(readFileSync(envFile, "utf8")).toContain(candidateRecord.authority_image.reference);

    const refused = run("bash", [UPDATE, "promote", "--release", candidate, "--canary-passed"], environment);
    expect(refused.status).toBe(1);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    const canary = run("bash", [UPDATE, "canary"], environment);
    expect(canary.status).toBe(0);
    const promoted = run("bash", [UPDATE, "promote", "--release", candidate, "--canary-passed"], environment);
    expect(promoted.status).toBe(0);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "current.clean-v1.json"))).toBe(true);
  });

  it.each([
    ["delivery_pending", "delivery is still pending", '"approval_outcome":"delivery_pending","approval_id":"approval-canary"'],
    ["not_actionable", "did not stage a private approval card: not_actionable", '"approval_outcome":"not_actionable"'],
  ])("aborts a first-deployment candidate after a %s canary and permits a new stage", (_outcome, expectedFailure, outcomeFields) => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-first-deploy-abort-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const started = join(root, "started");
    const mismatchedRuntime = join(root, "mismatched-runtime");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const firstProfile = writeRuntimeProfile();
    const nextProfile = writeRuntimeProfile("a".repeat(40), "\n# next candidate\n");
    const first = releaseWithRuntimeProfile(firstProfile, {
      release_id: "clean-v1-20260822-005",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}` },
    });
    const next = releaseWithRuntimeProfile(nextProfile, {
      release_id: "clean-v1-20260822-006",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"e".repeat(64)}` },
    });
    const firstCandidate = writeRecord(first);
    const nextCandidate = writeRecord(next);
    const runtimeConfig = prepareRuntimeConfig(root, firstProfile);
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash
if [[ "$1" == compose ]] && grep -q 'interrupted activation' "${runtimeConfig}/compose.clean-v1.yaml"; then exit 44; fi
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then [[ -f "${started}" ]] && printf 'authority-container\\n'; exit 0; fi
if [[ "$1" == compose && "$*" == *" ps -q proxy"* ]]; then [[ -f "${started}" ]] && printf 'proxy-container\\n'; exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then touch "${started}"; exit 0; fi
if [[ "$1" == compose && "$*" == *" down"* ]]; then rm -f "${started}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.release-id'* ]]; then [[ -f "${mismatchedRuntime}" ]] && { printf 'wrong-release\\n'; exit 0; }; sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.runtime-profile-sha256'* ]]; then sed -n 's/^ECHO_CLEAN_RUNTIME_PROFILE_SHA256=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"f".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${first.authority_image.reference}' '${next.authority_image.reference}'; exit 0; fi
if [[ "$1" == compose && "$*" == *"staging-private-dm-canary"* ]]; then release_id="$(sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}")"; printf '{"schema_version":1,"kind":"echo-staging-synthetic-private-dm-canary-receipt-v1","release_id":"%s",${outcomeFields}}\\n' "$release_id"; exit 0; fi
`);
    chmodSync(docker, 0o755);
    writeFileSync(envFile, "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\nECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org\n", { mode: 0o600 });
    const environment = { PATH: `${bin}:${process.env.PATH}`, ECHO_CLEAN_ENV_FILE: envFile, ECHO_CLEAN_RELEASE_STATE_DIR: state, ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig };
    expect(run("bash", [UPDATE, "stage", "--release", firstCandidate, "--runtime-profile", firstProfile], environment).status).toBe(0);
    const canary = run("bash", [UPDATE, "canary"], environment);
    expect(canary.status).toBe(1);
    expect(canary.stderr).toContain(expectedFailure);
    // A running runtime that no longer proves the staged tuple must not be
    // treated as safely stopped or archived.
    writeFileSync(mismatchedRuntime, "yes\n");
    const refused = run("bash", [UPDATE, "rollback"], environment);
    expect(refused.status).toBe(1);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-005.json"))).toBe(false);
    rmSync(mismatchedRuntime);
    // Simulate an interruption after the runtime stop and immutable failed
    // record publish, but before the staged candidate was removed. The active
    // environment, profile, and one materialized file are also incomplete.
    rmSync(started);
    writeFileSync(envFile, "interrupted activation\n", { mode: 0o600 });
    writeFileSync(activeRuntimeProfile(state), "interrupted activation\n", {
      mode: 0o600,
    });
    writeFileSync(
      join(runtimeConfig, "Caddyfile.clean-v1"),
      "interrupted activation\n",
    );
    writeFileSync(
      join(runtimeConfig, "compose.clean-v1.yaml"),
      "interrupted activation\n",
    );
    mkdirSync(join(state, "failed"), { recursive: true });
    copyFileSync(
      join(state, "candidate.clean-v1.json"),
      join(state, "failed", "clean-v1-20260822-005.json"),
    );
    chmodSync(join(state, "failed", "clean-v1-20260822-005.json"), 0o600);
    expect(run("bash", [UPDATE, "rollback"], environment).stdout).toContain('"stage":"aborted"');
    expect(existsSync(started)).toBe(false);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "current.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-005.json"))).toBe(true);
    expect(run("bash", [UPDATE, "stage", "--release", nextCandidate, "--runtime-profile", nextProfile], environment).status).toBe(0);
  });

  it("keeps a first-deployment candidate staged when an automatic stop fails", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-first-deploy-stop-retry-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const stopAttempted = join(root, "stop-attempted");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const candidate = writeRecord(releaseWithRuntimeProfile(profile, { release_id: "clean-v1-20260822-008", authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}` } }));
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then exit 1; fi
if [[ "$1" == compose && "$*" == *" down"* ]]; then touch "${stopAttempted}"; exit 1; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
`);
    chmodSync(docker, 0o755);
    writeFileSync(envFile, "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\n", { mode: 0o600 });
    const result = run("bash", [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile], { PATH: `${bin}:${process.env.PATH}`, ECHO_CLEAN_ENV_FILE: envFile, ECHO_CLEAN_RELEASE_STATE_DIR: state, ECHO_CLEAN_RUNTIME_CONFIG_DIR: prepareRuntimeConfig(root, profile) });
    expect(result.stderr).toContain("candidate stop could not be confirmed");
    expect(existsSync(stopAttempted)).toBe(true);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-008.json"))).toBe(false);
  });

  it("rejects a misrouted public descriptor before accepting a first deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-public-descriptor-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const started = join(root, "started");
    const log = join(root, "docker.log");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const candidateRecord = releaseWithRuntimeProfile(profile, {
      release_id: "clean-v1-20260822-004",
      authority_image: {
        reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
      },
    });
    const candidate = writeRecord(candidateRecord);
    const runtimeConfig = prepareRuntimeConfig(root, profile);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then
  [[ -f "${started}" ]] && printf 'authority-container\\n'
  exit 0
fi
if [[ "$1" == compose && "$*" == *" ps -q proxy"* ]]; then printf 'proxy-container\\n'; exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then touch "${started}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.release-id'* ]]; then sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.runtime-profile-sha256'* ]]; then sed -n 's/^ECHO_CLEAN_RUNTIME_PROFILE_SHA256=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"e".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${candidateRecord.authority_image.reference}'; exit 0; fi
if [[ "$1" == compose && "$*" == *" exec "* && "$*" == *"https://authority.example.test/v1/authority-descriptor"* ]]; then
  # The proxy served a valid-shaped descriptor, but from the wrong Authority.
  exit 1
fi
if [[ "$1" == compose && "$*" == *" exec "* ]]; then exit 0; fi
if [[ "$1" == compose && "$*" == *" down"* ]]; then exit 0; fi
`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(
      envFile,
      "ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local\nECHO_CLEAN_AUTHORITY_HOST=authority.example.test\n",
      { mode: 0o600 },
    );

    const result = run(
      "bash",
      [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile],
      {
        PATH: `${bin}:${process.env.PATH}`,
        ECHO_CLEAN_ENV_FILE: envFile,
        ECHO_CLEAN_RELEASE_STATE_DIR: state,
        ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("candidate failed health/setup checks");
    expect(existsSync(join(state, "current.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-004.json"))).toBe(true);
    expect(readFileSync(log, "utf8")).toContain(
      "https://authority.example.test/v1/authority-descriptor",
    );
  });

  it("requires an accepted-image rollback reader before an upgrade canary creates state", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-canary-rollback-reader-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const invoked = join(root, "canary-invoked");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const acceptedProfile = writeRuntimeProfile();
    const candidateProfile = writeRuntimeProfile("a".repeat(40), "\n# candidate\n");
    const accepted = releaseWithRuntimeProfile(acceptedProfile);
    const candidate = releaseWithRuntimeProfile(candidateProfile, {
      release_id: "clean-v1-20260822-007",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}` },
    });
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *"staging-private-dm-canary"* ]]; then touch "${invoked}"; fi
`);
    chmodSync(docker, 0o755);
    installActiveTuple(state, envFile, candidate, candidateProfile);
    copyFileSync(writeRecord(accepted), join(state, "current.clean-v1.json"));
    copyFileSync(writeRecord(candidate), join(state, "candidate.clean-v1.json"));
    const result = run("bash", [UPDATE, "canary"], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: prepareRuntimeConfig(root, candidateProfile),
    });
    expect(result.stderr).toContain("rollback-read capability");
    expect(existsSync(invoked)).toBe(false);
  });

  it("binds routine promotion to staged canary evidence and recovers a promotion crash", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-promote-retry-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const acceptedProfile = writeRuntimeProfile();
    const nextProfile = writeRuntimeProfile("a".repeat(40), "\n# next profile\n");
    const accepted = releaseWithRuntimeProfile(acceptedProfile, {
      release_id: "clean-v1-20260822-002",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}` },
    });
    const next = releaseWithRuntimeProfile(nextProfile, {
      release_id: "clean-v1-20260822-003",
      authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"e".repeat(64)}` },
    });
    const acceptedPath = writeRecord(accepted);
    const nextPath = writeRecord(next);
    const runtimeConfig = prepareRuntimeConfig(root, acceptedProfile);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then printf 'authority-container\\n'; exit 0; fi
if [[ "$1" == compose && "$*" == *" ps -q proxy"* ]]; then printf 'proxy-container\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.release-id'* ]]; then sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.runtime-profile-sha256'* ]]; then sed -n 's/^ECHO_CLEAN_RUNTIME_PROFILE_SHA256=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"f".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.echobrain.authority.state-capability.staging-synthetic-meeting-canary-v1'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${accepted.authority_image.reference}' '${next.authority_image.reference}'; exit 0; fi
if [[ "$1" == compose && "$*" == *"staging-private-dm-canary"* ]]; then
  release_id="$(sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}")"
  printf '{"schema_version":1,"kind":"echo-staging-synthetic-private-dm-canary-receipt-v1","release_id":"%s","approval_outcome":"staged","approval_id":"approval-canary"}\\n' "$release_id"
  exit 0
fi
`,
    );
    chmodSync(docker, 0o755);
    const acceptedEnvironment = `ECHO_CLEAN_AUTHORITY_IMAGE=${accepted.authority_image.reference}
ECHO_CLEAN_AUTHORITY_HOST=authority-staging.echobrain.org
ECHO_CLEAN_RELEASE_ID=${accepted.release_id}
ECHO_CLEAN_RELEASE_SOURCE_SHA=${accepted.source_sha}
ECHO_CLEAN_RUNTIME_PROFILE_SHA256=${accepted.runtime_profile.artifact_sha256}
ECHO_CLEAN_RUNTIME_PROFILE_VERSION=${accepted.runtime_profile.profile_version}
`;
    writeFileSync(envFile, acceptedEnvironment, { mode: 0o600 });
    mkdirSync(state, { recursive: true });
    mkdirSync(join(state, "runtime-profiles"), { recursive: true });
    mkdirSync(join(state, "runtime-environments"), { recursive: true });
    copyFileSync(acceptedPath, join(state, "current.clean-v1.json"));
    copyFileSync(acceptedPath, join(state, "candidate.clean-v1.json"));
    copyFileSync(acceptedProfile, acceptedRuntimeProfile(state, String(accepted.release_id)));
    copyFileSync(acceptedProfile, activeRuntimeProfile(state));
    writeFileSync(
      acceptedRuntimeEnvironment(state, String(accepted.release_id)),
      acceptedEnvironment,
      { mode: 0o600 },
    );
    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
    };

    writeCanaryReceipt(state, String(accepted.release_id));
    const retry = run("bash", [UPDATE, "promote", "--release", acceptedPath, "--canary-passed"], environment);
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('"idempotent":true');
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "history", "clean-v1-20260822-002.json"))).toBe(false);

    const staged = run("bash", [UPDATE, "stage", "--release", nextPath, "--runtime-profile", nextProfile], environment);
    expect(staged.status).toBe(0);
    const refusedWithoutEvidence = run(
      "bash",
      [UPDATE, "promote", "--release", nextPath, "--canary-passed"],
      environment,
    );
    expect(refusedWithoutEvidence.status).toBe(1);
    expect(refusedWithoutEvidence.stderr).toContain(
      "requires a private-DM canary receipt for the exact staged candidate",
    );
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);

    const pendingReceipt = writeCanaryReceipt(
      state,
      String(next.release_id),
      "delivery_pending",
    );
    const refusedPending = run(
      "bash",
      [UPDATE, "promote", "--release", nextPath, "--canary-passed"],
      environment,
    );
    expect(refusedPending.status).toBe(1);
    expect(refusedPending.stderr).toContain(
      "requires a staged private-DM canary for the exact candidate",
    );
    rmSync(pendingReceipt);

    const canary = run("bash", [UPDATE, "canary"], environment);
    expect(canary.status).toBe(0);
    expect(canary.stdout).toContain('"approval_outcome":"staged"');
    const storedReceipt = canaryReceiptPath(state, String(next.release_id));
    expect(readFileSync(storedReceipt, "utf8")).toContain(
      `"release_id":"${next.release_id}"`,
    );
    expect(statSync(storedReceipt).mode & 0o777).toBe(0o600);

    const storedAcceptedProfile = acceptedRuntimeProfile(
      state,
      String(accepted.release_id),
    );
    rmSync(storedAcceptedProfile);
    const refused = run(
      "bash",
      [UPDATE, "promote", "--release", nextPath, "--canary-passed"],
      environment,
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("stored runtime profile is missing or unsafe");
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    copyFileSync(acceptedProfile, storedAcceptedProfile);
    // Simulate a promotion interruption after immutable history publication.
    mkdirSync(join(state, "history"), { recursive: true });
    writeFileSync(
      join(state, "history", "clean-v1-20260822-002.json"),
      "conflicting history record\n",
      { mode: 0o600 },
    );
    const conflicted = run("bash", [UPDATE, "promote", "--release", nextPath, "--canary-passed"], environment);
    expect(conflicted.status).toBe(1);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    copyFileSync(
      acceptedPath,
      join(state, "history", "clean-v1-20260822-002.json"),
    );
    chmodSync(join(state, "history", "clean-v1-20260822-002.json"), 0o600);
    const promoted = run("bash", [UPDATE, "promote", "--release", nextPath, "--canary-passed"], environment);
    expect(promoted.status).toBe(0);
    expect(existsSync(join(state, "history", "clean-v1-20260822-002.json"))).toBe(true);
  });

  it("rejects a reused release ID before Docker can mutate the deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-reuse-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const profile = writeRuntimeProfile();
    const candidate = writeRecord(releaseWithRuntimeProfile(profile));
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(envFile, `ECHO_CLEAN_AUTHORITY_IMAGE=${record().authority_image.reference}\n`);
    chmodSync(envFile, 0o600);
    mkdirSync(join(state, "history"), { recursive: true });
    copyFileSync(candidate, join(state, "history", "clean-v1-20260822-001.json"));

    const result = run("bash", [UPDATE, "stage", "--release", candidate, "--runtime-profile", profile], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release_id was already used");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not claim an accepted release while a staged candidate has a corrupt current record", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-status-current-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const profile = writeRuntimeProfile();
    const candidateRecord = releaseWithRuntimeProfile(profile, {
      release_id: "clean-v1-20260822-002",
    });
    const candidate = writeRecord(candidateRecord);
    mkdirSync(state, { recursive: true });
    const runtimeConfig = prepareRuntimeConfig(root, profile);
    installActiveTuple(state, envFile, candidateRecord, profile);
    copyFileSync(candidate, join(state, "candidate.clean-v1.json"));
    writeFileSync(join(state, "current.clean-v1.json"), "not a release record\n");

    const result = run("bash", [UPDATE, "status"], {
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("clean-v1 release record");
  });

  it("does not claim an accepted release through a current-record symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-status-symlink-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const profile = writeRuntimeProfile();
    const candidateRecord = releaseWithRuntimeProfile(profile, {
      release_id: "clean-v1-20260822-002",
    });
    const candidate = writeRecord(candidateRecord);
    mkdirSync(state, { recursive: true });
    const runtimeConfig = prepareRuntimeConfig(root, profile);
    installActiveTuple(state, envFile, candidateRecord, profile);
    copyFileSync(candidate, join(state, "candidate.clean-v1.json"));
    symlinkSync(candidate, join(state, "current.clean-v1.json"));

    const result = run("bash", [UPDATE, "status"], {
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("regular file");
  });

  it("reports runtime-profile drift before claiming the accepted release is healthy", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-runtime-profile-status-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const profile = writeRuntimeProfile();
    const marker = join(root, "docker-called");
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const accepted = releaseWithRuntimeProfile(profile);
    const acceptedPath = writeRecord(accepted);
    mkdirSync(bin);
    writeFileSync(docker, `#!/usr/bin/env bash\ntouch "${marker}"\n`);
    chmodSync(docker, 0o755);
    writeFileSync(
      envFile,
      `ECHO_CLEAN_AUTHORITY_IMAGE=${accepted.authority_image.reference}\nECHO_CLEAN_AUTHORITY_HOST=authority.example.test\n`,
    );
    chmodSync(envFile, 0o600);
    mkdirSync(state, { recursive: true });
    copyFileSync(acceptedPath, join(state, "current.clean-v1.json"));
    copyFileSync(
      writeRuntimeProfile("a".repeat(40), "\n# drifted\n"),
      activeRuntimeProfile(state),
    );

    const result = run("bash", [UPDATE, "status"], {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: root,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime profile drifted from the accepted release record");
    expect(existsSync(marker)).toBe(false);
  });

  it("rolls back the accepted image, runtime profile, proxy, and public descriptor together", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-runtime-profile-rollback-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const log = join(root, "docker.log");
    const count = join(root, "up-count");
    const proxyRestarted = join(root, "proxy-restarted");
    const currentProfile = writeRuntimeProfile();
    const candidateProfile = writeRuntimeProfile(
      "a".repeat(40),
      "\n# candidate profile\n",
    );
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const currentRecord = releaseWithRuntimeProfile(currentProfile);
    const candidateRecord = releaseWithRuntimeProfile(candidateProfile, {
      release_id: "clean-v1-20260822-002",
      authority_image: {
        reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
      },
    });
    const current = writeRecord(currentRecord);
    const candidate = writeRecord(candidateRecord);
    const runtimeConfig = prepareRuntimeConfig(root, currentProfile);
    mkdirSync(bin);
    mkdirSync(join(state, "runtime-profiles"), { recursive: true });
    mkdirSync(join(state, "runtime-environments"), { recursive: true });
    copyFileSync(
      currentProfile,
      acceptedRuntimeProfile(state, String(currentRecord.release_id)),
    );
    copyFileSync(currentProfile, activeRuntimeProfile(state));
    const currentEnvironment = `ECHO_CLEAN_AUTHORITY_IMAGE=${currentRecord.authority_image.reference}
ECHO_CLEAN_AUTHORITY_HOST=authority.example.test
ECHO_CLEAN_RELEASE_ID=${currentRecord.release_id}
ECHO_CLEAN_RELEASE_SOURCE_SHA=${currentRecord.source_sha}
ECHO_CLEAN_RUNTIME_PROFILE_SHA256=${currentRecord.runtime_profile.artifact_sha256}
ECHO_CLEAN_RUNTIME_PROFILE_VERSION=${currentRecord.runtime_profile.profile_version}
`;
    writeFileSync(envFile, currentEnvironment, { mode: 0o600 });
    writeFileSync(
      acceptedRuntimeEnvironment(state, String(currentRecord.release_id)),
      currentEnvironment,
      { mode: 0o600 },
    );
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then printf 'authority-container\\n'; exit 0; fi
if [[ "$1" == compose && "$*" == *" ps -q proxy"* ]]; then printf 'proxy-container\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.release-id'* ]]; then sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.runtime-profile-sha256'* ]]; then sed -n 's/^ECHO_CLEAN_RUNTIME_PROFILE_SHA256=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"e".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then
  printf '%s\\n' '${currentRecord.authority_image.reference}' '${candidateRecord.authority_image.reference}'
  exit 0
fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then
  if [[ ! -f "${count}" ]]; then
    cmp -s "${activeRuntimeProfile(state)}" "${candidateProfile}" || exit 31
    touch "${count}"
    exit 1
  fi
  cmp -s "${activeRuntimeProfile(state)}" "${currentProfile}" || exit 32
  exit 0
fi
if [[ "$1" == compose && "$*" == *" restart proxy"* ]]; then touch "${proxyRestarted}"; exit 0; fi
if [[ "$1" == compose && "$*" == *" exec "* ]]; then exit 0; fi
`,
    );
    chmodSync(docker, 0o755);
    mkdirSync(state, { recursive: true });
    copyFileSync(current, join(state, "current.clean-v1.json"));

    const result = run(
      "bash",
      [UPDATE, "stage", "--release", candidate, "--runtime-profile", candidateProfile],
      {
        PATH: `${bin}:${process.env.PATH}`,
        ECHO_CLEAN_ENV_FILE: envFile,
        ECHO_CLEAN_RELEASE_STATE_DIR: state,
        ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("previous accepted release tuple was restored and verified");
    expect(readFileSync(envFile, "utf8")).toContain(
      currentRecord.authority_image.reference,
    );
    expect(readFileSync(activeRuntimeProfile(state))).toEqual(
      readFileSync(currentProfile),
    );
    expect(existsSync(proxyRestarted)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain(" restart proxy");
    expect(readFileSync(log, "utf8")).toContain(
      "https://authority.example.test/v1/authority-descriptor",
    );
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(true);
  });

  it("keeps a staged candidate through a transient rollback failure so rollback can be retried", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-v1-rollback-retry-"));
    roots.push(root);
    const envFile = join(root, ".env.clean-v1");
    const state = join(root, "release-state");
    const count = join(root, "up-count");
    const currentProfile = writeRuntimeProfile();
    const bin = join(root, "bin");
    const docker = join(bin, "docker");
    const currentRecord = releaseWithRuntimeProfile(currentProfile);
    const candidateProfile = writeRuntimeProfile("a".repeat(40), "\n# candidate profile\n");
    const candidateRecord = releaseWithRuntimeProfile(candidateProfile, {
      release_id: "clean-v1-20260822-002",
      authority_image: {
        reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"d".repeat(64)}`,
      },
    });
    const current = writeRecord(currentRecord);
    const candidate = writeRecord(candidateRecord);
    const runtimeConfig = prepareRuntimeConfig(root, currentProfile);
    mkdirSync(bin);
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
if [[ "$1" == compose && "$*" == *" ps -q authority"* ]]; then printf 'authority-container\\n'; exit 0; fi
if [[ "$1" == compose && "$*" == *" ps -q proxy"* ]]; then printf 'proxy-container\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.State.Running'* ]]; then printf 'true\\n'; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.release-id'* ]]; then sed -n 's/^ECHO_CLEAN_RELEASE_ID=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'io.echo-brain.runtime-profile-sha256'* ]]; then sed -n 's/^ECHO_CLEAN_RUNTIME_PROFILE_SHA256=//p' "${envFile}"; exit 0; fi
if [[ "$1" == inspect && "$*" == *'.Image'* ]]; then printf 'sha256:${"e".repeat(64)}\\n'; exit 0; fi
if [[ "$1" == image && "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s\\n' '${"a".repeat(40)}'; exit 0; fi
if [[ "$1" == image ]]; then printf '%s\\n' '${currentRecord.authority_image.reference}' '${candidateRecord.authority_image.reference}'; exit 0; fi
if [[ "$1" == compose && "$*" == *" up "* ]]; then
  if [[ ! -f "${count}" ]]; then touch "${count}"; exit 1; fi
fi
`,
    );
    chmodSync(docker, 0o755);
    mkdirSync(state, { recursive: true });
    installActiveTuple(state, envFile, currentRecord, currentProfile);
    copyFileSync(current, join(state, "current.clean-v1.json"));
    copyFileSync(candidate, join(state, "candidate.clean-v1.json"));
    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_CLEAN_ENV_FILE: envFile,
      ECHO_CLEAN_RELEASE_STATE_DIR: state,
      ECHO_CLEAN_RUNTIME_CONFIG_DIR: runtimeConfig,
    };

    const failed = run("bash", [UPDATE, "rollback"], environment);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("candidate remains staged");
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(true);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(false);

    // Simulate an interruption after publishing the immutable failed record.
    mkdirSync(join(state, "failed"), { recursive: true });
    copyFileSync(
      join(state, "candidate.clean-v1.json"),
      join(state, "failed", "clean-v1-20260822-002.json"),
    );
    chmodSync(join(state, "failed", "clean-v1-20260822-002.json"), 0o600);
    const retried = run("bash", [UPDATE, "rollback"], environment);
    expect(retried.status).toBe(0);
    expect(existsSync(join(state, "candidate.clean-v1.json"))).toBe(false);
    expect(existsSync(join(state, "failed", "clean-v1-20260822-002.json"))).toBe(true);
  });
});
