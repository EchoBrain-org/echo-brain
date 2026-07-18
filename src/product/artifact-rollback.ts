import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertDirectory,
  assertPrivateOwnedDirectory,
  assertSafeIdentifier,
  assertSafeRelativePath,
  assertSha256,
  canonicalLocalPath,
  digestFileNoFollow,
  fsyncDirectory,
  pathEntryExists,
  pathIsWithin,
  readFileNoFollow,
  resolveContainedRelativePath,
  sha256Bytes,
  writeFileExclusive,
} from './secure-local-files.js';

export const MANAGED_PRODUCT_CURRENT_POINTER = 'current';
export const MANAGED_PRODUCT_PREFIX = 'prefix';
export const MANAGED_PRODUCT_EXECUTABLE_RELATIVE_PATH =
  'prefix/node_modules/.bin/echo-brain';
export const MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST =
  'deployed-tree-manifest.json';

const ARTIFACT_MANIFEST_PATH = 'artifact-manifest.json';
const INSTALLED_PRODUCT_PACKAGE_PATH =
  'prefix/node_modules/echo-brain/package.json';
const INSTALLED_PRODUCT_PACKAGE_ROOT = 'prefix/node_modules/echo-brain';
const INSTALLED_PRODUCT_SHRINKWRAP_PATH =
  'prefix/node_modules/echo-brain/npm-shrinkwrap.json';
const INSTALL_ROOT_PACKAGE_PATH = 'prefix/package.json';
const INSTALL_ROOT_LOCK_PATH = 'prefix/package-lock.json';
const INSTALLED_PRODUCT_CLI_PATH =
  'prefix/node_modules/echo-brain/dist/product/cli.js';
const PRODUCT_PACKAGE_NAME = 'echo-brain';
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/;
const NODE_VERSION_PATTERN = /^22\.\d+\.\d+$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type JsonRecord = Record<string, unknown>;

export interface ManagedProductReleasePin {
  sourceSha: string;
  version: string;
  artifactSha256: string;
  artifactManifestSha256: string;
  deployedTreeManifestSha256: string;
  qualificationReport: null;
}

export interface PrepareManagedProductReleaseOptions {
  /** A private (0700), current-user-owned root containing direct-child releases. */
  managedReleasesRoot: string;
  /** An already offline-installed, staging release that is a direct child of the root. */
  releaseId: string;
  expectedSourceSha: string;
  expectedVersion: string;
  expectedArtifactSha256: string;
  expectedArtifactManifestSha256: string;
}

export interface VerifyManagedProductReleaseOptions {
  managedReleasesRoot: string;
  releaseId: string;
  expected: ManagedProductReleasePin;
}

export interface ManagedProductArtifactIdentity {
  package: 'echo-brain';
  sourceSha: string;
  version: string;
  artifactSha256: string;
  artifactManifestSha256: string;
  artifactPath: string;
  artifactSize: number;
  packagedShrinkwrapSha256: string;
  packageFiles: ArtifactManifestPackageFile[];
}

export interface ArtifactManifestPackageFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ManagedProductReleaseFileEntry {
  path: string;
  type: 'file';
  mode: number;
  size: number;
  sha256: string;
}

export interface ManagedProductReleaseDirectoryEntry {
  path: string;
  type: 'directory';
  mode: number;
}

export interface ManagedProductReleaseSymlinkEntry {
  path: string;
  type: 'symlink';
  target: string;
}

export type ManagedProductReleaseTreeEntry =
  | ManagedProductReleaseFileEntry
  | ManagedProductReleaseDirectoryEntry
  | ManagedProductReleaseSymlinkEntry;

export interface ManagedProductDeployedTreeManifest {
  schema_version: 1;
  kind: 'echo-product-managed-release';
  release_id: string;
  prefix_path: 'prefix';
  executable_path: 'prefix/node_modules/.bin/echo-brain';
  artifact: {
    package: 'echo-brain';
    source_sha: string;
    version: string;
    path: string;
    size: number;
    sha256: string;
    manifest_path: 'artifact-manifest.json';
    manifest_sha256: string;
    packaged_shrinkwrap_sha256: string;
  };
  qualification_report: null;
  deployed_tree: {
    digest_sha256: string;
    entries: ManagedProductReleaseTreeEntry[];
  };
}

export interface VerifiedManagedProductRelease {
  releaseDirectory: string;
  executablePath: string;
  artifact: ManagedProductArtifactIdentity;
  manifest: ManagedProductDeployedTreeManifest;
  deployedTreeManifestSha256: string;
  pin: ManagedProductReleasePin;
}

export type PreparedManagedProductRelease = VerifiedManagedProductRelease;

export type ManagedProductReleaseSwitchFaultPoint =
  | 'after_pointer_switch'
  | 'after_post_switch_verification'
  | 'after_commit_marker'
  | 'before_pointer_revert';

export interface SwitchManagedProductReleaseOptions
  extends VerifyManagedProductReleaseOptions {
  operationId: string;
  switchedAt: string;
  /** Test-only fault hook used to prove post-switch reversion behavior. */
  faultInjector?: (point: ManagedProductReleaseSwitchFaultPoint) => void;
}

export type ManagedReleaseSwitchMarkerPhase =
  | 'prepared'
  | 'committed'
  | 'reverted'
  | 'revert-failed';

export interface ManagedReleaseSwitchMarker {
  schema_version: 1;
  kind: 'echo-product-release-switch';
  operation_id: string;
  switched_at: string;
  phase: ManagedReleaseSwitchMarkerPhase;
  previous_release_id: string | null;
  release_id: string;
  source_sha: string;
  version: string;
  artifact_sha256: string;
  artifact_manifest_sha256: string;
  deployed_tree_manifest_sha256: string;
  qualification_report_sha256: string | null;
  failure_stage: string | null;
}

export interface ReleasePointerSwitchEvidence {
  operation: 'release-pointer-switch';
  operation_id: string;
  switched_at: string;
  switched: boolean;
  previous_release_id: string | null;
  release_id: string;
  source_sha: string;
  version: string;
  artifact_sha256: string;
  artifact_manifest_sha256: string;
  deployed_tree_manifest_sha256: string;
  qualification_report_sha256: string | null;
  marker_sha256: string | null;
}

export interface SwitchedManagedProductRelease {
  verifiedRelease: VerifiedManagedProductRelease;
  markerPath: string | null;
  marker: ManagedReleaseSwitchMarker | null;
  evidence: ReleasePointerSwitchEvidence;
}

export interface ManagedReleaseRevertReport {
  attempted: true;
  status: 'reverted' | 'failed';
  previousReleaseId: string | null;
  markerPhase: ManagedReleaseSwitchMarkerPhase;
  markerUpdated: boolean;
  error: string | null;
}

export interface RecoverManagedProductReleaseSwitchOptions {
  managedReleasesRoot: string;
  operationId: string;
}

export interface RecoveredManagedProductReleaseSwitch {
  recovered: boolean;
  markerPath: string;
  marker: ManagedReleaseSwitchMarker;
}

export class ManagedProductReleaseSwitchError extends Error {
  readonly code = 'MANAGED_PRODUCT_RELEASE_SWITCH_FAILED';

  constructor(
    message: string,
    readonly revert: ManagedReleaseRevertReport,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'ManagedProductReleaseSwitchError';
  }
}

