import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { OrganizationPersonToolV3, OrganizationPersonToolV4, OrganizationToolSetupStatusV4 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { createPersonToolsHttpApplicationV3, createPersonToolsHttpApplicationV4 } from '../../src/presentation/person-tools-http-application.js';

const authorization: PersonAccessAuthorization = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_type: 'employee', identity_binding_id: 'identity', session_family_id: 'session',
  access_credential_sha256: canonicalSha256({ access: 1 }), person_state_sha256: canonicalSha256({ person: 1 }), session_state_sha256: canonicalSha256({ session: 1 }),
  access_expires_at: '2026-09-12T12:00:00Z', hard_reauthentication_at: '2026-09-13T12:00:00Z', checked_at: '2026-09-12T11:00:00Z',
};
const request = { route_id: 'person-tools-v3', method: 'GET' as const, path: '/v3/person/tools', raw_body: new Uint8Array(), content_type: undefined, headers: { authorization: 'Bearer test-session' } };
const tool = (tool_id: string): OrganizationPersonToolV3 => ({ tool_id, display_name: tool_id, availability: 'enabled', personal_status: 'linked', external_scope_id: 'tenant@example', external_subject_id: 'subject@example' });
const toolV4 = (tool_id: string, organization_setup: OrganizationToolSetupStatusV4 | null = null): OrganizationPersonToolV4 => ({ ...tool(tool_id), organization_setup });

describe('Person tools status authorization', () => {
  it('refuses unauthenticated reads before calling tools and account/session drift after awaiting them', async () => {
    const tools = vi.fn(async () => [toolV4('calendar')]);
    const api = createPersonToolsHttpApplicationV3({ authenticate: () => authorization, tools });
    await expect(api.accept({ ...request, headers: {} })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(tools).not.toHaveBeenCalled();
    for (const change of [{ membership_id: 'different' }, { principal_id: 'different' }, { session_state_sha256: canonicalSha256({ changed: 1 }) }]) {
      let calls = 0;
      const route = createPersonToolsHttpApplicationV3({ authenticate: () => ++calls === 1 ? authorization : { ...authorization, ...change }, tools });
      await expect(route.accept(request)).rejects.toMatchObject({ code: 'unauthorized' });
    }
    const duplicate = createPersonToolsHttpApplicationV3({ authenticate: () => authorization, tools: async () => [toolV4('calendar'), toolV4('calendar')] });
    await expect(duplicate.accept(request)).rejects.toThrow();
  });
  it('v4 carries the organization setup status through untouched', async () => {
    const api = createPersonToolsHttpApplicationV4({ authenticate: () => authorization, tools: async () => [toolV4('slack', 'connected')] });
    expect(await api.accept({ ...request, route_id: 'person-tools-v4', path: '/v4/person/tools' })).toMatchObject({
      status: 200, body: { schema_version: 4, tools: [toolV4('slack', 'connected')] },
    });
  });
  it('v3 strips organization_setup from v4 tools', async () => {
    const api = createPersonToolsHttpApplicationV3({ authenticate: () => authorization, tools: async () => [toolV4('slack', 'connected')] });
    const response = await api.accept(request) as { readonly status: number; readonly body: { readonly tools: readonly unknown[] } };
    expect(response).toMatchObject({ status: 200, body: { schema_version: 3 } });
    expect(response.body.tools).toEqual([tool('slack')]);
    expect(response.body.tools[0]).not.toHaveProperty('organization_setup');
  });
});
