import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_PATH_V3, PERSON_ANSWER_PATH_V4, PERSON_ANSWER_PATH_V5, PERSON_ANSWER_ROUTE_HEADER_V5,
  PERSON_ASK_PROGRESS_HEADER_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V1,
  createPersonAskProgressDecoderV1, validatePersonAnswerResponseV6,
  type PersonAskProgressEventV1,
} from '@echo-brain/organization-api';
import type { AgenticAskAuditEntryV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';

/**
 * Ask progress over HTTP (ADR-0039): the real V5 route and evidence desk
 * behind the real server, over fake stores and a scripted model. The stream
 * is read end to end with the shared decoder a client uses.
 */

const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
});

const BODY = 'The PVT fixture is ready.\nManufacturing approved it.';
const QUERY = 'pvt fixture';

function fixture(options: { readonly writer?: () => Promise<unknown> } = {}) {
  let revoked = false;
  const checked_at = '2026-10-16T20:00:00.000Z';
  const authenticateAccess = vi.fn(({ access_token }: { access_token: string }) => {
    if (access_token !== 'owner') throw new AuthorityOperationError('unauthorized', 'Session is not valid');
    return { organization_id: 'organization-1', principal_id: 'principal-owner', membership_id: 'membership-owner', session_family_id: 'session-owner' };
  });
  const note = { kind: 'note', text: BODY, visibility: 'only_me', label: 'PVT fixture readiness', received_at: checked_at, version: '1', ref: `note:ctx_${'a'.repeat(64)}`,
    citation: { kind: 'source_revision', source_id: `source:${'d'.repeat(64)}`, revision_id: 'revision-1', source_sha256: canonicalSha256('source'), representation_sha256: canonicalSha256('representation'), anchor_sha256: canonicalSha256('anchor') },
  };
  const check = () => { if (revoked) throw new AuthorityOperationError('unauthorized', 'Source access revoked'); return { checked_at }; };
  const originals = {
    deskAuthorize: vi.fn(check), revalidateDeskRelease: vi.fn(check),
    deskSearch: vi.fn(() => ({ items: [note], truncated: false, receipt: canonicalSha256('note release'),
      release: { authorization: { principal_id: 'principal-owner', membership_id: 'membership-owner', session_family_id: 'session-owner', checked_at }, scope: { kind: 'mine' }, authorization_revision: 0, released_atoms: [] },
    })),
  };
  // Searches once, finishes on what it found, then writes one sentence.
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { results?: string[] }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
      if (options.writer !== undefined) return options.writer();
      return { sentences: [{ text: 'The PVT fixture is ready and Manufacturing approved it.', evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    }
    const id = prompt.last_results?.[0]?.results?.[0];
    return { parts: [{ question: prompt.question, needs: [{ need: 'PVT fixture readiness', status: id === undefined ? 'open' : 'found', evidence: id === undefined ? [] : [id] }], notes: 'private planner note' }],
      actions: id === undefined ? [{ tool: 'search', args: { query: QUERY } }] : [{ tool: 'finish', args: {} }] };
  });
  const audits: AgenticAskAuditEntryV1[] = [];
  const options_ = {
    authority_id: 'authority-1', organization_id: 'organization-1', state_lineage_id: 'lineage-1', sessions: { authenticateAccess }, originals,
    records: { initializeDesk: () => { throw new PersonRecordSearchIndexLagV1(); } }, model: { generate },
    generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 25_000 },
    audit: { forRequest: () => ({ append: (entry: AgenticAskAuditEntryV1) => { audits.push(entry); } }), forLiveRequest: () => ({ record: async () => canonicalSha256('live release') }) },
  } as unknown as CreatePersonLiveAnswerRouteOptionsV1;
  return {
    note, generate, audits, authenticateAccess,
    v5: createPersonLiveAnswerRouteV1(options_, 6), v4: createPersonLiveAnswerRouteV1(options_, 5),
    revokeAtFinalCheck() { originals.revalidateDeskRelease.mockImplementation(() => { if (generate.mock.calls.some(([input]) => (input.schema.properties as Record<string, unknown>).sentences !== undefined)) revoked = true; return check(); }); },
  };
}

