import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1 } from '@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1';
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, organizationPersonSlackIdentityLinkChallengeCodeSha256 } from '@echo-brain/provider-slack-client/organization-api/person-slack-identity-link';
import type { NangoConnectionClientV1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1';
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1, type ObserveSlackIdentityLinkChallengeInput, type SlackIntegrationProvider } from '@echo-brain/provider-slack-server/organization-control-plane/application/slack-integration-contracts';
import { slackConnectionVerificationEvidenceSha256V1 } from '../../../../providers/slack/server/src/organization-control-plane/application/slack-connection-verification-evidence-v1.js';
import type { BegunPersonOidcLogin } from '../../src/application/person-identity-sessions.js';
import { FIXTURE_JIRA_CLOUD_V1, fakeJiraCloudFetchV1, fakeJiraNangoV1 } from './fake-jira-v1.js';
export const FIXTURE_EMAIL = 'founder@example.test';
export const FIXTURE_CLOUD = FIXTURE_JIRA_CLOUD_V1;

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

/** Creates a new private root whose `private/` directory holds the staging profile and test inputs. */
export function prepare(root: string): void {
  for (const path of [root, join(root, 'private')]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

export function configuration(root: string) {
  const privateRoot = join(root, 'private');
  return {
    organization_name: 'Connector rehearsal fixture',
    owner_name: 'Fixture Founder',
    owner_email: FIXTURE_EMAIL,
    oidc: { config_file: join(privateRoot, 'oidc-config.json') },
    nango: { secret_key_file: join(privateRoot, 'nango-secret-key') },
    granola: { credential_file: join(privateRoot, 'granola-organization-key'), owner_email_file: join(privateRoot, 'granola-owner-email') },
    openrouter: { credential_file: join(privateRoot, 'openrouter-credential') },
  };
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
    createReconnectSession: vi.fn(async input => {
      slackTags = input.tags;
      return { connect_link: 'https://connect.nango.dev/fixture-slack', expires_at: new Date(Date.now() + 60_000).toISOString() };
    }),
    findConnectionIdByTag: vi.fn(async input => slackTags[input.key] === input.value ? 'fixture-slack-connection' : undefined),
    getSlackConnection: vi.fn(async () => {
      if (slackConnection === undefined) throw new Error('fixture Slack connection has not completed');
      return slackConnection;
    }),
  };
  const finishSlack = (scopes: readonly string[] = SLACK_PRIVATE_APP_BOT_SCOPES_V1) => {
    slackConnection = {
      connection_id: 'fixture-slack-connection', tags: slackTags, team_id: 'TFIXTURE', app_id: 'AFIXTURE', bot_user_id: 'UBOTFIXTURE',
      granted_scopes: scopes, bot_token: 'xoxb-synthetic-slack',
    };
  };
  const provider: SlackIntegrationProvider = {
    verifyConnection: vi.fn(async () => {
      const verified = { team_id: 'TFIXTURE', enterprise_id: null, bot_user_id: 'UBOTFIXTURE', bot_id: 'BFIXTURE', app_id: 'AFIXTURE',
        granted_scopes: slackConnection?.granted_scopes ?? SLACK_PRIVATE_APP_BOT_SCOPES_V1 };
      return { ...verified, verification_evidence_sha256: slackConnectionVerificationEvidenceSha256V1(verified) };
    }),
    openIdentityLinkDirectMessage: vi.fn(async (_token: string, userId: string) => ({ team_id: 'TFIXTURE', channel_id: `D${userId.slice(1)}`, recipient_user_id: userId })),
    postIdentityLinkChallenge: vi.fn(async (_token: string, input: { channel_id: string }) => ({ team_id: 'TFIXTURE', channel_id: input.channel_id, challenge_message_ts: '1727700000.000001' })),
    observeIdentityLinkChallenge: vi.fn(async (_token: string, input: ObserveSlackIdentityLinkChallengeInput) => {
      if (input.recipient_user_id === undefined) throw new Error('fixture recipient is required');
      return { team_id: 'TFIXTURE', user_id: input.recipient_user_id, channel_id: input.channel_id, challenge_message_ts: input.challenge_message_ts,
        reply_message_ts: '1727700000.000002', verification_evidence_sha256: canonicalSha256({ fixture: input.recipient_user_id, reply: true }) };
    }),
  };
  const jira = fakeJiraNangoV1();
  const jiraFetch = fakeJiraCloudFetchV1();
  return { oidc_provider, oidcState: () => attempted?.state ?? '', slack: { nango: slackNango, manifest_provider: { createApp: vi.fn(async () => ({ app_id: 'AFIXTURE', client_id: '111.222', client_secret: 'synthetic-slack-client-secret', signing_secret: 'synthetic-slack-signing-secret' })), updateApp: vi.fn() }, provider }, jira_person_live_seams: { nango: jira.nango, fetch: jiraFetch }, finishSlack, finishJira: jira.finish, jiraFetch };
}

type ProviderSeamsV1 = ReturnType<typeof providerSeams>;
type FixturePostV1 = (path: string, body: unknown) => Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;

/** Completes the owner's invitation sign-in as a browser would and returns the sealed access token. */
export async function signInOwner(origin: string, seams: ProviderSeamsV1, invitationPath: string): Promise<string> {
  const { login_grant } = JSON.parse(readFileSync(invitationPath, 'utf8')) as { login_grant: string };
  const begun = await fetch(`${origin}/v2/session/oidc/begin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'identity_bootstrap', login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } }),
  });
  expect(begun.status).toBe(201);
  const callback = await (await fetch(`${origin}/v2/session/oidc/callback?state=${encodeURIComponent(seams.oidcState())}&code=fixture`)).text();
  return (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(callback)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
}

/** Sets up and installs the organization Slack app, then links the signed-in owner's Slack identity. */
export async function connectSlackAndLinkOwner(post: FixturePostV1, seams: ProviderSeamsV1, scopes?: readonly string[]): Promise<void> {
  expect((await post(ORGANIZATION_API_SLACK_SETUP_PATH_V1, { request_id: `oss_${randomUUID()}`, configuration_token: 'xoxe.fixture-configuration-token' })).status).toBe(201);
  const install = await post(ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, { request_id: `osi_${randomUUID()}` });
  expect(install.status).toBe(201);
  seams.finishSlack(scopes);
  expect(await post(ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, { attempt_id: install.body.attempt_id })).toMatchObject({ status: 200, body: { status: 'complete' } });
  const code = randomBytes(32).toString('base64url');
  const linked = await post(ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, { request_id: `psb_${randomUUID()}`, recipient_user_id: 'UFOUNDER', challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(code) });
  expect(linked.status).toBe(201);
  expect((await post(ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, { request_id: `psc_${randomUUID()}`, challenge_attempt_id: linked.body.challenge_attempt_id, challenge_message_ts: linked.body.challenge_message_ts, challenge_code: code })).status).toBe(200);
}
