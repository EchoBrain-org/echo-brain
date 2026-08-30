import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
// These are the actual Layer 1 through Layer 3 read/search modules. Deliberately
// exclude the Person runtime composition root: it may compose Layer 4, but must
// not make the lower-layer read/search closures model-aware.
const LAYER1_3_READ_SEARCH_ROOTS = [
  "services/organization-record/src/retrieve",
  "services/organization-retrieval/src",
  "services/organization-authority/src/application/readable-search-authorization-fence.ts",
  "services/organization-authority/src/composition/person-record-read-route.ts",
  "services/organization-authority/src/composition/person-record-search-route.ts",
  "services/organization-authority/src/presentation/person-record-read-http-application.ts",
  "services/organization-authority/src/presentation/person-record-search-http-application.ts",
] as const;
const ANSWER_COMPOSITION_ROOT =
  "services/organization-authority/src/answer-composition";
const ANSWER_COMPOSITION_ROUTE =
  "services/organization-authority/src/composition/person-answer-route.ts";
const ANSWER_COMPOSITION_AUDIT_WRITER =
  "services/organization-authority/src/adapters/persistence/sqlite/person-answer-composition-audit-v1.ts";
/** Composition roots may select an answer-composition runtime, but never inspect its implementation. */
const ANSWER_COMPOSITION_WIRING_ROOTS = new Set([
  "services/organization-authority/src/composition/clean-live-cli.ts",
  "services/organization-authority/src/composition/organization-authority-api-runtime.ts",
  "services/organization-authority/src/composition/organization-authority-composition-root.ts",
  "services/organization-authority/src/composition/organization-authority-runtime.ts",
]);
const MODEL_IMPORT =
  /(?:anthropic|openai|openrouter|ollama|processing\/adapters\/decision-processors\/llm)/;
const DIRECT_LOWER_LAYER_IMPORT =
  /(?:@echo-brain\/organization-(?:record|retrieval)|better-sqlite3|(?:^|\/)(?:record|retrieval|storage)(?:\/|$))/;
const EXCLUDED_LAYER4_PATH =
  /(?:^|\/)(?:agents?|tools?|memory|iterations?|vector|hybrid|rerank(?:ing)?|streaming)(?:[\/_\-.]|$)/i;

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

function filesIfPresent(root: string): string[] {
  return existsSync(join(REPO, root)) ? files(root) : [];
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
  roots: readonly string[] = LAYER1_3_READ_SEARCH_ROOTS,
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

function directLayer4LowerLayerEdges(): readonly string[] {
  return [...filesIfPresent(ANSWER_COMPOSITION_ROOT), ANSWER_COMPOSITION_ROUTE]
    .flatMap((importer) =>
      runtimeModuleReferences(importer).flatMap(({ specifier }) => {
        if (specifier === undefined) return [`${importer} -> non-static import`];
        const resolved = specifier.startsWith(".")
          ? resolveRelative(importer, specifier)
          : undefined;
        return DIRECT_LOWER_LAYER_IMPORT.test(specifier) ||
            (resolved !== undefined && DIRECT_LOWER_LAYER_IMPORT.test(resolved))
          ? [`${importer} -> ${specifier}`]
          : [];
      }),
    )
    .sort();
}

describe("retrieval and answer-composition boundaries", () => {
  it("keeps every Layer 1 through Layer 3 read/search import path independent from LLM processors and model SDKs", () => {
    expect(reachableModelEdges()).toEqual([]);
  });

  it("follows runtime re-exports, import(), and require() when checking the Layer 3 closure", () => {
    expect(
      reachableModelEdges([
        "tests/fixtures/retrieval-answer-composition-boundary/re-export.ts",
        "tests/fixtures/retrieval-answer-composition-boundary/dynamic-import.ts",
        "tests/fixtures/retrieval-answer-composition-boundary/require.ts",
      ]),
    ).toEqual([
      "tests/fixtures/retrieval-answer-composition-boundary/dynamic-import.ts -> ./openai-adapter.js",
      "tests/fixtures/retrieval-answer-composition-boundary/re-export.ts -> ./openai-adapter.js",
      "tests/fixtures/retrieval-answer-composition-boundary/require.ts -> ./openai-adapter.js",
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

  it("keeps answer composition confined to its component, audit writer, and declared runtime wiring", () => {
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
      production.filter(
        (path) =>
          /answer_composition/.test(source(path)) &&
          !path.startsWith(`${ANSWER_COMPOSITION_ROOT}/`) &&
          path !== ANSWER_COMPOSITION_AUDIT_WRITER &&
          !ANSWER_COMPOSITION_WIRING_ROOTS.has(path),
      ),
    ).toEqual([]);
  });

  it("keeps the persisted answer_composition audit kind in the audit writer", () => {
    expect(source(ANSWER_COMPOSITION_AUDIT_WRITER)).toContain(
      'context_kind: "answer_composition"',
    );
  });

  it("keeps Layer 4 from directly importing Layer 1, Layer 2, or storage", () => {
    expect(directLayer4LowerLayerEdges()).toEqual([]);
  });

  it("keeps excluded agent, tool, memory, iterative retrieval, hybrid retrieval, reranking, and streaming paths absent from Layer 4", () => {
    const layer4 = filesIfPresent(ANSWER_COMPOSITION_ROOT);
    expect(layer4.filter((path) => EXCLUDED_LAYER4_PATH.test(path))).toEqual([]);
    expect(
      layer4.filter((path) => /(?:ReadableStream|text\/event-stream|stream\s*:\s*true)/.test(source(path))),
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
