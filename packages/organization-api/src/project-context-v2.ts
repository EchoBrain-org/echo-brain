import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { MAX_ORGANIZATION_API_CURSOR_CHARACTERS, asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, assertTimestamp, fail } from './validation.js';
import { validatePersonUploadContextId } from './person-updates.js';
import { PROJECT_CONTEXT_RESPONSE_MAX_BYTES, PROJECT_NAME_MAX_BYTES, PROJECT_PAGE_MAX_ITEMS, type ProjectIdV1, type ProjectRoleV1, validateProjectIdV1 } from './project-context-v1.js';
import { validatePersonUploadAudienceV3, type PersonUploadAudienceV3 } from './person-upload-audience-v3.js';

export const PERSON_PROJECTS_PATH_V2 = '/v2/person/projects';

export type ProjectStatusV2 = 'active' | 'archived';
export interface ProjectSummaryV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-project-summary-v2';
  readonly project_id: ProjectIdV1;
  readonly name: string;
  readonly created_at: string;
  readonly role: ProjectRoleV1;
  readonly status: ProjectStatusV2;
}
export interface ProjectListV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-project-list-v2';
  readonly items: readonly ProjectSummaryV2[];
  readonly next_cursor: string | null;
}
/** V2 lists one lifecycle state at a time; omitted status is the active list. */
export interface ProjectPageRequestV2 {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: ProjectStatusV2;
}

export interface ProjectContextItemV2 {
  readonly context_id: string;
  readonly received_at: string;
  readonly title: string;
  readonly excerpt: string;
  readonly audience: PersonUploadAudienceV3;
}
export interface ProjectContextFeedV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-project-context-feed-v2';
  readonly project_id: ProjectIdV1;
  readonly items: readonly ProjectContextItemV2[];
  readonly next_cursor: string | null;
}
export interface ProjectContextSearchResultV2 extends Omit<ProjectContextFeedV2, 'kind'> {
  readonly kind: 'echo-project-context-search-result-v2';
}
export interface ProjectContextReadV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-project-context-read-v2';
  readonly project_id: ProjectIdV1;
  readonly context_id: string;
  readonly received_at: string;
  readonly title: string;
  readonly text: string;
  readonly audience: PersonUploadAudienceV3;
}

