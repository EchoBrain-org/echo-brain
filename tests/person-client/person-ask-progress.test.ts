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
  formatPersonAskProgressEventV3,
  validatePersonAskProgressLineV3,
  validatePersonAskProgressResultLineV3,
  type OrganizationPersonSessionV2,
  type PersonAnswerScopeV3,
  type PersonAskProgressEventV3,
  type PersonAskProgressStepEventV3,
} from '@echo-brain/organization-api';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { PersonClient } from '../../src/product/person-client/client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

// Ask progress (ADR-0039) on the Person client: V3 on /v7 (research tool contract v1), the one Ask route, its opt-in
// stream, and `person ask --progress`.

const ORIGIN = 'https://authority.example.test';
const NOW = '2026-10-16T10:00:00.000Z';
const SESSION: OrganizationPersonSessionV2 = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  display_name: 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
  access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-10-16T10:10:00.000Z', refresh_expires_at: '2026-10-23T10:00:00.000Z', hard_reauthentication_at: '2026-10-23T10:00:00.000Z',
};

const record = canonicalSha256('record');
// Non-ASCII labels put multi-byte characters across chunk boundaries.
const decision = { citation: { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: record, policy_id: 'project-members-readable-person-v1' as const }, kind: 'decision' as const, label: 'THERM DVT recovery sync — café', visibility: 'team' as const, ref: `meeting:${record}` as const };
const ticket = { citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10048', permalink: 'https://example.atlassian.net/browse/THERM-48', text_sha256: canonicalSha256('THERM-48') }, kind: 'ticket' as const, label: 'THERM-48: Fan curve ✓', visibility: 'only_me' as const };
const answer = (scope: PersonAnswerScopeV3 = { kind: 'global' }) => ({ schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope, outcome: 'answered' as const, citations: [decision], parts: [{ question: 'What did we decide?', status: 'answered' as const, statements: [{ text: 'The team chose the recovery plan.', citation_indexes: [0], private: false }] }] });
const receipt = () => ({ looked_through: 3, elapsed_ms: 48_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, { kind: 'tickets' as const, tool_id: 'jira' }], found: 22 }, { type: 'read' as const, items: [decision, ticket] }] });
const STEPS: readonly PersonAskProgressStepEventV3[] = [
  { type: 'stage', stage: 'searching' },
  { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'tickets', tool_id: 'jira' }], found: 22 },
  { type: 'stage', stage: 'reading', pending: 2 },
  { type: 'read', items: [decision, ticket] },
  { type: 'stage', stage: 'checking_access' },
  { type: 'stage', stage: 'writing' },
];
const ANSWERED: PersonAskProgressEventV3 = { type: 'answer', response: answer(), receipt: receipt() };
const frames = (events: readonly PersonAskProgressEventV3[]) => events.map(event => formatPersonAskProgressEventV3(event)).join('');
/** Every step with heartbeats between some of them, then the answer. */
const STREAM = `${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${frames(STEPS.slice(0, 2))}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${frames(STEPS.slice(2))}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${frames([ANSWERED])}`;

// A follow-up (ADR-0040), as an answer cites it.
const followUp = { citation: { kind: 'follow_up' as const, item_id: 'itm_launch-1' }, kind: 'follow_up' as const, label: 'Ship the launch checklist', visibility: 'team' as const, ref: 'follow_up:itm_launch-1' as const };

