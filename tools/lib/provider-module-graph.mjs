import { posix } from 'node:path';
import ts from 'typescript';
import { textFile } from './repository-files.mjs';
import { collectModuleReferences } from './module-references.mjs';

/** Whole-module edges, including type imports, side effects, namespaces and re-exports. */
export function providerModuleGraph(tree, resolveRelative, errors) {
  const publicExports = new Map();
  const outputs = [];
  const workspaces = JSON.parse(textFile(tree, 'package.json')).workspaces;
  for (const workspace of workspaces) {
    const pkg = JSON.parse(textFile(tree, `${workspace}/package.json`));
    const config = JSON.parse(textFile(tree, `${workspace}/tsconfig.json`));
    const output = config.compilerOptions?.outDir ?? 'dist';
    const source = config.compilerOptions?.rootDir ?? 'src';
    outputs.push({ source: posix.join(workspace, source), output: posix.join(workspace, output) });
    const entries = typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports;
    for (const [subpath, value] of Object.entries(entries ?? {})) {
      const target = typeof value === 'string' ? value : value?.import;
      if (typeof target !== 'string' || subpath.includes('*') ||
          (typeof value === 'object' && (Object.keys(value).some(key => !['types', 'import'].includes(key)) ||
            value.types !== target.replace(/\.js$/, '.d.ts')))) {
        errors.push(`provider graph requires an explicit workspace export: ${pkg.name} ${subpath}`);
        continue;
      }
      const specifier = `${pkg.name}${subpath === '.' ? '' : subpath.slice(1)}`;
      if (target.endsWith('.json')) {
        const path = posix.join(workspace, target);
        if (!tree.has(path)) errors.push(`workspace asset export has no source: ${specifier}`);
        publicExports.set(specifier, path);
        continue;
      }
      if (!target.startsWith(`./${output}/`)) {
        errors.push(`provider graph requires a source-resolvable workspace export: ${specifier}`);
        continue;
      }
      const path = posix.join(workspace, source, target.slice(output.length + 3));
      const resolved = resolveRelative(tree, 'package.json', `./${path}`);
      if (resolved === null) errors.push(`provider graph workspace export has no source: ${specifier}`);
      else publicExports.set(specifier, resolved);
    }
  }
  const resolve = (path, specifier) => specifier.startsWith('.')
    ? resolveRelative(tree, path, specifier)
    : publicExports.get(specifier) ?? null;
  const cache = new Map();
  const targets = path => {
    if (cache.has(path)) return cache.get(path);
    const source = textFile(tree, path);
    const found = new Set();
    if (source !== null && /\.[cm]?[jt]sx?$/.test(path)) {
      const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const assetReferences = node => {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' &&
            node.arguments?.[1]?.getText(parsed) === 'import.meta.url') {
          const literal = node.arguments[0];
          if (!literal || !ts.isStringLiteral(literal)) errors.push('runtime asset URL must be literal: ' + path);
          else {
            let target = resolve(path, literal.text);
            if (!target) {
              const output = outputs.find(item => path.startsWith(item.source + "/"));
              if (output) {
                const emitted = posix.join(output.output, posix.relative(output.source, path));
                const asset = posix.join(posix.dirname(emitted), literal.text);
                if (tree.has(asset)) target = asset;
              }
            }
            if (target) found.add(target);
            else errors.push('runtime asset has no source: ' + path + ' -> ' + literal.text);
          }
        }
        ts.forEachChild(node, assetReferences);
      };
      assetReferences(parsed);
      for (const reference of collectModuleReferences(parsed, { includeTypeQueries: true })) {
        if (reference.specifier === null) continue; // The workspace loader gate reports this.
        const target = resolve(path, reference.specifier);
        if (target !== null) found.add(target);
      }
    }
    cache.set(path, found);
    return found;
  };
  return { targets, resolve, publicExports };
}
