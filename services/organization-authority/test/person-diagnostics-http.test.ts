import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_PATH_V5, PERSON_DIAGNOSTICS_PATH_V1, PERSON_RUNS_PATH_V1,
  validatePersonDiagnosticsResultV1,
} from '@echo-brain/organization-api';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createPersonDiagnosticsV1, type PersonDiagnosticsV1 } from '../src/composition/person-diagnostics-v1.js';
import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import type { PersonDiagnosticsHttpApplicationV1 } from '../src/presentation/person-diagnostics-http-application.js';
import type { PersonAnswerV5HttpApplication } from '../src/presentation/person-answer-v5-http-application.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../src/presentation/person-trigger-runs-http-application.js';

const capture_id = 'cap_00000000-0000-4000-8000-000000000001';
const run_id = 'run_00000000-0000-4000-8000-000000000002';
const receipt = { schema_version: 1 as const, kind: 'echo-person-diagnostic-capture-v1' as const, capture_id, status: 'prepared' as const, expires_at: '2026-10-08T20:15:00.000Z' } as const;
const preparedRead = { ...receipt, kind: 'echo-person-diagnostic-result-v1' as const };
const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
const registries: PersonDiagnosticsV1[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
  for (const registry of registries.splice(0)) registry.close();
});
async function origin(input: { diagnostics?: PersonDiagnosticsHttpApplicationV1; ask?: PersonAnswerV5HttpApplication; runs?: PersonTriggerRunsHttpApplicationV1 }) {
  const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
    ...(input.diagnostics === undefined ? {} : { person_diagnostics: input.diagnostics }),
    ...(input.ask === undefined ? {} : { person_answer_v5: input.ask }), ...(input.runs === undefined ? {} : { person_trigger_runs: input.runs }),
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable');
  return `http://127.0.0.1:${address.port}`;
}
const post = (base: string, path: string, body: unknown, token: string | null = 'owner') => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });

function captureFixture() {
  let revoked = false;
  const checked_at = '2026-10-08T20:00:00.000Z';
  const authenticateAccess = vi.fn(({ access_token }: { access_token: string }) => {
    if (access_token !== 'owner' && access_token !== 'other') throw new AuthorityOperationError('unauthorized', 'Session is not valid');
    return { organization_id: 'organization-1', principal_id: `principal-${access_token}`, membership_id: `membership-${access_token}`, session_family_id: `session-${access_token}` };
  });
  const diagnostics = createPersonDiagnosticsV1({ sessions: { authenticateAccess } }); registries.push(diagnostics);
  const note = { kind: 'note', text: 'The PVT fixture is ready.\nManufacturing approved it.', visibility: 'only_me', label: 'PVT fixture readiness', received_at: checked_at, version: '1', ref: `note:ctx_${'a'.repeat(64)}`,
    citation: { kind: 'source_revision', source_id: `source:${'d'.repeat(64)}`, revision_id: 'revision-1', source_sha256: canonicalSha256('source'), representation_sha256: canonicalSha256('representation'), anchor_sha256: canonicalSha256('anchor') },
  };
  const deskAuthorize = vi.fn(() => { if (revoked) throw new AuthorityOperationError('unauthorized', 'Source access revoked'); return { checked_at }; });
  const revalidateDeskRelease = vi.fn(() => { if (revoked) throw new AuthorityOperationError('unauthorized', 'Source access revoked'); return { checked_at }; });
  const originals = {
    deskAuthorize, revalidateDeskRelease,
    deskSearch: vi.fn(() => ({ items: [note], truncated: false, receipt: canonicalSha256('note release'),
      release: { authorization: { principal_id: 'principal-owner', membership_id: 'membership-owner', session_family_id: 'session-owner', checked_at }, scope: { kind: 'mine' }, authorization_revision: 0, released_atoms: [] },
    })),
  };
  const replies: unknown[] = [];
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { results?: { id: string }[] }[]; evidence?: { id: string }[] };
    const id = prompt.last_results?.[0]?.results?.[0]?.id;
    const reply = (input.schema.properties as Record<string, unknown>).sentences !== undefined
      ? { sentences: [{ text: 'The PVT fixture is ready and Manufacturing approved it.', evidence: [prompt.evidence![0]!.id] }], not_found: [] }
      : { parts: [{ question: prompt.question, needs: [{ need: 'PVT fixture readiness', status: id === undefined ? 'open' : 'found', evidence: id === undefined ? [] : [id] }], notes: '' }], actions: id === undefined ? [{ tool: 'search', args: { query: 'PVT fixture' } }] : [{ tool: 'finish', args: {} }] };
    replies.push(reply); return reply;
  });
  const options = {
    authority_id: 'authority-1', organization_id: 'organization-1', state_lineage_id: 'lineage-1', sessions: { authenticateAccess }, diagnostics, originals,
    records: { initializeDesk: () => { throw new PersonRecordSearchIndexLagV1(); } }, model: { generate },
    generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 25_000 },
    audit: { forRequest: () => ({ append: vi.fn() }), forLiveRequest: () => ({ record: async () => canonicalSha256('live release') }) },
  } as unknown as CreatePersonLiveAnswerRouteOptionsV1;
  return { diagnostics, route: createPersonLiveAnswerRouteV1(options, 6), generate, replies, originals, authenticateAccess, revoke() { revoked = true; } };
}

