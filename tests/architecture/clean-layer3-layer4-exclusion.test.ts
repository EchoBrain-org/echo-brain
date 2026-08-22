import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const LAYER3_ROOTS = [
  "services/organization-authority/src/application",
  "services/organization-authority/src/presentation",
  // These are the actual composition roots that bind the L3 HTTP applications
  // to their release implementations. Presentation uses their interfaces only.
  "services/organization-authority/src/composition/clean-person-runtime.ts",
  "services/organization-authority/src/composition/clean-person-record-read-route.ts",
  "services/organization-authority/src/composition/clean-person-record-search-route.ts",
  "services/organization-retrieval/src",
] as const;
const MODEL_IMPORT =
  /(?:anthropic|openai|openrouter|ollama|processing\/adapters\/decision-processors\/llm)/;

function files(root: string): string[] {
  const absolute = join(REPO, root);
  return readdirSync(absolute).flatMap((name) => {
    const path = join(absolute, name);
    const repositoryPath = relative(REPO, path).replaceAll("\\", "/");
    return statSync(path).isDirectory()
      ? files(repositoryPath)
      : path.endsWith(".ts")
        ? [repositoryPath]
        : [];
  });
}

function source(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

function resolveRelative(
  importer: string,
  specifier: string,
): string | undefined {
  const target = posix.normalize(
    posix.join(posix.dirname(importer), specifier),
  );
  return [
    ...(specifier.endsWith(".js") ? [target.slice(0, -3) + ".ts"] : []),
    target,
    `${target}.ts`,
    `${target}.mts`,
    posix.join(target, "index.ts"),
  ].find((candidate) =>
    statSync(join(REPO, candidate), { throwIfNoEntry: false })?.isFile(),
  );
}

type RuntimeModuleReferenceKind =
  | "import"
  | "re-export"
  | "dynamic-import"
  | "require";

interface RuntimeModuleReference {
  readonly kind: RuntimeModuleReferenceKind;
  readonly specifier: string | undefined;
}

function runtimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
    return true;
  }
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function literalSpecifier(expression: ts.Expression | undefined):
  | string
  | undefined {
  if (expression === undefined) return undefined;
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : undefined;
}

function runtimeModuleReferences(
  path: string,
  text = source(path),
): readonly RuntimeModuleReference[] {
  const parsed = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const references: RuntimeModuleReference[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly !== true &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      references.push({ kind: "import", specifier: node.moduleSpecifier.text });
    }
    if (
      ts.isExportDeclaration(node) &&
      runtimeExport(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      references.push({ kind: "re-export", specifier: node.moduleSpecifier.text });
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        references.push({
          kind: "dynamic-import",
          specifier: literalSpecifier(node.arguments[0]),
        });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        references.push({
          kind: "require",
          specifier: literalSpecifier(node.arguments[0]),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return references;
}

function reachableModelEdges(
  roots: readonly string[] = LAYER3_ROOTS,
): readonly string[] {
  const pending = roots.flatMap((root) =>
    root.endsWith(".ts") ? [root] : files(root),
  );
  const visited = new Set<string>();
  const edges: string[] = [];
  while (pending.length > 0) {
    const importer = pending.pop()!;
    if (visited.has(importer)) continue;
    visited.add(importer);
    for (const { kind, specifier } of runtimeModuleReferences(importer)) {
      if (specifier === undefined) {
        // An opaque runtime loader cannot be bounded to the caller's reviewed
        // closure, so it is itself a Layer 4 boundary violation.
        edges.push(`${importer} -> non-static ${kind}`);
        continue;
      }
      const resolved = specifier.startsWith(".")
        ? resolveRelative(importer, specifier)
        : undefined;
      if (
        MODEL_IMPORT.test(specifier) ||
        (resolved !== undefined && MODEL_IMPORT.test(resolved))
      ) {
        edges.push(`${importer} -> ${specifier}`);
      }
      if (resolved !== undefined) pending.push(resolved);
    }
  }
  return edges.sort();
}

describe("clean Layer 3 excludes Layer 4 execution", () => {
  it("keeps every Layer 3-reachable import path independent from LLM processors and model SDKs", () => {
    expect(reachableModelEdges()).toEqual([]);
  });

  it("follows runtime re-exports, import(), and require() when checking the Layer 3 closure", () => {
    expect(
      reachableModelEdges([
        "tests/fixtures/layer3-layer4-exclusion/re-export.ts",
        "tests/fixtures/layer3-layer4-exclusion/dynamic-import.ts",
        "tests/fixtures/layer3-layer4-exclusion/require.ts",
      ]),
    ).toEqual([
      "tests/fixtures/layer3-layer4-exclusion/dynamic-import.ts -> ./openai-adapter.js",
      "tests/fixtures/layer3-layer4-exclusion/re-export.ts -> ./openai-adapter.js",
      "tests/fixtures/layer3-layer4-exclusion/require.ts -> ./openai-adapter.js",
    ]);
  });

  it("rejects opaque runtime loaders rather than letting them evade the closure", () => {
    expect(
      runtimeModuleReferences(
        "opaque-runtime-loader.ts",
        'const name = "openai"; void import(name); require(name);',
      ),
    ).toEqual([
      { kind: "dynamic-import", specifier: undefined },
      { kind: "require", specifier: undefined },
    ]);
  });

  it("has no production TypeScript answer-composition writer or Layer 4 endpoint", () => {
    const production = [
      "services/organization-authority/src",
      "services/organization-control-plane/src",
      "services/organization-record/src",
      "services/organization-retrieval/src",
      "packages/federation-protocol/src",
      "packages/organization-api/src",
      "packages/organization-protocol/src",
      "src/product/person-client",
    ].flatMap(files);
    expect(
      production.filter((path) => /answer_composition/.test(source(path))),
    ).toEqual([]);
    expect(
      production.filter((path) =>
        /(?:layer[-_ ]?4|answer[-_ ]?composition).*(?:route|endpoint|handler)/i.test(
          source(path),
        ),
      ),
    ).toEqual([]);
  });

  it("adds no model or agent dependency to Layer 3 workspaces", () => {
    for (const manifestPath of [
      "services/organization-authority/package.json",
      "services/organization-retrieval/package.json",
    ]) {
      const manifest = JSON.parse(source(manifestPath)) as {
        dependencies?: Record<string, string>;
      };
      expect(
        Object.keys(manifest.dependencies ?? {}).filter((name) =>
          /anthropic|openai|openrouter|ollama|langchain|agent/i.test(name),
        ),
      ).toEqual([]);
    }
  });
});