interface ParsedArtifactManifest {
  package: 'echo-brain';
  sourceSha: string;
  version: string;
  artifactSha256: string;
  artifactPath: string;
  artifactSize: number;
  packagedShrinkwrapSha256: string;
  packageFiles: ArtifactManifestPackageFile[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function assertSourceSha(value: string, label: string): void {
  if (!SOURCE_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character source SHA`);
  }
}

function assertVersion(value: string, label: string): void {
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be a product prerelease version`);
  }
}

function assertIsoInstant(value: string): void {
  if (!ISO_INSTANT_PATTERN.test(value)) {
    throw new Error('switchedAt must be a caller-supplied UTC ISO instant');
  }
}

function assertExpectedIdentity(
  sourceSha: string,
  version: string,
  artifactSha256: string,
  artifactManifestSha256: string,
): void {
  assertSourceSha(sourceSha, 'expected source SHA');
  assertVersion(version, 'expected version');
  assertSha256(artifactSha256, 'expected artifact checksum');
  assertSha256(artifactManifestSha256, 'expected artifact manifest checksum');
}

function parseArtifactManifest(bytes: Buffer): ParsedArtifactManifest {
  const manifest = requireRecord(parseJson(bytes, 'artifact manifest'), 'artifact manifest');
  exactKeys(
    manifest,
    [
      'schema_version',
      'package',
      'version',
      'source_sha',
      'product_boundary_version',
      'declared_platform',
      'dependency_lock_sha256',
      'packaged_shrinkwrap_sha256',
      'build_command',
      'artifact',
      'package_files',
    ],
    'artifact manifest v1',
  );
  if (manifest['schema_version'] !== 1) {
    throw new Error('artifact manifest schema_version must be exactly 1');
  }
  if (manifest['package'] !== PRODUCT_PACKAGE_NAME) {
    throw new Error('artifact manifest package must be echo-brain');
  }
  const version = requireString(manifest['version'], 'artifact manifest version');
  assertVersion(version, 'artifact manifest version');
  const sourceSha = requireString(
    manifest['source_sha'],
    'artifact manifest source SHA',
  );
  assertSourceSha(sourceSha, 'artifact manifest source SHA');
  if (
    !Number.isSafeInteger(manifest['product_boundary_version']) ||
    (manifest['product_boundary_version'] as number) < 1
  ) {
    throw new Error('artifact manifest product boundary version is invalid');
  }
  assertSha256(
    requireString(
      manifest['dependency_lock_sha256'],
      'artifact dependency lock checksum',
    ),
    'artifact dependency lock checksum',
  );
  const packagedShrinkwrapSha256 = requireString(
    manifest['packaged_shrinkwrap_sha256'],
    'packaged shrinkwrap checksum',
  );
  assertSha256(packagedShrinkwrapSha256, 'packaged shrinkwrap checksum');

  const declaredPlatform = requireRecord(
    manifest['declared_platform'],
    'artifact declared platform',
  );
  exactKeys(declaredPlatform, ['os', 'architecture', 'node'], 'declared platform');
  if (
    declaredPlatform['os'] !== 'darwin' ||
    declaredPlatform['architecture'] !== 'arm64' ||
    typeof declaredPlatform['node'] !== 'string' ||
    !NODE_VERSION_PATTERN.test(declaredPlatform['node'])
  ) {
    throw new Error('artifact declared platform is not a supported v1 target');
  }

  if (
    !Array.isArray(manifest['build_command']) ||
    manifest['build_command'].length === 0 ||
    manifest['build_command'].some(
      (part) => typeof part !== 'string' || part.length === 0,
    )
  ) {
    throw new Error('artifact build command is invalid');
  }

  const artifact = requireRecord(manifest['artifact'], 'artifact identity');
  exactKeys(artifact, ['path', 'size', 'sha256'], 'artifact identity');
  const artifactPath = requireString(artifact['path'], 'artifact path');
  assertSafeRelativePath(artifactPath, 'artifact path');
  if (
    artifactPath.includes('/') ||
    !artifactPath.endsWith('.tgz') ||
    artifactPath === ARTIFACT_MANIFEST_PATH ||
    artifactPath === MANAGED_PRODUCT_PREFIX ||
    artifactPath === MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST
  ) {
    throw new Error('artifact path must name a non-reserved .tgz beside its manifest');
  }
  const artifactSize = requireSafeInteger(artifact['size'], 'artifact size');
  if (artifactSize === 0) throw new Error('artifact size must be positive');
  const artifactSha256 = requireString(artifact['sha256'], 'artifact checksum');
  assertSha256(artifactSha256, 'artifact checksum');

  if (!Array.isArray(manifest['package_files']) || manifest['package_files'].length === 0) {
    throw new Error('artifact package_files must be a non-empty array');
  }
  const packageFiles: ArtifactManifestPackageFile[] = [];
  let previousPath: string | null = null;
  for (const [index, rawEntry] of manifest['package_files'].entries()) {
    const entry = requireRecord(rawEntry, `artifact package_files[${index}]`);
    exactKeys(entry, ['path', 'size', 'sha256'], 'artifact package file');
    const path = requireString(entry['path'], 'artifact package file path');
    assertSafeRelativePath(path, 'artifact package file path');
    const size = requireSafeInteger(entry['size'], 'artifact package file size');
    const sha256 = requireString(entry['sha256'], 'artifact package file checksum');
    assertSha256(sha256, 'artifact package file checksum');
    if (
      previousPath !== null &&
      Buffer.from(previousPath).compare(Buffer.from(path)) >= 0
    ) {
      throw new Error('artifact package_files must be uniquely byte-sorted');
    }
    previousPath = path;
    packageFiles.push({ path, size, sha256 });
  }

  return {
    package: PRODUCT_PACKAGE_NAME,
    sourceSha,
    version,
    artifactSha256,
    artifactPath,
    artifactSize,
    packagedShrinkwrapSha256,
    packageFiles,
  };
}

function artifactIdentityFromFile(
  releaseDirectory: string,
  expectedSourceSha: string,
  expectedVersion: string,
  expectedArtifactSha256: string,
  expectedArtifactManifestSha256: string,
): ManagedProductArtifactIdentity {
  const path = join(releaseDirectory, ARTIFACT_MANIFEST_PATH);
  const bytes = readFileNoFollow(path, 'artifact manifest');
  const manifestSha256 = sha256Bytes(bytes);
  if (manifestSha256 !== expectedArtifactManifestSha256) {
    throw new Error('artifact manifest checksum does not match the pinned release');
  }
  const manifest = parseArtifactManifest(bytes);
  if (
    manifest.sourceSha !== expectedSourceSha ||
    manifest.version !== expectedVersion ||
    manifest.artifactSha256 !== expectedArtifactSha256
  ) {
    throw new Error('artifact manifest source/version/artifact identity mismatch');
  }
  return {
    package: PRODUCT_PACKAGE_NAME,
    sourceSha: manifest.sourceSha,
    version: manifest.version,
    artifactSha256: manifest.artifactSha256,
    artifactManifestSha256: manifestSha256,
    artifactPath: manifest.artifactPath,
    artifactSize: manifest.artifactSize,
    packagedShrinkwrapSha256: manifest.packagedShrinkwrapSha256,
    packageFiles: manifest.packageFiles,
  };
}

function canonicalManagedRoot(input: string): string {
  const root = canonicalLocalPath(input, 'managed releases root', true);
  assertPrivateOwnedDirectory(root, 'managed releases root');
  return root;
}

/**
 * Return the lexical executable path through the stable `current` pointer.
 * Callers must not realpath this value before persisting it in a service file.
 */
export function managedProductCurrentExecutablePath(
  managedReleasesRoot: string,
): string {
  return join(
    canonicalManagedRoot(managedReleasesRoot),
    MANAGED_PRODUCT_CURRENT_POINTER,
    ...MANAGED_PRODUCT_EXECUTABLE_RELATIVE_PATH.split('/'),
  );
}

function canonicalReleaseDirectory(root: string, releaseId: string): string {
  assertSafeIdentifier(releaseId, 'release id');
  if (releaseId === MANAGED_PRODUCT_CURRENT_POINTER) {
    throw new Error('release id may not be the stable current pointer name');
  }
  const releaseDirectory = canonicalLocalPath(
    join(root, releaseId),
    'managed release directory',
    true,
  );
  if (dirname(releaseDirectory) !== root) {
    throw new Error('managed release must be a direct child of its managed root');
  }
  assertDirectory(releaseDirectory, 'managed release directory');
  assertOwned(lstatSync(releaseDirectory), 'managed release directory');
  return releaseDirectory;
}

function assertOwned(state: Stats, label: string): void {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || state.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function safeSymlinkTarget(
  releaseDirectory: string,
  symlinkPath: string,
  target: string,
): void {
  if (
    target.length === 0 ||
    target.includes('\0') ||
    target.includes('\\') ||
    isAbsolute(target)
  ) {
    throw new Error('release symlink target must be a relative POSIX path');
  }
  const resolvedLexically = resolve(dirname(symlinkPath), target);
  if (!pathIsWithin(resolvedLexically, releaseDirectory)) {
    throw new Error('release symlink escapes the managed release');
  }
  let resolvedActually: string;
  try {
    resolvedActually = realpathSync(symlinkPath);
  } catch {
    throw new Error('release symlink must resolve to an existing entry');
  }
  if (!pathIsWithin(resolvedActually, releaseDirectory)) {
    throw new Error('release symlink resolves outside the managed release');
  }
}

function collectTreeEntries(
  releaseDirectory: string,
  excludeManifest: boolean,
): ManagedProductReleaseTreeEntry[] {
  const entries: ManagedProductReleaseTreeEntry[] = [];
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right)),
    )) {
      const absolutePath = join(directory, name);
      const path = relative(releaseDirectory, absolutePath).split(sep).join('/');
      if (excludeManifest && path === MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST) {
        continue;
      }
      assertSafeRelativePath(path, 'deployed tree path');
      const state = lstatSync(absolutePath);
      assertOwned(state, `release entry ${path}`);
      if (state.isSymbolicLink()) {
        const target = readlinkSync(absolutePath);
        safeSymlinkTarget(releaseDirectory, absolutePath, target);
        entries.push({ path, type: 'symlink', target });
      } else if (state.isDirectory()) {
        if (realpathSync(absolutePath) !== absolutePath) {
          throw new Error(`release directory is not canonical: ${path}`);
        }
        entries.push({ path, type: 'directory', mode: state.mode & 0o777 });
        visit(absolutePath);
      } else if (state.isFile()) {
        if (state.nlink !== 1) {
          throw new Error(`release file may not be hard-linked: ${path}`);
        }
        const digest = digestFileNoFollow(absolutePath, `release file ${path}`);
        entries.push({
          path,
          type: 'file',
          mode: digest.mode,
          size: digest.size,
          sha256: digest.sha256,
        });
      } else {
        throw new Error(`release contains an unsupported file type: ${path}`);
      }
    }
  }
  visit(releaseDirectory);
  return entries.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
}

