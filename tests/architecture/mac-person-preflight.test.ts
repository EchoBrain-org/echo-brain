import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("rejects macOS 13 before launching a runtime or writing an installation (mocked OS)", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "echo-mac-preflight-"));
  try {
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(root, "uname"), '#!/bin/bash\nif [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi\n', { mode: 0o755 });
    writeFileSync(join(root, "sw_vers"), '#!/bin/bash\necho 13.7.1\n', { mode: 0o755 });
    writeFileSync(join(root, "start.sh"), readFileSync(resolve("deploy/release/start-person-onboarding-kit.sh")));
    const result = spawnSync("/bin/bash", [join(root, "start.sh"), "--install-only"], { encoding: "utf8", env: { HOME: home, PATH: `${root}:/usr/bin:/bin` } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("macOS 14 or later");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
