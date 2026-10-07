import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
export const CONFLUENCE_CLOUD_ID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function confluenceFailure(code: 'invalid_request'|'invalid_output'|'unauthorized'|'not_found'|'stale_access_state'|'unavailable'|'rate_limited'): never { throw new AuthorityOperationError(code, 'Confluence live evidence operation could not be completed'); }
export function confluenceString(value: unknown, max=1024, pattern?: RegExp): string { if(typeof value!=='string'||value.length<1||value.length>max||value!==value.normalize('NFC')||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)||(pattern!==undefined&&!pattern.test(value))) confluenceFailure('invalid_output'); return value; }
export function confluenceRecord(value: unknown): Record<string,unknown> { if(value===null||typeof value!=='object'||Array.isArray(value)) confluenceFailure('invalid_output'); return value as Record<string,unknown>; }
export function confluenceArray(value: unknown, max=512): readonly unknown[] { if(!Array.isArray(value)||value.length>max) confluenceFailure('invalid_output'); return value; }
export function copyConfluenceBindingV1(value: PersonConnectorReadBindingV1): PersonConnectorReadBindingV1 { if(value.tool_id!=='confluence'||typeof value.external_scope_id!=='string'||typeof value.external_subject_id!=='string'||typeof value.read_grant_sha256!=='string') confluenceFailure('unauthorized'); return Object.freeze({...value}); }

/** Fixed server-only policy for shared Atlassian consent and custody. */
export const CONFLUENCE_PERSON_PROVIDER_V1 = Object.freeze({
  nango_provider_id: 'confluence',
  id: 'confluence' as const,
  storage_namespace: 'confluence',
  display_name: 'Confluence',
  scope_id_pattern: CONFLUENCE_CLOUD_ID,
  oauth_scopes: 'offline_access read:page:confluence read:space:confluence read:content-details:confluence',
  credential_origin: 'https://api.atlassian.com',
  credential_paths: (cloudId: string) => ['/oauth/token/accessible-resources', `/ex/confluence/${cloudId}/wiki/api/v2/`, `/ex/confluence/${cloudId}/wiki/rest/api/`],
  failure: confluenceFailure,
  string: confluenceString,
  record: confluenceRecord,
  array: confluenceArray,
  copyBinding: copyConfluenceBindingV1,
});
