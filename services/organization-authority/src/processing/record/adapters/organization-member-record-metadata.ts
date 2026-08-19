import { createHash } from 'node:crypto';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE,
  type OrganizationRecordOrganizationMemberAuthorizationV3,
} from '@echo-brain/organization-protocol';
import { validateOrganizationMemberAuthorizationEvidence } from '../../authorization/organization-member-authorization-evidence.js';
import type { ApprovalDecision } from '../../core/approval/approval-gate.js';
import type { DeliveryEnvelope } from '../../core/contracts/delivery.js';
import { approvedBriefDigest } from '../../core/delivery/envelope.js';
import type {
  AuthorityApprovalResolutionMetadata,
  AuthorityProcessingCandidate,
} from '../../storage/sqlite-authority-processing-store.js';
import type {
  OrganizationMemberRecordApprovalMetadata,
  OrganizationMemberRecordApprovalMetadataLookup,
} from './organization-member-record-first-delivery.js';

export interface OrganizationMemberRecordMetadataStore {
  getCandidate(
    processingKey: string,
  ): Promise<AuthorityProcessingCandidate | undefined>;
  getApproval(processingKey: string): Promise<ApprovalDecision | undefined>;
  readApprovalResolutionMetadata(
    approvalId: string,
  ): AuthorityApprovalResolutionMetadata | null;
}

function deliveryProcessingKey(envelope: DeliveryEnvelope): string | null {
  const prefix = 'delivery:v1:';
  if (!envelope.idempotency_key.startsWith(prefix)) return null;
  let identity: unknown;
  try {
    identity = JSON.parse(envelope.idempotency_key.slice(prefix.length));
  } catch {
    return null;
  }
  if (
    !Array.isArray(identity) ||
    identity.length !== 5 ||
    identity.some((value) => typeof value !== 'string') ||
    identity[1] !== approvedBriefDigest(envelope.brief) ||
    identity[2] !== envelope.destination.adapter_id ||
    identity[3] !== envelope.destination.instance_id ||
    identity[4] !== envelope.destination.external_id
  ) {
    return null;
  }
  return identity[0] as string;
}

function approvalId(processingKey: string): string {
  return createHash('sha256').update(processingKey, 'utf8').digest('hex');
}

/** Rejoins one core delivery to the immutable approval facts stored beside it. */
export class SqliteOrganizationMemberRecordApprovalMetadataLookup
  implements OrganizationMemberRecordApprovalMetadataLookup
{
  constructor(private readonly store: OrganizationMemberRecordMetadataStore) {}

  async findForDelivery(
    envelope: DeliveryEnvelope,
  ): Promise<OrganizationMemberRecordApprovalMetadata | null> {
    const processingKey = deliveryProcessingKey(envelope);
    if (processingKey === null) return null;
    const candidate = await this.store.getCandidate(processingKey);
    const approval = await this.store.getApproval(processingKey);
    const id = approvalId(processingKey);
    const resolution = this.store.readApprovalResolutionMetadata(id);
    if (
      candidate === undefined ||
      candidate.first_request === null ||
      approval?.status !== 'approved' ||
      resolution === null ||
      resolution.approval_id !== id ||
      resolution.surface !== ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE ||
      resolution.resolved_at !== approval.reviewed_at ||
      canonicalJson(candidate.first_request.brief) !==
        canonicalJson(envelope.brief) ||
      canonicalJson(approval.approved_brief) !== canonicalJson(envelope.brief)
    ) {
      return null;
    }
    const evidence = validateOrganizationMemberAuthorizationEvidence(
      resolution.metadata['authorization'],
    );
    if (
      evidence.approval_id !== id ||
      evidence.evaluated_at !== approval.reviewed_at
    ) {
      return null;
    }
    const source = candidate.meeting.provenance;
    return Object.freeze({
      approval_id: id,
      source: {
        adapter_id: source.source.adapter_id,
        instance_id: source.source.instance_id,
        external_id: source.external_id,
      },
      reviewed_by: approval.reviewed_by,
      submitted_at: resolution.resolved_at,
      authorization:
        evidence as OrganizationRecordOrganizationMemberAuthorizationV3,
    });
  }
}
