import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';
import { PERSON_DOCUMENT_MAX_ORIGINAL_BYTES } from '@echo-brain/organization-api';

const NOW = '2026-09-23T01:00:00.000Z';
const requestId = '10000000-0000-4000-8000-000000000001';
const documentId = `doc_${'a'.repeat(64)}`;
const projectId = 'prj_10000000-0000-4000-8000-000000000001';
const homes: string[] = [];
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function setup(bytes = Buffer.from('# SCOUT PRD\n' + 'robot requirements\n'.repeat(750))) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-document-cli-'))); homes.push(home);
  const store = new PersonSessionStore(home);
  store.install('https://authority.example', 'oau_00000000-0000-4000-8000-000000000001', {
    organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001', display_name: 'Document Fixture', membership_type: 'employee',
    identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-09-23T01:10:00.000Z',
    refresh_expires_at: '2026-09-30T01:00:00.000Z', hard_reauthentication_at: '2026-09-30T01:00:00.000Z',
  });
  const file = join(home, 'SCOUT.md'); writeFileSync(file, bytes);
  const upload = { schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: requestId, filename: 'SCOUT.md',
    title: 'SCOUT PRD', content_length: bytes.length, sha256: digest(bytes), audience: { kind: 'only_me' }, project_id: null };
  const receipt = { ...upload, kind: 'echo-person-document-receipt-v1', document_id: documentId, detected_media_type: 'text/markdown',
    received_at: NOW, state: 'saved', extraction_state: 'extracting' };
  const metadata = { ...receipt, kind: 'echo-person-document-metadata-v1', extraction_detail: null, extractor: null, extracted_text_bytes: 0 };
  return { home, file, bytes, upload, receipt, metadata, store };
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
async function run(home: string, args: string[], fetch: typeof globalThis.fetch) {
  let stdout = '', stderr = '';
  const code = await runPersonClientCli(args, { home_directory: home, now: () => NOW, fetch,
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  return { code, stdout, stderr, result: stdout ? JSON.parse(stdout) as Record<string, unknown> : null, failure: stderr ? JSON.parse(stderr) as Record<string, unknown> : null };
}
const uploadArgs = (file: string) => ['documents', 'upload', '--file', file, '--audience', 'only-me', '--title', 'SCOUT PRD', '--request-id', requestId];
async function consume(init?: RequestInit): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) { expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function original(bytes: Uint8Array, sha256 = digest(bytes)): Response {
  return new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'text/markdown', 'content-length': String(bytes.byteLength), 'x-echo-document-sha256': sha256 } });
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('document CLI custody and bounded transport', () => {
  it('classifies a storage quota rejection as not submitted without exposing diagnostics', async () => {
    const f = setup();
    const outcome = await run(f.home, uploadArgs(f.file), async (_url, init) => {
      await consume(init);
      return json({ error: { code: 'quota_exceeded', message: 'private capacity diagnostic' } }, 409);
    });
    expect(outcome.failure).toMatchObject({ code: 'quota_exceeded', status: 409, mutation_outcome: 'not_submitted', request_id: requestId });
    expect(outcome.stderr).not.toContain('private capacity');
  });
  it('streams an ordinary PRD larger than 8 KiB with exact metadata, bytes, and bounded receipt', async () => {
    const f = setup();
    expect(f.bytes.length).toBeGreaterThan(8192);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://authority.example/v1/person/documents/${requestId}`);
      expect(init?.method).toBe('PUT'); expect(init?.redirect).toBe('error');
      expect((init as RequestInit & { duplex: string }).duplex).toBe('half');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(JSON.parse(Buffer.from(headers.get('x-echo-document-metadata')!, 'base64url').toString())).toEqual(f.upload);
      expect(headers.get('content-length')).toBe(String(f.bytes.length));
      expect(await consume(init)).toEqual(f.bytes);
      return json(f.receipt, 201);
    });
    const outcome = await run(f.home, uploadArgs(f.file), fetch);
    expect(outcome.code, outcome.stderr).toBe(0); expect(outcome.result).toEqual({ ok: true, result: f.receipt });
    expect(outcome.stdout.length).toBeLessThan(2048); expect(outcome.stdout).not.toContain('robot requirements');
  });

  it('submits one V2 document record with independent canonical associations and project-audience union', async () => {
    const f = setup();
    const associations = [projectId, 'prj_10000000-0000-4000-8000-000000000002'];
    const metadata = { schema_version: 2, kind: 'echo-person-document-upload-v2', request_id: requestId, filename: 'SCOUT.md', title: 'SCOUT PRD', content_length: f.bytes.length, sha256: f.upload.sha256,
      association_project_ids: associations, audience: { kind: 'projects', project_ids: associations } };
    const receipt = { ...metadata, kind: 'echo-person-document-receipt-v2', document_id: documentId, detected_media_type: 'text/markdown', received_at: NOW, state: 'saved', extraction_state: 'extracting' };
    const outcome = await run(f.home, ['documents', 'upload-v2', '--file', f.file, '--title', 'SCOUT PRD', '--request-id', requestId,
      '--association-project-ids-json', JSON.stringify(associations), '--audience', 'projects', '--audience-project-ids-json', JSON.stringify(associations)], async (url, init) => {
      expect(String(url)).toBe(`https://authority.example/v2/person/documents/${requestId}`);
      expect(JSON.parse(Buffer.from(new Headers(init?.headers).get('x-echo-document-metadata')!, 'base64url').toString())).toEqual(metadata);
      await consume(init); return json(receipt, 201);
    });
    expect(outcome.code, outcome.stderr).toBe(0); expect(outcome.result).toEqual({ ok: true, result: receipt });
  });

  it('retains the exact snapshot across lost responses and changed/deleted source files', async () => {
    const f = setup(); let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(await consume(init)).toEqual(f.bytes); calls += 1;
      if (calls === 1) throw new Error('private network failure');
      return json(f.receipt, 201);
    });
    const first = await run(f.home, uploadArgs(f.file), fetch);
    expect(first.failure).toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown', request_id: requestId });
    expect(first.stderr).not.toContain('private network');
    writeFileSync(f.file, 'changed'); unlinkSync(f.file);
    const second = await run(f.home, uploadArgs(f.file), fetch);
    expect(second.code, second.stderr).toBe(0); expect(calls).toBe(2);
  });

  it('keeps an uncertain snapshot after a later rejected retry, and settles it only against exact status', async () => {
    const f = setup(); let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(await consume(init)).toEqual(f.bytes); calls += 1;
      if (calls === 1) throw new Error('lost');
      return json({ error: { code: 'unauthorized', message: 'request failed' } }, 401);
    });
    await run(f.home, uploadArgs(f.file), fetch);
    writeFileSync(f.file, 'changed');
    expect((await run(f.home, uploadArgs(f.file), fetch)).failure).toMatchObject({ code: 'unauthorized' });
    expect(calls).toBe(2);
    const root = join(f.home, '.local/share/echo-brain/person/document-snapshots');
    const pending = join(root, readdirSync(root)[0]!, requestId);
    expect(existsSync(pending)).toBe(true);
    const status = await run(f.home, ['documents', 'status', '--request-id', requestId], async () => json(f.metadata));
    expect(status.code, status.stderr).toBe(0); expect(existsSync(pending)).toBe(false);
  });

  it('lists and retries retained original bytes by request ID after a fresh process without the source path', async () => {
    const f = setup();
    await run(f.home, uploadArgs(f.file), async (_url, init) => { await consume(init); throw new Error('lost'); });
    unlinkSync(f.file);
    const offline = vi.fn();
    const pending = await run(f.home, ['documents', 'pending'], offline);
    expect(pending.code, pending.stderr).toBe(0);
    expect(pending.result).toMatchObject({ ok: true, result: { snapshots: [{ request_id: requestId, filename: 'SCOUT.md', sha256: f.upload.sha256 }] } });
    expect(pending.stdout).not.toContain(f.file); expect(offline).not.toHaveBeenCalled();
    const retry = await run(f.home, ['documents', 'retry', '--request-id', requestId], async (_url, init) => {
      expect(await consume(init)).toEqual(f.bytes); return json(f.receipt, 201);
    });
    expect(retry.code, retry.stderr).toBe(0);
    expect((await run(f.home, ['documents', 'pending'], offline)).result).toMatchObject({ ok: true, result: { snapshots: [] } });
  });

  it('explicitly abandons a retained local snapshot without claiming the Authority upload was cancelled', async () => {
    const f = setup();
    await run(f.home, uploadArgs(f.file), async (_url, init) => { await consume(init); throw new Error('lost'); });
    const offline = vi.fn();
    const abandoned = await run(f.home, ['documents', 'abandon', '--request-id', requestId], offline);
    expect(abandoned.code, abandoned.stderr).toBe(0);
    expect(abandoned.result).toMatchObject({ ok: true, result: { request_id: requestId, local_snapshot_removed: true, authority_outcome: 'unchanged' } });
    expect(offline).not.toHaveBeenCalled();
    const retry = await run(f.home, ['documents', 'retry', '--request-id', requestId], offline);
    expect(retry.failure).toMatchObject({ code: 'snapshot_not_found', mutation_outcome: 'not_submitted' });
    expect(offline).not.toHaveBeenCalled();
  });

  it('checks the captured GUI account before opening a file or submitting bytes', async () => {
    const f = setup(); unlinkSync(f.file); const fetch = vi.fn();
    const outcome = await run(f.home, [...uploadArgs(f.file), '--expected-authority', 'https://authority.example', '--expected-membership-id', 'mem_00000000-0000-4000-8000-000000000002'], fetch);
    expect(outcome.failure).toMatchObject({ code: 'stale_access_state', mutation_outcome: 'not_submitted' }); expect(fetch).not.toHaveBeenCalled();
  });

  it('retains a submitted snapshot and withholds its receipt after an account switch', async () => {
    const f = setup();
    const outcome = await run(f.home, uploadArgs(f.file), async (_url, init) => {
      await consume(init); const stored = f.store.read();
      f.store.install(stored.authority_origin, stored.authority_id, { ...stored.session, membership_id: 'mem_00000000-0000-4000-8000-000000000002' });
      return json(f.receipt, 201);
    });
    expect(outcome.stdout).toBe(''); expect(outcome.failure).toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown' });
    const root = join(f.home, '.local/share/echo-brain/person/document-snapshots'); expect(existsSync(join(root, readdirSync(root)[0]!, requestId))).toBe(true);
  });

  it('treats interrupted original downloads as failures without publishing partial bytes', async () => {
    const f = setup(); const out = join(f.home, 'download.md');
    const outcome = await run(f.home, ['documents', 'download', '--document-id', documentId, '--out', out], async url => {
      if (!String(url).endsWith('/original')) return json(f.metadata);
      let part = 0;
      return new Response(new ReadableStream({ pull(controller) { if (part++ === 0) controller.enqueue(f.bytes.subarray(0, 10)); else controller.error(new Error('private transport diagnostic')); } }),
        { headers: { 'content-type': 'text/markdown', 'content-length': String(f.bytes.length), 'x-echo-document-sha256': f.upload.sha256 } });
    });
    expect(outcome.code).not.toBe(0); expect(outcome.stderr).not.toContain('private transport'); expect(existsSync(out)).toBe(false);
    expect(readdirSync(f.home).some(name => name.startsWith('.echo-document-'))).toBe(false);
  });

  it('rejects changed coordinates on an uncertain request before retrying network', async () => {
    const f = setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { await consume(init); throw new Error('lost'); });
    await run(f.home, uploadArgs(f.file), fetch);
    const args = uploadArgs(f.file); args[args.indexOf('--title') + 1] = 'Changed title';
    const second = await run(f.home, args, fetch);
    expect(second.failure).toMatchObject({ code: 'snapshot_conflict', mutation_outcome: 'not_submitted' }); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['title', 'sha256', 'audience', 'extra'])('withholds mismatched or malformed upload receipt %s as unknown', async field => {
    const f = setup();
    const change = field === 'sha256' ? `sha256:${'b'.repeat(64)}` : field === 'audience' ? { kind: 'team' } : 'wrong';
    const outcome = await run(f.home, uploadArgs(f.file), async (_url, init) => { await consume(init); return json({ ...f.receipt, [field]: change }, 201); });
    expect(outcome.stdout).toBe(''); expect(outcome.failure).toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown' });
  });

  it('accepts the exact 25 MiB limit while rejecting limit+1 before network', async () => {
    const f = setup(); truncateSync(f.file, PERSON_DOCUMENT_MAX_ORIGINAL_BYTES);
    let sent = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const meta = JSON.parse(Buffer.from(new Headers(init?.headers).get('x-echo-document-metadata')!, 'base64url').toString());
      for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) { sent += chunk.byteLength; expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024); }
      return json({ ...f.receipt, ...meta, kind: 'echo-person-document-receipt-v1' }, 201);
    });
    expect((await run(f.home, uploadArgs(f.file), fetch)).code).toBe(0); expect(sent).toBe(PERSON_DOCUMENT_MAX_ORIGINAL_BYTES);
    truncateSync(f.file, PERSON_DOCUMENT_MAX_ORIGINAL_BYTES + 1);
    expect((await run(f.home, uploadArgs(f.file), fetch)).failure).toMatchObject({ code: 'invalid_file' }); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'directory', 'symlink', 'legacy'])('rejects %s input before network', async kind => {
    const f = setup(); let path = f.file;
    if (kind === 'empty') truncateSync(path, 0);
    if (kind === 'directory') path = f.home;
    if (kind === 'symlink') { path = join(f.home, 'link.md'); symlinkSync(f.file, path); }
    if (kind === 'legacy') { path = join(f.home, 'old.doc'); writeFileSync(path, 'legacy'); }
    const fetch = vi.fn(); const outcome = await run(f.home, uploadArgs(path), fetch);
    expect(outcome.code).not.toBe(0); expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps association and audience independent and carries Unicode metadata in ASCII-safe headers', async () => {
    const f = setup(); const args = uploadArgs(f.file); args[args.indexOf('--title') + 1] = '机器人 PRD'; args.push('--project-id', projectId);
    const outcome = await run(f.home, args, async (_url, init) => {
      const encoded = new Headers(init?.headers).get('x-echo-document-metadata')!; expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      const meta = JSON.parse(Buffer.from(encoded, 'base64url').toString()); expect(meta.title).toBe('机器人 PRD'); expect(meta.audience).toEqual({ kind: 'only_me' }); expect(meta.project_id).toBe(projectId);
      await consume(init); return json({ ...f.receipt, ...meta, kind: 'echo-person-document-receipt-v1' }, 201);
    }); expect(outcome.code, outcome.stderr).toBe(0);
  });

  it('lists documents with empty query and reads metadata plus provenance-bound text pages', async () => {
    const f = setup();
    const list = await run(f.home, ['documents', 'search', '--project-id', projectId], async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ project_id: projectId, query: '', limit: 10, cursor: null });
      return json({ schema_version: 1, kind: 'echo-person-document-search-result-v1', documents: [], next_cursor: null });
    }); expect(list.code).toBe(0);
    const page = { schema_version: 1, kind: 'echo-person-document-text-v1', document_id: documentId, original_sha256: f.upload.sha256,
      extractor: 'fixture-v1', extraction_state: 'ready', chunks: [{ ordinal: 0, anchor_kind: 'paragraph', anchor_start: 1, text: 'Robot requirements' }], next_cursor: 'bmV4dA' };
    const read = await run(f.home, ['documents', 'read', '--document-id', documentId, '--project-id', projectId], async url => {
      expect(new URL(String(url)).searchParams.get('project_id')).toBe(projectId);
      return json(new URL(String(url)).pathname.endsWith('/text') ? page : { ...f.metadata, extractor: 'fixture-v1', extraction_state: 'ready', extracted_text_bytes: 18 });
    }); expect(read.code, read.stderr).toBe(0); expect(read.result).toEqual({ ok: true, result: { metadata: { ...f.metadata, extractor: 'fixture-v1', extraction_state: 'ready', extracted_text_bytes: 18 }, text: page } });
  });

  it('searches V2 documents through the V2 endpoint and preserves projects audience', async () => {
    const f = setup();
    const metadata = { schema_version: 2, kind: 'echo-person-document-metadata-v2', request_id: requestId, filename: 'SCOUT.md', title: 'SCOUT PRD', content_length: f.bytes.length, sha256: f.upload.sha256,
      audience: { kind: 'projects', project_ids: [projectId] }, association_project_ids: [projectId], document_id: documentId, detected_media_type: 'text/markdown', received_at: NOW, state: 'saved', extraction_state: 'ready', extraction_detail: null, extractor: 'fixture-v2', extracted_text_bytes: 18 };
    const outcome = await run(f.home, ['documents', 'search-v2', '--project-id', projectId, '--query', 'SCOUT'], async (url, init) => {
      expect(String(url)).toBe('https://authority.example/v2/person/documents/search');
      expect(JSON.parse(String(init?.body))).toEqual({ schema_version: 2, kind: 'echo-person-document-search-v2', project_id: projectId, query: 'SCOUT', limit: 10, cursor: null });
      return json({ schema_version: 2, kind: 'echo-person-document-search-result-v2', documents: [{ ...metadata, excerpt: 'Robot requirements', anchor: { kind: 'paragraph', start: 1 } }], next_cursor: null });
    });
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.result).toMatchObject({ ok: true, result: { documents: [{ audience: { kind: 'projects', project_ids: [projectId] } }] } });
  });

  it('reconciles extraction completion between metadata and text reads without losing provenance', async () => {
    const f = setup(); let reads = 0;
    const ready = { ...f.metadata, extractor: 'fixture-v1', extraction_state: 'ready', extracted_text_bytes: 18 };
    const text = { schema_version: 1, kind: 'echo-person-document-text-v1', document_id: documentId, original_sha256: f.upload.sha256,
      extractor: 'fixture-v1', extraction_state: 'ready', chunks: [{ ordinal: 0, anchor_kind: 'paragraph', anchor_start: 1, text: 'Robot requirements' }], next_cursor: null };
    const result = await run(f.home, ['documents', 'read', '--document-id', documentId], async url => {
      if (String(url).endsWith('/text')) return json(text);
      return json(reads++ === 0 ? f.metadata : ready);
    });
    expect(result.code, result.stderr).toBe(0); expect(reads).toBe(2);
    expect(result.result).toEqual({ ok: true, result: { metadata: ready, text } });
    const bad = await run(f.home, ['documents', 'read', '--document-id', documentId], async url => json(String(url).endsWith('/text') ? { ...text, original_sha256: `sha256:${'b'.repeat(64)}` } : f.metadata));
    expect(bad.failure).toMatchObject({ code: 'invalid_response' }); expect(bad.stdout).toBe('');
  });

  it('settles a retained request from a minimal saved receipt after project access loss', async () => {
    const f = setup();
    await run(f.home, uploadArgs(f.file), async (_url, init) => { await consume(init); throw new Error('lost'); });
    const saved = { schema_version: 1, kind: 'echo-person-document-saved-v1', request_id: requestId, document_id: documentId, received_at: NOW, state: 'saved' };
    const result = await run(f.home, ['documents', 'status', '--request-id', requestId], async () => json(saved));
    expect(result.code, result.stderr).toBe(0); expect(result.result).toEqual({ ok: true, result: saved });
    expect((await run(f.home, ['documents', 'pending'], vi.fn())).result).toMatchObject({ ok: true, result: { snapshots: [] } });
  });

  it.each(['associate', 'dissociate'])('binds a document %s mutation to its exact request and unchanged audience', async operation => {
    const f = setup(); const args = ['documents', operation, '--request-id', requestId, '--document-id', documentId, '--project-id', projectId];
    const receipt = { schema_version: 1, kind: 'echo-person-document-association-receipt-v1', request_id: requestId,
      document_id: documentId, project_id: projectId, operation, received_at: NOW, state: 'applied' };
    const sent: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://authority.example/v1/person/documents/${documentId}/${operation}`);
      expect(init?.method).toBe('POST'); const body = JSON.parse(String(init?.body)); sent.push(body);
      expect(body).toEqual({ schema_version: 1, kind: `echo-person-document-${operation}-v1`, request_id: requestId, document_id: documentId, project_id: projectId });
      if (sent.length === 1) throw new Error('lost');
      return json(receipt);
    });
    expect((await run(f.home, args, fetch)).failure).toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown', request_id: requestId });
    expect((await run(f.home, args, fetch)).result).toEqual({ ok: true, result: receipt }); expect(sent[0]).toEqual(sent[1]);
    const mismatch = await run(f.home, args, async () => json({ ...receipt, document_id: `doc_${'b'.repeat(64)}` }));
    expect(mismatch.failure).toMatchObject({ code: 'outcome_unknown' });
    const offline = vi.fn();
    const stale = await run(f.home, [...args, '--expected-authority', 'https://authority.example', '--expected-membership-id', 'mem_other'], offline);
    expect(stale.failure).toMatchObject({ code: 'stale_access_state', mutation_outcome: 'not_submitted' }); expect(offline).not.toHaveBeenCalled();
  });

  it('does not count interrupted preparation directories against the retained-request limit', async () => {
    const f = setup();
    await run(f.home, uploadArgs(f.file), async (_url, init) => { await consume(init); throw new Error('lost'); });
    const root = join(f.home, '.local/share/echo-brain/person/document-snapshots'); const account = join(root, readdirSync(root)[0]!);
    for (let index = 0; index < 10; index++) mkdirSync(join(account, `.preparing-fixture-${index}`), { mode: 0o700 });
    const nextId = '10000000-0000-4000-8000-000000000002'; const args = uploadArgs(f.file); args[args.indexOf('--request-id') + 1] = nextId;
    const result = await run(f.home, args, async (_url, init) => { await consume(init); return json({ ...f.receipt, request_id: nextId }, 201); });
    expect(result.code, result.stderr).toBe(0);
  });

  it('downloads exact bytes to a new atomic file and prints only byte/hash proof', async () => {
    const f = setup(); const out = join(f.home, 'download.md');
    const outcome = await run(f.home, ['documents', 'download', '--document-id', documentId, '--out', out, '--project-id', projectId], async url => {
      expect(new URL(String(url)).searchParams.get('project_id')).toBe(projectId);
      return String(url).includes('/original?') ? original(f.bytes) : json(f.metadata);
    });
    expect(outcome.code, outcome.stderr).toBe(0); expect(readFileSync(out)).toEqual(f.bytes);
    expect(outcome.result).toEqual({ ok: true, result: { document_id: documentId, output_path: out, content_length: f.bytes.length, sha256: f.upload.sha256 } });
    expect(outcome.stdout).not.toContain('robot requirements');
  });

  it.each(['hash', 'length', 'truncated', 'wrong-proof', 'existing'])('never publishes a %s download or overwrites an existing file', async kind => {
    const f = setup(); const out = join(f.home, 'download.md');
    if (kind === 'existing') writeFileSync(out, 'keep');
    const outcome = await run(f.home, ['documents', 'download', '--document-id', documentId, '--out', out], async url => {
      if (!String(url).endsWith('/original')) return json(f.metadata);
      if (kind === 'wrong-proof') return original(f.bytes, `sha256:${'b'.repeat(64)}`);
      const bytes = kind === 'hash' ? Buffer.alloc(f.bytes.length, 65) : kind === 'length' ? Buffer.concat([f.bytes, Buffer.from('!')]) : kind === 'truncated' ? f.bytes.subarray(1) : f.bytes;
      return new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'text/markdown', 'content-length': String(f.bytes.length), 'x-echo-document-sha256': f.upload.sha256 } });
    });
    expect(outcome.code).not.toBe(0); expect(outcome.stdout).toBe(''); expect(existsSync(out)).toBe(kind === 'existing');
    if (kind === 'existing') expect(readFileSync(out, 'utf8')).toBe('keep');
    expect(readdirSync(f.home).some(name => name.startsWith('.echo-document-'))).toBe(false);
  });

  it('withholds a download when the signed-in identity changes before file publication', async () => {
    const f = setup(); const out = join(f.home, 'download.md');
    const outcome = await run(f.home, ['documents', 'download', '--document-id', documentId, '--out', out], async url => {
      if (!String(url).endsWith('/original')) return json(f.metadata);
      const stored = f.store.read();
      f.store.install(stored.authority_origin, stored.authority_id, { ...stored.session, membership_id: 'mem_00000000-0000-4000-8000-000000000002' });
      return original(f.bytes);
    }); expect(outcome.code).not.toBe(0); expect(existsSync(out)).toBe(false);
  });

  it('rejects duplicate, unknown, and contradictory document options before sending', async () => {
    const f = setup();
    for (const args of [[...uploadArgs(f.file), '--audience', 'team'], [...uploadArgs(f.file), '--audience-project-id', projectId],
      ['documents', 'read', '--document-id', '../../secret'], ['documents', 'search', '--limit', '21'], ['documents', 'search', '--query', '界'.repeat(67)]]) {
      const fetch = vi.fn(); const outcome = await run(f.home, args, fetch); expect(outcome.code).not.toBe(0); expect(fetch).not.toHaveBeenCalled();
    }
  });
});