function expectedTopLevelNames(artifactPath: string, sealed: boolean): string[] {
  return [
    ARTIFACT_MANIFEST_PATH,
    artifactPath,
    MANAGED_PRODUCT_PREFIX,
    ...(sealed ? [MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST] : []),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function assertExactTopLevelLayout(
  releaseDirectory: string,
  artifactPath: string,
  sealed: boolean,
): void {
  const actual = readdirSync(releaseDirectory).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  const expected = expectedTopLevelNames(artifactPath, sealed);
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error('managed release has missing or unexpected top-level entries');
  }
  const prefix = join(releaseDirectory, MANAGED_PRODUCT_PREFIX);
  assertDirectory(prefix, 'offline-installed release prefix');
}

function verifyRetainedArtifact(
  releaseDirectory: string,
  artifact: ManagedProductArtifactIdentity,
): string {
  const artifactPath = resolveContainedRelativePath(
    releaseDirectory,
    artifact.artifactPath,
    'retained release artifact path',
  );
  const digest = digestFileNoFollow(artifactPath, 'retained release artifact');
  if (
    digest.size !== artifact.artifactSize ||
    digest.sha256 !== artifact.artifactSha256
  ) {
    throw new Error('retained release artifact does not match its pinned size and checksum');
  }
  return artifactPath;
}

function expectedPackageDirectories(
  files: readonly ArtifactManifestPackageFile[],
): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = dirname(file.path).split(sep).join('/');
    while (directory !== '.') {
      directories.add(directory);
      directory = dirname(directory).split(sep).join('/');
    }
  }
  return [...directories].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
}

