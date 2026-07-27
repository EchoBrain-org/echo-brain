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
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
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

const TARGET = "organization-admin-edge";
const PACKAGE_NAME = "@echo-brain/organization-admin-edge";
const SERVICE_ROOT = "services/organization-admin-edge";
const RELEASE_ROOT = "release/organization-admin-edge";
const TOOL_ROOT = "tools/organization-admin-edge";
const ENTRYPOINT = "dist/main.js";
const LAUNCHER = "bin/echo-organization-admin-edge.mjs";
const BUILD_IDENTITY = "dist/build-identity.v1.json";
const FOUNDER_LIVE_EVIDENCE_SCHEMA =
  "schemas/organization-admin-edge-founder-live-evidence.v1.schema.json";
const EXPECTED_OPERATOR_TOOLS = Object.freeze([
  "tools/organization-admin-edge/verify-artifact.mjs",
  "tools/organization-admin-edge/install-release.mjs",
  "tools/organization-admin-edge/prepare-launchd.mjs",
  "tools/organization-admin-edge/create-founder-live-plan.mjs",
  "tools/organization-admin-edge/verify-founder-live-activation.mjs",
  "tools/organization-admin-edge/validate-founder-live-evidence.mjs",
]);
const EXPECTED_BUNDLES = Object.freeze(
  ARTIFACT_BUNDLED_WORKSPACES.map(({ name }) => name),
);
const EXPECTED_PACKAGE_FILES = Object.freeze([
  "bin/**",
  "dist/**/*.js",
  "dist/**/*.js.map",
  BUILD_IDENTITY,
  "schemas/*.schema.json",
  ...EXPECTED_OPERATOR_TOOLS,
  "npm-shrinkwrap.json",
  "README.md",
  "LICENSE",
]);

function copyDirectory(source, destination) {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(
      `required administrator edge package directory is missing: ${source}`,
    );
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile())
      copyRequired(from, to, "administrator edge package input");
    else {
      throw new Error(
        `administrator edge package input contains a non-file: ${from}`,
      );
    }
  }
}

function assertExactReleaseContract(boundary, template) {
  if (
    boundary?.schema_version !== 1 ||
    boundary.kind !== "echo-runtime-release-boundary" ||
    boundary.target !== TARGET ||
    boundary.package !== PACKAGE_NAME ||
    boundary.source_boundary !== `${SERVICE_ROOT}/source-boundary.v1.json` ||
    boundary.entrypoint !== ENTRYPOINT ||
    boundary.launcher !== LAUNCHER ||
    boundary.founder_live_evidence_schema !== FOUNDER_LIVE_EVIDENCE_SCHEMA ||
    boundary.operator_tools_runtime_imported !== false ||
    JSON.stringify(boundary.operator_tools) !==
      JSON.stringify(EXPECTED_OPERATOR_TOOLS) ||
    boundary.mutable_state?.packaged !== false
  ) {
    throw new Error(
      "organization administrator edge runtime boundary is invalid",
    );
  }
  if (
    JSON.stringify(boundary.bundled_workspace_packages) !==
      JSON.stringify(EXPECTED_BUNDLES) ||
    JSON.stringify(template.bundleDependencies) !==
      JSON.stringify(EXPECTED_BUNDLES)
  ) {
    throw new Error(
      `administrator edge bundleDependencies must be exactly: ${EXPECTED_BUNDLES.join(", ")}`,
    );
  }
  if (
    !Array.isArray(boundary.external_runtime_packages) ||
    boundary.external_runtime_packages.length !== 0
  ) {
    throw new Error(
      "organization administrator edge must not declare external runtime packages",
    );
  }
  if (
    template.name !== boundary.package ||
    template.private !== true ||
    template.type !== "module" ||
    template.scripts !== undefined ||
    template.devDependencies !== undefined ||
    template.optionalDependencies !== undefined ||
    template.peerDependencies !== undefined ||
    template.main !== boundary.entrypoint ||
    template.bin?.["echo-organization-admin-edge"] !== boundary.launcher ||
    JSON.stringify(template.files) !== JSON.stringify(EXPECTED_PACKAGE_FILES) ||
    template.engines?.node !== boundary.declared_platform?.node ||
    template.engines?.npm !== boundary.declared_platform?.npm ||
    boundary.declared_platform?.os !== "darwin" ||
    boundary.declared_platform?.architecture !== "arm64"
  ) {
    throw new Error(
      "administrator edge package template differs from its runtime boundary",
    );
  }
  const dependencyNames = Object.keys(template.dependencies ?? {}).sort();
  if (
    JSON.stringify(dependencyNames) !==
    JSON.stringify([...EXPECTED_BUNDLES].sort())
  ) {
    throw new Error(
      "administrator edge runtime dependencies must be exactly the bundled workspaces",
    );
  }
}

function safePackagePath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.includes("\\") &&
    !isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

