import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonPageCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createConfluenceCloudTransportV1 } from '../src/confluence-cloud-transport-v1.js';
import { createConfluencePersonLiveEvidenceReaderV1 } from '../src/confluence-person-live-evidence-reader-v1.js';

const CLOUD = '00000000-0000-4000-8000-000000000007';
const ORIGIN = 'https://synthetic-echo.atlassian.net';
const API_PREFIX = `/ex/confluence/${CLOUD}/wiki`;
const SCOPES = ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'];
const binding: PersonConnectorReadBindingV1 = Object.freeze({ organization_id: 'synthetic-org', principal_id: 'synthetic-person', membership_id: 'synthetic-member',
  tool_id: 'confluence', external_scope_id: CLOUD, external_subject_id: 'synthetic-account', read_grant_sha256: canonicalSha256({ synthetic_grant: 1 }) });
const document = (text: string) => JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const emptyHash = `sha256:${createHash('sha256').update('').digest('hex')}`;
type Page = { id: string; spaceId: string; title: string; status: string; version: number; document: string; createdAt: string };
type Call = { path: string; query: URLSearchParams };
const page = (overrides: Partial<Page> = {}): Page => ({ id: '123', spaceId: '42', title: 'ECHO product requirements', status: 'current', version: 3,
  document: document('EVT requirements\nThe gate requires meeting, ticket, and document context.'), createdAt: '2026-10-05T12:00:00Z', ...overrides });
