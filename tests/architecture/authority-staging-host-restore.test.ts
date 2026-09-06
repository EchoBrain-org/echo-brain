import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const RESTORER = resolve(
  REPO,
  "deploy/organization-authority/restore-clean-v1-host.sh",
);

function restoreScript(): string {
  return readFileSync(RESTORER, "utf8");
}

describe("Authority retained-host restore", () => {
  it("keeps blank materialization a safe no-op but refuses a resume without an accepted tuple", () => {
    const script = restoreScript();

    expect(() => execFileSync("bash", ["-n", RESTORER])).not.toThrow();
    expect(script).toContain("is_blank_data_volume");
    expect(script).toContain("lost+found");
    expect(script).toContain(
      '{"ok":true,"state":"unprepared","action":"no_op"}',
    );
    expect(script).toContain("return 10");
    expect(script).toContain("if [[ $COMMAND == materialize ]]; then");
    expect(script).toContain(
      "fail 'retained host resume requires an accepted release tuple'",
    );
    expect(script).toContain(
      "but resume is refused. A partial, candidate, symlinked, permission-unsafe, or",
    );
  });

  it("executes blank materialization successfully but exits through the classified resume refusal", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-retained-host-restore-"));
    const deploy = join(root, "deploy");
    const data = join(deploy, "clean-data");
    const bin = join(root, "bin");
    const testableRestorer = join(root, "restore-clean-v1-host.sh");
    try {
      mkdirSync(join(data, "lost+found"), { recursive: true });
      mkdirSync(join(deploy, "release"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(deploy, "release", "clean-v1-release.py"), "#!/bin/sh\n");
      writeFileSync(
        join(deploy, "release", "clean-v1-runtime-profile.py"),
        "#!/bin/sh\n",
      );
      writeFileSync(
        join(bin, "id"),
        "#!/bin/sh\ncase \"$1\" in -u) printf '999\\n' ;; -g) printf '988\\n' ;; esac\n",
      );
      writeFileSync(join(bin, "stat"), "#!/bin/sh\nprintf '999:988:700\\n'\n");
      chmodSync(join(bin, "id"), 0o755);
      chmodSync(join(bin, "stat"), 0o755);

      const rootCheck =
        "[[ " + "$" + "{EUID} -eq 0 ]] || fail 'run this restore command as root'";
      const source = restoreScript();
      expect(source).toContain(rootCheck);
      writeFileSync(
        testableRestorer,
        source.replace(
          rootCheck,
          ": # isolated behavior test supplies Linux ownership facts",
        ),
        { mode: 0o700 },
      );

      const environment = {
        ...process.env,
        PATH: bin + ":" + (process.env.PATH ?? ""),
      };
      const materialize = spawnSync(
        "bash",
        [testableRestorer, "materialize", "--deploy-dir", deploy],
        { encoding: "utf8", env: environment },
      );
      expect(materialize.status).toBe(0);
      expect(materialize.stdout).toContain(
        '{"ok":true,"state":"unprepared","action":"no_op"}',
      );
      expect(materialize.stderr).toBe("");

      const resume = spawnSync(
        "bash",
        [testableRestorer, "resume", "--deploy-dir", deploy],
        { encoding: "utf8", env: environment },
      );
      expect(resume.status).toBe(1);
      expect(resume.stdout).toContain(
        '{"ok":true,"state":"unprepared","action":"no_op"}',
      );
      expect(resume.stderr).toContain(
        "restore-clean-v1-host: retained host resume requires an accepted release tuple",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rebuilds only the root-volume runtime material from a complete accepted retained tuple", () => {
    const script = restoreScript();

    for (const retainedPath of [
      'RELEASE_FILE="$RELEASE_DIR/current.clean-v1.json"',
      'ACTIVE_RUNTIME_PROFILE="$RELEASE_DIR/runtime-profile.active"',
      'RUNTIME_PROFILES_DIR="$RELEASE_DIR/runtime-profiles"',
      'RUNTIME_ENVIRONMENTS_DIR="$RELEASE_DIR/runtime-environments"',
      'SETUP_FILE="$PRIVATE_DIR/onboard-clean-v1.conf"',
    ]) {
      expect(script).toContain(retainedPath);
    }
    for (const runtimeFile of [
      "Caddyfile.clean-v1",
      "Caddyfile.clean-v1.ec2",
      "compose.clean-v1.ec2.yaml",
      "compose.clean-v1.yaml",
      ".env.clean-v1",
    ]) {
      expect(script).toContain(runtimeFile);
    }
    expect(script).toContain("validate_retained_tuple");
    expect(script).toContain("active retained runtime profile differs from the accepted release tuple");
    expect(script).toContain("deployment runtime file drifts from the accepted retained tuple");
    expect(script).toContain('"$ONBOARD_TOOL" resume');
    expect(script).toContain('"$ONBOARD_TOOL" status');
    expect(script).toContain("terminal_green=true");
  });

  it("keeps the parent guard through onboarding resume and terminal status", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-restore-handoff-"));
    try {
      mkdirSync(join(root, "release"), { mode: 0o700 });
      writeFileSync(join(root, "release", "clean-v1-release.py"), "# fixture\n");
      writeFileSync(join(root, "release", "clean-v1-runtime-profile.py"), "# fixture\n");
      const rootCheck = "[[ " + "$" + "{EUID} -eq 0 ]] || fail 'run this restore command as root'";
      const original = restoreScript();
      const materializer = /^restore_or_no_op\(\) \{\n.*?^\}/ms;
      expect(original).toMatch(materializer);
      writeFileSync(join(root, "restore.sh"), original.replace(rootCheck, ": # isolated handoff proof").replace(materializer, "restore_or_no_op() { return 0; }"));
      writeFileSync(join(root, "onboard-clean-v1.sh"), `#!/usr/bin/env bash
set -euo pipefail
guard="$ECHO_TEST_DEPLOY/.staging-release-guard"
test -f "$guard/owner-pid" || exit 42
if mkdir "$guard" 2>/dev/null; then exit 43; fi
if [[ "$1" == resume ]]; then
  test "\${ECHO_CLEAN_PARENT_GUARD_PID:-}" = "$PPID" || exit 44
else
  printf 'terminal_green=true\\n'
fi
`, { mode: 0o700 });
      const result = spawnSync("bash", [join(root, "restore.sh"), "resume", "--deploy-dir", root], {
        encoding: "utf8", env: { ...process.env, ECHO_TEST_DEPLOY: root },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("terminal_green=true");
      expect(() => readFileSync(join(root, ".staging-release-guard", "owner-pid"))).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails closed instead of inventing or mixing state after partial, candidate, unsafe, or wrong-identity recovery inputs", () => {
    const script = restoreScript();

    for (const refusal of [
      "retained clean-data is partial or contains an unsafe state directory",
      "a candidate release is present",
      "an Authority operation lock is present",
      "clean-data root must be owned by fixed Authority UID/GID with mode 0700",
      "retained clean-data state directory has an unexpected Authority UID/GID or mode",
      "retained release directory must preserve its root-owned control boundary",
      "retained onboarding setup file has an unexpected Authority UID/GID",
      "accepted retained release record must preserve its root-owned control boundary",
      "active retained runtime profile must preserve its root-owned control boundary",
      "accepted retained runtime environment has an unexpected control owner",
      "deployment runtime files are partial; refusing to fabricate a mixed host state",
      "existing deployment runtime file is unsafe",
    ]) {
      expect(script).toContain(refusal);
    }
    expect(script).toContain("AUTHORITY_UID=999");
    expect(script).toContain("AUTHORITY_GID=988");
    expect(script).toContain("require_authority_identity");
    expect(script).not.toMatch(/get-secret-value|batch-get-secret-value/i);
    expect(script).not.toContain("oidc-client-secret");
    expect(script).not.toContain("slack-bot-token");
  });
});