function verifyInstalledPackageInventory(
  releaseDirectory: string,
  artifact: ManagedProductArtifactIdentity,
): void {
  const packageRoot = INSTALLED_PRODUCT_PACKAGE_ROOT;
  const packagePrefix = `${packageRoot}/`;
  const entries = collectTreeEntries(releaseDirectory, false)
    .filter((entry) => entry.path.startsWith(packagePrefix))
    .map((entry) => ({
      ...entry,
      path: entry.path.slice(packagePrefix.length),
    }));
  if (entries.some((entry) => entry.type === 'symlink')) {
    throw new Error('installed product package contains a symlink absent from its manifest');
  }
  const actualFiles = entries.filter(
    (entry): entry is ManagedProductReleaseFileEntry => entry.type === 'file',
  );
  const actualDirectories = entries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => entry.path);
  const expectedDirectories = expectedPackageDirectories(artifact.packageFiles);
  if (
    JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories) ||
    actualFiles.length !== artifact.packageFiles.length
  ) {
    throw new Error('installed product package inventory differs from artifact package_files');
  }
  for (let index = 0; index < artifact.packageFiles.length; index += 1) {
    const expected = artifact.packageFiles[index]!;
    const actual = actualFiles[index]!;
    if (
      actual.path !== expected.path ||
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`installed product package byte mismatch: ${expected.path}`);
    }
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function artifactSha512Integrity(artifactPath: string): string {
  const bytes = readFileNoFollow(artifactPath, 'retained release artifact');
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function verifiedArtifactDependency(
  value: unknown,
  retainedArtifactPath: string,
): string {
  const dependency = requireString(value, 'offline install artifact dependency');
  if (!dependency.startsWith('file:')) {
    throw new Error('offline install must bind echo-brain through a file: artifact');
  }
  const referencedPath = canonicalLocalPath(
    dependency.slice('file:'.length),
    'offline install artifact dependency path',
    true,
  );
  if (referencedPath !== retainedArtifactPath) {
    throw new Error('offline install lock does not reference the retained artifact');
  }
  return dependency;
}

function verifyDependencyInstallationLock(
  releaseDirectory: string,
  artifact: ManagedProductArtifactIdentity,
  retainedArtifactPath: string,
): void {
  const installedShrinkwrapPath = resolveContainedRelativePath(
    releaseDirectory,
    INSTALLED_PRODUCT_SHRINKWRAP_PATH,
    'installed product shrinkwrap path',
  );
  const shrinkwrapBytes = readFileNoFollow(
    installedShrinkwrapPath,
    'installed product shrinkwrap',
  );
  if (sha256Bytes(shrinkwrapBytes) !== artifact.packagedShrinkwrapSha256) {
    throw new Error('installed product shrinkwrap does not match the artifact manifest');
  }
  const productLock = requireRecord(
    parseJson(shrinkwrapBytes, 'installed product shrinkwrap'),
    'installed product shrinkwrap',
  );
  const productPackages = requireRecord(
    productLock['packages'],
    'installed product shrinkwrap packages',
  );
  const productMetadata = requireRecord(
    productPackages[''],
    'installed product shrinkwrap root package',
  );
  if (
    productLock['lockfileVersion'] !== 3 ||
    productLock['version'] !== artifact.version ||
    productMetadata['version'] !== artifact.version ||
    productMetadata['name'] !== PRODUCT_PACKAGE_NAME
  ) {
    throw new Error('installed product shrinkwrap identity is invalid');
  }

  const rootPackage = requireRecord(
    parseJson(
      readFileNoFollow(
        resolveContainedRelativePath(
          releaseDirectory,
          INSTALL_ROOT_PACKAGE_PATH,
          'offline install root package path',
        ),
        'offline install root package',
      ),
      'offline install root package',
    ),
    'offline install root package',
  );
  exactKeys(
    rootPackage,
    ['name', 'version', 'private', 'dependencies'],
    'offline install root package',
  );
  if (
    rootPackage['name'] !== 'echo-brain-offline-install' ||
    rootPackage['version'] !== '0.0.0' ||
    rootPackage['private'] !== true
  ) {
    throw new Error('offline install root package identity is invalid');
  }
  const rootDependencies = requireRecord(
    rootPackage['dependencies'],
    'offline install root dependencies',
  );
  exactKeys(rootDependencies, [PRODUCT_PACKAGE_NAME], 'offline install root dependencies');
  const dependency = verifiedArtifactDependency(
    rootDependencies[PRODUCT_PACKAGE_NAME],
    retainedArtifactPath,
  );

  const rootLock = requireRecord(
    parseJson(
      readFileNoFollow(
        resolveContainedRelativePath(
          releaseDirectory,
          INSTALL_ROOT_LOCK_PATH,
          'offline installation lock path',
        ),
        'offline installation lock',
      ),
      'offline installation lock',
    ),
    'offline installation lock',
  );
  const syntheticProduct: JsonRecord = {
    version: artifact.version,
    resolved: dependency,
    integrity: artifactSha512Integrity(retainedArtifactPath),
  };
  for (const key of ['dependencies', 'bin', 'engines'] as const) {
    if (productMetadata[key] !== undefined) {
      syntheticProduct[key] = productMetadata[key];
    }
  }
  const expectedPackages: JsonRecord = {
    '': {
      name: 'echo-brain-offline-install',
      version: '0.0.0',
      dependencies: { [PRODUCT_PACKAGE_NAME]: dependency },
    },
    'node_modules/echo-brain': syntheticProduct,
  };
  for (const [path, entry] of Object.entries(productPackages)) {
    if (path !== '') expectedPackages[path] = entry;
  }
  const expectedRootLock = {
    name: 'echo-brain-offline-install',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: expectedPackages,
  };
  if (!sameJson(rootLock, expectedRootLock)) {
    throw new Error('offline installation lock does not match the packaged dependency lock');
  }
}

function parseInstalledPackage(
  releaseDirectory: string,
  expectedVersion: string,
): void {
  const packagePath = resolveContainedRelativePath(
    releaseDirectory,
    INSTALLED_PRODUCT_PACKAGE_PATH,
    'installed product package path',
  );
  const packageJson = requireRecord(
    parseJson(readFileNoFollow(packagePath, 'installed product package'), 'installed product package'),
    'installed product package',
  );
  if (
    packageJson['name'] !== PRODUCT_PACKAGE_NAME ||
    packageJson['version'] !== expectedVersion
  ) {
    throw new Error('installed product package identity mismatch');
  }
  const bin = requireRecord(packageJson['bin'], 'installed product bin');
  if (bin[PRODUCT_PACKAGE_NAME] !== 'dist/product/cli.js') {
    throw new Error('installed product package does not declare the expected CLI');
  }
}

function assertRunnableExecutable(
  releaseDirectory: string,
  expectedVersion: string,
): string {
  parseInstalledPackage(releaseDirectory, expectedVersion);
  const executablePath = resolveContainedRelativePath(
    releaseDirectory,
    MANAGED_PRODUCT_EXECUTABLE_RELATIVE_PATH,
    'managed product executable path',
  );
  if (!pathEntryExists(executablePath)) {
    throw new Error('offline-installed release is missing the echo-brain executable');
  }
  const expectedTarget = resolveContainedRelativePath(
    releaseDirectory,
    INSTALLED_PRODUCT_CLI_PATH,
    'installed product CLI path',
  );
  let actualTarget: string;
  try {
    actualTarget = realpathSync(executablePath);
  } catch {
    throw new Error('offline-installed echo-brain executable does not resolve');
  }
  if (actualTarget !== expectedTarget) {
    throw new Error('offline-installed executable does not resolve to the product CLI');
  }
  const targetState = lstatSync(actualTarget);
  if (!targetState.isFile() || (targetState.mode & 0o111) === 0) {
    throw new Error('offline-installed product CLI must be an executable regular file');
  }
  return executablePath;
}

function sealEntryTree(releaseDirectory: string): void {
  function visit(directory: string): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const state = lstatSync(path);
      if (state.isSymbolicLink()) continue;
      if (state.isDirectory()) {
        visit(path);
        chmodSync(path, 0o555);
      } else if (state.isFile()) {
        chmodSync(path, (state.mode & 0o111) === 0 ? 0o444 : 0o555);
      }
    }
  }
  visit(releaseDirectory);
}

function syncReleaseTree(releaseDirectory: string): void {
  function visit(directory: string): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const state = lstatSync(path);
      if (state.isSymbolicLink()) continue;
      if (state.isDirectory()) {
        visit(path);
        fsyncDirectory(path);
      } else if (state.isFile()) {
        const descriptor = openSync(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
    }
  }
  visit(releaseDirectory);
  fsyncDirectory(releaseDirectory);
}

function assertTreeSealed(
  releaseDirectory: string,
  entries: readonly ManagedProductReleaseTreeEntry[],
): void {
  const rootState = lstatSync(releaseDirectory);
  assertOwned(rootState, 'managed release directory');
  if ((rootState.mode & 0o222) !== 0) {
    throw new Error('managed release directory is writable');
  }
  for (const entry of entries) {
    if (entry.type !== 'symlink' && (entry.mode & 0o222) !== 0) {
      throw new Error(`managed release entry is writable: ${entry.path}`);
    }
  }
}

