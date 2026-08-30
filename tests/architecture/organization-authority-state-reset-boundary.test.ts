import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const CLEAN_ENTRIES = [
  "services/organization-authority/src/clean-reset-main.ts",
  "services/organization-authority/src/clean-person-main.ts",
  "services/organization-authority/src/clean-live-main.ts",
  "services/organization-authority/src/clean-granola-source-main.ts",
  "services/organization-authority/src/clean-founder-main.ts",
  "services/organization-control-plane/src/clean-slack-connect-main.ts",
  "services/organization-control-plane/src/clean-person-slack-approval-activate-main.ts",
  "services/organization-control-plane/src/clean-person-slack-reaction-approval-activate-main.ts",
] as const;

interface WorkspaceExport {
  readonly package_path: string;
  readonly export_path: string;
}

const WORKSPACE_EXPORTS: ReadonlyMap<string, WorkspaceExport> = new Map([
  [
    "@echo-brain/organization-control-plane/organization-control-database-v1",
    {
      package_path: "services/organization-control-plane/package.json",
      export_path: "./organization-control-database-v1",
    },
  ],
  [
    "@echo-brain/organization-control-plane/slack-approval-runtime-v1",
    {
      package_path: "services/organization-control-plane/package.json",
      export_path: "./slack-approval-runtime-v1",
    },
  ],
  [
    "@echo-brain/organization-control-plane/record-visibility-policy-contracts-v1",
    {
      package_path: "services/organization-control-plane/package.json",
      export_path: "./record-visibility-policy-contracts-v1",
    },
  ],
  [
    "@echo-brain/organization-control-plane/slack-external-identity-integration-v1",
    {
      package_path: "services/organization-control-plane/package.json",
      export_path: "./slack-external-identity-integration-v1",
    },
  ],
  [
    "@echo-brain/organization-control-plane/slack-connection-setup-v1",
    {
      package_path: "services/organization-control-plane/package.json",
      export_path: "./slack-connection-setup-v1",
    },
  ],
  [
    "@echo-brain/organization-record/organization-record-runtime-v1",
    {
      package_path: "services/organization-record/package.json",
      export_path: "./organization-record-runtime-v1",
    },
  ],
  [
    "@echo-brain/organization-record/new-lineage-v1",
    {
      package_path: "services/organization-record/package.json",
      export_path: "./new-lineage-v1",
    },
  ],
  [
    "@echo-brain/organization-retrieval/readable-search-runtime-v1",
    {
      package_path: "services/organization-retrieval/package.json",
      export_path: "./readable-search-runtime-v1",
    },
  ],
  [
    "@echo-brain/organization-retrieval/new-lineage-v1",
    {
      package_path: "services/organization-retrieval/package.json",
      export_path: "./new-lineage-v1",
    },
  ],
]);

const ALLOWED_LEAF_IMPORTS = new Set([
  "@echo-brain/federation-protocol",
  "@echo-brain/organization-api",
  "@echo-brain/organization-protocol",
  "better-sqlite3",
  "node:buffer",
  "node:crypto",
  "node:events",
  "node:fs",
  "node:http",
  "node:net",
  "node:path",
  "openid-client",
]);

const FORBIDDEN_SELECTED_MODULES = [
  /(?:^|\/)migrations(?:\/|$)/,
  /(?:^|\/)migrate\.ts$/,
  /(?:^|\/)open-database\.ts$/,
  /(?:^|\/)composition\/operator-state\.ts$/,
  /(?:^|\/)composition\/runtime\.ts$/,
  /(?:^|\/)composition\/activate-meeting-source\.ts$/,
  /(?:^|\/)composition\/server-installation-/,
  /(?:^|\/)adapters\/slack\/slack-integration-provider\.ts$/,
  /(?:^|\/)application\/organization-member-readable-policy\.ts$/,
  /(?:^|\/)application\/reviewer-restricted-policy\.ts$/,
  /(?:^|\/)adapters\/slack\/organization-member-card-grammar\.ts$/,
  /(?:^|\/)adapters\/slack\/reviewer-card-grammar\.ts$/,
] as const;

