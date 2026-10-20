import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createConfluenceCloudTransportV1 } from '../src/confluence-cloud-transport-v1.js';
import { createConfluencePersonLiveContainerReaderV1 } from '../src/confluence-person-live-container-reader-v1.js';

const CLOUD = '00000000-0000-4000-8000-000000000007';
const ORIGIN = 'https://synthetic-echo.atlassian.net';
const API_PREFIX = `/ex/confluence/${CLOUD}/wiki`;
const binding: PersonConnectorReadBindingV1 = Object.freeze({ organization_id: 'synthetic-org', principal_id: 'synthetic-person', membership_id: 'synthetic-member',
  tool_id: 'confluence', external_scope_id: CLOUD, external_subject_id: 'synthetic-account', read_grant_sha256: canonicalSha256({ synthetic_grant: 1 }) });
type Space = { readonly id: string; readonly key: string; readonly name: string };
/** A space as Confluence returns it; its provider links and description are never followed or released. */
const wire = (space: Space) => ({ ...space, type: 'global', status: 'current', authorId: 'never-release-author', homepageId: '999',
  description: null, _links: { webui: 'https://untrusted.invalid/never-follow' } });
const container = (id: string, key: string): PersonToolContainerCitationV1 => ({ kind: 'tool_container', tool_id: 'confluence', external_scope_id: CLOUD,
  container: 'confluence_space', container_id: id, permalink: `${ORIGIN}/wiki/spaces/${key}` });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const LEFT_OUT = 'Some Confluence spaces could not be shown, so these results leave them out.';