function serializeTreeEntries(entries: readonly ManagedProductReleaseTreeEntry[]): string {
  return `${JSON.stringify(entries)}\n`;
}

function buildDeployedTreeManifest(
  releaseId: string,
  artifact: ManagedProductArtifactIdentity,
  entries: ManagedProductReleaseTreeEntry[],
): ManagedProductDeployedTreeManifest {
  return {
    schema_version: 1,
    kind: 'echo-product-managed-release',
    release_id: releaseId,
    prefix_path: MANAGED_PRODUCT_PREFIX,
    executable_path: MANAGED_PRODUCT_EXECUTABLE_RELATIVE_PATH,
    artifact: {
      package: artifact.package,
      source_sha: artifact.sourceSha,
      version: artifact.version,
      path: artifact.artifactPath,
      size: artifact.artifactSize,
      sha256: artifact.artifactSha256,
      manifest_path: ARTIFACT_MANIFEST_PATH,
      manifest_sha256: artifact.artifactManifestSha256,
      packaged_shrinkwrap_sha256: artifact.packagedShrinkwrapSha256,
    },
    qualification_report: null,
    deployed_tree: {
      digest_sha256: sha256Bytes(serializeTreeEntries(entries)),
      entries,
    },
  };
}

function parseTreeEntry(value: unknown, index: number): ManagedProductReleaseTreeEntry {
  const entry = requireRecord(value, `deployed tree entry ${index}`);
  const path = requireString(entry['path'], 'deployed tree entry path');
  assertSafeRelativePath(path, 'deployed tree entry path');
  if (entry['type'] === 'file') {
    exactKeys(entry, ['path', 'type', 'mode', 'size', 'sha256'], 'deployed file entry');
    const mode = requireSafeInteger(entry['mode'], 'deployed file mode');
    if (mode > 0o777) throw new Error('deployed file mode is invalid');
    const size = requireSafeInteger(entry['size'], 'deployed file size');
    const sha256 = requireString(entry['sha256'], 'deployed file checksum');
    assertSha256(sha256, 'deployed file checksum');
    return { path, type: 'file', mode, size, sha256 };
  }
  if (entry['type'] === 'directory') {
    exactKeys(entry, ['path', 'type', 'mode'], 'deployed directory entry');
    const mode = requireSafeInteger(entry['mode'], 'deployed directory mode');
    if (mode > 0o777) throw new Error('deployed directory mode is invalid');
    return { path, type: 'directory', mode };
  }
  if (entry['type'] === 'symlink') {
    exactKeys(entry, ['path', 'type', 'target'], 'deployed symlink entry');
    return {
      path,
      type: 'symlink',
      target: requireString(entry['target'], 'deployed symlink target'),
    };
  }
  throw new Error('deployed tree entry type is invalid');
}

function parseDeployedTreeManifest(
  bytes: Buffer,
): ManagedProductDeployedTreeManifest {
  const manifest = requireRecord(
    parseJson(bytes, 'deployed tree manifest'),
    'deployed tree manifest',
  );
  exactKeys(
    manifest,
    [
      'schema_version',
      'kind',
      'release_id',
      'prefix_path',
      'executable_path',
      'artifact',
      'qualification_report',
      'deployed_tree',
    ],
    'deployed tree manifest v1',
  );
  if (manifest['schema_version'] !== 1) {
    throw new Error('deployed tree manifest schema_version must be exactly 1');
  }
  if (manifest['kind'] !== 'echo-product-managed-release') {
    throw new Error('deployed tree manifest kind is invalid');
  }
  const releaseId = requireString(manifest['release_id'], 'deployed release id');
  assertSafeIdentifier(releaseId, 'deployed release id');
  if (
    manifest['prefix_path'] !== MANAGED_PRODUCT_PREFIX ||
    manifest['executable_path'] !== MANAGED_PRODUCT_EXECUTABLE_RELATIVE_PATH
  ) {
    throw new Error('deployed release paths are not the fixed v1 layout');
  }

  const artifact = requireRecord(manifest['artifact'], 'deployed artifact identity');
  exactKeys(
    artifact,
    [
      'package',
      'source_sha',
      'version',
      'path',
      'size',
      'sha256',
      'manifest_path',
      'manifest_sha256',
      'packaged_shrinkwrap_sha256',
    ],
    'deployed artifact identity',
  );
  if (
    artifact['package'] !== PRODUCT_PACKAGE_NAME ||
    artifact['manifest_path'] !== ARTIFACT_MANIFEST_PATH
  ) {
    throw new Error('deployed artifact package or manifest path is invalid');
  }
  const sourceSha = requireString(artifact['source_sha'], 'deployed source SHA');
  const version = requireString(artifact['version'], 'deployed version');
  const artifactPath = requireString(artifact['path'], 'deployed artifact path');
  assertSafeRelativePath(artifactPath, 'deployed artifact path');
  if (artifactPath.includes('/') || !artifactPath.endsWith('.tgz')) {
    throw new Error('deployed artifact path is invalid');
  }
  const artifactSize = requireSafeInteger(artifact['size'], 'deployed artifact size');
  const artifactSha256 = requireString(artifact['sha256'], 'deployed artifact checksum');
  const artifactManifestSha256 = requireString(
    artifact['manifest_sha256'],
    'deployed artifact manifest checksum',
  );
  assertSourceSha(sourceSha, 'deployed source SHA');
  assertVersion(version, 'deployed version');
  assertSha256(artifactSha256, 'deployed artifact checksum');
  assertSha256(artifactManifestSha256, 'deployed artifact manifest checksum');
  const packagedShrinkwrapSha256 = requireString(
    artifact['packaged_shrinkwrap_sha256'],
    'deployed packaged shrinkwrap checksum',
  );
  assertSha256(
    packagedShrinkwrapSha256,
    'deployed packaged shrinkwrap checksum',
  );
  if (manifest['qualification_report'] !== null) {
    throw new Error('managed release v1 cannot claim unauthenticated qualification');
  }

  const deployedTree = requireRecord(manifest['deployed_tree'], 'deployed tree');
  exactKeys(deployedTree, ['digest_sha256', 'entries'], 'deployed tree');
  const digestSha256 = requireString(
    deployedTree['digest_sha256'],
    'deployed tree digest',
  );
  assertSha256(digestSha256, 'deployed tree digest');
  if (!Array.isArray(deployedTree['entries']) || deployedTree['entries'].length === 0) {
    throw new Error('deployed tree entries must be a non-empty array');
  }
  const entries = deployedTree['entries'].map(parseTreeEntry);
  let previousPath: string | null = null;
  for (const entry of entries) {
    if (
      previousPath !== null &&
      Buffer.from(previousPath).compare(Buffer.from(entry.path)) >= 0
    ) {
      throw new Error('deployed tree entries must be uniquely byte-sorted');
    }
    previousPath = entry.path;
  }

  return {
    schema_version: 1,
    kind: 'echo-product-managed-release',
    release_id: releaseId,
    prefix_path: MANAGED_PRODUCT_PREFIX,
    executable_path: MANAGED_PRODUCT_EXECUTABLE_RELATIVE_PATH,
    artifact: {
      package: PRODUCT_PACKAGE_NAME,
      source_sha: sourceSha,
      version,
      path: artifactPath,
      size: artifactSize,
      sha256: artifactSha256,
      manifest_path: ARTIFACT_MANIFEST_PATH,
      manifest_sha256: artifactManifestSha256,
      packaged_shrinkwrap_sha256: packagedShrinkwrapSha256,
    },
    qualification_report: null,
    deployed_tree: { digest_sha256: digestSha256, entries },
  };
}

