import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { ConfluenceConnectionStoreV1 } from '@echo-brain/provider-confluence/confluence-connection-store-v1';
import { ConfluenceProjectMappingStoreV1 } from '@echo-brain/provider-confluence/confluence-project-mapping-store-v1';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import { JiraProjectMappingStoreV1 } from '@echo-brain/provider-jira/jira-project-mapping-store-v1';
import type { PersonContextProjectAuthorizationV1, PersonContextProjectNamesV1, PersonLiveConnectorDefinitionV1 } from '../src/application/ports/person-context-live-runtime-v1.js';
import { confluencePersonLiveConnectorsV1, openConfluencePersonLiveRuntimeV1 } from '../src/composition/confluence-person-live-runtime-v1.js';
import { jiraPersonLiveConnectorsV1, openJiraPersonLiveRuntimeV1 } from '../src/composition/jira-person-live-runtime-v1.js';
import { personLiveConnectorDefinitionsV1 } from '../src/composition/person-live-connector-registry-v1.js';

const CLOUD = '00000000-0000-4000-8000-000000000007';
const SITE = 'https://echo-fixture.atlassian.net';
const ECHO_PROJECT = 'prj_00000000-0000-4000-8000-000000000010';
const person = { organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_fixture', membership_id: 'mem_00000000-0000-4000-8000-000000000001' };
const sessions = { authenticateAccess: ({ access_token }: { readonly access_token: string }): PersonAccessAuthorization => {
  if (access_token !== 'session') throw new Error('Unknown fixture session');
  return { ...person, membership_type: 'owner', identity_binding_id: 'idb_fixture', session_family_id: 'sfm_fixture', access_credential_sha256: canonicalSha256({ access_token }),
    access_expires_at: '2099-01-01T00:00:00.000Z', hard_reauthentication_at: '2099-01-01T00:00:00.000Z', person_state_sha256: canonicalSha256({ person: 1 }),
    session_state_sha256: canonicalSha256({ session: 1 }), checked_at: '2026-10-19T00:00:00.000Z' } as PersonAccessAuthorization;
} };
const authorize: PersonContextProjectAuthorizationV1 = (_token, project_id) => {
  if (project_id !== ECHO_PROJECT) throw new Error('Fixture project is unknown');
  return { role: 'member', authorization_sha256: canonicalSha256({ project_id }) };
};
const names: PersonContextProjectNamesV1 = (_token, project_ids) => new Map(project_ids.map(id => [id, 'Launchscope']));
const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1) => canonicalSha256(release)) };
const configuration = { enabled: true as const, cloud_id: CLOUD, integration_id: 'fixture', nango_authorization: () => 'synthetic-nango-key-0000000000000000' };

/** A person already connected to the tool, with one ECHO project mapped, in a store the runtime shares. */
function connected(store: JiraConnectionStoreV1 | ConfluenceConnectionStoreV1) {
  const attempt = store.begin(person).attempt;
  store.complete(person, attempt, 'fixture-reference', CLOUD, 'fixture-account', SITE);
  const tags = { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: attempt };
  const unused = async () => { throw new Error('unused'); };
  return { connect: vi.fn(unused), find: vi.fn(unused), disconnect: vi.fn(unused), connection: vi.fn(async () => ({ tags, access_token: 'synthetic-oauth-bearer' })) };
}
/** Counts how often the shared runtime opens and closes. */
function counted<R extends { close(): void }>(open: () => R) {
  const counts = { opened: 0, closed: 0 };
  return { counts, open: () => { counts.opened += 1; const runtime = open(); return { ...runtime, close: () => { counts.closed += 1; runtime.close(); } }; } };
}
async function containersOf(definitions: readonly PersonLiveConnectorDefinitionV1[], counts: { readonly opened: number; readonly closed: number }) {
  const registered = personLiveConnectorDefinitionsV1({ live_connectors: definitions });
  const [items, containers] = registered.map(definition => definition.open(sessions, authorize, names));
  expect(counts.opened).toBe(1);
  // The tool, its connection routes and its owner accounts are the item connector's alone, so each is listed once.
  expect(Object.keys(containers!).sort()).toEqual(['application', 'close']);
  expect(items).toHaveProperty('connection_http');
  const source = await containers!.application.source({ access_token: 'session', audit });
  const listed = (await source!.list({})).items.map(item => [item.kind, item.label, item.text]);
  items!.close();
  expect(counts.closed).toBe(0);
  containers!.close(); containers!.close();
  expect(counts.closed).toBe(1);
  return { registered, listed };
}

