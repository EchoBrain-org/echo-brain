import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { observeCoreRuntimeV1, withCoreRuntimeDiagnosticToolV1, type CoreRuntimeDiagnosticObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
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
const withFields = (fields: Record<string, unknown>, base = ticket()) => ({ ...base, fields: { ...base.fields, ...fields } });
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
    if (input.path === `${prefix}/issue/bulkfetch`) {
      if (f.bulkResponse !== undefined) return f.bulkResponse;
      // Like Jira, an id or a key; unknown and hidden issues are simply omitted.
      const resolve = (idOrKey: string) => f.tickets.has(idOrKey) ? idOrKey : [...f.tickets.entries()].find(([, value]) => (value as { key?: string } | null)?.key === idOrKey)?.[0];
      const ids = (input.body!.issueIdsOrKeys as string[]).map(resolve).filter((id): id is string => id !== undefined && !f.denied.has(id));
      return { issues: ids.map(id => f.tickets.get(id)), issueErrors: [] };
    }
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
  const jqls = () => request.mock.calls.filter(([input]) => input.path.endsWith('/search/jql')).map(([input]) => input.body?.jql);
  return { ...f, state: f, request, transport, authorization, releases, audit, make, jqls };
}

describe('person-bound Jira live reader through the shared audited wrapper', () => {
  it('captures the exact generated JQL only in diagnostics and preserves concurrent tool identity', async () => {
    const f = fixture(); const { reader } = await f.make('ECHO');
    const diagnostics: CoreRuntimeDiagnosticObservationV1[] = [];
    const metadata: unknown[] = [];
    await observeCoreRuntimeV1('research_run', () => Promise.all(['DVT accuracy', 'ECHO-1'].map((query, index) =>
      withCoreRuntimeDiagnosticToolV1({ tool_call_id: index + 1, round: 1 }, () => reader.search({ query, limit: 5 })))), {
      diagnostic_observer: event => { diagnostics.push(event); }, observer: event => { metadata.push(event); },
    });
    const queries = diagnostics.filter(event => event.kind === 'provider_query');
    expect(queries).toHaveLength(2);
    const text = queries.find(query => query.query.includes('DVT'))!;
    expect(f.request.mock.calls).toContainEqual([
      expect.objectContaining({ path: `${prefix}/search/jql`, body: expect.objectContaining({ jql: text.query, maxResults: text.max_results }) }),
    ]);
    // A key lookup is named in JQL form but runs as a bulk issue read.
    const key = queries.find(query => query.query.includes('ECHO-1'))!;
    expect(key).toMatchObject({ query: 'key in ("ECHO-1")', max_results: 1 });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/bulkfetch`, body: expect.objectContaining({ issueIdsOrKeys: ['ECHO-1'] }) }));
    expect(text.tool_context).toEqual({ tool_call_id: 1, round: 1 });
    expect(key.tool_context).toEqual({ tool_call_id: 2, round: 1 });
    expect(JSON.stringify(metadata)).not.toContain('DVT');
  });
  it('combines keywords with updated/due bounds in the client zone and preserves date meanings', async () => {
    const f = fixture();
    f.state.tickets.set('10001', withFields({ created: '2026-09-01T12:00:00Z', updated: '2026-10-17T01:00:00Z', duedate: '2026-10-20' }));
    const { source } = await f.make();
    const dates = { since: '2026-10-16', until: '2026-10-16', date_field: 'updated' as const, time_zone: 'America/Los_Angeles' };
    const result = await source.search({ query: 'ECHO-1', ...dates });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.dates).toEqual({ created: '2026-09-01T12:00:00.000Z', updated: '2026-10-17T01:00:00.000Z', due: '2026-10-20' });
    expect((await source.search({ query: 'ECHO-1', ...dates, time_zone: 'UTC' })).items).toEqual([]);
    expect((await source.search({ query: 'ECHO-1', since: '2026-10-20', until: '2026-10-20', date_field: 'due', time_zone: 'Pacific/Auckland' })).items).toHaveLength(1);
    f.state.pages = [page()];
    expect((await source.list({ ...dates })).items).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ jql: expect.stringContaining('updated >=') }) }));
    await expect(source.list({ since: '2026-02-30' })).rejects.toMatchObject({ code: 'invalid_request' });
    // A date field Jira does not record is refused, never answered empty or swapped for another (ADR-0041, addition 3).
    const requests = f.request.mock.calls.length;
    for (const date_field of ['occurred', 'received'] as const) {
      await expect(source.list({ since: '2026-10-16', until: '2026-10-16', date_field })).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(source.search({ query: 'ECHO-1', since: '2026-10-16', until: '2026-10-16', date_field })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(f.request.mock.calls.length).toBe(requests);
    await source.revalidate({});
  });

  it('reads a 25-ticket inventory page with one permission-applying bulk fetch, in discovery order', async () => {
    const f = fixture();
    const ids = Array.from({ length: 25 }, (_, index) => String(10025 - index));
    for (const id of ids) f.state.tickets.set(id, ticket(id));
    f.state.pages = [page(ids)];
    // Jira returns bulk results in ascending id order; discovery order is newest first.
    f.state.hook = input => {
      if (input.path === `${prefix}/issue/bulkfetch`) f.state.bulkResponse = { issues: [...input.body!.issueIdsOrKeys as string[]].sort().map(id => ticket(id)), issueErrors: [] };
    };
    const { source } = await f.make();
    f.request.mockClear();
    const result = await source.list({ limit: 50 });
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(ids);
    expect(result.items.every(item => !('text' in item))).toBe(true);
    const reads = f.request.mock.calls.map(([request]) => request).filter(request => request.path.includes('/issue/'));
    expect(reads).toEqual([expect.objectContaining({ path: `${prefix}/issue/bulkfetch`, method: 'POST',
      body: { issueIdsOrKeys: ids, fields: ['summary', 'project', 'created', 'updated', 'status', 'assignee', 'duedate'] } })]);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/search/jql`, body: expect.objectContaining({ maxResults: 25, fields: ['id'] }) }));
    expect(f.audit.record).toHaveBeenCalledTimes(1);
  });

  it('says when a last page was exactly full, so its end is unverified, and never when the end is confirmed (ADR-0041)', async () => {
    const f = fixture();
    const ids = Array.from({ length: 25 }, (_, index) => String(10025 - index));
    for (const id of ids) f.state.tickets.set(id, withFields({ created: '2026-10-04T12:00:00Z' }, ticket(id)));
    // isLast with all 25 asked for, isLast with fewer, and a page with a next token.
    f.state.pages = [page(ids), page(ids.slice(0, 24)), page(ids, 'next')];
    const { source } = await f.make();
    expect(await source.list({ limit: 50 })).toMatchObject({ truncated: false, page_full: true });
    expect(await source.list({ limit: 50 })).toMatchObject({ truncated: false, page_full: false });
    const continued = await source.list({ limit: 50 });
    expect(continued).toMatchObject({ truncated: true, page_full: false, next_cursor: expect.any(String) });
    // Newest first, a full page whose oldest issue predates since confirms the end without its token.
    for (const id of ids.slice(-1)) f.state.tickets.set(id, withFields({ created: '2026-10-01T12:00:00Z' }, ticket(id)));
    f.state.pages = [page(ids, 'next')];
    const dated = await source.list({ limit: 50, since: '2026-10-03' });
    expect(dated).toMatchObject({ truncated: false, page_full: false });
    expect(dated).not.toHaveProperty('next_cursor');
    expect(dated.items).toHaveLength(24);
    // The audit never records it.
    expect(JSON.stringify(f.releases)).not.toContain('page_full');
  });

  it('keeps a full list page of worst-case metadata inside the shared result bound', async () => {
    const f = fixture();
    const ids = Array.from({ length: 30 }, (_, index) => String(10030 - index));
    // Quotes double under JSON escaping: the largest label, owner and status the parser admits.
    for (const id of ids) f.state.tickets.set(id, withFields({ summary: '"'.repeat(300), assignee: { displayName: '"'.repeat(128) }, status: { name: '"'.repeat(128) } }, ticket(id)));
    f.state.pages = [page(ids.slice(0, 25), 'next')];
    const { source } = await f.make();
    const result = await source.list({ limit: 50 });
    expect(result.items).toHaveLength(25);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
  });

  it('gives a hit the bulk fetch omits its own exact read, keeping order and the exact refusal', async () => {
    const f = fixture();
    f.state.pages = [page(['10002', '10001'])];
    f.state.hook = input => {
      if (input.path === `${prefix}/issue/bulkfetch`) f.state.bulkResponse = { issues: [ticket('10002', 'Review security')], issueErrors: [] };
    };
    const { source } = await f.make();
    f.request.mockClear();
    const result = await source.list({});
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(['10002', '10001']);
    expect(f.request.mock.calls.map(([request]) => request.path).filter(path => path.includes('/issue/'))).toEqual([`${prefix}/issue/bulkfetch`, `${prefix}/issue/10001`]);

    for (const code of ['unauthorized', 'not_found'] as const) {
      const denied = fixture(); denied.state.pages = [page(['10002', '10001'])]; denied.state.denied.set('10001', code);
      const made = await denied.make();
      await expect(made.source.list({})).rejects.toMatchObject({ code });
      expect(denied.audit.record).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['provider error', { issues: [ticket()], issueErrors: [{ id: '10002', errorMessage: 'private provider detail' }] }, 'unavailable'],
    ['unexpected issue', { issues: [ticket(), ticket('10003')], issueErrors: [] }, 'invalid_output'],
    ['duplicate issue', { issues: [ticket(), ticket()], issueErrors: [] }, 'invalid_output'],
    ['other project', { issues: [{ ...withFields({ project: { id: '99999', key: 'OTHER', self: `${origin}/rest/api/3/project/99999` } }), key: 'OTHER-1' }], issueErrors: [] }, 'unauthorized'],
  ] as const)('withholds a discovered page for a %s bulk response', async (_label, response, code) => {
    const f = fixture(); f.state.pages = [page(['10001', '10002'])]; f.state.bulkResponse = response;
    const { source } = await f.make('ECHO');
    await expect(source.list({})).rejects.toMatchObject({ code, message: 'Live evidence operation could not be completed' });
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(JSON.stringify(f.releases)).not.toContain('private provider detail');
  });
  it('shares only queued connection checks and keeps post-read fences independent', async () => {
    const f = fixture(); const { reader } = await f.make('ECHO');
    const verificationReads = () => f.request.mock.calls.filter(([request]) =>
      request.path === '/oauth/token/accessible-resources' || request.path === `${prefix}/myself` || request.path === `${prefix}/project/ECHO`);
    f.request.mockClear();

    await Promise.all([reader.search({ query: 'ship', limit: 1 }), reader.search({ query: 'ship', limit: 1 })]);
    // The two pre-read checks queue together (3 reads). Both single bulk
    // reads finish in the same turn, so their post-read fences also queue
    // together and share one check that starts after both reads (3 + 3).
    expect(verificationReads()).toHaveLength(6);

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
    f.state.tickets.set('10001', withFields({ issuelinks: [
      { outwardIssue: { id: '10007' } }, { inwardIssue: { id: '10003' } }, { outwardIssue: { id: '10002' } },
      { inwardIssue: { id: '10003' } }, { outwardIssue: { id: '10001' } }, { outwardIssue: { id: '10006' } },
      { inwardIssue: { id: '10005' } }, { outwardIssue: { id: '10004' } },
    ] }));
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
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,updated,status,assignee,duedate,description,issuelinks' } }));
    for (const id of ['10002', '10003', '10004', '10005']) {
      expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/${id}`, query: { fields: 'summary,project,created,updated,status,assignee,duedate' } }));
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
    f.state.tickets.set('10001', withFields({ issuelinks: Array.from({ length: 65 }, (_, index) => ({ outwardIssue: { id: String(10002 + index) } })) }));
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
    f.state.tickets.set('10001', withFields({ issuelinks: [{ outwardIssue: { id: '10002' } }] }));
    f.state.denied.set('10002', 'unauthorized');
    const { source } = await f.make('ECHO');
    const discovered = (await source.search({ query: 'ship' })).items[0]!;
    f.request.mockClear();

    const refreshed = await source.openCitation!({ citation: discovered.citation });

    expect(refreshed.items).toHaveLength(1);
    expect(refreshed.items[0]).toMatchObject({ citation: { ticket_id: '10001' }, text: 'ECHO-1: Ship connector\n\nLaunch Friday\n@Alex' });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,updated,status,assignee,duedate,description' } }));
    expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10002` }));
  });

  it('omits an inaccessible or out-of-project linked issue without leaking its metadata', async () => {
    for (const state of ['outside_project', 'denied'] as const) {
      const f = fixture();
      const related = ticket('10002', 'Private linked issue');
      f.state.tickets.set('10002', state === 'outside_project' ? { ...related, key: 'OTHER-2', fields: { ...related.fields,
        project: { id: '20000', key: 'OTHER', self: `${origin}/rest/api/3/project/20000` } } } : related);
      f.state.tickets.set('10001', withFields({ issuelinks: [{ outwardIssue: { id: '10002' } }] }));
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
    f.state.tickets.set('10001', withFields({ issuelinks: [{ outwardIssue: { id: '10002' } }] }));
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
    f.state.tickets.set('10001', withFields({ issuelinks: [
      { outwardIssue: { id: '10003' } }, { inwardIssue: { id: '10002' } },
    ] }));
    const { source } = await f.make('ECHO');
    const anchor = (await source.search({ query: 'ship' })).items[0]!;
    const limited = await source.open({ item: anchor.id, limit: 2 });
    expect(limited.items.map(item => item.citation.ticket_id)).toEqual(['10001', '10002']);
    expect(limited.truncated).toBe(true);

    const malformed = fixture();
    malformed.state.tickets.set('10001', withFields({ issuelinks: [{ outwardIssue: { id: '10002' }, inwardIssue: { id: '10003' } }] }));
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
    expect(f.jqls()[0]).toBe('created >= "1970-01-01" ORDER BY created DESC, id DESC');
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
    expect(f.jqls()[0]).toBe('project = 10000 ORDER BY created DESC, id DESC');
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
    const f = fixture(); f.state.pages = [page(), page()];
    const { source } = await f.make('ECHO');
    await source.search({ query: 'launch' });
    expect((await source.search({ query: 'ECHO-1' })).items.map(item => item.citation.ticket_id)).toEqual(['10001']);
    expect((await source.list({})).items.map(item => item.citation.ticket_id)).toEqual(['10001']);
    expect(f.jqls()).toEqual([
      'project = 10000 AND (text ~ "\\\"launch\\\"") ORDER BY created DESC, id DESC',
      'project = 10000 ORDER BY created DESC, id DESC',
    ]);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/project/ECHO` }));
  });

  it('drops a named key outside the pinned project as no match, without releasing it', async () => {
    const f = fixture();
    const other = ticket('10002', 'Private other project');
    f.state.tickets.set('10002', { ...other, key: 'OTHER-2', fields: { ...other.fields, project: { id: '20000', key: 'OTHER', self: `${origin}/rest/api/3/project/20000` } } });
    const { source } = await f.make('ECHO');
    const result = await source.search({ query: 'OTHER-2' });
    expect(result.items).toEqual([]);
    expect(f.jqls()).toEqual([]);
    expect(JSON.stringify(f.releases)).not.toContain('OTHER-2');
    expect(JSON.stringify(f.releases)).not.toContain('Private other project');
  });

  it.each(['search', 'list', 'open', 'revalidate'] as const)('refuses an exact issue outside the pinned project during %s', async operation => {
    const f = fixture(); const { source } = await f.make('ECHO');
    const first = operation === 'open' || operation === 'revalidate' ? await source.search({ query: 'launch' }) : undefined;
    const auditsBefore = f.audit.record.mock.calls.length;
    f.state.tickets.set('10001', { ...withFields({ project: { id: '99999', key: 'OTHER', self: `${origin}/rest/api/3/project/99999` } }), key: 'OTHER-1' });
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
    else f.state.hook = request => { if (request.path === `${prefix}/issue/bulkfetch`) remap(); };
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
    expect(item).toMatchObject({ kind: 'ticket', label: 'ECHO-1: Ship connector', date_kind: 'created',
      visibility: 'only_me', attributes: { status: 'In progress', owner: 'Alex', due_at: '2026-10-02' }, occurred_at: '2026-09-30',
      citation: { ticket_id: '10001', external_scope_id: cloudid, permalink: `${origin}/browse/ECHO-1`, text_sha256: digest('') } });
    expect(item).not.toHaveProperty('text');
    expect(item).not.toHaveProperty('handle');
    expect(f.audit.record).toHaveBeenCalledTimes(1);
    expect(f.authorization.assertCurrent).toHaveBeenCalledTimes(3);
    const auditText = JSON.stringify(f.releases);
    for (const hidden of ['Ship connector', 'Launch Friday', 'launch', 'jira_item_', 'never-return', 'emailAddress']) expect(auditText).not.toContain(hidden);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/bulkfetch`, body: { issueIdsOrKeys: ['10001'], fields: ['summary', 'project', 'created', 'updated', 'status', 'assignee', 'duedate'] } }));
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/search/jql`, body: expect.objectContaining({ fields: ['id'], maxResults: 5 }) }));
    expect(f.request.mock.calls.filter(([request]) => request.path.includes('/issue/')).every(([request]) => !(request.body?.fields as string[] | undefined)?.includes('description'))).toBe(true);
    expect(f.request.mock.calls.filter(([request]) => request.path.includes('/issue/')).every(([request]) => !request.query?.fields?.includes('description'))).toBe(true);
    const opened = await source.open({ item: item.id });
    const text = 'ECHO-1: Ship connector\n\nLaunch Friday\n@Alex';
    expect(opened.items[0]).toMatchObject({ id: item.id, text, citation: { text_sha256: digest(text) } });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project,created,updated,status,assignee,duedate,description,issuelinks' } }));
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

  const checklist = (state: unknown) => ({ type: 'doc', version: 1, content: [{ type: 'taskList', attrs: { localId: 'list' }, content: [
    { type: 'taskItem', attrs: { localId: 'task', ...(state === undefined ? {} : { state }) }, content: [{ type: 'text', text: 'Review gate' }] },
  ] }] });
  const inlineCard = (attrs: unknown) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs }] }] });
  it.each<[string, unknown]>([
    ['non-ADF body', 'not-v3-ADF'],
    ['unknown body node', { type: 'doc', version: 1, content: [{ type: 'unknown' }] }],
    ['NUL body text', { type: 'doc', version: 1, content: [{ type: 'text', text: '\u0000bad' }] }],
    ...[undefined, null, 'done', 'IN_PROGRESS'].map((state): [string, unknown] => [`checklist completion state ${JSON.stringify(state)}`, checklist(state)]),
    ...[{}, { url: 7 }, { url: 'https://example.test/\u0000' }, { url: 'https://example.test', data: {} }]
      .map((attrs): [string, unknown] => [`inline link card ${JSON.stringify(attrs)}`, inlineCard(attrs)]),
  ])('refuses a malformed %s on open after metadata discovery', async (_name, description) => {
    const f = fixture();
    f.state.tickets.set('10001', withFields({ description }));
    const { source } = await f.make();
    const discovered = await source.search({ query: 'ship' });
    expect(discovered.items[0]).not.toHaveProperty('text');
    await expect(source.open({ item: discovered.items[0]!.id })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f.releases.map(release => release.operation)).toEqual(['search']);
  });

  it('opens a ticket containing an inline link card without fetching the linked page', async () => {
    const f = fixture();
    const url = 'https://never-fetch.example.test/walkthrough';
    f.state.tickets.set('10001', withFields({ description: {
      type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Read ' }, { type: 'inlineCard', attrs: { url } }, { type: 'text', text: ' before the gate.' },
      ] }],
    } }));
    const { source } = await f.make();
    const inventory = await source.list({ limit: 1 });
    const opened = await source.open({ item: inventory.items[0]!.id });
    const text = `ECHO-1: Ship connector\n\nRead ${url} before the gate.`;
    expect(opened.items[0]).toMatchObject({ text, citation: { text_sha256: digest(text) } });
    expect(f.request.mock.calls.every(([request]) => request.path === '/oauth/token/accessible-resources' ||
      request.path === `${prefix}/myself` || request.path === `${prefix}/search/jql` || request.path === `${prefix}/issue/bulkfetch` || request.path === `${prefix}/issue/10001`)).toBe(true);
    await source.revalidate({});
  });

  it('searches and opens checklist tickets while preserving task completion in the cited text', async () => {
    const f = fixture();
    f.state.tickets.set('10001', withFields({ description: {
      type: 'doc', version: 1, content: [{ type: 'taskList', attrs: { localId: 'private-list-id' }, content: [
        { type: 'taskItem', attrs: { localId: 'private-task-id', state: 'TODO' }, content: [
          { type: 'text', text: 'Review ' }, { type: 'text', text: 'gate', marks: [{ type: 'strong' }] },
        ] },
        { type: 'taskList', attrs: { localId: 'private-nested-id' }, content: [
          { type: 'taskItem', attrs: { localId: 'private-done-id', state: 'DONE' }, content: [{ type: 'text', text: 'Run tests' }] },
        ] },
      ] }],
    } }));
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

  it.each(['ECHO-1', 'echo-1', '(ECHO-1),'])('looks up an issue key named alone (%s) through the bulk issue read, not JQL', async query => {
    const f = fixture(); const { source } = await f.make();
    f.request.mockClear();
    const result = await source.search({ query });
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(['10001']);
    expect(result.truncated).toBe(false);
    expect(f.jqls()).toEqual([]);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/bulkfetch`, method: 'POST',
      body: { issueIdsOrKeys: ['ECHO-1'], fields: ['summary', 'project', 'created', 'updated', 'status', 'assignee', 'duedate'] } }));
  });

  it('treats a missing or hidden named key as no match rather than failing the search', async () => {
    const f = fixture(); f.state.denied.set('10002', 'unauthorized');
    const { source } = await f.make();
    await expect(source.search({ query: 'ECHO-2' })).resolves.toMatchObject({ items: [], truncated: false });
    await expect(source.search({ query: 'ECHO-404' })).resolves.toMatchObject({ items: [], truncated: false });
    f.state.bulkResponse = { issues: [], issueErrors: [{ id: 'ECHO-1', errorMessage: 'private provider detail' }] };
    await expect(source.search({ query: 'ECHO-1' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('matches a key mixed with words exactly, or as a word with the rest, key first and without duplicates', async () => {
    const f = fixture();
    // ECHO-2 is named; ECHO-1 mentions it in its text.
    f.state.pages = [page(['10002', '10001'])];
    const { source } = await f.make('ECHO');
    const result = await source.search({ query: 'blocks ECHO-2' });
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(['10002', '10001']);
    expect(f.jqls()).toEqual(['project = 10000 AND (text ~ "\\\"blocks\\\"" AND text ~ "\\\"ECHO\\\\-2\\\"") ORDER BY created DESC, id DESC']);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/bulkfetch`, body: expect.objectContaining({ issueIdsOrKeys: ['ECHO-2'] }) }));
  });

  it('keeps the named-key matches when the words match nothing, without a relaxed retry', async () => {
    const f = fixture(); f.state.pages = [page([])];
    const { source } = await f.make();
    const result = await source.search({ query: 'blocks ECHO-2' });
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(['10002']);
    expect(f.jqls()).toHaveLength(1);
  });

  it('looks up at most the result limit of named keys and reports the rest as truncated', async () => {
    const f = fixture();
    for (const id of ['10003', '10004', '10005', '10006']) f.state.tickets.set(id, ticket(id));
    const { source } = await f.make();
    const result = await source.search({ query: 'ECHO-6 ECHO-5 ECHO-4 ECHO-3 ECHO-2 ECHO-1' });
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(['10006', '10005', '10004', '10003', '10002']);
    expect(result.truncated).toBe(true);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/bulkfetch`, body: expect.objectContaining({ issueIdsOrKeys: ['ECHO-6', 'ECHO-5', 'ECHO-4', 'ECHO-3', 'ECHO-2'] }) }));
    expect(f.jqls()).toEqual([]);
  });

  it('retries an empty multi-word search once, matching all terms but one', async () => {
    const f = fixture(); f.state.pages = [page([]), page(['10001'])];
    const { source } = await f.make('ECHO');
    const result = await source.search({ query: 'DVT blocking bug' });
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(['10001']);
    const literal = (term: string) => `text ~ "\\"${term}\\""`;
    expect(f.jqls()).toEqual([
      `project = 10000 AND (${literal('DVT')} AND ${literal('blocking')} AND ${literal('bug')}) ORDER BY created DESC, id DESC`,
      `project = 10000 AND ((${literal('blocking')} AND ${literal('bug')}) OR (${literal('DVT')} AND ${literal('bug')}) OR (${literal('DVT')} AND ${literal('blocking')})) ORDER BY created DESC, id DESC`,
    ]);

    const two = fixture(); two.state.pages = [page([]), page([])];
    const pair = await two.make();
    await expect(pair.source.search({ query: 'blocking DVT' })).resolves.toMatchObject({ items: [] });
    // Two terms relax to a plain OR, and an empty retry is not retried again.
    expect(two.jqls()).toEqual([
      `${literal('blocking')} AND ${literal('DVT')} ORDER BY created DESC, id DESC`,
      `(${literal('DVT')}) OR (${literal('blocking')}) ORDER BY created DESC, id DESC`,
    ]);
  });

  it('keeps a named key nothing matched in every relaxed clause, dropping only words', async () => {
    const literal = (term: string) => `text ~ "\\"${term}\\""`;
    const key = literal('ECHO\\\\-404');
    const one = fixture(); one.state.pages = [page([]), page(['10001'])];
    const single = await one.make();
    // ECHO-404 does not exist (or is hidden), so its lookup finds nothing.
    const result = await single.source.search({ query: 'blocks ECHO-404' });
    expect(result.items.map(item => item.citation.ticket_id)).toEqual(['10001']);
    // With one word, the retry is the key's own text clause: tickets that mention it.
    expect(one.jqls()).toEqual([
      `${literal('blocks')} AND ${key} ORDER BY created DESC, id DESC`,
      `(${key}) ORDER BY created DESC, id DESC`,
    ]);

    const two = fixture(); two.state.pages = [page([]), page([])];
    const pair = await two.make();
    await pair.source.search({ query: 'status of ECHO-404' });
    expect(two.jqls()).toEqual([
      `${literal('status')} AND ${literal('of')} AND ${key} ORDER BY created DESC, id DESC`,
      `(${literal('of')} AND ${key}) OR (${literal('status')} AND ${key}) ORDER BY created DESC, id DESC`,
    ]);
  });

  it.each([
    ['one term', 'launch', [page([])]],
    ['a match for every term', 'launch connector', [page(['10001'])]],
    ['a further page of matches', 'launch connector', [page([], 'next')]],
    ['seven terms', 'one two three four five six seven', [page([])]],
    ['seven words and a key', 'one two three four five six seven ECHO-404', [page([])]],
    ['no word but keys', 'ECHO-404 (ECHO-404),', [page([])]],
  ] as const)('does not relax a search with %s', async (_label, query, pages) => {
    const f = fixture(); f.state.pages = [...pages];
    const { source } = await f.make();
    await source.search({ query });
    expect(f.jqls()).toHaveLength(1);
  });

  it('compiles keyword search as independent terms within the pinned project', async () => {
    const f = fixture(); const { source } = await f.make('ECHO');
    await source.search({ query: 'launch connector' });
    expect(f.jqls()[0]).toBe('project = 10000 AND (text ~ "\\\"launch\\\"" AND text ~ "\\\"connector\\\"") ORDER BY created DESC, id DESC');
  });

  it('bounds NFC text by UTF-8 bytes before hashing, with aggregate releases accepted by the wrapper', async () => {
    const f = fixture();
    f.state.pages = [page(Array.from({ length: 5 }, (_, i) => String(10001 + i)))];
    for (let i = 0; i < 5; i++) f.state.tickets.set(String(10001 + i), withFields({ summary: 'Cafe\u0301', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '\t😀'.repeat(3000) }] }] } }, ticket(String(10001 + i), 'Cafe\u0301')));
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
    const literals = ['"hello\\""', '"OR"', '"project"', '"="', '"SECRET"'];
    expect(f.jqls()[0]).toBe(literals.map(value => `text ~ ${JSON.stringify(value)}`).join(' AND ') + ' ORDER BY created DESC, id DESC');
    expect(Object.isFrozen(reader.binding)).toBe(true);
    await reader.search({ query: 'ECHO-1', limit: 1, ...{ person: 'another-person', cloudid: 'another-site', connectionId: 'another-connection' } });
    expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ path: `${prefix}/myself` }));
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/issue/bulkfetch`, body: expect.objectContaining({ issueIdsOrKeys: ['ECHO-1'] }) }));
    expect(f.request.mock.calls.every(([r]) => !r.path.includes('another') && !JSON.stringify(r.body ?? {}).includes('another'))).toBe(true);
  });

  it('counts repeated keywords once when compiling a bounded query', async () => {
    const f = fixture(); const { source } = await f.make();
    await source.search({ query: Array.from({ length: 40 }, (_, i) => i % 2 === 0 ? 'MRD' : 'mrd').join(' ') });
    expect(f.jqls()[0]).toBe(`text ~ ${JSON.stringify('"mrd"')} ORDER BY created DESC, id DESC`);
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
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ body: { jql: 'project = 10000 AND created >= "2026-08-31" AND created < "2026-10-03" ORDER BY created DESC, id DESC', maxResults: 1, fields: ['id'], nextPageToken: 'private-provider-token' } }));
    await source.open({ item: first.items[0]!.id });
    expect(f.releases.at(-1)!.operation).toBe('open');
  });

  it('bounds JQL by created with a day of margin, filters UTC days exactly and stops once a page predates since', async () => {
    const f = fixture();
    // Newest first, as Jira orders them: after until, inside the UTC day (the previous local day), before since.
    f.state.tickets.set('10003', withFields({ created: '2026-10-02T01:00:00.000+0000' }, ticket('10003')));
    f.state.tickets.set('10002', withFields({ created: '2026-09-30T23:30:00.000-0700' }, ticket('10002')));
    f.state.pages = [page(['10003'], 'page-2'), page(['10002', '10001'], 'page-3')];
    const { source } = await f.make();
    const first = await source.list({ since: '2026-10-01', until: '2026-10-01', limit: 2 });
    expect(first.items).toEqual([]); expect(first.next_cursor).toBeDefined(); expect(first.truncated).toBe(true);
    const second = await source.list({ since: '2026-10-01', until: '2026-10-01', limit: 2, cursor: first.next_cursor });
    expect(second.items.map(item => [item.citation.ticket_id, item.occurred_at])).toEqual([['10002', '2026-10-01']]);
    // Jira still offers page-3, but its issues can only be older than since.
    expect(second.next_cursor).toBeUndefined(); expect(second.truncated).toBe(false);
    expect(f.jqls()).toEqual(Array(2).fill('created >= "2026-09-30" AND created < "2026-10-03" ORDER BY created DESC, id DESC'));
    expect(f.releases[0]!.citations).toEqual([]); expect(f.releases).toHaveLength(2);
  });

  it('keeps paging an inventory with no since, and bounds until alone without dropping the site-wide restriction', async () => {
    const f = fixture(); f.state.pages = [page(['10001'], 'page-2')];
    const { source } = await f.make();
    const unbounded = await source.list({ limit: 1 });
    expect(unbounded.next_cursor).toBeDefined();
    f.state.pages = [page(['10001'], 'page-2')];
    const until = await source.list({ until: '2026-12-31', limit: 1 });
    expect(until.next_cursor).toBeDefined();
    f.state.pages = [page(['10001'])];
    await source.list({ container: 'ECHO', since: '2026-03-01', limit: 1 });
    expect(f.jqls()).toEqual([
      'created >= "1970-01-01" ORDER BY created DESC, id DESC',
      'created >= "1970-01-01" AND created < "2027-01-02" ORDER BY created DESC, id DESC',
      'project = 10000 AND created >= "2026-02-28" ORDER BY created DESC, id DESC',
    ]);
  });

  it('leaves out a coarse created bound past four-digit years instead of sending a malformed JQL date', async () => {
    const f = fixture(); f.state.pages = [page(), page(), page()];
    const { source } = await f.make();
    // A planner may ask for everything until 9999-12-31; the exact UTC filter still applies.
    await expect(source.list({ until: '9999-12-31' })).resolves.toMatchObject({ items: [{ citation: { ticket_id: '10001' } }] });
    await expect(source.list({ since: '0000-01-01' })).resolves.toMatchObject({ items: [{ citation: { ticket_id: '10001' } }] });
    await source.list({ container: 'ECHO', since: '0000-01-01', until: '9999-12-30' });
    expect(f.jqls()).toEqual([
      'created >= "1970-01-01" ORDER BY created DESC, id DESC',
      'created >= "1970-01-01" ORDER BY created DESC, id DESC',
      'project = 10000 ORDER BY created DESC, id DESC',
    ]);
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

  it('re-reads only newly released tickets in an incremental check and verifies the connection once, after them', async () => {
    const f = fixture(); f.state.pages = [page(['10001']), page(['10002'])];
    const { source } = await f.make('ECHO');
    const verify = ['/oauth/token/accessible-resources', `${prefix}/myself`, `${prefix}/project/ECHO`];
    const calls = () => f.request.mock.calls.map(([request]) => request.path === `${prefix}/issue/bulkfetch` ? `bulk:${(request.body!.issueIdsOrKeys as string[]).join(',')}` : request.path);
    await source.list({});
    f.request.mockClear(); await source.revalidate({ mode: 'incremental' });
    expect(calls()).toEqual(['bulk:10001', ...verify]);
    // A repair with no new evidence re-reads nothing and still verifies the account, site and project.
    f.request.mockClear(); await source.revalidate({ mode: 'incremental' });
    expect(calls()).toEqual(verify);
    await source.list({});
    f.request.mockClear(); await source.revalidate({ mode: 'incremental' });
    expect(calls()).toEqual(['bulk:10002', ...verify]);
    // The full check keeps both verifications around every released ticket.
    f.request.mockClear(); await source.revalidate({});
    expect(calls()).toEqual([...verify, 'bulk:10001,10002', ...verify]);
    // An already-checked ticket hidden mid-run is not re-read before the next
    // model call (ADR-0038), but the full release check refuses it.
    f.state.denied.set('10001', 'not_found');
    await expect(source.revalidate({ mode: 'incremental' })).resolves.toBeUndefined();
    await expect(source.revalidate({})).rejects.toMatchObject({ code: 'not_found' });
    f.state.denied.clear(); f.state.myself = { accountId: 'changed', active: true, accountType: 'atlassian' };
    await expect(source.revalidate({ mode: 'incremental' })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses a newly released ticket hidden before an incremental check', async () => {
    const f = fixture(); f.state.pages = [page(['10001']), page(['10002'])];
    const { source } = await f.make('ECHO');
    await source.list({});
    await source.revalidate({ mode: 'incremental' });
    await source.list({});
    f.state.denied.set('10002', 'not_found');
    await expect(source.revalidate({ mode: 'incremental' })).rejects.toMatchObject({ code: 'not_found', message: 'Live evidence operation could not be completed' });
    // The failed check left 10002 pending, so the next incremental check reads it again.
    f.state.denied.clear(); f.request.mockClear();
    await source.revalidate({ mode: 'incremental' });
    expect(f.request.mock.calls.filter(([request]) => request.path === `${prefix}/issue/bulkfetch`).map(([request]) => request.body!.issueIdsOrKeys)).toEqual([['10002']]);
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
