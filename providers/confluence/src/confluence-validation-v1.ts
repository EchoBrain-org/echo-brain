import { createPersonProviderValidationV1, type PersonProviderFailureCodeV1 } from '@echo-brain/provider-runtime/person-provider-v1';
export const CONFLUENCE_CLOUD_ID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/** A Confluence page or space id. */
export const CONFLUENCE_ID = /^[1-9][0-9]{0,19}$/;
const API_ORIGIN = 'https://api.atlassian.com';
const validation = createPersonProviderValidationV1('confluence', CONFLUENCE_CLOUD_ID, 'Confluence live evidence operation could not be completed');
export const { record: confluenceRecord, array: confluenceArray, copyBinding: copyConfluenceBindingV1 } = validation;
export function confluenceFailure(code: PersonProviderFailureCodeV1): never { return validation.failure(code); }
/**
 * A Confluence string within `maximum` UTF-16 code units, also as the provider's string the shared Atlassian modules call.
 * The shared check counts UTF-8 bytes, so it allows three per code unit, the most one takes: no string within `maximum`
 * code units is refused.
 */
export function confluenceString(value: unknown, maximum = 1024, pattern?: RegExp): string {
  return validation.string(value, maximum * 3, pattern);
}
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
