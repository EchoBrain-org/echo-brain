import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { expect, it, vi } from 'vitest';
import { ConfluenceConnectionStoreV1 } from '../src/confluence-connection-store-v1.js';
import { ConfluenceProjectMappingStoreV1 } from '../src/confluence-project-mapping-store-v1.js';
import { createConfluencePersonConnectionV1 } from '../src/confluence-person-connection-v1.js';
import type { ConfluenceNangoV1 } from '../src/confluence-nango-v1.js';

const cloud = '00000000-0000-4000-8000-000000000007';
const project = 'prj_00000000-0000-4000-8000-000000000010';
const site = 'https://fixture.atlassian.net';
const person = { organization_id: 'org-fixture', principal_id: 'person-fixture', membership_id: 'member-fixture' };

/** One connected person, a project grant that can be revoked, and a fake Confluence Cloud with one page in space 123. */
function fixture() {
  const db = new Database(':memory:');
  const store = new ConfluenceConnectionStoreV1(db);
  const mappings = new ConfluenceProjectMappingStoreV1(db);
  const begun = store.begin(person);
  store.complete(person, begun.attempt, 'confluence-reference', cloud, 'account-fixture', site);
  const tags = { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: begun.attempt };
  const unused = async () => { throw new Error('unused'); };
  const nango: ConfluenceNangoV1 = { connect: vi.fn(unused), find: vi.fn(unused), disconnect: vi.fn(unused),
    connection: vi.fn(async () => ({ tags, access_token: 'synthetic-confluence-token' })) };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/oauth/token/accessible-resources') return Response.json([{ id: cloud, url: site, scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'] }]);
    if (path.endsWith('/rest/api/user/current')) return Response.json({ accountId: 'account-fixture', type: 'known', accountType: 'atlassian' });
    if (path.endsWith('/api/v2/pages')) return Response.json({ results: [{ id: '100', spaceId: '123', title: 'ECHO MRD', status: 'current', version: { number: 7 } }], _links: {} });
    if (path.endsWith('/api/v2/spaces/123')) return Response.json({ id: '123', key: 'ECHO', name: 'Echo Product' });
    throw new Error(`unexpected Confluence endpoint ${path}`);
  });
  let member = true;
  const service = createConfluencePersonConnectionV1({ store, nango, cloud_id: cloud, fetch: fetch as typeof globalThis.fetch, project_mappings: mappings,
    authorize_project: (_token, project_id) => {
      if (project_id !== project || !member) throw new AuthorityOperationError('unauthorized', 'Fixture project access revoked');
      return { role: 'member', authorization_sha256: canonicalSha256('member') };
    },
    // As the port promises: names only for the projects the asker can see.
    project_names: (_token, project_ids) => new Map(project_ids.filter(id => id === project && member).map(id => [id, 'Launchscope'])),
    authenticate: token => ({ ...person, authorization_sha256: canonicalSha256({ token }) }) });
  const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1) => canonicalSha256(release)) };
  return { db, fetch, nango,
    source: () => service.source({ access_token: 'session', project_id: project, audit }),
    containers: (scoped = false) => service.containerSource({ access_token: 'session', ...(scoped ? { project_id: project } : {}), audit }),
    map: (cloud_id: string) => mappings.set(person.organization_id, project, mappings.read(person.organization_id, project).revision, canonicalSha256(randomUUID()), { cloud_id, space_ids: ['123'] }),
    revoke: () => { member = false; } };
}

it('reads a project only through its saved mapping on this site, fenced to the mapping and the project grant', async () => {
  const f = fixture();
  try {
    // An unmapped project reads nothing: never the person's global Confluence results.
    expect(await f.source()).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.nango.connection).not.toHaveBeenCalled();
    f.map('00000000-0000-4000-8000-000000000008');
    await expect(f.source()).rejects.toMatchObject({ code: 'unauthorized' });
    f.map(cloud);
    const source = (await f.source())!;
    expect((await source.list({})).items).toHaveLength(1);
    const listed = f.fetch.mock.calls.map(([url]) => new URL(String(url))).filter(url => url.pathname.endsWith('/api/v2/pages'));
    expect(listed.map(url => url.searchParams.get('space-id'))).toEqual(['123']);
    // A mapping saved, or the project grant lost, after a source opened refuses its next read.
    f.map(cloud);
    await expect(source.list({})).rejects.toMatchObject({ code: 'stale_access_state' });
    const reopened = (await f.source())!;
    f.revoke();
    await expect(reopened.list({})).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.source()).rejects.toMatchObject({ code: 'unauthorized' });
  } finally { f.db.close(); }
});

it('reads only the mapped spaces in a project scope, and nothing for an unmapped project', async () => {
  const f = fixture();
  try {
    expect(await f.containers(true)).toBeUndefined();
    f.map(cloud);
    const source = (await f.containers(true))!;
    expect((await source.list({})).items.map(item => item.label)).toEqual(['Echo Product']);
    expect(f.fetch.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/api/v2/spaces'))).toBe(false);
    f.revoke();
    await expect(source.list({})).rejects.toMatchObject({ code: 'unauthorized' });
  } finally { f.db.close(); }
});
