import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import type { NangoConnectionClientV1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1';
import type { ObserveSlackIdentityLinkChallengeInput, SlackIntegrationProvider } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1';
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1 } from '@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1';
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, organizationPersonSlackIdentityLinkChallengeCodeSha256 } from '@echo-brain/provider-slack-client/organization-api/person-slack-identity-link';
import type { BegunPersonOidcLogin } from '../src/application/person-identity-sessions.js';
import { requestConnectorRehearsalControlV1 } from '../src/composition/connector-rehearsal-control-v1.js';
import { bootstrapConnectorRehearsalV1, openConnectorRehearsalRuntimeV1, runConnectorRehearsalV1, type ConnectorRehearsalConfigurationV1 } from '../src/composition/connector-rehearsal-runtime-v1.js';
import { readOrganizationAuthoritySetupManifest } from '../src/composition/organization-authority-setup-cli.js';
import { runOrganizationAuthorityServiceCli } from '../src/composition/organization-authority-service-cli.js';
import { prepare } from '../../../tools/connector-rehearsal.mjs';

const AUTHORITY = 'https://connector-rehearsal.example.test';
const EMAIL = 'founder@example.test';
const CLOUD = '00000000-0000-4000-8000-000000000007';
const SITE = 'https://echo-fixture.atlassian.net';
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function port(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = (server.address() as { port: number }).port;
  const closed = once(server, 'close');
  server.close();
  await closed;
  return result;
}

function newRoot(prefix: string): string {
  const directory = process.platform === 'darwin' ? '/private/tmp' : realpathSync(tmpdir());
  const root = mkdtempSync(`${directory}/${prefix}`);
  rmSync(root, { recursive: true, force: true });
  roots.push(root);
  return root;
}

function privateFile(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function configuration(root: string, authority = AUTHORITY): ConnectorRehearsalConfigurationV1 {
  const privateRoot = join(root, 'private');
  return {
    schema_version: 1,
    kind: 'echo-connector-rehearsal-config-v1',
    authority_url: authority,
    organization_name: 'Connector rehearsal fixture',
    owner_name: 'Fixture Founder',
    owner_email: EMAIL,
    oidc: { config_file: join(privateRoot, 'oidc-config.json'), client_secret_file: null },
    nango: { secret_key_file: join(privateRoot, 'nango-secret-key'), slack_integration_key: 'slack', jira_integration_key: 'jira' },
    jira: { cloud_id: CLOUD, project: 'ECHO' },
    granola: { credential_file: join(privateRoot, 'granola-organization-key'), owner_email_file: join(privateRoot, 'granola-owner-email') },
    openrouter: { credential_file: join(privateRoot, 'openrouter-credential') },
  };
}

function prepareConfiguration(root: string, authority = AUTHORITY): ConnectorRehearsalConfigurationV1 {
  prepare(root);
  const config = configuration(root, authority);
  privateFile(config.oidc.config_file, JSON.stringify({
    issuer: 'https://issuer.example.test', client_id: 'connector-rehearsal-client',
    redirect_uri: `${authority}/v2/session/oidc/callback`, tenant: { kind: 'issuer' },
    id_token_algorithms: ['RS256'], client_authentication: 'none',
  }));
  privateFile(config.nango.secret_key_file, 'synthetic-nango-key-0000000000000000');
  privateFile(config.granola.credential_file, `grn_${'a'.repeat(32)}`);
  privateFile(config.granola.owner_email_file, EMAIL);
  privateFile(config.openrouter.credential_file, 'synthetic-openrouter-key-000000000000');
  privateFile(join(root, 'connector-rehearsal.json'), JSON.stringify(config));
  return config;
}

async function quietly(input: Parameters<typeof runConnectorRehearsalV1>[0]): Promise<number> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { return await runConnectorRehearsalV1(input); } finally { write.mockRestore(); }
}

