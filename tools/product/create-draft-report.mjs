#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseArgs(argv) {
  const args = {};
  const flags = [
    '--artifact-manifest',
    '--matrix',
    '--output',
    '--capability-id',
    '--spec-id',
    '--ci-run-id',
    '--ci-run-attempt',
    '--ci-workflow',
    '--boundary-status',
    '--product-test-status',
    '--unexpected-skip-count',
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  for (const flag of ['artifact-manifest', 'matrix', 'output']) {
    if (!isAbsolute(args[flag] ?? '')) throw new Error(`--${flag} must be absolute`);
  }
  for (const flag of flags.slice(3).map((value) => value.slice(2))) {
    if (args[flag] === undefined) throw new Error(`--${flag} is required`);
  }
  for (const flag of ['boundary-status', 'product-test-status']) {
    if (!['pass', 'fail'].includes(args[flag])) throw new Error(`--${flag} must be pass or fail`);
  }
  return args;
}

export function createDraftReport({ artifactManifestPath, matrixPath, inputs }) {
  const artifactManifest = readJson(artifactManifestPath);
  const matrix = readJson(matrixPath);
  const implemented = new Map([
    ['product-source-boundary', inputs.boundaryStatus],
    ['product-tests', inputs.productTestStatus],
    ['artifact-provenance-machine', 'pass'],
  ]);
  const cells = matrix.cells.map((definition) => {
    const status = implemented.get(definition.id);
    if (status !== undefined) {
      return status === 'pass'
        ? {
            id: definition.id,
            authority: definition.authority,
            status: 'pass',
            evidence_refs: [
              definition.id === 'product-tests'
                ? 'build-job:product-test-results'
                : 'build-job:artifact-manifest',
            ],
          }
        : {
            id: definition.id,
            authority: definition.authority,
            status: 'fail',
            evidence_refs: ['build-job:status'],
            reason: `${definition.id} failed in the build job`,
          };
    }
    return {
      id: definition.id,
      authority: definition.authority,
      status: 'pending',
      evidence_refs: [],
      reason:
        definition.authority === 'machine'
          ? 'not implemented or not executed in this rank-1 foundation cell'
          : 'human-authority evidence cannot be supplied by CI',
    };
  });
  return {
    schema_version: 1,
    report_kind: 'ci-draft',
    capability_id: inputs.capabilityId,
    spec_id: inputs.specId,
    product_boundary_version: artifactManifest.product_boundary_version,
    source_sha: artifactManifest.source_sha,
    reviewed_qualification_sha: null,
    artifact: {
      version: artifactManifest.version,
      sha256: artifactManifest.artifact.sha256,
      manifest_sha256: sha256(artifactManifestPath),
      dependency_lock_sha256: artifactManifest.dependency_lock_sha256,
    },
    ci: {
      run_id: inputs.ciRunId,
      run_attempt: Number(inputs.ciRunAttempt),
      workflow: inputs.ciWorkflow,
      source_sha: artifactManifest.source_sha,
      artifact_sha256: artifactManifest.artifact.sha256,
    },
    declared_platform: artifactManifest.declared_platform,
    unexpected_skip_count: Number(inputs.unexpectedSkipCount),
    maturity: 'DEV',
    result: 'incomplete',
    cells,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = createDraftReport({
    artifactManifestPath: resolve(args['artifact-manifest']),
    matrixPath: resolve(args.matrix),
    inputs: {
      capabilityId: args['capability-id'],
      specId: args['spec-id'],
      ciRunId: args['ci-run-id'],
      ciRunAttempt: args['ci-run-attempt'],
      ciWorkflow: args['ci-workflow'],
      boundaryStatus: args['boundary-status'],
      productTestStatus: args['product-test-status'],
      unexpectedSkipCount: args['unexpected-skip-count'],
    },
  });
  writeFileSync(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`create-draft-report: ${error.message}\n`);
    process.exitCode = 1;
  }
}
