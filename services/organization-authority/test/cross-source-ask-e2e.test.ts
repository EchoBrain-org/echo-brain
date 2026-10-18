import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_EVIDENCE_OPEN_PATH_V1, PERSON_EVIDENCE_SEARCH_PATH_V1, validatePersonAnswerResponseV5, validatePersonEvidenceDeskResponseV1 } from '@echo-brain/organization-api';
import { startOrganizationAuthorityApiRuntime } from '../src/composition/organization-authority-api-runtime.js';
import type { PersonLiveConnectorDefinitionV1 } from '../src/application/ports/person-context-live-runtime-v1.js';
import { allSourceAskFixture, crossSourceAuthorityFixture, DOCUMENT_TEXT, PRIVATE_DOCUMENT_TEXT, SLACK_LIVE_CONNECTOR } from './fixtures/cross-source-ask-runtime.js';
import { JIRA_TEXT, SLACK_TEXT, SLACK_CHANNEL, SLACK_TEAM } from './fixtures/cross-source-live-fixture.js';
import { FIXTURE_JIRA_CLOUD_V1, FIXTURE_JIRA_SITE_V1 } from './fixtures/fake-jira-v1.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const fixture = (owned = roots) => crossSourceAuthorityFixture(owned);
const allSourceFixture = () => allSourceAskFixture(roots);

function finishingModel() {
  const generate = vi.fn(async () => ({ parts: [{ question: 'What changed?', needs: [{ need: 'changes', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] }));
  return { generate, answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'synthetic', planner_model: 'synthetic', answer_model: 'synthetic', timeout_ms: 1000 } } };
}

it('selects the Slack live runtime for authenticated Ask without inventing a disconnected grant', async () => {
  const f = await fixture();
  const source = vi.fn(async () => undefined);
  const close = vi.fn();
  const slack_live_runtime_factory = vi.fn(() => ({ application: { source }, close }));
  const dependencies = { oidc_provider: f.oidc, live_connectors: [{ ...SLACK_LIVE_CONNECTOR, open: slack_live_runtime_factory }], answer_composition_generation: finishingModel().answer_composition_generation };
  const runtime = await startOrganizationAuthorityApiRuntime(f.config, dependencies);
  try {
    const origin = `http://127.0.0.1:${runtime.address.port}`;
    const token = await f.login(origin);
    const response = await fetch(`${origin}/v4/person/ask`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 3, question: 'What changed?' }) });
    expect(response.status).toBe(200);
    expect(slack_live_runtime_factory).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ citations: [] });
  } finally { await runtime.close(); }
  expect(close).toHaveBeenCalledTimes(1);
});

it('registers two page connectors through one lifecycle, catalog, HTTP and versioned Ask path', async () => {
  const f = await fixture();
  const calls = ['handbook', 'runbooks'].map(source_id => ({ source_id, source: vi.fn(async () => undefined), tools: vi.fn(async () => []), close: vi.fn() }));
  const live_connectors: PersonLiveConnectorDefinitionV1[] = calls.map(call => ({
    descriptor: { source_id: call.source_id, selector: call.source_id, kind: 'page', tool_id: call.source_id, description: `Live ${call.source_id} pages`, metadata_only_list: true },
    scopes: ['global', 'project'], minimum_response_version: 6,
    open: authentication => ({ application: { source: call.source }, tools: call.tools, close: call.close,
      connection_http: { routes: [{ route_id: call.source_id, method: 'POST', path: `/v1/person/tools/${call.source_id}/probe` }],
        async accept(request) {
          authentication.authenticateAccess({ access_token: request.headers.authorization!.slice('Bearer '.length) });
          return { status: 200, body: { tool_id: call.source_id } };
        },
      },
    }),
  }));
  const runtime = await startOrganizationAuthorityApiRuntime(f.config, { oidc_provider: f.oidc, live_connectors, answer_composition_generation: finishingModel().answer_composition_generation });
  try {
    const origin = `http://127.0.0.1:${runtime.address.port}`;
    const token = await f.login(origin);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect((await fetch(`${origin}/v4/person/tools`, { headers })).status).toBe(200);
    for (const call of calls) {
      expect(call.tools).toHaveBeenCalledWith(token);
      const response = await fetch(`${origin}/v1/person/tools/${call.source_id}/probe`, { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tool_id: call.source_id });
    }
    // Page-only registration cannot expose page citations through the older ticket response.
    const ask = (version: number) => fetch(`${origin}/v${version}/person/ask`, { method: 'POST', headers, body: JSON.stringify({ schema_version: 3, question: 'What changed?' }) });
    const legacy = await ask(4);
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ schema_version: 5, citations: [] });
    expect(calls.every(call => call.source.mock.calls.length === 0)).toBe(true);
    const answer = await ask(5);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ schema_version: 6 });
    for (const call of calls) expect(call.source).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ access_token: token }));
  } finally { await runtime.close(); }
  for (const call of calls) expect(call.close).toHaveBeenCalledTimes(1);
});

