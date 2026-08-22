/** Private workspace entrypoint for new-lineage genesis composition. */
export {
  applyOrganizationControlBaselineV1,
  ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1,
  organizationControlBaselineSha256V1,
} from "./persistence/baseline.js";
export { openOrganizationControlDatabase } from "./persistence/open-unmigrated-database.js";
/**
 * Clean runtime-only Slack contracts and adapters. These modules do not load
 * the legacy migration/open-database entrypoints exported by the package root.
 */
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
  type SlackIntegrationProvider,
} from "./application/contracts.js";
export {
  SlackIntegrationProviderError,
  SlackWebIntegrationProvider,
} from "./adapters/slack/slack-integration-provider.js";
export { FileOrganizationSecretStore } from "./security/file-secret-store.js";
export {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  buildExternalHumanIdentityLinkContractV2,
  validatePersonSlackApprovalBindingContractV2,
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
} from "./application/person-slack-approval-contracts-v2.js";
export {
  CleanSlackConnectionConflictError,
  connectCleanSlackV1,
  runCleanSlackConnectCommandV1,
  type CleanSlackConnectionPublicInputV1,
  type CleanSlackConnectionVerifierV1,
  type ConnectedCleanSlackV1,
  type ConnectCleanSlackInputV1,
  type RunCleanSlackConnectCommandV1Input,
} from "./persistence/sqlite-clean-slack-connection-v1.js";
/** Private stopped-state activation primitives for the clean server path. */
export {
  activatePersonSlackApprovalV2,
  PersonSlackApprovalActivationConflictError,
  PersonSlackApprovalActivationDeniedError,
  type PersonSlackApprovalActivationCommandV2,
  type PersonSlackApprovalActivationResultV2,
} from "./application/person-slack-approval-activation-v2.js";
export {
  SqlitePersonSlackApprovalActivationCoordinatorV2,
  type StableAuthorityAdministratorFenceV2,
} from "./persistence/sqlite-person-slack-approval-activation-v2.js";
/** Private selected runtime seams for staged Slack approval finalization. */
export {
  stagePersonSlackPendingApprovalV1,
  validateReprovedPersonSlackPendingApprovalV1,
  PersonSlackPendingApprovalConflictError,
  type StagePersonSlackPendingApprovalCommandV1,
  type StagedPersonSlackPendingApprovalV1,
} from "./persistence/sqlite-person-slack-pending-approval-v1.js";
export {
  SqlitePersonSlackApprovalFinalizationCoordinatorV2,
  type StableAuthorityPersonSlackApprovalFenceV2,
} from "./persistence/sqlite-person-slack-approval-finalization-v2.js";
export {
  SqliteCleanSlackApprovalTokenReaderV1,
  type CleanSlackApprovalTokenReaderV1,
  type CleanSlackSecretReaderV1,
} from "./persistence/clean-slack-approval-token-reader-v1.js";
export { CleanSlackReactionObserverV1 } from "./adapters/slack/clean-slack-reaction-observer-v1.js";
export {
  finalizePersonSlackApprovalV2,
  PersonSlackApprovalFinalizationConflictError,
  PersonSlackApprovalFinalizationDeniedError,
  type PersonSlackApprovalFinalizationCodecV2,
  type PersonSlackApprovalFinalizationCoordinatorV2,
  type PersonSlackApprovalFinalizationIdFactoryV2,
  type PersonSlackApprovalFinalizationResultV2,
  type PersonSlackApprovalFinalizationTransactionV2,
  type PersonSlackApprovalObserverV2,
  type StoredProviderHumanActionV2,
} from "./application/person-slack-approval-finalization-v2.js";
export {
  buildProviderHumanActionDurableResult,
  buildProviderHumanSemanticActionInputV1,
  validateProviderHumanActionDurableResult,
  validateProviderHumanAuthorizationAllowV2,
  validateProviderHumanIntegrationAuditEntryV2,
  validateProviderHumanSemanticActionInputV1,
  type ApprovalContractSha256,
  type ProviderHumanActionContractSetV2,
} from "./application/person-slack-approval-contracts-v2.js";
