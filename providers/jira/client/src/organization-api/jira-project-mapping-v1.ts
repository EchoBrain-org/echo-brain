import { validateProjectIdV1 } from '@echo-brain/organization-api';
import { asEnumerableRecord, assertExactKeys, fail } from '@echo-brain/organization-api/validation';

export const PERSON_JIRA_PROJECT_READ_PATH_V1 = '/v1/person/tools/jira/project/read';
export const PERSON_JIRA_PROJECT_SET_PATH_V1 = '/v1/person/tools/jira/project/set';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface JiraProjectReadV1 { readonly schema_version: 1; readonly project_id: string }
export interface JiraProjectSetV1 extends JiraProjectReadV1 {
  readonly request_id: string;
  readonly expected_revision: string | null;
  readonly jira_project: string | null;
}
export interface JiraProjectMappingV1 extends JiraProjectReadV1 {
  readonly revision: string | null;
  readonly mapping: Readonly<{ cloud_id: string; project_id: string; project_key: string }> | null;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Jira project revision is invalid');
  return value;
}
function base(record: Record<string, unknown>): JiraProjectReadV1 {
  if (record.schema_version !== 1) fail('Jira project version is unsupported');
  return { schema_version: 1, project_id: validateProjectIdV1(record.project_id) };
}
export function validateJiraProjectReadV1(value: unknown): JiraProjectReadV1 {
  const record = asEnumerableRecord(value, 'Jira project');
  assertExactKeys(record, ['schema_version', 'project_id'], 'Jira project');
  return Object.freeze(base(record));
}
export function validateJiraProjectSetV1(value: unknown): JiraProjectSetV1 {
  const record = asEnumerableRecord(value, 'Jira project setting');
  assertExactKeys(record, ['schema_version', 'project_id', 'request_id', 'expected_revision', 'jira_project'], 'Jira project setting');
  if (record.jira_project !== null && (typeof record.jira_project !== 'string' || !(ID.test(record.jira_project) || KEY.test(record.jira_project)))) fail('Jira project key is invalid');
  return Object.freeze({ ...base(record), request_id: uuid(record.request_id), expected_revision: record.expected_revision === null ? null : uuid(record.expected_revision), jira_project: record.jira_project as string | null });
}
export function validateJiraProjectMappingV1(value: unknown): JiraProjectMappingV1 {
  const record = asEnumerableRecord(value, 'Jira project mapping');
  assertExactKeys(record, ['schema_version', 'project_id', 'revision', 'mapping'], 'Jira project mapping');
  const revision = record.revision === null ? null : uuid(record.revision);
  let mapping: JiraProjectMappingV1['mapping'] = null;
  if (record.mapping !== null) {
    const selected = asEnumerableRecord(record.mapping, 'Jira project coordinates');
    assertExactKeys(selected, ['cloud_id', 'project_id', 'project_key'], 'Jira project coordinates');
    if (revision === null || typeof selected.cloud_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(selected.cloud_id) || typeof selected.project_id !== 'string' || !ID.test(selected.project_id) || typeof selected.project_key !== 'string' || !KEY.test(selected.project_key)) fail('Jira project coordinates are invalid');
    mapping = Object.freeze({ cloud_id: selected.cloud_id, project_id: selected.project_id, project_key: selected.project_key });
  }
  return Object.freeze({ ...base(record), revision, mapping });
}
