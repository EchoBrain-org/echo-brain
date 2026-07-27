#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TARGET = "organization-admin-edge";
const EXPECTED_PACKAGE = "@echo-brain/organization-admin-edge";
const EXPECTED_ENTRYPOINT = "dist/main.js";
const EXPECTED_LAUNCHER = "bin/echo-organization-admin-edge.mjs";
const EXPECTED_BUNDLES = Object.freeze([
  "@echo-brain/federation-protocol",
  "@echo-brain/organization-protocol",
  "@echo-brain/organization-api",
]);
const EXPECTED_PLATFORM = Object.freeze({
  os: "darwin",
  architecture: "arm64",
  node: "22.22.1",
  npm: "10.9.4",
});
const REQUIRED_PACKAGE_PATHS = Object.freeze([
  "package.json",
  "npm-shrinkwrap.json",
  EXPECTED_LAUNCHER,
  EXPECTED_ENTRYPOINT,
  "dist/build-identity.v1.json",
  "schemas/organization-admin-edge-preflight.v1.schema.json",
  "README.md",
  "LICENSE",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeRelativePath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.includes("\\") &&
    !posix.isAbsolute(path) &&
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

function directFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const state = lstatSync(path);
      if (state.isSymbolicLink()) {
        throw new Error(
          `artifact directory contains a symlink: ${relative(root, path)}`,
        );
      }
      if (state.isDirectory()) visit(path);
      else if (state.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      } else {
        throw new Error(
          `artifact directory contains a non-file: ${relative(root, path)}`,
        );
      }
    }
  }
  visit(root);
  return files.sort();
}

function tar(commandArgs, encoding = "utf8") {
  const result = spawnSync("/usr/bin/tar", commandArgs, {
    encoding,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    const stderr =
      typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      `cannot inspect administrator edge tarball: ${stderr || result.error?.message || "tar failed"}`,
    );
  }
  return result.stdout;
}

function tarEntry(artifactPath, path) {
  return tar(["-xOf", artifactPath, `package/${path}`], "buffer");
}

function assertManifestShape(manifest) {
  if (
    manifest?.schema_version !== 1 ||
    manifest.kind !== "echo-exact-runtime-artifact" ||
    manifest.target !== TARGET ||
    manifest.package !== EXPECTED_PACKAGE ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(
      manifest.version,
    ) ||
    typeof manifest.source_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.source_sha) ||
    manifest.source_kind !== "materialized-commit" ||
    manifest.runtime_boundary_version !== 1 ||
    manifest.entrypoint !== EXPECTED_ENTRYPOINT ||
    manifest.launcher !== EXPECTED_LAUNCHER ||
    JSON.stringify(manifest.bundled_workspace_packages) !==
      JSON.stringify(EXPECTED_BUNDLES) ||
    !Array.isArray(manifest.external_runtime_packages) ||
    manifest.external_runtime_packages.length !== 0 ||
    JSON.stringify(manifest.declared_platform) !==
      JSON.stringify(EXPECTED_PLATFORM) ||
    typeof manifest.dependency_lock_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.dependency_lock_sha256) ||
    typeof manifest.packaged_shrinkwrap_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.packaged_shrinkwrap_sha256) ||
    typeof manifest.runtime_boundary_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.runtime_boundary_sha256) ||
    typeof manifest.source_boundary_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.source_boundary_sha256)
  ) {
    throw new Error("administrator edge artifact manifest identity is invalid");
  }
  if (
    !safeRelativePath(manifest.artifact?.path) ||
    manifest.artifact.path.includes("/") ||
    !Number.isSafeInteger(manifest.artifact.size) ||
    manifest.artifact.size < 1 ||
    typeof manifest.artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.artifact.sha256)
  ) {
    throw new Error(
      "administrator edge artifact manifest tarball entry is invalid",
    );
  }
  if (
    !Array.isArray(manifest.package_files) ||
    manifest.package_files.length === 0
  ) {
    throw new Error(
      "administrator edge artifact package_files must be a non-empty array",
    );
  }
  let previous = null;
  for (const entry of manifest.package_files) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !safeRelativePath(entry.path) ||
      containsPrivateRuntimeMaterial(entry.path) ||
      (previous !== null && entry.path <= previous) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(
        "administrator edge artifact package_files contain an unsafe or unsorted entry",
      );
    }
    previous = entry.path;
  }
  const packagePaths = new Set(manifest.package_files.map(({ path }) => path));
  for (const requiredPath of REQUIRED_PACKAGE_PATHS) {
    if (!packagePaths.has(requiredPath)) {
      throw new Error(
        `administrator edge artifact package_files omit required runtime path: ${requiredPath}`,
      );
    }
  }
}

