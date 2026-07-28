import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../../util/json.js';
import {
  assertSafeRelativePath,
  assertSha256,
  digestFileNoFollow,
  readFileNoFollow,
  sha256Bytes,
} from '../secure-local-files.js';
import type { ProductArtifactEvidenceProvider } from './approval-capture.js';
import { loadPackagedBuildIdentity } from './build-identity.js';
import type { ProductArtifactIdentityV1 } from './contracts.js';

interface ArtifactEvidenceOptions {
  artifactManifestPath?: string;
  loadBuildIdentity?: typeof loadPackagedBuildIdentity;
  historicalArtifactManifestPaths?: () => readonly string[];
}

interface RetainedArtifactManifestIdentity {
  format: 'retained-tarball';
  version: string;
  sourceSha: string;
  artifactPath: string;
  artifactSize: number;
  artifactSha256: string;
}

interface PackagedFileIdentity {
  path: string;
  size: number;
  sha256: string;
}

interface PackageArtifactManifestIdentity {
  format: 'package-files';
  version: string;
  sourceSha: string;
  files: readonly PackagedFileIdentity[];
}

type ArtifactManifestIdentity =
  | RetainedArtifactManifestIdentity
  | PackageArtifactManifestIdentity;

const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;
const PACKAGE_EVIDENCE_FILE = 'package-artifact-evidence.v1.json';
const MAX_PACKAGED_FILES = 4_096;
const REQUIRED_PACKAGED_FILES = [
  'dist/product/build-identity.v1.json',
  'dist/product/cli.js',
  'dist/product/federation/artifact-evidence.js',
  'dist/product/index.js',
  'node_modules/@echo-brain/federation-protocol/dist/index.js',
  'node_modules/@echo-brain/federation-protocol/package.json',
  'node_modules/@echo-brain/organization-api/dist/index.js',
  'node_modules/@echo-brain/organization-api/package.json',
  'node_modules/@echo-brain/organization-protocol/dist/index.js',
  'node_modules/@echo-brain/organization-protocol/package.json',
  'npm-shrinkwrap.json',
  'package.json',
] as const;

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
  // node_modules/echo-brain/dist/product/federation/*.js
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    PACKAGE_EVIDENCE_FILE,
  );
}

function parseArtifactManifest(raw: Buffer): ArtifactManifestIdentity {
  const manifest = record(parseJson(raw.toString('utf8')), 'artifact manifest');
  if (manifest['kind'] === 'echo-package-artifact-evidence') {
    const keys = Object.keys(manifest).sort();
    if (
      keys.join(',') !==
        'files,kind,package,schema_version,source_sha,version' ||
      manifest['schema_version'] !== 1 ||
      manifest['package'] !== 'echo-brain'
    ) {
      fail('package artifact manifest does not describe echo-brain v1');
    }
    const version = nonEmpty(manifest['version'], 'artifact version');
    const sourceSha = nonEmpty(manifest['source_sha'], 'artifact source SHA');
    if (!SOURCE_SHA_RE.test(sourceSha)) {
      fail('artifact source SHA must be a full lowercase commit');
    }
    const rawFiles = manifest['files'];
    if (
      !Array.isArray(rawFiles) ||
      rawFiles.length === 0 ||
      rawFiles.length > MAX_PACKAGED_FILES
    ) {
      fail(
        `package artifact files must contain 1-${String(MAX_PACKAGED_FILES)} entries`,
      );
    }
    const files = rawFiles.map((value, index): PackagedFileIdentity => {
      const file = record(value, `package artifact file ${String(index)}`);
      if (Object.keys(file).sort().join(',') !== 'path,sha256,size') {
        fail(`package artifact file ${String(index)} has unsupported fields`);
      }
      const path = nonEmpty(file['path'], 'package artifact file path');
      assertSafeRelativePath(path, 'package artifact file path');
      if (path === `dist/${PACKAGE_EVIDENCE_FILE}`) {
        fail('package artifact manifest cannot hash itself');
      }
      const size = file['size'];
      if (!Number.isSafeInteger(size) || (size as number) < 0) {
        fail('package artifact file size must be a non-negative safe integer');
      }
      const sha256 = nonEmpty(
        file['sha256'],
        'package artifact file SHA-256',
      );
      assertSha256(sha256, 'package artifact file SHA-256');
      return { path, size: size as number, sha256 };
    });
    for (let index = 1; index < files.length; index += 1) {
      if (
        Buffer.from(files[index - 1]!.path).compare(
          Buffer.from(files[index]!.path),
        ) >= 0
      ) {
        fail('package artifact files must be uniquely bytewise sorted');
      }
    }
    const paths = new Set(files.map(({ path }) => path));
    for (const required of REQUIRED_PACKAGED_FILES) {
      if (!paths.has(required)) {
        fail(`package artifact files are missing required path ${required}`);
      }
    }
    return {
      format: 'package-files',
      version,
      sourceSha,
      files,
    };
  }
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
    format: 'retained-tarball',
    version,
    sourceSha,
    artifactPath,
    artifactSize: artifactSize as number,
    artifactSha256,
  };
}

function verifyPackageFiles(
  manifestPath: string,
  manifest: PackageArtifactManifestIdentity,
): void {
  if (
    basename(manifestPath) !== PACKAGE_EVIDENCE_FILE ||
    basename(dirname(manifestPath)) !== 'dist'
  ) {
    fail(`package artifact manifest must be installed at dist/${PACKAGE_EVIDENCE_FILE}`);
  }
  const root = resolve(dirname(manifestPath), '..');
  for (const expected of manifest.files) {
    const actual = digestFileNoFollow(
      join(root, ...expected.path.split('/')),
      `installed package file ${expected.path}`,
    );
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      fail(`installed package file ${expected.path} does not match its manifest`);
    }
  }
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
  const raw = readFileNoFollow(manifestPath, 'artifact manifest');
  const manifest = parseArtifactManifest(raw);
  if (manifest.format === 'package-files') {
    verifyPackageFiles(manifestPath, manifest);
    return {
      product_version: manifest.version,
      source_sha: manifest.sourceSha,
      artifact_sha256: `sha256:${sha256Bytes(raw)}`,
    };
  }
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
 * Reads the release artifact identity installed with the package. Ordinary npm
 * packages verify a self-excluding manifest over every npm-packed file.
 * Explicit legacy manifest paths continue to verify retained release tarballs.
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
