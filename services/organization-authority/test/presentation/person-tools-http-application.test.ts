import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { OrganizationPersonToolV4, OrganizationToolSetupStatusV4 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { createOrganizationAuthorityHttpServer } from '../../src/presentation/organization-authority-http-server.js';
import { createPersonToolsHttpApplicationV4 } from '../../src/presentation/person-tools-http-application.js';
import { authorityHttpServerOptions } from '../fixtures/authority-http-server.js';

const authorization: PersonAccessAuthorization = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_type: 'employee', identity_binding_id: 'identity', session_family_id: 'session',
  access_credential_sha256: canonicalSha256({ access: 1 }), person_state_sha256: canonicalSha256({ person: 1 }), session_state_sha256: canonicalSha256({ session: 1 }),
  access_expires_at: '2026-09-12T12:00:00Z', hard_reauthentication_at: '2026-09-13T12:00:00Z', checked_at: '2026-09-12T11:00:00Z',
};
const request = { route_id: 'person-tools-v4', method: 'GET' as const, path: '/v4/person/tools', raw_body: new Uint8Array(), content_type: undefined, headers: { authorization: 'Bearer test-session' } };
const tool = (tool_id: string, organization_setup: OrganizationToolSetupStatusV4 | null = null): OrganizationPersonToolV4 => ({
  tool_id, display_name: tool_id, availability: 'enabled', personal_status: 'linked', external_scope_id: 'tenant@example', external_subject_id: 'subject@example', organization_setup,
});

describe('Person tools status authorization', () => {
  it('refuses unauthenticated reads before calling tools and account/session drift after awaiting them', async () => {
    const tools = vi.fn(async () => [tool('calendar')]);
    const api = createPersonToolsHttpApplicationV4({ authenticate: () => authorization, tools });
    await expect(api.accept({ ...request, headers: {} })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(tools).not.toHaveBeenCalled();
    for (const change of [{ membership_id: 'different' }, { principal_id: 'different' }, { session_state_sha256: canonicalSha256({ changed: 1 }) }]) {
      let calls = 0;
      const route = createPersonToolsHttpApplicationV4({ authenticate: () => ++calls === 1 ? authorization : { ...authorization, ...change }, tools });
      await expect(route.accept(request)).rejects.toMatchObject({ code: 'unauthorized' });
    }
    const duplicate = createPersonToolsHttpApplicationV4({ authenticate: () => authorization, tools: async () => [tool('calendar'), tool('calendar')] });
    await expect(duplicate.accept(request)).rejects.toThrow();
  });
  it('carries the organization setup status through untouched', async () => {
    const api = createPersonToolsHttpApplicationV4({ authenticate: () => authorization, tools: async () => [tool('slack', 'connected')] });
    expect(api.routes).toEqual([{ route_id: 'person-tools-v4', method: 'GET', path: '/v4/person/tools' }]);
    expect(await api.accept(request)).toMatchObject({
      status: 200, body: { schema_version: 4, tools: [tool('slack', 'connected')] },
    });
  });
  it('keeps the retired V2 and V3 lists reserved, so no provider can mount one (ADR-0048)', () => {
    for (const path of ['/v2/person/tools', '/v3/person/tools', '/v3/person/tools/slack']) {
      const application = { routes: [{ route_id: 'collision', method: 'GET' as const, path }], accept: async () => ({ status: 200 as const, body: {} }) };
      for (const ingress of [{ person_tools: application }, { person_external_identity_link: application }, { person_tool_connections: [application] }]) {
        expect(() => createOrganizationAuthorityHttpServer(authorityHttpServerOptions(ingress))).toThrow('collides with Authority route');
      }
    }
  });
});
