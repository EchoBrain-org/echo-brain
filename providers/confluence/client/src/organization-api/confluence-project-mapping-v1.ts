import { validateProjectIdV1 } from '@echo-brain/organization-api';
import { asEnumerableRecord, assertExactKeys, fail } from '@echo-brain/organization-api/validation';

export const PERSON_CONFLUENCE_PROJECT_READ_PATH_V1 = '/v1/person/tools/confluence/project/read';
export const PERSON_CONFLUENCE_PROJECT_SET_PATH_V1 = '/v1/person/tools/confluence/project/set';
export const PERSON_CONFLUENCE_PROJECT_LIST_PATH_V1 = '/v1/person/tools/confluence/project/list';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SPACE_ID = /^[1-9][0-9]{0,19}$/;
export const CONFLUENCE_PROJECT_MAX_SPACES_V1 = 20;

export interface ConfluenceProjectReadV1 { readonly schema_version: 1; readonly project_id: string }
export interface ConfluenceProjectSetV1 extends ConfluenceProjectReadV1 {
  readonly request_id: string;
  readonly expected_revision: string | null;
  /** null removes the mapping. Values are immutable Confluence space IDs. */
  readonly space_ids: readonly string[] | null;
}
export interface ConfluenceProjectMappingV1 extends ConfluenceProjectReadV1 {
  readonly revision: string | null;
  readonly mapping: Readonly<{ cloud_id: string; space_ids: readonly string[] }> | null;
}
export interface ConfluenceProjectMappingsV1 { readonly schema_version: 1; readonly mappings: readonly ConfluenceProjectMappingV1[] }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Confluence project revision is invalid');
  return value;
}
function base(record: Record<string, unknown>): ConfluenceProjectReadV1 {
  if (record.schema_version !== 1) fail('Confluence project version is unsupported');
  return { schema_version: 1, project_id: validateProjectIdV1(record.project_id) };
}
function spaces(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONFLUENCE_PROJECT_MAX_SPACES_V1 ||
      !value.every(id => typeof id === 'string' && SPACE_ID.test(id)) || new Set(value).size !== value.length) fail(`${label} is invalid`);
  return Object.freeze([...value] as string[]);
}
export function validateConfluenceProjectReadV1(value: unknown): ConfluenceProjectReadV1 {
  const record = asEnumerableRecord(value, 'Confluence project');
  assertExactKeys(record, ['schema_version', 'project_id'], 'Confluence project');
  return Object.freeze(base(record));
}
export function validateConfluenceProjectSetV1(value: unknown): ConfluenceProjectSetV1 {
  const record = asEnumerableRecord(value, 'Confluence project setting');
  assertExactKeys(record, ['schema_version', 'project_id', 'request_id', 'expected_revision', 'space_ids'], 'Confluence project setting');
  return Object.freeze({ ...base(record), request_id: uuid(record.request_id), expected_revision: record.expected_revision === null ? null : uuid(record.expected_revision), space_ids: record.space_ids === null ? null : spaces(record.space_ids, 'Confluence space IDs') });
}
export function validateConfluenceProjectMappingV1(value: unknown): ConfluenceProjectMappingV1 {
  const record = asEnumerableRecord(value, 'Confluence project mapping');
  assertExactKeys(record, ['schema_version', 'project_id', 'revision', 'mapping'], 'Confluence project mapping');
  const revision = record.revision === null ? null : uuid(record.revision);
  let mapping: ConfluenceProjectMappingV1['mapping'] = null;
  if (record.mapping !== null) {
    const selected = asEnumerableRecord(record.mapping, 'Confluence project coordinates');
    assertExactKeys(selected, ['cloud_id', 'space_ids'], 'Confluence project coordinates');
    if (revision === null || typeof selected.cloud_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(selected.cloud_id)) fail('Confluence project coordinates are invalid');
    mapping = Object.freeze({ cloud_id: selected.cloud_id, space_ids: spaces(selected.space_ids, 'Confluence space IDs') });
  }
  return Object.freeze({ ...base(record), revision, mapping });
}
export function validateConfluenceProjectMappingsV1(value: unknown): ConfluenceProjectMappingsV1 {
  const record = asEnumerableRecord(value, 'Confluence project mappings');
  assertExactKeys(record, ['schema_version', 'mappings'], 'Confluence project mappings');
  if (record.schema_version !== 1 || !Array.isArray(record.mappings) || record.mappings.length > 100) fail('Confluence project mappings are invalid');
  const mappings = Object.freeze(record.mappings.map(validateConfluenceProjectMappingV1));
  if (new Set(mappings.map(mapping => mapping.project_id)).size !== mappings.length) fail('Confluence project mappings are duplicated');
  return Object.freeze({ schema_version: 1, mappings });
}

export const PERSON_CONFLUENCE_SPACES_LIST_PATH_V1 = '/v1/person/tools/confluence/spaces/list';
export interface ConfluenceSpaceListV1 { readonly schema_version: 1; readonly cursor?: string }
export interface ConfluenceSpaceV1 { readonly id: string; readonly key: string; readonly name: string }
export interface ConfluenceSpacesPageV1 { readonly schema_version: 1; readonly items: readonly ConfluenceSpaceV1[]; readonly next_cursor: string | null }
const CURSOR = /^[A-Za-z0-9_-]{1,4096}$/;
function spaceText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value !== value.normalize('NFC') || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) fail(`${label} is invalid`);
  return value;
}
export function validateConfluenceSpaceListV1(value: unknown): ConfluenceSpaceListV1 {
  const record = asEnumerableRecord(value, 'Confluence space list');
  assertExactKeys(record, ['schema_version', ...(Object.hasOwn(record, 'cursor') ? ['cursor'] : [])], 'Confluence space list');
  if (record.schema_version !== 1 || (record.cursor !== undefined && (typeof record.cursor !== 'string' || !CURSOR.test(record.cursor)))) fail('Confluence space list is invalid');
  return Object.freeze({ schema_version: 1, ...(record.cursor === undefined ? {} : { cursor: record.cursor }) });
}
export function validateConfluenceSpacesPageV1(value: unknown): ConfluenceSpacesPageV1 {
  const record = asEnumerableRecord(value, 'Confluence spaces page');
  assertExactKeys(record, ['schema_version', 'items', 'next_cursor'], 'Confluence spaces page');
  if (record.schema_version !== 1 || !Array.isArray(record.items) || record.items.length > 20 || (record.next_cursor !== null && (typeof record.next_cursor !== 'string' || !CURSOR.test(record.next_cursor)))) fail('Confluence spaces page is invalid');
  const items = Object.freeze(record.items.map(item => {
    const space = asEnumerableRecord(item, 'Confluence space');
    assertExactKeys(space, ['id', 'key', 'name'], 'Confluence space');
    if (typeof space.id !== 'string' || !SPACE_ID.test(space.id)) fail('Confluence space ID is invalid');
    return Object.freeze({ id: space.id, key: spaceText(space.key, 'Confluence space key'), name: spaceText(space.name, 'Confluence space name') });
  }));
  if (new Set(items.map(item => item.id)).size !== items.length) fail('Confluence spaces page is duplicated');
  return Object.freeze({ schema_version: 1, items, next_cursor: record.next_cursor as string | null });
}
