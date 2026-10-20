import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createJiraCloudTransportV1, type JiraCloudRequestV1, type JiraCloudTransportV1 } from '../src/jira-cloud-transport-v1.js';
import { createJiraPersonLiveContainerReaderV1 } from '../src/jira-person-live-container-reader-v1.js';

const cloudid = '00000000-0000-4000-8000-000000000007';
const origin = 'https://echo-fixture.atlassian.net';
const prefix = `/ex/jira/${cloudid}/rest/api/3`;
const binding: PersonConnectorReadBindingV1 = Object.freeze({ organization_id: 'org_00000000-0000-4000-8000-000000000001',
  principal_id: 'person-fixture', membership_id: 'mem_00000000-0000-4000-8000-000000000001', tool_id: 'jira',
  external_scope_id: cloudid, external_subject_id: 'synthetic-account', read_grant_sha256: canonicalSha256({ synthetic_grant: 1 }) });
/** A project as Jira's project search and exact read return it; avatars and types are never released. */
const project = (id: string, key: string, name: string) => ({ id, key, name, self: `${origin}/rest/api/3/project/${id}`, projectTypeKey: 'software', simplified: false,
  avatarUrls: { '48x48': 'https://never-fetch.example.test/avatar' }, isPrivate: false });
const container = (id: string, key: string): PersonToolContainerCitationV1 => ({ kind: 'tool_container', tool_id: 'jira', external_scope_id: cloudid,
  container: 'jira_project', container_id: id, permalink: `${origin}/browse/${key}` });
const LEFT_OUT = 'Some Jira projects could not be shown, so these results leave them out.';

/** `wire` reads through the real transport, so its request checks apply; a refusal is the status Jira answers. */
function fixture(options: { readonly pinned?: string; readonly wire?: boolean } = {}) {
  const state = {
    projects: new Map([['10000', project('10000', 'ECHO', 'Echo Platform')], ['10001', project('10001', 'LS', 'Launch Readiness')], ['10002', project('10002', 'OPS', 'Operations')]]),
    /** Projects the asker cannot browse: Jira's search leaves them out and its exact read refuses them. */
    hidden: new Set<string>(),
    /** The ECHO projects mapped to each Jira project that the asker can see, as the connection reads them. */
    echo: new Map<string, readonly string[]>([['10001', ['Launchscope']]]),
    searchResponse: undefined as unknown,
  };
  const request = vi.fn(async (input: JiraCloudRequestV1): Promise<unknown> => {
    if (input.path === '/oauth/token/accessible-resources') return [{ id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }];
    if (input.path === `${prefix}/myself`) return { accountId: binding.external_subject_id, active: true, accountType: 'atlassian' };
    if (input.path === `${prefix}/project/search`) {
      if (state.searchResponse !== undefined) return state.searchResponse;
      const startAt = Number(input.query?.startAt ?? '0'); const maxResults = Number(input.query?.maxResults ?? '50');
      const query = input.query?.query?.toLowerCase();
      const visible = [...state.projects.values()].filter(value => !state.hidden.has(value.id) &&
        (query === undefined || value.key.toLowerCase().includes(query) || value.name.toLowerCase().includes(query))).sort((left, right) => left.key < right.key ? -1 : 1);
      const values = visible.slice(startAt, startAt + maxResults);
      return { self: 'https://never-follow.example.test', maxResults, startAt, total: visible.length, isLast: startAt + values.length >= visible.length, values };
    }
    const exact = /\/project\/(\d+)$/.exec(input.path);
    if (exact !== null && input.path === `${prefix}/project/${exact[1]}`) {
      const value = state.projects.get(exact[1]!);
      if (value === undefined || state.hidden.has(value.id)) throw new AuthorityOperationError('not_found', 'private provider response');
      return value;
    }
    throw new Error(`Unexpected synthetic endpoint ${input.path}`);
  });
  const fetch = async (url: string) => {
    const parsed = new URL(url);
    try { return Response.json(await request({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) })); }
    catch (error) {
      if (error instanceof AuthorityOperationError) return Response.json({}, { status: 404 });
      throw error;
    }
  };
  const transport: JiraCloudTransportV1 = options.wire === true ? createJiraCloudTransportV1({ binding, fetch }) : { binding: { ...binding }, request };
  const releases: PersonLiveEvidenceReleaseV1<PersonToolContainerCitationV1>[] = [];
  const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1<PersonToolContainerCitationV1>) => { releases.push(release); return canonicalSha256(release); }) };
  async function make() {
    const reader = await createJiraPersonLiveContainerReaderV1({ binding, transport, echo_projects: () => new Map(state.echo), ...(options.pinned === undefined ? {} : { project: options.pinned }) });
    const source = createAuditedPersonLiveEvidenceSourceV1({ actor: binding, read_grant_sha256: binding.read_grant_sha256, reader, audit, authorization: { assertCurrent: () => {} },
      access: { tool_id: 'jira', identity_status: 'linked', external_scope_id: cloudid, external_subject_id: binding.external_subject_id, read_status: 'connected', read_capabilities: ['live_evidence'] } });
    return { reader, source };
  }
  const searches = () => request.mock.calls.filter(([input]) => input.path === `${prefix}/project/search`).map(([input]) => input.query);
  return { state, request, audit, releases, make, searches };
}

