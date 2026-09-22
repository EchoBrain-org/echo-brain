import { canonicalJson, canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonQueryText } from './person-query.js';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  MAX_ORGANIZATION_API_CURSOR_CHARACTERS,
  asRecord,
  assertExactKeys,
  assertId,
  assertOnlyEnumerableDataProperties,
  assertTimestamp,
  fail,
} from './validation.js';
import { validatePersonUpdateRequestId, validatePersonUploadContextId } from './person-updates.js';

export const PERSON_PROJECTS_PATH_V1 = '/v1/person/projects';
export const PROJECT_NAME_MAX_BYTES = 200;
export const PROJECT_PAGE_MAX_ITEMS = 10;
/** New project/original responses may carry bounded original bytes and pages. */
export const PROJECT_CONTEXT_RESPONSE_MAX_BYTES = 32 * 1024;
export type ProjectIdV1 = `prj_${string}`;
export type ProjectRoleV1 = 'lead' | 'member';

export interface ProjectCreateV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-create-v1';
  readonly request_id: string;
  readonly name: string;
}
export interface ProjectSummaryV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-summary-v1';
  readonly project_id: ProjectIdV1;
  readonly name: string;
  readonly created_at: string;
  readonly role: ProjectRoleV1;
}
export interface ProjectCreateReceiptV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-create-receipt-v1';
  readonly request_id: string;
  readonly project_id: ProjectIdV1;
  readonly created_at: string;
  readonly state: 'created';
}
export type ProjectMutationOperationV1 = 'member_set' | 'member_remove' | 'associate' | 'dissociate';
export type ProjectMutationReceiptV1 =
  | { readonly schema_version: 1; readonly kind: 'echo-project-mutation-receipt-v1'; readonly request_id: string; readonly project_id: ProjectIdV1; readonly operation: 'member_set' | 'member_remove'; readonly membership_id: string; readonly received_at: string; readonly state: 'applied' }
  | { readonly schema_version: 1; readonly kind: 'echo-project-mutation-receipt-v1'; readonly request_id: string; readonly project_id: ProjectIdV1; readonly operation: 'associate' | 'dissociate'; readonly context_id: string; readonly received_at: string; readonly state: 'applied' };
export interface ProjectListV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-list-v1';
  readonly items: readonly ProjectSummaryV1[];
  readonly next_cursor: string | null;
}
export interface ProjectMemberV1 {
  readonly membership_id: string;
  readonly display_name: string;
  readonly role: ProjectRoleV1;
}
export interface ProjectMembersV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-members-v1';
  readonly project_id: ProjectIdV1;
  readonly items: readonly ProjectMemberV1[];
  readonly next_cursor: string | null;
}
export interface ProjectDirectoryEntryV1 { readonly membership_id: string; readonly display_name: string }
export interface ProjectDirectorySearchV1 { readonly project_id: ProjectIdV1; readonly query: string; readonly limit?: number; readonly cursor?: string }
export interface ProjectDirectoryV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-directory-v1';
  readonly project_id: ProjectIdV1;
  readonly items: readonly ProjectDirectoryEntryV1[];
  readonly next_cursor: string | null;
}
export interface ProjectMemberSetV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-member-set-v1';
  readonly request_id: string;
  readonly project_id: ProjectIdV1;
  readonly membership_id: string;
  readonly role: ProjectRoleV1;
}
export interface ProjectMemberRemoveV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-member-remove-v1';
  readonly request_id: string;
  readonly project_id: ProjectIdV1;
  readonly membership_id: string;
}
export interface ProjectContextAssociateV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-context-associate-v1';
  readonly request_id: string;
  readonly project_id: ProjectIdV1;
  readonly context_id: string;
}
export interface ProjectContextDissociateV1 extends Omit<ProjectContextAssociateV1, 'kind'> {
  readonly kind: 'echo-project-context-dissociate-v1';
}
export interface ProjectPageRequestV1 { readonly limit?: number; readonly cursor?: string }
export interface ProjectContextBrowseV1 { readonly project_id: ProjectIdV1; readonly limit?: number; readonly cursor?: string }
export interface ProjectContextSearchV1 extends ProjectContextBrowseV1 { readonly query: string }
export interface ProjectContextReadRequestV1 { readonly project_id: ProjectIdV1; readonly context_id: string }
export type ProjectContextAudienceV1 =
  | { readonly kind: 'only_me' }
  | { readonly kind: 'team' }
  | { readonly kind: 'project'; readonly project_id: ProjectIdV1 };
