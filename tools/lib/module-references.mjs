import ts from 'typescript';

// Recognizable module-loader capabilities are refused outright rather than
// tracked.
//
// A loader (`require`, or a `createRequire` result) is a *value*: it can be
// renamed, stored in a container, returned from a function, and called far from
// where it was made. Deciding what such a value loads is a data-flow problem,
// and the previous name-following approach could always be walked around by
// storing the loader somewhere it did not look. Repository source does not use
// a loader — every intended edge is a static import or an explicitly permitted
// `import()` — so acquiring a known loader capability is the violation.
//
// This collector is an architecture guard over reviewed source, not a hostile
// JavaScript sandbox: generated code and arbitrarily constructed property names
// are outside its proof boundary. Ceremony callers separately require these
// sources to equal a named Git commit byte-for-byte and hash the reviewed list.
const LOADER_NAMES = new Set([
  'require',
  'module',
  'createRequire',
  'getBuiltinModule',
]);
const REFLECTIVE_LOADER_NAMES = new Set([
  'module',
  'createRequire',
  'getBuiltinModule',
]);
const SAFE_NODE_MODULE_EXPORTS = new Set([
  'builtinModules',
  'isBuiltin',
  'syncBuiltinESMExports',
]);
const REFLECTIVE_PROPERTY_READERS = new Set([
  'get',
  'getOwnPropertyDescriptor',
]);

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

function staticString(node) {
  const literal = literalText(node);
  if (literal !== null) return literal;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  return null;
}

function staticPropertyName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return staticString(node.expression);
  return staticString(node);
}

function importedName(specifier) {
  const name = specifier.propertyName ?? specifier.name;
  return ts.isIdentifier(name) ? name.text : literalText(name);
}

function isNodeModuleSpecifier(node) {
  const specifier = literalText(node);
  return specifier === 'module' || specifier === 'node:module';
}

// `node:module` exposes several loader entry points, not just the export named
// `createRequire` (`Module`, the default export, `_load`, and `runMain` are
// examples). Once the namespace or one of those values is acquired, reflection
// and computed property names can hide how it is used. Refuse that capability
// at the import edge and permit only the small set of non-loading named exports
// used by repository infrastructure.
function exposesNodeModuleLoader(node) {
  if (
    ts.isImportDeclaration(node) &&
    isNodeModuleSpecifier(node.moduleSpecifier)
  ) {
    const clause = node.importClause;
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return false;
    if (clause.name !== undefined) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return false;
    if (ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some(
      (specifier) =>
        !specifier.isTypeOnly &&
        !SAFE_NODE_MODULE_EXPORTS.has(importedName(specifier)),
    );
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    isNodeModuleSpecifier(node.moduleSpecifier)
  ) {
    if (node.isTypeOnly) return false;
    const clause = node.exportClause;
    if (clause === undefined || ts.isNamespaceExport(clause)) return true;
    return clause.elements.some(
      (specifier) =>
        !specifier.isTypeOnly &&
        !SAFE_NODE_MODULE_EXPORTS.has(importedName(specifier)),
    );
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    isNodeModuleSpecifier(node.moduleReference.expression)
  ) {
    return true;
  }
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments[0] !== undefined &&
    isNodeModuleSpecifier(node.arguments[0])
  );
}

function readsLoaderNameReflectively(node) {
  if (
    (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
    REFLECTIVE_LOADER_NAMES.has(importedName(node))
  ) {
    return true;
  }
  if (
    ts.isBindingElement(node) &&
    node.propertyName !== undefined &&
    REFLECTIVE_LOADER_NAMES.has(staticPropertyName(node.propertyName))
  ) {
    return true;
  }
  if (
    ts.isPropertyAssignment(node) &&
    isDestructuringAssignmentProperty(node) &&
    REFLECTIVE_LOADER_NAMES.has(staticPropertyName(node.name))
  ) {
    return true;
  }
  if (
    ts.isComputedPropertyName(node) &&
    REFLECTIVE_LOADER_NAMES.has(staticString(node.expression))
  ) {
    return true;
  }
  if (!ts.isCallExpression(node) || node.arguments.length < 2) return false;
  const propertyName = staticString(node.arguments[1]);
  if (!REFLECTIVE_LOADER_NAMES.has(propertyName)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ((callee.expression.getText() === 'Reflect' &&
      REFLECTIVE_PROPERTY_READERS.has(callee.name.text)) ||
      (callee.expression.getText() === 'Object' &&
        callee.name.text === 'getOwnPropertyDescriptor'))
  );
}

function isDestructuringAssignmentProperty(node) {
  let expression = node;
  while (expression.parent !== undefined) {
    const parent = expression.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === expression &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return true;
    }
    if (
      !ts.isObjectLiteralExpression(parent) &&
      !ts.isArrayLiteralExpression(parent) &&
      !ts.isParenthesizedExpression(parent) &&
      !(ts.isPropertyAssignment(parent) && parent.initializer === expression)
    ) {
      return false;
    }
    expression = parent;
  }
  return false;
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

// Loader API names other than `require` are only ever exempt as declaration-only
// member names. Every other position is refused. Literal element access is the
// same operation, so `process['getBuiltinModule'](...)` is refused at the
// element-access expression.
function isLoaderReference(node) {
  if (exposesNodeModuleLoader(node) || readsLoaderNameReflectively(node))
    return true;
  if (
    ts.isElementAccessExpression(node) &&
    REFLECTIVE_LOADER_NAMES.has(staticString(node.argumentExpression))
  ) {
    return true;
  }
  if (!ts.isIdentifier(node) || !LOADER_NAMES.has(node.text)) return false;
  const parent = node.parent;
  if (MEMBER_NAME_PARENT_KINDS.has(parent.kind) && parent.name === node) {
    return false;
  }
  return node.text === 'require' ? !isRequireNamePosition(node) : true;
}

export function collectModuleReferences(sourceFile) {
  const references = [];

  // CommonJS supplies `require` and `module.require` as ambient capabilities,
  // so no token necessarily exists for the collector to follow. The protected
  // source graphs are ESM; refuse unambiguously CommonJS source files instead
  // of claiming their executed-module closure can be proven statically.
  if (/\.(?:cjs|cts)$/.test(sourceFile.fileName)) {
    references.push({
      specifier: null,
      expression: '<CommonJS module scope>',
      kind: 'module-loader',
      line: 1,
    });
  }

  function record(node, expression, kind) {
    references.push({
      specifier: literalText(expression),
      expression: expression.getText(sourceFile),
      kind,
      line:
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1,
    });
  }

  function visit(node) {
    if (
      ts.isTypeNode(node) ||
      (ts.isImportSpecifier(node) && node.isTypeOnly) ||
      (ts.isExportSpecifier(node) && node.isTypeOnly)
    ) {
      return;
    }
    if (isLoaderReference(node)) {
      record(node, node, 'module-loader');
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      record(
        node,
        node.moduleSpecifier,
        ts.isImportDeclaration(node) ? 'import' : 're-export',
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
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
    if (
      (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && node.isTypeOnly) ||
      (ts.isImportEqualsDeclaration(node) && node.isTypeOnly)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}
