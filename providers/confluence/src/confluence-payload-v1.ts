import type { ConfluenceCloudTransportV1 } from './confluence-cloud-transport-v1.js';
import { confluenceArray, confluenceFailure, confluenceRecord, confluenceString } from './confluence-validation-v1.js';

const REQUIRED_SCOPES = Object.freeze([
  'read:page:confluence',
  'read:space:confluence',
  'search:confluence',
  'read:confluence-user',
]);

function confluenceSiteOrigin(value: unknown): string {
  const raw = confluenceString(value, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { confluenceFailure('invalid_output'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/i.test(url.hostname) || (raw !== url.origin && raw !== `${url.origin}/`)) confluenceFailure('invalid_output');
  return url.origin;
}

/** Verifies the exact cloud resource, permissions, pinned site and authenticated Atlassian account. */
export async function verifyConfluenceConnectionV1(transport: ConfluenceCloudTransportV1, input: { readonly signal?: AbortSignal; readonly expected_origin?: string; readonly require_account?: (account: string) => void } = {}) {
  const cloud = transport.binding.external_scope_id!;
  const subject = transport.binding.external_subject_id;
  input.signal?.throwIfAborted();
  const matches: Record<string, unknown>[] = [];
  for (const raw of confluenceArray(await transport.request({ path: '/oauth/token/accessible-resources', signal: input.signal }), 256)) {
    const resource = confluenceRecord(raw);
    const id = confluenceString(resource.id, 256);
    const scopes = confluenceArray(resource.scopes, 256).map(scope => confluenceString(scope, 128));
    if (id === cloud && scopes.some(scope => scope.endsWith(':confluence') || scope.includes(':confluence-'))) matches.push(resource);
  }
  if (matches.length !== 1) confluenceFailure('unauthorized');
  const selected = matches[0]!;
  const scopes = confluenceArray(selected.scopes, 256).map(scope => confluenceString(scope, 128));
  if (!REQUIRED_SCOPES.every(scope => scopes.includes(scope))) confluenceFailure('unauthorized');
  const origin = confluenceSiteOrigin(selected.url);
  if (input.expected_origin !== undefined && input.expected_origin !== origin) confluenceFailure('stale_access_state');
  const user = confluenceRecord(await transport.request({ path: '/rest/api/user/current', signal: input.signal }));
  const account = confluenceString(user.accountId, 256);
  if (input.require_account !== undefined) input.require_account(account);
  else if (account !== subject) confluenceFailure('unauthorized');
  // Confluence's User schema has no required `active` field (unlike Jira).
  // `accountType` is also optional and documented as empty when unavailable.
  // Bind the known current user's accountId; never accept an explicit app.
  if ((user.active !== undefined && user.active !== true) || user.type !== 'known' ||
      (user.accountType !== undefined && user.accountType !== '' && user.accountType !== 'atlassian')) confluenceFailure('unauthorized');
  return Object.freeze({ origin, account_id: account });
}
