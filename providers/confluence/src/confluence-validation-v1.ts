import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
export const CONFLUENCE_CLOUD_ID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/** A Confluence page or space id. */
export const CONFLUENCE_ID = /^[1-9][0-9]{0,19}$/;
const API_ORIGIN = 'https://api.atlassian.com';
export function confluenceFailure(code: 'invalid_request'|'invalid_output'|'unauthorized'|'not_found'|'stale_access_state'|'unavailable'|'rate_limited'): never { throw new AuthorityOperationError(code, 'Confluence live evidence operation could not be completed'); }
export function confluenceString(value: unknown, max=1024, pattern?: RegExp): string { if(typeof value!=='string'||value.length<1||value.length>max||value!==value.normalize('NFC')||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)||(pattern!==undefined&&!pattern.test(value))) confluenceFailure('invalid_output'); return value; }
export function confluenceRecord(value: unknown): Record<string,unknown> { if(value===null||typeof value!=='object'||Array.isArray(value)) confluenceFailure('invalid_output'); return value as Record<string,unknown>; }
export function confluenceArray(value: unknown, max=512): readonly unknown[] { if(!Array.isArray(value)||value.length>max) confluenceFailure('invalid_output'); return value; }
/**
 * The opaque cursor of a Confluence next link to `path`, by its public wiki or OAuth proxy path, never the link itself:
 * a next link repeats limit, status and space selectors, and only the cursor goes on to our own pinned request.
 */
export function confluenceNextCursorV1(raw: unknown, cloud: string, path: string, maximum = 4096): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let url: URL;
  try { url = new URL(confluenceString(raw, maximum), API_ORIGIN); } catch { confluenceFailure('invalid_output'); }
  const paths = [path, `/wiki${path}`, `/ex/confluence/${cloud}/wiki${path}`];
  if (url.origin !== API_ORIGIN || !paths.includes(url.pathname) || url.username !== '' || url.password !== '' || url.hash !== '' ||
      url.searchParams.getAll('cursor').length !== 1) confluenceFailure('invalid_output');
  return confluenceString(url.searchParams.get('cursor'), 4096);
}
/** A page version's number (`version.number`): a positive safe integer, as text. */
export function confluenceVersionNumberV1(version: Record<string, unknown>): string {
  const number = version.number;
  if (!Number.isSafeInteger(number) || (number as number) < 1) confluenceFailure('invalid_output');
  return String(number);
}
/** A page body's Atlassian document (`body.atlas_doc_format`): the JSON text of its value. */
export function confluenceAtlasDocumentV1(body: unknown): string {
  const representation = confluenceRecord(confluenceRecord(body).atlas_doc_format);
  if (representation.representation !== undefined && representation.representation !== 'atlas_doc_format') confluenceFailure('invalid_output');
  if (typeof representation.value !== 'string') confluenceFailure('invalid_output');
  return representation.value;
}
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