function providerSeams() {
  let attempted: BegunPersonOidcLogin | undefined;
  const oidc_provider = {
    buildAuthorizationUrl(input: BegunPersonOidcLogin) {
      attempted = input;
      return `https://issuer.example.test/authorize?state=${encodeURIComponent(input.state)}`;
    },
    async redeemAuthorizationCode() {
      return { kind: 'verified' as const, token: {
        issuer: 'https://issuer.example.test', subject: 'fixture-founder', audience: 'connector-rehearsal-client', nonce: attempted!.nonce,
        issued_at: Math.floor(Date.now() / 1000), claims: { email: EMAIL, email_verified: true },
      } };
    },
  };
  let slackTags: Readonly<Record<string, string>> = {};
  let slackConnection: Awaited<ReturnType<NangoConnectionClientV1['getSlackConnection']>> | undefined;
  const slackNango: NangoConnectionClientV1 = {
    createConnectSession: vi.fn(async input => {
      slackTags = input.tags;
      return { connect_link: 'https://connect.nango.dev/fixture-slack', expires_at: new Date(Date.now() + 60_000).toISOString() };
    }),
    createReconnectSession: vi.fn(),
    findConnectionIdByTag: vi.fn(async input => slackTags[input.key] === input.value ? 'fixture-slack-connection' : undefined),
    getSlackConnection: vi.fn(async () => {
      if (slackConnection === undefined) throw new Error('fixture Slack connection has not completed');
      return slackConnection;
    }),
  };
  const finishSlack = () => {
    slackConnection = {
      connection_id: 'fixture-slack-connection', tags: slackTags, team_id: 'TFIXTURE', app_id: 'AFIXTURE', bot_user_id: 'UBOTFIXTURE',
      granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: 'xoxb-synthetic-slack', updated_at: new Date().toISOString(),
    };
  };
  const provider: SlackIntegrationProvider = {
    verifyConnection: vi.fn(async () => ({
      team_id: 'TFIXTURE', enterprise_id: null, bot_user_id: 'UBOTFIXTURE', bot_id: 'BFIXTURE', app_id: 'AFIXTURE',
      granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, verification_evidence_sha256: canonicalSha256({ fixture: 'slack-connection' }),
    })),
    verifyHuman: vi.fn(async (_token: string, userId: string) => ({ team_id: 'TFIXTURE', user_id: userId, verification_evidence_sha256: canonicalSha256({ fixture: userId }) })),
    openIdentityLinkDirectMessage: vi.fn(async (_token: string, userId: string) => ({ team_id: 'TFIXTURE', channel_id: `D${userId.slice(1)}`, recipient_user_id: userId })),
    postIdentityLinkChallenge: vi.fn(async (_token: string, input: { channel_id: string }) => ({ team_id: 'TFIXTURE', channel_id: input.channel_id, challenge_message_ts: '1727700000.000001' })),
    observeIdentityLinkChallenge: vi.fn(async (_token: string, input: ObserveSlackIdentityLinkChallengeInput) => {
      if (input.recipient_user_id === undefined) throw new Error('fixture recipient is required');
      return { team_id: 'TFIXTURE', user_id: input.recipient_user_id, channel_id: input.channel_id, challenge_message_ts: input.challenge_message_ts,
        reply_message_ts: '1727700000.000002', verification_evidence_sha256: canonicalSha256({ fixture: input.recipient_user_id, reply: true }) };
    }),
  };
  let jiraTags: Readonly<Record<string, string>> = {};
  let pendingJiraReference = '';
  let jiraAttempt = 0;
  const jiraConnections = new Map<string, { readonly tags: Readonly<Record<string, string>>; readonly access_token: string; readonly updated_at: string }>();
  const jira: JiraNangoV1 = {
    connect: vi.fn(async tags => { jiraTags = tags; pendingJiraReference = `fixture-jira-${++jiraAttempt}`; return { link: 'https://connect.nango.dev/fixture-jira' }; }),
    connection: vi.fn(async reference => {
      const result = jiraConnections.get(reference);
      if (result === undefined) throw new AuthorityOperationError('not_found', 'fixture Jira connection is absent');
      return result;
    }),
    find: vi.fn(async tags => [...jiraConnections].find(([, value]) => canonicalSha256(tags) === canonicalSha256(value.tags))?.[0]),
    disconnect: vi.fn(async reference => { jiraConnections.delete(reference); }),
  };
  const finishJira = () => jiraConnections.set(pendingJiraReference, { tags: jiraTags, access_token: 'synthetic-jira-oauth-bearer', updated_at: new Date().toISOString() });
  const jiraFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-jira-oauth-bearer');
    if (url.pathname === '/oauth/token/accessible-resources') return Response.json([{ id: CLOUD, url: SITE, scopes: ['read:jira-work', 'read:jira-user'] }]);
    if (url.pathname.endsWith('/myself')) return Response.json({ accountId: 'fixture-jira-account', active: true, accountType: 'atlassian' });
    if (url.pathname.endsWith('/project/ECHO')) return Response.json({ id: '10000', key: 'ECHO', self: `${SITE}/rest/api/3/project/10000` });
    if (url.pathname.endsWith('/search/jql')) return Response.json({ isLast: true, issues: [{ id: '10001' }] });
    if (url.pathname.endsWith('/issue/10001')) return Response.json({ id: '10001', key: 'ECHO-1', self: `${SITE}/rest/api/3/issue/10001`, fields: { summary: 'Ship connector rehearsal', project: { id: '10000', key: 'ECHO', self: `${SITE}/rest/api/3/project/10000` }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Capture Jira through the rehearsal.' }] }] }, created: '2026-10-01T12:00:00.000Z', updated: '2026-10-02T03:04:05.000-0700', status: { name: 'Open' }, assignee: { displayName: 'Fixture Owner', accountId: 'fixture-jira-account' }, duedate: null, labels: ['rehearsal'], priority: { name: 'High' } } });
    throw new Error(`unexpected Jira endpoint ${url.pathname}`);
  });
  return { oidc_provider, oidcState: () => attempted?.state ?? '', slack: { nango: slackNango, manifest_provider: { createApp: vi.fn(async () => ({ app_id: 'AFIXTURE', client_id: '111.222', client_secret: 'synthetic-slack-client-secret', signing_secret: 'synthetic-slack-signing-secret' })), updateApp: vi.fn() }, provider }, jira_person_live_seams: { nango: jira, fetch: jiraFetch }, finishSlack, finishJira, jiraFetch };
}

it('boots the isolated profile, performs real Person setup, captures Jira request-only, and never starts a Granola poll itself', async () => {
  const root = newRoot('echo-rehearsal-');
  const config = prepareConfiguration(root);
  await bootstrapConnectorRehearsalV1({ directory: root, configuration: config });
  const manifest = readOrganizationAuthoritySetupManifest(join(root, 'state'));
  expect(verifyAuthorityStateLineage(join(root, 'state')).root).toMatchObject({ authority_id: manifest.authority_id, organization_id: manifest.organization_id });
  expect(await quietly({ action: 'credentials-install', directory: root, configuration: config })).toBe(0);

  const seams = providerSeams();
  const granolaFetches: string[] = [];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://public-api.granola.ai') {
      granolaFetches.push(url.href);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'grn_'.concat('a'.repeat(32))}`);
      if (url.pathname === '/v1/notes') return Response.json({ notes: [{ id: 'owner-preflight', owner: { email: EMAIL } }], hasMore: false, cursor: null });
      throw new Error(`unexpected Granola endpoint ${url.pathname}`);
    }
    return originalFetch(input, init);
  });

  let runtime = await openConnectorRehearsalRuntimeV1({ directory: root, configuration: config }, { port: await port(), service: { api: { oidc_provider: seams.oidc_provider }, slack: seams.slack, jira_person_live_seams: seams.jira_person_live_seams } });
  let origin = `http://127.0.0.1:${runtime.address.port}`;
  let owner = '';
  const post = async (path: string, body: unknown, token = owner) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    const invitation = JSON.parse(readFileSync(manifest.invitation_path, 'utf8')) as { login_grant: string };
    expect((await post('/v2/session/oidc/begin', { kind: 'identity_bootstrap', login_grant: invitation.login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } }, '')).status).toBe(201);
    const callback = await (await fetch(`${origin}/v2/session/oidc/callback?state=${encodeURIComponent(seams.oidcState())}&code=fixture`)).text();
    // The provider intentionally retains the opaque state only inside the fake. Extract the sealed local handoff, as a browser would.
    owner = (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(callback)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
    await expect(requestConnectorRehearsalControlV1({ socket_path: join(root, 'control.sock'), input: { action: 'cycle-once', access_token: owner }, signal: AbortSignal.timeout(5_000) })).rejects.toThrow('Connector rehearsal control request failed');

    expect((await post(ORGANIZATION_API_SLACK_SETUP_PATH_V1, { request_id: `oss_${randomUUID()}`, configuration_token: 'xoxe.fixture-configuration-token' })).status).toBe(201);
    const install = await post(ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, { request_id: `osi_${randomUUID()}` });
    expect(install.status).toBe(201);
    seams.finishSlack();
    expect((await post(ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, { attempt_id: install.body.attempt_id })).body).toMatchObject({ status: 'complete' });
    const code = randomBytes(32).toString('base64url');
    const linked = await post(ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, { request_id: `psb_${randomUUID()}`, recipient_user_id: 'UFOUNDER', challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(code) });
    expect(linked.status).toBe(201);
    expect((await post(ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, { request_id: `psc_${randomUUID()}`, challenge_attempt_id: linked.body.challenge_attempt_id, challenge_message_ts: linked.body.challenge_message_ts, challenge_code: code })).status).toBe(200);

    const jira = await post('/v1/person/tools/jira/connect', { schema_version: 1 });
    expect(jira.status).toBe(201);
    seams.finishJira();
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: jira.body.attempt })).toMatchObject({ status: 200, body: { status: 'complete', failure_reason: null } });
  } finally { await runtime.close(); }

  expect(await quietly({ action: 'finalize', directory: root, configuration: config })).toBe(0);
  expect(granolaFetches).toHaveLength(1);
  runtime = await openConnectorRehearsalRuntimeV1({ directory: root, configuration: config }, { port: await port(), service: { api: { oidc_provider: seams.oidc_provider }, slack: seams.slack, jira_person_live_seams: seams.jira_person_live_seams } });
  origin = `http://127.0.0.1:${runtime.address.port}`;
  try {
    expect(runtime.processing).toBe('active');
    const receipt = await requestConnectorRehearsalControlV1({ socket_path: join(root, 'control.sock'), input: { action: 'capture', tool: 'jira', limit: 1, access_token: owner }, signal: AbortSignal.timeout(15_000) });
    expect(receipt).toMatchObject({ kind: 'echo-context-capture-rehearsal-receipt-v1', counts: { captured: 1, request_only: 1, admitted: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(granolaFetches).toHaveLength(1);
    await expect(requestConnectorRehearsalControlV1({ socket_path: join(root, 'control.sock'), input: { action: 'capture', tool: 'jira', limit: 1, access_token: 'invalid' }, signal: AbortSignal.timeout(5_000) })).rejects.toThrow('Connector rehearsal control request failed');
  } finally { await runtime.close(); }

  const stderr: string[] = [];
  expect(await runOrganizationAuthorityServiceCli(['serve', '--state-dir', join(root, 'state'), '--host', '127.0.0.1', '--port', String(await port()), '--nango-secret-key-file', config.nango.secret_key_file, '--nango-integration', 'slack', '--jira-cloud-id', CLOUD, '--jira-nango-integration', 'jira'], { stdout: () => undefined, stderr: value => stderr.push(value) })).toBe(1);
  expect(stderr.join('')).toContain('echo-clean-live-startup-failed-v1');
});

it('rejects a private rehearsal origin, an unfinished lock, and state copied from another rehearsal root', async () => {
  const privateOriginRoot = newRoot('echo-rehearsal-origin-');
  const privateOrigin = prepareConfiguration(privateOriginRoot, 'https://10.0.0.1');
  await expect(bootstrapConnectorRehearsalV1({ directory: privateOriginRoot, configuration: privateOrigin })).rejects.toThrow('Connector rehearsal prerequisites or state binding are invalid');

  const first = newRoot('echo-rehearsal-first-');
  const firstConfig = prepareConfiguration(first);
  await bootstrapConnectorRehearsalV1({ directory: first, configuration: firstConfig });
  privateFile(join(first, 'operation.lock.json'), JSON.stringify({ schema_version: 1, kind: 'echo-connector-rehearsal-lock-v1', pid: 1 }));
  await expect(openConnectorRehearsalRuntimeV1({ directory: first, configuration: firstConfig }, { port: await port() })).rejects.toThrow('Connector rehearsal has an active or unfinished operation');

  const second = newRoot('echo-rehearsal-second-');
  const secondConfig = prepareConfiguration(second);
  cpSync(join(first, 'state'), join(second, 'state'), { recursive: true });
  chmodSync(join(second, 'state'), 0o700);
  await expect(bootstrapConnectorRehearsalV1({ directory: second, configuration: secondConfig })).rejects.toThrow('Connector rehearsal prerequisites or state binding are invalid');
});
