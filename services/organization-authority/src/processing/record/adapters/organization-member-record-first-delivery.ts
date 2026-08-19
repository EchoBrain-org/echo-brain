import type {
  AcceptedOrganizationRecordV1,
  SubmitOrganizationRecordEnvelopeRequestV1,
} from '@echo-brain/organization-api';
import {
  ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationRecordOrganizationMemberAuthorizationV3,
  OrganizationRecordSourceLocatorV1,
} from '@echo-brain/organization-protocol';
import { AdapterError } from '../../core/contracts/adapter.js';
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
} from '../../core/contracts/adapter.js';
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../core/contracts/delivery.js';
import type { DeliverySurfaceAdapter } from '../../core/ports/adapters.js';
import type {
  BuiltOrganizationRecordEnvelope,
  OrganizationRecordEnvelopeBuilder,
} from '../ports.js';

/** Immutable approval facts recovered from the Authority processing store. */
export interface OrganizationMemberRecordApprovalMetadata {
  readonly approval_id: string;
  readonly source: OrganizationRecordSourceLocatorV1;
  readonly reviewed_by: string;
  /** Frozen submit time; retries must rebuild no timestamp. */
  readonly submitted_at: string;
  readonly authorization: OrganizationRecordOrganizationMemberAuthorizationV3;
}

export interface OrganizationMemberRecordApprovalMetadataLookup {
  findForDelivery(
    envelope: DeliveryEnvelope,
  ): Promise<OrganizationMemberRecordApprovalMetadata | null>;
}

/** The current Authority record-ingest application surface, kept structural. */
export interface OrganizationRecordAppendApplication {
  submitRecordEnvelope(
    request: SubmitOrganizationRecordEnvelopeRequestV1,
  ): Promise<AcceptedOrganizationRecordV1>;
}

/**
 * Durable create-once storage for the signed record envelope. The callback may
 * run only when this idempotency key has no frozen envelope; concurrent calls
 * return the same winner.
 */
export interface FrozenOrganizationRecordEnvelopeStore {
  getOrCreate(
    idempotencyKey: string,
    create: () => Promise<BuiltOrganizationRecordEnvelope>,
  ): Promise<BuiltOrganizationRecordEnvelope>;
}

export interface OrganizationMemberRecordFirstDeliveryOptions {
  readonly approvalMetadata: OrganizationMemberRecordApprovalMetadataLookup;
  readonly recordEnvelopes: FrozenOrganizationRecordEnvelopeStore;
  readonly recordEnvelopeBuilder: OrganizationRecordEnvelopeBuilder;
  readonly records: OrganizationRecordAppendApplication;
  readonly finalDelivery: DeliverySurfaceAdapter;
}

/**
 * One delivery edge with fixed ordering: append the readable record, then send
 * the final Slack delivery. A Slack retry repeats the idempotent record append
 * with the same frozen signed bytes before trying Slack again.
 */
export class OrganizationMemberRecordFirstDeliverySurface
  implements DeliverySurfaceAdapter
{
  readonly identity: DeliverySurfaceAdapter['identity'];
  readonly destination: DeliverySurfaceAdapter['destination'];

  constructor(
    private readonly options: OrganizationMemberRecordFirstDeliveryOptions,
  ) {
    this.identity = options.finalDelivery.identity;
    this.destination = options.finalDelivery.destination;
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    return this.options.finalDelivery.validateConfig(config);
  }

  async healthCheck(
    context?: AdapterOperationContext,
  ): Promise<AdapterHealth> {
    return await this.options.finalDelivery.healthCheck(context);
  }

  async publish(
    envelope: DeliveryEnvelope,
    context?: AdapterOperationContext,
  ): Promise<DeliveryReceipt> {
    context?.signal.throwIfAborted();
    const metadata =
      await this.options.approvalMetadata.findForDelivery(envelope);
    if (metadata === null) {
      throw new AdapterError(
        'temporarily_unavailable',
        'organization-member record approval metadata is unavailable',
        true,
      );
    }

    const record = await this.options.recordEnvelopes.getOrCreate(
      metadata.approval_id,
      async () =>
        await this.options.recordEnvelopeBuilder.build({
          event_type: 'approval',
          approval_id: metadata.approval_id,
          source: metadata.source,
          meeting_id: envelope.brief.meeting.id,
          brief: envelope.brief,
          alternatives: [],
          links: { parent: null, supersedes: null },
          reviewed_at: envelope.approved_at,
          reviewed_by: metadata.reviewed_by,
          reason: null,
          surface: ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE,
          authorization: metadata.authorization,
          submitted_at: metadata.submitted_at,
        }),
    );
    if (
      record.event_type !== 'approval' ||
      record.idempotency_key !== metadata.approval_id ||
      record.envelope.schema_version !== 3
    ) {
      throw new AdapterError(
        'permanently_rejected',
        'frozen organization-member record envelope does not match its approval',
        false,
      );
    }

    context?.signal.throwIfAborted();
    await this.options.records.submitRecordEnvelope({
      record_envelope: record.envelope,
    });
    context?.signal.throwIfAborted();
    return await this.options.finalDelivery.publish(envelope, context);
  }
}
