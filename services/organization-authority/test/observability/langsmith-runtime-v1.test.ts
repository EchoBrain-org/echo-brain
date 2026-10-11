import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('sends one correlated multipart trace to the selected region and workspace', async () => {
    const { config } = fixture();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 202 }));
    const send = createLangSmithSenderV1({ ...config, workspace_id: '11111111-2222-3333-4444-555555555555' }, fetcher);
    const run: LangSmithRunV1 = { id: '12345678-1234-4123-8123-123456789012', name: 'ECHO ask', run_type: 'chain',
      trace_id: '12345678-1234-4123-8123-123456789012', dotted_order: '20261010T000000000000Z12345678-1234-4123-8123-123456789012',
      start_time: '2026-10-10T00:00:00.000Z', session_name: config.project, inputs: { question: 'THERM?' }, outputs: { answer: 'DVT hold' }, extra: { metadata: { complete: true } } };
    await send([run], new AbortController().signal);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://eu.api.smith.langchain.com/runs/multipart');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-api-key': config.api_key, 'x-tenant-id': '11111111-2222-3333-4444-555555555555' } });
    const form = options!.body as FormData;
    expect(JSON.parse(await (form.get(`post.${run.id}`) as Blob).text())).toMatchObject({ trace_id: run.trace_id, extra: run.extra });
    expect(JSON.parse(await (form.get(`post.${run.id}.inputs`) as Blob).text())).toEqual(run.inputs);
    expect(JSON.parse(await (form.get(`post.${run.id}.outputs`) as Blob).text())).toEqual(run.outputs);
    expect(await (form.get(`post.${run.id}`) as Blob).text()).not.toContain(config.api_key);
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
