import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createJiraPersonConnectionV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import type { JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import { SqliteContextCaptureStoreV1 } from '../src/adapters/persistence/sqlite/context-capture-store-v1.js';
import type { ContextIntakeAuthorityV1 } from '../src/application/context-intake-v1.js';
import { createJiraContextIntakeV1 } from '../src/composition/provider-context-intakes-v1.js';

const cloud = '22222222-2222-4222-8222-222222222222';
const organization = 'org_connected_capture';
const person = { organization_id: organization, principal_id: 'person_connected_capture', membership_id: 'membership_connected_capture' };
const site = 'https://capture-connected.atlassian.net';
const api = `/ex/jira/${cloud}/rest/api/3`;

function json(value: unknown): Response { return Response.json(value); }
function issue() {
  return {
    id: '10001', key: 'ECHO-1', self: `${site}/rest/api/3/issue/10001`,
    fields: {
      summary: 'Capture through a current Jira grant', project: { id: '10000', key: 'ECHO', self: `${site}/rest/api/3/project/10000` },
      created: '2026-10-01T00:00:00.000+0000', updated: '2026-10-02T12:34:56.000+0000', status: { name: 'Open' },
      assignee: null, duedate: null, labels: ['capture'], priority: { name: 'High' },
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The shared request-only intake received this ticket.' }] }] },
    },
  };
}

function fixture() {
  const database = new Database(':memory:'); const store = new JiraConnectionStoreV1(database);
  let active = true; let pendingTags: Readonly<Record<string, string>> = {}; let sequence = 0;
  const connections = new Map<string, { readonly tags: Readonly<Record<string, string>>; readonly access_token: string }>();
  const finishConsent = () => { const reference = `capture-reference-${sequence}`; connections.set(reference, { tags: pendingTags, access_token: 'synthetic-capture-oauth' }); return reference; };
  const nango: JiraNangoV1 = {
    connect: vi.fn(async tags => { pendingTags = tags; sequence += 1; return { link: 'https://connect.nango.dev/capture-fixture' }; }),
    connection: vi.fn(async reference => {
      const connection = connections.get(reference);
      if (connection === undefined) throw new AuthorityOperationError('not_found', 'fixture connection absent');
      return connection;
    }),
    find: vi.fn(async tags => [...connections].find(([, connection]) => canonicalSha256(connection.tags) === canonicalSha256(tags))?.[0]),
    disconnect: vi.fn(async reference => { connections.delete(reference); }),
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-capture-oauth');
    if (url.pathname === '/oauth/token/accessible-resources') return json([{ id: cloud, url: site, scopes: ['read:jira-work', 'read:jira-user'] }]);
    if (url.pathname === `${api}/myself`) return json({ accountId: 'capture-account', active: true, accountType: 'atlassian' });
    if (url.pathname === `${api}/project/ECHO`) return json(issue().fields.project);
    if (url.pathname === `${api}/search/jql`) return json({ isLast: true, issues: [{ id: '10001' }] });
    if (url.pathname === `${api}/issue/10001`) return json(issue());
    throw new Error(`unexpected Jira path ${url.pathname}`);
  });
  const service = createJiraPersonConnectionV1({
    store, nango, cloud_id: cloud, fetch: fetch as typeof globalThis.fetch,
    authenticate(token) {
      if (!active || token !== 'person-token') throw new AuthorityOperationError('unauthorized', 'fixture person revoked');
      return { ...person, authorization_sha256: canonicalSha256({ token }) };
    },
  });
  async function connect() {
    const begun = await service.connect({ access_token: 'person-token' }); finishConsent();
    await expect(service.status({ access_token: 'person-token', attempt: begun.attempt })).resolves.toMatchObject({ status: 'complete' });
  }
  function intake(capability: Awaited<ReturnType<typeof service.captureConnection>>) {
    const authority: ContextIntakeAuthorityV1 = {
      select: () => ({ disposition: 'request_only', scope: { organization_id: organization, custody_ref: `organization:${organization}`, access_policy_ref: 'capture-fixture', analysis_policy: 'on_request' }, permitted_representations: ['excerpt'] }),
      requireCurrent: () => capability.require_current(),
    };
    return createJiraContextIntakeV1({
      transport: capability.transport, project: 'ECHO', representation: 'excerpt',
      source_instance_id: `jira-cloud:${cloud}:project:ECHO`, organization_id: organization, authority,
      require_read_current: () => capability.require_current(), now: () => new Date('2026-10-03T00:00:00.000Z'),
    });
  }
  return { database, store, service, nango, fetch, finishConsent, connect, intake };
}

it('runs capture through an actually connected Jira grant, keeps it request-only, and revokes handed-off captures on reconnect or disconnect', async () => {
  const f = fixture();
  try {
    const admit = vi.spyOn(SqliteContextCaptureStoreV1.prototype, 'admitSourceRevision');
    await f.connect();
    const first = await f.service.captureConnection({ access_token: 'person-token' });
    const firstIntake = f.intake(first);
    await expect(firstIntake.pull()).resolves.toMatchObject({ captures: [{ admission: 'request_only', source: { content: { source_type: 'ticket' } } }] });
    expect(admit).not.toHaveBeenCalled();
    for (const table of ['authority_sources_v1', 'authority_source_revisions_v1', 'authority_source_contents_v1', 'authority_source_representations_v1']) {
      expect(f.database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)).toBeUndefined();
    }

    const reconnect = await f.service.connect({ access_token: 'person-token' }); // Fresh attempt immediately invalidates the first grant.
    const afterReconnect = f.fetch.mock.calls.length;
    await expect(firstIntake.pull()).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.fetch).toHaveBeenCalledTimes(afterReconnect);
    expect(admit).not.toHaveBeenCalled();

    // Finish that fresh connection and prove its own handoff is then revoked by disconnect.
    f.finishConsent();
    await expect(f.service.status({ access_token: 'person-token', attempt: reconnect.attempt })).resolves.toMatchObject({ status: 'complete' });
    const second = await f.service.captureConnection({ access_token: 'person-token' });
    const secondIntake = f.intake(second);
    await f.service.disconnect({ access_token: 'person-token' });
    const afterDisconnect = f.fetch.mock.calls.length;
    await expect(secondIntake.pull()).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.fetch).toHaveBeenCalledTimes(afterDisconnect);
    expect(admit).not.toHaveBeenCalled();
  } finally { f.database.close(); }
});