function verifyPackageJson(artifactPath, manifest, errors) {
  const packageJson = JSON.parse(
    tarEntry(artifactPath, "package.json").toString("utf8"),
  );
  if (
    packageJson.name !== EXPECTED_PACKAGE ||
    packageJson.version !== manifest.version ||
    packageJson.private !== true ||
    packageJson.type !== "module" ||
    packageJson.scripts !== undefined ||
    packageJson.devDependencies !== undefined ||
    packageJson.optionalDependencies !== undefined ||
    packageJson.peerDependencies !== undefined ||
    packageJson.main !== manifest.entrypoint ||
    packageJson.bin?.["echo-organization-admin-edge"] !== manifest.launcher ||
    JSON.stringify(packageJson.engines) !==
      JSON.stringify({
        node: EXPECTED_PLATFORM.node,
        npm: EXPECTED_PLATFORM.npm,
      }) ||
    JSON.stringify(packageJson.bundleDependencies) !==
      JSON.stringify(EXPECTED_BUNDLES)
  ) {
    errors.push(
      "packaged administrator edge manifest differs from the artifact identity",
    );
  }
  const dependencies = packageJson.dependencies ?? {};
  const dependencyNames = Object.keys(dependencies).sort();
  if (
    JSON.stringify(dependencyNames) !==
      JSON.stringify([...EXPECTED_BUNDLES].sort()) ||
    EXPECTED_BUNDLES.some((name) => dependencies[name] !== "0.0.0-dev.0")
  ) {
    errors.push(
      "packaged administrator edge runtime dependency set is invalid",
    );
  }
}

function verifyShrinkwrap(artifactPath, manifest, errors) {
  const shrinkwrapBytes = tarEntry(artifactPath, "npm-shrinkwrap.json");
  if (sha256(shrinkwrapBytes) !== manifest.packaged_shrinkwrap_sha256) {
    errors.push("packaged administrator edge shrinkwrap hash mismatch");
    return;
  }
  const shrinkwrap = JSON.parse(shrinkwrapBytes.toString("utf8"));
  const root = shrinkwrap.packages?.[""];
  const rootDependencies = root?.dependencies ?? {};
  if (
    shrinkwrap.lockfileVersion !== 3 ||
    shrinkwrap.name !== EXPECTED_PACKAGE ||
    shrinkwrap.version !== manifest.version ||
    root?.name !== EXPECTED_PACKAGE ||
    root?.version !== manifest.version ||
    JSON.stringify(Object.keys(rootDependencies).sort()) !==
      JSON.stringify([...EXPECTED_BUNDLES].sort()) ||
    EXPECTED_BUNDLES.some((name) => rootDependencies[name] !== "0.0.0-dev.0") ||
    JSON.stringify(root?.bundleDependencies) !==
      JSON.stringify(EXPECTED_BUNDLES) ||
    JSON.stringify(root?.bin) !==
      JSON.stringify({
        "echo-organization-admin-edge": EXPECTED_LAUNCHER,
      }) ||
    JSON.stringify(root?.engines) !==
      JSON.stringify({
        node: EXPECTED_PLATFORM.node,
        npm: EXPECTED_PLATFORM.npm,
      })
  ) {
    errors.push("packaged administrator edge shrinkwrap identity is invalid");
  }

  const expectedPaths = [
    "",
    ...EXPECTED_BUNDLES.map((name) => `node_modules/${name}`),
  ].sort();
  const actualPaths = Object.keys(shrinkwrap.packages ?? {}).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    errors.push(
      "packaged administrator edge shrinkwrap contains an unexpected dependency",
    );
    return;
  }
  for (const name of EXPECTED_BUNDLES) {
    const path = `node_modules/${name}`;
    const metadata = shrinkwrap.packages[path];
    if (
      metadata?.inBundle !== true ||
      metadata.link === true ||
      metadata.version !== "0.0.0-dev.0"
    ) {
      errors.push(
        `bundled administrator edge workspace lock entry is invalid: ${path}`,
      );
    }
  }
}

