import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  spawnSanitizedChild,
  spawnSanitizedChildSync,
} from "../../src/product/spawn-sanitized-child.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const temporaryRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "echo-organization-authority-artifact-")),
);
const MAX_LIFECYCLE_OUTPUT_BYTES = 64 * 1024;
const LIFECYCLE_COMMAND_TIMEOUT_MS = 15_000;
const READINESS_TIMEOUT_MS = 15_000;
const SHUTDOWN_DEADLINE_MS = 10_000;

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    timeout?: number;
  } = {},
): CommandResult {
  const result = spawnSanitizedChildSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function runLifecycleCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): CommandResult {
  return run(command, args, {
    ...options,
    maxBuffer: MAX_LIFECYCLE_OUTPUT_BYTES,
    timeout: LIFECYCLE_COMMAND_TIMEOUT_MS,
  });
}

function parseCommandJson<T>(result: CommandResult, label: string): T {
  expect(result.status, `${label}: ${result.stderr || result.stdout}`).toBe(0);
  expect(
    Buffer.byteLength(result.stdout),
    `${label} stdout`,
  ).toBeLessThanOrEqual(MAX_LIFECYCLE_OUTPUT_BYTES);
  expect(
    Buffer.byteLength(result.stderr),
    `${label} stderr`,
  ).toBeLessThanOrEqual(MAX_LIFECYCLE_OUTPUT_BYTES);
  return JSON.parse(result.stdout) as T;
}

function reserveLoopbackPort(environment: NodeJS.ProcessEnv): number {
  const script = `
import { createServer } from "node:net";
const server = createServer();
server.once("error", (error) => {
  process.stderr.write(error.message + "\\n");
  process.exitCode = 1;
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.stderr.write("could not reserve a loopback port\\n");
    process.exitCode = 1;
    server.close();
    return;
  }
  process.stdout.write(String(address.port) + "\\n");
  server.close();
});`;
  const result = runLifecycleCommand(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: temporaryRoot, env: environment },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toMatch(/^[1-9][0-9]{0,4}$/);
  const port = Number(result.stdout.trim());
  expect(port).toBeLessThanOrEqual(65_535);
  return port;
}

