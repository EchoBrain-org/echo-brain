import { createHash } from 'node:crypto';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE,
  RESTRICTED_REVIEWER_RECORD_SURFACE,
  type OrganizationRecordReviewerAuthorizationV1,
} from '@echo-brain/organization-protocol';
import { validateOrganizationMemberAuthorizationEvidence } from '../../authorization/organization-member-authorization-evidence.js';
import { validateReviewerAuthorizationEvidence } from '../../authorization/reviewer-authorization-evidence.js';
import type { ApprovalDecision } from '../../core/approval/approval-gate.js';
import type {
  AuthorityTerminalRecordAct,
} from '../../storage/sqlite-authority-processing-store.js';
import type {
  ResolvedOrganizationRecordMetadata,
  ResolvedOrganizationRecordMetadataLookup,
} from './resolved-organization-record-act-writer.js';
import type { OrganizationRecordAuthorizationEvidence } from '../ports.js';

export interface ResolvedOrganizationRecordMetadataStore {
  readTerminalRecordAct(processingKey: string): AuthorityTerminalRecordAct | null;
}

function approvalId(processingKey: string): string {
  return createHash('sha256').update(processingKey, 'utf8').digest('hex');
}

/** Rejoins a resolved core act to the immutable Authority facts stored beside it. */
export class SqliteResolvedOrganizationRecordMetadataLookup
  implements ResolvedOrganizationRecordMetadataLookup
{
  constructor(private readonly store: ResolvedOrganizationRecordMetadataStore) {}

  async findForResolvedAct(
    processingKey: string,
    decision: Exclude<ApprovalDecision, { status: 'pending' }>,
  ): Promise<ResolvedOrganizationRecordMetadata | null> {
    const stored = this.store.readTerminalRecordAct(processingKey);
    const candidate = stored?.candidate;
    const approval = stored?.decision;
    const id = approvalId(processingKey);
    const resolution = stored?.metadata;
    if (
      candidate === undefined ||
      candidate.first_request === null ||
      approval === undefined ||
      canonicalJson(approval) !== canonicalJson(decision) ||
      approval.status !== decision.status ||
      resolution === undefined ||
      resolution.approval_id !== id ||
      resolution.resolved_at !== approval.reviewed_at ||
      (approval.status === 'approved' &&
        (canonicalJson(candidate.first_request.brief) !== canonicalJson(approval.approved_brief) ||
          approval.approved_brief === null))
    ) {
      return null;
    }
    let authorization;
    let surface: string;
    try {
      const evidence = resolution.metadata['authorization'];
      const schema = (evidence as { schema_version?: unknown } | null)?.schema_version;
      if (
        schema === 3 &&
        approval.status === 'approved' &&
        resolution.surface === 'slack-organization-member-readable-v1'
      ) {
        authorization = validateOrganizationMemberAuthorizationEvidence(evidence);
        surface = ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE;
      } else if (
        schema === 2 &&
        approval.status === 'approved' &&
        resolution.surface === 'slack-reviewer-v1'
      ) {
        authorization = validateReviewerAuthorizationEvidence(evidence);
        surface = RESTRICTED_REVIEWER_RECORD_SURFACE;
      } else if (schema === 1 && resolution.surface === 'slack-authority-v1') {
        const v1 = evidence as unknown as OrganizationRecordReviewerAuthorizationV1;
        if (
          v1?.kind !== 'echo-organization-authorization-evidence' ||
          v1.approval_id !== id ||
          v1.action !== (approval.status === 'approved' ? 'approve' : 'reject') ||
          v1.allowed !== true ||
          v1.evaluated_at !== approval.reviewed_at
        ) return null;
        authorization = v1;
        surface = resolution.surface;
      } else return null;
      if (authorization.approval_id !== id || authorization.evaluated_at !== approval.reviewed_at) return null;
    } catch {
      return null;
    }
    const source = candidate.meeting.provenance;
    return Object.freeze({
      approval_id: id,
      meeting_id: candidate.meeting.id,
      source: {
        adapter_id: source.source.adapter_id,
        instance_id: source.source.instance_id,
        external_id: source.external_id,
      },
      reviewed_by: approval.reviewed_by,
      submitted_at: resolution.resolved_at,
      authorization: authorization as OrganizationRecordAuthorizationEvidence,
      surface,
    });
  }
}