describe('one runtime without live connectors', () => {
  // Kept out of `roots`: the file-level afterEach would delete this live state directory after the first case.
  const shared: string[] = [];
  const { generate, answer_composition_generation } = finishingModel();
  let runtime: Awaited<ReturnType<typeof startOrganizationAuthorityApiRuntime>> | undefined;
  let origin = ''; let token = '';
  beforeAll(async () => {
    const f = await fixture(shared);
    runtime = await startOrganizationAuthorityApiRuntime(f.config, { oidc_provider: f.oidc, answer_composition_generation });
    origin = `http://127.0.0.1:${runtime.address.port}`;
    token = await f.login(origin);
  });
  afterAll(async () => { await runtime?.close(); shared.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
  beforeEach(() => { generate.mockClear(); });

  it.each([
    { version: 4, schema: 5, mine: false }, { version: 4, schema: 5, mine: true }, { version: 5, schema: 6, mine: false }, { version: 5, schema: 6, mine: true },
    // The V7 Ask (ADR-0040) is mounted with the runtime's follow-up sources: outside Mine its catalog lists follow-ups.
    { version: 6, schema: 7, mine: false }, { version: 6, schema: 7, mine: true },
  ])('serves V$version Ask with no live connectors (mine=$mine)', async ({ version, schema, mine }) => {
    const response = await fetch(`${origin}/v${version}/person/ask`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 3, question: 'What changed?', ...(mine ? { mine: true } : {}) }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-echo-person-ask-route')).toBe(version >= 5 ? String(version) : null);
    expect(await response.json()).toMatchObject({ schema_version: schema, scope: { kind: mine ? 'mine' : 'global' }, citations: [] });
    expect(generate).toHaveBeenCalled();
    const [prompt] = generate.mock.calls[0] as unknown as [{ readonly user_prompt: string }];
    const catalog = (JSON.parse(prompt.user_prompt) as { source_catalog?: { source: string }[] }).source_catalog?.map(entry => entry.source) ?? [];
    expect(catalog.includes('follow_ups')).toBe(version === 6 && !mine);
  });
});

it('closes already opened connectors if a later registered connector fails to start', async () => {
  const f = await fixture();
  const close = vi.fn();
  const definition = (source_id: string): Omit<PersonLiveConnectorDefinitionV1, 'open'> => ({
    descriptor: { source_id, selector: source_id, kind: 'page', description: 'Live pages', metadata_only_list: true },
    scopes: ['global'], minimum_response_version: 6,
  });
  await expect(startOrganizationAuthorityApiRuntime(f.config, { oidc_provider: f.oidc, live_connectors: [
    { ...definition('first'), open: () => ({ application: { source: async () => undefined }, close }) },
    { ...definition('second'), open: () => { throw new Error('connector startup failed'); } },
  ] })).rejects.toThrow('connector startup failed');
  expect(close).toHaveBeenCalledTimes(1);
});

it('answers one authenticated HTTP question from approved Granola records, a document, Jira and Slack with current audited citations', async () => {
  const f = await allSourceFixture();
  try {
    const response = await f.ask();
    expect(response.status).toBe(200);
    const answer = validatePersonAnswerResponseV5(response.body);
    expect(answer.outcome).toBe('answered');
    expect(answer.citations.map(item => item.kind).sort()).toEqual(['decision', 'document_passage', 'slack_message', 'slack_message', 'ticket']);
    expect(answer.citations.map(item => item.citation.kind).sort()).toEqual(['approved_record', 'slack_message', 'slack_message', 'source_revision', 'ticket']);
    expect(answer.citations.find(item => item.kind === 'decision')?.citation).toMatchObject({ record_sha256: f.seeded.approved_record_sha256 });
    expect(answer.citations.find(item => item.kind === 'ticket')?.citation).toMatchObject({ tool_id: 'jira', ticket_id: '10001', external_scope_id: FIXTURE_JIRA_CLOUD_V1, permalink: `${FIXTURE_JIRA_SITE_V1}/browse/ECHO-1` });
    expect(answer.citations.find(item => item.kind === 'slack_message')?.citation).toEqual({ kind: 'slack_message', team_id: SLACK_TEAM, channel_id: SLACK_CHANNEL, message_ts: f.live.ts, permalink: `https://crosssource.slack.com/archives/${SLACK_CHANNEL}/p${f.live.ts.replace('.', '')}`, text_sha256: sha256Digest(SLACK_TEXT) });
    for (const text of [f.seeded.approved_text, DOCUMENT_TEXT, JIRA_TEXT, SLACK_TEXT]) expect(f.prompts.join('\n')).toContain(text);
    expect(f.generate).toHaveBeenCalledTimes(4);
    const jiraSearches = f.live.jiraFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/search/jql'));
    expect(jiraSearches).toHaveLength(1);
    expect(JSON.parse(String(jiraSearches[0]![1]?.body)).jql).not.toContain('project =');
    expect(f.live.jiraFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/issue/10001')).length).toBeGreaterThanOrEqual(1);
    const rechecks = f.live.jiraFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/issue/bulkfetch'));
    expect(rechecks.length).toBeGreaterThanOrEqual(2);
    for (const [, request] of rechecks) expect(JSON.parse(String(request?.body)).issueIdsOrKeys).toEqual(['10001']);
    expect(f.live.slackCalls.some(call => call.method === 'revalidate')).toBe(true);
    expect(f.live.slackCalls.length).toBeLessThanOrEqual(48);
    const auditRows = f.database.prepare('SELECT body_json FROM authority_person_read_decision_audit_v2').all() as { body_json: string }[];
    const terminal = auditRows.map(row => JSON.parse(row.body_json) as Record<string, unknown>).find(row => row.kind === 'echo-person-agentic-ask-audit-v1');
    expect(terminal).toMatchObject({ outcome: 'answered', model_calls: 4, response_sha256: canonicalSha256(answer) });
    for (const row of auditRows) for (const forbidden of [JIRA_TEXT, SLACK_TEXT, PRIVATE_DOCUMENT_TEXT, 'synthetic-jira-oauth-bearer']) expect(row.body_json).not.toContain(forbidden);
    const released = JSON.stringify(answer);
    expect(released).not.toContain(f.seeded.hidden_text); expect(released).not.toContain(PRIVATE_DOCUMENT_TEXT);
    expect(released).not.toContain(f.seeded.unapproved_text);
  } finally { await f.close(); }
});

it('omits a disconnected Slack source without provider calls or fabricated Slack citations', async () => {
  const f = await allSourceFixture();
  try {
    f.live.disconnectSlack();
    const response = await f.ask();
    expect(response.status).toBe(200);
    const answer = validatePersonAnswerResponseV5(response.body);
    expect(answer.citations.map(item => item.kind).sort()).toEqual(['decision', 'document_passage', 'ticket']);
    expect(f.live.slackRead).not.toHaveBeenCalled();
    expect(f.prompts.join('\n')).not.toContain(SLACK_TEXT);
    expect(f.generate).toHaveBeenCalledTimes(4);
  } finally { await f.close(); }
});

it('returns a meeting record through the public evidence search and open doors without its list label (ADR-0041, X21)', async () => {
  // The desk names a meeting record in Ask's list rows by a line of its own text; that label, like named dates and refs,
  // is internal research metadata, and the public desk contract carries none of it.
  const f = await allSourceFixture();
  try {
    const searched = await f.post(PERSON_EVIDENCE_SEARCH_PATH_V1, { schema_version: 1, query: 'Launchscope' });
    expect(searched.status).toBe(200);
    const record = validatePersonEvidenceDeskResponseV1(searched.body).items.find(item => item.citation.kind === 'approved_record' && item.citation.record_sha256 === f.seeded.approved_record_sha256);
    expect(record).toMatchObject({ kind: 'decision', text: f.seeded.approved_text });
    const opened = await f.post(PERSON_EVIDENCE_OPEN_PATH_V1, { schema_version: 1, citation: record!.citation });
    expect(opened.status).toBe(200);
    for (const response of [searched, opened]) {
      const records = validatePersonEvidenceDeskResponseV1(response.body).items.filter(item => item.citation.kind === 'approved_record');
      expect(records.length).toBeGreaterThan(0);
      for (const item of records) for (const key of ['list_label', 'ref', 'dates', 'date_kind']) expect(item).not.toHaveProperty(key);
      expect(JSON.stringify(response.body)).not.toContain(`${f.seeded.approved_text} (`);
    }
  } finally { await f.close(); }
});

it('refuses unauthenticated Ask and revoked Slack reads without releasing provider evidence', async () => {
  const f = await allSourceFixture();
  try {
    const jiraBefore = f.live.jiraFetch.mock.calls.length;
    expect((await f.post('/v4/person/ask', { schema_version: 3, question: 'Launchscope' }, 'invalid-person-session')).status).toBe(401);
    expect(f.live.jiraFetch).toHaveBeenCalledTimes(jiraBefore); expect(f.live.slackRead).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
    f.live.denySlack();
    const denied = await f.ask();
    expect(denied.status).toBe(401);
    expect(f.live.slackRead).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(denied.body)).not.toContain(SLACK_TEXT);
  } finally { await f.close(); }
});

it.each(['slack', 'jira'] as const)('withholds %s evidence when permission fails during its provider read', async tool => {
  const f = await allSourceFixture();
  try {
    if (tool === 'slack') f.live.revokeSlackDuringRead();
    else f.live.denyJira();
    const response = await f.ask();
    expect(response.status).toBe(401);
    expect(f.generate).toHaveBeenCalledTimes(1);
    const deniedText = tool === 'slack' ? SLACK_TEXT : JIRA_TEXT;
    expect(f.prompts.join('\n')).not.toContain(deniedText);
    expect(JSON.stringify(response.body)).not.toContain(deniedText);
  } finally { await f.close(); }
});

it('suppresses the completed answer when Slack permission is revoked during its final model call', async () => {
  const f = await allSourceFixture();
  try {
    f.beforeAnswerReturn(() => f.live.denySlack());
    const response = await f.ask();
    expect(response.status).toBe(401);
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(f.prompts.at(-1)).toContain(SLACK_TEXT); // The earlier authorized release reached the answer model.
    const released = JSON.stringify(response.body);
    for (const text of [SLACK_TEXT, JIRA_TEXT, DOCUMENT_TEXT, f.seeded.approved_text]) expect(released).not.toContain(text);
    expect(response.body).not.toHaveProperty('citations');
    expect(f.database.prepare("SELECT count(*) AS n FROM authority_person_read_decision_audit_v2 WHERE body_json LIKE '%echo-person-agentic-ask-audit-v1%' AND body_json LIKE '%\"outcome\":\"answered\"%'").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it('withholds an audited answer when Jira disconnects during the last awaited Slack release fence', async () => {
  const f = await allSourceFixture();
  try {
    let disconnected = false;
    f.live.beforeSlackResponse(async () => {
      const terminal = f.database.prepare("SELECT 1 FROM authority_person_read_decision_audit_v2 WHERE body_json LIKE '%echo-person-agentic-ask-audit-v1%' AND body_json LIKE '%\"outcome\":\"answered\"%'").get();
      if (terminal === undefined || disconnected) return;
      disconnected = true;
      // A real authenticated disconnect changes the same durable grant that the request captured.
      expect(await f.post('/v1/person/tools/jira/disconnect', { schema_version: 1 })).toMatchObject({ status: 200, body: { connected: false } });
    });
    const response = await f.ask();
    expect(disconnected).toBe(true);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'stale_access_state' } });
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(response.body).not.toHaveProperty('citations');
    const released = JSON.stringify(response.body);
    for (const text of [SLACK_TEXT, JIRA_TEXT, DOCUMENT_TEXT, f.seeded.approved_text]) expect(released).not.toContain(text);
  } finally { await f.close(); }
});
