import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import type { JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import { openJiraPersonLiveRuntimeV1 } from '../src/composition/jira-person-live-runtime-v1.js';
import { authorization } from './fixtures/project-context-sqlite.js';
import { FIXTURE_JIRA_CLOUD_V1, FIXTURE_JIRA_SITE_V1 } from './fixtures/fake-jira-v1.js';

type Person = { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string };
const ARI: Person = { organization_id: 'org_fixture', principal_id: 'prn_ari', membership_id: 'mem_ari' };
const MINA: Person = { organization_id: 'org_fixture', principal_id: 'prn_mina', membership_id: 'mem_mina' };
const OTHER_CLOUD = '00000000-0000-4000-8000-000000000008';
const BEARER = 'synthetic-jira-oauth-bearer';
const BULK_PATH = `/ex/jira/${FIXTURE_JIRA_CLOUD_V1}/rest/api/3/issue/bulkfetch`;

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** The real Jira runtime over an in-memory connection store, a fake Nango and a fake Jira Cloud. Ari is the caller. */
async function jiraRuntimeFixture(options: { readonly bulk: unknown | ((ids: readonly string[]) => Response | unknown) }) {
  const database = new Database(':memory:');
  const store = new JiraConnectionStoreV1(database);
  const references = new Map<string, Readonly<Record<string, string>>>();
  const connect = (person: Person, account: string, cloud = FIXTURE_JIRA_CLOUD_V1) => {
    const begun = store.begin(person);
    const reference = `nango-${person.principal_id}`;
    store.complete(person, begun.attempt, reference, cloud, account, FIXTURE_JIRA_SITE_V1);
    references.set(reference, { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: begun.attempt });
  };
  connect(ARI, 'acct-ari');
  const unused = async () => { throw new Error('unused'); };
  const nango: JiraNangoV1 = { connect: vi.fn(unused), find: vi.fn(unused), disconnect: vi.fn(unused),
    connection: vi.fn(async reference => {
      const tags = references.get(reference);
      if (tags === undefined) throw new AuthorityOperationError('not_found', 'fixture Jira connection is absent');
      return { tags, access_token: BEARER };
    }) };
  const requests: { readonly path: string; readonly method: string; readonly body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${BEARER}`);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { issueIdsOrKeys: string[] };
    requests.push({ path: url.pathname, method: init?.method ?? 'GET', body });
    if (url.pathname !== BULK_PATH) throw new Error(`unexpected Jira endpoint ${url.pathname}`);
    const reply = typeof options.bulk === 'function' ? (options.bulk as (ids: readonly string[]) => unknown)(body!.issueIdsOrKeys) : options.bulk;
    return reply instanceof Response ? reply : Response.json(reply);
  });
  const runtime = openJiraPersonLiveRuntimeV1({
    state_directory: '/nonexistent-jira-owner-fixture',
    sessions: { authenticateAccess: ({ access_token }) => {
      if (access_token !== 'synthetic-echo-access') throw new AuthorityOperationError('unauthorized', 'fixture session is unknown');
      return authorization({ ...ARI, membership_type: 'employee' });
    } },
    configuration: { enabled: true, cloud_id: FIXTURE_JIRA_CLOUD_V1, integration_id: 'jira', nango_authorization: () => 'synthetic-only-nango-authorization' },
    seams: { database, nango, fetch: fetch as typeof globalThis.fetch },
  });
  cleanups.push(() => { runtime.close(); database.close(); });
  return { runtime, token: 'synthetic-echo-access', requests, connect, store };
}

describe('Jira owner accounts', () => {
  it('reads assignees in one bulk call with the person connection and maps accounts to people', async () => {
    const f = await jiraRuntimeFixture({ bulk: { issues: [{ id: '10046', fields: { assignee: { accountId: 'acct-mina', displayName: 'Mina Patel' } } }, { id: '10047', fields: { assignee: null } }] } });
    expect(await f.runtime.owners.assignees({ access_token: f.token, ticket_ids: ['10046', '10047'] })).toEqual(new Map([['10046', 'acct-mina']]));
    expect(f.requests.filter(r => r.path.endsWith('/issue/bulkfetch'))).toHaveLength(1);
    f.connect(MINA, 'acct-mina');
    expect(f.runtime.owners.people('acct-mina')).toEqual([MINA]);
  });

  it('asks only for the assignee field, at most 100 valid ticket ids per call, and ignores issue errors', async () => {
    const f = await jiraRuntimeFixture({ bulk: (ids: readonly string[]) => ({
      issues: ids.filter(id => id !== '10002').map(id => ({ id, fields: { assignee: { accountId: `acct-${id}` } } })),
      issueErrors: [{ issueIdsOrKeys: ['10002'], status: 404, elementErrors: { errorMessages: ['hidden'] } }],
    }) });
    const ids = Array.from({ length: 150 }, (_, index) => String(10_001 + index));
    const result = await f.runtime.owners.assignees({ access_token: f.token, ticket_ids: [...ids, '10001', 'ECHO-12', ''] });
    expect(f.requests).toEqual([
      { path: BULK_PATH, method: 'POST', body: { issueIdsOrKeys: ids.slice(0, 100), fields: ['assignee'] } },
      { path: BULK_PATH, method: 'POST', body: { issueIdsOrKeys: ids.slice(100), fields: ['assignee'] } },
    ]);
    expect(result.size).toBe(149);
    expect(result.get('10001')).toBe('acct-10001');
    expect(result.has('10002')).toBe(false);
  });

  it('returns an empty map for a failed read', async () => {
    const issue = (accountId: unknown) => ({ issues: [{ id: '10046', fields: { assignee: { accountId } } }] });
    for (const bulk of [
      new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
      new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }),
      issue('acct mina'),
      issue('a'.repeat(129)),
      { issues: [{ id: '99999', fields: { assignee: { accountId: 'acct-mina' } } }] },
      { issueErrors: [] },
    ]) {
      const f = await jiraRuntimeFixture({ bulk: () => bulk });
      expect(await f.runtime.owners.assignees({ access_token: f.token, ticket_ids: ['10046'] })).toEqual(new Map());
      expect(f.requests).toHaveLength(1);
    }
    const f = await jiraRuntimeFixture({ bulk: issue('acct-mina') });
    // An unknown session or a person with no Jira connection reads nothing.
    expect(await f.runtime.owners.assignees({ access_token: 'synthetic-unknown', ticket_ids: ['10046'] })).toEqual(new Map());
    f.store.revoke(ARI);
    expect(await f.runtime.owners.assignees({ access_token: f.token, ticket_ids: ['10046'] })).toEqual(new Map());
    expect(f.requests).toEqual([]);
  });

  it('maps an account to people on this site only', async () => {
    const f = await jiraRuntimeFixture({ bulk: { issues: [] } });
    const rafael = { organization_id: 'org_fixture', principal_id: 'prn_rafael', membership_id: 'mem_rafael' };
    f.connect(rafael, 'acct-rafael', OTHER_CLOUD);
    expect(f.runtime.owners.cloud_id).toBe(FIXTURE_JIRA_CLOUD_V1);
    expect(f.runtime.owners.people('acct-rafael')).toEqual([]);
    expect(f.runtime.owners.people('acct-ari')).toEqual([ARI]);
  });
});
