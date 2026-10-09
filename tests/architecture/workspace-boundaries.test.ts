import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  copyCoherentWorktreeSnapshot,
  createCoherentWorktreeSnapshot,
} from "../fixtures/coherent-worktree.js";

const REPO = resolve(import.meta.dirname, "../..");
const REGISTRY = "tools/workspace-source-boundaries.v1.json";
const tmpDirs: string[] = [];
let snapshot: string | undefined;
const dockerfile = readFileSync(
  join(REPO, "deploy/organization-authority/Dockerfile"),
  "utf8",
);

afterAll(() =>
  tmpDirs
    .slice()
    .reverse()
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

interface Registry {
  registry_version: number;
  kind: string;
  retired_workspace_roots: string[];
  manifests: string[];
}

interface BoundaryManifest {
  name: string;
  workspace: boolean;
  boundary_root: string;
  entry_points: string[];
  owned_source_paths: string[];
  allowed_workspace_packages: string[];
  allowed_external_packages: string[];
  allowed_node_builtins: string[];
  component_index_contract?: {
    canonical_components: Array<{
      name: string;
      path: string;
      export: string;
    }>;
    retired_source_paths: string[];
    compatibility_entrypoints: Array<{
      path: string;
      targets: string[];
    }>;
  };
}

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  files?: string[];
  exports?: Record<string, unknown>;
}

interface BoundaryResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO, path), "utf8")) as T;
}

function snapshotRepository(): string {
  if (snapshot !== undefined) return snapshot;

  const root = mkdtempSync(join(tmpdir(), "echo-workspace-boundary-snapshot-"));
  tmpDirs.push(root);
  snapshot = createCoherentWorktreeSnapshot(REPO, root);
  return snapshot;
}

function fixtureRepository(): string {
  const source = snapshotRepository();
  const root = mkdtempSync(join(tmpdir(), "echo-workspace-boundary-"));
  tmpDirs.push(root);
  return copyCoherentWorktreeSnapshot(source, root);
}

function readFixtureJson<T>(fixture: string, path: string): T {
  return JSON.parse(readFileSync(join(fixture, path), "utf8")) as T;
}

function writeFixtureJson(fixture: string, path: string, value: unknown): void {
  writeFileSync(join(fixture, path), `${JSON.stringify(value, null, 2)}\n`);
}

function runBoundary(fixture: string): BoundaryResult {
  // The checker exits right after writing its report, and pipe writes are
  // asynchronous on macOS, so a batched report could be cut at 64 KiB.
  // Capture through files instead, outside the scanned fixture.
  const output = mkdtempSync(join(tmpdir(), "echo-workspace-boundary-output-"));
  const paths = [join(output, "stdout"), join(output, "stderr")] as const;
  const fds = paths.map((path) => openSync(path, "w"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(fixture, "tools/check-architecture-boundaries.mjs")],
      { cwd: fixture, stdio: ["ignore", fds[0], fds[1]] },
    );
    return {
      status: result.status,
      stdout: readFileSync(paths[0], "utf8"),
      stderr: readFileSync(paths[1], "utf8"),
    };
  } finally {
    fds.forEach((fd) => closeSync(fd));
    rmSync(output, { recursive: true, force: true });
  }
}

