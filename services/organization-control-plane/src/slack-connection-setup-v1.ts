/** Current owner-operated Slack connection setup command surface. */
export {
  runSlackConnectionSetupCli,
  type SlackConnectionSetupCliDependencies,
  type SlackConnectionSetupCliIo,
} from "./composition/slack-connection-setup-cli.js";
/** Compatibility aliases for the original public command surface. */
export {
  runSlackConnectionSetupCli as runCleanSlackConnectCli,
  type SlackConnectionSetupCliDependencies as CleanSlackConnectCliDependencies,
  type SlackConnectionSetupCliIo as CleanSlackConnectCliIo,
} from "./composition/slack-connection-setup-cli.js";
export { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES } from "./application/contracts.js";