/**
 * Seal an already offline-installed direct-child release and write its complete
 * deployed-tree manifest. This function does not install or extract packages.
 */
export function prepareManagedProductRelease(
  options: PrepareManagedProductReleaseOptions,
): PreparedManagedProductRelease {
  assertExpectedIdentity(
    options.expectedSourceSha,
    options.expectedVersion,
    options.expectedArtifactSha256,
    options.expectedArtifactManifestSha256,
  );
  const root = canonicalManagedRoot(options.managedReleasesRoot);
  const releaseDirectory = canonicalReleaseDirectory(root, options.releaseId);
  if (pathEntryExists(join(releaseDirectory, MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST))) {
    throw new Error('managed release already has a deployed-tree manifest');
  }
  const artifact = artifactIdentityFromFile(
    releaseDirectory,
    options.expectedSourceSha,
    options.expectedVersion,
    options.expectedArtifactSha256,
    options.expectedArtifactManifestSha256,
  );
  assertExactTopLevelLayout(releaseDirectory, artifact.artifactPath, false);
  collectTreeEntries(releaseDirectory, false);
  const retainedArtifactPath = verifyRetainedArtifact(
    releaseDirectory,
    artifact,
  );
  verifyInstalledPackageInventory(releaseDirectory, artifact);
  verifyDependencyInstallationLock(
    releaseDirectory,
    artifact,
    retainedArtifactPath,
  );
  assertRunnableExecutable(releaseDirectory, options.expectedVersion);

  sealEntryTree(releaseDirectory);
  const entries = collectTreeEntries(releaseDirectory, false);
  const manifest = buildDeployedTreeManifest(options.releaseId, artifact, entries);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = join(
    releaseDirectory,
    MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST,
  );
  writeFileExclusive(manifestPath, manifestBytes, 0o444);
  syncReleaseTree(releaseDirectory);
  chmodSync(releaseDirectory, 0o555);
  fsyncDirectory(releaseDirectory);
  fsyncDirectory(root);

  const pin: ManagedProductReleasePin = {
    sourceSha: options.expectedSourceSha,
    version: options.expectedVersion,
    artifactSha256: options.expectedArtifactSha256,
    artifactManifestSha256: options.expectedArtifactManifestSha256,
    deployedTreeManifestSha256: sha256Bytes(manifestBytes),
    qualificationReport: null,
  };
  return verifyManagedProductRelease({
    managedReleasesRoot: root,
    releaseId: options.releaseId,
    expected: pin,
  });
}

/** Verify the exact, sealed, runnable deployed bytes selected by a release pin. */
export function verifyManagedProductRelease(
  options: VerifyManagedProductReleaseOptions,
): VerifiedManagedProductRelease {
  assertExpectedIdentity(
    options.expected.sourceSha,
    options.expected.version,
    options.expected.artifactSha256,
    options.expected.artifactManifestSha256,
  );
  assertSha256(
    options.expected.deployedTreeManifestSha256,
    'expected deployed tree manifest checksum',
  );
  if (options.expected.qualificationReport !== null) {
    throw new Error('managed release v1 cannot claim unauthenticated qualification');
  }
  const root = canonicalManagedRoot(options.managedReleasesRoot);
  const releaseDirectory = canonicalReleaseDirectory(root, options.releaseId);

  const manifestBytes = readFileNoFollow(
    join(releaseDirectory, MANAGED_PRODUCT_DEPLOYED_TREE_MANIFEST),
    'deployed tree manifest',
  );
  const deployedTreeManifestSha256 = sha256Bytes(manifestBytes);
  if (
    deployedTreeManifestSha256 !==
    options.expected.deployedTreeManifestSha256
  ) {
    throw new Error('deployed tree manifest checksum does not match the release pin');
  }
  const manifest = parseDeployedTreeManifest(manifestBytes);
  if (manifest.release_id !== options.releaseId) {
    throw new Error('deployed tree manifest release id mismatch');
  }
  const artifact = artifactIdentityFromFile(
    releaseDirectory,
    options.expected.sourceSha,
    options.expected.version,
    options.expected.artifactSha256,
    options.expected.artifactManifestSha256,
  );
  assertExactTopLevelLayout(releaseDirectory, artifact.artifactPath, true);
  if (
    manifest.artifact.package !== artifact.package ||
    manifest.artifact.source_sha !== artifact.sourceSha ||
    manifest.artifact.version !== artifact.version ||
    manifest.artifact.path !== artifact.artifactPath ||
    manifest.artifact.size !== artifact.artifactSize ||
    manifest.artifact.sha256 !== artifact.artifactSha256 ||
    manifest.artifact.manifest_sha256 !== artifact.artifactManifestSha256 ||
    manifest.artifact.packaged_shrinkwrap_sha256 !==
      artifact.packagedShrinkwrapSha256
  ) {
    throw new Error('deployed tree artifact identity mismatch');
  }
  const retainedArtifactPath = verifyRetainedArtifact(
    releaseDirectory,
    artifact,
  );
  verifyInstalledPackageInventory(releaseDirectory, artifact);
  verifyDependencyInstallationLock(
    releaseDirectory,
    artifact,
    retainedArtifactPath,
  );

  const actualEntries = collectTreeEntries(releaseDirectory, true);
  if (
    manifest.deployed_tree.digest_sha256 !==
      sha256Bytes(serializeTreeEntries(manifest.deployed_tree.entries)) ||
    JSON.stringify(manifest.deployed_tree.entries) !==
      JSON.stringify(actualEntries) ||
    manifest.deployed_tree.digest_sha256 !==
      sha256Bytes(serializeTreeEntries(actualEntries))
  ) {
    throw new Error('deployed release tree does not match its complete manifest');
  }
  assertTreeSealed(releaseDirectory, actualEntries);
  const executablePath = assertRunnableExecutable(
    releaseDirectory,
    options.expected.version,
  );
  const pin: ManagedProductReleasePin = {
    ...options.expected,
    qualificationReport: null,
  };
  return {
    releaseDirectory,
    executablePath,
    artifact,
    manifest,
    deployedTreeManifestSha256,
    pin,
  };
}

function currentPointerTarget(root: string): string | null {
  const pointerPath = join(root, MANAGED_PRODUCT_CURRENT_POINTER);
  if (!pathEntryExists(pointerPath)) return null;
  const state = lstatSync(pointerPath);
  if (!state.isSymbolicLink()) {
    throw new Error('managed current pointer must be a symlink or absent');
  }
  const target = readlinkSync(pointerPath);
  assertSafeIdentifier(target, 'managed current pointer target');
  const targetDirectory = join(root, target);
  if (!pathEntryExists(targetDirectory)) {
    throw new Error('managed current pointer target does not exist');
  }
  assertDirectory(targetDirectory, 'managed current pointer target');
  return target;
}

function pointerStagingPath(root: string, operationId: string, suffix = ''): string {
  return join(root, `.release-pointer-${operationId}${suffix}.tmp`);
}

