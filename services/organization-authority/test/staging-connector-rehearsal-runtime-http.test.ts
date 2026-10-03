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
import { STAGING_CONNECTOR_REHEARSAL_POLICY_V2 } from '../src/composition/staging-connector-rehearsal-protocol.js';
import { readOrganizationAuthoritySetupManifest } from '../src/composition/organization-authority-setup-cli.js';
import { readPersonOidcConfiguration } from '../src/composition/organization-authority-person-administration-cli.js';
import { PERSON_ANSWER_PATH_V4 } from '@echo-brain/organization-api';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { FIXTURE_CLOUD, FIXTURE_EMAIL, configuration, connectSlackAndLinkOwner, port, prepare, privateFile, providerSeams, signInOwner } from './fixtures/connector-rehearsal-runtime-fixture-v1.js';
import { SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function selection() {
  return { release_id: 'clean-v1-staging-connector', authority_host: 'authority-staging.echobrain.org', profile: {
    schema_version: 2 as const, kind: 'echo-staging-connector-rehearsal-profile-v2' as const,
    capture_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V2 as typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V2,
    jira: { cloud_id: FIXTURE_CLOUD, integration_key: 'jira', project: 'ECHO' },
    slack: { channel_id: 'C01234567' },
  } };
}

it('serves owner-bound Jira connection and retained Granola, Jira and Slack pointer capture through staging HTTP across restart', async () => {
  const root = join(realpathSync(tmpdir()), `echo-staging-connector-${randomUUID()}`); roots.push(root);
  prepare(root);
  const config = configuration(root);
  privateFile(config.oidc.config_file, JSON.stringify({ issuer: 'https://issuer.example.test', client_id: 'connector-rehearsal-client', redirect_uri: `${STAGING_AUTHORITY_ORIGIN_V1}/v2/session/oidc/callback`, tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'], client_authentication: 'none' }));
  privateFile(config.nango.secret_key_file, 'synthetic-nango-key-0000000000000000'); privateFile(config.granola.credential_file, `grn_${'a'.repeat(32)}`); privateFile(config.granola.owner_email_file, FIXTURE_EMAIL); privateFile(config.openrouter.credential_file, 'synthetic-openrouter-key-000000000000');
  const stateDirectory = join(root, 'state');
  expect(await runOrganizationAuthoritySetupCli(['bootstrap', '--state-dir', stateDirectory, '--organization-name', config.organization_name, '--owner-display-name', config.owner_name, '--owner-email', config.owner_email, '--authority-url', STAGING_AUTHORITY_ORIGIN_V1, '--oidc-config', config.oidc.config_file], { stdout: () => {}, stderr: () => {} })).toBe(0);
  expect(await runOrganizationAuthoritySetupCli(['credentials-install', '--state-dir', stateDirectory, '--granola-credential-file', config.granola.credential_file, '--granola-owner-email-file', config.granola.owner_email_file, '--llm-credential-file', config.openrouter.credential_file], { stdout: () => {}, stderr: () => {} })).toBe(0);
  const manifest = readOrganizationAuthoritySetupManifest(join(root, 'state'));
  const oidc = readPersonOidcConfiguration(config.oidc.config_file);
  const seams = providerSeams();
  const originalFetch = globalThis.fetch;
  const slackReads: string[] = [];
  let slackEmpty = false;
  let granolaVisible = false;
  let modelCalls = 0;
  let modelRequests = 0;
  const slackText = 'Slack body must not be retained.';
  const slackTimestamp = `${Math.floor(Date.now() / 1000) - 60}.123456`;
  const granolaTimestamp = new Date(Date.now() + 60_000).toISOString();
  const granolaNote = { id: 'fixture-note', object: 'note', title: 'Staging retained capture', created_at: granolaTimestamp, updated_at: granolaTimestamp, summary_markdown: '## Decision\nRetain this synthetic meeting.', owner: { name: 'Founder', email: 'founder@example.test' }, attendees: [{ id: 'owner', email: 'founder@example.test' }], calendar_event: { start: { dateTime: granolaTimestamp } }, web_url: 'https://app.granola.ai/notes/fixture-note', transcript: [{ text: 'This is the retained synthetic transcript.', speaker: 'Founder' }] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://public-api.granola.ai') {
      if (url.pathname === '/v1/notes') return Response.json({ notes: granolaVisible ? [{ id: granolaNote.id, created_at: granolaNote.created_at, updated_at: granolaNote.updated_at, owner: granolaNote.owner }] : [], hasMore: false, cursor: null });
      if (url.pathname === `/v1/notes/${granolaNote.id}`) return Response.json(granolaNote);
      throw new Error(`unexpected Granola endpoint ${url.pathname}`);
    }
    if (url.origin === 'https://slack.com') {
      slackReads.push(url.pathname);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-synthetic-slack');
      if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: 'TFIXTURE', user_id: 'UBOTFIXTURE', url: 'https://fixture.slack.com/' });
      expect(url.searchParams.get('channel')).toBe('C01234567');
      if (url.pathname === '/api/conversations.info') return Response.json({ ok: true, channel: { id: 'C01234567', name: 'echo-test', is_member: true, is_private: false, context_team_id: 'TFIXTURE' } });
      if (url.pathname === '/api/conversations.history') {
        expect(url.searchParams.get('limit')).toBe('1');
        return Response.json({ ok: true, messages: slackEmpty ? [] : [{ type: 'message', ts: slackTimestamp, user: 'UFOUNDER', text: slackText }], has_more: false });
      }
      if (url.pathname === '/api/chat.getPermalink') return Response.json({ ok: true, channel: 'C01234567', permalink: `https://fixture.slack.com/archives/C01234567/p${slackTimestamp.replace('.', '')}` });
      throw new Error(`unexpected Slack endpoint ${url.pathname}`);
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
    if (url.hostname === 'openrouter.ai') {
      modelRequests += 1;
      if (url.pathname.endsWith('/chat/completions')) modelCalls += 1;
    }
    throw new Error(`unexpected remote endpoint ${url.origin}`);
  });
  const selected = selection();
  const profile_sha256 = canonicalSha256(selected.profile);
  privateFile(join(root, 'private', 'staging-connector-rehearsal.json'), JSON.stringify(selected.profile));
  const open = async () => openStagingConnectorRehearsalService({
    state_directory: manifest.state_directory, authority_url: STAGING_AUTHORITY_ORIGIN_V1, host: '127.0.0.1', port: await port(), worker_interval_ms: 60_000,
    oidc: oidc.configuration, client_authentication: { method: 'none' }, pkce_key_file: manifest.pkce_key_file,
    slack_nango: { secret_key: readPrivateAuthorityCredential(`file:${config.nango.secret_key_file}`), integration_key: 'slack' },
    granola_credential_file: manifest.granola_credential_file, granola_owner_email_file: manifest.granola_owner_email_file, openrouter_credential_file: manifest.llm_credential_file,
  }, selected, { api: { oidc_provider: seams.oidc_provider }, slack: seams.slack, jira: seams.jira_person_live_seams });
  let runtime = await open();
  let owner = '';
  let jiraAttempt = '';
  const post = async (path: string, body: unknown, token = owner) => {
    const response = await fetch(`http://127.0.0.1:${runtime.address.port}${path}`, { method: 'POST', headers: { ...(token === '' ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const capture = (tool: 'granola' | 'jira' | 'slack') => post('/v1/staging/connector-rehearsal', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'capture', tool, limit: 1 });
  const verifyRead = (tool: 'jira' | 'slack') => post('/v1/staging/connector-rehearsal', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'verify-read', tool });
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
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 1, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'jira', limit: 1 })).status).toBe(400);
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 2, release_id: 'clean-v1-wrong-binding', profile_sha256, action: 'capture', tool: 'jira', limit: 1 })).status).toBe(503);
    expect(seams.jiraFetch).toHaveBeenCalledTimes(before);
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'jira', limit: 1 }, '')).status).toBe(401);
    await connectSlackAndLinkOwner(post, seams, SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1);
  } finally { await runtime.close(); }
  granolaVisible = true;
  const finalizeErrors: string[] = []; const finalized = await runOrganizationAuthoritySetupCli(['finalize', '--state-dir', stateDirectory], { stdout: () => {}, stderr: value => finalizeErrors.push(value) }); expect(finalized, finalizeErrors.join('')).toBe(0);
  granolaVisible = false;
  runtime = await open();
  try {
    expect(runtime.processing).toBe('active');
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: jiraAttempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
    const beforeCapture = new Database(join(manifest.state_directory, 'authority.sqlite'), { readonly: true });
    const cursorBefore = (beforeCapture.prepare('SELECT cursor AS source_cursor FROM authority_live_source_progress_v2 WHERE singleton=1').get() as { source_cursor: string }).source_cursor; beforeCapture.close();
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
    for (const [tool, text] of [['slack', slackText], ['jira', 'ECHO-1: Ship on Friday\n\nThe ticket body stays with Jira.']] as const) {
      const proof = await verifyRead(tool);
      expect(proof).toMatchObject({ status: 200, body: { action: 'verify-read', tool, qualified: false, result: {
        status: 'verified', source_coordinate_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        text_sha256: `sha256:${createHash('sha256').update(text).digest('hex')}`, text_bytes: Buffer.byteLength(text),
      } } });
      expect(JSON.stringify(proof.body)).not.toContain(text);
    }
    expect(slackReads.slice(readStart).filter(path => path === '/api/conversations.history')).toHaveLength(3);
    const jiraReads = seams.jiraFetch.mock.calls.slice(jiraStart);
    expect(jiraReads).toHaveLength(25);
    expect(jiraReads.filter(([input]) => String(input).includes('/issue/10001'))).toHaveLength(3);
    const searches = jiraReads.filter(([input]) => String(input).includes('/search/jql'));
    expect(searches).toHaveLength(1);
    expect(JSON.parse(String(searches[0]![1]?.body))).toMatchObject({ jql: 'project = 10000 ORDER BY created DESC, id DESC', maxResults: 1 });
    expect(custodyCounts()).toEqual(custodyBefore);
    expect(modelCalls).toBe(0);
    expect(modelRequests).toBe(modelRequestsBefore);
    slackEmpty = true;
    expect(await verifyRead('slack')).toMatchObject({ status: 200, body: { result: { status: 'refused', phase: 'inventory', reason: 'empty' } } });
    slackEmpty = false;
    const readsBeforeMismatch = slackReads.length;
    for (const mismatch of [{ release_id: 'clean-v1-other-release' }, { profile_sha256: canonicalSha256('other') }]) {
      expect((await post('/v1/staging/connector-rehearsal', { schema_version: 2, release_id: selected.release_id, profile_sha256, action: 'verify-read', tool: 'slack', ...mismatch })).status).toBe(503);
    }
    expect(slackReads).toHaveLength(readsBeforeMismatch);
    granolaVisible = true;
    expect(await capture('granola')).toMatchObject({ status: 200, body: { kind: 'echo-staging-connector-rehearsal-receipt-v2', qualified: false, tool: 'granola', receipt: { counts: { captured: 1, admitted: 1, request_only: 0 } } } });
    expect(await capture('granola')).toMatchObject({ status: 200, body: { receipt: { counts: { captured: 1, admitted: 0, duplicate: 1 } } } });
    expect(await capture('jira')).toMatchObject({ status: 200, body: { tool: 'jira', receipt: { counts: { admitted: 1, duplicate: 0, request_only: 0 } } } });
    expect(await capture('jira')).toMatchObject({ status: 200, body: { tool: 'jira', receipt: { counts: { admitted: 0, duplicate: 1, request_only: 0 } } } });
    expect(await capture('slack')).toMatchObject({ status: 200, body: { tool: 'slack', receipt: { counts: { captured: 1, admitted: 1, request_only: 0 } } } });
    expect(await capture('slack')).toMatchObject({ status: 200, body: { tool: 'slack', receipt: { counts: { captured: 1, admitted: 0, duplicate: 1 } } } });
    const retained = new Database(join(manifest.state_directory, 'authority.sqlite'), { readonly: true });
    try {
      expect((retained.prepare('SELECT cursor AS source_cursor FROM authority_live_source_progress_v2 WHERE singleton=1').get() as { source_cursor: string }).source_cursor).toBe(cursorBefore);
      const content = (adapter: string) => (retained.prepare('SELECT contents.content_json FROM authority_source_contents_v1 AS contents JOIN authority_sources_v1 AS source ON source.organization_id=contents.organization_id AND source.source_id=contents.source_id WHERE source.adapter_id=?').get(adapter) as { content_json: string }).content_json;
      expect(JSON.parse(content('jira-context-capture'))).toMatchObject({ representation: { kind: 'pointer' } });
      expect(content('jira-context-capture')).not.toContain('The ticket body stays with Jira.');
      expect(JSON.parse(content('slack-context-capture'))).toMatchObject({ payload: { kind: 'message' }, representation: { kind: 'pointer' } });
      expect(content('slack-context-capture')).not.toContain('Slack body must not be retained.');
    } finally { retained.close(); }
    expect((await post(PERSON_ANSWER_PATH_V4, { question: 'fixture' })).status).toBe(503);
    const control = new Database(join(manifest.state_directory, 'integrations.sqlite'));
    try { control.prepare("UPDATE organization_external_human_link_current SET current_status='revoked'").run(); } finally { control.close(); }
    const readsBeforeRevoked = slackReads.length;
    expect(await verifyRead('slack')).toMatchObject({ status: 200, body: { result: { status: 'refused' } } });
    expect((await capture('slack')).status).toBe(503);
    expect(slackReads).toHaveLength(readsBeforeRevoked);
  } finally { await runtime.close(); }
});
