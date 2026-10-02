import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { openOrganizationControlDatabase } from '@echo-brain/organization-control-plane/persistence/open-organization-control-database';
import { FileOrganizationSecretStore } from '@echo-brain/organization-control-plane/security/file-secret-store';
import { SlackWebIdentityProviderV1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-web-identity-provider-v1';
import { createSlackBotTokenSourceV1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-bot-token-source-v1';
import { SlackConnectionHealthV1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-connection-health-v1';
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1, SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1 } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';
import type { NangoConnectionClientV1, NangoSlackConnectionV1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1';
import { serializeSlackAppCredentialsV1 } from '../../../providers/slack/server/src/organization-control-plane/application/slack-app-credentials-v1.js';
import { buildExternalHumanIdentityLinkContractV2 } from '../../../providers/slack/server/src/organization-control-plane/application/organization-tool-connection-contracts-v2.js';
import { activateNangoSlackConnectionV1 } from '../../../providers/slack/server/src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js';
import { readActiveSlackConnectionV1 } from '../../../providers/slack/server/src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { openSlackContextCaptureRuntimeV1, type OpenSlackContextCaptureRuntimeInputV1 } from '../src/composition/slack-context-capture-runtime-v1.js';
import { createContextSourceIntakeV1 } from '../src/composition/context-source-intake-v1.js';

const NOW = '2026-10-02T00:00:00.000Z';
const CHANNEL = 'CTEST123';
const TEAM = 'TTEST123';
const BOT = 'UBOT123';
const HUMAN = 'UHUMAN123';
const APP = 'ATEST123';
const TS = '1790966400.123456';
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-slack-context-runtime-'))); chmodSync(root, 0o700); directories.push(root);
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: join(root, 'state'), organization_display_name: 'Test',
    owner_display_name: 'Owner', created_at: NOW, creating_artifact_revision: 'slack-context-fixture' });
  const coordinates = { authority_id: initialized.authority_id, organization_id: initialized.organization_id, state_lineage_id: initialized.state_lineage_id };
  const owner = { organization_id: initialized.organization_id, principal_id: initialized.owner_principal_id, membership_id: initialized.owner_membership_id };
  const control = openOrganizationControlDatabase(join(initialized.state_directory, 'integrations.sqlite'), { fileMustExist: true });
  const database = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  const health = new SlackConnectionHealthV1();
  const secrets = new FileOrganizationSecretStore(join(initialized.state_directory, 'secrets'));
  let scopes: readonly string[] = SLACK_PRIVATE_APP_BOT_SCOPES_V1;
  let botUser = BOT;
  let privateChannel = false;
  let member = true;
  let rejected = false;
  let beforeFetch: ((method: string) => void) | undefined;
  let beforeToken: (() => void) | undefined;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url); const method = url.pathname.slice('/api/'.length);
    beforeFetch?.(method);
    const reply = (body: unknown) => Response.json(body, { headers: { 'x-oauth-scopes': scopes.join(',') } });
    if (rejected) return reply({ ok: false, error: 'invalid_auth' });
    if (method === 'auth.test') return reply({ ok: true, team_id: TEAM, user_id: botUser, bot_id: 'BTEST123', app_id: APP, url: 'https://fixture.slack.com/' });
    if (method === 'bots.info') return reply({ ok: true, bot: { id: 'BTEST123', user_id: botUser, app_id: APP, deleted: false } });
    expect(url.searchParams.get('channel')).toBe(CHANNEL);
    if (method === 'conversations.info') return reply({ ok: true, channel: { id: CHANNEL, is_member: member, is_private: privateChannel, context_team_id: TEAM } });
    if (method === 'conversations.history') return reply({ ok: true, messages: [{ type: 'message', ts: TS, user: HUMAN, text: 'Do not retain this body' }], has_more: false });
    if (method === 'chat.getPermalink') return reply({ ok: true, channel: CHANNEL, permalink: `https://fixture.slack.com/archives/${CHANNEL}/p${TS.replace('.', '')}` });
    throw new Error('Unexpected Slack method');
  });
  const provider = new SlackWebIdentityProviderV1({ fetch });
  let connection: NangoSlackConnectionV1 = { connection_id: 'nango-fixture', tags: {}, team_id: TEAM, app_id: APP, bot_user_id: BOT,
    bot_token: 'xoxb-fixture-old-token', granted_scopes: scopes, updated_at: NOW };
  const nango = { getSlackConnection: vi.fn(async () => { beforeToken?.(); return connection; }) } as unknown as NangoConnectionClientV1;
  const credentials = { kind: 'echo-slack-app-credentials-v1' as const, app_id: APP, client_id: '1234.5678',
    client_secret: 'fixture-client-secret', signing_secret: 'fixture-signing-secret', nango_connection_id: null };
  await activateNangoSlackConnectionV1({ ...coordinates, database: control, secrets, verifier: provider,
    credential: { credentials, reference: secrets.create(serializeSlackAppCredentialsV1(credentials)) }, nango: connection, now: () => NOW, new_connection_id: () => 'con_fixture' });
  const active = readActiveSlackConnectionV1(control)!;
  const link = buildExternalHumanIdentityLinkContractV2({ ...coordinates, external_identity_link_id: 'clm_fixture', provider_issuer: 'https://slack.com',
    provider_tenant_kind: 'workspace', provider_tenant_id: TEAM, provider_enterprise_id: null, provider_subject_id: HUMAN,
    principal_id: owner.principal_id, membership_id: owner.membership_id, membership_type: 'owner', verification_event_id: 'link-event',
    verification_evidence_sha256: canonicalSha256('identity-proof'), verified_at: NOW });
  control.prepare(`INSERT INTO organization_external_human_link_contracts(external_identity_link_id,contract_sha256,contract_json,created_at) VALUES(?,?,?,?)`)
    .run(link.external_identity_link_id, canonicalSha256(link), canonicalJson(link), NOW);
  control.prepare(`INSERT INTO organization_external_human_link_current(external_identity_link_id,contract_sha256,provider_issuer,provider_tenant_kind,provider_tenant_id,
    provider_enterprise_id,provider_subject_id,principal_id,membership_id,current_status,updated_at) VALUES(?,?,'https://slack.com','workspace',?,NULL,?,?,?,'active',?)`)
    .run(link.external_identity_link_id, canonicalSha256(link), TEAM, HUMAN, owner.principal_id, owner.membership_id, NOW);
  const tokenSource = createSlackBotTokenSourceV1({ secrets, nango, health });
  await tokenSource.botToken(active); // Cache the old token under the preserved approval state.
  connection = { ...connection, bot_token: 'xoxb-fixture-fresh-token', granted_scopes: SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1 };
  scopes = SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1;
  fetch.mockClear(); vi.mocked(nango.getSlackConnection).mockClear();
  let authorization: PersonAccessAuthorization = { ...owner, membership_type: 'owner', identity_binding_id: 'identity', session_family_id: 'session',
    access_credential_sha256: canonicalSha256('access'), person_state_sha256: canonicalSha256('person'), session_state_sha256: canonicalSha256('session'),
    checked_at: NOW, access_expires_at: '2099-01-01T00:00:00.000Z', hard_reauthentication_at: '2099-01-01T00:00:00.000Z' };
  const options: OpenSlackContextCaptureRuntimeInputV1 = { state_directory: initialized.state_directory, initial_owner: owner,
    authenticate_access: { authenticateAccess: ({ access_token }) => { if (access_token !== 'owner-token') throw new Error('Invalid session'); return authorization; } },
    profile_sha256: canonicalSha256('exact-v2-profile'), capability: SLACK_PUBLIC_CHANNEL_CONTEXT_CAPABILITY_V1, channel_id: CHANNEL,
    source_instance_id: 'staging-slack-context-v1', slack: { bot_token_source: tokenSource, connection_health: health, provider }, fetch };
  const runtime = openSlackContextCaptureRuntimeV1(options);
  const create = (signal = new AbortController().signal) => runtime.create_source({ access_token: 'owner-token', signal });
  const revokeLink = () => { control.prepare("UPDATE organization_external_human_link_current SET current_status='revoked'").run(); };
  const revokeOwner = () => { database.prepare("UPDATE authority_memberships SET status='revoked', revoked_at=?, revocation_reason='test' WHERE membership_id=?").run(NOW, owner.membership_id); };
  return { runtime, create, control, database, owner, active, options, fetch, nango, health, revokeLink, revokeOwner,
    setScopes: (value: readonly string[]) => { scopes = value; }, setBot: (value: string) => { botUser = value; },
    setPrivate: () => { privateChannel = true; }, setNotMember: () => { member = false; }, setRejected: () => { rejected = true; },
    setBeforeFetch: (hook: (method: string) => void) => { beforeFetch = hook; }, setBeforeToken: (hook: () => void) => { beforeToken = hook; },
    setAuthorization: (update: Partial<PersonAccessAuthorization>) => { authorization = { ...authorization, ...update }; },
    close: () => { runtime.close(); control.close(); database.close(); } };
}

