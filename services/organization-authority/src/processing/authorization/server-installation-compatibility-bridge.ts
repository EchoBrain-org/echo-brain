import { randomUUID } from 'node:crypto';
import {
  assertUtcMillisecondTimestamp,
  canonicalSha256,
  type InstallationKeyDescriptor,
  type P256SigningKeyDescriptor,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationMemberReadablePermissionCheckRequest,
  createOrganizationPermissionCheckRequest,
  validateOrganizationMemberReadablePermissionCheckDecision,
  validateOrganizationPermissionCheckDecision,
  type OrganizationMemberReadablePermissionCheckRequestV3,
  type OrganizationPermissionCheckRequestV1,
} from '@echo-brain/organization-api';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import type {
  AuthorityReadTransaction,
  OrganizationAuthorityRepository,
  StoredAuthorityAccessState,
  StoredAuthorityEnrollment,
  StoredAuthorityMetadata,
} from '../../application/ports/authority-repository.js';
import type {
  ApprovalActionAuthorizationResult,
  ApprovalActionAuthorizationRequest,
  ApprovalActionAuthorizer,
  OrganizationMemberApprovalActionAuthorizationRequest,
  OrganizationMemberApprovalActionAuthorizer,
} from '../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import {
  validateOrganizationMemberAuthorizationEvidence,
  type OrganizationMemberAuthorizationEvidence,
} from './organization-member-authorization-evidence.js';
import { ExistingExportableInstallationKey } from './security/existing-exportable-installation-key.js';

type AuthorityRepositoryReader = Pick<OrganizationAuthorityRepository, 'read'>;

interface InstallationAuthorizationSnapshot {
  metadata: StoredAuthorityMetadata;
  enrollment: StoredAuthorityEnrollment;
  access: StoredAuthorityAccessState | undefined;
}

interface PermissionDecisionActor {
  principal_id: string | null;
  membership_id: string | null;
}

