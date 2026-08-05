import {
  assertInternalLiveCompatibility,
  internalLiveManifestSha256,
  parseInternalLiveReleaseManifest,
  verifyInspectedInternalLivePackage,
  type InspectedInternalLivePackage,
  type InternalLiveReleaseManifestV1,
} from './internal-live-release.js';

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INTERNAL_LIVE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-internal\.(0|[1-9]\d*)$/u;

function internalLiveVersionTuple(value: string): readonly bigint[] | null {
  const match = INTERNAL_LIVE_VERSION_PATTERN.exec(value);
  return match === null ? null : match.slice(1).map((part) => BigInt(part!));
}

function assertNoInternalLiveDowngrade(
  installedVersion: string,
  candidateVersion: string,
): void {
  const installed = internalLiveVersionTuple(installedVersion);
  const candidate = internalLiveVersionTuple(candidateVersion);
  if (installed === null || candidate === null) return;
  for (let index = 0; index < installed.length; index += 1) {
    if (candidate[index]! > installed[index]!) return;
    if (candidate[index]! < installed[index]!) {
      throw new InternalLiveUpdateError(
        'release_verification_failed',
        `internal-live update refuses downgrade from ${installedVersion} to ${candidateVersion}`,
      );
    }
  }
}

export type InternalLiveUpdatePhase =
  | 'verified'
  | 'stopping_service'
  | 'creating_backup'
  | 'retaining_previous_package'
  | 'installing_candidate'
  | 'reconfiguring_candidate'
  | 'starting_candidate'
  | 'checking_candidate'
  | 'rolling_back'
  | 'completed'
  | 'rolled_back'
  | 'failed';

export type InternalLiveUpdateFailureCode =
  | 'service_not_running'
  | 'stop_failed'
  | 'backup_failed'
  | 'retain_failed'
  | 'install_failed'
  | 'reconfigure_failed'
  | 'start_failed'
  | 'doctor_failed'
  | 'rollback_failed';

export interface InternalLiveInstalledIdentity {
  product_version: string;
  source_sha: string;
}

export interface InternalLiveDoctorSummary {
  ok: boolean;
  passed: number;
  total: number;
}

export interface InternalLiveUpdateFailure {
  phase: InternalLiveUpdatePhase;
  code: InternalLiveUpdateFailureCode;
}

