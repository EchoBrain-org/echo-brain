import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  spawnSanitizedChild,
  spawnSanitizedChildSync,
} from "../../src/product/spawn-sanitized-child.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "echo-organization-authority-artifact-"),
);

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): CommandResult {
  const result = spawnSanitizedChildSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function copyOwnedBuildSlice(fixture: string): void {
  for (const path of [
    "release/organization-authority",
    "tools/organization-authority",
  ]) {
    cpSync(join(REPO_ROOT, path), join(fixture, path), { recursive: true });
  }
  for (const path of [
    "tools/release/runtime-shrinkwrap.mjs",
    "tools/product/sync-shrinkwrap.mjs",
  ]) {
    const destination = join(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(REPO_ROOT, path), destination);
  }
}

function linkBuildDependencies(fixture: string): void {
  const installed = join(REPO_ROOT, "node_modules");
  const target = join(fixture, "node_modules");
  mkdirSync(target);
  for (const entry of readdirSync(installed, { withFileTypes: true })) {
    if (
      entry.name === "@echo-brain" ||
      entry.name === ".bin" ||
      entry.name === ".package-lock.json"
    ) {
      continue;
    }
    symlinkSync(
      join(installed, entry.name),
      join(target, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
}

function prepareCommittedFixture(): { root: string; sha: string } {
  const fixture = join(temporaryRoot, "exact-source");
  const cloned = run(
    "git",
    ["clone", "--quiet", "--no-hardlinks", REPO_ROOT, fixture],
    { cwd: temporaryRoot },
  );
  expect(cloned.status, cloned.stderr).toBe(0);
  copyOwnedBuildSlice(fixture);
  const added = run(
    "git",
    [
      "add",
      "release/organization-authority",
      "tools/release/runtime-shrinkwrap.mjs",
      "tools/organization-authority",
      "tools/product/sync-shrinkwrap.mjs",
    ],
    { cwd: fixture },
  );
  expect(added.status, added.stderr).toBe(0);
  const committed = run(
    "git",
    [
      "-c",
      "user.name=ECHO Test",
      "-c",
      "user.email=echo-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: materialize authority artifact slice",
    ],
    { cwd: fixture },
  );
  expect(committed.status, committed.stderr).toBe(0);
  linkBuildDependencies(fixture);
  const head = run("git", ["rev-parse", "HEAD"], { cwd: fixture });
  expect(head.status, head.stderr).toBe(0);
  return { root: fixture, sha: head.stdout.trim() };
}

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("organization authority runtime shrinkwrap", () => {
  it("derives the external closure and exactly three in-bundle workspaces", () => {
    const output = join(temporaryRoot, "authority-shrinkwrap.json");
    const generated = run(process.execPath, [
      join(REPO_ROOT, "tools/organization-authority/sync-shrinkwrap.mjs"),
      "--output",
      output,
    ]);
    expect(generated.status, generated.stderr).toBe(0);
    const shrinkwrap = JSON.parse(readFileSync(output, "utf8")) as {
      name: string;
      packages: Record<
        string,
        {
          inBundle?: boolean;
          link?: boolean;
          resolved?: string;
          integrity?: string;
        }
      >;
    };
    expect(shrinkwrap.name).toBe("@echo-brain/organization-authority");
    expect(
      Object.entries(shrinkwrap.packages)
        .filter(([, metadata]) => metadata.inBundle === true)
        .map(([path]) => path)
        .sort(),
    ).toEqual(
      [
        "node_modules/@echo-brain/federation-protocol",
        "node_modules/@echo-brain/organization-api",
        "node_modules/@echo-brain/organization-protocol",
      ].sort(),
    );
    expect(
      shrinkwrap.packages["node_modules/@echo-brain/organization-authority"],
    ).toBeUndefined();
    expect(shrinkwrap.packages["node_modules/better-sqlite3"]).toMatchObject({
      resolved: expect.any(String),
      integrity: expect.any(String),
    });
    for (const [path, metadata] of Object.entries(shrinkwrap.packages)) {
      if (path === "" || metadata.inBundle === true) continue;
      expect(metadata.link, path).not.toBe(true);
      expect(metadata.resolved, path).toEqual(expect.any(String));
      expect(metadata.integrity, path).toEqual(expect.any(String));
    }
  });
});

describe("exact-commit organization authority artifact", () => {
  it("rejects a mismatched source SHA before publishing output", () => {
    const outDir = join(temporaryRoot, "wrong-sha-output");
    const result = run(process.execPath, [
      join(REPO_ROOT, "tools/organization-authority/build-artifact.mjs"),
      "--version",
      "0.1.0-dev.wrong-sha",
      "--source-sha",
      "0000000000000000000000000000000000000000",
      "--out-dir",
      outDir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source SHA mismatch");
    expect(existsSync(outDir)).toBe(false);
  });

  it("packages committed bytes, verifies every file, and rejects tampering", async () => {
    const fixture = prepareCommittedFixture();
    const outDir = join(temporaryRoot, "authority-artifact");
    const ready = join(temporaryRoot, "authority-build-ready");
    const resume = join(temporaryRoot, "authority-build-resume");
    const builder = join(
      fixture.root,
      "tools/organization-authority/build-artifact.mjs",
    );
    const child = spawnSanitizedChild(
      process.execPath,
      [
        builder,
        "--version",
        "0.1.0-dev.phase5",
        "--source-sha",
        fixture.sha,
        "--out-dir",
        outDir,
      ],
      {
        cwd: fixture.root,
        env: {
          NODE_ENV: "test",
          RUNTIME_ARTIFACT_TEST_PREFLIGHT_READY_FILE: ready,
          RUNTIME_ARTIFACT_TEST_CONTINUE_FILE: resume,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    let earlyStatus: number | null | undefined;
    child.once("close", (status) => {
      earlyStatus = status;
    });
    await vi.waitFor(
      () => {
        if (earlyStatus !== undefined) {
          throw new Error(
            `authority builder exited before its checkpoint (${String(earlyStatus)}): ${stderr || stdout}`,
          );
        }
        expect(existsSync(ready)).toBe(true);
      },
      {
        timeout: 15_000,
      },
    );
    const readmePath = join(
      fixture.root,
      "services/organization-authority/README.md",
    );
    const marker = "UNCOMMITTED_AUTHORITY_MUTATION_MUST_NOT_SHIP";
    writeFileSync(
      readmePath,
      `${readFileSync(readmePath, "utf8")}\n${marker}\n`,
    );
    writeFileSync(resume, "continue\n");
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", resolveStatus);
    });
    expect(status, stderr).toBe(0);

    const built = JSON.parse(stdout) as {
      target: string;
      artifact: string;
    };
    expect(built.target).toBe("organization-authority");
    expect(readdirSync(outDir).sort()).toEqual(
      [
        "artifact-manifest.json",
        built.artifact,
        `${built.artifact}.sha256`,
      ].sort(),
    );
    const manifest = JSON.parse(
      readFileSync(join(outDir, "artifact-manifest.json"), "utf8"),
    ) as {
      kind: string;
      target: string;
      package: string;
      source_sha: string;
      bundled_workspace_packages: string[];
      external_runtime_packages: string[];
      package_files: Array<{ path: string }>;
    };
    expect(manifest).toMatchObject({
      kind: "echo-exact-runtime-artifact",
      target: "organization-authority",
      package: "@echo-brain/organization-authority",
      source_sha: fixture.sha,
      external_runtime_packages: ["better-sqlite3"],
    });
    expect(manifest.bundled_workspace_packages).toEqual([
      "@echo-brain/federation-protocol",
      "@echo-brain/organization-protocol",
      "@echo-brain/organization-api",
    ]);
    const paths = manifest.package_files.map(({ path }) => path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(
      expect.arrayContaining([
        "bin/echo-organization-authority.mjs",
        "dist/main.js",
        "dist/build-identity.v1.json",
        "migrations/0001_single_org_authority.sql",
        "node_modules/@echo-brain/federation-protocol/dist/index.js",
        "node_modules/@echo-brain/organization-protocol/dist/index.js",
        "node_modules/@echo-brain/organization-api/dist/index.js",
      ]),
    );
    expect(
      paths.some(
        (path) =>
          path.startsWith("src/") ||
          path.startsWith("test/") ||
          path.includes("experimental") ||
          path.includes("organization-authority/src"),
      ),
    ).toBe(false);

    const packagedReadme = run(
      "/usr/bin/tar",
      ["-xOf", join(outDir, built.artifact), "package/README.md"],
      { cwd: temporaryRoot },
    );
    expect(packagedReadme.status, packagedReadme.stderr).toBe(0);
    expect(packagedReadme.stdout).not.toContain(marker);

    const verifier = join(
      fixture.root,
      "tools/organization-authority/verify-artifact.mjs",
    );
    const verified = run(
      process.execPath,
      [verifier, "--artifact-dir", outDir],
      { cwd: fixture.root },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      errors: [],
      target: "organization-authority",
    });

    const tamperedDir = join(temporaryRoot, "tampered-authority-artifact");
    cpSync(outDir, tamperedDir, { recursive: true });
    writeFileSync(join(tamperedDir, built.artifact), "tampered\n", {
      flag: "a",
    });
    const rejected = run(
      process.execPath,
      [verifier, "--artifact-dir", tamperedDir],
      { cwd: fixture.root },
    );
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "authority artifact SHA-256 mismatch",
        "authority artifact size mismatch",
      ]),
    });

    const swappedDir = join(temporaryRoot, "swapped-authority-artifact");
    cpSync(outDir, swappedDir, { recursive: true });
    const swappedManifestPath = join(swappedDir, "artifact-manifest.json");
    const swappedManifest = JSON.parse(
      readFileSync(swappedManifestPath, "utf8"),
    ) as Record<string, unknown>;
    swappedManifest.target = "employee-product";
    writeFileSync(
      swappedManifestPath,
      `${JSON.stringify(swappedManifest, null, 2)}\n`,
    );
    const swapped = run(
      process.execPath,
      [verifier, "--artifact-dir", swappedDir],
      { cwd: fixture.root },
    );
    expect(swapped.status).toBe(1);
    expect(swapped.stderr).toContain(
      "authority artifact manifest identity is invalid",
    );

    const overwrite = run(
      process.execPath,
      [
        builder,
        "--version",
        "0.1.0-dev.phase5",
        "--source-sha",
        fixture.sha,
        "--out-dir",
        outDir,
      ],
      { cwd: fixture.root },
    );
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toContain("--out-dir already exists");
  }, 120_000);
});
