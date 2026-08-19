import type { JsonObject } from '@echo-brain/federation-protocol';
import type {
  OrganizationRecordDecisionBriefV1,
  OrganizationRecordEnvelopeAnyVersion,
  OrganizationRecordEventTypeV1,
  OrganizationRecordOrganizationMemberAuthorizationV3,
  OrganizationRecordReviewerAuthorizationV1,
  OrganizationRecordReviewerAuthorizationV2,
  OrganizationRecordSourceLocatorV1,
} from '@echo-brain/organization-protocol';

/** Every authorization family currently admitted by the record protocol. */
export type OrganizationRecordAuthorizationEvidence =
  | OrganizationRecordReviewerAuthorizationV1
  | OrganizationRecordReviewerAuthorizationV2
  | OrganizationRecordOrganizationMemberAuthorizationV3;

/**
 * The resolved processing result required to build one signed record envelope.
 * `approval_id` is the content-derived sha256 of the processing key and is
 * preserved byte-for-byte as the protocol idempotency key.
 */
export interface OrganizationRecordEnvelopeBuildInput {
  readonly event_type: OrganizationRecordEventTypeV1;
  readonly approval_id: string;
  readonly source: OrganizationRecordSourceLocatorV1;
  readonly meeting_id: string;
  /** The approved brief, or null for a rejection. */
  readonly brief: OrganizationRecordDecisionBriefV1 | null;
  readonly alternatives: readonly JsonObject[];
  readonly links: {
    readonly parent: string | null;
    readonly supersedes: string | null;
  };
  readonly reviewed_at: string;
  /** Display only; authorization evidence carries the identity of record. */
  readonly reviewed_by: string;
  readonly reason: string | null;
  readonly surface: string;
  readonly authorization: OrganizationRecordAuthorizationEvidence;
  readonly submitted_at: string;
}

export interface BuiltOrganizationRecordEnvelope {
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly event_type: OrganizationRecordEventTypeV1;
  readonly envelope: OrganizationRecordEnvelopeAnyVersion;
}

export interface OrganizationRecordEnvelopeBuilder {
  build(
    input: OrganizationRecordEnvelopeBuildInput,
  ): Promise<BuiltOrganizationRecordEnvelope>;
}
