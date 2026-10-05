import Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { expect, it, vi } from 'vitest';
import { ConfluenceConnectionStoreV1 } from '../src/confluence-connection-store-v1.js';
import { createConfluencePersonConnectionV1 } from '../src/confluence-person-connection-v1.js';
import type { ConfluenceNangoV1 } from '../src/confluence-nango-v1.js';

const cloud = '00000000-0000-4000-8000-000000000007';
const person = { organization_id: 'org-fixture', principal_id: 'person-fixture', membership_id: 'member-fixture' };
const other = { organization_id: 'org-fixture', principal_id: 'other-fixture', membership_id: 'other-member' };
const site = 'https://fixture.atlassian.net';
function fixture(next = `https://api.atlassian.com/ex/confluence/${cloud}/wiki/api/v2/spaces?limit=20&cursor=next-page`) {
  const db = new Database(':memory:');
  const store = new ConfluenceConnectionStoreV1(db);
  const begun = store.begin(person);
  const stored = store.complete(person, begun.attempt, 'confluence-reference', cloud, 'account-fixture', site);
  const secondAttempt = store.begin(other);
  store.complete(other, secondAttempt.attempt, 'confluence-reference-two', cloud, 'account-other', site);
  const tags = { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: begun.attempt };
  const nango: ConfluenceNangoV1 = {
    connect: vi.fn(async () => ({ link: 'https://connect.nango.dev/fixture' })),
    find: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    connection: vi.fn(async () => ({ tags, access_token: 'synthetic-confluence-token' })),
  };
  const requests: URL[] = [];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const request = new URL(String(url)); requests.push(request);
    const body = request.pathname === '/oauth/token/accessible-resources'
      ? [{ id: cloud, url: site, scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'] }]
      : request.pathname.endsWith('/rest/api/user/current')
        ? { accountId: 'account-fixture', type: 'known', accountType: 'atlassian' }
        : request.searchParams.get('cursor') === 'next-page'
          ? { results: [{ id: '200', key: '~personal', name: 'Personal space' }], _links: {} }
          : { results: [{ id: '100', key: 'ECHO', name: 'ECHO product' }], _links: { next } };
    return Response.json(body);
  });
  const service = createConfluencePersonConnectionV1({ store, nango, cloud_id: cloud, fetch: fetch as typeof globalThis.fetch, authenticate: token => ({ ...(token === 'session-two' ? other : person), authorization_sha256: canonicalSha256({ token }) }) });
  return { db, service, requests, stored };
}

it.each([
  `https://api.atlassian.com/ex/confluence/${cloud}/wiki/api/v2/spaces?limit=20&cursor=next-page`,
  '/wiki/api/v2/spaces?cursor=next-page&limit=20',
  '/api/v2/spaces?cursor=next-page&limit=250&status=archived',
])('extracts only the opaque cursor from a pinned spaces next link: %s', async next => {
  const f = fixture(next);
  try {
    const first = await f.service.spacesList({ access_token: 'session-one' });
    expect(first).toMatchObject({ items: [{ id: '100', key: 'ECHO' }] });
    expect(first.next_cursor).toMatch(/^confluence_spaces_/);
    const second = await f.service.spacesList({ access_token: 'session-one', cursor: first.next_cursor! });
    expect(second).toMatchObject({ items: [{ id: '200', key: '~personal' }], next_cursor: null });
    expect(f.requests.some(request => request.pathname.endsWith('/api/v2/spaces') && request.searchParams.get('cursor') === 'next-page')).toBe(true);
    const continued = f.requests.find(request => request.searchParams.get('cursor') === 'next-page')!;
    expect(continued.pathname).toBe(`/ex/confluence/${cloud}/wiki/api/v2/spaces`);
    expect(continued.searchParams.get('limit')).toBe('20');
    expect(continued.searchParams.has('status')).toBe(false);
  } finally { f.db.close(); }
});

it.each([
  'https://untrusted.example/wiki/api/v2/spaces?cursor=next-page',
  'https://api.atlassian.com/ex/confluence/00000000-0000-4000-8000-000000000008/wiki/api/v2/spaces?cursor=next-page',
  '/wiki/api/v2/pages?cursor=next-page',
  '/wiki/api/v2/spaces?cursor=one&cursor=two',
])('rejects a next link outside the exact spaces resource: %s', async next => {
  const f = fixture(next);
  try { await expect(f.service.spacesList({ access_token: 'session-one' })).rejects.toMatchObject({ code: 'invalid_output' }); }
  finally { f.db.close(); }
});

it('does not accept a picker cursor for another authenticated person', async () => {
  const f = fixture();
  try {
    const first = await f.service.spacesList({ access_token: 'session-one' });
    await expect(f.service.spacesList({ access_token: 'session-two', cursor: first.next_cursor! })).rejects.toMatchObject({ code: 'invalid_request' });
  } finally { f.db.close(); }
});
