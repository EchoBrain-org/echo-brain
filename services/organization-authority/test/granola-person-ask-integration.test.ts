import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { validateOrganizationPersonToolsV4, validatePersonAnswerResponseV8 } from '@echo-brain/organization-api';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { openOrganizationAuthorityService } from '../src/composition/organization-authority-composition-root.js';
import { fakeConfluenceNangoV1 } from './fixtures/fake-confluence-v1.js';
import { askReply } from './fixtures/ask-over-http.js';
const CLOUD = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const MEETING = '33333333-3333-4333-8333-333333333333';
import { ownerGenesis, port, signInHttp, syntheticOidcProvider } from './fixtures/owner-session.js';

const EMAIL = 'founder@example.test';
const AUTHORITY = 'https://authority.example.test';
const OIDC = { issuer: 'https://issuer.example.test', client_id: 'fixture-client', redirect_uri: `${AUTHORITY}/v2/session/oidc/callback`, tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'] };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

/** Production Authority composition with synthetic OIDC/model/provider boundaries. */
it('catalogs, connects, maps, cites, and disconnects historical Granola evidence without source admission through the Ask route', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-granola-ask-proof-'))); chmodSync(root, 0o700); roots.push(root);
  const genesis = ownerGenesis({ root, oidc: OIDC, email: EMAIL, authority_url: AUTHORITY, revision: 'granola-fixture' });
  const { initialized, credentials: keys } = genesis;
  const oidc_provider = syntheticOidcProvider(OIDC, () => EMAIL);
  const granola = fakeConfluenceNangoV1();
  const mcpCalls: { name: string; arguments: Record<string, unknown> }[] = [];
  const granolaFetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), { name, arguments: args } = request.params;
    mcpCalls.push(request.params);
    let value: unknown;
    if (name === 'get_account_info') value = { email: EMAIL, active_workspace: { id: CLOUD, display_name: 'Fixture' }, mcp_note_access: { scopes: ['personal', 'public'] } };
    else if (name === 'list_meeting_folders') value = { count: 1, folders: [{ id: FOLDER, title: 'Interviews', note_count: 1 }] };
    else if (name === 'search_meetings' || name === 'get_meetings') value = `<pagination has_more="false" completion_status="exhausted" /><meetings_data count="1"><meeting id="${MEETING}" title="Historical interview" date="Jan 10, 2025" meeting_at="2025-01-10T09:00:00Z" url="https://notes.granola.ai/d/${MEETING}"><known_participants>Speaker A</known_participants><private_notes>Pilot planning</private_notes><summary>The pilot starts after access review.</summary></meeting></meetings_data>`;
    else if (name === 'search_transcripts') value = { status: 'ok', completion_status: 'exhausted', next_cursor: null, meetings: [{ meeting_id: MEETING, transcript_version: 'v1', passages: [{ chunk_id: 0, text: 'The pilot starts after access review.' }] }] };
    else if (name === 'get_meeting_transcript' && args.chunk_ids?.[0] === 0) value = { id: MEETING, status: 'ok', transcript_version: 'v1', chunks: [{ chunk_id: 0, transcript: '[0:30] Speaker A: The pilot starts after access review.' }] };
    else throw new Error(`Unexpected provider operation: ${name}`);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } });
  };
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { items?: string[] }[]; opened?: { id: string }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).blocks !== undefined) {
      return { blocks: [{ block: 'answer', sentences: [{ text: 'The interview says the pilot starts after access review.', evidence: [prompt.evidence![0]!.id] }] }], not_found: [] };
    }
    const id = prompt.opened?.[0]?.id ?? prompt.last_results?.[0]?.items?.[0];
    if (prompt.opened?.length) return { parts: [{ question: prompt.question, needs: [{ need: 'release decision', status: 'found', evidence: [id] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    if (id !== undefined) return { parts: [{ question: prompt.question, needs: [{ need: 'release decision', status: 'open', evidence: [] }], notes: '' }], actions: [{ tool: 'open', args: { id } }] };
    return { parts: [{ question: prompt.question, needs: [{ need: 'release decision', status: 'open', evidence: [] }], notes: '' }], actions: [{ tool: 'search', args: { query: 'pilot', source: 'granola_meetings' } }] };
  });
  const privateFile = (name: string, value: string) => { const path = join(root, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
  const runtime = await openOrganizationAuthorityService({
    state_directory: initialized.state_directory, host: '127.0.0.1', port: await port(), authority_url: AUTHORITY, oidc: OIDC, client_authentication: { method: 'none' }, pkce_key_file: keys.pkce_sealing_key_reference.slice(5),
    nango: { secret_key: 'synthetic-nango-key-0000000000000000', integration_key: 'slack' },
    openrouter_credential_file: privateFile('openrouter.key', 'synthetic-openrouter-key-000000000000'),
  }, {
    api: { oidc_provider, answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 25_000 } } },
    granola_person_live_seams: { nango: granola.nango, fetch: granolaFetch },
    slack: { nango: {} as never, manifest_provider: {} as never, provider: {} as never },
  });
  const origin = `http://127.0.0.1:${runtime.address.port}`;
  let owner = '';
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return askReply(response);
  };
  const tools = async () => {
    const response = await fetch(`${origin}/v4/person/tools`, { headers: { authorization: `Bearer ${owner}` } });
    expect(response.status).toBe(200); return validateOrganizationPersonToolsV4(await response.json()).tools;
  };
  try {
    owner = await signInHttp(origin, oidc_provider, genesis.login_grant);
    expect(await tools()).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'granola', personal_status: 'unlinked', external_subject_id: null })]));
    const connected = await post('/v1/person/tools/granola/connect', { schema_version: 1 }); expect(connected.status).toBe(201);
    expect(granola.tags()).toMatchObject({ organization_id: initialized.organization_id, echo_membership: initialized.owner_membership_id });
    granola.finish();
    expect(await post('/v1/person/tools/granola/status', { schema_version: 1, attempt: connected.body.attempt })).toMatchObject({ status: 200, body: { status: 'complete', failure_reason: null } });
    expect(await tools()).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'granola', personal_status: 'linked', external_scope_id: CLOUD })]));
    const created = await post('/v1/person/projects', { schema_version: 1, kind: 'echo-project-create-v1', request_id: randomUUID(), name: 'Project A' }); expect(created.status).toBe(201);
    const project_id = created.body.project_id as string;
    const mappingRead = { schema_version: 1, project_id };
    expect(await post('/v1/person/tools/granola/project/read', mappingRead)).toMatchObject({ status: 200, body: { mapping: null, revision: null } });
    const mapped = await post('/v1/person/tools/granola/project/set', { ...mappingRead, request_id: randomUUID(), expected_revision: null, folder_ids: [FOLDER] });
    expect(mapped).toMatchObject({ status: 200, body: { mapping: { cloud_id: CLOUD, folder_ids: [FOLDER] } } });
    const answer = await post('/v7/person/ask', { schema_version: 3, question: 'What did the interview say about the pilot?', project_id });
    expect(answer.status, JSON.stringify({ body: answer.body, tools: mcpCalls.map(call => call.name), generations: generate.mock.calls.length })).toBe(200);
    const checked = validatePersonAnswerResponseV8(answer.body);
    expect(JSON.stringify(checked)).toContain('https://notes.granola.ai/d/' + MEETING);
    expect(JSON.stringify(checked)).toContain('transcript:0:0');
    expect(mcpCalls.filter(call => call.name === 'search_meetings').every(call => call.arguments.folder_id === FOLDER)).toBe(true);
    expect(mcpCalls.find(call => call.name === 'search_transcripts')?.arguments.meeting_ids).toEqual([MEETING]);
    const home = await post('/v1/person/meetings', { schema_version: 2, tool_id: 'granola', operation: 'home' });
    expect(home.status).toBe(200);
    expect(JSON.stringify(home.body)).toContain('"sources":[]');
    expect((await post('/v1/person/tools/granola/disconnect', { schema_version: 1 })).status).toBe(200);
    expect(await tools()).toEqual(expect.arrayContaining([expect.objectContaining({ tool_id: 'granola', personal_status: 'revoked', external_subject_id: null })]));
  } finally { await runtime.close(); }
});
