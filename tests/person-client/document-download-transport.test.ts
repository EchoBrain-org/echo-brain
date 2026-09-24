import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDocumentDownload } from '../../src/product/person-client/document-file.js';

const bytes = Buffer.from('Synthetic document transport fixture.\n'.repeat(300));
const expected = {
  content_length: bytes.length,
  sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  detected_media_type: 'text/plain',
};
const servers: Server[] = [];
const directories: string[] = [];

async function response(body: Buffer, encoding: 'br' | 'gzip' | null, length: boolean) {
  const wire = encoding === 'br' ? brotliCompressSync(body) : encoding === 'gzip' ? gzipSync(body) : body;
  const server = createServer((_request, reply) => {
    reply.setHeader('content-type', expected.detected_media_type);
    reply.setHeader('x-echo-document-sha256', expected.sha256);
    if (encoding) reply.setHeader('content-encoding', encoding);
    if (length) reply.setHeader('content-length', wire.length);
    reply.write(wire);
    reply.end();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
  return fetch(`http://127.0.0.1:${address.port}/original`);
}

function output() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-download-transport-'));
  directories.push(directory);
  return join(directory, 'original.txt');
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('document downloads through HTTP content encoding', () => {
  it.each([
    { encoding: 'br' as const, length: false },
    { encoding: 'br' as const, length: true },
    { encoding: 'gzip' as const, length: true },
    { encoding: null, length: false },
    { encoding: null, length: true },
  ])('verifies decoded bytes with $encoding encoding and Content-Length=$length', async ({ encoding, length }) => {
    const fetched = await response(bytes, encoding, length);
    if (!length) expect(fetched.headers.get('content-length')).toBeNull();
    if (encoding && length) expect(fetched.headers.get('content-length')).not.toBe(String(bytes.length));
    const out = output();
    let published = false;
    await saveDocumentDownload(fetched, out, expected, () => { published = true; });
    expect(published).toBe(true);
    expect(readFileSync(out)).toEqual(bytes);
  });

  it.each(['truncated', 'oversized', 'corrupt'] as const)('rejects a %s decoded body without publishing it', async kind => {
    const bad = kind === 'truncated' ? bytes.subarray(1) : kind === 'oversized' ? Buffer.concat([bytes, Buffer.from('!')]) : Buffer.alloc(bytes.length, 65);
    const fetched = await response(bad, 'br', false);
    const out = output();
    await expect(saveDocumentDownload(fetched, out, expected, () => { throw new Error('Must not publish'); })).rejects.toMatchObject({ code: 'invalid_download' });
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(directories.at(-1)!)).toEqual([]);
  });
});
