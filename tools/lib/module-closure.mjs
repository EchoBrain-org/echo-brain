import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { collectModuleReferences } from './module-references.mjs';

const SOURCE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];

function isRelativeSpecifier(specifier) {
  return (
    specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
  );
}

function toProjectRelative(projectRoot, absolute, context) {
  const rel = relative(projectRoot, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${context}: path escapes the project root`);
  }
  return rel.split(sep).join('/');
}

export function collectExecutedModuleClosure({ projectRoot, entryPoints, readSource }) {
  const root = resolve(projectRoot);
  const read = readSource ?? ((absolute) => readFileSync(absolute, 'utf8'));
  const queue = entryPoints.map((entry) =>
    toProjectRelative(root, resolve(root, entry), `entry point ${entry}`),
  );
  const closure = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (closure.has(current)) continue;
    closure.add(current);
    const absolute = resolve(root, current);
    const sourceFile = ts.createSourceFile(absolute, read(absolute), ts.ScriptTarget.Latest, true);
    for (const reference of collectModuleReferences(sourceFile)) {
      const label = `${current}:${reference.line} (${reference.kind})`;
      if (reference.specifier === null) {
        if (reference.kind === 'require' || reference.kind === 'createRequire') {
          throw new Error(`${label}: escaped module loader is forbidden in ceremony sources`);
        }
        continue;
      }
      if (!isRelativeSpecifier(reference.specifier)) continue;
      const resolvedRelative = toProjectRelative(
        root,
        resolve(dirname(absolute), reference.specifier),
        label,
      );
      if (!SOURCE_EXTENSIONS.some((extension) => resolvedRelative.endsWith(extension))) {
        throw new Error(`${label}: import resolves to an unsupported file: ${resolvedRelative}`);
      }
      queue.push(resolvedRelative);
    }
  }
  return [...closure].sort();
}

export function diffCeremonyAttestation({ projectRoot, entryPoints, attestedSourcePaths, readSource }) {
  const closure = collectExecutedModuleClosure({ projectRoot, entryPoints, readSource });
  const attested = new Set(attestedSourcePaths);
  const closureSet = new Set(closure);
  return {
    closure,
    missing: closure.filter((path) => !attested.has(path)),
    extra: attestedSourcePaths.filter((path) => !closureSet.has(path)),
  };
}

export function assertCeremonyAttestationClosure(options) {
  const { missing, extra } = diffCeremonyAttestation(options);
  if (missing.length === 0 && extra.length === 0) return;
  const parts = [];
  if (missing.length > 0) parts.push(`executed but unattested: ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`attested but never executed: ${extra.join(', ')}`);
  throw new Error(
    `Phase 5 ceremony attestation is out of sync with the driver import closure (${parts.join('; ')})`,
  );
}
