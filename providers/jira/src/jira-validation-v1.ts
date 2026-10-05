import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

export function jiraFailure(code: 'invalid_request' | 'invalid_output' | 'unauthorized' | 'not_found' | 'stale_access_state' | 'unavailable' | 'rate_limited'): never {
  throw new AuthorityOperationError(code, 'Jira live evidence operation could not be completed');
}

/** Provider objects may have extra fields, but never executable properties. */
export function jiraRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d) || !d.enumerable)) jiraFailure('invalid_output');
  return value as Record<string, unknown>;
}

export function jiraArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1) jiraFailure('invalid_output');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (d === undefined || !('value' in d) || !d.enumerable) jiraFailure('invalid_output');
  }
  return value;
}

export function jiraString(value: unknown, maximum = 256, pattern = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum ||
      value !== value.normalize('NFC') || !pattern.test(value)) jiraFailure('invalid_output');
  return value;
}

export const JIRA_CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const JIRA_ID = /^[1-9][0-9]{0,19}$/;
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
export const JIRA_TICKET_KEY = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,19}$/;

export function copyJiraBindingV1(value: PersonConnectorReadBindingV1): PersonConnectorReadBindingV1 {
  jiraRecord(value);
  for (const field of ['organization_id', 'principal_id', 'membership_id', 'external_subject_id'] as const) jiraString(value[field]);
  if (value.tool_id !== 'jira' || typeof value.external_scope_id !== 'string' || !JIRA_CLOUD_ID.test(value.external_scope_id) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.read_grant_sha256)) jiraFailure('unauthorized');
  return Object.freeze({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id,
    tool_id: 'jira', external_scope_id: value.external_scope_id, external_subject_id: value.external_subject_id, read_grant_sha256: value.read_grant_sha256 });
}

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
