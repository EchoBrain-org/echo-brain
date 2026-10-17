import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_ROUTE_HEADER_V5,
  PERSON_ASK_PROGRESS_HEADER_V1,
  PERSON_ASK_PROGRESS_HEARTBEAT_V1,
  PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1,
  formatPersonAskProgressEventV1,
  type OrganizationPersonSessionV2,
  type PersonAnswerScopeV3,
  type PersonAskProgressEventV1,
  type PersonAskProgressStepEventV1,
} from '@echo-brain/organization-api';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { PersonClient } from '../../src/product/person-client/client.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

// Ask progress V1 (ADR-0039) on the Person client: the opt-in stream and its fallbacks.

const ORIGIN = 'https://authority.example.test';
const NOW = '2026-10-16T10:00:00.000Z';
const SESSION: OrganizationPersonSessionV2 = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  display_name: 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
  access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-10-16T10:10:00.000Z', refresh_expires_at: '2026-10-23T10:00:00.000Z', hard_reauthentication_at: '2026-10-23T10:00:00.000Z',
};

const record = canonicalSha256('record');
// Non-ASCII labels put multi-byte characters across chunk boundaries.
const decision = { citation: { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'THERM DVT recovery sync — café', visibility: 'team' as const, ref: `meeting:${record}` as const };
const ticket = { citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10048', permalink: 'https://example.atlassian.net/browse/THERM-48', text_sha256: canonicalSha256('THERM-48') }, kind: 'ticket' as const, label: 'THERM-48: Fan curve ✓', visibility: 'only_me' as const };
const answer = (scope: PersonAnswerScopeV3 = { kind: 'global' }) => ({ schema_version: 6 as const, kind: 'echo-clean-person-answer-v6' as const, scope, outcome: 'answered' as const, citations: [decision], parts: [{ question: 'What did we decide?', status: 'answered' as const, statements: [{ text: 'The team chose the recovery plan.', citation_indexes: [0], private: false }] }] });
const v5Answer = () => ({ ...answer(), schema_version: 5 as const, kind: 'echo-clean-person-answer-v5' as const });
const receipt = () => ({ looked_through: 3, elapsed_ms: 48_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, { kind: 'tickets' as const, tool_id: 'jira' }], found: 22 }, { type: 'read' as const, items: [decision, ticket] }] });
const STEPS: readonly PersonAskProgressStepEventV1[] = [
  { type: 'stage', stage: 'searching' },
  { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'tickets', tool_id: 'jira' }], found: 22 },
  { type: 'stage', stage: 'reading', pending: 2 },
  { type: 'read', items: [decision, ticket] },
  { type: 'stage', stage: 'checking_access' },
  { type: 'stage', stage: 'writing' },
];
const ANSWERED: PersonAskProgressEventV1 = { type: 'answer', response: answer(), receipt: receipt() };
const frames = (events: readonly PersonAskProgressEventV1[]) => events.map(event => formatPersonAskProgressEventV1(event)).join('');
/** Every step with heartbeats between some of them, then the answer. */
const STREAM = `${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${frames(STEPS.slice(0, 2))}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${frames(STEPS.slice(2))}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${frames([ANSWERED])}`;

const encoder = new TextEncoder();
const STREAM_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', [PERSON_ANSWER_ROUTE_HEADER_V5]: '5' };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A finished stream delivered in chunks of `size` bytes. */
function sse(body: string | Uint8Array, size = Number.MAX_SAFE_INTEGER, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  }), { status: init.status ?? 200, headers: { ...STREAM_HEADERS, ...init.headers } });
}

/** A stream the test writes while the client reads; `cancelled` says whether the client dropped the connection. */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { state.cancelled = true; },
  }), { status: 200, headers: STREAM_HEADERS });
  return {
    response, state,
    write(text: string) { controller.enqueue(encoder.encode(text)); },
    close() { controller.close(); },
  };
}

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function sessionHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-ask-progress-'))); homes.push(home);
  new PersonSessionStore(home).install(ORIGIN, 'oau_00000000-0000-4000-8000-000000000001', SESSION);
  return home;
}
const authority = (fetch: typeof globalThis.fetch) => new PersonAuthorityClient({ authority_origin: ORIGIN, fetch });
const pathOf = (input: unknown) => new URL(String(input)).pathname;
const headersOf = (init: RequestInit | undefined) => new Headers(init?.headers);


