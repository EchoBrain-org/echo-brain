import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudRequestV1, JiraCloudTransportV1 } from '../src/jira-cloud-transport-v1.js';
import { createJiraPersonLiveEvidenceReaderV1 } from '../src/jira-person-live-evidence-reader-v1.js';

const cloudid = '00000000-0000-4000-8000-000000000007';
const origin = 'https://echo-fixture.atlassian.net';
const prefix = `/ex/jira/${cloudid}/rest/api/3`;
const binding: PersonConnectorReadBindingV1 = Object.freeze({ organization_id: 'org_00000000-0000-4000-8000-000000000001',
  principal_id: 'person-fixture', membership_id: 'mem_00000000-0000-4000-8000-000000000001', tool_id: 'jira',
  external_scope_id: cloudid, external_subject_id: 'synthetic-account', read_grant_sha256: canonicalSha256({ synthetic_grant: 1 }) });
const digest = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const project = () => ({ id: '10000', key: 'ECHO', self: `${origin}/rest/api/3/project/10000`, name: 'Fixture' });
const ticket = (id = '10001', summary = 'Ship connector') => ({ id, key: `ECHO-${Number(id) - 10000}`, self: `${origin}/rest/api/3/issue/${id}`,
  fields: { summary, project: project(), description: { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Launch Friday', marks: [{ type: 'strong' }] }] },
    { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Alex', id: 'never-return-this-id' } }] },
  ] }, created: '2026-09-30T12:34:56.000+0000', status: { name: 'In progress' }, assignee: { displayName: 'Alex', emailAddress: 'never-return@example.test' }, duedate: '2026-10-02',
    comment: { comments: [{ body: 'never-return-comment' }] }, attachment: [{ content: 'https://never-fetch.example.test' }], issuelinks: [] } });
const page = (ids = ['10001'], token?: string) => ({ isLast: token === undefined, issues: ids.map(id => ({ id })), ...(token === undefined ? {} : { nextPageToken: token }) });

function fixture() {
  const f = {
    resources: [{ id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }] as unknown,
    myself: { accountId: binding.external_subject_id, active: true, accountType: 'atlassian', emailAddress: 'irrelevant@example.test' } as unknown,
    project: project() as unknown,
    tickets: new Map<string, unknown>([['10001', ticket()], ['10002', ticket('10002', 'Review security')]]),
    pages: [page()] as unknown[],
    bulkResponse: undefined as unknown,
    hook: undefined as ((input: JiraCloudRequestV1) => void) | undefined,
    denied: new Map<string, 'unauthorized' | 'not_found'>(),
  };
  const request = vi.fn(async (input: JiraCloudRequestV1): Promise<unknown> => {
    f.hook?.(input);
    if (input.path === '/oauth/token/accessible-resources') return f.resources;
    if (input.path === `${prefix}/myself`) return f.myself;
    if (input.path.startsWith(`${prefix}/project/`)) return f.project;
    if (input.path === `${prefix}/search/jql`) return f.pages.shift() ?? page([]);
    if (input.path === `${prefix}/issue/bulkfetch`) return f.bulkResponse !== undefined ? f.bulkResponse : {
      issues: (input.body!.issueIdsOrKeys as string[]).filter(id => !f.denied.has(id)).map(id => f.tickets.get(id)), issueErrors: [],
    };
    if (input.path.startsWith(`${prefix}/issue/`)) {
      const id = input.path.slice(`${prefix}/issue/`.length);
      const denied = f.denied.get(id);
      if (denied !== undefined) throw new AuthorityOperationError(denied, 'private provider response');
      return f.tickets.get(id);
    }
    throw new Error('Unexpected synthetic endpoint');
  });
  const transport: JiraCloudTransportV1 = { binding: { ...binding }, request };
  const authorization = { assertCurrent: vi.fn(() => {}) };
  const releases: PersonLiveEvidenceReleaseV1<PersonTicketCitationV1>[] = [];
  const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1<PersonTicketCitationV1>) => { releases.push(release); return canonicalSha256(release); }) };
  async function make(fixedProject?: string) {
    const reader = await createJiraPersonLiveEvidenceReaderV1({ binding, transport, ...(fixedProject === undefined ? {} : { project: fixedProject }) });
    const source = createAuditedPersonLiveEvidenceSourceV1({ actor: binding,
      access: { tool_id: 'jira', identity_status: 'linked', external_scope_id: cloudid, external_subject_id: binding.external_subject_id,
        read_status: 'connected', read_capabilities: ['live_evidence'] }, read_grant_sha256: binding.read_grant_sha256, reader, authorization, audit });
    return { reader, source };
  }
  return { ...f, state: f, request, transport, authorization, releases, audit, make };
}

