import { describe, expect, it } from 'vitest';
import { personMeetingProjectPathsV1, validatePersonMeetingProjectSetV1, validatePersonMeetingFoldersPageV1 } from '../src/person-meeting-projects-v1.js';
import { PersonMeetingProjectClientV1 } from '../src/person-meeting-project-client-v1.js';
import type { PersonToolSessionV1 } from '../src/person-tool-client.js';

const project_id = 'prj_11111111-1111-4111-8111-111111111111';
const command = { schema_version: 1, project_id, request_id: '11111111-1111-4111-8111-111111111112', expected_revision: null, folder_ids: ['folder-1'] };
describe('personal meeting search mappings', () => {
  it('accepts stable provider folder IDs while rejecting route injection and accidental extraction options', () => {
    expect(personMeetingProjectPathsV1('granola').set).toBe('/v1/person/tools/granola/project/set');
    for (const tool of ['../meetings', 'https://example.test', 'granola?import=1']) expect(() => personMeetingProjectPathsV1(tool)).toThrow();
    expect(validatePersonMeetingProjectSetV1(command)).toEqual(command);
    for (const value of [{ ...command, retain: true }, { ...command, watch: 'folder' }, { ...command, folder_ids: [] },
      { ...command, folder_ids: ['folder-1', 'folder-1'] }, { ...command, folder_ids: ['../folder'] }, { ...command, expected_revision: 'stale' }]) {
      expect(() => validatePersonMeetingProjectSetV1(value)).toThrow();
    }
  });
  it('refuses a mapping response for another project before returning it to the client', async () => {
    const session: PersonToolSessionV1 = { identity: { organization_id: 'org', membership_id: 'member' }, request_id: () => 'request', random_bytes: n => new Uint8Array(n),
      transport: { getJson: async () => { throw new Error('Unexpected GET'); }, json: async input => {
        input.validate_request(input.body);
        return input.validate_response({ schema_version: 1, project_id: 'prj_22222222-2222-4222-8222-222222222222', revision: null, mapping: null });
      } } };
    const client = new PersonMeetingProjectClientV1({ withToolSession: operation => operation(session) }, 'granola', 'Granola');
    await expect(client.projectRead(project_id)).rejects.toThrow('did not match');
  });
  it('refuses duplicate folder identities and malformed continuations from the provider picker', () => {
    const item = { id: 'folder-1', key: 'folder-1', name: 'Interviews' };
    expect(() => validatePersonMeetingFoldersPageV1({ schema_version: 1, items: [item, item], next_cursor: null })).toThrow();
    expect(() => validatePersonMeetingFoldersPageV1({ schema_version: 1, items: [item], next_cursor: 'https://example.test/' })).toThrow();
  });
});
