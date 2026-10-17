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
import { PersonRecordSearchIndexLagV1, PersonRecordSearchSnapshotChangedV1 } from '../src/composition/person-record-search-route.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import type { CoreRuntimeObservationV1, CoreRuntimeObserverV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';

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

function fixture(options: { readonly writer?: (attempt: number, written: () => unknown) => Promise<unknown> } = {}) {
  let revoked = false;
  const checked_at = '2026-10-16T20:00:00.000Z';
  const authenticateAccess = vi.fn(({ access_token }: { access_token: string }) => {
    if (access_token !== 'owner') throw new AuthorityOperationError('unauthorized', 'Session is not valid');
    return { organization_id: 'organization-1', principal_id: 'principal-owner', membership_id: 'membership-owner', session_family_id: 'session-owner' };
  });
  const note = { kind: 'note', text: BODY, visibility: 'only_me', label: 'PVT fixture readiness', received_at: checked_at, version: '1', ref: `note:ctx_${'a'.repeat(64)}`,
    citation: { kind: 'source_revision', source_id: `source:${'d'.repeat(64)}`, revision_id: 'revision-1', source_sha256: canonicalSha256('source'), representation_sha256: canonicalSha256('representation'), anchor_sha256: canonicalSha256('anchor') },
  };
  // A second note the search finds once the record snapshot has advanced (a restarted Ask's second attempt).
  const later = { ...note, label: 'PVT sign-off', ref: `note:ctx_${'b'.repeat(64)}`, citation: { ...note.citation, source_id: `source:${'e'.repeat(64)}`, anchor_sha256: canonicalSha256('later anchor') } };
  let attempt = 0;
  let restartAt: number | undefined;
  const check = () => { if (revoked) throw new AuthorityOperationError('unauthorized', 'Source access revoked'); return { checked_at }; };
  // The access check that re-reads a release for the `restartAt`th time sees the record snapshot advance, once.
  const revalidate = () => {
    if (restartAt !== undefined && --restartAt === 0) { attempt = 1; throw new PersonRecordSearchSnapshotChangedV1(); }
    return check();
  };
  const originals = {
    deskAuthorize: vi.fn(check), revalidateDeskRelease: vi.fn(revalidate),
    deskSearch: vi.fn(() => ({ items: attempt === 0 ? [note] : [note, later], truncated: false, receipt: canonicalSha256('note release'),
      release: { authorization: { principal_id: 'principal-owner', membership_id: 'membership-owner', session_family_id: 'session-owner', checked_at }, scope: { kind: 'mine' }, authorization_revision: 0, released_atoms: [] },
    })),
  };
  // Searches once, finishes on what it found, then writes one sentence.
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    const prompt = JSON.parse(input.user_prompt) as { question: string; last_results?: { results?: string[] }[]; evidence?: { id: string }[] };
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
      const written = () => ({ sentences: [{ text: 'The PVT fixture is ready and Manufacturing approved it.', evidence: [prompt.evidence![0]!.id] }], not_found: [] });
      return options.writer === undefined ? written() : options.writer(attempt, written);
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
    note, later, generate, audits, authenticateAccess,
    /** The `call`th release re-read by an access check sees the record snapshot advance, and the Ask restarts. */
    restartAtCheck(call: number) { restartAt = call; },
    v5: createPersonLiveAnswerRouteV1(options_, 6), v4: createPersonLiveAnswerRouteV1(options_, 5),
    /** Access is revoked once `writers` answer writers have run, so that attempt's final check refuses it. */
    revokeAtFinalCheck(writers = 1) { originals.revalidateDeskRelease.mockImplementation(() => { if (generate.mock.calls.filter(([input]) => (input.schema.properties as Record<string, unknown>).sentences !== undefined).length >= writers) revoked = true; return revalidate(); }); },
  };
}

async function origin(f: ReturnType<typeof fixture>, observer?: CoreRuntimeObserverV1) {
  const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
    person_answer_v5: f.v5, person_answer_v4: f.v4, ...(observer === undefined ? {} : { core_runtime_observation: { observer } }) });
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
    const observed: CoreRuntimeObservationV1[] = [];
    const base = await origin(f, event => { observed.push(event); });
    const response = await ask(base);
    expect(response.status).toBe(200);
    expect(response.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('5');
    const events = decode(await response.text());
    expect(events.at(-1)).toEqual({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'request failed' } });
    expect(events.at(-2)).toEqual({ type: 'stage', stage: 'checking_access' });
    expect(events.some(event => event.type === 'answer')).toBe(false);
    // A refused final check writes no request record.
    expect(f.audits).toEqual([]);
    // The request's span records the status the error event carries, as the JSON route's failure would: the wire's 200 says nothing.
    await vi.waitFor(() => expect(observed.filter(event => event.phase === 'http_request' && event.event !== 'started').map(event => event.counts.http_status)).toEqual([401]));
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