export interface InternalLiveUpdateTransactionV1 {
  schema_version: 1;
  kind: 'echo-internal-live-update-transaction';
  channel: 'internal-live';
  transaction_id: string;
  release_version: string;
  manifest_sha256: string;
  artifact_sha256: string;
  source_sha: string;
  previous: InternalLiveInstalledIdentity;
  phase: InternalLiveUpdatePhase;
  backup_ref: string | null;
  previous_package_ref: string | null;
  package_may_have_changed: boolean;
  state_may_have_changed: boolean;
  doctor: InternalLiveDoctorSummary | null;
  failure: InternalLiveUpdateFailure | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface InternalLiveUpdateReceiptV1 {
  schema_version: 1;
  kind: 'echo-internal-live-update-receipt';
  channel: 'internal-live';
  transaction_id: string;
  release_version: string;
  manifest_sha256: string;
  artifact_sha256: string;
  source_sha: string;
  previous: InternalLiveInstalledIdentity;
  outcome: 'healthy' | 'rolled_back' | 'failed';
  doctor: InternalLiveDoctorSummary | null;
  failure: InternalLiveUpdateFailure | null;
  started_at: string;
  finished_at: string;
}

export interface InternalLiveUpdateStore {
  loadActive(): Promise<InternalLiveUpdateTransactionV1 | null>;
  saveActive(transaction: InternalLiveUpdateTransactionV1): Promise<void>;
  saveReceipt(receipt: InternalLiveUpdateReceiptV1): Promise<void>;
}

export interface InternalLiveArtifactReference {
  /** Opaque to the transaction engine and never copied into a receipt. */
  reference: unknown;
}

export interface InternalLiveUpdateOperations {
  obtainApprovedManifest(): Promise<unknown>;
  verifyManifestApproval(
    manifest: InternalLiveReleaseManifestV1,
    manifestSha256: string,
  ): Promise<void>;
  runtime(): {
    os: NodeJS.Platform;
    arch: string;
    node: string;
    npm: string;
  };
  obtainArtifact(
    manifest: InternalLiveReleaseManifestV1,
  ): Promise<InternalLiveArtifactReference>;
  digestArtifact(
    artifact: InternalLiveArtifactReference,
  ): Promise<{ sha256: string; size_bytes: number }>;
  inspectArtifact(
    artifact: InternalLiveArtifactReference,
  ): Promise<InspectedInternalLivePackage>;
  currentInstallation(): Promise<InternalLiveInstalledIdentity>;
  serviceIsRunning(): Promise<boolean>;
  stopService(): Promise<void>;
  createBackup(
    transactionId: string,
    stableTimestamp: string,
  ): Promise<{ backup_ref: string }>;
  retainCurrentPackage(
    transactionId: string,
  ): Promise<{ package_ref: string }>;
  installCandidate(
    artifact: InternalLiveArtifactReference,
    transactionId: string,
  ): Promise<void>;
  reconfigureCandidate(): Promise<void>;
  startService(): Promise<void>;
  doctor(): Promise<InternalLiveDoctorSummary>;
  installPreviousPackage(
    packageRef: string,
    transactionId: string,
  ): Promise<void>;
  restoreBackup(
    backupRef: string,
    transactionId: string,
    stableTimestamp: string,
  ): Promise<void>;
  reconfigurePrevious(): Promise<void>;
  now(): string;
}

export interface ApplyInternalLiveUpdateOptions {
  transactionId: string;
}

export class InternalLiveUpdateError extends Error {
  constructor(
    public readonly code:
      | InternalLiveUpdateFailureCode
      | 'invalid_transaction'
      | 'update_in_progress'
      | 'release_verification_failed',
    message: string,
  ) {
    super(message);
    this.name = 'InternalLiveUpdateError';
  }
}

const UPDATE_PHASES = new Set<InternalLiveUpdatePhase>([
  'verified',
  'stopping_service',
  'creating_backup',
  'retaining_previous_package',
  'installing_candidate',
  'reconfiguring_candidate',
  'starting_candidate',
  'checking_candidate',
  'rolling_back',
  'completed',
  'rolled_back',
  'failed',
]);

const FAILURE_CODES = new Set<InternalLiveUpdateFailureCode>([
  'service_not_running',
  'stop_failed',
  'backup_failed',
  'retain_failed',
  'install_failed',
  'reconfigure_failed',
  'start_failed',
  'doctor_failed',
  'rollback_failed',
]);

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function exactTransactionKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      `${label} has unknown or missing fields`,
    );
  }
}

function parseInstalledIdentity(
  value: unknown,
): InternalLiveInstalledIdentity {
  const record = recordValue(value, 'previous installation identity');
  exactTransactionKeys(
    record,
    ['product_version', 'source_sha'],
    'previous installation identity',
  );
  const identity = {
    product_version: record['product_version'],
    source_sha: record['source_sha'],
  };
  assertInstalledIdentity(identity as InternalLiveInstalledIdentity);
  return identity as InternalLiveInstalledIdentity;
}

function parseDoctorSummary(value: unknown): InternalLiveDoctorSummary {
  const record = recordValue(value, 'doctor summary');
  exactTransactionKeys(record, ['ok', 'passed', 'total'], 'doctor summary');
  const summary = {
    ok: record['ok'],
    passed: record['passed'],
    total: record['total'],
  };
  assertDoctorSummary(summary as InternalLiveDoctorSummary);
  return summary as InternalLiveDoctorSummary;
}

function parseFailure(value: unknown): InternalLiveUpdateFailure {
  const record = recordValue(value, 'update failure');
  exactTransactionKeys(record, ['phase', 'code'], 'update failure');
  if (
    !UPDATE_PHASES.has(record['phase'] as InternalLiveUpdatePhase) ||
    !FAILURE_CODES.has(record['code'] as InternalLiveUpdateFailureCode)
  ) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'update failure has an unsupported phase or code',
    );
  }
  return {
    phase: record['phase'] as InternalLiveUpdatePhase,
    code: record['code'] as InternalLiveUpdateFailureCode,
  };
}

