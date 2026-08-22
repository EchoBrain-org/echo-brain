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
  runCleanPersonSlackApprovalActivateCli,
  type CleanPersonSlackApprovalActivateCliDependencies,
  type CleanPersonSlackApprovalActivateCliIo,
} from "./composition/clean-person-slack-approval-activate-cli.js";
