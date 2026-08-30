#!/usr/bin/env node

/**
 * Produce the one immutable, ARM64/Linux verifier bundle accepted by the
 * isolated recovery-helper stack. This is intentionally not a deployment
 * artifact: it contains no clean-data, environment file, credentials, image,
 * or cloud configuration.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const NODE_VERSION = "v22.22.1";
const BUNDLE_SUFFIX = ".tar.gz";

function fail(message) {
  throw new Error(`authority recovery helper bundle: ${message}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch {
    fail(`${file} did not complete successfully`);
  }
}

function regularDirectory(path, label) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (state.isSymbolicLink() || !state.isDirectory())
    fail(`${label} must be a directory, not a symlink`);
}

function regularFile(path, label) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (state.isSymbolicLink() || !state.isFile())
    fail(`${label} must be a regular file, not a symlink`);
}

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--source-root" ||
    argv[2] !== "--output"
  ) {
    fail(
      "usage: build-authority-recovery-helper-bundle.mjs --source-root <unchanged-repository-root> --output <new-bundle.tar.gz>",
    );
  }
  const sourceRoot = resolve(argv[1]);
  const output = resolve(argv[3]);
  if (
    !basename(output).endsWith(BUNDLE_SUFFIX) ||
    existsSync(output) ||
    existsSync(`${output}.manifest.json`)
  ) {
    fail("output and its manifest must be new .tar.gz paths");
  }
  return Object.freeze({ sourceRoot, output });
}

function checkedCommit(sourceRoot) {
  regularDirectory(sourceRoot, "source root");
  const status = run("git", [
    "-C",
    sourceRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "")
    fail("source root must have no tracked or untracked changes");
  const commit = run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]).trim();
  if (!SOURCE_SHA.test(commit))
    fail("source root must resolve a full Git commit");
  return commit;
}

function requiredBuildPaths(sourceRoot) {
  const paths = [
    "npm-shrinkwrap.json",
    "node_modules",
    "tools/verify-authority-recovery.mjs",
    "tools/clean-v1-release.mjs",
    "tools/clean-v1-runtime-profile.mjs",
    "services/organization-authority/dist/composition/verify-authority-state-lineage.js",
  ];
  for (const path of paths) {
    const absolute = join(sourceRoot, path);
    if (path === "node_modules") regularDirectory(absolute, path);
    else regularFile(absolute, path);
  }
  return paths;
}

function copyWorkspaceBuildOutputs(sourceRoot, stageRoot) {
  for (const group of ["packages", "services", "src/product"]) {
    const sourceGroup = join(sourceRoot, group);
    if (!existsSync(sourceGroup)) continue;
    regularDirectory(sourceGroup, group);
    for (const entry of readdirSync(sourceGroup, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const output = join(sourceGroup, entry.name, "dist");
      if (!existsSync(output)) continue;
      regularDirectory(output, `${group}/${entry.name}/dist`);
      const destination = join(stageRoot, "source", group, entry.name, "dist");
      mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      cpSync(output, destination, {
        dereference: false,
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }
}

function makeBundle({ sourceRoot, output }) {
  if (
    process.platform !== "linux" ||
    process.arch !== "arm64" ||
    process.version !== NODE_VERSION
  ) {
    fail(`must run on Linux ARM64 with Node ${NODE_VERSION}`);
  }
  const commit = checkedCommit(sourceRoot);
  run("npm", ["run", "build:workspaces"], { cwd: sourceRoot });
  const requiredPaths = requiredBuildPaths(sourceRoot);
  const lockDigest = sha256(join(sourceRoot, "npm-shrinkwrap.json"));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const stageRoot = mkdtempSync(
    join(tmpdir(), "echo-authority-recovery-bundle-"),
  );
  try {
    const sourceTar = join(stageRoot, "source.tar");
    run("git", [
      "-C",
      sourceRoot,
      "archive",
      "--format=tar",
      `--output=${sourceTar}`,
      "--prefix=source/",
      commit,
    ]);
    run("tar", ["-xf", sourceTar, "-C", stageRoot]);
    cpSync(
      join(sourceRoot, "node_modules"),
      join(stageRoot, "source", "node_modules"),
      {
        dereference: false,
        recursive: true,
        verbatimSymlinks: true,
      },
    );
    copyWorkspaceBuildOutputs(sourceRoot, stageRoot);
    const runtimeDirectory = join(stageRoot, "runtime");
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o755 });
    copyFileSync(process.execPath, join(runtimeDirectory, "node"));
    chmodSync(join(runtimeDirectory, "node"), 0o755);

    writeFileSync(
      join(stageRoot, "source", "recovery-helper-bundle.manifest.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          kind: "echo-authority-recovery-helper-bundle-v1",
          source_commit: commit,
          node_version: process.version,
          platform: process.platform,
          architecture: process.arch,
          npm_shrinkwrap_sha256: lockDigest,
          required_paths: requiredPaths,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    const node = join(runtimeDirectory, "node");
    const stagedSource = join(stageRoot, "source");
    run(node, [
      "--check",
      join(stagedSource, "tools/verify-authority-recovery.mjs"),
    ]);
    run(
      node,
      [
        join(stagedSource, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.config.ts",
        "tests/architecture/authority-recovery-verifier.test.ts",
      ],
      { cwd: stagedSource },
    );
    run("tar", ["-C", stageRoot, "-czf", output, "runtime", "source"]);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  const manifest = Object.freeze({
    schema_version: 1,
    kind: "echo-authority-recovery-helper-bundle-v1",
    source_commit: commit,
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    npm_shrinkwrap_sha256: lockDigest,
    archive_sha256: sha256(output),
    required_paths: requiredPaths,
  });
  writeFileSync(
    `${output}.manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
  return manifest;
}

try {
  const manifest = makeBundle(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