describe('Ask progress stream on the Person client (ADR-0039)', () => {
  it('opts in on V5 and reads every event across any chunking, heartbeats included', async () => {
    const bytes = encoder.encode(STREAM);
    for (const size of [1, 2, 3, 5, 64, 1000, bytes.length]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(bytes, size));
      const progress: PersonAskProgressStepEventV1[] = [];
      const result = await authority(fetch).askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event));
      expect(result).toEqual({ result: answer(), receipt: receipt() });
      expect(Object.isFrozen(result)).toBe(true);
      expect(progress).toEqual(STEPS);
      const [url, init] = fetch.mock.calls[0]!;
      expect(pathOf(url)).toBe('/v5/person/ask');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ schema_version: 3, question: 'What did we decide?' });
      const headers = headersOf(init);
      expect(headers.get(PERSON_ASK_PROGRESS_HEADER_V1)).toBe('1');
      expect(headers.get('accept')).toBe('text/event-stream, application/json');
      expect(headers.get('authorization')).toBe('Bearer bearer');
      expect(headers.get('x-echo-time-zone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
  });

  it('hands each step on as it arrives, before the stream has ended', async () => {
    const stream = openStream();
    const progress: PersonAskProgressStepEventV1[] = [];
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response))
      .askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 1)));
    await vi.waitFor(() => expect(progress).toEqual(STEPS.slice(0, 1)));
    stream.write(`${frames(STEPS.slice(1, 3))}${frames(STEPS.slice(3)).slice(0, 40)}`);
    await vi.waitFor(() => expect(progress).toEqual(STEPS.slice(0, 3)));
    stream.write(`${frames(STEPS.slice(3)).slice(40)}${frames([ANSWERED])}`);
    stream.close();
    await expect(pending).resolves.toEqual({ result: answer(), receipt: receipt() });
    expect(progress).toEqual(STEPS);
  });

  it.each([
    ['another SSE field', 'event: stage\n\n'],
    ['a second data line in one event', 'data: {"type":"stage","stage":"searching"}\ndata: {}\n\n'],
    ['a carriage return', 'data: {"type":"stage","stage":"searching"}\r\n\r\n'],
    ['an event that is not JSON', 'data: not json\n\n'],
    ['an event outside the contract', 'data: {"type":"stage","stage":"searching","notes":"Mara owns THERM-48"}\n\n'],
    ['a planner round', 'data: {"type":"round","round":2}\n\n'],
    ['a step after the answer', `${frames([ANSWERED])}${frames(STEPS.slice(0, 1))}`],
    ['a heartbeat after the answer', `${frames([ANSWERED])}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}`],
    ['two answers', frames([ANSWERED, ANSWERED])],
    ['an end without the result', frames(STEPS)],
    ['an end inside an event', `${frames(STEPS)}data: {"type":"stage"`],
  ])('fails closed on %s with invalid_response', async (_name, body) => {
    await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(body)))
      .askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined))
      .rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'invalid_response', status: 200 });
  });

  it('fails closed on invalid UTF-8, including a character the stream cuts short', async () => {
    const valid = encoder.encode(frames(STEPS.slice(0, 1)));
    for (const bytes of [Uint8Array.from([...valid, 0x64, 0x61, 0xff, 0x0a]), Uint8Array.from([...encoder.encode(frames([ANSWERED])), 0xe2, 0x80])]) {
      await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(bytes, 3)))
        .askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('drops the connection on a malformed event while the Authority is still writing, and names nothing after it', async () => {
    const stream = openStream();
    const progress: PersonAskProgressStepEventV1[] = [];
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response))
      .askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 1)));
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    stream.write('data: {"type":"read","items":[{"id":"E5"}]}\n\n');
    await expect(pending).rejects.toMatchObject({ code: 'invalid_response' });
    expect(stream.state.cancelled).toBe(true);
    expect(progress).toEqual(STEPS.slice(0, 1));
  });

  it('accepts a stream only as the V5 route\'s 200', async () => {
    const unmarked = new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    for (const response of [sse(STREAM, undefined, { status: 503 }), sse(STREAM, undefined, { status: 404 }), unmarked]) {
      const progress: PersonAskProgressStepEventV1[] = [];
      await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response))
        .askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event))).rejects.toMatchObject({ code: 'invalid_response' });
      expect(progress).toEqual([]);
    }
  });

  it('stops reading past the whole-stream bound', async () => {
    const stream = openStream();
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response))
      .askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined);
    // Comment lines stay under the line bound, so only the stream bound can stop them.
    const comment = `: ${'x'.repeat(100 * 1024)}\n`;
    for (let written = 0; written <= PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1; written += comment.length) stream.write(comment);
    await expect(pending).rejects.toMatchObject({ code: 'response_too_large', status: 200 });
    expect(stream.state.cancelled).toBe(true);
  });

  it('refuses a streamed answer for another scope', async () => {
    const project = 'prj_00000000-0000-4000-8000-000000000019' as const;
    await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(frames([{ type: 'answer', response: answer(), receipt: receipt() }]))))
      .askV5WithProgress('bearer', 'What did we decide?', project, undefined, () => undefined)).rejects.toMatchObject({ code: 'invalid_response' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(frames([{ type: 'answer', response: answer({ kind: 'project', project_id: project }), receipt: receipt() }])));
    await expect(authority(fetch).askV5WithProgress('bearer', 'What did we decide?', project, undefined, () => undefined))
      .resolves.toMatchObject({ result: { scope: { kind: 'project', project_id: project } } });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ schema_version: 3, question: 'What did we decide?', project_id: project });
  });

  it('turns an error inside the stream into the error its JSON response would have been, never a V4 fallback', async () => {
    for (const [status, code] of [[404, 'not_found'], [503, 'unavailable'], [401, 'unauthorized']] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(`${frames(STEPS.slice(0, 2))}${frames([{ type: 'error', status, error: { code, message: 'request failed' } }])}`));
      const progress: PersonAskProgressStepEventV1[] = [];
      await expect(new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch }).askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event)))
        .rejects.toMatchObject({ name: 'PersonAuthorityClientError', code, status, routeMatched: true });
      expect(progress).toEqual(STEPS.slice(0, 2));
      expect(fetch.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v5/person/ask']);
    }
  });

  it('answers from an Authority that does not stream with its JSON, without progress or a receipt', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answer(), 200, { [PERSON_ANSWER_ROUTE_HEADER_V5]: '5' }));
    const progress: PersonAskProgressStepEventV1[] = [];
    const result = await new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch }).askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event));
    expect(result).toEqual({ result: answer() });
    expect('receipt' in result).toBe(false);
    expect(progress).toEqual([]);
    // A JSON body is still bound to today's validator and scope.
    for (const body of [{ ...answer(), receipt: receipt() }, answer({ kind: 'mine' })]) {
      await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(body))).askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined))
        .rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('falls back to V4 without progress only for an Authority with no V5 route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'route absent' } }, 404))
      .mockResolvedValueOnce(json(v5Answer()));
    const progress: PersonAskProgressStepEventV1[] = [];
    await expect(new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch }).askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event)))
      .resolves.toEqual({ result: v5Answer() });
    expect(fetch.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v5/person/ask', '/v4/person/ask']);
    expect(headersOf(fetch.mock.calls[1]![1]).has(PERSON_ASK_PROGRESS_HEADER_V1)).toBe(false);
    expect(progress).toEqual([]);
    // A JSON failure from the V5 route itself, before any stream, never falls back.
    for (const [status, code, headers] of [[404, 'not_found', { [PERSON_ANSWER_ROUTE_HEADER_V5]: '5' }], [401, 'unauthorized', {}]] as const) {
      const refused = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code, message: 'request failed' } }, status, headers));
      await expect(new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch: refused }).askWithLiveProgress('What did we decide?', undefined, undefined, () => undefined))
        .rejects.toMatchObject({ code, status });
      expect(refused).toHaveBeenCalledTimes(1);
    }
  });

  it('cancels the stream when the caller aborts, and hands on nothing after', async () => {
    const stream = openStream();
    const caller = new AbortController();
    const progress: PersonAskProgressStepEventV1[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response);
    const pending = authority(fetch).askV5WithProgress('bearer', 'What did we decide?', undefined, caller.signal, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 2)));
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'transport_failed', status: null });
    expect(stream.state.cancelled).toBe(true);
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(progress).toEqual(STEPS.slice(0, 2));
  });

  it('reads a real streamed response to its answer', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, STREAM_HEADERS);
      const bytes = encoder.encode(STREAM);
      // Uneven writes split frames and characters on the wire.
      for (let at = 0; at < bytes.length; at += 997) response.write(bytes.slice(at, at + 997));
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const progress: PersonAskProgressStepEventV1[] = [];
      await expect(new PersonAuthorityClient({ authority_origin: `http://127.0.0.1:${port}`, allow_insecure_loopback: true })
        .askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event))).resolves.toEqual({ result: answer(), receipt: receipt() });
      expect(progress).toEqual(STEPS);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('reads a real streamed response as it is written, and a caller abort disconnects the Authority', async () => {
    const seen: { header?: string | undefined; closed: boolean } = { closed: false };
    let wrote!: (text: string) => void;
    const server = createServer((request, response) => {
      seen.header = request.headers[PERSON_ASK_PROGRESS_HEADER_V1] as string | undefined;
      response.writeHead(200, STREAM_HEADERS);
      response.on('close', () => { seen.closed = !response.writableEnded; });
      wrote = text => { response.write(text); };
      wrote(`${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${frames(STEPS.slice(0, 1))}`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new PersonAuthorityClient({ authority_origin: `http://127.0.0.1:${port}`, allow_insecure_loopback: true });
      const caller = new AbortController();
      const progress: PersonAskProgressStepEventV1[] = [];
      const pending = client.askV5WithProgress('bearer', 'What did we decide?', undefined, caller.signal, event => progress.push(event));
      await vi.waitFor(() => expect(progress).toEqual(STEPS.slice(0, 1)));
      expect(seen.header).toBe('1');
      wrote(frames(STEPS.slice(1, 2)));
      await vi.waitFor(() => expect(progress).toEqual(STEPS.slice(0, 2)));
      caller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'transport_failed' });
      await vi.waitFor(() => expect(seen.closed).toBe(true));
      expect(progress).toEqual(STEPS.slice(0, 2));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('reads nothing from a stream whose caller cancelled before its headers arrived', async () => {
    const stream = openStream();
    const caller = new AbortController();
    const progress: PersonAskProgressStepEventV1[] = [];
    // The mock answers despite the abort, as a response already in flight would.
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => { caller.abort(); return stream.response; });
    await expect(authority(fetch).askV5WithProgress('bearer', 'What did we decide?', undefined, caller.signal, event => progress.push(event)))
      .rejects.toMatchObject({ code: 'transport_failed' });
    expect(stream.state.cancelled).toBe(true);
    expect(progress).toEqual([]);
  });

  it('bounds the whole stream by the ask timeout', async () => {
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const stream = openStream();
    const progress: PersonAskProgressStepEventV1[] = [];
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response))
      .askV5WithProgress('bearer', 'What did we decide?', undefined, new AbortController().signal, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 1)));
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    timeout.abort();
    await expect(pending).rejects.toMatchObject({ code: 'transport_failed' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(135_000);
    expect(stream.state.cancelled).toBe(true);
  });

  it('a body read that fails mid-stream is a transport failure', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { status: 200, headers: STREAM_HEADERS });
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response)).askV5WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined);
    controller.error(new TypeError('terminated'));
    await expect(pending).rejects.toMatchObject({ code: 'transport_failed' });
  });

  it('stops handing on steps once another account is signed in, and drops the stream', async () => {
    const home = sessionHome();
    const stream = openStream();
    const progress: PersonAskProgressStepEventV1[] = [];
    const pending = new PersonClient({ home_directory: home, now: () => NOW, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response) })
      .askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 1)));
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    new PersonSessionStore(home).install(ORIGIN, 'oau_00000000-0000-4000-8000-000000000001', { ...SESSION, membership_id: 'mem_00000000-0000-4000-8000-000000000002' });
    stream.write(frames(STEPS.slice(1, 2)));
    await expect(pending).rejects.toThrow('did not match the current account');
    expect(stream.state.cancelled).toBe(true);
    expect(progress).toEqual(STEPS.slice(0, 1));
  });

  it('withholds a step that arrives while another command refreshes the session, and keeps the Ask', async () => {
    const home = sessionHome();
    const store = new PersonSessionStore(home);
    const stream = openStream();
    const progress: PersonAskProgressStepEventV1[] = [];
    const pending = new PersonClient({ home_directory: home, now: () => NOW, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response) })
      .askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 1)));
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    // A refresh sets the live session aside until it completes.
    const claim = store.claimRefresh();
    const read = vi.spyOn(PersonSessionStore.prototype, 'read');
    stream.write(frames(STEPS.slice(1, 2)));
    await vi.waitFor(() => expect(read.mock.results.some(result => result.type === 'throw')).toBe(true));
    store.completeRefresh(claim, { ...SESSION, access_token: 'B'.repeat(43), refresh_token: 'S'.repeat(43), access_expires_at: '2026-10-16T10:20:00.000Z' });
    stream.write(`${frames(STEPS.slice(2))}${frames([ANSWERED])}`);
    stream.close();
    await expect(pending).resolves.toEqual({ result: answer(), receipt: receipt() });
    expect(progress).toEqual([STEPS[0], ...STEPS.slice(2)]);
  });
});
