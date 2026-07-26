#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_BUNDLED_WORKSPACES,
  REPO_ROOT,
  assertPackageHasNoBuildPaths,
  copyRequired,
  gitOutput,
  isolatedNpmEnvironment,
  linkMaterializedBuildDependencies,
  materializeCommit,
  parseArgs,
  parseSinglePackResult,
  readJson,
  run,
  safeRemoveTemporary,
  sha256File,
  stageBundledWorkspaces,
  waitAtTestPreflightCheckpoint,
} from "../release/artifact-builder.mjs";

function copyDirectory(source, destination) {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(
      `required authority package directory is missing: ${source}`,
    );
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyRequired(from, to, "authority package input");
    else
      throw new Error(`authority package input contains a non-file: ${from}`);
  }
}

function assertExactReleaseContract(boundary, template) {
  const expectedBundles = ARTIFACT_BUNDLED_WORKSPACES.map(({ name }) => name);
  if (
    boundary?.schema_version !== 1 ||
    boundary.kind !== "echo-runtime-release-boundary" ||
    boundary.target !== "organization-authority" ||
    boundary.package !== "@echo-brain/organization-authority" ||
    boundary.source_boundary !==
      "services/organization-authority/source-boundary.v1.json" ||
    boundary.entrypoint !== "dist/main.js" ||
    boundary.launcher !== "bin/echo-organization-authority.mjs" ||
    boundary.admin_entrypoint !== "dist/admin-main.js" ||
    boundary.admin_launcher !== "bin/echo-organization-admin.mjs"
  ) {
    throw new Error("organization authority runtime boundary is invalid");
  }
  if (
    JSON.stringify(boundary.bundled_workspace_packages) !==
      JSON.stringify(expectedBundles) ||
    JSON.stringify(template.bundleDependencies) !==
      JSON.stringify(expectedBundles)
  ) {
    throw new Error(
      `authority bundleDependencies must be exactly: ${expectedBundles.join(", ")}`,
    );
  }
  if (
    template.name !== boundary.package ||
    template.main !== boundary.entrypoint ||
    template.bin?.["echo-organization-authority"] !== boundary.launcher ||
    template.bin?.["echo-organization-admin"] !== boundary.admin_launcher ||
    template.engines?.node !== boundary.declared_platform?.node ||
    template.engines?.npm !== boundary.declared_platform?.npm
  ) {
    throw new Error(
      "authority package template differs from its runtime boundary",
    );
  }
  const external = Object.keys(template.dependencies ?? {})
    .filter((name) => !expectedBundles.includes(name))
    .sort();
  if (
    JSON.stringify(external) !==
    JSON.stringify([...boundary.external_runtime_packages].sort())
  ) {
    throw new Error(
      "authority external runtime dependency boundary differs from its package template",
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const sourceSha = args["source-sha"].toLowerCase();
  const outDir = resolve(args["out-dir"]);
  const head = gitOutput(["rev-parse", "HEAD"]).toLowerCase();
  if (head !== sourceSha) {
    throw new Error(`source SHA mismatch: HEAD=${head} supplied=${sourceSha}`);
  }
  if (existsSync(outDir))
    throw new Error(`--out-dir already exists: ${outDir}`);

  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${basename(outDir)}.build-`));
  const work = join(temporary, "work");
  const source = join(work, "source");
  const packageDir = join(work, "package");
  try {
    mkdirSync(work, { recursive: true });
    materializeCommit(sourceSha, source, join(work, "source.tar"));
    linkMaterializedBuildDependencies(source);
    run(
      process.execPath,
      ["tools/organization-authority/sync-shrinkwrap.mjs", "--check"],
      {
        cwd: source,
      },
    );
    waitAtTestPreflightCheckpoint({
      readyEnvVar: "RUNTIME_ARTIFACT_TEST_PREFLIGHT_READY_FILE",
      resumeEnvVar: "RUNTIME_ARTIFACT_TEST_CONTINUE_FILE",
      label: "authority",
    });
    run(
      process.execPath,
      [
        join(source, "node_modules/typescript/bin/tsc"),
        "-b",
        join(source, "services/organization-authority"),
      ],
      { cwd: source },
    );

    const boundary = readJson(
      join(source, "release/organization-authority/runtime-boundary.v1.json"),
    );
    const template = readJson(
      join(source, "release/organization-authority/package.template.json"),
    );
    assertExactReleaseContract(boundary, template);

    mkdirSync(packageDir, { recursive: true });
    copyDirectory(
      join(source, "services/organization-authority/dist"),
      join(packageDir, "dist"),
    );
    copyDirectory(
      join(source, "services/organization-authority/migrations"),
      join(packageDir, "migrations"),
    );
    copyRequired(
      join(source, "services/organization-authority/README.md"),
      join(packageDir, "README.md"),
      "authority package input",
    );
    copyRequired(
      join(source, "LICENSE"),
      join(packageDir, "LICENSE"),
      "authority package input",
    );
    writeFileSync(
      join(packageDir, "dist/build-identity.v1.json"),
      `${JSON.stringify({
        schema_version: 1,
        kind: "echo-organization-authority-build-identity",
        version,
        source_sha: sourceSha,
        source_kind: "materialized-commit",
      })}\n`,
    );
    for (const [launcher, entrypoint] of [
      [boundary.launcher, boundary.entrypoint],
      [boundary.admin_launcher, boundary.admin_entrypoint],
    ]) {
      const launcherPath = join(packageDir, launcher);
      mkdirSync(dirname(launcherPath), { recursive: true });
      writeFileSync(
        launcherPath,
        `#!/usr/bin/env node\nawait import(new URL('../${entrypoint}', import.meta.url));\n`,
      );
      chmodSync(launcherPath, 0o755);
    }

    const packageJson = { ...template, version };
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const committedShrinkwrapPath = join(source, "npm-shrinkwrap.json");
    const packagedShrinkwrapPath = join(packageDir, "npm-shrinkwrap.json");
    run(
      process.execPath,
      [
        "tools/organization-authority/sync-shrinkwrap.mjs",
        "--output",
        packagedShrinkwrapPath,
      ],
      { cwd: source },
    );
    const packagedShrinkwrap = readJson(packagedShrinkwrapPath);
    packagedShrinkwrap.version = version;
    packagedShrinkwrap.packages[""].version = version;
    writeFileSync(
      packagedShrinkwrapPath,
      `${JSON.stringify(packagedShrinkwrap, null, 2)}\n`,
    );
    stageBundledWorkspaces(source, packageDir, work);

    const packOutput = run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
      {
        cwd: packageDir,
        env: isolatedNpmEnvironment(join(work, "npm-cache")),
      },
    );
    const packResult = parseSinglePackResult(packOutput, "authority npm pack");
    if (packResult.name !== template.name || packResult.version !== version) {
      throw new Error("npm pack identity differs from the authority release");
    }
    const packedBundles = Array.isArray(packResult.bundled)
      ? [...packResult.bundled].sort()
      : [];
    const expectedBundles = ARTIFACT_BUNDLED_WORKSPACES.map(
      ({ name }) => name,
    ).sort();
    if (JSON.stringify(packedBundles) !== JSON.stringify(expectedBundles)) {
      throw new Error(
        "npm pack did not bundle the exact authority workspace package set",
      );
    }
    const packedPaths = packResult.files.map(({ path }) => path).sort();
    if (
      new Set(packedPaths).size !== packedPaths.length ||
      packedPaths.some(
        (path) =>
          typeof path !== "string" ||
          path === "" ||
          isAbsolute(path) ||
          path
            .split("/")
            .some((part) => part === "" || part === "." || part === "..") ||
          path.startsWith("src/") ||
          path.startsWith("test/") ||
          path.endsWith(".tsbuildinfo"),
      )
    ) {
      throw new Error("authority npm pack reported an unsafe file set");
    }
    for (const required of [
      "package.json",
      "npm-shrinkwrap.json",
      boundary.entrypoint,
      boundary.launcher,
      boundary.admin_entrypoint,
      boundary.admin_launcher,
      "dist/build-identity.v1.json",
      "migrations/0001_single_org_authority.sql",
      "migrations/0002_admin_command_idempotency.sql",
    ]) {
      if (!packedPaths.includes(required)) {
        throw new Error(
          `authority npm pack omitted required file: ${required}`,
        );
      }
    }
    assertPackageHasNoBuildPaths(
      packedPaths.map((path) => join(packageDir, path)),
      [REPO_ROOT, temporary, source],
      "authority package file",
    );
    const packageEntries = packedPaths.map((path) => ({
      path,
      size: statSync(join(packageDir, path)).size,
      sha256: sha256File(join(packageDir, path)),
    }));

    const tarballName = packResult.filename;
    const tarballPath = join(temporary, tarballName);
    if (!existsSync(tarballPath)) {
      throw new Error(`npm pack output is missing: ${tarballName}`);
    }
    const tarballSha256 = sha256File(tarballPath);
    writeFileSync(
      join(temporary, `${tarballName}.sha256`),
      `${tarballSha256}  ${tarballName}\n`,
    );

    const manifest = {
      schema_version: 1,
      kind: "echo-exact-runtime-artifact",
      target: "organization-authority",
      package: template.name,
      version,
      source_sha: sourceSha,
      source_kind: "materialized-commit",
      runtime_boundary_version: boundary.schema_version,
      runtime_boundary_sha256: sha256File(
        join(source, "release/organization-authority/runtime-boundary.v1.json"),
      ),
      source_boundary_sha256: sha256File(
        join(source, boundary.source_boundary),
      ),
      declared_platform: boundary.declared_platform,
      entrypoint: boundary.entrypoint,
      launcher: boundary.launcher,
      admin_entrypoint: boundary.admin_entrypoint,
      admin_launcher: boundary.admin_launcher,
      bundled_workspace_packages: boundary.bundled_workspace_packages,
      external_runtime_packages: boundary.external_runtime_packages,
      dependency_lock_sha256: sha256File(committedShrinkwrapPath),
      packaged_shrinkwrap_sha256: sha256File(packagedShrinkwrapPath),
      build_command: [
        "node",
        "tools/organization-authority/build-artifact.mjs",
        "--version",
        version,
        "--source-sha",
        sourceSha,
        "--out-dir",
        outDir,
      ],
      artifact: {
        path: tarballName,
        size: statSync(tarballPath).size,
        sha256: tarballSha256,
      },
      package_files: packageEntries,
    };
    writeFileSync(
      join(temporary, "artifact-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    safeRemoveTemporary(work, temporary);
    if (existsSync(outDir))
      throw new Error(`--out-dir appeared during build: ${outDir}`);
    renameSync(temporary, outDir);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        target: "organization-authority",
        out_dir: outDir,
        artifact: tarballName,
        sha256: tarballSha256,
      })}\n`,
    );
  } catch (error) {
    if (existsSync(temporary)) safeRemoveTemporary(temporary, parent);
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`authority-build-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
