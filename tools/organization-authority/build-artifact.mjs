#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, "../..");
const BUNDLED_WORKSPACES = Object.freeze([
  {
    name: "@echo-brain/federation-protocol",
    directory: "packages/federation-protocol",
  },
  {
    name: "@echo-brain/organization-protocol",
    directory: "packages/organization-protocol",
  },
  {
    name: "@echo-brain/organization-api",
    directory: "packages/organization-api",
  },
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--version", "--source-sha", "--out-dir"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
  }
  for (const flag of ["version", "source-sha", "out-dir"]) {
    if (args[flag] === undefined) throw new Error(`--${flag} is required`);
  }
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(args.version)) {
    throw new Error("--version must be a valid prerelease version");
  }
  if (!/^[0-9a-fA-F]{40}$/.test(args["source-sha"])) {
    throw new Error("--source-sha must be a full 40-character commit SHA");
  }
  if (!isAbsolute(args["out-dir"])) {
    throw new Error("--out-dir must be absolute");
  }
  return args;
}

function run(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeout ?? 180_000,
  };
  let result;
  if (command === "git") result = spawnSync("git", args, spawnOptions);
  else if (command === "/usr/bin/tar")
    result = spawnSync("/usr/bin/tar", args, spawnOptions);
  else if (command === "npm") result = spawnSync("npm", args, spawnOptions);
  else if (command === process.execPath)
    result = spawnSync(process.execPath, args, spawnOptions);
  else throw new Error(`unsupported authority build command: ${command}`);
  if (result.status !== 0) {
    const stderr =
      typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout =
      typeof result.stdout === "string" ? result.stdout.trim() : "";
    throw new Error(
      `${basename(command)} ${args.join(" ")} failed (${String(result.status)}): ${stderr || stdout || result.error?.message || "no output"}`,
    );
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function gitOutput(args) {
  return run("git", args, { cwd: REPO_ROOT }).trim();
}

function materializeCommit(sourceSha, destination, archivePath) {
  mkdirSync(destination, { recursive: true });
  const archiveFd = openSync(archivePath, "w");
  try {
    run("git", ["archive", "--format=tar", sourceSha], {
      cwd: REPO_ROOT,
      encoding: "buffer",
      stdio: ["ignore", archiveFd, "pipe"],
    });
  } finally {
    closeSync(archiveFd);
  }
  run("/usr/bin/tar", ["-xf", archivePath, "-C", destination]);
}

function linkMaterializedBuildDependencies(source) {
  const installed = join(REPO_ROOT, "node_modules");
  if (!existsSync(installed) || !lstatSync(installed).isDirectory()) {
    throw new Error("root node_modules is required after npm ci");
  }
  const materialized = join(source, "node_modules");
  mkdirSync(materialized, { recursive: true });
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
      join(materialized, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
  const scope = join(materialized, "@echo-brain");
  mkdirSync(scope, { recursive: true });
  for (const workspace of BUNDLED_WORKSPACES) {
    symlinkSync(
      join(source, workspace.directory),
      join(scope, workspace.name.slice("@echo-brain/".length)),
      "dir",
    );
  }
}

function isolatedNpmEnvironment(cache) {
  return {
    ...process.env,
    npm_config_cache: cache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function parseSinglePackResult(output, context) {
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(`${context} did not emit exactly one artifact record`);
  }
  if (!Array.isArray(result[0].files)) {
    throw new Error(`${context} did not report its packed file set`);
  }
  return result[0];
}

function filesUnder(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else
        throw new Error(`package staging contains a non-file entry: ${path}`);
    }
  }
  visit(root);
  return files.sort();
}

function copyRequired(source, destination) {
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`required authority package input is missing: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

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
    else if (entry.isFile()) copyRequired(from, to);
    else
      throw new Error(`authority package input contains a non-file: ${from}`);
  }
}

function assertExactReleaseContract(boundary, template) {
  const expectedBundles = BUNDLED_WORKSPACES.map(({ name }) => name);
  if (
    boundary?.schema_version !== 1 ||
    boundary.kind !== "echo-runtime-release-boundary" ||
    boundary.target !== "organization-authority" ||
    boundary.package !== "@echo-brain/organization-authority" ||
    boundary.source_boundary !==
      "services/organization-authority/source-boundary.v1.json" ||
    boundary.entrypoint !== "dist/main.js" ||
    boundary.launcher !== "bin/echo-organization-authority.mjs"
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

function stageBundledWorkspaces(source, packageDir, work) {
  const packDirectory = join(work, "workspace-packs");
  mkdirSync(packDirectory, { recursive: true });
  for (const workspace of BUNDLED_WORKSPACES) {
    const workspaceDirectory = join(source, workspace.directory);
    const manifest = readJson(join(workspaceDirectory, "package.json"));
    if (
      manifest.name !== workspace.name ||
      typeof manifest.version !== "string"
    ) {
      throw new Error(
        `bundled workspace manifest identity is invalid: ${workspace.directory}`,
      );
    }
    const output = run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ],
      {
        cwd: workspaceDirectory,
        env: isolatedNpmEnvironment(join(work, "npm-cache")),
      },
    );
    const packed = parseSinglePackResult(
      output,
      `npm pack for ${workspace.name}`,
    );
    if (packed.name !== workspace.name || packed.version !== manifest.version) {
      throw new Error(
        `npm pack identity differs from bundled workspace: ${workspace.name}`,
      );
    }
    const packedPaths = packed.files.map(({ path }) => path).sort();
    if (
      !packedPaths.includes("package.json") ||
      !packedPaths.includes("dist/index.js") ||
      packedPaths.some(
        (path) =>
          isAbsolute(path) ||
          path.split("/").includes("..") ||
          path === "src" ||
          path.startsWith("src/") ||
          path.endsWith(".tsbuildinfo"),
      )
    ) {
      throw new Error(
        `bundled workspace pack contains an invalid file set: ${workspace.name}`,
      );
    }
    const tarballPath = join(packDirectory, packed.filename);
    const destination = join(packageDir, "node_modules", workspace.name);
    mkdirSync(destination, { recursive: true });
    run("/usr/bin/tar", [
      "-xzf",
      tarballPath,
      "--strip-components",
      "1",
      "-C",
      destination,
    ]);
    const stagedPaths = filesUnder(destination).map((path) =>
      relative(destination, path).split(sep).join("/"),
    );
    if (JSON.stringify(stagedPaths) !== JSON.stringify(packedPaths)) {
      throw new Error(
        `staged files differ from npm pack output: ${workspace.name}`,
      );
    }
  }
}

function safeRemoveTemporary(path, parent) {
  const rel = relative(parent, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`refusing to remove unsafe temporary path: ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

function assertPackageHasNoBuildPath(packageDir, packagePaths, forbiddenPaths) {
  for (const relativePath of packagePaths) {
    const content = readFileSync(join(packageDir, relativePath));
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    for (const forbidden of forbiddenPaths) {
      if (text.includes(forbidden)) {
        throw new Error(
          `authority package file contains an absolute build path: ${relativePath}`,
        );
      }
    }
  }
}

function waitAtTestPreflightCheckpoint() {
  if (process.env.NODE_ENV !== "test") return;
  const ready = process.env.RUNTIME_ARTIFACT_TEST_PREFLIGHT_READY_FILE;
  const resume = process.env.RUNTIME_ARTIFACT_TEST_CONTINUE_FILE;
  if (ready === undefined && resume === undefined) return;
  if (!isAbsolute(ready ?? "") || !isAbsolute(resume ?? "")) {
    throw new Error(
      "authority build test checkpoint paths must both be absolute",
    );
  }
  writeFileSync(ready, "ready\n");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(resume)) return;
    Atomics.wait(sleeper, 0, 0, 20);
  }
  throw new Error("authority build test checkpoint timed out");
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
    waitAtTestPreflightCheckpoint();
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
    );
    copyRequired(join(source, "LICENSE"), join(packageDir, "LICENSE"));
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
    const launcherPath = join(packageDir, boundary.launcher);
    mkdirSync(dirname(launcherPath), { recursive: true });
    writeFileSync(
      launcherPath,
      "#!/usr/bin/env node\nawait import(new URL('../dist/' + 'main.js', import.meta.url));\n",
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
    const expectedBundles = BUNDLED_WORKSPACES.map(({ name }) => name).sort();
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
      "dist/build-identity.v1.json",
      "migrations/0001_single_org_authority.sql",
    ]) {
      if (!packedPaths.includes(required)) {
        throw new Error(
          `authority npm pack omitted required file: ${required}`,
        );
      }
    }
    assertPackageHasNoBuildPath(packageDir, packedPaths, [
      REPO_ROOT,
      temporary,
      source,
    ]);
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
