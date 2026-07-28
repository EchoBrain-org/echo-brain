import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PackagedProductArtifactEvidenceProvider } from '../../../src/product/federation/artifact-evidence.js';

const roots: string[] = [];
const BUILD_TOOL_URL = pathToFileURL(
  resolve(import.meta.dirname, '../../../tools/build.mjs'),
).href;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(): {
  root: string;
  manifestPath: string;
  artifactPath: string;
  provider: PackagedProductArtifactEvidenceProvider;
} {
  const root = mkdtempSync(join(tmpdir(), 'echo-artifact-evidence-'));
  roots.push(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const artifactPath = join(root, 'echo-brain-0.1.0-dev.7.tgz');
  const bytes = Buffer.from('exact artifact bytes');
  writeFileSync(artifactPath, bytes, { mode: 0o600 });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const manifestPath = join(root, 'artifact-manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: 1,
      package: 'echo-brain',
      version: '0.1.0-dev.7',
      source_sha: 'a'.repeat(40),
      artifact: {
        path: 'echo-brain-0.1.0-dev.7.tgz',
        size: bytes.length,
        sha256: digest,
      },
    }),
    { mode: 0o600 },
  );
  const provider = new PackagedProductArtifactEvidenceProvider({
    artifactManifestPath: manifestPath,
    loadBuildIdentity: () => ({
      schema_version: 1,
      kind: 'echo-packaged-build-identity',
      product_version: '0.1.0-dev.7',
      source_sha: 'a'.repeat(40),
      source_kind: 'materialized-commit',
    }),
  });
  return { root, manifestPath, artifactPath, provider };
}

