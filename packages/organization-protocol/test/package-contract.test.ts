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
  "./schemas/organization-enrollment-request.v1.schema.json",
  "./schemas/organization-enrollment-receipt.v1.schema.json",
  "./schemas/organization-installation-access-state.v1.schema.json",
  "./schemas/organization-record-envelope.v1.schema.json",
  "./schemas/organization-record-receipt.v1.schema.json",
  "./fixtures/onboarding-access-chain.v1.json",
  "./fixtures/organization-record-chain.v1.json",
  "./fixtures/organization-record-payload-conformance.v1.json",
] as const;

describe("organization protocol package contract", () => {
  it("publishes only the code entry point and exact versioned assets", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [".", ...assetExports].sort(),
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
      "fixtures/**",
    ]);
    expect(packageJson.files).not.toContain("dist/.tsbuildinfo");
  });

  it("depends only on the federation protocol workspace", () => {
    expect(packageJson.dependencies).toEqual({
      "@echo-brain/federation-protocol": "0.0.0-dev.0",
    });
  });

  it("ships no private key or bearer grant in its fixtures", () => {
    for (const name of [
      "fixtures/onboarding-access-chain.v1.json",
      "fixtures/organization-record-chain.v1.json",
      "fixtures/organization-record-payload-conformance.v1.json",
    ]) {
      const fixture = readFileSync(new URL(name, packageRoot), "utf8");
      expect(fixture, name).not.toMatch(/private[_ -]?key/i);
      expect(fixture, name).not.toMatch(/enrollment_grant_base64/i);
      expect(fixture, name).not.toMatch(/enrollment_grant_bytes/i);
    }
  });
});
