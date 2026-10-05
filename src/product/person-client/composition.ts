import { createConfluencePersonToolProviderV1 } from '@echo-brain/provider-confluence-client/person/confluence-tool-provider';
import { createJiraPersonToolProviderV1 } from '@echo-brain/provider-jira-client/person/jira-tool-provider';
import { createSlackPersonToolProviderV1 } from '@echo-brain/provider-slack-client/person/slack-tool-provider';
import { runPersonClientCli as runCli, type PersonClientCliDependencies } from './commands.js';
export { runClientUpdateCli, updateBeforePersonCommand } from './client-update-cli.js';

/** The shipped Person CLI selects its tool providers only at this entrypoint. */
export function runPersonClientCli(argv: readonly string[], dependencies: PersonClientCliDependencies = {}): Promise<number> {
  return runCli(argv, { ...dependencies, tool_providers: dependencies.tool_providers ?? [createSlackPersonToolProviderV1(), createJiraPersonToolProviderV1(), createConfluencePersonToolProviderV1()] });
}
