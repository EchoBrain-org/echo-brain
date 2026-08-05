import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireProcessFileLock } from '../../infrastructure/filesystem/process-file-lock.js';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  createOrganizationInternalLiveDirectiveRequest,
  createOrganizationInternalLiveUpdateReceipt,
  type OrganizationInternalLiveUpdateFailurePhaseV1,
} from '@echo-brain/organization-api';
import type { ProductRuntimeConfig } from '../config.js';
import type { PackagedBuildIdentityV1 } from '../build-identity.js';
import { FileInstallationSigner } from '../machine/security/file-installation-signer.js';
import {
  signWithInstallationKey,
  verifyInstallationKeyDescriptor,
  type InstallationSigner,
} from '../machine/security/installation-signer.js';
import { HttpOrganizationAuthorityClient } from '../organization/client/http-organization-authority-client.js';
import { SqliteOrganizationStateStore } from '../organization/state/sqlite-organization-state-store.js';
import { resolveProductStatePaths } from '../paths.js';
import {
  assertPrivateOwnedDirectory,
  ensureDirectory,
} from '../secure-local-files.js';
import {
  NodeInternalLiveUpdateOperations,
  defaultInternalLiveNpmPath,
  internalLiveNpmVersion,
  internalLiveUpdateRoot,
  type InternalLiveCommandRunner,
} from './internal-live-node-operations.js';
import { FileInternalLiveUpdateStore } from './internal-live-update-store.js';
import {
  applyInternalLiveUpdate,
  type InternalLiveUpdateReceiptV1,
} from './internal-live-update.js';

export interface RunInternalLiveUpdateOptions {
  configPath: string;
  config: ProductRuntimeConfig;
  cliPath: string;
  productVersion: string;
  buildIdentity: PackagedBuildIdentityV1;
  now: () => string;
  installationSigner?: InstallationSigner;
  authorityFetch?: typeof fetch;
  publicFetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
  commandRunner?: InternalLiveCommandRunner;
  npmPath?: string;
  nextDirectiveRequestId?: () => string;
  nextTransactionId?: () => string;
}

export interface InternalLiveUpdateRunResult {
  directive_sequence: number;
  receipt: InternalLiveUpdateReceiptV1;
}

export interface AcquireInternalLiveUpdateLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

export async function acquireInternalLiveUpdateLock(
  configPath: string,
  options: AcquireInternalLiveUpdateLockOptions = {},
): Promise<() => Promise<void>> {
  const root = internalLiveUpdateRoot(configPath);
  ensureDirectory(root);
  assertPrivateOwnedDirectory(root, 'internal-live update directory');
  return await acquireProcessFileLock(join(root, 'apply.lock'), {
    timeoutMs: options.timeoutMs ?? 1_000,
    staleMs: options.staleMs ?? 30_000,
    retryMs: options.retryMs ?? 50,
  });
}

function protocolSigningKey(
  descriptor: Awaited<ReturnType<InstallationSigner['inspect']>>,
  installationId: string,
): P256SigningKeyDescriptor {
  if (descriptor === null) {
    throw new Error('organization installation signing key is unavailable');
  }
  verifyInstallationKeyDescriptor(descriptor);
  if (descriptor.installation_id !== installationId) {
    throw new Error(
      'organization installation signer belongs to another installation',
    );
  }
  return {
    key_id: descriptor.key_id,
    algorithm: descriptor.algorithm,
    public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
  };
}

function authorityFailurePhase(
  receipt: InternalLiveUpdateReceiptV1,
): OrganizationInternalLiveUpdateFailurePhaseV1 | null {
  const failure = receipt.failure;
  if (failure === null) return null;
  if (failure.code === 'rollback_failed' || failure.phase === 'rolling_back') {
    return 'rollback';
  }
  switch (failure.phase) {
    case 'verified':
    case 'stopping_service':
      return 'service_stop';
    case 'creating_backup':
      return 'backup';
    case 'retaining_previous_package':
    case 'installing_candidate':
    case 'reconfiguring_candidate':
      return 'install';
    case 'starting_candidate':
      return 'service_start';
    case 'checking_candidate':
      return 'doctor';
    default:
      return 'rollback';
  }
}

/**
 * One explicit INTERNAL LIVE pull. Authority traffic uses the pinned
 * organization transport; public GitHub bytes use a separate fetch instance.
 */
