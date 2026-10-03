import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV4, validatePersonAnswerResponseV5 } from '@echo-brain/organization-api';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { readPrivateAuthorityPersonSessionPkceKey } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { NangoConnectionClientV1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1';
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from '@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1';
import type { BegunPersonOidcLogin } from '../src/application/person-identity-sessions.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials, issuePersonOnboardingInvitation } from '../src/composition/person-onboarding-service.js';
import { openOrganizationAuthorityService } from '../src/composition/organization-authority-composition-root.js';
import { FIXTURE_JIRA_CLOUD_V1 as CLOUD, FIXTURE_JIRA_SITE_V1 as SITE, fakeJiraCloudFetchV1, fakeJiraNangoV1 } from './fixtures/fake-jira-v1.js';

const EMAIL = 'founder@example.test';
const AUTHORITY = 'https://authority.example.test';
const OIDC = { issuer: 'https://issuer.example.test', client_id: 'fixture-client', redirect_uri: `${AUTHORITY}/v2/session/oidc/callback`, tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'] };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

async function port(): Promise<number> {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const result = (socket.address() as { port: number }).port; const closed = once(socket, 'close'); socket.close(); await closed; return result;
}

/** Production selecting composition and real Person sessions; both providers and models are synthetic. */
it('connects Jira for the authenticated Person, audits tickets before Ask, and retains modern Slack Nango setup wiring', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-jira-ask-proof-'))); chmodSync(root, 0o700); roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: join(root, 'state'), organization_display_name: 'Fixture', owner_display_name: 'Founder', created_at: new Date(Date.now() - 1000).toISOString(), creating_artifact_revision: 'jira-fixture' });
  const state = initialized.state_directory;
  const keys = initializePersonSessionCredentials({ state_directory: state });
  const invitation = join(root, 'invitation.json');
  issuePersonOnboardingInvitation({ state_directory: state, oidc: OIDC, pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(keys.pkce_sealing_key_reference), membership_id: initialized.owner_membership_id, expected_email: EMAIL, authority_url: AUTHORITY, output_path: invitation });
  let attempt: BegunPersonOidcLogin | undefined;
  let loginEmail = EMAIL;
  const oidc_provider = {
    buildAuthorizationUrl(value: BegunPersonOidcLogin) { attempt = value; return `${OIDC.issuer}/authorize?state=${encodeURIComponent(value.state)}`; },
    async redeemAuthorizationCode() { return { kind: 'verified' as const, token: { issuer: OIDC.issuer, subject: `fixture-${loginEmail}`, audience: OIDC.client_id, nonce: attempt!.nonce, issued_at: Math.floor(Date.now() / 1000), claims: { email: loginEmail, email_verified: true } } }; },
  };
  const jira = fakeJiraNangoV1();
  const jiraFetch = fakeJiraCloudFetchV1();
  let slackTags: Readonly<Record<string, string>> = {};
  const slackNango: NangoConnectionClientV1 = {
    createConnectSession: vi.fn(async input => { slackTags = input.tags; return { connect_link: 'https://connect.nango.dev/fixture-slack', expires_at: new Date(Date.now() + 60_000).toISOString() }; }),
    createReconnectSession: vi.fn(), findConnectionIdByTag: vi.fn(async () => 'fixture-slack-reference'),
    getSlackConnection: vi.fn(async () => ({ connection_id: 'fixture-slack-reference', tags: slackTags, team_id: 'TFIXTURE', enterprise_id: null, is_enterprise_install: false, app_id: 'AFIXTURE', bot_user_id: 'UBOTFIXTURE', granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: 'xoxb-synthetic-slack', updated_at: new Date().toISOString() })),
  };
  const verifySlack = vi.fn(async () => ({ team_id: 'TFIXTURE', enterprise_id: null, bot_user_id: 'UBOTFIXTURE', bot_id: 'BFIXTURE', app_id: 'AFIXTURE', granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, verification_evidence_sha256: canonicalSha256({ fixture: 'slack-identity' }) }));
  const audit = openAuthorityDatabase(join(state, 'authority.sqlite'), { fileMustExist: true });
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { results?: { id: string }[] }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) return { sentences: [{ text: 'The ticket says ship on Friday.', evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    const hit = prompt.last_results?.[0]?.results?.[0]?.id;
    if (hit !== undefined) {
      const releases = audit.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE body_json LIKE '%echo-person-live-evidence-release-audit-v1%'").all();
      expect(releases.length).toBeGreaterThan(0); // Ticket bytes reached this model only after durable release audit.
      return { parts: [{ question: prompt.question, needs: [{ need: 'ship day', status: 'found', evidence: [hit] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    }
    return { parts: [{ question: prompt.question, needs: [{ need: 'ship day', status: 'open', evidence: [] }], notes: '' }], actions: [{ tool: 'search', args: { query: 'ship', kinds: ['ticket'] } }] };
  });
  const privateFile = (name: string, value: string) => { const path = join(root, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
  const runtime = await openOrganizationAuthorityService({
    state_directory: state, host: '127.0.0.1', port: await port(), authority_url: AUTHORITY, oidc: OIDC, client_authentication: { method: 'none' }, pkce_key_file: keys.pkce_sealing_key_reference.slice(5),
    slack_nango: { secret_key: 'synthetic-nango-key-0000000000000000', integration_key: 'slack' },
    jira_person_live: { enabled: true, cloud_id: CLOUD, integration_id: 'jira', nango_authorization: () => 'synthetic-nango-key-0000000000000000' },
    granola_credential_file: privateFile('granola.key', 'synthetic-granola-credential-000000000000'), granola_owner_email_file: privateFile('granola-email', EMAIL), openrouter_credential_file: privateFile('openrouter.key', 'synthetic-openrouter-key-000000000000'),
  }, {
    api: { oidc_provider, answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 25_000 } } },
    jira_person_live_seams: { nango: jira.nango, fetch: jiraFetch },
    slack: { nango: slackNango, manifest_provider: { createApp: vi.fn(async () => ({ app_id: 'AFIXTURE', client_id: '111.222', client_secret: 'synthetic-slack-client-secret', signing_secret: 'synthetic-slack-signing-secret' })), updateApp: vi.fn() }, provider: { verifyConnection: verifySlack, openIdentityLinkDirectMessage: vi.fn(), postIdentityLinkChallenge: vi.fn(), observeIdentityLinkChallenge: vi.fn() } },
  });
  const origin = `http://127.0.0.1:${runtime.address.port}`;
  const post = async (path: string, body: unknown, token = owner) => { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, any> }; };
  let owner = '';
  try {
    const login_grant = (JSON.parse(readFileSync(invitation, 'utf8')) as { login_grant: string }).login_grant;
    const begun = await post('/v2/session/oidc/begin', { kind: 'identity_bootstrap', login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } });
    expect(begun.status).toBe(201);
    const page = await (await fetch(`${origin}/v2/session/oidc/callback?state=${encodeURIComponent(attempt!.state)}&code=synthetic`)).text();
    owner = (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(page)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
    expect((await post('/v1/person/tools/jira/connect', { schema_version: 1 }, 'wrong-person-token')).status).toBe(401);
    const connected = await post('/v1/person/tools/jira/connect', { schema_version: 1 }); expect(connected.status).toBe(201);
    expect(jira.tags()).toMatchObject({ organization_id: initialized.organization_id, echo_membership: initialized.owner_membership_id });
    const invited = await post('/v1/person/employees', { name: 'Fixture Employee', email: 'employee@example.test' }); expect(invited.status).toBe(201);
    loginEmail = 'employee@example.test';
    const employeeBegin = await post('/v2/session/oidc/begin', { kind: 'identity_bootstrap', login_grant: invited.body.login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } }); expect(employeeBegin.status).toBe(201);
    const employeePage = await (await fetch(`${origin}/v2/session/oidc/callback?state=${encodeURIComponent(attempt!.state)}&code=employee`)).text();
    const employee = (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(employeePage)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
    expect((await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: connected.body.attempt }, employee)).status).toBe(401);
    jira.finish(); // Browser consent is reconciled only by the server-bound attempt.
    expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: connected.body.attempt })).toMatchObject({ status: 200, body: { status: 'complete', failure_reason: null } });
    const response = await post('/v4/person/ask', { schema_version: 3, question: 'When should the ticket ship?' }); expect(response.status).toBe(200);
    const answer = validatePersonAnswerResponseV5(response.body); expect(answer.citations[0]).toMatchObject({ kind: 'ticket', citation: { ticket_id: '10001', external_scope_id: CLOUD, permalink: `${SITE}/browse/ECHO-1` } });
    const cited = answer.citations[0]!.citation; if (cited.kind !== 'ticket') throw new Error('Expected fixture ticket citation');
    expect(() => validatePersonAnswerResponseV4(response.body)).toThrow();
    expect(generate).toHaveBeenCalledTimes(3);
    const rows = audit.prepare('SELECT body_json FROM authority_person_read_decision_audit_v2').all() as { body_json: string }[];
    const releases = rows.map(row => JSON.parse(row.body_json)).filter(row => row.kind === 'echo-person-live-evidence-release-audit-v1'); expect(releases[0].citations[0]).toMatchObject({ coordinates: { object_id: '10001' }, text_sha256: cited.text_sha256 });
    for (const row of rows) { expect(row.body_json).not.toContain('Ship on Friday'); expect(row.body_json).not.toContain('synthetic-jira-oauth-bearer'); expect(row.body_json).not.toContain('jira_item_'); }
    // Both live connectors share this production root without retired Slack startup fields.
    expect((await post('/v2/organization/tools/slack/setup', { request_id: `oss_${randomUUID()}`, configuration_token: 'synthetic-slack-configuration-token' })).status).toBe(201);
    const slackBegin = await post('/v2/organization/tools/slack/install/begin', { request_id: `osi_${randomUUID()}` }); expect(slackBegin.status).toBe(201);
    const slackStatus = await post('/v2/organization/tools/slack/install/status', { attempt_id: slackBegin.body.attempt_id }); expect(slackStatus).toMatchObject({ status: 200, body: { status: 'complete', result: { kind: 'created', workspace_id: 'TFIXTURE' } } });
    expect(verifySlack).toHaveBeenCalledWith('xoxb-synthetic-slack', undefined);
  } finally { await runtime.close(); audit.close(); }
});
