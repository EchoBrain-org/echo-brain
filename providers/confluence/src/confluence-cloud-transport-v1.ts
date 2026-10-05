import { createPersonProviderJsonTransportV1, PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1, type PersonProviderAuthenticatedFetchV1 } from '@echo-brain/provider-runtime/person-provider-json-transport-v1';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { CONFLUENCE_PERSON_PROVIDER_V1, CONFLUENCE_CLOUD_ID, confluenceFailure, copyConfluenceBindingV1 } from './confluence-validation-v1.js';

export interface ConfluenceCloudRequestV1 {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly signal?: AbortSignal;
}

/** Authorization is owned by the connection and revalidated for each request. */
export type ConfluenceCloudAuthenticatedFetchV1 = PersonProviderAuthenticatedFetchV1;
export interface ConfluenceCloudTransportV1 {
  readonly binding: PersonConnectorReadBindingV1;
  request(input: ConfluenceCloudRequestV1): Promise<unknown>;
}

export const CONFLUENCE_RESPONSE_MAX_BYTES_V1 = PERSON_PROVIDER_RESPONSE_MAX_BYTES_V1;
const NUMERIC_ID = '[1-9][0-9]{0,19}';
const PAGE = new RegExp(`^/api/v2/pages/${NUMERIC_ID}$`);
const SPACE = new RegExp(`^/api/v2/spaces/${NUMERIC_ID}$`);
const SPACE_PAGES = new RegExp(`^/api/v2/spaces/${NUMERIC_ID}/pages$`);
const PAGE_LIST_STATUSES = new Set(['current', 'archived', 'deleted', 'trashed']);
const PAGE_STATUSES = new Set([...PAGE_LIST_STATUSES, 'historical', 'draft']);
const SPACE_ID = new RegExp(`^${NUMERIC_ID}$`);

function stringQuery(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

/** Endpoint and selector ownership stays inside the adapter, never a provider-supplied URL. */
function requestUrl(cloud: string, input: ConfluenceCloudRequestV1): URL {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['path', 'query', 'signal'].includes(key))) confluenceFailure('invalid_request');
  const path = input.path;
  if (typeof path !== 'string') confluenceFailure('invalid_request');
  const resources = path === '/oauth/token/accessible-resources';
  const page = PAGE.test(path);
  const pageList = path === '/api/v2/pages' || SPACE_PAGES.test(path);
  const spaces = path === '/api/v2/spaces';
  const search = path === '/rest/api/search';
  if (!(resources || path === '/rest/api/user/current' || page || pageList || spaces || SPACE.test(path) || search)) {
    confluenceFailure('invalid_request');
  }
  const url = new URL(resources ? `https://api.atlassian.com${path}` : `https://api.atlassian.com/ex/confluence/${cloud}/wiki${path}`);
  if (input.query !== undefined && (input.query === null || typeof input.query !== 'object' || Array.isArray(input.query))) confluenceFailure('invalid_request');
  for (const [key, value] of Object.entries(input.query ?? {})) {
    // Unknown selectors are refused even if their value is undefined.
    const allowed = key === 'limit' && (pageList || spaces || search) ||
      key === 'cursor' && (pageList || spaces || search) ||
      key === 'status' && (pageList || page) || key === 'body-format' && page ||
      (key === 'space-id' || key === 'id') && path === '/api/v2/pages' ||
      (key === 'cql' || key === 'expand' || key === 'includeArchivedSpaces') && search;
    if (!allowed) confluenceFailure('invalid_request');
    if (value === undefined) continue;
    if (key === 'space-id' || key === 'id') {
      const values = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(values) || values.length < 1 || values.length > (key === 'id' ? 250 : 100) || new Set(values).size !== values.length ||
          values.some(id => typeof id !== 'string' || !SPACE_ID.test(id))) confluenceFailure('invalid_request');
      // This endpoint documents the IDs as a comma-separated list.
      url.searchParams.set(key, values.join(','));
      continue;
    }
    if (key === 'status') {
      const statuses = page ? PAGE_STATUSES : PAGE_LIST_STATUSES;
      const values = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(values) || values.length < 1 || values.length > statuses.size ||
          new Set(values).size !== values.length || values.some(status => typeof status !== 'string' || !statuses.has(status))) confluenceFailure('invalid_request');
      for (const status of values) url.searchParams.append(key, status);
      continue;
    }
    if (!stringQuery(value, key === 'cql' || key === 'cursor' ? 4096 : 128)) confluenceFailure('invalid_request');
    if (key === 'limit' && (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 250) ||
        key === 'body-format' && value !== 'atlas_doc_format' || key === 'expand' && value !== 'content' ||
        key === 'includeArchivedSpaces' && value !== 'true' && value !== 'false') confluenceFailure('invalid_request');
    url.searchParams.set(key, value);
  }
  return url;
}

/** Confluence remains GET-only; its endpoint and selector checks precede shared transport I/O. */
export function createConfluenceCloudTransportV1(authenticated: ConfluenceCloudAuthenticatedFetchV1): ConfluenceCloudTransportV1 {
  const cloud = copyConfluenceBindingV1(authenticated.binding).external_scope_id;
  if (typeof cloud !== 'string' || !CONFLUENCE_CLOUD_ID.test(cloud)) confluenceFailure('unauthorized');
  return createPersonProviderJsonTransportV1(CONFLUENCE_PERSON_PROVIDER_V1, authenticated,
    (input: ConfluenceCloudRequestV1) => ({ url: requestUrl(cloud, input) }));
}
