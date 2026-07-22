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

const EXPECTED_PACKAGE = "@echo-brain/organization-authority";
const EXPECTED_BUNDLES = Object.freeze([
  "@echo-brain/federation-protocol",
  "@echo-brain/organization-protocol",
  "@echo-brain/organization-api",
]);
const EXPECTED_EXTERNALS = Object.freeze(["better-sqlite3"]);

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
      else if (state.isFile())
        files.push(relative(root, path).split(sep).join("/"));
      else
        throw new Error(
          `artifact directory contains a non-file: ${relative(root, path)}`,
        );
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
      `cannot inspect authority tarball: ${stderr || result.error?.message || "tar failed"}`,
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
    manifest.target !== "organization-authority" ||
    manifest.package !== EXPECTED_PACKAGE ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(
      manifest.version,
    ) ||
    typeof manifest.source_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.source_sha) ||
    manifest.source_kind !== "materialized-commit" ||
    manifest.entrypoint !== "dist/main.js" ||
    manifest.launcher !== "bin/echo-organization-authority.mjs" ||
    JSON.stringify(manifest.bundled_workspace_packages) !==
      JSON.stringify(EXPECTED_BUNDLES) ||
    JSON.stringify(manifest.external_runtime_packages) !==
      JSON.stringify(EXPECTED_EXTERNALS) ||
    typeof manifest.dependency_lock_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.dependency_lock_sha256) ||
    typeof manifest.packaged_shrinkwrap_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.packaged_shrinkwrap_sha256) ||
    typeof manifest.runtime_boundary_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.runtime_boundary_sha256) ||
    typeof manifest.source_boundary_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.source_boundary_sha256) ||
    typeof manifest.declared_platform?.os !== "string" ||
    typeof manifest.declared_platform?.architecture !== "string" ||
    typeof manifest.declared_platform?.node !== "string" ||
    typeof manifest.declared_platform?.npm !== "string"
  ) {
    throw new Error("authority artifact manifest identity is invalid");
  }
  if (
    !safeRelativePath(manifest.artifact?.path) ||
    manifest.artifact.path.includes("/") ||
    !Number.isSafeInteger(manifest.artifact.size) ||
    manifest.artifact.size < 1 ||
    typeof manifest.artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.artifact.sha256)
  ) {
    throw new Error("authority artifact manifest tarball entry is invalid");
  }
  if (
    !Array.isArray(manifest.package_files) ||
    manifest.package_files.length === 0
  ) {
    throw new Error(
      "authority artifact package_files must be a non-empty array",
    );
  }
  let previous = null;
  for (const entry of manifest.package_files) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !safeRelativePath(entry.path) ||
      (previous !== null && entry.path <= previous) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(
        "authority artifact package_files contain an unsafe or unsorted entry",
      );
    }
    previous = entry.path;
  }
}