describe('Ask progress across a restarted Ask', () => {
  /** The first attempt's audit record is written; the check after it sees the record snapshot advance. */
  const AFTER_AUDIT = 4;
  /** The check before the first attempt's writer, after it named the note: it stops before any audit write. */
  const BEFORE_WRITER = 2;
  const sources = [{ kind: 'meetings' }, { kind: 'documents' }];
  const named = (item: ReturnType<typeof fixture>['note']) => expect.objectContaining({ citation: { ...item.citation, label: item.label }, kind: 'note', label: item.label, visibility: 'only_me', ref: item.ref });
  const digestOf = (item: ReturnType<typeof fixture>['note']) => canonicalSha256({ ...item.citation, label: item.label });
  /** The restarted attempt finds the note again and a later one: it names only the later one. */
  const restarted = [
    { type: 'stage', stage: 'searching' },
    { type: 'searched', sources, found: 2 },
    { type: 'stage', stage: 'reading', pending: 1 },
  ] as const;

  it('keeps one stream across both attempts, names each item once, and audits each name in the record of the attempt that sent it', async () => {
    const f = fixture();
    f.restartAtCheck(AFTER_AUDIT);
    const events = decode(await (await ask(await origin(f))).text());
    expect(events.slice(0, -1)).toEqual([
      { type: 'stage', stage: 'searching' },
      { type: 'searched', sources, found: 1 },
      { type: 'stage', stage: 'reading', pending: 1 },
      { type: 'read', items: [named(f.note)] },
      { type: 'stage', stage: 'writing' },
      { type: 'stage', stage: 'checking_access' },
      ...restarted,
      { type: 'read', items: [named(f.later)] },
      { type: 'stage', stage: 'writing' },
      { type: 'stage', stage: 'checking_access' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'answer' });
    // The first attempt's record, written before its snapshot advanced, holds its name; the released attempt's holds only its own.
    expect(f.audits).toEqual([
      expect.objectContaining({ outcome: 'answered', named_citation_digests: [digestOf(f.note)] }),
      expect.objectContaining({ outcome: 'answered', named_citation_digests: [digestOf(f.later)] }),
    ]);
    expect(f.generate).toHaveBeenCalledTimes(6);
  });

  it("sends only the released attempt's receipt: what it read, the names it sent, and the time since the request started", async () => {
    // The first attempt's writer takes a while; the second attempt alone is far quicker.
    const f = fixture({ writer: async (attempt, written) => { if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250)); return written(); } });
    f.restartAtCheck(AFTER_AUDIT);
    const terminal = decode(await (await ask(await origin(f))).text()).at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    // It read the note again, so it counts it, but the first attempt named it.
    expect(terminal.receipt).toMatchObject({ looked_through: 2, rows: [{ type: 'searched', sources, found: 2 }, { type: 'read', items: [named(f.later)] }] });
    expect(terminal.receipt.rows).toHaveLength(2);
    expect(terminal.receipt.elapsed_ms).toBeGreaterThanOrEqual(250);
  });

  it('ends a restarted Ask whose final attempt is refused with one error event and no receipt', async () => {
    const f = fixture();
    f.restartAtCheck(AFTER_AUDIT);
    f.revokeAtFinalCheck(2);
    const events = decode(await (await ask(await origin(f))).text());
    expect(events.at(-1)).toEqual({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'request failed' } });
    expect(events.at(-2)).toEqual({ type: 'stage', stage: 'checking_access' });
    expect(events.filter(event => event.type === 'read')).toEqual([{ type: 'read', items: [named(f.note)] }, { type: 'read', items: [named(f.later)] }]);
    expect(events.some(event => event.type === 'answer')).toBe(false);
    // The refused attempt writes no request record; the first attempt's record stands.
    expect(f.audits).toEqual([expect.objectContaining({ outcome: 'answered', named_citation_digests: [digestOf(f.note)] })]);
  });

  it('writes no request record for an attempt stopped before its audit write, and still never names its items again', async () => {
    const f = fixture();
    f.restartAtCheck(BEFORE_WRITER);
    const events = decode(await (await ask(await origin(f))).text());
    expect(events.slice(0, -1)).toEqual([
      { type: 'stage', stage: 'searching' },
      { type: 'searched', sources, found: 1 },
      { type: 'stage', stage: 'reading', pending: 1 },
      { type: 'read', items: [named(f.note)] },
      { type: 'stage', stage: 'writing' },
      ...restarted,
      { type: 'read', items: [named(f.later)] },
      { type: 'stage', stage: 'writing' },
      { type: 'stage', stage: 'checking_access' },
    ]);
    // Like any failed run (ADR-0039), the stopped attempt leaves its name to the desk's release audit.
    expect(f.audits).toEqual([expect.objectContaining({ outcome: 'answered', named_citation_digests: [digestOf(f.later)] })]);
  });
});
