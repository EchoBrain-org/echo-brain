import { chmodSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { JiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import type { NangoConnectionClientV1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1';
import type { ObserveSlackIdentityLinkChallengeInput, SlackIntegrationProvider } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1';
import type { BegunPersonOidcLogin } from '../../src/application/person-identity-sessions.js';
import { runConnectorRehearsalV1, type ConnectorRehearsalConfigurationV1 } from '../../src/composition/connector-rehearsal-runtime-v1.js';
import { prepare } from '../../../../tools/connector-rehearsal.mjs';
export { prepare } from '../../../../tools/connector-rehearsal.mjs';
export const FIXTURE_AUTHORITY = 'https://connector-rehearsal.example.test';
export const FIXTURE_EMAIL = 'founder@example.test';
export const FIXTURE_CLOUD = '00000000-0000-4000-8000-000000000007';
export const FIXTURE_SITE = 'https://echo-fixture.atlassian.net';

export async function port(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = (server.address() as { port: number }).port;
  const closed = once(server, 'close');
  server.close();
  await closed;
  return result;
}

export function privateFile(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function configuration(root: string, authority = FIXTURE_AUTHORITY): ConnectorRehearsalConfigurationV1 {
  const privateRoot = join(root, 'private');
  return {
    schema_version: 1,
    kind: 'echo-connector-rehearsal-config-v1',
    authority_url: authority,
    organization_name: 'Connector rehearsal fixture',
    owner_name: 'Fixture Founder',
    owner_email: FIXTURE_EMAIL,
    oidc: { config_file: join(privateRoot, 'oidc-config.json'), client_secret_file: null },
    nango: { secret_key_file: join(privateRoot, 'nango-secret-key'), slack_integration_key: 'slack', jira_integration_key: 'jira' },
    jira: { cloud_id: FIXTURE_CLOUD, project: 'ECHO' },
    granola: { credential_file: join(privateRoot, 'granola-organization-key'), owner_email_file: join(privateRoot, 'granola-owner-email') },
    openrouter: { credential_file: join(privateRoot, 'openrouter-credential') },
  };
}

export function prepareConfiguration(root: string, authority = FIXTURE_AUTHORITY): ConnectorRehearsalConfigurationV1 {
  prepare(root);
  const config = configuration(root, authority);
  privateFile(config.oidc.config_file, JSON.stringify({
    issuer: 'https://issuer.example.test', client_id: 'connector-rehearsal-client',
    redirect_uri: `${authority}/v2/session/oidc/callback`, tenant: { kind: 'issuer' },
    id_token_algorithms: ['RS256'], client_authentication: 'none',
  }));
  privateFile(config.nango.secret_key_file, 'synthetic-nango-key-0000000000000000');
  privateFile(config.granola.credential_file, `grn_${'a'.repeat(32)}`);
  privateFile(config.granola.owner_email_file, FIXTURE_EMAIL);
  privateFile(config.openrouter.credential_file, 'synthetic-openrouter-key-000000000000');
  privateFile(join(root, 'connector-rehearsal.json'), JSON.stringify(config));
  return config;
}

export async function quietly(input: Parameters<typeof runConnectorRehearsalV1>[0]): Promise<number> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { return await runConnectorRehearsalV1(input); } finally { write.mockRestore(); }
}

export function providerSeams() {
  let attempted: BegunPersonOidcLogin | undefined;
  const oidc_provider = {
    buildAuthorizationUrl(input: BegunPersonOidcLogin) {
      attempted = input;
      return `https://issuer.example.test/authorize?state=${encodeURIComponent(input.state)}`;
    },
    async redeemAuthorizationCode() {
      return { kind: 'verified' as const, token: {
        issuer: 'https://issuer.example.test', subject: 'fixture-founder', audience: 'connector-rehearsal-client', nonce: attempted!.nonce,
        issued_at: Math.floor(Date.now() / 1000), claims: { email: FIXTURE_EMAIL, email_verified: true },
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
    if (url.pathname === '/oauth/token/accessible-resources') return Response.json([{ id: FIXTURE_CLOUD, url: FIXTURE_SITE, scopes: ['read:jira-work', 'read:jira-user'] }]);
    if (url.pathname.endsWith('/myself')) return Response.json({ accountId: 'fixture-jira-account', active: true, accountType: 'atlassian' });
    if (url.pathname.endsWith('/project/ECHO')) return Response.json({ id: '10000', key: 'ECHO', self: `${FIXTURE_SITE}/rest/api/3/project/10000` });
    if (url.pathname.endsWith('/search/jql')) return Response.json({ isLast: true, issues: [{ id: '10001' }] });
    if (url.pathname.endsWith('/issue/10001')) return Response.json({ id: '10001', key: 'ECHO-1', self: `${FIXTURE_SITE}/rest/api/3/issue/10001`, fields: { summary: 'Ship connector rehearsal', project: { id: '10000', key: 'ECHO', self: `${FIXTURE_SITE}/rest/api/3/project/10000` }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Capture Jira through the rehearsal.' }] }] }, created: '2026-10-01T12:00:00.000Z', updated: '2026-10-02T03:04:05.000-0700', status: { name: 'Open' }, assignee: { displayName: 'Fixture Owner', accountId: 'fixture-jira-account' }, duedate: null, labels: ['rehearsal'], priority: { name: 'High' } } });
    throw new Error(`unexpected Jira endpoint ${url.pathname}`);
  });
  return { oidc_provider, oidcState: () => attempted?.state ?? '', slack: { nango: slackNango, manifest_provider: { createApp: vi.fn(async () => ({ app_id: 'AFIXTURE', client_id: '111.222', client_secret: 'synthetic-slack-client-secret', signing_secret: 'synthetic-slack-signing-secret' })), updateApp: vi.fn() }, provider }, jira_person_live_seams: { nango: jira, fetch: jiraFetch }, finishSlack, finishJira, jiraFetch };
}