describe('person diagnostics HTTP integration', () => {
  it('requires a bearer and dispatches validated prepare/read operations without starting work', async () => {
    const application = { prepare: vi.fn(async () => receipt), read: vi.fn(async () => preparedRead), close() {} } satisfies PersonDiagnosticsHttpApplicationV1;
    const base = await origin({ diagnostics: application });
    const prepare = { schema_version: 1, operation: 'prepare', target: { kind: 'ask' } };
    const read = { schema_version: 1, operation: 'read', capture_id };
    for (const request of [prepare, read]) expect((await post(base, PERSON_DIAGNOSTICS_PATH_V1, request, null)).status).toBe(401);
    expect(application.prepare).not.toHaveBeenCalled(); expect(application.read).not.toHaveBeenCalled();
    const prepared = await post(base, PERSON_DIAGNOSTICS_PATH_V1, prepare);
    expect(prepared.status).toBe(200); expect(await prepared.json()).toEqual(receipt);
    const response = await post(base, PERSON_DIAGNOSTICS_PATH_V1, read);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(preparedRead);
    expect(application.prepare).toHaveBeenCalledExactlyOnceWith({ access_token: 'owner', request: prepare, signal: expect.any(AbortSignal) });
    expect(application.read).toHaveBeenCalledExactlyOnceWith({ access_token: 'owner', request: read, signal: expect.any(AbortSignal) });
    for (const request of [{ ...read, capture_id: 'cap_guess' }, { ...prepare, principal_id: 'another-person' }, { ...prepare, target: { kind: 'ask', question: 'Not a prepare field' } }]) {
      expect((await post(base, PERSON_DIAGNOSTICS_PATH_V1, request)).status).toBe(400);
    }
    expect(application.prepare).toHaveBeenCalledTimes(1); expect(application.read).toHaveBeenCalledTimes(1);
  });

  it('reserves the diagnostics endpoint against provider route collisions', () => {
    expect(() => createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
      person_tools: { routes: [{ route_id: 'collision', method: 'POST', path: PERSON_DIAGNOSTICS_PATH_V1 }], accept: async () => ({ status: 200, body: {} }) },
    })).toThrow('collides with Authority route');
  });

  it('forwards capture selection on the ordinary Ask and run start routes, rejecting it for retry/view', async () => {
    const ask = vi.fn(async () => ({ schema_version: 6 as const, kind: 'echo-clean-person-answer-v6' as const, scope: { kind: 'global' as const }, outcome: 'not_found' as const, citations: [], parts: [{ question: 'What changed?', status: 'not_found' as const, statements: [], gap: 'No evidence found.' }] }));
    const runs = { list: vi.fn(async () => ({ runs: [] })), start: vi.fn(async () => ({ state: 'running' as const })), retry: vi.fn(), view: vi.fn(),
      home: vi.fn(), items: vi.fn(), item: vi.fn(), send: vi.fn(), set_state: vi.fn(), assign: vi.fn(), close() {} } satisfies PersonTriggerRunsHttpApplicationV1;
    const base = await origin({ ask: { ask }, runs });
    const askRequest = { schema_version: 3, question: 'What changed?', capture_id };
    const startRequest = { schema_version: 1, operation: 'start', run_id, capture_id };
    expect((await post(base, PERSON_ANSWER_PATH_V5, askRequest)).status).toBe(200);
    expect(ask).toHaveBeenCalledExactlyOnceWith({ access_token: 'owner', request: askRequest, signal: expect.any(AbortSignal) });
    expect((await post(base, PERSON_RUNS_PATH_V1, startRequest)).status).toBe(200);
    expect(runs.start).toHaveBeenCalledExactlyOnceWith({ access_token: 'owner', request: startRequest, signal: expect.any(AbortSignal) });
    for (const operation of ['retry', 'view']) expect((await post(base, PERSON_RUNS_PATH_V1, { ...startRequest, operation })).status).toBe(400);
    expect(runs.retry).not.toHaveBeenCalled(); expect(runs.view).not.toHaveBeenCalled();
  });

  it('captures a real ordinary V5 Ask with exact model/tool payloads and fences every authenticated read', async () => {
    const f = captureFixture();
    const base = await origin({ diagnostics: f.diagnostics, ask: f.route });
    const prepare = { schema_version: 1, operation: 'prepare', target: { kind: 'ask' } };
    expect((await post(base, PERSON_DIAGNOSTICS_PATH_V1, prepare, 'invalid')).status).toBe(401);
    const receipt = validatePersonDiagnosticsResultV1('prepare', await (await post(base, PERSON_DIAGNOSTICS_PATH_V1, prepare)).json());
    expect(f.generate).not.toHaveBeenCalled(); expect(f.originals.deskAuthorize).not.toHaveBeenCalled();
    const readRequest = { schema_version: 1, operation: 'read', capture_id: receipt.capture_id };
    const initial = validatePersonDiagnosticsResultV1('read', await (await post(base, PERSON_DIAGNOSTICS_PATH_V1, readRequest)).json());
    expect(initial.status).toBe('prepared'); expect(initial).not.toHaveProperty('trace');
    expect((await post(base, PERSON_DIAGNOSTICS_PATH_V1, readRequest, 'other')).status).toBe(404);
    const answer = await post(base, PERSON_ANSWER_PATH_V5, { schema_version: 3, question: 'Is the PVT fixture ready?', mine: true, capture_id: receipt.capture_id });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ schema_version: 6, outcome: 'answered', parts: [{ statements: [{ text: 'The PVT fixture is ready and Manufacturing approved it.' }] }] });
    const fencesBeforeRead = f.originals.revalidateDeskRelease.mock.calls.length;
    const result = validatePersonDiagnosticsResultV1('read', await (await post(base, PERSON_DIAGNOSTICS_PATH_V1, readRequest)).json());
    expect(result).toMatchObject({ status: 'completed', trace: { complete: true, dropped_events: 0 } });
    expect(f.originals.revalidateDeskRelease.mock.calls.length).toBeGreaterThan(fencesBeforeRead);
    const events = result.trace!.events;
    const modelRequests = events.filter(event => event.kind === 'model_request');
    expect(modelRequests).toHaveLength(f.generate.mock.calls.length);
    for (const [index, event] of modelRequests.entries()) {
      const { signal: _signal, ...exactInput } = f.generate.mock.calls[index]![0];
      expect(event.input).toEqual(exactInput);
    }
    expect(events.filter(event => event.kind === 'model_response').map(event => event.value)).toEqual(f.replies);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_request', tool: 'search', args: { query: 'PVT fixture' } }));
    const searchResult = events.find(event => event.kind === 'tool_response' && event.tool === 'search')!;
    expect(JSON.parse((modelRequests[1]!.input as { user_prompt: string }).user_prompt).last_results).toEqual([searchResult.result]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'lifecycle', stage: 'trigger', event: 'started' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'lifecycle', stage: 'application', event: 'succeeded' }));
    expect((await post(base, PERSON_DIAGNOSTICS_PATH_V1, readRequest, 'other')).status).toBe(404);
    f.revoke();
    const refused = validatePersonDiagnosticsResultV1('read', await (await post(base, PERSON_DIAGNOSTICS_PATH_V1, readRequest)).json());
    expect(refused.status).toBe('failed'); expect(refused).not.toHaveProperty('trace');
    expect((await post(base, PERSON_DIAGNOSTICS_PATH_V1, readRequest)).status).toBe(404);
  });
});
