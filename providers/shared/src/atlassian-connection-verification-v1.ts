import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { PersonProviderV1 } from './person-provider-v1.js';

// Product-specific resource/account rules belong to this Atlassian family adapter.
type AtlassianPersonProviderV1 = PersonProviderV1 & { readonly id: 'jira' | 'confluence' };

export interface AtlassianConnectionCheckInputV1 {
  readonly signal?: AbortSignal;
  readonly expected_origin?: string;
  readonly require_account?: (account_id: string) => void;
}
const REQUIRED_SCOPES = Object.freeze({
  jira: [['read:jira-work'], ['read:jira-user']],
  confluence: [
    ['read:page:confluence'],
    ['read:space:confluence'],
    // Atlassian documents classic OR granular scopes for these v1 endpoints.
    ['search:confluence', 'read:content-details:confluence'],
    ['read:confluence-user', 'read:content-details:confluence'],
  ],
});

/**
 * Combine only checks queued before their remote I/O begins. Every later
 * fence starts fresh, even while the preceding verification remains in flight.
 * A reader owns this helper; callers retain their own local grant fences.
 */
export function createAtlassianVerificationBatchV1<T>(verify: (signal?: AbortSignal) => Promise<T>): (signal?: AbortSignal) => Promise<T> {
  const queued = new Map<AbortSignal | undefined, Promise<T>>();
  return async (signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const existing = queued.get(signal);
    if (existing !== undefined) return existing;
    const batch = new Promise<T>((resolve, reject) => {
      queueMicrotask(() => {
        // Clear before invoking the operation: a post-read caller must never
        // join a remote check that started before its resource read finished.
        queued.delete(signal);
        try {
          signal?.throwIfAborted();
          void verify(signal).then(resolve, reject);
        } catch (error) { reject(error); }
      });
    });
    queued.set(signal, batch);
    return batch;
  };
}

export function atlassianSiteOriginV1(provider: AtlassianPersonProviderV1, value: unknown): string {
  const raw = provider.string(value, provider.id === 'jira' ? 256 : 2048);
  let url: URL;
  try { url = new URL(raw); } catch { provider.failure('invalid_output'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(url.hostname) || (raw !== url.origin && raw !== `${url.origin}/`)) provider.failure('invalid_output');
  return url.origin;
}

/** Bind the exact product resource/site and current Atlassian account before releasing context. */
export async function verifyAtlassianConnectionV1(provider: AtlassianPersonProviderV1, transport: {
  readonly binding: PersonConnectorReadBindingV1;
  request(input: { readonly path: string; readonly signal?: AbortSignal }): Promise<unknown>;
}, input: AtlassianConnectionCheckInputV1 = {}): Promise<{ readonly origin: string; readonly account_id: string }> {
  const { signal } = input;
  const { external_scope_id: cloud, external_subject_id: subject } = transport.binding;
  signal?.throwIfAborted();
  const resources = provider.array(await transport.request({ path: '/oauth/token/accessible-resources', signal }), 256);
  signal?.throwIfAborted();
  const matches: Record<string, unknown>[] = [];
  for (const raw of resources) {
    const resource = provider.record(raw);
    const id = provider.string(resource.id, 256);
    const scopes = provider.array(resource.scopes, 256).map(scope => provider.string(scope, 128));
    // Jira and Confluence can share a cloud ID; never select the first resource.
    if (id === cloud && scopes.some(scope => scope.endsWith(`:${provider.id}`) || scope.includes(`:${provider.id}-`))) matches.push(resource);
  }
  if (matches.length !== 1) provider.failure('unauthorized');
  const selected = matches[0]!;
  const scopes = selected.scopes as readonly string[];
  if (!REQUIRED_SCOPES[provider.id].every(alternatives => alternatives.some(scope => scopes.includes(scope)))) provider.failure('unauthorized');
  const origin = atlassianSiteOriginV1(provider, selected.url);
  if (input.expected_origin !== undefined && input.expected_origin !== origin) provider.failure('stale_access_state');
  const path = provider.id === 'jira' ? `/ex/jira/${cloud}/rest/api/3/myself` : '/rest/api/user/current';
  const user = provider.record(await transport.request({ path, signal }));
  signal?.throwIfAborted();
  const account_id = provider.string(user.accountId, 256);
  if (input.require_account !== undefined) input.require_account(account_id);
  else if (account_id !== subject) provider.failure('unauthorized');
  // Jira requires active/accountType. Confluence's known-user schema makes both optional.
  const valid = provider.id === 'jira' ? user.active === true && user.accountType === 'atlassian'
    : user.type === 'known' && (user.active === undefined || user.active === true) &&
      (user.accountType === undefined || user.accountType === '' || user.accountType === 'atlassian');
  if (!valid) provider.failure('unauthorized');
  return Object.freeze({ origin, account_id });
}
