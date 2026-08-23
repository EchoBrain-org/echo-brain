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
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const DEPLOYMENT = "deploy/organization-authority";

function deploymentFile(name: string): string {
  return readFileSync(resolve(REPO, DEPLOYMENT, name), "utf8");
}

function preparedStatusFixture() {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-status-"));
  const deploy = join(root, "deploy", "organization-authority");
  const release = join(deploy, "release");
  const privateDir = join(deploy, "clean-data", "private");
  const releaseDir = join(deploy, "clean-data", "release");
  const bin = join(root, "bin");
  const calls = join(root, "docker-calls");
  const image = "123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const source = "c".repeat(40);
  mkdirSync(release, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const file of [
    "onboard-clean-v1.sh",
    "compose.clean-v1.yaml",
    "compose.clean-v1.ec2.yaml",
  ]) {
    copyFileSync(resolve(REPO, DEPLOYMENT, file), join(deploy, file));
  }
  copyFileSync(
    resolve(REPO, "deploy/release/clean-v1-release.py"),
    join(release, "clean-v1-release.py"),
  );
  chmodSync(join(deploy, "onboard-clean-v1.sh"), 0o755);
  const record = `${JSON.stringify({
    authority_image: { reference: image },
    baseline_compatibility_class: "clean-v1",
    kind: "echo-clean-v1-release",
    person_client: {
      artifact_sha256: "b".repeat(64),
      artifact_url: "https://downloads.example/echo-brain-person-client.tgz",
      package: "@echo-brain/person-client",
      version: "0.1.0-internal.1",
    },
    release_id: "clean-v1-status-test",
    released_at: "2026-08-23T00:00:00Z",
    schema_version: 1,
    source_sha: source,
  })}\n`;
  writeFileSync(join(releaseDir, "current.clean-v1.json"), record);
  writeFileSync(
    join(deploy, ".env.clean-v1"),
    `ECHO_CLEAN_AUTHORITY_IMAGE=${image}\n`,
  );
  for (const name of [
    "onboard-clean-v1.conf",
    "oidc-config.json",
    "oidc-client-secret",
    "slack-bot-token",
    "granola-credential-source",
    "granola-owner-email",
    "llm-credential-source",
  ]) {
    writeFileSync(join(privateDir, name), "fixture");
  }
  const fakeDocker = join(bin, "docker");
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [[ "$1" == compose && "$2" == version ]]; then exit 0; fi
if [[ "$1" == compose ]]; then
  case " $* " in
    *" run "*) printf '%s\\n' '{"next_step":"complete"}'; exit 0 ;;
    *" ps -q authority "*) printf '%s\\n' fake-container; exit 0 ;;
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
  if [[ "$*" == *.State.Running* ]]; then printf '%s\\n' "$ECHO_FAKE_RUNNING"; exit 0; fi
  if [[ "$*" == *.State.Health* ]]; then printf '%s\\n' "$ECHO_FAKE_HEALTH"; exit 0; fi
  if [[ "$*" == *.Image* ]]; then printf '%s\\n' sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; exit 0; fi
