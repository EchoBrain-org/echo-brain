import { createPersonConnectionLifecycleV1, type PersonConnectionAuthorizationV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import { createPersonProjectMappingAccessV1, type PersonProjectAuthorizationV1, type PersonProjectNamesV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import { validateJiraProjectReadV1, validateJiraProjectSetV1, type JiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';
import type { JiraProjectMappingStoreV1 } from './jira-project-mapping-store-v1.js';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { JiraConnectionStoreV1, type JiraStoredConnectionV1 } from './jira-connection-store-v1.js';
import { createJiraCloudTransportV1, type JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { createJiraPersonLiveContainerReaderV1 } from './jira-person-live-container-reader-v1.js';
import { createJiraPersonLiveEvidenceReaderV1 } from './jira-person-live-evidence-reader-v1.js';
import type { JiraNangoV1 } from './jira-nango-v1.js';
import { jiraProjectMatches, parseJiraProject, readJiraAssigneeAccountsV1, readJiraTicketMarkersV1, verifyJiraConnectionV1 } from './jira-payload-v1.js';
export { jiraTicketMarkerV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_ID, JIRA_PERSON_PROVIDER_V1, jiraFailure } from './jira-validation-v1.js';

type JiraPersonAuthorizationV1 = PersonConnectionAuthorizationV1;
export function createJiraPersonConnectionV1(options: {
  readonly store: JiraConnectionStoreV1;
  readonly nango: JiraNangoV1;
  readonly cloud_id: string;
  readonly fetch: typeof fetch;
  readonly project_mappings?: JiraProjectMappingStoreV1;
  /** Current exact ECHO project grant, supplied only by Authority composition. */
  readonly authorize_project?: PersonProjectAuthorizationV1;
  /** Current names of the ECHO projects the asker can see; a Jira project's container item names those mapped to it. */
  readonly project_names?: PersonProjectNamesV1;
  /** Existing ECHO session resolver, including current exact membership and session checks. */
  readonly authenticate: (access_token: string) => JiraPersonAuthorizationV1;
}) {
  const cloud = options.cloud_id;
  const shared = createPersonConnectionLifecycleV1({ ...options, scope_id: options.cloud_id, provider: JIRA_PERSON_PROVIDER_V1,
    verify: (authenticated, input) => verifyJiraConnectionV1(createJiraCloudTransportV1(authenticated), input),
  });
  const { actor, tags, authenticated } = shared;
  const access = createPersonProjectMappingAccessV1(JIRA_PERSON_PROVIDER_V1, options);
  const { projectAccess, mappingInput, projectScope } = access;
  /** This person's current connection as a transport, fenced on the same actor and grant before every request. */
  function openTransport(input: { readonly access_token: string; readonly signal?: AbortSignal }): JiraCloudTransportV1 {
    const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
    const stored = options.store.current(person);
    if (stored === undefined || !stored.active) jiraFailure('unauthorized');
    const binding = copyJiraBindingV1(stored.binding);
    const current = () => { requirePerson(); options.store.requireCurrent(binding); };
    current(); input.signal?.throwIfAborted();
    return createJiraCloudTransportV1(authenticated(binding, stored.reference, tags(person, stored.attempt), current));
  }
  /** A bulk issue read with this person's own connection, of the distinct valid issue ids among `ticket_ids`; none reads nothing. */
  async function readTickets<T>(input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal },
    read: (transport: JiraCloudTransportV1, request: { readonly cloud_id: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }) => Promise<ReadonlyMap<string, T>>): Promise<ReadonlyMap<string, T>> {
    const ticket_ids = [...new Set(input.ticket_ids)].filter(id => JIRA_ID.test(id));
    if (ticket_ids.length === 0) return new Map();
    return read(openTransport(input), { cloud_id: cloud, ticket_ids, signal: input.signal });
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
      const replay = access.store.prepare(person.organization_id, request.project_id, request.expected_revision, command);
      if (replay !== undefined) return replay;
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
    /** Assignee account ids by ticket id, read in bulk with this person's own connection. */
    assigneeAccounts(input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, string>> {
      return readTickets(input, readJiraAssigneeAccountsV1);
    },
    /**
     * The Ask source check's tickets (Ask timeline v1, C1; ADR-0047): each ticket's marker by its id, read in bulk with this
     * person's own connection, at most 100 ids in two calls. A ticket they cannot read now does not come back and is left out;
     * one whose fields no marker can be made from is null.
     */
    ticketMarkers(input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, string | null>> {
      return readTickets(input, readJiraTicketMarkersV1);
    },
    async source(input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined> {
      const { person, requirePerson } = actor(input.access_token);
      const scope = projectScope(input.access_token, person.organization_id, input.project_id, cloud, validateJiraProjectReadV1);
      if (scope === null) return undefined;
      const stored: JiraStoredConnectionV1 | undefined = options.store.current(person);
      if (stored === undefined || !stored.active) return undefined;
      const current = () => { requirePerson(); options.store.requireCurrent(stored.binding); scope?.current(); };
      const selectedProject = scope?.mapping.project_id;
      current();
      const reader = await createJiraPersonLiveEvidenceReaderV1({ binding: stored.binding, transport: createJiraCloudTransportV1(authenticated(stored.binding, stored.reference, tags(person, stored.attempt), current)), expected_origin: stored.site, signal: input.signal, ...(selectedProject === undefined ? {} : { project: selectedProject }) });
      current();
      return createAuditedPersonLiveEvidenceSourceV1({ actor: person, read_grant_sha256: stored.binding.read_grant_sha256, reader, audit: input.audit, authorization: { assertCurrent: current }, access: { tool_id: 'jira', external_scope_id: cloud, external_subject_id: stored.binding.external_subject_id, identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'] } });
    },
    /** The Jira projects the asker can browse, as tool containers (research tool contract v1); a project scope reads only its mapped one. */
    containerSource: (input: Parameters<typeof access.containerSource>[1]) => access.containerSource({
      scope_id: cloud, validate: validateJiraProjectReadV1, lifecycle: shared, store: options.store, containers: mapping => [mapping.project_id],
      reader: ({ fetch: authenticatedFetch, ...read }, mapping) => createJiraPersonLiveContainerReaderV1({ ...read, transport: createJiraCloudTransportV1(authenticatedFetch),
        ...(mapping === undefined ? {} : { project: mapping.project_id }) }),
    }, input),
  });
}
export type JiraPersonConnectionV1 = ReturnType<typeof createJiraPersonConnectionV1>;