async function runInternalLiveUpdateLocked(
  options: RunInternalLiveUpdateOptions,
): Promise<InternalLiveUpdateRunResult> {
  const now = options.now;
  const paths = resolveProductStatePaths(options.config.state_dir);
  const state = new SqliteOrganizationStateStore(paths.database);
  let connection: ReturnType<typeof state.readAuthorityConnection>;
  let enrollment: ReturnType<typeof state.readEnrollment>;
  try {
    connection = state.readAuthorityConnection();
    enrollment = state.readEnrollment();
  } finally {
    state.close();
  }
  if (
    connection === null ||
    enrollment === null ||
    enrollment.receipt === null ||
    enrollment.accepted_access_sequence < 1
  ) {
    throw new Error(
      'active organization enrollment is required for internal-live updates',
    );
  }
  const receipt = enrollment.receipt;
  if (
    connection.authority_id !== receipt.authority_id ||
    connection.organization_id !== receipt.organization_id
  ) {
    throw new Error('organization authority connection does not match enrollment');
  }

  const signer =
    options.installationSigner ??
    new FileInstallationSigner(
      join(options.config.state_dir, 'installation', 'keys'),
    );
  const signingKey = protocolSigningKey(
    await signer.inspect(receipt.installation_id),
    receipt.installation_id,
  );
  if (signingKey.key_id !== receipt.installation_key_id) {
    throw new Error('organization installation key no longer matches enrollment');
  }
  const authority = new HttpOrganizationAuthorityClient({
    baseUrl: connection.authority_base_url,
    ...(options.authorityFetch === undefined
      ? connection.authority_ca_pem === null
        ? {}
        : { authorityCaPem: connection.authority_ca_pem }
      : { fetch: options.authorityFetch }),
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  });
  const directiveRequest = await createOrganizationInternalLiveDirectiveRequest(
    {
      request_id:
        options.nextDirectiveRequestId?.() ?? `udr_${randomUUID()}`,
      authority_id: receipt.authority_id,
      authority_key_id: receipt.authority_key_id,
      organization_id: receipt.organization_id,
      enrollment_id: receipt.enrollment_id,
      installation_id: receipt.installation_id,
      installation_signing_key: signingKey,
      requested_at: now(),
    },
    (bytes) =>
      signWithInstallationKey(
        signer,
        receipt.installation_id,
        receipt.installation_key_id,
        bytes,
      ),
  );
  const directive = await authority.fetchInternalLiveDirective(
    directiveRequest,
  );

  const commandRunner = options.commandRunner;
  const npmPath = options.npmPath ?? defaultInternalLiveNpmPath();
  const npmVersion = await internalLiveNpmVersion(npmPath, commandRunner);
  const operations = new NodeInternalLiveUpdateOperations({
    configPath: options.configPath,
    config: options.config,
    cliPath: options.cliPath,
    productVersion: options.productVersion,
    sourceSha: options.buildIdentity.source_sha,
    directive,
    npmPath,
    npmVersion,
    now,
    ...(options.publicFetch === undefined
      ? {}
      : { publicFetch: options.publicFetch }),
    ...(commandRunner === undefined ? {} : { commandRunner }),
  });
  const store = new FileInternalLiveUpdateStore({
    directory: join(internalLiveUpdateRoot(options.configPath), 'transaction'),
    stateDir: options.config.state_dir,
  });
  const updateReceipt = await applyInternalLiveUpdate(
    {
      transactionId:
        options.nextTransactionId?.() ?? `upd_${randomUUID()}`,
    },
    operations,
    store,
  );
  const failurePhase = authorityFailurePhase(updateReceipt);
  const signedReceipt = await createOrganizationInternalLiveUpdateReceipt(
    {
      transaction_id: updateReceipt.transaction_id,
      authority_id: receipt.authority_id,
      authority_key_id: receipt.authority_key_id,
      organization_id: receipt.organization_id,
      enrollment_id: receipt.enrollment_id,
      installation_id: receipt.installation_id,
      directive_sequence: directive.directive_sequence,
      release_version: updateReceipt.release_version,
      manifest_sha256: updateReceipt.manifest_sha256,
      artifact_sha256: updateReceipt.artifact_sha256,
      source_sha: updateReceipt.source_sha,
      outcome: updateReceipt.outcome,
      doctor: updateReceipt.doctor,
      failure:
        updateReceipt.failure === null || failurePhase === null
          ? null
          : { phase: failurePhase, code: updateReceipt.failure.code },
      finished_at: updateReceipt.finished_at,
      installation_signing_key: signingKey,
    },
    (bytes) =>
      signWithInstallationKey(
        signer,
        receipt.installation_id,
        receipt.installation_key_id,
        bytes,
      ),
  );
  await authority.recordInternalLiveUpdateReceipt(signedReceipt);
  if (updateReceipt.outcome === 'rolled_back') {
    await store.clearReportedRollback(updateReceipt.transaction_id);
  }
  return {
    directive_sequence: directive.directive_sequence,
    receipt: updateReceipt,
  };
}

export async function runInternalLiveUpdate(
  options: RunInternalLiveUpdateOptions,
): Promise<InternalLiveUpdateRunResult> {
  const release = await acquireInternalLiveUpdateLock(options.configPath);
  try {
    return await runInternalLiveUpdateLocked(options);
  } finally {
    await release();
  }
}
