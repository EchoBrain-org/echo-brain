#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEPLOYMENT = join(ROOT, "deploy", "organization-authority");
const MANIFEST = join(
  DEPLOYMENT,
  "authority-current-host-recovery-v1.validation-tools.json",
);
const PAIRS = Object.freeze([
  Object.freeze({
    template: join(
      DEPLOYMENT,
      "authority-current-host-recovery-v1.template.json",
    ),
    guard: join(
      DEPLOYMENT,
      "authority-current-host-recovery-v1.guard",
    ),
  }),
  Object.freeze({
    template: join(
      DEPLOYMENT,
      "authority-recovery-helper-v1.template.json",
    ),
    guard: join(DEPLOYMENT, "authority-recovery-helper-v1.guard"),
  }),
]);

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INPUT: "1",
    },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `: ${(result.stderr ?? "").trim()}` : "";
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}${detail}`,
    );
  }
  return capture ? (result.stdout ?? "").trim() : "";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function downloadVerified(url, expectedSha256, path) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`invalid pinned SHA-256 for ${basename(path)}`);
  }
  run("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    url,
    "--output",
    path,
  ]);
  const actual = sha256(path);
  if (actual !== expectedSha256) {
    throw new Error(
      `${basename(path)} SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`,
    );
  }
}

function platformKey() {
  const architecture =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : null;
  const operatingSystem =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "linux"
        ? "linux"
        : null;
  if (architecture === null || operatingSystem === null) {
    throw new Error(
      `unsupported validator platform ${process.platform}/${process.arch}`,
    );
  }
  return `${architecture}-${operatingSystem}`;
}

function findRegularFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findRegularFile(path, name);
      if (nested !== null) return nested;
    } else if (entry.isFile() && entry.name === name && lstatSync(path).isFile()) {
      return path;
    }
  }
  return null;
}

const manifest = object(
  JSON.parse(readFileSync(MANIFEST, "utf8")),
  "validation-tools manifest",
);
const lint = object(manifest.cfn_lint, "cfn_lint");
const wheel = object(lint.wheel, "cfn_lint wheel");
const dependencies = object(lint.dependencies, "cfn_lint dependencies");
const dependencyAssets = object(
  dependencies.assets,
  "cfn_lint dependency assets",
);
const platform = platformKey();
const universalWheels = dependencies.universal;
if (!Array.isArray(universalWheels)) {
  throw new Error("cfn_lint universal dependencies are not an array");
}
const platformWheels = dependencyAssets[platform];
if (!Array.isArray(platformWheels)) {
  throw new Error(`unsupported cfn_lint wheel platform ${platform}`);
}
const guard = object(manifest.cfn_guard, "cfn_guard");
const assets = object(guard.assets, "cfn_guard assets");
const asset = object(assets[platform], "cfn_guard platform asset");
const temporary = mkdtempSync(join(tmpdir(), "echo-authority-cfn-"));

try {
  const pythonVersion = text(lint.python_version, "cfn_lint Python version");
  const actualPythonVersion = run(
    "python3",
    ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    true,
  );
  if (actualPythonVersion !== pythonVersion) {
    throw new Error(
      `cfn-lint requires Python ${pythonVersion}; found ${actualPythonVersion}`,
    );
  }
  const pinnedWheels = [wheel, ...universalWheels, ...platformWheels].map(
    (value, index) => object(value, `cfn_lint wheel ${String(index + 1)}`),
  );
  const wheelNames = pinnedWheels.map((value, index) =>
    text(value.name, `cfn_lint wheel ${String(index + 1)} name`),
  );
  if (new Set(wheelNames).size !== wheelNames.length) {
    throw new Error("cfn_lint wheel names are not unique");
  }
  const wheelPaths = pinnedWheels.map((value, index) => {
    const path = join(temporary, wheelNames[index]);
    downloadVerified(
      text(value.url, `${wheelNames[index]} URL`),
      text(value.sha256, `${wheelNames[index]} SHA-256`),
      path,
    );
    return path;
  });
  const virtualEnvironment = join(temporary, "cfn-lint-venv");
  run("python3", ["-m", "venv", virtualEnvironment]);
  const python = join(virtualEnvironment, "bin", "python");
  run(python, [
    "-m",
    "pip",
    "install",
    "--quiet",
    "--disable-pip-version-check",
    "--no-index",
    "--no-deps",
    ...wheelPaths,
  ]);
  run(python, ["-m", "pip", "check"]);
  const cfnLint = join(virtualEnvironment, "bin", "cfn-lint");
  const lintVersion = text(lint.version, "cfn_lint version");
  if (run(cfnLint, ["--version"], true) !== `cfn-lint ${lintVersion}`) {
    throw new Error("cfn-lint version does not match the pinned manifest");
  }

  const guardVersion = text(guard.version, "cfn_guard version");
  const guardAssetName = text(asset.name, "cfn_guard asset name");
  const guardArchive = join(temporary, guardAssetName);
  const releaseRoot = text(guard.source, "cfn_guard source").replace(
    "/releases/tag/",
    "/releases/download/",
  );
  downloadVerified(
    `${releaseRoot}/${guardAssetName}`,
    text(asset.sha256, "cfn_guard asset SHA-256"),
    guardArchive,
  );
  run("tar", ["-xzf", guardArchive, "-C", temporary]);
  const cfnGuard = findRegularFile(temporary, "cfn-guard");
  if (cfnGuard === null) throw new Error("cfn-guard binary is missing");
  chmodSync(cfnGuard, 0o755);
  if (run(cfnGuard, ["--version"], true) !== `cfn-guard ${guardVersion}`) {
    throw new Error("cfn-guard version does not match the pinned manifest");
  }

  run(cfnLint, [
    "--format",
    "json",
    "--regions",
    "us-west-2",
    "--template",
    ...PAIRS.map(({ template }) => template),
  ]);
  for (const pair of PAIRS) {
    run(cfnGuard, [
      "validate",
      "--rules",
      pair.guard,
      "--data",
      pair.template,
      "--output-format",
      "json",
    ]);
  }
  console.log(
    `authority infrastructure templates: cfn-lint ${lintVersion} and cfn-guard ${guardVersion} passed`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