// A workspace stream: the V8 answer, whose search names the asker's projects and Jira's containers, and whose read names a
// project and a Jira project with its key.
const projectId = 'prj_00000000-0000-4000-8000-000000000021' as const;
const project = { citation: { kind: 'project' as const, project_id: projectId }, kind: 'project' as const, label: 'Thermal recovery', visibility: 'project' as const, ref: `project:${projectId}` as const };
const container = {
  citation: { kind: 'tool_container' as const, tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project' as const, container_id: '10001', permalink: 'https://example.atlassian.net/browse/THERM' },
  kind: 'tool_container' as const, label: 'Thermal — DVT ✓', visibility: 'only_me' as const, key: 'THERM',
};
const answerV8 = (scope: PersonAnswerScopeV3 = { kind: 'global' }) => ({ schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope, outcome: 'answered' as const, citations: [project, container, followUp],
  parts: [{ question: 'Where is Thermal recovery tracked?', status: 'answered' as const, statements: [{ text: 'Thermal recovery is tracked in the THERM Jira project.', citation_indexes: [0, 1], private: true }] }] });
const receiptV3 = () => ({ looked_through: 2, elapsed_ms: 24_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'projects' as const }, { kind: 'containers' as const, tool_id: 'jira' }], found: 5 }, { type: 'read' as const, items: [project, container] }] });
const STEPS_V3: readonly PersonAskProgressStepEventV3[] = [
  { type: 'stage', stage: 'searching' },
  { type: 'searched', sources: [{ kind: 'projects' }, { kind: 'containers', tool_id: 'jira' }], found: 5 },
  { type: 'stage', stage: 'reading', pending: 2 },
  { type: 'read', items: [project, container] },
  { type: 'stage', stage: 'writing' },
  { type: 'stage', stage: 'checking_access' },
];
const ANSWERED_V3: PersonAskProgressEventV3 = { type: 'answer', response: answerV8(), receipt: receiptV3() };
const framesV3 = (events: readonly PersonAskProgressEventV3[]) => events.map(event => formatPersonAskProgressEventV3(event)).join('');
const STREAM_V3 = `${framesV3(STEPS_V3.slice(0, 2))}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}${framesV3(STEPS_V3.slice(2))}${framesV3([ANSWERED_V3])}`;

// A Mine Ask's stream, in any version: only what the asker added, so meetings and documents, and never a live tool, a
// follow-up or the workspace.
const SEARCHED_MINE = { type: 'searched' as const, sources: [{ kind: 'meetings' as const }, { kind: 'documents' as const }], found: 1 };
const READ_MINE = { type: 'read' as const, items: [decision] };
const STEPS_MINE: readonly PersonAskProgressStepEventV3[] = [
  { type: 'stage', stage: 'searching' }, SEARCHED_MINE, { type: 'stage', stage: 'reading', pending: 1 }, READ_MINE,
  { type: 'stage', stage: 'writing' }, { type: 'stage', stage: 'checking_access' },
];
const receiptMine = () => ({ looked_through: 1, elapsed_ms: 12_000, rows: [SEARCHED_MINE, READ_MINE] });
const answerMineV8 = () => answer({ kind: 'mine' });

const encoder = new TextEncoder();
const STREAM_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', [PERSON_ANSWER_ROUTE_HEADER_V5]: '7' };
const V7_HEADERS = { [PERSON_ANSWER_ROUTE_HEADER_V5]: '7' };
/** An Authority with no /v7: a 404 without the route header. */
const noRoute = () => json({ error: { code: 'not_found', message: 'route absent' } }, 404);
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
function openStream(headers: Record<string, string> = STREAM_HEADERS) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { state.cancelled = true; },
  }), { status: 200, headers });
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

function cli(home: string, fetch: typeof globalThis.fetch, abort_signal?: AbortSignal) {
  const output = { stdout: '', stderr: '' };
  const run = (argv: readonly string[]) => runPersonClientCli(argv, {
    home_directory: home, now: () => NOW, fetch, ...(abort_signal === undefined ? {} : { abort_signal }),
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } },
  });
  return { output, run };
}
const lines = (text: string) => text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as unknown);

