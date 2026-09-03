import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const DEPLOYMENT = "deploy/organization-authority";
const RUNTIME_PROFILE_FILES = [
  "Caddyfile.clean-v1",
  "Caddyfile.clean-v1.ec2",
  "compose.clean-v1.ec2.yaml",
  "compose.clean-v1.yaml",
] as const;

function deploymentFile(name: string): string {
  return readFileSync(resolve(REPO, DEPLOYMENT, name), "utf8");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function runtimeProfile(sourceSha: string) {
  const files = Object.fromEntries(
    RUNTIME_PROFILE_FILES.map((name) => [name, deploymentFile(name)]),
  );
  const bytes = `${canonicalJson({
    files,
    kind: "echo-clean-v1-runtime-profile",
    schema_version: 1,
    source_sha: sourceSha,
  })}\n`;
  return {
    bytes,
    digest: createHash("sha256").update(bytes, "utf8").digest("hex"),
    files,
  };
}

function releaseRecord({
  image,
  profile,
  releaseId,
  source,
}: {
  image: string;
  profile: ReturnType<typeof runtimeProfile>;
  releaseId: string;
  source: string;
}): string {
  return `${canonicalJson({
    authority_image: { reference: image },
    baseline_compatibility_class: "clean-v1",
    kind: "echo-clean-v1-release",
    person_client: {
      artifact_sha256: "b".repeat(64),
      artifact_url: "https://downloads.example/echo-brain-person-client.tgz",
      package: "@echo-brain/person-client",
      version: "0.1.0-internal.1",
    },
    release_id: releaseId,
    released_at: "2026-08-23T00:00:00Z",
    runtime_profile: {
      artifact_sha256: profile.digest,
      artifact_url: "https://downloads.example/echo-brain-runtime-profile.json",
      profile_version: "clean-v1-profile-1",
    },
    schema_version: 1,
    source_sha: source,
  })}\n`;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`timed out waiting for test marker ${path}`);
}

function preparedStatusFixture() {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-status-"));
  const deploy = join(root, "deploy", "organization-authority");
  const release = join(deploy, "release");
  const privateDir = join(deploy, "clean-data", "private");
  const stateCredentialDir = join(
    deploy,
    "clean-data",
    "state",
    "credentials",
  );
  const durableSentinel = join(deploy, "clean-data", "state", "durable-sentinel");
  const releaseDir = join(deploy, "clean-data", "release");
  const bin = join(root, "bin");
  const calls = join(root, "docker-calls");
  const failedUpMarker = join(root, "failed-first-up");
  const installWaitMarker = join(root, "credential-install-waiting");
  const installReleaseMarker = join(root, "credential-install-release");
  const image = "123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const source = "c".repeat(40);
  const releaseId = "clean-v1-status-test";
  const profile = runtimeProfile(source);
  mkdirSync(release, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(stateCredentialDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const file of [
    "onboard-clean-v1.sh",
    ...RUNTIME_PROFILE_FILES,
  ]) {
    copyFileSync(resolve(REPO, DEPLOYMENT, file), join(deploy, file));
  }
  copyFileSync(
    resolve(REPO, "deploy/release/clean-v1-release.py"),
    join(release, "clean-v1-release.py"),
  );
  copyFileSync(
    resolve(REPO, "deploy/release/clean-v1-runtime-profile.py"),
    join(release, "clean-v1-runtime-profile.py"),
  );
  chmodSync(join(deploy, "onboard-clean-v1.sh"), 0o755);
  const record = releaseRecord({ image, profile, releaseId, source });
  writeFileSync(join(releaseDir, "current.clean-v1.json"), record);
  const profilesDir = join(releaseDir, "runtime-profiles");
  const environmentsDir = join(releaseDir, "runtime-environments");
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(environmentsDir, { recursive: true });
  writeFileSync(join(profilesDir, `${releaseId}.profile`), profile.bytes);
  writeFileSync(join(releaseDir, "runtime-profile.active"), profile.bytes);
  for (const name of RUNTIME_PROFILE_FILES) {
    writeFileSync(join(deploy, name), profile.files[name]);
  }
  const environmentRecord = [
    `ECHO_CLEAN_AUTHORITY_IMAGE=${image}`,
    `ECHO_CLEAN_RELEASE_ID=${releaseId}`,
    `ECHO_CLEAN_RUNTIME_PROFILE_SHA256=${profile.digest}`,
    "ECHO_CLEAN_RUNTIME_PROFILE_VERSION=clean-v1-profile-1",
  ].join("\n") + "\n";
  writeFileSync(
    join(deploy, ".env.clean-v1"),
    environmentRecord,
  );
  writeFileSync(
    join(environmentsDir, `${releaseId}.env`),
    environmentRecord,
  );
  chmodSync(privateDir, 0o700);
  const privateFiles: Record<string, string> = {
    "onboard-clean-v1.conf": `runtime_user=${execFileSync("id", ["-un"]).toString().trim()}\nauthority_url=https://authority.example\n`,
    "oidc-config.json": "fixture",
    "oidc-client-secret": "fixture",
    "slack-bot-token": "fixture",
    "slack-signing-secret": "fixture",
    "granola-credential-source": `grn_${"a".repeat(40)}`,
    "granola-owner-email": "founder@example.com",
    "llm-credential-source": "b".repeat(43),
  };
  for (const [name, value] of Object.entries(privateFiles)) {
    writeFileSync(join(privateDir, name), value);
    chmodSync(join(privateDir, name), 0o600);
  }
  chmodSync(stateCredentialDir, 0o700);
  writeFileSync(
    join(stateCredentialDir, "granola-credential"),
    privateFiles["granola-credential-source"]!,
    { mode: 0o600 },
  );
  writeFileSync(
    join(stateCredentialDir, "llm-credential"),
    privateFiles["llm-credential-source"]!,
    { mode: 0o600 },
  );
  writeFileSync(durableSentinel, "durable-work-must-survive");
  const fakeDocker = join(bin, "docker");
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [[ "$1" == compose && "$2" == version ]]; then exit 0; fi
if [[ "$1" == compose ]]; then
  case " $* " in
    *" up -d --no-build --wait --wait-timeout 90 "*)
      if [[ "$ECHO_FAKE_FAIL_FIRST_UP" == true && ! -f ${JSON.stringify(failedUpMarker)} ]]; then
        touch ${JSON.stringify(failedUpMarker)}
        exit 1
      fi
      exit 0
      ;;
    *" credentials-install "*)
      install -m 0600 ${JSON.stringify(join(privateDir, "granola-credential-source"))} ${JSON.stringify(join(stateCredentialDir, "granola-credential"))}
      install -m 0600 ${JSON.stringify(join(privateDir, "llm-credential-source"))} ${JSON.stringify(join(stateCredentialDir, "llm-credential"))}
      if [[ "$ECHO_FAKE_WAIT_DURING_INSTALL" == true ]]; then
        printf '%s\n' "$PPID" > ${JSON.stringify(installWaitMarker)}
        wait_attempts=0
        while [[ ! -f ${JSON.stringify(installReleaseMarker)} && "$wait_attempts" -lt 500 ]]; do
          sleep 0.01
          wait_attempts=$((wait_attempts + 1))
        done
        [[ -f ${JSON.stringify(installReleaseMarker)} ]] || exit 1
      fi
      printf '%s\\n' '{"ok":true,"credentials_ready":true}'
      exit 0
      ;;
    *" run "*) printf '%s\\n' "$ECHO_FAKE_SETUP_STATUS"; exit 0 ;;
    *" ps -q authority "*) printf '%s\\n' fake-authority; exit 0 ;;
    *" ps -q proxy "*) printf '%s\\n' fake-proxy; exit 0 ;;
  esac
  exit 0
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$*" == *RepoDigests* ]]; then printf '%s\\n' "$ECHO_FAKE_REPO_DIGEST"; exit 0; fi
  if [[ "$*" == *org.opencontainers.image.revision* ]]; then printf '%s\\n' "$ECHO_FAKE_SOURCE"; exit 0; fi
  printf '%s\\n' sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  exit 0
