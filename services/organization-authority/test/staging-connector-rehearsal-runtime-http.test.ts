import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { readPrivateAuthorityCredential } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1 } from '@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1';
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, organizationPersonSlackIdentityLinkChallengeCodeSha256 } from '@echo-brain/provider-slack-client/organization-api/person-slack-identity-link';
import { runOrganizationAuthoritySetupCli } from '../src/composition/organization-authority-setup-cli.js';
import { openStagingConnectorRehearsalService } from '../src/composition/staging-connector-rehearsal-runtime.js';
import { STAGING_CONNECTOR_REHEARSAL_POLICY_V2 } from '../src/composition/staging-connector-rehearsal-protocol-v2.js';
import { readOrganizationAuthoritySetupManifest } from '../src/composition/organization-authority-setup-cli.js';
import { readPersonOidcConfiguration } from '../src/composition/organization-authority-person-administration-cli.js';
import { PERSON_ANSWER_PATH_V4 } from '@echo-brain/organization-api';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { FIXTURE_CLOUD, FIXTURE_EMAIL, configuration, port, prepare, privateFile, providerSeams } from './fixtures/connector-rehearsal-runtime-fixture-v1.js';
import { SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function selection() {
  return { release_id: 'clean-v1-staging-connector', authority_host: 'authority-staging.echobrain.org', profile: {
    schema_version: 1 as const, kind: 'echo-staging-connector-rehearsal-profile-v1' as const,
    capture_policy: 'initial-owner-granola-retained-jira-request-only-v1' as const,
    jira: { cloud_id: FIXTURE_CLOUD, integration_key: 'jira', project: 'ECHO' },
  } };
}

it('serves owner-bound Jira connection and request-only capture through staging HTTP across restart', async () => {
  const root = join(realpathSync(tmpdir()), `echo-staging-connector-${randomUUID()}`); roots.push(root);
  prepare(root);
  const config = configuration(root, STAGING_AUTHORITY_ORIGIN_V1);
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
  const granolaTimestamp = new Date(Date.now() + 60_000).toISOString();
  const granolaNote = { id: 'fixture-note', object: 'note', title: 'Staging retained capture', created_at: granolaTimestamp, updated_at: granolaTimestamp, summary_markdown: '## Decision\nRetain this synthetic meeting.', owner: { name: 'Founder', email: 'founder@example.test' }, attendees: [{ id: 'owner', email: 'founder@example.test' }], calendar_event: { start: { dateTime: granolaTimestamp } }, web_url: 'https://app.granola.ai/notes/fixture-note', transcript: [{ text: 'This is the retained synthetic transcript.', speaker: 'Founder' }] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://public-api.granola.ai') {
      if (url.pathname === '/v1/notes') return Response.json({ notes: [{ id: granolaNote.id, created_at: granolaNote.created_at, updated_at: granolaNote.updated_at, owner: granolaNote.owner }], hasMore: false, cursor: null });
      if (url.pathname === `/v1/notes/${granolaNote.id}`) return Response.json(granolaNote);
      throw new Error(`unexpected Granola endpoint ${url.pathname}`);
    }
    if (url.origin === 'https://slack.com') {
      slackReads.push(url.pathname);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-synthetic-slack');
      if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: 'TFIXTURE', user_id: 'UBOTFIXTURE', url: 'https://fixture.slack.com/' });
      expect(url.searchParams.get('channel')).toBe('C01234567');
      if (url.pathname === '/api/conversations.info') return Response.json({ ok: true, channel: { id: 'C01234567', is_member: true, is_private: false, context_team_id: 'TFIXTURE' } });
      if (url.pathname === '/api/conversations.history') return Response.json({ ok: true, messages: [{ type: 'message', ts: '1790966400.123456', user: 'UFOUNDER', text: 'Slack body must not be retained.' }], has_more: false });
      if (url.pathname === '/api/chat.getPermalink') return Response.json({ ok: true, channel: 'C01234567', permalink: 'https://fixture.slack.com/archives/C01234567/p1790966400123456' });
      throw new Error(`unexpected Slack endpoint ${url.pathname}`);
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
    throw new Error(`unexpected remote endpoint ${url.origin}`);
  });
  const selected = selection();
  const profile_sha256 = canonicalSha256(selected.profile);
  privateFile(join(root, 'private', 'staging-connector-rehearsal.json'), JSON.stringify(selected.profile));
  const open = async () => openStagingConnectorRehearsalService({
    state_directory: manifest.state_directory, authority_url: STAGING_AUTHORITY_ORIGIN_V1, host: '127.0.0.1', port: await port(), scheduling: 'periodic', worker_interval_ms: 60_000,
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
  try {
    const invitation = JSON.parse(readFileSync(manifest.invitation_path, 'utf8')) as { login_grant: string };
    expect((await post('/v2/session/oidc/begin', { kind: 'identity_bootstrap', login_grant: invitation.login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } }, '')).status).toBe(201);
    const callback = await (await fetch(`http://127.0.0.1:${runtime.address.port}/v2/session/oidc/callback?state=${encodeURIComponent(seams.oidcState())}&code=fixture`)).text();
    owner = (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(callback)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
    const connect = await post('/v1/person/tools/jira/connect', { schema_version: 1 });
    expect(connect.status).toBe(201);
    seams.finishJira();
    const attempt = connect.body.attempt as string; jiraAttempt = attempt;
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
    const before = seams.jiraFetch.mock.calls.length;
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 1, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'slack', limit: 1 })).status).toBe(400);
    expect(slackReads).toHaveLength(0);
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 1, release_id: 'clean-v1-wrong-binding', profile_sha256, action: 'capture', tool: 'jira', limit: 1 })).status).toBe(503);
    expect(seams.jiraFetch).toHaveBeenCalledTimes(before);
    expect((await post('/v1/staging/connector-rehearsal', { schema_version: 1, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'jira', limit: 1 }, '')).status).toBe(401);
    expect((await post(ORGANIZATION_API_SLACK_SETUP_PATH_V1, { request_id: `oss_${randomUUID()}`, configuration_token: 'xoxe.fixture-configuration-token' })).status).toBe(201);
    const install = await post(ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, { request_id: `osi_${randomUUID()}` });
    seams.finishSlack();
    expect((await post(ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, { attempt_id: install.body.attempt_id })).status).toBe(200);
    const code = randomBytes(32).toString('base64url');
    const linked = await post(ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, { request_id: `psb_${randomUUID()}`, recipient_user_id: 'UFOUNDER', challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(code) });
    expect(linked.status).toBe(201);
    expect((await post(ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, { request_id: `psc_${randomUUID()}`, challenge_attempt_id: linked.body.challenge_attempt_id, challenge_message_ts: linked.body.challenge_message_ts, challenge_code: code })).status).toBe(200);
  } finally { await runtime.close(); }
  const finalizeErrors: string[] = []; const finalized = await runOrganizationAuthoritySetupCli(['finalize', '--state-dir', stateDirectory], { stdout: () => {}, stderr: value => finalizeErrors.push(value) }); expect(finalized, finalizeErrors.join('')).toBe(0);
  runtime = await open();
  try {
    const post2 = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${runtime.address.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(runtime.processing).toBe('active');
    expect(await post2('/v1/person/tools/jira/status', { schema_version: 1, attempt: jiraAttempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
    const receipt = await post2('/v1/staging/connector-rehearsal', { schema_version: 1, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'jira', limit: 1 });
    expect(receipt).toMatchObject({ status: 200, body: { qualified: false, tool: 'jira', receipt: { counts: { captured: 1, request_only: 1, admitted: 0 } } } });
    const beforeCapture = new Database(join(manifest.state_directory, 'authority.sqlite'), { readonly: true });
    const cursorBefore = (beforeCapture.prepare('SELECT cursor AS source_cursor FROM authority_live_source_progress_v2 WHERE singleton=1').get() as { source_cursor: string }).source_cursor; beforeCapture.close();
    const retained = await post2('/v1/staging/connector-rehearsal', { schema_version: 1, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'granola', limit: 1 });
    expect(retained).toMatchObject({ status: 200, body: { qualified: false, tool: 'granola', receipt: { counts: { captured: 1, admitted: 1, request_only: 0 } } } });
    const replay = await post2('/v1/staging/connector-rehearsal', { schema_version: 1, release_id: selected.release_id, profile_sha256, action: 'capture', tool: 'granola', limit: 1 });
    expect(replay).toMatchObject({ status: 200, body: { receipt: { counts: { captured: 1, admitted: 0, duplicate: 1 } } } });
    const database = new Database(join(manifest.state_directory, 'authority.sqlite'), { readonly: true });
    try {
      expect(database.prepare("SELECT count(*) AS count FROM authority_sources_v1 WHERE adapter_id='jira-context-capture'").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM authority_sources_v1 WHERE adapter_id='granola-context-capture'").get()).toEqual({ count: 1 });
      expect((database.prepare('SELECT cursor AS source_cursor FROM authority_live_source_progress_v2 WHERE singleton=1').get() as { source_cursor: string }).source_cursor).toBe(cursorBefore);
    } finally { database.close(); }
    expect((await post2(PERSON_ANSWER_PATH_V4, { question: 'fixture' })).status).toBe(503);
  } finally { await runtime.close(); }

  const v2 = {
    release_id: selected.release_id,
    authority_host: selected.authority_host,
    profile: {
      schema_version: 2 as const,
      kind: 'echo-staging-connector-rehearsal-profile-v2' as const,
      capture_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V2 as typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V2,
      predecessor_profile_sha256: profile_sha256,
      jira: { ...selected.profile.jira, project: 'ECHO' },
      slack: { channel_id: 'C01234567' },
    },
  };
  runtime = await openStagingConnectorRehearsalService({
    state_directory: manifest.state_directory, authority_url: STAGING_AUTHORITY_ORIGIN_V1, host: '127.0.0.1', port: await port(), scheduling: 'periodic', worker_interval_ms: 60_000,
    oidc: oidc.configuration, client_authentication: { method: 'none' }, pkce_key_file: manifest.pkce_key_file,
    slack_nango: { secret_key: readPrivateAuthorityCredential(`file:${config.nango.secret_key_file}`), integration_key: 'slack' },
    granola_credential_file: manifest.granola_credential_file, granola_owner_email_file: manifest.granola_owner_email_file, openrouter_credential_file: manifest.llm_credential_file,
  }, v2, { api: { oidc_provider: seams.oidc_provider }, slack: seams.slack, jira: seams.jira_person_live_seams });
  try {
    const captureSlack = () => post('/v1/staging/connector-rehearsal', { schema_version: 2, release_id: v2.release_id, profile_sha256: canonicalSha256(v2.profile), action: 'capture', tool: 'slack', limit: 1 });
    expect((await captureSlack()).status).toBe(503); // Approval scopes alone do not authorize channel intake.
    expect(slackReads).toHaveLength(0);
    const controlSnapshot = () => {
      const db = new Database(join(manifest.state_directory, 'integrations.sqlite'), { readonly: true });
      try { return { connections: db.prepare('SELECT * FROM organization_tool_connection_current_state').all(), links: db.prepare('SELECT * FROM organization_external_human_link_current').all() }; }
      finally { db.close(); }
    };
    const controlBefore = controlSnapshot();
    expect((await post(ORGANIZATION_API_SLACK_SETUP_PATH_V1, { request_id: `oss_${randomUUID()}`, configuration_token: 'xoxe.fixture-configuration-token' })).status).toBe(201);
    expect(seams.slack.manifest_provider.createApp).toHaveBeenCalledTimes(1);
    expect(seams.slack.manifest_provider.updateApp).toHaveBeenCalledWith(expect.objectContaining({ app_id: 'AFIXTURE', manifest: expect.objectContaining({ oauth_config: expect.objectContaining({ scopes: expect.objectContaining({ bot: SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1 }) }) }) }));
    const upgrade = await post(ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, { request_id: `osi_${randomUUID()}` });
    expect(upgrade.status).toBe(201);
    seams.finishSlack(SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1);
    expect((await post(ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, { attempt_id: upgrade.body.attempt_id })).status).toBe(200);
    expect(controlSnapshot()).toEqual(controlBefore);
    expect(await captureSlack()).toMatchObject({ status: 200, body: { tool: 'slack', receipt: { counts: { captured: 1, admitted: 1, request_only: 0 } } } });
    expect(await captureSlack()).toMatchObject({ status: 200, body: { tool: 'slack', receipt: { counts: { captured: 1, admitted: 0, duplicate: 1 } } } });
    const v1Wire = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/staging/connector-rehearsal`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 1, release_id: v2.release_id, profile_sha256: canonicalSha256(v2.profile), action: 'capture', tool: 'jira', limit: 1 }) });
    expect(v1Wire.status).toBe(400);
    const response = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/staging/connector-rehearsal`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 2, release_id: v2.release_id, profile_sha256: canonicalSha256(v2.profile), action: 'capture', tool: 'jira', limit: 1 }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ kind: 'echo-staging-connector-rehearsal-receipt-v2', tool: 'jira', receipt: { counts: { admitted: 1, duplicate: 0, request_only: 0 } } });
    const replay = await fetch(`http://127.0.0.1:${runtime.address.port}/v1/staging/connector-rehearsal`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 2, release_id: v2.release_id, profile_sha256: canonicalSha256(v2.profile), action: 'capture', tool: 'jira', limit: 1 }) });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ tool: 'jira', receipt: { counts: { admitted: 0, duplicate: 1, request_only: 0 } } });
    const retained = new Database(join(manifest.state_directory, 'authority.sqlite'), { readonly: true });
    try {
      const row = retained.prepare("SELECT contents.content_json FROM authority_source_contents_v1 AS contents JOIN authority_sources_v1 AS source ON source.organization_id=contents.organization_id AND source.source_id=contents.source_id WHERE source.adapter_id='jira-context-capture'").get() as { content_json: string };
      expect(JSON.parse(row.content_json)).toMatchObject({ representation: { kind: 'pointer' } });
      expect(row.content_json).not.toContain('Capture Jira through the rehearsal.');
      const slack = retained.prepare("SELECT contents.content_json FROM authority_source_contents_v1 AS contents JOIN authority_sources_v1 AS source ON source.organization_id=contents.organization_id AND source.source_id=contents.source_id WHERE source.adapter_id='slack-context-capture'").get() as { content_json: string };
      expect(JSON.parse(slack.content_json)).toMatchObject({ source_type: 'message', representation: { kind: 'pointer' } });
      expect(slack.content_json).not.toContain('Slack body must not be retained.');
    } finally { retained.close(); }
    const control = new Database(join(manifest.state_directory, 'integrations.sqlite'));
    try { control.prepare("UPDATE organization_external_human_link_current SET current_status='revoked'").run(); } finally { control.close(); }
    const readsBeforeRevoked = slackReads.length;
    expect((await captureSlack()).status).toBe(503);
    expect(slackReads).toHaveLength(readsBeforeRevoked);
  } finally { await runtime.close(); }
});
