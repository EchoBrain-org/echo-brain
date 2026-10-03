import { expect, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';

export const FIXTURE_JIRA_CLOUD_V1 = '00000000-0000-4000-8000-000000000007';
export const FIXTURE_JIRA_SITE_V1 = 'https://echo-fixture.atlassian.net';
const ACCESS_TOKEN = 'synthetic-jira-oauth-bearer';

/** Tag-matching Nango fake. A consent completes only when the test calls finish(). */
export function fakeJiraNangoV1() {
  let tags: Readonly<Record<string, string>> = {};
  let pending = '';
  let attempts = 0;
  const connections = new Map<string, { readonly tags: Readonly<Record<string, string>>; readonly access_token: string }>();
  const nango: JiraNangoV1 = {
    connect: vi.fn(async value => { tags = value; pending = `fixture-jira-${++attempts}`; return { link: 'https://connect.nango.dev/fixture-jira' }; }),
    connection: vi.fn(async reference => {
      const connection = connections.get(reference);
      if (connection === undefined) throw new AuthorityOperationError('not_found', 'fixture Jira connection is absent');
      return connection;
    }),
    find: vi.fn(async value => [...connections].find(([, connection]) => canonicalSha256(value) === canonicalSha256(connection.tags))?.[0]),
    disconnect: vi.fn(async reference => { connections.delete(reference); }),
  };
  return { nango, tags: () => tags, finish: () => { connections.set(pending, { tags, access_token: ACCESS_TOKEN }); } };
}

/** Fake Jira Cloud for one ECHO issue. Every call must carry the Nango bearer and refuse redirects. */
export function fakeJiraCloudFetchV1() {
  const site = FIXTURE_JIRA_SITE_V1;
  const project = { id: '10000', key: 'ECHO', self: `${site}/rest/api/3/project/10000` };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    if (url.pathname === '/oauth/token/accessible-resources') return Response.json([{ id: FIXTURE_JIRA_CLOUD_V1, url: site, scopes: ['read:jira-work', 'read:jira-user'] }]);
    if (url.pathname.endsWith('/myself')) return Response.json({ accountId: 'fixture-jira-account', active: true, accountType: 'atlassian' });
    if (url.pathname.endsWith('/project/ECHO')) return Response.json(project);
    if (url.pathname.endsWith('/search/jql')) return Response.json({ isLast: true, issues: [{ id: '10001' }] });
    if (url.pathname.endsWith('/issue/10001')) return Response.json({ id: '10001', key: 'ECHO-1', self: `${site}/rest/api/3/issue/10001`, fields: { summary: 'Ship on Friday', project, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The ticket body stays with Jira.' }] }] }, created: '2026-10-01T12:00:00.000Z', updated: '2026-10-02T03:04:05.000-0700', status: { name: 'Open' }, assignee: { displayName: 'Fixture Owner', accountId: 'fixture-jira-account' }, duedate: null, labels: ['fixture'], priority: { name: 'High' } } });
    throw new Error(`unexpected Jira endpoint ${url.pathname}`);
  });
}
