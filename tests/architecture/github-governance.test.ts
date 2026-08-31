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
  ["/packages/federation-protocol/package.json", "@EchoBrain-org"],
  ["/packages/federation-protocol/tsconfig.json", "@EchoBrain-org"],
  ["/packages/federation-protocol/source-boundary.v1.json", "@EchoBrain-org"],
  ["/packages/organization-protocol/package.json", "@EchoBrain-org"],
  ["/packages/organization-protocol/tsconfig.json", "@EchoBrain-org"],
  ["/packages/organization-protocol/source-boundary.v1.json", "@EchoBrain-org"],
  ["/packages/organization-api/package.json", "@EchoBrain-org"],
  ["/packages/organization-api/tsconfig.json", "@EchoBrain-org"],
  ["/packages/organization-api/source-boundary.v1.json", "@EchoBrain-org"],
  ["/src/product/person-client/package.json", "@EchoBrain-org"],
  ["/src/product/person-client/tsconfig.json", "@EchoBrain-org"],
  ["/src/product/person-client/source-boundary.v1.json", "@EchoBrain-org"],
  ["/services/organization-authority/package.json", "@EchoBrain-org"],
  ["/services/organization-authority/tsconfig.json", "@EchoBrain-org"],
  ["/services/organization-authority/source-boundary.v1.json", "@EchoBrain-org"],
  ["/packages/organization-control-plane/package.json", "@EchoBrain-org"],
  ["/packages/organization-control-plane/tsconfig.json", "@EchoBrain-org"],
  ["/packages/organization-control-plane/source-boundary.v1.json", "@EchoBrain-org"],
  ["/packages/organization-record/package.json", "@EchoBrain-org"],
  ["/packages/organization-record/tsconfig.json", "@EchoBrain-org"],
  ["/packages/organization-record/source-boundary.v1.json", "@EchoBrain-org"],
  ["/packages/organization-retrieval/package.json", "@EchoBrain-org"],
  ["/packages/organization-retrieval/tsconfig.json", "@EchoBrain-org"],
  ["/packages/organization-retrieval/source-boundary.v1.json", "@EchoBrain-org"],
  ["/tests/architecture/ci-workflow.test.ts", "@EchoBrain-org"],
  ["/tests/architecture/github-governance.test.ts", "@EchoBrain-org"],
  [
    "/docs/operations/RB-OPERATIONS-003-protect-canonical-source-and-releases.md",
    "@EchoBrain-org",
  ],
] as const;

function ownershipRules() {
  return readFileSync(CODEOWNERS, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
}

describe("GitHub release governance", () => {
  it("requires the repository owner to review every policy and release surface", () => {
    expect(ownershipRules()).toEqual(EXPECTED_RELEASE_OWNERSHIP);
  });

  it("keeps every protected path rooted in the repository", () => {
    for (const [pattern] of EXPECTED_RELEASE_OWNERSHIP) {
      expect(existsSync(resolve(REPO, pattern.slice(1))), pattern).toBe(true);
    }
  });
});
