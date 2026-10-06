import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { readPrivateAuthorityCredential } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import { runOrganizationAuthoritySetupCli } from '../src/composition/organization-authority-setup-cli.js';
import { openStagingConnectorRehearsalService } from '../src/composition/staging-connector-rehearsal-runtime.js';
import { STAGING_CONNECTOR_REHEARSAL_POLICY_V3 } from '../src/composition/staging-connector-rehearsal-protocol.js';
import { readOrganizationAuthoritySetupManifest } from '../src/composition/organization-authority-setup-cli.js';
import { readPersonOidcConfiguration } from '../src/composition/organization-authority-person-administration-cli.js';
import { PERSON_ANSWER_PATH_V4 } from '@echo-brain/organization-api';
import { validateOrganizationPersonToolsV4, validatePersonAnswerResponseV5 } from '@echo-brain/organization-api';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { FIXTURE_CLOUD, configuration, connectSlackAndLinkOwner, port, prepare, privateFile, providerSeams, signInOwner } from './fixtures/connector-rehearsal-runtime-fixture-v1.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function selection() {
  return { release_id: 'clean-v1-staging-connector', authority_host: 'authority-staging.echobrain.org', profile: {
    schema_version: 3 as const, kind: 'echo-staging-connector-rehearsal-profile-v3' as const,
    read_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V3 as typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V3,
    jira: { cloud_id: FIXTURE_CLOUD, integration_key: 'jira', project: 'ECHO' },
  } };
}

