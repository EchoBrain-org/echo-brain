import { expect, it, vi } from 'vitest';
import type { ProviderHttpRequestV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import {
  PERSON_JIRA_CANCEL_PATH_V1,
  PERSON_JIRA_CONNECT_PATH_V1,
  PERSON_JIRA_DISCONNECT_PATH_V1,
  PERSON_JIRA_STATUS_PATH_V1,
} from '@echo-brain/provider-jira-client/organization-api/jira-person-connection-v1';
import { createJiraPersonConnectionHttpApplicationV1, type JiraPersonConnectionHttpPortV1 } from '../src/jira-person-connection-http-application-v1.js';

const attempt = '00000000-0000-4000-8000-000000000001';
const expires_at = '2026-10-01T00:30:00.000Z';
function request(route_id: string, path: string, value: unknown, input: Partial<ProviderHttpRequestV1> = {}): ProviderHttpRequestV1 {
  return {
    route_id, method: 'POST', path, raw_body: new TextEncoder().encode(JSON.stringify(value)),
    content_type: 'application/json', headers: { authorization: 'Bearer synthetic-access' }, ...input,
  };
}
function fixture() {
  const connection: JiraPersonConnectionHttpPortV1 = {
    connect: vi.fn(async () => ({ schema_version: 1 as const, attempt, connect_link: 'https://connect.nango.dev/fixture', expires_at })),
    status: vi.fn(async () => ({ schema_version: 1 as const, attempt, expires_at, status: 'pending' as const, failure_reason: null })),
    cancel: vi.fn(async () => ({ schema_version: 1 as const, attempt, expires_at, status: 'cancelled' as const, failure_reason: null })),
    disconnect: vi.fn(async () => ({ schema_version: 1 as const, connected: false as const })),
  };
  return { connection, application: createJiraPersonConnectionHttpApplicationV1(connection) };
}

it('owns the four strict Jira Person connection routes and forwards only the authenticated command', async () => {
  const f = fixture();
  expect(f.application.routes).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: PERSON_JIRA_CONNECT_PATH_V1 }), expect.objectContaining({ path: PERSON_JIRA_STATUS_PATH_V1 }),
    expect.objectContaining({ path: PERSON_JIRA_CANCEL_PATH_V1 }), expect.objectContaining({ path: PERSON_JIRA_DISCONNECT_PATH_V1 }),
  ]));
  await expect(f.application.accept(request('jira-connect', PERSON_JIRA_CONNECT_PATH_V1, { schema_version: 1 }))).resolves.toMatchObject({ status: 201, body: { attempt } });
  expect(f.connection.connect).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'synthetic-access' }));
  await expect(f.application.accept(request('jira-status', PERSON_JIRA_STATUS_PATH_V1, { schema_version: 1, attempt }))).resolves.toMatchObject({ status: 200, body: { status: 'pending' } });
  await expect(f.application.accept(request('jira-cancel', PERSON_JIRA_CANCEL_PATH_V1, { schema_version: 1, attempt }))).resolves.toMatchObject({ status: 200, body: { status: 'cancelled' } });
  await expect(f.application.accept(request('jira-disconnect', PERSON_JIRA_DISCONNECT_PATH_V1, { schema_version: 1 }))).resolves.toMatchObject({ status: 200, body: { connected: false } });
  expect(f.connection.status).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'synthetic-access', attempt }));
  expect(f.connection.cancel).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'synthetic-access', attempt }));
});

it('rejects malformed JSON, missing bearer authentication, and caller-selected identity fields before connection work', async () => {
  const f = fixture();
  await expect(f.application.accept(request('jira-connect', PERSON_JIRA_CONNECT_PATH_V1, { schema_version: 1, organization_id: 'other' }))).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(f.application.accept(request('jira-status', PERSON_JIRA_STATUS_PATH_V1, { schema_version: 1, attempt: 'not-an-attempt' }))).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(f.application.accept(request('jira-connect', PERSON_JIRA_CONNECT_PATH_V1, { schema_version: 1 }, { headers: {} }))).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(f.application.accept(request('jira-connect', PERSON_JIRA_CONNECT_PATH_V1, { schema_version: 1 }, { content_type: 'text/plain' }))).rejects.toMatchObject({ code: 'invalid_request' });
  expect(f.connection.connect).not.toHaveBeenCalled();
});

it('forwards the listener cancellation signal to the provider lifecycle', async () => {
  const f = fixture(); const controller = new AbortController();
  await f.application.accept(request('jira-status', PERSON_JIRA_STATUS_PATH_V1, { schema_version: 1, attempt }, { signal: controller.signal }));
  expect(f.connection.status).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
});
