import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const EXPECTED_NPM_VERSION = "10.9.4";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hashFile(path, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function tarText(artifact, path) {
  const result = spawnSync("/usr/bin/tar", ["-xOf", artifact, path], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cannot read ${path} from rehearsal artifact`);
  }
  return result.stdout;
}

function canonicalPackagePath(packageName) {
  if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(packageName)) {
    throw new Error(
      `rehearsal artifact package name is unsafe: ${packageName}`,
    );
  }
  return `node_modules/${packageName}`;
}

function rootInstallLock(artifact, manifest, packagedLock, packageJson) {
  const dependency = `file:${artifact}`;
  const packagePath = canonicalPackagePath(packageJson.name);
  return {
    name: "echo-phase5-rehearsal-install",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "echo-phase5-rehearsal-install",
        version: "0.0.0",
        dependencies: { [packageJson.name]: dependency },
      },
      [packagePath]: {
        version: manifest.version,
        resolved: dependency,
        integrity: `sha512-${hashFile(artifact, "sha512", "base64")}`,
        dependencies: packagedLock.packages[""].dependencies,
        bundleDependencies: packagedLock.packages[""].bundleDependencies ?? [],
        ...(packageJson.bin === undefined ? {} : { bin: packageJson.bin }),
        ...(packageJson.engines === undefined
          ? {}
          : { engines: packageJson.engines }),
      },
      ...Object.fromEntries(
        Object.entries(packagedLock.packages).filter(([path]) => path !== ""),
      ),
    },
  };
}

function locateNodeDirectory() {
  const candidates = [
    resolve(dirname(process.execPath), ".."),
    resolve(dirname(process.execPath), "../.."),
    "/usr/local",
    "/opt/homebrew",
  ];
  for (const candidate of candidates) {
    const versionHeader = join(candidate, "include/node/node_version.h");
    if (!existsSync(join(candidate, "include/node/node.h"))) continue;
    let text;
    try {
      text = readFileSync(versionHeader, "utf8");
    } catch {
      continue;
    }
    const major = /^#define NODE_MAJOR_VERSION (\d+)$/m.exec(text)?.[1];
    const minor = /^#define NODE_MINOR_VERSION (\d+)$/m.exec(text)?.[1];
    const patch = /^#define NODE_PATCH_VERSION (\d+)$/m.exec(text)?.[1];
    const version = `${major}.${minor}.${patch}`;
    if (version === process.versions.node) {
      return { directory: candidate, version };
    }
  }
  throw new Error("Phase 5 rehearsal could not locate matching Node headers");
}

function preflightBuildToolchain(environment, nodeHeaderVersion) {
  const npm = spawnSync("npm", ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  const npmVersion = typeof npm.stdout === "string" ? npm.stdout.trim() : "";
  if (npm.status !== 0 || npmVersion !== EXPECTED_NPM_VERSION) {
    throw new Error(`Phase 5 rehearsal requires npm ${EXPECTED_NPM_VERSION}`);
  }
  const python = spawnSync("/usr/bin/python3", ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  const make = spawnSync("/usr/bin/make", ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  const clang = spawnSync("/usr/bin/clang", ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  const clangxx = spawnSync("/usr/bin/clang++", ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  const pythonVersion = /^Python (\d+\.\d+\.\d+)$/m.exec(
    `${python.stdout ?? ""}${python.stderr ?? ""}`,
  )?.[1];
  const makeVersion = /^(?:GNU Make|Apple make) (\d+(?:\.\d+)+)$/m.exec(
    make.stdout ?? "",
  )?.[1];
  const clangVersion = /^(?:Apple )?clang version (\d+(?:\.\d+)+)/m.exec(
    clang.stdout ?? "",
  )?.[1];
  const clangxxVersion = /^(?:Apple )?clang version (\d+(?:\.\d+)+)/m.exec(
    clangxx.stdout ?? "",
  )?.[1];
  if (
    python.status !== 0 ||
    make.status !== 0 ||
    clang.status !== 0 ||
    clangxx.status !== 0 ||
    pythonVersion === undefined ||
    makeVersion === undefined ||
    clangVersion === undefined ||
    clangxxVersion === undefined
  ) {
    throw new Error("Phase 5 native build toolchain preflight failed");
  }
  return Object.freeze({
    npm: EXPECTED_NPM_VERSION,
    node_headers: nodeHeaderVersion,
    python: pythonVersion,
    make: makeVersion,
    clang: clangVersion,
    clangxx: clangxxVersion,
    install_mode: "npm-cache-only",
    network_isolation_proven: false,
  });
}

function installEnvironment(prefix, cacheDirectory) {
  const nodeHeaders = locateNodeDirectory();
  const environmentRoot = join(prefix, ".rehearsal-npm-environment");
  mkdirSync(join(environmentRoot, "home"), { recursive: true, mode: 0o700 });
  mkdirSync(join(environmentRoot, "tmp"), { recursive: true, mode: 0o700 });
  writeFileSync(join(environmentRoot, "user-npmrc"), "", { mode: 0o600 });
  writeFileSync(join(environmentRoot, "global-npmrc"), "", { mode: 0o600 });
  return {
    environmentRoot,
    environment: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: join(environmentRoot, "home"),
      TMPDIR: join(environmentRoot, "tmp"),
      LANG: process.env.LANG ?? "C",
      LC_ALL: process.env.LC_ALL ?? "C",
      NODE_OPTIONS: "",
      NODE_PATH: "",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      all_proxy: "http://127.0.0.1:9",
      no_proxy: "",
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_build_from_source: "true",
      npm_config_ignore_scripts: "false",
      npm_config_omit: "",
      npm_config_include: "optional",
      npm_config_script_shell: "/bin/sh",
      npm_config_node_options: "",
      npm_config_userconfig: join(environmentRoot, "user-npmrc"),
      npm_config_globalconfig: join(environmentRoot, "global-npmrc"),
      npm_config_nodedir: nodeHeaders.directory,
      npm_config_cache: cacheDirectory,
      PYTHON: "/usr/bin/python3",
      NODE_GYP_FORCE_PYTHON: "/usr/bin/python3",
      npm_config_python: "/usr/bin/python3",
      MAKE: "/usr/bin/make",
      npm_config_make: "/usr/bin/make",
      CC: "/usr/bin/clang",
      CXX: "/usr/bin/clang++",
    },
    nodeHeaderVersion: nodeHeaders.version,
  };
}

function platformMismatch(declared) {
  if (declared === undefined) return null;
  const mismatches = [];
  if (declared.os !== undefined && declared.os !== process.platform) {
    mismatches.push(`os:${declared.os}->${process.platform}`);
  }
  if (
    declared.architecture !== undefined &&
    declared.architecture !== process.arch
  ) {
    mismatches.push(`architecture:${declared.architecture}->${process.arch}`);
  }
  if (declared.node !== undefined && declared.node !== process.versions.node) {
    mismatches.push(`node:${declared.node}->${process.versions.node}`);
  }
  return mismatches.length === 0 ? null : mismatches;
}

/**
 * Installs exact artifact bytes for the explicitly non-qualifying one-machine
 * rehearsal. Unlike the release installer, this function may cross the
 * product platform fence only when the caller records an acknowledgement.
 */
export function installRehearsalArtifact(options) {
  const artifactDirectory = resolve(options.artifactDirectory);
  const prefix = resolve(options.prefix);
  const cacheDirectory = resolve(options.cacheDirectory);
  const manifestPath = join(artifactDirectory, "artifact-manifest.json");
  const manifest = readJson(manifestPath);
  if (manifest.package !== options.expectedPackage) {
    throw new Error(
      `rehearsal artifact package mismatch: expected ${options.expectedPackage}`,
    );
  }
  if (
    options.expectedTarget !== undefined &&
    manifest.target !== undefined &&
    manifest.target !== options.expectedTarget
  ) {
    throw new Error(
      `rehearsal artifact target mismatch: expected ${options.expectedTarget}`,
    );
  }
  if (
    typeof manifest.artifact?.path !== "string" ||
    manifest.artifact.path === "" ||
    manifest.artifact.path !== basename(manifest.artifact.path) ||
    !/^[0-9A-Za-z][0-9A-Za-z._-]{0,254}$/.test(manifest.artifact.path)
  ) {
    throw new Error("rehearsal artifact path is unsafe");
  }
  const artifact = join(artifactDirectory, manifest.artifact.path);
  if (
    !existsSync(artifact) ||
    hashFile(artifact) !== manifest.artifact.sha256
  ) {
    throw new Error("rehearsal artifact SHA-256 verification failed");
  }
  const sidecar = `${artifact}.sha256`;
  if (
    !existsSync(sidecar) ||
    readFileSync(sidecar, "utf8") !==
      `${manifest.artifact.sha256}  ${manifest.artifact.path}\n`
  ) {
    throw new Error("rehearsal artifact checksum sidecar is inconsistent");
  }
  const packageJson = JSON.parse(tarText(artifact, "package/package.json"));
  const packagedLock = JSON.parse(
    tarText(artifact, "package/npm-shrinkwrap.json"),
  );
  if (
    packageJson.name !== options.expectedPackage ||
    packageJson.version !== manifest.version ||
    packagedLock.name !== packageJson.name ||
    packagedLock.version !== packageJson.version
  ) {
    throw new Error("rehearsal artifact internal identity is inconsistent");
  }
  const mismatch = platformMismatch(manifest.declared_platform);
  if (mismatch !== null && options.acknowledgeUnsupportedHost !== true) {
    throw new Error(
      `rehearsal artifact platform differs from this host (${mismatch.join(", ")}); explicit acknowledgement is required`,
    );
  }
  if (existsSync(prefix)) {
    const state = lstatSync(prefix);
    if (
      state.isSymbolicLink() ||
      !state.isDirectory() ||
      readdirSync(prefix).length > 0
    ) {
      throw new Error("rehearsal install prefix must be absent or empty");
    }
  } else {
    mkdirSync(prefix, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    join(prefix, "package.json"),
    `${JSON.stringify(
      {
        name: "echo-phase5-rehearsal-install",
        version: "0.0.0",
        private: true,
        dependencies: { [packageJson.name]: `file:${artifact}` },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(prefix, "package-lock.json"),
    `${JSON.stringify(
      rootInstallLock(artifact, manifest, packagedLock, packageJson),
      null,
      2,
    )}\n`,
  );
  const install = installEnvironment(prefix, cacheDirectory);
  const toolchain = preflightBuildToolchain(
    install.environment,
    install.nodeHeaderVersion,
  );
  let result;
  try {
    result = spawnSync(
      "npm",
      [
        "ci",
        "--prefix",
        prefix,
        "--offline",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts=false",
        "--include=optional",
        "--cache",
        cacheDirectory,
      ],
      {
        encoding: "utf8",
        env: install.environment,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } finally {
    rmSync(install.environmentRoot, { recursive: true, force: true });
  }
  if (result.status !== 0) {
    rmSync(prefix, { recursive: true, force: true });
    throw new Error("rehearsal cache-only npm install failed");
  }
  return Object.freeze({
    packageName: packageJson.name,
    packageRoot: join(prefix, canonicalPackagePath(packageJson.name)),
    sourceSha: manifest.source_sha,
    version: manifest.version,
    artifactSha256: manifest.artifact.sha256,
    manifestSha256: hashFile(manifestPath),
    dependencyLockSha256: manifest.dependency_lock_sha256,
    declaredPlatform: manifest.declared_platform ?? null,
    observedPlatform: {
      os: process.platform,
      architecture: process.arch,
      node: process.versions.node,
    },
    toolchain,
    platformMismatch: mismatch ?? [],
  });
}
