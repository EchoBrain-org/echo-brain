#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '../..');
const SCHEMA_PATH = joinRoot('schemas/product/qualification-report.v1.schema.json');
const MATRIX_PATH = joinRoot('schemas/product/qualification-matrix.v1.json');

function joinRoot(path) {
  return resolve(REPO_ROOT, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function samePlatform(left, right) {
  return (
    left?.os === right?.os &&
    left?.architecture === right?.architecture &&
    left?.node === right?.node
  );
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pointerGet(document, pointer) {
  if (!pointer.startsWith('#/')) throw new Error(`unsupported schema reference: ${pointer}`);
  return pointer
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], document);
}

function jsonTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return plainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateSchemaValue(value, rule, root, path, errors) {
  if (rule.$ref !== undefined) {
    const referenced = pointerGet(root, rule.$ref);
    if (referenced === undefined) throw new Error(`unresolved schema reference: ${rule.$ref}`);
    validateSchemaValue(value, referenced, root, path, errors);
    return;
  }
  if (rule.oneOf !== undefined) {
    const variants = rule.oneOf.filter((variant) => {
      const variantErrors = [];
      validateSchemaValue(value, variant, root, path, variantErrors);
      return variantErrors.length === 0;
    });
    if (variants.length !== 1) errors.push(`${path} must match exactly one schema variant`);
    return;
  }
  if (rule.type !== undefined && !jsonTypeMatches(value, rule.type)) {
    errors.push(`${path} must be ${rule.type}`);
    return;
  }
  if (rule.const !== undefined && value !== rule.const) {
    errors.push(`${path} must be equal to constant`);
  }
  if (rule.enum !== undefined && !rule.enum.includes(value)) {
    errors.push(`${path} must be equal to one of the allowed values`);
  }
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      errors.push(`${path} must NOT have fewer than ${rule.minLength} characters`);
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, 'u').test(value)) {
      errors.push(`${path} must match pattern ${rule.pattern}`);
    }
  }
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) {
    errors.push(`${path} must be >= ${rule.minimum}`);
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) {
      errors.push(`${path} must NOT have fewer than ${rule.minItems} items`);
    }
    if (rule.maxItems !== undefined && value.length > rule.maxItems) {
      errors.push(`${path} must NOT have more than ${rule.maxItems} items`);
    }
    if (rule.uniqueItems === true) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${path} must NOT have duplicate items`);
      }
    }
    if (rule.items !== undefined) {
      value.forEach((item, index) =>
        validateSchemaValue(item, rule.items, root, `${path}/${index}`, errors),
      );
    }
  }
  if (plainObject(value)) {
    for (const key of rule.required ?? []) {
      if (!(key in value)) errors.push(`${path} must have required property '${key}'`);
    }
    const properties = rule.properties ?? {};
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path} must NOT have additional property '${key}'`);
      }
    }
    for (const [key, propertyRule] of Object.entries(properties)) {
      if (key in value) {
        validateSchemaValue(value[key], propertyRule, root, `${path}/${key}`, errors);
      }
    }
  }
}

function schemaShapeErrors(report, schema) {
  const errors = [];
  validateSchemaValue(report, schema, schema, '', errors);
  return errors;
}

