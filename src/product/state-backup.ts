import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  assertDirectory,
  assertDisjointPaths,
  assertOwnerControlledDirectory,
  assertPrivateOwnedDirectory,
  assertSafeIdentifier,
  assertSafeRelativePath,
  assertSha256,
  canonicalLocalPath,
  copyFileNoFollow,
  digestFileNoFollow,
  ensureDirectory,
  fsyncDirectory,
  fsyncDirectoryTree,
  pathIsWithin,
  pathEntryExists,
  readFileNoFollow,
  resolveContainedRelativePath,
  secureTreeFiles,
  sha256Bytes,
  writeFileExclusive,
} from './secure-local-files.js';
import {
  acquireProductMaintenanceLease,
  assertProductMaintenanceLease,
  type ProductMaintenanceLease,
} from './lifecycle-lock.js';
import { inspectFounderProvenanceResidue } from './retired-founder-provenance.js';

const BACKUP_MANIFEST = 'backup-manifest.json';
const PRODUCT_DATABASE = 'echo-brain.sqlite';
const SQLITE_AUXILIARY_FILES = new Set([
  `${PRODUCT_DATABASE}-wal`,
  `${PRODUCT_DATABASE}-shm`,
  `${PRODUCT_DATABASE}-journal`,
]);
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RESTORE_TRANSACTION_PREFIX = '.echo-restore-';
const RESTORE_TRANSACTION_SUFFIX = '.transaction.json';
const BACKUP_PREPARATION_SUFFIX = '.creating.transaction.json';

export type StateBackupFileRole = 'sqlite' | 'state';

export interface StateBackupManifestFile {
  path: string;
  role: StateBackupFileRole;
  mode: number;
  size: number;
  sha256: string;
}

export interface StateBackupManifest {
  schema_version: 1;
  kind: 'echo-product-state-backup';
  backup_id: string;
  created_at: string;
  source_state_path_sha256: string;
  canonical_config_sha256: string;
  contains_secrets: true;
  files: StateBackupManifestFile[];
}

export interface StateBackupEvidence {
  operation: 'backup';
  backup_id: string;
  created_at: string;
  source_state_path_sha256: string;
  canonical_config_sha256: string;
  contains_secrets: true;
  manifest_sha256: string;
  file_count: number;
  total_bytes: number;
  reused: boolean;
}

export interface CreateProductStateBackupOptions {
  stateDir: string;
  backupRoot: string;
  backupId: string;
  createdAt: string;
  canonicalConfigSha256: string;
  /** Reuse a caller-held maintenance window; otherwise this operation acquires one. */
  maintenanceLease?: ProductMaintenanceLease;
}

export interface CreatedProductStateBackup {
  backupDirectory: string;
  manifest: StateBackupManifest;
  evidence: StateBackupEvidence;
}

export interface ValidatedProductStateBackup {
  backupDirectory: string;
  manifest: StateBackupManifest;
  manifestSha256: string;
}

export interface RestoreProductStateBackupOptions {
  stateDir: string;
  backupDirectory: string;
  automaticBackupRoot: string;
  operationId: string;
  restoredAt: string;
  preRestoreBackupId: string;
  preRestoreBackupCreatedAt: string;
  canonicalConfigSha256: string;
  /** Reuse a caller-held maintenance window; otherwise this operation acquires one. */
  maintenanceLease?: ProductMaintenanceLease;
  /** Test-only crash hook. A thrown error leaves the durable transaction for retry recovery. */
  faultInjector?: (point: ProductStateRestoreFaultPoint) => void;
}

export type ProductStateRestoreFaultPoint =
  'after_prepare_marker' | 'after_live_replaced' | 'after_stage_promoted';

export interface StateRestoreEvidence {
  operation: 'restore';
  operation_id: string;
  restored_at: string;
  restored_backup_id: string;
  restored_manifest_sha256: string;
  target_state_path_sha256: string;
  canonical_config_sha256: string;
  contains_secrets: true;
  pre_restore_backup: StateBackupEvidence | null;
}

export interface RestoredProductStateBackup {
  evidence: StateRestoreEvidence;
}

interface StateRestoreTransaction {
  schema_version: 1;
  kind: 'echo-product-state-restore-transaction';
  operation_id: string;
  restored_at: string;
  source_backup_id: string;
  source_manifest_sha256: string;
  target_state_path_sha256: string;
  canonical_config_sha256: string;
  pre_restore_backup_id: string;
  pre_restore_backup_created_at: string;
  had_live_state: boolean;
}

interface StateBackupPreparation {
  schema_version: 1;
  kind: 'echo-product-state-backup-preparation';
  backup_id: string;
  created_at: string;
  source_state_path_sha256: string;
  canonical_config_sha256: string;
}

const FOUNDER_RESIDUE_PAYLOAD_ROOTS = ['identity', 'bootstrap/founder-identity'];

/**
 * Manifest paths that would land inside the retired founder identity or
 * bootstrap locations. Detection is path-based only -- restore never parses
 * retired state -- and mirrors the live residue detector, so a payload is
 * refused exactly when restoring it would materialize a fenced state root.
 */
function founderResiduePayloadPaths(
  manifest: StateBackupManifest,
): string[] {
  return manifest.files
    .map((file) => file.path)
    .filter((path) =>
      FOUNDER_RESIDUE_PAYLOAD_ROOTS.some(
        (root) => path === root || path.startsWith(`${root}/`),
      ),
    );
}

/**
 * Refuse when a directory involved in restore holds, or cannot be proven free
 * of, retired founder-provenance residue. Inspection is observational, so when
 * this throws nothing has been renamed, deleted, staged, or promoted: the
 * residue stays exactly where it was found and `backup` remains the one
 * supported way to preserve it.
 */
