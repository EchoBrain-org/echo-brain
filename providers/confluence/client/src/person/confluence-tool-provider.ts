import { createPersonToolConnectionVerbsV1, type PersonToolProviderV1 } from "@echo-brain/organization-api";
import { ConfluencePersonClientV1 } from "./confluence-person-client.js";

export function createConfluencePersonToolProviderV1(): PersonToolProviderV1 {
  const verbs: PersonToolProviderV1["verbs"] = {
    ...createPersonToolConnectionVerbsV1("Confluence", host => new ConfluencePersonClientV1(host)),
    project: {
      description: 'Reads or changes an ECHO project’s Confluence spaces; --spaces lists the spaces you can choose. Leads set --space-ids (comma-separated stable space IDs) or --clear with --mapping-revision and --mapping-request.',
      options: { 'echo-project': { type: 'string' }, 'space-ids': { type: 'string' }, 'spaces': { type: 'boolean' }, 'space-cursor': { type: 'string' }, 'clear': { type: 'boolean' }, 'mapping-revision': { type: 'string' }, 'mapping-request': { type: 'string' } },
      run: async context => {
        const values = context.values;
        const client = new ConfluencePersonClientV1(context.host);
        if (values.spaces === true) {
          if (values['echo-project'] !== undefined || values['space-ids'] !== undefined || values.clear === true || values['mapping-revision'] !== undefined || values['mapping-request'] !== undefined) throw new Error('Listing cannot be combined with a mapping option');
          const cursor = values['space-cursor'];
          if (cursor !== undefined && typeof cursor !== 'string') throw new Error('--cursor is invalid');
          context.print({ ok: true, result: await client.spaces({ schema_version: 1, ...(cursor === undefined ? {} : { cursor }) }) });
          return;
        }
        const project_id = values['echo-project'];
        if (typeof project_id !== 'string') throw new Error('--echo-project is required');
        const raw = values['space-ids'];
        const parsed = typeof raw === 'string' ? raw.split(',').map(value => value.trim()).filter(Boolean) : undefined;
        const write = parsed !== undefined || values.clear === true;
        if (values.clear === true && parsed !== undefined) throw new Error('Choose --space-ids or --clear');
        if (!write && (values['mapping-revision'] !== undefined || values['mapping-request'] !== undefined)) throw new Error('A mapping change is required');
        if (write && (typeof values['mapping-revision'] !== 'string' || typeof values['mapping-request'] !== 'string')) throw new Error('--mapping-revision and --mapping-request are required');
        context.print({ ok: true, result: write ? await client.projectSet({ schema_version: 1, project_id,
          request_id: values['mapping-request'] as string, expected_revision: values['mapping-revision'] === 'none' ? null : values['mapping-revision'] as string,
          space_ids: values.clear === true ? null : parsed!,
        }) : await client.projectRead(project_id) });
      },
    },
  };
  return Object.freeze({ tool_id: "confluence", verbs: Object.freeze(verbs) });
}
