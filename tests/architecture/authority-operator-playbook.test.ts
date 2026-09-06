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
  it("keeps every production host change a human action", () => {
    expect(PLAYBOOK).toContain("Coding agents do not start interactive SSM sessions");
    expect(PLAYBOOK).toContain("this repository wraps no SSM Run Command");
    expect(PLAYBOOK).toContain("Agents never open or type into that session.");
    expect(PLAYBOOK).toContain("Do not loop `resume`\nthrough a human gate.");
    const agents = readRepoFile("AGENTS.md");
    expect(agents).toContain("this repository no longer wraps any SSM Run Command");
    expect(agents).toContain("There is no automated release lane.");
  });

  it("keeps onboarding release-bound and Granola-free", () => {
    expect(PLAYBOOK).toContain("<release-matched-kit>/Start ECHO.command");
    expect(PLAYBOOK).toContain("person slack-link");
    expect(PLAYBOOK).toContain("Do not create a live Granola note to rehearse a release.");
    expect(PLAYBOOK).not.toContain("Granola note and Approve DM");
    expect(PLAYBOOK).not.toContain("Google / `echo-brain person login`");
  });

  it("no longer routes to the retired staging slot", () => {
    for (const retired of [
      "authority:staging",
      "slot-init",
      "onboarding-transfer",
      "--require-authority",
      "--initialize-blank-data-volume",
      "restore-clean-v1-host.sh",
      "#automated-current-host-staging-lane",
      "#live-operator-boundary",
    ]) {
      expect(PLAYBOOK).not.toContain(retired);
    }
    const releaseGuide = readRepoFile("deploy/release/README.md");
    expect(releaseGuide).toContain("## EC2 Authority replacement");
    expect(releaseGuide).not.toContain("authority:staging-release");
    expect(releaseGuide).not.toContain("## Automated current-host staging lane");
    expect(readRepoFile("package.json")).not.toContain("authority:staging");
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
