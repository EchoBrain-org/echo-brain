import type {
  AcceptedOrganizationRecordV1,
  SubmitOrganizationRecordEnvelopeRequestV1,
} from '@echo-brain/organization-api';
import type { OrganizationRecordSourceLocatorV1 } from '@echo-brain/organization-protocol';
import { AdapterError } from '../../core/contracts/adapter.js';
import type { AdapterOperationContext } from '../../core/contracts/adapter.js';
import type { JsonObject } from '../../core/contracts/json.js';
import type { ApprovalDecision } from '../../core/approval/approval-gate.js';
import type { ResolvedActWriter } from '../../core/ports/adapters.js';
import type {
  BuiltOrganizationRecordEnvelope,
  OrganizationRecordAuthorizationEvidence,
  OrganizationRecordEnvelopeBuilder,
} from '../ports.js';

export interface ResolvedOrganizationRecordMetadata {
  readonly approval_id: string;
  readonly meeting_id: string;
  readonly source: OrganizationRecordSourceLocatorV1;
  readonly reviewed_by: string;
  readonly submitted_at: string;
  readonly authorization: OrganizationRecordAuthorizationEvidence;
  readonly surface: string;
}

/** Resolves the Authority-owned facts for the terminal act, not a delivery. */
export interface ResolvedOrganizationRecordMetadataLookup {
  findForResolvedAct(
    processingKey: string,
    decision: Exclude<ApprovalDecision, { status: 'pending' }>,
  ): Promise<ResolvedOrganizationRecordMetadata | null>;
}

export interface OrganizationRecordAppendApplication {
  submitRecordEnvelope(
    request: SubmitOrganizationRecordEnvelopeRequestV1,
  ): Promise<AcceptedOrganizationRecordV1>;
}

export interface OrganizationRecordSubmitterAccess {
  ensureCurrentInstallationAccess(signal?: AbortSignal): Promise<void>;
}

/** Create-once storage keeps a retry/restart on the exact signed bytes. */
export interface FrozenOrganizationRecordEnvelopeStore {
  getOrCreate(
    idempotencyKey: string,
    create: () => Promise<BuiltOrganizationRecordEnvelope>,
  ): Promise<BuiltOrganizationRecordEnvelope>;
}

export interface ResolvedOrganizationRecordActWriterOptions {
  readonly metadata: ResolvedOrganizationRecordMetadataLookup;
  readonly recordEnvelopes: FrozenOrganizationRecordEnvelopeStore;
  readonly recordEnvelopeBuilder: OrganizationRecordEnvelopeBuilder;
  readonly installationAccess: OrganizationRecordSubmitterAccess;
  readonly records: OrganizationRecordAppendApplication;
}

/**
 * Compatibility writer over the existing record application boundary. It does
 * not invent a record protocol: the existing V1 rejection, V2 reviewer, and
 * V3 organization-member builders select the wire shape from stored evidence.
 */
export class ResolvedOrganizationRecordActWriter implements ResolvedActWriter {
  constructor(private readonly options: ResolvedOrganizationRecordActWriterOptions) {}

  async write(
    input: Parameters<ResolvedActWriter['write']>[0],
    context?: AdapterOperationContext,
  ): Promise<void> {
    context?.signal.throwIfAborted();
    const metadata = await this.options.metadata.findForResolvedAct(
      input.processing_key,
      input.decision,
    );
    if (metadata === null) {
      throw new AdapterError(
        'temporarily_unavailable',
        'resolved organization record metadata is unavailable',
        true,
      );
    }
    if (metadata.meeting_id !== input.meeting.id) {
      throw new AdapterError(
        'permanently_rejected',
        'resolved organization record metadata does not bind this meeting',
        false,
      );
    }
    const record = await this.options.recordEnvelopes.getOrCreate(
      metadata.approval_id,
      async () =>
        await this.options.recordEnvelopeBuilder.build({
          event_type: input.decision.status === 'approved' ? 'approval' : 'rejection',
          approval_id: metadata.approval_id,
          source: metadata.source,
          meeting_id: input.meeting.id,
          brief:
            input.decision.status === 'approved'
              ? input.decision.approved_brief
              : null,
          alternatives: [],
          links: { parent: null, supersedes: null },
          reviewed_at: input.decision.reviewed_at,
          reviewed_by: metadata.reviewed_by,
          reason: input.decision.reason,
          surface: metadata.surface,
          authorization: metadata.authorization,
          submitted_at: metadata.submitted_at,
        }),
    );
    this.assertExactRecord(record, metadata.approval_id, input.decision.status);
    context?.signal.throwIfAborted();
    await this.options.installationAccess.ensureCurrentInstallationAccess(context?.signal);
    context?.signal.throwIfAborted();
    await this.options.records.submitRecordEnvelope({ record_envelope: record.envelope });
  }

  private assertExactRecord(
    record: BuiltOrganizationRecordEnvelope,
    approvalId: string,
    status: 'approved' | 'rejected',
  ): void {
    const envelope = record.envelope as unknown as JsonObject;
    const eventType = status === 'approved' ? 'approval' : 'rejection';
    if (
      record.idempotency_key !== approvalId ||
      record.event_type !== eventType ||
      envelope['kind'] !== 'echo-organization-record-envelope' ||
      envelope['envelope_id'] !== record.envelope_id ||
      envelope['idempotency_key'] !== approvalId ||
      envelope['event_type'] !== eventType ||
      ![1, 2, 3].includes(envelope['schema_version'] as number)
    ) {
      throw new AdapterError(
        'permanently_rejected',
        'frozen organization record envelope does not match its terminal act',
        false,
      );
    }
  }
}
