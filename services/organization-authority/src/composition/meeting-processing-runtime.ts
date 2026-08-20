import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import { createOrganizationAccessLeaseRequestV2 } from '@echo-brain/organization-api';
import { verifyOrganizationAuthorityPin } from '@echo-brain/organization-protocol';
import {
  FileOrganizationSecretStore,
  OrganizationIntegrationsRepository,
} from '@echo-brain/organization-control-plane';
import { readAuthorityProcessingSourceRuntimeBinding } from '../adapters/persistence/sqlite/processing-source-runtime-binding.js';
import { assertAuthorityProcessingOwnerEmailBinding } from '../adapters/persistence/sqlite/processing-source-identity.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
  readPrivateAuthorityOrganizationCredentialScope,
} from '../adapters/security/private-file-credentials.js';
import type { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import type { ReadableSearchAuthorizationFence } from '../application/readable-search-authorization-fence.js';
import { isOrganizationMemberReadableRecordingPolicy } from '../application/organization-recording-policy.js';
import { createSlackReactionsApprovalSurface } from '../processing/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { createStructuredTextDecisionProcessor } from '../processing/adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import { FileSlackDeliveryReceiptStore } from '../processing/adapters/delivery-surfaces/slack/slack-delivery-receipt-store.js';
import { SlackDeliverySurface } from '../processing/adapters/delivery-surfaces/slack/slack-delivery-surface.js';
import { createGranolaMeetingSourceAdapter } from '../processing/adapters/meeting-sources/granola/index.js';
import { validateOrganizationMemberAuthorizationEvidence } from '../processing/authorization/organization-member-authorization-evidence.js';
import { assertReviewerDisplayName } from '../processing/authorization/reviewer-authorization-evidence.js';
import { ExistingExportableInstallationKey } from '../processing/authorization/security/existing-exportable-installation-key.js';
import { ServerInstallationCompatibilityBridge } from '../processing/authorization/server-installation-compatibility-bridge.js';
import {
  runAuthorityLiveMeetingCycle,
  type AuthorityLiveAdapterConfig,
  type AuthorityLiveMeetingCycleResult,
} from '../processing/live/run-live-meeting-cycle.js';
import {
  authorityProcessingCredentialReferenceSha256,
} from '../processing/live/run-one-meeting.js';
import { SerializedAuthorityMeetingWorker } from '../processing/live/serialized-authority-meeting-worker.js';
import { organizationMemberApprovalPresentationRenderer } from '../processing/record/adapters/organization-member-presentation-renderer.js';
import { OrganizationMemberRecordFirstDeliverySurface } from '../processing/record/adapters/organization-member-record-first-delivery.js';
import { SqliteOrganizationMemberRecordApprovalMetadataLookup } from '../processing/record/adapters/organization-member-record-metadata.js';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '../processing/record/protocol-record-envelope-builder.js';
import { SqliteAuthorityProcessingStore } from '../processing/storage/sqlite-authority-processing-store.js';
import type { OrganizationRecordRuntime } from './organization-record.js';
import type { ComposedOrganizationIntegrationsApplication } from './organization-integrations.js';
import type { AuthorityServeConfig } from './config.js';
import {
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
  AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME,
} from './process-one-meeting.js';

export const AUTHORITY_PROCESSING_INSTALLATION_KEY_FILENAME =
  'installation-key-state.v1.json';

const GRANOLA_CREDENTIAL_REF = 'authority:granola-organization-api-key';

export interface AuthorityMeetingProcessingRuntime {
  close(): Promise<void>;
}

export interface OpenAuthorityMeetingProcessingRuntimeOptions {
  readonly config: AuthorityServeConfig;
  readonly authority: OrganizationAuthorityApplication;
  readonly authorityRepository: SqliteOrganizationAuthorityRepository;
  readonly authorizationFence: ReadableSearchAuthorizationFence;
  readonly integrations: ComposedOrganizationIntegrationsApplication;
  readonly integrationsRepository: OrganizationIntegrationsRepository;
  readonly integrationSecrets: FileOrganizationSecretStore;
  readonly records: OrganizationRecordRuntime;
}

function adapterConfig(
  adapterId: string,
  instanceId: string,
  settings: AuthorityLiveAdapterConfig['settings'],
  credentialReference?: string,
): AuthorityLiveAdapterConfig {
  return {
    adapter_id: adapterId,
    instance_id: instanceId,
    ...(credentialReference === undefined
      ? {}
      : { credential_ref: credentialReference }),
    settings,
  };
}

function assertValidAdapter(
  label: string,
  adapter: {
    validateConfig(config: AuthorityLiveAdapterConfig): {
      ok: boolean;
      errors: readonly string[];
    };
  },
  config: AuthorityLiveAdapterConfig,
): void {
  const validation = adapter.validateConfig(config);
  if (!validation.ok) {
    throw new Error(
      `${label} configuration is invalid: ${validation.errors.join('; ')}`,
    );
  }
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

function boundedCycleFailure(result: AuthorityLiveMeetingCycleResult): Error {
  const stages = [
    ...new Set([
      ...result.failures.map((failure) => failure.stage),
      ...(result.dead_letters.length === 0 ? [] : ['delivery'] as const),
    ]),
  ].sort();
  return new Error(
    `authority meeting cycle failed count=${result.failures.length + result.dead_letters.length} stages=${stages.join(',') || 'unknown'}`,
  );
}

/**
 * Opens the minimum live meeting pipeline only after its source and exact
 * installation-scoped approval capability have been explicitly provisioned.
 * An incomplete pipeline remains a record-serving Authority and does not poll
 * a provider by implication.
 */
export async function openAuthorityMeetingProcessingRuntime(
  options: OpenAuthorityMeetingProcessingRuntimeOptions,
): Promise<AuthorityMeetingProcessingRuntime | null> {
  const policy = options.config.organization_recording_policy_v1;
  if (policy === undefined) return null;
  if (!isOrganizationMemberReadableRecordingPolicy(policy)) {
    throw new Error(
      'minimum Authority meeting runtime requires organization-member-readable-v1',
    );
  }

  const sourceBinding = readAuthorityProcessingSourceRuntimeBinding(
    options.config.database_path,
    options.config.organization_id,
  );
  if (sourceBinding === null) return null;
  if (options.records.organizationMemberReadableHealth.kind !== 'ready') {
    throw new Error(
      'Authority meeting runtime requires ready organization-member record admission',
    );
  }

  const processingCredentialDirectory = join(
    options.config.state_directory,
    'credentials',
    'processing',
  );
  const installationKey = new ExistingExportableInstallationKey(
    join(
      processingCredentialDirectory,
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

  const slackBinding =
    options.integrationsRepository.activeSlackApprovalRuntimeBinding(
      policy.approval_surface_adapter_instance_id,
      installationDescriptor.installation_id,
      installationDescriptor.key_id,
    );
  if (slackBinding === null) {
    process.stderr.write(
      'organization authority meeting processing disabled: the current installation has no complete policy-surface Slack binding\n',
    );
    return null;
  }
  const reviewer = options.authorityRepository.read((transaction) =>
    transaction.membership(slackBinding.membership_id),
  );
  if (
    reviewer === undefined ||
    reviewer.organization_id !== options.config.organization_id ||
    reviewer.principal_id !== slackBinding.principal_id ||
    reviewerEnrollment.principal_id !== slackBinding.principal_id ||
    reviewerEnrollment.membership_id !== slackBinding.membership_id ||
    reviewer.status !== 'active'
  ) {
    throw new Error(
      'Slack approval reviewer is not the exact active Authority membership',
    );
  }
  assertReviewerDisplayName(reviewer.display_name);
  if (
    installationDescriptor.installation_id !== slackBinding.installation_id ||
    installationDescriptor.key_id !== slackBinding.installation_key_id
  ) {
    throw new Error(
      'server installation key differs from the active Slack approval binding',
    );
  }
  const credentialDirectory = join(options.config.state_directory, 'credentials');
  const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
    `file:${join(
      credentialDirectory,
      AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME,
    )}`,
  );
  const ownerEmailSha256 = assertAuthorityProcessingOwnerEmailBinding(
    options.config.database_path,
    {
      organization_id: sourceBinding.organization_id,
      principal_id: sourceBinding.principal_id,
      membership_id: sourceBinding.membership_id,
      membership_type: sourceBinding.membership_type,
    },
    ownerEmail,
  );
  const credentialScope = readPrivateAuthorityOrganizationCredentialScope(
    `file:${join(
      credentialDirectory,
      AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME,
    )}`,
  );
  if (
    ownerEmailSha256 !== sourceBinding.owner_email_sha256 ||
    credentialScope !== sourceBinding.credential_scope ||
    authorityProcessingCredentialReferenceSha256(
      AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
    ) !== sourceBinding.credential_reference_sha256
  ) {
    throw new Error(
      'Authority meeting source files differ from the provisioned source binding',
    );
  }
  const granolaCredential =
    readPrivateAuthorityGranolaOrganizationCredential(
      `file:${join(
        credentialDirectory,
        AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME,
      )}`,
    );

  const authorityDescriptor = options.authority.descriptor();

  const slackCredential = options.integrationSecrets.read(
    slackBinding.organization_tool.secret,
  );
  const slackCredentialReference = `file:${join(
    credentialDirectory,
    'integrations',
    `${slackBinding.organization_tool.secret.secret_handle_id}.secret`,
  )}`;
  const resolveSlackCredential = (reference: string): string | undefined =>
    reference === slackCredentialReference ? slackCredential : undefined;

  const store = new SqliteAuthorityProcessingStore(
    options.config.database_path,
    {
      organization_id: sourceBinding.organization_id,
      principal_id: sourceBinding.principal_id,
      membership_id: sourceBinding.membership_id,
      membership_type: sourceBinding.membership_type,
      source_adapter_id: sourceBinding.source_adapter_id,
      source_instance_id: sourceBinding.source_instance_id,
    },
    {
      bindingMode: 'require-existing',
      sourceConfiguration: {
        owner_email_sha256: sourceBinding.owner_email_sha256,
        credential_scope: sourceBinding.credential_scope,
        credential_reference_sha256:
          sourceBinding.credential_reference_sha256,
      },
      fileMustExist: true,
    },
  );

  try {
    await store.initialize();

    const sourceConfig = adapterConfig(
      'granola',
      sourceBinding.source_instance_id,
      { page_size: 1, owner_email: ownerEmail },
      GRANOLA_CREDENTIAL_REF,
    );
    const source = createGranolaMeetingSourceAdapter(sourceConfig, {
      credentialResolver: async (reference) =>
        reference === GRANOLA_CREDENTIAL_REF ? granolaCredential : undefined,
    });
    assertValidAdapter('Granola meeting source', source, sourceConfig);

    const processorConfig = adapterConfig(
      'structured-text',
      policy.decision_processor_adapter_instance_id,
      {},
    );
    const processor = createStructuredTextDecisionProcessor(processorConfig);
    assertValidAdapter('structured-text decision processor', processor, processorConfig);

    const bridge = new ServerInstallationCompatibilityBridge({
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
              previous_access_state_sha256:
                input.current_access_state_sha256,
              requested_active_lease_ttl_ms:
                options.config.active_lease_ttl_ms,
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

    const approvalConfig = adapterConfig(
      'slack-reactions',
      policy.approval_surface_adapter_instance_id,
      {
        channel_id: slackBinding.organization_tool.channel_id,
        reviewer: {
          slack_user_id: slackBinding.reviewer_slack_user_id,
          name: reviewer.display_name,
        },
        approve_reaction: slackBinding.organization_tool.approve_reaction,
        reject_reaction: slackBinding.organization_tool.reject_reaction,
        presentation_mode: 'organization-member-readable-v1',
      },
      slackCredentialReference,
    );
    const approval = createSlackReactionsApprovalSurface(approvalConfig, {
      store,
      approvalActionAuthorizer: bridge,
      organizationMemberApprovalActionAuthorizer: bridge,
      organizationMemberAuthorizationEvidenceValidator:
        validateOrganizationMemberAuthorizationEvidence,
      reviewerDisplayNameValidator: assertReviewerDisplayName,
      organizationMemberPresentationRenderer:
        organizationMemberApprovalPresentationRenderer,
      credentialResolver: resolveSlackCredential,
    });
    assertValidAdapter('Slack approval surface', approval, approvalConfig);
    if (
      approval.identity.adapter_id !== slackBinding.adapter_id ||
      approval.identity.instance_id !== slackBinding.adapter_instance_id ||
      approval.identity.version !== slackBinding.adapter_version
    ) {
      throw new Error(
        'Slack approval adapter differs from its active runtime binding',
      );
    }

    const deliveryConfig = adapterConfig(
      'slack',
      policy.approval_surface_adapter_instance_id,
      { channel_id: slackBinding.organization_tool.channel_id },
      slackCredentialReference,
    );
    const finalSlackDelivery = new SlackDeliverySurface(deliveryConfig, {
      receiptStore: new FileSlackDeliveryReceiptStore(
        options.config.state_directory,
        deliveryConfig.instance_id,
      ),
      credentialResolver: resolveSlackCredential,
    });
    assertValidAdapter('Slack delivery surface', finalSlackDelivery, deliveryConfig);

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
    const delivery = new OrganizationMemberRecordFirstDeliverySurface({
      approvalMetadata:
        new SqliteOrganizationMemberRecordApprovalMetadataLookup(store),
      recordEnvelopes: store,
      recordEnvelopeBuilder,
      records: options.records,
      finalDelivery: finalSlackDelivery,
    });

    const worker = new SerializedAuthorityMeetingWorker({
      runCycle: async (signal) => {
        const result = await runAuthorityLiveMeetingCycle(
          {
            meetingSource: source,
            decisionProcessor: processor,
            approvalGate: approval,
            deliverySurfaces: [delivery],
            state: store,
          },
          signal,
        );
        if (!result.ok) throw boundedCycleFailure(result);
      },
      onError: (error) => {
        process.stderr.write(
          `authority_meeting_worker_cycle_failed message=${JSON.stringify(error.message.slice(0, 512))}\n`,
        );
      },
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      close: (): Promise<void> => {
        closePromise ??= worker.close().then(() => store.close());
        return closePromise;
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }
}
