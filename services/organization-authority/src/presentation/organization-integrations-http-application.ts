import type {
  OrganizationPermissionCheckDecisionV1,
  OrganizationPermissionCheckRequestV1,
} from '@echo-brain/organization-api';

export interface BootstrapSlackApprovalResult {
  connection_attempt_id: string;
  identity_attempt_id: string;
  identity_link_id: string;
  connection_id: string;
  adapter_binding_id: string;
  approve_permission_grant_id: string;
  reject_permission_grant_id: string;
  organization_id: string;
  membership_id: string;
  installation_id: string;
  slack_team_id: string;
  slack_user_id: string;
  channel_id: string;
  created_at: string;
}

export interface OnboardOrganizationSlackToolRequest {
  command_id: string;
  administrator_membership_id: string;
  channel_id: string;
  slack_bot_token: string;
}

export interface OnboardSlackOrganizationToolResult {
  connection_attempt_id: string;
  connection_id: string;
  organization_id: string;
  provider: 'slack';
  status: 'active';
  slack_team_id: string;
  slack_bot_user_id: string;
  channel_id: string;
  granted_scopes: readonly string[];
  activated_at: string;
}

export interface OrganizationIntegrationsOverview {
  identity_links: readonly Readonly<Record<string, unknown>>[];
  tool_connections: readonly Readonly<Record<string, unknown>>[];
  adapter_bindings: readonly Readonly<Record<string, unknown>>[];
  permission_grants: readonly Readonly<Record<string, unknown>>[];
  recent_audit: readonly Readonly<Record<string, unknown>>[];
}

export interface BootstrapOrganizationSlackApprovalRequest {
  command_id: string;
  administrator_membership_id: string;
  target_membership_id: string;
  installation_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  channel_id: string;
  approve_reaction: string;
  reject_reaction: string;
  slack_user_id: string;
  slack_bot_token: string;
}

export interface OrganizationIntegrationsHttpApplication {
  overview(): OrganizationIntegrationsOverview;
  onboardSlackOrganizationTool(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<OnboardSlackOrganizationToolResult>;
  bootstrapSlackApproval(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<BootstrapSlackApprovalResult>;
  checkPermission(
    request: OrganizationPermissionCheckRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationPermissionCheckDecisionV1>;
}
