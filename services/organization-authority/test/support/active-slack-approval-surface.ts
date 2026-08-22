import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  canonicalSha256,
} from '@echo-brain/federation-protocol';
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  OrganizationIntegrationsRepository,
  SLACK_DEFAULT_APPROVE_REACTION,
  SLACK_DEFAULT_REJECT_REACTION,
  SLACK_ORGANIZATION_TOOL_PROFILE,
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  openAndMigrateOrganizationControlDatabase,
} from '@echo-brain/organization-control-plane';

export interface SlackApprovalSurfaceFixtureIdentity {
  readonly principal_id: string;
  readonly membership_id: string;
}

export interface SlackApprovalSurfaceFixtureInstallation {
  readonly installation_id: string;
  readonly installation_key_id: string;
}

export interface SeedActiveSlackApprovalSurfaceInput {
  readonly integrations_database_path: string;
  readonly organization_id: string;
  readonly authority_id: string;
  readonly owner: SlackApprovalSurfaceFixtureIdentity;
  readonly installation: SlackApprovalSurfaceFixtureInstallation;
  readonly secret_handle_id?: string;
  readonly adapter_instance_id?: string;
  readonly activated_at?: string;
}

export interface SeededActiveSlackApprovalSurface {
  readonly connection_attempt_id: string;
  readonly connection_id: string;
  readonly adapter_binding_id: string;
}

/**
 * Seeds the durable rows left by Slack organization-tool onboarding and
 * approval-surface activation. The repository is constructed first so the
 * supplied organization and Authority identity must match the initialized DB.
 */
