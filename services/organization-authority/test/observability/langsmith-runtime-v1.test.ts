import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { observeCoreRuntimeDiagnosticV1, observeCoreRuntimeRootV1, observeCoreRuntimeV1, type CoreRuntimeObservationScopeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { createLangSmithRuntimeV1, createLangSmithSenderV1, readLangSmithConfigV1 } from '../../src/composition/observability/langsmith-runtime-v1.js';
import { createLangSmithObserverV1, type LangSmithRunV1 } from '../../src/composition/observability/langsmith-observer-v1.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-langsmith-')); roots.push(root);
  const path = join(root, 'tracing.json');
  const config = { project: 'echo-staging', region: 'eu' as const, api_key: 'fixture-key-never-log', expires_at: new Date(Date.now() + 3600_000).toISOString() };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { path, config };
};
/** The runs one multipart upload carried, root first, rebuilt from their parts. */
async function uploadedRuns(form: FormData): Promise<LangSmithRunV1[]> {
  const runs = new Map<string, Record<string, unknown>>();
  for (const [name, value] of form.entries()) {
    const [, id, part] = /^post\.([^.]+)(?:\.(\w+))?$/u.exec(name)!;
    const json = JSON.parse(await (value as Blob).text()) as Record<string, unknown>;
    runs.set(id!, { ...runs.get(id!), ...(part === undefined ? json : { [part]: json }) });
  }
  return [...runs.values()] as unknown as LangSmithRunV1[];
}
/** A trace with its random child run ids replaced by position, so two projections of the same events compare equal. */
function positional(runs: readonly LangSmithRunV1[]): unknown {
  let json = JSON.stringify(runs);
  runs.forEach((run, index) => { if (run.id !== run.trace_id) json = json.split(run.id).join(`child-${index}`); });
  return JSON.parse(json);
}
/** One meeting lane's extraction, as far as the exporters see it. */
const meetingLane = (scope: CoreRuntimeObservationScopeV1 | undefined, meeting: string) => observeCoreRuntimeRootV1('worker_execution', () =>
  observeCoreRuntimeV1('extraction', async () => {
    observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'extraction', event: 'started', data: { meeting, title: 'private meeting title' } });
  }), scope);
