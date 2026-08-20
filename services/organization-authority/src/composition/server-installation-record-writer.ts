import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import { createOrganizationAccessLeaseRequestV2 } from '@echo-brain/organization-api';
import { verifyOrganizationAuthorityPin } from '@echo-brain/organization-protocol';
import type { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import type { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import type { StoredAuthorityEnrollment } from '../application/ports/authority-repository.js';
import type { ReadableSearchAuthorizationFence } from '../application/readable-search-authorization-fence.js';
import { ExistingExportableInstallationKey } from '../processing/authorization/security/existing-exportable-installation-key.js';
import { ServerInstallationCompatibilityBridge } from '../processing/authorization/server-installation-compatibility-bridge.js';
import { SqliteResolvedOrganizationRecordMetadataLookup } from '../processing/record/adapters/organization-member-record-metadata.js';
import { ResolvedOrganizationRecordActWriter } from '../processing/record/adapters/resolved-organization-record-act-writer.js';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '../processing/record/protocol-record-envelope-builder.js';
import type { SqliteAuthorityProcessingStore } from '../processing/storage/sqlite-authority-processing-store.js';
import type { ComposedOrganizationIntegrationsApplication } from './organization-integrations.js';
import type { OrganizationRecordRuntime } from './organization-record.js';
import type { AuthorityServeConfig } from './config.js';

export const AUTHORITY_PROCESSING_INSTALLATION_KEY_FILENAME =
  'installation-key-state.v1.json';

export interface ComposeServerInstallationRecordWriterOptions {
  readonly config: AuthorityServeConfig;
  readonly authority: OrganizationAuthorityApplication;
  readonly authorityRepository: SqliteOrganizationAuthorityRepository;
  readonly authorizationFence: ReadableSearchAuthorizationFence;
  readonly integrations: ComposedOrganizationIntegrationsApplication;
  readonly records: OrganizationRecordRuntime;
}

export interface ServerInstallationRecordWriterComposition {
  readonly installationDescriptor: ReturnType<
    ExistingExportableInstallationKey['inspect']
  >;
  readonly installationSigningKey: P256SigningKeyDescriptor;
  readonly reviewerEnrollment: StoredAuthorityEnrollment;
  readonly compatibilityBridge: ServerInstallationCompatibilityBridge;
  createResolvedActWriter(
    store: SqliteAuthorityProcessingStore,
  ): ResolvedOrganizationRecordActWriter;
}

export interface ServerInstallationRecordIdentity {
  readonly installationKey: ExistingExportableInstallationKey;
  readonly installationDescriptor: ReturnType<
    ExistingExportableInstallationKey['inspect']
  >;
  readonly installationSigningKey: P256SigningKeyDescriptor;
  readonly reviewerEnrollment: StoredAuthorityEnrollment;
}

function protocolKey(
  key: ReturnType<ExistingExportableInstallationKey['inspect']>,
): P256SigningKeyDescriptor {
  return Object.freeze({
    key_id: key.key_id,
    algorithm: key.algorithm,
    public_key_spki_der_base64: key.public_key_spki_der_base64,
  });
}

/** Reads and validates only the existing server installation identity. */
export function inspectServerInstallationRecordIdentity(
  options: ComposeServerInstallationRecordWriterOptions,
): ServerInstallationRecordIdentity {
  const installationKey = new ExistingExportableInstallationKey(
    join(
      options.config.state_directory,
      'credentials',
      'processing',
      AUTHORITY_PROCESSING_INSTALLATION_KEY_FILENAME,
    ),
  );
  const installationDescriptor = installationKey.inspect();
  const installationSigningKey = protocolKey(installationDescriptor);
  const reviewerEnrollment = options.authorityRepository.read((transaction) =>
    transaction.enrollmentByInstallation(
      installationDescriptor.installation_id,
    ),
  );
  if (
    reviewerEnrollment === undefined ||
    reviewerEnrollment.status !== 'active' ||
    reviewerEnrollment.authority_id !== options.config.authority_id ||
    reviewerEnrollment.organization_id !== options.config.organization_id ||
    reviewerEnrollment.installation_id !==
      installationDescriptor.installation_id ||
    reviewerEnrollment.installation_signing_key.key_id !==
      installationSigningKey.key_id ||
    reviewerEnrollment.installation_signing_key.algorithm !==
      installationSigningKey.algorithm ||
    reviewerEnrollment.installation_signing_key.public_key_spki_der_base64 !==
      installationSigningKey.public_key_spki_der_base64
  ) {
    throw new Error(
      'server installation key does not match the active Authority enrollment',
    );
  }
  return Object.freeze({
    installationKey,
    installationDescriptor,
    installationSigningKey,
    reviewerEnrollment,
  });
}

/**
 * Composes the existing installation-authorized record writer without loading
 * a meeting source, decision processor, approval surface, or delivery surface.
 */
export function composeServerInstallationRecordWriter(
  options: ComposeServerInstallationRecordWriterOptions,
  inspected: ServerInstallationRecordIdentity =
    inspectServerInstallationRecordIdentity(options),
): ServerInstallationRecordWriterComposition {
  const {
    installationKey,
    installationDescriptor,
    installationSigningKey,
    reviewerEnrollment,
  } = inspected;

  const authorityDescriptor = options.authority.descriptor();
  const compatibilityBridge = new ServerInstallationCompatibilityBridge({
    authorityRepository: options.authorityRepository,
    keyStatePath: installationKey.path,
    permissionCheck: options.integrations,
    now: () => new Date().toISOString(),
    accessRefresh: {
      refreshInstallationAccess: async (input, signal) => {
        signal?.throwIfAborted();
        if (
          input.installation_id !== installationDescriptor.installation_id ||
          input.current_access_state_sha256 === null
        ) {
          throw new Error(
            'server installation access cannot be refreshed from the current state',
          );
        }
        const request = await createOrganizationAccessLeaseRequestV2(
          {
            request_id: `alr_${randomUUID()}`,
            authority_id: authorityDescriptor.authority_id,
            authority_key_id: authorityDescriptor.signing_key.key_id,
            organization_id: authorityDescriptor.organization_id,
            enrollment_id: input.enrollment_id,
            installation_id: input.installation_id,
            installation_signing_key: installationSigningKey,
            previous_access_state_sha256: input.current_access_state_sha256,
            requested_active_lease_ttl_ms: options.config.active_lease_ttl_ms,
            requested_at: input.requested_at,
          },
          async (bytes) =>
            installationKey.sign(
              installationDescriptor.installation_id,
              installationSigningKey.key_id,
              bytes,
            ),
        );
        signal?.throwIfAborted();
        await options.authorizationFence.withWrite(
          async () => await options.authority.issueAccessLease(request),
          { ...(signal === undefined ? {} : { signal }) },
        );
      },
    },
  });

  const recordEnvelopeBuilder = new ProtocolOrganizationRecordEnvelopeBuilder({
    pinnedAuthority: verifyOrganizationAuthorityPin(
      authorityDescriptor,
      options.authority.authorityPinSha256(),
    ),
    installationSigningKey,
    sign: async (bytes) =>
      installationKey.sign(
        installationDescriptor.installation_id,
        installationSigningKey.key_id,
        bytes,
      ),
  });

  return Object.freeze({
    installationDescriptor,
    installationSigningKey,
    reviewerEnrollment,
    compatibilityBridge,
    createResolvedActWriter: (store: SqliteAuthorityProcessingStore) =>
      new ResolvedOrganizationRecordActWriter({
        metadata: new SqliteResolvedOrganizationRecordMetadataLookup(store),
        recordEnvelopes: store,
        recordEnvelopeBuilder,
        installationAccess: compatibilityBridge,
        records: options.records,
      }),
  });
}
