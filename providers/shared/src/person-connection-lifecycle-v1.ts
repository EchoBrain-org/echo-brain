import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { PersonConnectionStoreV1, PersonConnectionAttemptFailureV1, PersonConnectionAttemptV1, ConnectedPersonV1 } from './person-connection-store-v1.js';
import type { NangoPersonConnectionV1 } from './nango-person-connection-v1.js';
import type { PersonProviderV1 } from './person-provider-v1.js';

export interface PersonConnectionAuthorizationV1 extends ConnectedPersonV1 { readonly authorization_sha256: Sha256Digest }
export interface PersonConnectionAuthenticatedFetchV1 {
  readonly binding: PersonConnectorReadBindingV1;
  fetch(url: string, init: RequestInit): Promise<Response>;
}
type PersonConnectionAttemptResponseV1 = Readonly<{
  schema_version: 1;
  attempt: string;
  expires_at: string;
  status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
  failure_reason: PersonConnectionAttemptFailureV1 | null;
}>;

class PersonConnectionCompletionFailure extends Error {
  constructor(readonly reason: PersonConnectionAttemptFailureV1) { super(reason); }
}

function expiresAt(value: number): string { return new Date(value).toISOString(); }
function attemptResponse(value: PersonConnectionAttemptV1): PersonConnectionAttemptResponseV1 {
  return Object.freeze({ schema_version: 1 as const, attempt: value.attempt, expires_at: expiresAt(value.expires), status: value.status, failure_reason: value.failure_reason });
}
function completionFailure(error: unknown): PersonConnectionAttemptFailureV1 {
  if (error instanceof PersonConnectionCompletionFailure) return error.reason;
  if (error instanceof AuthorityOperationError && (error.code === 'unavailable' || error.code === 'rate_limited')) return 'provider_unavailable';
  return 'provider_rejected';
}

