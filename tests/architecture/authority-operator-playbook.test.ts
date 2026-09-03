import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const PLAYBOOK = readFileSync(
  resolve(
    REPO,
    "docs/operations/PB-OPERATIONS-001-authority-operator-lane.md",
  ),
  "utf8",
);
const readRepoFile = (path: string) => readFileSync(resolve(REPO, path), "utf8");

describe("Authority operator playbook", () => {
  it("keeps retained recovery inside the reviewed authority-required up", () => {
    expect(PLAYBOOK).toContain("up --require-authority");
    expect(PLAYBOOK).toContain(
      "Do not invoke\n`restore-clean-v1-host.sh resume` manually for this normal path.",
    );
    expect(PLAYBOOK).not.toContain(
      "restore-clean-v1-host.sh resume` via bounded SSM",
    );
  });

  it("keeps transfer cleanup conditional", () => {
    expect(PLAYBOOK).toContain(
      "Run `cleanup`\nonly when execute retains the receipt and reports `cleanup_required`",
    );
  });

  it("keeps onboarding release-bound and staging synthetic", () => {
    expect(PLAYBOOK).toContain("<release-matched-kit>/Start ECHO.command");
    expect(PLAYBOOK).toContain("person slack-link");
    expect(PLAYBOOK).toContain("./update-clean-v1.sh canary");
    expect(PLAYBOOK).toContain("Do not create a live Granola\nnote for this flow.");
    expect(PLAYBOOK).not.toContain("Granola note and Approve DM");
    expect(PLAYBOOK).not.toContain("Google / `echo-brain person login`");
  });

  it("stops routine updates for human approval and reads before promotion", () => {
    expect(PLAYBOOK).toContain(
      "../../deploy/release/README.md#ec2-authority-replacement",
    );
    expect(PLAYBOOK).toContain(
      "Only after both checks pass may the host operator run\n`update-clean-v1.sh promote --canary-passed`",
    );
    expect(PLAYBOOK).toContain(
      "The flag\nis the operator's explicit confirmation of those human checks",
    );
    const releaseGuide = readRepoFile("deploy/release/README.md");
    expect(releaseGuide).toContain(
      '"$HOME/.local/bin/echo-brain" person records --query',
    );
    expect(releaseGuide).toContain(
      '"$HOME/.local/bin/echo-brain" person ask --question',
    );
    expect(releaseGuide).not.toMatch(/^echo-brain person (?:records|ask)/m);
  });

  it("is reachable from every shared operator entrypoint", () => {
    const sharedPath =
      "docs/operations/PB-OPERATIONS-001-authority-operator-lane.md";
    expect(readRepoFile("AGENTS.md")).toContain(sharedPath);
    expect(readRepoFile("CLAUDE.md")).toContain(sharedPath);
    expect(readRepoFile("README.md")).toContain(sharedPath);
    expect(readRepoFile("deploy/organization-authority/README.md")).toContain(
      `../../${sharedPath}`,
    );
    expect(readRepoFile("docs/operations/README.md")).toContain(
      "PB-OPERATIONS-001-authority-operator-lane.md",
    );
    const component = readRepoFile("docs/components/operations-release.md");
    expect(component).toContain("playbook_ids:\n  - PB-OPERATIONS-001");
    expect(component).toContain(
      "../operations/PB-OPERATIONS-001-authority-operator-lane.md",
    );
  });
});