describe('explicit staging LangSmith selection', () => {
  it('accepts an explicit persistent selection after a month, but never treats a missing expiry as persistent', () => {
    const { path, config } = fixture();
    const persistent = { ...config, expires_at: null };
    writeFileSync(path, JSON.stringify(persistent));
    expect(readLangSmithConfigV1(path, STAGING_AUTHORITY_ORIGIN_V1, Date.now() + 30 * 24 * 3600_000)).toEqual(persistent);
    expect(() => readLangSmithConfigV1(path, 'https://authority.example')).toThrow('configuration is invalid');
    for (const expires_at of [undefined, '', false, 0]) {
      writeFileSync(path, JSON.stringify({ ...config, expires_at }));
      expect(() => readLangSmithConfigV1(path, STAGING_AUTHORITY_ORIGIN_V1)).toThrow('configuration is invalid');
    }
  });

  it('exports persistent research after the former window and after restarting from the same selection', async () => {
    const { path, config } = fixture();
    writeFileSync(path, JSON.stringify({ ...config, expires_at: null }));
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 202 }));
    const lines: string[] = [];
    const create = () => createLangSmithRuntimeV1({ path, authority_url: STAGING_AUTHORITY_ORIGIN_V1, release_sha: 'a'.repeat(40), write: line => { lines.push(line); } });
    const research = async (runtime: ReturnType<typeof create>) => {
      await observeCoreRuntimeV1('research_run', async () => {
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: 1, round: 1, tool: 'search', args: { query: 'fixture THERM' } });
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: 1, round: 1, tool: 'search', result: { items: [] } });
      }, runtime.scope);
    };
    const running = create();
    try {
      running.start();
      clock.mockReturnValue(started + 25 * 3600_000);
      await research(running);
    } finally { await running.close(); }
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(started + 30 * 24 * 3600_000);
    const restarted = create();
    try { restarted.start(); await research(restarted); } finally { await restarted.close(); }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ enabled: true, exported: 1, failed: 0 }));
    expect(lines.join('')).not.toContain(config.api_key);
    expect(lines.join('')).not.toContain('fixture THERM');
    rmSync(path);
    const disabled = create();
    try { disabled.start(); await research(disabled); } finally { await disabled.close(); }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is disabled for missing or expired selections and rejects production, unsafe files, and unknown destinations', () => {
    const { path, config } = fixture();
    expect(readLangSmithConfigV1(`${path}-absent`, STAGING_AUTHORITY_ORIGIN_V1)).toBeUndefined();
    expect(readLangSmithConfigV1(path, STAGING_AUTHORITY_ORIGIN_V1)).toEqual(config);
    expect(() => readLangSmithConfigV1(path, 'https://authority.example')).toThrow('configuration is invalid');
    const link = `${path}-link`; symlinkSync(path, link);
    expect(() => readLangSmithConfigV1(link, STAGING_AUTHORITY_ORIGIN_V1)).toThrow('configuration is invalid');
    chmodSync(path, 0o644);
    expect(() => readLangSmithConfigV1(path, STAGING_AUTHORITY_ORIGIN_V1)).toThrow('configuration is invalid');
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ ...config, expires_at: new Date(Date.now() - 1000).toISOString() }));
    expect(readLangSmithConfigV1(path, STAGING_AUTHORITY_ORIGIN_V1)).toBeUndefined();
    for (const changes of [{ region: 'https://untrusted.example' }, { expires_at: '2099-01-01T00:00:00Z' }, { extra: true }]) {
      writeFileSync(path, JSON.stringify({ ...config, ...changes }));
      expect(() => readLangSmithConfigV1(path, STAGING_AUTHORITY_ORIGIN_V1)).toThrow('configuration is invalid');
    }
  });

  it('sends correlated multipart parts with UTF-8 byte lengths on the HTTP wire', async () => {
    const { config } = fixture();
    let received: { headers: IncomingHttpHeaders; body: Buffer } | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = { headers: request.headers, body: Buffer.concat(chunks) };
      response.writeHead(202).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server address missing');
    // Use Node's real fetch encoder and capture the actual HTTP request locally.
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => fetch(`http://127.0.0.1:${address.port}`, options));
    const send = createLangSmithSenderV1({ ...config, workspace_id: '11111111-2222-3333-4444-555555555555' }, fetcher);
    const run: LangSmithRunV1 = { id: '12345678-1234-4123-8123-123456789012', name: 'ECHO ask', run_type: 'chain',
      trace_id: '12345678-1234-4123-8123-123456789012', dotted_order: '20261010T000000000000Z12345678-1234-4123-8123-123456789012',
      start_time: '2026-10-10T00:00:00.000Z', session_name: config.project, inputs: { question: 'THERM 温度 ±0.1 °C?' }, outputs: { answer: 'DVT hold 🧪' },
      events: [{ name: 'citation', time: '2026-10-10T00:00:01.000Z', kwargs: { title: '测试' } }], extra: { metadata: { complete: true } } };
    const child: LangSmithRunV1 = { ...run, id: '22345678-1234-4123-8123-123456789012', parent_run_id: run.id,
      dotted_order: `${run.dotted_order}.20261010T000001000000Z22345678-1234-4123-8123-123456789012`,
      inputs: {}, outputs: undefined, events: undefined };
    try {
      await send([run, child], new AbortController().signal);
      const [url, options] = fetcher.mock.calls[0]!;
      expect(url).toBe('https://eu.api.smith.langchain.com/runs/multipart');
      expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-api-key': config.api_key, 'x-tenant-id': '11111111-2222-3333-4444-555555555555' } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(received).toBeDefined();
      expect(received!.headers['x-api-key']).toBe(config.api_key);
      expect(received!.headers['x-tenant-id']).toBe('11111111-2222-3333-4444-555555555555');
      const boundary = /boundary=([^;]+)/.exec(received!.headers['content-type'] ?? '')?.[1];
      expect(boundary).toBeTruthy();
      const wire = received!.body.toString('utf8');
      const parts = wire.split(`--${boundary}`).slice(1, -1);
      expect(parts).toHaveLength(6);
      const values = new Map<string, unknown>();
      for (const part of parts) {
        expect(part.startsWith('\r\n')).toBe(true);
        expect(part.endsWith('\r\n')).toBe(true);
        const separator = part.indexOf('\r\n\r\n');
        const headers = part.slice(2, separator);
        const payload = part.slice(separator + 4, -2);
        expect(headers).toMatch(/Content-Type: application\/json/i);
        const length = /Content-Length: (\d+)/i.exec(headers)?.[1] ?? /;\s*length=(\d+)/i.exec(headers)?.[1];
        expect(Number(length)).toBe(Buffer.byteLength(payload, 'utf8'));
        const name = /name="([^"]+)"/.exec(headers)?.[1];
        expect(name).toBeTruthy();
        values.set(name!, JSON.parse(payload));
      }
      expect(values.get(`post.${run.id}`)).toMatchObject({ trace_id: run.trace_id, extra: run.extra });
      expect(values.get(`post.${run.id}.inputs`)).toEqual(run.inputs);
      expect(values.get(`post.${run.id}.outputs`)).toEqual(run.outputs);
      expect(values.get(`post.${run.id}.events`)).toEqual(run.events);
      expect(values.get(`post.${child.id}`)).toMatchObject({ parent_run_id: run.id, trace_id: run.trace_id });
      expect(values.get(`post.${child.id}.inputs`)).toEqual({});
      expect(wire).not.toContain(config.api_key);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('reports unsuccessful uploads and network failures without retaining private error content', async () => {
    const { config } = fixture();
    for (const fetcher of [vi.fn<typeof fetch>(async () => new Response('private server error', { status: 429 })),
      vi.fn<typeof fetch>(async () => { throw new Error('private network error'); })]) {
      await expect(createLangSmithSenderV1(config, fetcher)([], new AbortController().signal)).rejects.toThrow(/^LangSmith trace export failed$/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([400, 401, 403, 429, 500])('reports HTTP %s in the existing status record without private response content', async status => {
    const { path, config } = fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private service response', { status }));
    const lines: string[] = [];
    const runtime = createLangSmithRuntimeV1({ path, authority_url: STAGING_AUTHORITY_ORIGIN_V1,
      release_sha: 'a'.repeat(40), write: line => { lines.push(line); } });
    try {
      runtime.start();
      await expect(observeCoreRuntimeV1('research_run', async () => {
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: 1, round: 1,
          tool: 'search', args: { query: 'private question' } });
        observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: 1, round: 1,
          tool: 'search', result: { text: 'private source' } });
        return 42;
      }, runtime.scope)).resolves.toBe(42);
    } finally { await runtime.close(); }
    expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      enabled: true, exported: 0, failed: 1, pending: 0,
      last_failure: { kind: 'http', http_status: status },
    }));
    for (const secret of [config.api_key, 'private service response', 'private question', 'private source']) {
      expect(lines.join('')).not.toContain(secret);
    }
  });

  it('uploads research exactly as a research exporter alone does, however slow meeting extraction uploads are', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { path } = fixture();
    let holding = true;
    const held: (() => void)[] = [], research: LangSmithRunV1[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const runs = await uploadedRuns(options!.body as FormData);
      // A meeting extraction's upload hangs until the test lets it go; research uploads are accepted at once.
      if (runs[0]!.name !== 'ECHO meeting_extraction') research.push(runs);
      else if (holding) await new Promise<void>(resolve => { held.push(resolve); });
      return new Response('', { status: 202 });
    });
    const lines: string[] = [];
    const runtime = createLangSmithRuntimeV1({ path, authority_url: STAGING_AUTHORITY_ORIGIN_V1, release_sha: 'a'.repeat(40), write: line => { lines.push(line); } });
    // The same events also reach a research exporter of its own: what the runtime's research uploads must equal.
    const alone: LangSmithRunV1[][] = [];
    const reference = createLangSmithObserverV1({ project: 'echo-staging', release_sha: 'a'.repeat(40), send: async runs => { alone.push(runs); } });
    const scope: CoreRuntimeObservationScopeV1 = {
      observer(event) { void reference.scope.observer!(structuredClone(event)); void runtime.scope!.observer!(event); },
      diagnostic_exporter(operation) {
        const recorders = [reference.scope.diagnostic_exporter!(operation), runtime.scope!.diagnostic_exporter!(operation)];
        return event => { for (const record of recorders) void record?.(event); };
      },
    };
    try {
      runtime.start();
      // Four meeting lanes fill meeting extraction's upload queue behind its one held upload; then six Asks, each of
      // which uploads while that upload still hangs.
      for (let lane = 0; lane < 4; lane++) await meetingLane(scope, `note-${lane}`);
      for (let ask = 0; ask < 6; ask++) {
        await observeCoreRuntimeV1('research_run', async () => {
          observeCoreRuntimeDiagnosticV1({ kind: 'tool_request', tool_call_id: 1, round: 1, tool: 'search', args: { query: `THERM ${ask}` } });
          observeCoreRuntimeDiagnosticV1({ kind: 'tool_response', tool_call_id: 1, round: 1, tool: 'search', result: { items: [] } });
        }, scope);
        await vi.waitFor(() => expect(research).toHaveLength(ask + 1));
      }
      await reference.flush();
      expect(research.map(positional)).toEqual(alone.map(positional));
      expect(held).toHaveLength(1);
      holding = false; held.shift()!();
      await reference.close(); await runtime.close();
      // Research's counts are the lone exporter's; meeting extraction's are reported apart.
      const { kind: _kind, enabled: _enabled, meeting_extraction: meetings, ...counts } = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      expect(counts).toEqual(reference.status());
      expect(meetings).toMatchObject({ exported: 4, failed: 0, dropped: 0, incomplete: 0, pending: 0 });
    } finally { vi.useRealTimers(); await runtime.close(); }
  });

  it('records an extraction run inside a research operation in both traces', async () => {
    const { path } = fixture();
    const uploads: LangSmithRunV1[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => { uploads.push(await uploadedRuns(options!.body as FormData)); return new Response('', { status: 202 }); });
    const runtime = createLangSmithRuntimeV1({ path, authority_url: STAGING_AUTHORITY_ORIGIN_V1, release_sha: 'a'.repeat(40), write: () => undefined });
    try {
      await observeCoreRuntimeV1('research_run', () => observeCoreRuntimeV1('extraction', async () => {
        observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'extraction', event: 'started', data: { meeting: 'note-1', title: 'nested' } });
      }), runtime.scope);
    } finally { await runtime.close(); }
    // Research keeps the payloads it always recorded; the extraction's own trace has them too.
    expect(Object.fromEntries(uploads.map(runs => [runs[0]!.name, runs.map(run => [run.name, run.inputs])]))).toEqual({
      'ECHO meeting_extraction': [['ECHO meeting_extraction', { meeting: 'note-1', title: 'nested' }]],
      'ECHO research': [['ECHO research', {}], ['extraction', { meeting: 'note-1', title: 'nested' }]],
    });
  });

  it('reports meeting extraction\'s counts apart, so its failed uploads leave the counts the release preflight reads clean', async () => {
    const { path } = fixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const runs = await uploadedRuns(options!.body as FormData);
      return new Response('private service response', { status: runs[0]!.name === 'ECHO meeting_extraction' ? 500 : 202 });
    });
    const lines: string[] = [];
    const runtime = createLangSmithRuntimeV1({ path, authority_url: STAGING_AUTHORITY_ORIGIN_V1, release_sha: 'a'.repeat(40), write: line => { lines.push(line); } });
    try {
      runtime.start();
      await meetingLane(runtime.scope, 'note-1');
      await observeCoreRuntimeV1('research_run', async () => 42, runtime.scope);
    } finally { await runtime.close(); }
    expect(JSON.parse(lines.at(-1)!)).toEqual({ kind: 'echo-langsmith-tracing-status-v1', enabled: true,
      exported: 1, failed: 0, dropped: 0, incomplete: 0, active: 0, pending: 0, last_failure: null,
      meeting_extraction: { exported: 0, failed: 1, dropped: 0, incomplete: 0, active: 0, pending: 0, last_failure: { kind: 'http', http_status: 500 } } });
    expect(lines.join('')).not.toContain('private');
  });

  it.each(['timeout', 'cancelled', 'network'] as const)('distinguishes %s without retaining transport errors', async kind => {
    const { config } = fixture();
    const deadline = new AbortController();
    const caller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (kind === 'timeout') deadline.abort();
      if (kind === 'cancelled') caller.abort();
      throw new Error('private network failure with credentials');
    });
    await expect(createLangSmithSenderV1(config, fetcher)([], caller.signal)).rejects.toMatchObject({
      message: 'LangSmith trace export failed', failure: { kind, http_status: null },
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('classifies serialization failure without sending or exposing the payload', async () => {
    const { config } = fixture();
    const fetcher = vi.fn<typeof fetch>();
    const run = { id: 'fixture', inputs: { private: 1n } } as unknown as LangSmithRunV1;
    await expect(createLangSmithSenderV1(config, fetcher)([run], new AbortController().signal)).rejects.toMatchObject({
      message: 'LangSmith trace export failed', failure: { kind: 'serialization', http_status: null },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([202, 403])('preserves HTTP %s when discarding the response body fails', async status => {
    const { config } = fixture();
    const response = new Response(new ReadableStream({ cancel() { throw new Error('private cleanup failure'); } }), { status });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const sent = createLangSmithSenderV1(config, fetcher)([], new AbortController().signal);
    if (status === 202) await expect(sent).resolves.toBeUndefined();
    else await expect(sent).rejects.toMatchObject({ failure: { kind: 'http', http_status: status } });
  });
});
