import { validateJiraProjectReadV1, validateJiraProjectSetV1, type JiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';
import type { JiraProjectMappingStoreV1 } from './jira-project-mapping-store-v1.js';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { OrganizationPersonToolV4, PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { JiraConnectionStoreV1, type JiraConnectionAttemptFailureV1, type JiraConnectionAttemptV1, type JiraPersonV1, type JiraStoredConnectionV1 } from './jira-connection-store-v1.js';
import { createJiraCloudTransportV1, type JiraCloudAuthenticatedFetchV1, type JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { createJiraPersonLiveEvidenceReaderV1 } from './jira-person-live-evidence-reader-v1.js';
import type { JiraNangoV1 } from './jira-nango-v1.js';
import { jiraProjectMatches, parseJiraProject, verifyJiraConnectionV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_CLOUD_ID, jiraFailure, jiraString } from './jira-validation-v1.js';

export interface JiraPersonAuthorizationV1 extends JiraPersonV1 { readonly authorization_sha256: Sha256Digest }
/**
 * Trusted server-only handoff for context capture. Its transport closes over
 * the provider-owned Nango reference; callers receive no credential, locator,
 * actor selector, or Jira site selector.
 */
export interface JiraCurrentCaptureConnectionV1 {
  readonly transport: JiraCloudTransportV1;
  /** Synchronous final Authority-runner fence over the same actor and grant. */
  require_current(): void;
}
type JiraAttemptResponseV1 = Readonly<{
  schema_version: 1;
  attempt: string;
  expires_at: string;
  status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
  failure_reason: JiraConnectionAttemptFailureV1 | null;
}>;

class JiraCompletionFailure extends Error {
  constructor(readonly reason: JiraConnectionAttemptFailureV1) { super(reason); }
}

function expiresAt(value: number): string { return new Date(value).toISOString(); }
function attemptResponse(value: JiraConnectionAttemptV1): JiraAttemptResponseV1 {
  return Object.freeze({ schema_version: 1 as const, attempt: value.attempt, expires_at: expiresAt(value.expires), status: value.status, failure_reason: value.failure_reason });
}
function completionFailure(error: unknown): JiraConnectionAttemptFailureV1 {
  if (error instanceof JiraCompletionFailure) return error.reason;
  if (error instanceof AuthorityOperationError && (error.code === 'unavailable' || error.code === 'rate_limited')) return 'provider_unavailable';
  return 'provider_rejected';
}

export function createJiraPersonConnectionV1(options: {
  readonly store: JiraConnectionStoreV1;
  readonly nango: JiraNangoV1;
  readonly cloud_id: string;
  readonly fetch: typeof fetch;
  readonly project_mappings?: JiraProjectMappingStoreV1;
  /** Current exact ECHO project grant, supplied only by Authority composition. */
  readonly authorize_project?: (access_token: string, project_id: string) => Readonly<{ role: 'lead' | 'member'; authorization_sha256: Sha256Digest }>;
  /** Existing ECHO session resolver, including current exact membership and session checks. */
  readonly authenticate: (access_token: string) => JiraPersonAuthorizationV1;
}) {
  if (!JIRA_CLOUD_ID.test(options.cloud_id)) jiraFailure('invalid_request');
  const cloud = options.cloud_id;
  function actor(token: string) {
    const authorization = Object.freeze({ ...options.authenticate(token) });
    const person = Object.freeze({ organization_id: authorization.organization_id, principal_id: authorization.principal_id, membership_id: authorization.membership_id });
    const requirePerson = () => { if (canonicalSha256(options.authenticate(token)) !== canonicalSha256(authorization)) jiraFailure('stale_access_state'); };
    return { person, requirePerson };
  }
  function tags(person: JiraPersonV1, attempt: string) { return { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: attempt }; }
  function authenticated(binding: PersonConnectorReadBindingV1, reference: string, expectedTags: Record<string, string>, current: () => void): JiraCloudAuthenticatedFetchV1 {
    return Object.freeze<JiraCloudAuthenticatedFetchV1>({ binding, async fetch(url, init) {
      current(); init.signal?.throwIfAborted();
      // Defensive allowlist BEFORE obtaining or attaching a credential, even if a future caller bypasses the transport.
      const target = new URL(url);
      if (target.origin !== 'https://api.atlassian.com' || target.username !== '' || target.password !== '' || target.hash !== '' ||
          !(target.pathname === '/oauth/token/accessible-resources' || target.pathname.startsWith(`/ex/jira/${cloud}/rest/api/3/`)) || init.redirect !== 'error') jiraFailure('unauthorized');
      const connection = await options.nango.connection(reference, init.signal ?? undefined);
      if (canonicalSha256(connection.tags) !== canonicalSha256(expectedTags)) jiraFailure('unauthorized');
      current(); init.signal?.throwIfAborted();
      const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${connection.access_token}`);
      try {
        const response = await options.fetch(url, { ...init, headers });
        try { current(); init.signal?.throwIfAborted(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
        return response;
      } catch { init.signal?.throwIfAborted(); jiraFailure('unavailable'); }
    } });
  }
  function projectAccess(token: string, projectId: string, lead = false) {
    if (options.project_mappings === undefined || options.authorize_project === undefined) jiraFailure('unavailable');
    const before = options.authorize_project(token, projectId);
    if (lead && before.role !== 'lead') jiraFailure('unauthorized');
    return { store: options.project_mappings, current: () => {
      if (canonicalSha256(options.authorize_project!(token, projectId)) !== canonicalSha256(before)) jiraFailure('stale_access_state');
    } };
  }
  function mappingInput<T>(validate: () => T): T {
    try { return validate(); } catch { jiraFailure('invalid_request'); }
  }
  async function finish(person: JiraPersonV1, requirePerson: () => void, attempt: string, reference: string, signal?: AbortSignal): Promise<void> {
    const pending = options.store.pending(person, attempt);
    const current = () => { requirePerson(); options.store.pending(person, attempt); signal?.throwIfAborted(); };
    const safeReference = jiraString(reference, 512);
    const temporary = copyJiraBindingV1({ ...person, tool_id: 'jira', external_scope_id: cloud, external_subject_id: pending.expected_account ?? 'unverified', read_grant_sha256: canonicalSha256({ attempt }) });
    const transport = createJiraCloudTransportV1(authenticated(temporary, safeReference, tags(person, attempt), current));
    const verified = await verifyJiraConnectionV1(transport, { signal, require_account: account => {
      if (pending.expected_account !== undefined && account !== pending.expected_account) throw new JiraCompletionFailure('account_mismatch');
    } });
    current(); options.store.complete(person, attempt, safeReference, cloud, verified.account_id, verified.origin);
  }
  return Object.freeze({
    /** Catalog status is local to this Person; listing tools never reads Jira or refreshes consent. */
    tool(input: { readonly access_token: string }): OrganizationPersonToolV4 {
      const { person, requirePerson } = actor(input.access_token);
      const stored = options.store.current(person);
      if (stored?.active === true) options.store.requireCurrent(stored.binding);
      requirePerson();
      return Object.freeze({
        tool_id: 'jira', display_name: 'Jira', availability: 'enabled',
        personal_status: stored === undefined ? 'unlinked' : stored.active ? 'linked' : 'revoked',
        external_scope_id: stored?.active === true ? stored.binding.external_scope_id : null,
        external_subject_id: stored?.active === true ? stored.binding.external_subject_id : null,
        organization_setup: null,
      });
    },
    projectRead(input: { readonly access_token: string; readonly request: unknown }): JiraProjectMappingV1 {
      const { person, requirePerson } = actor(input.access_token);
      const request = mappingInput(() => validateJiraProjectReadV1(input.request));
      const access = projectAccess(input.access_token, request.project_id);
      const result = access.store.read(person.organization_id, request.project_id);
      requirePerson(); access.current();
      return result;
    },
    async projectSet(input: { readonly access_token: string; readonly request: unknown; readonly signal?: AbortSignal }): Promise<JiraProjectMappingV1> {
      const { person, requirePerson } = actor(input.access_token);
      const request = mappingInput(() => validateJiraProjectSetV1(input.request));
      const access = projectAccess(input.access_token, request.project_id, true);
      const current = () => { requirePerson(); access.current(); input.signal?.throwIfAborted(); };
      current();
      const command = canonicalSha256({ person, request });
      const replay = access.store.replay(person.organization_id, request.project_id, command);
      if (replay !== undefined) return replay;
      if (access.store.read(person.organization_id, request.project_id).revision !== request.expected_revision) throw new AuthorityOperationError('conflict', 'Jira project setting changed; reload it');
      let mapping: JiraProjectMappingV1['mapping'] = null;
      if (request.jira_project !== null) {
        const stored = options.store.current(person);
        if (stored === undefined || !stored.active) jiraFailure('unauthorized');
        const connectionCurrent = () => { current(); options.store.requireCurrent(stored.binding); };
        const transport = createJiraCloudTransportV1(authenticated(stored.binding, stored.reference, tags(person, stored.attempt), connectionCurrent));
        const { origin } = await verifyJiraConnectionV1(transport, { expected_origin: stored.site, signal: input.signal });
        const prefix = `https://api.atlassian.com/ex/jira/${cloud}`;
        const readProject = async (id: string) => parseJiraProject(await transport.request({ path: `/ex/jira/${cloud}/rest/api/3/project/${id}`, query: { expand: 'projectKeys' }, signal: input.signal }), origin, prefix);
        const selected = await readProject(request.jira_project);
        if (!jiraProjectMatches(selected, request.jira_project)) jiraFailure('invalid_output');
        connectionCurrent();
        mapping = Object.freeze({ cloud_id: cloud, project_id: selected.id, project_key: selected.key });
      }
      current();
      // No asynchronous work between the final grant check and the atomic CAS.
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
    async status(input: { readonly access_token: string; readonly attempt: string; readonly signal?: AbortSignal }): Promise<JiraAttemptResponseV1> {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const attempt = jiraString(input.attempt, 128);
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
    async cancel(input: { readonly access_token: string; readonly attempt: string; readonly signal?: AbortSignal }): Promise<JiraAttemptResponseV1> {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const attempt = jiraString(input.attempt, 128);
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
    /** Local-only preflight. Never starts consent, refreshes a token or changes the binding. */
    captureStatus(input: { readonly access_token: string }): Readonly<{ connected: boolean }> {
      const { person, requirePerson } = actor(input.access_token);
      const stored = options.store.current(person);
      if (stored !== undefined && stored.active) options.store.requireCurrent(stored.binding);
      requirePerson();
      return Object.freeze({ connected: stored?.active === true });
    },
    async captureConnection(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<JiraCurrentCaptureConnectionV1> {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const stored = options.store.current(person);
      if (stored === undefined || !stored.active) jiraFailure('unauthorized');
      const binding = copyJiraBindingV1(stored.binding);
      const current = () => { requirePerson(); options.store.requireCurrent(binding); };
      current(); input.signal?.throwIfAborted();
      const transport = createJiraCloudTransportV1(authenticated(binding, stored.reference, tags(person, stored.attempt), current));
      return Object.freeze({ transport, require_current: current });
    },
    async source(input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined> {
      const { person, requirePerson } = actor(input.access_token);
      const access = input.project_id === undefined ? undefined : projectAccess(input.access_token, mappingInput(() => validateJiraProjectReadV1({ schema_version: 1, project_id: input.project_id })).project_id);
      const mapped = access?.store.read(person.organization_id, input.project_id!);
      if (access !== undefined && mapped?.mapping == null) return undefined;
      if (mapped?.mapping !== undefined && mapped.mapping !== null && mapped.mapping.cloud_id !== cloud) jiraFailure('unauthorized');
      const stored: JiraStoredConnectionV1 | undefined = options.store.current(person);
      if (stored === undefined || !stored.active) return undefined;
      const current = () => {
        requirePerson(); options.store.requireCurrent(stored.binding); access?.current();
        if (access !== undefined && access.store.read(person.organization_id, input.project_id!).revision !== mapped!.revision) jiraFailure('stale_access_state');
      };
      const selectedProject = mapped?.mapping?.project_id;
      current();
      const reader = await createJiraPersonLiveEvidenceReaderV1({ binding: stored.binding, transport: createJiraCloudTransportV1(authenticated(stored.binding, stored.reference, tags(person, stored.attempt), current)), expected_origin: stored.site, signal: input.signal, ...(selectedProject === undefined ? {} : { project: selectedProject }) });
      current();
      return createAuditedPersonLiveEvidenceSourceV1({ actor: person, read_grant_sha256: stored.binding.read_grant_sha256, reader, audit: input.audit, authorization: { assertCurrent: current }, access: { tool_id: 'jira', external_scope_id: cloud, external_subject_id: stored.binding.external_subject_id, identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'] } });
    },
  });
}
export type JiraPersonConnectionV1 = ReturnType<typeof createJiraPersonConnectionV1>;
