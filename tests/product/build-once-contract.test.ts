import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSanitizedChild } from '../../src/product/spawn-sanitized-child.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const BUILDER = join(REPO_ROOT, 'tools/product/build-artifact.mjs');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'echo-build-once-contract-'));

async function run(
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawnSanitizedChild>[2] = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawnSanitizedChild(command, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', resolveStatus);
  });
  return { status, stdout, stderr };
}

async function headSha(): Promise<string> {
  const result = await run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('Git-object product builder', () => {
  it('rejects a supplied source SHA that is not HEAD before creating output', async () => {
    const outDir = join(temporaryRoot, 'mismatch-output');
    const result = await run(
      process.execPath,
      [
        BUILDER,
        '--version',
        '0.1.0-dev.mismatch',
        '--source-sha',
        '0000000000000000000000000000000000000000',
        '--out-dir',
        outDir,
      ],
      { cwd: REPO_ROOT },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source SHA mismatch');
    expect(existsSync(outDir)).toBe(false);
  });

  it('uses committed bytes after preflight and atomically publishes a new lineage', async () => {
    const outDir = join(temporaryRoot, 'git-object-output');
    const ready = join(temporaryRoot, 'preflight-ready');
    const resume = join(temporaryRoot, 'preflight-continue');
    const closurePath = join(REPO_ROOT, 'src/product/paths.ts');
    const ignoredPath = join(
      REPO_ROOT,
      'src/product/ignored-artifact-sentinel.log',
    );
    const original = readFileSync(closurePath, 'utf8');
    const marker = 'WORKTREE_MUTATION_MUST_NOT_SHIP_132';
    const child = spawnSanitizedChild(
      process.execPath,
      [
        BUILDER,
        '--version',
        '0.1.0-dev.git-objects',
        '--source-sha',
        await headSha(),
        '--out-dir',
        outDir,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          NODE_ENV: 'test',
          PRODUCT_BUILD_TEST_PREFLIGHT_READY_FILE: ready,
          PRODUCT_BUILD_TEST_CONTINUE_FILE: resume,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {
        timeout: 10_000,
      });
      writeFileSync(closurePath, `${original}\n// ${marker}\n`);
      writeFileSync(ignoredPath, `${marker}\n`);
      writeFileSync(resume, 'continue\n');
      const status = await new Promise<number | null>(
        (resolveStatus, reject) => {
          child.once('error', reject);
          child.once('close', resolveStatus);
        },
      );
      expect(status, stderr).toBe(0);
    } finally {
      writeFileSync(closurePath, original);
      rmSync(ignoredPath, { force: true });
    }

    const artifactResult = JSON.parse(stdout) as { artifact: string };
    expect(readdirSync(outDir).sort()).toEqual(
      [
        'artifact-manifest.json',
        artifactResult.artifact,
        `${artifactResult.artifact}.sha256`,
      ].sort(),
    );
    const extracted = join(temporaryRoot, 'git-object-extracted');
    mkdirSync(extracted);
    const unpacked = await run(
      'tar',
      ['-xzf', join(outDir, artifactResult.artifact), '-C', extracted],
      { cwd: temporaryRoot },
    );
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const packageFiles = readdirSync(join(extracted, 'package/dist/product'));
    expect(packageFiles).not.toContain(basename(ignoredPath));
    for (const path of packageFiles.filter((name) => name.endsWith('.js'))) {
      expect(
        readFileSync(join(extracted, 'package/dist/product', path), 'utf8'),
      ).not.toContain(marker);
    }

    const manifest = JSON.parse(
      readFileSync(join(outDir, 'artifact-manifest.json'), 'utf8'),
    ) as {
      source_sha: string;
      package_files: Array<{ path: string }>;
    };
    expect(manifest.source_sha).toBe(await headSha());
    expect(
      manifest.package_files.some((entry) =>
        entry.path.includes('ignored-artifact'),
      ),
    ).toBe(false);

    const overwrite = await run(
      process.execPath,
      [
        BUILDER,
        '--version',
        '0.1.0-dev.git-objects',
        '--source-sha',
        await headSha(),
        '--out-dir',
        outDir,
      ],
      { cwd: REPO_ROOT },
    );
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toContain('--out-dir already exists');
  }, 60_000);
});

describe('qualification workflow build-once and terminal contracts', () => {
  const workflowPath = join(
    REPO_ROOT,
    '.github/workflows/product-qualification.yml',
  );

  it('has one pack producer and no downstream checkout, pack, or rebuild', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow.match(/tools\/product\/build-artifact\.mjs/g)).toHaveLength(
      1,
    );
    expect(workflow).not.toContain('npm pack');
    expect(workflow).toContain('ref: ${{ steps.expected.outputs.sha }}');
    expect(workflow).toContain('${{ github.event.pull_request.head.sha }}');
    const target = workflow
      .split('\n  target:\n')[1]!
      .split('\n  aggregate:\n')[0]!;
    const aggregate = workflow.split('\n  aggregate:\n')[1]!;
    for (const downstream of [target, aggregate]) {
      expect(downstream).not.toContain('actions/checkout@');
      expect(downstream).not.toContain('build-artifact.mjs');
      expect(downstream).not.toContain('npm pack');
    }
    expect(target.indexOf('Verify exact bytes before install')).toBeLessThan(
      target.indexOf('Run the shipped installer'),
    );
    expect(target).toContain('run-target-cell.mjs');
    expect(
      readFileSync(
        join(REPO_ROOT, 'tools/product/prepare-offline-deps.mjs'),
        'utf8',
      ),
    ).toContain("'install-bundle.mjs'");
    expect(
      readFileSync(
        join(REPO_ROOT, 'tools/product/prepare-offline-deps.mjs'),
        'utf8',
      ),
    ).toContain("'install-archive.mjs'");
    expect(
      readFileSync(
        join(REPO_ROOT, 'tools/product/prepare-offline-deps.mjs'),
        'utf8',
      ),
    ).toContain("'install-echo-brain.command'");
  });

  it('keeps evidence uploads always-running and puts the terminal gate last', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    for (const uploadName of [
      'Upload immutable build bundle',
      'Upload immutable target evidence',
      'Upload immutable final DEV report',
    ]) {
      const at = workflow.indexOf(`- name: ${uploadName}`);
      expect(at, uploadName).toBeGreaterThan(-1);
      expect(workflow.slice(at, at + 180), uploadName).toContain(
        'if: always()',
      );
    }
    expect(workflow.indexOf('- name: Final terminal gate')).toBeGreaterThan(
      workflow.indexOf('- name: Upload immutable final DEV report'),
    );
    expect(workflow).not.toMatch(/\b(?:tags|release):/);
  });

  it('uses only standalone repository paths and the authoritative root lock', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const readme = readFileSync(join(REPO_ROOT, 'product/README.md'), 'utf8');
    const builder = readFileSync(
      join(REPO_ROOT, 'tools/product/build-artifact.mjs'),
      'utf8',
    );
    const template = JSON.parse(
      readFileSync(join(REPO_ROOT, 'product/package.template.json'), 'utf8'),
    ) as { files: string[] };
    for (const obsolete of [
      'src/capture/',
      'src/enrich/',
      'src/echo-home/',
      'package-lock.json',
      'tools/install-echo-codex-skills.sh',
      'Project_echo',
    ]) {
      expect(workflow, obsolete).not.toContain(obsolete);
      expect(readme, obsolete).not.toContain(obsolete);
    }
    expect(workflow).toContain("- 'npm-shrinkwrap.json'");
    expect(builder).toContain("join(source, 'npm-shrinkwrap.json')");
    expect(template.files).toEqual(
      expect.arrayContaining([
        'schemas/meeting-context.v1.schema.json',
        'schemas/runtime-config.v1.schema.json',
      ]),
    );
  });

  it('keeps the foundation private, DEV-only, and ordered before later gates', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const readme = readFileSync(join(REPO_ROOT, 'product/README.md'), 'utf8');
    const packageTemplate = JSON.parse(
      readFileSync(join(REPO_ROOT, 'product/package.template.json'), 'utf8'),
    ) as { private: boolean };
    const draftTool = readFileSync(
      join(REPO_ROOT, 'tools/product/create-draft-report.mjs'),
      'utf8',
    );
    const aggregateTool = readFileSync(
      join(REPO_ROOT, 'tools/product/aggregate-evidence.mjs'),
      'utf8',
    );

    expect(packageTemplate.private).toBe(true);
    expect(draftTool).toContain("maturity: 'DEV'");
    expect(draftTool).toContain("result: 'incomplete'");
    expect(aggregateTool).toContain("report.maturity = 'DEV'");
    expect(aggregateTool).toContain("report.result = 'incomplete'");
    expect(workflow).not.toMatch(/^\s+environment:/m);
    expect(workflow).not.toMatch(/\b(?:npm publish|gh release|git tag)\b/);
    for (const excludedTransition of [
      'no tag',
      'GitHub Release',
      'registry publication',
      'protected-environment approval',
      'client installation',
      'real meeting',
      'credential change',
      'release authorization',
    ]) {
      expect(readme, excludedTransition).toContain(excludedTransition);
    }

    const orderedGates = [
      'keep the standalone product boundary',
      'qualify the implemented onboarding',
      'add and drill a managed exact-artifact upgrade',
      'run the exact artifact',
      'complete independent review',
      'install the same bytes',
    ];
    let prior = -1;
    for (const gate of orderedGates) {
      const at = readme.indexOf(gate);
      expect(at, gate).toBeGreaterThan(prior);
      prior = at;
    }
  });

  it('uploads a valid incomplete DEV report but leaves a forced dependency failure red', async () => {
    const fixture = join(temporaryRoot, 'forced-failure');
    mkdirSync(fixture);
    const artifactManifest = join(fixture, 'artifact-manifest.json');
    writeFileSync(
      artifactManifest,
      `${JSON.stringify(
        {
          schema_version: 1,
          source_sha: '1'.repeat(40),
          version: '0.1.0-dev.workflow',
          product_boundary_version: 1,
          declared_platform: {
            os: 'darwin',
            architecture: 'arm64',
            node: '22.22.1',
          },
          dependency_lock_sha256: 'b'.repeat(64),
          artifact: { path: 'echo-brain.tgz', size: 1, sha256: 'a'.repeat(64) },
        },
        null,
        2,
      )}\n`,
    );
    const draft = join(fixture, 'draft.json');
    const created = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'tools/product/create-draft-report.mjs'),
        '--artifact-manifest',
        artifactManifest,
        '--matrix',
        join(REPO_ROOT, 'schemas/product/qualification-matrix.v1.json'),
        '--output',
        draft,
        '--capability-id',
        'team-meeting-to-brief',
        '--spec-id',
        'standalone-product-qualification-v1',
        '--ci-run-id',
        'forced-failure-run',
        '--ci-run-attempt',
        '1',
        '--ci-workflow',
        'product-qualification',
        '--boundary-status',
        'pass',
        '--product-test-status',
        'pass',
        '--unexpected-skip-count',
        '0',
      ],
      { cwd: REPO_ROOT },
    );
    expect(created.status, created.stderr).toBe(0);
    const dependencies = join(fixture, 'dependencies.json');
    writeFileSync(dependencies, '{"build":"success","target":"failure"}\n');
    const finalReport = join(fixture, 'qualification-report.json');
    const terminal = join(fixture, 'terminal-status.json');
    const aggregated = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'tools/product/aggregate-evidence.mjs'),
        '--draft-report',
        draft,
        '--dependency-results',
        dependencies,
        '--artifact-manifest',
        artifactManifest,
        '--schema',
        join(REPO_ROOT, 'schemas/product/qualification-report.v1.schema.json'),
        '--matrix',
        join(REPO_ROOT, 'schemas/product/qualification-matrix.v1.json'),
        '--output',
        finalReport,
        '--terminal-output',
        terminal,
      ],
      { cwd: REPO_ROOT },
    );
    expect(aggregated.status, aggregated.stderr).toBe(0);
    const report = JSON.parse(readFileSync(finalReport, 'utf8')) as {
      maturity: string;
      result: string;
      cells: Array<{ id: string; status: string }>;
    };
    expect(report).toMatchObject({ maturity: 'DEV', result: 'incomplete' });
    expect(
      report.cells.find((cell) => cell.id === 'clean-install'),
    ).toMatchObject({
      status: 'fail',
    });
    for (const unimplemented of [
      'runtime-isolation',
      'state-fresh',
      'state-populated',
      'backup-restore',
      'state-preservation',
      'disable-uninstall-recovery',
      'restoration-health',
    ]) {
      expect(
        report.cells.find((cell) => cell.id === unimplemented),
      ).toMatchObject({
        status: 'pending',
      });
    }
    const terminalResult = JSON.parse(readFileSync(terminal, 'utf8')) as {
      ok: boolean;
      dependency_failures: string[];
      validation_errors: string[];
    };
    expect(terminalResult).toMatchObject({
      ok: false,
      dependency_failures: ['target:failure'],
      validation_errors: [],
    });

    const validated = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'tools/product/validate-qualification.mjs'),
        '--report',
        finalReport,
        '--artifact-manifest',
        artifactManifest,
      ],
      { cwd: REPO_ROOT },
    );
    expect(validated.status, validated.stderr).toBe(0);
    const gated = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'tools/product/terminal-gate.mjs'),
        '--terminal-status',
        terminal,
      ],
      { cwd: REPO_ROOT },
    );
    expect(gated.status).toBe(1);
  });
});
