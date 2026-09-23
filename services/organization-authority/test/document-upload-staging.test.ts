import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_DOCUMENT_MAX_ORIGINAL_BYTES } from '@echo-brain/organization-api';
import { createPersonDocumentUploadStagingV1 } from '../src/adapters/files/document-upload-staging-v1.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'echo-document-staging-test-')); roots.push(root);
  return { root, stager: createPersonDocumentUploadStagingV1({ temporaryDirectory: root }) };
}
function metadata(bytes: Uint8Array) { return { content_length: bytes.byteLength, sha256: sha256Digest(bytes) }; }
async function* stream(bytes: Uint8Array) { for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024); }

describe('private document upload staging', () => {
  it('preserves bytes over 8 KiB and removes private transient files after success', async () => {
    const f = await fixture(); const bytes = Buffer.from('SCOUT requirements 雪\r\n'.repeat(1024));
    async function* observedStream() {
      yield bytes.subarray(0, 10);
      const names = await readdir(f.root); expect(names).toHaveLength(1);
      const directory = join(f.root, names[0]!);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, 'original'))).mode & 0o777).toBe(0o600);
      yield bytes.subarray(10);
    }
    expect(await f.stager.stage(observedStream(), metadata(bytes))).toEqual(bytes);
    expect(await readdir(f.root)).toEqual([]);
  });
  it('admits the exact original-size boundary and refuses boundary plus one before reading', async () => {
    const f = await fixture(); const bytes = Buffer.alloc(PERSON_DOCUMENT_MAX_ORIGINAL_BYTES, 0x61);
    const staged = await f.stager.stage(stream(bytes), metadata(bytes));
    expect(Buffer.from(staged).equals(bytes)).toBe(true);
    expect(sha256Digest(staged)).toBe(metadata(bytes).sha256);
    let read = false;
    async function* forbiddenStream() { read = true; yield Buffer.from('x'); }
    await expect(f.stager.stage(forbiddenStream(), { ...metadata(bytes), content_length: bytes.length + 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(read).toBe(false); expect(await readdir(f.root)).toEqual([]);
  });
  it.each(['short', 'long', 'digest'] as const)('refuses %s transfers and leaves no admitted or temporary data', async mode => {
    const f = await fixture(); const bytes = Buffer.from('expected');
    const incoming = mode === 'short' ? bytes.subarray(0, 3) : mode === 'long' ? Buffer.concat([bytes, Buffer.from('x')]) : Buffer.from('modified');
    await expect(f.stager.stage(stream(incoming), metadata(bytes))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await readdir(f.root)).toEqual([]);
  });
  it('cleans a partially written transfer when the source aborts', async () => {
    const f = await fixture(); const bytes = Buffer.from('expected');
    async function* aborted() { yield bytes.subarray(0, 3); throw new Error('synthetic stream abort'); }
    await expect(f.stager.stage(aborted(), metadata(bytes))).rejects.toThrow('synthetic stream abort');
    expect(await readdir(f.root)).toEqual([]);
  });
  it('keeps concurrent temporary originals independent', async () => {
    const f = await fixture(); const first = Buffer.from('first'.repeat(4096)); const second = Buffer.from('second'.repeat(4096));
    const result = await Promise.all([f.stager.stage(stream(first), metadata(first)), f.stager.stage(stream(second), metadata(second))]);
    expect(result).toEqual([first, second]); expect(await readdir(f.root)).toEqual([]);
  });
});
