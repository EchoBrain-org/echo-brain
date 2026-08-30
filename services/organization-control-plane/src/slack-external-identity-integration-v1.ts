/** Slack connection verification and Person-to-Slack identity linking. */
export {
  AUTHORITY_FILE_SECRET_BACKEND,
  SLACK_DEFAULT_APPROVE_REACTION,
  SLACK_DEFAULT_REJECT_REACTION,
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  type ActiveSlackOrganizationTool,
  type BeginPersonSlackIdentityLinkChallengeInput,
  type BegunSlackIdentityLinkChallenge,
  type CompletePersonSlackIdentityLinkChallengeInput,
  type CompletedPersonSlackIdentityLink,
  type OrganizationSecretReference,
  type OrganizationSecretStore,
  type PendingPersonSlackIdentityLinkChallenge,
  type PersonSlackIdentityLinkSession,
} from "./application/contracts.js";
export {
  CleanSlackIdentityProviderErrorV1,
  CleanSlackWebIdentityProviderV1,
  type CleanSlackIdentityProviderV1,
} from "./adapters/slack/clean-slack-web-identity-provider-v1.js";
export { FileOrganizationSecretStore } from "./security/file-secret-store.js";
export {
  buildExternalHumanIdentityLinkContractV2,
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
} from "./application/person-slack-reaction-approval-contracts-v2.js";
