import { describe, expect, it } from 'vitest';
import { validatePersonDocumentSearchV2, validatePersonDocumentUploadMetadataV2, validatePersonUpdateReceiptV3, validatePersonUpdateSubmitV3, validateProjectContextFeedV2 } from '../src/index.js';

const first = 'prj_00000000-0000-4000-8000-000000000001';
const second = 'prj_00000000-0000-4000-8000-000000000002';
const request_id = '00000000-0000-4000-8000-000000000003';
const associations = [first, second];
const audience = { kind: 'projects', project_ids: associations };

describe('multi-project Person upload contracts', () => {
  it('accepts independent canonical association and projects-audience sets', () => {
    expect(validatePersonUpdateSubmitV3({ schema_version: 3, kind: 'echo-person-update-submit-v3', request_id, title: 'MRD', text: 'The project starts Tuesday.', association_project_ids: associations, audience })).toMatchObject({ association_project_ids: associations, audience });
    expect(validatePersonDocumentUploadMetadataV2({ schema_version: 2, kind: 'echo-person-document-upload-v2', request_id, filename: 'MRD.md', title: 'MRD', content_length: 28, sha256: `sha256:${'a'.repeat(64)}`, association_project_ids: associations, audience })).toMatchObject({ association_project_ids: associations, audience });
  });

  it('allows a default-private upload with no association', () => {
    expect(validatePersonUpdateSubmitV3({ schema_version: 3, kind: 'echo-person-update-submit-v3', request_id, title: 'Private note', text: 'Keep this private.', association_project_ids: [], audience: { kind: 'only_me' } })).toMatchObject({ association_project_ids: [], audience: { kind: 'only_me' } });
  });

  it('keeps a project view selector separate from the V2 audience union', () => {
    expect(validatePersonDocumentSearchV2({ schema_version: 2, kind: 'echo-person-document-search-v2', project_id: first, query: 'MRD', limit: 10, cursor: null }))
      .toMatchObject({ project_id: first, query: 'MRD' });
    expect(() => validatePersonDocumentSearchV2({ schema_version: 2, kind: 'echo-person-document-search-v2', project_id: first, query: 'MRD', limit: 10, cursor: null, audience })).toThrow();
  });

  it('returns multi-project audience through project V2 rather than counterfeiting it as V1', () => {
    expect(validateProjectContextFeedV2({ schema_version: 2, kind: 'echo-project-context-feed-v2', project_id: first, items: [{
      context_id: `ctx_${'a'.repeat(64)}`, received_at: '2026-09-23T00:00:00.000Z', title: 'MRD', excerpt: 'Project kickoff', audience,
    }], next_cursor: null })).toMatchObject({ items: [{ audience }] });
  });

  it('rejects unsorted, duplicate, oversized, or mismatched receipt sets', () => {
    const base = { schema_version: 3, kind: 'echo-person-update-submit-v3', request_id, title: 'MRD', text: 'The project starts Tuesday.', association_project_ids: associations, audience };
    expect(() => validatePersonUpdateSubmitV3({ ...base, association_project_ids: [second, first] })).toThrow(/sorted/);
    expect(() => validatePersonUpdateSubmitV3({ ...base, audience: { kind: 'projects', project_ids: [first, first] } })).toThrow(/sorted/);
    expect(() => validatePersonUpdateSubmitV3({ ...base, association_project_ids: Array.from({ length: 21 }, (_, index) => `prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`) })).toThrow();
    expect(() => validatePersonUpdateReceiptV3({ schema_version: 3, kind: 'echo-person-update-receipt-v3', request_id, context_id: `ctx_${'a'.repeat(64)}`, received_at: '2026-09-23T00:00:00.000Z', association_project_ids: associations, audience, state: 'received', extra: true })).toThrow();
  });
});
