import { createPersonToolConnectionVerbsV1, type PersonToolProviderV1 } from "@echo-brain/organization-api";
import { JiraPersonClientV1 } from "./jira-person-client.js";

export function createJiraPersonToolProviderV1(): PersonToolProviderV1 {
  const verbs: PersonToolProviderV1["verbs"] = {
    ...createPersonToolConnectionVerbsV1("Jira", host => new JiraPersonClientV1(host)),
    project: {
      description: 'Reads an ECHO project’s Jira mapping. Leads can set --jira-project or --clear with --mapping-revision (none for a new setting) and --mapping-request (UUID).',
      options: { 'echo-project': { type: 'string' }, 'jira-project': { type: 'string' }, 'clear': { type: 'boolean' }, 'mapping-revision': { type: 'string' }, 'mapping-request': { type: 'string' } },
      requires: ['echo-project'],
      run: async context => {
        const values = context.values;
        const project_id = values['echo-project'];
        if (typeof project_id !== 'string') throw new Error('--echo-project is required');
        const client = new JiraPersonClientV1(context.host);
        const write = values['jira-project'] !== undefined || values.clear === true;
        if (values.clear === true && values['jira-project'] !== undefined) throw new Error('Choose --jira-project or --clear');
        if (!write && (values['mapping-revision'] !== undefined || values['mapping-request'] !== undefined)) throw new Error('A mapping change is required');
        if (write && (typeof values['mapping-revision'] !== 'string' || typeof values['mapping-request'] !== 'string')) throw new Error('--mapping-revision and --mapping-request are required');
        context.print({ ok: true, result: write ? await client.projectSet({ schema_version: 1, project_id,
          request_id: values['mapping-request'] as string, expected_revision: values['mapping-revision'] === 'none' ? null : values['mapping-revision'] as string,
          jira_project: values.clear === true ? null : values['jira-project'] as string,
        }) : await client.projectRead(project_id) });
      },
    },
  };
  return Object.freeze({ tool_id: "jira", verbs: Object.freeze(verbs) });
}
