import { posix } from 'node:path';
import ts from 'typescript';
import { textFile } from './repository-files.mjs';

// Use TypeScript's alias resolution rather than treating a mixed package barrel
// as either wholly neutral or wholly provider-owned. Build from the worktree,
// not dist: architecture checks run before compilation and include new files.
export function providerModuleGraph(tree, resolveRelative, errors) {
  const exports = new Map();
  const root = JSON.parse(textFile(tree, 'package.json'));
  for (const workspace of Array.isArray(root.workspaces) ? root.workspaces : []) {
    const pkg = JSON.parse(textFile(tree, `${workspace}/package.json`));
    if (!pkg) continue; // The workspace manifest validator reports missing packages.
    const config = JSON.parse(textFile(tree, `${workspace}/tsconfig.json`)) ?? {};
    const output = config.compilerOptions?.outDir ?? 'dist';
    const source = config.compilerOptions?.rootDir ?? 'src';
    const entries = typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports;
    for (const [subpath, value] of Object.entries(entries ?? {})) {
      const target = typeof value === 'string' ? value : value?.import;
      // Public schema/golden-fixture JSON is data, not a module implementation.
      if (typeof target === 'string' && target.endsWith('.json')) continue;
      if (typeof target !== 'string' || !target.startsWith(`./${output}/`) || subpath.includes('*')) {
        errors.push(`provider graph requires a source-resolvable workspace export: ${pkg.name} ${subpath}`);
        continue;
      }
      const emitted = posix.normalize(target);
      const path = `${workspace}/${source}/${emitted.slice(output.length + 1)}`;
      if (resolveRelative(tree, 'package.json', `./${path}`) === null) {
        errors.push(`provider graph workspace export has no source: ${pkg.name} ${subpath}`);
      }
      exports.set(`${pkg.name}${subpath === '.' ? '' : subpath.slice(1)}`, path);
    }
  }
  const resolve = (path, specifier) => {
    if (specifier.startsWith('.')) return resolveRelative(tree, path, specifier);
    const target = exports.get(specifier);
    return target === undefined ? null : resolveRelative(tree, 'package.json', `./${target}`);
  };
  const sources = new Map();
  const options = { noLib: true, types: [], allowJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const host = {
    getSourceFile(path) {
      if (!tree.has(path)) return undefined;
      if (!sources.has(path)) sources.set(path, ts.createSourceFile(path, textFile(tree, path), ts.ScriptTarget.Latest, true));
      return sources.get(path);
    },
    getDefaultLibFileName: () => '',
    writeFile() {},
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: path => tree.has(path),
    readFile: path => textFile(tree, path) ?? undefined,
    getCanonicalFileName: path => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNames: (names, importer) => names.map(name => {
      const path = resolve(importer, name);
      return path === null ? undefined : { resolvedFileName: path, extension: ts.Extension.Ts };
    }),
  };
  const program = ts.createProgram([...tree.keys()].filter(path => /\.[cm]?[jt]sx?$/.test(path) &&
    (path.startsWith('src/') || path.includes('/src/'))), options, host);
  const checker = program.getTypeChecker();
  const cache = new Map();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    const targets = new Set();
    const addDeclaration = value => {
      let symbol = value;
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const declaration of symbol?.declarations ?? []) {
        const target = declaration.getSourceFile().fileName;
        if (target !== path && tree.has(target)) targets.add(target);
      }
    };
    const addSymbol = node => addDeclaration(checker.getSymbolAtLocation(node));
    const addModule = node => {
      const module = checker.getSymbolAtLocation(node);
      if (module) for (const symbol of checker.getExportsOfModule(module)) addDeclaration(symbol);
    };
    const visit = node => {
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) addSymbol(node.name);
      if (ts.isImportClause(node) && node.name) addSymbol(node.name);
      if (ts.isImportTypeNode(node)) {
        if (node.qualifier) addSymbol(node.qualifier);
        else if (ts.isLiteralTypeNode(node.argument)) addModule(node.argument.literal);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        addModule(node.arguments[0]);
      }
      // Namespace and star imports/exports expose the whole module, including
      // provider re-exports hidden behind a declared exception.
      if ((ts.isImportDeclaration(node) && (!node.importClause || ts.isNamespaceImport(node.importClause.namedBindings ?? node))) ||
          (ts.isExportDeclaration(node) && (!node.exportClause || ts.isNamespaceExport(node.exportClause)))) {
        if (node.moduleSpecifier) addModule(node.moduleSpecifier);
      }
      ts.forEachChild(node, visit);
    };
    const source = program.getSourceFile(path);
    if (source) visit(source);
    cache.set(path, targets);
    return targets;
  };
}
