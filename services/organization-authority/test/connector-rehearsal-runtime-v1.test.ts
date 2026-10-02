import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1 } from '@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1';
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, organizationPersonSlackIdentityLinkChallengeCodeSha256 } from '@echo-brain/provider-slack-client/organization-api/person-slack-identity-link';
import { requestConnectorRehearsalControlV1 } from '../src/composition/connector-rehearsal-control-v1.js';
import { bootstrapConnectorRehearsalV1, openConnectorRehearsalRuntimeV1 } from '../src/composition/connector-rehearsal-runtime-v1.js';
import { readOrganizationAuthoritySetupManifest } from '../src/composition/organization-authority-setup-cli.js';
import { runOrganizationAuthorityServiceCli } from '../src/composition/organization-authority-service-cli.js';
import { FIXTURE_CLOUD as CLOUD, FIXTURE_EMAIL as EMAIL, port, prepareConfiguration, providerSeams, privateFile, quietly } from './fixtures/connector-rehearsal-runtime-fixture-v1.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function newRoot(prefix: string): string {
  const directory = process.platform === 'darwin' ? '/private/tmp' : realpathSync(tmpdir());
  const root = mkdtempSync(`${directory}/${prefix}`);
  rmSync(root, { recursive: true, force: true });
  roots.push(root);
  return root;
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