function fixture() {
  const state = {
    spaces: [{ id: '42', key: 'ECHO', name: 'Echo Product' }, { id: '43', key: 'ENG', name: 'Engineering' }, { id: '44', key: 'OPS', name: 'Operations' }] as Space[],
    echo: new Map<string, readonly string[]>([['43', ['Launchscope']]]),
    spacesResponse: undefined as unknown,
  };
  const calls: { path: string; query: URLSearchParams }[] = [];
  const fetch = vi.fn(async (raw: string, _init: RequestInit) => {
    const url = new URL(raw);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
    calls.push({ path, query: new URLSearchParams(url.searchParams) });
    if (path === '/oauth/token/accessible-resources') return response([{ id: CLOUD, url: ORIGIN, scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'] }]);
    if (path === '/rest/api/user/current') return response({ accountId: binding.external_subject_id, type: 'known', accountType: 'atlassian' });
    if (path === '/api/v2/spaces') {
      if (state.spacesResponse !== undefined) return response(state.spacesResponse);
      const visible = state.spaces;
      const start = Number(url.searchParams.get('cursor')?.slice('opaque-'.length) ?? '0');
      const limit = Number(url.searchParams.get('limit'));
      const next = start + limit < visible.length ? `/wiki/api/v2/spaces?cursor=opaque-${start + limit}&limit=${limit}` : undefined;
      return response({ results: visible.slice(start, start + limit).map(wire), _links: { base: 'https://untrusted.invalid', ...(next === undefined ? {} : { next }) } });
    }
    const exact = /^\/api\/v2\/spaces\/(\d+)$/.exec(path);
    if (exact !== null) {
      const space = state.spaces.find(value => value.id === exact[1]);
      return space === undefined ? response({}, 404) : response(wire(space));
    }
    throw new Error(`Unexpected synthetic endpoint: ${path}`);
  });
  const releases: PersonLiveEvidenceReleaseV1<PersonToolContainerCitationV1>[] = [];
  const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1<PersonToolContainerCitationV1>) => { releases.push(release); return canonicalSha256(release); }) };
  async function make() {
    const reader = await createConfluencePersonLiveContainerReaderV1({ binding, transport: createConfluenceCloudTransportV1({ binding, fetch }), expected_origin: ORIGIN,
      echo_projects: () => state.echo });
    return createAuditedPersonLiveEvidenceSourceV1({ actor: binding, read_grant_sha256: binding.read_grant_sha256, reader, audit, authorization: { assertCurrent: () => {} },
      access: { tool_id: 'confluence', external_scope_id: CLOUD, external_subject_id: binding.external_subject_id, identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'] } });
  }
  const spaceLists = () => calls.filter(call => call.path === '/api/v2/spaces').map(call => Object.fromEntries(call.query));
  return { state, calls, fetch, audit, releases, make, spaceLists };
}

describe('Confluence spaces as a tool container source (research tool contract v1)', () => {
  it('lists the spaces the asker can view, a page at a time, each with its key, name, link and mapped ECHO projects', async () => {
    const f = fixture(); const source = await f.make();
    const first = await source.list({ limit: 2 });
    expect(first.items.map(item => [item.kind, item.label, item.text, item.attributes, item.citation])).toEqual([
      ['tool_container', 'Echo Product', 'Confluence space ECHO: Echo Product', { key: 'ECHO', tool: 'Confluence' }, container('42', 'ECHO')],
      ['tool_container', 'Engineering', 'Confluence space ENG: Engineering\nECHO projects: Launchscope', { key: 'ENG', tool: 'Confluence' }, container('43', 'ENG')],
    ]);
    expect(first).toMatchObject({ truncated: true, next_cursor: expect.any(String) });
    const second = await source.list({ limit: 2, cursor: first.next_cursor });
    expect(second.items.map(item => item.label)).toEqual(['Operations']);
    expect(second).toMatchObject({ truncated: false, page_full: false });
    // Only the opaque cursor is carried from Confluence's next link, into our own pinned endpoint and page size.
    expect(f.spaceLists()).toEqual([{ limit: '2' }, { limit: '2', cursor: 'opaque-2' }]);
    for (const hidden of ['never-follow', 'never-release', 'untrusted']) expect(JSON.stringify([first, second, f.releases])).not.toContain(hidden);
  });

  it('links a personal space by its encoded key', async () => {
    const f = fixture(); f.state.spaces = [{ id: '45', key: '~557058:ab-12', name: 'Dana Example' }];
    const source = await f.make();
    expect((await source.list({})).items[0]!.citation.permalink).toBe(`${ORIGIN}/wiki/spaces/~557058%3Aab-12`);
  });

  it('finds a space by key, name or mapped ECHO project, and says when the spaces it looked through were cut short', async () => {
    const f = fixture(); const source = await f.make();
    expect((await source.search({ query: 'Launchscope' })).items.map(item => item.label)).toEqual(['Engineering']);
    expect((await source.search({ query: 'ops space' })).items.map(item => item.label)).toEqual(['Operations']);
    expect((await source.search({ query: 'confluence spaces', limit: 2 })).items.map(item => item.label)).toEqual(['Echo Product', 'Engineering']);
    f.state.spaces = Array.from({ length: 1001 }, (_, index) => ({ id: String(1000 + index), key: `S${index}`, name: index === 1000 ? 'Far Away' : `Space ${index}` }));
    const far = await source.search({ query: 'far away' });
    expect(far.items).toEqual([]);
    expect(far.truncated).toBe(true);
    expect(f.spaceLists().slice(-4).map(query => query.limit)).toEqual(['250', '250', '250', '250']);
  });

  // What every tool's containers share (project scopes, refused dates, checks) is the shared reader's, tested there and through Jira.

  it('refuses malformed space pages before anything is released', async () => {
    for (const malformed of [{ results: [wire({ id: '42', key: 'ECHO', name: 'Echo' }), wire({ id: '42', key: 'ECHO', name: 'Echo' })] }, { results: 'not a list' }, {}]) {
      const f = fixture(); f.state.spacesResponse = malformed;
      const source = await f.make();
      await expect(source.list({})).rejects.toMatchObject({ code: 'invalid_output' });
      expect(f.audit.record).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['an id that is not one', { id: 'not-an-id', key: 'BAD', name: 'Bad Space' }],
    ['an unexpected key shape', { id: '45', key: 'has space', name: 'Bad Space' }],
    ['an empty name', { id: '45', key: 'BAD', name: '' }],
    ['a blank name', { id: '45', key: 'BAD', name: ' ' }],
    ['a name that is not NFC', { id: '45', key: 'BAD', name: 'Bad Café' }],
    ['a line separator in its name', { id: '45', key: 'BAD', name: 'Bad Space' }],
  ])('leaves out a space with %s, says so, and never ends the list or search as complete', async (_case, bad) => {
    const f = fixture(); f.state.spaces.splice(1, 0, bad);
    const source = await f.make();
    const listed = await source.list({});
    expect(listed.items.map(item => item.label)).toEqual(['Echo Product', 'Engineering', 'Operations']);
    expect(listed).toMatchObject({ truncated: false, page_full: false, notice: LEFT_OUT });
    const found = await source.search({ query: 'confluence spaces' });
    expect(found.items.map(item => item.label)).toEqual(['Echo Product', 'Engineering', 'Operations']);
    expect(found).toMatchObject({ truncated: false, notice: LEFT_OUT });
    // Nothing of the row left out is released, named or audited.
    expect([...listed.items, ...found.items, ...f.releases.flatMap(release => release.citations.map(citation => ({ citation })))].map(item => item.citation.container_id)).not.toContain(bad.id);
    for (const left of ['not-an-id', 'BAD', 'Bad', 'has space']) expect(JSON.stringify([...listed.items, ...found.items])).not.toContain(left);
  });
});