function atomicSetCurrentPointer(
  root: string,
  target: string,
  operationId: string,
  suffix = '',
): void {
  const pointerPath = join(root, MANAGED_PRODUCT_CURRENT_POINTER);
  const temporaryPointer = pointerStagingPath(root, operationId, suffix);
  if (pathEntryExists(temporaryPointer)) {
    throw new Error('managed pointer staging path already exists');
  }
  symlinkSync(target, temporaryPointer, 'dir');
  try {
    if (readlinkSync(temporaryPointer) !== target) {
      throw new Error('managed pointer staging verification failed');
    }
    renameSync(temporaryPointer, pointerPath);
    fsyncDirectory(root);
  } finally {
    if (pathEntryExists(temporaryPointer)) {
      unlinkSync(temporaryPointer);
      fsyncDirectory(root);
    }
  }
}

function removeCurrentPointer(root: string): void {
  const pointerPath = join(root, MANAGED_PRODUCT_CURRENT_POINTER);
  if (!pathEntryExists(pointerPath)) return;
  if (!lstatSync(pointerPath).isSymbolicLink()) {
    throw new Error('refusing to remove a non-symlink managed current pointer');
  }
  unlinkSync(pointerPath);
  fsyncDirectory(root);
}

function markerPathFor(root: string, operationId: string): string {
  return join(root, `.release-switch-${operationId}.json`);
}