describe('person-bound Jira live reader through the shared audited wrapper', () => {
  it('bounds exact inventory reads at four and preserves discovery order', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const ids = Array.from({ length: 20 }, (_, index) => String(10001 + index));
      for (const id of ids) f.state.tickets.set(id, ticket(id));
      f.state.pages = [page(ids)];
      const original = f.request.getMockImplementation()!;
      let active = 0; let maximum = 0;
      f.request.mockImplementation(async input => {
        if (input.path.startsWith(`${prefix}/issue/`)) {
          active++; maximum = Math.max(maximum, active);
          await new Promise(resolve => setTimeout(resolve, 10));
          active--;
        }
        return original(input);
      });
      const { source } = await f.make();
      const start = Date.now(); let elapsed = 0;
      const pending = source.list({ limit: 20 }).then(result => { elapsed = Date.now() - start; return result; });
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;
      expect(elapsed).toBe(50);
      expect(maximum).toBe(4);
      expect(result.items.map(item => item.citation.ticket_id)).toEqual(ids);
      expect(f.audit.record).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('discovers ticket summaries before fetching a selected body', async () => {
    const f = fixture(); const { source } = await f.make();
    const discovered = await source.search({ query: 'ship' });
    expect(discovered.items[0]).toMatchObject({ label: 'ECHO-1: Ship connector', date_kind: 'created', attributes: { status: 'In progress' } });
    expect(discovered.items[0]).not.toHaveProperty('text');
    expect(f.request.mock.calls.filter(([request]) => request.path.includes('/issue/')).every(([request]) => !request.query?.fields?.includes('description'))).toBe(true);
    const opened = await source.open({ item: discovered.items[0]!.id });
    expect(opened.items[0]).toMatchObject({ id: discovered.items[0]!.id, text: 'ECHO-1: Ship connector\n\nLaunch Friday\n@Alex' });
  });

  it('shares only queued connection checks and keeps post-read fences independent', async () => {
    const f = fixture(); const { reader } = await f.make('ECHO');
    const verificationReads = () => f.request.mock.calls.filter(([request]) =>
      request.path === '/oauth/token/accessible-resources' || request.path === `${prefix}/myself` || request.path === `${prefix}/project/ECHO`);
    f.request.mockClear();

    await Promise.all([reader.search({ query: 'ship', limit: 1 }), reader.search({ query: 'ship', limit: 1 })]);
    // The two pre-read checks queue together (3 reads). Once provider I/O
    // starts, each post-read fence is new (3 + 3), never an in-flight cache.
    expect(verificationReads()).toHaveLength(9);

    f.request.mockClear();
    await reader.search({ query: 'ship', limit: 1 });
    await reader.search({ query: 'ship', limit: 1 });
    expect(verificationReads()).toHaveLength(12);
  });

  it.each(['subject', 'project'] as const)('keeps the final remote %s fence fresh after an initial verification', async drift => {
    const f = fixture(); const { reader } = await f.make('ECHO');
    f.state.hook = request => {
      if (request.path !== `${prefix}/search/jql`) return;
      if (drift === 'subject') f.state.myself = { accountId: 'other-person', active: true, accountType: 'atlassian' };
      else f.state.project = { id: '99999', key: 'ECHO', self: `${origin}/rest/api/3/project/99999` };
    };
    await expect(reader.search({ query: 'ship', limit: 1 })).rejects.toMatchObject({ code: drift === 'subject' ? 'unauthorized' : 'stale_access_state' });
  });

  it('opens an anchor first and admits bounded, deduplicated linked-ticket metadata through the existing item refs', async () => {
    const f = fixture();
    for (const id of ['10002', '10003', '10004', '10005', '10006', '10007']) f.state.tickets.set(id, ticket(id, `Linked ${id}`));
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, issuelinks: [
      { outwardIssue: { id: '10007' } }, { inwardIssue: { id: '10003' } }, { outwardIssue: { id: '10002' } },
      { inwardIssue: { id: '10003' } }, { outwardIssue: { id: '10001' } }, { outwardIssue: { id: '10006' } },
      { inwardIssue: { id: '10005' } }, { outwardIssue: { id: '10004' } },
    ] } });
    const { source } = await f.make('ECHO');
    const anchor = (await source.search({ query: 'ship' })).items[0]!;

    const opened = await source.open({ item: anchor.id });

    expect(opened.items.map(item => item.citation.ticket_id)).toEqual(['10001', '10002', '10003', '10004', '10005']);
    expect(opened.items[0]).toHaveProperty('text', 'ECHO-1: Ship connector\n\nLaunch Friday\n@Alex');
    for (const item of opened.items.slice(1)) {
      expect(item).not.toHaveProperty('text');
      expect(item).toMatchObject({ label: `ECHO-${Number(item.citation.ticket_id) - 10000}: Linked ${item.citation.ticket_id}`, attributes: { status: 'In progress' } });
    }
    expect(opened.truncated).toBe(true);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,status,assignee,duedate,description,issuelinks' } }));
    for (const id of ['10002', '10003', '10004', '10005']) {
      expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/${id}`, query: { fields: 'summary,project,created,status,assignee,duedate' } }));
    }
    expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10006` }));
    const linked = await source.open({ item: opened.items[1]!.id });
    expect(linked.items[0]).toMatchObject({ citation: { ticket_id: '10002' }, text: 'ECHO-2: Linked 10002\n\nLaunch Friday\n@Alex' });
  });

  it('opens an anchor when Jira omits optional link context, without inferring that no relationship exists', async () => {
    const f = fixture();
    const anchor = ticket();
    const { issuelinks: _issuelinks, ...fields } = anchor.fields;
    f.state.tickets.set('10001', { ...anchor, fields });
    const { source } = await f.make('ECHO');
    const discovered = (await source.search({ query: 'ship' })).items[0]!;

    const opened = await source.open({ item: discovered.id });

    expect(opened.items).toHaveLength(1);
    expect(opened.items[0]).toMatchObject({ citation: { ticket_id: '10001' }, text: 'ECHO-1: Ship connector\n\nLaunch Friday\n@Alex' });
    expect(opened.truncated).toBe(false);
  });

  it('bounds a large valid link list without blocking the anchor, including limit one', async () => {
    const f = fixture();
    for (const id of ['10002', '10003', '10004', '10005']) f.state.tickets.set(id, ticket(id, `Linked ${id}`));
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, issuelinks: Array.from({ length: 65 }, (_, index) => ({ outwardIssue: { id: String(10002 + index) } })) } });
    const { source } = await f.make('ECHO');
    const anchor = (await source.search({ query: 'ship' })).items[0]!;
    f.request.mockClear();

    const anchorOnly = await source.open({ item: anchor.id, limit: 1 });
    expect(anchorOnly.items.map(item => item.citation.ticket_id)).toEqual(['10001']);
    expect(anchorOnly.truncated).toBe(true);
    expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10002` }));

    f.request.mockClear();
    const expanded = await source.open({ item: anchor.id });
    expect(expanded.items.map(item => item.citation.ticket_id)).toEqual(['10001', '10002', '10003', '10004', '10005']);
    expect(expanded.truncated).toBe(true);
  });

  it('refreshes a citation as anchor-only without reading optional linked context', async () => {
    const f = fixture();
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, issuelinks: [{ outwardIssue: { id: '10002' } }] } });
    f.state.denied.set('10002', 'unauthorized');
    const { source } = await f.make('ECHO');
    const discovered = (await source.search({ query: 'ship' })).items[0]!;
    f.request.mockClear();

    const refreshed = await source.openCitation!({ citation: discovered.citation });

    expect(refreshed.items).toHaveLength(1);
    expect(refreshed.items[0]).toMatchObject({ citation: { ticket_id: '10001' }, text: 'ECHO-1: Ship connector\n\nLaunch Friday\n@Alex' });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,status,assignee,duedate,description' } }));
    expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10002` }));
  });

  it('omits an inaccessible or out-of-project linked issue without leaking its metadata', async () => {
    for (const state of ['outside_project', 'denied'] as const) {
      const f = fixture();
      const related = ticket('10002', 'Private linked issue');
      f.state.tickets.set('10002', state === 'outside_project' ? { ...related, key: 'OTHER-2', fields: { ...related.fields,
        project: { id: '20000', key: 'OTHER', self: `${origin}/rest/api/3/project/20000` } } } : related);
      f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, issuelinks: [{ outwardIssue: { id: '10002' } }] } });
      if (state === 'denied') f.state.denied.set('10002', 'unauthorized');
      const { source } = await f.make('ECHO');
      const anchor = (await source.search({ query: 'ship' })).items[0]!;

      const opened = await source.open({ item: anchor.id });
      expect(opened.items.map(item => item.citation.ticket_id)).toEqual(['10001']);
      expect(opened.truncated).toBe(true);
      expect(f.audit.record).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(f.releases)).not.toContain('Private linked issue');
      expect(JSON.stringify(f.releases)).not.toContain('OTHER-2');
    }
  });

  it('fails closed for a transient linked-issue error after the final connection fence', async () => {
    const f = fixture();
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, issuelinks: [{ outwardIssue: { id: '10002' } }] } });
    f.state.hook = request => {
      if (request.path === `${prefix}/issue/10002`) throw new AuthorityOperationError('unavailable', 'synthetic temporary provider failure');
    };
    const { source } = await f.make('ECHO');
    const anchor = (await source.search({ query: 'ship' })).items[0]!;
    const checksBefore = f.request.mock.calls.filter(([request]) => request.path === '/oauth/token/accessible-resources').length;

    await expect(source.open({ item: anchor.id })).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.request.mock.calls.filter(([request]) => request.path === '/oauth/token/accessible-resources')).toHaveLength(checksBefore + 2);
    expect(f.audit.record).toHaveBeenCalledTimes(1);
  });

  it('limits related metadata by the existing open limit and rejects malformed link references', async () => {
    const f = fixture();
    f.state.tickets.set('10002', ticket('10002', 'First related'));
    f.state.tickets.set('10003', ticket('10003', 'Second related'));
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, issuelinks: [
      { outwardIssue: { id: '10003' } }, { inwardIssue: { id: '10002' } },
    ] } });
    const { source } = await f.make('ECHO');
    const anchor = (await source.search({ query: 'ship' })).items[0]!;
    const limited = await source.open({ item: anchor.id, limit: 2 });
    expect(limited.items.map(item => item.citation.ticket_id)).toEqual(['10001', '10002']);
    expect(limited.truncated).toBe(true);

    const malformed = fixture();
    malformed.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, issuelinks: [{ outwardIssue: { id: '10002' }, inwardIssue: { id: '10003' } }] } });
    const malformedSource = await malformed.make('ECHO');
    const malformedAnchor = (await malformedSource.source.search({ query: 'ship' })).items[0]!;
    await expect(malformedSource.source.open({ item: malformedAnchor.id })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(malformed.audit.record).toHaveBeenCalledTimes(1);
  });

  it('lists visible tickets across projects globally and pins project discovery before release', async () => {
    const f = fixture();
    const other = ticket('10002');
    f.state.tickets.set('10002', { ...other, key: 'OTHER-2', fields: { ...other.fields, project: { id: '20000', key: 'OTHER', self: `${origin}/rest/api/3/project/20000` } } });
    f.state.pages = [page(['10001', '10002'])];
    const global = await f.make();
    expect((await global.source.list({})).items.map(item => item.citation.ticket_id)).toEqual(['10001', '10002']);
    expect(f.request.mock.calls.find(([request]) => request.path.endsWith('/search/jql'))![0].body?.jql).toBe('created >= "1970-01-01" ORDER BY created DESC, id DESC');
    f.request.mockClear(); f.state.pages = [page(['10001'])];
    const scoped = await f.make('ECHO');
    expect((await scoped.source.list({})).items.map(item => item.citation.ticket_id)).toEqual(['10001']);
    expect(f.request.mock.calls.find(([request]) => request.path.endsWith('/search/jql'))![0].body?.jql).toBe('project = 10000 ORDER BY created DESC, id DESC');
  });

  it('finishes 22-ticket research and both release fences within the 200-credential-request window', async () => {
    const f = fixture();
    const ids = Array.from({ length: 22 }, (_, index) => String(10001 + index));
    for (const id of ids) f.state.tickets.set(id, ticket(id));
    f.state.pages = [page(ids.slice(0, 2)), page(ids.slice(2)), page(ids.slice(0, 5)), page(ids.slice(0, 1))];
    let credentialRequests = 0;
    f.state.hook = () => { if (++credentialRequests > 200) throw new AuthorityOperationError('unavailable', 'Credential endpoint rate limit'); };
    const { source } = await f.make('ECHO');
    await source.revalidate({});
    await source.search({ query: 'MRD', limit: 5 });
    await source.list({ limit: 20 });
    await source.revalidate({});
    await source.search({ query: 'ECHO program management', limit: 5 });
    await source.search({ query: 'ECHO-1', limit: 5 });
    await source.revalidate({});
    await source.revalidate({});
    await source.revalidate({});
    await expect(source.revalidate({})).resolves.toBeUndefined();
    expect(credentialRequests).toBeLessThanOrEqual(200);
  });
  it.each(['KAN', '10000'])('keeps live reads in the same project after its configured key is renamed (%s)', async selection => {
    const f = fixture();
    f.state.project = { ...project(), projectKeys: ['KAN', 'ECHO'] };
    const reader = await createJiraPersonLiveEvidenceReaderV1({ binding, transport: f.transport, project: selection });
    const result = await reader.list({ limit: 5 });
    expect(result.items[0]).toMatchObject({ label: 'ECHO-1: Ship connector', citation: { ticket_id: '10001' } });
    expect(f.request.mock.calls.find(([request]) => request.path === `${prefix}/search/jql`)![0].body?.jql).toBe('project = 10000 ORDER BY created DESC, id DESC');
  });

  it.each([undefined, [], ['OTHER'], 'KAN', ['KAN', 'invalid key'], ['KAN', '10000']])('rejects an unverified or malformed previous project key (%j)', async keys => {
    const f = fixture(); f.state.project = { ...project(), ...(keys === undefined ? {} : { projectKeys: keys }) };
    await expect(f.make('KAN')).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f.request.mock.calls.some(([request]) => request.path.endsWith('/search/jql'))).toBe(false);
  });

  it('rechecks historical keys and supports them as scoped or unscoped list selectors', async () => {
    const f = fixture(); f.state.project = { ...project(), projectKeys: ['KAN', 'ECHO'] };
    const { source } = await f.make('10000');
    await expect(source.list({ container: 'KAN' })).resolves.toMatchObject({ items: [{ label: 'ECHO-1: Ship connector' }] });
    f.state.pages = [page()];
    const unscoped = await f.make();
    await expect(unscoped.source.list({ container: 'KAN' })).resolves.toMatchObject({ items: [{ label: 'ECHO-1: Ship connector' }] });
    f.state.project = { ...project(), projectKeys: ['ECHO'] }; f.state.pages = [page()];
    await expect(source.list({ container: 'KAN' })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('pins a trusted project for keyword/key search and inventory without a model-selected container', async () => {
    const f = fixture(); f.state.pages = [page(), page(), page()];
    const { source } = await f.make('ECHO');
    await source.search({ query: 'launch' });
    await source.search({ query: 'ECHO-1' });
    await source.list({});
    expect(f.request.mock.calls.filter(([request]) => request.path === `${prefix}/search/jql`).map(([request]) => request.body?.jql)).toEqual([
      'project = 10000 AND (text ~ "\\\"launch\\\"") ORDER BY created DESC, id DESC',
      'project = 10000 AND (key = "ECHO-1") ORDER BY created DESC, id DESC',
      'project = 10000 ORDER BY created DESC, id DESC',
    ]);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/project/ECHO` }));
  });

  it.each(['search', 'list', 'open', 'revalidate'] as const)('refuses an exact issue outside the pinned project during %s', async operation => {
    const f = fixture(); const { source } = await f.make('ECHO');
    const first = operation === 'open' || operation === 'revalidate' ? await source.search({ query: 'launch' }) : undefined;
    const auditsBefore = f.audit.record.mock.calls.length;
    f.state.tickets.set('10001', { ...ticket(), key: 'OTHER-1', fields: { ...ticket().fields,
      project: { id: '99999', key: 'OTHER', self: `${origin}/rest/api/3/project/99999` } } });
    const result = operation === 'search' ? source.search({ query: 'launch' })
      : operation === 'list' ? source.list({})
      : operation === 'open' ? source.open({ item: first!.items[0]!.id }) : source.revalidate({});
    await expect(result).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.audit.record).toHaveBeenCalledTimes(auditsBefore);
  });

  it('refuses a different list project before provider reads while accepting the fixed project ID', async () => {
    const f = fixture(); const { source } = await f.make('ECHO'); f.request.mockClear();
    await expect(source.list({ container: 'OTHER' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.request).not.toHaveBeenCalled(); expect(f.audit.record).not.toHaveBeenCalled();
    await expect(source.list({ container: '10000' })).resolves.toMatchObject({ items: [{ kind: 'ticket' }] });
  });

  it.each(['before', 'during'] as const)('refuses a configured project key remapped to another ID %s a read', async moment => {
    const f = fixture(); const { source } = await f.make('ECHO');
    const remap = () => { f.state.project = { id: '99999', key: 'ECHO', self: `${origin}/rest/api/3/project/99999` }; };
    if (moment === 'before') remap();
    else f.state.hook = request => { if (request.path === `${prefix}/issue/10001`) remap(); };
    await expect(source.search({ query: 'launch' })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('rejects invalid trusted project selectors before any provider call', async () => {
    for (const fixedProject of ['', 'ECHO OR project = OTHER', `${origin}/browse/ECHO-1`]) {
      const f = fixture(); await expect(f.make(fixedProject)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(f.request).not.toHaveBeenCalled();
    }
  });

  it('releases normalized exact-read evidence, digests the bounded bytes and opens only issued handles', async () => {
    const f = fixture(); const { source } = await f.make();
    await expect(source.open({ item: '10001' })).rejects.toMatchObject({ code: 'not_found' });
    const result = await source.search({ query: 'launch' });
    const item = result.items[0]!;
    expect(item).toMatchObject({ kind: 'ticket', label: 'ECHO-1: Ship connector',
      visibility: 'only_me', attributes: { status: 'In progress', owner: 'Alex', due_at: '2026-10-02' }, occurred_at: '2026-09-30',
      citation: { ticket_id: '10001', external_scope_id: cloudid, permalink: `${origin}/browse/ECHO-1`, text_sha256: digest('') } });
    expect(item).not.toHaveProperty('text');
    expect(item).not.toHaveProperty('handle');
    expect(f.audit.record).toHaveBeenCalledTimes(1);
    expect(f.authorization.assertCurrent).toHaveBeenCalledTimes(3);
    const auditText = JSON.stringify(f.releases);
    for (const hidden of ['Ship connector', 'Launch Friday', 'launch', 'jira_item_', 'never-return', 'emailAddress']) expect(auditText).not.toContain(hidden);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,status,assignee,duedate' } }));
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/search/jql`, body: expect.objectContaining({ fields: ['id'], maxResults: 5 }) }));
    const opened = await source.open({ item: item.id });
    const text = 'ECHO-1: Ship connector\n\nLaunch Friday\n@Alex';
    expect(opened.items[0]).toMatchObject({ id: item.id, text, citation: { text_sha256: digest(text) } });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,status,assignee,duedate,description,issuelinks' } }));
    expect(f.audit.record).toHaveBeenCalledTimes(2);
    const second = await f.make();
    await expect(second.source.open({ item: item.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses another trusted actor, tenant, subject or grant before transport is called', async () => {
    for (const drift of [{ principal_id: 'someone-else' }, { membership_id: 'another-tenure' }, { external_scope_id: '00000000-0000-4000-8000-000000000008' },
      { external_subject_id: 'another-subject' }, { read_grant_sha256: canonicalSha256({ replacement: true }) }, { tool_id: 'slack' }]) {
      const f = fixture();
      await expect(createJiraPersonLiveEvidenceReaderV1({ binding: { ...binding, ...drift }, transport: f.transport })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.request).not.toHaveBeenCalled();
    }
  });

  it('verifies cloudid, exact read scopes and current active human account; email is never proof', async () => {
    const badResources = [[], [{ id: 'another-site', url: origin, scopes: ['read:jira-work', 'read:jira-user'] }],
      [{ id: cloudid, url: origin, scopes: ['read:jira-user'] }], [{ id: cloudid, url: origin, scopes: ['read:jira-work'] }],
      [{ id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }, { id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }]];
    for (const resources of badResources) {
      const f = fixture(); f.state.resources = resources;
      await expect(f.make()).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.audit.record).not.toHaveBeenCalled();
    }
    for (const drift of [{ accountId: 'another-subject' }, { active: false }, { accountType: 'app' }, { accountType: 'customer' }, { accountId: 'unknown' }]) {
      const f = fixture(); f.state.myself = { ...(f.state.myself as object), ...drift };
      await expect(f.make()).rejects.toMatchObject({ code: 'unauthorized' });
    }
    const f = fixture(); f.state.resources = [{ id: cloudid, url: 'https://confluence-fixture.atlassian.net', scopes: ['read:confluence-content.all'] }, ...(f.state.resources as object[])];
    const { source } = await f.make();
    expect((await source.search({ query: 'ship' })).items).toHaveLength(1);
  });

  it('refuses non-Cloud/unsafe site URLs, tenant drift and subject changes during a read', async () => {
    for (const url of ['http://echo-fixture.atlassian.net', 'https://evil.example.test', `${origin}:444`, `${origin}/nested`, `${origin}?token=synthetic`, 'https://person@echo-fixture.atlassian.net', 'https://echo-fixture.atlassian.net.evil.test']) {
      const f = fixture(); f.state.resources = [{ id: cloudid, url, scopes: ['read:jira-work', 'read:jira-user'] }];
      await expect(f.make()).rejects.toMatchObject({ code: 'invalid_output' });
    }
    for (const type of ['subject', 'origin', 'transport']) {
      const f = fixture(); const { source } = await f.make();
      f.state.hook = input => {
        if (!input.path.includes('/issue/')) return;
        if (type === 'subject') f.state.myself = { accountId: 'other-person', active: true, accountType: 'atlassian' };
        if (type === 'origin') f.state.resources = [{ id: cloudid, url: 'https://other-fixture.atlassian.net', scopes: ['read:jira-work', 'read:jira-user'] }];
        if (type === 'transport') Object.assign(f.transport.binding, { principal_id: 'another-person' });
      };
      await expect(source.search({ query: 'ship' })).rejects.toMatchObject({ code: type === 'subject' ? 'unauthorized' : 'stale_access_state' });
      expect(f.audit.record).not.toHaveBeenCalled();
    }
  });

  it('refuses denied exact reads and malformed issue payloads before any audit', async () => {
    for (const code of ['unauthorized', 'not_found'] as const) {
      const f = fixture(); const { source } = await f.make(); f.state.denied.set('10001', code);
      await expect(source.search({ query: 'ship' })).rejects.toMatchObject({ code, message: 'Live evidence operation could not be completed' });
      expect(f.audit.record).not.toHaveBeenCalled();
    }
    const good = ticket();
    const malformed = [null, { ...good, id: '10002' }, { ...good, self: 'https://other-fixture.atlassian.net/rest/api/3/issue/10001' },
      { ...good, self: `${origin}/rest/api/3/issue/10002` }, { ...good, key: 'WRONG-1' },
      ...[{ summary: {} }, { summary: 'private\u0000text' }, { status: null }, { created: '2026-02-30T12:00:00Z' }, { duedate: '2026-02-30' },
        { project: { ...project(), self: `${origin}/rest/api/3/project/99999` } }].map(fields => ({ ...good, fields: { ...good.fields, ...fields } }))];
    for (const bad of malformed) {
      const f = fixture(); const { source } = await f.make(); f.state.tickets.set('10001', bad);
      await expect(source.search({ query: 'ship' })).rejects.toMatchObject({ code: 'invalid_output' });
      expect(f.audit.record).not.toHaveBeenCalled();
    }
    const getter = vi.fn(() => 'private');
    const f = fixture(); const { source } = await f.make(); f.state.tickets.set('10001', Object.defineProperty(ticket(), 'fields', { enumerable: true, get: getter }));
    await expect(source.search({ query: 'ship' })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['not-v3-ADF', { type: 'doc', version: 1, content: [{ type: 'unknown' }] },
    { type: 'doc', version: 1, content: [{ type: 'text', text: '\u0000bad' }] }])('refuses malformed bodies on open after metadata discovery (%j)', async description => {
    const f = fixture(); const { source } = await f.make();
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, description } });
    const discovered = await source.search({ query: 'ship' });
    expect(discovered.items[0]).not.toHaveProperty('text');
    await expect(source.open({ item: discovered.items[0]!.id })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f.releases.map(release => release.operation)).toEqual(['search']);
  });

  it('opens a ticket containing an inline link card without fetching the linked page', async () => {
    const f = fixture();
    const url = 'https://never-fetch.example.test/walkthrough';
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, description: {
      type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Read ' }, { type: 'inlineCard', attrs: { url } }, { type: 'text', text: ' before the gate.' },
      ] }],
    } } });
    const { source } = await f.make();
    const inventory = await source.list({ limit: 1 });
    const opened = await source.open({ item: inventory.items[0]!.id });
    const text = `ECHO-1: Ship connector\n\nRead ${url} before the gate.`;
    expect(opened.items[0]).toMatchObject({ text, citation: { text_sha256: digest(text) } });
    expect(f.request.mock.calls.every(([request]) => request.path === '/oauth/token/accessible-resources' ||
      request.path === `${prefix}/myself` || request.path === `${prefix}/search/jql` || request.path === `${prefix}/issue/10001`)).toBe(true);
    await source.revalidate({});
  });

  it('searches and opens checklist tickets while preserving task completion in the cited text', async () => {
    const f = fixture();
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, description: {
      type: 'doc', version: 1, content: [{ type: 'taskList', attrs: { localId: 'private-list-id' }, content: [
        { type: 'taskItem', attrs: { localId: 'private-task-id', state: 'TODO' }, content: [
          { type: 'text', text: 'Review ' }, { type: 'text', text: 'gate', marks: [{ type: 'strong' }] },
        ] },
        { type: 'taskList', attrs: { localId: 'private-nested-id' }, content: [
          { type: 'taskItem', attrs: { localId: 'private-done-id', state: 'DONE' }, content: [{ type: 'text', text: 'Run tests' }] },
        ] },
      ] }],
    } } });
    f.state.pages = [page(['10002', '10001']), page()];
    const { source } = await f.make();
    const searched = await source.search({ query: 'gate' });
    expect(searched.items).toHaveLength(2);
    const text = 'ECHO-1: Ship connector\n\n[ ] Review gate\n[x] Run tests';
    expect(searched.items[1]).not.toHaveProperty('text');
    const selected = await source.open({ item: searched.items[1]!.id });
    expect(selected.items[0]).toMatchObject({ text, attributes: { status: 'In progress' }, citation: { text_sha256: digest(text) } });
    const inventory = await source.list({ limit: 1 });
    const opened = await source.open({ item: inventory.items[0]!.id });
    expect(opened.items[0]).toMatchObject({ text, citation: { text_sha256: digest(text) } });
    for (const hidden of ['Review gate', 'Run tests', 'private-task-id', 'private-list-id']) {
      expect(JSON.stringify(f.releases)).not.toContain(hidden);
    }
  });

  it.each([undefined, null, 'done', 'IN_PROGRESS'])('refuses a checklist with an unknown completion state (%j)', async state => {
    const f = fixture();
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, description: {
      type: 'doc', version: 1, content: [{ type: 'taskList', attrs: { localId: 'list' }, content: [
        { type: 'taskItem', attrs: { localId: 'task', ...(state === undefined ? {} : { state }) }, content: [{ type: 'text', text: 'Review gate' }] },
      ] }],
    } } });
    const { source } = await f.make();
    const discovered = await source.search({ query: 'gate' });
    await expect(source.open({ item: discovered.items[0]!.id })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f.releases.map(release => release.operation)).toEqual(['search']);
  });

  it.each(['ECHO-1', 'echo-1'])('uses exact issue-key search for %s', async query => {
    const f = fixture(); const { source } = await f.make();
    const result = await source.search({ query });
    expect(result.items).toHaveLength(1);
    expect(f.request.mock.calls.find(([request]) => request.path.endsWith('/search/jql'))![0].body?.jql)
      .toBe('key = "ECHO-1" ORDER BY created DESC, id DESC');
  });

  it('compiles keyword search as independent terms within the pinned project', async () => {
    const f = fixture(); const { source } = await f.make('ECHO');
    await source.search({ query: 'launch connector' });
    const request = f.request.mock.calls.find(([request]) => request.path.endsWith('/search/jql'))![0];
    expect(request.body?.jql).toBe('project = 10000 AND (text ~ "\\\"launch\\\"" AND text ~ "\\\"connector\\\"") ORDER BY created DESC, id DESC');
  });

  it.each([{}, { url: 7 }, { url: 'https://example.test/\u0000' }, { url: 'https://example.test', data: {} }])('refuses malformed inline link cards (%j)', async attrs => {
    const f = fixture();
    f.state.tickets.set('10001', { ...ticket(), fields: { ...ticket().fields, description: {
      type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs }] }],
    } } });
    const { source } = await f.make();
    const discovered = await source.search({ query: 'ship' });
    await expect(source.open({ item: discovered.items[0]!.id })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f.releases.map(release => release.operation)).toEqual(['search']);
  });

  it('bounds NFC text by UTF-8 bytes before hashing, with aggregate releases accepted by the wrapper', async () => {
    const f = fixture();
    f.state.pages = [page(Array.from({ length: 5 }, (_, i) => String(10001 + i)))];
    for (let i = 0; i < 5; i++) f.state.tickets.set(String(10001 + i), { ...ticket(String(10001 + i), 'Cafe\u0301'), fields: { ...ticket().fields, summary: 'Cafe\u0301', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '\t😀'.repeat(3000) }] }] } } });
    const { source } = await f.make(); const result = await source.search({ query: 'launch', limit: 50 });
    expect(result.items).toHaveLength(5);
    for (const discovered of result.items) {
      expect(discovered).not.toHaveProperty('text');
      const opened = await source.open({ item: discovered.id });
      expect(opened.truncated).toBe(true);
      const item = opened.items[0]!;
      expect(Buffer.byteLength(item.text!, 'utf8')).toBeLessThanOrEqual(3072);
      expect(item.text).toBe(item.text!.normalize('NFC'));
      expect(item.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(item.citation.text_sha256).toBe(digest(item.text!));
    }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
  });

  it('keeps query operators literal and connection/grant selectors outside method arguments', async () => {
    const f = fixture(); const { source, reader } = await f.make();
    await source.search({ query: 'hello" OR project = SECRET' });
    const request = f.request.mock.calls.find(([r]) => r.path.endsWith('/search/jql'))![0];
    const literals = ['"hello\\""', '"OR"', '"project"', '"="', '"SECRET"'];
    expect(request.body!.jql).toBe(literals.map(value => `text ~ ${JSON.stringify(value)}`).join(' AND ') + ' ORDER BY created DESC, id DESC');
    expect(Object.isFrozen(reader.binding)).toBe(true);
    f.state.pages = [page()];
    await reader.search({ query: 'ECHO-1', limit: 1, ...{ person: 'another-person', cloudid: 'another-site', connectionId: 'another-connection' } });
    expect(f.request.mock.calls.filter(([r]) => r.path.endsWith('/search/jql')).at(-1)![0].body!.jql).toBe('key = "ECHO-1" ORDER BY created DESC, id DESC');
    expect(f.request.mock.calls.every(([r]) => !r.path.includes('another'))).toBe(true);
  });

  it('counts repeated keywords once when compiling a bounded query', async () => {
    const f = fixture(); const { source } = await f.make();
    await source.search({ query: Array.from({ length: 40 }, (_, i) => i % 2 === 0 ? 'MRD' : 'mrd').join(' ') });
    const request = f.request.mock.calls.find(([r]) => r.path.endsWith('/search/jql'))![0];
    expect(request.body!.jql).toBe(`text ~ ${JSON.stringify('"mrd"')} ORDER BY created DESC, id DESC`);
  });

  it('lists metadata with opaque request-bound pagination and validates the project and date selection', async () => {
    const f = fixture(); f.state.pages = [page(['10001'], 'private-provider-token'), page(['10002'])];
    const { source, reader } = await f.make();
    const first = await source.list({ container: 'ECHO', since: '2026-09-01', until: '2026-10-01', limit: 1 });
    expect(first.items[0]).not.toHaveProperty('text');
    expect(first.items[0]!.citation.text_sha256).toBe(digest(''));
    expect(first.next_cursor).not.toContain('private-provider-token');
    expect(JSON.stringify(f.releases)).not.toContain('private-provider-token');
    for (const input of [{ container: 'ECHO', cursor: first.next_cursor }, { container: 'OTHER', since: '2026-09-01', until: '2026-10-01', cursor: first.next_cursor }]) await expect(source.list(input)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(reader.list({ container: 'ECHO', limit: 1, cursor: 'private-provider-token' })).rejects.toMatchObject({ code: 'invalid_request' });
    const other = await f.make();
    await expect(other.source.list({ container: 'ECHO', since: '2026-09-01', until: '2026-10-01', cursor: first.next_cursor })).rejects.toMatchObject({ code: 'invalid_request' });
    const second = await source.list({ container: 'ECHO', since: '2026-09-01', until: '2026-10-01', cursor: first.next_cursor, limit: 1 });
    expect(second.items[0]!.citation.ticket_id).toBe('10002'); expect(second.next_cursor).toBeUndefined();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ body: { jql: 'project = 10000 ORDER BY created DESC, id DESC', maxResults: 1, fields: ['id'], nextPageToken: 'private-provider-token' } }));
    await source.open({ item: first.items[0]!.id });
    expect(f.releases.at(-1)!.operation).toBe('open');
  });

  it('filters UTC dates inclusively and audits empty pages while advancing pagination', async () => {
    const f = fixture(); f.state.pages = [page(['10001'], 'page-2'), page(['10002'])];
    f.state.tickets.set('10002', { ...ticket('10002'), fields: { ...ticket().fields, created: '2026-09-30T23:30:00.000-0700' } });
    const { source } = await f.make();
    const first = await source.list({ since: '2026-10-01', until: '2026-10-01', limit: 1 });
    expect(first.items).toEqual([]); expect(first.next_cursor).toBeDefined();
    const second = await source.list({ since: '2026-10-01', until: '2026-10-01', limit: 1, cursor: first.next_cursor });
    expect(second.items[0]!.occurred_at).toBe('2026-10-01');
    expect(f.releases[0]!.citations).toEqual([]); expect(f.releases).toHaveLength(2);
  });

  it('refuses malformed search pages, repeated cursors/IDs and project mismatches', async () => {
    for (const malformed of [{ issues: [{ id: '10001' }] }, { isLast: false, issues: [] }, { isLast: true, issues: [], nextPageToken: 'bad' },
      page(['10001', '10001']), { isLast: true, issues: Array(1) }, page(['bad-id'])]) {
      const f = fixture(); const { source } = await f.make(); f.state.pages = [malformed];
      await expect(source.search({ query: 'ship' })).rejects.toMatchObject({ code: 'invalid_output' }); expect(f.audit.record).not.toHaveBeenCalled();
    }
    for (const next of [page(['10002'], 'loop'), page(['10001'])]) {
      const f = fixture(); f.state.pages = [page(['10001'], 'loop'), next]; const { source } = await f.make();
      const first = await source.list({ container: 'ECHO', limit: 1 });
      await expect(source.list({ container: 'ECHO', limit: 1, cursor: first.next_cursor })).rejects.toMatchObject({ code: 'invalid_output' });
      expect(f.audit.record).toHaveBeenCalledTimes(1);
    }
    const f = fixture(); const { source } = await f.make(); f.state.project = { id: '99999', key: 'ECHO', self: `${origin}/rest/api/3/project/99999` };
    await expect(source.list({ container: 'ECHO' })).rejects.toMatchObject({ code: 'invalid_output' }); expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('revalidates every inventory and earlier text citation; changed visibility stops reuse', async () => {
    const f = fixture(); f.state.pages = [page(['10001', '10002']), page(['10001'])];
    const { source, reader } = await f.make();
    const inventory = await source.list({ container: 'ECHO' });
    const original = await source.open({ item: inventory.items[0]!.id });
    f.state.tickets.set('10001', ticket('10001', 'Edited after first read'));
    const edited = await source.search({ query: 'edited' });
    expect(original.items[0]!.citation.text_sha256).not.toBe(edited.items[0]!.citation.text_sha256);
    f.request.mockClear(); await source.revalidate({});
    expect(f.request.mock.calls.filter(([r]) => r.path.includes('/issue/')).map(([r]) => r.body?.issueIdsOrKeys)).toEqual([['10001', '10002']]);
    await expect(reader.revalidate({ citations: [{ ...inventory.items[0]!.citation, permalink: `${origin}/browse/ECHO-999` }] })).rejects.toMatchObject({ code: 'unauthorized' });
    f.state.denied.set('10002', 'not_found');
    await expect(source.revalidate({})).rejects.toMatchObject({ code: 'not_found' });
    f.state.denied.clear(); f.state.myself = { accountId: 'changed', active: true, accountType: 'atlassian' };
    await expect(source.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('checks every released issue in bounded batches and accepts a different response order', async () => {
    const f = fixture(); const ids = Array.from({ length: 107 }, (_, index) => String(10001 + index));
    for (const id of ids) f.state.tickets.set(id, ticket(id));
    f.state.pages = [];
    for (let index = 0; index < ids.length; index += 20) f.state.pages.push(page(ids.slice(index, index + 20)));
    const { source } = await f.make('ECHO');
    while (f.state.pages.length > 0) await source.list({ limit: 20 });
    f.state.hook = input => {
      if (input.path === `${prefix}/issue/bulkfetch`) f.state.bulkResponse = { issues: [...input.body!.issueIdsOrKeys as string[]].reverse().map(id => ticket(id)), issueErrors: [] };
    };
    f.request.mockClear();
    await source.revalidate({});
    const batches = f.request.mock.calls.map(([request]) => request).filter(request => request.path === `${prefix}/issue/bulkfetch`);
    expect(batches.map(request => (request.body!.issueIdsOrKeys as string[]).length)).toEqual([50, 50, 7]);
    expect(batches.flatMap(request => request.body!.issueIdsOrKeys)).toEqual(ids);
    expect(batches.every(request => request.method === 'POST' && !(request.body!.fields as string[]).includes('description'))).toBe(true);
  });

  it.each([
    ['missing', { issues: [ticket()] }, 'not_found'],
    ['duplicate', { issues: [ticket(), ticket()] }, 'invalid_output'],
    ['unexpected', { issues: [ticket(), ticket('10003')] }, 'invalid_output'],
    ['oversized', { issues: [ticket(), ticket('10002'), ticket('10003')] }, 'invalid_output'],
    ['provider error', { issues: [ticket()], issueErrors: [{ id: '10002', errorMessage: 'private provider detail' }] }, 'unavailable'],
    ['malformed errors', { issues: [ticket(), ticket('10002')], issueErrors: {} }, 'invalid_output'],
  ] as const)('withholds release for a %s bulk permission response', async (_label, response, code) => {
    const f = fixture(); f.state.pages = [page(['10001', '10002'])];
    const { source } = await f.make('ECHO'); await source.list({});
    const auditsBefore = f.audit.record.mock.calls.length;
    f.state.bulkResponse = response;
    await expect(source.revalidate({})).rejects.toMatchObject({ code, message: 'Live evidence operation could not be completed' });
    expect(f.audit.record).toHaveBeenCalledTimes(auditsBefore);
  });

  it('cancels between permission batches without fetching the remaining issues', async () => {
    const f = fixture(); const ids = Array.from({ length: 51 }, (_, index) => String(10001 + index));
    for (const id of ids) f.state.tickets.set(id, ticket(id));
    f.state.pages = [page(ids.slice(0, 20)), page(ids.slice(20, 40)), page(ids.slice(40))];
    const { source } = await f.make('ECHO');
    while (f.state.pages.length > 0) await source.list({ limit: 20 });
    const controller = new AbortController();
    f.state.hook = input => { if (input.path === `${prefix}/issue/bulkfetch`) controller.abort(); };
    f.request.mockClear();
    await expect(source.revalidate({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.request.mock.calls.filter(([request]) => request.path === `${prefix}/issue/bulkfetch`)).toHaveLength(1);
  });

  it('fails closed on audit failure, ECHO grant changes and cancellation with no evidence release', async () => {
    for (const failure of ['audit', 'grant', 'abort']) {
      const f = fixture(); const { source } = await f.make(); const controller = new AbortController();
      if (failure === 'audit') f.audit.record.mockRejectedValueOnce(new Error('private raw ticket and synthetic bearer'));
      if (failure === 'grant') f.authorization.assertCurrent.mockImplementationOnce(() => { throw new AuthorityOperationError('stale_access_state', 'private grant'); });
      if (failure === 'abort') f.state.hook = input => { expect(input.signal).toBe(controller.signal); if (input.path.includes('/issue/')) controller.abort(); };
      await expect(source.search({ query: 'ship', signal: controller.signal })).rejects.toMatchObject(failure === 'abort' ? { name: 'AbortError' } : { code: failure === 'audit' ? 'unavailable' : 'stale_access_state', message: 'Live evidence operation could not be completed' });
      if (failure !== 'audit') expect(f.audit.record).not.toHaveBeenCalled();
    }
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(createJiraPersonLiveEvidenceReaderV1({ binding, transport: f.transport, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('bounds caller input and refuses URL/JQL containers before transport', async () => {
    const f = fixture(); const { reader } = await f.make(); f.request.mockClear();
    for (const input of [{ container: 'ECHO OR project = SECRET', limit: 1 }, { container: `${origin}/browse/ECHO-1`, limit: 1 },
      { since: '2026-02-30', limit: 1 }, { since: '2026-10-01', until: '2026-09-01', limit: 1 }, { limit: 51 }, { limit: 0 }]) await expect(reader.list(input)).rejects.toMatchObject({ code: 'invalid_request' });
    for (const query of ['', 'x'.repeat(1025), 'bad\nquery']) await expect(reader.search({ query, limit: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe('Jira open by an earlier citation (background trigger starting evidence)', () => {
  const earlier = (ticketId: string, scope = cloudid): PersonTicketCitationV1 => ({ kind: 'ticket', tool_id: 'jira', external_scope_id: scope,
    ticket_id: ticketId, permalink: `${origin}/browse/ECHO-${Number(ticketId) - 10000}`, text_sha256: digest('an older body') as `sha256:${string}` });

  it('re-reads the current ticket body through the exact read and audits it as an open', async () => {
    const f = fixture();
    const { source } = await f.make('ECHO');
    const result = await source.openCitation!({ citation: earlier('10002') });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: 'ticket', label: 'ECHO-2: Review security', attributes: { status: 'In progress' } });
    expect(result.items[0]!.text).toContain('Launch Friday');
    expect(result.items[0]!.citation.text_sha256).not.toBe(digest('an older body'));
    expect(f.releases.at(-1)).toMatchObject({ operation: 'open' });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10002` }));
  });

  it('refuses a citation from another Jira site', async () => {
    const f = fixture();
    const { source } = await f.make('ECHO');
    await expect(source.openCitation!({ citation: earlier('10001', '00000000-0000-4000-8000-000000000099') })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.releases).toHaveLength(0);
  });

  it('refuses a ticket outside the pinned project', async () => {
    const f = fixture();
    const base = ticket('10003');
    f.state.tickets.set('10003', { ...base, key: 'OTHER-3', fields: { ...base.fields, project: { id: '20000', key: 'OTHER', self: `${origin}/rest/api/3/project/20000`, name: 'Other' } } });
    const { source } = await f.make('ECHO');
    await expect(source.openCitation!({ citation: earlier('10003') })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.releases).toHaveLength(0);
  });

  it('is unavailable through a reader that cannot open citations', async () => {
    const f = fixture();
    const { reader } = await f.make('ECHO');
    const { openCitation: _openCitation, ...bare } = reader;
    const source = createAuditedPersonLiveEvidenceSourceV1({ actor: binding,
      access: { tool_id: 'jira', identity_status: 'linked', external_scope_id: cloudid, external_subject_id: binding.external_subject_id, read_status: 'connected', read_capabilities: ['live_evidence'] },
      read_grant_sha256: binding.read_grant_sha256, reader: bare, authorization: f.authorization, audit: f.audit });
    await expect(source.openCitation!({ citation: earlier('10001') })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