function assertFreeOfFounderResidue(directory: string, label: string): void {
  const residue = inspectFounderProvenanceResidue(directory);
  if (!residue.present) return;
  throw new Error(
    `${label} holds retired founder-provenance material and is ` +
      'preservation-only; no restore may modify, recover, or erase it ' +
      `[${residue.findings.join('; ')}]`,
  );
}

function assertPayloadFreeOfFounderResidue(
  manifest: StateBackupManifest,
): void {
  const residue = founderResiduePayloadPaths(manifest);
  if (residue.length === 0) return;
  throw new Error(
    'validated backup payload contains retired founder-provenance material; ' +
      'the mode that produced it is retired, the backup directory itself is ' +
      'left untouched, and no restore may reintroduce it ' +
      `[${residue.join('; ')}]`,
  );
}

function assertIsoInstant(value: string, label: string): void {
  if (!ISO_INSTANT_PATTERN.test(value)) {
    throw new Error(`${label} must be a caller-supplied UTC ISO instant`);
  }
}

function exactKeys(
  value: Record<string, unknown>,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function productStatePathIdentity(canonicalStateDir: string): string {
  return sha256Bytes(`${canonicalStateDir}\n`);
}

function backupEvidence(
  manifest: StateBackupManifest,
  manifestSha256: string,
  reused: boolean,
): StateBackupEvidence {
  return Object.freeze({
    operation: 'backup',
    backup_id: manifest.backup_id,
    created_at: manifest.created_at,
    source_state_path_sha256: manifest.source_state_path_sha256,
    canonical_config_sha256: manifest.canonical_config_sha256,
    contains_secrets: true,
    manifest_sha256: manifestSha256,
    file_count: manifest.files.length,
    total_bytes: manifest.files.reduce((total, file) => total + file.size, 0),
    reused,
  });
}

function parseManifest(bytes: Buffer): StateBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('backup manifest is not valid JSON');
  }
  if (!isRecord(parsed)) throw new Error('backup manifest must be an object');
  exactKeys(
    parsed,
    [
      'schema_version',
      'kind',
      'backup_id',
      'created_at',
      'source_state_path_sha256',
      'canonical_config_sha256',
      'contains_secrets',
      'files',
    ],
    'backup manifest',
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-product-state-backup' ||
    typeof parsed['backup_id'] !== 'string' ||
    typeof parsed['created_at'] !== 'string' ||
    typeof parsed['source_state_path_sha256'] !== 'string' ||
    typeof parsed['canonical_config_sha256'] !== 'string' ||
    parsed['contains_secrets'] !== true ||
    !Array.isArray(parsed['files'])
  ) {
    throw new Error('backup manifest has invalid field types or versions');
  }
  assertSafeIdentifier(parsed['backup_id'], 'backup manifest id');
  assertIsoInstant(parsed['created_at'], 'backup manifest created_at');
  assertSha256(
    parsed['source_state_path_sha256'],
    'source state path identity',
  );
  assertSha256(parsed['canonical_config_sha256'], 'canonical config hash');

  const files: StateBackupManifestFile[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed['files']) {
    if (!isRecord(candidate))
      throw new Error('backup file entry must be an object');
    exactKeys(
      candidate,
      ['path', 'role', 'mode', 'size', 'sha256'],
      'backup file entry',
    );
    if (
      typeof candidate['path'] !== 'string' ||
      (candidate['role'] !== 'sqlite' && candidate['role'] !== 'state') ||
      !Number.isInteger(candidate['mode']) ||
      (candidate['mode'] as number) < 0 ||
      (candidate['mode'] as number) > 0o777 ||
      !Number.isSafeInteger(candidate['size']) ||
      (candidate['size'] as number) < 0 ||
      typeof candidate['sha256'] !== 'string'
    ) {
      throw new Error('backup file entry has invalid fields');
    }
    assertSafeRelativePath(candidate['path'], 'backup file path');
    assertSha256(candidate['sha256'], 'backup file checksum');
    if (candidate['path'] === BACKUP_MANIFEST || seen.has(candidate['path'])) {
      throw new Error(
        'backup manifest contains a duplicate or reserved file path',
      );
    }
    if (
      (candidate['role'] === 'sqlite') !==
      (candidate['path'] === PRODUCT_DATABASE)
    ) {
      throw new Error('SQLite backup role must name only the product database');
    }
    if (SQLITE_AUXILIARY_FILES.has(candidate['path'])) {
      throw new Error('backup manifest may not contain SQLite WAL sidecars');
    }
    seen.add(candidate['path']);
    files.push({
      path: candidate['path'],
      role: candidate['role'],
      mode: candidate['mode'] as number,
      size: candidate['size'] as number,
      sha256: candidate['sha256'],
    });
  }
  const ordered = [...files].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  if (files.some((file, index) => file.path !== ordered[index]!.path)) {
    throw new Error('backup manifest files must be byte-sorted');
  }
  return {
    schema_version: 1,
    kind: 'echo-product-state-backup',
    backup_id: parsed['backup_id'],
    created_at: parsed['created_at'],
    source_state_path_sha256: parsed['source_state_path_sha256'],
    canonical_config_sha256: parsed['canonical_config_sha256'],
    contains_secrets: true,
    files,
  };
}

