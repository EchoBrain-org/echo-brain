/**
 * Public integration surface for Slack-backed approval contracts used by
 * Organization Authority: the control database, visibility policy contracts,
 * the tool connection contracts, and the Slack identity-link lookup.
 */
export { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/persistence/open-organization-control-database";
export * from "@echo-brain/organization-control-plane/record-visibility-policy-contracts-v1";
export {
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
} from "./application/organization-tool-connection-contracts-v2.js";
export { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
export {
  resolveCurrentSlackDmApprovalReviewerTargetV1,
  type CurrentSlackDmApprovalReviewerV1,
  type CurrentSlackDmApprovalReviewerTargetV1,
  type PrivateApprovalSlackIdentityLinkV1,
  type SlackDmApprovalReviewerTargetCoordinatesV1,
} from "./persistence/sqlite-slack-dm-approval-reviewer-target-v1.js";
