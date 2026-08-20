import { join } from 'node:path';
import {
  FileOrganizationSecretStore,
  OrganizationIntegrationsRepository,
} from '@echo-brain/organization-control-plane';
import { readAuthorityProcessingSourceRuntimeBinding } from '../adapters/persistence/sqlite/processing-source-runtime-binding.js';
import { assertAuthorityProcessingOwnerEmailBinding } from '../adapters/persistence/sqlite/processing-source-identity.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  readPrivateAuthorityCredential,
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
  readPrivateAuthorityOrganizationCredentialScope,
} from '../adapters/security/private-file-credentials.js';
import type { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import type { ReadableSearchAuthorizationFence } from '../application/readable-search-authorization-fence.js';
import { isOrganizationMemberReadableRecordingPolicy } from '../application/organization-recording-policy.js';
import { createSlackReactionsApprovalSurface } from '../processing/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { createLlmDecisionProcessor } from '../processing/adapters/decision-processors/llm/llm-decision-processor.js';
import { SlackDeliverySurface } from '../processing/adapters/delivery-surfaces/slack/slack-delivery-surface.js';
import { createGranolaMeetingSourceAdapter } from '../processing/adapters/meeting-sources/granola/index.js';
import { validateOrganizationMemberAuthorizationEvidence } from '../processing/authorization/organization-member-authorization-evidence.js';
import { assertReviewerDisplayName } from '../processing/authorization/reviewer-authorization-evidence.js';
import type { AdapterConfig as AuthorityLiveAdapterConfig } from '../processing/core/contracts/adapter.js';
import {
  runCoreCycle,
  type CoreCycleResult as AuthorityLiveMeetingCycleResult,
} from '../processing/core/processing/run-core-cycle.js';
import { SerializedAuthorityMeetingWorker } from '../processing/live/serialized-authority-meeting-worker.js';
import { organizationMemberApprovalPresentationRenderer } from '../processing/record/adapters/organization-member-presentation-renderer.js';
import { SqliteAuthorityProcessingStore } from '../processing/storage/sqlite-authority-processing-store.js';
import type { OrganizationRecordRuntime } from './organization-record.js';
import type { ComposedOrganizationIntegrationsApplication } from './organization-integrations.js';
import type { AuthorityServeConfig } from './config.js';
import {
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
  AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME,
  authorityProcessingCredentialReferenceSha256,
} from './processing-source-credentials.js';
import {
  composeServerInstallationRecordWriter,
  inspectServerInstallationRecordIdentity,
} from './server-installation-record-writer.js';

const GRANOLA_CREDENTIAL_REF = 'authority:granola-organization-api-key';
const AUTHORITY_OPENROUTER_CREDENTIAL_FILENAME = 'openrouter-api-key';
const AUTHORITY_OPENROUTER_MODEL = 'deepseek/deepseek-r1';
const AUTHORITY_OPENROUTER_REQUEST_TIMEOUT_MS = 600_000;

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

export function authorityLiveDecisionProcessorConfig(
  instanceId: string,
  credentialReference: string,
): AuthorityLiveAdapterConfig {
  return adapterConfig(
    'llm',
    instanceId,
    {
      provider: 'openrouter',
      model: AUTHORITY_OPENROUTER_MODEL,
      max_output_tokens: 8_192,
      request_timeout_ms: AUTHORITY_OPENROUTER_REQUEST_TIMEOUT_MS,
    },
    credentialReference,
  );
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
  const installationIdentity = inspectServerInstallationRecordIdentity(options);
  const {
    installationDescriptor,
    reviewerEnrollment,
  } = installationIdentity;

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
  const recordWriting = composeServerInstallationRecordWriter(
    options,
    installationIdentity,
  );
  const bridge = recordWriting.compatibilityBridge;
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

  const openRouterCredentialReference = `file:${join(
    processingCredentialDirectory,
    AUTHORITY_OPENROUTER_CREDENTIAL_FILENAME,
  )}`;
  const openRouterCredential = readPrivateAuthorityCredential(
    openRouterCredentialReference,
  );
  const resolveOpenRouterCredential = (
    reference: string,
  ): string | undefined =>
    reference === openRouterCredentialReference
      ? openRouterCredential
      : undefined;

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

    const processorConfig = authorityLiveDecisionProcessorConfig(
      policy.decision_processor_adapter_instance_id,
      openRouterCredentialReference,
    );
    const processor = createLlmDecisionProcessor(processorConfig, {
      credentialResolver: resolveOpenRouterCredential,
    });
    assertValidAdapter(
      'OpenRouter decision processor',
      processor,
      processorConfig,
    );

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
      receiptStore: store,
      credentialResolver: resolveSlackCredential,
    });
    assertValidAdapter('Slack delivery surface', finalSlackDelivery, deliveryConfig);

    const resolvedActWriter = recordWriting.createResolvedActWriter(store);

    const worker = new SerializedAuthorityMeetingWorker({
      runCycle: async (signal) => {
        const result = await runCoreCycle(
          {
            meetingSource: source,
            decisionProcessor: processor,
            approvalGate: approval,
            deliverySurfaces: [finalSlackDelivery],
            resolvedActWriter,
            state: store,
            deadlines: { extractMs: AUTHORITY_OPENROUTER_REQUEST_TIMEOUT_MS },
            signal,
          },
          { limit: 1 },
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
