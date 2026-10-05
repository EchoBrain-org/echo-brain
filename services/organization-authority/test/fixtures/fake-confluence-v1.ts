import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { ConfluenceNangoV1 } from '@echo-brain/provider-confluence/confluence-nango-v1';
import { vi } from 'vitest';

export const FIXTURE_CONFLUENCE_CLOUD_V1 = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_CONFLUENCE_SITE_V1 = 'https://echo-fixture.atlassian.net';
const ACCESS_TOKEN = 'synthetic-confluence-oauth-bearer';

/** A consent completes only when the fixture explicitly records its connection. */
export function fakeConfluenceNangoV1() {
  let tags: Readonly<Record<string, string>> = {};
  let pending = '';
  let attempts = 0;
  const connections = new Map<string, { readonly tags: Readonly<Record<string, string>>; readonly access_token: string }>();
  const nango: ConfluenceNangoV1 = {
    connect: vi.fn(async value => { tags = value; pending = `fixture-confluence-${++attempts}`; return { link: 'https://connect.nango.dev/fixture-confluence' }; }),
    connection: vi.fn(async reference => {
      const connection = connections.get(reference);
      if (connection === undefined) throw new AuthorityOperationError('not_found', 'fixture Confluence connection is absent');
      return connection;
    }),
    find: vi.fn(async value => [...connections].find(([, connection]) => canonicalSha256(value) === canonicalSha256(connection.tags))?.[0]),
    disconnect: vi.fn(async reference => { connections.delete(reference); }),
  };
  return { nango, tags: () => tags, finish: () => { connections.set(pending, { tags, access_token: ACCESS_TOKEN }); } };
}

/** Fake Cloud responses for a single space and an HTML-backed page. */
export function fakeConfluenceCloudFetchV1() {
  const page = {
    id: '100', spaceId: '123', title: 'ECHO MRD', status: 'current', version: { number: 7 },
    _links: { base: FIXTURE_CONFLUENCE_SITE_V1, webui: '/wiki/spaces/ECHO/pages/100/ECHO+MRD' },
    body: { storage: { value: '<h1>ECHO MRD</h1><p>The release decision is to start EVT after PRD approval.</p>' } },
  };
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth/token/accessible-resources') return Response.json([{ id: FIXTURE_CONFLUENCE_CLOUD_V1, url: FIXTURE_CONFLUENCE_SITE_V1, scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'] }]);
    if (url.pathname.endsWith('/rest/api/user/current')) return Response.json({ accountId: 'fixture-confluence-account', type: 'known', accountType: 'atlassian' });
    if (url.pathname.endsWith('/api/v2/spaces/123')) return Response.json({ id: '123', key: 'ECHO', name: 'ECHO' });
    if (url.pathname.endsWith('/api/v2/pages')) return Response.json({ results: [page], _links: {} });
    if (url.pathname.endsWith('/api/v2/pages/100')) return Response.json(page);
    if (url.pathname.endsWith('/rest/api/search')) return Response.json({ results: [{ content: page }], _links: {} });
    throw new Error(`unexpected Confluence endpoint ${url.pathname}`);
  });
}