fi
if [[ "$1" == inspect ]]; then
  if [[ "$*" == *io.echo-brain.release-id* ]]; then printf '%s\\n' "$ECHO_FAKE_RELEASE_ID"; exit 0; fi
  if [[ "$*" == *io.echo-brain.runtime-profile-sha256* ]]; then printf '%s\\n' "$ECHO_FAKE_RUNTIME_PROFILE_SHA256"; exit 0; fi
  if [[ "$*" == *.State.Running* ]]; then printf '%s\\n' "$ECHO_FAKE_RUNNING"; exit 0; fi
  if [[ "$*" == *.State.Health* ]]; then printf '%s\\n' "$ECHO_FAKE_HEALTH"; exit 0; fi
  if [[ "$*" == *.Image* ]]; then printf '%s\\n' sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; exit 0; fi
fi
exit 1
`,
  );
  chmodSync(fakeDocker, 0o755);
  writeFileSync(
    join(bin, "mountpoint"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  chmodSync(join(bin, "mountpoint"), 0o755);
  writeFileSync(
    join(bin, "cp"),
    `#!/usr/bin/env bash
if [[ "$ECHO_FAKE_FAIL_REHEARSAL_ARCHIVE" == true && "$*" == *"clean-data/."* && "$*" == *"retired-rehearsals"* ]]; then
  exit 1
