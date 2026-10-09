import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, it, type ExpectStatic } from "vitest";
import { canonicalJsonForTest as canonical } from "../support/test-canonical-json.js";

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

afterAll(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function writePrivate(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
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
  writePrivate(join(deploy, ".env.clean-v1"), environment);
  writePrivate(
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
  );
  writePrivate(join(release, "runtime-profile.active"), profile);
  writePrivate(join(release, "runtime-profiles", `${releaseId}.profile`), profile);
  writePrivate(join(release, "runtime-environments", `${releaseId}.env`), environment);
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
    lock: join(data, ".authority-operation-lock"),
    guard: join(deploy, ".staging-release-guard"),
    marker: (name: "down" | "restart" | "proxy-restart") => join(root, name),
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

type Subject = ReturnType<typeof fixture>;
type RunResult = { status: number | null; stdout: string; stderr: string };

/** Spawns the maintenance script without blocking, so the suite's tests overlap their idle waits. */
function run(args: readonly string[], environment: Record<string, string | undefined>) {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("bash", [MAINTENANCE, ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function writeStatus(subject: Subject, fields: Record<string, unknown>) {
  const maintenance = join(subject.data, "backup-maintenance");
  mkdirSync(maintenance, { mode: 0o700 });
  writePrivate(join(maintenance, "status.json"), JSON.stringify(fields) + "\n");
  return maintenance;
}

function dropRuntimeProfile(subject: Subject) {
  const current = join(subject.data, "release", "current.clean-v1.json");
  const legacy = JSON.parse(readFileSync(current, "utf8")) as Record<
    string,
    unknown
  >;
  delete legacy.runtime_profile;
  writePrivate(current, `${canonical(legacy)}\n`);
}

describe.concurrent("current-host backup maintenance transaction", () => {
  it("documents the canonical installed deployment path for durable execution", ({ expect }) => {
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

  it("bounds the durable unit beyond the maximum acknowledgement and restart proof", ({ expect }) => {
    const script = readFileSync(MAINTENANCE, "utf8");
    const runbook = readFileSync(RECOVERY_RUNBOOK, "utf8");
    for (const source of [script, runbook]) {
      expect(source).toContain("TimeoutStartSec=3900");
      expect(source).toContain("TimeoutStopSec=300");
    }
    expect(script).toContain("ack-timeout-seconds <1-3600>");
    expect(script).toContain("--wait-timeout 90 authority proxy");
  });

  it("serializes every onboarding mutation with the same fail-closed lock", ({ expect }) => {
    const source = readFileSync(ONBOARD, "utf8");
    for (const operation of ["prepare", "replace_rehearsal", "resume"]) {
      const start = source.indexOf(`\n${operation}() {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = source.indexOf("\n}\n", start);
      expect(source.slice(start, next)).toContain("acquire_operation_lock");
    }
  });

  it.for<[
    string,
    {
      readonly args: readonly string[];
      readonly arrange: (subject: Subject) => void;
      readonly message: string;
      readonly extra?: (subject: Subject, result: RunResult, expect: ExpectStatic) => void;
    },
  ]>([
    ["when another operation owns the shared lock", {
      args: ["maintain", "--ack-timeout-seconds", "30"],
      arrange: (subject) => {
        mkdirSync(subject.lock, { mode: 0o700 });
        writePrivate(join(subject.lock, "owner-pid"), "99999999\n");
      },
      message: "another Authority activation or release operation",
    }],
    ["while the bounded release root guard is held", {
      args: ["maintain", "--ack-timeout-seconds", "1"],
      arrange: (subject) => {
        mkdirSync(subject.guard, { mode: 0o700 });
        writePrivate(join(subject.guard, "owner-pid"), "99999999\n");
      },
      message: "root-owned guard",
      extra: (subject, _result, expect) => {
        expect(readFileSync(join(subject.guard, "owner-pid"), "utf8")).toBe("99999999\n");
        expect(existsSync(subject.lock)).toBe(false);
      },
    }],
    ["a pre-runtime-profile release through preflight", {
      args: ["preflight"],
      arrange: dropRuntimeProfile,
      message: "accepted release record is not canonical clean-v1",
      extra: (subject, _result, expect) => expect(existsSync(subject.lock)).toBe(false),
    }],
    ["a pre-runtime-profile release through maintain", {
      args: ["maintain", "--ack-timeout-seconds", "1"],
      arrange: dropRuntimeProfile,
      message: "accepted release record is not canonical clean-v1",
      extra: (subject, _result, expect) => expect(existsSync(subject.lock)).toBe(false),
    }],
    ["to overwrite an explicit recovery_required status with a new transaction", {
      args: ["maintain", "--ack-timeout-seconds", "1"],
      arrange: (subject) => {
        writeStatus(subject, {
          schema_version: 1,
          operation_id: "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa",
          coordinator_nonce: "b".repeat(48),
          state: "recovery_required",
          reason: "restart_proof_failed",
        });
      },
      message: "requires deliberate recovery",
    }],
    ["a malformed maintenance status with a sanitized failure", {
      args: ["maintain", "--ack-timeout-seconds", "1"],
      arrange: (subject) => {
        const maintenance = join(subject.data, "backup-maintenance");
        mkdirSync(maintenance, { mode: 0o700 });
        writePrivate(join(maintenance, "status.json"), "not-json\n");
      },
      message: "backup maintenance status is unavailable or unsafe",
      extra: (subject, result, expect) => {
        expect(result.stderr).not.toContain("Traceback");
        expect(result.stderr).not.toContain(subject.root);
      },
    }],
    ["deployed Compose profile drift", {
      args: ["maintain", "--ack-timeout-seconds", "1"],
      arrange: (subject) =>
        writeFileSync(
          join(subject.deploy, "compose.clean-v1.yaml"),
          "services: { drift: {} }\n",
        ),
      message: "deployed runtime profile files drifted",
    }],
    ["full environment snapshot drift", {
      args: ["maintain", "--ack-timeout-seconds", "1"],
      arrange: (subject) =>
        writePrivate(
          join(subject.deploy, ".env.clean-v1"),
          `${readFileSync(join(subject.deploy, ".env.clean-v1"), "utf8")}ECHO_CLEAN_UNTRACKED=drift\n`,
        ),
      message: "environment drifted from the accepted release snapshot",
    }],
  ])("refuses %s before any outage", async ([, { args, arrange, message, extra }], { expect }) => {
    const subject = fixture();
    arrange(subject);

    const result = await run(args, subject.environment);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(existsSync(subject.marker("down"))).toBe(false);
    expect(existsSync(subject.marker("restart"))).toBe(false);
    extra?.(subject, result, expect);
  });

  it("proves the complete accepted tuple without stopping or restarting the Authority", async ({ expect }) => {
    const subject = fixture();

    const result = await run(["preflight"], subject.environment);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("maintenance_preflight_ready=true\n");
    expect(result.stderr).toBe("");
    expect(existsSync(subject.guard)).toBe(false);
    expect(existsSync(subject.marker("down"))).toBe(false);
    expect(existsSync(subject.marker("restart"))).toBe(false);
    expect(existsSync(subject.lock)).toBe(false);
  });

  it("does not report readiness when the preflight lock cannot be removed", async ({ expect }) => {
    const subject = fixture();
    const rmdir = join(subject.root, "bin", "rmdir");
    writeFileSync(
      rmdir,
      `#!/usr/bin/env bash
exit 1
`,
      { mode: 0o755 },
    );

    const result = await run(["preflight"], subject.environment);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("maintenance_preflight_ready=true");
    expect(result.stderr).toContain(
      "could not release the Authority operation lock",
    );
    expect(existsSync(subject.marker("down"))).toBe(false);
    expect(existsSync(subject.marker("restart"))).toBe(false);
    expect(existsSync(subject.lock)).toBe(true);
  });

  // Sequential: its 10s acknowledgement guard must not compete with sibling processes.
  it.sequential("accepts only the current operation nonce before restarting without a pull", async ({ expect }) => {
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
    expect(existsSync(join(subject.guard, "owner-pid"))).toBe(true);
    const acknowledgement = await run(
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
    expect(existsSync(subject.guard)).toBe(false);
    expect(existsSync(subject.marker("restart"))).toBe(true);
    expect(existsSync(subject.lock)).toBe(false);
    const status = readFileSync(
      join(subject.data, "backup-maintenance", "status.json"),
      "utf8",
    );
    expect(status).toContain('"state":"complete"');
    expect(status).toContain('"maintainer_pid":');
    expect(status).toContain('"acknowledgement_deadline_epoch_seconds":');
  });

  it("restarts and proves the accepted tuple after an acknowledgement timeout, releasing the lock only after recovery", async ({ expect }) => {
    const subject = fixture();
    const result = await run(
      ["maintain", "--ack-timeout-seconds", "1"],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(existsSync(subject.marker("down"))).toBe(true);
    expect(existsSync(subject.marker("restart"))).toBe(true);
    expect(existsSync(subject.marker("proxy-restart"))).toBe(true);
    expect(existsSync(subject.lock)).toBe(false);
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

  it("keeps the shared lock and records recovery_required when no-pull restart proof fails", async ({ expect }) => {
    const subject = fixture();
    const result = await run(["maintain", "--ack-timeout-seconds", "1"], {
      ...subject.environment,
      ECHO_TEST_RESTART_FAIL: "true",
    });

    expect(result.status).toBe(1);
    expect(existsSync(subject.marker("down"))).toBe(true);
    expect(existsSync(subject.marker("restart"))).toBe(true);
    expect(existsSync(join(subject.guard, "owner-pid"))).toBe(true);
    expect(existsSync(subject.lock)).toBe(true);
    const status = readFileSync(
      join(subject.data, "backup-maintenance", "status.json"),
      "utf8",
    );
    expect(status).toContain('"state":"recovery_required"');
  });

  it("rejects an acknowledgement whose nonce belongs to no current waiting operation", async ({ expect }) => {
    const subject = fixture();
    const maintenance = writeStatus(subject, {
      schema_version: 1,
      operation_id: "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa",
      coordinator_nonce: "b".repeat(48),
      state: "awaiting_external_ack",
      reason: null,
    });

    const result = await run(
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

  it("rejects a late acknowledgement even before the maintainer flips status", async ({ expect }) => {
    const subject = fixture();
    const operationId = "backup-20260825T120000Z-aaaaaaaaaaaaaaaaaaaaaaaa";
    const nonce = "b".repeat(48);
    const maintenance = writeStatus(subject, {
      schema_version: 1,
      operation_id: operationId,
      coordinator_nonce: nonce,
      maintainer_pid: process.pid,
      maintainer_started_at_epoch_seconds: 1,
      acknowledgement_deadline_epoch_seconds: 0,
      state: "awaiting_external_ack",
      reason: null,
    });

    const result = await run(
      ["acknowledge", "--operation-id", operationId, "--nonce", nonce],
      subject.environment,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("acknowledgement deadline has passed");
    expect(existsSync(join(maintenance, `${operationId}.ack`))).toBe(false);
  });
});
