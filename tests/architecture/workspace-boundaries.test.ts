import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const REGISTRY = "tools/workspace-source-boundaries.v1.json";
const tmpDirs: string[] = [];

afterAll(() =>
  tmpDirs.forEach((path) => rmSync(path, { recursive: true, force: true })),
);

interface Registry {
  registry_version: number;
  kind: string;
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
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO, path), "utf8")) as T;
}

// Mirrors matchesGlob in tools/check-architecture-boundaries.mjs. The tool runs main() at
// import time, so its matcher cannot be imported; a boundary pattern is
// compared against another pattern exactly as the tool compares it to a path.
function matchesGlob(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!pattern.includes("*")) return path === pattern;
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

function fixtureRepository(): string {
  const fixture = mkdtempSync(join(tmpdir(), "echo-workspace-boundary-"));
  tmpDirs.push(fixture);
  const clone = join(fixture, "repo");
  const cloned = spawnSync("git", ["clone", "--quiet", REPO, clone], {
    encoding: "utf8",
  });
  expect(cloned.status, cloned.stdout + cloned.stderr).toBe(0);

  // Negative boundary tests must mutate one coherent repository snapshot. A
  // hand-picked overlay can silently mix committed source with current
  // manifests, which makes the guard report stale or missing imports instead
  // of the violation under test.
  const workingTreeDiff = spawnSync(
    "git",
    ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."],
    { cwd: REPO, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(workingTreeDiff.status, workingTreeDiff.stderr?.toString("utf8")).toBe(
    0,
  );
  if (workingTreeDiff.stdout.length > 0) {
    const applied = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: clone,
      input: workingTreeDiff.stdout,
      encoding: "utf8",
    });
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
  }

  const untracked = spawnSync(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { cwd: REPO, encoding: "buffer" },
  );
  expect(untracked.status, untracked.stderr?.toString("utf8")).toBe(0);
  for (const path of untracked.stdout.toString("utf8").split("\0")) {
    if (path === "") continue;
    const source = join(REPO, path);
    if (!lstatSync(source).isFile()) continue;
    const destination = join(clone, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { force: true });
  }
  symlinkSync(join(REPO, "node_modules"), join(clone, "node_modules"), "dir");
  return clone;
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
      "@echo-brain/organization-api": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-protocol",
      ],
      "@echo-brain/organization-authority": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-control-plane",
        "@echo-brain/organization-protocol",
        "@echo-brain/organization-record",
        "@echo-brain/organization-retrieval",
      ],
      "@echo-brain/organization-control-plane": [],
      "@echo-brain/organization-protocol": ["@echo-brain/federation-protocol"],
      "@echo-brain/organization-record": ["@echo-brain/federation-protocol"],
      "@echo-brain/organization-retrieval": ["@echo-brain/federation-protocol"],
      "@echo-brain/person-client": [
        "@echo-brain/federation-protocol",
        "@echo-brain/organization-api",
        "@echo-brain/organization-protocol",
      ],
    });
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
      if (manifest.files?.some((path) => path.startsWith("baselines/"))) {
        expect(dockerfile).toContain(
          `COPY --from=build /app/${workspace}/baselines ./${workspace}/baselines`,
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
      "RUN find packages services -type f \\( -name '*.d.ts' -o -name '*.tsbuildinfo' \\) -delete";

    expect(dockerfile).toContain(cleanup);
    expect(dockerfile.indexOf(cleanup)).toBeGreaterThan(
      dockerfile.indexOf("npm ci --omit=dev --workspace @echo-brain/organization-authority --include-workspace-root=false"),
    );
    expect(dockerfile.indexOf(cleanup)).toBeLessThan(
      dockerfile.indexOf("\nFROM node:22.22.1-bookworm-slim"),
    );
    expect([...cleanup.matchAll(/-name '([^']+)'/g)].map((match) => match[1])).toEqual([
      "*.d.ts",
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
        "services/organization-control-plane",
        "services/organization-control-plane/source-boundary.v1.json",
      ],
      [
        "services/organization-record",
        "services/organization-record/source-boundary.v1.json",
      ],
      [
        "services/organization-retrieval",
        "services/organization-retrieval/source-boundary.v1.json",
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

  it("declares and ships all Authority state baseline SQL assets", () => {
    const expectedByRoot: Record<string, string[]> = {
      "services/organization-authority": [
        "authority-baseline-v1.sql",
        "authority-live-source-v3.sql",
        "authority-private-approval-v2.sql",
      ],
      "services/organization-control-plane": [
        "organization-control-plane-baseline-v1.sql",
        "organization-control-plane-private-approval-v2.sql",
      ],
      "services/organization-record": [
        "organization-record-derived-baseline-v1.sql",
        "organization-record-log-baseline-v1.sql",
        "organization-record-log-baseline-v2.sql",
      ],
      "services/organization-retrieval": [
        "readable-search-content-baseline-v1.sql",
        "readable-search-facts-baseline-v1.sql",
        "readable-search-lexical-baseline-v1.sql",
      ],
    };

    for (const [root, expectedBaselines] of Object.entries(expectedByRoot)) {
      const manifest = readJson<{ runtime_assets?: string[] }>(
        `${root}/source-boundary.v1.json`,
      );
      const packageManifest = readJson<PackageManifest>(`${root}/package.json`);
      expect(packageManifest.files).toContain("baselines/**");
      expect(
        [...(manifest.runtime_assets ?? [])]
          .filter((path) => path.startsWith(`${root}/baselines/`))
          .map((path) => path.slice(`${root}/baselines/`.length))
          .sort(),
      ).toEqual([...expectedBaselines].sort());

      const baselineDirectory = join(REPO, root, "baselines");
      const presentBaselines = existsSync(baselineDirectory)
        ? readdirSync(baselineDirectory)
            .filter((path) => path.endsWith(".sql"))
            .sort()
        : [];
      expect(expectedBaselines).toEqual(
        expect.arrayContaining(presentBaselines),
      );
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
  ])("rejects a module loader: %s", (_name, lines) => {
    const fixture = fixtureRepository();
    writeFileSync(
      join(fixture, "packages/federation-protocol/src/index.ts"),
      `${lines.join("\n")}\n`,
    );
    const result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
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

  it("discovers adapter ids and rejects them in provider-neutral core", () => {
    const fixture = fixtureRepository();
    let result = runBoundary(fixture);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      discovered_adapter_ids: string[];
    };
    expect(report.discovered_adapter_ids).toEqual([
      "anthropic",
      "deepseek",
      "granola",
      "llm",
      "ollama",
      "openai",
      "openrouter",
      "slack",
      "synthetic-source",
    ]);

    const probe = join(
      fixture,
      "services/organization-authority/src/processing/core/adapter-id-leak-probe.ts",
    );
    writeFileSync(probe, `export const leakedAdapterId = 'granola';\n`);
    result = runBoundary(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "provider identifier 'granola' leaked into provider-neutral module: services/organization-authority/src/processing/core/adapter-id-leak-probe.ts",
    );
  });

  it("keeps supplemental provider identifiers and discovered adapters out of neutral modules", () => {
    const fixture = fixtureRepository();
    const manifest = readFixtureJson<BoundaryManifest>(
      fixture,
      "services/organization-authority/source-boundary.v1.json",
    );
    const admittedMeetingProcessingRule = manifest.layer_rules.find(
      (rule) => rule.name === "admitted-meeting-processing-is-provider-neutral",
    );
    expect(admittedMeetingProcessingRule).toBeDefined();
    expect(admittedMeetingProcessingRule?.allowed_imports).not.toContain(
      "services/organization-authority/src/processing/adapters/meeting-sources/granola/index.ts",
    );
    const compositionRule = manifest.layer_rules.find(
      (rule) => rule.name === "authority-composition-may-wire-pre-processing-layers",
    );
    expect(compositionRule?.allowed_imports).toContain(
      "services/organization-authority/src/processing/adapters/meeting-sources/granola/**",
    );
    for (const concreteCompositionModule of [
      "services/organization-authority/src/composition/granola-admitted-meeting-source-cursor-policy-v1.ts",
      "services/organization-authority/src/composition/organization-authority-composition-root.ts",
    ]) {
      expect(existsSync(join(fixture, concreteCompositionModule))).toBe(true);
    }

    const product = readFixtureJson<{
      adapter_architecture: {
        provider_neutral_paths: string[];
        provider_identifier_registry: Array<{
          identifier: string;
          transport_provider?: boolean;
          source_evidence_paths: string[];
        }>;
        provider_adapter_roots: Array<{
          identifier: string;
          root: string;
        }>;
        forbid_discovered_adapter_ids_in_provider_neutral_paths: boolean;
      };
    }>(fixture, "product/source-boundary.v1.json");
    expect(product.adapter_architecture.provider_neutral_paths).toContain(
      "services/organization-authority/src/processing/admitted-meeting-processing/**",
    );
    expect(
      product.adapter_architecture.provider_identifier_registry.map(
        ({ identifier }) => identifier,
      ),
    ).toEqual(["openrouter", "openai", "anthropic", "ollama", "deepseek"]);
    expect(
      product.adapter_architecture
        .forbid_discovered_adapter_ids_in_provider_neutral_paths,
    ).toBe(true);
    expect(product.adapter_architecture.provider_adapter_roots).toEqual(expect.arrayContaining([
      {
        identifier: "granola",
        root: "services/organization-authority/src/processing/adapters/meeting-sources/granola/",
      },
      {
        identifier: "llm",
        root: "services/organization-authority/src/processing/adapters/decision-processors/llm/",
      },
      {
        identifier: "slack",
        root: "services/organization-authority/src/processing/adapters/shared/slack/",
      },
      {
        identifier: "synthetic-source",
        root: "services/organization-authority/src/quality/synthetic-meeting-fixture-v1.ts",
      },
      {
        identifier: "openrouter",
        root: "services/organization-authority/src/composition/*openrouter*.ts",
      },
      {
        identifier: "slack",
        root: "services/organization-authority/src/composition/*slack*.ts",
      },
      {
        identifier: "synthetic-source",
        root: "services/organization-authority/src/composition/synthetic-meeting-quality-cli.ts",
      },
    ]));

    const probePath =
      "services/organization-authority/src/processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1.ts";
    const probe = join(fixture, probePath);
    const original = readFileSync(probe, "utf8");
    for (const providerIdentifier of [
      "openrouter",
      "openai",
      "anthropic",
      "ollama",
    ]) {
      try {
        writeFileSync(
          probe,
          `${original}\n// ${providerIdentifier} compatibility leak.\n`,
        );
        const result = runBoundary(fixture);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout + result.stderr).toContain(
          `provider identifier '${providerIdentifier}' leaked into provider-neutral module: ${probePath}`,
        );
      } finally {
        writeFileSync(probe, original);
      }
    }

    for (const registeredProvider of product.adapter_architecture
      .provider_identifier_registry) {
      const sourceEvidence = registeredProvider.source_evidence_paths;
      try {
        registeredProvider.source_evidence_paths = [
          `services/organization-authority/src/composition/missing-${registeredProvider.identifier}-provider.ts`,
        ];
        writeFixtureJson(fixture, "product/source-boundary.v1.json", product);
        const result = runBoundary(fixture);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout + result.stderr).toContain(
          `adapter architecture provider '${registeredProvider.identifier}' source evidence path matches no source file`,
        );
      } finally {
        registeredProvider.source_evidence_paths = sourceEvidence;
        writeFixtureJson(fixture, "product/source-boundary.v1.json", product);
      }
    }

    const authority = readFixtureJson<{
      layer_rules: Array<Record<string, unknown>>;
    }>(fixture, "services/organization-authority/source-boundary.v1.json");
    authority.layer_rules.push({
      name: "test-fixture-provider-adapter",
      from: "services/organization-authority/src/processing/adapters/delivery-surfaces/fixture-provider/**",
      allowed_imports: [],
      allowed_workspace_packages: [],
      allowed_external_packages: [],
      allowed_node_builtins: [],
    });
    writeFixtureJson(
      fixture,
      "services/organization-authority/source-boundary.v1.json",
      authority,
    );
    const fixtureProvider = join(
      fixture,
      "services/organization-authority/src/processing/adapters/delivery-surfaces/fixture-provider/client.ts",
    );
    mkdirSync(dirname(fixtureProvider), { recursive: true });
    writeFileSync(fixtureProvider, "export const fixtureProvider = true;\n");
    let result = runBoundary(fixture);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "provider/adapter source is not covered by declared provider_adapter_roots: services/organization-authority/src/processing/adapters/delivery-surfaces/fixture-provider/client.ts",
    );

    product.adapter_architecture.provider_adapter_roots.push({
      identifier: "fixture-provider",
      root: "services/organization-authority/src/processing/adapters/delivery-surfaces/fixture-provider/",
    });
    writeFixtureJson(fixture, "product/source-boundary.v1.json", product);
    try {
      writeFileSync(probe, `${original}\n// fixture-provider compatibility leak.\n`);
      result = runBoundary(fixture);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `provider identifier 'fixture-provider' leaked into provider-neutral module: ${probePath}`,
      );
    } finally {
      writeFileSync(probe, original);
    }

    const newClient = join(
      fixture,
      "services/organization-authority/src/processing/adapters/decision-processors/llm/unregistered-client.ts",
    );
    try {
      writeFileSync(
        newClient,
        [
          'import type { LlmProviderClient, StructuredGenerationRequest, StructuredGenerationResult } from "./llm-provider.js";',
          'export class UnregisteredClient {',
          '  get provider() { return "unregistered" as unknown as LlmProviderClient["provider"]; }',
          '  async generateStructured(_request: StructuredGenerationRequest): Promise<StructuredGenerationResult> { throw new Error("fixture"); }',
          '  async verifyModel(_model: string): Promise<void> {}',
          '}',
          '',
        ].join('\n'),
      );
      const result = runBoundary(fixture);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "LLM provider declarations must exactly match LLM_PROVIDER_IDS",
      );
    } finally {
      rmSync(newClient, { force: true });
    }

    try {
      writeFileSync(
        newClient,
        [
          'import type { LlmProviderClient as Client, StructuredGenerationRequest, StructuredGenerationResult } from "./llm-provider.js";',
          'export class UnregisteredClient implements Client {',
          '  async generateStructured(_request: StructuredGenerationRequest): Promise<StructuredGenerationResult> { throw new Error("fixture"); }',
          '  async verifyModel(_model: string): Promise<void> {}',
          '}',
          '',
        ].join('\n'),
      );
      const result = runBoundary(fixture);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "LLM provider client 'UnregisteredClient'",
      );
    } finally {
      rmSync(newClient, { force: true });
    }
  });

  it("rejects direct and transitive neutral-module reachability into declared provider roots", () => {
    const fixture = fixtureRepository();
    const neutralPath =
      "services/organization-authority/src/composition/organization-authority-runtime.ts";
    const neutral = join(fixture, neutralPath);
    const original = readFileSync(neutral, "utf8");
    const providerPath =
      "services/organization-authority/src/processing/adapters/meeting-sources/granola/index.ts";
    try {
      writeFileSync(
        neutral,
        `${original}\nimport \"../processing/adapters/meeting-sources/granola/index.js\";\n`,
      );
      let result = runBoundary(fixture);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `provider-neutral module reaches declared provider/adapter root 'granola': ${neutralPath} -> ${providerPath}`,
      );

      writeFileSync(neutral, original);
      const intermediaryPath =
        "services/organization-authority/src/composition/provider-reach-probe.ts";
      writeFileSync(
        join(fixture, intermediaryPath),
        'import "../processing/adapters/meeting-sources/granola/index.js";\n',
      );
      writeFileSync(
        neutral,
        `${original}\nimport \"./provider-reach-probe.js\";\n`,
      );
      result = runBoundary(fixture);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `provider-neutral module reaches declared provider/adapter root 'granola': ${neutralPath} -> ${providerPath}`,
      );
    } finally {
      writeFileSync(neutral, original);
    }
  });

  it("rejects a bland three-hop bridge from a neutral root into provider composition", () => {
    const fixture = fixtureRepository();
    const neutralPath =
      "services/organization-authority/src/composition/organization-authority-runtime.ts";
    const neutral = join(fixture, neutralPath);
    const original = readFileSync(neutral, "utf8");
    const firstBridge = "services/organization-authority/src/composition/bland-bridge-one.ts";
    const secondBridge = "services/organization-authority/src/composition/bland-bridge-two.ts";
    try {
      writeFileSync(join(fixture, secondBridge), 'import "./private-slack-approval-interaction-protocol-v1.js";\n');
      writeFileSync(join(fixture, firstBridge), 'import "./bland-bridge-two.js";\n');
      writeFileSync(neutral, `${original}\nimport "./bland-bridge-one.js";\n`);
      const result = runBoundary(fixture);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `provider-neutral module reaches declared provider/adapter root 'slack': ${neutralPath} -> services/organization-authority/src/composition/private-slack-approval-interaction-protocol-v1.ts`,
      );
    } finally {
      writeFileSync(neutral, original);
    }
  });

  it("rejects Authority composition imports into processing core", () => {
    const fixture = fixtureRepository();
    const compositionPath = join(
      fixture,
      "services/organization-authority/src/composition/organization-authority-setup-cli.ts",
    );
    writeFileSync(
      compositionPath,
      `${readFileSync(compositionPath, "utf8")}\nexport * from '../processing/core/index.js';\n`,
    );

    const result = runBoundary(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "@echo-brain/organization-authority: layer rule 'authority-composition-may-wire-pre-processing-layers' rejects edge: services/organization-authority/src/composition/organization-authority-setup-cli.ts -> services/organization-authority/src/processing/core/index.ts",
    );
  });

  it("enforces every Authority processing layer against domain imports", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "services/organization-authority/source-boundary.v1.json";
    const domainErrors = "services/organization-authority/src/domain/errors.ts";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    const processingRules = manifest.layer_rules.filter((rule) =>
      rule.name.startsWith("processing-"),
    );

    expect(processingRules.length).toBeGreaterThan(0);
    expect(existsSync(join(fixture, domainErrors))).toBe(true);

    // Mirror tools/lib/repository-files.mjs so a dead glob cannot pass by
    // selecting a path the checker itself never scans.
    const listed = spawnSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: fixture, encoding: "buffer" },
    );
    expect(listed.status, listed.stderr?.toString("utf8")).toBe(0);
    const sourcePaths = listed.stdout
      .toString("utf8")
      .split("\0")
      .filter(
        (path) =>
          path !== "" &&
          /\.(?:[cm]?[jt]sx?)$/.test(path) &&
          existsSync(join(fixture, path)) &&
          lstatSync(join(fixture, path)).isFile(),
      )
      .sort();

    const probes = processingRules.map((rule) => {
      const sourcePath = sourcePaths.find((path) =>
        matchesGlob(path, rule.from),
      );
      if (sourcePath === undefined) {
        throw new Error(
          `processing layer rule '${rule.name}' matches no real source`,
        );
      }
      return { rule, sourcePath };
    });

    // The clean checker rejects overlapping rules; keep each mutation and
    // restoration unambiguous if the manifest ever regresses.
    expect(new Set(probes.map(({ sourcePath }) => sourcePath)).size).toBe(
      probes.length,
    );

    const baseline = runBoundary(fixture);
    expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);

    for (const { rule, sourcePath } of probes) {
      const absolutePath = join(fixture, sourcePath);
      const original = readFileSync(absolutePath, "utf8");
      const relativeTarget = posix
        .relative(posix.dirname(sourcePath), domainErrors)
        .replace(/\.ts$/, ".js");
      const specifier = relativeTarget.startsWith(".")
        ? relativeTarget
        : `./${relativeTarget}`;

      try {
        writeFileSync(
          absolutePath,
          `${original}${original.endsWith("\n") ? "" : "\n"}import '${specifier}';\n`,
        );
        const result = runBoundary(fixture);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        const report = JSON.parse(result.stdout) as { errors: string[] };
        expect(report.errors, rule.name).toEqual([
          `@echo-brain/organization-authority: layer rule '${rule.name}' rejects edge: ${sourcePath} -> ${domainErrors}`,
        ]);
      } finally {
        writeFileSync(absolutePath, original);
      }
    }

    const restored = runBoundary(fixture);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
  });

  it("applies builtin and external allowlists at the matching layer", () => {
    const fixture = fixtureRepository();
    const manifestPath =
      "services/organization-authority/source-boundary.v1.json";
    const manifest = readFixtureJson<BoundaryManifest>(fixture, manifestPath);
    manifest.allowed_node_builtins = ["process"];
    manifest.allowed_external_packages = ["ajv"];
    writeFixtureJson(fixture, manifestPath, manifest);
    const packagePath = "services/organization-authority/package.json";
    const packageJson = readFixtureJson<{
      dependencies: Record<string, string>;
    }>(fixture, packagePath);
    packageJson.dependencies.ajv = "8.17.1";
    writeFixtureJson(fixture, packagePath, packageJson);
    writeFileSync(
      join(fixture, "services/organization-authority/src/domain/probe.ts"),
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
      "layer rule 'authority-domain-is-pure' rejects Node builtin node:process",
    );
    expect(result.stdout + result.stderr).toContain(
      "layer rule 'authority-domain-is-pure' rejects external import ajv",
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