export function validateQualificationReport(report, options = {}) {
  const schema = readJson(options.schemaPath ?? SCHEMA_PATH);
  const errors = schemaShapeErrors(report, schema);
  if (errors.length > 0) {
    return { ok: false, errors: errors.sort() };
  }

  if (
    report.report_kind !== 'ci-draft' ||
    report.maturity !== 'DEV' ||
    report.result !== 'incomplete' ||
    report.reviewed_qualification_sha !== null
  ) {
    errors.push(
      'this DEV validator rejects release authority until authenticated founder/reviewer evidence sealing is implemented',
    );
  }

  const matrix = readJson(options.matrixPath ?? MATRIX_PATH);
  const definitions = new Map(matrix.cells.map((cell) => [cell.id, cell]));
  const byId = new Map();
  for (const cell of report.cells) {
    if (byId.has(cell.id)) errors.push(`duplicate matrix cell: ${cell.id}`);
    byId.set(cell.id, cell);
    const definition = definitions.get(cell.id);
    if (definition === undefined) {
      errors.push(`unknown matrix cell: ${cell.id}`);
      continue;
    }
    if (cell.authority !== definition.authority) {
      errors.push(
        `${cell.id}: authority must be ${definition.authority}, received ${cell.authority}`,
      );
    }
    if (cell.status === 'pass' && cell.evidence_refs.length === 0) {
      errors.push(`${cell.id}: passing cells require evidence`);
    }
    if (cell.status !== 'pass' && cell.reason === undefined) {
      errors.push(`${cell.id}: non-passing cells require a reason`);
    }
    if (cell.status === 'not_applicable') {
      if (!definition.not_applicable) {
        errors.push(`${cell.id}: not_applicable is forbidden`);
      } else {
        const approvals = cell.not_applicable_approvals ?? [];
        const authorities = new Set(approvals.map((approval) => approval.authority));
        if (!authorities.has('founder') || !authorities.has('independent-reviewer')) {
          errors.push(
            `${cell.id}: not_applicable requires founder and independent-reviewer rationale`,
          );
        }
      }
    }
    if (cell.authority !== 'machine' && cell.status === 'pass') {
      if (report.report_kind === 'ci-draft') {
        errors.push(`${cell.id}: CI drafts cannot pass human-authority cells`);
      }
      const attestation = cell.attestation;
      if (attestation === undefined || attestation.authority !== cell.authority) {
        errors.push(`${cell.id}: human pass requires a matching attestation`);
      } else if (
        attestation.binding.source_sha !== report.source_sha ||
        attestation.binding.artifact_version !== report.artifact.version ||
        attestation.binding.artifact_sha256 !== report.artifact.sha256
      ) {
        errors.push(`${cell.id}: human attestation identity mismatch`);
      }
    }
  }
  for (const definition of matrix.cells) {
    if (!byId.has(definition.id)) errors.push(`missing mandatory matrix cell: ${definition.id}`);
  }

  if (report.unexpected_skip_count !== 0) {
    errors.push(`unexpected_skip_count must be zero, received ${report.unexpected_skip_count}`);
  }
  if (report.ci.source_sha !== report.source_sha) {
    errors.push('CI/source identity mismatch');
  }
  if (report.ci.artifact_sha256 !== report.artifact.sha256) {
    errors.push('CI/artifact identity mismatch');
  }

  if (options.artifactManifestPath !== undefined) {
    const artifactManifestPath = resolve(options.artifactManifestPath);
    const artifactManifest = readJson(artifactManifestPath);
    if (sha256File(artifactManifestPath) !== report.artifact.manifest_sha256) {
      errors.push('artifact-manifest hash mismatch');
    }
    if (artifactManifest.source_sha !== report.source_sha) {
      errors.push('artifact-manifest/source identity mismatch');
    }
    if (artifactManifest.version !== report.artifact.version) {
      errors.push('artifact-manifest/version identity mismatch');
    }
    if (artifactManifest.artifact?.sha256 !== report.artifact.sha256) {
      errors.push('artifact-manifest/artifact identity mismatch');
    }
    if (artifactManifest.dependency_lock_sha256 !== report.artifact.dependency_lock_sha256) {
      errors.push('artifact-manifest/dependency-lock identity mismatch');
    }
    if (
      artifactManifest.product_boundary_version !== report.product_boundary_version ||
      !samePlatform(artifactManifest.declared_platform, report.declared_platform)
    ) {
      errors.push('artifact-manifest/product-boundary identity mismatch');
    }
  }

  if (report.result === 'qualified') {
    if (
      report.report_kind !== 'qualified-release' ||
      report.maturity !== 'QUALIFIED' ||
      report.reviewed_qualification_sha === null
    ) {
      errors.push('qualified result requires a reviewed QUALIFIED release record');
    }
    for (const definition of matrix.cells) {
      const cell = byId.get(definition.id);
      if (
        cell !== undefined &&
        cell.status !== 'pass' &&
        !(cell.status === 'not_applicable' && definition.not_applicable)
      ) {
        errors.push(`qualified result has a non-green cell: ${definition.id}`);
      }
    }
  }

  return { ok: errors.length === 0, errors: errors.sort() };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--report', '--artifact-manifest', '--schema', '--matrix'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  if (!isAbsolute(args.report ?? '')) throw new Error('--report must be absolute');
  if (args['artifact-manifest'] !== undefined && !isAbsolute(args['artifact-manifest'])) {
    throw new Error('--artifact-manifest must be absolute');
  }
  for (const flag of ['schema', 'matrix']) {
    if (args[flag] !== undefined && !isAbsolute(args[flag])) {
      throw new Error(`--${flag} must be absolute`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validateQualificationReport(readJson(args.report), {
    artifactManifestPath: args['artifact-manifest'],
    schemaPath: args.schema,
    matrixPath: args.matrix,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`validate-qualification: ${error.message}\n`);
    process.exitCode = 1;
  }
}
