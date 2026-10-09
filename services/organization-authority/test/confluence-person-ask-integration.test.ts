import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { validateOrganizationPersonToolsV4, validatePersonAnswerResponseV6 } from '@echo-brain/organization-api';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { BegunPersonOidcLogin } from '../src/application/person-identity-sessions.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials, issuePersonOnboardingInvitation } from '../src/composition/person-onboarding-service.js';
import { openOrganizationAuthorityService } from '../src/composition/organization-authority-composition-root.js';
import { readPrivateAuthorityPersonSessionPkceKey } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import { FIXTURE_CONFLUENCE_CLOUD_V1 as CLOUD, FIXTURE_CONFLUENCE_SITE_V1 as SITE, fakeConfluenceCloudFetchV1, fakeConfluenceNangoV1 } from './fixtures/fake-confluence-v1.js';
import { port } from './fixtures/connector-rehearsal-runtime-fixture-v1.js';

const EMAIL = 'founder@example.test';
const AUTHORITY = 'https://authority.example.test';
const OIDC = { issuer: 'https://issuer.example.test', client_id: 'fixture-client', redirect_uri: `${AUTHORITY}/v2/session/oidc/callback`, tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'] };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

/** Production Authority composition with synthetic OIDC/model/provider boundaries. */
it('catalogs, connects, maps, cites, and disconnects Confluence page evidence through the V6 Ask route', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-confluence-ask-proof-'))); chmodSync(root, 0o700); roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: join(root, 'state'), organization_display_name: 'Fixture', owner_display_name: 'Founder', created_at: new Date(Date.now() - 1000).toISOString(), creating_artifact_revision: 'confluence-fixture' });
  const keys = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
  const invitation = join(root, 'invitation.json');
  issuePersonOnboardingInvitation({ state_directory: initialized.state_directory, oidc: OIDC, pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(keys.pkce_sealing_key_reference), membership_id: initialized.owner_membership_id, expected_email: EMAIL, authority_url: AUTHORITY, output_path: invitation });
  let attempt: BegunPersonOidcLogin | undefined;
  const oidc_provider = {
    buildAuthorizationUrl(value: BegunPersonOidcLogin) { attempt = value; return `${OIDC.issuer}/authorize?state=${encodeURIComponent(value.state)}`; },
    async redeemAuthorizationCode() { return { kind: 'verified' as const, token: { issuer: OIDC.issuer, subject: 'fixture-founder', audience: OIDC.client_id, nonce: attempt!.nonce, issued_at: Math.floor(Date.now() / 1000), claims: { email: EMAIL, email_verified: true } } }; },
  };
  const confluence = fakeConfluenceNangoV1();
  const confluenceFetch = fakeConfluenceCloudFetchV1();
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { items?: { id: string }[] }[]; opened?: { id: string }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
      return { sentences: [{ text: 'The MRD says to start EVT after PRD approval.', evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    }
    const id = prompt.opened?.[0]?.id ?? prompt.last_results?.[0]?.items?.[0]?.id;
    if (prompt.opened?.length) return { parts: [{ question: prompt.question, needs: [{ need: 'release decision', status: 'found', evidence: [id] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    if (id !== undefined) return { parts: [{ question: prompt.question, needs: [{ need: 'release decision', status: 'open', evidence: [] }], notes: '' }], actions: [{ tool: 'open', args: { id } }] };
    return { parts: [{ question: prompt.question, needs: [{ need: 'release decision', status: 'open', evidence: [] }], notes: '' }], actions: [{ tool: 'list', args: { source: 'pages' } }] };
  });
  const privateFile = (name: string, value: string) => { const path = join(root, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
  const runtime = await openOrganizationAuthorityService({
    state_directory: initialized.state_directory, host: '127.0.0.1', port: await port(), authority_url: AUTHORITY, oidc: OIDC, client_authentication: { method: 'none' }, pkce_key_file: keys.pkce_sealing_key_reference.slice(5),
    slack_nango: { secret_key: 'synthetic-nango-key-0000000000000000', integration_key: 'slack' },
    confluence_person_live: { enabled: true, cloud_id: CLOUD, integration_id: 'confluence', nango_authorization: () => 'synthetic-nango-key-0000000000000000' },
    openrouter_credential_file: privateFile('openrouter.key', 'synthetic-openrouter-key-000000000000'),
  }, {
    api: { oidc_provider, answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 25_000 } } },
    confluence_person_live_seams: { nango: confluence.nango, fetch: confluenceFetch },
    slack: { nango: {} as never, manifest_provider: {} as never, provider: {} as never },
  });
  const origin = `http://127.0.0.1:${runtime.address.port}`;
  let owner = '';
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const tools = async () => {
    const response = await fetch(`${origin}/v4/person/tools`, { headers: { authorization: `Bearer ${owner}` } });
    expect(response.status).toBe(200); return validateOrganizationPersonToolsV4(await response.json()).tools;
  };
  try {
    const login_grant = (JSON.parse(readFileSync(invitation, 'utf8')) as { login_grant: string }).login_grant;
    expect((await post('/v2/session/oidc/begin', { kind: 'identity_bootstrap', login_grant, loopback_handoff: { url: `http://127.0.0.1:39999/${'P'.repeat(43)}`, token: 'T'.repeat(43) } })).status).toBe(201);
    const page = await (await fetch(`${origin}/v2/session/oidc/callback?state=${encodeURIComponent(attempt!.state)}&code=synthetic`)).text();
    owner = (JSON.parse(Buffer.from(/name="session" value="([A-Za-z0-9_-]+)"/.exec(page)![1]!, 'base64url').toString('utf8')) as { access_token: string }).access_token;
    expect(await tools()).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'confluence', personal_status: 'unlinked', external_subject_id: null })]));
    const connected = await post('/v1/person/tools/confluence/connect', { schema_version: 1 }); expect(connected.status).toBe(201);
    expect(confluence.tags()).toMatchObject({ organization_id: initialized.organization_id, echo_membership: initialized.owner_membership_id });
    confluence.finish();
    expect(await post('/v1/person/tools/confluence/status', { schema_version: 1, attempt: connected.body.attempt })).toMatchObject({ status: 200, body: { status: 'complete', failure_reason: null } });
    expect(await tools()).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'confluence', personal_status: 'linked', external_scope_id: CLOUD })]));
    const created = await post('/v1/person/projects', { schema_version: 1, kind: 'echo-project-create-v1', request_id: randomUUID(), name: 'Project A' }); expect(created.status).toBe(201);
    const project_id = created.body.project_id as string;
    const mappingRead = { schema_version: 1, project_id };
    expect(await post('/v1/person/tools/confluence/project/read', mappingRead)).toMatchObject({ status: 200, body: { mapping: null, revision: null } });
    const mapped = await post('/v1/person/tools/confluence/project/set', { ...mappingRead, request_id: randomUUID(), expected_revision: null, space_ids: ['123'] });
    expect(mapped).toMatchObject({ status: 200, body: { mapping: { cloud_id: CLOUD, space_ids: ['123'] } } });
    generate.mockClear(); confluenceFetch.mockClear(); vi.mocked(confluence.nango.connection).mockClear();
    const answer = await post('/v5/person/ask', { schema_version: 3, question: 'What did we decide for the release?', project_id });
    expect(answer.status).toBe(200);
    expect(validatePersonAnswerResponseV6(answer.body)).toMatchObject({ schema_version: 6, outcome: 'answered', scope: { kind: 'project', project_id }, citations: [expect.objectContaining({ kind: 'page', citation: expect.objectContaining({ page_id: '100', external_scope_id: CLOUD, permalink: `${SITE}/wiki/pages/viewpage.action?pageId=100` }) })] });
    expect(confluenceFetch.mock.calls.some(([url]) => {
      const request = new URL(String(url));
      return request.pathname.endsWith('/api/v2/pages') && request.searchParams.get('space-id') === '123';
    })).toBe(true);
    // One Ask creates one request-owned Confluence reader. Its discovery,
    // open, verification, and citation revalidation all share that reader's
    // credential lookup; the next Ask must create a fresh one.
    expect(vi.mocked(confluence.nango.connection)).toHaveBeenCalledTimes(1);
    expect(confluenceFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/oauth/token/accessible-resources').length).toBeGreaterThan(1);
    expect(confluenceFetch.mock.calls.filter(([url]) => {
      const request = new URL(String(url));
      return request.pathname.endsWith('/api/v2/pages') && request.searchParams.has('id');
    }).length).toBeGreaterThan(0);
    generate.mockClear(); confluenceFetch.mockClear(); vi.mocked(confluence.nango.connection).mockClear();
    const fresh = await post('/v5/person/ask', { schema_version: 3, question: 'What did we decide for the release?', project_id });
    expect(fresh.status).toBe(200);
    expect(vi.mocked(confluence.nango.connection)).toHaveBeenCalledTimes(1);
    expect((await post('/v1/person/tools/confluence/disconnect', { schema_version: 1 })).status).toBe(200);
    expect(await tools()).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'confluence', personal_status: 'revoked', external_subject_id: null })]));
  } finally { await runtime.close(); }
});
