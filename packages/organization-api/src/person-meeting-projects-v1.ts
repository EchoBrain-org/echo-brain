import { validateProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, assertExactKeys, assertToolId, fail } from './validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MEETING_PROJECT_MAX_FOLDERS_V1 = 20;

interface PersonMeetingProjectReadV1 { readonly schema_version: 1; readonly project_id: string }
export interface PersonMeetingProjectSetV1 extends PersonMeetingProjectReadV1 {
  readonly request_id: string;
  readonly expected_revision: string | null;
  /** null removes the mapping. Values are immutable Meeting folder IDs. */
  readonly folder_ids: readonly string[] | null;
}
export interface PersonMeetingProjectMappingV1 extends PersonMeetingProjectReadV1 {
  readonly revision: string | null;
  readonly mapping: Readonly<{ cloud_id: string; folder_ids: readonly string[] }> | null;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Meeting project revision is invalid');
  return value;
}
function base(record: Record<string, unknown>): PersonMeetingProjectReadV1 {
  if (record.schema_version !== 1) fail('Meeting project version is unsupported');
  return { schema_version: 1, project_id: validateProjectIdV1(record.project_id) };
}
function folders(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MEETING_PROJECT_MAX_FOLDERS_V1 ||
      !value.every(id => typeof id === 'string' && FOLDER_ID.test(id)) || new Set(value).size !== value.length) fail(`${label} is invalid`);
  return Object.freeze([...value] as string[]);
}
export function validatePersonMeetingProjectReadV1(value: unknown): PersonMeetingProjectReadV1 {
  const record = asEnumerableRecord(value, 'Meeting project');
  assertExactKeys(record, ['schema_version', 'project_id'], 'Meeting project');
  return Object.freeze(base(record));
}
export function validatePersonMeetingProjectSetV1(value: unknown): PersonMeetingProjectSetV1 {
  const record = asEnumerableRecord(value, 'Meeting project setting');
  assertExactKeys(record, ['schema_version', 'project_id', 'request_id', 'expected_revision', 'folder_ids'], 'Meeting project setting');
  return Object.freeze({ ...base(record), request_id: uuid(record.request_id), expected_revision: record.expected_revision === null ? null : uuid(record.expected_revision), folder_ids: record.folder_ids === null ? null : folders(record.folder_ids, 'Meeting folder IDs') });
}
export function validatePersonMeetingProjectMappingV1(value: unknown): PersonMeetingProjectMappingV1 {
  const record = asEnumerableRecord(value, 'Meeting project mapping');
  assertExactKeys(record, ['schema_version', 'project_id', 'revision', 'mapping'], 'Meeting project mapping');
  const revision = record.revision === null ? null : uuid(record.revision);
  let mapping: PersonMeetingProjectMappingV1['mapping'] = null;
  if (record.mapping !== null) {
    const selected = asEnumerableRecord(record.mapping, 'Meeting project coordinates');
    assertExactKeys(selected, ['cloud_id', 'folder_ids'], 'Meeting project coordinates');
    if (revision === null || typeof selected.cloud_id !== 'string' || !FOLDER_ID.test(selected.cloud_id)) fail('Meeting project coordinates are invalid');
    mapping = Object.freeze({ cloud_id: selected.cloud_id, folder_ids: folders(selected.folder_ids, 'Meeting folder IDs') });
  }
  return Object.freeze({ ...base(record), revision, mapping });
}

export interface PersonMeetingFolderListV1 { readonly schema_version: 1; readonly cursor?: string }
interface PersonMeetingFolderV1 { readonly id: string; readonly key: string; readonly name: string }
export interface PersonMeetingFoldersPageV1 { readonly schema_version: 1; readonly items: readonly PersonMeetingFolderV1[]; readonly next_cursor: string | null }
const CURSOR = /^[A-Za-z0-9_-]{1,4096}$/;
function folderText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value !== value.normalize('NFC') || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) fail(`${label} is invalid`);
  return value;
}
export function validatePersonMeetingFolderListV1(value: unknown): PersonMeetingFolderListV1 {
  const record = asEnumerableRecord(value, 'Meeting folder list');
  assertExactKeys(record, ['schema_version', ...(Object.hasOwn(record, 'cursor') ? ['cursor'] : [])], 'Meeting folder list');
  if (record.schema_version !== 1 || (record.cursor !== undefined && (typeof record.cursor !== 'string' || !CURSOR.test(record.cursor)))) fail('Meeting folder list is invalid');
  return Object.freeze({ schema_version: 1, ...(record.cursor === undefined ? {} : { cursor: record.cursor }) });
}
export function validatePersonMeetingFoldersPageV1(value: unknown): PersonMeetingFoldersPageV1 {
  const record = asEnumerableRecord(value, 'Meeting folders page');
  assertExactKeys(record, ['schema_version', 'items', 'next_cursor'], 'Meeting folders page');
  if (record.schema_version !== 1 || !Array.isArray(record.items) || record.items.length > 20 || (record.next_cursor !== null && (typeof record.next_cursor !== 'string' || !CURSOR.test(record.next_cursor)))) fail('Meeting folders page is invalid');
  const items = Object.freeze(record.items.map(item => {
    const folder = asEnumerableRecord(item, 'Meeting folder');
    assertExactKeys(folder, ['id', 'key', 'name'], 'Meeting folder');
    if (typeof folder.id !== 'string' || !FOLDER_ID.test(folder.id)) fail('Meeting folder ID is invalid');
    return Object.freeze({ id: folder.id, key: folderText(folder.key, 'Meeting folder key'), name: folderText(folder.name, 'Meeting folder name') });
  }));
  if (new Set(items.map(item => item.id)).size !== items.length) fail('Meeting folders page is duplicated');
  return Object.freeze({ schema_version: 1, items, next_cursor: record.next_cursor as string | null });
}

/** Provider selection supplies the tool ID; a model or folder cannot supply a route. */
export function personMeetingProjectPathsV1(tool_id: string) {
  assertToolId(tool_id);
  const prefix = `/v1/person/tools/${tool_id}`;
  return Object.freeze({ read: `${prefix}/project/read`, set: `${prefix}/project/set`, folders: `${prefix}/folders/list` });
}
