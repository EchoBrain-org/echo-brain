import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { personLoginGrantExpectedEmailSha256 } from '../../domain/person-email-binding.js';
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  DeliveryEnvelope,
  DeliveryReceipt,
  DeliverySurfaceAdapter,
  JsonObject,
} from '../core/index.js';
import { runCoreCycle } from '../core/index.js';
import {
  createGranolaMeetingSourceAdapter,
  type GranolaApiClient,
} from '../adapters/meeting-sources/granola/index.js';
import { createStructuredTextDecisionProcessor } from '../adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import {
  AuthorityProcessingApprovalGate,
  SqliteAuthorityProcessingStore,
  type AuthorityProcessingStoreBinding,
} from '../storage/sqlite-authority-processing-store.js';

const GRANOLA_ADAPTER_ID = 'granola' as const;
const STRUCTURED_TEXT_ADAPTER_ID = 'structured-text' as const;
const PENDING_ONLY_DELIVERY_ADAPTER_ID = 'authority-pending-only';

export interface RunOneAuthorityMeetingInput {
  readonly database_path: string;
  readonly binding: AuthorityProcessingStoreBinding;
  readonly source_instance_id: string;
  readonly owner_email: string;
  readonly approved_owner_email_sha256: `sha256:${string}`;
  readonly granola_credential: string;
  readonly credential_scope: 'organization';
  readonly credential_reference: string;
  readonly decision_processor_instance_id: string;
}

export interface RunOneAuthorityMeetingOptions {
  /** Test seam. Production constructs the canonical HTTPS Granola client. */
  readonly granola_client?: GranolaApiClient;
  readonly now?: () => string;
  readonly create_id?: () => string;
}

export interface AuthorityOneMeetingRunResult {
  readonly schema_version: 1;
  readonly kind: 'echo-organization-authority-one-meeting-run';
  readonly source: {
    readonly adapter_id: 'granola';
    readonly instance_id: string;
  };
  readonly decision_processor: {
    readonly adapter_id: 'structured-text';
    readonly instance_id: string;
  };
  readonly outcome:
    | 'pending_created'
    | 'pending_exists'
    | 'no_meeting'
    | 'failed';
  readonly source_binding: {
    readonly owner: 'provisioned' | 'existing';
    readonly configuration: 'provisioned' | 'existing';
  };
  readonly ok: boolean;
  readonly meetings_seen: number;
  readonly meetings_processed: number;
  readonly meetings_skipped: number;
  readonly meetings_pending: number;
  readonly meetings_rejected: number;
  readonly meetings_dead_lettered: number;
  readonly deliveries: number;
  readonly cursor_advanced: boolean;
  readonly failure_count: number;
  readonly failure_stages: readonly (
    | 'processing'
    | 'approval'
    | 'delivery'
    | 'contract'
  )[];
  readonly pending_approval_ids: readonly string[];
}

function authorityProcessingCredentialReferenceSha256(
  credentialReference: string,
): `sha256:${string}` {
  return canonicalSha256({
    schema_version: 1,
    kind: 'authority-processing-organization-credential-reference-v1',
    source_adapter_id: GRANOLA_ADAPTER_ID,
    credential_scope: 'organization',
    credential_reference: credentialReference,
  });
}

function validConfig(_config: AdapterConfig): AdapterConfigValidation {
  return { ok: true, errors: [] };
}

async function healthy(): Promise<AdapterHealth> {
  return {
    status: 'healthy',
    checked_at: new Date().toISOString(),
  };
}

/**
 * A deliberate fail-closed terminal edge for the first founder-live rung.
 * The Authority approval gate always stages a new candidate as pending, so
 * this surface is not called on the admitted path. If an already-approved
 * candidate reaches this command, publication refuses instead of pretending
 * that record delivery exists.
 */
class PendingOnlyDeliverySurface implements DeliverySurfaceAdapter {
  readonly identity = {
    kind: 'delivery-surface' as const,
    adapter_id: PENDING_ONLY_DELIVERY_ADAPTER_ID,
    instance_id: 'one-meeting',
    version: '1.0.0',
  };

