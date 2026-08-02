import {
  organizationInternalLiveManifestSha256,
  validateOrganizationInternalLiveReleaseManifest,
  type OrganizationInternalLiveReleaseManifestV1,
} from '@echo-brain/organization-api';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-internal\.(?:0|[1-9]\d*)$/u;
export type InternalLiveReleaseManifestV1 =
  OrganizationInternalLiveReleaseManifestV1;

export const parseInternalLiveReleaseManifest =
  validateOrganizationInternalLiveReleaseManifest;
export const internalLiveManifestSha256 =
  organizationInternalLiveManifestSha256;

export interface PackageArtifactEvidenceFileV1 {
  path: string;
  size: number;
  sha256: string;
}

export interface PackageArtifactEvidenceV1 {
  schema_version: 1;
  kind: 'echo-package-artifact-evidence';
  package: 'echo-brain';
  version: string;
  source_sha: string;
  files: readonly PackageArtifactEvidenceFileV1[];
}

export interface InspectedInternalLivePackage {
  package_name: string;
  package_version: string;
  build_identity: unknown;
  artifact_evidence: unknown;
  /**
   * Every regular package entry except dist/package-artifact-evidence.v1.json.
   * The inspector must reject links and non-regular archive entries.
   */
  package_files: readonly PackageArtifactEvidenceFileV1[];
}

export interface VerifiedInternalLiveArtifact {
  artifact_sha256: string;
  artifact_size_bytes: number;
  product_version: string;
  source_sha: string;
  evidence_file_count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} has an unsupported value`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  return requireString(value, SHA256_PATTERN, label);
}

function requireSourceSha(value: unknown, label: string): string {
  return requireString(value, SOURCE_SHA_PATTERN, label);
}

function safePackagePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('package evidence contains an unsafe path');
  }
  return value;
}

function parseEvidenceFile(
  value: unknown,
  index: number,
): PackageArtifactEvidenceFileV1 {
  const record = requireRecord(value, `package evidence file ${index}`);
  exactKeys(record, ['path', 'size', 'sha256'], `package evidence file ${index}`);
  const size = record['size'];
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error(`package evidence file ${index} has an invalid size`);
  }
  return {
    path: safePackagePath(record['path']),
    size: size as number,
    sha256: requireSha256(
      record['sha256'],
      `package evidence file ${index} SHA-256`,
    ),
  };
}

export function parsePackageArtifactEvidence(
  value: unknown,
): PackageArtifactEvidenceV1 {
  const record = requireRecord(value, 'package artifact evidence');
  exactKeys(
    record,
    ['schema_version', 'kind', 'package', 'version', 'source_sha', 'files'],
    'package artifact evidence',
  );
  if (
    record['schema_version'] !== 1 ||
    record['kind'] !== 'echo-package-artifact-evidence' ||
    record['package'] !== 'echo-brain' ||
    !Array.isArray(record['files']) ||
    record['files'].length === 0 ||
    record['files'].length > 4_096
  ) {
    throw new Error('package artifact evidence has an unsupported shape');
  }
  const files = record['files'].map(parseEvidenceFile);
  const sorted = [...files].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  if (
    files.some((file, index) => file.path !== sorted[index]?.path) ||
    new Set(files.map((file) => file.path)).size !== files.length
  ) {
    throw new Error('package artifact evidence files must be unique and byte-sorted');
  }
  return {
    schema_version: 1,
    kind: 'echo-package-artifact-evidence',
    package: 'echo-brain',
    version: requireString(
      record['version'],
      VERSION_PATTERN,
      'package artifact evidence version',
    ),
    source_sha: requireSourceSha(
      record['source_sha'],
      'package artifact evidence source SHA',
    ),
    files,
  };
}

function sameEvidenceFiles(
  expected: readonly PackageArtifactEvidenceFileV1[],
  actual: readonly PackageArtifactEvidenceFileV1[],
): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((file, index) => {
    const observed = actual[index];
    return (
      observed !== undefined &&
      observed.path === file.path &&
      observed.size === file.size &&
      observed.sha256 === file.sha256
    );
  });
}

export function assertInternalLiveCompatibility(
  manifest: InternalLiveReleaseManifestV1,
  runtime: {
    os: NodeJS.Platform;
    arch: string;
    node: string;
    npm: string;
  },
): void {
  const observedNode = runtime.node.startsWith('v')
    ? runtime.node.slice(1)
    : runtime.node;
  if (
    runtime.os !== manifest.compatibility.os ||
    runtime.arch !== manifest.compatibility.arch ||
    observedNode !== manifest.compatibility.node ||
    runtime.npm !== manifest.compatibility.npm
  ) {
    throw new Error('internal-live release is incompatible with this runtime');
  }
}

export function verifyInspectedInternalLivePackage(
  manifest: InternalLiveReleaseManifestV1,
  inspection: InspectedInternalLivePackage,
  artifact: { sha256: string; size_bytes: number },
): VerifiedInternalLiveArtifact {
  if (
    artifact.sha256 !== manifest.artifact.sha256 ||
    artifact.size_bytes !== manifest.artifact.size_bytes
  ) {
    throw new Error('downloaded artifact does not match the release manifest');
  }
  const buildIdentity = requireRecord(
    inspection.build_identity,
    'packaged build identity',
  );
  exactKeys(
    buildIdentity,
    ['schema_version', 'kind', 'product_version', 'source_sha', 'source_kind'],
    'packaged build identity',
  );
  if (
    buildIdentity['schema_version'] !== 1 ||
    buildIdentity['kind'] !== 'echo-packaged-build-identity' ||
    buildIdentity['source_kind'] !== 'materialized-commit'
  ) {
    throw new Error('packaged build identity is not release-grade');
  }
  const buildVersion = requireString(
    buildIdentity['product_version'],
    VERSION_PATTERN,
    'packaged build version',
  );
  const buildSourceSha = requireSourceSha(
    buildIdentity['source_sha'],
    'packaged build source SHA',
  );
  const evidence = parsePackageArtifactEvidence(inspection.artifact_evidence);
  const actualFiles = inspection.package_files.map(parseEvidenceFile);
  if (
    inspection.package_name !== manifest.artifact.package ||
    inspection.package_version !== manifest.release_version ||
    buildVersion !== manifest.release_version ||
    evidence.version !== manifest.release_version ||
    buildSourceSha !== manifest.source.sha ||
    evidence.source_sha !== manifest.source.sha ||
    evidence.package !== manifest.artifact.package ||
    !sameEvidenceFiles(evidence.files, actualFiles)
  ) {
    throw new Error('package contents do not match internal-live release evidence');
  }
  return Object.freeze({
    artifact_sha256: artifact.sha256,
    artifact_size_bytes: artifact.size_bytes,
    product_version: buildVersion,
    source_sha: buildSourceSha,
    evidence_file_count: evidence.files.length,
  });
}