describe('Slack context capture runtime', () => {
  it('uses a fresh token and real Slack scope proof with the unchanged four-scope approval state, then retains only pointer metadata', async () => {
    const f = await fixture();
    try {
      const configured = await f.create();
      expect(f.nango.getSlackConnection).toHaveBeenCalledTimes(1);
      expect(f.fetch.mock.calls.map(([input, init]) => new Request(input, init).headers.get('authorization'))).toEqual([
        'Bearer xoxb-fixture-fresh-token', 'Bearer xoxb-fixture-fresh-token',
      ]);
      expect(f.active.state.observed_granted_scopes).toEqual(SLACK_PRIVATE_APP_BOT_SCOPES_V1);
      const intake = createContextSourceIntakeV1({ source: configured.source, identity: configured.source.identity, organization_id: f.owner.organization_id,
        require_read_current: configured.require_current, authority: {
          select: () => ({ disposition: 'retained', scope: { organization_id: f.owner.organization_id, custody_ref: 'fixture-owner', access_policy_ref: 'fixture-explicit-channel', analysis_policy: 'on_request' }, permitted_representations: ['pointer'] }),
          requireCurrent: configured.require_current,
        }, retention: { disposition: 'retained', database: f.database } });
      const result = await intake.pull({ limit: 1 });
      expect(result).toBeDefined();
      const sources = f.database.prepare('SELECT * FROM authority_sources_v1').all();
      expect(sources).toHaveLength(1);
      expect(JSON.stringify(sources)).not.toContain('Do not retain this body');
      expect(readActiveSlackConnectionV1(f.control)).toEqual(f.active);
    } finally { f.close(); }
  });

  it.each(['missing-scope', 'extra-scope', 'different-bot'] as const)('refuses a fresh provider proof with %s before channel reads', async failure => {
    const f = await fixture();
    try {
      if (failure === 'missing-scope') f.setScopes(SLACK_PRIVATE_APP_BOT_SCOPES_V1);
      else if (failure === 'extra-scope') f.setScopes([...SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, 'files:read']);
      else f.setBot('UOTHER123');
      await expect(f.create()).rejects.toThrow('Slack context capture is not available');
      expect(f.fetch.mock.calls.every(([input]) => !String(input).includes('conversations.'))).toBe(true);
      expect(f.health.needsReinstall(f.active.state_sha256)).toBe(false);
    } finally { f.close(); }
  });

  it.each(['link', 'membership', 'session', 'connection', 'health'] as const)('requires current %s before any provider read', async failure => {
    const f = await fixture();
    try {
      if (failure === 'link') f.revokeLink();
      else if (failure === 'membership') f.revokeOwner();
      else if (failure === 'session') f.setAuthorization({ membership_type: 'employee' });
      else if (failure === 'connection') f.control.prepare("UPDATE organization_tool_connection_current_state SET current_status='revoked'").run();
      else f.health.markNeedsReinstall(f.active.state_sha256);
      await expect(f.create()).rejects.toThrow();
      expect(f.nango.getSlackConnection).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('fences an owner revocation during token resolution before contacting Slack', async () => {
    const f = await fixture();
    try { f.setBeforeToken(f.revokeOwner); await expect(f.create()).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled(); }
    finally { f.close(); }
  });

  it('fences a link revocation during fresh bot proof', async () => {
    const f = await fixture();
    try { f.setBeforeFetch(method => { if (method === 'bots.info') f.revokeLink(); }); await expect(f.create()).rejects.toThrow(); }
    finally { f.close(); }
  });

  it.each(['link', 'reconnect', 'owner'] as const)('fences %s drift during history and synchronously before admission', async failure => {
    const f = await fixture();
    try {
      const configured = await f.create();
      f.setBeforeFetch(method => { if (method === 'conversations.history') {
        if (failure === 'link') f.revokeLink(); else if (failure === 'owner') f.revokeOwner(); else f.health.clear();
      } });
      await expect(configured.source.pull({ limit: 1 })).rejects.toThrow();
      expect(() => configured.require_current()).toThrow();
      expect(f.database.prepare('SELECT 1 FROM authority_sources_v1').all()).toHaveLength(0);
    } finally { f.close(); }
  });

  it.each(['private', 'not-member'] as const)('refuses %s channel before history', async failure => {
    const f = await fixture();
    try {
      if (failure === 'private') f.setPrivate(); else f.setNotMember();
      const configured = await f.create(); await expect(configured.source.pull({ limit: 1 })).rejects.toThrow();
      expect(f.fetch.mock.calls.every(([input]) => !String(input).includes('conversations.history'))).toBe(true);
    } finally { f.close(); }
  });

  it('marks the shared connection health only on Slack rejecting the freshly resolved token', async () => {
    const f = await fixture();
    try { f.setRejected(); await expect(f.create()).rejects.toThrow(); expect(f.health.needsReinstall(f.active.state_sha256)).toBe(true); }
    finally { f.close(); }
  });

  it('cancels before provider work and refuses previously opened sources after close', async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(); controller.abort();
      await expect(f.create(controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.fetch).not.toHaveBeenCalled();
      const configured = await f.create(); f.runtime.close();
      expect(() => configured.require_current()).toThrow(); await expect(configured.source.pull({ limit: 1 })).rejects.toThrow();
    } finally { f.close(); }
  });
});