fi
exec /bin/cp "$@"
`,
  );
  chmodSync(join(bin, "cp"), 0o755);
  const environment = (overrides: Record<string, string>) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ECHO_FAKE_REPO_DIGEST: image,
    ECHO_FAKE_SOURCE: source,
    ECHO_FAKE_RELEASE_ID: releaseId,
    ECHO_FAKE_RUNTIME_PROFILE_SHA256: profile.digest,
    ECHO_FAKE_RUNNING: "true",
    ECHO_FAKE_HEALTH: "healthy",
    ECHO_FAKE_SETUP_STATUS: '{"next_step":"complete"}',
    ECHO_FAKE_FAIL_FIRST_UP: "false",
    ECHO_FAKE_FAIL_REHEARSAL_ARCHIVE: "false",
    ECHO_FAKE_WAIT_DURING_INSTALL: "false",
    ...overrides,
  });
  const run = (
    command:
      | "activate-provider-credentials"
      | "replace-rehearsal"
      | "status"
      | "resume",
    overrides: Record<string, string> = {},
    args: readonly string[] = [],
  ) =>
    spawnSync("bash", [join(deploy, "onboard-clean-v1.sh"), command, ...args], {
      encoding: "utf8",
      env: environment(overrides),
    });
  const spawnRun = (
    command: "activate-provider-credentials",
    overrides: Record<string, string>,
    args: readonly string[],
  ) =>
    spawn("bash", [join(deploy, "onboard-clean-v1.sh"), command, ...args], {
      env: environment(overrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    root,
    deploy,
    privateDir,
    stateCredentialDir,
    durableSentinel,
    releaseDir,
    calls,
    installWaitMarker,
    installReleaseMarker,
    image,
    profile,
    releaseId,
    source,
    run,
    spawnRun,
  };
}

describe("clean-v1 Organization Authority deployment profile", () => {
  it("keeps server onboarding in one resumable wrapper with fixed private inputs", () => {
    const wrapper = resolve(REPO, DEPLOYMENT, "onboard-clean-v1.sh");
    const source = readFileSync(wrapper, "utf8");
    const guide = deploymentFile("README.md");

    expect(() => execFileSync("bash", ["-n", wrapper])).not.toThrow();
    expect(source).toContain("doctor) shift; doctor");
    expect(source).toContain("prepare) shift; prepare");
    expect(source).toContain(
      "activate-provider-credentials) shift; activate_provider_credentials",
    );
    expect(source).toContain('redirect: "error"');
    expect(source).toContain(".authority-operation-lock");
    expect(source).toContain("resume) [[ $# -eq 1 ]] || usage; resume");
    expect(source).toContain("status) [[ $# -eq 1 ]] || usage; status");
    expect(source).toContain("compose.clean-v1.yaml");
    expect(source).toContain("compose.clean-v1.ec2.yaml");
    expect(source).toContain('PRIVATE_DIR="$DATA_DIR/private"');
    expect(source).toContain("granola-owner-email");
    expect(source).toContain("clean-v1-release.py");
    expect(source).toContain('$DEPLOY_DIR/release/clean-v1-release.py');
    expect(source).toContain("clean-v1-runtime-profile.py");
    expect(source).toContain('$DEPLOY_DIR/release/clean-v1-runtime-profile.py');
    expect(source).toContain("runtime-profile.json");
    expect(source).toContain("runtime_profile_matches_prepared_tuple");
    expect(source).toContain("service_uses_accepted_runtime_profile authority");
    expect(source).toContain("service_uses_accepted_runtime_profile proxy");
    expect(source).toContain("< \"$PRIVATE_DIR/slack-bot-token\"");
    expect(source).toContain("slack-signing-secret");
    expect(source).toContain("Interactivity & Shortcuts");
    expect(deploymentFile("compose.clean-v1.yaml")).toContain(
      "--slack-signing-secret-file",
    );
    expect(deploymentFile("compose.clean-v1.yaml")).toContain(
      "/echo-clean/private/slack-signing-secret",
    );
    expect(source).toContain("docker image inspect");
    expect(source).toContain("compose_clean pull authority");
    expect(source).toContain('"$SETUP_COMMAND" resume --state-dir /echo-clean/state');
    expect(source).toContain("status_boolean \"$status_json\" slack_connected");
    expect(source).toContain("require_image_present");
    expect(source).toContain("healthy_authority()");
    expect(source).toContain("authority_uses_accepted_image()");
    expect(source).toContain("terminal_green()");
    expect(source).toContain("onboarding_complete=true");
    expect(source).not.toContain("Reject a second card");
    expect(source).toContain("founder-person-invitation.json");
    expect(source).toContain("canonical accepted release record %s");
    expect(source).toContain("verified Person onboarding kit matching that release");
    expect(source).toContain('"$initial_owner_invitation" "$RELEASE_FILE"');
    expect(source).toContain('"<release-matched-kit>/Start ECHO.command" <transferred-absolute-path>');
    expect(source).toContain("Do not use a preexisting global echo-brain command");
    expect(source).toContain('client_sha256="$(release_field client-sha256)"');
    expect(source).toContain('client_version="$(release_field client-version)"');
    expect(source).toContain('source_sha="$(release_field source-sha)"');
    expect(source).toContain("KIT-BUILD:");
    expect(source).toContain("deploy/release/README.md");
    expect(source).toContain("npm run kit:person-onboarding");
    expect(source).toContain("transferred accepted release record");
    expect(source).not.toContain(
      "then run echo-brain person login --invitation <transferred-absolute-path>",
    );
    expect(source).toContain("replace-rehearsal --confirm-no-live-users");
    expect(source).not.toContain('mv "$DATA_DIR"');
    expect(source).toContain("doctor --input-dir <absolute-private-input-directory>");
    expect(source).toContain("prepare --input-dir <absolute-private-input-directory>");
    expect(source).toContain("onboarding.clean-v1.json");
    expect(source).toContain("echo-clean-v1-onboarding-input-v1");
    expect(source).toContain("doctor_json");
    expect(source).toContain("oidc_callback_invalid");
    expect(source).toContain('id -u "$runtime_user"');
    expect(source).toContain('id -g "$runtime_user"');
    expect(source).toContain('chown "$RUNTIME_UID:$RUNTIME_GID"');
    expect(source).toContain("runtime user must be a non-root");
    expect(source).toContain("require_safe_directory_target");
    expect(source).toContain("live data and environment were restored");
    expect(source).not.toContain('uid="$(id -u)"');
    expect(source).not.toContain('gid="$(id -g)"');
    expect(source).not.toContain("compose_clean build");
    expect(source).not.toContain("migrations/");
    expect(source).not.toContain("dist/main.js");
    expect(source).not.toContain("--slack-bot-token ");
    expect(source).not.toContain("--granola-credential ");
    expect(source).not.toContain("--llm-credential ");
    expect(guide).toContain("never auto-reclaim an existing lock");
    expect(guide).toContain("Recover an interrupted operation lock");
    expect(guide).toContain('rmdir -- "$authority_lock"');
  });

  it("keeps credential-bearing release URLs out of the founder handoff", () => {
    const fixture = preparedStatusFixture();
    const urlToken = "founder-handoff-url-token-must-not-be-logged";
    try {
      const releasePath = join(
        fixture.releaseDir,
        "current.clean-v1.json",
      );
      writeFileSync(
        releasePath,
        readFileSync(releasePath, "utf8").replace(
          "https://downloads.example/echo-brain-person-client.tgz",
          `https://downloads.example/echo-brain-person-client.tgz?token=${urlToken}`,
        ),
      );
      const onboarding = join(
        fixture.deploy,
        "clean-data",
        "state",
        "onboarding",
      );
      mkdirSync(onboarding, { recursive: true });
      writeFileSync(join(onboarding, "founder-person-invitation.json"), "{}\n", {
        mode: 0o600,
      });

      const result = fixture.run("resume", {
        ECHO_FAKE_SETUP_STATUS:
          '{"next_step":"complete_founder_browser_login"}',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("RELEASE-MATCHED-KIT:");
      expect(result.stdout).toContain("client_artifact_sha256=");
      expect(result.stdout).not.toContain(urlToken);
      expect(result.stdout).not.toContain("client_artifact_url=");
      expect(result.stdout).toContain(
        '"$HOME/Library/Application Support/ECHO/bin/echo-brain" person logout',
      );
      expect(result.stdout).not.toContain("echo-brain person logout");
      expect(result.stdout).not.toContain("echo-brain person login");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("uses the kit-installed client for the founder Slack handoff", () => {
    const fixture = preparedStatusFixture();
    try {
      const result = fixture.run("resume", {
        ECHO_FAKE_SETUP_STATUS:
          '{"next_step":"complete_founder_slack_link"}',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        '"$HOME/Library/Application Support/ECHO/bin/echo-brain" person slack-link',
      );
      expect(result.stdout).not.toContain("run echo-brain person slack-link");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps host canary commands separate from kit-installed founder reads", () => {
    const fixture = preparedStatusFixture();
    try {
      const result = fixture.run("resume", {
        ECHO_FAKE_SETUP_STATUS: '{"next_step":"ready_to_start"}',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "HOST ACTION: On the exact staging host, run ./update-clean-v1.sh canary.\n",
      );
      expect(result.stdout).toContain(
        'FOUNDER ACTION: Approve its private Slack card, then on the initial-owner machine run "$HOME/Library/Application Support/ECHO/bin/echo-brain" person records --limit 20',
      );
      expect(result.stdout).toContain(
        "HOST ACTION: On the exact staging host, rerun ./onboard-clean-v1.sh resume, then ./onboard-clean-v1.sh status.",
      );
      expect(result.stdout).toContain(
        '"$HOME/Library/Application Support/ECHO/bin/echo-brain" person records --limit 20',
      );
      expect(result.stdout).toContain(
        '"$HOME/Library/Application Support/ECHO/bin/echo-brain" person records --query "SYNTHETIC STAGING CANARY"',
      );
      expect(result.stdout).not.toContain(
        "run echo-brain person records --limit 20",
      );
      expect(result.stdout).not.toContain(
        'and echo-brain person records --query "SYNTHETIC STAGING CANARY"',
      );
      expect(result.stdout).not.toMatch(
        /HOST ACTION:[^\n]*Library\/Application Support\/ECHO\/bin\/echo-brain/,
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("reports a complete canary safely when the Authority is stopped or drifted", () => {
    const fixture = preparedStatusFixture();
    try {
      const stopped = fixture.run("status", { ECHO_FAKE_RUNNING: "false" });
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain("authority_running=false");
      expect(stopped.stdout).toContain("terminal_green=false");
      expect(readFileSync(fixture.calls, "utf8")).toContain("--pull never");
      expect(readFileSync(fixture.calls, "utf8")).not.toMatch(/compose .* pull/);

      const digestDrift = fixture.run("status", {
        ECHO_FAKE_REPO_DIGEST:
          "123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      });
      expect(digestDrift.status).toBe(0);
      expect(digestDrift.stdout).toContain("authority_exact_accepted_image=false");
      expect(digestDrift.stdout).toContain("terminal_green=false");

      const sourceDrift = fixture.run("status", {
        ECHO_FAKE_SOURCE: "d".repeat(40),
      });
      expect(sourceDrift.status).toBe(0);
      expect(sourceDrift.stdout).toContain("authority_exact_accepted_image=false");
      expect(sourceDrift.stdout).toContain("terminal_green=false");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("hands a staged candidate to the update command without running it as accepted onboarding", () => {
    const fixture = preparedStatusFixture();
    try {
      writeFileSync(
        join(fixture.releaseDir, "candidate.clean-v1.json"),
        readFileSync(join(fixture.releaseDir, "current.clean-v1.json")),
      );
      const status = fixture.run("status");
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("release_state=staged_candidate");
      expect(status.stdout).toContain("terminal_green=false");
      expect(status.stdout).toContain("update-clean-v1.sh status");
      expect(readFileSync(fixture.calls, "utf8")).not.toContain(" run ");
      expect(readFileSync(fixture.calls, "utf8")).not.toContain(" pull ");

      const resume = fixture.run("resume");
      expect(resume.status).toBe(1);
      expect(resume.stderr).toContain("a candidate release is staged");
      expect(readFileSync(fixture.calls, "utf8")).not.toContain(" up ");

      const activation = fixture.run(
        "activate-provider-credentials",
        {},
        ["--input-dir", join(fixture.root, "unused-provider-credentials")],
      );
      expect(activation.status).toBe(1);
      expect(activation.stderr).toContain("a candidate release is staged");
      expect(readFileSync(fixture.calls, "utf8")).not.toMatch(/ down\n/);
      expect(readFileSync(fixture.durableSentinel, "utf8")).toBe(
        "durable-work-must-survive",
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("restarts the accepted runtime when rehearsal archival fails after shutdown", () => {
    const fixture = preparedStatusFixture();
    try {
      const environment = readFileSync(join(fixture.deploy, ".env.clean-v1"), "utf8");
      const sentinel = join(fixture.deploy, "clean-data", "rehearsal-sentinel");
      writeFileSync(sentinel, "live-data-must-survive");

      const result = fixture.run(
        "replace-rehearsal",
        { ECHO_FAKE_FAIL_REHEARSAL_ARCHIVE: "true" },
        ["--confirm-no-live-users"],
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "live data and environment were restored and the prior runtime was restarted",
      );
      expect(readFileSync(sentinel, "utf8")).toBe("live-data-must-survive");
      expect(readFileSync(join(fixture.deploy, ".env.clean-v1"), "utf8")).toBe(
        environment,
      );
      expect(existsSync(join(fixture.deploy, "retired-rehearsals"))).toBe(true);
      expect(readdirSync(join(fixture.deploy, "retired-rehearsals"))).toHaveLength(0);

      const calls = readFileSync(fixture.calls, "utf8");
      const down = calls.indexOf(" down --remove-orphans");
      const restarted = calls.indexOf(" up -d --no-build --wait --wait-timeout 90");
      expect(down).toBeGreaterThanOrEqual(0);
      expect(restarted).toBeGreaterThan(down);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses provider activation while another Authority operation holds the shared lock", () => {
    const fixture = preparedStatusFixture();
    try {
      const lock = join(
        fixture.deploy,
        "clean-data",
        ".authority-operation-lock",
      );
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner-pid"), `${process.pid}\n`, {
        mode: 0o600,
      });

      const activation = fixture.run(
        "activate-provider-credentials",
        {},
        ["--input-dir", join(fixture.root, "unused-provider-credentials")],
      );

      expect(activation.status).toBe(1);
      expect(activation.stderr).toContain(
        "another Authority activation or release operation is already in progress",
      );
      expect(readFileSync(fixture.calls, "utf8")).not.toMatch(/ down\n/);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps a dead-owner operation lock fail-closed for deliberate recovery", () => {
    const fixture = preparedStatusFixture();
    try {
      const lock = join(
        fixture.deploy,
        "clean-data",
        ".authority-operation-lock",
      );
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner-pid"), "99999999\n", {
        mode: 0o600,
      });

      const activation = fixture.run(
        "activate-provider-credentials",
        {},
        ["--input-dir", join(fixture.root, "unused-provider-credentials")],
      );

      expect(activation.status).toBe(1);
      expect(activation.stderr).toContain(
        "another Authority activation or release operation is already in progress",
      );
      expect(activation.stderr).toContain("README operation-lock recovery");
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(fixture.calls, "utf8")).not.toMatch(/ down\n/);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("activates validated provider credentials through one healthy accepted-image restart", () => {
    const fixture = preparedStatusFixture();
    try {
      const inputDir = join(fixture.root, "provider-credentials");
      const nextGranola = `grn_${"g".repeat(40)}`;
      const nextLlm = "l".repeat(43);
      mkdirSync(inputDir, { mode: 0o700 });
      writeFileSync(join(inputDir, "granola-credential"), nextGranola, {
        mode: 0o600,
      });
      writeFileSync(join(inputDir, "llm-credential"), nextLlm, {
        mode: 0o600,
      });

      expect(
        readFileSync(join(fixture.stateCredentialDir, "granola-credential"), "utf8"),
      ).not.toBe(nextGranola);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "llm-credential"), "utf8"),
      ).not.toBe(nextLlm);

      chmodSync(join(inputDir, "llm-credential"), 0o644);
      const rejected = fixture.run(
        "activate-provider-credentials",
        {},
        ["--input-dir", inputDir],
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("provider activation input");
      expect(rejected.stdout).not.toContain("provider_credentials_activated");
      expect(rejected.stderr).not.toContain(nextGranola);
      expect(rejected.stderr).not.toContain(nextLlm);
      expect(readFileSync(fixture.calls, "utf8")).not.toMatch(/ down\n/);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "granola-credential"), "utf8"),
      ).not.toBe(nextGranola);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "llm-credential"), "utf8"),
      ).not.toBe(nextLlm);
      chmodSync(join(inputDir, "llm-credential"), 0o600);

      const activated = fixture.run(
        "activate-provider-credentials",
        {},
        ["--input-dir", inputDir],
      );
      expect(activated.status).toBe(0);
      expect(activated.stdout).toContain("provider_credentials_activated=true");
      expect(activated.stdout).toContain("authority_healthy=true");
      expect(activated.stdout).toContain(
        "authority_exact_accepted_image=true",
      );
      expect(activated.stdout).toContain("public_descriptor_healthy=true");
      expect(activated.stdout).not.toContain(inputDir);
      expect(activated.stdout).not.toContain(nextGranola);
      expect(activated.stdout).not.toContain(nextLlm);
      expect(activated.stderr).not.toContain(nextGranola);
      expect(activated.stderr).not.toContain(nextLlm);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "granola-credential"), "utf8"),
      ).toBe(nextGranola);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "llm-credential"), "utf8"),
      ).toBe(nextLlm);
      const calls = readFileSync(fixture.calls, "utf8");
      expect(calls).toMatch(/ down\n/);
      expect(calls).toContain(" up -d --no-build --wait --wait-timeout 90");
      expect(calls).toContain(" credentials-install ");
      expect(calls).toContain(" exec -T authority node ");
      expect(calls).not.toMatch(/ (bootstrap|finalize|resume) /);
      expect(calls).not.toContain(nextGranola);
      expect(calls).not.toContain(nextLlm);
      expect(readFileSync(fixture.durableSentinel, "utf8")).toBe(
        "durable-work-must-survive",
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("restores and verifies both previous provider credentials when replacement startup fails", () => {
    const fixture = preparedStatusFixture();
    try {
      const inputDir = join(fixture.root, "provider-credentials");
      const nextGranola = `grn_${"r".repeat(40)}`;
      const nextLlm = "q".repeat(43);
      const previousGranolaSource = readFileSync(
        join(fixture.privateDir, "granola-credential-source"),
        "utf8",
      );
      const previousLlmSource = readFileSync(
        join(fixture.privateDir, "llm-credential-source"),
        "utf8",
      );
      const previousGranolaActive = readFileSync(
        join(fixture.stateCredentialDir, "granola-credential"),
        "utf8",
      );
      const previousLlmActive = readFileSync(
        join(fixture.stateCredentialDir, "llm-credential"),
        "utf8",
      );
      mkdirSync(inputDir, { mode: 0o700 });
      writeFileSync(join(inputDir, "granola-credential"), nextGranola, {
        mode: 0o600,
      });
      writeFileSync(join(inputDir, "llm-credential"), nextLlm, {
        mode: 0o600,
      });

      const failed = fixture.run(
        "activate-provider-credentials",
        { ECHO_FAKE_FAIL_FIRST_UP: "true" },
        ["--input-dir", inputDir],
      );

      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        "previous credentials were restored and verified",
      );
      expect(failed.stdout).not.toContain("provider_credentials_activated");
      expect(failed.stdout).not.toContain(inputDir);
      expect(failed.stdout).not.toContain(nextGranola);
      expect(failed.stdout).not.toContain(nextLlm);
      expect(failed.stderr).not.toContain(inputDir);
      expect(failed.stderr).not.toContain(nextGranola);
      expect(failed.stderr).not.toContain(nextLlm);
      expect(
        readFileSync(join(fixture.privateDir, "granola-credential-source"), "utf8"),
      ).toBe(previousGranolaSource);
      expect(
        readFileSync(join(fixture.privateDir, "llm-credential-source"), "utf8"),
      ).toBe(previousLlmSource);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "granola-credential"), "utf8"),
      ).toBe(previousGranolaActive);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "llm-credential"), "utf8"),
      ).toBe(previousLlmActive);
      const calls = readFileSync(fixture.calls, "utf8");
      expect(calls.match(/ down\n/g)).toHaveLength(2);
      expect(
        calls.match(/ up -d --no-build --wait --wait-timeout 90\n/g),
      ).toHaveLength(2);
      expect(calls.match(/ credentials-install /g)).toHaveLength(1);
      expect(calls).not.toMatch(/ (bootstrap|finalize|resume) /);
      expect(calls).not.toContain(nextGranola);
      expect(calls).not.toContain(nextLlm);
      expect(readFileSync(fixture.durableSentinel, "utf8")).toBe(
        "durable-work-must-survive",
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("restores the previous provider credentials and runtime when activation is interrupted", async () => {
    const fixture = preparedStatusFixture();
    try {
      const inputDir = join(fixture.root, "provider-credentials");
      const nextGranola = `grn_${"i".repeat(40)}`;
      const nextLlm = "j".repeat(43);
      const previousGranolaSource = readFileSync(
        join(fixture.privateDir, "granola-credential-source"),
        "utf8",
      );
      const previousLlmSource = readFileSync(
        join(fixture.privateDir, "llm-credential-source"),
        "utf8",
      );
      const previousGranolaActive = readFileSync(
        join(fixture.stateCredentialDir, "granola-credential"),
        "utf8",
      );
      const previousLlmActive = readFileSync(
        join(fixture.stateCredentialDir, "llm-credential"),
        "utf8",
      );
      mkdirSync(inputDir, { mode: 0o700 });
      writeFileSync(join(inputDir, "granola-credential"), nextGranola, {
        mode: 0o600,
      });
      writeFileSync(join(inputDir, "llm-credential"), nextLlm, {
        mode: 0o600,
      });

      const activation = fixture.spawnRun(
        "activate-provider-credentials",
        { ECHO_FAKE_WAIT_DURING_INSTALL: "true" },
        ["--input-dir", inputDir],
      );
      let stdout = "";
      let stderr = "";
      activation.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      activation.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveCompletion, rejectCompletion) => {
          activation.once("error", rejectCompletion);
          activation.once("close", (code, signal) =>
            resolveCompletion({ code, signal }),
          );
        },
      );
      await waitForFile(fixture.installWaitMarker);
      expect(Number(readFileSync(fixture.installWaitMarker, "utf8"))).toBe(
        activation.pid,
      );
      process.kill(activation.pid!, "SIGTERM");
      const interruptedAt = Date.now();
      const interrupted = await completion;

      expect(interrupted).toEqual({ code: 143, signal: null });
      expect(Date.now() - interruptedAt).toBeLessThan(4_000);
      expect(stdout).not.toContain("provider_credentials_activated");
      expect(stdout).not.toContain(nextGranola);
      expect(stdout).not.toContain(nextLlm);
      expect(stderr).not.toContain(nextGranola);
      expect(stderr).not.toContain(nextLlm);
      expect(
        readFileSync(join(fixture.privateDir, "granola-credential-source"), "utf8"),
      ).toBe(previousGranolaSource);
      expect(
        readFileSync(join(fixture.privateDir, "llm-credential-source"), "utf8"),
      ).toBe(previousLlmSource);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "granola-credential"), "utf8"),
      ).toBe(previousGranolaActive);
      expect(
        readFileSync(join(fixture.stateCredentialDir, "llm-credential"), "utf8"),
      ).toBe(previousLlmActive);
      expect(readFileSync(fixture.durableSentinel, "utf8")).toBe(
        "durable-work-must-survive",
      );
      const calls = readFileSync(fixture.calls, "utf8");
      expect(calls.match(/ down\n/g)).toHaveLength(2);
      expect(calls.match(/ credentials-install /g)).toHaveLength(1);
      expect(calls.match(/ up -d --no-build --wait --wait-timeout 90\n/g)).toHaveLength(1);
      expect(calls).not.toContain(nextGranola);
      expect(calls).not.toContain(nextLlm);
      expect(stderr).toContain(
        "activation was interrupted; previous credentials were restored and verified",
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }, 10_000);

  it("prepares offline without pulling and persists the fixed clean inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-onboard-"));
    try {
      const deploy = join(root, "deploy", "organization-authority");
      const release = join(deploy, "release");
      const bin = join(root, "bin");
      mkdirSync(deploy, { recursive: true });
      mkdirSync(release, { recursive: true });
      mkdirSync(bin, { recursive: true });
      for (const file of [
        "onboard-clean-v1.sh",
        ...RUNTIME_PROFILE_FILES,
      ]) {
        copyFileSync(resolve(REPO, DEPLOYMENT, file), join(deploy, file));
      }
      copyFileSync(
        resolve(REPO, "deploy/release/clean-v1-release.py"),
        join(release, "clean-v1-release.py"),
      );
      copyFileSync(
        resolve(REPO, "deploy/release/clean-v1-runtime-profile.py"),
        join(release, "clean-v1-runtime-profile.py"),
      );
      chmodSync(join(deploy, "onboard-clean-v1.sh"), 0o755);
      const calls = join(root, "docker-calls");
      const fakeDocker = join(bin, "docker");
      writeFileSync(
        fakeDocker,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nif [ "$1 $2" = "compose version" ]; then exit 0; fi\nif [ "$1" = compose ]; then exit 0; fi\nexit 1\n`,
      );
      chmodSync(fakeDocker, 0o755);
      writeFileSync(
        join(bin, "systemctl"),
        "#!/bin/sh\n[ \"${ECHO_FAKE_TUNNEL:-active}\" = active ]\n",
      );
      chmodSync(join(bin, "systemctl"), 0o755);
      writeFileSync(join(bin, "mountpoint"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "mountpoint"), 0o755);
      const image = "123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const inputDir = join(root, "onboarding-input");
      mkdirSync(inputDir);
      chmodSync(inputDir, 0o700);
      const releasePath = join(inputDir, "release.json");
      const source = "c".repeat(40);
      const profile = runtimeProfile(source);
      writeFileSync(join(inputDir, "runtime-profile.json"), profile.bytes);
      writeFileSync(
        releasePath,
        releaseRecord({
          image,
          profile,
          releaseId: "clean-v1-onboarding-test",
          source,
        }),
      );
      writeFileSync(
        join(inputDir, "onboarding.clean-v1.json"),
        `${JSON.stringify({
          authority_host: "authority.example.com",
          aws_region: "us-west-2",
          kind: "echo-clean-v1-onboarding-input-v1",
          organization_name: "Test Org",
          owner_display_name: "Founder",
          owner_email: "founder@example.com",
          runtime_user: execFileSync("id", ["-un"]).toString().trim(),
          schema_version: 1,
          slack_approval_channel_id: "C0123456789",
        })}\n`,
      );
      writeFileSync(
        join(inputDir, "oidc-config.json"),
        `${JSON.stringify({
          client_authentication: "client_secret_post",
          client_id: "founder-client",
          id_token_algorithms: ["RS256"],
          issuer: "https://issuer.example",
          redirect_uri: "https://authority.example.com/v2/session/oidc/callback",
          tenant: { kind: "issuer" },
        })}\n`,
      );
      for (const name of [
        "oidc-client-secret",
        "slack-bot-token",
        "slack-signing-secret",
        "granola-credential",
        "llm-credential",
      ]) {
        writeFileSync(join(inputDir, name), `${name}-value`);
      }
      writeFileSync(join(inputDir, "slack-signing-secret"), "s".repeat(32));
      for (const name of readdirSync(inputDir)) chmodSync(join(inputDir, name), 0o600);
      const prepareArguments = [
        join(deploy, "onboard-clean-v1.sh"),
        "prepare",
        "--input-dir", inputDir,
      ];
      const commandEnvironment = {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ECHO_FAKE_TUNNEL: "active",
        },
      };
      symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
      const noPython = spawnSync(
        "/bin/bash",
        [join(deploy, "onboard-clean-v1.sh"), "doctor", "--input-dir", inputDir],
        { encoding: "utf8", env: { PATH: bin } },
      );
      expect(noPython.status).toBe(0);
      expect(JSON.parse(noPython.stdout)).toEqual({
        ok: false,
        code: "python3_missing",
        next_action: "Install python3, then rerun doctor.",
      });
      const inactiveTunnel = execFileSync(
        "bash",
        [join(deploy, "onboard-clean-v1.sh"), "doctor", "--input-dir", inputDir],
        {
          env: {
            ...commandEnvironment.env,
            ECHO_FAKE_TUNNEL: "inactive",
          },
        },
      ).toString();
      expect(JSON.parse(inactiveTunnel)).toEqual({
        ok: false,
        code: "cloudflared_inactive",
        next_action: "Start cloudflared-echo-authority.service, then rerun doctor.",
      });
      const doctor = execFileSync(
        "bash",
        [join(deploy, "onboard-clean-v1.sh"), "doctor", "--input-dir", inputDir],
        commandEnvironment,
      ).toString();
      expect(doctor.split("\n").filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(doctor)).toEqual({
        ok: true,
        code: "ready",
        next_action: "Run prepare with the same input directory.",
      });
      const signingSecret = join(inputDir, "slack-signing-secret");
      rmSync(signingSecret);
      const missingSigningSecretDoctor = execFileSync(
        "bash",
        [join(deploy, "onboard-clean-v1.sh"), "doctor", "--input-dir", inputDir],
        commandEnvironment,
      ).toString();
      expect(JSON.parse(missingSigningSecretDoctor)).toEqual({
        ok: false,
        code: "input_files_invalid",
        next_action:
          "Use exactly the documented current-executor-owned regular files with mode 0600.",
      });
      writeFileSync(signingSecret, "s".repeat(32), { mode: 0o600 });
      chmodSync(signingSecret, 0o600);
      const manifest = join(inputDir, "onboarding.clean-v1.json");
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8").replace(
          '"aws_region":"us-west-2"',
          '"aws_region":"not-a-region"',
        ),
      );
      chmodSync(manifest, 0o600);
      const invalidRegionDoctor = execFileSync(
        "bash",
        [join(deploy, "onboard-clean-v1.sh"), "doctor", "--input-dir", inputDir],
        commandEnvironment,
      ).toString();
      expect(JSON.parse(invalidRegionDoctor)).toEqual({
        ok: false,
        code: "input_manifest_invalid",
        next_action:
          "Use the exact manifest schema and safe ordinary values from the committed example.",
      });
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8").replace(
          '"aws_region":"not-a-region"',
          '"aws_region":"us-west-2"',
        ),
      );
      chmodSync(manifest, 0o600);
      const oidcConfig = join(inputDir, "oidc-config.json");
      writeFileSync(oidcConfig, '{"redirect_uri":"https://wrong.example/v2/session/oidc/callback"}\n');
      chmodSync(oidcConfig, 0o600);
      const invalidCallbackDoctor = execFileSync(
        "bash",
        [join(deploy, "onboard-clean-v1.sh"), "doctor", "--input-dir", inputDir],
        commandEnvironment,
      ).toString();
      expect(invalidCallbackDoctor.split("\n").filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(invalidCallbackDoctor)).toEqual({
        ok: false,
        code: "oidc_callback_invalid",
        next_action: "Set oidc-config.json redirect_uri to the exact Authority callback URL.",
      });
      writeFileSync(
        oidcConfig,
        `${JSON.stringify({
          client_authentication: "client_secret_post",
          client_id: "founder-client",
          id_token_algorithms: ["RS256"],
          issuer: "https://issuer.example",
          redirect_uri: "https://authority.example.com/v2/session/oidc/callback",
          tenant: { kind: "issuer" },
        })}\n`,
      );
      chmodSync(oidcConfig, 0o600);
      const output = execFileSync(
        "bash",
        prepareArguments,
        commandEnvironment,
      ).toString();
      expect(output).toContain("prepared=true");
      expect(readFileSync(calls, "utf8")).toContain("compose");
      expect(readFileSync(calls, "utf8")).not.toContain("pull");
      expect(readFileSync(join(deploy, "clean-data/private/granola-owner-email"), "utf8")).toBe("founder@example.com");
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(image);
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(
        `ECHO_CLEAN_AUTHORITY_UID=${statSync(inputDir).uid}`,
      );
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(
        `ECHO_CLEAN_AUTHORITY_GID=${statSync(inputDir).gid}`,
      );
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(
        "ECHO_CLEAN_AWS_REGION=us-west-2",
      );
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(
        "ECHO_CLEAN_AUTHORITY_LOG_GROUP=/echo-brain/authority/authority.example.com",
      );
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(
        `ECHO_CLEAN_RUNTIME_PROFILE_SHA256=${profile.digest}`,
      );
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(
        "ECHO_CLEAN_RUNTIME_PROFILE_VERSION=clean-v1-profile-1",
      );
      expect(
        readFileSync(
          join(
            deploy,
            "clean-data/release/runtime-profiles/clean-v1-onboarding-test.profile",
          ),
          "utf8",
        ),
      ).toBe(profile.bytes);
      expect(
        readFileSync(
          join(deploy, "clean-data/release/runtime-profile.active"),
          "utf8",
        ),
      ).toBe(profile.bytes);
      expect(
        readFileSync(
          join(
            deploy,
            "clean-data/release/runtime-environments/clean-v1-onboarding-test.env",
          ),
          "utf8",
        ),
      ).toBe(readFileSync(join(deploy, ".env.clean-v1"), "utf8"));
      expect(statSync(join(deploy, "clean-data")).uid).toBe(
        statSync(inputDir).uid,
      );
      expect(statSync(join(deploy, "clean-data/private")).mode & 0o777).toBe(
        0o700,
      );
      for (const fixedPrivate of [
        "onboard-clean-v1.conf",
        "oidc-config.json",
        "oidc-client-secret",
        "slack-bot-token",
        "slack-signing-secret",
        "granola-credential-source",
        "granola-owner-email",
        "llm-credential-source",
      ]) {
        const metadata = statSync(join(deploy, "clean-data/private", fixedPrivate));
        expect(metadata.uid).toBe(statSync(inputDir).uid);
        expect(metadata.gid).toBe(statSync(inputDir).gid);
        expect(metadata.mode & 0o777).toBe(0o600);
      }
      const rootArguments = [...prepareArguments];
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`"runtime_user":"${execFileSync("id", ["-un"]).toString().trim()}"`, '"runtime_user":"root"'));
      expect(() =>
        execFileSync("bash", rootArguments, commandEnvironment),
      ).toThrow(/doctor did not report this input directory ready/);
      writeFileSync(manifest, `${JSON.stringify({
        authority_host: "authority.example.com",
        aws_region: "us-west-2",
        kind: "echo-clean-v1-onboarding-input-v1",
        organization_name: "Test Org",
        owner_display_name: "Founder",
        owner_email: "founder@example.com",
        runtime_user: execFileSync("id", ["-un"]).toString().trim(),
        schema_version: 1,
        slack_approval_channel_id: "C0123456789",
      })}\n`);
      chmodSync(manifest, 0o600);
      writeFileSync(
        join(deploy, "clean-data", "rehearsal-sentinel"),
        "rehearsal-data-must-survive",
      );
      const cleanDataInode = statSync(join(deploy, "clean-data")).ino;
      rmSync(join(deploy, "clean-data/private/onboard-clean-v1.conf"));
      const retired = execFileSync(
        "bash",
        [
          join(deploy, "onboard-clean-v1.sh"),
          "replace-rehearsal",
          "--confirm-no-live-users",
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
      ).toString();
      expect(retired).toContain("rehearsal_replaced=true");
      expect(existsSync(join(deploy, "clean-data"))).toBe(true);
      expect(statSync(join(deploy, "clean-data")).ino).toBe(cleanDataInode);
      expect(readdirSync(join(deploy, "clean-data"))).toHaveLength(0);
      expect(existsSync(join(deploy, ".env.clean-v1"))).toBe(false);
      const archives = readdirSync(join(deploy, "retired-rehearsals"));
      expect(archives).toHaveLength(1);
      expect(
        existsSync(join(deploy, "retired-rehearsals", archives[0]!, "clean-data")),
      ).toBe(true);
      expect(
        existsSync(
          join(deploy, "retired-rehearsals", archives[0]!, ".env.clean-v1"),
        ),
      ).toBe(true);
      expect(
        readFileSync(
          join(
            deploy,
            "retired-rehearsals",
            archives[0]!,
            "clean-data/rehearsal-sentinel",
          ),
          "utf8",
        ),
      ).toBe("rehearsal-data-must-survive");
      rmSync(join(deploy, "clean-data"), { recursive: true });
      symlinkSync(inputDir, join(deploy, "clean-data"), "dir");
      expect(() =>
        execFileSync("bash", prepareArguments, commandEnvironment),
      ).toThrow(/doctor did not report this input directory ready/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("selects the dedicated clean live entrypoint and a fresh clean state mount", () => {
    const compose = deploymentFile("compose.clean-v1.yaml");

    expect(compose).toContain("name: echo-organization-authority-clean-v1");
    expect(compose).toContain(
      "services/organization-authority/dist/clean-live-main.js",
    );
    expect(compose).toContain("./clean-data:/echo-clean");
    expect(compose).toContain("/echo-clean/state");
    expect(compose).toContain("/v1/authority-descriptor");
    expect(compose).not.toContain("dist/main.js");
    expect(compose).not.toContain("/echo/authority.json");
    expect(compose).not.toContain("./data:/echo");
  });

  it("keeps clean ingress free of the retired authenticated proxy contract", () => {
    const localCaddyfile = deploymentFile("Caddyfile.clean-v1");
    const ec2Caddyfile = deploymentFile("Caddyfile.clean-v1.ec2");
    for (const caddyfile of [localCaddyfile, ec2Caddyfile]) {
      expect(caddyfile).toContain("reverse_proxy 127.0.0.1:39479");
      for (const forbidden of [
        "X-Echo-Proxy-Authorization",
        "X-Echo-Authenticated-Client-Id",
        "X-Echo-Proxy-Source-Address",
        "trusted-proxy",
      ]) {
        expect(caddyfile).not.toContain(forbidden);
      }
    }
    expect(localCaddyfile).toContain(
      "header_up X-Echo-Client-IP {remote_host}",
    );
    expect(ec2Caddyfile).toContain(
      "header_up X-Echo-Client-IP {http.request.header.CF-Connecting-IP}",
    );
    expect(ec2Caddyfile).not.toContain(
      "header_up X-Echo-Client-IP {remote_host}",
    );
  });

  it("offers a loopback-only HTTP origin for the EC2 tunnel", () => {
    const compose = deploymentFile("compose.clean-v1.ec2.yaml");
    const baseCompose = deploymentFile("compose.clean-v1.yaml");
    const caddyfile = deploymentFile("Caddyfile.clean-v1.ec2");

    expect(compose).toContain("build: !reset null");
    expect(compose).toContain("host_ip: 127.0.0.1");
    expect(compose).toContain("published: \"80\"");
    expect(compose).not.toContain('published: "443"');
    expect(compose).toContain(
      "./Caddyfile.clean-v1.ec2:/etc/caddy/Caddyfile:ro",
    );
    expect(compose).toContain("driver: awslogs");
    expect(compose).toContain("ECHO_CLEAN_AWS_REGION");
    expect(compose).toContain("ECHO_CLEAN_AUTHORITY_LOG_GROUP");
    expect(compose).toContain('awslogs-stream: "authority"');
    expect(baseCompose).not.toContain("driver: awslogs");
    expect(caddyfile).toContain(
      "http://{$ECHO_CLEAN_AUTHORITY_HOST:localhost}",
    );
  });

  it("does not make legacy machine lifecycle surfaces part of the clean profile", () => {
    const cleanFiles = [
      deploymentFile("compose.clean-v1.yaml"),
      deploymentFile("compose.clean-v1.ec2.yaml"),
      deploymentFile("Caddyfile.clean-v1"),
      deploymentFile("Caddyfile.clean-v1.ec2"),
    ].join("\n");

    for (const forbidden of ["installation", "enrollment"]) {
      expect(cleanFiles).not.toContain(forbidden);
    }
    expect(cleanFiles).not.toContain("lease-token");
  });
});
