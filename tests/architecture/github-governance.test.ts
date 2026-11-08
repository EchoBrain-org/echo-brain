import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");

/** CODEOWNERS rules as [pattern, ...owners] in file order; GitHub applies the last match. */
const rules = readFileSync(resolve(REPO, ".github/CODEOWNERS"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => line.split(/\s+/));

describe("GitHub release governance", () => {
  it("keeps every protected path rooted in the repository", () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const [pattern] of rules) {
      // Exact paths and directory prefixes only, so a glob cannot become a silent catch-all.
      expect(pattern, pattern).toMatch(/^\/[^*?[\]!\\]+$/);
      expect(existsSync(resolve(REPO, pattern!.slice(1))), pattern).toBe(true);
    }
  });

  it("requires the repository owner for every selecting entrypoint", () => {
    const manifest = JSON.parse(readFileSync(
      resolve(REPO, "product/source-boundary.v1.json"), "utf8",
    )) as { adapter_architecture: { bootstrap_entrypoints: string[] } };
    const paths = [
      "product/source-boundary.v1.json",
      ...manifest.adapter_architecture.bootstrap_entrypoints,
    ];
    expect(paths.length).toBeGreaterThan(1);
    for (const path of paths) {
      // Honor last-match precedence so a later rule cannot pass this check unnoticed.
      const rule = rules.slice().reverse().find(([pattern]) => pattern === `/${path}` ||
        (pattern!.endsWith("/") && `/${path}`.startsWith(pattern!)));
      expect(rule?.slice(1), path).toEqual(["@EchoBrain-org"]);
    }
  });
});