interface PackageExport {
  readonly import: string;
}

interface PackageManifest {
  readonly exports: Readonly<Record<string, PackageExport>>;
}

function resolveRelative(importer: string, specifier: string): string {
  const target = posix.normalize(
    posix.join(posix.dirname(importer), specifier),
  );
  const candidates = [
    ...(specifier.endsWith(".js") ? [target.slice(0, -3) + ".ts"] : []),
    target,
    `${target}.ts`,
    `${target}.mts`,
    posix.join(target, "index.ts"),
  ];
  const resolved = candidates.find((path) => existsSync(join(REPO, path)));
  if (resolved === undefined) {
    throw new Error(`unresolved clean import ${specifier} from ${importer}`);
  }
  return resolved;
}

function resolveWorkspaceExport(specifier: string): string {
  const workspace = WORKSPACE_EXPORTS.get(specifier);
  if (workspace === undefined)
    throw new Error(`unexpected clean import ${specifier}`);
  const manifest = JSON.parse(
    readFileSync(join(REPO, workspace.package_path), "utf8"),
  ) as PackageManifest;
  const exported = manifest.exports[workspace.export_path]?.import;
  if (exported === undefined || !exported.startsWith("./dist/")) {
    throw new Error(
      `${workspace.package_path} must expose ${workspace.export_path}`,
    );
  }
  const source = join(
    dirname(workspace.package_path),
    "src",
    exported.slice("./dist/".length),
  )
    .replace(/\.js$/, ".ts")
    .replace(/\\/g, "/");
  if (!existsSync(join(REPO, source))) {
    throw new Error(`${specifier} resolves to missing source ${source}`);
  }
  return source;
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (
    node.exportClause === undefined ||
    !ts.isNamedExports(node.exportClause)
  ) {
    return false;
  }
  return node.exportClause.elements.every((element) => element.isTypeOnly);
}

function staticRuntimeModuleSpecifiers(path: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(join(REPO, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly !== true &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(node) &&
      !exportIsTypeOnly(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function cleanClosure(entry: string): ReadonlySet<string> {
  const closure = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const importer = pending.pop()!;
    if (closure.has(importer)) continue;
    closure.add(importer);
    for (const specifier of staticRuntimeModuleSpecifiers(importer)) {
      if (specifier.startsWith(".")) {
        pending.push(resolveRelative(importer, specifier));
      } else if (WORKSPACE_EXPORTS.has(specifier)) {
        pending.push(resolveWorkspaceExport(specifier));
      } else if (!ALLOWED_LEAF_IMPORTS.has(specifier)) {
        throw new Error(
          `unexpected clean entry import ${specifier} from ${importer}`,
        );
      }
    }
  }
  return closure;
}

describe("Organization Authority executable closure boundaries", () => {
  it("uses responsibility-named record and retrieval runtimes with thin legacy shims", () => {
    const compatibilityEntrypoints = [
      [
        "services/organization-record/src/new-lineage-v1.ts",
        'export * from "./organization-record-runtime-v1.js";\n',
      ],
      [
        "services/organization-retrieval/src/new-lineage-v1.ts",
        'export * from "./readable-search-runtime-v1.js";\n',
      ],
    ] as const;
    for (const [path, expected] of compatibilityEntrypoints) {
      expect(readFileSync(join(REPO, path), "utf8")).toBe(
        `/** @deprecated Compatibility entrypoint. Use ${
          path.includes("organization-record")
            ? "organization-record-runtime-v1"
            : "readable-search-runtime-v1"
        }. */\n${expected}`,
      );
    }
  });

  for (const entry of CLEAN_ENTRIES) {
    it(`${entry} excludes retired machine, migration, and reaction-policy runtime`, () => {
      const closure = cleanClosure(entry);
      expect(closure).toContain(entry);
      for (const path of closure) {
        for (const forbidden of FORBIDDEN_SELECTED_MODULES) {
          expect(path, `${entry} reaches forbidden module ${path}`).not.toMatch(
            forbidden,
          );
        }
      }
    });
  }
});
