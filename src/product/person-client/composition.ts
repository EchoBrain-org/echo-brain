import { createSlackPersonCommandsV1 } from '@echo-brain/provider-slack-client/person/slack-commands';
import { runPersonClientCli as runCli, type PersonClientCliDependencies } from './commands.js';

/** The shipped Person CLI selects its tool fragments only at this entrypoint. */
export function runPersonClientCli(argv: readonly string[], dependencies: PersonClientCliDependencies = {}): Promise<number> {
  return runCli(argv, { ...dependencies, tool_commands: dependencies.tool_commands ?? createSlackPersonCommandsV1() });
}
