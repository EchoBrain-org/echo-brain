import { randomUUID } from 'node:crypto';
import {
  canonicalSha256,
  type JsonObject,
  type P256SigningKeyDescriptor,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  createOrganizationMemberReadablePermissionCheckRequest,
  createOrganizationPermissionCheckRequest,
  createOrganizationReviewerPermissionCheckRequest,
  validateOrganizationPermissionCheckDecision,
  validateOrganizationReviewerPermissionCheckDecision,
} from '@echo-brain/organization-api';
import type { InstallationSigner } from '../machine/security/installation-signer.js';
import {
  signWithInstallationKey,
  verifyInstallationKeyDescriptor,
} from '../machine/security/installation-signer.js';
import type { OrganizationAuthorityClient } from './client/authority-client.js';
import type { OrganizationStateStore } from './state/organization-state-store.js';

export interface OrganizationApprovalActionAuthorizationRequest {
  approval_id: string;
  action: 'approve' | 'reject';
  adapter_identity: {
    kind: 'approval-surface';
    adapter_id: string;
    instance_id: string;
    version: string;
  };
  provider_identity: {
    provider: 'slack';
    team_id: string;
    enterprise_id: string | null;
    bot_user_id: string;
    bot_id: string | null;
    app_id: string | null;
  };
  actor: {
    provider: 'slack';
    team_id: string;
    user_id: string;
  };
  channel_id: string;
  message_ts: string;
  reaction_name: string;
}

export interface OrganizationApprovalActionAuthorizerOptions {
  openState(): OrganizationStateStore;
  authorityClient: OrganizationAuthorityClient;
  installationSigner: InstallationSigner;
  now: () => string;
  nextRequestId?: () => string;
}

export type OrganizationApprovalActionAuthorizationEvidence = JsonObject & {
  schema_version: 1;
  kind: 'echo-organization-authorization-evidence';
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  /**
   * Which act the Authority evaluated. Carried on the evidence itself so a
   * later consumer -- organization ingest above all -- can match an act to its
   * authorization without re-deriving the signed request bytes.
   */
  action: 'approve' | 'reject';
  request_sha256: Sha256Digest;
  provider_event_sha256: Sha256Digest;
  allowed: boolean;
  reason_code: string;
  principal_id: string | null;
  membership_id: string | null;
  adapter_binding_id: string | null;
  permission_grant_id: string | null;
  evaluated_at: string;
};

type OrganizationApprovalActionAuthorizationAllowEvidence =
  OrganizationApprovalActionAuthorizationEvidence & {
    allowed: true;
    principal_id: string;
    membership_id: string;
    adapter_binding_id: string;
    permission_grant_id: string;
  };

export type OrganizationApprovalActionAuthorizationResult =
  | {
      allowed: true;
      reason: string;
      evidence: OrganizationApprovalActionAuthorizationAllowEvidence;
    }
  | {
      allowed: false;
      reason: string;
      evidence?: OrganizationApprovalActionAuthorizationEvidence;
    };

/**
 * One reviewer approval, described entirely by the immutable local
 * presentation contract. Nothing here is read from current configuration: the
 * adapter identity, reaction pair, channel, reviewer Slack user, and both
 * content digests all come from the frozen slot.
 */
export interface OrganizationReviewerApprovalAuthorizationRequest {
  approval_id: string;
  adapter_identity: {
    kind: 'approval-surface';
    adapter_id: string;
    instance_id: string;
    version: string;
  };
  provider_identity: {
    provider: 'slack';
    team_id: string;
    enterprise_id: string | null;
    bot_user_id: string;
    bot_id: string | null;
    app_id: string | null;
  };
  actor: {
    provider: 'slack';
    team_id: string;
    user_id: string;
  };
  channel_id: string;
  message_ts: string;
  approve_reaction: string;
  reject_reaction: string;
  reviewer_release_draft_sha256: Sha256Digest;
  approval_presentation_sha256: Sha256Digest;
}

