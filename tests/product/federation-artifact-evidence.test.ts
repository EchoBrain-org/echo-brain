import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PackagedProductArtifactEvidenceProvider } from '../../src/product/federation/artifact-evidence.js';

const roots: string[] = [];

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

describe('packaged product artifact evidence', () => {
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
