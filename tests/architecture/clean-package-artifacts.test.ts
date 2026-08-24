import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const RETIRED_ARTIFACTS = [
  {
    packagePath: "packages/federation-protocol",
    retiredPath: "dist/installation-key-descriptor.js",
  },
  {
    packagePath: "packages/organization-protocol",
    retiredPath: "dist/record-envelope-v3.js",
  },
  {
    packagePath: "packages/organization-api",
    retiredPath: "dist/access-lease-request.js",
  },
] as const;

function npmPackDryRun(packageRoot: string): { files: Array<{ path: string }> } {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath === undefined ? "npm" : process.execPath;
  const args = [
    ...(npmExecPath === undefined ? [] : [npmExecPath]),
    "pack",
    "--dry-run",
    "--json",
  ];
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return (JSON.parse(result.stdout) as Array<{
    files: Array<{ path: string }>;
  }>)[0];
}

describe("clean workspace package artifacts", () => {
  it("removes stale retired dist modules before each package pack", () => {
    for (const artifact of RETIRED_ARTIFACTS) {
      const packageRoot = resolve(REPO, artifact.packagePath);
      const manifest = JSON.parse(
        readFileSync(resolve(packageRoot, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };
      expect(manifest.scripts?.prepack).toBe("npm run clean && npm run build");

      const staleArtifact = resolve(packageRoot, artifact.retiredPath);
      mkdirSync(dirname(staleArtifact), { recursive: true });
      writeFileSync(staleArtifact, "export const retired = true;\n");
      expect(existsSync(staleArtifact)).toBe(true);
      try {
        const packed = npmPackDryRun(packageRoot);
        const retiredPackPath = relative(packageRoot, staleArtifact);
        expect(packed.files.map((file) => file.path)).not.toContain(
          retiredPackPath,
        );
        expect(existsSync(staleArtifact)).toBe(false);
      } finally {
        rmSync(staleArtifact, { force: true });
      }
    }
  });
});