/** Validate durable state before replaying any update side effect. */
export function parseInternalLiveUpdateTransaction(
  value: unknown,
): InternalLiveUpdateTransactionV1 {
  const record = recordValue(value, 'internal-live update transaction');
  exactTransactionKeys(
    record,
    [
      'schema_version',
      'kind',
      'channel',
      'transaction_id',
      'release_version',
      'manifest_sha256',
      'artifact_sha256',
      'source_sha',
      'previous',
      'phase',
      'backup_ref',
      'previous_package_ref',
      'package_may_have_changed',
      'state_may_have_changed',
      'doctor',
      'failure',
      'started_at',
      'updated_at',
      'finished_at',
    ],
    'internal-live update transaction',
  );
  if (
    record['schema_version'] !== 1 ||
    record['kind'] !== 'echo-internal-live-update-transaction' ||
    record['channel'] !== 'internal-live' ||
    typeof record['release_version'] !== 'string' ||
    record['release_version'].length === 0 ||
    record['release_version'].length > 128 ||
    typeof record['manifest_sha256'] !== 'string' ||
    !SHA256_PATTERN.test(record['manifest_sha256']) ||
    typeof record['artifact_sha256'] !== 'string' ||
    !SHA256_PATTERN.test(record['artifact_sha256']) ||
    typeof record['source_sha'] !== 'string' ||
    !SOURCE_SHA_PATTERN.test(record['source_sha']) ||
    !UPDATE_PHASES.has(record['phase'] as InternalLiveUpdatePhase) ||
    typeof record['package_may_have_changed'] !== 'boolean' ||
    typeof record['state_may_have_changed'] !== 'boolean'
  ) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'internal-live update transaction has an unsupported shape',
    );
  }
  if (typeof record['transaction_id'] !== 'string') {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'update transaction id must be a string',
    );
  }
  assertSafeReference(record['transaction_id'], 'update transaction id');
  const reference = (field: 'backup_ref' | 'previous_package_ref') => {
    const candidate = record[field];
    if (candidate !== null && typeof candidate !== 'string') {
      throw new InternalLiveUpdateError(
        'invalid_transaction',
        `${field} must be null or an opaque identifier`,
      );
    }
    if (typeof candidate === 'string') assertSafeReference(candidate, field);
    return candidate as string | null;
  };
  const backupRef = reference('backup_ref');
  const previousPackageRef = reference('previous_package_ref');
  const startedAt = record['started_at'];
  const updatedAt = record['updated_at'];
  const finishedAt = record['finished_at'];
  if (
    typeof startedAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    (finishedAt !== null && typeof finishedAt !== 'string')
  ) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'transaction timestamps have an unsupported shape',
    );
  }
  assertIsoInstant(startedAt, 'transaction start time');
  assertIsoInstant(updatedAt, 'transaction update time');
  if (typeof finishedAt === 'string') {
    assertIsoInstant(finishedAt, 'transaction finish time');
  }
  const phase = record['phase'] as InternalLiveUpdatePhase;
  if (terminal(phase) !== (finishedAt !== null)) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'transaction terminal phase and finish time disagree',
    );
  }
  const packageMayHaveChanged = record['package_may_have_changed'] as boolean;
  const stateMayHaveChanged = record['state_may_have_changed'] as boolean;
  if (
    (packageMayHaveChanged && previousPackageRef === null) ||
    (stateMayHaveChanged && (!packageMayHaveChanged || backupRef === null))
  ) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'transaction rollback references are incomplete',
    );
  }
  const doctor =
    record['doctor'] === null ? null : parseDoctorSummary(record['doctor']);
  const failure =
    record['failure'] === null ? null : parseFailure(record['failure']);
  if (
    (phase === 'completed' &&
      (doctor?.ok !== true || failure !== null)) ||
    (phase === 'rolled_back' &&
      (doctor?.ok !== true || failure === null)) ||
    (phase === 'failed' && failure?.code !== 'rollback_failed') ||
    (!terminal(phase) && doctor !== null)
  ) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'transaction terminal evidence is inconsistent',
    );
  }
  return {
    schema_version: 1,
    kind: 'echo-internal-live-update-transaction',
    channel: 'internal-live',
    transaction_id: record['transaction_id'],
    release_version: record['release_version'],
    manifest_sha256: record['manifest_sha256'],
    artifact_sha256: record['artifact_sha256'],
    source_sha: record['source_sha'],
    previous: parseInstalledIdentity(record['previous']),
    phase,
    backup_ref: backupRef,
    previous_package_ref: previousPackageRef,
    package_may_have_changed: packageMayHaveChanged,
    state_may_have_changed: stateMayHaveChanged,
    doctor,
    failure,
    started_at: startedAt,
    updated_at: updatedAt,
    finished_at: finishedAt,
  };
}

function assertSafeReference(value: string, label: string): void {
  if (!SAFE_REFERENCE_PATTERN.test(value)) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      `${label} must be an opaque safe identifier`,
    );
  }
}

function assertIsoInstant(value: string, label: string): void {
  if (!ISO_INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      `${label} must be a UTC ISO instant`,
    );
  }
}