it('exposes the Jira-only rehearsal protocol and reuses the owner Jira grant for live Ask across restart', async () => {
  const root = join(realpathSync(tmpdir()), `echo-staging-connector-${randomUUID()}`); roots.push(root);
  prepare(root);
  const config = configuration(root);
  privateFile(config.oidc.config_file, JSON.stringify({ issuer: 'https://issuer.example.test', client_id: 'connector-rehearsal-client', redirect_uri: `${STAGING_AUTHORITY_ORIGIN_V1}/v2/session/oidc/callback`, tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'], client_authentication: 'none' }));
  privateFile(config.nango.secret_key_file, 'synthetic-nango-key-0000000000000000'); privateFile(config.openrouter.credential_file, 'synthetic-openrouter-key-000000000000');
  const stateDirectory = join(root, 'state');
  expect(await runOrganizationAuthoritySetupCli(['bootstrap', '--state-dir', stateDirectory, '--organization-name', config.organization_name, '--owner-display-name', config.owner_name, '--owner-email', config.owner_email, '--authority-url', STAGING_AUTHORITY_ORIGIN_V1, '--oidc-config', config.oidc.config_file], { stdout: () => {}, stderr: () => {} })).toBe(0);
  expect(await runOrganizationAuthoritySetupCli(['credentials-install', '--state-dir', stateDirectory, '--llm-credential-file', config.openrouter.credential_file], { stdout: () => {}, stderr: () => {} })).toBe(0);
  const manifest = readOrganizationAuthoritySetupManifest(join(root, 'state'));
  const oidc = readPersonOidcConfiguration(config.oidc.config_file);
  const seams = providerSeams();
  const originalFetch = globalThis.fetch;
  const slackReads: string[] = [];
  let modelCalls = 0;
  let modelRequests = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://slack.com') {
      // The bot only delivers. Nothing here may read Slack.
      slackReads.push(url.pathname);
      throw new Error(`unexpected Slack read ${url.pathname}`);
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
    if (url.hostname === 'openrouter.ai') {
      modelRequests += 1;
      if (url.pathname.endsWith('/chat/completions')) modelCalls += 1;
    }
    throw new Error(`unexpected remote endpoint ${url.origin}`);
  });
  const selected = selection();
  let jiraAskEnabled = false;
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; source_catalog?: { tool_id?: string }[]; last_results?: { results?: { id: string }[] }[]; opened?: { id: string }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) return { sentences: [{ text: 'The ticket says ship on Friday.', evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    if (!prompt.source_catalog?.some(source => source.tool_id === 'jira')) return { parts: [{ question: prompt.question, needs: [{ need: 'ship day', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    const opened = prompt.opened?.[0]?.id;
    if (opened !== undefined) return { parts: [{ question: prompt.question, needs: [{ need: 'ship day', status: 'found', evidence: [opened] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    const hit = prompt.last_results?.[0]?.results?.[0]?.id;
    return { parts: [{ question: prompt.question, needs: [{ need: 'ship day', status: 'open', evidence: [] }], notes: '' }],
      actions: [hit === undefined ? { tool: 'search', args: { query: 'ship', source: 'tickets' } } : { tool: 'open', args: { id: hit } }] };
  });
  const profile_sha256 = canonicalSha256(selected.profile);
  privateFile(join(root, 'private', 'staging-connector-rehearsal.json'), JSON.stringify(selected.profile));
  const open = async () => openStagingConnectorRehearsalService({
    state_directory: manifest.state_directory, authority_url: STAGING_AUTHORITY_ORIGIN_V1, host: '127.0.0.1', port: await port(), worker_interval_ms: 60_000,
    oidc: oidc.configuration, client_authentication: { method: 'none' }, pkce_key_file: manifest.pkce_key_file,
    slack_nango: { secret_key: readPrivateAuthorityCredential(`file:${config.nango.secret_key_file}`), integration_key: 'slack' },
    ...(jiraAskEnabled ? { jira_person_live: { enabled: true as const, cloud_id: FIXTURE_CLOUD, integration_id: 'jira', nango_authorization: () => 'synthetic-nango-key-0000000000000000' } } : {}),
    openrouter_credential_file: manifest.llm_credential_file,
  }, selected, { api: { oidc_provider: seams.oidc_provider,
    answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 25_000 } },
  }, slack: seams.slack, jira: seams.jira_person_live_seams });
  let runtime = await open();
  let owner = '';
  let jiraAttempt = '';
  const post = async (path: string, body: unknown, token = owner) => {
    const response = await fetch(`http://127.0.0.1:${runtime.address.port}${path}`, { method: 'POST', headers: { ...(token === '' ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const verifyRead = (tool: 'jira') => post('/v1/staging/connector-rehearsal', { schema_version: 3, release_id: selected.release_id, profile_sha256, action: 'verify-read', tool });
  try {
    owner = await signInOwner(`http://127.0.0.1:${runtime.address.port}`, seams, manifest.invitation_path);
    const beforeUnconnected = seams.jiraFetch.mock.calls.length;
    expect(await verifyRead('jira')).toMatchObject({ status: 200, body: { action: 'verify-read', qualified: false, result: { status: 'refused', phase: 'connection', reason: 'connection_absent' } } });
    expect(seams.jiraFetch).toHaveBeenCalledTimes(beforeUnconnected);
    const connect = await post('/v1/person/tools/jira/connect', { schema_version: 1 });
    expect(connect.status).toBe(201);
    seams.finishJira();
    const attempt = connect.body.attempt as string; jiraAttempt = attempt;
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
    const before = seams.jiraFetch.mock.calls.length;
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'granola', limit: 1 })).status).toBe(400);
    expect(seams.jiraFetch).toHaveBeenCalledTimes(before);
    // A token from before the delivery-only manifest may still hold the two retired channel scopes.
    await connectSlackAndLinkOwner(post, seams, ['channels:history', 'channels:read', 'chat:write', 'im:history', 'im:write', 'users:read']);
  } finally { await runtime.close(); }
  const finalizeErrors: string[] = []; const finalized = await runOrganizationAuthoritySetupCli(['finalize', '--state-dir', stateDirectory], { stdout: () => {}, stderr: value => finalizeErrors.push(value) }); expect(finalized, finalizeErrors.join('')).toBe(0);
  runtime = await open();
  try {
    expect(runtime.processing).toBe('active');
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: jiraAttempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
    const custodyCounts = () => {
      const database = new Database(join(manifest.state_directory, 'authority.sqlite'), { readonly: true });
      try { return ['authority_sources_v1', 'authority_source_revisions_v1', 'authority_source_contents_v1', 'authority_source_representations_v1']
        .map(table => database.prepare(`SELECT count(*) AS count FROM ${table}`).get()); }
      finally { database.close(); }
    };
    const custodyBefore = custodyCounts();
    const readStart = slackReads.length;
    const jiraStart = seams.jiraFetch.mock.calls.length;
    const modelRequestsBefore = modelRequests;
    for (const [tool, text] of [['jira', 'ECHO-1: Ship on Friday\n\nThe ticket body stays with Jira.']] as const) {
      const proof = await verifyRead(tool);
      expect(proof).toMatchObject({ status: 200, body: { action: 'verify-read', tool, qualified: false, result: {
        status: 'verified', source_coordinate_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        text_sha256: `sha256:${createHash('sha256').update(text).digest('hex')}`, text_bytes: Buffer.byteLength(text),
      } } });
      expect(JSON.stringify(proof.body)).not.toContain(text);
    }
    expect(slackReads.slice(readStart)).toEqual([]);
    const jiraReads = seams.jiraFetch.mock.calls.slice(jiraStart);
    expect(jiraReads).toHaveLength(25);
    expect(jiraReads.filter(([input]) => String(input).includes('/issue/10001'))).toHaveLength(2);
    const rechecks = jiraReads.filter(([input]) => String(input).includes('/issue/bulkfetch'));
    expect(rechecks).toHaveLength(1);
    expect(JSON.parse(String(rechecks[0]![1]?.body)).issueIdsOrKeys).toEqual(['10001']);
    const searches = jiraReads.filter(([input]) => String(input).includes('/search/jql'));
    expect(searches).toHaveLength(1);
    expect(JSON.parse(String(searches[0]![1]?.body))).toMatchObject({ jql: 'project = 10000 ORDER BY created DESC, id DESC', maxResults: 1 });
    expect(custodyCounts()).toEqual(custodyBefore);
    expect(modelCalls).toBe(0);
    expect(modelRequests).toBe(modelRequestsBefore);
    // Slack has no verify-read: the bot never reads, and person reads are not built yet.
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 3, release_id: selected.release_id, profile_sha256, action: 'verify-read', tool: 'slack' })).status).toBe(400);
    const jiraBeforeMismatch = seams.jiraFetch.mock.calls.length;
    for (const mismatch of [{ release_id: 'clean-v1-other-release' }, { profile_sha256: canonicalSha256('other') }]) {
      expect((await post('/v1/staging/connector-rehearsal', { schema_version: 3, release_id: selected.release_id, profile_sha256, action: 'verify-read', tool: 'jira', ...mismatch })).status).toBe(503);
    }
    expect(seams.jiraFetch).toHaveBeenCalledTimes(jiraBeforeMismatch);
    expect(slackReads).toEqual([]);
    // Local Ask remains available before Jira Ask is selected, without reading Jira.
    const jiraBeforeLocalAsk = seams.jiraFetch.mock.calls.length;
    expect(await post(PERSON_ANSWER_PATH_V4, { schema_version: 3, question: 'fixture' })).toMatchObject({ status: 200, body: { schema_version: 5, citations: [] } });
    expect(seams.jiraFetch).toHaveBeenCalledTimes(jiraBeforeLocalAsk);
      await runtime.close();
    jiraAskEnabled = true;
    runtime = await open();
    // Enabling Ask reuses the existing consent in the same profile-bound sidecar.
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: jiraAttempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
    const custodyBeforeAsk = custodyCounts();
    const tools = async (token = owner) => {
      const response = await fetch(`http://127.0.0.1:${runtime.address.port}/v4/person/tools`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      return validateOrganizationPersonToolsV4(await response.json()).tools;
    };
    const catalog = await tools();
    expect(catalog.map(tool => tool.tool_id).sort()).toEqual(['granola', 'jira', 'slack']);
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'jira', availability: 'enabled', personal_status: 'linked', external_scope_id: FIXTURE_CLOUD })]));
    // Each Person can connect Jira, without seeing or using the owner's grant.
    const invited = await post('/v1/person/employees', { name: 'Fixture Employee', email: 'employee@example.test' });
    expect(invited.status).toBe(201);
    const redeem = seams.oidc_provider.redeemAuthorizationCode;
    vi.spyOn(seams.oidc_provider, 'redeemAuthorizationCode').mockImplementation(async () => {
      const result = await redeem();
      return { ...result, token: { ...result.token, subject: 'fixture-employee', claims: { email: 'employee@example.test', email_verified: true } } };
    });
    expect((await post('/v2/session/oidc/begin', { kind: 'identity_bootstrap', login_grant: invited.body.login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } })).status).toBe(201);
    const page = await (await fetch(`http://127.0.0.1:${runtime.address.port}/v2/session/oidc/callback?state=${encodeURIComponent(seams.oidcState())}&code=employee`)).text();
    const employee = (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(page)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
    const employeeCatalog = await tools(employee);
    expect(employeeCatalog.map(tool => tool.tool_id).sort()).toEqual(['granola', 'jira', 'slack']);
    expect(employeeCatalog).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'jira', availability: 'enabled', personal_status: 'unlinked', external_scope_id: null, external_subject_id: null })]));
    const employeeConnect = await post('/v1/person/tools/jira/connect', { schema_version: 1 }, employee);
    expect(employeeConnect.status).toBe(201);
    seams.finishJira();
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: employeeConnect.body.attempt }, employee)).toMatchObject({ status: 200, body: { status: 'complete' } });
    const globalReadStart = seams.jiraFetch.mock.calls.length;
    const connections = vi.mocked(seams.jira_person_live_seams.nango.connection);
    const ownerConnectionStart = connections.mock.calls.length;
    generate.mockClear();
    const answerResponse = await post(PERSON_ANSWER_PATH_V4, { schema_version: 3, question: 'When should the ticket ship?' });
    expect(answerResponse.status).toBe(200);
    const answer = validatePersonAnswerResponseV5(answerResponse.body);
    expect(answer.citations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ticket', citation: expect.objectContaining({ ticket_id: '10001' }) })]));
    const globalSearches = seams.jiraFetch.mock.calls.slice(globalReadStart).filter(([url]) => String(url).endsWith('/search/jql'));
    expect(globalSearches).toHaveLength(1);
    expect(JSON.parse(String(globalSearches[0]![1]?.body)).jql).not.toContain('project =');
    expect(generate).toHaveBeenCalledTimes(4);
    const ownerReferences = new Set(connections.mock.calls.slice(ownerConnectionStart).map(([reference]) => reference));
    expect(ownerReferences.size).toBe(1);
    const employeeConnectionStart = connections.mock.calls.length;
    const employeeAnswer = await post(PERSON_ANSWER_PATH_V4, { schema_version: 3, question: 'When should the ticket ship?' }, employee);
    expect(employeeAnswer.status).toBe(200);
    expect(validatePersonAnswerResponseV5(employeeAnswer.body).citations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ticket' })]));
    const employeeReferences = new Set(connections.mock.calls.slice(employeeConnectionStart).map(([reference]) => reference));
    expect(employeeReferences.size).toBe(1);
    expect([...employeeReferences].some(reference => ownerReferences.has(reference))).toBe(false);
    expect(custodyCounts()).toEqual(custodyBeforeAsk);
    const control = new Database(join(manifest.state_directory, 'integrations.sqlite'));
    try { control.prepare("UPDATE organization_external_human_link_current SET current_status='revoked'").run(); } finally { control.close(); }
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 3, release_id: selected.release_id, profile_sha256, action: 'verify-read', tool: 'slack' })).status).toBe(400);
    expect(slackReads).toEqual([]);
  } finally { await runtime.close(); }
});
