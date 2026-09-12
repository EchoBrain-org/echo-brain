import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const CODEOWNERS = resolve(REPO, ".github/CODEOWNERS");

const EXPECTED_RELEASE_OWNERSHIP = [
  ["/.github/", "@EchoBrain-org"],
  ["/tools/", "@EchoBrain-org"],
  ["/deploy/release/", "@EchoBrain-org"],
  ["/deploy/organization-authority/", "@EchoBrain-org"],
  ["/package.json", "@EchoBrain-org"],
  ["/npm-shrinkwrap.json", "@EchoBrain-org"],
  ["/.nvmrc", "@EchoBrain-org"],
  ["/.dockerignore", "@EchoBrain-org"],
  ["/eslint.config.js", "@EchoBrain-org"],
  ["/tsconfig.build.json", "@EchoBrain-org"],
  ["/tsconfig.json", "@EchoBrain-org"],
  ["/tsconfig.workspaces.json", "@EchoBrain-org"],
  ["/vitest.config.ts", "@EchoBrain-org"],
  ["/vitest.package.config.ts", "@EchoBrain-org"],
  ["/docs/operations/RB-OPERATIONS-003-protect-canonical-source-and-releases.md", "@EchoBrain-org"],
  ["/product/", "@EchoBrain-org"],
  ["/packages/", "@EchoBrain-org"],
  ["/providers/", "@EchoBrain-org"],
  ["/services/", "@EchoBrain-org"],
  ["/src/product/person-client/", "@EchoBrain-org"],
  ["/tests/architecture/", "@EchoBrain-org"],
  ["/docs/architecture/", "@EchoBrain-org"],
  ["/docs/invariants/", "@EchoBrain-org"],
  ["/docs/qualification/", "@EchoBrain-org"],
] as const;

function ownershipRules() {
  return readFileSync(CODEOWNERS, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
}

describe("GitHub release governance", () => {
  it("protects provider ownership, public ports, and selecting entrypoints", () => {
    const manifest = JSON.parse(readFileSync(
      resolve(REPO, "product/source-boundary.v1.json"), "utf8",
    )) as { adapter_architecture: { bootstrap_entrypoints: string[] } };
    const paths = [
      "product/source-boundary.v1.json",
      "providers/slack/server/src/setup/initial-owner-slack-setup-v1.ts",
      "providers/slack/client/swift/slack-connected-tools.swift",
      "packages/organization-processing/src/core/contracts",
      "packages/organization-processing/src/ports/approval-workflow-bundle-v1.ts",
      "docs/invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md",
      ...manifest.adapter_architecture.bootstrap_entrypoints,
    ];
    const rules = ownershipRules();
    for (const path of paths) {
      // These repository rules use exact paths or directory prefixes. Honor
      // last-match precedence so a later unowned entry cannot pass this check.
      const rule = rules.slice().reverse().find(([pattern]) => pattern === `/${path}` ||
        (pattern!.endsWith("/") && `/${path}`.startsWith(pattern!)));
      expect(rule?.slice(1), path).toEqual(["@EchoBrain-org"]);
    }
  });

  it("requires the repository owner to review every policy and release surface", () => {
    expect(ownershipRules()).toEqual(EXPECTED_RELEASE_OWNERSHIP);
  });

  it("keeps every protected path rooted in the repository", () => {
    for (const [pattern] of EXPECTED_RELEASE_OWNERSHIP) {
      expect(existsSync(resolve(REPO, pattern.slice(1))), pattern).toBe(true);
    }
  });
});
