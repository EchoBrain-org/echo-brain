import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { OrganizationPersonToolV3 } from '@echo-brain/organization-api';
import { composePersonExternalIdentityRuntimeBundlesV1, type PersonExternalIdentityRuntimeBundleV1 } from '@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { createPersonToolsHttpApplicationV3 } from '../../src/presentation/person-tools-http-application-v3.js';

const authorization: PersonAccessAuthorization = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_type: 'employee', identity_binding_id: 'identity', session_family_id: 'session',
  access_credential_sha256: canonicalSha256({ access: 1 }), person_state_sha256: canonicalSha256({ person: 1 }), session_state_sha256: canonicalSha256({ session: 1 }),
  access_expires_at: '2026-09-12T12:00:00Z', hard_reauthentication_at: '2026-09-13T12:00:00Z', checked_at: '2026-09-12T11:00:00Z',
};
const request = { route_id: 'person-tools-v3', method: 'GET' as const, path: '/v3/person/tools', raw_body: new Uint8Array(), content_type: undefined, headers: { authorization: 'Bearer test-session' } };
const tool = (tool_id: string): OrganizationPersonToolV3 => ({ tool_id, display_name: tool_id, availability: 'enabled', personal_status: 'linked', external_scope_id: 'tenant@example', external_subject_id: 'subject@example' });
const runtimeInput = { state_directory: 'unused', authority_id: 'unused', organization_id: authorization.organization_id, state_lineage_id: 'unused', authentication: { authenticateAccess: () => authorization }, membership_type: () => 'employee' as const };
function fragment(name: string, close: () => void = () => {}): PersonExternalIdentityRuntimeBundleV1 {
  return { open: () => ({ application: { routes: [{ route_id: 'status', method: 'GET', path: `/v3/tools/${name}` }], accept: async request => ({ status: 200, body: { name, route: request.route_id } }) }, tools: async token => { expect(token).toBe('test-session'); return [tool(name)]; }, close }) };
}

describe('Person identity fragment composition and status authorization', () => {
  it('serves two independently owned tools, dispatches original route IDs and closes once in reverse order', async () => {
    const closed: string[] = [];
    const selected = [fragment('calendar', () => closed.push('calendar')), fragment('mail', () => closed.push('mail'))];
    const bundle = composePersonExternalIdentityRuntimeBundlesV1(selected);
    selected.splice(0);
    const runtime = bundle.open(runtimeInput);
    const authenticate = vi.fn(() => authorization);
    const api = createPersonToolsHttpApplicationV3({ authenticate, tools: token => runtime.tools(token) });
    expect(await api.accept(request)).toMatchObject({ status: 200, body: { schema_version: 3, tools: [tool('calendar'), tool('mail')] } });
    expect(authenticate.mock.calls).toHaveLength(2);
    for (const route of runtime.application.routes) {
      expect(await runtime.application.accept({ ...request, ...route })).toMatchObject({ body: { route: 'status' } });
    }
    runtime.close(); runtime.close();
    expect(closed).toEqual(['mail', 'calendar']);
  });
  it('refuses unauthenticated reads before calling fragments and account/session drift after awaiting them', async () => {
    const tools = vi.fn(async () => [tool('calendar')]);
    const api = createPersonToolsHttpApplicationV3({ authenticate: () => authorization, tools });
    await expect(api.accept({ ...request, headers: {} })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(tools).not.toHaveBeenCalled();
    for (const change of [{ membership_id: 'different' }, { principal_id: 'different' }, { session_state_sha256: canonicalSha256({ changed: 1 }) }]) {
      let calls = 0;
      const route = createPersonToolsHttpApplicationV3({ authenticate: () => ++calls === 1 ? authorization : { ...authorization, ...change }, tools });
      await expect(route.accept(request)).rejects.toMatchObject({ code: 'unauthorized' });
    }
    const duplicate = createPersonToolsHttpApplicationV3({ authenticate: () => authorization, tools: async () => [tool('calendar'), tool('calendar')] });
    await expect(duplicate.accept(request)).rejects.toThrow();
  });
  it('rejects route collisions and closes all acquired fragments even when one close fails', () => {
    const closed: string[] = [];
    const bad = () => { closed.push('bad'); throw new Error('close failed'); };
    expect(() => composePersonExternalIdentityRuntimeBundlesV1([fragment('same', () => closed.push('first')), fragment('same', bad)]).open(runtimeInput)).toThrow('same HTTP route');
    expect(closed).toEqual(['bad', 'first']);
  });
});
