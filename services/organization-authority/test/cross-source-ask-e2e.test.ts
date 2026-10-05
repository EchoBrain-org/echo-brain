import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV5 } from '@echo-brain/organization-api';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { readPrivateAuthorityPersonSessionPkceKey } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import type { BegunPersonOidcLogin } from '../src/application/person-identity-sessions.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials, issuePersonOnboardingInvitation } from '../src/composition/person-onboarding-service.js';
import { startOrganizationAuthorityApiRuntime } from '../src/composition/organization-authority-api-runtime.js';
import { openJiraPersonLiveRuntimeV1 } from '../src/composition/jira-person-live-runtime-v1.js';
import type { PersonLiveConnectorDefinitionV1 } from '../src/application/ports/person-context-live-runtime-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { port } from './fixtures/connector-rehearsal-runtime-fixture-v1.js';
import { crossSourceLiveFixture, JIRA_TEXT, SLACK_TEXT, SLACK_CHANNEL, SLACK_TEAM } from './fixtures/cross-source-live-fixture.js';
import { seedCrossSourceRecords } from './fixtures/cross-source-record-fixture.js';
import { authorization } from './fixtures/project-context-sqlite.js';
import { FIXTURE_JIRA_CLOUD_V1, FIXTURE_JIRA_SITE_V1 } from './fixtures/fake-jira-v1.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const AUTHORITY = 'https://authority.example.test';
const EMAIL = 'cross-source@example.test';
const OIDC = { issuer: 'https://issuer.example.test', client_id: 'cross-source-client', redirect_uri: `${AUTHORITY}/v2/session/oidc/callback`, tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'] };

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-cross-source-ask-')));
  chmodSync(root, 0o700); roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: join(root, 'state'), organization_display_name: 'Cross-source fixture', owner_display_name: 'Fixture Owner', created_at: new Date(Date.now() - 1000).toISOString(), creating_artifact_revision: 'cross-source-http-test' });
  const credentials = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
  const key = readPrivateAuthorityPersonSessionPkceKey(credentials.pkce_sealing_key_reference);
  const invitation = join(root, 'invitation.json');
  issuePersonOnboardingInvitation({ state_directory: initialized.state_directory, oidc: OIDC, pkce_sealing_key: key, membership_id: initialized.owner_membership_id, expected_email: EMAIL, authority_url: AUTHORITY, output_path: invitation });
  let attempt: BegunPersonOidcLogin | undefined;
  const oidc = {
    buildAuthorizationUrl(value: BegunPersonOidcLogin) { attempt = value; return `${OIDC.issuer}/authorize?state=${encodeURIComponent(value.state)}`; },
    async redeemAuthorizationCode() { return { kind: 'verified' as const, token: { issuer: OIDC.issuer, subject: 'cross-source-owner', audience: OIDC.client_id, nonce: attempt!.nonce, issued_at: Math.floor(Date.now() / 1000), claims: { email: EMAIL, email_verified: true } } }; },
  };
  const config = { state_directory: initialized.state_directory, host: '127.0.0.1' as const, port: await port(), authority_url: AUTHORITY, oidc: OIDC, client_authentication: { method: 'none' as const }, pkce_sealing_key: key };
  const login = async (origin: string) => {
    const { login_grant } = JSON.parse(readFileSync(invitation, 'utf8')) as { login_grant: string };
    const begun = await fetch(`${origin}/v2/session/oidc/begin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'identity_bootstrap', login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } }) });
    expect(begun.status).toBe(201);
    const callback = await (await fetch(`${origin}/v2/session/oidc/callback?state=${encodeURIComponent(attempt!.state)}&code=synthetic`)).text();
    return (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(callback)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
  };
  return { initialized, config, oidc, login };
}

it('selects the Slack live runtime for authenticated Ask without inventing a disconnected grant', async () => {
  const f = await fixture();
  const source = vi.fn(async () => undefined);
  const close = vi.fn();
  const slack_live_runtime_factory = vi.fn(() => ({ application: { source }, close }));
  const generate = vi.fn(async () => ({ parts: [{ question: 'What changed?', needs: [{ need: 'changes', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] }));
  const dependencies = { oidc_provider: f.oidc, slack_live_runtime_factory, answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'synthetic', planner_model: 'synthetic', answer_model: 'synthetic', timeout_ms: 1000 } } };
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
  const generate = vi.fn(async () => ({ parts: [{ question: 'What changed?', needs: [{ need: 'changes', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] }));
  const runtime = await startOrganizationAuthorityApiRuntime(f.config, { oidc_provider: f.oidc, live_connectors,
    answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'synthetic', planner_model: 'synthetic', answer_model: 'synthetic', timeout_ms: 1000 } },
  });
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

it.each([{ version: 4, schema: 5, mine: false }, { version: 4, schema: 5, mine: true }, { version: 5, schema: 6, mine: false }, { version: 5, schema: 6, mine: true }])('serves V$version Ask with no live connectors (mine=$mine)', async ({ version, schema, mine }) => {
  const f = await fixture();
  const generate = vi.fn(async () => ({ parts: [{ question: 'What changed?', needs: [{ need: 'changes', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] }));
  const runtime = await startOrganizationAuthorityApiRuntime(f.config, { oidc_provider: f.oidc,
    answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'synthetic', planner_model: 'synthetic', answer_model: 'synthetic', timeout_ms: 1000 } },
  });
  try {
    const origin = `http://127.0.0.1:${runtime.address.port}`;
    const token = await f.login(origin);
    const response = await fetch(`${origin}/v${version}/person/ask`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 3, question: 'What changed?', ...(mine ? { mine: true } : {}) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schema_version: schema, scope: { kind: mine ? 'mine' : 'global' }, citations: [] });
    expect(generate).toHaveBeenCalled();
  } finally { await runtime.close(); }
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