function serializeMarker(marker: ManagedReleaseSwitchMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

function parseSwitchMarker(bytes: Buffer): ManagedReleaseSwitchMarker {
  const value = requireRecord(
    parseJson(bytes, 'release switch marker'),
    'release switch marker',
  );
  exactKeys(
    value,
    [
      'schema_version',
      'kind',
      'operation_id',
      'switched_at',
      'phase',
      'previous_release_id',
      'release_id',
      'source_sha',
      'version',
      'artifact_sha256',
      'artifact_manifest_sha256',
      'deployed_tree_manifest_sha256',
      'qualification_report_sha256',
      'failure_stage',
    ],
    'release switch marker v1',
  );
  if (
    value['schema_version'] !== 1 ||
    value['kind'] !== 'echo-product-release-switch'
  ) {
    throw new Error('release switch marker must use the exact v1 schema and kind');
  }
  const operationId = requireString(value['operation_id'], 'marker operation id');
  const switchedAt = requireString(value['switched_at'], 'marker switched at');
  const releaseId = requireString(value['release_id'], 'marker release id');
  const sourceSha = requireString(value['source_sha'], 'marker source SHA');
  const version = requireString(value['version'], 'marker version');
  const artifactSha256 = requireString(
    value['artifact_sha256'],
    'marker artifact checksum',
  );
  const artifactManifestSha256 = requireString(
    value['artifact_manifest_sha256'],
    'marker artifact manifest checksum',
  );
  const deployedTreeManifestSha256 = requireString(
    value['deployed_tree_manifest_sha256'],
    'marker deployed tree manifest checksum',
  );
  assertSafeIdentifier(operationId, 'marker operation id');
  assertIsoInstant(switchedAt);
  assertSafeIdentifier(releaseId, 'marker release id');
  assertSourceSha(sourceSha, 'marker source SHA');
  assertVersion(version, 'marker version');
  assertSha256(artifactSha256, 'marker artifact checksum');
  assertSha256(artifactManifestSha256, 'marker artifact manifest checksum');
  assertSha256(
    deployedTreeManifestSha256,
    'marker deployed tree manifest checksum',
  );
  const previousReleaseId =
    value['previous_release_id'] === null
      ? null
      : requireString(value['previous_release_id'], 'marker previous release id');
  if (previousReleaseId !== null) {
    assertSafeIdentifier(
      previousReleaseId,
      'marker previous release id',
    );
  }
  const phase = value['phase'];
  if (
    phase !== 'prepared' &&
    phase !== 'committed' &&
    phase !== 'reverted' &&
    phase !== 'revert-failed'
  ) {
    throw new Error('release switch marker phase is invalid');
  }
  if (value['qualification_report_sha256'] !== null) {
    throw new Error('release switch marker cannot claim unauthenticated qualification');
  }
  const failureStage = value['failure_stage'];
  if (failureStage !== null && typeof failureStage !== 'string') {
    throw new Error('release switch marker failure stage is invalid');
  }
  return {
    schema_version: 1,
    kind: 'echo-product-release-switch',
    operation_id: operationId,
    switched_at: switchedAt,
    phase,
    previous_release_id: previousReleaseId,
    release_id: releaseId,
    source_sha: sourceSha,
    version,
    artifact_sha256: artifactSha256,
    artifact_manifest_sha256: artifactManifestSha256,
    deployed_tree_manifest_sha256: deployedTreeManifestSha256,
    qualification_report_sha256: null,
    failure_stage: failureStage,
  };
}

function readSwitchMarker(path: string): ManagedReleaseSwitchMarker {
  return parseSwitchMarker(readFileNoFollow(path, 'release switch marker'));
}

function assertNoIncompleteSwitchMarkers(root: string): void {
  for (const name of readdirSync(root)) {
    if (!name.startsWith('.release-switch-') || !name.endsWith('.json')) continue;
    const marker = readSwitchMarker(join(root, name));
    if (marker.phase === 'prepared' || marker.phase === 'revert-failed') {
      throw new Error(
        `incomplete managed release switch ${marker.operation_id} must be recovered first`,
      );
    }
  }
}

function createMarker(path: string, marker: ManagedReleaseSwitchMarker, root: string): void {
  writeFileExclusive(path, serializeMarker(marker), 0o600);
  fsyncDirectory(root);
}

function replaceMarker(
  path: string,
  marker: ManagedReleaseSwitchMarker,
  root: string,
  operationId: string,
): void {
  const temporary = join(root, `.release-switch-${operationId}.marker.tmp`);
  if (pathEntryExists(temporary)) {
    throw new Error('release switch marker staging path already exists');
  }
  writeFileExclusive(temporary, serializeMarker(marker), 0o600);
  try {
    renameSync(temporary, path);
    fsyncDirectory(root);
  } finally {
    if (pathEntryExists(temporary)) {
      unlinkSync(temporary);
      fsyncDirectory(root);
    }
  }
}

function switchMarker(
  options: SwitchManagedProductReleaseOptions,
  previousReleaseId: string | null,
  phase: ManagedReleaseSwitchMarkerPhase,
  failureStage: string | null,
): ManagedReleaseSwitchMarker {
  return {
    schema_version: 1,
    kind: 'echo-product-release-switch',
    operation_id: options.operationId,
    switched_at: options.switchedAt,
    phase,
    previous_release_id: previousReleaseId,
    release_id: options.releaseId,
    source_sha: options.expected.sourceSha,
    version: options.expected.version,
    artifact_sha256: options.expected.artifactSha256,
    artifact_manifest_sha256: options.expected.artifactManifestSha256,
    deployed_tree_manifest_sha256:
      options.expected.deployedTreeManifestSha256,
    qualification_report_sha256: null,
    failure_stage: failureStage,
  };
}

function switchEvidence(
  options: SwitchManagedProductReleaseOptions,
  previousReleaseId: string | null,
  switched: boolean,
  marker: ManagedReleaseSwitchMarker | null,
): ReleasePointerSwitchEvidence {
  return {
    operation: 'release-pointer-switch',
    operation_id: options.operationId,
    switched_at: options.switchedAt,
    switched,
    previous_release_id: previousReleaseId,
    release_id: options.releaseId,
    source_sha: options.expected.sourceSha,
    version: options.expected.version,
    artifact_sha256: options.expected.artifactSha256,
    artifact_manifest_sha256: options.expected.artifactManifestSha256,
    deployed_tree_manifest_sha256:
      options.expected.deployedTreeManifestSha256,
    qualification_report_sha256: null,
    marker_sha256: marker === null ? null : sha256Bytes(serializeMarker(marker)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restorePreviousPointer(
  root: string,
  previousReleaseId: string | null,
  candidateReleaseId: string,
  operationId: string,
): void {
  const current = currentPointerTarget(root);
  if (current === previousReleaseId) return;
  if (current !== candidateReleaseId) {
    throw new Error('current pointer changed unexpectedly; refusing an unsafe revert');
  }
  if (previousReleaseId === null) {
    removeCurrentPointer(root);
  } else {
    atomicSetCurrentPointer(
      root,
      previousReleaseId,
      operationId,
      '.revert',
    );
  }
  if (currentPointerTarget(root) !== previousReleaseId) {
    throw new Error('managed current pointer did not return to its previous target');
  }
}

/**
 * Reconcile a durable switch journal after process interruption. Prepared and
 * revert-failed operations are restored to their previous pointer; committed
 * and reverted operations are checked but left unchanged.
 */
export function recoverManagedProductReleaseSwitch(
  options: RecoverManagedProductReleaseSwitchOptions,
): RecoveredManagedProductReleaseSwitch {
  assertSafeIdentifier(options.operationId, 'release switch operation id');
  const root = canonicalManagedRoot(options.managedReleasesRoot);
  const markerPath = markerPathFor(root, options.operationId);
  if (!pathEntryExists(markerPath)) {
    throw new Error('release switch recovery marker does not exist');
  }
  let marker = readSwitchMarker(markerPath);
  if (marker.operation_id !== options.operationId) {
    throw new Error('release switch marker operation identity mismatch');
  }
  if (marker.phase === 'committed') {
    if (currentPointerTarget(root) !== marker.release_id) {
      throw new Error('committed release switch pointer does not match its journal');
    }
    return { recovered: false, markerPath, marker };
  }
  if (marker.phase === 'reverted') {
    if (currentPointerTarget(root) !== marker.previous_release_id) {
      throw new Error('reverted release switch pointer does not match its journal');
    }
    return { recovered: false, markerPath, marker };
  }

  let recoveryError: unknown = null;
  try {
    restorePreviousPointer(
      root,
      marker.previous_release_id,
      marker.release_id,
      marker.operation_id,
    );
  } catch (error) {
    recoveryError = error;
  }
  marker = {
    ...marker,
    phase: recoveryError === null ? 'reverted' : 'revert-failed',
    failure_stage: 'journal-recovery',
  };
  let markerUpdated = false;
  let markerError: unknown = null;
  try {
    replaceMarker(markerPath, marker, root, marker.operation_id);
    markerUpdated = true;
  } catch (error) {
    markerError = error;
  }
  if (recoveryError !== null || markerError !== null) {
    const report: ManagedReleaseRevertReport = {
      attempted: true,
      status: recoveryError === null ? 'reverted' : 'failed',
      previousReleaseId: marker.previous_release_id,
      markerPhase: marker.phase,
      markerUpdated,
      error:
        recoveryError === null
          ? `marker update failed: ${errorMessage(markerError)}`
          : errorMessage(recoveryError),
    };
    throw new ManagedProductReleaseSwitchError(
      recoveryError === null
        ? 'managed release pointer recovered but its durable journal update failed'
        : 'managed release switch journal recovery could not restore the previous pointer',
      report,
      { cause: recoveryError ?? markerError },
    );
  }
  return { recovered: true, markerPath, marker };
}

/**
 * Atomically switch the stable `current` symlink to a verified installed
 * release. The caller owns service stop/start, lifecycle locking, state backup,
 * and state compatibility. A durable marker is fsynced before pointer mutation.
 */
export function switchManagedProductRelease(
  options: SwitchManagedProductReleaseOptions,
): SwitchedManagedProductRelease {
  assertSafeIdentifier(options.operationId, 'release switch operation id');
  assertIsoInstant(options.switchedAt);
  const verifiedRelease = verifyManagedProductRelease(options);
  const root = canonicalManagedRoot(options.managedReleasesRoot);
  assertNoIncompleteSwitchMarkers(root);
  const previousReleaseId = currentPointerTarget(root);
  if (previousReleaseId === options.releaseId) {
    return {
      verifiedRelease,
      markerPath: null,
      marker: null,
      evidence: switchEvidence(options, previousReleaseId, false, null),
    };
  }

  const markerPath = markerPathFor(root, options.operationId);
  if (pathEntryExists(markerPath)) {
    throw new Error('release switch operation id already has a durable marker');
  }
  let marker = switchMarker(options, previousReleaseId, 'prepared', null);
  createMarker(markerPath, marker, root);

  let failureStage = 'pointer-switch';
  try {
    atomicSetCurrentPointer(root, options.releaseId, options.operationId);
    options.faultInjector?.('after_pointer_switch');
    failureStage = 'post-switch-verification';
    verifyManagedProductRelease(options);
    if (currentPointerTarget(root) !== options.releaseId) {
      throw new Error('managed current pointer does not select the verified release');
    }
    options.faultInjector?.('after_post_switch_verification');
    failureStage = 'commit-marker';
    marker = switchMarker(options, previousReleaseId, 'committed', null);
    replaceMarker(markerPath, marker, root, options.operationId);
    options.faultInjector?.('after_commit_marker');
    failureStage = 'post-commit-verification';
    if (currentPointerTarget(root) !== options.releaseId) {
      throw new Error('managed current pointer changed after commit');
    }
  } catch (cause) {
    let revertError: unknown = null;
    try {
      options.faultInjector?.('before_pointer_revert');
      restorePreviousPointer(
        root,
        previousReleaseId,
        options.releaseId,
        options.operationId,
      );
    } catch (error) {
      revertError = error;
    }

    marker = switchMarker(
      options,
      previousReleaseId,
      revertError === null ? 'reverted' : 'revert-failed',
      failureStage,
    );
    let markerUpdated = false;
    let markerError: unknown = null;
    try {
      replaceMarker(markerPath, marker, root, options.operationId);
      markerUpdated = true;
    } catch (error) {
      markerError = error;
    }
    const revertStatus = revertError === null ? 'reverted' : 'failed';
    const report: ManagedReleaseRevertReport = {
      attempted: true,
      status: revertStatus,
      previousReleaseId,
      markerPhase: marker.phase,
      markerUpdated,
      error:
        revertError === null
          ? markerError === null
            ? null
            : `marker update failed: ${errorMessage(markerError)}`
          : errorMessage(revertError),
    };
    throw new ManagedProductReleaseSwitchError(
      revertStatus === 'reverted'
        ? 'managed release switch failed after pointer mutation; previous pointer was restored'
        : 'managed release switch failed after pointer mutation and pointer reversion failed',
      report,
      { cause },
    );
  }

  return {
    verifiedRelease,
    markerPath,
    marker,
    evidence: switchEvidence(options, previousReleaseId, true, marker),
  };
}
