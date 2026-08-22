import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
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
  OrganizationRecordOrganizationMemberAuthorizationV3,
  OrganizationRecordRejectionPayloadV1,
  OrganizationRecordReviewerAuthorizationV1,
  OrganizationRecordReviewerAuthorizationV2,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import type {
  BuiltOrganizationRecordEnvelope,
  OrganizationRecordEnvelopeBuildInput,
  OrganizationRecordEnvelopeBuilder,
} from './ports.js';

export interface ProtocolOrganizationRecordEnvelopeBuilderOptions {
  readonly pinnedAuthority: PinnedOrganizationAuthority;
  readonly installationSigningKey: P256SigningKeyDescriptor;
  readonly sign: CanonicalPayloadSigner;
  /** Test seam; production creates one random, frozen record id. */
  readonly nextEnvelopeId?: () => string;
}

function protocolLinks(
  links: OrganizationRecordEnvelopeBuildInput['links'],
): null {
  if (links.parent !== null || links.supersedes !== null) {
    throw new Error(
      'organization record schema version 1 carries no decision links',
    );
  }
  return null;
}

function approvalPayload(
  input: OrganizationRecordEnvelopeBuildInput,
): OrganizationRecordApprovalPayloadV1 {
  if (input.brief === null) {
    throw new Error('organization record approval requires an approved brief');
  }
  return {
    brief: input.brief,
    source: input.source,
    alternatives: input.alternatives,
    links: protocolLinks(input.links),
    reviewed_at: input.reviewed_at,
    surface: input.surface,
  };
}

function rejectionPayload(
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

/** Maps a resolved Authority processing result onto the signed wire protocol. */
export class ProtocolOrganizationRecordEnvelopeBuilder
  implements OrganizationRecordEnvelopeBuilder
{
  private readonly nextEnvelopeId: () => string;

  constructor(
    private readonly options: ProtocolOrganizationRecordEnvelopeBuilderOptions,
  ) {
    this.nextEnvelopeId = options.nextEnvelopeId ?? organizationRecordEnvelopeId;
  }

  async build(
    input: OrganizationRecordEnvelopeBuildInput,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    switch (input.authorization.schema_version) {
      case 1:
        return await this.buildV1(input, input.authorization);
      case 2:
        return await this.buildReviewerApproval(input, input.authorization);
      case 3:
        return await this.buildOrganizationMemberApproval(
          input,
          input.authorization,
        );
    }
  }

  private async buildV1(
    input: OrganizationRecordEnvelopeBuildInput,
    authorization: OrganizationRecordReviewerAuthorizationV1,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    const common = {
      envelope_id: this.nextEnvelopeId(),
      idempotency_key: input.approval_id,
      reviewer: {
        principal_id: authorization.principal_id,
        membership_id: authorization.membership_id,
        reviewed_by: input.reviewed_by,
        authorization,
      },
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
              payload: approvalPayload(input),
              intent: CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
            },
            this.options.pinnedAuthority,
            this.options.sign,
          )
        : await createOrganizationRecordRejectionEnvelope(
            { ...common, payload: rejectionPayload(input) },
            this.options.pinnedAuthority,
            this.options.sign,
          );
    return {
      envelope_id: envelope.envelope_id,
      idempotency_key: envelope.idempotency_key,
      event_type: envelope.event_type,
      envelope,
    };
  }

  private async buildReviewerApproval(
    input: OrganizationRecordEnvelopeBuildInput,
    authorization: OrganizationRecordReviewerAuthorizationV2,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    if (input.event_type !== 'approval') {
      throw new Error(
        'organization record schema version 2 admits approval only',
      );
    }
    const envelope = await createOrganizationRecordReviewerApprovalEnvelope(
      {
        envelope_id: this.nextEnvelopeId(),
        idempotency_key: input.approval_id,
        payload: approvalPayload(input),
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
      envelope,
    };
  }

  private async buildOrganizationMemberApproval(
    input: OrganizationRecordEnvelopeBuildInput,
    authorization: OrganizationRecordOrganizationMemberAuthorizationV3,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    if (input.event_type !== 'approval') {
      throw new Error(
        'organization record schema version 3 admits approval only',
      );
    }
    const envelope =
      await createOrganizationRecordOrganizationMemberApprovalEnvelope(
        {
          envelope_id: this.nextEnvelopeId(),
          idempotency_key: input.approval_id,
          payload: approvalPayload(input),
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
      envelope,
    };
  }
}