/** The complete Authority proof one reviewer allow produced. */
export type OrganizationReviewerApprovalAuthorizationEvidence = JsonObject & {
  schema_version: 2;
  kind: 'echo-organization-authorization-evidence';
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  action: 'approve';
  request_sha256: Sha256Digest;
  provider_event_sha256: Sha256Digest;
  allowed: true;
  reason_code: 'active_reviewer_restricted_notice_v1';
  principal_id: string;
  membership_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: Sha256Digest;
  reviewer_release_draft_sha256: Sha256Digest;
  approval_presentation_sha256: Sha256Digest;
  semantic_intent_sha256: Sha256Digest;
  message_presentation_sha256: Sha256Digest;
};

export type OrganizationReviewerApprovalAuthorizationResult =
  | {
      allowed: true;
      reason: string;
      evidence: OrganizationReviewerApprovalAuthorizationEvidence;
    }
  | { allowed: false; reason: string };

export interface OrganizationMemberApprovalAuthorizationRequest {
  approval_id: string;
  adapter_identity: OrganizationReviewerApprovalAuthorizationRequest['adapter_identity'];
  provider_identity: OrganizationReviewerApprovalAuthorizationRequest['provider_identity'];
  actor: OrganizationReviewerApprovalAuthorizationRequest['actor'];
  channel_id: string;
  message_ts: string;
  approve_reaction: string;
  reject_reaction: string;
  policy_id: 'organization-member-readable-v1';
  policy_contract_sha256: Sha256Digest;
  release_draft_sha256: Sha256Digest;
  approval_presentation_sha256: Sha256Digest;
}

export type OrganizationMemberApprovalAuthorizationEvidence = JsonObject & {
  schema_version: 3;
  kind: 'echo-organization-authorization-evidence';
  policy_id: 'organization-member-readable-v1';
  policy_contract_sha256: Sha256Digest;
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  action: 'approve';
  request_sha256: Sha256Digest;
  provider_event_sha256: Sha256Digest;
  allowed: true;
  reason_code: 'active_organization_member_readable_notice_v1';
  principal_id: string;
  membership_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: Sha256Digest;
  release_draft_sha256: Sha256Digest;
  approval_presentation_sha256: Sha256Digest;
  semantic_intent_sha256: Sha256Digest;
  message_presentation_sha256: Sha256Digest;
};

export type OrganizationMemberApprovalAuthorizationResult =
  | {
      allowed: true;
      reason: string;
      evidence: OrganizationMemberApprovalAuthorizationEvidence;
    }
  | { allowed: false; reason: string };

/**
 * Once any Authority trust or enrollment intent is pinned, local approval
 * resolution would create an unattributed bypass even if enrollment response
 * persistence is still pending.
 */
export function organizationApprovalResolutionRequiresAuthority(
  state: Pick<
    OrganizationStateStore,
    'readPinnedAuthority' | 'readAuthorityConnection' | 'readEnrollment'
  >,
): boolean {
  return (
    state.readPinnedAuthority() !== null ||
    state.readAuthorityConnection() !== null ||
    state.readEnrollment() !== null
  );
}

function protocolSigningKey(
  descriptor: Awaited<ReturnType<InstallationSigner['inspect']>>,
  installationId: string,
): P256SigningKeyDescriptor {
  if (descriptor === null) {
    throw new Error('organization installation signing key is unavailable');
  }
  verifyInstallationKeyDescriptor(descriptor);
  if (descriptor.installation_id !== installationId) {
    throw new Error(
      'organization installation signer belongs to another installation',
    );
  }
  return {
    key_id: descriptor.key_id,
    algorithm: descriptor.algorithm,
    public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
  };
}

/**
 * Turns one observed Slack action into a fresh, installation-signed
 * organization permission check. No positive decision is cached: every
 * decisive reaction reaches the customer-hosted Authority.
 */
export class OrganizationApprovalActionAuthorizer {
  private readonly now: () => string;
  private readonly nextRequestId: () => string;

  constructor(
    private readonly options: OrganizationApprovalActionAuthorizerOptions,
  ) {
    this.now = options.now;
    this.nextRequestId =
      options.nextRequestId ?? (() => `pcr_${randomUUID()}`);
  }

