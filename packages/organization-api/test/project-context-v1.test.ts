import { describe, expect, it } from 'vitest';
import {
  PERSON_DIRECTORY_PATH_V1,
  validateOrganizationDirectorySearchV1,
  validateOrganizationDirectoryV1,
  validatePersonUpdateSubmitV1,
  validatePersonUpdateSubmitV2,
  validatePersonUpdateReceiptV2,
  validatePersonUpdateStatusV2,
  validatePersonUploadContentV2,
  validatePersonUploadSearchResultV2,
  validateProjectContextAssociateV1,
  validateProjectContextBrowseV1,
  validateProjectContextDissociateV1,
  validateProjectContextFeedV1,
  validateProjectContextReadV1,
  validateProjectContextReadRequestV1,
  validateProjectContextSearchV1,
  validateProjectContextSearchResultV1,
  validateProjectCreateReceiptV1,
  validateProjectCreateV1,
  validateProjectDirectoryV1,
  validateProjectDirectorySearchV1,
  validateProjectListV1,
  validateProjectMemberAddV1,
  validateProjectMemberRemoveV1,
  validateProjectMemberSetV1,
  validateProjectMembersV1,
  validateProjectMutationReceiptV1,
  validateProjectPageRequestV1,
} from '../src/index.js';

const request_id = '00000000-0000-4000-8000-000000000001';
const project_id = 'prj_00000000-0000-4000-8000-000000000002';
const membership_id = 'mem_00000000-0000-4000-8000-000000000003';
const context_id = `ctx_${'a'.repeat(64)}`;
const received_at = '2026-09-21T00:00:00.000Z';
const project_id_2 = 'prj_00000000-0000-4000-8000-000000000004';

