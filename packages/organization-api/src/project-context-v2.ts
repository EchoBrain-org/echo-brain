import { asEnumerableRecord as object, assertBoundedText as text, assertExactKeys, assertTimestamp, fail, pageCursor } from './validation.js';
import { validatePersonUploadContextId } from './person-updates.js';
import { responseBound } from './person-update-validation.js';
import { PROJECT_PAGE_MAX_ITEMS, type ProjectIdV1, type ProjectRoleV1, validateProjectIdV1, validateProjectNameV1, validateProjectRoleV1 } from './project-context-v1.js';
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
export interface ProjectContextSearchResultV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-project-context-search-result-v2';
  readonly project_id: ProjectIdV1;
  readonly items: readonly ProjectContextItemV2[];
  readonly next_cursor: string | null;
}

function cursor(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail(`${label} is invalid`);
  return value;
}
function status(value: unknown): asserts value is ProjectStatusV2 { if (value !== 'active' && value !== 'archived') fail('Project status is invalid'); }
export function validateProjectPageRequestV2(value: unknown): ProjectPageRequestV2 {
  const record = object(value, 'Project page request');
  assertExactKeys(record, [...(Object.hasOwn(record, 'limit') ? ['limit'] : []), ...(Object.hasOwn(record, 'cursor') ? ['cursor'] : []), ...(Object.hasOwn(record, 'status') ? ['status'] : [])], 'Project page request');
  if (Object.hasOwn(record, 'limit') && (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > PROJECT_PAGE_MAX_ITEMS)) fail('Project page request limit is invalid');
  if (Object.hasOwn(record, 'status')) status(record.status);
  return { limit: (record.limit as number | undefined) ?? PROJECT_PAGE_MAX_ITEMS, ...(Object.hasOwn(record, 'cursor') ? { cursor: pageCursor(record.cursor, 'Project page request cursor') } : {}), status: (record.status as ProjectStatusV2 | undefined) ?? 'active' };
}
export function validateProjectSummaryV2(value: unknown): ProjectSummaryV2 {
  const record = object(value, 'Project summary');
  assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'name', 'created_at', 'role', 'status'], 'Project summary');
  if (record.schema_version !== 2 || record.kind !== 'echo-project-summary-v2') fail('Project summary version or kind is unsupported');
  const project_id = validateProjectIdV1(record.project_id, 'Project summary project_id'); const name = validateProjectNameV1(record.name); assertTimestamp(record.created_at, 'Project summary created_at'); const role = validateProjectRoleV1(record.role); status(record.status);
  return { schema_version: 2, kind: 'echo-project-summary-v2', project_id, name, created_at: record.created_at as string, role, status: record.status };
}
export function validateProjectListV2(value: unknown): ProjectListV2 {
  const record = object(value, 'Project list');
  assertExactKeys(record, ['schema_version', 'kind', 'items', 'next_cursor'], 'Project list');
  if (record.schema_version !== 2 || record.kind !== 'echo-project-list-v2' || !Array.isArray(record.items) || record.items.length > PROJECT_PAGE_MAX_ITEMS) fail('Project list is invalid');
  const items = record.items.map(validateProjectSummaryV2);
  if (new Set(items.map(item => item.project_id)).size !== items.length) fail('Project list contains duplicates');
  const response = { schema_version: 2 as const, kind: 'echo-project-list-v2' as const, items, next_cursor: record.next_cursor === null ? null : pageCursor(record.next_cursor, 'Project list next_cursor') };
  responseBound(response, 'Project list'); return response;
}
function item(value: unknown): ProjectContextItemV2 {
  const record = object(value, 'Project context item');
  assertExactKeys(record, ['context_id', 'received_at', 'title', 'excerpt', 'audience'], 'Project context item');
  validatePersonUploadContextId(record.context_id); assertTimestamp(record.received_at, 'Project context item received_at');
  text(record.title, 'Project context item title', 200); text(record.excerpt, 'Project context item excerpt', 1200, true);
  if ([...(record.excerpt as string)].length > 300) fail('Project context item excerpt is invalid');
  return { context_id: record.context_id as string, received_at: record.received_at as string, title: record.title as string, excerpt: record.excerpt as string, audience: validatePersonUploadAudienceV3(record.audience) };
}
export function validateProjectContextSearchResultV2(value: unknown): ProjectContextSearchResultV2 {
  const record = object(value, 'Project context page');
  assertExactKeys(record, ['schema_version', 'kind', 'project_id', 'items', 'next_cursor'], 'Project context page');
  if (record.schema_version !== 2 || record.kind !== 'echo-project-context-search-result-v2' || !Array.isArray(record.items) || record.items.length > PROJECT_PAGE_MAX_ITEMS) fail('Project context page is invalid');
  const items = record.items.map(item);
  if (new Set(items.map(entry => entry.context_id)).size !== items.length) fail('Project context page contains duplicates');
  const response = { schema_version: 2 as const, kind: 'echo-project-context-search-result-v2' as const, project_id: validateProjectIdV1(record.project_id, 'Project context page project_id'), items, next_cursor: record.next_cursor === null ? null : cursor(record.next_cursor, 'Project context page cursor') };
  responseBound(response, 'Project context page'); return response;
}
