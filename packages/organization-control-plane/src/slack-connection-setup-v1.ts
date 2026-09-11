/** Organization Slack connection setup command surface. */
export {
  runSlackConnectionSetupCli,
  type SlackConnectionSetupCliDependencies,
  type SlackConnectionSetupCliIo,
} from "./composition/slack-connection-setup-cli.js";
/** Compatibility aliases for the original public command surface. */
export { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES } from "./application/slack-integration-contracts.js";
