import { createPersonProviderValidationV1, type PersonProviderFailureCodeV1 } from '@echo-brain/provider-runtime/person-provider-v1';
export const JIRA_CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const JIRA_ID = /^[1-9][0-9]{0,19}$/;
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
export const JIRA_TICKET_KEY = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,19}$/;


const validation = createPersonProviderValidationV1('jira', JIRA_CLOUD_ID, 'Jira live evidence operation could not be completed');
export const { record: jiraRecord, array: jiraArray, string: jiraString, copyBinding: copyJiraBindingV1 } = validation;
export function jiraFailure(code: PersonProviderFailureCodeV1): never { return validation.failure(code); }

/** Bound by UTF-8 code points, then NFC again in case truncation split a combining sequence. */
export function jiraBoundText(value: string, maximum: number): { readonly text: string; readonly truncated: boolean } {
  const normalized = value.normalize('NFC');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cs}]/u.test(normalized)) jiraFailure('invalid_output');
  let text = ''; let bytes = 0;
  for (const point of normalized) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > maximum) break;
    bytes += size; text += point;
  }
  return { text: text.normalize('NFC'), truncated: text !== normalized };
}

export function jiraDay(value: unknown, code: 'invalid_output' | 'invalid_request' = 'invalid_output'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) jiraFailure(code);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) jiraFailure(code);
  return value;
}

/** Fixed server-only policy for shared Atlassian consent and custody. */
export const JIRA_PERSON_PROVIDER_V1 = Object.freeze({
  nango_provider_id: 'jira',
  id: 'jira' as const,
  storage_namespace: 'jira',
  display_name: 'Jira',
  scope_id_pattern: JIRA_CLOUD_ID,
  oauth_scopes: 'offline_access read:jira-work read:jira-user',
  credential_origin: 'https://api.atlassian.com',
  credential_paths: (cloudId: string) => ['/oauth/token/accessible-resources', `/ex/jira/${cloudId}/rest/api/3/`],
  failure: jiraFailure,
  string: jiraString,
  record: jiraRecord,
  array: jiraArray,
  copyBinding: copyJiraBindingV1,
});
