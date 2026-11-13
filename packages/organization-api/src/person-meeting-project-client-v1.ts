import { personMeetingProjectPathsV1, validatePersonMeetingProjectReadV1, validatePersonMeetingProjectSetV1, validatePersonMeetingProjectMappingV1, validatePersonMeetingFolderListV1, validatePersonMeetingFoldersPageV1, type PersonMeetingFolderListV1, type PersonMeetingFoldersPageV1, type PersonMeetingProjectSetV1, type PersonMeetingProjectMappingV1 } from './person-meeting-projects-v1.js';
import { PersonToolConnectionClientV1 } from './person-tool-connection-client-v1.js';
import { PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, type PersonToolHostV1, type PersonToolVerbV1 } from './person-tool-client.js';

const MEETING_TOOL_TIMEOUT_MS = 75_000;

export class PersonMeetingProjectClientV1 extends PersonToolConnectionClientV1 {
  private readonly paths: ReturnType<typeof personMeetingProjectPathsV1>;
  constructor(host: PersonToolHostV1, tool_id: string, display_name: string) {
    super(host, display_name, tool_id);
    this.paths = personMeetingProjectPathsV1(tool_id);
  }

  projectRead(project_id: string): Promise<PersonMeetingProjectMappingV1> {
    return this.projectRequest(this.paths.read, validatePersonMeetingProjectReadV1({ schema_version: 1, project_id }), validatePersonMeetingProjectReadV1);
  }
  projectSet(request: PersonMeetingProjectSetV1): Promise<PersonMeetingProjectMappingV1> {
    return this.projectRequest(this.paths.set, validatePersonMeetingProjectSetV1(request), validatePersonMeetingProjectSetV1);
  }
  folders(input: PersonMeetingFolderListV1): Promise<PersonMeetingFoldersPageV1> {
    // 20 folders at six JSON bytes per key/name code unit plus cursor: 66,563 bytes.
    return this.host.withToolSession(session => session.transport.json({ path: this.paths.folders, body: validatePersonMeetingFolderListV1(input), validate_request: validatePersonMeetingFolderListV1, validate_response: validatePersonMeetingFoldersPageV1, maximum_response_bytes: PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, timeout_ms: MEETING_TOOL_TIMEOUT_MS }));
  }
  private projectRequest(path: string, body: { readonly project_id: string }, validate_request: (value: unknown) => unknown): Promise<PersonMeetingProjectMappingV1> {
    return this.host.withToolSession(session => session.transport.json({ path, body, validate_request, validate_response: value => {
      const result = validatePersonMeetingProjectMappingV1(value);
      if (result.project_id !== body.project_id) throw new Error('Meeting project response did not match the requested project');
      return result;
    }, maximum_response_bytes: PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, timeout_ms: MEETING_TOOL_TIMEOUT_MS }));
  }

}

/** Shared folder mapping command for an explicitly selected meeting provider. */
export function createPersonMeetingProjectVerbV1(tool_id: string, display_name: string): PersonToolVerbV1 {
  personMeetingProjectPathsV1(tool_id);
  return {
    description: `Reads or changes an ECHO project’s ${display_name} folders; --folders lists the folders you can choose. Leads set --folder-ids (comma-separated stable folder IDs) or --clear with --mapping-revision and --mapping-request.`,
    options: { 'echo-project': { type: 'string' }, 'folder-ids': { type: 'string' }, 'folders': { type: 'boolean' }, 'folder-cursor': { type: 'string' }, 'clear': { type: 'boolean' }, 'mapping-revision': { type: 'string' }, 'mapping-request': { type: 'string' } },
    run: async context => {
      const values = context.values;
      const client = new PersonMeetingProjectClientV1(context.host, tool_id, display_name);
      if (values.folders === true) {
        if (values['echo-project'] !== undefined || values['folder-ids'] !== undefined || values.clear === true || values['mapping-revision'] !== undefined || values['mapping-request'] !== undefined) throw new Error('Listing cannot be combined with a mapping option');
        const cursor = values['folder-cursor'];
        if (cursor !== undefined && typeof cursor !== 'string') throw new Error('--cursor is invalid');
        context.print({ ok: true, result: await client.folders({ schema_version: 1, ...(cursor === undefined ? {} : { cursor }) }) });
        return;
      }
      const project_id = values['echo-project'];
      if (typeof project_id !== 'string') throw new Error('--echo-project is required');
      const raw = values['folder-ids'];
      const parsed = typeof raw === 'string' ? raw.split(',').map(value => value.trim()).filter(Boolean) : undefined;
      const write = parsed !== undefined || values.clear === true;
      if (values.clear === true && parsed !== undefined) throw new Error('Choose --folder-ids or --clear');
      if (!write && (values['mapping-revision'] !== undefined || values['mapping-request'] !== undefined)) throw new Error('A mapping change is required');
      if (write && (typeof values['mapping-revision'] !== 'string' || typeof values['mapping-request'] !== 'string')) throw new Error('--mapping-revision and --mapping-request are required');
      context.print({ ok: true, result: write ? await client.projectSet({ schema_version: 1, project_id,
        request_id: values['mapping-request'] as string, expected_revision: values['mapping-revision'] === 'none' ? null : values['mapping-revision'] as string,
        folder_ids: values.clear === true ? null : parsed!,
      }) : await client.projectRead(project_id) });
    },
  };
}