fi
exit 1
`,
  );
  chmodSync(fakeDocker, 0o755);
  const run = (command: "status" | "resume", overrides: Record<string, string> = {}) =>
    spawnSync("bash", [join(deploy, "onboard-clean-v1.sh"), command], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ECHO_FAKE_REPO_DIGEST: image,
        ECHO_FAKE_SOURCE: source,
        ECHO_FAKE_RUNNING: "true",
        ECHO_FAKE_HEALTH: "healthy",
        ...overrides,
      },
    });
  return { root, releaseDir, calls, image, source, run };
}

describe("clean founder deployment profile", () => {
  it("keeps server onboarding in one resumable wrapper with fixed private inputs", () => {
    const wrapper = resolve(REPO, DEPLOYMENT, "onboard-clean-v1.sh");
    const source = readFileSync(wrapper, "utf8");

    expect(() => execFileSync("bash", ["-n", wrapper])).not.toThrow();
    expect(source).toContain("prepare) shift; prepare");
    expect(source).toContain("resume) [[ $# -eq 1 ]] || usage; resume");
    expect(source).toContain("status) [[ $# -eq 1 ]] || usage; status");
    expect(source).toContain("compose.clean-v1.yaml");
    expect(source).toContain("compose.clean-v1.ec2.yaml");
    expect(source).toContain('PRIVATE_DIR="$DATA_DIR/private"');
    expect(source).toContain("granola-owner-email");
    expect(source).toContain("clean-v1-release.py");
    expect(source).toContain('$DEPLOY_DIR/release/clean-v1-release.py');
    expect(source).toContain("< \"$PRIVATE_DIR/slack-bot-token\"");
    expect(source).toContain("docker image inspect");
    expect(source).toContain("compose_clean pull authority");
    expect(source).toContain('"$FOUNDER_MAIN" resume --state-dir /echo-clean/state');
    expect(source).toContain("status_boolean \"$status_json\" slack_connected");
    expect(source).toContain("require_image_present");
    expect(source).toContain("healthy_authority()");
    expect(source).toContain("authority_uses_accepted_image()");
    expect(source).toContain("terminal_green()");
    expect(source).toContain("onboarding_complete=true");
    expect(source).toContain("Rerun onboard-clean-v1.sh resume, then onboard-clean-v1.sh status");
    expect(source).toContain("one new Granola note");
    expect(source).not.toContain("Reject a second card");
    expect(source).toContain("founder-person-invitation.json");
    expect(source).toContain("replace-rehearsal --confirm-no-live-users");
    expect(source).toContain("--runtime-user <os-user>");
    expect(source).toContain('id -u "$runtime_user"');
    expect(source).toContain('id -g "$runtime_user"');
    expect(source).toContain('chown "$RUNTIME_UID:$RUNTIME_GID"');
    expect(source).toContain("runtime user must be a non-root");
    expect(source).toContain("require_safe_directory_target");
    expect(source).toContain("clean data was restored");
    expect(source).not.toContain('uid="$(id -u)"');
    expect(source).not.toContain('gid="$(id -g)"');
    expect(source).not.toContain("compose_clean build");
    expect(source).not.toContain("migrations/");
    expect(source).not.toContain("dist/main.js");
    expect(source).not.toContain("--slack-bot-token ");
    expect(source).not.toContain("--granola-credential ");
    expect(source).not.toContain("--llm-credential ");
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
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("prepares offline without pulling and persists the fixed clean inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-clean-onboard-"));
    try {
      const deploy = join(root, "deploy", "organization-authority");
      const release = join(deploy, "release");
      const privateSources = join(root, "private-sources");
      const bin = join(root, "bin");
      mkdirSync(deploy, { recursive: true });
      mkdirSync(release, { recursive: true });
      mkdirSync(privateSources, { recursive: true });
      mkdirSync(bin, { recursive: true });
      for (const file of [
        "onboard-clean-v1.sh",
        "compose.clean-v1.yaml",
        "compose.clean-v1.ec2.yaml",
      ]) {
        copyFileSync(resolve(REPO, DEPLOYMENT, file), join(deploy, file));
      }
      copyFileSync(
        resolve(REPO, "deploy/release/clean-v1-release.py"),
        join(release, "clean-v1-release.py"),
      );
      chmodSync(join(deploy, "onboard-clean-v1.sh"), 0o755);
      const calls = join(root, "docker-calls");
      const fakeDocker = join(bin, "docker");
      writeFileSync(
        fakeDocker,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nif [[ "$1 $2" == "compose version" ]]; then exit 0; fi\nif [[ "$1" == compose ]]; then exit 0; fi\nexit 1\n`,
      );
      chmodSync(fakeDocker, 0o755);
      const image = "123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const releaseRecord = join(privateSources, "release.json");
      writeFileSync(
        releaseRecord,
        `${JSON.stringify({
          authority_image: { reference: image },
          baseline_compatibility_class: "clean-v1",
          kind: "echo-clean-v1-release",
          person_client: {
            artifact_sha256: "b".repeat(64),
            artifact_url: "https://downloads.example/echo-brain-person-client.tgz",
            package: "@echo-brain/person-client",
            version: "0.1.0-internal.1",
          },
          release_id: "clean-v1-onboarding-test",
          released_at: "2026-08-23T00:00:00Z",
          schema_version: 1,
          source_sha: "c".repeat(40),
        })}\n`,
      );
      const privateFiles = [
        "oidc.json",
        "oidc-secret",
        "slack-token",
        "granola-credential",
        "llm-credential",
      ].map((name) => {
        const path = join(privateSources, name);
        writeFileSync(path, `${name}-value`);
        return path;
      });
      const prepareArguments = [
        join(deploy, "onboard-clean-v1.sh"),
        "prepare",
        "--release", releaseRecord,
        "--runtime-user", execFileSync("id", ["-un"]).toString().trim(),
        "--organization-name", "Test Org",
        "--owner-display-name", "Founder",
        "--owner-email", "founder@example.com",
        "--authority-host", "authority.example.com",
        "--slack-approval-channel-id", "C0123456789",
        "--oidc-config-file", privateFiles[0],
        "--oidc-client-secret-file", privateFiles[1],
        "--slack-bot-token-file", privateFiles[2],
        "--granola-credential-file", privateFiles[3],
        "--llm-credential-file", privateFiles[4],
      ];
      const commandEnvironment = {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      };
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
        `ECHO_CLEAN_AUTHORITY_UID=${statSync(privateSources).uid}`,
      );
      expect(readFileSync(join(deploy, ".env.clean-v1"), "utf8")).toContain(
        `ECHO_CLEAN_AUTHORITY_GID=${statSync(privateSources).gid}`,
      );
      expect(statSync(join(deploy, "clean-data")).uid).toBe(
        statSync(privateSources).uid,
      );
      expect(statSync(join(deploy, "clean-data/private")).mode & 0o777).toBe(
        0o700,
      );
      for (const fixedPrivate of [
        "onboard-clean-v1.conf",
        "oidc-config.json",
        "oidc-client-secret",
        "slack-bot-token",
        "granola-credential-source",
        "granola-owner-email",
        "llm-credential-source",
      ]) {
        const metadata = statSync(join(deploy, "clean-data/private", fixedPrivate));
        expect(metadata.uid).toBe(statSync(privateSources).uid);
        expect(metadata.gid).toBe(statSync(privateSources).gid);
        expect(metadata.mode & 0o777).toBe(0o600);
      }
      const rootArguments = [...prepareArguments];
      rootArguments[rootArguments.indexOf("--runtime-user") + 1] = "root";
      expect(() =>
        execFileSync("bash", rootArguments, commandEnvironment),
      ).toThrow(/runtime user must be a non-root/);
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
      expect(existsSync(join(deploy, "clean-data"))).toBe(false);
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
      symlinkSync(privateSources, join(deploy, "clean-data"), "dir");
      expect(() =>
        execFileSync("bash", prepareArguments, commandEnvironment),
      ).toThrow(/clean data path is not a safe directory/);
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
    const caddyfiles = [
      deploymentFile("Caddyfile.clean-v1"),
      deploymentFile("Caddyfile.clean-v1.ec2"),
    ];

    for (const caddyfile of caddyfiles) {
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
  });

  it("offers a loopback-only HTTP origin for the EC2 tunnel", () => {
    const compose = deploymentFile("compose.clean-v1.ec2.yaml");
    const caddyfile = deploymentFile("Caddyfile.clean-v1.ec2");

    expect(compose).toContain("build: !reset null");
    expect(compose).toContain("host_ip: 127.0.0.1");
    expect(compose).toContain("published: \"80\"");
    expect(compose).not.toContain('published: "443"');
    expect(compose).toContain(
      "./Caddyfile.clean-v1.ec2:/etc/caddy/Caddyfile:ro",
    );
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

    for (const forbidden of ["installation", "enrollment", "lease"]) {
      expect(cleanFiles).not.toContain(forbidden);
    }
  });
});