function assertInstalledIdentity(identity: InternalLiveInstalledIdentity): void {
  if (
    typeof identity.product_version !== 'string' ||
    identity.product_version.length === 0 ||
    identity.product_version.length > 128 ||
    !SOURCE_SHA_PATTERN.test(identity.source_sha)
  ) {
    throw new InternalLiveUpdateError(
      'release_verification_failed',
      'current installation identity is invalid',
    );
  }
}

function assertDoctorSummary(summary: InternalLiveDoctorSummary): void {
  if (
    typeof summary.ok !== 'boolean' ||
    !Number.isSafeInteger(summary.passed) ||
    summary.passed < 0 ||
    !Number.isSafeInteger(summary.total) ||
    summary.total <= 0 ||
    summary.passed > summary.total ||
    summary.ok !== (summary.passed === summary.total)
  ) {
    throw new InternalLiveUpdateError(
      'doctor_failed',
      'doctor returned an invalid summary',
    );
  }
}

function failureCodeForPhase(
  phase: InternalLiveUpdatePhase,
): InternalLiveUpdateFailureCode {
  switch (phase) {
    case 'verified':
    case 'stopping_service':
      return 'stop_failed';
    case 'creating_backup':
      return 'backup_failed';
    case 'retaining_previous_package':
      return 'retain_failed';
    case 'installing_candidate':
      return 'install_failed';
    case 'reconfiguring_candidate':
      return 'reconfigure_failed';
    case 'starting_candidate':
      return 'start_failed';
    case 'checking_candidate':
      return 'doctor_failed';
    default:
      return 'rollback_failed';
  }
}

function withPhase(
  transaction: InternalLiveUpdateTransactionV1,
  phase: InternalLiveUpdatePhase,
  now: string,
  changes: Partial<InternalLiveUpdateTransactionV1> = {},
): InternalLiveUpdateTransactionV1 {
  assertIsoInstant(now, 'transaction update time');
  return {
    ...transaction,
    ...changes,
    phase,
    updated_at: now,
  };
}

function terminal(phase: InternalLiveUpdatePhase): boolean {
  return phase === 'completed' || phase === 'rolled_back' || phase === 'failed';
}

function receiptFor(
  transaction: InternalLiveUpdateTransactionV1,
): InternalLiveUpdateReceiptV1 {
  if (!terminal(transaction.phase) || transaction.finished_at === null) {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      'cannot emit a receipt for a non-terminal update',
    );
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'echo-internal-live-update-receipt',
    channel: 'internal-live',
    transaction_id: transaction.transaction_id,
    release_version: transaction.release_version,
    manifest_sha256: transaction.manifest_sha256,
    artifact_sha256: transaction.artifact_sha256,
    source_sha: transaction.source_sha,
    previous: { ...transaction.previous },
    outcome:
      transaction.phase === 'completed'
        ? 'healthy'
        : transaction.phase === 'rolled_back'
          ? 'rolled_back'
          : 'failed',
    doctor: transaction.doctor === null ? null : { ...transaction.doctor },
    failure:
      transaction.failure === null ? null : { ...transaction.failure },
    started_at: transaction.started_at,
    finished_at: transaction.finished_at,
  });
}

async function persist(
  store: InternalLiveUpdateStore,
  transaction: InternalLiveUpdateTransactionV1,
): Promise<InternalLiveUpdateTransactionV1> {
  await store.saveActive(transaction);
  return transaction;
}

async function finish(
  store: InternalLiveUpdateStore,
  transaction: InternalLiveUpdateTransactionV1,
): Promise<InternalLiveUpdateReceiptV1> {
  const receipt = receiptFor(transaction);
  await store.saveReceipt(receipt);
  return receipt;
}

