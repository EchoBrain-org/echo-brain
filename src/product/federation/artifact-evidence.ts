import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../../util/json.js';
import {
  assertSafeRelativePath,
  assertSha256,
  digestFileNoFollow,
  readFileNoFollow,
} from '../secure-local-files.js';
import type { ProductArtifactEvidenceProvider } from './approval-capture.js';
import { loadPackagedBuildIdentity } from './build-identity.js';
import type { ProductArtifactIdentityV1 } from './contracts.js';

interface ArtifactEvidenceOptions {
  artifactManifestPath?: string;
  loadBuildIdentity?: typeof loadPackagedBuildIdentity;
  historicalArtifactManifestPaths?: () => readonly string[];
}

interface ArtifactManifestIdentity {
  version: string;
  sourceSha: string;
  artifactPath: string;
  artifactSize: number;
  artifactSha256: string;
}

const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;

function fail(message: string): never {
  throw new Error(`packaged product artifact evidence failed: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function defaultArtifactManifestPath(): string {
  // Installed layout:
  // <release>/prefix/node_modules/echo-brain/dist/product/federation/*.js
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'artifact-manifest.json',
  );
}

function parseArtifactManifest(raw: Buffer): ArtifactManifestIdentity {
  const manifest = record(parseJson(raw.toString('utf8')), 'artifact manifest');
  if (
    manifest['schema_version'] !== 1 ||
    manifest['package'] !== 'echo-brain'
  ) {
    fail('artifact manifest does not describe echo-brain v1');
  }
  const version = nonEmpty(manifest['version'], 'artifact version');
  const sourceSha = nonEmpty(manifest['source_sha'], 'artifact source SHA');
  if (!SOURCE_SHA_RE.test(sourceSha)) {
    fail('artifact source SHA must be a full lowercase commit');
  }
  const artifact = record(manifest['artifact'], 'artifact identity');
  const artifactPath = nonEmpty(artifact['path'], 'artifact path');
  assertSafeRelativePath(artifactPath, 'artifact path');
  if (artifactPath.includes('/') || !artifactPath.endsWith('.tgz')) {
    fail('artifact path must name one sibling .tgz file');
  }
  const artifactSize = artifact['size'];
  if (!Number.isSafeInteger(artifactSize) || (artifactSize as number) < 1) {
    fail('artifact size must be a positive safe integer');
  }
  const artifactSha256 = nonEmpty(artifact['sha256'], 'artifact SHA-256');
  assertSha256(artifactSha256, 'artifact SHA-256');
  return {
    version,
    sourceSha,
    artifactPath,
    artifactSize: artifactSize as number,
    artifactSha256,
  };
}

function defaultHistoricalManifestPaths(currentManifestPath: string): string[] {
  const releaseDirectory = dirname(currentManifestPath);
  const releasesRoot = dirname(releaseDirectory);
  if (basename(releasesRoot) !== 'releases') return [];
  return readdirSync(releasesRoot)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    .flatMap((entry) => {
      const directory = join(releasesRoot, entry);
      const state = lstatSync(directory, { throwIfNoEntry: false });
      if (
        state === undefined ||
        state.isSymbolicLink() ||
        !state.isDirectory()
      ) {
        return [];
      }
      const manifest = join(directory, 'artifact-manifest.json');
      const manifestState = lstatSync(manifest, { throwIfNoEntry: false });
      return manifestState?.isFile() === true && !manifestState.isSymbolicLink()
        ? [manifest]
        : [];
    });
}

function verifiedArtifactIdentity(
  manifestPath: string,
): ProductArtifactIdentityV1 {
  const manifest = parseArtifactManifest(
    readFileNoFollow(manifestPath, 'artifact manifest'),
  );
  const artifact = digestFileNoFollow(
    join(dirname(manifestPath), manifest.artifactPath),
    'retained product artifact',
  );
  if (
    artifact.size !== manifest.artifactSize ||
    artifact.sha256 !== manifest.artifactSha256
  ) {
    fail('retained product artifact does not match its manifest');
  }
  return {
    product_version: manifest.version,
    source_sha: manifest.sourceSha,
    artifact_sha256: `sha256:${manifest.artifactSha256}`,
  };
}

/**
 * Reads the immutable release artifact identity installed beside the package.
 * The source/version must agree with the packaged build identity and the
 * retained tarball is re-hashed before any attribution snapshot is returned.
 */
export class PackagedProductArtifactEvidenceProvider implements ProductArtifactEvidenceProvider {
  private readonly artifactManifestPath: string;
  private readonly loadBuildIdentity: typeof loadPackagedBuildIdentity;
  private readonly historicalArtifactManifestPaths: () => readonly string[];

  constructor(options: ArtifactEvidenceOptions = {}) {
    this.artifactManifestPath = resolve(
      options.artifactManifestPath ?? defaultArtifactManifestPath(),
    );
    this.loadBuildIdentity =
      options.loadBuildIdentity ?? loadPackagedBuildIdentity;
    this.historicalArtifactManifestPaths =
      options.historicalArtifactManifestPaths ??
      (() => defaultHistoricalManifestPaths(this.artifactManifestPath));
  }

  current(): ProductArtifactIdentityV1 {
    const build = this.loadBuildIdentity();
    if (build.source_kind !== 'materialized-commit') {
      fail('worktree builds cannot produce seed-grade artifact evidence');
    }
    const current = verifiedArtifactIdentity(this.artifactManifestPath);
    if (
      current.product_version !== build.product_version ||
      current.source_sha !== build.source_sha
    ) {
      fail('artifact manifest and packaged build identity disagree');
    }
    return current;
  }

  verify(value: ProductArtifactIdentityV1): void {
    const same = (candidate: ProductArtifactIdentityV1): boolean =>
      value.product_version === candidate.product_version &&
      value.source_sha === candidate.source_sha &&
      value.artifact_sha256 === candidate.artifact_sha256;
    if (same(this.current())) return;
    const candidates = [...new Set(this.historicalArtifactManifestPaths())]
      .map((path) => resolve(path))
      .filter((path) => path !== this.artifactManifestPath)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const path of candidates) {
      if (same(verifiedArtifactIdentity(path))) return;
    }
    fail(
      'recorded artifact identity has no verified retained release artifact',
    );
  }
}