describe('Ask progress stream on the Person client (ADR-0039)', () => {
  it('opts in on /v7 and reads every event across any chunking, heartbeats included', async () => {
    const bytes = encoder.encode(STREAM);
    for (const size of [1, 2, 3, 5, 64, 1000, bytes.length]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(bytes, size));
      const progress: PersonAskProgressStepEventV3[] = [];
      const result = await authority(fetch).askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event));
      expect(result).toEqual({ result: answer(), receipt: receipt() });
      expect(Object.isFrozen(result)).toBe(true);
      expect(progress).toEqual(STEPS);
      const [url, init] = fetch.mock.calls[0]!;
      expect(pathOf(url)).toBe('/v7/person/ask');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ schema_version: 3, question: 'What did we decide?' });
      const headers = headersOf(init);
      expect(headers.get(PERSON_ASK_PROGRESS_HEADER_V1)).toBe('3');
      expect(headers.get('accept')).toBe('text/event-stream, application/json');
      expect(headers.get('authorization')).toBe('Bearer bearer');
      expect(headers.get('x-echo-time-zone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(headers.get('x-echo-answer-layout')).toBe('1');
    }
  });

  // The decoder's own rules are the shared codec's (person-ask-progress-v3.test.ts in packages/organization-api).
  it.each([
    ['an event outside the contract', 'data: {"type":"stage","stage":"searching","notes":"Mara owns THERM-48"}\n\n'],
    ['a step after the answer', `${frames([ANSWERED])}${frames(STEPS.slice(0, 1))}`],
    ['an end without the result', frames(STEPS)],
  ])('fails closed on %s with invalid_response', async (_name, body) => {
    await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(body)))
      .askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined))
      .rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'invalid_response', status: 200 });
  });

  it('fails closed on invalid UTF-8, including a character the stream cuts short', async () => {
    const valid = encoder.encode(frames(STEPS.slice(0, 1)));
    for (const bytes of [Uint8Array.from([...valid, 0x64, 0x61, 0xff, 0x0a]), Uint8Array.from([...encoder.encode(frames([ANSWERED])), 0xe2, 0x80])]) {
      await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(bytes, 3)))
        .askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('drops the connection on a malformed event while the Authority is still writing, and names nothing after it', async () => {
    const stream = openStream();
    const progress: PersonAskProgressStepEventV3[] = [];
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response))
      .askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 1)));
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    stream.write('data: {"type":"read","items":[{"id":"E5"}]}\n\n');
    await expect(pending).rejects.toMatchObject({ code: 'invalid_response' });
    expect(stream.state.cancelled).toBe(true);
    expect(progress).toEqual(STEPS.slice(0, 1));
  });

  it('accepts a stream only as the /v7 route\'s 200', async () => {
    const unmarked = new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    for (const response of [sse(STREAM, undefined, { status: 503 }), sse(STREAM, undefined, { status: 404 }), unmarked]) {
      const progress: PersonAskProgressStepEventV3[] = [];
      await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response))
        .askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, event => progress.push(event))).rejects.toMatchObject({ code: 'invalid_response' });
      expect(progress).toEqual([]);
    }
  });

  it('stops reading past the whole-stream bound', async () => {
    const stream = openStream();
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response))
      .askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined);
    // Comment lines stay under the line bound, so only the stream bound can stop them.
    const comment = `: ${'x'.repeat(100 * 1024)}\n`;
    for (let written = 0; written <= PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1; written += comment.length) stream.write(comment);
    await expect(pending).rejects.toMatchObject({ code: 'response_too_large', status: 200 });
    expect(stream.state.cancelled).toBe(true);
  });

  it('refuses a streamed answer for another scope', async () => {
    const project = 'prj_00000000-0000-4000-8000-000000000019' as const;
    await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(frames([{ type: 'answer', response: answer(), receipt: receipt() }]))))
      .askV7WithProgress('bearer', 'What did we decide?', project, undefined, () => undefined)).rejects.toMatchObject({ code: 'invalid_response' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(frames([{ type: 'answer', response: answer({ kind: 'project', project_id: project }), receipt: receipt() }])));
    await expect(authority(fetch).askV7WithProgress('bearer', 'What did we decide?', project, undefined, () => undefined))
      .resolves.toMatchObject({ result: { scope: { kind: 'project', project_id: project } } });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ schema_version: 3, question: 'What did we decide?', project_id: project });
  });

  it('turns an error inside the stream into the error its JSON response would have been, never a fallback', async () => {
    for (const [status, code] of [[404, 'not_found'], [503, 'unavailable'], [401, 'unauthorized']] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(`${framesV3(STEPS_V3.slice(0, 2))}${framesV3([{ type: 'error', status, error: { code, message: 'request failed' } }])}`, undefined, { headers: V7_HEADERS }));
      const progress: PersonAskProgressStepEventV3[] = [];
      await expect(new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch }).askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event)))
        .rejects.toMatchObject({ name: 'PersonAuthorityClientError', code, status, routeMatched: true });
      expect(progress).toEqual(STEPS_V3.slice(0, 2));
      expect(fetch.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v7/person/ask']);
    }
  });

  it('answers from an Authority that does not stream with its JSON, without progress or a receipt', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answerV8(), 200, V7_HEADERS));
    const progress: PersonAskProgressStepEventV3[] = [];
    const result = await new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch }).askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event));
    expect(result).toEqual({ result: answerV8() });
    expect('receipt' in result).toBe(false);
    expect(progress).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v7/person/ask']);
    // A JSON body is still bound to the V8 validator and the scope.
    for (const body of [{ ...answer(), receipt: receipt() }, answer({ kind: 'mine' }), { ...answer(), schema_version: 7, kind: 'echo-clean-person-answer-v7' }]) {
      await expect(authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(body))).askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined))
        .rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('fails with not_supported on an Authority without /v7, and asks no other route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(noRoute());
    const progress: PersonAskProgressStepEventV3[] = [];
    await expect(new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch }).askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event)))
      .rejects.toMatchObject({ code: 'not_supported', status: 404 });
    expect(fetch.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v7/person/ask']);
    // Every Ask asks for answer layout v1 (ADR-0045), streamed or not.
    expect(headersOf(fetch.mock.calls[0]![1]).get('x-echo-answer-layout')).toBe('1');
    expect(progress).toEqual([]);
    // A JSON failure from /v7 itself, before any stream, is that failure: its own 404 stays a 404.
    for (const [reply, status, code] of [
      [json({ error: { code: 'not_found', message: 'request failed' } }, 404, V7_HEADERS), 404, 'not_found'],
      [json({ error: { code: 'unauthorized', message: 'request failed' } }, 401), 401, 'unauthorized'],
      [json({ error: { code: 'unavailable', message: 'request failed' } }, 503, V7_HEADERS), 503, 'unavailable'],
    ] as const) {
      const refused = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply);
      await expect(new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch: refused }).askWithLiveProgress('What did we decide?', undefined, undefined, () => undefined))
        .rejects.toMatchObject({ code, status });
      expect(refused.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v7/person/ask']);
    }
  });

  it('cancels the stream when the caller aborts, and hands on nothing after', async () => {
    const stream = openStream();
    const caller = new AbortController();
    const progress: PersonAskProgressStepEventV3[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response);
    const pending = authority(fetch).askV7WithProgress('bearer', 'What did we decide?', undefined, caller.signal, event => progress.push(event));
    stream.write(frames(STEPS.slice(0, 2)));
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'transport_failed', status: null });
    expect(stream.state.cancelled).toBe(true);
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(progress).toEqual(STEPS.slice(0, 2));
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
      const progress: PersonAskProgressStepEventV3[] = [];
      const pending = client.askV7WithProgress('bearer', 'What did we decide?', undefined, caller.signal, event => progress.push(event));
      await vi.waitFor(() => expect(progress).toEqual(STEPS.slice(0, 1)));
      expect(seen.header).toBe('3');
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
    const progress: PersonAskProgressStepEventV3[] = [];
    // The mock answers despite the abort, as a response already in flight would.
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => { caller.abort(); return stream.response; });
    await expect(authority(fetch).askV7WithProgress('bearer', 'What did we decide?', undefined, caller.signal, event => progress.push(event)))
      .rejects.toMatchObject({ code: 'transport_failed' });
    expect(stream.state.cancelled).toBe(true);
    expect(progress).toEqual([]);
  });

  it('bounds the whole stream by the ask timeout', async () => {
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const stream = openStream();
    const progress: PersonAskProgressStepEventV3[] = [];
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response))
      .askV7WithProgress('bearer', 'What did we decide?', undefined, new AbortController().signal, event => progress.push(event));
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
    const pending = authority(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response)).askV7WithProgress('bearer', 'What did we decide?', undefined, undefined, () => undefined);
    controller.error(new TypeError('terminated'));
    await expect(pending).rejects.toMatchObject({ code: 'transport_failed' });
  });

  it('asks only as the account its caller expects: another sign-in that came first is refused before anything is sent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch });
    const progress: PersonAskProgressStepEventV3[] = [];
    for (const expected of [
      { expected_authority: ORIGIN, expected_membership_id: 'mem_00000000-0000-4000-8000-000000000002' },
      { expected_authority: 'https://other.example.test', expected_membership_id: SESSION.membership_id },
      // A pin is both or it is refused.
      { expected_membership_id: SESSION.membership_id },
    ]) {
      await expect(client.askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event), expected))
        .rejects.toThrow('did not match the current account');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(progress).toEqual([]);
    fetch.mockResolvedValueOnce(sse(STREAM_V3, undefined, { headers: V7_HEADERS }));
    await expect(client.askWithLiveProgress('What did we decide?', undefined, undefined, event => progress.push(event),
      { expected_authority: ORIGIN, expected_membership_id: SESSION.membership_id })).resolves.toEqual({ result: answerV8(), receipt: receiptV3() });
    expect(progress).toEqual(STEPS_V3);
  });

  it('stops handing on steps once another account is signed in, and drops the stream', async () => {
    const home = sessionHome();
    const stream = openStream({ ...STREAM_HEADERS, ...V7_HEADERS });
    const progress: PersonAskProgressStepEventV3[] = [];
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
    const stream = openStream({ ...STREAM_HEADERS, ...V7_HEADERS });
    const progress: PersonAskProgressStepEventV3[] = [];
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
    stream.write(`${framesV3(STEPS_V3.slice(2))}${framesV3([ANSWERED_V3])}`);
    stream.close();
    await expect(pending).resolves.toEqual({ result: answerV8(), receipt: receiptV3() });
    expect(progress).toEqual([STEPS[0], ...STEPS_V3.slice(2)]);
  });
});