async function origin(f: ReturnType<typeof fixture>) {
  const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
    person_answer_v5: f.v5, person_answer_v4: f.v4 });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable');
  return `http://127.0.0.1:${address.port}`;
}
const question = { schema_version: 3, question: 'Is the PVT fixture ready?', mine: true };
const ask = (base: string, input: { readonly path?: string; readonly progress?: string | null; readonly token?: string; readonly body?: unknown; readonly signal?: AbortSignal } = {}) => fetch(`${base}${input.path ?? PERSON_ANSWER_PATH_V5}`, {
  method: 'POST', ...(input.signal === undefined ? {} : { signal: input.signal }),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${input.token ?? 'owner'}`,
    ...(input.progress === null ? {} : { [PERSON_ASK_PROGRESS_HEADER_V1]: input.progress ?? PERSON_ASK_PROGRESS_HEADER_VALUE_V1 }) },
  body: JSON.stringify(input.body ?? question),
});
function decode(text: string): readonly PersonAskProgressEventV1[] {
  const decoder = createPersonAskProgressDecoderV1();
  const events = [...decoder.push(text)];
  decoder.end();
  return events;
}

describe('Ask progress over HTTP', () => {
  it('streams progress, then the released answer with its receipt, as server-sent events when the client opts in', async () => {
    const f = fixture();
    const base = await origin(f);
    const plain = await ask(base, { progress: null });
    expect(plain.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const json = validatePersonAnswerResponseV6(await plain.json());

    const streamed = await ask(base);
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(streamed.headers.get('cache-control')).toBe('no-store');
    expect(streamed.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('5');
    expect(streamed.headers.has('content-length')).toBe(false);
    const raw = await streamed.text();
    // Exactly one data line per event, a blank line after each, and no other field.
    expect(raw.endsWith('\n\n')).toBe(true);
    for (const line of raw.split('\n')) expect(line === '' || line.startsWith('data: ') || line.startsWith(':')).toBe(true);
    const events = decode(raw);
    // The desk cites an original with its display label, exactly as the answer's citations do.
    const named = { citation: { ...f.note.citation, label: f.note.label }, kind: 'note', label: f.note.label, visibility: 'only_me', ref: f.note.ref };
    expect(events.slice(0, -1)).toEqual([
      { type: 'stage', stage: 'searching' },
      { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'documents' }], found: 1 },
      { type: 'stage', stage: 'reading', pending: 1 },
      { type: 'read', items: [expect.objectContaining(named)] },
      { type: 'stage', stage: 'writing' },
      { type: 'stage', stage: 'checking_access' },
    ]);
    const terminal = events.at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    // The answer is byte for byte what the JSON route returns; the receipt lists what was read.
    expect(terminal.response).toEqual(json);
    expect(terminal.receipt).toMatchObject({ looked_through: 1, rows: [{ type: 'searched', found: 1 }, { type: 'read', items: [expect.objectContaining(named)] }] });
    // While it ran, no body, query, planner note or scratchpad id left the Authority.
    const progress = raw.slice(0, raw.lastIndexOf('data: '));
    for (const secret of ['PVT fixture is ready', 'Manufacturing', QUERY, 'private planner note', '"E1"']) expect(progress).not.toContain(secret);
    // One audit record each; only the streamed one names, by citation commitment.
    const readItem = events.find(event => event.type === 'read');
    if (readItem?.type !== 'read') throw new Error('expected a read event');
    expect(f.audits).toHaveLength(2);
    expect(f.audits[0]).not.toHaveProperty('named_citation_digests');
    expect(f.audits[1]).toMatchObject({ outcome: 'answered', named_citation_digests: [canonicalSha256(readItem.items[0]!.citation)] });
  });

  it('keeps JSON for any other header value, for /v4 and /v3, and for failures before the stream starts', async () => {
    const f = fixture();
    const base = await origin(f);
    for (const progress of ['0', 'yes', '11']) {
      const response = await ask(base, { progress });
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      validatePersonAnswerResponseV6(await response.json());
    }
    const v4 = await ask(base, { path: PERSON_ANSWER_PATH_V4 });
    expect(v4.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await v4.json()).toMatchObject({ schema_version: 5 });
    // No V3 application is composed here: the route still answers in JSON.
    expect((await ask(base, { path: PERSON_ANSWER_PATH_V3 })).headers.get('content-type')).toBe('application/json; charset=utf-8');
    const unauthenticated = await ask(base, { token: 'stranger' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(unauthenticated.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('5');
    await expect(unauthenticated.json()).resolves.toEqual({ error: { code: 'unauthorized', message: 'request failed' } });
    const invalid = await ask(base, { body: { schema_version: 3 } });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(f.audits.every(entry => entry.named_citation_digests === undefined)).toBe(true);
  });

  it('ends a stream that already started with one error event carrying the JSON status, and sends no receipt', async () => {
    const f = fixture();
    f.revokeAtFinalCheck();
    const base = await origin(f);
    const response = await ask(base);
    expect(response.status).toBe(200);
    expect(response.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('5');
    const events = decode(await response.text());
    expect(events.at(-1)).toEqual({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'request failed' } });
    expect(events.at(-2)).toEqual({ type: 'stage', stage: 'checking_access' });
    expect(events.some(event => event.type === 'answer')).toBe(false);
    // A refused final check writes no request record.
    expect(f.audits).toEqual([]);
  });

  it('cancels the Ask when the client disconnects mid-stream, and audits what was named on the cancelled witness', async () => {
    let writerStarted!: () => void;
    const started = new Promise<void>(resolve => { writerStarted = resolve; });
    const f = fixture({ writer: () => { writerStarted(); return new Promise<never>(() => undefined); } });
    const base = await origin(f);
    const controller = new AbortController();
    const response = await ask(base, { signal: controller.signal });
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const reader = response.body!.getReader();
    const decoder = createPersonAskProgressDecoderV1();
    const text = new TextDecoder();
    const seen: PersonAskProgressEventV1[] = [];
    while (!seen.some(event => event.type === 'stage' && event.stage === 'writing')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stream ended early');
      seen.push(...decoder.push(text.decode(chunk.value, { stream: true })));
    }
    await started;
    controller.abort();
    await vi.waitFor(() => expect(f.audits).toHaveLength(1));
    const readItem = seen.find(event => event.type === 'read');
    if (readItem?.type !== 'read') throw new Error('expected a read event');
    expect(f.audits[0]).toMatchObject({ outcome: 'cancelled', named_citation_digests: [canonicalSha256(readItem.items[0]!.citation)], response_sha256: null });
    // The writer was the last model call; nothing ran after the disconnect.
    expect(f.generate).toHaveBeenCalledTimes(3);
  });
});
