import { createHash, X509Certificate } from "node:crypto";
import {
  chmodSync,
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { Ajv, type AnySchema } from "ajv";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  spawnSanitizedChild,
  spawnSanitizedChildSync,
} from "../../src/product/spawn-sanitized-child.js";
import { createTestPki } from "../support/organization-admin-edge-pki.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const BUILDER = "tools/organization-admin-edge/build-artifact.mjs";
const VERIFIER = "tools/organization-admin-edge/verify-artifact.mjs";
const EDGE_README = "services/organization-admin-edge/README.md";
const PREFLIGHT_SCHEMA =
  "schemas/organization-admin-edge-preflight.v1.schema.json";
const FOUNDER_LIVE_EVIDENCE_SCHEMA =
  "schemas/organization-admin-edge-founder-live-evidence.v1.schema.json";
const OPERATOR_TOOLS = [
  "tools/organization-admin-edge/verify-artifact.mjs",
  "tools/organization-admin-edge/install-release.mjs",
  "tools/organization-admin-edge/prepare-launchd.mjs",
  "tools/organization-admin-edge/create-founder-live-plan.mjs",
  "tools/organization-admin-edge/verify-founder-live-activation.mjs",
  "tools/organization-admin-edge/validate-founder-live-evidence.mjs",
] as const;
const BUNDLES = [
  "@echo-brain/federation-protocol",
  "@echo-brain/organization-protocol",
  "@echo-brain/organization-api",
] as const;
const temporaryRoot = realpathSync(
  mkdtempSync(join(tmpdir(), "echo-organization-admin-edge-artifact-")),
);

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeout?: number;
  } = {},
): CommandResult {
  const result = spawnSanitizedChildSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function checkedRun(
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  const result = run(command, args, { cwd });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

function repositoryPaths(): string[] {
  const listed = checkedRun(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    REPO_ROOT,
  );
  return listed
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((path) => {
      if (
        path.includes("\\") ||
        posix.isAbsolute(path) ||
        posix.normalize(path) !== path ||
        path === ".." ||
        path.startsWith("../")
      ) {
        throw new Error(`unsafe repository fixture path: ${path}`);
      }
      return path;
    });
}

function overlayCurrentWorktree(fixture: string): void {
  for (const path of repositoryPaths()) {
    const source = join(REPO_ROOT, path);
    const destination = join(fixture, path);
    if (!existsSync(source)) {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    const state = lstatSync(source);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    if (state.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), destination);
    } else if (state.isFile()) {
      cpSync(source, destination, { force: true, preserveTimestamps: true });
      chmodSync(destination, state.mode & 0o777);
    } else {
      throw new Error(`unsupported repository fixture entry: ${path}`);
    }
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

function prepareCommittedFixture(): {
  readonly root: string;
  readonly sha: string;
} {
  const fixture = join(temporaryRoot, "exact-source");
  checkedRun(
    "git",
    ["clone", "--quiet", "--no-hardlinks", REPO_ROOT, fixture],
    temporaryRoot,
  );
  overlayCurrentWorktree(fixture);
  checkedRun("git", ["add", "-A"], fixture);
  checkedRun(
    "git",
    [
      "-c",
      "user.name=ECHO Artifact Test",
      "-c",
      "user.email=artifact-test@echo.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: materialize current administrator edge candidate",
    ],
    fixture,
  );
  const sha = checkedRun("git", ["rev-parse", "HEAD"], fixture).trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  expect(checkedRun("git", ["status", "--short"], fixture)).toBe("");
  linkBuildDependencies(fixture);
  return { root: fixture, sha };
}

function isPrivateRuntimeMaterial(path: string): boolean {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    /^(?:config|state)(?:\/|\.json$)/.test(lower) ||
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
    /\.(?:cer|crt|der|key|p12|pem|pfx)$/.test(lower)
  );
}

afterAll(() => {
  function makeWritable(path: string): void {
    const state = lstatSync(path);
    if (state.isSymbolicLink()) return;
    if (state.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) {
        makeWritable(join(path, entry));
      }
    } else if (state.isFile()) {
      chmodSync(path, 0o600);
    }
  }
  makeWritable(temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("organization administrator edge runtime shrinkwrap", () => {
  it("contains exactly three bundles and no external package", () => {
    const output = join(temporaryRoot, "admin-edge-shrinkwrap.json");
    const result = run(process.execPath, [
      join(REPO_ROOT, "tools/organization-admin-edge/sync-shrinkwrap.mjs"),
      "--output",
      output,
    ]);
    expect(result.status, result.stderr).toBe(0);

    const shrinkwrap = JSON.parse(readFileSync(output, "utf8")) as {
      readonly name: string;
      readonly packages: Record<
        string,
        { readonly inBundle?: boolean; readonly link?: boolean }
      >;
    };
    expect(shrinkwrap.name).toBe("@echo-brain/organization-admin-edge");
    expect(Object.keys(shrinkwrap.packages).sort()).toEqual(
      ["", ...BUNDLES.map((name) => `node_modules/${name}`)].sort(),
    );
    for (const name of BUNDLES) {
      expect(shrinkwrap.packages[`node_modules/${name}`]).toMatchObject({
        inBundle: true,
      });
      expect(shrinkwrap.packages[`node_modules/${name}`]?.link).not.toBe(true);
    }
  });
});

describe("exact-commit organization administrator edge artifact", () => {
  it("rejects a mismatched source SHA without publishing output", () => {
    const outDir = join(temporaryRoot, "wrong-sha-output");
    const result = run(process.execPath, [
      join(REPO_ROOT, BUILDER),
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

  it("builds committed bytes, verifies the closure, and rejects mutations", async () => {
    const fixture = prepareCommittedFixture();
    const outDir = join(temporaryRoot, "admin-edge-artifact");
    const ready = join(temporaryRoot, "admin-edge-build-ready");
    const resume = join(temporaryRoot, "admin-edge-build-resume");
    const builder = join(fixture.root, BUILDER);
    const child = spawnSanitizedChild(
      process.execPath,
      [
        builder,
        "--version",
        "0.1.0-dev.admin-edge-test",
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
    let earlyStatus: number | null | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("close", (status) => {
      earlyStatus = status;
    });
    const completion = new Promise<number | null>((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", resolveStatus);
    });
    await vi.waitFor(
      () => {
        if (earlyStatus !== undefined) {
          throw new Error(
            `administrator edge builder exited before its checkpoint (${String(earlyStatus)}): ${stderr || stdout}`,
          );
        }
        expect(existsSync(ready)).toBe(true);
      },
      { timeout: 15_000 },
    );

    const readmePath = join(fixture.root, EDGE_README);
    const marker = "UNCOMMITTED_ADMIN_EDGE_MUTATION_MUST_NOT_SHIP";
    writeFileSync(
      readmePath,
      `${readFileSync(readmePath, "utf8")}\n${marker}\n`,
    );
    writeFileSync(resume, "continue\n");
    const buildStatus = await completion;
    expect(buildStatus, stderr).toBe(0);

    const built = JSON.parse(stdout) as {
      readonly target: string;
      readonly artifact: string;
      readonly sha256: string;
    };
    expect(built.target).toBe("organization-admin-edge");
    expect(readdirSync(outDir).sort()).toEqual(
      [
        "artifact-manifest.json",
        built.artifact,
        `${built.artifact}.sha256`,
      ].sort(),
    );
    const manifestPath = join(outDir, "artifact-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      readonly kind: string;
      readonly target: string;
      readonly package: string;
      readonly source_sha: string;
      readonly founder_live_evidence_schema: string;
      readonly operator_tools_runtime_imported: boolean;
      readonly operator_tools: string[];
      readonly bundled_workspace_packages: string[];
      readonly external_runtime_packages: string[];
      readonly artifact: { readonly sha256: string };
      readonly package_files: Array<{ readonly path: string }>;
    };
    expect(manifest).toMatchObject({
      kind: "echo-exact-runtime-artifact",
      target: "organization-admin-edge",
      package: "@echo-brain/organization-admin-edge",
      source_sha: fixture.sha,
      founder_live_evidence_schema: FOUNDER_LIVE_EVIDENCE_SCHEMA,
      operator_tools_runtime_imported: false,
      operator_tools: OPERATOR_TOOLS,
      external_runtime_packages: [],
    });
    expect(manifest.bundled_workspace_packages).toEqual(BUNDLES);

    const paths = manifest.package_files.map(({ path }) => path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(
      expect.arrayContaining([
        "bin/echo-organization-admin-edge.mjs",
        "dist/main.js",
        "dist/build-identity.v1.json",
        "schemas/organization-admin-edge-preflight.v1.schema.json",
        FOUNDER_LIVE_EVIDENCE_SCHEMA,
        ...OPERATOR_TOOLS,
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
          path.includes("/src/") ||
          path.includes("/test/") ||
          isPrivateRuntimeMaterial(path),
      ),
    ).toBe(false);
    expect(
      new Set(
        paths
          .filter((path) => path.startsWith("node_modules/"))
          .map((path) => path.split("/").slice(1, 3).join("/")),
      ),
    ).toEqual(new Set(BUNDLES));

    const tarball = join(outDir, built.artifact);
    expect(
      createHash("sha256").update(readFileSync(tarball)).digest("hex"),
    ).toBe(built.sha256);
    expect(built.sha256).toBe(manifest.artifact.sha256);
    const packagedReadme = run(
      "/usr/bin/tar",
      ["-xOf", tarball, "package/README.md"],
      { cwd: temporaryRoot },
    );
    expect(packagedReadme.status, packagedReadme.stderr).toBe(0);
    expect(packagedReadme.stdout).not.toContain(marker);

    const verifier = join(fixture.root, VERIFIER);
    const verified = run(
      process.execPath,
      [verifier, "--artifact-dir", outDir],
      { cwd: fixture.root },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      errors: [],
      target: "organization-admin-edge",
    });

    const installRoot = join(temporaryRoot, "installed-admin-edge");
    mkdirSync(installRoot);
    const extracted = run(
      "/usr/bin/tar",
      ["-xzf", tarball, "-C", installRoot],
      { cwd: temporaryRoot },
    );
    expect(extracted.status, extracted.stderr).toBe(0);
    const preflightSchema = JSON.parse(
      readFileSync(join(installRoot, "package", PREFLIGHT_SCHEMA), "utf8"),
    ) as AnySchema;
    const validatePreflight = new Ajv({
      allErrors: true,
      strict: true,
    }).compile(preflightSchema);
    const help = run(
      process.execPath,
      [
        join(installRoot, "package/bin/echo-organization-admin-edge.mjs"),
        "--help",
      ],
      { cwd: installRoot },
    );
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(
      "echo-organization-admin-edge serve --config <absolute-path>",
    );
    expect(help.stdout).toContain(
      "echo-organization-admin-edge preflight --config <absolute-path>",
    );
    expect(help.stderr).toBe("");

    const bootstrapRoot = join(temporaryRoot, "isolated-operator-bootstrap");
    mkdirSync(bootstrapRoot, { mode: 0o700 });
    for (const path of [...OPERATOR_TOOLS, FOUNDER_LIVE_EVIDENCE_SCHEMA]) {
      const output = run("/usr/bin/tar", ["-xOf", tarball, `package/${path}`], {
        cwd: temporaryRoot,
      });
      expect(output.status, output.stderr).toBe(0);
      const destination = join(bootstrapRoot, "package", path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, output.stdout, { mode: 0o400, flag: "wx" });
      const state = lstatSync(destination);
      expect(state.isFile()).toBe(true);
      expect(state.isSymbolicLink()).toBe(false);
      expect(state.nlink).toBe(1);
    }
    const isolatedOperatorCwd = join(temporaryRoot, "isolated-operator-cwd");
    mkdirSync(isolatedOperatorCwd);
    const packagedVerifier = run(
      process.execPath,
      [
        join(
          bootstrapRoot,
          "package/tools/organization-admin-edge/verify-artifact.mjs",
        ),
        "--artifact-dir",
        outDir,
      ],
      { cwd: isolatedOperatorCwd },
    );
    expect(packagedVerifier.status, packagedVerifier.stderr).toBe(0);
    expect(JSON.parse(packagedVerifier.stdout)).toMatchObject({
      ok: true,
      errors: [],
      target: "organization-admin-edge",
    });

    const sealedInstallRoot = join(temporaryRoot, "isolated-operator-install");
    const packagedInstaller = run(
      process.execPath,
      [
        join(
          bootstrapRoot,
          "package/tools/organization-admin-edge/install-release.mjs",
        ),
        "--artifact-dir",
        outDir,
        "--expected-artifact-sha256",
        manifest.artifact.sha256,
        "--install-root",
        sealedInstallRoot,
      ],
      { cwd: isolatedOperatorCwd },
    );
    expect(packagedInstaller.status, packagedInstaller.stderr).toBe(0);
    expect(JSON.parse(packagedInstaller.stdout)).toMatchObject({
      ok: true,
      changed: true,
      artifact: { sha256: manifest.artifact.sha256 },
    });

    for (const tool of [
      "create-founder-live-plan.mjs",
      "verify-founder-live-activation.mjs",
      "validate-founder-live-evidence.mjs",
    ]) {
      const loadedWithoutRepository = run(
        process.execPath,
        [join(bootstrapRoot, `package/tools/organization-admin-edge/${tool}`)],
        { cwd: isolatedOperatorCwd },
      );
      expect(loadedWithoutRepository.status).toBe(1);
      expect(loadedWithoutRepository.stderr).not.toContain(
        "ERR_MODULE_NOT_FOUND",
      );
    }

    const pki = createTestPki();
    try {
      const proxyToken = "packaged-preflight-proxy-token-00000000000000000001";
      const proxyTokenPath = join(pki.directory, "trusted-proxy-token");
      writeFileSync(proxyTokenPath, proxyToken, {
        encoding: "ascii",
        mode: 0o600,
      });
      const publicKey = new X509Certificate(
        pki.admin_one.certificate,
      ).publicKey.export({
        format: "der",
        type: "spki",
      });
      expect(Buffer.isBuffer(publicKey)).toBe(true);
      const adminPin = `sha256:${createHash("sha256")
        .update(publicKey)
        .digest("hex")}`;
      const configPath = join(pki.directory, "admin-edge.json");
      writeFileSync(
        configPath,
        `${JSON.stringify({
          schema_version: 1,
          kind: "echo-organization-admin-edge-runtime-config",
          listener: { host: "127.0.0.1", port: 443 },
          public_origin: "https://admin.edge.test",
          employee_authority_base_url: "https://authority.edge.test",
          authority_origin: "http://127.0.0.1:39479",
          tls: {
            certificate_chain_ref: `file:${pki.server.certificate_path}`,
            private_key_ref: `file:${pki.server.private_key_path}`,
            client_ca_bundle_ref: `file:${pki.ca_certificate_path}`,
          },
          trusted_proxy_token_ref: `file:${proxyTokenPath}`,
          allowed_admin_client_spki_sha256: [adminPin],
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const packagedPreflight = run(
        process.execPath,
        [
          join(installRoot, "package/bin/echo-organization-admin-edge.mjs"),
          "preflight",
          "--config",
          configPath,
        ],
        { cwd: installRoot, timeout: 10_000 },
      );
      const report = JSON.parse(packagedPreflight.stdout) as {
        readonly ok: boolean;
        readonly release_platform_qualified: boolean;
        readonly failed_check?: string;
      };
      expect(
        validatePreflight(report),
        JSON.stringify(validatePreflight.errors),
      ).toBe(true);
      const releasePlatform =
        process.platform === "darwin" &&
        process.arch === "arm64" &&
        process.versions.node === "22.22.1";
      if (releasePlatform) {
        expect(packagedPreflight.status, packagedPreflight.stderr).toBe(0);
        expect(report).toMatchObject({
          ok: true,
          release_platform_qualified: true,
          public_origin: "https://admin.edge.test",
          listener: { host: "127.0.0.1", port: 443 },
          allowed_admin_client_count: 1,
          client_ca_certificate_count: 1,
        });
      } else {
        expect(packagedPreflight.status).toBe(1);
        expect(report).toMatchObject({
          ok: false,
          release_platform_qualified: false,
          failed_check: "release_platform",
        });
      }
      expect(packagedPreflight.stderr).toBe("");
      expect(packagedPreflight.stdout).not.toContain(proxyToken);
      expect(packagedPreflight.stdout).not.toContain(adminPin);
      expect(packagedPreflight.stdout).not.toContain(pki.directory);
    } finally {
      pki.cleanup();
    }

    const tamperedDir = join(temporaryRoot, "tampered-admin-edge-artifact");
    cpSync(outDir, tamperedDir, { recursive: true });
    writeFileSync(join(tamperedDir, built.artifact), "tampered\n", {
      flag: "a",
    });
    const tampered = run(
      process.execPath,
      [verifier, "--artifact-dir", tamperedDir],
      { cwd: fixture.root },
    );
    expect(tampered.status).toBe(1);
    expect(JSON.parse(tampered.stdout)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "administrator edge artifact SHA-256 mismatch",
        "administrator edge artifact size mismatch",
      ]),
    });

    const incompleteDir = join(temporaryRoot, "incomplete-admin-edge-artifact");
    cpSync(outDir, incompleteDir, { recursive: true });
    const incompleteManifestPath = join(
      incompleteDir,
      "artifact-manifest.json",
    );
    const incompleteManifest = JSON.parse(
      readFileSync(incompleteManifestPath, "utf8"),
    ) as { package_files: Array<{ readonly path: string }> };
    incompleteManifest.package_files = incompleteManifest.package_files.filter(
      ({ path }) => path !== "dist/main.js",
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
      "package_files omit required runtime path: dist/main.js",
    );

    const linkedDir = join(temporaryRoot, "linked-admin-edge-artifact");
    cpSync(outDir, linkedDir, { recursive: true });
    const linkedTree = join(temporaryRoot, "linked-admin-edge-tree");
    mkdirSync(linkedTree);
    const linkedArtifactPath = join(linkedDir, built.artifact);
    const expandedLinked = run(
      "/usr/bin/tar",
      ["-xzf", linkedArtifactPath, "-C", linkedTree],
      { cwd: temporaryRoot },
    );
    expect(expandedLinked.status, expandedLinked.stderr).toBe(0);
    const linkedVerifierPath = join(
      linkedTree,
      "package/tools/organization-admin-edge/verify-artifact.mjs",
    );
    rmSync(linkedVerifierPath);
    symlinkSync("/etc/passwd", linkedVerifierPath);
    const repackedLinked = run(
      "/usr/bin/tar",
      ["-czf", linkedArtifactPath, "-C", linkedTree, "package"],
      { cwd: temporaryRoot },
    );
    expect(repackedLinked.status, repackedLinked.stderr).toBe(0);
    const linkedManifestPath = join(linkedDir, "artifact-manifest.json");
    const linkedManifest = JSON.parse(
      readFileSync(linkedManifestPath, "utf8"),
    ) as {
      artifact: { path: string; size: number; sha256: string };
    };
    linkedManifest.artifact.size = statSync(linkedArtifactPath).size;
    linkedManifest.artifact.sha256 = createHash("sha256")
      .update(readFileSync(linkedArtifactPath))
      .digest("hex");
    writeFileSync(
      linkedManifestPath,
      `${JSON.stringify(linkedManifest, null, 2)}\n`,
    );
    writeFileSync(
      `${linkedArtifactPath}.sha256`,
      `${linkedManifest.artifact.sha256}  ${linkedManifest.artifact.path}\n`,
    );
    const linked = run(
      process.execPath,
      [verifier, "--artifact-dir", linkedDir],
      { cwd: fixture.root },
    );
    expect(linked.status).toBe(1);
    expect(JSON.parse(linked.stdout)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "administrator edge tarball contains a non-regular, linked, or ambiguous entry",
      ]),
    });

    const overwrite = run(
      process.execPath,
      [
        builder,
        "--version",
        "0.1.0-dev.admin-edge-test",
        "--source-sha",
        fixture.sha,
        "--out-dir",
        outDir,
      ],
      { cwd: fixture.root },
    );
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toContain("--out-dir already exists");
  }, 300_000);
});