  readonly destination = {
    adapter_id: this.identity.adapter_id,
    instance_id: this.identity.instance_id,
    external_id: 'pending-only',
  };

  validateConfig = validConfig;
  healthCheck = healthy;

  async publish(
    _envelope: DeliveryEnvelope,
  ): Promise<DeliveryReceipt> {
    throw new Error(
      'one-meeting Authority run refuses delivery until live record delivery is composed',
    );
  }
}

function adapterConfig(
  adapterId: string,
  instanceId: string,
  settings: Readonly<JsonObject>,
  credentialReference?: string,
): AdapterConfig {
  return {
    adapter_id: adapterId,
    instance_id: instanceId,
    ...(credentialReference === undefined
      ? {}
      : { credential_ref: credentialReference }),
    settings,
  };
}

/**
 * Pulls at most one real meeting into the Authority-owned pre-record store.
 * It is intentionally a single call, not a loop or scheduler. A pending
 * result keeps the source cursor in place, making an operator retry converge
 * on the same immutable candidate instead of admitting a second meeting.
 */
export async function runOneAuthorityMeeting(
  input: RunOneAuthorityMeetingInput,
  options: RunOneAuthorityMeetingOptions = {},
): Promise<AuthorityOneMeetingRunResult> {
  if (
    input.binding.source_adapter_id !== GRANOLA_ADAPTER_ID ||
    input.binding.source_instance_id !== input.source_instance_id
  ) {
    throw new Error(
      'Authority one-meeting source differs from its exact store binding',
    );
  }
  if (
    input.credential_scope !== 'organization' ||
    personLoginGrantExpectedEmailSha256(input.owner_email) !==
      input.approved_owner_email_sha256
  ) {
    throw new Error(
      'Authority one-meeting source lacks its exact approved identity and credential scope',
    );
  }
  const sourceConfig = adapterConfig(
    GRANOLA_ADAPTER_ID,
    input.source_instance_id,
    {
      page_size: 1,
      owner_email: input.owner_email,
    },
    'authority:granola-organization-api-key',
  );
  const source = createGranolaMeetingSourceAdapter(sourceConfig, {
    ...(options.granola_client === undefined
      ? {
          credentialResolver: async (reference) =>
            reference === sourceConfig.credential_ref
              ? input.granola_credential
              : undefined,
        }
      : { client: options.granola_client }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const sourceValidation = source.validateConfig(sourceConfig);
  if (!sourceValidation.ok) {
    throw new Error(
      `Authority one-meeting source configuration is invalid: ${sourceValidation.errors.join('; ')}`,
    );
  }

  const processorConfig = adapterConfig(
    STRUCTURED_TEXT_ADAPTER_ID,
    input.decision_processor_instance_id,
    {},
  );
  const processor = createStructuredTextDecisionProcessor(processorConfig, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const processorValidation = processor.validateConfig(processorConfig);
  if (!processorValidation.ok) {
    throw new Error(
      `Authority one-meeting processor configuration is invalid: ${processorValidation.errors.join('; ')}`,
    );
  }

  const store = new SqliteAuthorityProcessingStore(
    input.database_path,
    input.binding,
    {
      bindingMode: 'provision',
      sourceConfiguration: {
        owner_email_sha256: input.approved_owner_email_sha256,
        credential_scope: input.credential_scope,
        credential_reference_sha256:
          authorityProcessingCredentialReferenceSha256(
            input.credential_reference,
          ),
      },
      fileMustExist: true,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
  try {
    await store.initialize();
    const provisioning = store.sourceProvisioningStatus();
    const pendingBefore = await store.listPendingApprovals();
    const unfinishedBefore = await store.countUnfinishedCandidates();
    if (unfinishedBefore > 0 || pendingBefore.length > 0) {
      if (unfinishedBefore !== 1 || pendingBefore.length !== 1) {
        throw new Error(
          'Authority one-meeting source has unfinished work that cannot be resumed by the pending-only command',
        );
      }
      return Object.freeze({
        schema_version: 1,
        kind: 'echo-organization-authority-one-meeting-run',
        source: {
          adapter_id: GRANOLA_ADAPTER_ID,
          instance_id: input.source_instance_id,
        },
        decision_processor: {
          adapter_id: STRUCTURED_TEXT_ADAPTER_ID,
          instance_id: input.decision_processor_instance_id,
        },
        outcome: 'pending_exists',
        source_binding: {
          owner: provisioning.owner_binding,
          configuration: provisioning.configuration_binding,
        },
        ok: true,
        meetings_seen: 0,
        meetings_processed: 0,
        meetings_skipped: 0,
        meetings_pending: 1,
        meetings_rejected: 0,
        meetings_dead_lettered: 0,
        deliveries: 0,
        cursor_advanced: false,
        failure_count: 0,
        failure_stages: [],
        pending_approval_ids: [pendingBefore[0]!.approval_id],
      });
    }
    const result = await runCoreCycle(
      {
        meetingSource: source,
        decisionProcessor: processor,
        deliverySurfaces: [new PendingOnlyDeliverySurface()],
        approvalGate: new AuthorityProcessingApprovalGate(store),
        state: store,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.create_id === undefined
          ? {}
          : { createId: options.create_id }),
      },
      { limit: 1 },
    );
    const pendingAfter = await store.listPendingApprovals();
    const exactPendingCreated =
      result.ok &&
      result.meetings_seen === 1 &&
      result.meetings_processed === 0 &&
      result.meetings_skipped === 0 &&
      result.meetings_pending === 1 &&
      result.meetings_rejected === 0 &&
      result.meetings_dead_lettered === 0 &&
      result.deliveries === 0 &&
      !result.cursor_advanced &&
      pendingAfter.length === 1;
    const exactNoMeeting =
      result.ok &&
      result.meetings_seen === 0 &&
      result.meetings_processed === 0 &&
      result.meetings_skipped === 0 &&
      result.meetings_pending === 0 &&
      result.meetings_rejected === 0 &&
      result.meetings_dead_lettered === 0 &&
      result.deliveries === 0 &&
      pendingAfter.length === 0;
    const contractFailure =
      result.ok && !exactPendingCreated && !exactNoMeeting;
    const outcome = exactPendingCreated
      ? 'pending_created'
      : exactNoMeeting
        ? 'no_meeting'
        : 'failed';
    const output: AuthorityOneMeetingRunResult = {
      schema_version: 1,
      kind: 'echo-organization-authority-one-meeting-run',
      source: {
        adapter_id: GRANOLA_ADAPTER_ID,
        instance_id: input.source_instance_id,
      },
      decision_processor: {
        adapter_id: STRUCTURED_TEXT_ADAPTER_ID,
        instance_id: input.decision_processor_instance_id,
      },
      outcome,
      source_binding: {
        owner: provisioning.owner_binding,
        configuration: provisioning.configuration_binding,
      },
      ok: outcome !== 'failed',
      meetings_seen: result.meetings_seen,
      meetings_processed: result.meetings_processed,
      meetings_skipped: result.meetings_skipped,
      meetings_pending: result.meetings_pending,
      meetings_rejected: result.meetings_rejected,
      meetings_dead_lettered: result.meetings_dead_lettered,
      deliveries: result.deliveries,
      cursor_advanced: result.cursor_advanced,
      failure_count: result.failures.length + (contractFailure ? 1 : 0),
      failure_stages: [
        ...new Set(result.failures.map((failure) => failure.stage)),
        ...(contractFailure ? (['contract'] as const) : []),
      ].sort(),
      pending_approval_ids: pendingAfter
        .map((item) => item.approval_id)
        .sort(),
    };
    return Object.freeze(output);
  } finally {
    store.close();
  }
}
