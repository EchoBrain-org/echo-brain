import { createPersonToolConnectionVerbsV1, PersonToolConnectionClientV1, personMeetingCommandV1, validatePersonMeetingRequestV1, type PersonToolProviderV1 } from '@echo-brain/organization-api';
function granolaTool(): PersonToolProviderV1 {
  const routes = Object.fromEntries(['connect','status','cancel','disconnect'].map(verb => [verb, `/v1/person/tools/granola/${verb}`])) as { connect: string; status: string; cancel: string; disconnect: string };
  const connection = createPersonToolConnectionVerbsV1('Granola', host => new PersonToolConnectionClientV1(host, 'Granola', routes));
  return { tool_id: 'granola', verbs: { ...connection, setup: connection.connect,
    meetings: { description: 'Browse, import, watch and review meetings with a versioned JSON request.', options: { request: { type: 'string' } }, requires: ['request'],
      async run(context) {
        const request = validatePersonMeetingRequestV1(JSON.parse(String(context.values.request)));
        if (request.tool_id !== 'granola') throw new Error('Meeting request must select Granola');
        context.print({ ok: true, result: await personMeetingCommandV1(context.host, request) });
      },
    },
  } };
}
import { createConfluencePersonToolProviderV1 } from '@echo-brain/provider-confluence-client/person/confluence-tool-provider';
import { createJiraPersonToolProviderV1 } from '@echo-brain/provider-jira-client/person/jira-tool-provider';
import { createSlackPersonToolProviderV1 } from '@echo-brain/provider-slack-client/person/slack-tool-provider';
import { runPersonClientCli as runCli, type PersonClientCliDependencies } from './commands.js';
export { runClientUpdateCli, updateBeforePersonCommand } from './client-update-cli.js';

/** The shipped Person CLI selects its tool providers only at this entrypoint. */
export function runPersonClientCli(argv: readonly string[], dependencies: PersonClientCliDependencies = {}): Promise<number> {
  return runCli(argv, { ...dependencies, tool_providers: dependencies.tool_providers ?? [granolaTool(), createSlackPersonToolProviderV1(), createJiraPersonToolProviderV1(), createConfluencePersonToolProviderV1()] });
}
