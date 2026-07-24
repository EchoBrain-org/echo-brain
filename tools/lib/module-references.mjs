import ts from 'typescript';

// Positions whose `name` is a member name: it labels a property inside a
// container's member list and is never evaluated as a value, so a tracked
// loader word appearing there is not a module load. Callers must guard on
// `parent.name === node`, which is what keeps computed names out: in
// `{ [require]: 1 }` the identifier's parent is the ComputedPropertyName, so it
// never matches and stays flagged — correctly, because there it *is* evaluated.
//
// ShorthandPropertyAssignment is deliberately absent. `{ require }` desugars to
// `{ require: require }`, so the identifier is simultaneously the member name
// and a live reference to the loader binding; exempting it would let the loader
// escape inside an object literal, which is exactly the hole this rule closes.
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

export function collectModuleReferences(sourceFile) {
  const references = [];
  const createRequireFactories = new Set(['createRequire']);
  const moduleNamespaces = new Set();
  const requireAliases = new Set();

  function isNodeModuleSpecifier(expression) {
    return literalText(expression)?.replace(/^node:/, '') === 'module';
  }

  function isRequireOfNodeModule(expression) {
    return (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'require' &&
      isNodeModuleSpecifier(expression.arguments[0])
    );
  }

  function isCreateRequireFactory(expression) {
    if (ts.isIdentifier(expression)) return createRequireFactories.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'createRequire') {
      return (
        (ts.isIdentifier(expression.expression) &&
          moduleNamespaces.has(expression.expression.text)) ||
        isRequireOfNodeModule(expression.expression)
      );
    }
    if (
      ts.isElementAccessExpression(expression) &&
      literalText(expression.argumentExpression)?.toString() === 'createRequire'
    ) {
      return (
        (ts.isIdentifier(expression.expression) &&
          moduleNamespaces.has(expression.expression.text)) ||
        isRequireOfNodeModule(expression.expression)
      );
    }
    return false;
  }

  function record(node, expression, kind) {
    references.push({
      specifier: literalText(expression),
      kind,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  }

  function isTrackedLoader(node) {
    return (
      ts.isIdentifier(node) &&
      (node.text === 'require' ||
        createRequireFactories.has(node.text) ||
        requireAliases.has(node.text))
    );
  }

  function isDeclarationOrMemberName(node) {
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

  function escapesDirectCallPosition(node) {
    if (!isTrackedLoader(node)) return false;
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return false;
    return !isDeclarationOrMemberName(node);
  }

  function visit(node) {
    if (escapesDirectCallPosition(node)) {
      record(node, node, createRequireFactories.has(node.text) ? 'createRequire' : 'require');
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      record(node, node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 're-export');
      if (
        ts.isImportDeclaration(node) &&
        isNodeModuleSpecifier(node.moduleSpecifier) &&
        node.importClause !== undefined
      ) {
        if (node.importClause.name !== undefined) {
          moduleNamespaces.add(node.importClause.name.text);
        }
        if (node.importClause.namedBindings !== undefined) {
          if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            moduleNamespaces.add(node.importClause.namedBindings.name.text);
          } else {
            for (const element of node.importClause.namedBindings.elements) {
              if ((element.propertyName?.text ?? element.name.text) === 'createRequire') {
                createRequireFactories.add(element.name.text);
              }
            }
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      record(node, node.moduleReference.expression, 'import-equals');
      if (isNodeModuleSpecifier(node.moduleReference.expression)) {
        moduleNamespaces.add(node.name.text);
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name) && isCreateRequireFactory(node.initializer)) {
        createRequireFactories.add(node.name.text);
      }
      if (
        ts.isCallExpression(node.initializer) &&
        isCreateRequireFactory(node.initializer.expression) &&
        ts.isIdentifier(node.name)
      ) {
        requireAliases.add(node.name.text);
      }
      if (isRequireOfNodeModule(node.initializer) && ts.isIdentifier(node.name)) {
        moduleNamespaces.add(node.name.text);
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        (isRequireOfNodeModule(node.initializer) ||
          (ts.isIdentifier(node.initializer) && moduleNamespaces.has(node.initializer.text)))
      ) {
        for (const element of node.name.elements) {
          if (
            (element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile)) ===
            'createRequire'
          ) {
            createRequireFactories.add(element.name.getText(sourceFile));
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node, node.arguments[0] ?? node.expression, 'dynamic-import');
      } else if (
        ts.isCallExpression(node.expression) &&
        isCreateRequireFactory(node.expression.expression)
      ) {
        record(node, node.arguments[0] ?? node.expression, 'createRequire');
      } else if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'require' || requireAliases.has(node.expression.text))
      ) {
        record(
          node,
          node.arguments[0] ?? node.expression,
          requireAliases.has(node.expression.text) ? 'createRequire' : 'require',
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}
