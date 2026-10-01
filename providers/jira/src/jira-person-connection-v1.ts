import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { JiraConnectionStoreV1, type JiraPersonV1, type JiraStoredConnectionV1 } from './jira-connection-store-v1.js';
import { createJiraCloudTransportV1, type JiraCloudAuthenticatedFetchV1 } from './jira-cloud-transport-v1.js';
import { createJiraPersonLiveEvidenceReaderV1 } from './jira-person-live-evidence-reader-v1.js';
import type { JiraNangoV1 } from './jira-nango-v1.js';
import { jiraSiteOrigin } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_CLOUD_ID, jiraArray, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

export interface JiraPersonAuthorizationV1 extends JiraPersonV1 { readonly authorization_sha256: Sha256Digest }
export function createJiraPersonConnectionV1(options: {
  readonly store: JiraConnectionStoreV1;
  readonly nango: JiraNangoV1;
  readonly cloud_id: string;
  readonly fetch: typeof fetch;
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
  return Object.freeze({
    async connect(input: { readonly access_token: string; readonly signal?: AbortSignal }) {
      const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
      const previous = options.store.current(person);
      const pending = options.store.begin(person);
      const current = () => { requirePerson(); options.store.attempt(person, pending.attempt); input.signal?.throwIfAborted(); };
      // Reconnect always replaces the Nango connection through fresh consent.
      // A token refresh or mutable connection timestamp cannot complete this attempt.
      if (previous !== undefined) {
        await options.nango.disconnect(previous.reference, input.signal);
        current();
      }
      const result = await options.nango.connect(tags(person, pending.attempt), input.signal);
      current();
      return Object.freeze({ schema_version: 1 as const, attempt: pending.attempt, connect_link: result.link });
    },
    async complete(input: { readonly access_token: string; readonly attempt: string; readonly connection?: string; readonly signal?: AbortSignal }) {
      const { person, requirePerson } = actor(input.access_token);
      input.signal?.throwIfAborted();
      const pending = options.store.attempt(person, jiraString(input.attempt, 128));
      const current = () => { requirePerson(); options.store.attempt(person, input.attempt); input.signal?.throwIfAborted(); };
      const discovered = input.connection ?? await options.nango.find(tags(person, input.attempt), input.signal);
      if (discovered === undefined) jiraFailure('unauthorized');
      current();
      const reference = jiraString(discovered, 512);
      const temporary = copyJiraBindingV1({ ...person, tool_id: 'jira', external_scope_id: cloud, external_subject_id: pending.expected_account ?? 'unverified', read_grant_sha256: canonicalSha256({ attempt: input.attempt }) });
      const transport = createJiraCloudTransportV1(authenticated(temporary, reference, tags(person, input.attempt), current));
      const resources = jiraArray(await transport.request({ path: '/oauth/token/accessible-resources', signal: input.signal }), 256).map(jiraRecord).filter(value => value.id === cloud && Array.isArray(value.scopes) && value.scopes.includes('read:jira-work'));
      if (resources.length !== 1) jiraFailure('unauthorized');
      const site = jiraSiteOrigin(resources[0]!.url);
      const myself = jiraRecord(await transport.request({ path: `/ex/jira/${cloud}/rest/api/3/myself`, signal: input.signal }));
      const account = jiraString(myself.accountId);
      if (pending.expected_account !== undefined && account !== pending.expected_account) jiraFailure('unauthorized');
      const verified = copyJiraBindingV1({ ...temporary, external_subject_id: account });
      await createJiraPersonLiveEvidenceReaderV1({ binding: verified, transport: createJiraCloudTransportV1(authenticated(verified, reference, tags(person, input.attempt), current)), expected_origin: site, signal: input.signal });
      current(); input.signal?.throwIfAborted();
      options.store.complete(person, input.attempt, reference, cloud, account, site);
      return Object.freeze({ schema_version: 1 as const, connected: true as const });
    },
    async disconnect(input: { readonly access_token: string; readonly signal?: AbortSignal }) {
      const { person, requirePerson } = actor(input.access_token); const stored = options.store.current(person);
      options.store.revoke(person); // Local revocation wins even if remote deletion/abort fails.
      if (stored !== undefined) await options.nango.disconnect(stored.reference, input.signal);
      requirePerson(); return Object.freeze({ schema_version: 1 as const, connected: false as const });
    },
    async source(input: { readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined> {
      const { person, requirePerson } = actor(input.access_token); const stored: JiraStoredConnectionV1 | undefined = options.store.current(person);
      if (stored === undefined || !stored.active) return undefined;
      const current = () => { requirePerson(); options.store.requireCurrent(stored.binding); };
      current();
      const reader = await createJiraPersonLiveEvidenceReaderV1({ binding: stored.binding, transport: createJiraCloudTransportV1(authenticated(stored.binding, stored.reference, tags(person, stored.attempt), current)), expected_origin: stored.site, signal: input.signal });
      current();
      return createAuditedPersonLiveEvidenceSourceV1({ actor: person, read_grant_sha256: stored.binding.read_grant_sha256, reader, audit: input.audit, authorization: { async requireCurrent(_binding, request) { request.signal?.throwIfAborted(); current(); } }, access: { tool_id: 'jira', external_scope_id: cloud, external_subject_id: stored.binding.external_subject_id, identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'] } });
    },
  });
}
export type JiraPersonConnectionV1 = ReturnType<typeof createJiraPersonConnectionV1>;