describe('tool container connectors share their tool\'s runtime (research tool contract v1)', () => {
  it.each([
    { tool: 'Jira', items: 'issues', containers: 'projects', scopes: ['read:jira-work', 'read:jira-user'],
      routes: { '/myself': { accountId: 'fixture-account', active: true, accountType: 'atlassian' },
        '/project/search': { isLast: true, values: [{ id: '10000', key: 'ECHO', name: 'Echo Platform', self: `${SITE}/rest/api/3/project/10000` }] } },
      registered: [['jira', 'ticket'], ['jira_projects', 'tool_container']], listed: [['tool_container', 'Echo Platform', 'Jira project ECHO: Echo Platform\nECHO projects: Launchscope']],
      connectors(database: Database.Database, fetch: typeof globalThis.fetch) {
        const nango = connected(new JiraConnectionStoreV1(database));
        new JiraProjectMappingStoreV1(database).set(person.organization_id, ECHO_PROJECT, null, canonicalSha256({ command: 1 }), { cloud_id: CLOUD, project_id: '10000', project_key: 'ECHO' });
        const runtime = counted(() => openJiraPersonLiveRuntimeV1({ state_directory: '/never-used', sessions, configuration, seams: { database, nango, fetch }, authorize_project: authorize, project_names: names }));
        return { counts: runtime.counts, definitions: jiraPersonLiveConnectorsV1(() => runtime.open()) };
      } },
    { tool: 'Confluence', items: 'pages', containers: 'spaces', scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'],
      routes: { '/rest/api/user/current': { accountId: 'fixture-account', type: 'known', accountType: 'atlassian' },
        '/api/v2/spaces': { results: [{ id: '42', key: 'ENG', name: 'Engineering' }], _links: {} } },
      registered: [['confluence', 'page'], ['confluence_spaces', 'tool_container']], listed: [['tool_container', 'Engineering', 'Confluence space ENG: Engineering\nECHO projects: Launchscope']],
      connectors(database: Database.Database, fetch: typeof globalThis.fetch) {
        const nango = connected(new ConfluenceConnectionStoreV1(database));
        new ConfluenceProjectMappingStoreV1(database).set(person.organization_id, ECHO_PROJECT, null, canonicalSha256({ command: 1 }), { cloud_id: CLOUD, space_ids: ['42'] });
        const runtime = counted(() => openConfluencePersonLiveRuntimeV1({ state_directory: '/never-used', sessions, configuration, seams: { database, nango, fetch }, authorize_project: authorize, project_names: names }));
        return { counts: runtime.counts, definitions: confluencePersonLiveConnectorsV1(() => runtime.open()) };
      } },
  ])('registers $tool $items and $containers over one runtime that closes when both have closed', async tool => {
    const database = new Database(':memory:');
    try {
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === '/oauth/token/accessible-resources') return Response.json([{ id: CLOUD, url: SITE, scopes: tool.scopes }]);
        const route = Object.entries(tool.routes).find(([suffix]) => path.endsWith(suffix));
        if (route === undefined) throw new Error(`Unexpected ${tool.tool} endpoint ${path}`);
        return Response.json(route[1]);
      });
      const { counts, definitions } = tool.connectors(database, fetch as typeof globalThis.fetch);
      const { registered, listed } = await containersOf(definitions, counts);
      expect(registered.map(definition => [definition.descriptor.source_id, definition.descriptor.kind])).toEqual(tool.registered);
      expect(listed).toEqual(tool.listed);
    } finally { database.close(); }
  });

  it('refuses to share a runtime with a registration opened under other authority', () => {
    const runtime = counted(() => ({ application: { source: async () => undefined }, connection_http: undefined, owners: undefined, tools: async () => [], close() {} }) as never);
    const [items, containers] = jiraPersonLiveConnectorsV1(() => runtime.open());
    items!.open(sessions, authorize, names);
    expect(() => containers!.open({ authenticateAccess: sessions.authenticateAccess }, authorize, names)).toThrow('Live connectors sharing a runtime must open with the same authority');
    expect(() => containers!.open(sessions, authorize, undefined)).toThrow('Live connectors sharing a runtime must open with the same authority');
    expect(runtime.counts.opened).toBe(1);
  });
});
