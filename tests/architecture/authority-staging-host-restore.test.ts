import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it("is syntactically valid and treats a genuinely blank retained volume as a safe no-op", () => {
    const script = restoreScript();

    expect(() => execFileSync("bash", ["-n", RESTORER])).not.toThrow();
    expect(script).toContain("is_blank_data_volume");
    expect(script).toContain("lost+found");
    expect(script).toContain(
      '{"ok":true,"state":"unprepared","action":"no_op"}',
    );
    expect(script).toContain("return 10");
    expect(script).toContain("[[ $COMMAND == materialize || $restored == false ]]");
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
