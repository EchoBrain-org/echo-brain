import { createHash } from 'node:crypto';
import { pdf, styledWordPdf, zip, entries } from './document-extraction-fixtures.js';
import { describe, expect, it } from 'vitest';
import { createDocumentExtractor, extractDocument, DOCUMENT_EXTRACTION_LIMITS } from '../src/adapters/documents/document-extraction.js';

function input(bytes: Buffer, filename: string) {
  return { bytes, filename, sourceSha256: createHash('sha256').update(bytes).digest('hex') };
}


describe('bounded isolated document extraction', () => {
  it('extracts text beyond 8KiB byte-exactly and preserves stable paragraph anchors', async () => {
    const text = `MRD\n${'SCOUT courier robot. '.repeat(700)}\nPRD-END-ROBOT`;
    const result = await extractDocument(input(Buffer.from(text), 'SCOUT.md'));
    expect(result.status).toBe('ready'); expect(result.chunks.map((c) => c.text).join('')).toBe(text);
    expect(result.chunks.at(-1)?.anchor_start).toBe(3); expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.extractorVersion).toContain('pdfjs-6.3.289');
  });
  it('extracts a real PDF with page anchors through PDF.js', async () => {
    const result = await extractDocument(input(pdf('SCOUT hardware software QA'), 'SCOUT.pdf'));
    expect(result.status).toBe('ready'); expect(result.mediaType).toBe('application/pdf');
    expect(result.chunks.map((c) => c.text).join('')).toContain('SCOUT hardware software QA');
    expect(result.chunks[0]).toMatchObject({ anchor_kind: 'page', anchor_start: 1 });
  });
  it('preserves CR-only UTF-8 lines', async () => {
    const text = 'Alpha\rHardware acceptance\rOmega';
    const plain = await extractDocument(input(Buffer.from(text), 'acceptance.txt'));
    expect(plain.status).toBe('ready');
    expect(plain.chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(plain.chunks.map((chunk) => chunk.anchor_start)).toEqual([1, 2, 3]);
  });
  it('preserves contiguous PDF style runs as one word', async () => {
    const styled = await extractDocument(input(styledWordPdf(), 'styled.pdf'));
    expect(styled.status).toBe('ready');
    expect(styled.chunks.map((chunk) => chunk.text).join('').trim()).toBe('hardware');
  });
  it('extracts a real zipped Word document with paragraph anchors through Mammoth', async () => {
    const result = await extractDocument(input(zip(entries(['SCOUT kickoff', 'Hardware & software requirements', 'PRD-END-ROBOT'])), 'SCOUT.docx'));
    expect(result.status).toBe('ready'); expect(result.chunks.map((c) => c.text).join('')).toContain('Hardware & software requirements');
    expect(result.chunks.at(-1)).toMatchObject({ anchor_kind: 'paragraph', anchor_start: 3 });
  });
  it('reports image-only/blank PDF text as no_text and a blank Word document likewise', async () => {
    expect((await extractDocument(input(pdf(''), 'blank.pdf'))).status).toBe('no_text');
    expect((await extractDocument(input(zip(entries([])), 'blank.docx'))).status).toBe('no_text');
  });
  it('truncates Unicode only at complete UTF-8 boundaries and marks partial', async () => {
    const result = await createDocumentExtractor({ textBytes: 31, chunkBytes: 12 })(input(Buffer.from('🙂'.repeat(100)), 'unicode.txt'));
    expect(result.status).toBe('partial'); expect(result.chunks.map((c) => c.text).join('')).toBe('🙂'.repeat(7));
    expect(result.chunks.every((c) => Buffer.byteLength(c.text) <= 12)).toBe(true);
    expect(result.message).toContain('extracted-text byte limit');
  });
  it('keeps ordinary search words whole at chunk boundaries while preserving exact text', async () => {
    const text = 'a '.repeat(1534) + 'hardware requirements';
    const result = await extractDocument(input(Buffer.from(text), 'boundary.txt'));
    expect(result.status).toBe('ready');
    expect(result.chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(result.chunks.some((chunk) => chunk.text.includes('hardware'))).toBe(true);
    expect(result.chunks.every((chunk) => Buffer.byteLength(chunk.text) <= 3072)).toBe(true);
  });
  it('marks PDF page and extracted chunk limits partial with retained anchored text', async () => {
    const pages = await createDocumentExtractor({ pdfPages: 1 })(input(pdf('Robot', 2), 'pages.pdf'));
    expect(pages.status).toBe('partial'); expect(pages.chunks.every((c) => c.anchor_start === 1)).toBe(true);
    expect(pages.message).toContain('PDF page limit');
    const chunks = await createDocumentExtractor({ chunks: 2 })(input(Buffer.from('one\ntwo\nthree'), 'many.txt'));
    expect(chunks.status).toBe('partial'); expect(chunks.chunks).toHaveLength(2);
    expect(chunks.message).toContain('extracted-text chunk limit');
  });
  it('rejects invalid UTF-8, NUL, MIME mismatch, malformed PDF, and unsupported legacy Word', async () => {
    for (const [bytes, filename] of [[Buffer.from([0xff]), 'x.txt'], [Buffer.from('x\0y'), 'x.md'], [Buffer.from('not a PDF'), 'x.pdf'], [Buffer.from('%PDF-1.7 garbage'), 'x.pdf'], [Buffer.from('garbage'), 'x.docx']] as const) {
      expect((await extractDocument(input(bytes, filename))).status).toBe('malformed');
    }
    expect((await extractDocument(input(Buffer.from('old Word'), 'x.doc'))).status).toBe('unsupported');
  });
  it('verifies source hash before parsing and rejects excessive original bytes before spawning', async () => {
    expect((await extractDocument({ ...input(Buffer.from('hello'), 'x.txt'), sourceSha256: '0'.repeat(64) })).status).toBe('malformed');
    expect((await createDocumentExtractor({ originalBytes: 4 })(input(Buffer.from('hello'), 'x.txt'))).status).toBe('limit_exceeded');
    expect(DOCUMENT_EXTRACTION_LIMITS.originalBytes).toBe(26_214_400);
  });
  it('preflights archive metadata count and claimed expanded size before invoking Word parser', async () => {
    const bytes = zip(entries(['hello']));
    expect((await createDocumentExtractor({ zipEntries: 2 })(input(bytes, 'x.docx'))).status).toBe('limit_exceeded');
    expect((await createDocumentExtractor({ zipExpandedBytes: 10 })(input(bytes, 'x.docx'))).status).toBe('limit_exceeded');
  });
  it('rejects actual expansion beyond declared lengths, duplicate paths, traversal, CRC corruption and XML entities', async () => {
    const cases = [
      [...entries(['hi']), { name: 'word/bomb.bin', value: 'x'.repeat(10000), claimedSize: 1 }],
      [...entries(['hi']), { name: 'word/document.xml', value: 'duplicate' }],
      [...entries(['hi']), { name: '../outside.xml', value: 'outside' }],
      [...entries(['hi']), { name: 'word/corrupt.bin', value: 'hello', crc: 0 }],
      [...entries(['hi']), { name: 'word/evil.xml', value: '<!DOCTYPE x [<!ENTITY xx SYSTEM "file:///etc/passwd">]><x>&xx;</x>' }],
    ];
    for (const entry of cases) expect((await extractDocument(input(zip(entry), 'x.docx'))).status).toBe('malformed');
  });
  it('reports password-encrypted real PDF explicitly', async () => {
    // Synthetic one-page PDF encrypted with a test-only password using pypdf.
    const encoded = 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDFjZDA4NzQ4MDM+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAxMDAgMTAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YWJhNjE5NGY5ODI5ZWRhOTM3MTk0NDJjMjE5NTUwMTU3ZWQwNTBjMDRhZjRiYWMyZTEwOTkyMzY2MDcyZGU0MD4KL1UgPDkxNjIzNzA4YmJlMzAxNDg3OWY4Y2RmYzcxM2ZjNWEwMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDMwMzkzNTMzMzE2NjYzMzg2MTM3MzAzMTYzMzczMDYyMzc2MzM3MzIzMzMwMzAzNjM4MzUzNjMyMzYzODY0NjM+IDwzMDM5MzUzMzMxNjY2MzM4NjEzNzMwMzE2MzM3MzA2MjM3NjMzNzMyMzMzMDMwMzYzODM1MzYzMjM2Mzg2NDYzPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK';
    expect((await extractDocument(input(Buffer.from(encoded, 'base64'), 'locked.pdf'))).status).toBe('encrypted');
  });
  it('rejects central-directory count disagreement before the second ZIP parser sees hidden entries', async () => {
    const bytes = zip(entries(['hello']));
    bytes.writeUInt16LE(1, bytes.length - 22 + 8); bytes.writeUInt16LE(1, bytes.length - 22 + 10);
    expect((await extractDocument(input(bytes, 'x.docx'))).status).toBe('malformed');
  });
  it('accepts prefixed service hashes and .markdown filenames', async () => {
    const value = input(Buffer.from('SCOUT'), 'SCOUT.markdown');
    expect((await extractDocument({ ...value, sourceSha256: `sha256:${value.sourceSha256}` })).status).toBe('ready');
  });
  it('reports encrypted ZIP and encrypted Office containers explicitly', async () => {
    const encryptedZip = zip(entries(['hello']).map((entry) => ({ ...entry, flags: 1 })));
    expect((await extractDocument(input(encryptedZip, 'locked.docx'))).status).toBe('encrypted');
    expect((await extractDocument(input(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'locked.docx'))).status).toBe('encrypted');
  });
  it('terminates timed-out worker and permits a subsequent healthy extraction', async () => {
    expect((await createDocumentExtractor({ timeoutMs: 1 })(input(pdf('Robot'), 'x.pdf'))).status).toBe('timed_out');
    expect((await extractDocument(input(Buffer.from('alive'), 'x.txt'))).status).toBe('ready');
  });
  it('terminates active extraction on cancellation and serializes bounded worker admission', async () => {
    const controller = new AbortController();
    const active = extractDocument(input(pdf('Robot', 50), 'x.pdf'), controller.signal);
    setTimeout(() => controller.abort(), 2);
    expect((await active).status).toBe('unavailable');
    const job = input(Buffer.from('hello'), 'x.txt');
    const first = extractDocument(job); const second = extractDocument(job); const third = extractDocument(job);
    expect((await third).status).toBe('unavailable'); expect((await first).status).toBe('ready'); expect((await second).status).toBe('ready');
  });
});
