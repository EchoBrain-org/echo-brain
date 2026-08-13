import type {
  JsonObject,
  P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
  createOrganizationRecordApprovalEnvelope,
  createOrganizationRecordOrganizationMemberApprovalEnvelope,
  createOrganizationRecordRejectionEnvelope,
  createOrganizationRecordReviewerApprovalEnvelope,
  organizationRecordEnvelopeId,
  organizationRecordOrganizationMemberIntent,
  organizationRecordReviewerIntent,
} from '@echo-brain/organization-protocol';
import type {
  CanonicalPayloadSigner,
  OrganizationRecordApprovalPayloadV1,
  OrganizationRecordDecisionBriefV1,
  OrganizationRecordOrganizationMemberAuthorizationV3,
  OrganizationRecordRejectionPayloadV1,
  OrganizationRecordReviewerAuthorizationV1,
  OrganizationRecordReviewerAuthorizationV2,
  OrganizationRecordReviewerV1,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import type {
  BuiltOrganizationRecordEnvelope,
  OrganizationRecordEnvelopeBuildInput,
  OrganizationRecordEnvelopeBuilder,
} from '../ports.js';

export interface ProtocolOrganizationRecordEnvelopeBuilderOptions {
  /** The out-of-band pinned authority this member is enrolled with. */
  readonly pinnedAuthority: PinnedOrganizationAuthority;
  readonly installationSigningKey: P256SigningKeyDescriptor;
  /** Signs the RFC 8785 canonical payload bytes with the installation key. */
  readonly sign: CanonicalPayloadSigner;
  /** Injected only so a test can pin the frozen id; production generates one. */
  readonly nextEnvelopeId?: () => string;
}

/**
 * V1 carries `links` for shape stability and pins it to null on the wire. The
 * local store hardcodes both members to null, so anything else means a node
 * gained linkage this protocol version cannot express — refuse rather than
 * silently drop it.
 */
function protocolLinks(links: OrganizationRecordEnvelopeBuildInput['links']): null {
  if (links.parent !== null || links.supersedes !== null) {
    throw new Error(
      'organization record schema version 1 carries no decision links',
    );
  }
  return null;
}

function reviewer(
  authorization: OrganizationRecordReviewerAuthorizationV1,
  reviewedBy: string,
): OrganizationRecordReviewerV1 {
  return {
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    reviewed_by: reviewedBy,
    authorization,
  };
}

/**
 * The concrete envelope builder: it turns one resolved decision node into the
 * exact signed wire document `packages/organization-protocol` defines.
 *
 * Everything durable about the envelope — canonicalization, the payload
 * schema, the intent pin, the reviewer-evidence binding — belongs to the
 * protocol package. This adapter only maps the submitter's local view onto it,
 * and every value it produces is re-validated by the protocol's own creator
 * before a signature is ever requested.
 */
export class ProtocolOrganizationRecordEnvelopeBuilder
  implements OrganizationRecordEnvelopeBuilder
{
  private readonly nextEnvelopeId: () => string;

  constructor(
    private readonly options: ProtocolOrganizationRecordEnvelopeBuilderOptions,
  ) {
    this.nextEnvelopeId =
      options.nextEnvelopeId ?? organizationRecordEnvelopeId;
  }

  async build(
    input: OrganizationRecordEnvelopeBuildInput,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    if (
      (input.authorization as unknown as { schema_version?: unknown })
        .schema_version === 3
    ) {
      return await this.buildOrganizationMemberApproval(input);
    }
    if (
      (input.authorization as unknown as { schema_version?: unknown })
        .schema_version === 2
    ) {
      return await this.buildReviewerApproval(input);
    }
    const authorization =
      input.authorization as unknown as OrganizationRecordReviewerAuthorizationV1;
    const envelopeId = this.nextEnvelopeId();
    const common = {
      envelope_id: envelopeId,
      idempotency_key: input.approval_id,
      reviewer: reviewer(authorization, input.reviewed_by),
      submitter: {
        installation_id: authorization.installation_id,
        submitted_at: input.submitted_at,
      },
      installation_signing_key: this.options.installationSigningKey,
    };
    const envelope =
      input.event_type === 'approval'
        ? await createOrganizationRecordApprovalEnvelope(
            {
              ...common,
              payload: this.approvalPayload(input),
              // No approval surface can express intent yet, so the
              // conservative installation default is the only honest value.
              intent: CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
            },
            this.options.pinnedAuthority,
            this.options.sign,
          )
        : await createOrganizationRecordRejectionEnvelope(
            { ...common, payload: this.rejectionPayload(input) },
            this.options.pinnedAuthority,
            this.options.sign,
          );
    const document = envelope as unknown as JsonObject;
    return {
      envelope_id: envelope.envelope_id,
      idempotency_key: envelope.idempotency_key,
      event_type: envelope.event_type,
      envelope: document,
    };
  }

  /**
   * The closed reviewer-v2 approval envelope.
   *
   * The intent is derived, never client-chosen: its only variable is the
   * Authority-computed semantic digest quoted from the evidence. The protocol
   * creator independently reprojects the release draft from this payload and
   * refuses to sign anything that does not reproduce the exact digest the
   * reviewer approved, so this adapter cannot widen or restate the package.
   */
  private async buildReviewerApproval(
    input: OrganizationRecordEnvelopeBuildInput,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    if (input.event_type !== 'approval') {
      throw new Error(
        'organization record schema version 2 admits approval only',
      );
    }
    const authorization =
      input.authorization as unknown as OrganizationRecordReviewerAuthorizationV2;
    const envelope = await createOrganizationRecordReviewerApprovalEnvelope(
      {
        envelope_id: this.nextEnvelopeId(),
        idempotency_key: input.approval_id,
        payload: this.approvalPayload(input),
        reviewer: {
          principal_id: authorization.principal_id,
          membership_id: authorization.membership_id,
          reviewed_by: input.reviewed_by,
          authorization,
        },
        intent: organizationRecordReviewerIntent(
          authorization.semantic_intent_sha256,
        ),
        submitter: {
          installation_id: authorization.installation_id,
          submitted_at: input.submitted_at,
        },
        installation_signing_key: this.options.installationSigningKey,
      },
      this.options.pinnedAuthority,
      this.options.sign,
    );
    return {
      envelope_id: envelope.envelope_id,
      idempotency_key: envelope.idempotency_key,
      event_type: envelope.event_type,
      envelope: envelope as unknown as JsonObject,
    };
  }

  /** The closed organization-member-readable schema-v3 approval envelope. */
  private async buildOrganizationMemberApproval(
    input: OrganizationRecordEnvelopeBuildInput,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    if (input.event_type !== 'approval') {
      throw new Error(
        'organization record schema version 3 admits approval only',
      );
    }
    const authorization =
      input.authorization as unknown as OrganizationRecordOrganizationMemberAuthorizationV3;
    const envelope =
      await createOrganizationRecordOrganizationMemberApprovalEnvelope(
        {
          envelope_id: this.nextEnvelopeId(),
          idempotency_key: input.approval_id,
          payload: this.approvalPayload(input),
          reviewer: {
            principal_id: authorization.principal_id,
            membership_id: authorization.membership_id,
            reviewed_by: input.reviewed_by,
            authorization,
          },
          intent: organizationRecordOrganizationMemberIntent(
            authorization.semantic_intent_sha256,
          ),
          submitter: {
            installation_id: authorization.installation_id,
            submitted_at: input.submitted_at,
          },
          installation_signing_key: this.options.installationSigningKey,
        },
        this.options.pinnedAuthority,
        this.options.sign,
      );
    return {
      envelope_id: envelope.envelope_id,
      idempotency_key: envelope.idempotency_key,
      event_type: envelope.event_type,
      envelope: envelope as unknown as JsonObject,
    };
  }

  private approvalPayload(
    input: OrganizationRecordEnvelopeBuildInput,
  ): OrganizationRecordApprovalPayloadV1 {
    return {
      brief: input.brief as OrganizationRecordDecisionBriefV1,
      source: input.source,
      alternatives: input.alternatives,
      links: protocolLinks(input.links),
      reviewed_at: input.reviewed_at,
      surface: input.surface,
    };
  }

  /**
   * A rejection records the act, never the rejected candidate content: no
   * brief, no alternatives, and no approval intent. `reconsider_after` belongs
   * to this payload and is null in v1 because no surface can set it.
   */
  private rejectionPayload(
    input: OrganizationRecordEnvelopeBuildInput,
  ): OrganizationRecordRejectionPayloadV1 {
    return {
      source: input.source,
      meeting_id: input.meeting_id,
      rejected_at: input.reviewed_at,
      reason: input.reason,
      reconsider_after: null,
    };
  }
}