export interface ProjectContextItemV1 {
  readonly context_id: string;
  readonly received_at: string;
  readonly title: string;
  readonly excerpt: string;
  readonly audience: ProjectContextAudienceV1;
}
export interface ProjectContextFeedV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-context-feed-v1';
  readonly project_id: ProjectIdV1;
  readonly items: readonly ProjectContextItemV1[];
  readonly next_cursor: string | null;
}
export interface ProjectContextSearchResultV1 extends Omit<ProjectContextFeedV1, 'kind'> {
  readonly kind: 'echo-project-context-search-result-v1';
}
export interface ProjectContextReadV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-project-context-read-v1';
  readonly project_id: ProjectIdV1;
  readonly context_id: string;
  readonly received_at: string;
  readonly title: string;
  readonly text: string;
  readonly audience: ProjectContextAudienceV1;
}

function object(value: unknown, label: string): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, label);
  return asRecord(value, label);
}
function snapshot(value: unknown, label: string): Record<string, unknown> {
  const record = object(value, label);
  let bytes: Uint8Array;
  try { bytes = canonicalJsonBytes(record); } catch (error) { fail(`${label} is not canonicalizable`, error); }
  if (bytes.byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail(`${label} exceeds JSON byte bound`);
  return JSON.parse(canonicalJson(record)) as Record<string, unknown>;
}
function responseBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > PROJECT_CONTEXT_RESPONSE_MAX_BYTES) fail(`${label} exceeds JSON byte bound`);
}
function text(value: unknown, label: string, maximum: number, multiline = false): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
      Array.from(value).reduce((bytes, point) => { const n = point.codePointAt(0)!; return bytes + (n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4); }, 0) > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) ||
      (!multiline && /[\t\r\n]/u.test(value))) fail(`${label} is invalid`);
}
function name(value: unknown): asserts value is string {
  text(value, 'Project name', PROJECT_NAME_MAX_BYTES);
  if ((value as string).trim() !== value || (value as string).normalize('NFC') !== value) fail('Project name is invalid');
}
function displayName(value: unknown): asserts value is string { text(value, 'Project display name', 200); }
function role(value: unknown): asserts value is ProjectRoleV1 { if (value !== 'lead' && value !== 'member') fail('Project role is invalid'); }
export function validateProjectContextAudienceV1(value: unknown): ProjectContextAudienceV1 {
  const record = object(value, 'Project context audience');
  if (record.kind === 'only_me' || record.kind === 'team') {
    assertExactKeys(record, ['kind'], 'Project context audience');
    return { kind: record.kind };
  }
  if (record.kind === 'project') {
    assertExactKeys(record, ['kind', 'project_id'], 'Project context audience');
    return { kind: 'project', project_id: validateProjectIdV1(record.project_id, 'Project context audience project_id') };
  }
  fail('Project context audience is invalid');
}
function cursor(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORGANIZATION_API_CURSOR_CHARACTERS || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail(`${label} is invalid`);
  const last = value.at(-1)!; const remainder = value.length % 4;
  if ((remainder === 2 && !/^[AQgw]$/.test(last)) || (remainder === 3 && !/^[AEIMQUYcgkosw048]$/.test(last))) fail(`${label} is invalid`);
  return value;
}
function optionalPaging(record: Record<string, unknown>, label: string): { limit: number; cursor?: string } {
  if (Object.hasOwn(record, 'limit') && (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > PROJECT_PAGE_MAX_ITEMS)) fail(`${label} limit is invalid`);
  return { limit: (record.limit as number | undefined) ?? PROJECT_PAGE_MAX_ITEMS, ...(Object.hasOwn(record, 'cursor') ? { cursor: cursor(record.cursor, `${label} cursor`) } : {}) };
}
function project(record: Record<string, unknown>, label: string): ProjectIdV1 { return validateProjectIdV1(record.project_id, `${label} project_id`); }
function page<T>(value: unknown, label: string, item: (value: unknown) => T): { items: readonly T[]; next_cursor: string | null } {
  const record = object(value, label); assertExactKeys(record, ['items', 'next_cursor'], label);
  if (!Array.isArray(record.items) || record.items.length > PROJECT_PAGE_MAX_ITEMS) fail(`${label} items are invalid`);
  const items = record.items.map(item);
  return { items, next_cursor: record.next_cursor === null ? null : cursor(record.next_cursor, `${label} next_cursor`) };
}
function unique<T>(items: readonly T[], field: keyof T, label: string): void {
  if (new Set(items.map(item => item[field])).size !== items.length) fail(`${label} contains duplicates`);
}