function verifyPackagedContracts(artifactPath, manifest, errors) {
  const listed = String(tar(["-tzf", artifactPath]))
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => !path.endsWith("/"));
  const archivePaths = listed.map((path) => {
    if (!path.startsWith("package/")) {
      throw new Error("authority tarball contains an entry outside package/");
    }
    const relativePath = path.slice("package/".length);
    if (!safeRelativePath(relativePath)) {
      throw new Error("authority tarball contains an unsafe entry");
    }
    return relativePath;
  });
  if (new Set(archivePaths).size !== archivePaths.length) {
    throw new Error("authority tarball contains duplicate entries");
  }
  const expectedPaths = manifest.package_files.map(({ path }) => path);
  if (
    JSON.stringify([...archivePaths].sort()) !== JSON.stringify(expectedPaths)
  ) {
    errors.push("authority tarball file set differs from package_files");
    return;
  }
  for (const entry of manifest.package_files) {
    const bytes = tarEntry(artifactPath, entry.path);
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      errors.push(`authority package entry hash mismatch: ${entry.path}`);
    }
  }

  const packageJson = JSON.parse(
    tarEntry(artifactPath, "package.json").toString("utf8"),
  );
  if (
    packageJson.name !== EXPECTED_PACKAGE ||
    packageJson.version !== manifest.version ||
    packageJson.main !== manifest.entrypoint ||
    packageJson.bin?.["echo-organization-authority"] !== manifest.launcher ||
    JSON.stringify(packageJson.bundleDependencies) !==
      JSON.stringify(EXPECTED_BUNDLES)
  ) {
    errors.push(
      "packaged authority manifest differs from the artifact identity",
    );
  }
  const externals = Object.keys(packageJson.dependencies ?? {})
    .filter((name) => !EXPECTED_BUNDLES.includes(name))
    .sort();
  if (JSON.stringify(externals) !== JSON.stringify([...EXPECTED_EXTERNALS])) {
    errors.push("packaged authority external dependency set is invalid");
  }

  const shrinkwrapBytes = tarEntry(artifactPath, "npm-shrinkwrap.json");
  if (sha256(shrinkwrapBytes) !== manifest.packaged_shrinkwrap_sha256) {
    errors.push("packaged authority shrinkwrap hash mismatch");
  } else {
    const shrinkwrap = JSON.parse(shrinkwrapBytes.toString("utf8"));
    if (
      shrinkwrap.name !== EXPECTED_PACKAGE ||
      shrinkwrap.version !== manifest.version ||
      shrinkwrap.packages?.[""]?.version !== manifest.version
    ) {
      errors.push("packaged authority shrinkwrap identity is invalid");
    }
    for (const [path, metadata] of Object.entries(shrinkwrap.packages ?? {})) {
      if (path === "") continue;
      if (EXPECTED_BUNDLES.some((name) => path === `node_modules/${name}`)) {
        if (metadata.inBundle !== true || metadata.link === true) {
          errors.push(
            `bundled authority workspace lock entry is invalid: ${path}`,
          );
        }
      } else if (
        metadata.link === true ||
        typeof metadata.resolved !== "string" ||
        typeof metadata.integrity !== "string"
      ) {
        errors.push(`external authority lock entry is invalid: ${path}`);
      }
    }
  }

  const identity = JSON.parse(
    tarEntry(artifactPath, "dist/build-identity.v1.json").toString("utf8"),
  );
  if (
    identity?.schema_version !== 1 ||
    identity.kind !== "echo-organization-authority-build-identity" ||
    identity.version !== manifest.version ||
    identity.source_sha !== manifest.source_sha ||
    identity.source_kind !== "materialized-commit"
  ) {
    errors.push("packaged authority build identity is invalid");
  }
}

export function verifyOrganizationAuthorityArtifact({ artifactDir }) {
  const root = resolve(artifactDir);
  const manifestPath = join(root, "artifact-manifest.json");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error("authority artifact manifest is missing");
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
      "authority artifact directory contains missing or unmanifested files",
    );
  }
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    errors.push(`authority artifact is missing: ${manifest.artifact.path}`);
  } else {
    if (statSync(artifactPath).size !== manifest.artifact.size) {
      errors.push("authority artifact size mismatch");
    }
    if (sha256File(artifactPath) !== manifest.artifact.sha256) {
      errors.push("authority artifact SHA-256 mismatch");
    }
  }
  if (!existsSync(checksumPath) || !statSync(checksumPath).isFile()) {
    errors.push("authority artifact checksum sidecar is missing");
  } else if (
    readFileSync(checksumPath, "utf8") !==
    `${manifest.artifact.sha256}  ${manifest.artifact.path}\n`
  ) {
    errors.push("authority artifact checksum sidecar mismatch");
  }
  if (errors.length === 0) {
    verifyPackagedContracts(artifactPath, manifest, errors);
  }
  return {
    ok: errors.length === 0,
    errors: errors.sort(),
    target: "organization-authority",
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
  const result = verifyOrganizationAuthorityArtifact({
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
    process.stderr.write(`authority-verify-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
