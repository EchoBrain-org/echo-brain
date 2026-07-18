import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSanitizedChild } from '../../src/product/spawn-sanitized-child.js';
import { runToolchainPreflight } from '../../tools/product/toolchain-preflight.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const VERSION = '0.1.0-dev.132';
const temporaryRoot = mkdtempSync(join(tmpdir(), 'echo-packaged-product-'));
let artifactDir: string;
let supportDir: string;
let artifactPath: string;
let artifactManifestPath: string;

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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

beforeAll(async () => {
  const supplied = globalThis.__ECHO_PRODUCT_ARTIFACT_DIR__;
  if (supplied !== undefined) {
    artifactDir = resolve(supplied);
    supportDir = join(dirname(artifactDir), 'qualification-support');
  } else {
    artifactDir = join(temporaryRoot, 'artifact');
    supportDir = join(temporaryRoot, 'qualification-support');
    const prepared = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'tools/product/prepare-offline-deps.mjs'),
        '--out-dir',
        supportDir,
      ],
      { cwd: REPO_ROOT },
    );
    expect(prepared.status, prepared.stderr).toBe(0);
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
    expect(head.status, head.stderr).toBe(0);
    const built = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'tools/product/build-artifact.mjs'),
        '--version',
        VERSION,
        '--source-sha',
        head.stdout.trim(),
        '--out-dir',
        artifactDir,
      ],
      { cwd: REPO_ROOT },
    );
    expect(built.status, built.stderr).toBe(0);
  }

  artifactManifestPath = join(artifactDir, 'artifact-manifest.json');
  const manifest = JSON.parse(readFileSync(artifactManifestPath, 'utf8')) as {
    artifact: { path: string };
  };
  artifactPath = join(artifactDir, manifest.artifact.path);
}, 120_000);

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('product-only artifact', () => {
  it('binds one tarball to its checksum and sorted package manifest', async () => {
    const manifest = JSON.parse(readFileSync(artifactManifestPath, 'utf8')) as {
      source_sha: string;
      version: string;
      artifact: { path: string; size: number; sha256: string };
      package_files: Array<{ path: string; size: number; sha256: string }>;
    };
    expect(
      filesUnder(artifactDir)
        .map((path) => basename(path))
        .sort(),
    ).toEqual(
      [
        'artifact-manifest.json',
        manifest.artifact.path,
        `${manifest.artifact.path}.sha256`,
      ].sort(),
    );
    expect(statSync(artifactPath).size).toBe(manifest.artifact.size);
    expect(sha256(artifactPath)).toBe(manifest.artifact.sha256);
    expect(readFileSync(`${artifactPath}.sha256`, 'utf8')).toBe(
      `${manifest.artifact.sha256}  ${manifest.artifact.path}\n`,
    );
    expect(manifest.package_files.map((entry) => entry.path)).toEqual(
      [...manifest.package_files.map((entry) => entry.path)].sort(),
    );

    const extracted = join(temporaryRoot, 'extracted');
    mkdirSync(extracted);
    const unpacked = await run('tar', ['-xzf', artifactPath, '-C', extracted]);
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const packageRoot = join(extracted, 'package');
    const actualPaths = filesUnder(packageRoot)
      .map((path) => relative(packageRoot, path).split(sep).join('/'))
      .sort();
    expect(actualPaths).toEqual(
      manifest.package_files.map((entry) => entry.path),
    );
    for (const entry of manifest.package_files) {
      const path = join(packageRoot, entry.path);
      expect(statSync(path).size, entry.path).toBe(entry.size);
      expect(sha256(path), entry.path).toBe(entry.sha256);
    }
  });

  it('contains only the fenced product closure and no repository path', () => {
    const manifest = JSON.parse(readFileSync(artifactManifestPath, 'utf8')) as {
      package_files: Array<{ path: string }>;
    };
    const paths = manifest.package_files.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'schemas/meeting-context.v1.schema.json',
        'schemas/runtime-config.v1.schema.json',
        'dist/product/lifecycle-lock.js',
        'dist/product/state-backup.js',
      ]),
    );
    for (const forbidden of [
      'dist/daemon/',
      'dist/mcp/',
      'dist/coord/',
      'dist/trace/',
      'tests/',
      'backlog/',
      'wiki/',
      'raw/',
    ]) {
      expect(
        paths.some((path) => path.startsWith(forbidden)),
        forbidden,
      ).toBe(false);
    }
    const extractedPackage = join(temporaryRoot, 'extracted/package');
    for (const path of filesUnder(extractedPackage)) {
      const content = readFileSync(path);
      if (!content.includes(0))
        expect(content.toString('utf8')).not.toContain(REPO_ROOT);
    }
  });

  it('runs the hashed verification and DEV-draft tools without a checkout', async () => {
    expect(existsSync(join(supportDir, 'install-bundle.mjs'))).toBe(true);
    expect(existsSync(join(supportDir, 'install-archive.mjs'))).toBe(true);
    expect(existsSync(join(supportDir, 'install-echo-brain.command'))).toBe(
      true,
    );
    expect(
      statSync(join(supportDir, 'install-echo-brain.command')).mode & 0o111,
    ).not.toBe(0);
    const verified = await run(
      process.execPath,
      [
        join(supportDir, 'verify-bundle.mjs'),
        '--artifact-dir',
        artifactDir,
        '--support-dir',
        supportDir,
      ],
      { cwd: temporaryRoot },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, errors: [] });

    const draft = join(temporaryRoot, 'standalone-draft.json');
    const created = await run(
      process.execPath,
      [
        join(supportDir, 'create-draft-report.mjs'),
        '--artifact-manifest',
        artifactManifestPath,
        '--matrix',
        join(supportDir, 'schemas/product/qualification-matrix.v1.json'),
        '--output',
        draft,
        '--capability-id',
        'team-meeting-to-brief',
        '--spec-id',
        'standalone-product-qualification-v1',
        '--ci-run-id',
        'standalone-fixture',
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
      { cwd: temporaryRoot },
    );
    expect(created.status, created.stderr).toBe(0);
    const validated = await run(
      process.execPath,
      [
        join(supportDir, 'validate-qualification.mjs'),
        '--report',
        draft,
        '--artifact-manifest',
        artifactManifestPath,
        '--schema',
        join(supportDir, 'schemas/product/qualification-report.v1.schema.json'),
        '--matrix',
        join(supportDir, 'schemas/product/qualification-matrix.v1.json'),
      ],
      { cwd: temporaryRoot },
    );
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toEqual({ ok: true, errors: [] });
  });

  it('installs from the exact cache and runs config validation plus offline selftest', async () => {
    const prefix = join(temporaryRoot, 'installed-prefix');
    const evidence = join(temporaryRoot, 'install-evidence.json');
    const hostileHome = join(temporaryRoot, 'hostile-home');
    mkdirSync(hostileHome, { mode: 0o700 });
    writeFileSync(
      join(hostileHome, '.npmrc'),
      'ignore-scripts=true\nprefix=/tmp/hostile-prefix\nnode-options=--require hostile-module\n',
    );
    const installed = await run(
      process.execPath,
      [
        join(supportDir, 'install-offline.mjs'),
        '--artifact',
        artifactPath,
        '--artifact-manifest',
        artifactManifestPath,
        '--support-dir',
        supportDir,
        '--prefix',
        prefix,
        '--evidence',
        evidence,
      ],
      {
        cwd: temporaryRoot,
        env: {
          HOME: hostileHome,
          npm_config_ignore_scripts: 'true',
          npm_config_prefix: '/tmp/hostile-prefix',
          NODE_PATH: '/tmp/hostile-node-path',
        },
      },
    );
    expect(installed.status, installed.stderr).toBe(0);
    const installEvidence = JSON.parse(readFileSync(evidence, 'utf8')) as {
      ok: boolean;
      npm_invoked: boolean;
      npm_status: number;
      npm_stderr: string;
      preflight: { ok: boolean };
    };
    expect(installEvidence).toMatchObject({
      ok: true,
      npm_invoked: true,
      npm_status: 0,
      preflight: { ok: true },
    });
    expect(installEvidence.npm_stderr).not.toMatch(
      /download|nodejs\.org|header fetch/i,
    );
    expect(existsSync(join(prefix, '.echo-offline-npm-cache'))).toBe(false);
    expect(
      readlinkSync(join(prefix, 'node_modules/.bin/echo-brain')),
    ).toContain('echo-brain/dist/product/cli.js');

    const stateDir = join(temporaryRoot, 'synthetic-state');
    const configPath = join(temporaryRoot, 'runtime-config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          lane: 'team-product',
          state_dir: stateDir,
          meeting_sources: [
            {
              adapter_id: 'granola',
              instance_id: 'primary',
              settings: { page_size: 30 },
            },
          ],
          decision_processor: {
            adapter_id: 'structured-text',
            instance_id: 'primary',
            settings: {},
          },
          communication_channels: [
            {
              adapter_id: 'jsonl-outbox',
              instance_id: 'qualification',
              settings: {
                path: join(stateDir, 'outbox.jsonl'),
                destination_id: 'synthetic-qualification',
              },
            },
          ],
          approval_mode: 'manual',
        },
        null,
        2,
      )}\n`,
    );
    const bin = join(prefix, 'node_modules/.bin/echo-brain');
    const help = await run(bin, ['--help'], { cwd: prefix });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('echo-brain onboard');
    expect(help.stdout).toContain('echo-brain service');
    expect(help.stdout).toContain('echo-brain backup');
    expect(help.stdout).toContain('echo-brain restore');
    const validated = await run(
      bin,
      ['validate-config', '--config', configPath],
      {
        cwd: prefix,
      },
    );
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      ok: true,
      command: 'validate-config',
      lane: 'team-product',
    });
    const selftest = await run(bin, ['selftest', '--config', configPath], {
      cwd: prefix,
    });
    expect(selftest.status, selftest.stderr).toBe(0);
    expect(JSON.parse(selftest.stdout)).toMatchObject({
      ok: true,
      command: 'selftest',
      maturity: 'DEV',
      wedge_executed: false,
      adapters_loaded: false,
      adapter_references: {
        meeting_sources: [{ adapter_id: 'granola', instance_id: 'primary' }],
        decision_processor: {
          adapter_id: 'structured-text',
          instance_id: 'primary',
        },
        communication_channels: [
          { adapter_id: 'jsonl-outbox', instance_id: 'qualification' },
        ],
      },
    });

    const reverified = await run(
      process.execPath,
      [
        join(supportDir, 'verify-bundle.mjs'),
        '--artifact-dir',
        artifactDir,
        '--support-dir',
        supportDir,
      ],
      { cwd: temporaryRoot },
    );
    expect(reverified.status, reverified.stderr).toBe(0);
    expect(JSON.parse(reverified.stdout)).toMatchObject({
      ok: true,
      errors: [],
    });
  }, 120_000);

  it('fails before npm when the target toolchain is unavailable', async () => {
    const result = await run(
      process.execPath,
      [
        join(supportDir, 'install-offline.mjs'),
        '--artifact',
        artifactPath,
        '--artifact-manifest',
        artifactManifestPath,
        '--support-dir',
        supportDir,
        '--prefix',
        join(temporaryRoot, 'preflight-red-prefix'),
      ],
      { cwd: temporaryRoot, env: { PATH: '' } },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      stage: 'toolchain-preflight',
      npm_invoked: false,
    });
  });
});

describe('toolchain preflight fixtures', () => {
  const commands = [
    'python3',
    'make',
    'clang',
    'clang++',
    'xcode-select',
    'xcrun',
    'node',
    'npm',
  ];
  const headerFiles = new Set([
    '/headers/include/node/node.h',
    '/headers/include/node/common.gypi',
    '/headers/include/node/config.gypi',
    '/headers/node-version.txt',
  ]);
  const passing = {
    expectedNode: '22.22.1',
    expectedNpm: '10.9.4',
    nodedir: '/headers',
    which: (command: string) => `/bin/${command}`,
    run: (command: string) => ({
      status: 0,
      stdout: command.endsWith('/npm') ? '10.9.4\n' : 'fixture-version\n',
      stderr: '',
    }),
    exists: (path: string) => headerFiles.has(path),
    read: () => '22.22.1\n',
    realpath: (path: string) => path,
    nodeVersion: '22.22.1',
    executingNodePath: '/bin/node',
  };

  it.each(commands)('rejects a missing %s prerequisite', (missing) => {
    const result = runToolchainPreflight({
      ...passing,
      which: (command: string) =>
        command === missing ? null : `/bin/${command}`,
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      name: missing,
      status: 'fail',
      reason: 'executable not found',
    });
  });

  it.each(['node.h', 'common.gypi', 'config.gypi'])(
    'rejects a missing %s header',
    (missing) => {
      const result = runToolchainPreflight({
        ...passing,
        exists: (path: string) =>
          headerFiles.has(path) && !path.endsWith(missing),
      });
      expect(result.ok).toBe(false);
      expect(
        result.checks.some(
          (check) => check.name.endsWith(missing) && check.status === 'fail',
        ),
      ).toBe(true);
    },
  );

  it('rejects executing-runtime and header-version mismatches', () => {
    const runtimeMismatch = runToolchainPreflight({
      ...passing,
      nodeVersion: '22.21.0',
    });
    expect(runtimeMismatch.ok).toBe(false);
    expect(runtimeMismatch.checks).toContainEqual({
      name: 'executing-node-version',
      status: 'fail',
      reason: 'expected 22.22.1, received 22.21.0',
    });
    const headerMismatch = runToolchainPreflight({
      ...passing,
      read: () => '22.20.0\n',
    });
    expect(headerMismatch.ok).toBe(false);
    expect(
      headerMismatch.checks.some(
        (check) =>
          check.name === 'header-node-version' && check.status === 'fail',
      ),
    ).toBe(true);
  });

  it('rejects an npm version outside the qualified toolchain', () => {
    const result = runToolchainPreflight({
      ...passing,
      run: (command: string) => ({
        status: 0,
        stdout: command.endsWith('/npm') ? '11.0.0\n' : 'fixture-version\n',
        stderr: '',
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      name: 'executing-npm-version',
      status: 'fail',
      reason: 'expected 10.9.4, received 11.0.0',
    });
  });

  it('rejects a PATH Node that differs from the executing runtime', () => {
    const result = runToolchainPreflight({
      ...passing,
      executingNodePath: '/native-arm64/node',
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      name: 'path-node-identity',
      status: 'fail',
      reason:
        'PATH node /bin/node does not match executing Node /native-arm64/node',
    });
  });
});