export function seedActiveSlackApprovalSurface(
  input: SeedActiveSlackApprovalSurfaceInput,
): SeededActiveSlackApprovalSurface {
  const database = openAndMigrateOrganizationControlDatabase(
    input.integrations_database_path,
    { fileMustExist: true },
  );
  try {
    const integrations = new OrganizationIntegrationsRepository(database, {
      organization_id: input.organization_id,
      authority_id: input.authority_id,
    });
    const activatedAt = input.activated_at ?? new Date().toISOString();
    const connectionAttemptId = `cat_${randomUUID()}`;
    const connectionId = `con_${randomUUID()}`;
    const adapterBindingId = `bnd_${randomUUID()}`;
    const scopes = [...SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES].sort();
    const scopesJson = canonicalJson(scopes);
    const publicToolConfiguration = {
      approve_reaction: SLACK_DEFAULT_APPROVE_REACTION,
      channel_id: 'C12345678',
      organization_tool_profile: SLACK_ORGANIZATION_TOOL_PROFILE,
      reject_reaction: SLACK_DEFAULT_REJECT_REACTION,
      schema_version: 1,
      slack_app_id: 'A12345678',
      slack_bot_id: 'B12345678',
      slack_bot_user_id: 'U12345679',
      slack_enterprise_id: null,
    };
    const publicBindingConfiguration = {
      approve_reaction: publicToolConfiguration.approve_reaction,
      channel_id: publicToolConfiguration.channel_id,
      reject_reaction: publicToolConfiguration.reject_reaction,
      slack_app_id: publicToolConfiguration.slack_app_id,
      slack_bot_id: publicToolConfiguration.slack_bot_id,
      slack_bot_user_id: publicToolConfiguration.slack_bot_user_id,
      slack_enterprise_id: publicToolConfiguration.slack_enterprise_id,
    };
    const expiresAt = new Date(
      Date.parse(activatedAt) + 15 * 60_000,
    ).toISOString();

    database
      .prepare(
        `INSERT INTO organization_connection_attempts (
           connection_attempt_id, organization_id, requested_by_principal_id,
           requested_by_membership_id, attempt_purpose, target_owner_kind,
           target_principal_id, target_membership_id, provider, provider_issuer,
           provider_tenant_kind, provider_tenant_id, redirect_uri,
           requested_scopes_json, requested_scopes_sha256, state_sha256,
           nonce_sha256, pkce_challenge_sha256, admin_session_sha256, status,
           provider_subject_kind, provider_subject_id, granted_scopes_json,
           granted_scopes_sha256, verification_evidence_sha256, created_at,
           expires_at, consumed_at, outcome_reason
         ) VALUES (
           ?, ?, ?, ?, 'tool_connection', 'organization', NULL, NULL,
           'slack', 'https://slack.com', 'workspace', 'T12345678',
           'https://authority.invalid/callback', ?, ?, ?, ?, ?, ?, 'pending',
           NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL
         )`,
      )
      .run(
        connectionAttemptId,
        input.organization_id,
        input.owner.principal_id,
        input.owner.membership_id,
        scopesJson,
        canonicalSha256(scopes),
        canonicalSha256({ connection_attempt_id: connectionAttemptId, kind: 'state' }),
        canonicalSha256({ connection_attempt_id: connectionAttemptId, kind: 'nonce' }),
        canonicalSha256({ connection_attempt_id: connectionAttemptId, kind: 'pkce' }),
        canonicalSha256({ connection_attempt_id: connectionAttemptId, kind: 'admin-session' }),
        activatedAt,
        expiresAt,
      );
    database
      .prepare(
        `UPDATE organization_connection_attempts
            SET status = 'succeeded', provider_subject_kind = 'service_account',
                provider_subject_id = 'U12345679', granted_scopes_json = ?,
                granted_scopes_sha256 = ?, verification_evidence_sha256 = ?,
                consumed_at = ?
          WHERE connection_attempt_id = ?`,
      )
      .run(
        scopesJson,
        canonicalSha256(scopes),
        canonicalSha256({ connection_attempt_id: connectionAttemptId, kind: 'evidence' }),
        activatedAt,
        connectionAttemptId,
      );
    database
      .prepare(
        `INSERT INTO organization_tool_connections (
           connection_id, organization_id, connection_kind, owner_kind,
           owner_principal_id, owner_membership_id, human_identity_link_id,
           provider, provider_issuer, provider_tenant_kind, provider_tenant_id,
           provider_subject_kind, provider_subject_id, granted_scopes_json,
           granted_scopes_sha256, verification_attempt_id,
           verification_evidence_sha256, secret_backend_id, secret_handle_id,
           status, created_by_principal_id, created_by_membership_id,
           activated_at, revoked_at, revocation_reason,
           public_configuration_json, public_configuration_sha256
         ) VALUES (
           ?, ?, 'service_account', 'organization', NULL, NULL, NULL,
           'slack', 'https://slack.com', 'workspace', 'T12345678',
           'service_account', 'U12345679', ?, ?, ?, ?, ?, ?, 'active', ?, ?,
           ?, NULL, NULL, ?, ?
         )`,
      )
      .run(
        connectionId,
        input.organization_id,
        scopesJson,
        canonicalSha256(scopes),
        connectionAttemptId,
        canonicalSha256({ connection_attempt_id: connectionAttemptId, kind: 'evidence' }),
        AUTHORITY_FILE_SECRET_BACKEND,
        input.secret_handle_id ?? `sch_${randomUUID()}`,
        input.owner.principal_id,
        input.owner.membership_id,
        activatedAt,
        canonicalJson(publicToolConfiguration),
        canonicalSha256(publicToolConfiguration),
      );
    database
      .prepare(
        `INSERT INTO organization_adapter_bindings (
           adapter_binding_id, organization_id, product_namespace,
           installation_id, installation_key_id, adapter_kind, adapter_id,
           adapter_instance_id, adapter_version, connection_id,
           public_configuration_json, public_configuration_sha256, status,
           created_by_principal_id, created_by_membership_id, bound_at,
           revoked_at, revocation_reason
         ) VALUES (
           ?, ?, 'echo-brain', ?, ?, 'approval-surface', 'slack-reactions',
           ?, '1.0.0', ?, ?, ?, 'active', ?, ?, ?, NULL, NULL
         )`,
      )
      .run(
        adapterBindingId,
        input.organization_id,
        input.installation.installation_id,
        input.installation.installation_key_id,
        input.adapter_instance_id ?? 'primary',
        connectionId,
        canonicalJson(publicBindingConfiguration),
        canonicalSha256(publicBindingConfiguration),
        input.owner.principal_id,
        input.owner.membership_id,
        activatedAt,
      );
    if (
      !integrations.hasActiveSlackApprovalSurfaceInstance(
        input.adapter_instance_id ?? 'primary',
      )
    ) {
      throw new Error('seeded Slack approval surface is not active');
    }
    return Object.freeze({
      connection_attempt_id: connectionAttemptId,
      connection_id: connectionId,
      adapter_binding_id: adapterBindingId,
    });
  } finally {
    database.close();
  }
}