describe('project context V1 public codecs', () => {
  it('admits a canonical project and immutable receipts without exposing current state', () => {
    expect(validateProjectCreateV1({ schema_version: 1, kind: 'echo-project-create-v1', request_id, name: 'NFC café' }))
      .toEqual({ schema_version: 1, kind: 'echo-project-create-v1', request_id, name: 'NFC café' });
    expect(validateProjectCreateReceiptV1({ schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id, project_id, created_at: received_at, state: 'created' }))
      .toEqual({ schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id, project_id, created_at: received_at, state: 'created' });
    expect(validateProjectMutationReceiptV1({ schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id, project_id, operation: 'member_set', membership_id, received_at, state: 'applied' }))
      .toMatchObject({ operation: 'member_set', membership_id });
    expect(validateProjectMemberAddV1({ schema_version: 1, kind: 'echo-project-member-add-v1', request_id, project_id, membership_id }))
      .toMatchObject({ request_id, project_id, membership_id });
    expect(validateProjectCreateV1({ schema_version: 1, kind: 'echo-project-create-v1', request_id, name: 'é'.repeat(100) }).name).toBe('é'.repeat(100));
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

  it('admits an initial project-directory browse without a search query', () => {
    expect(validateProjectDirectorySearchV1({ project_id, limit: 2 })).toEqual({ project_id, limit: 2 });
    expect(validateProjectDirectorySearchV1({ project_id, query: 'Ada', limit: 2 })).toEqual({ project_id, query: 'Ada', limit: 2 });
    expect(() => validateProjectDirectorySearchV1({ project_id, query: ' ', limit: 2 })).toThrow();
  });

  it('keeps the organization directory to query and paging, with the project directory bounds', () => {
    expect(PERSON_DIRECTORY_PATH_V1).toBe('/v1/person/directory');
    expect(validateOrganizationDirectorySearchV1({})).toEqual({ limit: 10 });
    expect(validateOrganizationDirectorySearchV1({ query: 'Ada', limit: 2, cursor: 'AQ' })).toEqual({ query: 'Ada', limit: 2, cursor: 'AQ' });
    for (const input of [
      { query: ' ' }, { query: '' }, { limit: 0 }, { limit: 1.5 }, { limit: 11 }, { limit: '2' },
      { cursor: 'AQ=' }, { cursor: 'A' }, { cursor: 'AB' }, { cursor: '' },
      // The caller never names a project, organization or person.
      { project_id }, { organization_id: 'org_untrusted' }, { membership_id }, { principal_id: 'untrusted' },
      null, [], 'Ada',
    ]) expect(() => validateOrganizationDirectorySearchV1(input), JSON.stringify(input)).toThrow();
  });

  it('admits one bounded organization directory page of unique names and IDs only', () => {
    const entry = (id = membership_id) => ({ membership_id: id, display_name: 'Ada' });
    const valid = { schema_version: 1, kind: 'echo-organization-directory-v1', items: [entry()], next_cursor: 'AQ' };
    expect(validateOrganizationDirectoryV1(valid)).toEqual(valid);
    expect(validateOrganizationDirectoryV1({ ...valid, items: [], next_cursor: null })).toEqual({ ...valid, items: [], next_cursor: null });
    for (const invalid of [
      { ...valid, items: [entry(), entry()] },
      { ...valid, items: Array.from({ length: 11 }, (_, index) => entry(`mem_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)) },
      { ...valid, kind: 'echo-project-directory-v1' }, { ...valid, schema_version: 2 }, { ...valid, project_id },
      { ...valid, items: [{ ...entry(), role: 'lead' }] }, { ...valid, items: [{ ...entry(), email: 'ada@example.test' }] },
      { ...valid, items: [{ ...entry(), display_name: ' ' }] }, { ...valid, items: [{ membership_id: 'mem_not-a-uuid', display_name: 'Ada' }] },
      { ...valid, next_cursor: 'AQ=' }, { schema_version: 1, kind: 'echo-organization-directory-v1', items: [entry()] },
    ]) expect(() => validateOrganizationDirectoryV1(invalid), JSON.stringify(invalid)).toThrow();
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

  it('keeps the V2 original-text byte and whitespace rules while bounding escaped JSON', () => {
    const common = { schema_version: 2 as const, kind: 'echo-person-update-submit-v2' as const, request_id, project_id: null, title: ' Title ', text: '  exact original whitespace\n', audience: { kind: 'only_me' as const } };
    expect(validatePersonUpdateSubmitV2(common)).toEqual(common);
    expect(validatePersonUpdateSubmitV2({ ...common, audience: { kind: 'team' } }).audience).toEqual({ kind: 'team' });
    expect(validatePersonUpdateSubmitV2({ ...common, title: 'é'.repeat(100), text: '😀'.repeat(2048) }).text).toBe('😀'.repeat(2048));
    expect(() => validatePersonUpdateSubmitV2({ ...common, text: '"'.repeat(8192) })).toThrow();
  });

  it('keeps an accepted near-request-bound original immediately readable through both response paths', () => {
    const text = '\n'.repeat(8047) + 'a';
    const submit = { schema_version: 2 as const, kind: 'echo-person-update-submit-v2' as const, request_id, title: 'x', text, project_id: null, audience: { kind: 'only_me' as const } };
    expect(validatePersonUpdateSubmitV2(submit).text).toBe(text);
    expect(validatePersonUploadContentV2({ schema_version: 2, kind: 'echo-person-upload-content-v2', context_id, received_at, title: 'x', text, audience: { kind: 'only_me' } }).text).toBe(text);
    expect(validateProjectContextReadV1({ schema_version: 1, kind: 'echo-project-context-read-v1', project_id, context_id, received_at, title: 'x', text, audience: { kind: 'only_me' } }).text).toBe(text);
  });

  it('admits the worst bounded escaped page under the dedicated response ceiling', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      context_id: `ctx_${String(index).padStart(64, '0')}`,
      received_at,
      title: 'x',
      excerpt: '"'.repeat(300),
      audience: { kind: 'team' as const },
    }));
    expect(validateProjectContextFeedV1({ schema_version: 1, kind: 'echo-project-context-feed-v1', project_id, items, next_cursor: null }).items).toHaveLength(10);
  });

  it('rejects hostile recursive input before any project contract can observe a different shape', () => {
    const base = { schema_version: 2, kind: 'echo-person-update-submit-v2', request_id, title: 'Original', text: 'Body', project_id: null, audience: { kind: 'only_me' } };
    const accessor = { ...base }; Object.defineProperty(accessor, 'title', { enumerable: true, get: () => 'Original' });
    const symbol = { ...base, [Symbol('private')]: 'x' };
    const nonEnumerable = { ...base }; Object.defineProperty(nonEnumerable, 'hidden', { value: 'x' });
    const cyclic: Record<string, unknown> = { ...base }; cyclic.self = cyclic;
    const inherited = Object.create({ audience: { kind: 'team' } }); Object.assign(inherited, base); delete inherited.audience;
    expect(() => validatePersonUpdateSubmitV2(accessor)).toThrow();
    expect(() => validatePersonUpdateSubmitV2(symbol)).toThrow();
    expect(() => validatePersonUpdateSubmitV2(nonEnumerable)).toThrow();
    expect(() => validatePersonUpdateSubmitV2(cyclic)).toThrow();
    expect(() => validatePersonUpdateSubmitV2(inherited)).toThrow();
  });

  it('fails closed for all page/result families on duplicate, oversized, hidden, or malformed nested data', () => {
    const summary = (id = project_id) => ({ schema_version: 1, kind: 'echo-project-summary-v1' as const, project_id: id, name: 'Project', created_at: received_at, role: 'lead' as const });
    const member = (id = membership_id) => ({ membership_id: id, display_name: 'Ada', role: 'member' as const });
    const directory = (id = membership_id) => ({ membership_id: id, display_name: 'Ada' });
    const context = (id = context_id) => ({ context_id: id, received_at, title: 'Original', excerpt: 'Exact source excerpt.', audience: { kind: 'project' as const, project_id: project_id_2 } });
    const cases: readonly [string, (value: unknown) => unknown, unknown, unknown, unknown][] = [
      ['project list', validateProjectListV1, { schema_version: 1, kind: 'echo-project-list-v1', items: [summary()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-list-v1', items: [summary(), summary()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-list-v1', items: Array.from({ length: 11 }, (_, index) => summary(`prj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)), next_cursor: null }],
      ['project members', validateProjectMembersV1, { schema_version: 1, kind: 'echo-project-members-v1', project_id, items: [member()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-members-v1', project_id, items: [member(), member()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-members-v1', project_id, items: Array.from({ length: 11 }, (_, index) => member(`mem_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)), next_cursor: null }],
      ['project directory', validateProjectDirectoryV1, { schema_version: 1, kind: 'echo-project-directory-v1', project_id, items: [directory()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-directory-v1', project_id, items: [directory(), directory()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-directory-v1', project_id, items: Array.from({ length: 11 }, (_, index) => directory(`mem_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)), next_cursor: null }],
      ['project feed', validateProjectContextFeedV1, { schema_version: 1, kind: 'echo-project-context-feed-v1', project_id, items: [context()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-context-feed-v1', project_id, items: [context(), context()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-context-feed-v1', project_id, items: Array.from({ length: 11 }, (_, index) => context(`ctx_${String(index).padStart(64, '0')}`)), next_cursor: null }],
      ['project search', validateProjectContextSearchResultV1, { schema_version: 1, kind: 'echo-project-context-search-result-v1', project_id, items: [context()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-context-search-result-v1', project_id, items: [context(), context()], next_cursor: null }, { schema_version: 1, kind: 'echo-project-context-search-result-v1', project_id, items: Array.from({ length: 11 }, (_, index) => context(`ctx_${String(index).padStart(64, '0')}`)), next_cursor: null }],
    ];
    for (const [label, validate, valid, duplicate, oversized] of cases) {
      expect(validate(valid), label).toBeTruthy();
      expect(() => validate(duplicate), `${label} duplicate`).toThrow();
      expect(() => validate(oversized), `${label} oversized`).toThrow();
    }
    expect(() => validateProjectContextFeedV1({ schema_version: 1, kind: 'echo-project-context-feed-v1', project_id, items: [{ ...context(), audience: { kind: 'project', project_id: project_id_2, global_auth: true } }], next_cursor: null })).toThrow();
    expect(() => validateProjectMembersV1({ schema_version: 1, kind: 'echo-project-members-v1', project_id, items: [{ ...member(), global_auth: true }], next_cursor: null })).toThrow();
    const sparse = [context()]; sparse.length = 2;
    expect(() => validateProjectContextFeedV1({ schema_version: 1, kind: 'echo-project-context-feed-v1', project_id, items: sparse, next_cursor: null })).toThrow();
  });

  it('rejects invalid paging, missing fields, and unreal timestamps at each public result boundary', () => {
    const list = { schema_version: 1, kind: 'echo-project-list-v1', items: [], next_cursor: null };
    const browse = { project_id, limit: 1, cursor: 'AQ' };
    for (const input of [{ ...browse, limit: 0 }, { ...browse, limit: 1.5 }, { ...browse, limit: 11 }, { ...browse, cursor: 'AQ=' }, { ...browse, cursor: 'A' }, { ...browse, cursor: 'AB' }]) {
      expect(() => validateProjectDirectorySearchV1({ ...input, query: 'Ada' })).toThrow();
    }
    expect(() => validateProjectListV1({ ...list, next_cursor: 'AQ=' })).toThrow();
    expect(() => validateProjectListV1({ schema_version: 1, kind: 'echo-project-list-v1', items: [{ schema_version: 1, kind: 'echo-project-summary-v1', project_id, name: 'Project', created_at: '2026-02-30T00:00:00.000Z', role: 'lead' }], next_cursor: null })).toThrow();
    expect(() => validateProjectContextReadV1({ schema_version: 1, kind: 'echo-project-context-read-v1', project_id, context_id, received_at, title: 'Original', text: 'Body', audience: null })).toThrow();
    expect(() => validateProjectCreateReceiptV1({ schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id, project_id, created_at: received_at })).toThrow();
  });

  it.each([
    ['member set', validateProjectMemberSetV1, { schema_version: 1, kind: 'echo-project-member-set-v1', request_id, project_id, membership_id, role: 'lead' }],
    ['member remove', validateProjectMemberRemoveV1, { schema_version: 1, kind: 'echo-project-member-remove-v1', request_id, project_id, membership_id }],
    ['dissociate', validateProjectContextDissociateV1, { schema_version: 1, kind: 'echo-project-context-dissociate-v1', request_id, project_id, context_id }],
    ['project page', validateProjectPageRequestV1, { limit: 10, cursor: 'AQ' }],
    ['context browse', validateProjectContextBrowseV1, { project_id, limit: 10, cursor: 'AQ' }],
    ['context search', validateProjectContextSearchV1, { project_id, query: 'Source', limit: 10, cursor: 'AQ' }],
    ['context read request', validateProjectContextReadRequestV1, { project_id, context_id }],
  ] as const)('admits the exact V1 %s request shape and rejects forged version/global fields', (_name, validate, valid) => {
    expect(validate(valid)).toBeTruthy();
    expect(() => validate({ ...valid, schema_version: 2 })).toThrow();
    expect(() => validate({ ...valid, global_authorization: 'forged' })).toThrow();
  });

  it('keeps V2 submit receipt and status coordinates closed, including private project association', () => {
    const coordinates = { request_id, context_id, received_at, project_id, audience: { kind: 'project' as const, project_id } };
    expect(validatePersonUpdateReceiptV2({ schema_version: 2, kind: 'echo-person-update-receipt-v2', ...coordinates, state: 'received' })).toMatchObject({ project_id, audience: { kind: 'project', project_id } });
    expect(validatePersonUpdateStatusV2({ schema_version: 2, kind: 'echo-person-update-status-v2', ...coordinates, status: 'stored', metadata: 'pending' })).toMatchObject({ project_id, metadata: 'pending' });
    expect(() => validatePersonUpdateReceiptV2({ schema_version: 2, kind: 'echo-person-update-receipt-v2', ...coordinates, state: 'received', memberships: [membership_id] })).toThrow();
    expect(() => validatePersonUpdateStatusV2({ schema_version: 1, kind: 'echo-person-update-status-v2', ...coordinates, status: 'stored', metadata: 'pending' })).toThrow();
  });
});