const DOCUMENT_TEXT = 'Launchscope document: the rollout starts with the pilot group.';
const PRIVATE_DOCUMENT_TEXT = 'Launchscope private document DENIED-DOCUMENT-8137.';
type PromptItem = { readonly id: string; readonly text?: string; readonly title?: string; readonly full?: boolean };
type Prompt = { readonly question: string; readonly step?: number; readonly last_results?: readonly { readonly results?: readonly PromptItem[] }[]; readonly opened?: readonly PromptItem[]; readonly seen?: readonly PromptItem[]; readonly evidence?: readonly PromptItem[] };

async function allSourceFixture() {
  const f = await fixture();
  const seeded = await seedCrossSourceRecords(f.initialized.state_directory, f.initialized);
  const database = openAuthorityDatabase(join(f.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  const repository = new SqlitePersonDocumentRepositoryV1(database);
  for (const [actor, text, audience] of [
    [{ organization_id: f.initialized.organization_id, principal_id: f.initialized.owner_principal_id, membership_id: f.initialized.owner_membership_id, membership_type: 'owner' as const }, DOCUMENT_TEXT, 'team'],
    [seeded.hidden_actor, PRIVATE_DOCUMENT_TEXT, 'only_me'],
  ] as const) {
    const documents = createPersonDocumentApplicationV1({ repository, authenticate: () => authorization(actor) });
    const bytes = Buffer.from(text);
    documents.upload('synthetic-seed', { schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: randomUUID(), filename: 'launchscope.md', title: 'Launchscope document', content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: audience }, project_id: null }, bytes);
    const claim = repository.claimExtraction();
    if (claim === undefined) throw new Error('Missing synthetic document extraction claim');
    expect(repository.completeExtraction(claim, { status: 'ready', sourceSha256: claim.source_sha256, extractorVersion: 'cross-source-fixture-v1', chunks: [{ anchor_kind: 'paragraph', anchor_start: 1, text }], message: null })).toBe(true);
  }
  const live = crossSourceLiveFixture(f.initialized);
  const prompts: string[] = [];
  let beforeAnswerReturn: (() => void) | undefined;
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    prompts.push(input.user_prompt);
    expect(input.user_prompt).not.toContain(seeded.hidden_text);
    expect(input.user_prompt).not.toContain(seeded.unapproved_text);
    expect(input.user_prompt).not.toContain(PRIVATE_DOCUMENT_TEXT);
    const prompt = JSON.parse(input.user_prompt) as Prompt;
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
      beforeAnswerReturn?.();
      return { sentences: (prompt.evidence ?? []).map(item => ({ text: item.text!, evidence: [item.id] })), not_found: [] };
    }
    const hits = prompt.opened?.length ? [...prompt.opened, ...(prompt.seen ?? [])] : prompt.last_results?.flatMap(result => result.results ?? []) ?? [];
    if (hits.length > 0) {
      const rows = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE body_json LIKE '%echo-person-live-evidence-release-audit-v1%'").all() as { body_json: string }[];
      // Every provider passage has crossed the real durable release boundary before the next model call.
      if (input.user_prompt.includes(JIRA_TEXT)) expect(rows.some(row => row.body_json.includes('"tool_id":"jira"'))).toBe(true);
      if (input.user_prompt.includes(SLACK_TEXT)) expect(rows.some(row => row.body_json.includes('"tool_id":"slack"'))).toBe(true);
      const unopened = hits.filter(item => item.text === undefined && item.full !== true);
      if (unopened.length > 0) return { parts: [{ question: prompt.question, needs: [{ need: 'cross-source launch status', status: 'open', evidence: [] }], notes: '' }], actions: unopened.slice(0, 4).map(item => ({ tool: 'open', args: { id: item.id } })) };
      return { parts: [{ question: prompt.question, needs: [{ need: 'cross-source launch status', status: 'found', evidence: hits.map(item => item.id) }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    }
    return { parts: [{ question: prompt.question, needs: [{ need: 'cross-source launch status', status: prompt.step === 1 ? 'open' : 'not_found', evidence: [] }], notes: '' }], actions: prompt.step === 1 ? [{ tool: 'search', args: { query: 'Launchscope' } }] : [{ tool: 'finish', args: {} }] };
  });
  const runtime = await startOrganizationAuthorityApiRuntime(f.config, {
    oidc_provider: f.oidc,
    ticket_live_runtime_factory: sessions => openJiraPersonLiveRuntimeV1({ state_directory: f.initialized.state_directory, sessions,
      configuration: { enabled: true, cloud_id: FIXTURE_JIRA_CLOUD_V1, integration_id: 'jira', nango_authorization: () => 'synthetic-only-nango-authorization' }, seams: { nango: live.jira.nango, fetch: live.jiraFetch } }),
    slack_live_runtime_factory: live.slackFactory,
    answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'synthetic', planner_model: 'synthetic', answer_model: 'synthetic', timeout_ms: 25_000 } },
  });
  const origin = `http://127.0.0.1:${runtime.address.port}`;
  const token = await f.login(origin);
  const post = async (path: string, body: unknown, bearer = token) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const connect = await post('/v1/person/tools/jira/connect', { schema_version: 1 });
  expect(connect.status).toBe(201); live.jira.finish();
  expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: connect.body.attempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
  const ask = () => post('/v4/person/ask', { schema_version: 3, question: 'Combine the Launchscope approved meeting, document, Jira ticket, and Slack message.' });
  return { ...f, seeded, database, live, prompts, generate, post, ask,
    beforeAnswerReturn(callback: () => void) { beforeAnswerReturn = callback; },
    async close() { await runtime.close(); database.close(); } };
}

function hasRequiredSourceCoverage(answer: ReturnType<typeof validatePersonAnswerResponseV5>): boolean {
  return ['decision', 'document_passage', 'ticket', 'slack_message'].every(kind => answer.citations.some(item => item.kind === kind));
}

it('answers one authenticated HTTP question from approved Granola records, a document, Jira and Slack with current audited citations', async () => {
  const f = await allSourceFixture();
  try {
    const response = await f.ask();
    expect(response.status).toBe(200);
    const answer = validatePersonAnswerResponseV5(response.body);
    expect(answer.outcome).toBe('answered');
    expect(hasRequiredSourceCoverage(answer)).toBe(true);
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
    expect(hasRequiredSourceCoverage(answer)).toBe(false);
    expect(f.live.slackRead).not.toHaveBeenCalled();
    expect(f.prompts.join('\n')).not.toContain(SLACK_TEXT);
    expect(f.generate).toHaveBeenCalledTimes(4);
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