async function runRollback(
  initial: InternalLiveUpdateTransactionV1,
  operations: InternalLiveUpdateOperations,
  store: InternalLiveUpdateStore,
): Promise<InternalLiveUpdateReceiptV1> {
  let transaction = initial;
  if (terminal(transaction.phase)) return await finish(store, transaction);
  if (transaction.phase !== 'rolling_back') {
    throw new InternalLiveUpdateError(
      'invalid_transaction',
      `cannot resume rollback from ${transaction.phase}`,
    );
  }
  try {
    if (transaction.package_may_have_changed) {
      if (transaction.previous_package_ref === null) {
        throw new Error('previous package reference is unavailable');
      }
      await operations.installPreviousPackage(
        transaction.previous_package_ref,
        transaction.transaction_id,
      );
    }
    // Repair the CLI before asking it to stop a possibly running candidate.
    // A failed npm install may have damaged the only global command path.
    await operations.stopService();
    if (transaction.state_may_have_changed) {
      if (transaction.backup_ref === null) {
        throw new Error('state backup reference is unavailable');
      }
      await operations.restoreBackup(
        transaction.backup_ref,
        transaction.transaction_id,
        transaction.started_at,
      );
    }
    if (transaction.package_may_have_changed) {
      await operations.reconfigurePrevious();
    }
    await operations.startService();
    const doctor = await operations.doctor();
    assertDoctorSummary(doctor);
    if (!doctor.ok) throw new Error('previous package failed doctor');
    const finishedAt = operations.now();
    transaction = await persist(
      store,
      withPhase(transaction, 'rolled_back', finishedAt, {
        doctor,
        finished_at: finishedAt,
      }),
    );
    return await finish(store, transaction);
  } catch {
    const failedAt = operations.now();
    transaction = await persist(
      store,
      withPhase(transaction, 'failed', failedAt, {
        failure: {
          phase: 'rolling_back',
          code: 'rollback_failed',
        },
        finished_at: failedAt,
      }),
    );
    return await finish(store, transaction);
  }
}

async function beginRollback(
  transaction: InternalLiveUpdateTransactionV1,
  failure: InternalLiveUpdateFailure,
  operations: InternalLiveUpdateOperations,
  store: InternalLiveUpdateStore,
): Promise<InternalLiveUpdateReceiptV1> {
  const rollingBack = await persist(
    store,
    withPhase(transaction, 'rolling_back', operations.now(), { failure }),
  );
  return await runRollback(rollingBack, operations, store);
}

async function runCandidate(
  initial: InternalLiveUpdateTransactionV1,
  artifact: InternalLiveArtifactReference,
  operations: InternalLiveUpdateOperations,
  store: InternalLiveUpdateStore,
): Promise<InternalLiveUpdateReceiptV1> {
  let transaction = initial;
  try {
    for (;;) {
      switch (transaction.phase) {
        case 'verified':
          transaction = await persist(
            store,
            withPhase(transaction, 'stopping_service', operations.now()),
          );
          break;
        case 'stopping_service':
          await operations.stopService();
          transaction = await persist(
            store,
            withPhase(transaction, 'creating_backup', operations.now()),
          );
          break;
        case 'creating_backup': {
          const backup = await operations.createBackup(
            transaction.transaction_id,
            transaction.started_at,
          );
          assertSafeReference(backup.backup_ref, 'state backup reference');
          transaction = await persist(
            store,
            withPhase(
              transaction,
              'retaining_previous_package',
              operations.now(),
              { backup_ref: backup.backup_ref },
            ),
          );
          break;
        }
        case 'retaining_previous_package': {
          const retained = await operations.retainCurrentPackage(
            transaction.transaction_id,
          );
          assertSafeReference(retained.package_ref, 'previous package reference');
          transaction = await persist(
            store,
            withPhase(
              transaction,
              'installing_candidate',
              operations.now(),
              {
                previous_package_ref: retained.package_ref,
                package_may_have_changed: true,
              },
            ),
          );
          break;
        }
        case 'installing_candidate':
          await operations.installCandidate(
            artifact,
            transaction.transaction_id,
          );
          transaction = await persist(
            store,
            withPhase(
              transaction,
              'reconfiguring_candidate',
              operations.now(),
              { state_may_have_changed: true },
            ),
          );
          break;
        case 'reconfiguring_candidate':
          await operations.reconfigureCandidate();
          transaction = await persist(
            store,
            withPhase(transaction, 'starting_candidate', operations.now()),
          );
          break;
        case 'starting_candidate':
          await operations.startService();
          transaction = await persist(
            store,
            withPhase(transaction, 'checking_candidate', operations.now()),
          );
          break;
        case 'checking_candidate': {
          const doctor = await operations.doctor();
          assertDoctorSummary(doctor);
          if (!doctor.ok) {
            throw new InternalLiveUpdateError(
              'doctor_failed',
              'candidate did not pass doctor',
            );
          }
          const finishedAt = operations.now();
          transaction = await persist(
            store,
            withPhase(transaction, 'completed', finishedAt, {
              doctor,
              finished_at: finishedAt,
            }),
          );
          return await finish(store, transaction);
        }
        case 'rolling_back':
          return await runRollback(transaction, operations, store);
        case 'completed':
        case 'rolled_back':
        case 'failed':
          return await finish(store, transaction);
      }
    }
  } catch (error) {
    const code =
      error instanceof InternalLiveUpdateError &&
      error.code !== 'invalid_transaction' &&
      error.code !== 'update_in_progress' &&
      error.code !== 'release_verification_failed'
        ? error.code
        : failureCodeForPhase(transaction.phase);
    return await beginRollback(
      transaction,
      { phase: transaction.phase, code },
      operations,
      store,
    );
  }
}

