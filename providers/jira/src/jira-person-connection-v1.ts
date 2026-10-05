import { createPersonConnectionLifecycleV1, type PersonConnectionAuthorizationV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import { validateJiraProjectReadV1, validateJiraProjectSetV1, type JiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';
import type { JiraProjectMappingStoreV1 } from './jira-project-mapping-store-v1.js';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { JiraConnectionStoreV1, type JiraStoredConnectionV1 } from './jira-connection-store-v1.js';
import { createJiraCloudTransportV1, type JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { createJiraPersonLiveEvidenceReaderV1 } from './jira-person-live-evidence-reader-v1.js';
import type { JiraNangoV1 } from './jira-nango-v1.js';
import { jiraProjectMatches, parseJiraProject, verifyJiraConnectionV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_PERSON_PROVIDER_V1, jiraFailure } from './jira-validation-v1.js';

export type JiraPersonAuthorizationV1 = PersonConnectionAuthorizationV1;
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
  const cloud = options.cloud_id;
  const shared = createPersonConnectionLifecycleV1({ ...options, scope_id: options.cloud_id, provider: JIRA_PERSON_PROVIDER_V1,
    verify: (authenticated, input) => verifyJiraConnectionV1(createJiraCloudTransportV1(authenticated), input),
  });
  const { actor, tags, authenticated } = shared;
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
  return Object.freeze({
    ...shared.application,
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