function containsPrivateRuntimeMaterial(path) {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  return (
    parts.some((part) =>
      [
        "certificate",
        "certificates",
        "credential",
        "credentials",
        "secret",
        "secrets",
      ].includes(part),
    ) ||
    /(?:^|\/)\.env(?:\.|$)/.test(lower) ||
    /\.(?:cer|crt|der|key|p12|pem|pfx)$/.test(lower)
  );
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
  if (existsSync(outDir)) {
    throw new Error(`--out-dir already exists: ${outDir}`);
  }

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
    run(process.execPath, [`${TOOL_ROOT}/sync-shrinkwrap.mjs`, "--check"], {
      cwd: source,
    });
    waitAtTestPreflightCheckpoint({
      readyEnvVar: "RUNTIME_ARTIFACT_TEST_PREFLIGHT_READY_FILE",
      resumeEnvVar: "RUNTIME_ARTIFACT_TEST_CONTINUE_FILE",
      label: "administrator edge",
    });
    run(
      process.execPath,
      [
        join(source, "node_modules/typescript/bin/tsc"),
        "-b",
        join(source, SERVICE_ROOT),
      ],
      { cwd: source },
    );

    const boundaryPath = join(source, RELEASE_ROOT, "runtime-boundary.v1.json");
    const templatePath = join(source, RELEASE_ROOT, "package.template.json");
    const boundary = readJson(boundaryPath);
    const template = readJson(templatePath);
    assertExactReleaseContract(boundary, template);

    mkdirSync(packageDir, { recursive: true });
    copyDirectory(join(source, SERVICE_ROOT, "dist"), join(packageDir, "dist"));
    copyDirectory(
      join(source, SERVICE_ROOT, "schemas"),
      join(packageDir, "schemas"),
    );
    copyRequired(
      join(source, FOUNDER_LIVE_EVIDENCE_SCHEMA),
      join(packageDir, FOUNDER_LIVE_EVIDENCE_SCHEMA),
      "administrator edge Founder Live evidence schema",
    );
    for (const operatorTool of EXPECTED_OPERATOR_TOOLS) {
      copyRequired(
        join(source, operatorTool),
        join(packageDir, operatorTool),
        "administrator edge operator tool",
      );
    }
    copyRequired(
      join(source, SERVICE_ROOT, "README.md"),
      join(packageDir, "README.md"),
      "administrator edge package input",
    );
    copyRequired(
      join(source, "LICENSE"),
      join(packageDir, "LICENSE"),
      "administrator edge package input",
    );
    writeFileSync(
      join(packageDir, BUILD_IDENTITY),
      `${JSON.stringify({
        schema_version: 1,
        kind: "echo-organization-admin-edge-build-identity",
        version,
        source_sha: sourceSha,
        source_kind: "materialized-commit",
      })}\n`,
    );

    const launcherPath = join(packageDir, boundary.launcher);
    mkdirSync(dirname(launcherPath), { recursive: true });
    writeFileSync(
      launcherPath,
      `#!/usr/bin/env node\nawait import(new URL('../${boundary.entrypoint}', import.meta.url));\n`,
    );
    chmodSync(launcherPath, 0o755);

    const packageJson = { ...template, version };
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const committedShrinkwrapPath = join(source, "npm-shrinkwrap.json");
    const packagedShrinkwrapPath = join(packageDir, "npm-shrinkwrap.json");
    run(
      process.execPath,
      [`${TOOL_ROOT}/sync-shrinkwrap.mjs`, "--output", packagedShrinkwrapPath],
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
    const packResult = parseSinglePackResult(
      packOutput,
      "administrator edge npm pack",
    );
    if (packResult.name !== template.name || packResult.version !== version) {
      throw new Error(
        "npm pack identity differs from the administrator edge release",
      );
    }
    const packedBundles = Array.isArray(packResult.bundled)
      ? [...packResult.bundled].sort()
      : [];
    if (
      JSON.stringify(packedBundles) !==
      JSON.stringify([...EXPECTED_BUNDLES].sort())
    ) {
      throw new Error(
        "npm pack did not bundle the exact administrator edge workspace package set",
      );
    }
    const packedPaths = packResult.files.map(({ path }) => path).sort();
    if (
      new Set(packedPaths).size !== packedPaths.length ||
      packedPaths.some(
        (path) =>
          !safePackagePath(path) ||
          path.startsWith("src/") ||
          path.startsWith("test/") ||
          path.endsWith(".tsbuildinfo") ||
          containsPrivateRuntimeMaterial(path),
      )
    ) {
      throw new Error(
        "administrator edge npm pack reported an unsafe file set",
      );
    }
    for (const required of [
      "package.json",
      "npm-shrinkwrap.json",
      boundary.entrypoint,
      boundary.launcher,
      BUILD_IDENTITY,
      "schemas/organization-admin-edge-preflight.v1.schema.json",
      boundary.founder_live_evidence_schema,
      ...boundary.operator_tools,
      "README.md",
      "LICENSE",
    ]) {
      if (!packedPaths.includes(required)) {
        throw new Error(
          `administrator edge npm pack omitted required file: ${required}`,
        );
      }
    }
    assertPackageHasNoBuildPaths(
      packedPaths.map((path) => join(packageDir, path)),
      [REPO_ROOT, temporary, source],
      "administrator edge package file",
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
      target: TARGET,
      package: template.name,
      version,
      source_sha: sourceSha,
      source_kind: "materialized-commit",
      runtime_boundary_version: boundary.schema_version,
      runtime_boundary_sha256: sha256File(boundaryPath),
      source_boundary_sha256: sha256File(
        join(source, boundary.source_boundary),
      ),
      declared_platform: boundary.declared_platform,
      entrypoint: boundary.entrypoint,
      launcher: boundary.launcher,
      founder_live_evidence_schema: boundary.founder_live_evidence_schema,
      operator_tools_runtime_imported: boundary.operator_tools_runtime_imported,
      operator_tools: boundary.operator_tools,
      bundled_workspace_packages: boundary.bundled_workspace_packages,
      external_runtime_packages: boundary.external_runtime_packages,
      dependency_lock_sha256: sha256File(committedShrinkwrapPath),
      packaged_shrinkwrap_sha256: sha256File(packagedShrinkwrapPath),
      build_command: [
        "node",
        `${TOOL_ROOT}/build-artifact.mjs`,
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
    if (existsSync(outDir)) {
      throw new Error(`--out-dir appeared during build: ${outDir}`);
    }
    renameSync(temporary, outDir);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        target: TARGET,
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
    process.stderr.write(`admin-edge-build-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
