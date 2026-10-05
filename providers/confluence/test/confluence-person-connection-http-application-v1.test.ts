import { expect, it, vi } from 'vitest';
import type { ProviderHttpRequestV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import {
  PERSON_CONFLUENCE_CANCEL_PATH_V1, PERSON_CONFLUENCE_CONNECT_PATH_V1, PERSON_CONFLUENCE_DISCONNECT_PATH_V1, PERSON_CONFLUENCE_STATUS_PATH_V1,
} from '@echo-brain/provider-confluence-client/organization-api/confluence-person-connection-v1';
import {
  PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1, PERSON_CONFLUENCE_PROJECT_READ_PATH_V1, PERSON_CONFLUENCE_PROJECT_SET_PATH_V1, PERSON_CONFLUENCE_SPACES_LIST_PATH_V1,
} from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import { createConfluencePersonConnectionHttpApplicationV1, type ConfluencePersonConnectionHttpPortV1 } from '../src/confluence-person-connection-http-application-v1.js';

const attempt = '00000000-0000-4000-8000-000000000001';
const project = 'prj_00000000-0000-4000-8000-000000000010';
const revision = '00000000-0000-4000-8000-000000000011';
function request(route_id: string, path: string, value: unknown, input: Partial<ProviderHttpRequestV1> = {}): ProviderHttpRequestV1 {
  return { route_id, method: 'POST', path, raw_body: new TextEncoder().encode(JSON.stringify(value)), content_type: 'application/json', headers: { authorization: 'Bearer synthetic-person' }, ...input };
}
function fixture() {
  const mapping = { schema_version: 1 as const, project_id: project, revision, mapping: { cloud_id: '00000000-0000-4000-8000-000000000007', space_ids: ['123'] } };
  const connection: ConfluencePersonConnectionHttpPortV1 = {
    connect: vi.fn(async () => ({ schema_version: 1 as const, attempt, connect_link: 'https://connect.nango.dev/fixture', expires_at: '2026-10-01T00:30:00.000Z' })),
    status: vi.fn(async () => ({ schema_version: 1 as const, attempt, expires_at: '2026-10-01T00:30:00.000Z', status: 'pending' as const, failure_reason: null })),
    cancel: vi.fn(async () => ({ schema_version: 1 as const, attempt, expires_at: '2026-10-01T00:30:00.000Z', status: 'cancelled' as const, failure_reason: null })),
    disconnect: vi.fn(async () => ({ schema_version: 1 as const, connected: false as const })),
    projectRead: vi.fn(() => mapping), projectSet: vi.fn(async () => mapping), projectList: vi.fn(() => ({ schema_version: 1 as const, mappings: [mapping] })),
    spacesList: vi.fn(async () => ({ schema_version: 1 as const, items: [{ id: '123', key: '~person', name: 'Personal space' }], next_cursor: null })),
  };
  return { connection, application: createConfluencePersonConnectionHttpApplicationV1(connection) };
}

it('owns lifecycle, project mapping, and permission-filtered space picker routes', async () => {
  const f = fixture();
  expect(f.application.routes.map(route => route.path)).toEqual(expect.arrayContaining([
    PERSON_CONFLUENCE_CONNECT_PATH_V1, PERSON_CONFLUENCE_STATUS_PATH_V1, PERSON_CONFLUENCE_CANCEL_PATH_V1, PERSON_CONFLUENCE_DISCONNECT_PATH_V1,
    PERSON_CONFLUENCE_PROJECT_READ_PATH_V1, PERSON_CONFLUENCE_PROJECT_SET_PATH_V1, PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1, PERSON_CONFLUENCE_SPACES_LIST_PATH_V1,
  ]));
  await expect(f.application.accept(request('confluence-connect', PERSON_CONFLUENCE_CONNECT_PATH_V1, { schema_version: 1 }))).resolves.toMatchObject({ status: 201, body: { attempt } });
  await expect(f.application.accept(request('confluence-status', PERSON_CONFLUENCE_STATUS_PATH_V1, { schema_version: 1, attempt }))).resolves.toMatchObject({ status: 200, body: { status: 'pending' } });
  await expect(f.application.accept(request('confluence-cancel', PERSON_CONFLUENCE_CANCEL_PATH_V1, { schema_version: 1, attempt }))).resolves.toMatchObject({ status: 200, body: { status: 'cancelled' } });
  await expect(f.application.accept(request('confluence-disconnect', PERSON_CONFLUENCE_DISCONNECT_PATH_V1, { schema_version: 1 }))).resolves.toMatchObject({ status: 200, body: { connected: false } });
  await expect(f.application.accept(request('confluence-project-read', PERSON_CONFLUENCE_PROJECT_READ_PATH_V1, { schema_version: 1, project_id: project }))).resolves.toMatchObject({ body: { mapping: { space_ids: ['123'] } } });
  await expect(f.application.accept(request('confluence-project-list', PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1, { schema_version: 1 }))).resolves.toMatchObject({ body: { mappings: [expect.objectContaining({ project_id: project })] } });
  await expect(f.application.accept(request('confluence-spaces-list', PERSON_CONFLUENCE_SPACES_LIST_PATH_V1, { schema_version: 1 }))).resolves.toMatchObject({ body: { items: [{ id: '123', key: '~person' }] } });
  await expect(f.application.accept(request('confluence-project-set', PERSON_CONFLUENCE_PROJECT_SET_PATH_V1, { schema_version: 1, project_id: project, request_id: '00000000-0000-4000-8000-000000000012', expected_revision: revision, space_ids: ['123'] }))).resolves.toMatchObject({ body: { revision } });
  expect(f.connection.spacesList).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'synthetic-person' }));
});

it('rejects caller-selected identity, invalid personal-space picker cursors, and missing auth before provider work', async () => {
  const f = fixture();
  await expect(f.application.accept(request('confluence-connect', PERSON_CONFLUENCE_CONNECT_PATH_V1, { schema_version: 1, organization_id: 'other' }))).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(f.application.accept(request('confluence-spaces-list', PERSON_CONFLUENCE_SPACES_LIST_PATH_V1, { schema_version: 1, cursor: 'provider-url-not-allowed?' }))).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(f.application.accept(request('confluence-connect', PERSON_CONFLUENCE_CONNECT_PATH_V1, { schema_version: 1 }, { headers: {} }))).rejects.toMatchObject({ code: 'unauthorized' });
  expect(f.connection.connect).not.toHaveBeenCalled();
  expect(f.connection.spacesList).not.toHaveBeenCalled();
});
