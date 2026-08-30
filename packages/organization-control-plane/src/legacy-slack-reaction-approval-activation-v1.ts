/** Retained installation-bound Slack reaction approval activation command. */
export {
  runLegacySlackReactionApprovalActivationCli,
  type LegacySlackReactionApprovalActivationCliDependencies,
  type LegacySlackReactionApprovalActivationCliIo,
} from "./composition/legacy-slack-reaction-approval-activation-cli.js";
/** Compatibility aliases for installations that imported the original command. */
export {
  runLegacySlackReactionApprovalActivationCli as runCleanPersonSlackReactionApprovalActivateCli,
  type LegacySlackReactionApprovalActivationCliDependencies as CleanPersonSlackReactionApprovalActivateCliDependencies,
  type LegacySlackReactionApprovalActivationCliIo as CleanPersonSlackReactionApprovalActivateCliIo,
} from "./composition/legacy-slack-reaction-approval-activation-cli.js";
