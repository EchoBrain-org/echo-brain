import type {
  OrganizationPermissionCheckDecisionV1,
  OrganizationPermissionCheckRequestV1,
  OrganizationMemberReadablePermissionCheckDecisionV3,
  OrganizationMemberReadablePermissionCheckRequestV3,
  OrganizationReviewerPermissionCheckDecisionV2,
  OrganizationReviewerPermissionCheckRequestV2,
  OrganizationSlackLinkBeginRequestV1,
  OrganizationSlackLinkBeginResponseV1,
  OrganizationSlackLinkCompleteRequestV1,
  OrganizationSlackLinkResultV1,
} from '@echo-brain/organization-api';
import type {
  ActivatedOrganizationSlackApproval,
} from '../application/slack-approval-activation.js';

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

export interface OrganizationIntegrationsHttpApplication {
  overview(): OrganizationIntegrationsOverview;
  onboardSlackOrganizationTool(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<OnboardSlackOrganizationToolResult>;
  activateSlackApproval(
    input: unknown,
  ): ActivatedOrganizationSlackApproval | Promise<ActivatedOrganizationSlackApproval>;
  beginSlackIdentityLink(
    input: OrganizationSlackLinkBeginRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkBeginResponseV1>;
  completeSlackIdentityLink(
    input: OrganizationSlackLinkCompleteRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkResultV1>;
  checkReviewerPermission(
    request: OrganizationReviewerPermissionCheckRequestV2,
    signal?: AbortSignal,
  ): Promise<OrganizationReviewerPermissionCheckDecisionV2>;

  checkOrganizationMemberReadablePermission?(
    request: OrganizationMemberReadablePermissionCheckRequestV3,
    signal?: AbortSignal,
  ): Promise<OrganizationMemberReadablePermissionCheckDecisionV3>;

  checkPermission(
    request: OrganizationPermissionCheckRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationPermissionCheckDecisionV1>;
}