function metadata(value: Page, body = false) {
  return { id: value.id, spaceId: value.spaceId, title: value.title, status: value.status, version: { number: value.version, createdAt: value.createdAt },
    // Citation URLs must come from the verified site plus stable ID, not provider-controlled links.
    _links: { webui: 'https://untrusted.invalid/never-follow', base: 'https://untrusted.invalid' },
    ...(body ? { body: { atlas_doc_format: { value: value.document, representation: 'atlas_doc_format' } } } : {}) };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function fixture(options: { selected?: readonly string[]; pages?: Page[]; scopes?: readonly string[] } = {}) {
  const calls: Call[] = [];
  const audits: PersonLiveEvidenceReleaseV1<PersonPageCitationV1>[] = [];
  const state: {
    pages: Map<string, Page>; keys: Map<string, string>; denied: Set<string>; account: string; site: string; searchIds: string[];
    list?: (call: Call) => unknown; bulk?: (call: Call) => unknown;
    searchNext?: string; authorizationCurrent: boolean; rejectAudit: boolean;
  } = { pages: new Map((options.pages ?? [page()]).map(value => [value.id, value])), keys: new Map([['42', 'ECHO'], ['43', '~personal:key']]),
    denied: new Set(), account: 'synthetic-account', site: ORIGIN, searchIds: ['123'], authorizationCurrent: true, rejectAudit: false };
  const fetch = vi.fn(async (raw: string, _init: RequestInit) => {
    const url = new URL(raw);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
    const call = { path, query: new URLSearchParams(url.searchParams) };
    calls.push(call);
    if (state.denied.has(path)) return response({ private: 'provider denial must not escape' }, 403);
    if (path === '/oauth/token/accessible-resources') return response([{ id: CLOUD, url: state.site, scopes: options.scopes ?? SCOPES }]);
    if (path === '/rest/api/user/current') return response({ accountId: state.account, type: 'known', accountType: 'atlassian' });
    if (path === '/api/v2/pages') {
      const ids = call.query.get('id')?.split(',');
      if (ids !== undefined) return response(state.bulk?.(call) ?? { results: [...state.pages.values()]
        .filter(value => ids.includes(value.id) && !state.denied.has(`/api/v2/pages/${value.id}`)).map(value => metadata(value)) });
      if (state.list !== undefined) return response(state.list(call));
      const selected = call.query.get('space-id')?.split(',');
      return response({ results: [...state.pages.values()].filter(value => selected === undefined || selected.includes(value.spaceId)).map(value => metadata(value)) });
    }
    if (path === '/rest/api/search') return response({ results: state.searchIds.map(id => ({ content: { id, type: 'page', title: 'Untrusted v1 search title',
      body: { document: { value: 'Search body must not become evidence' } }, version: { number: 999 } }, excerpt: 'Search excerpt must not become evidence' })),
      ...(state.searchNext === undefined ? {} : { _links: { next: state.searchNext } }) });
    const space = /^\/api\/v2\/spaces\/(\d+)$/.exec(path);
    if (space !== null) return state.keys.has(space[1]!) ? response({ id: space[1], key: state.keys.get(space[1]!) }) : response({}, 404);
    const exact = /^\/api\/v2\/pages\/(\d+)$/.exec(path);
    if (exact !== null) {
      const value = state.pages.get(exact[1]!);
      return value === undefined ? response({}, 404) : response(metadata(value, call.query.get('body-format') === 'atlas_doc_format'));
    }
    throw new Error(`Unexpected synthetic endpoint: ${path}`);
  });
  const transport = createConfluenceCloudTransportV1({ binding, fetch });
  const reader = await createConfluencePersonLiveEvidenceReaderV1({ binding, transport, expected_origin: ORIGIN,
    ...(options.selected === undefined ? {} : { space_ids: options.selected }) });
  const source = createAuditedPersonLiveEvidenceSourceV1({ actor: { organization_id: binding.organization_id, principal_id: binding.principal_id, membership_id: binding.membership_id },
    read_grant_sha256: binding.read_grant_sha256, reader,
    authorization: { assertCurrent() { if (!state.authorizationCurrent) throw new AuthorityOperationError('unauthorized', 'synthetic membership revoked'); } },
    audit: { async record(event) { if (state.rejectAudit) throw new Error('synthetic audit refused'); audits.push(event); return canonicalSha256(event); } },
    access: { tool_id: 'confluence', external_scope_id: CLOUD, external_subject_id: 'synthetic-account', identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'] } });
  return { source, reader, state, calls, audits, fetch, bodyCalls: () => calls.filter(call => call.query.get('body-format') === 'atlas_doc_format') };
}

// Every operation below crosses the production audited release boundary; raw
// reader outputs alone would miss citation, coordinate, digest and size defects.
describe('Confluence live reader through the audited evidence source', () => {
  it('batches simultaneous connection fences but checks the account again on the next read', async () => {
    const f = await fixture({ selected: ['42'] });
    const controller = new AbortController();
    const results = await Promise.all(['gate', 'regression', 'approval'].map(query =>
      f.source.search({ query, signal: controller.signal })));
    expect(results.every(result => result.items.length === 1)).toBe(true);
    // Initialization, then one shared pre-read and one shared post-read fence.
    // Each search still performs its own scoped discovery and exact page read.
    expect(f.calls.filter(call => call.path === '/rest/api/user/current')).toHaveLength(3);
    expect(f.calls.filter(call => call.path === '/oauth/token/accessible-resources')).toHaveLength(3);
    expect(f.calls.filter(call => call.path === '/rest/api/search')).toHaveLength(3);
    expect(f.calls.filter(call => call.path === '/api/v2/pages/123')).toHaveLength(3);
    const released = f.audits.length;
    f.state.account = 'different-account';
    await expect(f.source.search({ query: 'gate', signal: controller.signal })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.audits).toHaveLength(released);
    expect(f.calls.filter(call => call.path === '/rest/api/user/current')).toHaveLength(4);
  });

  it('can finish both release fences after a multi-step Ask discovers fifteen pages and opens three sections', async () => {
    const f = await fixture({ pages: Array.from({ length: 15 }, (_, index) => page({ id: String(100 + index),
      document: document('Gate readiness evidence. '.repeat(270)) })) });
    // Reproduce the live failure: six research calls, one answer call, then
    // the pre-audit and post-audit fences over every released citation.
    await f.source.revalidate({});
    const found = await f.source.list({ limit: 20 });
    await f.source.revalidate({});
    const opened = await f.source.open({ item: found.items[0]!.id });
    expect(opened.items).toHaveLength(3);
    await f.source.revalidate({});
    await f.source.revalidate({});
    await Promise.all(opened.items.slice(0, 2).map(item => f.source.open({ item: item.id })));
    await f.source.revalidate({});
    await f.source.revalidate({});
    await f.source.revalidate({});
    await f.source.revalidate({});
    await expect(f.source.revalidate({})).resolves.toBeUndefined();
    expect(f.calls.length).toBeLessThan(160);
    expect(JSON.stringify(f.audits)).not.toContain('Gate readiness evidence.');
  });

  it('lists, searches, opens, and revalidates a mapped page with the minimal granular resource grant', async () => {
    const f = await fixture({ selected: ['42'], scopes: ['read:page:confluence', 'read:space:confluence', 'read:content-details:confluence'] });
    const listed = await f.source.list({ limit: 20 });
    expect(listed.items.map(item => item.citation.page_id)).toEqual(['123']);
    expect(f.calls.find(call => call.path === '/api/v2/pages')!.query.get('space-id')).toBe('42');
    const found = await f.source.search({ query: 'EVT requirements' });
    expect(f.calls.find(call => call.path === '/rest/api/search')!.query.get('cql')).toBe('type = page AND text ~ "EVT requirements" AND space IN ("ECHO")');
    const opened = await f.source.open({ item: found.items[0]!.id });
    expect(opened.items.map(item => item.text).join('')).toBe('EVT requirements\nThe gate requires meeting, ticket, and document context.');
    const reads = f.bodyCalls().length;
    await f.source.revalidate({});
    expect(f.bodyCalls()).toHaveLength(reads + 1);
    expect(JSON.stringify(f.audits)).not.toContain('The gate requires');
  });

  it('discovers global metadata without body reads or an ECHO space allowlist', async () => {
    const f = await fixture({ pages: [page(), page({ id: '124', spaceId: '999', title: 'A different accessible space', status: 'archived' })] });
    const result = await f.source.list({ limit: 20 });
    expect(result.items.map(item => item.citation.page_id)).toEqual(['123', '124']);
    expect(result.items.every(item => item.text === undefined && item.citation.text_sha256 === emptyHash && item.visibility === 'only_me')).toBe(true);
    expect(result.items[0]).toMatchObject({ kind: 'page', label: 'ECHO product requirements', occurred_at: '2026-10-05', date_kind: 'version_created', citation: { section_id: 'inventory', version: '3', permalink: `${ORIGIN}/wiki/pages/viewpage.action?pageId=123` } });
    const discovery = f.calls.find(call => call.path === '/api/v2/pages')!;
    expect(discovery.query.get('space-id')).toBeNull();
    expect(discovery.query.getAll('status')).toEqual(['current', 'archived', 'deleted', 'trashed']);
    expect(f.bodyCalls()).toEqual([]);
    expect(f.audits).toHaveLength(1);
    expect(JSON.stringify(f.audits)).not.toContain('The gate requires');
    expect(JSON.stringify(f.audits)).not.toContain('ECHO product requirements');
    expect(f.calls.filter(call => call.path === '/rest/api/user/current')).toHaveLength(3);
  });

  it('applies mapped space IDs before list discovery and honors a narrower explicit container', async () => {
    const f = await fixture({ selected: ['42', '43'], pages: [page(), page({ id: '124', spaceId: '43' }), page({ id: '125', spaceId: '999' })] });
    const mapped = await f.source.list({ limit: 20 });
    expect(mapped.items.map(item => item.citation.page_id)).toEqual(['123', '124']);
    expect(f.calls.find(call => call.path === '/api/v2/pages')!.query.get('space-id')).toBe('42,43');
    const narrowed = await f.source.list({ container: '43', limit: 20 });
    expect(narrowed.items.map(item => item.citation.page_id)).toEqual(['124']);
    expect(f.calls.filter(call => call.path === '/api/v2/pages').at(-1)!.query.get('space-id')).toBe('43');
    const before = f.calls.length;
    await expect(f.source.list({ container: '999' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.calls).toHaveLength(before);
  });

  it('resolves renamed and personal space keys live before scoped CQL and normalizes v1 hits through v2 metadata', async () => {
    const f = await fixture({ selected: ['42', '43'] });
    f.state.keys.set('42', 'RENAMED');
    const first = await f.source.search({ query: 'EVT requirements', limit: 5 });
    const cql = f.calls.find(call => call.path === '/rest/api/search')!;
    expect(cql.query.get('cql')).toBe('type = page AND text ~ "EVT requirements" AND space IN ("RENAMED", "~personal:key")');
    expect(cql.query.get('includeArchivedSpaces')).toBe('true');
    expect(first.items[0]).toMatchObject({ label: 'ECHO product requirements', citation: { page_id: '123', version: '3' } });
    expect(first.items[0]!.text).toBeUndefined();
    expect(f.calls.some(call => call.path === '/api/v2/pages/123' && !call.query.has('body-format'))).toBe(true);
    expect(f.bodyCalls()).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('Search excerpt');
    expect(JSON.stringify(first)).not.toContain('Untrusted v1');
    f.state.keys.set('42', 'RENAMED_AGAIN');
    await f.source.search({ query: 'EVT requirements' });
    expect(f.calls.filter(call => call.path === '/rest/api/search').at(-1)!.query.get('cql')).toContain('"RENAMED_AGAIN"');
  });

  it('queries only requester-visible mapped spaces and returns empty when none are visible', async () => {
    const f = await fixture({ selected: ['42', '43'] });
    f.state.denied.add('/api/v2/spaces/43');
    expect((await f.source.search({ query: 'requirements' })).items).toHaveLength(1);
    expect(f.calls.find(call => call.path === '/rest/api/search')!.query.get('cql')).toBe('type = page AND text ~ "requirements" AND space IN ("ECHO")');
    f.state.denied.add('/api/v2/spaces/42');
    const searchCount = f.calls.filter(call => call.path === '/rest/api/search').length;
    expect(await f.source.search({ query: 'requirements' })).toMatchObject({ items: [], truncated: false });
    expect(f.calls.filter(call => call.path === '/rest/api/search')).toHaveLength(searchCount);
  });

  it('opens and continues a long page in bounded, audited sections without skipping or repeating text', async () => {
    const text = 'EVT decision 😊 remains open. '.repeat(700);
    const f = await fixture({ pages: [page({ document: document(text) })] });
    const found = await f.source.list({});
    let item = found.items[0]!.id;
    let combined = '';
    let sections = 0;
    let continuationCount = 0;
    for (;;) {
      const opened = await f.source.open({ item, limit: 3 });
      expect(opened.items.length).toBeLessThanOrEqual(3);
      for (const section of opened.items.filter(value => value.text !== undefined)) {
        expect(Buffer.byteLength(section.text!, 'utf8')).toBeLessThanOrEqual(3072);
        expect(section.citation.section_id).toBe(`s${++sections}`);
        expect(section.citation.text_sha256).toBe(`sha256:${createHash('sha256').update(section.text!).digest('hex')}`);
        combined += section.text;
      }
      const continuation = opened.items.find(value => value.text === undefined);
      if (continuation === undefined) { expect(opened.truncated).toBe(false); break; }
      expect(opened.truncated).toBe(true);
      expect(continuation.citation.section_id).toMatch(/^continue:/);
      expect(continuation.citation.text_sha256).toBe(emptyHash);
      item = continuation.id;
      continuationCount += 1;
      expect(continuationCount).toBeLessThan(10);
    }
    expect(combined).toBe(text);
    expect(sections).toBeGreaterThan(3);
    expect(continuationCount).toBeGreaterThan(0);
    const before = f.bodyCalls().length;
    await f.source.revalidate({});
    expect(f.bodyCalls()).toHaveLength(before + 1);
    expect(JSON.stringify(f.audits)).not.toContain('EVT decision');
  });

  it('revalidates metadata-only discovery without fetching bodies', async () => {
    const f = await fixture();
    await f.source.list({});
    await f.source.revalidate({});
    expect(f.calls.some(call => call.path === '/api/v2/pages' && call.query.get('id') === '123')).toBe(true);
    expect(f.bodyCalls()).toEqual([]);
  });

  it('revalidates every released metadata page in bounded batches regardless of response order', async () => {
    const pages = Array.from({ length: 107 }, (_, index) => page({ id: String(100 + index) }));
    const f = await fixture({ pages });
    f.state.list = call => {
      const offset = Number(call.query.get('cursor') ?? '0');
      return { results: pages.slice(offset, offset + 20).map(value => metadata(value)),
        ...(offset + 20 >= pages.length ? {} : { _links: { next: `/api/v2/pages?cursor=${offset + 20}` } }) };
    };
    let cursor: string | undefined;
    do { cursor = (await f.source.list({ limit: 20, ...(cursor === undefined ? {} : { cursor }) })).next_cursor; } while (cursor !== undefined);
    f.state.bulk = call => ({ results: call.query.get('id')!.split(',').reverse().map(id => metadata(f.state.pages.get(id)!)) });
    f.calls.length = 0;
    await f.source.revalidate({});
    const batches = f.calls.filter(call => call.query.has('id'));
    expect(batches.map(call => call.query.get('id')!.split(',').length)).toEqual([50, 50, 7]);
    expect(batches.flatMap(call => call.query.get('id')!.split(','))).toEqual(pages.map(value => value.id));
    expect(f.bodyCalls()).toEqual([]);
    expect(f.calls.some(call => /^\/api\/v2\/pages\/\d+$/.test(call.path))).toBe(false);
  });

  it.each(['missing', 'duplicate', 'unexpected', 'oversized', 'version', 'title', 'status', 'moved_space'] as const)(
    'refuses a %s bulk metadata result without releasing another receipt', async change => {
      const f = await fixture({ selected: ['42'], pages: [page(), page({ id: '124' })] });
      await f.source.list({});
      const before = f.audits.length;
      let rows = [metadata(page()), metadata(page({ id: '124' }))];
      let code = 'invalid_output';
      if (change === 'missing') { rows = rows.slice(0, 1); code = 'not_found'; }
      if (change === 'duplicate') rows[1] = rows[0]!;
      if (change === 'unexpected') rows[1] = metadata(page({ id: '999' }));
      if (change === 'oversized') rows.push(metadata(page({ id: '999' })));
      if (change === 'version') { rows[0]!.version.number += 1; code = 'stale_access_state'; }
      if (change === 'title') { rows[0]!.title = 'Changed title'; code = 'stale_access_state'; }
      if (change === 'status') { rows[0]!.status = 'archived'; code = 'stale_access_state'; }
      if (change === 'moved_space') { rows[0]!.spaceId = '999'; code = 'unauthorized'; }
      f.state.bulk = () => ({ results: rows });
      await expect(f.source.revalidate({})).rejects.toMatchObject({ code, message: 'Live evidence operation could not be completed' });
      expect(f.audits).toHaveLength(before);
    });

  it('refuses the whole permission check when a previously discovered page is no longer visible', async () => {
    const f = await fixture({ pages: [page(), page({ id: '124' })] });
    await f.source.list({});
    f.state.denied.add('/api/v2/pages/124');
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code: 'not_found' });
    expect(f.audits).toHaveLength(1);
    expect(f.bodyCalls()).toEqual([]);
  });

  it('finishes a paginated bulk check with pinned selectors and only the opaque next cursor', async () => {
    const f = await fixture({ pages: [page(), page({ id: '124' })] });
    await f.source.list({});
    f.state.bulk = call => call.query.has('cursor') ? { results: [metadata(page({ id: '124' }))] }
      : { results: [metadata(page())], _links: { next: '/wiki/api/v2/pages?id=999&status=trashed&limit=250&cursor=next-batch-page' } };
    f.calls.length = 0;
    await f.source.revalidate({});
    const batches = f.calls.filter(call => call.query.has('id'));
    expect(batches).toHaveLength(2);
    expect(batches[1]!.query.get('id')).toBe('123,124');
    expect(batches[1]!.query.get('limit')).toBe('2');
    expect(batches[1]!.query.getAll('status')).toEqual(['current', 'archived', 'deleted', 'trashed']);
    expect(batches[1]!.query.get('cursor')).toBe('next-batch-page');
  });

  it.each(['foreign_url', 'empty', 'duplicate', 'repeated_cursor', 'complete_with_cursor'] as const)(
    'refuses %s bulk pagination without an unbounded retry', async failure => {
      const f = await fixture({ pages: [page(), page({ id: '124' }), page({ id: '125' })] });
      await f.source.list({});
      f.state.bulk = call => ({ results: failure === 'empty' ? [] : failure === 'complete_with_cursor'
        ? [metadata(page()), metadata(page({ id: '124' })), metadata(page({ id: '125' }))]
        : [metadata(page({ id: call.query.has('cursor') && failure === 'repeated_cursor' ? '124' : '123' }))],
        _links: { next: failure === 'foreign_url' ? 'https://untrusted.invalid/api/v2/pages?cursor=x' : '/api/v2/pages?cursor=repeated' } });
      f.calls.length = 0;
      await expect(f.source.revalidate({})).rejects.toMatchObject({ code: 'invalid_output' });
      expect(f.calls.filter(call => call.query.has('id')).length).toBeLessThanOrEqual(2);
    });

  it.each(['draft', 'historical'] as const)('keeps exact metadata revalidation for %s pages absent from the bulk status contract', async status => {
    const f = await fixture({ pages: [page({ status })] });
    await f.source.search({ query: 'requirements' });
    f.calls.length = 0;
    await f.source.revalidate({});
    expect(f.calls.filter(call => call.path === '/api/v2/pages/123').map(call => call.query.get('status'))).toEqual([status]);
    expect(f.calls.some(call => call.query.has('id'))).toBe(false);
    expect(f.bodyCalls()).toEqual([]);
  });

  it('honors cancellation between bulk pages and checks the grant after metadata revalidation', async () => {
    const f = await fixture({ pages: [page(), page({ id: '124' })] });
    await f.source.list({});
    const controller = new AbortController();
    f.state.bulk = () => { controller.abort(); return { results: [metadata(page())], _links: { next: '/api/v2/pages?cursor=next' } }; };
    f.calls.length = 0;
    await expect(f.source.revalidate({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls.filter(call => call.query.has('id'))).toHaveLength(1);
    f.state.bulk = () => { f.state.account = 'another-account'; return { results: [metadata(page()), metadata(page({ id: '124' }))] }; };
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it.each(['version', 'hash', 'permission', 'moved_space', 'account', 'site'] as const)('refuses released evidence when its %s changes', async change => {
    const f = await fixture({ selected: ['42'] });
    const found = await f.source.list({});
    await f.source.open({ item: found.items[0]!.id });
    let code = 'stale_access_state';
    if (change === 'version') f.state.pages.get('123')!.version += 1;
    if (change === 'hash') f.state.pages.get('123')!.document = document('Different content at the same version must fail closed.');
    if (change === 'permission') { f.state.denied.add('/api/v2/pages/123'); code = 'unauthorized'; }
    if (change === 'moved_space') { f.state.pages.get('123')!.spaceId = '999'; code = 'unauthorized'; }
    if (change === 'account') { f.state.account = 'another-account'; code = 'unauthorized'; }
    if (change === 'site') f.state.site = 'https://different.atlassian.net';
    await expect(f.source.revalidate({})).rejects.toMatchObject({ code, message: 'Live evidence operation could not be completed' });
  });

  it('refuses an inventory open when its version changes after discovery', async () => {
    const f = await fixture();
    const found = await f.source.list({});
    f.state.pages.get('123')!.version += 1;
    await expect(f.source.open({ item: found.items[0]!.id })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(f.audits).toHaveLength(1);
  });

  it.each([
    '/api/v2/pages?cursor=second',
    '/wiki/api/v2/pages?limit=999&status=current&space-id=999&cursor=second',
    `https://api.atlassian.com/ex/confluence/${CLOUD}/wiki/api/v2/pages?cursor=second`,
  ])('uses only the opaque cursor from an accepted next link: %s', async next => {
    const first = page(); const second = page({ id: '124' });
    const f = await fixture({ selected: ['42'], pages: [first, second] });
    f.state.list = call => call.query.has('cursor') ? { results: [metadata(second)] } : { results: [metadata(first)], _links: { next } };
    const one = await f.source.list({ limit: 2 });
    expect(one.next_cursor).toMatch(/^live_cursor_/);
    expect(one.next_cursor).not.toContain('second');
    const two = await f.source.list({ limit: 2, cursor: one.next_cursor });
    expect(two.items.map(item => item.citation.page_id)).toEqual(['124']);
    const call = f.calls.filter(call => call.path === '/api/v2/pages').at(-1)!;
    expect(call.query.get('cursor')).toBe('second');
    expect(call.query.get('limit')).toBe('2');
    expect(call.query.get('space-id')).toBe('42');
    expect(call.query.getAll('status')).toEqual(['current', 'archived', 'deleted', 'trashed']);
  });

  it.each([
    'https://evil.example.test/api/v2/pages?cursor=x',
    `https://api.atlassian.com/ex/confluence/11111111-1111-4111-8111-111111111111/wiki/api/v2/pages?cursor=x`,
    '/api/v2/spaces?cursor=x', '/api/v2/pages?cursor=x&cursor=y', '/api/v2/pages?limit=1',
    'https://user:password@api.atlassian.com/api/v2/pages?cursor=x', '/api/v2/pages?cursor=x#fragment',
  ])('refuses hostile pagination before releasing/auditing the discovered page: %s', async next => {
    const f = await fixture();
    f.state.list = () => ({ results: [metadata(page())], _links: { next } });
    await expect(f.source.list({})).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f.audits).toEqual([]);
  });

  it('keeps item and cursor handles local to their request and list selection', async () => {
    const a = await fixture(); const b = await fixture();
    a.state.list = () => ({ results: [metadata(page())], _links: { next: '/api/v2/pages?cursor=provider-private-cursor' } });
    const found = await a.source.list({ limit: 2 });
    await expect(b.source.open({ item: found.items[0]!.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.source.list({ limit: 2, cursor: found.next_cursor })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(a.source.list({ limit: 2, cursor: 'provider-private-cursor' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(a.source.list({ limit: 2, container: '42', cursor: found.next_cursor })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(b.audits).toEqual([]);
  });

  it('refuses a provider result outside the mapped spaces before audit/release', async () => {
    const f = await fixture({ selected: ['42'] });
    f.state.list = () => ({ results: [metadata(page({ spaceId: '999' }))] });
    await expect(f.source.list({})).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.audits).toEqual([]);
  });

  it('marks unsupported embeds incomplete while preserving readable page context and never following embedded URLs', async () => {
    const f = await fixture({ pages: [page({ document: JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'EVT gate\nOwner approval is required.' }] }, { type: 'extension', attrs: { extensionKey: 'jira', parameters: { url: 'https://untrusted.invalid/private' } } }, { type: 'paragraph', content: [{ type: 'text', text: 'Review next week.' }] }] }) })] });
    const found = await f.source.list({});
    const opened = await f.source.open({ item: found.items[0]!.id });
    expect(opened.truncated).toBe(false);
    expect(opened.notice).toBe('Some Confluence page content could not be fully represented as text.');
    const text = opened.items.map(item => item.text ?? '').join('');
    expect(text).toContain('EVT gate');
    expect(text).toContain('Owner approval is required.');
    expect(text).toContain('[Unsupported embedded content omitted.]');
    expect(text).toContain('Review next week.');
    expect(text).not.toContain('untrusted.invalid');
    expect(f.fetch.mock.calls.every(([url]) => new URL(url).origin === 'https://api.atlassian.com')).toBe(true);
    await f.source.revalidate({});
  });

  it('bounds Unicode labels before the shared audit boundary and preserves source identity', async () => {
    const title = '需求😊'.repeat(120);
    const f = await fixture({ pages: [page({ title })] });
    const found = await f.source.list({});
    expect(Buffer.byteLength(found.items[0]!.label, 'utf8')).toBeLessThanOrEqual(256);
    expect(found.items[0]!.label).not.toContain('\ufffd');
    const opened = await f.source.open({ item: found.items[0]!.id });
    expect(opened.items[0]!.citation.page_id).toBe('123');
    expect(Buffer.byteLength(opened.items[0]!.label, 'utf8')).toBeLessThanOrEqual(256);
  });

  it('uses scoped CQL for date-filtered discovery, with an inclusive final day', async () => {
    const f = await fixture({ selected: ['42'] });
    await f.source.list({ since: '2026-10-01', until: '2026-10-05' });
    const query = f.calls.find(call => call.path === '/rest/api/search')!.query;
    expect(query.get('cql')).toBe('type = page AND space IN ("ECHO") AND lastmodified >= "2026-10-01" AND lastmodified < "2026-10-06"');
    expect(f.bodyCalls()).toEqual([]);
  });

  it('reports truncated search discovery when more permission-visible matches exist', async () => {
    const f = await fixture();
    f.state.searchNext = '/wiki/rest/api/search?cursor=next-search-page';
    const result = await f.source.search({ query: 'EVT' });
    expect(result.truncated).toBe(true);
    expect(result.next_cursor).toBeUndefined();
    expect(f.bodyCalls()).toEqual([]);
  });

  it('requires a successful audit and a current local grant before releasing results', async () => {
    const f = await fixture();
    f.state.rejectAudit = true;
    await expect(f.source.list({})).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.audits).toEqual([]);
    f.state.rejectAudit = false; f.state.authorizationCurrent = false;
    const before = f.calls.length;
    await expect(f.source.list({})).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.calls).toHaveLength(before);
  });
});

describe('Confluence open by an earlier citation (background trigger starting evidence)', () => {
  const earlier = (pageId: string, scope = CLOUD): PersonPageCitationV1 => ({ kind: 'page', tool_id: 'confluence', external_scope_id: scope,
    page_id: pageId, section_id: 's1', version: '1', permalink: `${ORIGIN}/wiki/pages/viewpage.action?pageId=${pageId}`, text_sha256: emptyHash as `sha256:${string}` });

  it('re-reads the current version from its first section and audits it as an open', async () => {
    const f = await fixture({ selected: ['42'], pages: [page({ id: '123', version: 5, document: document('Current gate text.') })] });
    const result = await f.source.openCitation!({ citation: earlier('123') });
    expect(result.items).toEqual([expect.objectContaining({ kind: 'page', text: 'Current gate text.', citation: expect.objectContaining({ page_id: '123', version: '5', section_id: 's1' }) })]);
    expect(f.audits.at(-1)).toMatchObject({ operation: 'open' });
  });

  // Twenty reader sections: each normalized paragraph plus its newline occupies one section.
  const twentySections = JSON.stringify({ type: 'doc', version: 1, content: Array.from({ length: 20 }, (_value, index) => {
    const marker = `Current section ${index + 1}. `;
    return { type: 'paragraph', content: [{ type: 'text', text: `${marker}${'x'.repeat(3071 - Buffer.byteLength(marker, 'utf8'))}` }] };
  }) });
  const digest = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}` as `sha256:${string}`;

  it('re-reads the cited section by position when the page is unchanged since the citation', async () => {
    const f = await fixture({ selected: ['42'], pages: [page({ id: '123', version: 5, document: twentySections })] });

    const result = await f.source.openCitation!({ citation: { ...earlier('123'), version: '5', section_id: 's20' } });

    expect(result).toMatchObject({ truncated: false, items: [expect.objectContaining({ text: expect.stringContaining('Current section 20.'), citation: expect.objectContaining({ page_id: '123', version: '5', section_id: 's20' }) })] });
    expect(result.items).toHaveLength(1);
    expect(result.notice).toBeUndefined();
  });

  it('follows a cited section whose text moved when the page was edited', async () => {
    const f = await fixture({ selected: ['42'], pages: [page({ id: '123', version: 5, document: twentySections })] });
    const current = await f.source.openCitation!({ citation: { ...earlier('123'), version: '5', section_id: 's5' } });
    const text = current.items[0]!.text!;

    // Version 4 cited this text as s3; two sections were inserted above it since.
    const result = await f.source.openCitation!({ citation: { ...earlier('123'), version: '4', section_id: 's3', text_sha256: digest(text) } });

    expect(result).toMatchObject({ truncated: false, items: [expect.objectContaining({ text, citation: expect.objectContaining({ version: '5', section_id: 's5' }) })] });
    expect(result.items).toHaveLength(1);
    expect(result.notice).toBeUndefined();
  });

  it('returns the current page from the top with a notice when the cited text no longer exists', async () => {
    const f = await fixture({ selected: ['42'], pages: [page({ id: '123', version: 5, document: twentySections })] });

    // Section positions may have shifted, so s20 of version 4 is not assumed to be s20 now.
    const result = await f.source.openCitation!({ citation: { ...earlier('123'), version: '4', section_id: 's20', text_sha256: digest('Earlier section 20.') } });

    expect(result.truncated).toBe(true);
    expect(result.items[0]).toMatchObject({ text: expect.stringContaining('Current section 1.'), citation: expect.objectContaining({ version: '5', section_id: 's1' }) });
    expect(result.items.some(item => item.text?.includes('Current section 20.'))).toBe(false);
    expect(result.notice).toMatch(/cited section changed since it was cited/u);
  });

  it('refuses an invalid cited section, or one missing from the unchanged page, instead of substituting another section', async () => {
    const f = await fixture({ selected: ['42'], pages: [page({ id: '123', version: 5, document: document('Only section.') })] });

    await expect(f.source.openCitation!({ citation: { ...earlier('123'), section_id: 'inventory' } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.source.openCitation!({ citation: { ...earlier('123'), version: '5', section_id: 's20' } })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.audits).toHaveLength(0);
  });

  it('refuses a page outside the mapped spaces', async () => {
    const f = await fixture({ selected: ['42'], pages: [page({ id: '777', spaceId: '43' })] });
    await expect(f.source.openCitation!({ citation: earlier('777') })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.audits).toHaveLength(0);
  });

  it('refuses a citation from another site', async () => {
    const f = await fixture({ selected: ['42'] });
    await expect(f.source.openCitation!({ citation: earlier('123', '00000000-0000-4000-8000-000000000099') })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.source.openCitation!({ citation: { ...earlier('123'), permalink: 'https://elsewhere.atlassian.net/wiki/pages/viewpage.action?pageId=123' } })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.audits).toHaveLength(0);
  });
});
