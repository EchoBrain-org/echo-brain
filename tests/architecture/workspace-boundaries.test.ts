import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  copyCoherentWorktreeSnapshot,
  createCoherentWorktreeSnapshot,
} from "../fixtures/coherent-worktree.js";

const REPO = resolve(import.meta.dirname, "../..");
const REGISTRY = "tools/workspace-source-boundaries.v1.json";
const tmpDirs: string[] = [];
let snapshot: string | undefined;
let moduleLoaderFixture: string | undefined;

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

interface LayerRule {
  name: string;
  from: string;
  allowed_imports: string[];
}

interface BoundaryManifest {
  name: string;
  workspace: boolean;
  boundary_root: string;
  entry_points: string[];
  owned_source_paths: string[];
  allowed_internal_paths: string[];
  allowed_workspace_packages: string[];
  allowed_external_packages: string[];
  allowed_node_builtins: string[];
  forbidden_repository_roots?: string[];
  runtime_assets?: string[];
  layer_rules: LayerRule[];
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

function fixtureForModuleLoaderCases(): string {
  if (moduleLoaderFixture === undefined) {
    moduleLoaderFixture = fixtureRepository();
  }
  return moduleLoaderFixture;
}

function readFixtureJson<T>(fixture: string, path: string): T {
  return JSON.parse(readFileSync(join(fixture, path), "utf8")) as T;
}

function writeFixtureJson(fixture: string, path: string, value: unknown): void {
  writeFileSync(join(fixture, path), `${JSON.stringify(value, null, 2)}\n`);
}

function runBoundary(fixture: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [join(fixture, "tools/check-architecture-boundaries.mjs")],
    {
      cwd: fixture,
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("workspace source boundaries", () => {
  it("accepts the declared workspace component indexes", () => {
    const fixture = fixtureRepository();

    const result = runBoundary(fixture);

    expect(result.status, result.stdout + result.stderr).toBe(0);
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

  it("rejects a reintroduced retired workspace root", () => {
    const fixture = fixtureRepository();
    const registry = readFixtureJson<Registry>(fixture, REGISTRY);
    const retiredRoot = registry.retired_workspace_roots[0]!;
    mkdirSync(join(fixture, retiredRoot), { recursive: true });

    const result = runBoundary(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      `retired workspace root remains: ${retiredRoot}`,
    );
  });

  it("requires a component index for every workspace", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "packages/federation-protocol/source-boundary.v1.json";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    delete manifest.component_index_contract;
    writeFixtureJson(fixture, manifestPath, manifest);

    const result = runBoundary(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "@echo-brain/federation-protocol: component_index_contract is required",
    );
  });

  it("rejects a missing canonical Authority component path", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "services/organization-authority/source-boundary.v1.json";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    const contract = manifest.component_index_contract;
    expect(contract).toBeDefined();
    contract!.canonical_components[0]!.path =
      "services/organization-authority/src/composition/missing-organization-authority-composition-root.ts";
    writeFixtureJson(fixture, manifestPath, manifest);

    const result = runBoundary(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "canonical component 'Organization Authority composition root' path is missing",
    );
  });

  it("rejects a reintroduced retired Authority component path", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "services/organization-authority/source-boundary.v1.json";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    const contract = manifest.component_index_contract;
    expect(contract).toBeDefined();
    const retiredPath = contract!.retired_source_paths[0]!;
    writeFileSync(join(fixture, retiredPath), "export {};\n");

    const result = runBoundary(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      `retired component source path remains: ${retiredPath}`,
    );
  });

  it("rejects a compatibility facade that targets the wrong implementation", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "services/organization-authority/source-boundary.v1.json";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    const contract = manifest.component_index_contract;
    expect(contract).toBeDefined();
    contract!.compatibility_entrypoints[0]!.targets = [
      "services/organization-authority/src/composition/organization-authority-service-cli.ts",
    ];
    writeFixtureJson(fixture, manifestPath, manifest);

    const result = runBoundary(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "compatibility entrypoint must import only its declared implementation targets",
    );
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
        "@echo-brain/provider-granola",
        "@echo-brain/provider-openrouter",
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
      "@echo-brain/provider-anthropic": [
        "@echo-brain/organization-processing"
      ],
      "@echo-brain/provider-ollama": [
        "@echo-brain/organization-processing"
      ],
      "@echo-brain/provider-openai": [
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
        "@echo-brain/organization-record",
        "@echo-brain/provider-slack-client"
      ],
      "@echo-brain/provider-slack-client": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api"
      ],
      "@echo-brain/provider-granola": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-authority-kernel",
        "@echo-brain/organization-processing"
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
    const dockerfile = readFileSync(
      join(REPO, "deploy/organization-authority/Dockerfile"),
      "utf8",
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
    const dockerfile = readFileSync(
      join(REPO, "deploy/organization-authority/Dockerfile"),
      "utf8",
    );
    const cleanup =
      "RUN find packages services providers -type f \\( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.tsbuildinfo' \\) -delete";

    expect(dockerfile).toContain(cleanup);
    expect(dockerfile.indexOf(cleanup)).toBeGreaterThan(
      dockerfile.indexOf("npm ci --omit=dev --workspace @echo-brain/organization-authority --include-workspace-root=false"),
    );
    expect(dockerfile.indexOf(cleanup)).toBeLessThan(
      dockerfile.indexOf("\nFROM node:22.22.1-bookworm-slim"),
    );
    expect([...cleanup.matchAll(/-name '([^']+)'/g)].map((match) => match[1])).toEqual([
      "*.d.ts",
      "*.d.ts.map",
      "*.tsbuildinfo",
    ]);
    expect(cleanup).not.toContain("*.map");
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
    expect(readFileSync(join(REPO, "deploy/organization-authority/Dockerfile"), "utf8"))
      .not.toContain("/migrations");
  });

  it("ships only the six current Authority state baseline SQL assets", () => {
    const expectedByRoot: Record<string, string[]> = {
      "packages/organization-authority-kernel": [
        "authority-baseline-v5.sql",
      ],
      "packages/organization-control-plane": [
        "organization-control-plane-baseline-v3.sql",
      ],
      "packages/organization-record": [
        "organization-record-log-baseline-v3.sql",
      ],
      "packages/organization-retrieval": [
        "readable-search-content-baseline-v1.sql",
        "readable-search-facts-baseline-v2.sql",
        "readable-search-lexical-baseline-v1.sql",
      ],
    };

    const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json",
      ...Object.keys(expectedByRoot).flatMap(root => ["--workspace", root]),
    ], { cwd: REPO, encoding: "utf8", timeout: 30_000 });
    expect(packed.status, packed.stderr).toBe(0);
    const artifacts = JSON.parse(packed.stdout) as Array<{ name: string; files: Array<{ path: string }> }>;

    for (const [root, expectedBaselines] of Object.entries(expectedByRoot)) {
      const manifest = readJson<{ runtime_assets?: string[] }>(
        `${root}/source-boundary.v1.json`,
      );
      const packageManifest = readJson<PackageManifest>(`${root}/package.json`);
      const artifact = artifacts.find(item => item.name === packageManifest.name);
      expect(artifact?.files.filter(file => file.path.endsWith(".sql")).map(file => file.path).sort())
        .toEqual(expectedBaselines.map(name => `baselines/${name}`).sort());
      expect(packageManifest.files?.filter(path => path.startsWith("baselines/")).sort())
        .toEqual(expectedBaselines.map(name => `baselines/${name}`).sort());
      expect(
        [...(manifest.runtime_assets ?? [])]
          .filter((path) => path.startsWith(`${root}/baselines/`))
          .map((path) => path.slice(`${root}/baselines/`.length))
          .sort(),
      ).toEqual([...expectedBaselines].sort());

      const dockerfile = readFileSync(join(REPO, "deploy/organization-authority/Dockerfile"), "utf8");
      expect(dockerfile).not.toContain(`/app/${root}/baselines ./${root}/baselines`);
      for (const name of expectedBaselines) {
        expect(existsSync(join(REPO, root, "baselines", name))).toBe(true);
        expect(dockerfile).toContain(
          `COPY --from=build /app/${root}/baselines/${name} ./${root}/baselines/${name}`,
        );
      }
    }
  });

  it("parses real module syntax without treating comments or strings as imports", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/index.ts");
    writeFileSync(
      entry,
      [
        `const example = "require('@forbidden/pkg')";`,
        `/* import '@forbidden/pkg'; */`,
        "void example;",
        "export {};",
        "",
      ].join("\n"),
    );
    const passingResult = runBoundary(fixture);
    expect(
      passingResult.status,
      passingResult.stdout + passingResult.stderr,
    ).toBe(0);

    writeFileSync(
      entry,
      `export { value } from /* boundary */ '@forbidden/pkg';\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "external import @forbidden/pkg is not allowed",
    );
  });

  it("rejects commented require syntax and non-literal module loading", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/index.ts");
    // Punctuation between the loader and its call cannot hide the name.
    writeFileSync(entry, `require /* boundary */ ('@forbidden/pkg');\n`);
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      `const target = '@forbidden/pkg';\nvoid import(target);\n`,
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "non-literal module loading is forbidden",
    );
  });

  it("rejects direct and disguised node:module loader capabilities", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/index.ts");
    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        `createRequire(import.meta.url)('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    // A node:module namespace exposes several loaders and is refused at the
    // import edge, before reflection or computed property access can hide which
    // loader is selected.
    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        "const load = Module.createRequire(import.meta.url);",
        `load('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        `const load = Module['createRequire'](import.meta.url);`,
        `load('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        `const make = Reflect.get(Module, 'createRequire');`,
        `make(import.meta.url)('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `import * as Module from 'node:module';`,
        `const { ['create' + 'Require']: make } = Module;`,
        `make(import.meta.url)('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `import { _load as load } from 'module';`,
        `load('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `const get = process['get' + 'BuiltinModule'];`,
        `get('module').createRequire(import.meta.url)('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `const { 'getBuiltinModule': get } = process;`,
        `const { 'createRequire': make } = get('module');`,
        `make(import.meta.url)('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        "let get;",
        "({ getBuiltinModule: get } = process);",
        "let make;",
        `({ createRequire: make } = get('module'));`,
        `make(import.meta.url)('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      ["const load = module._load;", `load('@forbidden/pkg');`, ""].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `const Module = Reflect.get(globalThis, 'module');`,
        `Module._load('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `import { 'getBuiltinModule' as get } from 'node:process';`,
        `get('module')._load('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );
  });

  it("rejects loader identifiers that escape direct call position", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/index.ts");

    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        "const load = createRequire(import.meta.url);",
        "const indirect = load;",
        `indirect('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    let result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        "const load = createRequire(import.meta.url);",
        "const forward = (loader) => loader('@forbidden/pkg');",
        "forward(load);",
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );

    writeFileSync(
      entry,
      [
        `import { createRequire } from 'node:module';`,
        "const load = createRequire(import.meta.url);",
        "const expose = () => load;",
        `expose()('@forbidden/pkg');`,
        "",
      ].join("\n"),
    );
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module loaders are forbidden",
    );
  });

  // Tracking where a loader value travels is undecidable in general, and the
  // repository uses no loader anywhere, so the rule is refusal at the source:
  // naming a loader is the violation, whatever is done with it afterwards.
  it.each([
    [
      "direct call with an allowlisted target",
      [
        `import { createRequire } from 'node:module';`,
        `createRequire(import.meta.url)('@echo-brain/federation-protocol');`,
      ],
    ],
    [
      "assignment after a bare declaration",
      [
        `import { createRequire } from 'node:module';`,
        "let load;",
        "load = createRequire(import.meta.url);",
        `load('@forbidden/pkg');`,
      ],
    ],
    [
      "loader stored in an object",
      [
        `import { createRequire } from 'node:module';`,
        "const loaders = { load: createRequire(import.meta.url) };",
        `loaders.load('@forbidden/pkg');`,
      ],
    ],
    [
      "loader stored in an array",
      [
        `import { createRequire } from 'node:module';`,
        "const loaders = [createRequire(import.meta.url)];",
        `loaders[0]('@forbidden/pkg');`,
      ],
    ],
    [
      "loader returned from a function",
      [
        `import { createRequire } from 'node:module';`,
        "const make = () => createRequire(import.meta.url);",
        `make()('@forbidden/pkg');`,
      ],
    ],
    ["bare require call", [`require('@forbidden/pkg');`]],
  ])("rejects a module loader: %s", (name, lines) => {
    // Every case replaces the entire source file before invoking the checker,
    // so these otherwise independent cases can safely share one isolated
    // worktree without reducing coverage.
    const fixture = fixtureForModuleLoaderCases();
    writeFileSync(
      join(fixture, "packages/federation-protocol/src/index.ts"),
      `${lines.join("\n")}\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status, name).not.toBe(0);
    expect(result.stdout + result.stderr, name).toContain(
      "module loaders are forbidden",
    );
  });

  it("accepts loader words used only as declaration-only member names", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/index.ts");

    // Every `require` / `createRequire` below sits in a member-name position:
    // it names a property and is never evaluated as a value. Modelling a
    // package.json exports entry is the ordinary reason to write these.
    writeFileSync(
      entry,
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
        "",
      ].join("\n"),
    );

    const result = runBoundary(fixture);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("still rejects loader words in evaluated property positions", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/index.ts");

    // A computed name and a shorthand property both *evaluate* the identifier,
    // so the member-name exemption must not reach them.
    const escapes: ReadonlyArray<readonly [string, string]> = [
      [
        "object shorthand property",
        ["export const bundle = { require };", ""].join("\n"),
      ],
      [
        "computed object key",
        ["export const table = { [require]: 1 };", ""].join("\n"),
      ],
      [
        "computed object key via createRequire",
        [
          `import { createRequire } from 'node:module';`,
          "export const table = { [createRequire]: 1 };",
          "",
        ].join("\n"),
      ],
      [
        "computed class member",
        [
          `import { createRequire } from 'node:module';`,
          "export class Loaders {",
          "  [createRequire]() {",
          "    return 1;",
          "  }",
          "}",
          "",
        ].join("\n"),
      ],
      [
        "shorthand property carrying a createRequire alias",
        [
          `import { createRequire } from 'node:module';`,
          "const load = createRequire(import.meta.url);",
          "export const bundle = { load };",
          "",
        ].join("\n"),
      ],
    ];

    for (const [label, source] of escapes) {
      writeFileSync(entry, source);
      const result = runBoundary(fixture);
      expect(
        result.status,
        `${label}: ${result.stdout + result.stderr}`,
      ).not.toBe(0);
      expect(result.stdout + result.stderr, label).toContain(
        "module loaders are forbidden",
      );
    }
  });

  it("rejects workspace deep imports that are not package exports", () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, "packages/organization-protocol/src/index.ts"),
      `export { value } from '@echo-brain/federation-protocol/private';\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "workspace deep import is not exported",
    );
  });

  it("rejects owned source files that do not belong to a declared layer", () => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, "services/organization-authority/src/unlayered.ts"),
      "export {};\n",
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "owned source file has no layer rule",
    );
  });

  it("rejects a replacement under the retired synthetic quality directory", () => {
    const fixture = fixtureRepository();
    const path =
      "services/organization-authority/src/quality/replacement-quality-lane-v2.ts";
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), "export {};\n");

    const result = runBoundary(fixture);

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      `owned source file has no layer rule: ${path}`,
    );
  });

  it("keeps retired machine product roots absent", () => {
    const fixture = fixtureRepository();
    const orphan = join(fixture, "src/product/organization/orphan.ts");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "export {};\n");
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "module remains under removed internal root",
    );
  });

  it("checks whole modules for named, type, namespace, side-effect and re-export edges", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/provider-probe.ts");
    const target = "@echo-brain/provider-openai/llm/openai-client";
    for (const source of [
      `import { OpenAiClient as Client } from '${target}'; export { Client };`,
      `import type { OpenAiClient } from '${target}'; export type Client = OpenAiClient;`,
      `import * as adapter from '${target}'; export { adapter };`,
      `import '${target}';`,
      `export { OpenAiClient } from '${target}';`,
      `export * from '${target}';`,
      `export type Client = import('${target}').OpenAiClient;`,
      `export const load = () => import('${target}');`,
    ]) {
      writeFileSync(entry, source);
      const result = runBoundary(fixture);
      expect(result.status, source).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("neutral module reaches provider");
    }
    for (const source of [
      "export type FileStats = import('node:fs').Stats;",
      "export type Database = import('better-sqlite3').Database;",
    ]) {
      writeFileSync(entry, source);
      expect(runBoundary(fixture).status, source).not.toBe(0);
    }
    writeFileSync(entry, `export const documentation = 'Slack, Granola, OpenRouter and an unknown future vendor';\n`);
    expect(runBoundary(fixture).status).toBe(0);
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
    writeFileSync(entry, original);
    expect(runBoundary(fixture).status).toBe(0);
  });

  it("checks provider assets and native assembly ownership through the same gate", () => {
    const fixture = fixtureRepository();
    const entry = join(fixture, "packages/federation-protocol/src/asset-probe.ts");
    writeFileSync(entry, "export const asset = new URL('../../../providers/openrouter/assets/telemetry-vocabulary.v1.json', import.meta.url);\n");
    expect(runBoundary(fixture).stdout).toContain("neutral module reaches provider");
    rmSync(entry);
    const orphan = join(fixture, "product/echo-overlay/unregistered.swift");
    writeFileSync(orphan, "struct Unregistered {}\n");
    expect(runBoundary(fixture).stdout).toContain("Swift source has no assembly owner");
    rmSync(orphan);
    const assemblyPath = "product/echo-overlay/source-assembly.v1.json";
    const assembly = readFixtureJson<{ neutral_sources: string[]; provider_sources: string[] }>(fixture, assemblyPath);
    assembly.neutral_sources.push(...assembly.provider_sources);
    assembly.provider_sources = [];
    writeFixtureJson(fixture, assemblyPath, assembly);
    expect(runBoundary(fixture).stdout).toContain("assembly input has the wrong provider owner");
  });

  it("builds neutral packages with no provider, Person or service workspace available", () => {
    const result = spawnSync(process.execPath, [join(REPO, "tools/check-neutral-build.mjs")], { cwd: REPO, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, neutral_workspaces: 8, provider_workspaces: 0, service_workspaces: 0, prebuilt_workspace_outputs: 0 });
  });

  it("does not hide provider exports behind an unused name in a shared barrel", () => {
    const fixture = fixtureRepository();
    const barrel = join(fixture, "packages/organization-api/src/index.ts");
    writeFileSync(barrel, readFileSync(barrel, "utf8") + "\nexport { OpenAiClient } from '@echo-brain/provider-openai/llm/openai-client';\n");
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("neutral module reaches provider: packages/organization-api/src/index.ts");
  });

  it("forbids neutral-to-bootstrap, provider-to-service and cross-provider dependencies", () => {
    const fixture = fixtureRepository();
    const cases = [
      ["packages/organization-api/src/direction-probe.ts", "../../../services/organization-authority/src/composition/organization-authority-setup-cli.js", "neutral module reaches bootstrap"],
      ["providers/openai/src/direction-probe.ts", "../../../services/organization-authority/src/composition/organization-authority-runtime.js", "provider imports the composing service"],
      ["providers/openai/src/direction-probe.ts", "@echo-brain/provider-anthropic/llm/anthropic-client", "cross-provider dependency"],
    ];
    for (const [path, target, failure] of cases) {
      const entry = join(fixture, path!);
      writeFileSync(entry, `import '${target}';\n`);
      const result = runBoundary(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(failure);
      rmSync(entry);
    }
    expect(runBoundary(fixture).status).toBe(0);
  });

  it("requires production ownership even for a test-named folder inside shipped source", () => {
    const fixture = fixtureRepository();
    const hidden = join(fixture, "packages/federation-protocol/src/test");
    mkdirSync(hidden);
    writeFileSync(join(hidden, "bridge.ts"), "import '@echo-brain/provider-openai/llm/openai-client';\n");
    expect(runBoundary(fixture).stdout).toContain("neutral module reaches provider");
    rmSync(hidden, { recursive: true });
    const orphan = join(fixture, "packages/unregistered/src");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "index.ts"), "export const value = 1;\n");
    expect(runBoundary(fixture).stdout).toContain("production module has no architecture owner");
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

  it("rejects retired exceptions, stale bootstrap declarations and divergent export conditions", () => {
    const fixture = fixtureRepository();
    const path = "product/source-boundary.v1.json";
    const product = readFixtureJson<{ adapter_architecture: Record<string, unknown> }>(fixture, path);
    product.adapter_architecture.provider_coupled_exceptions = [];
    writeFixtureJson(fixture, path, product);
    expect(runBoundary(fixture).stdout).toContain("unsupported or retired: provider_coupled_exceptions");
    delete product.adapter_architecture.provider_coupled_exceptions;
    (product.adapter_architecture.bootstrap_entrypoints as string[]).push("services/organization-authority/src/missing.ts");
    writeFixtureJson(fixture, path, product);
    expect(runBoundary(fixture).stdout).toContain("bootstrap entrypoint must name a composing source module");
    (product.adapter_architecture.bootstrap_entrypoints as string[]).pop(); writeFixtureJson(fixture, path, product);
    const packagePath = "providers/openai/package.json";
    const pkg = readFixtureJson<{ exports: Record<string, Record<string, string>> }>(fixture, packagePath);
    pkg.exports["./llm/openai-client"]!.node = "./dist/another-entry.js";
    writeFixtureJson(fixture, packagePath, pkg);
    expect(runBoundary(fixture).stdout).toContain("requires an explicit workspace export");
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
