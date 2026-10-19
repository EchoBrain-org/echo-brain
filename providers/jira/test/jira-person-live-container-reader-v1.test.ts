import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudRequestV1, JiraCloudTransportV1 } from '../src/jira-cloud-transport-v1.js';
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

function fixture(options: { readonly pinned?: string } = {}) {
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
  const transport: JiraCloudTransportV1 = { binding: { ...binding }, request };
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

  it('names at most ten mapped ECHO projects, then how many more', async () => {
    const f = fixture(); f.state.echo.set('10000', Array.from({ length: 12 }, (_, index) => `Project ${String(index + 1).padStart(2, '0')}`));
    const { source } = await f.make();
    const [item] = (await source.list({ limit: 1 })).items;
    expect(item!.text).toBe(`Jira project ECHO: Echo Platform\nECHO projects: ${Array.from({ length: 10 }, (_, index) => `Project ${String(index + 1).padStart(2, '0')}`).join(', ')}, and 2 more`);
  });

  it('refuses a date window or a container selector before any provider read', async () => {
    const f = fixture(); const { source } = await f.make(); f.request.mockClear();
    for (const dates of [{ since: '2026-10-01' }, { until: '2026-10-01' }, { date_field: 'created' as const }, { since: '2026-10-01', date_field: 'any' as const }]) {
      await expect(source.list(dates)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(source.search({ query: 'echo', ...dates })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(source.list({ container: 'ECHO' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('in a project scope reads only the Jira project the ECHO project maps', async () => {
    const f = fixture({ pinned: '10001' }); const { source } = await f.make();
    const listed = await source.list({});
    expect(listed.items.map(item => item.label)).toEqual(['Launch Readiness']);
    expect(listed).toMatchObject({ truncated: false, page_full: false });
    expect((await source.search({ query: 'echo' })).items).toEqual([]);
    expect((await source.search({ query: 'launch' })).items.map(item => item.label)).toEqual(['Launch Readiness']);
    expect(f.searches()).toEqual([]);
    f.state.hidden.add('10001');
    expect((await source.list({})).items).toEqual([]);
  });

  it.each([
    ['renamed in Jira', 'stale_access_state', (f: ReturnType<typeof fixture>) => { f.state.projects.set('10002', project('10002', 'OPS', 'Operations and Support')); }],
    ['re-keyed in Jira', 'stale_access_state', (f: ReturnType<typeof fixture>) => { f.state.projects.set('10002', project('10002', 'OPX', 'Operations')); }],
    ['no longer visible', 'not_found', (f: ReturnType<typeof fixture>) => { f.state.hidden.add('10000'); }],
    ['no longer mapped to a visible ECHO project', 'stale_access_state', (f: ReturnType<typeof fixture>) => { f.state.echo.delete('10001'); }],
  ])('revalidates every released project: one %s stops reuse', async (_change, code, change) => {
    const f = fixture(); const { source } = await f.make();
    await source.list({});
    await expect(source.revalidate({})).resolves.toBeUndefined();
    change(f);
    await expect(source.revalidate({})).rejects.toMatchObject({ code });
  });

  it('revalidates every release of a project, not only its latest', async () => {
    const f = fixture(); const { source } = await f.make();
    const [listed] = (await source.list({ limit: 1 })).items;
    f.state.projects.set('10000', project('10000', 'ECHO', 'Echo Platform Two'));
    expect((await source.open({ item: listed!.id })).items[0]!.label).toBe('Echo Platform Two');
    // The list released the old name too, and it is no longer what the asker sees.
    await expect(source.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('compares a check against the ECHO projects named after Jira answers, so a change during the check is seen', async () => {
    const f = fixture(); const { source } = await f.make();
    await source.list({});
    const answer = f.request.getMockImplementation()!;
    f.request.mockImplementation(async input => {
      const value = await answer(input);
      if (/\/project\/\d+$/.test(input.path)) f.state.echo.delete('10001');
      return value;
    });
    await expect(source.revalidate({})).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('refuses malformed project pages before anything is released', async () => {
    const valid = project('10000', 'ECHO', 'Echo Platform');
    for (const malformed of [
      { isLast: true, values: [valid, valid] },
      { isLast: false, values: [] },
      { values: [valid] },
      { isLast: true, values: [{ ...valid, self: 'https://elsewhere.example.test/rest/api/3/project/10000' }] },
      { isLast: true, values: [{ ...valid, name: ' ' }] },
      { isLast: true, values: [{ ...valid, key: 'not a key' }] },
    ]) {
      const f = fixture(); f.state.searchResponse = malformed;
      const { source } = await f.make();
      await expect(source.list({})).rejects.toMatchObject({ code: 'invalid_output' });
      expect(f.audit.record).not.toHaveBeenCalled();
    }
  });
});
