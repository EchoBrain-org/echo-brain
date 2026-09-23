import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PERSON_DOCUMENT_MAX_ORIGINAL_BYTES, PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS, PERSON_DOCUMENT_TRANSFER_IDLE_TIMEOUT_MS, assertPersonDocumentOriginalV1,
  detectPersonDocumentMediaTypeV1, validatePersonDocumentTextV1, validatePersonDocumentUploadMetadataV1, validatePersonDocumentSavedV1, validatePersonDocumentUploadResultV1, validatePersonDocumentStatusV1,
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
  it('accepts UTF-8 text beginning with PK when it is not a ZIP local-file signature', () => {
    expect(detectPersonDocumentMediaTypeV1(new TextEncoder().encode('PKCE flow notes'), 'pkce-notes.md')).toBe('text/markdown');
    expect(detectPersonDocumentMediaTypeV1(new TextEncoder().encode('PKI rollout plan'), 'pki.txt')).toBe('text/plain');
  });
  it('publishes and enforces the shared extracted-text chunk bound', () => {
    const text = { schema_version: 1, kind: 'echo-person-document-text-v1', document_id: `doc_${'a'.repeat(64)}`, original_sha256: `sha256:${'b'.repeat(64)}`, extractor: 'fixture', extraction_state: 'ready', chunks: [{ ordinal: 0, anchor_kind: 'paragraph', anchor_start: 1, text: 'a'.repeat(PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES) }], next_cursor: null };
    expect(PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES).toBe(3072);
    expect(validatePersonDocumentTextV1(text)).toEqual(text);
    expect(() => validatePersonDocumentTextV1({ ...text, chunks: [{ ...text.chunks[0], text: 'a'.repeat(PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES + 1) }] })).toThrow(/chunk/);
  });
  it('publishes bounded document-transfer timing policy', () => {
    expect(PERSON_DOCUMENT_TRANSFER_DEADLINE_MS).toBe(10 * 60 * 1000);
    expect(PERSON_DOCUMENT_TRANSFER_IDLE_TIMEOUT_MS).toBe(60 * 1000);
    expect(PERSON_DOCUMENT_TRANSFER_IDLE_TIMEOUT_MS).toBeLessThan(PERSON_DOCUMENT_TRANSFER_DEADLINE_MS);
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


describe('minimal document admission proof',()=>{
  it('accepts the same strict minimal object for upload replay and status, never retained metadata',()=>{
    const value={schema_version:1,kind:'echo-person-document-saved-v1',request_id:'12345678-1234-4123-8123-123456789abc',document_id:`doc_${'a'.repeat(64)}`,received_at:'2026-09-21T22:01:00.000Z',state:'saved'};
    expect(validatePersonDocumentUploadResultV1(value)).toEqual(value);expect(validatePersonDocumentStatusV1(value)).toEqual(value);
    for(const extra of [{title:'private'},{audience:{kind:'team'}},{project_id:null},{sha256:`sha256:${'b'.repeat(64)}`}])expect(()=>validatePersonDocumentSavedV1({...value,...extra})).toThrow();
    expect(()=>validatePersonDocumentSavedV1({...value,request_id:'wrong'})).toThrow();expect(()=>validatePersonDocumentSavedV1({...value,document_id:'doc_wrong'})).toThrow();expect(()=>validatePersonDocumentSavedV1({...value,schema_version:2})).toThrow();
  });
});
