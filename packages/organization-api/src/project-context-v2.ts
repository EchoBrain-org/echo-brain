import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, assertTimestamp, fail } from './validation.js';
import { validatePersonUploadContextId } from './person-updates.js';
import { PROJECT_CONTEXT_RESPONSE_MAX_BYTES, PROJECT_PAGE_MAX_ITEMS, type ProjectIdV1, validateProjectIdV1 } from './project-context-v1.js';
import { validatePersonUploadAudienceV3, type PersonUploadAudienceV3 } from './person-upload-audience-v3.js';

export const PERSON_PROJECTS_PATH_V2 = '/v2/person/projects';

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
function responseBound(value: unknown, label: string): void {
  if (canonicalJsonBytes(value).byteLength > PROJECT_CONTEXT_RESPONSE_MAX_BYTES) fail(`${label} exceeds JSON byte bound`);
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