describe('Jira projects as a tool container source (research tool contract v1)', () => {
  it('lists the projects the asker can browse, a page at a time, each with its key, name, link and mapped ECHO projects', async () => {
    const f = fixture(); const { source } = await f.make();
    const first = await source.list({ limit: 2 });
    expect(first.items.map(item => [item.kind, item.label, item.text, item.attributes, item.citation])).toEqual([
      ['tool_container', 'Echo Platform', 'Jira project ECHO: Echo Platform', { key: 'ECHO', tool: 'Jira' }, container('10000', 'ECHO')],
      ['tool_container', 'Launch Readiness', 'Jira project LS: Launch Readiness\nECHO projects: Launchscope', { key: 'LS', tool: 'Jira' }, container('10001', 'LS')],
    ]);
    expect(first).toMatchObject({ truncated: true, next_cursor: expect.any(String) });
    const second = await source.list({ limit: 2, cursor: first.next_cursor });
    expect(second.items.map(item => item.label)).toEqual(['Operations']);
    expect(second).toMatchObject({ truncated: false, page_full: false });
    expect(second).not.toHaveProperty('next_cursor');
    // Jira applies the asker's own browse permission, in a stable key order.
    expect(f.searches()).toEqual([{ startAt: '0', maxResults: '2', orderBy: 'key', action: 'browse' }, { startAt: '2', maxResults: '2', orderBy: 'key', action: 'browse' }]);
    expect(f.releases.flatMap(release => release.citations)).toEqual([container('10000', 'ECHO'), container('10001', 'LS'), container('10002', 'OPS')]);
    for (const hidden of ['never-fetch', 'never-follow', 'software']) expect(JSON.stringify([first, second])).not.toContain(hidden);
  });

  it('finds a project by key, name or the ECHO project mapped to it, ignoring words that name the collection', async () => {
    const f = fixture(); const { source } = await f.make();
    expect((await source.search({ query: 'launch' })).items.map(item => item.label)).toEqual(['Launch Readiness']);
    // Launchscope names only the ECHO project: the mapped Jira project is read exactly, as the asker.
    expect((await source.search({ query: 'Launchscope Jira project' })).items.map(item => item.label)).toEqual(['Launch Readiness']);
    expect(f.searches().at(-1)).toEqual({ query: 'launchscope', maxResults: '50', orderBy: 'key', action: 'browse' });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/project/10001` }));
    // Words that only name the collection read its first page.
    const all = await source.search({ query: 'jira projects', limit: 2 });
    expect(all.items.map(item => item.label)).toEqual(['Echo Platform', 'Launch Readiness']);
    expect(all.truncated).toBe(true);
  });

  it('never finds a project the asker cannot browse, even through its ECHO project', async () => {
    const f = fixture(); f.state.hidden.add('10001');
    const { source } = await f.make();
    expect((await source.search({ query: 'Launchscope' })).items).toEqual([]);
    expect((await source.list({})).items.map(item => item.label)).toEqual(['Echo Platform', 'Operations']);
  });

  it('opens a project with a current exact read, naming the ECHO projects mapped to it now', async () => {
    const f = fixture(); const { source } = await f.make();
    const [listed] = (await source.list({ limit: 1 })).items;
    f.state.echo.set('10000', ['Launchscope', 'Atlas']);
    const opened = await source.open({ item: listed!.id });
    expect(opened.items).toEqual([expect.objectContaining({ id: listed!.id, label: 'Echo Platform', text: 'Jira project ECHO: Echo Platform\nECHO projects: Atlas, Launchscope' })]);
    expect(opened.truncated).toBe(false);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/project/10000` }));
  });

  it('cuts a long keyword to what Jira\'s project search takes, at a whole character, and still matches the whole query', async () => {
    // 89 characters with commas and no spaces: one word of 267 bytes.
    const phrase = '季度发布计划，'.repeat(13).slice(0, 89);
    const f = fixture({ wire: true });
    f.state.projects.set('10003', project('10003', 'PLAN', `计划 ${phrase}`));
    // Holds the part Jira is sent, but not the whole phrase: Jira returns it, and the reader leaves it out.
    f.state.projects.set('10004', project('10004', 'NEAR', `${phrase.slice(0, 85)}以外`));
    const { source } = await f.make();
    const found = await source.search({ query: phrase });
    expect(found.items.map(item => item.attributes?.key)).toEqual(['PLAN']);
    const sent = f.searches().at(-1)!.query!;
    expect(Buffer.byteLength(sent, 'utf8')).toBeLessThanOrEqual(256);
    expect(phrase.startsWith(sent)).toBe(true);
    expect([...sent]).toHaveLength(85);
  });

  it('refuses malformed project pages before anything is released', async () => {
    const valid = project('10000', 'ECHO', 'Echo Platform');
    for (const malformed of [
      { isLast: true, values: [valid, valid] },
      { isLast: false, values: [] },
      { values: [valid] },
    ]) {
      const f = fixture(); f.state.searchResponse = malformed;
      const { source } = await f.make();
      await expect(source.list({})).rejects.toMatchObject({ code: 'invalid_output' });
      expect(f.audit.record).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['a self link on another site', (value: ReturnType<typeof project>) => ({ ...value, self: 'https://elsewhere.example.test/rest/api/3/project/10003' })],
    ['a blank name', (value: ReturnType<typeof project>) => ({ ...value, name: ' ' })],
    ['a name that is not NFC', (value: ReturnType<typeof project>) => ({ ...value, name: 'Bad Café' })],
    ['a line separator in its name', (value: ReturnType<typeof project>) => ({ ...value, name: 'Bad Project' })],
    ['an unexpected key shape', (value: ReturnType<typeof project>) => ({ ...value, key: 'not a key' })],
  ])('leaves out a project with %s, says so, and never ends the list or search as complete', async (_case, malform) => {
    const f = fixture(); f.state.projects.set('10003', malform(project('10003', 'BAD', 'Bad Project')));
    const { source } = await f.make();
    const listed = await source.list({});
    expect(listed.items.map(item => item.label)).toEqual(['Echo Platform', 'Launch Readiness', 'Operations']);
    expect(listed).toMatchObject({ truncated: false, page_full: false, notice: LEFT_OUT });
    const found = await source.search({ query: 'jira projects' });
    expect(found.items.map(item => item.label)).toEqual(['Echo Platform', 'Launch Readiness', 'Operations']);
    expect(found).toMatchObject({ truncated: false, notice: LEFT_OUT });
    // Nothing of the row left out is released, named or audited.
    expect([...listed.items, ...found.items, ...f.releases.flatMap(release => release.citations.map(citation => ({ citation })))].map(item => item.citation.container_id)).not.toContain('10003');
    for (const left of ['BAD', 'Bad', 'not a key', 'elsewhere']) expect(JSON.stringify([...listed.items, ...found.items])).not.toContain(left);
  });

  it('in a project scope leaves out a mapped project it cannot show, and says so', async () => {
    const f = fixture({ pinned: '10001' }); f.state.projects.set('10001', project('10001', 'LS', 'Launch Readiness'));
    const { source } = await f.make();
    const listed = await source.list({});
    expect(listed).toMatchObject({ items: [], truncated: false, page_full: false, notice: LEFT_OUT });
    expect(await source.search({ query: 'launch' })).toMatchObject({ items: [], truncated: false, notice: LEFT_OUT });
  });
});