  async authorize(
    input: OrganizationApprovalActionAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<OrganizationApprovalActionAuthorizationResult> {
    const state = this.options.openState();
    try {
      const enrollment = state.readEnrollment();
      if (
        enrollment === null ||
        enrollment.receipt === null ||
        enrollment.accepted_access_sequence < 1
      ) {
        throw new Error(
          'organization enrollment is unavailable for approval authorization',
        );
      }
      const requestIdentity = enrollment.request;
      const signerKey = protocolSigningKey(
        await this.options.installationSigner.inspect(
          requestIdentity.installation_id,
        ),
        requestIdentity.installation_id,
      );
      if (
        signerKey.key_id !==
        requestIdentity.installation_signing_key.key_id
      ) {
        throw new Error(
          'organization installation signer no longer matches the enrollment',
        );
      }
      const providerBotId = input.provider_identity.bot_id;
      if (providerBotId === null) {
        throw new Error('Slack approval bot identity is unavailable');
      }
      const request = await createOrganizationPermissionCheckRequest(
        {
          request_id: this.nextRequestId(),
          authority_id: requestIdentity.authority_id,
          authority_key_id: requestIdentity.authority_key_id,
          organization_id: requestIdentity.organization_id,
          enrollment_id: enrollment.receipt.enrollment_id,
          installation_id: requestIdentity.installation_id,
          installation_signing_key: signerKey,
          provider: 'slack',
          provider_issuer: 'https://slack.com',
          provider_tenant_kind: 'workspace',
          provider_tenant_id: input.actor.team_id,
          provider_enterprise_id:
            input.provider_identity.enterprise_id,
          provider_connection_subject_id:
            input.provider_identity.bot_user_id,
          provider_connection_bot_id: providerBotId,
          provider_connection_app_id: input.provider_identity.app_id,
          provider_subject_kind: 'human_user',
          provider_subject_id: input.actor.user_id,
          adapter_kind: 'approval-surface',
          adapter_id: input.adapter_identity.adapter_id,
          adapter_instance_id: input.adapter_identity.instance_id,
          adapter_version: input.adapter_identity.version,
          action: input.action,
          approval_id: input.approval_id,
          channel_id: input.channel_id,
          message_ts: input.message_ts,
          reaction_name: input.reaction_name,
          requested_at: this.now(),
        },
        (bytes) =>
          signWithInstallationKey(
            this.options.installationSigner,
            requestIdentity.installation_id,
            signerKey.key_id,
            bytes,
          ),
      );
      const decision = validateOrganizationPermissionCheckDecision(
        await this.options.authorityClient.checkPermission(request, signal),
      );
      if (
        decision.request_sha256 !== canonicalSha256(request) ||
        decision.provider_event_sha256 !== request.provider_event_sha256
      ) {
        throw new Error(
          'organization permission decision does not match the signed request',
        );
      }
      const evidenceBase = {
        schema_version: 1,
        kind: 'echo-organization-authorization-evidence',
        authority_id: requestIdentity.authority_id,
        organization_id: requestIdentity.organization_id,
        enrollment_id: enrollment.receipt.enrollment_id,
        installation_id: requestIdentity.installation_id,
        request_id: request.request_id,
        approval_id: request.approval_id,
        action: input.action,
        request_sha256: decision.request_sha256,
        provider_event_sha256: decision.provider_event_sha256,
        reason_code: decision.reason_code,
        evaluated_at: decision.evaluated_at,
      } as const;
      const reason = decision.reason_code.replaceAll('_', ' ');
      if (!decision.allowed) {
        return {
          allowed: false,
          reason,
          evidence: {
            ...evidenceBase,
            allowed: false,
            principal_id: decision.principal_id,
            membership_id: decision.membership_id,
            adapter_binding_id: decision.adapter_binding_id,
            permission_grant_id: decision.permission_grant_id,
          },
        };
      }
      if (
        decision.principal_id !== requestIdentity.principal_id ||
        decision.membership_id !== requestIdentity.membership_id
      ) {
        throw new Error(
          'organization permission decision belongs to another enrolled member',
        );
      }
      if (
        decision.adapter_binding_id === null ||
        decision.permission_grant_id === null
      ) {
        throw new Error(
          'organization permission allow decision has no attribution evidence',
        );
      }
      return {
        allowed: true,
        reason,
        evidence: {
          ...evidenceBase,
          allowed: true,
          principal_id: decision.principal_id,
          membership_id: decision.membership_id,
          adapter_binding_id: decision.adapter_binding_id,
          permission_grant_id: decision.permission_grant_id,
        },
      };
    } finally {
      state.close();
    }
  }

  /**
   * The schema-v2 reviewer approval. It sends only content commitments, and it
   * accepts an allow only when every returned proof field is present and both
   * request digests match the exact bytes this installation signed.
   */
  async authorizeReviewerApproval(
    input: OrganizationReviewerApprovalAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<OrganizationReviewerApprovalAuthorizationResult> {
    const state = this.options.openState();
    try {
      const enrollment = state.readEnrollment();
      if (
        enrollment === null ||
        enrollment.receipt === null ||
        enrollment.accepted_access_sequence < 1
      ) {
        throw new Error(
          'organization enrollment is unavailable for approval authorization',
        );
      }
      const requestIdentity = enrollment.request;
      const signerKey = protocolSigningKey(
        await this.options.installationSigner.inspect(
          requestIdentity.installation_id,
        ),
        requestIdentity.installation_id,
      );
      if (signerKey.key_id !== requestIdentity.installation_signing_key.key_id) {
        throw new Error(
          'organization installation signer no longer matches the enrollment',
        );
      }
      const providerBotId = input.provider_identity.bot_id;
      if (providerBotId === null) {
        throw new Error('Slack approval bot identity is unavailable');
      }
      const request = await createOrganizationReviewerPermissionCheckRequest(
        {
          request_id: this.nextRequestId(),
          authority_id: requestIdentity.authority_id,
          authority_key_id: requestIdentity.authority_key_id,
          organization_id: requestIdentity.organization_id,
          enrollment_id: enrollment.receipt.enrollment_id,
          installation_id: requestIdentity.installation_id,
          installation_signing_key: signerKey,
          provider: 'slack',
          provider_issuer: 'https://slack.com',
          provider_tenant_kind: 'workspace',
          provider_tenant_id: input.actor.team_id,
          provider_enterprise_id: input.provider_identity.enterprise_id,
          provider_connection_subject_id: input.provider_identity.bot_user_id,
          provider_connection_bot_id: providerBotId,
          provider_connection_app_id: input.provider_identity.app_id,
          provider_subject_kind: 'human_user',
          provider_subject_id: input.actor.user_id,
          adapter_kind: 'approval-surface',
          adapter_id: input.adapter_identity.adapter_id,
          adapter_instance_id: input.adapter_identity.instance_id,
          adapter_version: input.adapter_identity.version,
          approval_id: input.approval_id,
          channel_id: input.channel_id,
          message_ts: input.message_ts,
          reaction_name: input.approve_reaction,
          approve_reaction: input.approve_reaction,
          reject_reaction: input.reject_reaction,
          reviewer_release_draft_sha256: input.reviewer_release_draft_sha256,
          approval_presentation_sha256: input.approval_presentation_sha256,
          requested_at: this.now(),
        },
        (bytes) =>
          signWithInstallationKey(
            this.options.installationSigner,
            requestIdentity.installation_id,
            signerKey.key_id,
            bytes,
          ),
      );
      const decision = validateOrganizationReviewerPermissionCheckDecision(
        await this.options.authorityClient.checkReviewerPermission(
          request,
          signal,
        ),
      );
      if (
        decision.request_sha256 !== canonicalSha256(request) ||
        decision.provider_event_sha256 !== request.provider_event_sha256
      ) {
        throw new Error(
          'organization permission decision does not match the signed request',
        );
      }
      const reason = decision.reason_code.replaceAll('_', ' ');
      if (!decision.allowed) return { allowed: false, reason };
      if (
        decision.principal_id !== requestIdentity.principal_id ||
        decision.membership_id !== requestIdentity.membership_id
      ) {
        throw new Error(
          'organization permission decision belongs to another enrolled member',
        );
      }
      if (
        decision.reviewer_release_draft_sha256 !==
          input.reviewer_release_draft_sha256 ||
        decision.approval_presentation_sha256 !==
          input.approval_presentation_sha256
      ) {
        throw new Error(
          'organization reviewer decision does not quote the frozen presentation',
        );
      }
      if (
        decision.adapter_binding_id === null ||
        decision.permission_grant_id === null ||
        decision.authorization_audit_event_id === null ||
        decision.authorization_audit_entry_sha256 === null ||
        decision.semantic_intent_sha256 === null ||
        decision.message_presentation_sha256 === null
      ) {
        throw new Error(
          'organization reviewer allow decision has no complete proof',
        );
      }
      return {
        allowed: true,
        reason,
        evidence: {
          schema_version: 2,
          kind: 'echo-organization-authorization-evidence',
          authority_id: requestIdentity.authority_id,
          organization_id: requestIdentity.organization_id,
          enrollment_id: enrollment.receipt.enrollment_id,
          installation_id: requestIdentity.installation_id,
          request_id: request.request_id,
          approval_id: request.approval_id,
          action: 'approve',
          request_sha256: decision.request_sha256,
          provider_event_sha256: decision.provider_event_sha256,
          allowed: true,
          reason_code: RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
          principal_id: decision.principal_id,
          membership_id: decision.membership_id,
          adapter_binding_id: decision.adapter_binding_id,
          permission_grant_id: decision.permission_grant_id,
          evaluated_at: decision.evaluated_at,
          authorization_audit_event_id: decision.authorization_audit_event_id,
          authorization_audit_entry_sha256:
            decision.authorization_audit_entry_sha256,
          reviewer_release_draft_sha256: input.reviewer_release_draft_sha256,
          approval_presentation_sha256: input.approval_presentation_sha256,
          semantic_intent_sha256: decision.semantic_intent_sha256,
          message_presentation_sha256: decision.message_presentation_sha256,
        },
      };
    } finally {
      state.close();
    }
  }

  /** The schema-v3 organization-member approval, with no reviewer fallback. */
  async authorizeOrganizationMemberApproval(
    input: OrganizationMemberApprovalAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<OrganizationMemberApprovalAuthorizationResult> {
    const state = this.options.openState();
    try {
      const enrollment = state.readEnrollment();
      if (
        enrollment === null ||
        enrollment.receipt === null ||
        enrollment.accepted_access_sequence < 1
      ) {
        throw new Error(
          'organization enrollment is unavailable for approval authorization',
        );
      }
      const requestIdentity = enrollment.request;
      const signerKey = protocolSigningKey(
        await this.options.installationSigner.inspect(
          requestIdentity.installation_id,
        ),
        requestIdentity.installation_id,
      );
      if (signerKey.key_id !== requestIdentity.installation_signing_key.key_id) {
        throw new Error(
          'organization installation signer no longer matches the enrollment',
        );
      }
      if (input.provider_identity.bot_id === null) {
        throw new Error('Slack approval bot identity is unavailable');
      }
      const request = await createOrganizationMemberReadablePermissionCheckRequest(
        {
          request_id: this.nextRequestId(),
          authority_id: requestIdentity.authority_id,
          authority_key_id: requestIdentity.authority_key_id,
          organization_id: requestIdentity.organization_id,
          enrollment_id: enrollment.receipt.enrollment_id,
          installation_id: requestIdentity.installation_id,
          installation_signing_key: signerKey,
          provider: 'slack',
          provider_issuer: 'https://slack.com',
          provider_tenant_kind: 'workspace',
          provider_tenant_id: input.actor.team_id,
          provider_enterprise_id: input.provider_identity.enterprise_id,
          provider_connection_subject_id: input.provider_identity.bot_user_id,
          provider_connection_bot_id: input.provider_identity.bot_id,
          provider_connection_app_id: input.provider_identity.app_id,
          provider_subject_kind: 'human_user',
          provider_subject_id: input.actor.user_id,
          adapter_kind: 'approval-surface',
          adapter_id: input.adapter_identity.adapter_id,
          adapter_instance_id: input.adapter_identity.instance_id,
          adapter_version: input.adapter_identity.version,
          approval_id: input.approval_id,
          channel_id: input.channel_id,
          message_ts: input.message_ts,
          reaction_name: input.approve_reaction,
          approve_reaction: input.approve_reaction,
          reject_reaction: input.reject_reaction,
          release_draft_sha256: input.release_draft_sha256,
          approval_presentation_sha256: input.approval_presentation_sha256,
          requested_at: this.now(),
        },
        (bytes) =>
          signWithInstallationKey(
            this.options.installationSigner,
            requestIdentity.installation_id,
            signerKey.key_id,
            bytes,
          ),
      );
      if (
        request.policy_id !== input.policy_id ||
        request.policy_contract_sha256 !== input.policy_contract_sha256
      ) {
        throw new Error(
          'organization-member request does not bind the frozen policy contract',
        );
      }
      const decision = await this.options.authorityClient.checkOrganizationMemberPermission(
        request,
        signal,
      );
      if (
        decision.request_sha256 !== canonicalSha256(request) ||
        decision.provider_event_sha256 !== request.provider_event_sha256
      ) {
        throw new Error(
          'organization permission decision does not match the signed request',
        );
      }
      const reason = decision.reason_code.replaceAll('_', ' ');
      if (!decision.allowed) return { allowed: false, reason };
      if (
        decision.principal_id !== requestIdentity.principal_id ||
        decision.membership_id !== requestIdentity.membership_id
      ) {
        throw new Error(
          'organization permission decision belongs to another enrolled member',
        );
      }
      if (
        decision.policy_id !== input.policy_id ||
        decision.policy_contract_sha256 !== input.policy_contract_sha256 ||
        decision.release_draft_sha256 !== input.release_draft_sha256 ||
        decision.approval_presentation_sha256 !==
          input.approval_presentation_sha256
      ) {
        throw new Error(
          'organization-member decision does not quote the frozen presentation contract',
        );
      }
      if (
        decision.adapter_binding_id === null ||
        decision.permission_grant_id === null ||
        decision.authorization_audit_event_id === null ||
        decision.authorization_audit_entry_sha256 === null ||
        decision.semantic_intent_sha256 === null ||
        decision.message_presentation_sha256 === null
      ) {
        throw new Error(
          'organization-member allow decision has no complete proof',
        );
      }
      const evidence: OrganizationMemberApprovalAuthorizationEvidence = {
        schema_version: 3,
        kind: 'echo-organization-authorization-evidence',
        policy_id: input.policy_id,
        policy_contract_sha256: input.policy_contract_sha256,
        authority_id: requestIdentity.authority_id,
        organization_id: requestIdentity.organization_id,
        enrollment_id: enrollment.receipt.enrollment_id,
        installation_id: requestIdentity.installation_id,
        request_id: request.request_id,
        approval_id: request.approval_id,
        action: 'approve',
        request_sha256: decision.request_sha256,
        provider_event_sha256: decision.provider_event_sha256,
        allowed: true,
        reason_code: 'active_organization_member_readable_notice_v1',
        principal_id: decision.principal_id,
        membership_id: decision.membership_id,
        adapter_binding_id: decision.adapter_binding_id,
        permission_grant_id: decision.permission_grant_id,
        evaluated_at: decision.evaluated_at,
        authorization_audit_event_id: decision.authorization_audit_event_id,
        authorization_audit_entry_sha256:
          decision.authorization_audit_entry_sha256,
        release_draft_sha256: input.release_draft_sha256,
        approval_presentation_sha256: input.approval_presentation_sha256,
        semantic_intent_sha256: decision.semantic_intent_sha256,
        message_presentation_sha256: decision.message_presentation_sha256,
      };
      return { allowed: true, reason, evidence };
    } finally {
      state.close();
    }
  }
}