/**
 * Apply one Authority-approved internal-live package.
 *
 * Artifact acquisition, hashing, package inspection, and approval verification
 * all finish before this function stops the live service. Mutating operations
 * must be idempotent for a transaction id: an interrupted intent phase is
 * deliberately replayed when the durable transaction is resumed.
 */
export async function applyInternalLiveUpdate(
  options: ApplyInternalLiveUpdateOptions,
  operations: InternalLiveUpdateOperations,
  store: InternalLiveUpdateStore,
): Promise<InternalLiveUpdateReceiptV1> {
  assertSafeReference(options.transactionId, 'update transaction id');
  let manifest: InternalLiveReleaseManifestV1;
  try {
    manifest = parseInternalLiveReleaseManifest(
      await operations.obtainApprovedManifest(),
    );
  } catch (error) {
    throw new InternalLiveUpdateError(
      'release_verification_failed',
      `internal-live manifest is invalid: ${(error as Error).message}`,
    );
  }
  const manifestSha256 = internalLiveManifestSha256(manifest);
  try {
    await operations.verifyManifestApproval(manifest, manifestSha256);
    assertInternalLiveCompatibility(manifest, operations.runtime());
  } catch (error) {
    throw new InternalLiveUpdateError(
      'release_verification_failed',
      `internal-live release is not approved or compatible: ${(error as Error).message}`,
    );
  }

  const loadedActive = await store.loadActive();
  const active =
    loadedActive === null
      ? null
      : parseInternalLiveUpdateTransaction(loadedActive);
  if (
    active !== null &&
    !terminal(active.phase) &&
    active.manifest_sha256 !== manifestSha256
  ) {
    throw new InternalLiveUpdateError(
      'update_in_progress',
      'a different internal-live update is already in progress',
    );
  }
  if (active !== null && active.manifest_sha256 === manifestSha256) {
    if (
      active.release_version !== manifest.release_version ||
      active.artifact_sha256 !== manifest.artifact.sha256 ||
      active.source_sha !== manifest.source.sha
    ) {
      throw new InternalLiveUpdateError(
        'invalid_transaction',
        'active transaction does not match its release manifest',
      );
    }
    if (terminal(active.phase)) return await finish(store, active);
  }

  let artifact: InternalLiveArtifactReference;
  try {
    artifact = await operations.obtainArtifact(manifest);
    const digest = await operations.digestArtifact(artifact);
    const inspection = await operations.inspectArtifact(artifact);
    verifyInspectedInternalLivePackage(manifest, inspection, digest);
  } catch (error) {
    throw new InternalLiveUpdateError(
      'release_verification_failed',
      `internal-live package verification failed: ${(error as Error).message}`,
    );
  }

  if (active !== null && active.manifest_sha256 === manifestSha256) {
    return await runCandidate(active, artifact, operations, store);
  }

  if (!(await operations.serviceIsRunning())) {
    throw new InternalLiveUpdateError(
      'service_not_running',
      'internal-live update requires the managed service to be running',
    );
  }
  const previous = await operations.currentInstallation();
  assertInstalledIdentity(previous);
  assertNoInternalLiveDowngrade(
    previous.product_version,
    manifest.release_version,
  );
  const startedAt = operations.now();
  assertIsoInstant(startedAt, 'transaction start time');
  const transaction: InternalLiveUpdateTransactionV1 = {
    schema_version: 1,
    kind: 'echo-internal-live-update-transaction',
    channel: 'internal-live',
    transaction_id: options.transactionId,
    release_version: manifest.release_version,
    manifest_sha256: manifestSha256,
    artifact_sha256: manifest.artifact.sha256,
    source_sha: manifest.source.sha,
    previous: { ...previous },
    phase: 'verified',
    backup_ref: null,
    previous_package_ref: null,
    package_may_have_changed: false,
    state_may_have_changed: false,
    doctor: null,
    failure: null,
    started_at: startedAt,
    updated_at: startedAt,
    finished_at: null,
  };
  await store.saveActive(transaction);
  return await runCandidate(transaction, artifact, operations, store);
}
