import { randomUUID } from 'node:crypto';
import {
  canonicalSha256,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationPermissionCheckRequest,
  validateOrganizationPermissionCheckDecision,
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
  ): Promise<{ allowed: boolean; reason: string }> {
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
      return {
        allowed: decision.allowed,
        reason: decision.reason_code.replaceAll('_', ' '),
      };
    } finally {
      state.close();
    }
  }
}
