import { describe, expect, it } from 'vitest';
import {
  validatePersonUpdateSubmitV1,
  validatePersonUpdateSubmitV2,
  validatePersonUploadContentV2,
  validatePersonUploadSearchResultV2,
  validateProjectContextAssociateV1,
  validateProjectContextFeedV1,
  validateProjectContextReadV1,
  validateProjectCreateReceiptV1,
  validateProjectCreateV1,
  validateProjectDirectorySearchV1,
  validateProjectMutationReceiptV1,
} from '../src/index.js';

const request_id = '00000000-0000-4000-8000-000000000001';
const project_id = 'prj_00000000-0000-4000-8000-000000000002';
const membership_id = 'mem_00000000-0000-4000-8000-000000000003';
const context_id = `ctx_${'a'.repeat(64)}`;
const received_at = '2026-09-21T00:00:00.000Z';

describe('project context V1 public codecs', () => {
  it('admits a canonical project and immutable receipts without exposing current state', () => {
    expect(validateProjectCreateV1({ schema_version: 1, kind: 'echo-project-create-v1', request_id, name: 'NFC café' }))
      .toEqual({ schema_version: 1, kind: 'echo-project-create-v1', request_id, name: 'NFC café' });
    expect(validateProjectCreateReceiptV1({ schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id, project_id, created_at: received_at, state: 'created' }))
      .toEqual({ schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id, project_id, created_at: received_at, state: 'created' });
    expect(validateProjectMutationReceiptV1({ schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id, project_id, operation: 'member_set', membership_id, received_at, state: 'applied' }))
      .toMatchObject({ operation: 'member_set', membership_id });
  });

  it.each([
    { name: ' cafe' }, { name: 'cafe ' }, { name: 'cafe\nnew' }, { name: 'cafe\u0301' },
    { project_id: 'prj_not-a-uuid' }, { request_id: 'not-a-uuid' }, { name: 'Project', unexpected: true },
  ])('rejects noncanonical project input %j', override => {
    expect(() => validateProjectCreateV1({ schema_version: 1, kind: 'echo-project-create-v1', request_id, name: 'Project', ...override })).toThrow();
  });

  it('makes association a separate idempotent mutation coordinate', () => {
    expect(validateProjectContextAssociateV1({ schema_version: 1, kind: 'echo-project-context-associate-v1', request_id, project_id, context_id }))
      .toMatchObject({ request_id, project_id, context_id });
    expect(() => validateProjectContextAssociateV1({ schema_version: 1, kind: 'echo-project-context-associate-v1', request_id, project_id, context_id, audience: { kind: 'project', project_id } })).toThrow();
  });

  it('uses a complete audience object for scoped releases, including a differently-associated project audience', () => {
    const audience_project = 'prj_00000000-0000-4000-8000-000000000004';
    const feed = validateProjectContextFeedV1({ schema_version: 1, kind: 'echo-project-context-feed-v1', project_id, items: [{ context_id, received_at, title: 'Original', excerpt: 'Exact source excerpt.', audience: { kind: 'project', project_id: audience_project } }], next_cursor: null });
    expect(feed.items[0]?.audience).toEqual({ kind: 'project', project_id: audience_project });
    expect(validateProjectContextReadV1({ schema_version: 1, kind: 'echo-project-context-read-v1', project_id, context_id, received_at, title: 'Original', text: 'Exact original bytes.\n', audience: { kind: 'only_me' } }).text).toBe('Exact original bytes.\n');
  });

  it('bounds project directory input to its lead-scoped project and never permits empty search', () => {
    expect(validateProjectDirectorySearchV1({ project_id, query: 'Ada', limit: 2 })).toEqual({ project_id, query: 'Ada', limit: 2 });
    expect(() => validateProjectDirectorySearchV1({ project_id, query: ' ', limit: 2 })).toThrow();
  });

  it('keeps V1 closed while V2 carries a nullable association and a separate audience', () => {
    const v1 = { schema_version: 1, kind: 'echo-person-update-submit-v1', request_id, title: 'Original', text: 'Body' };
    expect(validatePersonUpdateSubmitV1(v1)).toEqual({ ...v1, visibility: 'only_me' });
    expect(() => validatePersonUpdateSubmitV1({ ...v1, project_id })).toThrow();
    const v2 = validatePersonUpdateSubmitV2({ schema_version: 2, kind: 'echo-person-update-submit-v2', request_id, title: 'Original', text: 'Body', project_id: null, audience: { kind: 'project', project_id } });
    expect(v2).toMatchObject({ project_id: null, audience: { kind: 'project', project_id } });
  });

  it('does not allow generic V2 content or search results to disclose associations', () => {
    const content = { schema_version: 2, kind: 'echo-person-upload-content-v2', context_id, received_at, audience: { kind: 'team' }, title: 'Original', text: 'Body' };
    expect(validatePersonUploadContentV2(content)).toEqual(content);
    expect(() => validatePersonUploadContentV2({ ...content, project_id })).toThrow();
    const results = { schema_version: 2, kind: 'echo-person-upload-search-v2', results: [{ context_id, received_at, audience: { kind: 'only_me' }, title: 'Original', excerpt: 'Body' }] };
    expect(validatePersonUploadSearchResultV2(results)).toEqual(results);
    expect(() => validatePersonUploadSearchResultV2({ ...results, results: [{ ...results.results[0], project_id }] })).toThrow();
  });

  it('rejects nested enumerable surprises and invalid project audience shapes', () => {
    const value = { schema_version: 2, kind: 'echo-person-update-submit-v2', request_id, title: 'Original', text: 'Body', project_id, audience: { kind: 'project', project_id } };
    Object.defineProperty(value.audience, 'hidden', { value: 'unexpected', enumerable: false });
    expect(() => validatePersonUpdateSubmitV2(value)).toThrow();
    expect(() => validatePersonUpdateSubmitV2({ schema_version: 2, kind: 'echo-person-update-submit-v2', request_id, title: 'Original', text: 'Body', project_id, audience: { kind: 'team', project_id } })).toThrow();
  });
});
