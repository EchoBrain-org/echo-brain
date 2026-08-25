import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const MAINTENANCE = join(
  REPO,
  "deploy",
  "organization-authority",
  "backup-authority-maintenance.sh",
);
const RELEASE_TOOL = join(REPO, "deploy", "release", "clean-v1-release.py");
const ONBOARD = join(
  REPO,
  "deploy",
  "organization-authority",
  "onboard-clean-v1.sh",
);
const RUNTIME_PROFILE_TOOL = join(
  REPO,
  "deploy",
  "release",
  "clean-v1-runtime-profile.py",
);
const RECOVERY_RUNBOOK = join(
  REPO,
  "docs",
  "operations",
  "RB-OPERATIONS-002-authority-recovery-floor.md",
);
const RELEASE_README = join(REPO, "deploy", "release", "README.md");
const AUTHORITY_README = join(
  REPO,
  "deploy",
  "organization-authority",
  "README.md",
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "echo-backup-maintenance-"));
  roots.push(root);
  const deploy = join(root, "deploy");
  const data = join(deploy, "clean-data");
  const release = join(data, "release");
  const bin = join(root, "bin");
  mkdirSync(release, { recursive: true, mode: 0o700 });
  mkdirSync(join(release, "runtime-profiles"), { mode: 0o700 });
  mkdirSync(join(release, "runtime-environments"), { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(deploy, "compose.clean-v1.yaml"), "services: {}\n");
  writeFileSync(join(deploy, "compose.clean-v1.ec2.yaml"), "services: {}\n");
  writeFileSync(join(deploy, "Caddyfile.clean-v1"), "");
  writeFileSync(join(deploy, "Caddyfile.clean-v1.ec2"), "");
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:${"b".repeat(64)}`;
  const source = "a".repeat(40);
  const releaseId = "clean-v1-20260822-001";
  const profile =
    canonical({
      schema_version: 1,
      kind: "echo-clean-v1-runtime-profile",
      source_sha: source,
      files: {
        "Caddyfile.clean-v1": "",
        "Caddyfile.clean-v1.ec2": "",
        "compose.clean-v1.ec2.yaml": "services: {}\n",
        "compose.clean-v1.yaml": "services: {}\n",
      },
    }) + "\n";
  const profileSha = createHash("sha256").update(profile).digest("hex");
  const environment =
    [
      `ECHO_CLEAN_AUTHORITY_IMAGE=${image}`,
      `ECHO_CLEAN_RELEASE_ID=${releaseId}`,
      `ECHO_CLEAN_RELEASE_SOURCE_SHA=${source}`,
      `ECHO_CLEAN_RUNTIME_PROFILE_SHA256=${profileSha}`,
      "ECHO_CLEAN_AUTHORITY_HOST=authority.example.test",
    ].join("\n") + "\n";
  writeFileSync(join(deploy, ".env.clean-v1"), environment, { mode: 0o600 });
  writeFileSync(
    join(release, "current.clean-v1.json"),
    canonical({
      schema_version: 1,
      kind: "echo-clean-v1-release",
      release_id: releaseId,
      released_at: "2026-08-22T20:00:00Z",
      baseline_compatibility_class: "clean-v1",
      source_sha: source,
      authority_image: { reference: image },
      person_client: {
        package: "@echo-brain/person-client",
        version: "0.1.0-internal.1",
        artifact_url: "https://downloads.example.test/client.tgz",
        artifact_sha256: "c".repeat(64),
      },
      runtime_profile: {
        artifact_url: "https://downloads.example.test/runtime-profile.json",
        artifact_sha256: profileSha,
        profile_version: "clean-v1-profile-1",
      },
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(join(release, "runtime-profile.active"), profile, {
    mode: 0o600,
  });
  writeFileSync(
    join(release, "runtime-profiles", `${releaseId}.profile`),
    profile,
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(release, "runtime-environments", `${releaseId}.env`),
    environment,
    { mode: 0o600 },
  );
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
root="$ECHO_TEST_ROOT"
if [[ "$1" == compose ]]; then
  if [[ "$args" == *" ps -aq authority"* || "$args" == *" ps -aq proxy"* ]]; then
    [[ -e "$root/stopped" ]] || printf '%s\\n' "container-id"
    exit 0
  fi
  if [[ "$args" == *" ps -q authority"* ]]; then
    [[ -e "$root/stopped" ]] || printf '%s\\n' "authority-id"
    exit 0
  fi
  if [[ "$args" == *" ps -q proxy"* ]]; then
    [[ -e "$root/stopped" ]] || printf '%s\\n' "proxy-id"
    exit 0
  fi
  if [[ "$args" == *" down --remove-orphans"* ]]; then
    touch "$root/down"
    touch "$root/stopped"
    [[ "\${ECHO_TEST_DOWN_FAIL:-false}" == true ]] && exit 1
    exit 0
  fi
  if [[ "$args" == *" up -d "* ]]; then
    touch "$root/restart"
    rm -f "$root/stopped"
    [[ "\${ECHO_TEST_RESTART_FAIL:-false}" == true ]] && exit 1
    exit 0
  fi
  if [[ "$args" == *" restart proxy"* ]]; then
    touch "$root/proxy-restart"
    [[ "\${ECHO_TEST_RESTART_FAIL:-false}" == true ]] && exit 1
    exit 0
  fi
  if [[ "$args" == *"clean-founder-main.js status "* ]]; then
    printf '%s\\n' '{"next_step":"complete"}'
    exit 0
  fi
  if [[ "$args" == *" exec -T authority node -e "* ]]; then exit 0; fi
fi
if [[ "$1" == inspect ]]; then
  if [[ "$args" == *".State.Running"* ]]; then printf '%s\\n' true; exit 0; fi
  if [[ "$args" == *"State.Health"* ]]; then printf '%s\\n' healthy; exit 0; fi
  if [[ "$args" == *"io.echo-brain.release-id"* ]]; then printf '%s\\n' clean-v1-20260822-001; exit 0; fi
  if [[ "$args" == *"io.echo-brain.runtime-profile-sha256"* ]]; then printf '%s\\n' '${profileSha}'; exit 0; fi
  if [[ "$args" == *"{{.Image}}"* ]]; then printf '%s\\n' 'sha256:${"d".repeat(64)}'; exit 0; fi
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$args" == *"RepoDigests"* ]]; then printf '%s\\n' '${image}'; exit 0; fi
  if [[ "$args" == *"org.opencontainers.image.revision"* ]]; then printf '%s\\n' '${source}'; exit 0; fi
fi
printf 'unexpected docker invocation: %s\\n' "$args" >&2
exit 1
`,
  );
  chmodSync(docker, 0o755);
  return {
    root,
    deploy,
    data,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ECHO_TEST_ROOT: root,
      ECHO_CLEAN_MAINTENANCE_DEPLOY_DIR: deploy,
      ECHO_CLEAN_RELEASE_TOOL: RELEASE_TOOL,
      ECHO_CLEAN_RUNTIME_PROFILE_TOOL: RUNTIME_PROFILE_TOOL,
    },
  };
}