function verifyPackagedContracts(artifactPath, manifest, errors) {
  const listed = String(tar(["-tzf", artifactPath]))
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => !path.endsWith("/"));
  const archivePaths = listed.map((path) => {
    if (!path.startsWith("package/")) {
      throw new Error(
        "administrator edge tarball contains an entry outside package/",
      );
    }
    const relativePath = path.slice("package/".length);
    if (
      !safeRelativePath(relativePath) ||
      containsPrivateRuntimeMaterial(relativePath)
    ) {
      throw new Error("administrator edge tarball contains an unsafe entry");
    }
    return relativePath;
  });
  if (new Set(archivePaths).size !== archivePaths.length) {
    throw new Error("administrator edge tarball contains duplicate entries");
  }
  const expectedPaths = manifest.package_files.map(({ path }) => path);
  if (
    JSON.stringify([...archivePaths].sort()) !== JSON.stringify(expectedPaths)
  ) {
    errors.push(
      "administrator edge tarball file set differs from package_files",
    );
    return;
  }
  for (const entry of manifest.package_files) {
    const bytes = tarEntry(artifactPath, entry.path);
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      errors.push(
        `administrator edge package entry hash mismatch: ${entry.path}`,
      );
    }
  }

  verifyPackageJson(artifactPath, manifest, errors);
  verifyShrinkwrap(artifactPath, manifest, errors);

  const identity = JSON.parse(
    tarEntry(artifactPath, "dist/build-identity.v1.json").toString("utf8"),
  );
  if (
    identity?.schema_version !== 1 ||
    identity.kind !== "echo-organization-admin-edge-build-identity" ||
    identity.version !== manifest.version ||
    identity.source_sha !== manifest.source_sha ||
    identity.source_kind !== "materialized-commit"
  ) {
    errors.push("packaged administrator edge build identity is invalid");
  }
}

export function verifyOrganizationAdminEdgeArtifact({ artifactDir }) {
  const root = resolve(artifactDir);
  const manifestPath = join(root, "artifact-manifest.json");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error("administrator edge artifact manifest is missing");
  }
  const manifest = readJson(manifestPath);
  assertManifestShape(manifest);
  const artifactPath = join(root, manifest.artifact.path);
  const checksumPath = `${artifactPath}.sha256`;
  const expectedFiles = [
    "artifact-manifest.json",
    manifest.artifact.path,
    `${manifest.artifact.path}.sha256`,
  ].sort();
  const errors = [];
  if (JSON.stringify(directFiles(root)) !== JSON.stringify(expectedFiles)) {
    errors.push(
      "administrator edge artifact directory contains missing or unmanifested files",
    );
  }
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    errors.push(
      `administrator edge artifact is missing: ${manifest.artifact.path}`,
    );
  } else {
    if (statSync(artifactPath).size !== manifest.artifact.size) {
      errors.push("administrator edge artifact size mismatch");
    }
    if (sha256File(artifactPath) !== manifest.artifact.sha256) {
      errors.push("administrator edge artifact SHA-256 mismatch");
    }
  }
  if (!existsSync(checksumPath) || !statSync(checksumPath).isFile()) {
    errors.push("administrator edge artifact checksum sidecar is missing");
  } else if (
    readFileSync(checksumPath, "utf8") !==
    `${manifest.artifact.sha256}  ${manifest.artifact.path}\n`
  ) {
    errors.push("administrator edge artifact checksum sidecar mismatch");
  }
  if (errors.length === 0) {
    verifyPackagedContracts(artifactPath, manifest, errors);
  }
  return {
    ok: errors.length === 0,
    errors: errors.sort(),
    target: TARGET,
    artifact_manifest: manifest,
    artifact_manifest_sha256: sha256File(manifestPath),
    artifact_path: artifactPath,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--artifact-dir", "--output"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
  }
  if (!isAbsolute(args["artifact-dir"] ?? "")) {
    throw new Error("--artifact-dir must be absolute");
  }
  if (args.output !== undefined && !isAbsolute(args.output)) {
    throw new Error("--output must be absolute");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyOrganizationAdminEdgeArtifact({
    artifactDir: args["artifact-dir"],
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output === undefined) process.stdout.write(serialized);
  else writeFileSync(resolve(args.output), serialized);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`admin-edge-verify-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
