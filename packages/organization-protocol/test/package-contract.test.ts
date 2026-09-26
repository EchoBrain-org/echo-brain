import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  exports: Record<string, unknown>;
  files: string[];
  dependencies: Record<string, string>;
}

const packageRoot = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL("package.json", packageRoot), "utf8"),
) as PackageJson;

const assetExports = [
  "./schemas/organization-authority-descriptor.v1.schema.json",
] as const;

describe("organization protocol package contract", () => {
  it("publishes only the code entry point and exact versioned assets", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [".", "./record-codec-support-v4", ...assetExports].sort(),
    );
    for (const subpath of assetExports) {
      const target = packageJson.exports[subpath];
      expect(target).toBe(subpath);
      expect(existsSync(new URL(subpath.slice(2), packageRoot)), subpath).toBe(
        true,
      );
    }
    expect(packageJson.files).toEqual([
      "dist/**/*.js",
      "dist/**/*.js.map",
      "dist/**/*.d.ts",
      "dist/**/*.d.ts.map",
      "schemas/*.schema.json",
    ]);
    expect(packageJson.files).not.toContain("dist/.tsbuildinfo");
  });

  it("depends only on the federation protocol workspace", () => {
    expect(packageJson.dependencies).toEqual({
      "@echo-brain/federation-protocol": "0.0.0-dev.0",
    });
  });
});
