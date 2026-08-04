export const ORGANIZATION_API_ADMIN_SLACK_APPROVAL_ACTIVATION_PATH =
  '/v1/admin/integrations/slack-approval-activation';

export interface ActivateOrganizationSlackApprovalRequest {
  command_id: string;
  administrator_membership_id: string;
  target_membership_id: string;
  installation_id: string;
  identity_link_id: string;
  adapter_binding_id: string;
}

export interface ActivatedOrganizationSlackApproval {
  identity_link_id: string;
  adapter_binding_id: string;
  approve_permission_grant_id: string;
  reject_permission_grant_id: string;
  membership_id: string;
  installation_id: string;
  activated_at: string;
  permission_grants_created: 0 | 2;
}
