import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { createLangSmithSenderV1, readLangSmithConfigV1 } from '../../src/composition/observability/langsmith-runtime-v1.js';
import type { LangSmithRunV1 } from '../../src/composition/observability/langsmith-observer-v1.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-langsmith-')); roots.push(root);
  const path = join(root, 'tracing.json');
  const config = { project: 'echo-staging', region: 'eu' as const, api_key: 'fixture-key-never-log', expires_at: new Date(Date.now() + 3600_000).toISOString() };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { path, config };
};
describe('explicit staging LangSmith selection', () => {
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
});