function packageFixture(): {
  root: string;
  manifestPath: string;
  provider: PackagedProductArtifactEvidenceProvider;
} {
  const root = mkdtempSync(join(tmpdir(), 'echo-package-evidence-'));
  roots.push(root);
  const files = {
    'dist/core/index.js': 'export const core = true;\n',
    'dist/product/build-identity.v1.json': '{"source_kind":"fixture"}\n',
    'dist/product/cli.js': '#!/usr/bin/env node\n',
    'dist/product/federation/artifact-evidence.js':
      'export const evidence = true;\n',
    'dist/product/index.js': 'export const product = true;\n',
    'node_modules/@echo-brain/federation-protocol/dist/index.js':
      'export const federation = true;\n',
    'node_modules/@echo-brain/federation-protocol/package.json':
      '{"name":"@echo-brain/federation-protocol"}\n',
    'node_modules/@echo-brain/organization-api/dist/index.js':
      'export const api = true;\n',
    'node_modules/@echo-brain/organization-api/package.json':
      '{"name":"@echo-brain/organization-api"}\n',
    'node_modules/@echo-brain/organization-protocol/dist/index.js':
      'export const organization = true;\n',
    'node_modules/@echo-brain/organization-protocol/package.json':
      '{"name":"@echo-brain/organization-protocol"}\n',
    'npm-shrinkwrap.json': '{"name":"echo-brain"}\n',
    'package.json': '{"name":"echo-brain"}\n',
  } as const;
  for (const [path, bytes] of Object.entries(files)) {
    const destination = join(root, ...path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const manifest = {
    schema_version: 1,
    kind: 'echo-package-artifact-evidence',
    package: 'echo-brain',
    version: '0.1.0-dev.7',
    source_sha: 'a'.repeat(40),
    files: Object.entries(files)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([path, bytes]) => ({
        path,
        size: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })),
  };
  const manifestPath = join(
    root,
    'dist',
    'package-artifact-evidence.v1.json',
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const provider = new PackagedProductArtifactEvidenceProvider({
    artifactManifestPath: manifestPath,
    loadBuildIdentity: () => ({
      schema_version: 1,
      kind: 'echo-packaged-build-identity',
      product_version: '0.1.0-dev.7',
      source_sha: 'a'.repeat(40),
      source_kind: 'materialized-commit',
    }),
  });
  return { root, manifestPath, provider };
}

function runGit(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function inspectRepositorySource(root: string): {
  sourceSha: string;
  sourceKind: 'materialized-commit' | 'worktree-head-unverified';
} {
  const script = `
    import { inspectRepositorySource } from ${JSON.stringify(BUILD_TOOL_URL)};
    process.stdout.write(JSON.stringify(inspectRepositorySource(process.env.ECHO_TEST_REPOSITORY)));
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      env: { ...process.env, ECHO_TEST_REPOSITORY: root },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    sourceSha: string;
    sourceKind: 'materialized-commit' | 'worktree-head-unverified';
  };
}

function cleanBuildOutputs(root: string): void {
  const script = `
    import { cleanBuildOutputs } from ${JSON.stringify(BUILD_TOOL_URL)};
    cleanBuildOutputs(process.env.ECHO_TEST_REPOSITORY);
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      env: { ...process.env, ECHO_TEST_REPOSITORY: root },
    },
  );
  expect(result.status, result.stderr).toBe(0);
}

describe('packaged product artifact evidence', () => {
  it('verifies every packed file, tolerates npm metadata, and detects tampering', () => {
    const { root, manifestPath, provider } = packageFixture();
    const current = provider.current();
    expect(current).toEqual({
      product_version: '0.1.0-dev.7',
      source_sha: 'a'.repeat(40),
      artifact_sha256: `sha256:${createHash('sha256')
        .update(readFileSync(manifestPath))
        .digest('hex')}`,
    });
    expect(() => provider.verify(current)).not.toThrow();

    writeFileSync(
      join(root, 'node_modules', '.package-lock.json'),
      'npm-managed metadata\n',
    );
    expect(provider.current()).toEqual(current);

    writeFileSync(join(resolve(manifestPath, '..'), 'product/cli.js'), 'tampered');
    expect(() => provider.current()).toThrow(
      /installed package file dist\/product\/cli\.js does not match its manifest/,
    );
  });

  it('binds attribution to the retained materialized release artifact', () => {
    const { provider } = fixture();
    const current = provider.current();
    expect(current).toEqual({
      product_version: '0.1.0-dev.7',
      source_sha: 'a'.repeat(40),
      artifact_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(() => provider.verify(current)).not.toThrow();
    expect(() =>
      provider.verify({
        ...current,
        artifact_sha256: `sha256:${'0'.repeat(64)}`,
      }),
    ).toThrow(/no verified retained release artifact/);
  });

  it('verifies attribution from a retained historical release', () => {
    const { root, manifestPath } = fixture();
    const historicalDirectory = join(root, 'historical');
    mkdirSync(historicalDirectory, { mode: 0o700 });
    const historicalArtifact = join(
      historicalDirectory,
      'echo-brain-0.1.0-dev.6.tgz',
    );
    const bytes = Buffer.from('historical artifact bytes');
    writeFileSync(historicalArtifact, bytes, { mode: 0o600 });
    const historicalManifest = join(
      historicalDirectory,
      'artifact-manifest.json',
    );
    const historicalDigest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(
      historicalManifest,
      JSON.stringify({
        schema_version: 1,
        package: 'echo-brain',
        version: '0.1.0-dev.6',
        source_sha: '6'.repeat(40),
        artifact: {
          path: 'echo-brain-0.1.0-dev.6.tgz',
          size: bytes.length,
          sha256: historicalDigest,
        },
      }),
      { mode: 0o600 },
    );
    const provider = new PackagedProductArtifactEvidenceProvider({
      artifactManifestPath: manifestPath,
      historicalArtifactManifestPaths: () => [historicalManifest],
      loadBuildIdentity: () => ({
        schema_version: 1,
        kind: 'echo-packaged-build-identity',
        product_version: '0.1.0-dev.7',
        source_sha: 'a'.repeat(40),
        source_kind: 'materialized-commit',
      }),
    });
    const historical = {
      product_version: '0.1.0-dev.6',
      source_sha: '6'.repeat(40),
      artifact_sha256: `sha256:${historicalDigest}` as const,
    };
    expect(() => provider.verify(historical)).not.toThrow();
    writeFileSync(historicalArtifact, 'tampered', { mode: 0o600 });
    expect(() => provider.verify(historical)).toThrow(
      /does not match its manifest/,
    );
  });

  it('fails closed for worktree builds, manifest drift, and artifact drift', () => {
    const { artifactPath, manifestPath, provider } = fixture();
    writeFileSync(artifactPath, 'tampered', { mode: 0o600 });
    expect(() => provider.current()).toThrow(/does not match its manifest/);

    const worktree = new PackagedProductArtifactEvidenceProvider({
      artifactManifestPath: manifestPath,
      loadBuildIdentity: () => ({
        schema_version: 1,
        kind: 'echo-packaged-build-identity',
        product_version: '0.1.0-dev.7',
        source_sha: 'a'.repeat(40),
        source_kind: 'worktree-head-unverified',
      }),
    });
    expect(() => worktree.current()).toThrow(/worktree builds/);
  });
});

describe('packaged build source classification', () => {
  it('removes ignored outputs for every bundled workspace before rebuilding', () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-build-clean-'));
    roots.push(root);
    const outputDirectories = [
      'dist',
      'packages/federation-protocol/dist',
      'packages/organization-protocol/dist',
      'packages/organization-api/dist',
    ];
    for (const directory of outputDirectories) {
      const output = join(root, ...directory.split('/'));
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'stale-or-tampered.js'), 'untrusted\n');
    }

    cleanBuildOutputs(root);

    for (const directory of outputDirectories) {
      expect(existsSync(join(root, ...directory.split('/')))).toBe(false);
    }
  });

  it('only labels a clean committed repository as materialized', () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-build-source-'));
    roots.push(root);
    runGit(root, ['init']);
    runGit(root, ['config', 'user.name', 'Echo Test']);
    runGit(root, ['config', 'user.email', 'echo-test@example.invalid']);
    writeFileSync(join(root, 'tracked.txt'), 'committed\n');
    runGit(root, ['add', 'tracked.txt']);
    runGit(root, ['commit', '-m', 'fixture']);

    expect(inspectRepositorySource(root)).toMatchObject({
      sourceSha: expect.stringMatching(/^[a-f0-9]{40}$/),
      sourceKind: 'materialized-commit',
    });

    writeFileSync(join(root, 'tracked.txt'), 'modified\n');
    expect(inspectRepositorySource(root).sourceKind).toBe(
      'worktree-head-unverified',
    );
    runGit(root, ['restore', 'tracked.txt']);
    writeFileSync(join(root, 'untracked.txt'), 'untracked\n');
    expect(inspectRepositorySource(root).sourceKind).toBe(
      'worktree-head-unverified',
    );
  });
});