function object(value: unknown, label: string): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, label);
  return asRecord(value, label);
}
function scalarText(value: unknown, label: string, maximum: number, multiline = false): asserts value is string {
  const bytes = typeof value === 'string' ? Array.from(value).reduce((total, point) => {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) fail(`${label} is invalid`);
    return total + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
  }, 0) : 0;
  if (typeof value !== 'string' || value.trim().length === 0 || bytes > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) ||
      (!multiline && /[\t\r\n]/u.test(value))) fail(`${label} is invalid`);
}
function cursor(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail(`${label} is invalid`);
  return value;
}
/** New project-list cursors use the established V1 page encoding constraints. */
function projectListCursor(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORGANIZATION_API_CURSOR_CHARACTERS || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail(`${label} is invalid`);
  const last = value.at(-1)!; const remainder = value.length % 4;
  if ((remainder === 2 && !/^[AQgw]$/.test(last)) || (remainder === 3 && !/^[AEIMQUYcgkosw048]$/.test(last))) fail(`${label} is invalid`);
  return value;
}
function name(value: unknown, label: string): asserts value is string {
  scalarText(value, label, PROJECT_NAME_MAX_BYTES);
  if ((value as string).trim() !== value || (value as string).normalize('NFC') !== value) fail(`${label} is invalid`);
}
function role(value: unknown): asserts value is ProjectRoleV1 { if (value !== 'lead' && value !== 'member') fail('Project role is invalid'); }
function status(value: unknown): asserts value is ProjectStatusV2 { if (value !== 'active' && value !== 'archived') fail('Project status is invalid'); }
function responseBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > PROJECT_CONTEXT_RESPONSE_MAX_BYTES) fail(`${label} exceeds JSON byte bound`);
}
export function validateProjectPageRequestV2(value: unknown): ProjectPageRequestV2 {
  const record = object(value, 'Project page request');
  assertExactKeys(record, [...(Object.hasOwn(record, 'limit') ? ['limit'] : []), ...(Object.hasOwn(record, 'cursor') ? ['cursor'] : []), ...(Object.hasOwn(record, 'status') ? ['status'] : [])], 'Project page request');
  if (Object.hasOwn(record, 'limit') && (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > PROJECT_PAGE_MAX_ITEMS)) fail('Project page request limit is invalid');
  if (Object.hasOwn(record, 'status')) status(record.status);
  return { limit: (record.limit as number | undefined) ?? PROJECT_PAGE_MAX_ITEMS, ...(Object.hasOwn(record, 'cursor') ? { cursor: projectListCursor(record.cursor, 'Project page request cursor') } : {}), status: (record.status as ProjectStatusV2 | undefined) ?? 'active' };
}
export function validateProjectSummaryV2(value: unknown): ProjectSummaryV2 {
  const record = object(value, 'Project summary');
  assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'name', 'created_at', 'role', 'status'], 'Project summary');
  if (record.schema_version !== 2 || record.kind !== 'echo-project-summary-v2') fail('Project summary version or kind is unsupported');
  const project_id = validateProjectIdV1(record.project_id, 'Project summary project_id'); name(record.name, 'Project name'); assertTimestamp(record.created_at, 'Project summary created_at'); role(record.role); status(record.status);
  return { schema_version: 2, kind: 'echo-project-summary-v2', project_id, name: record.name as string, created_at: record.created_at as string, role: record.role, status: record.status };
}
export function validateProjectListV2(value: unknown): ProjectListV2 {
  const record = object(value, 'Project list');
  assertExactKeys(record, ['schema_version', 'kind', 'items', 'next_cursor'], 'Project list');
  if (record.schema_version !== 2 || record.kind !== 'echo-project-list-v2' || !Array.isArray(record.items) || record.items.length > PROJECT_PAGE_MAX_ITEMS) fail('Project list is invalid');
  const items = record.items.map(validateProjectSummaryV2);
  if (new Set(items.map(item => item.project_id)).size !== items.length) fail('Project list contains duplicates');
  const response = { schema_version: 2 as const, kind: 'echo-project-list-v2' as const, items, next_cursor: record.next_cursor === null ? null : projectListCursor(record.next_cursor, 'Project list next_cursor') };
  responseBound(response, 'Project list'); return response;
}
function item(value: unknown): ProjectContextItemV2 {
  const record = object(value, 'Project context item');
  assertExactKeys(record, ['context_id', 'received_at', 'title', 'excerpt', 'audience'], 'Project context item');
  validatePersonUploadContextId(record.context_id); assertTimestamp(record.received_at, 'Project context item received_at');
  scalarText(record.title, 'Project context item title', 200); scalarText(record.excerpt, 'Project context item excerpt', 1200, true);
  if ([...(record.excerpt as string)].length > 300) fail('Project context item excerpt is invalid');
  return { context_id: record.context_id as string, received_at: record.received_at as string, title: record.title as string, excerpt: record.excerpt as string, audience: validatePersonUploadAudienceV3(record.audience) };
}
function page(value: unknown, kind: ProjectContextFeedV2['kind'] | ProjectContextSearchResultV2['kind']): ProjectContextFeedV2 | ProjectContextSearchResultV2 {
  const record = object(value, 'Project context page');
  assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'items', 'next_cursor'], 'Project context page');
  if (record.schema_version !== 2 || record.kind !== kind || !Array.isArray(record.items) || record.items.length > PROJECT_PAGE_MAX_ITEMS) fail('Project context page is invalid');
  const items = record.items.map(item);
  if (new Set(items.map(entry => entry.context_id)).size !== items.length) fail('Project context page contains duplicates');
  const response = { schema_version: 2 as const, kind, project_id: validateProjectIdV1(record.project_id, 'Project context page project_id'), items, next_cursor: record.next_cursor === null ? null : cursor(record.next_cursor, 'Project context page cursor') } as ProjectContextFeedV2 | ProjectContextSearchResultV2;
  responseBound(response, 'Project context page'); return response;
}
export function validateProjectContextFeedV2(value: unknown): ProjectContextFeedV2 { return page(value, 'echo-project-context-feed-v2') as ProjectContextFeedV2; }
export function validateProjectContextSearchResultV2(value: unknown): ProjectContextSearchResultV2 { return page(value, 'echo-project-context-search-result-v2') as ProjectContextSearchResultV2; }
export function validateProjectContextReadV2(value: unknown): ProjectContextReadV2 {
  const record = object(value, 'Project context read');
  assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'context_id', 'received_at', 'title', 'text', 'audience'], 'Project context read');
  if (record.schema_version !== 2 || record.kind !== 'echo-project-context-read-v2') fail('Project context read version or kind is unsupported');
  const response = { schema_version: 2 as const, kind: 'echo-project-context-read-v2' as const, project_id: validateProjectIdV1(record.project_id, 'Project context read project_id'), context_id: validatePersonUploadContextId(record.context_id), received_at: record.received_at as string, title: record.title as string, text: record.text as string, audience: validatePersonUploadAudienceV3(record.audience) };
  assertTimestamp(response.received_at, 'Project context read received_at'); scalarText(response.title, 'Project context read title', 200); scalarText(response.text, 'Project context read text', 8 * 1024, true);
  responseBound(response, 'Project context read'); return response;
}
