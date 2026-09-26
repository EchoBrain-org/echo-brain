import { readFileSync } from "node:fs";
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

describe("organization protocol package contract", () => {
  it("publishes only the code entry points", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [".", "./record-codec-support-v4"].sort(),
    );
    expect(packageJson.files).toEqual([
      "dist/**/*.js",
      "dist/**/*.js.map",
      "dist/**/*.d.ts",
      "dist/**/*.d.ts.map",
    ]);
    expect(packageJson.files).not.toContain("dist/.tsbuildinfo");
  });

  it("depends only on the federation protocol workspace", () => {
    expect(packageJson.dependencies).toEqual({
      "@echo-brain/federation-protocol": "0.0.0-dev.0",
    });
  });
});
