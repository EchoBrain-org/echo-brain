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

  it("automates routine staging execution but retains human approval and proven reads before promotion", () => {
    expect(PLAYBOOK).toContain(
      "../../deploy/release/README.md#ec2-authority-replacement",
    );
    expect(PLAYBOOK).toContain(
      "After `stage` and synthetic `canary`, stop for the founder's private Slack-card\napproval.",
    );
    expect(PLAYBOOK).toContain(
      "Only after both checks pass, show their evidence and ask\nthe founder for the final decision on that exact candidate.",
    );
    expect(PLAYBOOK).toContain("Plan and execute are machine steps, not repeated human approval prompts.");
    expect(PLAYBOOK).toContain("release- and client-digest-bound authorization");
    expect(PLAYBOOK).toContain("Never create it merely because\nthe PR was approved or the founder authorized automation.");
    const releaseGuide = readRepoFile("deploy/release/README.md");
    expect(releaseGuide).toContain(
      '"$HOME/.local/bin/echo-brain" person records --query',
    );
    expect(releaseGuide).toContain(
      '"$HOME/.local/bin/echo-brain" person ask --question',
    );
    expect(releaseGuide).not.toMatch(/^echo-brain person (?:records|ask)/m);
    expect(releaseGuide).toContain("The CLI never\ncreates it automatically.");
    expect(releaseGuide).toContain('"release_authorized": true');
  });

  it("limits delegated execution to the reviewed current-host staging CLI", () => {
    expect(PLAYBOOK).toContain("uses the reviewed `authority:staging-release`");
    expect(PLAYBOOK).toContain("Coding agents do not start interactive SSM sessions.");
    expect(PLAYBOOK).toContain("Other host actions remain human-only");
    expect(PLAYBOOK).toContain("Unknown drift, unconfirmed remote\nexecution, or destructive changes");
    expect(PLAYBOOK).toContain("The Cloud\nboundary in `AGENTS.md` wins.");
    const agents = readRepoFile("AGENTS.md");
    expect(agents).toContain("`npm run authority:staging-release` CLI");
    expect(agents).toContain("Host-local onboarding remains in the human Session Manager lane.");
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
