#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateQualificationReport } from './validate-qualification.mjs';

// Packaged `selftest` proves installability and SQLite loading only; it
// deliberately reports adapters_loaded=false and wedge_executed=false. Do not
// promote that evidence into product-only-boot, wedge, or operations cells.
const TARGET_CELLS = {
  'clean-install': ['first_install', 'second_install'],
};
const BUILD_CELLS = [
  'product-source-boundary',
  'product-tests',
  'artifact-provenance-machine',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  const args = {};
  const flags = [
    '--draft-report',
    '--target-evidence',
    '--dependency-results',
    '--artifact-manifest',
    '--schema',
    '--matrix',
    '--output',
    '--terminal-output',
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  for (const flag of flags.map((value) => value.slice(2))) {
    if (flag === 'target-evidence') continue;
    if (!isAbsolute(args[flag] ?? ''))
      throw new Error(`--${flag} must be absolute`);
  }
  if (
    args['target-evidence'] !== undefined &&
    !isAbsolute(args['target-evidence'])
  ) {
    throw new Error('--target-evidence must be absolute');
  }
  return args;
}

function setCell(report, id, status, reason, evidenceRefs) {
  const cell = report.cells.find((candidate) => candidate.id === id);
  if (cell === undefined)
    throw new Error(`draft report is missing cell: ${id}`);
  cell.status = status;
  cell.evidence_refs = evidenceRefs;
  if (status === 'pass') delete cell.reason;
  else cell.reason = reason;
}

export function aggregateEvidence({
  draft,
  targetEvidence,
  dependencyResults,
  artifactManifest,
  artifactManifestPath,
  schemaPath,
  matrixPath,
}) {
  const report = structuredClone(draft);
  report.report_kind = 'ci-draft';
  report.maturity = 'DEV';
  report.result = 'incomplete';
  const identityErrors = [];

  if (dependencyResults.target !== 'success' || targetEvidence === null) {
    const reason =
      targetEvidence === null
        ? 'target evidence is missing'
        : `target dependency result is ${dependencyResults.target}`;
    for (const id of Object.keys(TARGET_CELLS)) {
      setCell(report, id, 'fail', reason, ['aggregation:dependency-results']);
    }
  } else {
    for (const [id, requiredStatuses] of Object.entries(TARGET_CELLS)) {
      const passed = requiredStatuses.every(
        (status) => targetEvidence.statuses?.[status] === true,
      );
      setCell(
        report,
        id,
        passed ? 'pass' : 'fail',
        passed
          ? undefined
          : `target evidence is red: ${requiredStatuses.join(', ')}`,
        ['target-evidence:macos-arm64-node-22'],
      );
    }
    report.unexpected_skip_count += targetEvidence.unexpected_skip_count ?? 0;
    const identity = targetEvidence.artifact_identity;
    if (
      identity?.source_sha !== report.source_sha ||
      identity?.version !== report.artifact.version ||
      identity?.sha256 !== report.artifact.sha256
    ) {
      identityErrors.push('target evidence artifact identity mismatch');
      setCell(
        report,
        'artifact-provenance-machine',
        'fail',
        'target evidence artifact identity mismatch',
        ['target-evidence:identity'],
      );
    }
  }

  if (
    artifactManifest.source_sha !== report.source_sha ||
    artifactManifest.version !== report.artifact.version ||
    artifactManifest.artifact.sha256 !== report.artifact.sha256
  ) {
    identityErrors.push('aggregate artifact identity mismatch');
    setCell(
      report,
      'artifact-provenance-machine',
      'fail',
      'aggregate artifact identity mismatch',
      ['aggregation:artifact-manifest'],
    );
  }

  const validation = validateQualificationReport(report, {
    artifactManifestPath,
    schemaPath,
    matrixPath,
  });
  const implementedCells = [...BUILD_CELLS, ...Object.keys(TARGET_CELLS)];
  const redCells = report.cells
    .filter(
      (cell) => implementedCells.includes(cell.id) && cell.status !== 'pass',
    )
    .map((cell) => cell.id)
    .sort();
  const dependencyFailures = Object.entries(dependencyResults)
    .filter(([, status]) => status !== 'success')
    .map(([job, status]) => `${job}:${status}`)
    .sort();
  const terminal = {
    schema_version: 1,
    ok:
      validation.ok &&
      redCells.length === 0 &&
      dependencyFailures.length === 0 &&
      identityErrors.length === 0 &&
      report.unexpected_skip_count === 0,
    red_cells: redCells,
    dependency_failures: dependencyFailures,
    identity_errors: identityErrors.sort(),
    unexpected_skip_count: report.unexpected_skip_count,
    validation_errors: validation.errors,
  };
  return { report, terminal };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetPath = args['target-evidence'];
  const artifactManifestPath = resolve(args['artifact-manifest']);
  const result = aggregateEvidence({
    draft: readJson(resolve(args['draft-report'])),
    targetEvidence:
      targetPath !== undefined && existsSync(targetPath)
        ? readJson(resolve(targetPath))
        : null,
    dependencyResults: readJson(resolve(args['dependency-results'])),
    artifactManifest: readJson(artifactManifestPath),
    artifactManifestPath,
    schemaPath: resolve(args.schema),
    matrixPath: resolve(args.matrix),
  });
  writeFileSync(
    resolve(args.output),
    `${JSON.stringify(result.report, null, 2)}\n`,
  );
  writeFileSync(
    resolve(args['terminal-output']),
    `${JSON.stringify(result.terminal, null, 2)}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`aggregate-evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