export function validateProductStateBackup(
  backupDirectory: string,
): ValidatedProductStateBackup {
  const canonicalBackup = canonicalLocalPath(
    backupDirectory,
    'backup directory',
    true,
  );
  assertPrivateOwnedDirectory(dirname(canonicalBackup), 'backup root');
  assertPrivateOwnedDirectory(canonicalBackup, 'backup directory');
  const manifestPath = join(canonicalBackup, BACKUP_MANIFEST);
  const manifestBytes = readFileNoFollow(manifestPath, 'backup manifest');
  const manifest = parseManifest(manifestBytes);
  if (basename(canonicalBackup) !== manifest.backup_id) {
    throw new Error('backup directory identity does not match its manifest');
  }

  const actual = secureTreeFiles(canonicalBackup);
  const expectedPaths = new Set([
    BACKUP_MANIFEST,
    ...manifest.files.map((file) => file.path),
  ]);
  if (
    actual.length !== expectedPaths.size ||
    actual.some((file) => !expectedPaths.has(file.relativePath))
  ) {
    throw new Error('backup directory contains missing or unmanifested files');
  }
  const byPath = new Map(actual.map((file) => [file.relativePath, file]));
  const manifestRecord = byPath.get(BACKUP_MANIFEST);
  if (manifestRecord === undefined || manifestRecord.mode !== 0o600) {
    throw new Error('backup manifest must be a private owner-only file');
  }
  for (const expected of manifest.files) {
    const found = byPath.get(expected.path);
    if (
      found === undefined ||
      found.mode !== expected.mode ||
      found.size !== expected.size ||
      found.sha256 !== expected.sha256
    ) {
      throw new Error(`backup file failed verification: ${expected.path}`);
    }
  }
  if (manifest.files.some((file) => file.role === 'sqlite')) {
    assertSqliteQuickCheck(
      join(canonicalBackup, PRODUCT_DATABASE),
      'validated SQLite backup',
    );
  }
  return {
    backupDirectory: canonicalBackup,
    manifest,
    manifestSha256: sha256Bytes(manifestBytes),
  };
}

function assertSqliteQuickCheck(path: string, label: string): void {
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    const rows = database.pragma('quick_check') as Array<
      Record<string, unknown>
    >;
    if (
      rows.length !== 1 ||
      Object.values(rows[0] ?? {}).length !== 1 ||
      Object.values(rows[0] ?? {})[0] !== 'ok'
    ) {
      throw new Error('integrity result was not ok');
    }
  } catch {
    throw new Error(`${label} failed SQLite quick_check`);
  } finally {
    database?.close();
  }
  for (const sidecar of SQLITE_AUXILIARY_FILES) {
    if (pathEntryExists(join(dirname(path), sidecar))) {
      throw new Error(
        `${label} created or depends on a forbidden SQLite sidecar`,
      );
    }
  }
}

function assertRequestedBackupIdentity(
  validated: ValidatedProductStateBackup,
  options: CreateProductStateBackupOptions,
  statePathIdentity: string,
): void {
  const manifest = validated.manifest;
  if (
    manifest.backup_id !== options.backupId ||
    manifest.created_at !== options.createdAt ||
    manifest.source_state_path_sha256 !== statePathIdentity ||
    manifest.canonical_config_sha256 !== options.canonicalConfigSha256
  ) {
    throw new Error(
      'existing backup id belongs to a different backup operation',
    );
  }
}

function backupPreparationPath(backupRoot: string, backupId: string): string {
  return join(backupRoot, `.${backupId}${BACKUP_PREPARATION_SUFFIX}`);
}

function expectedBackupPreparation(
  options: CreateProductStateBackupOptions,
  statePathIdentity: string,
): StateBackupPreparation {
  return {
    schema_version: 1,
    kind: 'echo-product-state-backup-preparation',
    backup_id: options.backupId,
    created_at: options.createdAt,
    source_state_path_sha256: statePathIdentity,
    canonical_config_sha256: options.canonicalConfigSha256,
  };
}

function readBackupPreparation(path: string): StateBackupPreparation {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileNoFollow(path, 'backup preparation').toString('utf8'),
    );
  } catch (error) {
    throw new Error(
      `backup preparation is invalid: ${(error as Error).message}`,
    );
  }
  if (!isRecord(value)) throw new Error('backup preparation must be an object');
  exactKeys(
    value,
    [
      'schema_version',
      'kind',
      'backup_id',
      'created_at',
      'source_state_path_sha256',
      'canonical_config_sha256',
    ],
    'backup preparation',
  );
  if (
    value['schema_version'] !== 1 ||
    value['kind'] !== 'echo-product-state-backup-preparation' ||
    typeof value['backup_id'] !== 'string' ||
    typeof value['created_at'] !== 'string' ||
    typeof value['source_state_path_sha256'] !== 'string' ||
    typeof value['canonical_config_sha256'] !== 'string'
  ) {
    throw new Error('backup preparation has invalid fields');
  }
  assertSafeIdentifier(value['backup_id'], 'backup preparation id');
  assertIsoInstant(value['created_at'], 'backup preparation created_at');
  assertSha256(
    value['source_state_path_sha256'],
    'backup preparation state identity',
  );
  assertSha256(
    value['canonical_config_sha256'],
    'backup preparation config hash',
  );
  return value as unknown as StateBackupPreparation;
}

function assertMatchingBackupPreparation(
  actual: StateBackupPreparation,
  expected: StateBackupPreparation,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'incomplete backup staging belongs to a different backup operation',
    );
  }
}