export function validateProjectIdV1(value: unknown, label = 'Project ID'): ProjectIdV1 {
  assertId(value, 'prj', label); return value as ProjectIdV1;
}
export function validateProjectCreateV1(value: unknown): ProjectCreateV1 {
  const record = snapshot(value, 'Project create'); assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'name'], 'Project create');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-create-v1') fail('Project create version or kind is unsupported');
  validatePersonUpdateRequestId(record.request_id); name(record.name);
  return record as unknown as ProjectCreateV1;
}
export function validateProjectSummaryV1(value: unknown): ProjectSummaryV1 {
  const record = object(value, 'Project summary'); assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'name', 'created_at', 'role'], 'Project summary');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-summary-v1') fail('Project summary version or kind is unsupported');
  project(record, 'Project summary'); name(record.name); assertTimestamp(record.created_at, 'Project summary created_at'); role(record.role);
  return record as unknown as ProjectSummaryV1;
}
export function validateProjectCreateReceiptV1(value: unknown): ProjectCreateReceiptV1 {
  const record = object(value, 'Project create receipt'); assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'project_id', 'created_at', 'state'], 'Project create receipt');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-create-receipt-v1' || record.state !== 'created') fail('Project create receipt is invalid');
  validatePersonUpdateRequestId(record.request_id); const project_id = project(record, 'Project create receipt'); assertTimestamp(record.created_at, 'Project create receipt created_at');
  return { schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id: record.request_id as string, project_id, created_at: record.created_at as string, state: 'created' };
}
export function validateProjectMutationReceiptV1(value: unknown): ProjectMutationReceiptV1 {
  const record = object(value, 'Project mutation receipt');
  const common = ['schema_version', 'kind', 'request_id', 'project_id', 'operation', 'received_at', 'state'];
  if (record.operation === 'member_set' || record.operation === 'member_remove') assertExactKeys(record, [...common, 'membership_id'], 'Project mutation receipt');
  else if (record.operation === 'associate' || record.operation === 'dissociate') assertExactKeys(record, [...common, 'context_id'], 'Project mutation receipt');
  else fail('Project mutation receipt is invalid');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-mutation-receipt-v1' || record.state !== 'applied') fail('Project mutation receipt is invalid');
  validatePersonUpdateRequestId(record.request_id); const project_id = project(record, 'Project mutation receipt'); assertTimestamp(record.received_at, 'Project mutation receipt received_at');
  if (record.operation === 'member_set' || record.operation === 'member_remove') {
    assertId(record.membership_id, 'mem', 'Project mutation receipt membership_id');
    return { schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id: record.request_id as string, project_id, operation: record.operation, membership_id: record.membership_id as string, received_at: record.received_at as string, state: 'applied' };
  }
  validatePersonUploadContextId(record.context_id);
  return { schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id: record.request_id as string, project_id, operation: record.operation, context_id: record.context_id as string, received_at: record.received_at as string, state: 'applied' };
}
export function validateProjectListV1(value: unknown): ProjectListV1 {
  const record = object(value, 'Project list'); assertExactKeys(record, ['schema_version', 'kind', 'items', 'next_cursor'], 'Project list');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-list-v1') fail('Project list version or kind is unsupported');
  const result = page({ items: record.items, next_cursor: record.next_cursor }, 'Project list', validateProjectSummaryV1); unique(result.items as ProjectSummaryV1[], 'project_id', 'Project list');
  const response = { schema_version: 1 as const, kind: 'echo-project-list-v1' as const, ...result }; responseBound(response, 'Project list'); return response;
}
function member(value: unknown): ProjectMemberV1 {
  const record = object(value, 'Project member'); assertExactKeys(record, ['membership_id', 'display_name', 'role'], 'Project member');
  assertId(record.membership_id, 'mem', 'Project member membership_id'); displayName(record.display_name); role(record.role);
  return record as unknown as ProjectMemberV1;
}
export function validateProjectMembersV1(value: unknown): ProjectMembersV1 {
  const record = object(value, 'Project members'); assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'items', 'next_cursor'], 'Project members');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-members-v1') fail('Project members version or kind is unsupported');
  const result = page({ items: record.items, next_cursor: record.next_cursor }, 'Project members', member); unique(result.items as ProjectMemberV1[], 'membership_id', 'Project members');
  const response = { schema_version: 1 as const, kind: 'echo-project-members-v1' as const, project_id: project(record, 'Project members'), ...result }; responseBound(response, 'Project members'); return response;
}
function directoryEntry(value: unknown): ProjectDirectoryEntryV1 {
  const record = object(value, 'Project directory entry'); assertExactKeys(record, ['membership_id', 'display_name'], 'Project directory entry');
  assertId(record.membership_id, 'mem', 'Project directory entry membership_id'); displayName(record.display_name); return record as unknown as ProjectDirectoryEntryV1;
}
export function validateProjectDirectorySearchV1(value: unknown): ProjectDirectorySearchV1 {
  const record = snapshot(value, 'Project directory search'); assertExactKeys(record, ['project_id', 'query', ...(Object.hasOwn(record, 'limit') ? ['limit'] : []), ...(Object.hasOwn(record, 'cursor') ? ['cursor'] : [])], 'Project directory search');
  const query = validatePersonQueryText(record.query); const paging = optionalPaging(record, 'Project directory search'); return { project_id: project(record, 'Project directory search'), query, ...paging };
}
export function validateProjectDirectoryV1(value: unknown): ProjectDirectoryV1 {
  const record = object(value, 'Project directory'); assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'items', 'next_cursor'], 'Project directory');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-directory-v1') fail('Project directory version or kind is unsupported');
  const result = page({ items: record.items, next_cursor: record.next_cursor }, 'Project directory', directoryEntry); unique(result.items as ProjectDirectoryEntryV1[], 'membership_id', 'Project directory');
  const response = { schema_version: 1 as const, kind: 'echo-project-directory-v1' as const, project_id: project(record, 'Project directory'), ...result }; responseBound(response, 'Project directory'); return response;
}
export function validateProjectMemberSetV1(value: unknown): ProjectMemberSetV1 {
  const record = snapshot(value, 'Project member set'); assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'project_id', 'membership_id', 'role'], 'Project member set');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-member-set-v1') fail('Project member set version or kind is unsupported');
  validatePersonUpdateRequestId(record.request_id); project(record, 'Project member set'); assertId(record.membership_id, 'mem', 'Project member set membership_id'); role(record.role); return record as unknown as ProjectMemberSetV1;
}
export function validateProjectMemberRemoveV1(value: unknown): ProjectMemberRemoveV1 {
  const record = snapshot(value, 'Project member remove'); assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'project_id', 'membership_id'], 'Project member remove');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-member-remove-v1') fail('Project member remove version or kind is unsupported');
  validatePersonUpdateRequestId(record.request_id); project(record, 'Project member remove'); assertId(record.membership_id, 'mem', 'Project member remove membership_id'); return record as unknown as ProjectMemberRemoveV1;
}
function association(value: unknown, kind: ProjectContextAssociateV1['kind'] | ProjectContextDissociateV1['kind'], label: string): ProjectContextAssociateV1 | ProjectContextDissociateV1 {
  const record = snapshot(value, label); assertExactKeys(record, ['schema_version', 'kind', 'request_id', 'project_id', 'context_id'], label);
  if (record.schema_version !== 1 || record.kind !== kind) fail(`${label} version or kind is unsupported`);
  validatePersonUpdateRequestId(record.request_id); project(record, label); validatePersonUploadContextId(record.context_id); return record as unknown as ProjectContextAssociateV1 | ProjectContextDissociateV1;
}
export function validateProjectContextAssociateV1(value: unknown): ProjectContextAssociateV1 { return association(value, 'echo-project-context-associate-v1', 'Project context association') as ProjectContextAssociateV1; }
export function validateProjectContextDissociateV1(value: unknown): ProjectContextDissociateV1 { return association(value, 'echo-project-context-dissociate-v1', 'Project context dissociation') as ProjectContextDissociateV1; }
export function validateProjectPageRequestV1(value: unknown): ProjectPageRequestV1 {
  const record = snapshot(value, 'Project page request'); assertExactKeys(record, [...(Object.hasOwn(record, 'limit') ? ['limit'] : []), ...(Object.hasOwn(record, 'cursor') ? ['cursor'] : [])], 'Project page request'); return optionalPaging(record, 'Project page request');
}
function browse(value: unknown, search: boolean): ProjectContextBrowseV1 | ProjectContextSearchV1 {
  const label = search ? 'Project context search' : 'Project context browse'; const record = snapshot(value, label);
  assertExactKeys(record, ['project_id', ...(search ? ['query'] : []), ...(Object.hasOwn(record, 'limit') ? ['limit'] : []), ...(Object.hasOwn(record, 'cursor') ? ['cursor'] : [])], label);
  const result = { project_id: project(record, label), ...optionalPaging(record, label) };
  return search ? { ...result, query: validatePersonQueryText(record.query) } : result;
}
export function validateProjectContextBrowseV1(value: unknown): ProjectContextBrowseV1 { return browse(value, false) as ProjectContextBrowseV1; }
export function validateProjectContextSearchV1(value: unknown): ProjectContextSearchV1 { return browse(value, true) as ProjectContextSearchV1; }
export function validateProjectContextReadRequestV1(value: unknown): ProjectContextReadRequestV1 {
  const record = snapshot(value, 'Project context read request'); assertExactKeys(record, ['project_id', 'context_id'], 'Project context read request');
  return { project_id: project(record, 'Project context read request'), context_id: validatePersonUploadContextId(record.context_id) };
}
function item(value: unknown): ProjectContextItemV1 {
  const record = object(value, 'Project context item'); assertExactKeys(record, ['context_id', 'received_at', 'title', 'excerpt', 'audience'], 'Project context item');
  validatePersonUploadContextId(record.context_id); assertTimestamp(record.received_at, 'Project context item received_at'); text(record.title, 'Project context item title', 200); text(record.excerpt, 'Project context item excerpt', 1200, true);
  if ([...(record.excerpt as string)].length > 300) fail('Project context item excerpt is invalid');
  return { context_id: record.context_id as string, received_at: record.received_at as string, title: record.title as string, excerpt: record.excerpt as string, audience: validateProjectContextAudienceV1(record.audience) };
}
function contextPage(value: unknown, kind: ProjectContextFeedV1['kind'] | ProjectContextSearchResultV1['kind']): ProjectContextFeedV1 | ProjectContextSearchResultV1 {
  const record = object(value, 'Project context page'); assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'items', 'next_cursor'], 'Project context page');
  if (record.schema_version !== 1 || record.kind !== kind) fail('Project context page version or kind is unsupported');
  const result = page({ items: record.items, next_cursor: record.next_cursor }, 'Project context page', item); unique(result.items as ProjectContextItemV1[], 'context_id', 'Project context page');
  const response = { schema_version: 1 as const, kind, project_id: project(record, 'Project context page'), ...result } as ProjectContextFeedV1 | ProjectContextSearchResultV1;
  responseBound(response, 'Project context page'); return response;
}
export function validateProjectContextFeedV1(value: unknown): ProjectContextFeedV1 { return contextPage(value, 'echo-project-context-feed-v1') as ProjectContextFeedV1; }
export function validateProjectContextSearchResultV1(value: unknown): ProjectContextSearchResultV1 { return contextPage(value, 'echo-project-context-search-result-v1') as ProjectContextSearchResultV1; }
export function validateProjectContextReadV1(value: unknown): ProjectContextReadV1 {
  const record = object(value, 'Project context read'); assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'context_id', 'received_at', 'title', 'text', 'audience'], 'Project context read');
  if (record.schema_version !== 1 || record.kind !== 'echo-project-context-read-v1') fail('Project context read version or kind is unsupported');
  const project_id = project(record, 'Project context read'); validatePersonUploadContextId(record.context_id); assertTimestamp(record.received_at, 'Project context read received_at'); text(record.title, 'Project context read title', 200); text(record.text, 'Project context read text', 8 * 1024, true);
  const response = { schema_version: 1 as const, kind: 'echo-project-context-read-v1' as const, project_id, context_id: record.context_id as string, received_at: record.received_at as string, title: record.title as string, text: record.text as string, audience: validateProjectContextAudienceV1(record.audience) };
  responseBound(response, 'Project context read'); return response;
}