function hashInstalledTree(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string, prefix = ""): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const state = lstatSync(path);
      if (state.isDirectory()) {
        hash.update(
          `directory\0${relativePath}\0${String(state.mode & 0o777)}\0`,
        );
        visit(path, relativePath);
      } else if (state.isFile()) {
        hash.update(
          `file\0${relativePath}\0${String(state.mode & 0o777)}\0${String(
            state.size,
          )}\0`,
        );
        hash.update(readFileSync(path));
      } else if (state.isSymbolicLink()) {
        hash.update(`link\0${relativePath}\0${readlinkSync(path)}\0`);
      } else {
        throw new Error(`unsupported entry in installed tree: ${relativePath}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

interface AuthorityInitializationOutput {
  kind: "echo-organization-authority-development-initialization";
  created: boolean;
  authority_descriptor: {
    authority_id: string;
    organization_id: string;
  };
}

interface AuthorityStatusOutput {
  kind: "echo-organization-authority-status";
  ok: boolean;
  initialized: boolean;
  running: boolean;
  healthy: boolean;
  authority_id: string | null;
  organization_id: string | null;
}

interface AuthorityReadinessOutput {
  schema_version: 1;
  kind: "echo-organization-authority-ready";
  host: string;
  port: number;
  message: string;
}

interface CapturedAuthorityProcess {
  child: ReturnType<typeof spawnSanitizedChild>;
  logs: { stdout: string; stderr: string };
  readiness: Promise<AuthorityReadinessOutput>;
  closed: Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
}

function startInstalledAuthority(
  executable: string,
  configPath: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): CapturedAuthorityProcess {
  const child = spawnSanitizedChild(
    executable,
    ["serve", "--config", configPath],
    options,
  );
  const logs = { stdout: "", stderr: "" };
  let readinessBuffer = "";
  let readinessSettled = false;
  let rejectReadiness: (error: Error) => void = () => undefined;
  let resolveReadiness: (value: AuthorityReadinessOutput) => void = () =>
    undefined;
  const readiness = new Promise<AuthorityReadinessOutput>(
    (resolveReady, reject) => {
      resolveReadiness = resolveReady;
      rejectReadiness = reject;
    },
  );
  const settleReadinessFailure = (message: string): void => {
    if (readinessSettled) return;
    readinessSettled = true;
    clearTimeout(readinessTimer);
    rejectReadiness(new Error(`${message}: ${logs.stderr || logs.stdout}`));
  };
  const append = (stream: "stdout" | "stderr", chunk: string): boolean => {
    const value = logs[stream] + chunk;
    if (Buffer.byteLength(value) > MAX_LIFECYCLE_OUTPUT_BYTES) {
      logs[stream] = value.slice(0, MAX_LIFECYCLE_OUTPUT_BYTES);
      settleReadinessFailure(`authority ${stream} exceeded its output limit`);
      child.kill("SIGKILL");
      return false;
    }
    logs[stream] = value;
    return true;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    append("stdout", chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    if (!append("stderr", chunk) || readinessSettled) return;
    readinessBuffer += chunk;
    for (;;) {
      const newline = readinessBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = readinessBuffer.slice(0, newline);
      readinessBuffer = readinessBuffer.slice(newline + 1);
      try {
        const value = JSON.parse(line) as Partial<AuthorityReadinessOutput>;
        if (
          Object.keys(value).sort().join(",") ===
            "host,kind,message,port,schema_version" &&
          value.schema_version === 1 &&
          value.kind === "echo-organization-authority-ready" &&
          typeof value.host === "string" &&
          typeof value.port === "number" &&
          typeof value.message === "string"
        ) {
          readinessSettled = true;
          clearTimeout(readinessTimer);
          resolveReadiness(value as AuthorityReadinessOutput);
          return;
        }
      } catch {
        // A non-JSON diagnostic is retained in the bounded log for failure output.
      }
    }
  });
  child.once("error", (error) => {
    settleReadinessFailure(
      `authority process failed to launch: ${error.message}`,
    );
  });
  const closed = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClosed) => {
    child.once("close", (status, signal) => {
      settleReadinessFailure(
        `authority process exited before readiness (${String(status)}, ${String(signal)})`,
      );
      resolveClosed({ status, signal });
    });
  });
  const readinessTimer = setTimeout(() => {
    settleReadinessFailure("authority readiness deadline exceeded");
    child.kill("SIGKILL");
  }, READINESS_TIMEOUT_MS);
  return { child, logs, readiness, closed };
}

async function stopInstalledAuthority(
  authority: CapturedAuthorityProcess,
): Promise<void> {
  const startedAt = Date.now();
  expect(authority.child.kill("SIGTERM"), authority.logs.stderr).toBe(true);
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("authority-shutdown-timeout");
  const outcome = await Promise.race([
    authority.closed,
    new Promise<typeof timedOut>((resolveTimeout) => {
      shutdownTimer = setTimeout(
        () => resolveTimeout(timedOut),
        SHUTDOWN_DEADLINE_MS,
      );
    }),
  ]);
  if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
  if (outcome === timedOut) {
    authority.child.kill("SIGKILL");
    await authority.closed;
    throw new Error(
      `installed authority did not stop within ${String(SHUTDOWN_DEADLINE_MS)}ms: ${authority.logs.stderr}`,
    );
  }
  expect(outcome, authority.logs.stderr).toEqual({ status: 0, signal: null });
  expect(Date.now() - startedAt).toBeLessThanOrEqual(SHUTDOWN_DEADLINE_MS);
}

async function cleanUpOwnedAuthority(
  authority: CapturedAuthorityProcess | undefined,
): Promise<void> {
  if (authority === undefined || authority.child.exitCode !== null) return;
  authority.child.kill("SIGKILL");
  await authority.closed;
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
  const status = run("git", ["status", "--short"], { cwd: fixture });
  expect(status.status, status.stderr).toBe(0);
  expect(status.stdout).toBe("");
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
        "bin/echo-organization-admin.mjs",
        "bin/echo-organization-authority.mjs",
        "dist/admin-main.js",
        "dist/main.js",
        "dist/build-identity.v1.json",
        "migrations/0001_single_org_authority.sql",
        "migrations/0002_admin_command_idempotency.sql",
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

    const operatorRootPath = join(temporaryRoot, "authority-operator");
    mkdirSync(operatorRootPath, { mode: 0o700 });
    const operatorRoot = realpathSync(operatorRootPath);
    const isolatedHome = join(operatorRoot, "home");
    const isolatedTmp = join(operatorRoot, "tmp");
    mkdirSync(isolatedHome, { mode: 0o700 });
    mkdirSync(isolatedTmp, { mode: 0o700 });
    const lifecycleEnvironment: NodeJS.ProcessEnv = {
      HOME: isolatedHome,
      TMPDIR: isolatedTmp,
      NODE_OPTIONS: "",
      NODE_PATH: "",
    };
    const installPrefix = join(temporaryRoot, "installed-authority");
    const installScript = `
const { installRehearsalArtifact } = await import(process.argv[1]);
const result = installRehearsalArtifact({
  artifactDirectory: process.argv[2],
  prefix: process.argv[3],
  cacheDirectory: process.argv[4],
  expectedPackage: "@echo-brain/organization-authority",
  expectedTarget: "organization-authority",
  acknowledgeUnsupportedHost: true,
});
process.stdout.write(JSON.stringify(result) + "\\n");`;
    const installed = parseCommandJson<{
      packageName: string;
      packageRoot: string;
      sourceSha: string;
    }>(
      run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          installScript,
          "--",
          pathToFileURL(
            join(fixture.root, "tools/phase5/install-rehearsal-artifact.mjs"),
          ).href,
          outDir,
          installPrefix,
          join(REPO_ROOT, ".npm-cache"),
        ],
        {
          cwd: operatorRoot,
          env: lifecycleEnvironment,
          maxBuffer: MAX_LIFECYCLE_OUTPUT_BYTES,
          // The installer gives its inner npm ci 180 seconds. The wrapper must
          // outlive that child so it can reap native-build failures cleanly.
          timeout: 240_000,
        },
      ),
      "authority rehearsal install",
    );
    expect(installed).toMatchObject({
      packageName: "@echo-brain/organization-authority",
      packageRoot: join(
        installPrefix,
        "node_modules/@echo-brain/organization-authority",
      ),
      sourceSha: fixture.sha,
    });

    const authorityExecutable = join(
      installPrefix,
      "node_modules/.bin/echo-organization-authority",
    );
    const adminExecutable = join(
      installPrefix,
      "node_modules/.bin/echo-organization-admin",
    );
    expect(existsSync(authorityExecutable)).toBe(true);
    expect(existsSync(adminExecutable)).toBe(true);
    const adminHelp = runLifecycleCommand(adminExecutable, ["--help"], {
      cwd: operatorRoot,
      env: lifecycleEnvironment,
    });
    expect(adminHelp.status, adminHelp.stderr).toBe(0);
    expect(adminHelp.stdout).toContain("echo-organization-admin");
    const installedTreeBeforeLifecycle = hashInstalledTree(installPrefix);
    const configPath = join(operatorRoot, "authority.json");
    const stateDirectory = join(operatorRoot, "authority-state");
    expect(relative(installPrefix, configPath).startsWith("..")).toBe(true);
    expect(relative(installPrefix, stateDirectory).startsWith("..")).toBe(true);
    const port = reserveLoopbackPort(lifecycleEnvironment);
    const initialization = parseCommandJson<AuthorityInitializationOutput>(
      runLifecycleCommand(
        authorityExecutable,
        [
          "init-development",
          "--config",
          configPath,
          "--state-dir",
          stateDirectory,
          "--organization-name",
          "Artifact Lifecycle Company",
          "--port",
          String(port),
        ],
        { cwd: operatorRoot, env: lifecycleEnvironment },
      ),
      "installed authority initialization",
    );
    expect(initialization).toMatchObject({
      kind: "echo-organization-authority-development-initialization",
      created: true,
    });
    const expectedIdentity = {
      authority_id: initialization.authority_descriptor.authority_id,
      organization_id: initialization.authority_descriptor.organization_id,
    };
    const readStatus = (label: string): AuthorityStatusOutput =>
      parseCommandJson<AuthorityStatusOutput>(
        runLifecycleCommand(
          authorityExecutable,
          ["status", "--config", configPath],
          { cwd: operatorRoot, env: lifecycleEnvironment },
        ),
        label,
      );
    expect(readStatus("initial stopped status")).toMatchObject({
      kind: "echo-organization-authority-status",
      ok: true,
      initialized: true,
      running: false,
      healthy: false,
      ...expectedIdentity,
    });

    let authority: CapturedAuthorityProcess | undefined;
    try {
      for (const generation of ["first", "restarted"] as const) {
        authority = startInstalledAuthority(authorityExecutable, configPath, {
          cwd: operatorRoot,
          env: lifecycleEnvironment,
        });
        expect(await authority.readiness).toEqual({
          schema_version: 1,
          kind: "echo-organization-authority-ready",
          host: "127.0.0.1",
          port,
          message: expect.any(String),
        });
        expect(readStatus(`${generation} healthy status`)).toMatchObject({
          ok: true,
          initialized: true,
          running: true,
          healthy: true,
          ...expectedIdentity,
        });
        const overview = parseCommandJson<{
          organization_id: string;
          authority_id: string;
          counts: { memberships: number; installations: number };
        }>(
          runLifecycleCommand(
            adminExecutable,
            ["overview", "--config", configPath],
            { cwd: operatorRoot, env: lifecycleEnvironment },
          ),
          `${generation} installed administrator overview`,
        );
        expect(overview).toMatchObject({
          organization_id: expectedIdentity.organization_id,
          authority_id: expectedIdentity.authority_id,
          counts: { memberships: 0, installations: 0 },
        });
        await stopInstalledAuthority(authority);
        authority = undefined;
        expect(readStatus(`${generation} stopped status`)).toMatchObject({
          ok: true,
          initialized: true,
          running: false,
          healthy: false,
          ...expectedIdentity,
        });
      }
    } finally {
      await cleanUpOwnedAuthority(authority);
    }
    expect(hashInstalledTree(installPrefix)).toBe(installedTreeBeforeLifecycle);

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

    const incompleteDir = join(temporaryRoot, "incomplete-authority-artifact");
    cpSync(outDir, incompleteDir, { recursive: true });
    const incompleteManifestPath = join(
      incompleteDir,
      "artifact-manifest.json",
    );
    const incompleteManifest = JSON.parse(
      readFileSync(incompleteManifestPath, "utf8"),
    ) as { package_files: Array<{ path: string }> };
    incompleteManifest.package_files = incompleteManifest.package_files.filter(
      ({ path }) => path !== "dist/admin-main.js",
    );
    writeFileSync(
      incompleteManifestPath,
      `${JSON.stringify(incompleteManifest, null, 2)}\n`,
    );
    const incomplete = run(
      process.execPath,
      [verifier, "--artifact-dir", incompleteDir],
      { cwd: fixture.root },
    );
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain(
      "authority artifact package_files omit required runtime path: dist/admin-main.js",
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
  }, 420_000);
});
