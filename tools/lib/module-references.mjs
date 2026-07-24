import ts from 'typescript';

// Module loaders are refused outright rather than tracked.
//
// A loader (`require`, or a `createRequire` result) is a *value*: it can be
// renamed, stored in a container, returned from a function, and called far from
// where it was made. Deciding what such a value loads is a data-flow problem,
// and the previous name-following approach could always be walked around by
// storing the loader somewhere it did not look. Nothing in this repository uses
// a loader — every module is reached by a static import or `import()`, both of
// which are syntax and cannot be disguised — so naming one is the violation and
// there is nothing left to follow.
const LOADER_NAMES = new Set(['require', 'createRequire']);

// Positions whose `name` is a member name: it labels a property inside a
// container's member list and is never evaluated as a value, so a loader word
// appearing there is not a loader. Callers must guard on `parent.name === node`,
// which is what keeps computed names out: in `{ [require]: 1 }` the
// identifier's parent is the ComputedPropertyName, so it never matches and
// stays flagged — correctly, because there it *is* evaluated.
const MEMBER_NAME_PARENT_KINDS = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.EnumMember,
]);

export function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

// A member name, or a name that introduces a binding of its own. Applies to
// `require` only: a package.json exports map is naturally modelled as
// `{ require: string }`, and reading it back as `entry.require` is ordinary
// code. `createRequire` gets no such latitude — see isLoaderReference.
function isRequireNamePosition(node) {
  const parent = node.parent;
  return (
    (MEMBER_NAME_PARENT_KINDS.has(parent.kind) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) &&
      (parent.name === node || parent.propertyName === node)) ||
    ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
      parent.name === node)
  );
}

// `createRequire` is only ever exempt as a declaration-only member name. Every
// other position is refused, and that single asymmetry is what closes the
// import surface without any tracking: `import { createRequire }` and
// `import { createRequire as make }` are refused at the specifier, and
// `Module.createRequire(...)` — however the namespace was obtained — is refused
// at the property name.
function isLoaderReference(node) {
  if (!ts.isIdentifier(node) || !LOADER_NAMES.has(node.text)) return false;
  const parent = node.parent;
  if (MEMBER_NAME_PARENT_KINDS.has(parent.kind) && parent.name === node) {
    return false;
  }
  return node.text === 'createRequire' ? true : !isRequireNamePosition(node);
}

export function collectModuleReferences(sourceFile) {
  const references = [];

  function record(node, expression, kind) {
    references.push({
      specifier: literalText(expression),
      kind,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  }

  function visit(node) {
    if (isLoaderReference(node)) {
      record(node, node, 'module-loader');
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      record(node, node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 're-export');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      record(node, node.moduleReference.expression, 'import-equals');
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      record(node, node.arguments[0] ?? node.expression, 'dynamic-import');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}