async function backupSqlite(
  source: string,
  destination: string,
): Promise<StateBackupManifestFile> {
  const sourceState = lstatSync(source);
  if (sourceState.isSymbolicLink() || !sourceState.isFile()) {
    throw new Error('product database must be a regular file, not a symlink');
  }
  const database = new Database(source, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
  // SQLite persists WAL mode in the database header. A backup snapshot has no
  // WAL dependency, so normalize it to DELETE mode before sealing it; otherwise
  // a later read can create unmanifested -wal/-shm files inside the backup.
  const snapshot = new Database(destination);
  try {
    snapshot.pragma('journal_mode = DELETE');
    snapshot.pragma('synchronous = FULL');
  } finally {
    snapshot.close();
  }
  chmodSync(destination, 0o600);
  assertSqliteQuickCheck(destination, 'created SQLite backup');
  const digest = digestFileNoFollow(destination, 'SQLite backup');
  return {
    path: PRODUCT_DATABASE,
    role: 'sqlite',
    mode: 0o600,
    size: digest.size,
    sha256: digest.sha256,
  };
}

export async function createProductStateBackup(
  options: CreateProductStateBackupOptions,
): Promise<CreatedProductStateBackup> {
  if (options.maintenanceLease === undefined) {
    const lease = await acquireProductMaintenanceLease(options.stateDir);
    try {
      return await createProductStateBackup({
        ...options,
        maintenanceLease: lease,
      });
    } finally {
      await lease.release();
    }
  }
  assertProductMaintenanceLease(options.maintenanceLease, options.stateDir);
  assertSafeIdentifier(options.backupId, 'backup id');
  assertIsoInstant(options.createdAt, 'backup createdAt');
  assertSha256(options.canonicalConfigSha256, 'canonical config hash');

  const stateDir = canonicalLocalPath(
    options.stateDir,
    'state directory',
    true,
  );
  assertDirectory(stateDir, 'state directory');
  const requestedBackupRoot = canonicalLocalPath(
    options.backupRoot,
    'backup root',
    false,
  );
  assertDisjointPaths(
    stateDir,
    requestedBackupRoot,
    'state directory',
    'backup root',
  );
  ensureDirectory(requestedBackupRoot);
  const backupRoot = canonicalLocalPath(
    requestedBackupRoot,
    'backup root',
    true,
  );
  assertPrivateOwnedDirectory(backupRoot, 'backup root');

  const statePathIdentity = productStatePathIdentity(stateDir);
  const finalDirectory = join(backupRoot, options.backupId);
  const temporaryDirectory = join(backupRoot, `.${options.backupId}.creating`);
  const preparationPath = backupPreparationPath(backupRoot, options.backupId);
  const expectedPreparation = expectedBackupPreparation(
    options,
    statePathIdentity,
  );
  if (pathEntryExists(finalDirectory)) {
    const validated = validateProductStateBackup(finalDirectory);
    assertRequestedBackupIdentity(validated, options, statePathIdentity);
    if (pathEntryExists(temporaryDirectory)) {
      throw new Error('committed backup has unexpected staging content');
    }
    if (pathEntryExists(preparationPath)) {
      assertMatchingBackupPreparation(
        readBackupPreparation(preparationPath),
        expectedPreparation,
      );
      rmSync(preparationPath, { force: true });
      fsyncDirectory(backupRoot);
    }
    return {
      backupDirectory: finalDirectory,
      manifest: validated.manifest,
      evidence: backupEvidence(
        validated.manifest,
        validated.manifestSha256,
        true,
      ),
    };
  }

  if (pathEntryExists(preparationPath)) {
    assertMatchingBackupPreparation(
      readBackupPreparation(preparationPath),
      expectedPreparation,
    );
    if (pathEntryExists(temporaryDirectory)) {
      assertDirectory(
        temporaryDirectory,
        'incomplete backup staging directory',
      );
      rmSync(temporaryDirectory, { recursive: true, force: true });
      fsyncDirectory(backupRoot);
    }
    rmSync(preparationPath, { force: true });
    fsyncDirectory(backupRoot);
  } else if (pathEntryExists(temporaryDirectory)) {
    throw new Error(
      'incomplete backup staging directory exists without durable operation identity',
    );
  }
  writeFileExclusive(
    preparationPath,
    `${JSON.stringify(expectedPreparation, null, 2)}\n`,
    0o600,
  );
  fsyncDirectory(backupRoot);
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  fsyncDirectory(backupRoot);
  let committed = false;
  try {
    const allStateFiles = secureTreeFiles(stateDir);
    const databaseRecord = allStateFiles.find(
      (file) => file.relativePath === PRODUCT_DATABASE,
    );
    const hasAuxiliary = allStateFiles.some((file) =>
      SQLITE_AUXILIARY_FILES.has(file.relativePath),
    );
    if (databaseRecord === undefined && hasAuxiliary) {
      throw new Error('SQLite sidecars exist without the product database');
    }

    const files: StateBackupManifestFile[] = [];
    if (databaseRecord !== undefined) {
      files.push(
        await backupSqlite(
          databaseRecord.absolutePath,
          join(temporaryDirectory, PRODUCT_DATABASE),
        ),
      );
    }
    for (const source of allStateFiles) {
      if (
        source.relativePath === PRODUCT_DATABASE ||
        SQLITE_AUXILIARY_FILES.has(source.relativePath)
      ) {
        continue;
      }
      const destination = resolveContainedRelativePath(
        temporaryDirectory,
        source.relativePath,
        'state backup file path',
      );
      ensureDirectory(dirname(destination));
      const copied = copyFileNoFollow(
        source.absolutePath,
        destination,
        'state backup source',
        source.mode,
      );
      if (
        copied.mode !== source.mode ||
        copied.size !== source.size ||
        copied.sha256 !== source.sha256
      ) {
        throw new Error(
          `state file changed during backup: ${source.relativePath}`,
        );
      }
      files.push({
        path: source.relativePath,
        role: 'state',
        mode: copied.mode,
        size: copied.size,
        sha256: copied.sha256,
      });
    }
    files.sort((left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)),
    );
    const manifest: StateBackupManifest = {
      schema_version: 1,
      kind: 'echo-product-state-backup',
      backup_id: options.backupId,
      created_at: options.createdAt,
      source_state_path_sha256: statePathIdentity,
      canonical_config_sha256: options.canonicalConfigSha256,
      contains_secrets: true,
      files,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileExclusive(
      join(temporaryDirectory, BACKUP_MANIFEST),
      manifestBytes,
      0o600,
    );
    fsyncDirectoryTree(temporaryDirectory);
    renameSync(temporaryDirectory, finalDirectory);
    fsyncDirectory(backupRoot);
    rmSync(preparationPath, { force: true });
    fsyncDirectory(backupRoot);
    committed = true;
    return {
      backupDirectory: finalDirectory,
      manifest,
      evidence: backupEvidence(manifest, sha256Bytes(manifestBytes), false),
    };
  } finally {
    if (!committed && pathEntryExists(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    if (!committed && pathEntryExists(preparationPath)) {
      rmSync(preparationPath, { force: true });
      fsyncDirectory(backupRoot);
    }
  }
}

function verifyRestoredStage(
  stageDirectory: string,
  manifest: StateBackupManifest,
): void {
  const actual = secureTreeFiles(stageDirectory);
  if (actual.length !== manifest.files.length) {
    throw new Error('restored state file count does not match backup manifest');
  }
  const byPath = new Map(actual.map((file) => [file.relativePath, file]));
  for (const expected of manifest.files) {
    const found = byPath.get(expected.path);
    if (
      found === undefined ||
      found.mode !== expected.mode ||
      found.size !== expected.size ||
      found.sha256 !== expected.sha256
    ) {
      throw new Error(`restored state failed verification: ${expected.path}`);
    }
  }
  if (manifest.files.some((file) => file.role === 'sqlite')) {
    assertSqliteQuickCheck(
      join(stageDirectory, PRODUCT_DATABASE),
      'restored SQLite backup',
    );
  }
}

function parseRestoreTransaction(bytes: Buffer): StateRestoreTransaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('restore transaction marker is not valid JSON');
  }
  if (!isRecord(parsed))
    throw new Error('restore transaction marker must be an object');
  exactKeys(
    parsed,
    [
      'schema_version',
      'kind',
      'operation_id',
      'restored_at',
      'source_backup_id',
      'source_manifest_sha256',
      'target_state_path_sha256',
      'canonical_config_sha256',
      'pre_restore_backup_id',
      'pre_restore_backup_created_at',
      'had_live_state',
    ],
    'restore transaction marker',
  );
  if (
    parsed['schema_version'] !== 1 ||
    parsed['kind'] !== 'echo-product-state-restore-transaction' ||
    typeof parsed['operation_id'] !== 'string' ||
    typeof parsed['restored_at'] !== 'string' ||
    typeof parsed['source_backup_id'] !== 'string' ||
    typeof parsed['source_manifest_sha256'] !== 'string' ||
    typeof parsed['target_state_path_sha256'] !== 'string' ||
    typeof parsed['canonical_config_sha256'] !== 'string' ||
    typeof parsed['pre_restore_backup_id'] !== 'string' ||
    typeof parsed['pre_restore_backup_created_at'] !== 'string' ||
    typeof parsed['had_live_state'] !== 'boolean'
  ) {
    throw new Error('restore transaction marker has invalid fields');
  }
  assertSafeIdentifier(
    parsed['operation_id'],
    'restore transaction operation id',
  );
  assertSafeIdentifier(
    parsed['source_backup_id'],
    'restore transaction source id',
  );
  assertSafeIdentifier(
    parsed['pre_restore_backup_id'],
    'restore transaction pre-backup id',
  );
  assertIsoInstant(parsed['restored_at'], 'restore transaction restored_at');
  assertIsoInstant(
    parsed['pre_restore_backup_created_at'],
    'restore transaction pre-backup created_at',
  );
  assertSha256(
    parsed['source_manifest_sha256'],
    'restore source manifest hash',
  );
  assertSha256(parsed['target_state_path_sha256'], 'restore target identity');
  assertSha256(parsed['canonical_config_sha256'], 'restore config hash');
  return parsed as unknown as StateRestoreTransaction;
}

interface DiscoveredRestoreTransaction {
  transaction: StateRestoreTransaction;
  markerPath: string;
}

function restoreTransactionMarkerName(operationId: string): string {
  return `${RESTORE_TRANSACTION_PREFIX}${operationId}${RESTORE_TRANSACTION_SUFFIX}`;
}

function discoverRestoreTransaction(
  parent: string,
  targetIdentity: string,
): DiscoveredRestoreTransaction | undefined {
  const matches: DiscoveredRestoreTransaction[] = [];
  for (const name of readdirSync(parent)) {
    if (
      !name.startsWith(RESTORE_TRANSACTION_PREFIX) ||
      !name.endsWith(RESTORE_TRANSACTION_SUFFIX)
    ) {
      continue;
    }
    const markerPath = join(parent, name);
    const digest = digestFileNoFollow(markerPath, 'restore transaction marker');
    if (digest.mode !== 0o600 || digest.size > 64 * 1024) {
      throw new Error(
        'restore transaction marker is not a bounded private owner-only file; stop the service and resolve it before retrying',
      );
    }
    const transaction = parseRestoreTransaction(
      readFileNoFollow(markerPath, 'restore transaction marker'),
    );
    if (name !== restoreTransactionMarkerName(transaction.operation_id)) {
      throw new Error(
        'restore transaction marker filename does not match its identity; stop the service and resolve it before retrying',
      );
    }
    if (transaction.target_state_path_sha256 === targetIdentity) {
      matches.push({ transaction, markerPath });
    }
  }
  if (matches.length > 1) {
    throw new Error(
      'multiple durable restore transactions target this state; recovery is ambiguous; stop the service and resolve the markers before retrying',
    );
  }
  return matches[0];
}

function assertCompatibleRestoreTransaction(
  transaction: StateRestoreTransaction,
  options: RestoreProductStateBackupOptions,
  targetIdentity: string,
): void {
  if (
    transaction.target_state_path_sha256 !== targetIdentity ||
    transaction.canonical_config_sha256 !== options.canonicalConfigSha256
  ) {
    throw new Error(
      'durable restore transaction belongs to a different installation; stop the service and resolve it before retrying',
    );
  }
}

function removePathDurably(path: string, parent: string): void {
  if (pathEntryExists(path)) {
    rmSync(path, { recursive: true, force: true });
    fsyncDirectory(parent);
  }
}

function removeMarkerDurably(markerPath: string, parent: string): void {
  if (pathEntryExists(markerPath)) {
    rmSync(markerPath, { force: true });
    fsyncDirectory(parent);
  }
}

function rollbackReplacedState(
  stateDir: string,
  stageDirectory: string,
  replacedDirectory: string,
  markerPath: string,
  parent: string,
): void {
  removePathDurably(stageDirectory, parent);
  if (pathEntryExists(stateDir)) removePathDurably(stateDir, parent);
  if (!pathEntryExists(replacedDirectory)) {
    throw new Error('interrupted restore has no recoverable replaced state');
  }
  renameSync(replacedDirectory, stateDir);
  fsyncDirectory(parent);
  removeMarkerDurably(markerPath, parent);
}

function restoredEvidence(
  options: RestoreProductStateBackupOptions,
  validated: ValidatedProductStateBackup,
  targetIdentity: string,
  preRestoreBackup: StateBackupEvidence | null,
): RestoredProductStateBackup {
  return {
    evidence: Object.freeze({
      operation: 'restore',
      operation_id: options.operationId,
      restored_at: options.restoredAt,
      restored_backup_id: validated.manifest.backup_id,
      restored_manifest_sha256: validated.manifestSha256,
      target_state_path_sha256: targetIdentity,
      canonical_config_sha256: options.canonicalConfigSha256,
      contains_secrets: true,
      pre_restore_backup: preRestoreBackup,
    }),
  };
}

function recoveredRestoredEvidence(
  transaction: StateRestoreTransaction,
  targetIdentity: string,
  preRestoreBackup: StateBackupEvidence | null,
): RestoredProductStateBackup {
  return {
    evidence: Object.freeze({
      operation: 'restore',
      operation_id: transaction.operation_id,
      restored_at: transaction.restored_at,
      restored_backup_id: transaction.source_backup_id,
      restored_manifest_sha256: transaction.source_manifest_sha256,
      target_state_path_sha256: targetIdentity,
      canonical_config_sha256: transaction.canonical_config_sha256,
      contains_secrets: true,
      pre_restore_backup: preRestoreBackup,
    }),
  };
}

function evidenceForRecoveredPreBackup(
  automaticBackupRoot: string,
  transaction: StateRestoreTransaction,
  targetIdentity: string,
): StateBackupEvidence | null {
  if (!transaction.had_live_state) return null;
  const preBackup = validateProductStateBackup(
    join(automaticBackupRoot, transaction.pre_restore_backup_id),
  );
  if (
    preBackup.manifest.backup_id !== transaction.pre_restore_backup_id ||
    preBackup.manifest.created_at !==
      transaction.pre_restore_backup_created_at ||
    preBackup.manifest.source_state_path_sha256 !== targetIdentity ||
    preBackup.manifest.canonical_config_sha256 !==
      transaction.canonical_config_sha256
  ) {
    throw new Error(
      'recovered pre-restore backup does not match its transaction',
    );
  }
  return backupEvidence(preBackup.manifest, preBackup.manifestSha256, true);
}

export async function restoreProductStateBackup(
  options: RestoreProductStateBackupOptions,
): Promise<RestoredProductStateBackup> {
  if (options.maintenanceLease === undefined) {
    const lease = await acquireProductMaintenanceLease(options.stateDir);
    try {
      return await restoreProductStateBackup({
        ...options,
        maintenanceLease: lease,
      });
    } finally {
      await lease.release();
    }
  }
  assertProductMaintenanceLease(options.maintenanceLease, options.stateDir);
  assertSafeIdentifier(options.operationId, 'restore operation id');
  assertSafeIdentifier(options.preRestoreBackupId, 'pre-restore backup id');
  assertIsoInstant(options.restoredAt, 'restore restoredAt');
  assertIsoInstant(
    options.preRestoreBackupCreatedAt,
    'pre-restore backup createdAt',
  );
  assertSha256(options.canonicalConfigSha256, 'canonical config hash');

  const stateDir = canonicalLocalPath(
    options.stateDir,
    'state directory',
    false,
  );
  if (dirname(stateDir) === stateDir) {
    throw new Error('state directory may not be a filesystem root');
  }
  const targetIdentity = productStatePathIdentity(stateDir);
  const parent = dirname(stateDir);
  assertOwnerControlledDirectory(parent, 'state directory parent');
  // Fail closed first: a live target that holds (or cannot be proven free of)
  // retired founder residue -- including the adjacent cutover guard, which
  // outlives deletion of the root itself -- is preservation-only. This runs
  // before transaction discovery, the pre-restore backup, the durable marker,
  // staging, and any live mutation, and it also refuses to report recovery
  // success over an interrupted older restore that promoted founder state,
  // whether or not that transaction recorded live state to put back.
  assertFreeOfFounderResidue(stateDir, 'restore target state');
  const requestedStageDirectory = join(
    parent,
    `.echo-restore-${options.operationId}.staging`,
  );
  const requestedReplacedDirectory = join(
    parent,
    `.echo-restore-${options.operationId}.replaced`,
  );
  const requestedMarkerPath = join(
    parent,
    restoreTransactionMarkerName(options.operationId),
  );
  let stageDirectory = requestedStageDirectory;
  let replacedDirectory = requestedReplacedDirectory;
  let markerPath = requestedMarkerPath;

  let pendingTransaction: StateRestoreTransaction | undefined;
  const discovered = discoverRestoreTransaction(parent, targetIdentity);
  if (discovered !== undefined) {
    pendingTransaction = discovered.transaction;
    markerPath = discovered.markerPath;
    stageDirectory = join(
      parent,
      `.echo-restore-${pendingTransaction.operation_id}.staging`,
    );
    replacedDirectory = join(
      parent,
      `.echo-restore-${pendingTransaction.operation_id}.replaced`,
    );
    assertCompatibleRestoreTransaction(
      pendingTransaction,
      options,
      targetIdentity,
    );
    const liveExists = pathEntryExists(stateDir);
    const stageExists = pathEntryExists(stageDirectory);
    const replacedExists = pathEntryExists(replacedDirectory);
    // An interrupted restore left by an older binary may hold retired founder
    // state in its staged or replaced directories. Recovery must not rename,
    // delete, or promote that material, so it stops here -- before any
    // recovery mutation -- and leaves the whole topology for manual
    // resolution. The live root itself was swept above.
    if (stageExists) {
      assertFreeOfFounderResidue(
        stageDirectory,
        'interrupted restore staging',
      );
    }
    if (replacedExists) {
      assertFreeOfFounderResidue(
        replacedDirectory,
        'interrupted restore replaced state',
      );
    }

    if (pendingTransaction.had_live_state && !liveExists && replacedExists) {
      rollbackReplacedState(
        stateDir,
        stageDirectory,
        replacedDirectory,
        markerPath,
        parent,
      );
      pendingTransaction = undefined;
    } else if (
      (pendingTransaction.had_live_state &&
        liveExists &&
        stageExists &&
        !replacedExists) ||
      (!pendingTransaction.had_live_state &&
        !liveExists &&
        stageExists &&
        !replacedExists)
    ) {
      removePathDurably(stageDirectory, parent);
      removeMarkerDurably(markerPath, parent);
      pendingTransaction = undefined;
    } else if (
      ((pendingTransaction.had_live_state && liveExists) ||
        (!pendingTransaction.had_live_state && !liveExists)) &&
      !stageExists &&
      !replacedExists
    ) {
      // The durable preparation landed but staging had not begun yet.
      removeMarkerDurably(markerPath, parent);
      pendingTransaction = undefined;
    } else if (!(liveExists && !stageExists)) {
      throw new Error(
        'restore transaction topology is inconsistent; recovery stopped',
      );
    }
  }
  if (pendingTransaction === undefined) {
    stageDirectory = requestedStageDirectory;
    replacedDirectory = requestedReplacedDirectory;
    markerPath = requestedMarkerPath;
  }
  if (
    pendingTransaction === undefined &&
    (pathEntryExists(stageDirectory) || pathEntryExists(replacedDirectory))
  ) {
    throw new Error(
      'restore staging path exists without a durable transaction marker',
    );
  }

  let validated: ValidatedProductStateBackup;
  try {
    validated = validateProductStateBackup(options.backupDirectory);
  } catch (error) {
    if (
      pendingTransaction !== undefined &&
      pathEntryExists(replacedDirectory)
    ) {
      rollbackReplacedState(
        stateDir,
        stageDirectory,
        replacedDirectory,
        markerPath,
        parent,
      );
    }
    throw error;
  }
  if (validated.manifest.source_state_path_sha256 !== targetIdentity) {
    if (
      pendingTransaction !== undefined &&
      pathEntryExists(replacedDirectory)
    ) {
      rollbackReplacedState(
        stateDir,
        stageDirectory,
        replacedDirectory,
        markerPath,
        parent,
      );
    }
    throw new Error('backup belongs to a different state path');
  }
  if (
    validated.manifest.canonical_config_sha256 !== options.canonicalConfigSha256
  ) {
    if (
      pendingTransaction !== undefined &&
      pathEntryExists(replacedDirectory)
    ) {
      rollbackReplacedState(
        stateDir,
        stageDirectory,
        replacedDirectory,
        markerPath,
        parent,
      );
    }
    throw new Error(
      'backup canonical config hash does not match this installation',
    );
  }
  // Refuse the incoming direction on the validated payload's own manifest,
  // still before the pre-restore backup, the durable marker, staging, and any
  // live mutation. A refusal changes nothing, so an interrupted-but-clean
  // topology stays recoverable by retrying with the right source.
  assertPayloadFreeOfFounderResidue(validated.manifest);

  const requestedAutomaticBackupRoot = canonicalLocalPath(
    options.automaticBackupRoot,
    'automatic backup root',
    false,
  );
  assertDisjointPaths(
    stateDir,
    requestedAutomaticBackupRoot,
    'state directory',
    'automatic backup root',
  );
  assertDisjointPaths(
    stateDir,
    validated.backupDirectory,
    'state directory',
    'restore source backup',
  );
  if (
    requestedAutomaticBackupRoot === validated.backupDirectory ||
    pathIsWithin(requestedAutomaticBackupRoot, validated.backupDirectory)
  ) {
    throw new Error(
      'automatic backup root may not be inside the restore source',
    );
  }
  ensureDirectory(requestedAutomaticBackupRoot);
  const automaticBackupRoot = canonicalLocalPath(
    requestedAutomaticBackupRoot,
    'automatic backup root',
    true,
  );
  assertPrivateOwnedDirectory(automaticBackupRoot, 'automatic backup root');
  if (
    pathIsWithin(validated.backupDirectory, automaticBackupRoot) &&
    dirname(validated.backupDirectory) !== automaticBackupRoot
  ) {
    throw new Error(
      'restore source under the automatic root must be a sibling backup id',
    );
  }
  if (
    join(automaticBackupRoot, options.preRestoreBackupId) ===
    validated.backupDirectory
  ) {
    throw new Error(
      'pre-restore backup id must differ from the restore source id',
    );
  }

  if (pendingTransaction !== undefined) {
    if (
      pendingTransaction.source_backup_id !== validated.manifest.backup_id ||
      pendingTransaction.source_manifest_sha256 !== validated.manifestSha256
    ) {
      if (pathEntryExists(replacedDirectory)) {
        rollbackReplacedState(
          stateDir,
          stageDirectory,
          replacedDirectory,
          markerPath,
          parent,
        );
      }
      throw new Error(
        'restore source does not match the durable transaction marker',
      );
    }
    try {
      verifyRestoredStage(stateDir, validated.manifest);
    } catch (error) {
      if (pathEntryExists(replacedDirectory)) {
        rollbackReplacedState(
          stateDir,
          stageDirectory,
          replacedDirectory,
          markerPath,
          parent,
        );
        throw error;
      }
      if (!pendingTransaction.had_live_state) throw error;
      // Recovery may itself have crashed after putting the original directory
      // back but before removing the marker. With no replaced directory left,
      // the durable pre-restore backup is the fallback and a fresh retry is safe.
      removeMarkerDurably(markerPath, parent);
      pendingTransaction = undefined;
    }
    if (pendingTransaction !== undefined) {
      const recoveredPreBackup = evidenceForRecoveredPreBackup(
        automaticBackupRoot,
        pendingTransaction,
        targetIdentity,
      );
      removePathDurably(replacedDirectory, parent);
      removeMarkerDurably(markerPath, parent);
      return recoveredRestoredEvidence(
        pendingTransaction,
        targetIdentity,
        recoveredPreBackup,
      );
    }
  }

  let preRestoreBackup: CreatedProductStateBackup | undefined;
  if (pathEntryExists(stateDir)) {
    assertDirectory(stateDir, 'live state directory');
    preRestoreBackup = await createProductStateBackup({
      stateDir,
      backupRoot: automaticBackupRoot,
      backupId: options.preRestoreBackupId,
      createdAt: options.preRestoreBackupCreatedAt,
      canonicalConfigSha256: options.canonicalConfigSha256,
      maintenanceLease: options.maintenanceLease,
    });
  }

  const transaction: StateRestoreTransaction = {
    schema_version: 1,
    kind: 'echo-product-state-restore-transaction',
    operation_id: options.operationId,
    restored_at: options.restoredAt,
    source_backup_id: validated.manifest.backup_id,
    source_manifest_sha256: validated.manifestSha256,
    target_state_path_sha256: targetIdentity,
    canonical_config_sha256: options.canonicalConfigSha256,
    pre_restore_backup_id: options.preRestoreBackupId,
    pre_restore_backup_created_at: options.preRestoreBackupCreatedAt,
    had_live_state: pathEntryExists(stateDir),
  };
  writeFileExclusive(
    markerPath,
    `${JSON.stringify(transaction, null, 2)}\n`,
    0o600,
  );
  fsyncDirectory(parent);
  let transactionDurable = true;
  options.faultInjector?.('after_prepare_marker');

  mkdirSync(stageDirectory, { mode: 0o700 });
  fsyncDirectory(parent);
  let stageExists = true;
  let replacedExists = false;
  try {
    for (const source of validated.manifest.files) {
      const sourcePath = resolveContainedRelativePath(
        validated.backupDirectory,
        source.path,
        'backup restore source path',
      );
      const destination = resolveContainedRelativePath(
        stageDirectory,
        source.path,
        'backup restore destination path',
      );
      ensureDirectory(dirname(destination));
      const copied = copyFileNoFollow(
        sourcePath,
        destination,
        'backup restore source',
        source.mode,
      );
      if (
        copied.mode !== source.mode ||
        copied.size !== source.size ||
        copied.sha256 !== source.sha256
      ) {
        throw new Error(`backup changed during restore: ${source.path}`);
      }
    }
    verifyRestoredStage(stageDirectory, validated.manifest);
    fsyncDirectoryTree(stageDirectory);

    if (pathEntryExists(stateDir)) {
      // Residue -- or the adjacent guard -- can appear under the live root
      // after the entry preflight. Re-check immediately before the rename
      // that would move it into the replaced directory; refusing here leaves
      // the durable marker, the staged payload, and the residue untouched.
      assertFreeOfFounderResidue(stateDir, 'restore target state');
      renameSync(stateDir, replacedDirectory);
      replacedExists = true;
      fsyncDirectory(parent);
      options.faultInjector?.('after_live_replaced');
    }
    // The staged payload was manifest-checked and verified, but residue can
    // still land inside it before promotion. Re-check before the rename that
    // would make it live.
    assertFreeOfFounderResidue(stageDirectory, 'completed restore staging');
    renameSync(stageDirectory, stateDir);
    stageExists = false;
    fsyncDirectory(parent);
    options.faultInjector?.('after_stage_promoted');
    // Residue in the promoted root -- or the adjacent guard beside the final
    // target -- refuses before the replaced original or the durable marker
    // is deleted, so the success path can never erase founder material.
    assertFreeOfFounderResidue(stateDir, 'promoted restored state');
    verifyRestoredStage(stateDir, validated.manifest);
    if (replacedExists) {
      // Residue can also land inside the replaced original after it was
      // renamed aside; re-check immediately before the deletion that would
      // erase it. Refusing leaves the promoted state, the replaced original,
      // its residue, and the durable marker in place.
      assertFreeOfFounderResidue(replacedDirectory, 'replaced original state');
      rmSync(replacedDirectory, { recursive: true, force: true });
      replacedExists = false;
      fsyncDirectory(parent);
    }
    removeMarkerDurably(markerPath, parent);
    transactionDurable = false;
  } finally {
    if (!transactionDurable && stageExists && pathEntryExists(stageDirectory)) {
      rmSync(stageDirectory, { recursive: true, force: true });
    }
  }

  return restoredEvidence(
    options,
    validated,
    targetIdentity,
    preRestoreBackup?.evidence ?? null,
  );
}