/** Personal OAuth consent and ECHO ownership; Nango owns token storage and refresh. */
export function createPersonConnectionLifecycleV1(options: {
  readonly provider: PersonProviderV1;
  readonly store: PersonConnectionStoreV1;
  readonly nango: NangoPersonConnectionV1;
  readonly scope_id: string;
  readonly fetch: typeof fetch;
  readonly authenticate: (access_token: string) => PersonConnectionAuthorizationV1;
  readonly verify: (authenticated: PersonConnectionAuthenticatedFetchV1, input: {
    readonly signal?: AbortSignal;
    readonly require_account: (account: string) => void;
  }) => Promise<Readonly<{ account_id: string; origin: string }>>;
}) {
  const { provider } = options;
  const { string, copyBinding } = provider;
  const failure: PersonProviderV1['failure'] = provider.failure;
  if (!provider.scope_id_pattern.test(options.scope_id) || options.store.provider.id !== provider.id) failure('invalid_request');
  const cloud = options.scope_id;
  function actor(token: string) {
    const authorization = Object.freeze({ ...options.authenticate(token) });
    const person = Object.freeze({ organization_id: authorization.organization_id, principal_id: authorization.principal_id, membership_id: authorization.membership_id });
    const requirePerson = () => { if (canonicalSha256(options.authenticate(token)) !== canonicalSha256(authorization)) failure('stale_access_state'); };
    return { person, requirePerson };
  }
  function tags(person: ConnectedPersonV1, attempt: string) { return { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: attempt }; }
  function authenticated(binding: PersonConnectorReadBindingV1, reference: string, expectedTags: Record<string, string>, current: () => void): PersonConnectionAuthenticatedFetchV1 {
    return Object.freeze<PersonConnectionAuthenticatedFetchV1>({ binding, async fetch(url, init) {
      current(); init.signal?.throwIfAborted();
      // Defensive allowlist BEFORE obtaining or attaching a credential, even if a future caller bypasses the transport.
      const target = new URL(url);
      if (target.origin !== provider.credential_origin || target.username !== '' || target.password !== '' || target.hash !== '' ||
          !provider.credential_paths(cloud).some(path => path.endsWith('/') ? target.pathname.startsWith(path) : target.pathname === path) ||
          init.redirect !== 'error') failure('unauthorized');
      const connection = await options.nango.connection(reference, init.signal ?? undefined);
      if (canonicalSha256(connection.tags) !== canonicalSha256(expectedTags)) failure('unauthorized');
      current(); init.signal?.throwIfAborted();
      const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${connection.access_token}`);
      try {
        const response = await options.fetch(url, { ...init, headers });
        try { current(); init.signal?.throwIfAborted(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
        return response;
      } catch { init.signal?.throwIfAborted(); failure('unavailable'); }
    } });
  }
  async function finish(person: ConnectedPersonV1, requirePerson: () => void, attempt: string, reference: string, signal?: AbortSignal): Promise<void> {
    const pending = options.store.pending(person, attempt);
    const current = () => { requirePerson(); options.store.pending(person, attempt); signal?.throwIfAborted(); };
    const safeReference = string(reference, 512);
    const temporary = copyBinding({ ...person, tool_id: provider.id, external_scope_id: cloud, external_subject_id: pending.expected_account ?? 'unverified', read_grant_sha256: canonicalSha256({ attempt }) });
    const verified = await options.verify(authenticated(temporary, safeReference, tags(person, attempt), current), {
      signal,
      require_account(account) {
        if (pending.expected_account !== undefined && account !== pending.expected_account) throw new PersonConnectionCompletionFailure('account_mismatch');
      },
    });
    current(); options.store.complete(person, attempt, safeReference, cloud, verified.account_id, verified.origin);
  }
  return Object.freeze({ actor, tags, authenticated, application: Object.freeze({
    /** Catalog status is local to this Person; listing tools never reads the provider or refreshes consent. */
    tool(input: { readonly access_token: string }): OrganizationPersonToolV4 {
      const { person, requirePerson } = actor(input.access_token);
      const stored = options.store.current(person);
      if (stored?.active === true) options.store.requireCurrent(stored.binding);
      requirePerson();
      return Object.freeze({
        tool_id: provider.id, display_name: provider.display_name, availability: 'enabled',
        personal_status: stored === undefined ? 'unlinked' : stored.active ? 'linked' : 'revoked',
        external_scope_id: stored?.active === true ? stored.binding.external_scope_id : null,
        external_subject_id: stored?.active === true ? stored.binding.external_subject_id : null,
        organization_setup: null,
      });
    },
    async connect(input: { readonly access_token: string; readonly signal?: AbortSignal }) {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const previous = options.store.current(person);
      const pending = options.store.begin(person);
      const current = () => { requirePerson(); options.store.pending(person, pending.attempt); input.signal?.throwIfAborted(); };
      // Reconnect always replaces the Nango connection through fresh consent.
      // A token refresh or mutable connection timestamp cannot complete this attempt.
      if (previous !== undefined) {
        await options.nango.disconnect(previous.reference, input.signal);
        current();
      }
      const result = await options.nango.connect(tags(person, pending.attempt), input.signal);
      current();
      return Object.freeze({ schema_version: 1 as const, attempt: pending.attempt, connect_link: result.link, expires_at: expiresAt(pending.expires) });
    },
    async status(input: { readonly access_token: string; readonly attempt: string; readonly signal?: AbortSignal }): Promise<PersonConnectionAttemptResponseV1> {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const attempt = string(input.attempt, 128);
      const saved = options.store.status(person, attempt);
      if (saved.status !== 'pending') return attemptResponse(saved);
      const current = () => { requirePerson(); options.store.pending(person, attempt); input.signal?.throwIfAborted(); };
      try {
        const reference = await options.nango.find(tags(person, attempt), input.signal);
        current();
        if (reference === undefined) return attemptResponse(options.store.status(person, attempt));
        await finish(person, requirePerson, attempt, reference, input.signal);
        return attemptResponse(options.store.status(person, attempt));
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // A concurrent status, cancellation, or expiry can settle this attempt
        // while Nango is in flight. Return only its durable terminal state.
        requirePerson(); input.signal?.throwIfAborted();
        const settled = options.store.status(person, attempt);
        if (settled.status !== 'pending') return attemptResponse(settled);
        return attemptResponse(options.store.fail(person, attempt, completionFailure(error)));
      }
    },
    async cancel(input: { readonly access_token: string; readonly attempt: string; readonly signal?: AbortSignal }): Promise<PersonConnectionAttemptResponseV1> {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const attempt = string(input.attempt, 128);
      const before = options.store.status(person, attempt);
      const cancelled = options.store.cancel(person, attempt);
      requirePerson(); input.signal?.throwIfAborted();
      if (before.status !== 'pending') return attemptResponse(cancelled);
      // Local cancellation wins before remote cleanup. If Nango is unavailable
      // or OAuth completes after this point, the tagged connection remains
      // unusable because finish() requires the still-pending local attempt.
      try {
        const reference = await options.nango.find(tags(person, attempt), input.signal);
        requirePerson(); input.signal?.throwIfAborted();
        if (reference !== undefined) await options.nango.disconnect(reference, input.signal);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // Cleanup is best effort; the locally terminal attempt cannot bind late consent.
      }
      // A cancelled local attempt remains denied, but a stale actor must never
      // receive its terminal state after remote cleanup returns.
      requirePerson(); input.signal?.throwIfAborted();
      return attemptResponse(options.store.status(person, attempt));
    },
    async disconnect(input: { readonly access_token: string; readonly signal?: AbortSignal }) {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const stored = options.store.current(person);
      options.store.revoke(person); // Local revocation wins even if remote deletion/abort fails.
      if (stored !== undefined) await options.nango.disconnect(stored.reference, input.signal);
      requirePerson(); return Object.freeze({ schema_version: 1 as const, connected: false as const });
    },
  }) });
}
