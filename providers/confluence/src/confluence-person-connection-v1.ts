import { validateConfluenceProjectReadV1, validateConfluenceProjectSetV1, validateConfluenceProjectMappingsV1, validateConfluenceSpacesPageV1, type ConfluenceProjectMappingV1, type ConfluenceProjectMappingsV1, type ConfluenceSpacesPageV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import { randomUUID } from 'node:crypto';
import type { ConfluenceProjectMappingStoreV1 } from './confluence-project-mapping-store-v1.js';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { OrganizationPersonToolV4, PersonPageCitationV1 } from '@echo-brain/organization-api';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { ConfluenceConnectionStoreV1, type ConfluenceConnectionAttemptFailureV1, type ConfluenceConnectionAttemptV1, type ConfluencePersonV1 } from './confluence-connection-store-v1.js';
import { createConfluenceCloudTransportV1, type ConfluenceCloudAuthenticatedFetchV1 } from './confluence-cloud-transport-v1.js';
import { createConfluencePersonLiveEvidenceReaderV1 } from './confluence-person-live-evidence-reader-v1.js';
import type { ConfluenceNangoV1 } from './confluence-nango-v1.js';
import { verifyConfluenceConnectionV1 } from './confluence-payload-v1.js';
import { copyConfluenceBindingV1, CONFLUENCE_CLOUD_ID, confluenceArray, confluenceFailure, confluenceString, confluenceRecord } from './confluence-validation-v1.js';

export interface ConfluencePersonAuthorizationV1 extends ConfluencePersonV1 { readonly authorization_sha256: Sha256Digest }
type ConfluenceAttemptResponseV1 = Readonly<{
  schema_version: 1;
  attempt: string;
  expires_at: string;
  status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
  failure_reason: ConfluenceConnectionAttemptFailureV1 | null;
}>;

class ConfluenceCompletionFailure extends Error {
  constructor(readonly reason: ConfluenceConnectionAttemptFailureV1) { super(reason); }
}

function expiresAt(value: number): string { return new Date(value).toISOString(); }
function attemptResponse(value: ConfluenceConnectionAttemptV1): ConfluenceAttemptResponseV1 {
  return Object.freeze({ schema_version: 1 as const, attempt: value.attempt, expires_at: expiresAt(value.expires), status: value.status, failure_reason: value.failure_reason });
}
function completionFailure(error: unknown): ConfluenceConnectionAttemptFailureV1 {
  if (error instanceof ConfluenceCompletionFailure) return error.reason;
  if (error instanceof AuthorityOperationError && (error.code === 'unavailable' || error.code === 'rate_limited')) return 'provider_unavailable';
  return 'provider_rejected';
}

export function createConfluencePersonConnectionV1(options: {
  readonly store: ConfluenceConnectionStoreV1;
  readonly nango: ConfluenceNangoV1;
  readonly cloud_id: string;
  readonly fetch: typeof fetch;
  readonly project_mappings?: ConfluenceProjectMappingStoreV1;
  /** Current exact ECHO project grant, supplied only by Authority composition. */
  readonly authorize_project?: (access_token: string, project_id: string) => Readonly<{ role: 'lead' | 'member'; authorization_sha256: Sha256Digest }>;
  /** Existing ECHO session resolver, including current exact membership and session checks. */
  readonly authenticate: (access_token: string) => ConfluencePersonAuthorizationV1;
}) {
  if (!CONFLUENCE_CLOUD_ID.test(options.cloud_id)) confluenceFailure('invalid_request');
  const cloud = options.cloud_id;
  /** Request-local picker cursors, fenced to both person tenure and live grant. */
  const space_cursors = new Map<string, Readonly<{ person_sha256: Sha256Digest; grant_sha256: Sha256Digest; provider_cursor?: string }>>();
  function actor(token: string) {
    const authorization = Object.freeze({ ...options.authenticate(token) });
    const person = Object.freeze({ organization_id: authorization.organization_id, principal_id: authorization.principal_id, membership_id: authorization.membership_id });
    const requirePerson = () => { if (canonicalSha256(options.authenticate(token)) !== canonicalSha256(authorization)) confluenceFailure('stale_access_state'); };
    return { person, requirePerson };
  }
  function tags(person: ConfluencePersonV1, attempt: string) { return { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: attempt }; }
  function authenticated(binding: PersonConnectorReadBindingV1, reference: string, expectedTags: Record<string, string>, current: () => void): ConfluenceCloudAuthenticatedFetchV1 {
    return Object.freeze<ConfluenceCloudAuthenticatedFetchV1>({ binding, async fetch(url, init) {
      current(); init.signal?.throwIfAborted();
      // Defensive allowlist BEFORE obtaining or attaching a credential, even if a future caller bypasses the transport.
      const target = new URL(url);
      if (target.origin !== 'https://api.atlassian.com' || target.username !== '' || target.password !== '' || target.hash !== '' ||
          !(target.pathname === '/oauth/token/accessible-resources' || target.pathname.startsWith(`/ex/confluence/${cloud}/wiki/api/v2/`) || target.pathname.startsWith(`/ex/confluence/${cloud}/wiki/rest/api/`)) || init.redirect !== 'error') confluenceFailure('unauthorized');
      const connection = await options.nango.connection(reference, init.signal ?? undefined);
      if (canonicalSha256(connection.tags) !== canonicalSha256(expectedTags)) confluenceFailure('unauthorized');
      current(); init.signal?.throwIfAborted();
      const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${connection.access_token}`);
      try {
        const response = await options.fetch(url, { ...init, headers });
        try { current(); init.signal?.throwIfAborted(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
        return response;
      } catch { init.signal?.throwIfAborted(); confluenceFailure('unavailable'); }
    } });
  }
  function projectAccess(token: string, projectId: string, lead = false) {
    if (options.project_mappings === undefined || options.authorize_project === undefined) confluenceFailure('unavailable');
    const before = options.authorize_project(token, projectId);
    if (lead && before.role !== 'lead') confluenceFailure('unauthorized');
    return { store: options.project_mappings, current: () => {
      if (canonicalSha256(options.authorize_project!(token, projectId)) !== canonicalSha256(before)) confluenceFailure('stale_access_state');
    } };
  }
  function mappingInput<T>(validate: () => T): T {
    try { return validate(); } catch { confluenceFailure('invalid_request'); }
  }
  function parseProviderCursor(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    const value = confluenceString(raw, 4096);
    let url: URL;
    try { url = new URL(value, 'https://api.atlassian.com'); } catch { confluenceFailure('invalid_output'); }
    const paths = ['/api/v2/spaces', '/wiki/api/v2/spaces', `/ex/confluence/${cloud}/wiki/api/v2/spaces`];
    if (url.origin !== 'https://api.atlassian.com' || !paths.includes(url.pathname) || url.username !== '' || url.password !== '' || url.hash !== '' ||
        url.searchParams.getAll('cursor').length !== 1) confluenceFailure('invalid_output');
    // Next links can repeat selectors and use either the public wiki path or
    // the OAuth proxy path. Never follow them; carry only the opaque cursor
    // into our own pinned endpoint and fixed page size.
    return confluenceString(url.searchParams.get('cursor'), 4096);
  }
  function visibleProjectMappings(accessToken: string, organizationId: string): readonly ConfluenceProjectMappingV1[] {
    if (options.project_mappings === undefined || options.authorize_project === undefined) confluenceFailure('unavailable');
    const selected: ConfluenceProjectMappingV1[] = [];
    for (const mapping of options.project_mappings.list(organizationId)) {
      try { options.authorize_project(accessToken, mapping.project_id); selected.push(mapping); }
      catch (error) {
        // Project membership is an authorization boundary. A denied project is
        // omitted rather than revealing its ECHO project id or mapping.
        if (!(error instanceof AuthorityOperationError) || error.code !== 'unauthorized') throw error;
      }
    }
    return Object.freeze(selected);
  }
  async function finish(person: ConfluencePersonV1, requirePerson: () => void, attempt: string, reference: string, signal?: AbortSignal): Promise<void> {
    const pending = options.store.pending(person, attempt);
    const current = () => { requirePerson(); options.store.pending(person, attempt); signal?.throwIfAborted(); };
    const safeReference = confluenceString(reference, 512);
    const temporary = copyConfluenceBindingV1({ ...person, tool_id: 'confluence', external_scope_id: cloud, external_subject_id: pending.expected_account ?? 'unverified', read_grant_sha256: canonicalSha256({ attempt }) });
    const transport = createConfluenceCloudTransportV1(authenticated(temporary, safeReference, tags(person, attempt), current));
    const verified = await verifyConfluenceConnectionV1(transport, { signal, require_account: account => {
      if (pending.expected_account !== undefined && account !== pending.expected_account) throw new ConfluenceCompletionFailure('account_mismatch');
    } });
    current(); options.store.complete(person, attempt, safeReference, cloud, verified.account_id, verified.origin);
  }
  return Object.freeze({
    /** Catalog status is local to this Person; listing tools never reads Confluence or refreshes consent. */
    tool(input: { readonly access_token: string }): OrganizationPersonToolV4 {
      const { person, requirePerson } = actor(input.access_token);
      const stored = options.store.current(person);
      if (stored?.active === true) options.store.requireCurrent(stored.binding);
      requirePerson();
      return Object.freeze({
        tool_id: 'confluence', display_name: 'Confluence', availability: 'enabled',
        personal_status: stored === undefined ? 'unlinked' : stored.active ? 'linked' : 'revoked',
        external_scope_id: stored?.active === true ? stored.binding.external_scope_id : null,
        external_subject_id: stored?.active === true ? stored.binding.external_subject_id : null,
        organization_setup: null,
      });
    },
    projectRead(input: { readonly access_token: string; readonly request: unknown }): ConfluenceProjectMappingV1 {
      const { person, requirePerson } = actor(input.access_token);
      const request = mappingInput(() => validateConfluenceProjectReadV1(input.request));
      const access = projectAccess(input.access_token, request.project_id);
      const result = access.store.read(person.organization_id, request.project_id);
      requirePerson(); access.current();
      return result;
    },
    projectList(input: { readonly access_token: string }): ConfluenceProjectMappingsV1 {
      const { person, requirePerson } = actor(input.access_token);
      const mappings = visibleProjectMappings(input.access_token, person.organization_id);
      requirePerson();
      return validateConfluenceProjectMappingsV1({ schema_version: 1, mappings });
    },
    async spacesList(input: { readonly access_token: string; readonly cursor?: string; readonly signal?: AbortSignal }): Promise<ConfluenceSpacesPageV1> {
      const { person, requirePerson } = actor(input.access_token);
      const stored = options.store.current(person);
      if (stored === undefined || !stored.active) confluenceFailure('unauthorized');
      const person_sha256 = canonicalSha256(person);
      const cursor = input.cursor === undefined ? undefined : space_cursors.get(input.cursor);
      if (input.cursor !== undefined && (cursor === undefined || cursor.person_sha256 !== person_sha256 || cursor.grant_sha256 !== stored.binding.read_grant_sha256)) confluenceFailure('invalid_request');
      const current = () => { requirePerson(); options.store.requireCurrent(stored.binding); input.signal?.throwIfAborted(); };
      current();
      const transport = createConfluenceCloudTransportV1(authenticated(stored.binding, stored.reference, tags(person, stored.attempt), current));
      await verifyConfluenceConnectionV1(transport, { expected_origin: stored.site, signal: input.signal });
      const raw = confluenceRecord(await transport.request({ path: '/api/v2/spaces', query: { limit: '20', ...(cursor?.provider_cursor === undefined ? {} : { cursor: cursor.provider_cursor }) }, signal: input.signal }));
      const results = confluenceArray(raw.results, 20).map(value => {
        const space = confluenceRecord(value);
        return Object.freeze({ id: confluenceString(space.id, 128, /^[1-9][0-9]{0,19}$/), key: confluenceString(space.key, 256), name: confluenceString(space.name, 256) });
      });
      if (new Set(results.map(space => space.id)).size !== results.length) confluenceFailure('invalid_output');
      const links = raw._links === undefined ? {} : confluenceRecord(raw._links);
      const provider_cursor = parseProviderCursor(links.next);
      let next_cursor: string | null = null;
      if (provider_cursor !== undefined) {
        // Cursors are short-lived request conveniences. Evict the oldest rather
        // than turning a long-lived authority process permanently unavailable.
        if (space_cursors.size >= 512) {
          const oldest = space_cursors.keys().next().value;
          if (typeof oldest === 'string') space_cursors.delete(oldest);
        }
        next_cursor = `confluence_spaces_${randomUUID()}`;
        space_cursors.set(next_cursor, Object.freeze({ person_sha256, grant_sha256: stored.binding.read_grant_sha256, provider_cursor }));
      }
      current();
      return validateConfluenceSpacesPageV1({ schema_version: 1, items: results, next_cursor });
    },
    async projectSet(input: { readonly access_token: string; readonly request: unknown; readonly signal?: AbortSignal }): Promise<ConfluenceProjectMappingV1> {
      const { person, requirePerson } = actor(input.access_token);
      const request = mappingInput(() => validateConfluenceProjectSetV1(input.request));
      const access = projectAccess(input.access_token, request.project_id, true);
      const current = () => { requirePerson(); access.current(); input.signal?.throwIfAborted(); };
      current();
      const command = canonicalSha256({ person, request });
      const replay = access.store.replay(person.organization_id, request.project_id, command);
      if (replay !== undefined) return replay;
      if (access.store.read(person.organization_id, request.project_id).revision !== request.expected_revision) {
        throw new AuthorityOperationError('conflict', 'Confluence project setting changed; reload it');
      }
      let mapping: ConfluenceProjectMappingV1['mapping'] = null;
      if (request.space_ids !== null) {
        const stored = options.store.current(person);
        if (stored === undefined || !stored.active) confluenceFailure('unauthorized');
        const connectionCurrent = () => { current(); options.store.requireCurrent(stored.binding); };
        const transport = createConfluenceCloudTransportV1(authenticated(stored.binding, stored.reference, tags(person, stored.attempt), connectionCurrent));
        await verifyConfluenceConnectionV1(transport, { expected_origin: stored.site, signal: input.signal });
        for (const id of request.space_ids) {
          const space = confluenceRecord(await transport.request({ path: `/api/v2/spaces/${encodeURIComponent(id)}`, signal: input.signal }));
          if (confluenceString(space.id, 128) !== id) confluenceFailure('invalid_output');
        }
        connectionCurrent();
        mapping = Object.freeze({ cloud_id: cloud, space_ids: Object.freeze([...request.space_ids]) });
      }
      current();
      return access.store.set(person.organization_id, request.project_id, request.expected_revision, command, mapping);
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
    async status(input: { readonly access_token: string; readonly attempt: string; readonly signal?: AbortSignal }): Promise<ConfluenceAttemptResponseV1> {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const attempt = confluenceString(input.attempt, 128);
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
    async cancel(input: { readonly access_token: string; readonly attempt: string; readonly signal?: AbortSignal }): Promise<ConfluenceAttemptResponseV1> {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const attempt = confluenceString(input.attempt, 128);
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
    async source(input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonPageCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonPageCitationV1> | undefined> {
      const { person, requirePerson }=actor(input.access_token); const access=input.project_id===undefined?undefined:projectAccess(input.access_token,mappingInput(()=>validateConfluenceProjectReadV1({schema_version:1,project_id:input.project_id})).project_id);const mapped=access?.store.read(person.organization_id,input.project_id!);if(access!==undefined&&mapped?.mapping===null)return undefined;if(mapped?.mapping!==null&&mapped?.mapping!==undefined&&mapped.mapping.cloud_id!==cloud)confluenceFailure('unauthorized');const stored=options.store.current(person);if(stored===undefined||!stored.active)return undefined;const current=()=>{requirePerson();options.store.requireCurrent(stored.binding);access?.current();if(access!==undefined&&access.store.read(person.organization_id,input.project_id!).revision!==mapped!.revision)confluenceFailure('stale_access_state');};current();const reader=await createConfluencePersonLiveEvidenceReaderV1({binding:stored.binding,transport:createConfluenceCloudTransportV1(authenticated(stored.binding,stored.reference,tags(person,stored.attempt),current)),expected_origin:stored.site,signal:input.signal,...(mapped?.mapping===null||mapped?.mapping===undefined?{}:{space_ids:mapped.mapping.space_ids})});current();return createAuditedPersonLiveEvidenceSourceV1({actor:person,read_grant_sha256:stored.binding.read_grant_sha256,reader,audit:input.audit,authorization:{assertCurrent:current},access:{tool_id:'confluence',external_scope_id:cloud,external_subject_id:stored.binding.external_subject_id,identity_status:'linked',read_status:'connected',read_capabilities:['live_evidence']}});
    },
  });
}
export type ConfluencePersonConnectionV1 = ReturnType<typeof createConfluencePersonConnectionV1>;