/** The existing in-process Authority permission operations used by Slack. */
export interface OrganizationMemberPermissionCheckPort {
  checkPermission(
    request: OrganizationPermissionCheckRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown>;

  checkOrganizationMemberReadablePermission(
    request: OrganizationMemberReadablePermissionCheckRequestV3,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface ServerInstallationAccessRefreshInput {
  installation_id: string;
  enrollment_id: string;
  current_access_state_sha256: Sha256Digest | null;
  requested_at: string;
}

/**
 * Optional foreground lease refresh. A single authorization may invoke this
 * at most once, then rereads Authority state exactly once. There is no timer or
 * background lifecycle in this compatibility bridge.
 */
export interface ServerInstallationAccessRefreshPort {
  refreshInstallationAccess(
    input: ServerInstallationAccessRefreshInput,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ServerInstallationCompatibilityBridgeOptions {
  authorityRepository: AuthorityRepositoryReader;
  keyStatePath: string;
  permissionCheck: OrganizationMemberPermissionCheckPort;
  now: () => string;
  nextRequestId?: () => string;
  accessRefresh?: ServerInstallationAccessRefreshPort;
}

function protocolKey(
  descriptor: InstallationKeyDescriptor,
): P256SigningKeyDescriptor {
  return {
    key_id: descriptor.key_id,
    algorithm: descriptor.algorithm,
    public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
  };
}

function sameProtocolKey(
  left: P256SigningKeyDescriptor,
  right: P256SigningKeyDescriptor,
): boolean {
  return (
    left.key_id === right.key_id &&
    left.algorithm === right.algorithm &&
    left.public_key_spki_der_base64 === right.public_key_spki_der_base64
  );
}

function timestamp(value: string, label: string): number {
  assertUtcMillisecondTimestamp(value, label);
  return Date.parse(value);
}

function assertDecisionActorMatchesEnrollment(
  decision: PermissionDecisionActor,
  enrollment: StoredAuthorityEnrollment,
  label: string,
): void {
  if (
    decision.principal_id !== enrollment.principal_id ||
    decision.membership_id !== enrollment.membership_id
  ) {
    throw new Error(`${label} belongs to another enrollment`);
  }
}

function snapshotFrom(
  transaction: AuthorityReadTransaction,
  installationId: string,
): InstallationAuthorizationSnapshot {
  const metadata = transaction.metadata();
  const enrollment = transaction.enrollmentByInstallation(installationId);
  if (enrollment === undefined) {
    throw new Error(
      'server installation is not enrolled with this Authority',
    );
  }
  return {
    metadata,
    enrollment,
    access: transaction.currentAccessState(enrollment.enrollment_id),
  };
}

function assertSnapshotIdentity(
  snapshot: InstallationAuthorizationSnapshot,
  installationKey: InstallationKeyDescriptor,
): void {
  const { metadata, enrollment, access } = snapshot;
  if (
    enrollment.authority_id !== metadata.authority_id ||
    enrollment.organization_id !== metadata.organization_id ||
    enrollment.installation_id !== installationKey.installation_id ||
    !sameProtocolKey(enrollment.installation_signing_key, installationKey) ||
    metadata.descriptor.authority_id !== metadata.authority_id ||
    metadata.descriptor.organization_id !== metadata.organization_id
  ) {
    throw new Error(
      'server installation key does not match Authority enrollment state',
    );
  }
  if (enrollment.status !== 'active') {
    throw new Error('server installation enrollment is inactive');
  }
  if (access === undefined) return;
  const state = access.state;
  if (
    access.enrollment_id !== enrollment.enrollment_id ||
    state.authority_id !== enrollment.authority_id ||
    state.authority_key_id !== metadata.descriptor.signing_key.key_id ||
    state.organization_id !== enrollment.organization_id ||
    state.enrollment_id !== enrollment.enrollment_id ||
    state.enrollment_receipt_sha256 !== enrollment.receipt_sha256 ||
    state.principal_id !== enrollment.principal_id ||
    state.membership_id !== enrollment.membership_id ||
    state.membership_type !== enrollment.membership_type ||
    state.installation_id !== enrollment.installation_id ||
    state.installation_key_id !== enrollment.installation_signing_key.key_id
  ) {
    throw new Error(
      'server installation current access does not match its enrollment',
    );
  }
}

function hasCurrentActiveAccess(
  snapshot: InstallationAuthorizationSnapshot,
  checkedAt: string,
): boolean {
  const state = snapshot.access?.state;
  if (state === undefined || state.status !== 'active') return false;
  return (
    timestamp(state.valid_until, 'server installation access valid_until') >
    timestamp(checkedAt, 'server installation access check time')
  );
}

/**
 * Minimum-V1 server-held installation compatibility.
 *
 * It reads the already-open Authority repository, opens an existing exportable
 * installation key file only for inspection/signing, performs one fresh
 * schema-v3 permission check through an injected in-process port, and returns
 * only locally revalidated schema-v3 allow evidence.
 */
export class ServerInstallationCompatibilityBridge
  implements ApprovalActionAuthorizer, OrganizationMemberApprovalActionAuthorizer
{
  private readonly installationKey: ExistingExportableInstallationKey;
  private readonly nextRequestId: () => string;

  constructor(
    private readonly options: ServerInstallationCompatibilityBridgeOptions,
  ) {
    this.installationKey = new ExistingExportableInstallationKey(
      options.keyStatePath,
    );
    this.nextRequestId =
      options.nextRequestId ?? (() => `pcr_${randomUUID()}`);
  }

  private readSnapshot(
    installationId: string,
  ): InstallationAuthorizationSnapshot {
    return this.options.authorityRepository.read((transaction) =>
      snapshotFrom(transaction, installationId),
    );
  }

  private async currentState(
    installationKey: InstallationKeyDescriptor,
    signal?: AbortSignal,
  ): Promise<InstallationAuthorizationSnapshot> {
    signal?.throwIfAborted();
    let snapshot = this.readSnapshot(installationKey.installation_id);
    assertSnapshotIdentity(snapshot, installationKey);
    let checkedAt = this.options.now();
    timestamp(checkedAt, 'server installation access check time');
    if (hasCurrentActiveAccess(snapshot, checkedAt)) return snapshot;
    if (snapshot.access?.state.status === 'revoked') {
      throw new Error('server installation access is revoked');
    }
    const refresh = this.options.accessRefresh;
    if (refresh === undefined) {
      throw new Error('server installation access is not current');
    }
    await refresh.refreshInstallationAccess(
      {
        installation_id: snapshot.enrollment.installation_id,
        enrollment_id: snapshot.enrollment.enrollment_id,
        current_access_state_sha256: snapshot.access?.state_sha256 ?? null,
        requested_at: checkedAt,
      },
      signal,
    );
    signal?.throwIfAborted();
    snapshot = this.readSnapshot(installationKey.installation_id);
    assertSnapshotIdentity(snapshot, installationKey);
    checkedAt = this.options.now();
    if (!hasCurrentActiveAccess(snapshot, checkedAt)) {
      throw new Error(
        snapshot.access?.state.status === 'revoked'
          ? 'server installation access is revoked'
          : 'server installation access refresh did not produce current access',
      );
    }
    return snapshot;
  }

  /**
   * Reestablishes the server installation's short-lived access lease without
   * repeating an already-durable approval authorization.
   */
  async ensureCurrentInstallationAccess(signal?: AbortSignal): Promise<void> {
    await this.currentState(this.installationKey.inspect(), signal);
  }

  async authorize(
    input: ApprovalActionAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalActionAuthorizationResult> {
    if (input.provider_identity.bot_id === null) {
      throw new Error('Slack approval bot identity is unavailable');
    }
    const installationDescriptor = this.installationKey.inspect();
    const snapshot = await this.currentState(installationDescriptor, signal);
    signal?.throwIfAborted();
    const requestedAt = this.options.now();
    timestamp(requestedAt, 'permission request time');
    const signingKey = protocolKey(installationDescriptor);
    const request = await createOrganizationPermissionCheckRequest(
      {
        request_id: this.nextRequestId(),
        authority_id: snapshot.enrollment.authority_id,
        authority_key_id: snapshot.metadata.descriptor.signing_key.key_id,
        organization_id: snapshot.enrollment.organization_id,
        enrollment_id: snapshot.enrollment.enrollment_id,
        installation_id: snapshot.enrollment.installation_id,
        installation_signing_key: signingKey,
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
        action: input.action,
        approval_id: input.approval_id,
        channel_id: input.channel_id,
        message_ts: input.message_ts,
        reaction_name: input.reaction_name,
        requested_at: requestedAt,
      },
      async (bytes) =>
        this.installationKey.sign(
          snapshot.enrollment.installation_id,
          signingKey.key_id,
          bytes,
        ),
    );
    signal?.throwIfAborted();
    const decision = validateOrganizationPermissionCheckDecision(
      await this.options.permissionCheck.checkPermission(request, signal),
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
      authority_id: snapshot.enrollment.authority_id,
      organization_id: snapshot.enrollment.organization_id,
      enrollment_id: snapshot.enrollment.enrollment_id,
      installation_id: snapshot.enrollment.installation_id,
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
    assertDecisionActorMatchesEnrollment(
      decision,
      snapshot.enrollment,
      'organization permission decision',
    );
    if (
      decision.adapter_binding_id === null ||
      decision.permission_grant_id === null
    ) {
      throw new Error('organization permission allow has incomplete evidence');
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
  }

  async authorizeOrganizationMemberApproval(
    input: OrganizationMemberApprovalActionAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalActionAuthorizationResult> {
    const expectedPolicyContract =
      organizationMemberReadablePolicyContractSha256();
    if (
      input.policy_id !== 'organization-member-readable-v1' ||
      input.policy_contract_sha256 !== expectedPolicyContract
    ) {
      throw new Error(
        'organization-member approval does not bind the current policy contract',
      );
    }
    if (input.provider_identity.bot_id === null) {
      throw new Error('Slack approval bot identity is unavailable');
    }

    const installationDescriptor = this.installationKey.inspect();
    const snapshot = await this.currentState(installationDescriptor, signal);
    signal?.throwIfAborted();
    const requestedAt = this.options.now();
    timestamp(requestedAt, 'organization-member permission request time');
    const signingKey = protocolKey(installationDescriptor);
    const request = await createOrganizationMemberReadablePermissionCheckRequest(
      {
        request_id: this.nextRequestId(),
        authority_id: snapshot.enrollment.authority_id,
        authority_key_id: snapshot.metadata.descriptor.signing_key.key_id,
        organization_id: snapshot.enrollment.organization_id,
        enrollment_id: snapshot.enrollment.enrollment_id,
        installation_id: snapshot.enrollment.installation_id,
        installation_signing_key: signingKey,
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
        release_draft_sha256: input.release_draft_sha256 as Sha256Digest,
        approval_presentation_sha256:
          input.approval_presentation_sha256 as Sha256Digest,
        requested_at: requestedAt,
      },
      async (bytes) =>
        this.installationKey.sign(
          snapshot.enrollment.installation_id,
          signingKey.key_id,
          bytes,
        ),
    );
    signal?.throwIfAborted();
    const decision = validateOrganizationMemberReadablePermissionCheckDecision(
      await this.options.permissionCheck.checkOrganizationMemberReadablePermission(
        request,
        signal,
      ),
    );
    if (
      decision.request_sha256 !== canonicalSha256(request) ||
      decision.provider_event_sha256 !== request.provider_event_sha256
    ) {
      throw new Error(
        'organization-member permission decision does not match the signed request',
      );
    }
    const reason = decision.reason_code.replaceAll('_', ' ');
    if (!decision.allowed) return { allowed: false, reason };
    assertDecisionActorMatchesEnrollment(
      decision,
      snapshot.enrollment,
      'organization-member permission decision',
    );
    if (
      decision.policy_id !== input.policy_id ||
      decision.policy_contract_sha256 !== input.policy_contract_sha256 ||
      decision.release_draft_sha256 !== input.release_draft_sha256 ||
      decision.approval_presentation_sha256 !==
        input.approval_presentation_sha256
    ) {
      throw new Error(
        'organization-member permission decision does not quote the frozen presentation contract',
      );
    }
    if (
      decision.adapter_binding_id === null ||
      decision.permission_grant_id === null ||
      decision.authorization_audit_event_id === null ||
      decision.authorization_audit_entry_sha256 === null ||
      decision.release_draft_sha256 === null ||
      decision.approval_presentation_sha256 === null ||
      decision.semantic_intent_sha256 === null ||
      decision.message_presentation_sha256 === null
    ) {
      throw new Error(
        'organization-member permission allow has incomplete evidence',
      );
    }

    const evidence: OrganizationMemberAuthorizationEvidence =
      validateOrganizationMemberAuthorizationEvidence({
        schema_version: 3,
        kind: 'echo-organization-authorization-evidence',
        policy_id: input.policy_id,
        policy_contract_sha256: input.policy_contract_sha256,
        authority_id: snapshot.enrollment.authority_id,
        organization_id: snapshot.enrollment.organization_id,
        enrollment_id: snapshot.enrollment.enrollment_id,
        installation_id: snapshot.enrollment.installation_id,
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
        authorization_audit_event_id:
          decision.authorization_audit_event_id,
        authorization_audit_entry_sha256:
          decision.authorization_audit_entry_sha256,
        release_draft_sha256: decision.release_draft_sha256,
        approval_presentation_sha256:
          decision.approval_presentation_sha256,
        semantic_intent_sha256: decision.semantic_intent_sha256,
        message_presentation_sha256:
          decision.message_presentation_sha256,
      });
    return { allowed: true, reason, evidence };
  }
}