describe('person ask --progress', () => {
  it('prints each step as its own line, then today\'s final line with the receipt, the workspace included', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(STREAM_V3, 7, { headers: V7_HEADERS }));
    const { output, run } = cli(sessionHome(), fetch);
    await expect(run(['ask', '--question', 'Where is Thermal recovery tracked?', '--progress'])).resolves.toBe(0);
    expect(output.stderr).toBe('');
    const printed = lines(output.stdout);
    expect(printed.slice(0, -1).map(line => validatePersonAskProgressLineV3(line))).toEqual(STEPS_V3.map(progress => ({ ok: true, progress })));
    expect(validatePersonAskProgressResultLineV3(printed.at(-1))).toEqual({ ok: true, result: answerV8(), receipt: receiptV3() });
    expect(output.stdout.endsWith('\n')).toBe(true);
    expect(pathOf(fetch.mock.calls[0]![0])).toBe('/v7/person/ask');
    expect(headersOf(fetch.mock.calls[0]![1]).get(PERSON_ASK_PROGRESS_HEADER_V1)).toBe('3');
  });

  it('keeps the project scope on the streamed request', async () => {
    const project = 'prj_00000000-0000-4000-8000-000000000019' as const;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(framesV3([{ type: 'answer', response: answerV8({ kind: 'project', project_id: project }), receipt: receiptV3() }]), undefined, { headers: V7_HEADERS }));
    const { output, run } = cli(sessionHome(), fetch);
    await expect(run(['ask', '--question', 'What did we decide?', '--progress', '--project', project])).resolves.toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ schema_version: 3, question: 'What did we decide?', project_id: project });
    expect(lines(output.stdout)).toEqual([{ ok: true, result: answerV8({ kind: 'project', project_id: project }), receipt: receiptV3() }]);
  });

  it('prints exactly the plain Ask\'s line from an Authority that does not stream', async () => {
    const home = sessionHome();
    const ask = async (argv: readonly string[]) => {
      const { output, run } = cli(home, vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answerV8(), 200, V7_HEADERS)));
      await expect(run(argv)).resolves.toBe(0);
      return output;
    };
    const plain = await ask(['ask', '--question', 'What did we decide?']);
    await expect(ask(['ask', '--question', 'What did we decide?', '--progress'])).resolves.toEqual(plain);
    expect(lines(plain.stdout)).toEqual([{ ok: true, result: answerV8() }]);
  });

  it('sends no opt-in header and prints one line without --progress, on /v7 in every scope, Mine included', async () => {
    for (const [argv, body] of [
      [['ask', '--question', 'What did we decide?'], answerV8()],
      [['ask', '--question', 'What did we decide?', '--mine'], answerMineV8()],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(body, 200, V7_HEADERS));
      const { output, run } = cli(sessionHome(), fetch);
      await expect(run(argv)).resolves.toBe(0);
      expect(pathOf(fetch.mock.calls[0]![0])).toBe('/v7/person/ask');
      expect(headersOf(fetch.mock.calls[0]![1]).has(PERSON_ASK_PROGRESS_HEADER_V1)).toBe(false);
      expect(headersOf(fetch.mock.calls[0]![1]).get('x-echo-answer-layout')).toBe('1');
      expect(output.stdout).toBe(`${JSON.stringify({ ok: true, result: body })}\n`);
    }
  });

  // Mine streams as every scope does, in progress V3 on /v7.
  it('streams a Mine Ask with --progress', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(frames([...STEPS_MINE, { type: 'answer', response: answerMineV8(), receipt: receiptMine() }]), 7));
    const { output, run } = cli(sessionHome(), fetch);
    await expect(run(['ask', '--question', 'What did we decide?', '--progress', '--mine'])).resolves.toBe(0);
    expect(output.stderr).toBe('');
    expect(fetch.mock.calls.map(([url, init]) => [pathOf(url), headersOf(init).get(PERSON_ASK_PROGRESS_HEADER_V1), JSON.parse(String(init?.body))]))
      .toEqual([['/v7/person/ask', '3', { schema_version: 3, question: 'What did we decide?', mine: true }]]);
    expect(lines(output.stdout)).toEqual([...STEPS_MINE.map(progress => ({ ok: true, progress })), { ok: true, result: answerMineV8(), receipt: receiptMine() }]);
  });

  it('pins the streamed Ask to the expected account: another one signed in prints no step and sends nothing', async () => {
    const pin = (membership: string) => [`--expected-membership-id=${membership}`, `--expected-authority=${ORIGIN}`];
    const fetch = vi.fn<typeof globalThis.fetch>();
    const refused = cli(sessionHome(), fetch);
    await expect(refused.run(['ask', '--question', 'What did we decide?', '--progress', ...pin('mem_00000000-0000-4000-8000-000000000002')])).resolves.toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(refused.output.stdout).toBe('');
    expect(JSON.parse(refused.output.stderr)).toMatchObject({ ok: false, action: 'ask' });

    fetch.mockResolvedValueOnce(sse(STREAM_V3, undefined, { headers: V7_HEADERS }));
    const pinned = cli(sessionHome(), fetch);
    await expect(pinned.run(['ask', '--question', 'What did we decide?', '--progress', ...pin(SESSION.membership_id)])).resolves.toBe(0);
    expect(lines(pinned.output.stdout)).toHaveLength(STEPS_V3.length + 1);

    // Only a streamed Ask takes a pin: a plain Ask never checks it.
    const unpinned = cli(sessionHome(), vi.fn<typeof globalThis.fetch>());
    await expect(unpinned.run(['ask', '--question', 'What did we decide?', ...pin(SESSION.membership_id)])).resolves.toBe(2);
    expect(JSON.parse(unpinned.output.stderr)).toEqual({ ok: false, error: '--expected-membership-id and --expected-authority require --progress with `echo-brain person ask`' });
  });

  it('makes an error inside the stream the command\'s ordinary failure, after the steps already printed', async () => {
    for (const [status, code, message] of [[502, 'invalid_output', 'Answer generation returned an invalid response.'], [503, 'unavailable', 'Person Authority rejected the request']] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(`${frames(STEPS.slice(0, 1))}${frames([{ type: 'error', status, error: { code, message: 'request failed' } }])}`));
      const { output, run } = cli(sessionHome(), fetch);
      await expect(run(['ask', '--question', 'What did we decide?', '--progress'])).resolves.toBe(1);
      expect(lines(output.stdout)).toEqual([{ ok: true, progress: STEPS[0] }]);
      expect(JSON.parse(output.stderr)).toEqual({ ok: false, action: 'ask', error: message, code, status });
    }
  });

  it('fails a malformed stream as invalid_response and prints no result', async () => {
    // Byte by byte, so the first step is complete before the malformed event arrives.
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(sse(`${frames(STEPS.slice(0, 1))}data: {"type":"stage","stage":"thinking"}\n\n`, 1));
    const { output, run } = cli(sessionHome(), fetch);
    await expect(run(['ask', '--question', 'What did we decide?', '--progress'])).resolves.toBe(1);
    expect(lines(output.stdout)).toEqual([{ ok: true, progress: STEPS[0] }]);
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_response', status: 200 });
  });

  it('stops on the desktop\'s cancellation mid-stream and prints no result', async () => {
    const stream = openStream();
    const caller = new AbortController();
    const { output, run } = cli(sessionHome(), vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream.response), caller.signal);
    const pending = run(['ask', '--question', 'What did we decide?', '--progress']);
    stream.write(frames(STEPS.slice(0, 1)));
    await vi.waitFor(() => expect(lines(output.stdout)).toHaveLength(1));
    caller.abort();
    await expect(pending).resolves.toBe(1);
    expect(stream.state.cancelled).toBe(true);
    expect(lines(output.stdout)).toEqual([{ ok: true, progress: STEPS[0] }]);
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, action: 'ask', code: 'transport_failed' });
  });
});
