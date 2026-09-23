import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PERSON_DOCUMENT_MAX_ORIGINAL_BYTES, assertPersonDocumentOriginalV1,
  detectPersonDocumentMediaTypeV1, validatePersonDocumentUploadMetadataV1,
} from '../src/person-documents-v1.js';

const bytes = new TextEncoder().encode(`# SCOUT PRD\n${'robot requirement\n'.repeat(700)}`);
function metadata(overrides: Record<string, unknown> = {}) {
  return { schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: '12345678-1234-4123-8123-123456789abc', filename: 'SCOUT-PRD.md', title: 'SCOUT PRD', content_length: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, audience: { kind: 'team' }, project_id: null, ...overrides };
}

describe('person document V1', () => {
  it('accepts a UTF-8 Markdown original larger than the legacy 8 KiB bound', () => {
    expect(bytes.length).toBeGreaterThan(8192);
    const value = validatePersonDocumentUploadMetadataV1(metadata());
    expect(assertPersonDocumentOriginalV1(value, bytes)).toBe('text/markdown');
  });
  it('checks the exact 25 MiB boundary before content detection', () => {
    const exact = new Uint8Array(PERSON_DOCUMENT_MAX_ORIGINAL_BYTES); exact.fill(0x61);
    expect(detectPersonDocumentMediaTypeV1(exact, 'large.txt')).toBe('text/plain');
    expect(() => detectPersonDocumentMediaTypeV1(new Uint8Array(PERSON_DOCUMENT_MAX_ORIGINAL_BYTES + 1), 'large.txt')).toThrow(/size/);
  });
  it('requires supported filename and content to agree and rejects arbitrary ZIP bytes', () => {
    expect(detectPersonDocumentMediaTypeV1(new TextEncoder().encode('%PDF-1.7\n'), 'correct.pdf')).toBe('application/pdf');
    expect(() => detectPersonDocumentMediaTypeV1(new TextEncoder().encode('%PDF-1.7\n'), 'wrong.txt')).toThrow(/filename/);
    expect(() => detectPersonDocumentMediaTypeV1(Uint8Array.from([0x50,0x4b,3,4,0,0]), 'wrong.docx')).toThrow(/Word document container/);
  });
  it('rejects legacy doc, invalid UTF-8, mismatch, and changed bytes', () => {
    expect(() => detectPersonDocumentMediaTypeV1(new TextEncoder().encode('legacy'), 'legacy.doc')).toThrow(/unsupported/);
    expect(() => detectPersonDocumentMediaTypeV1(Uint8Array.from([0xc3, 0x28]), 'bad.txt')).toThrow();
    const value = validatePersonDocumentUploadMetadataV1(metadata());
    expect(() => assertPersonDocumentOriginalV1(value, new TextEncoder().encode('changed'))).toThrow(/length/);
    expect(() => assertPersonDocumentOriginalV1(validatePersonDocumentUploadMetadataV1(metadata({ sha256: `sha256:${'0'.repeat(64)}` })), bytes)).toThrow(/SHA-256/);
  });
  it('keeps audience and association independent', () => {
    const project = 'prj_00000000-0000-4000-8000-000000000002';
    expect(validatePersonDocumentUploadMetadataV1(metadata({ audience: { kind: 'only_me' }, project_id: project })).project_id).toBe(project);
  });
});

describe('document metadata rejection boundaries', () => {
  it('rejects path filenames, control characters, noncanonical identity and extra fields', () => {
    for (const filename of ['../MRD.md', 'folder/MRD.md', 'folder\\MRD.md', 'bad\nname.md']) expect(() => validatePersonDocumentUploadMetadataV1(metadata({filename}))).toThrow();
    expect(() => validatePersonDocumentUploadMetadataV1(metadata({request_id:'not-a-uuid'}))).toThrow();
    expect(() => validatePersonDocumentUploadMetadataV1(metadata({extra:'ignored'}))).toThrow();
  });
  it('accepts ordinary Unicode basenames and independently selected project audience', () => {
    const project='prj_00000000-0000-4000-8000-000000000002';
    expect(validatePersonDocumentUploadMetadataV1(metadata({filename:'机器人-PRD.md', audience:{kind:'project',project_id:project},project_id:null}))).toMatchObject({filename:'机器人-PRD.md',project_id:null});
  });
});