describe("workspace source boundaries", () => {
  // Every refusal names its own field or path, so one checker run proves each.
  describe("product manifest refusals", () => {
    const retiredFields = [
      "entry_points",
      "allowed_internal_paths",
      "forbidden_internal_roots",
      "allowed_external_runtime_packages",
      "runtime_assets",
      "layer_rules",
    ];
    let result: BoundaryResult;
    beforeAll(() => {
      const fixture = fixtureRepository();
      const path = "product/source-boundary.v1.json";
      const boundary = readFixtureJson<
        Record<string, unknown> & { adapter_architecture: Record<string, unknown> }
      >(fixture, path);
      for (const field of retiredFields) {
        boundary[field] = [field === "layer_rules" ? {} : "src/retired-machine.ts"];
      }
      boundary.child_process_owner = "src/retired-machine.ts";
      boundary.adapter_architecture.provider_coupled_exceptions = [];
      (boundary.adapter_architecture.bootstrap_entrypoints as string[]).push("services/organization-authority/src/missing.ts");
      writeFixtureJson(fixture, path, boundary);
      const packagePath = "providers/openrouter/package.json";
      const pkg = readFixtureJson<{ exports: Record<string, Record<string, string>> }>(fixture, packagePath);
      pkg.exports["./llm/openrouter-decision-processor"]!.node = "./dist/another-entry.js";
      writeFixtureJson(fixture, packagePath, pkg);
      result = runBoundary(fixture);
    });

    it.each([
      ...retiredFields.map((field) => [
        `reactivation through retired machine ${field}`,
        `retired machine boundary ${field} must remain empty`,
      ]),
      ["a process owner in the retired machine boundary", "retired machine boundary child_process_owner must remain null"],
      ["retired provider exceptions", "unsupported or retired: provider_coupled_exceptions"],
      ["a stale bootstrap declaration", "bootstrap entrypoint must name a composing source module: services/organization-authority/src/missing.ts"],
      ["a divergent export condition", "requires an explicit workspace export: @echo-brain/provider-openrouter ./llm/openrouter-decision-processor"],
    ])("refuses %s", (_label, message) => {
      expect(result.status).not.toBe(0);
      expect(result.stdout, result.stderr).toContain(message);
    });
  });

  it("accepts the declared workspace component indexes", () => {
    const fixture = fixtureRepository();

    const result = runBoundary(fixture);

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  describe("ownership, layer and component-index refusals", () => {
    const authorityPath = "services/organization-authority/source-boundary.v1.json";
    const retiredRoot = readJson<Registry>(REGISTRY).retired_workspace_roots[0]!;
    const retiredPath = readJson<BoundaryManifest>(authorityPath)
      .component_index_contract!.retired_source_paths[0]!;
    const unlayered = "services/organization-authority/src/unlayered.ts";
    const quality = "services/organization-authority/src/quality/replacement-quality-lane-v2.ts";
    const orphan = "src/product/organization/orphan.ts";
    // Document parser and filesystem work stay out of these layers.
    const layerProbes = [
      ["services/organization-authority/src/application/document-v1.ts", "pdfjs-dist", "external import", "authority-application-depends-inward"],
      ["services/organization-authority/src/presentation/person-documents-http-route-v1.ts", "node:fs/promises", "Node builtin", "authority-presentation-calls-application"],
    ] as const;
    let result: BoundaryResult;
    beforeAll(() => {
      const fixture = fixtureRepository();
      for (const [path, dependency] of layerProbes) {
        const file = join(fixture, path);
        writeFileSync(file, `import '${dependency}';\n${readFileSync(file, "utf8")}`);
      }
      mkdirSync(join(fixture, retiredRoot), { recursive: true });
      const federationPath = "packages/federation-protocol/source-boundary.v1.json";
      const federation = readFixtureJson<BoundaryManifest>(fixture, federationPath);
      delete federation.component_index_contract;
      writeFixtureJson(fixture, federationPath, federation);
      const authority = readFixtureJson<BoundaryManifest>(fixture, authorityPath);
      const contract = authority.component_index_contract!;
      contract.canonical_components[0]!.path =
        "services/organization-authority/src/composition/missing-organization-authority-composition-root.ts";
      contract.compatibility_entrypoints[0]!.targets = [
        "services/organization-authority/src/composition/organization-authority-service-cli.ts",
      ];
      writeFixtureJson(fixture, authorityPath, authority);
      for (const path of [retiredPath, unlayered, quality, orphan]) {
        mkdirSync(dirname(join(fixture, path)), { recursive: true });
        writeFileSync(join(fixture, path), "export {};\n");
      }
      result = runBoundary(fixture);
    });

    it.each([
      ...layerProbes.map(([path, dependency, kind, layer]) => [
        `document parser and filesystem work in ${path}`,
        `layer rule '${layer}' rejects ${kind} ${dependency} in ${path}`,
      ]),
      ["a reintroduced retired workspace root", `retired workspace root remains: ${retiredRoot}`],
      ["a workspace without a component index", "@echo-brain/federation-protocol: component_index_contract is required"],
      ["a missing canonical Authority component path", "canonical component 'Organization Authority composition root' path is missing"],
      ["a reintroduced retired Authority component path", `retired component source path remains: ${retiredPath}`],
      ["a compatibility facade that targets the wrong implementation", "compatibility entrypoint must import only its declared implementation targets"],
      ["an owned source file outside every declared layer", `owned source file has no layer rule: ${unlayered}`],
      ["a replacement under the retired synthetic quality directory", `owned source file has no layer rule: ${quality}`],
      ["a module under a retired machine product root", `module remains under removed internal root: ${orphan}`],
    ])("refuses %s", (_label, message) => {
      expect(result.status).not.toBe(0);
      expect(result.stdout, result.stderr).toContain(message);
    });
  });

  it("retains dirty and untracked inputs in isolated coherent worktrees", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "echo-coherent-source-"));
    tmpDirs.push(sourceRoot);
    const source = join(sourceRoot, "repo");
    mkdirSync(join(source, "node_modules"), { recursive: true });
    expect(spawnSync("git", ["init", "--quiet", source]).status).toBe(0);
    expect(
      spawnSync("git", ["-C", source, "config", "user.email", "test@example.test"])
        .status,
    ).toBe(0);
    expect(
      spawnSync("git", ["-C", source, "config", "user.name", "Test User"]).status,
    ).toBe(0);
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    expect(spawnSync("git", ["-C", source, "add", "tracked.txt"]).status).toBe(0);
    expect(
      spawnSync("git", ["-C", source, "commit", "--quiet", "-m", "initial"]).status,
    ).toBe(0);
    writeFileSync(join(source, "tracked.txt"), "dirty\n");
    writeFileSync(join(source, "untracked.txt"), "untracked\n");

    const snapshotRoot = mkdtempSync(join(tmpdir(), "echo-coherent-snapshot-"));
    const firstRoot = mkdtempSync(join(tmpdir(), "echo-coherent-first-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "echo-coherent-second-"));
    tmpDirs.push(snapshotRoot, firstRoot, secondRoot);
    const snapshot = createCoherentWorktreeSnapshot(source, snapshotRoot);
    const first = copyCoherentWorktreeSnapshot(snapshot, firstRoot);
    const second = copyCoherentWorktreeSnapshot(snapshot, secondRoot);

    for (const repository of [snapshot, first, second]) {
      expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe("dirty\n");
      expect(readFileSync(join(repository, "untracked.txt"), "utf8")).toBe(
        "untracked\n",
      );
    }
    const listed = spawnSync(
      "git",
      ["-C", first, "ls-files", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8" },
    );
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("untracked.txt");

    writeFileSync(join(first, "tracked.txt"), "first fixture only\n");
    expect(readFileSync(join(second, "tracked.txt"), "utf8")).toBe("dirty\n");
  });

  it("matches every declared workspace to one checked boundary", () => {
    const rootPackage = readJson<{ workspaces: string[] }>("package.json");
    const registry = readJson<Registry>(REGISTRY);
    const manifests = registry.manifests.map((path) =>
      readJson<BoundaryManifest>(path),
    );
    const workspaceRoots = manifests
      .filter((manifest) => manifest.workspace)
      .map((manifest) => manifest.boundary_root)
      .sort();

    expect(registry).toMatchObject({
      registry_version: 1,
      kind: "echo-workspace-source-boundary-registry",
    });
    expect(registry.retired_workspace_roots).toEqual([
      "services/organization-control-plane",
      "services/organization-record",
      "services/organization-retrieval",
    ]);
    expect(workspaceRoots).toEqual([...rootPackage.workspaces].sort());
    expect(new Set(manifests.map((manifest) => manifest.name)).size).toBe(
      manifests.length,
    );
    for (const manifest of manifests) {
      for (const entryPoint of manifest.entry_points) {
        expect(existsSync(join(REPO, entryPoint)), entryPoint).toBe(true);
      }
    }
  });

  it("locks the one-way workspace dependency graph", () => {
    const registry = readJson<Registry>(REGISTRY);
    const graph = Object.fromEntries(
      registry.manifests.map((path) => {
        const manifest = readJson<BoundaryManifest>(path);
        return [manifest.name, [...manifest.allowed_workspace_packages].sort()];
      }),
    );

    expect(graph).toEqual({
      "@echo-brain/federation-protocol": [],
      "@echo-brain/organization-protocol": [
        "@echo-brain/federation-protocol"
      ],
      "@echo-brain/organization-api": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-protocol"
      ],
      "@echo-brain/organization-authority": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/organization-control-plane",
        "@echo-brain/organization-processing",
        "@echo-brain/organization-protocol",
        "@echo-brain/organization-record",
        "@echo-brain/organization-retrieval",
        "@echo-brain/provider-confluence",
        "@echo-brain/provider-granola",
        "@echo-brain/provider-jira",
        "@echo-brain/provider-openrouter",
        "@echo-brain/provider-runtime",
        "@echo-brain/provider-slack-server",
        "@echo-brain/provider-synthetic-demo"
      ],
      "@echo-brain/organization-control-plane": [],
      "@echo-brain/organization-record": [
        "@echo-brain/federation-protocol"
      ],
      "@echo-brain/organization-retrieval": [
        "@echo-brain/federation-protocol"
      ],
      "@echo-brain/person-client": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-protocol",
        "@echo-brain/provider-confluence-client",
        "@echo-brain/provider-jira-client",
        "@echo-brain/provider-slack-client"
      ],
      "@echo-brain/organization-authority-kernel": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-control-plane",
        "@echo-brain/organization-protocol",
        "@echo-brain/organization-record",
        "@echo-brain/organization-retrieval"
      ],
      "@echo-brain/organization-processing": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/organization-control-plane",
        "@echo-brain/organization-record"
      ],
      "@echo-brain/provider-openrouter": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/organization-processing"
      ],
      "@echo-brain/provider-synthetic-demo": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/organization-processing"
      ],
      "@echo-brain/provider-slack-server": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/organization-control-plane",
        "@echo-brain/organization-processing",
        "@echo-brain/organization-protocol",
        "@echo-brain/provider-runtime",
        "@echo-brain/provider-slack-client"
      ],
      "@echo-brain/provider-slack-client": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api"
      ],
      "@echo-brain/provider-granola": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/organization-processing",
        "@echo-brain/provider-runtime"
      ],
      "@echo-brain/provider-runtime": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-authority-kernel"
      ],
      "@echo-brain/provider-confluence": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/provider-confluence-client",
        "@echo-brain/provider-runtime"
      ],
      "@echo-brain/provider-confluence-client": [
        "@echo-brain/organization-api"
      ],
      "@echo-brain/provider-jira": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/provider-jira-client",
        "@echo-brain/provider-runtime"
      ],
      "@echo-brain/provider-jira-client": [
        "@echo-brain/organization-api"
      ]
    });;
  });

  it("keeps the Authority container closed over its workspace build and runtime dependencies", () => {
    const rootPackage = readJson<{ workspaces: string[] }>("package.json");
    const workspaceByName = new Map(
      rootPackage.workspaces.map((workspace) => [
        readJson<PackageManifest>(`${workspace}/package.json`).name,
        workspace,
      ]),
    );

    const runtimeClosure = new Set<string>();
    const visit = (workspace: string): void => {
      if (runtimeClosure.has(workspace)) return;
      runtimeClosure.add(workspace);
      const manifest = readJson<PackageManifest>(`${workspace}/package.json`);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        const dependencyWorkspace = workspaceByName.get(dependency);
        if (dependencyWorkspace !== undefined) visit(dependencyWorkspace);
      }
    };
    visit("services/organization-authority");

    // npm ci reads every workspace manifest, but the server builder compiles
    // and receives source only for the Authority dependency closure.
    for (const workspace of rootPackage.workspaces) {
      const parent = workspace.split("/")[0]!;
      const manifestCopied =
        dockerfile.includes(`COPY ${workspace} ./${workspace}`) ||
        dockerfile.includes(`COPY ${parent} ./${parent}`) ||
        dockerfile.includes(
          `COPY ${workspace}/package.json ./${workspace}/package.json`,
        );
      expect(
        manifestCopied,
        `builder omits workspace manifest ${workspace}`,
      ).toBe(true);
    }
    for (const workspace of runtimeClosure) {
      const parent = workspace.split("/")[0]!;
      const sourceCopied =
        dockerfile.includes(`COPY ${workspace} ./${workspace}`) ||
        dockerfile.includes(`COPY ${parent} ./${parent}`);
      expect(sourceCopied, `builder omits workspace source ${workspace}`).toBe(
        true,
      );
    }
    expect(dockerfile).toContain(
      "npm run build --workspace @echo-brain/organization-authority",
    );
    expect(dockerfile).toContain(
      "npm ci --omit=dev --workspace @echo-brain/organization-authority --include-workspace-root=false",
    );
    expect(dockerfile).not.toContain("npm run build:workspaces");
    expect(dockerfile).not.toContain(
      "COPY src/product/person-client ./src/product/person-client",
    );

    for (const match of dockerfile.matchAll(/^COPY --from=build \/app\/(.+?) \./gm)) {
      const path = match[1]!;
      if (path === "node_modules" || path.endsWith("/dist")) continue;
      expect(existsSync(join(REPO, path)), `runtime COPY source is missing: ${path}`).toBe(true);
    }

    // npm's workspace links resolve into these runtime directories. Every
    // reachable workspace therefore needs its package exports and compiled
    // code, and service packages that ship Authority state baselines need those
    // immutable filesystem assets beside dist.
    for (const workspace of [...runtimeClosure].sort()) {
      const manifest = readJson<PackageManifest>(`${workspace}/package.json`);
      expect(dockerfile).toContain(
        `COPY --from=build /app/${workspace}/package.json ./${workspace}/package.json`,
      );
      expect(dockerfile).toContain(
        `COPY --from=build /app/${workspace}/dist ./${workspace}/dist`,
      );
      for (const target of Object.values(manifest.exports ?? {})) {
        if (typeof target !== "string" || !target.endsWith(".json")) continue;
        const asset = target.replace(/^\.\//, "");
        const copied = [asset, dirname(asset)].some(path => dockerfile.includes(
          `COPY --from=build /app/${workspace}/${path} ./${workspace}/${path}`,
        ));
        expect(copied, `runtime omits public asset ${workspace}/${asset}`).toBe(true);
      }
      for (const asset of manifest.files?.filter(path => path.startsWith("baselines/")) ?? []) {
        expect(dockerfile).toContain(
          `COPY --from=build /app/${workspace}/${asset} ./${workspace}/${asset}`,
        );
      }
    }
  });

  it("removes TypeScript-only Authority image artifacts before the runtime image copies them", () => {
    const cleanup =
      "RUN find packages services providers -type f \\( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.tsbuildinfo' \\) -delete";

    expect(dockerfile).toContain(cleanup);
    expect(dockerfile.indexOf(cleanup)).toBeGreaterThan(
      dockerfile.indexOf("npm ci --omit=dev --workspace @echo-brain/organization-authority --include-workspace-root=false"),
    );
    expect(dockerfile.indexOf(cleanup)).toBeLessThan(
      dockerfile.indexOf("\nFROM node:22.22.1-bookworm-slim"),
    );
  });

  it("ships frozen baselines instead of migration trees", () => {
    for (const [root, manifestPath] of [
      [
        "services/organization-authority",
        "services/organization-authority/source-boundary.v1.json",
      ],
      [
        "packages/organization-control-plane",
        "packages/organization-control-plane/source-boundary.v1.json",
      ],
      [
        "packages/organization-record",
        "packages/organization-record/source-boundary.v1.json",
      ],
      [
        "packages/organization-retrieval",
        "packages/organization-retrieval/source-boundary.v1.json",
      ],
    ]) {
      const packageManifest = readJson<PackageManifest>(`${root}/package.json`);
      const manifest = readJson<{ runtime_assets?: string[] }>(manifestPath);
      expect(existsSync(join(REPO, root, "migrations"))).toBe(false);
      expect(
        packageManifest.files?.some((path) => path.startsWith("migrations/")) ??
          false,
      ).toBe(false);
      expect(
        (manifest.runtime_assets ?? []).some((path) =>
          path.startsWith(`${root}/migrations/`),
        ),
      ).toBe(false);
    }
    expect(dockerfile).not.toContain("/migrations");
  });

  const expectedByRoot: Record<string, string[]> = {
    "packages/organization-authority-kernel": [
      "authority-baseline-v13.sql",
    ],
    "packages/organization-control-plane": [
      "organization-control-plane-baseline-v4.sql",
    ],
    "packages/organization-record": [
      "organization-record-log-baseline-v4.sql",
    ],
    "packages/organization-retrieval": [
      "readable-search-content-baseline-v2.sql",
      "readable-search-facts-baseline-v3.sql",
      "readable-search-lexical-baseline-v2.sql",
    ],
  };
  let packed: Array<{ name: string; files: Array<{ path: string }> }> | undefined;
  // One npm pack serves the Authority package and every baseline package.
  function packedFiles(root: string): string[] | undefined {
    if (packed === undefined) {
      const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json",
        ...["services/organization-authority", ...Object.keys(expectedByRoot)].flatMap(workspace => ["--workspace", workspace]),
      ], { cwd: REPO, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      packed = JSON.parse(result.stdout) as typeof packed;
    }
    const name = readJson<PackageManifest>(`${root}/package.json`).name;
    return packed!.find(item => item.name === name)?.files.map(file => file.path);
  }

  it("ships the compiled document extraction worker in the Authority package", () => {
    expect(packedFiles("services/organization-authority")).toContain("dist/adapters/documents/document-extraction-worker.js");
  });

  it("ships only the current baselines", () => {
    for (const [root, expectedBaselines] of Object.entries(expectedByRoot)) {
      const manifest = readJson<{ runtime_assets?: string[] }>(
        `${root}/source-boundary.v1.json`,
      );
      const packageManifest = readJson<PackageManifest>(`${root}/package.json`);
      expect(packedFiles(root)?.filter(path => path.endsWith(".sql")).sort())
        .toEqual(expectedBaselines.map(name => `baselines/${name}`).sort());
      expect(packageManifest.files?.filter(path => path.startsWith("baselines/")).sort())
        .toEqual(expectedBaselines.map(name => `baselines/${name}`).sort());
      expect(
        [...(manifest.runtime_assets ?? [])]
          .filter((path) => path.startsWith(`${root}/baselines/`))
          .map((path) => path.slice(`${root}/baselines/`.length))
          .sort(),
      ).toEqual([...expectedBaselines].sort());
      // The per-file COPY lines are checked with the runtime closure above.
      expect(dockerfile).not.toContain(`/app/${root}/baselines ./${root}/baselines`);
    }
  });

  // Each probe is its own file and every refusal names its file, so one
  // checker run proves each probe on its own.
  describe("module reference parsing", () => {
    const probePath = (label: string) =>
      `packages/federation-protocol/src/probe-${label.replace(/[^a-z0-9]+/gi, "-")}.ts`;
    const deepImport = "packages/organization-protocol/src/probe-deep-import.ts";
    const accepted: Array<[string, string[]]> = [
      [
        "comments and strings",
        [
          `const example = "require('@forbidden/pkg')";`,
          `/* import '@forbidden/pkg'; */`,
          "void example;",
          "export {};",
        ],
      ],
      [
        // Every `require` / `createRequire` below sits in a member-name position:
        // it names a property and is never evaluated as a value. Modelling a
        // package.json exports entry is the ordinary reason to write these.
        "declaration-only member names",
        [
          "export interface PackageEntryPoint {",
          "  require: string;",
          "  import: string;",
          "}",
          "export interface LoaderApi {",
          "  require(specifier: string): unknown;",
          "  createRequire: string;",
          "}",
          "export type ExportsMap = { require: string };",
          "export const entryPoint = {",
          `  exports: { require: './index.cjs', import: './index.mjs' },`,
          `  createRequire: 'documented',`,
          "};",
          "export const literalMembers = {",
          "  require() {",
          `    return 'name only';`,
          "  },",
          "  get createRequire() {",
          `    return 'name only';`,
          "  },",
          "};",
          "export class Manifest {",
          `  require = './index.cjs';`,
          "  createRequire(): string {",
          "    return this.require;",
          "  }",
          "}",
          "export class Accessors {",
          `  private value = './index.cjs';`,
          "  get require(): string {",
          "    return this.value;",
          "  }",
          "  set require(next: string) {",
          "    this.value = next;",
          "  }",
          "  get createRequire(): string {",
          "    return this.value;",
          "  }",
          "}",
          "export enum LoaderKind {",
          `  require = 'require',`,
          `  createRequire = 'createRequire',`,
          "}",
        ],
      ],
      [
        "vendor prose",
        [`export const documentation = 'Slack, Granola, OpenRouter and an unknown future vendor';`],
      ],
    ];
    const loader = (path: string) =>
      `module loaders are forbidden; use a static import or import() in ${path}:`;
    // Tracking where a loader value travels is undecidable in general, and the
    // repository uses no loader anywhere, so the rule is refusal at the source:
    // naming a loader is the violation, whatever is done with it afterwards.
    const refused: Array<[string, (path: string) => string, string[]]> = [
      [
        "a re-export with a comment before its specifier",
        (path) => `external import @forbidden/pkg is not allowed in ${path}`,
        [`export { value } from /* boundary */ '@forbidden/pkg';`],
      ],
      // Punctuation between the loader and its call cannot hide the name.
      ["require with a comment before its call", loader, [`require /* boundary */ ('@forbidden/pkg');`]],
      [
        "non-literal module loading",
        (path) => `non-literal module loading is forbidden in ${path}:`,
        [`const target = '@forbidden/pkg';`, "void import(target);"],
      ],
      [
        "imported createRequire",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          `createRequire(import.meta.url)('@forbidden/pkg');`,
        ],
      ],
      // A node:module namespace exposes several loaders and is refused at the
      // import edge, before reflection or computed property access can hide
      // which loader is selected.
      [
        "node:module namespace member",
        loader,
        [
          `import * as Module from 'node:module';`,
          "const load = Module.createRequire(import.meta.url);",
          `load('@forbidden/pkg');`,
        ],
      ],
      [
        "node:module namespace computed member",
        loader,
        [
          `import * as Module from 'node:module';`,
          `const load = Module['createRequire'](import.meta.url);`,
          `load('@forbidden/pkg');`,
        ],
      ],
      [
        "node:module namespace reflection",
        loader,
        [
          `import * as Module from 'node:module';`,
          `const make = Reflect.get(Module, 'createRequire');`,
          `make(import.meta.url)('@forbidden/pkg');`,
        ],
      ],
      [
        "node:module namespace computed destructuring",
        loader,
        [
          `import * as Module from 'node:module';`,
          `const { ['create' + 'Require']: make } = Module;`,
          `make(import.meta.url)('@forbidden/pkg');`,
        ],
      ],
      [
        "aliased _load import",
        loader,
        [`import { _load as load } from 'module';`, `load('@forbidden/pkg');`],
      ],
      [
        "computed getBuiltinModule access",
        loader,
        [
          `const get = process['get' + 'BuiltinModule'];`,
          `get('module').createRequire(import.meta.url)('@forbidden/pkg');`,
        ],
      ],
      [
        "quoted getBuiltinModule destructuring",
        loader,
        [
          `const { 'getBuiltinModule': get } = process;`,
          `const { 'createRequire': make } = get('module');`,
          `make(import.meta.url)('@forbidden/pkg');`,
        ],
      ],
      [
        "getBuiltinModule destructuring assignment",
        loader,
        [
          "let get;",
          "({ getBuiltinModule: get } = process);",
          "let make;",
          `({ createRequire: make } = get('module'));`,
          `make(import.meta.url)('@forbidden/pkg');`,
        ],
      ],
      ["module._load alias", loader, ["const load = module._load;", `load('@forbidden/pkg');`]],
      [
        "reflected global module",
        loader,
        [`const Module = Reflect.get(globalThis, 'module');`, `Module._load('@forbidden/pkg');`],
      ],
      [
        "getBuiltinModule imported from node:process",
        loader,
        [
          `import { 'getBuiltinModule' as get } from 'node:process';`,
          `get('module')._load('@forbidden/pkg');`,
        ],
      ],
      [
        "loader aliased to another identifier",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "const load = createRequire(import.meta.url);",
          "const indirect = load;",
          `indirect('@forbidden/pkg');`,
        ],
      ],
      [
        "loader passed as an argument",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "const load = createRequire(import.meta.url);",
          "const forward = (loader) => loader('@forbidden/pkg');",
          "forward(load);",
        ],
      ],
      [
        "loader returned from a closure",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "const load = createRequire(import.meta.url);",
          "const expose = () => load;",
          `expose()('@forbidden/pkg');`,
        ],
      ],
      [
        "direct call with an allowlisted target",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          `createRequire(import.meta.url)('@echo-brain/federation-protocol');`,
        ],
      ],
      [
        "assignment after a bare declaration",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "let load;",
          "load = createRequire(import.meta.url);",
          `load('@forbidden/pkg');`,
        ],
      ],
      [
        "loader stored in an object",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "const loaders = { load: createRequire(import.meta.url) };",
          `loaders.load('@forbidden/pkg');`,
        ],
      ],
      [
        "loader stored in an array",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "const loaders = [createRequire(import.meta.url)];",
          `loaders[0]('@forbidden/pkg');`,
        ],
      ],
      [
        "loader returned from a function",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "const make = () => createRequire(import.meta.url);",
          `make()('@forbidden/pkg');`,
        ],
      ],
      ["bare require call", loader, [`require('@forbidden/pkg');`]],
      // A computed name and a shorthand property both *evaluate* the
      // identifier, so the member-name exemption must not reach them.
      ["object shorthand property", loader, ["export const bundle = { require };"]],
      ["computed object key", loader, ["export const table = { [require]: 1 };"]],
      [
        "computed object key via createRequire",
        loader,
        [`import { createRequire } from 'node:module';`, "export const table = { [createRequire]: 1 };"],
      ],
      [
        "computed class member",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "export class Loaders {",
          "  [createRequire]() {",
          "    return 1;",
          "  }",
          "}",
        ],
      ],
      [
        "shorthand property carrying a createRequire alias",
        loader,
        [
          `import { createRequire } from 'node:module';`,
          "const load = createRequire(import.meta.url);",
          "export const bundle = { load };",
        ],
      ],
    ];
    let acceptedResult: BoundaryResult;
    let refusedResult: BoundaryResult;
    beforeAll(() => {
      const fixture = fixtureRepository();
      // "wx" refuses to overwrite, so no two probes can share a file.
      const write = (path: string, lines: string[]) =>
        writeFileSync(join(fixture, path), `${lines.join("\n")}\n`, { flag: "wx" });
      for (const [label, lines] of accepted) write(probePath(label), lines);
      acceptedResult = runBoundary(fixture);
      for (const [label, , lines] of refused) write(probePath(label), lines);
      write(deepImport, [`export { value } from '@echo-brain/federation-protocol/private';`]);
      refusedResult = runBoundary(fixture);
    });

    it("accepts loader words in comments, strings, declaration-only member names and vendor prose", () => {
      expect(acceptedResult.status, acceptedResult.stdout + acceptedResult.stderr).toBe(0);
    });

    it.each(refused)("rejects %s", (label, failure) => {
      expect(refusedResult.status).not.toBe(0);
      expect(refusedResult.stdout, refusedResult.stderr).toContain(failure(probePath(label)));
    });

    it("rejects workspace deep imports that are not package exports", () => {
      expect(refusedResult.status).not.toBe(0);
      expect(refusedResult.stdout, refusedResult.stderr).toContain(
        `workspace deep import is not exported: @echo-brain/federation-protocol/private in ${deepImport}`,
      );
    });
  });

  // Each probe is its own file and every refusal names its edge or path, so
  // one run per fixture proves each probe on its own.
  describe("provider ownership and direction", () => {
    const processor = "@echo-brain/provider-openrouter/llm/openrouter-decision-processor";
    const reaches = (path: string, target = "providers/openrouter/src/llm/openrouter-decision-processor.ts") =>
      `neutral module reaches provider: ${path} -> ${target}`;
    const edgePath = (index: number) => `packages/federation-protocol/src/provider-probe-${index}.ts`;
    // Whole modules: named, type, namespace, side-effect and re-export edges.
    const edges = [
      `import { createOpenRouterDecisionProcessor as Client } from '${processor}'; export { Client };`,
      `import type { createOpenRouterDecisionProcessor } from '${processor}'; export type Client = typeof createOpenRouterDecisionProcessor;`,
      `import * as adapter from '${processor}'; export { adapter };`,
      `import '${processor}';`,
      `export { createOpenRouterDecisionProcessor } from '${processor}';`,
      `export * from '${processor}';`,
      `export type Client = typeof import('${processor}').createOpenRouterDecisionProcessor;`,
      `export const load = () => import('${processor}');`,
    ];
    const typeFs = "packages/federation-protocol/src/type-fs.ts";
    const typeSqlite = "packages/federation-protocol/src/type-sqlite.ts";
    const barrel = "packages/organization-api/src/index.ts";
    // A test-named folder inside shipped source is still production source.
    const bridge = "packages/federation-protocol/src/test/bridge.ts";
    const asset = "packages/federation-protocol/src/asset-probe.ts";
    const unregistered = "packages/unregistered/src/index.ts";
    const swift = "product/unregistered.swift";
    const assemblyPath = "deploy/organization-authority/journey-explorer-assembly.v1.json";
    const neutralAsset = "deploy/organization-authority/authority-staging-v1.example.json";
    // The dangerous direction: provider code listed as a neutral source.
    // Neutral sources must be .mjs, so the probe is a provider-owned module.
    const providerModule = "providers/openrouter/src/assembly-probe.mjs";
    const composition = "services/organization-authority/src/composition";
    const directions = [
      ["neutral-to-bootstrap", "packages/organization-api/src/direction-probe.ts", `../../../${composition}/organization-authority-setup-cli.js`, "neutral module reaches bootstrap", `${composition}/organization-authority-setup-cli.ts`],
      ["provider-to-service", "providers/openrouter/src/direction-probe-service.ts", `../../../${composition}/organization-authority-runtime.js`, "provider imports the composing service", `${composition}/organization-authority-runtime.ts`],
      ["cross-provider", "providers/openrouter/src/direction-probe-provider.ts", "@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1", "cross-provider dependency", "providers/synthetic-demo/src/staging-synthetic-personal-meeting-provider-v1.ts"],
    ];
    let ownership: BoundaryResult;
    let direction: BoundaryResult;
    beforeAll(() => {
      const fixture = fixtureRepository();
      const write = (path: string, source: string) => writeFileSync(join(fixture, path), source);
      edges.forEach((source, index) => write(edgePath(index), source));
      write(typeFs, "export type FileStats = import('node:fs').Stats;");
      write(typeSqlite, "export type Database = import('better-sqlite3').Database;");
      write(barrel, `${readFileSync(join(fixture, barrel), "utf8")}\nexport { createOpenRouterDecisionProcessor } from '${processor}';\n`);
      mkdirSync(dirname(join(fixture, bridge)));
      write(bridge, `import '${processor}';\n`);
      write(asset, "export const asset = new URL('../../../providers/openrouter/assets/telemetry-vocabulary.v1.json', import.meta.url);\n");
      mkdirSync(dirname(join(fixture, unregistered)), { recursive: true });
      write(unregistered, "export const value = 1;\n");
      write(swift, "struct Unregistered {}\n");
      write(providerModule, "export const probe = 1;\n");
      const assembly = readFixtureJson<{ neutral_sources: string[]; provider_assets: string[] }>(fixture, assemblyPath);
      writeFixtureJson(fixture, assemblyPath, {
        ...assembly,
        neutral_sources: [...assembly.neutral_sources, providerModule],
        provider_assets: [...assembly.provider_assets, neutralAsset],
      });
      ownership = runBoundary(fixture);

      const directionFixture = fixtureRepository();
      for (const [, path, target] of directions) {
        writeFileSync(join(directionFixture, path!), `import '${target}';\n`);
      }
      direction = runBoundary(directionFixture);
    });

    it.each([
      ...edges.map((source, index) => [`the whole-module edge ${source}`, reaches(edgePath(index))]),
      ["a type-only Node builtin edge", `Node builtin node:fs is not boundary-allowlisted in ${typeFs}`],
      ["a type-only external package edge", `external import better-sqlite3 is not allowed in ${typeSqlite}`],
      ["a provider export behind an unused name in a shared barrel", reaches(barrel)],
      ["a provider edge from a test-named folder inside shipped source", reaches(bridge)],
      ["a provider asset URL", reaches(asset, "providers/openrouter/assets/telemetry-vocabulary.v1.json")],
      ["a production module without an architecture owner", `production module has no architecture owner: ${unregistered}`],
      ["retired Swift source", `Swift source is retired and has no builder: ${swift}`],
      ["a neutral asset listed as a provider asset", `assembly input has the wrong provider owner: ${neutralAsset}`],
      ["a provider module listed as a neutral source", `assembly input has the wrong provider owner: ${providerModule}`],
      ["a neutral source outside its assembly", `neutral assembly input escapes its owner: ${providerModule}`],
    ])("refuses %s", (_label, message) => {
      expect(ownership.status).not.toBe(0);
      expect(ownership.stdout, ownership.stderr).toContain(message);
    });

    it.each(directions)("forbids %s dependencies", (_label, path, _target, failure, resolved) => {
      expect(direction.status).not.toBe(0);
      expect(direction.stdout, direction.stderr).toContain(`${failure}: ${path} -> ${resolved}`);
    });
  });

  it("enforces executable deployment assembly imports as well as workspace imports", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "deploy/organization-authority/staging-journey-explorer-handler-v1.mjs");
    const original = readFileSync(entry, "utf8");
    for (const [probe, error] of [
      ["const target = 'unexpected'; export const load = () => import(target);", "assembly forbids opaque module loading"],
      ["import 'unexpected-provider-sdk';", "assembly import is not allowed"],
      ["import 'node:fs';", "assembly import is not allowed"],
      ["import '@aws-sdk/client-cloudwatch-logs/unreviewed';", "assembly import is not allowed"],
      ["const load = process.getBuiltinModule;", "assembly forbids opaque module loading"],
      ["import './unregistered.mjs';", "assembly import is not a declared input"],
    ]) {
      writeFileSync(entry, original + "\n" + probe);
      const result = runBoundary(fixture);
      expect(result.status, probe).not.toBe(0);
      expect(result.stdout + result.stderr, probe).toContain(error);
    }
  });

  it("builds neutral packages with no provider, Person or service workspace available", () => {
    const result = spawnSync(process.execPath, [join(REPO, "tools/check-neutral-build.mjs")], { cwd: REPO, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, neutral_workspaces: 8, provider_workspaces: 0, service_workspaces: 0, prebuilt_workspace_outputs: 0 });
  });

  it("admits a new vendor only through a real workspace and one provider folder", () => {
    const fixture = fixtureRepository();
    const root = "providers/unseen-adapter";
    const source = `${root}/src/index.ts`;
    mkdirSync(join(fixture, root, "src"), { recursive: true });
    writeFileSync(join(fixture, source), "export const decode = (value: unknown) => ({ value });\n");
    expect(runBoundary(fixture).stdout).toContain("provider source must belong to a registered workspace package");
    const name = "@echo-brain/provider-unseen-adapter";
    writeFixtureJson(fixture, `${root}/package.json`, { name, version: "0.0.0-dev.0", type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } });
    writeFixtureJson(fixture, `${root}/tsconfig.json`, { compilerOptions: { rootDir: "src", outDir: "dist" } });
    const manifest = { boundary_version: 1, kind: "echo-workspace-source-boundary", name, workspace: true,
      boundary_root: root, source_root: `${root}/src`, package_json: `${root}/package.json`, entry_points: [source],
      owned_source_paths: [`${root}/src/**`], allowed_internal_paths: [`${root}/src/**`],
      allowed_workspace_packages: [], allowed_external_packages: [], allowed_node_builtins: [], runtime_assets: [],
      component_index_contract: { canonical_components: [{ name: "Synthetic decoder", path: source, export: "decode" }], retired_source_paths: [], compatibility_entrypoints: [] },
      layer_rules: [{ name: "provider-owned", from: `${root}/src/**`, allowed_imports: [`${root}/src/**`], allowed_workspace_packages: [], allowed_external_packages: [], allowed_node_builtins: [] }],
    };
    writeFixtureJson(fixture, `${root}/source-boundary.v1.json`, manifest);
    const pkg = readFixtureJson<{ workspaces: string[] }>(fixture, "package.json");
    pkg.workspaces.push(root); writeFixtureJson(fixture, "package.json", pkg);
    const registry = readFixtureJson<Registry>(fixture, REGISTRY);
    registry.manifests.push(`${root}/source-boundary.v1.json`); writeFixtureJson(fixture, REGISTRY, registry);
    expect(runBoundary(fixture).stdout).toContain("production module has no architecture owner");
    const product = readFixtureJson<{ adapter_architecture: { provider_roots: string[] } }>(fixture, "product/source-boundary.v1.json");
    product.adapter_architecture.provider_roots.push(root); writeFixtureJson(fixture, "product/source-boundary.v1.json", product);
    const result = runBoundary(fixture);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("applies builtin and external allowlists at the matching layer", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "packages/organization-authority-kernel/source-boundary.v1.json";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    manifest.allowed_node_builtins = ["process"];
    manifest.allowed_external_packages = ["ajv"];
    writeFixtureJson(fixture, manifestPath, manifest);
    const packagePath = "packages/organization-authority-kernel/package.json";
    const packageJson = readFixtureJson<{
      dependencies: Record<string, string>;
    }>(fixture, packagePath);
    packageJson.dependencies.ajv = "8.17.1";
    writeFixtureJson(fixture, packagePath, packageJson);
    writeFileSync(
      join(fixture, "packages/organization-authority-kernel/src/domain/probe.ts"),
      [
        `import process from 'node:process';`,
        `import Ajv from 'ajv';`,
        "void process;",
        "void Ajv;",
        "",
      ].join("\n"),
    );

    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'organization-authority-kernel-domain' rejects Node builtin node:process",
    );
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'organization-authority-kernel-domain' rejects external import ajv",
    );
  });

  it("rejects manifests that narrow ownership or point outside their boundary", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "services/organization-authority/source-boundary.v1.json";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    manifest.owned_source_paths = [
      "services/organization-authority/src/domain/**",
    ];
    manifest.entry_points = ["tests/not-an-authority-entry.ts"];
    writeFixtureJson(fixture, manifestPath, manifest);

    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("entry_points path leaves");
    expect(result.stdout + result.stderr).toContain(
      "source file is not covered by owned_source_paths",
    );
  });
});
