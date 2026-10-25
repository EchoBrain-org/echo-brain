import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_ASK_CHECK_REQUEST_KIND_V1, validatePersonAskCheckRequestV1, validatePersonAskCheckV1, type PersonPageCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { ConfluenceConnectionStoreV1 } from '@echo-brain/provider-confluence/confluence-connection-store-v1';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import { jiraTicketMarkerV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import { SqliteImpactItemsV1 } from '../src/adapters/persistence/sqlite/impact-items-v1.js';
import { SqliteOpenItemPeopleV1 } from '../src/adapters/persistence/sqlite/open-item-people-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import type { PersonSourceCheckV1 } from '../src/application/ports/person-source-check-v1.js';
import { openConfluencePersonLiveRuntimeV1 } from '../src/composition/confluence-person-live-runtime-v1.js';
import { openJiraPersonLiveRuntimeV1 } from '../src/composition/jira-person-live-runtime-v1.js';
import { createPersonAskCheckV1, type PersonAskCheckLiveFailureV1 } from '../src/composition/person-ask-check-v1.js';
import { personLiveConnectorDefinitionsV1 } from '../src/composition/person-live-connector-registry-v1.js';
import { confluencePersonLiveConnectorsV1 } from '../src/composition/confluence-person-live-runtime-v1.js';
import { jiraPersonLiveConnectorsV1 } from '../src/composition/jira-person-live-runtime-v1.js';
import { FIXTURE_CONFLUENCE_CLOUD_V1, FIXTURE_CONFLUENCE_SITE_V1 } from './fixtures/fake-confluence-v1.js';
import { FIXTURE_JIRA_CLOUD_V1, FIXTURE_JIRA_SITE_V1 } from './fixtures/fake-jira-v1.js';
import { OWNER, authorization, projectContextDatabase } from './fixtures/project-context-sqlite.js';

const BEARER = 'synthetic-atlassian-oauth-bearer';
const person = { organization_id: OWNER.organization_id, principal_id: OWNER.principal_id, membership_id: OWNER.membership_id };
const sessions = { authenticateAccess: ({ access_token }: { readonly access_token: string }) => {
  if (access_token !== 'owner') throw new AuthorityOperationError('unauthorized', 'person authentication failed');
  return authorization(OWNER);
} };
const configuration = (cloud_id: string) => ({ enabled: true as const, cloud_id, integration_id: 'fixture', nango_authorization: () => 'synthetic-only-nango-authorization' });
const adf = (...paragraphs: string[]) => ({ type: 'doc', version: 1, content: paragraphs.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
const json = (value: unknown, status = 200) => Response.json(value, { status });

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** The owner connected to a tool: a completed consent in its store, and a Nango that hands back that person's own token. */
function connected(store: JiraConnectionStoreV1 | ConfluenceConnectionStoreV1, cloud: string, site: string) {
  const attempt = store.begin(person).attempt;
  store.complete(person, attempt, 'fixture-reference', cloud, 'fixture-account', site);
  const tags = { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: attempt };
  const unused = async () => { throw new Error('unused'); };
  return { connect: vi.fn(unused), find: vi.fn(unused), disconnect: vi.fn(unused), connection: vi.fn(async () => ({ tags, access_token: BEARER })) };
}

/** The check over an Authority with no meetings, and these tools' own checks. */
function askCheck(live: readonly PersonSourceCheckV1[]) {
  const database = projectContextDatabase();
  cleanups.push(() => database.close());
  const failures: PersonAskCheckLiveFailureV1[] = [];
  const app = createPersonAskCheckV1({
    database, sessions, projects: new SqliteProjectContextRepositoryV1(database), records: { readableDecisionProjects: () => new Map() },
    originals: new SqlitePersonOriginalContextRetrievalV1(database, sessions, OWNER.organization_id), items: new SqliteImpactItemsV1(database),
    people: new SqliteOpenItemPeopleV1(database), live, on_live_failure: event => { failures.push(event); },
  });
  const check = async (items: readonly unknown[]) => {
    const request = validatePersonAskCheckRequestV1({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1, items });
    return validatePersonAskCheckV1(await app.check({ access_token: 'owner', request }), request).items;
  };
  return { check, failures };
}
const item = (citation: unknown, marker?: string) => ({ asked_at: '2026-10-20T09:00:00.000Z', citation, ...(marker === undefined ? {} : { marker }) });

describe('Ask source check through the Jira connection', () => {
  const BULK = `/ex/jira/${FIXTURE_JIRA_CLOUD_V1}/rest/api/3/issue/bulkfetch`;
  const fields = (id: string) => ({ summary: `Kestrel issue ${id}`, description: adf(`Ship ${id} after the review.`), status: { name: 'In Progress' },
    assignee: { displayName: 'Mina Patel', accountId: 'acct-mina' }, duedate: '2026-10-30', updated: '2026-10-20T09:00:00.000+0000' });
  const ticket = (ticket_id: string) => ({ kind: 'ticket', tool_id: 'jira', external_scope_id: FIXTURE_JIRA_CLOUD_V1, ticket_id,
    permalink: `${FIXTURE_JIRA_SITE_V1}/browse/ECHO-${ticket_id}`, text_sha256: sha256Digest(`ECHO-${ticket_id} text`) });

  /** The real Jira runtime over a fake Jira Cloud holding these issues as the owner sees them; `reply` overrides a bulk read. */
  function jira(issues: Map<string, Record<string, unknown>>, reply?: (ids: readonly string[]) => Response | undefined) {
    const database = new Database(':memory:');
    const store = new JiraConnectionStoreV1(database);
    const nango = connected(store, FIXTURE_JIRA_CLOUD_V1, FIXTURE_JIRA_SITE_V1);
    const bulk: { readonly ids: readonly string[]; readonly fields: readonly string[] }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${BEARER}`);
      if (url.pathname !== BULK || init?.method !== 'POST') throw new Error(`unexpected Jira endpoint ${url.pathname}`);
      const body = JSON.parse(String(init.body)) as { issueIdsOrKeys: string[]; fields: string[] };
      bulk.push({ ids: body.issueIdsOrKeys, fields: body.fields });
      return reply?.(body.issueIdsOrKeys) ?? json({ issueErrors: [], issues: body.issueIdsOrKeys.flatMap(id => (issues.has(id)
        ? [{ id, key: `ECHO-${id}`, self: `${FIXTURE_JIRA_SITE_V1}/rest/api/3/issue/${id}`, fields: issues.get(id) }] : [])) });
    });
    const runtime = openJiraPersonLiveRuntimeV1({ state_directory: '/nonexistent-ask-check', sessions, configuration: configuration(FIXTURE_JIRA_CLOUD_V1),
      seams: { database, nango, fetch: fetch as typeof globalThis.fetch } });
    cleanups.push(() => { runtime.close(); database.close(); });
    return { runtime, store, bulk, fetch, ...askCheck([runtime.checks]) };
  }

  it('fingerprints what an answer read of a ticket, returns it as the baseline, and moves it with each of those fields, never with a comment', async () => {
    const issues = new Map<string, Record<string, unknown>>([['10012', fields('10012')]]);
    const f = jira(issues);
    const [baseline] = await f.check([item(ticket('10012'))]);
    // The canonical JSON of the parsed summary, description, status, assignee and due date.
    const marker = canonicalSha256({ summary: 'Kestrel issue 10012', description: 'Ship 10012 after the review.', status: 'In Progress', assignee: 'Mina Patel', due_date: '2026-10-30' });
    expect(baseline).toEqual({ state: 'same', marker });
    expect(jiraTicketMarkerV1(fields('10012'))).toBe(marker);
    expect(await f.check([item(ticket('10012'), marker)])).toEqual([{ state: 'same', marker }]);
    // A comment moves Jira's `updated`, which the marker leaves out.
    issues.set('10012', { ...fields('10012'), updated: '2026-10-21T10:00:00.000+0000', comment: { comments: [{ body: adf('A comment.') }] } });
    expect(await f.check([item(ticket('10012'), marker)])).toEqual([{ state: 'same', marker }]);
    for (const [change, value] of [
      ['summary', { summary: 'Kestrel issue 10012 moved to Monday' }],
      ['description', { description: adf('Ship 10012 after the second review.') }],
      ['status', { status: { name: 'Done' } }],
      ['assignee', { assignee: { displayName: 'Rafael Moreno', accountId: 'acct-rafael' } }],
      ['no assignee', { assignee: null }],
      ['due date', { duedate: '2026-11-02' }],
      ['no due date', { duedate: null }],
      ['no description', { description: null }],
    ] as const) {
      issues.set('10012', { ...fields('10012'), ...value });
      const [answer] = await f.check([item(ticket('10012'), marker)]);
      expect(answer, change).toEqual({ state: 'changed', marker: jiraTicketMarkerV1(issues.get('10012')) });
      expect(answer!.marker, change).not.toBe(marker);
    }
  });

  it('answers a hidden, deleted or never-existing ticket unreadable, and reads no key or malformed id', async () => {
    const f = jira(new Map([['10012', fields('10012')]]));
    // 10013 was deleted or is hidden from the owner; 10099 never existed: Jira returns neither.
    expect(await f.check([item(ticket('10013')), item(ticket('10099')), item(ticket('10012'))])).toEqual([{ state: 'unreadable' }, { state: 'unreadable' }, { state: 'same', marker: jiraTicketMarkerV1(fields('10012')) }]);
    f.bulk.length = 0;
    expect(await f.check([item(ticket('ECHO-12')), item(ticket('012'))])).toEqual([{ state: 'unreadable' }, { state: 'unreadable' }]);
    expect(f.bulk).toEqual([]);
    expect(f.failures).toEqual([]);
  });

  it('reads at most a hundred tickets in two bulk calls of fifty, asking only for the fields the marker covers', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => String(20_000 + index));
    const f = jira(new Map(ids.map(id => [id, fields(id)])));
    expect(await f.check(ids.map(id => item(ticket(id))))).toEqual(ids.map(id => ({ state: 'same', marker: jiraTicketMarkerV1(fields(id)) })));
    expect(f.bulk).toEqual([
      { ids: ids.slice(0, 50), fields: ['summary', 'description', 'status', 'assignee', 'duedate'] },
      { ids: ids.slice(50), fields: ['summary', 'description', 'status', 'assignee', 'duedate'] },
    ]);
  });

  it('answers unknown when Jira fails or answers something malformed, or the owner is not connected, reporting only where and why', async () => {
    const issue = (id: string) => ({ id, key: `ECHO-${id}`, fields: fields(id) });
    for (const [label, reply, code] of [
      ['an outage', () => json({}, 500), 'unavailable'],
      ['a refused token', () => json({}, 403), 'unauthorized'],
      ['a rate limit', () => json({}, 429), 'rate_limited'],
      ['an issue Jira could not return now', () => json({ issues: [issue('10012')], issueErrors: [{ id: '10013', errorMessage: 'Retry later' }] }), 'unavailable'],
      ['an issue nobody asked for', () => json({ issues: [issue('10777')], issueErrors: [] }), 'invalid_output'],
      ['a malformed issue', () => json({ issues: [{ id: '10012', fields: { ...fields('10012'), status: null } }], issueErrors: [] }), 'invalid_output'],
    ] as const) {
      const f = jira(new Map([['10012', fields('10012')]]), reply);
      expect(await f.check([item(ticket('10012')), item(ticket('10013'))]), label).toEqual([{ state: 'unknown' }, { state: 'unknown' }]);
      expect(f.failures, label).toEqual([{ kind: 'person_ask_check_live_read', reason: 'tickets', code }]);
    }
    const f = jira(new Map([['10012', fields('10012')]]));
    f.store.revoke(person);
    expect(await f.check([item(ticket('10012'))])).toEqual([{ state: 'unknown' }]);
    expect(f.failures).toEqual([{ kind: 'person_ask_check_live_read', reason: 'tickets', code: 'unauthorized' }]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('Ask source check through the Confluence connection', () => {
  const PREFIX = `/ex/confluence/${FIXTURE_CONFLUENCE_CLOUD_V1}/wiki`;
  type Page = { id: string; status: string; version: number; paragraphs: readonly string[] };

  /** The real Confluence runtime over a fake Confluence Cloud holding these pages, all in space 42 and visible to the owner. */
  function confluence(pages: Map<string, Page>, fail: { readonly versions?: number; readonly bodies?: number } = {}) {
    const database = new Database(':memory:');
    const store = new ConfluenceConnectionStoreV1(database);
    const nango = connected(store, FIXTURE_CONFLUENCE_CLOUD_V1, FIXTURE_CONFLUENCE_SITE_V1);
    const calls: { readonly path: string; readonly query: URLSearchParams }[] = [];
    const metadata = (page: Page, body: boolean) => ({ id: page.id, spaceId: '42', title: `Page ${page.id}`, status: page.status, version: { number: page.version, createdAt: '2026-10-20T09:00:00.000Z' },
      ...(body ? { body: { atlas_doc_format: { representation: 'atlas_doc_format', value: JSON.stringify(adf(...page.paragraphs)) } } } : {}) });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe('error');
      const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
      calls.push({ path, query: new URLSearchParams(url.searchParams) });
      if (path === '/oauth/token/accessible-resources') return json([{ id: FIXTURE_CONFLUENCE_CLOUD_V1, url: FIXTURE_CONFLUENCE_SITE_V1, scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'] }]);
      if (path === '/rest/api/user/current') return json({ accountId: 'fixture-account', type: 'known', accountType: 'atlassian' });
      const statuses = url.searchParams.getAll('status');
      const shown = (page: Page) => statuses.length === 0 || statuses.includes(page.status);
      if (path === '/api/v2/pages') {
        const ids = url.searchParams.get('id')?.split(',');
        if (ids !== undefined && fail.versions !== undefined) return json({}, fail.versions);
        return json({ results: [...pages.values()].filter(page => (ids === undefined || ids.includes(page.id)) && shown(page)).map(page => metadata(page, false)), _links: {} });
      }
      const exact = /^\/api\/v2\/pages\/(\d+)$/.exec(path);
      if (exact !== null) {
        const body = url.searchParams.get('body-format') === 'atlas_doc_format';
        if (body && fail.bodies !== undefined) return json({}, fail.bodies);
        const page = pages.get(exact[1]!);
        return page === undefined || !shown(page) ? json({}, 404) : json(metadata(page, body));
      }
      throw new Error(`unexpected Confluence endpoint ${path}`);
    });
    const runtime = openConfluencePersonLiveRuntimeV1({ state_directory: '/nonexistent-ask-check', sessions, configuration: configuration(FIXTURE_CONFLUENCE_CLOUD_V1),
      seams: { database, nango, fetch: fetch as typeof globalThis.fetch } });
    cleanups.push(() => { runtime.close(); database.close(); });
    /** The page citations the real reader releases, as an answer carried them: the inventory row, then its sections. */
    const cited = async (pageId: string): Promise<readonly PersonPageCitationV1[]> => {
      const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1<PersonPageCitationV1>) => canonicalSha256(release)) };
      const source = (await runtime.application.source({ access_token: 'owner', audit }))!;
      const listed = (await source.list({})).items.find(entry => entry.citation.page_id === pageId)!;
      const opened = await source.open({ item: listed.id, limit: 8 });
      return [listed.citation, ...opened.items.map(entry => entry.citation)];
    };
    const reads = () => {
      const metadataCalls = calls.filter(call => call.path === '/api/v2/pages' && call.query.has('id'));
      const bodyCalls = calls.filter(call => /^\/api\/v2\/pages\/\d+$/.test(call.path) && call.query.get('body-format') === 'atlas_doc_format');
      return { metadata: metadataCalls.map(call => call.query.get('id')!.split(',')), bodies: bodyCalls.map(call => call.path.slice('/api/v2/pages/'.length)),
        statuses: metadataCalls.map(call => call.query.getAll('status')) };
    };
    return { runtime, store, fetch, calls, reads, cited, ...askCheck([runtime.checks]) };
  }
  // Two reader sections: each normalized paragraph plus its newline fills one.
  const long = (marker: string) => `${marker} ${'x'.repeat(3070 - Buffer.byteLength(marker, 'utf8'))}`;

  it('answers a page the same while its version stands, and compares the cited section the reader released when it moves', async () => {
    const pages = new Map<string, Page>([['200', { id: '200', status: 'current', version: 3, paragraphs: [long('Gate one.'), long('Gate two.')] }]]);
    const f = confluence(pages);
    const [inventory, first, second] = await f.cited('200');
    expect([inventory!.section_id, first!.section_id, second!.section_id]).toEqual(['inventory', 's1', 's2']);
    expect(inventory!.text_sha256).toBe(sha256Digest(''));
    f.calls.length = 0;
    expect(await f.check([item(inventory), item(first), item(second)])).toEqual([{ state: 'same' }, { state: 'same' }, { state: 'same' }]);
    // One metadata call by id, of current and archived pages, and no body.
    expect(f.reads()).toEqual({ metadata: [['200']], bodies: [], statuses: [['current', 'archived']] });
    // Version 4 adds a section above both: each cited section is still on the page, moved down, so it is the same.
    pages.set('200', { ...pages.get('200')!, version: 4, paragraphs: [long('A new first gate.'), long('Gate one.'), long('Gate two.')] });
    f.calls.length = 0;
    expect(await f.check([item(first), item(second), item(inventory)])).toEqual([{ state: 'same' }, { state: 'same' }, { state: 'changed' }]);
    // The inventory row cites no text: any new version changed it, with no body read for it.
    expect(f.reads()).toEqual({ metadata: [['200']], bodies: ['200'], statuses: [['current', 'archived']] });
    // Version 5 edits the second gate: its citation changed, the first stands.
    pages.set('200', { ...pages.get('200')!, version: 5, paragraphs: [long('A new first gate.'), long('Gate one.'), long('Gate two, moved to Monday.')] });
    expect(await f.check([item(first), item(second)])).toEqual([{ state: 'same' }, { state: 'changed' }]);
    expect(f.failures).toEqual([]);
  });

  it('answers a hidden, trashed, deleted or never-existing page unreadable', async () => {
    const pages = new Map<string, Page>([
      ['200', { id: '200', status: 'current', version: 3, paragraphs: ['Gate one.'] }],
      ['201', { id: '201', status: 'archived', version: 3, paragraphs: ['Archived gate.'] }],
      ['202', { id: '202', status: 'current', version: 3, paragraphs: ['Soon trashed.'] }],
      ['203', { id: '203', status: 'current', version: 3, paragraphs: ['Soon gone.'] }],
    ]);
    const f = confluence(pages);
    const [, archived] = await f.cited('201');
    const [, trashed] = await f.cited('202');
    const [, gone] = await f.cited('203');
    pages.set('202', { ...pages.get('202')!, status: 'trashed' });
    pages.delete('203');
    const never = { ...gone!, page_id: '299', permalink: `${FIXTURE_CONFLUENCE_SITE_V1}/wiki/pages/viewpage.action?pageId=299` };
    expect(await f.check([item(archived), item(trashed), item(gone), item(never)])).toEqual([{ state: 'same' }, { state: 'unreadable' }, { state: 'unreadable' }, { state: 'unreadable' }]);
    // A page that disappears between its version and its body reads as gone, never changed.
    pages.set('201', { ...pages.get('201')!, version: 4 });
    const fetched = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      if (/\/api\/v2\/pages\/201$/.test(new URL(String(input)).pathname)) return json({}, 404);
      return fetched(input, init);
    });
    expect(await f.check([item(archived)])).toEqual([{ state: 'unreadable' }]);
    expect(f.failures).toEqual([]);
  });

  it('reads a hundred pages in two metadata calls of fifty and at most ten bodies, leaving the rest unknown', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => String(300 + index));
    const pages = new Map(ids.map(id => [id, { id, status: 'current', version: 3, paragraphs: [`Gate ${id}.`] }] as const));
    const f = confluence(pages);
    const page = (id: string) => ({ kind: 'page', tool_id: 'confluence', external_scope_id: FIXTURE_CONFLUENCE_CLOUD_V1, page_id: id, section_id: 's1', version: '2',
      permalink: `${FIXTURE_CONFLUENCE_SITE_V1}/wiki/pages/viewpage.action?pageId=${id}`, text_sha256: sha256Digest(`Gate ${id}.`) });
    const answers = await f.check(ids.map(id => item(page(id))));
    expect(answers.map(answer => answer.state)).toEqual(ids.map((_, index) => (index < 10 ? 'same' : 'unknown')));
    expect(f.reads().metadata).toEqual([ids.slice(0, 50), ids.slice(50)]);
    expect(f.reads().bodies.sort()).toEqual(ids.slice(0, 10).sort());
  });

  it('answers unknown when Confluence fails, or the owner is not connected, and keeps what the versions settled', async () => {
    const pages = new Map<string, Page>([['200', { id: '200', status: 'current', version: 3, paragraphs: ['Gate one.'] }], ['201', { id: '201', status: 'current', version: 4, paragraphs: ['Gate two.'] }]]);
    const page = (id: string, version: string, text: string) => ({ kind: 'page', tool_id: 'confluence', external_scope_id: FIXTURE_CONFLUENCE_CLOUD_V1, page_id: id, section_id: 's1', version,
      permalink: `${FIXTURE_CONFLUENCE_SITE_V1}/wiki/pages/viewpage.action?pageId=${id}`, text_sha256: sha256Digest(text) });
    const versionsDown = confluence(pages, { versions: 500 });
    expect(await versionsDown.check([item(page('200', '3', 'Gate one.')), item(page('201', '3', 'Gate two.'))])).toEqual([{ state: 'unknown' }, { state: 'unknown' }]);
    expect(versionsDown.failures).toEqual([{ kind: 'person_ask_check_live_read', reason: 'pages', code: 'unavailable' }]);
    const bodiesDown = confluence(pages, { bodies: 503 });
    expect(await bodiesDown.check([item(page('200', '3', 'Gate one.')), item(page('201', '3', 'Gate two.'))])).toEqual([{ state: 'same' }, { state: 'unknown' }]);
    expect(bodiesDown.failures).toEqual([{ kind: 'person_ask_check_live_read', reason: 'page_bodies', code: 'unavailable' }]);
    const signedOut = confluence(pages);
    signedOut.store.revoke(person);
    expect(await signedOut.check([item(page('200', '3', 'Gate one.'))])).toEqual([{ state: 'unknown' }]);
    expect(signedOut.failures).toEqual([{ kind: 'person_ask_check_live_read', reason: 'pages', code: 'unauthorized' }]);
    expect(signedOut.calls).toEqual([]);
  });
});

describe('the Ask source checks a tool registers', () => {
  it('are the items connector\'s alone, so each tool is checked once', () => {
    const jiraDatabase = new Database(':memory:');
    const confluenceDatabase = new Database(':memory:');
    const jiraNango = connected(new JiraConnectionStoreV1(jiraDatabase), FIXTURE_JIRA_CLOUD_V1, FIXTURE_JIRA_SITE_V1);
    const confluenceNango = connected(new ConfluenceConnectionStoreV1(confluenceDatabase), FIXTURE_CONFLUENCE_CLOUD_V1, FIXTURE_CONFLUENCE_SITE_V1);
    const unusedFetch = vi.fn(async () => { throw new Error('unused'); }) as unknown as typeof globalThis.fetch;
    const definitions = personLiveConnectorDefinitionsV1({ live_connectors: [
      ...jiraPersonLiveConnectorsV1(() => openJiraPersonLiveRuntimeV1({ state_directory: '/never-used', sessions, configuration: configuration(FIXTURE_JIRA_CLOUD_V1), seams: { database: jiraDatabase, nango: jiraNango, fetch: unusedFetch } })),
      ...confluencePersonLiveConnectorsV1(() => openConfluencePersonLiveRuntimeV1({ state_directory: '/never-used', sessions, configuration: configuration(FIXTURE_CONFLUENCE_CLOUD_V1), seams: { database: confluenceDatabase, nango: confluenceNango, fetch: unusedFetch } })),
    ] });
    // A tool's connectors share its runtime, so they open with the same grants.
    const authorize = () => { throw new Error('unused'); };
    const opened = definitions.map(definition => definition.open(sessions, authorize));
    cleanups.push(() => { for (const runtime of opened) runtime.close(); jiraDatabase.close(); confluenceDatabase.close(); });
    expect(opened.map(runtime => runtime.checks === undefined ? null : [runtime.checks.kind, runtime.checks.tool_id, runtime.checks.external_scope_id]))
      .toEqual([['ticket', 'jira', FIXTURE_JIRA_CLOUD_V1], null, ['page', 'confluence', FIXTURE_CONFLUENCE_CLOUD_V1], null]);
  });
});
