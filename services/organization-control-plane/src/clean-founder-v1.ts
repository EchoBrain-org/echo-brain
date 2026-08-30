/**
 * Narrow stopped-state commands consumed by the clean founder coordinator.
 * This leaf deliberately exposes no legacy control-plane runtime.
 */
export {
  runCleanSlackConnectCli,
  type CleanSlackConnectCliDependencies,
  type CleanSlackConnectCliIo,
} from "./composition/clean-slack-connect-cli.js";
export {
  runCleanPersonSlackReactionApprovalActivateCli,
  type CleanPersonSlackReactionApprovalActivateCliDependencies,
  type CleanPersonSlackReactionApprovalActivateCliIo,
} from "./composition/clean-person-slack-reaction-approval-activate-cli.js";
export { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES } from "./application/contracts.js";
