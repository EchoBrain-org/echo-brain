import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PERSON_DOCUMENT_MAX_ORIGINAL_BYTES, PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS, PERSON_DOCUMENT_TRANSFER_IDLE_TIMEOUT_MS, assertPersonDocumentOriginalV1,
  detectPersonDocumentMediaTypeV1,
  validatePersonDocumentUploadMetadataV2, validatePersonDocumentSavedV2, validatePersonDocumentUploadResultV2, validatePersonDocumentStatusV2,
  validatePersonDocumentMetadataV2, validatePersonDocumentSearchV2, validatePersonDocumentSearchResultV2,
} from '../src/person-documents-v1.js';

const bytes = new TextEncoder().encode(`# SCOUT PRD\n${'robot requirement\n'.repeat(700)}`);
function metadata(overrides: Record<string, unknown> = {}) {
  return { schema_version: 2, kind: 'echo-person-document-upload-v2', request_id: '12345678-1234-4123-8123-123456789abc', filename: 'SCOUT-PRD.md', title: 'SCOUT PRD', content_length: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, audience: { kind: 'team' }, association_project_ids: [], ...overrides };
}

describe('person document originals', () => {
  it('accepts a UTF-8 Markdown original larger than the legacy 8 KiB bound', () => {
    expect(bytes.length).toBeGreaterThan(8192);
    const value = validatePersonDocumentUploadMetadataV2(metadata());
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
  it('publishes the shared extracted-text chunk bound', () => {
    expect(PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES).toBe(3072);
  });
  it('publishes bounded document-transfer timing policy', () => {
    expect(PERSON_DOCUMENT_TRANSFER_DEADLINE_MS).toBe(10 * 60 * 1000);
    expect(PERSON_DOCUMENT_TRANSFER_IDLE_TIMEOUT_MS).toBe(60 * 1000);
    expect(PERSON_DOCUMENT_TRANSFER_IDLE_TIMEOUT_MS).toBeLessThan(PERSON_DOCUMENT_TRANSFER_DEADLINE_MS);
  });
  it('rejects legacy doc, invalid UTF-8, mismatch, and changed bytes', () => {
    expect(() => detectPersonDocumentMediaTypeV1(new TextEncoder().encode('legacy'), 'legacy.doc')).toThrow(/unsupported/);
    expect(() => detectPersonDocumentMediaTypeV1(Uint8Array.from([0xc3, 0x28]), 'bad.txt')).toThrow();
    const value = validatePersonDocumentUploadMetadataV2(metadata());
    expect(() => assertPersonDocumentOriginalV1(value, new TextEncoder().encode('changed'))).toThrow(/length/);
    expect(() => assertPersonDocumentOriginalV1(validatePersonDocumentUploadMetadataV2(metadata({ sha256: `sha256:${'0'.repeat(64)}` })), bytes)).toThrow(/SHA-256/);
  });
  it('keeps audience and association independent', () => {
    const project = 'prj_00000000-0000-4000-8000-000000000002';
    expect(validatePersonDocumentUploadMetadataV2(metadata({ audience: { kind: 'only_me' }, association_project_ids: [project] })).association_project_ids).toEqual([project]);
  });
});

describe('document metadata rejection boundaries', () => {
  it('rejects path filenames, control characters, noncanonical identity, extra fields and a V1 upload', () => {
    for (const filename of ['../MRD.md', 'folder/MRD.md', 'folder\\MRD.md', 'bad\nname.md']) expect(() => validatePersonDocumentUploadMetadataV2(metadata({filename}))).toThrow();
    expect(() => validatePersonDocumentUploadMetadataV2(metadata({request_id:'not-a-uuid'}))).toThrow();
    expect(() => validatePersonDocumentUploadMetadataV2(metadata({extra:'ignored'}))).toThrow();
    const { association_project_ids: _associations, ...v1 } = metadata({ schema_version: 1, kind: 'echo-person-document-upload-v1' });
    expect(() => validatePersonDocumentUploadMetadataV2({ ...v1, project_id: null })).toThrow();
  });
  it('accepts ordinary Unicode basenames and independently selected project audience', () => {
    const project='prj_00000000-0000-4000-8000-000000000002';
    expect(validatePersonDocumentUploadMetadataV2(metadata({filename:'机器人-PRD.md', audience:{kind:'project',project_id:project}}))).toMatchObject({filename:'机器人-PRD.md',association_project_ids:[]});
  });
});


describe('minimal document admission proof',()=>{
  it('accepts the same strict minimal object for upload replay and status, never retained metadata',()=>{
    const value={schema_version:2,kind:'echo-person-document-saved-v2',request_id:'12345678-1234-4123-8123-123456789abc',document_id:`doc_${'a'.repeat(64)}`,received_at:'2026-09-21T22:01:00.000Z',state:'saved'};
    expect(validatePersonDocumentUploadResultV2(value)).toEqual(value);expect(validatePersonDocumentStatusV2(value)).toEqual(value);
    for(const extra of [{title:'private'},{audience:{kind:'team'}},{association_project_ids:[]},{sha256:`sha256:${'b'.repeat(64)}`}])expect(()=>validatePersonDocumentSavedV2({...value,...extra})).toThrow();
    expect(()=>validatePersonDocumentSavedV2({...value,request_id:'wrong'})).toThrow();expect(()=>validatePersonDocumentSavedV2({...value,document_id:'doc_wrong'})).toThrow();expect(()=>validatePersonDocumentSavedV2({...value,schema_version:1,kind:'echo-person-document-saved-v1'})).toThrow();
  });
});

describe('document V2 shared validation', () => {
  const upload = metadata();
  const saved = {
    schema_version: 2, kind: 'echo-person-document-saved-v2',
    request_id: upload.request_id, document_id: `doc_${'a'.repeat(64)}`,
    received_at: '2026-09-21T22:01:00.000Z', state: 'saved',
  };

  it('freezes the upload, keeps the minimal proof identity and normalizes search fields', () => {
    expect(Object.isFrozen(validatePersonDocumentUploadMetadataV2(upload))).toBe(true);
    expect(validatePersonDocumentSavedV2(saved)).toBe(saved);
    const search = { schema_version: 2, kind: 'echo-person-document-search-v2', project_id: null, query: '  café  ', limit: 1, cursor: null };
    expect(validatePersonDocumentSearchV2(search)).toEqual({ ...search, query: 'café' });
    expect(() => validatePersonDocumentUploadMetadataV2({ ...upload, schema_version: 1 })).toThrow();
    expect(() => validatePersonDocumentSavedV2({ ...saved, schema_version: 1 })).toThrow();
    expect(() => validatePersonDocumentSearchV2({ ...search, schema_version: 1, kind: 'echo-person-document-search-v1' })).toThrow();
  });

  it('preserves withheld request IDs and checks metadata, excerpts, anchors and cursor before release', () => {
    const document = {
      ...upload, ...saved, kind: 'echo-person-document-metadata-v2', request_id: null,
      detected_media_type: 'text/markdown', extraction_state: 'ready', extraction_detail: null,
      extractor: 'fixture', extracted_text_bytes: 1,
    };
    expect(validatePersonDocumentMetadataV2(document)).toBe(document);
    const results = {
      schema_version: 2, kind: 'echo-person-document-search-result-v2',
      documents: [{ ...document, excerpt: 'Found text', anchor: { kind: 'paragraph', start: 1 } }], next_cursor: null,
    };
    expect(validatePersonDocumentSearchResultV2(results)).toBe(results);
    // Package errors let the client report a malformed Authority response, not a bad request.
    const apiError = expect.objectContaining({ name: 'OrganizationApiValidationError' });
    for (const invalid of [
      { extraction_detail: '\u0000' }, { extractor: '' }, { extracted_text_bytes: -1 },
      { request_id: 'wrong' }, { received_at: 'not-a-time' },
    ]) expect(() => validatePersonDocumentMetadataV2({ ...document, ...invalid })).toThrow(apiError);
    for (const invalid of [{ excerpt: 'x'.repeat(241) }, { anchor: { kind: 'paragraph', start: 0 } }]) {
      expect(() => validatePersonDocumentSearchResultV2({ ...results, documents: [{ ...results.documents[0], ...invalid }] })).toThrow(apiError);
    }
    expect(() => validatePersonDocumentSearchResultV2({ ...results, next_cursor: 'bad=' })).toThrow(apiError);
  });
});