function run(args: string[], environment: Record<string, string | undefined>) {
  return spawnSync("bash", [MAINTENANCE, ...args], {
    encoding: "utf8",
    env: environment,
  });
}

describe("current-host backup maintenance transaction", () => {
  it("documents the canonical installed deployment path for durable execution", () => {
    const source = readFileSync(MAINTENANCE, "utf8");
    const releaseReadme = readFileSync(RELEASE_README, "utf8");
    const authorityReadme = readFileSync(AUTHORITY_README, "utf8");
    expect(source).toContain(
      "/srv/echo-authority-clean-v1/backup-authority-maintenance.sh",
    );
    expect(source).not.toContain("/opt/echo-brain");
    expect(releaseReadme).toContain("install -o root -g root -m 0755 \\");
    expect(releaseReadme).toContain("./backup-authority-maintenance.sh");
    expect(releaseReadme).toContain(
      "sha256sum ./backup-authority-maintenance.sh",
    );
    expect(authorityReadme).toContain(
      "/srv/echo-authority-clean-v1/backup-authority-maintenance.sh",
    );
    expect(authorityReadme).toContain("mode `0755`");
  });

  it("bounds the durable unit beyond the maximum acknowledgement and restart proof", () => {
    const script = readFileSync(MAINTENANCE, "utf8");
    const runbook = readFileSync(RECOVERY_RUNBOOK, "utf8");
    for (const source of [script, runbook]) {
      expect(source).toContain("TimeoutStartSec=3900");
      expect(source).toContain("TimeoutStopSec=300");
    }
    expect(script).toContain("ack-timeout-seconds <1-3600>");
    expect(script).toContain("--wait-timeout 90 authority proxy");
  });

  it("serializes every onboarding mutation with the same fail-closed lock", () => {
    const source = readFileSync(ONBOARD, "utf8");
    for (const operation of ["prepare", "replace_rehearsal", "resume"]) {
      const start = source.indexOf(`\n${operation}() {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = source.indexOf("\n}\n", start);
      expect(source.slice(start, next)).toContain("acquire_operation_lock");
    }
  });

  it("uses the shared lock and refuses to touch Docker when another operation owns it", () => {
    const subject = fixture();
    const lock = join(subject.data, ".authority-operation-lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner-pid"), "99999999\n", { mode: 0o600 });

    const result = run(
      ["maintain", "--ack-timeout-seconds", "30"],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "another Authority activation or release operation",
    );
    expect(existsSync(join(subject.root, "down"))).toBe(false);
    expect(existsSync(join(subject.root, "restart"))).toBe(false);
  });

  it("will not overwrite an explicit recovery_required status with a new transaction", () => {
    const subject = fixture();
    const maintenance = join(subject.data, "backup-maintenance");
    mkdirSync(maintenance, { mode: 0o700 });
    writeFileSync(
      join(maintenance, "status.json"),
      JSON.stringify({
        schema_version: 1,
        operation_id: "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa",
        coordinator_nonce: "b".repeat(48),
        state: "recovery_required",
        reason: "restart_proof_failed",
      }) + "\n",
      { mode: 0o600 },
    );

    const result = run(
      ["maintain", "--ack-timeout-seconds", "1"],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires deliberate recovery");
    expect(existsSync(join(subject.root, "down"))).toBe(false);
  });

  it("sanitizes malformed maintenance status failures before Docker is touched", () => {
    const subject = fixture();
    const maintenance = join(subject.data, "backup-maintenance");
    mkdirSync(maintenance, { mode: 0o700 });
    writeFileSync(join(maintenance, "status.json"), "not-json\n", {
      mode: 0o600,
    });

    const result = run(
      ["maintain", "--ack-timeout-seconds", "1"],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "backup maintenance status is unavailable or unsafe",
    );
    expect(result.stderr).not.toContain("Traceback");
    expect(result.stderr).not.toContain(subject.root);
    expect(existsSync(join(subject.root, "down"))).toBe(false);
  });

  it("refuses deployed Compose profile drift before it can stop the Authority", () => {
    const subject = fixture();
    writeFileSync(
      join(subject.deploy, "compose.clean-v1.yaml"),
      "services: { drift: {} }\n",
    );

    const result = run(
      ["maintain", "--ack-timeout-seconds", "1"],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deployed runtime profile files drifted");
    expect(existsSync(join(subject.root, "down"))).toBe(false);
  });

  it("refuses full environment snapshot drift before it can stop the Authority", () => {
    const subject = fixture();
    writeFileSync(
      join(subject.deploy, ".env.clean-v1"),
      `${readFileSync(join(subject.deploy, ".env.clean-v1"), "utf8")}ECHO_CLEAN_UNTRACKED=drift\n`,
      { mode: 0o600 },
    );

    const result = run(
      ["maintain", "--ack-timeout-seconds", "1"],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "environment drifted from the accepted release snapshot",
    );
    expect(existsSync(join(subject.root, "down"))).toBe(false);
  });

  it("accepts only the current operation nonce before restarting without a pull", async () => {
    const subject = fixture();
    const child = spawn(
      "bash",
      [MAINTENANCE, "maintain", "--ack-timeout-seconds", "30"],
      {
        env: subject.environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const operation = await new Promise<{ id: string; nonce: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(
            new Error(`maintenance never awaited acknowledgement: ${stderr}`),
          );
        }, 10_000);
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          const id = /^operation_id=(.+)$/m.exec(stdout)?.[1];
          const nonce = /^coordinator_nonce=(.+)$/m.exec(stdout)?.[1];
          if (id && nonce) {
            clearTimeout(timer);
            resolve({ id, nonce });
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.once("error", reject);
      },
    );
    const closed = new Promise<{ code: number | null; stderr: string }>(
      (resolve) => child.once("close", (code) => resolve({ code, stderr })),
    );
    const acknowledgement = run(
      [
        "acknowledge",
        "--operation-id",
        operation.id,
        "--nonce",
        operation.nonce,
      ],
      subject.environment,
    );
    expect(acknowledgement.status).toBe(0);
    const result = await closed;

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(stdout).toContain("maintenance_complete=true");
    expect(existsSync(join(subject.root, "restart"))).toBe(true);
    expect(existsSync(join(subject.data, ".authority-operation-lock"))).toBe(
      false,
    );
    const status = readFileSync(
      join(subject.data, "backup-maintenance", "status.json"),
      "utf8",
    );
    expect(status).toContain('"state":"complete"');
    expect(status).toContain('"maintainer_pid":');
    expect(status).toContain('"acknowledgement_deadline_epoch_seconds":');
  });

  it("restarts and proves the accepted tuple after an acknowledgement timeout, releasing the lock only after recovery", () => {
    const subject = fixture();
    const result = run(
      ["maintain", "--ack-timeout-seconds", "1"],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(existsSync(join(subject.root, "down"))).toBe(true);
    expect(existsSync(join(subject.root, "restart"))).toBe(true);
    expect(existsSync(join(subject.root, "proxy-restart"))).toBe(true);
    expect(existsSync(join(subject.data, ".authority-operation-lock"))).toBe(
      false,
    );
    const status = readFileSync(
      join(subject.data, "backup-maintenance", "status.json"),
      "utf8",
    );
    expect(status).toContain('"state":"recovered_after_interruption"');
    expect(readFileSync(MAINTENANCE, "utf8")).toContain("--pull never");
    expect(readFileSync(MAINTENANCE, "utf8")).toContain(
      "trap 'signal_exit 143' TERM",
    );
  });

  it("keeps the shared lock and records recovery_required when no-pull restart proof fails", () => {
    const subject = fixture();
    const result = run(["maintain", "--ack-timeout-seconds", "1"], {
      ...subject.environment,
      ECHO_TEST_RESTART_FAIL: "true",
    });

    expect(result.status).toBe(1);
    expect(existsSync(join(subject.root, "down"))).toBe(true);
    expect(existsSync(join(subject.root, "restart"))).toBe(true);
    expect(existsSync(join(subject.data, ".authority-operation-lock"))).toBe(
      true,
    );
    const status = readFileSync(
      join(subject.data, "backup-maintenance", "status.json"),
      "utf8",
    );
    expect(status).toContain('"state":"recovery_required"');
  });

  it("rejects an acknowledgement whose nonce belongs to no current waiting operation", () => {
    const subject = fixture();
    const maintenance = join(subject.data, "backup-maintenance");
    mkdirSync(maintenance, { mode: 0o700 });
    writeFileSync(
      join(maintenance, "status.json"),
      JSON.stringify({
        schema_version: 1,
        operation_id: "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa",
        coordinator_nonce: "b".repeat(48),
        state: "awaiting_external_ack",
        reason: null,
      }) + "\n",
      { mode: 0o600 },
    );

    const result = run(
      [
        "acknowledge",
        "--operation-id",
        "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa",
        "--nonce",
        "c".repeat(48),
      ],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "does not match the current waiting operation",
    );
    expect(
      existsSync(
        join(
          maintenance,
          "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa.ack",
        ),
      ),
    ).toBe(false);
  });

  it("rejects a late acknowledgement even before the maintainer flips status", () => {
    const subject = fixture();
    const maintenance = join(subject.data, "backup-maintenance");
    const operationId = "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa";
    const nonce = "b".repeat(48);
    mkdirSync(maintenance, { mode: 0o700 });
    writeFileSync(
      join(maintenance, "status.json"),
      JSON.stringify({
        schema_version: 1,
        operation_id: operationId,
        coordinator_nonce: nonce,
        maintainer_pid: process.pid,
        maintainer_started_at_epoch_seconds: 1,
        acknowledgement_deadline_epoch_seconds: 0,
        state: "awaiting_external_ack",
        reason: null,
      }) + "\n",
      { mode: 0o600 },
    );

    const result = run(
      ["acknowledge", "--operation-id", operationId, "--nonce", nonce],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("acknowledgement deadline has passed");
    expect(existsSync(join(maintenance, `${operationId}.ack`))).toBe(false);
  });
});
