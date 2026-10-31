import { createPersonConnectionLifecycleV1, type PersonConnectionAuthorizationV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import { createPersonProjectMappingAccessV1, type PersonProjectAuthorizationV1, type PersonProjectNamesV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import { validateJiraProjectReadV1, validateJiraProjectSetV1, type JiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';
import type { JiraProjectMappingStoreV1 } from './jira-project-mapping-store-v1.js';
import type { PersonTicketCitationV1 } from '@echo-brain/organization-api';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraConnectionStoreV1 } from './jira-connection-store-v1.js';
import { createJiraCloudTransportV1, type JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { createJiraPersonLiveContainerReaderV1 } from './jira-person-live-container-reader-v1.js';
import { createJiraPersonLiveEvidenceReaderV1 } from './jira-person-live-evidence-reader-v1.js';
import type { JiraNangoV1 } from './jira-nango-v1.js';
import { jiraProjectMatches, parseJiraProject, readJiraAssigneeAccountsV1, readJiraTicketMarkersV1, verifyJiraConnectionV1 } from './jira-payload-v1.js';
export { jiraTicketMarkerV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_ID, JIRA_PERSON_PROVIDER_V1, jiraFailure } from './jira-validation-v1.js';

type JiraPersonAuthorizationV1 = PersonConnectionAuthorizationV1;
/**
 * Trusted server-only handoff of this person's current connection, for the
 * staging rehearsal's read proof and the assignee lookup; Jira context capture
 * is disabled. Its transport closes over the provider-owned Nango reference;
 * callers receive no credential, locator, actor selector, or Jira site selector.
 */
interface JiraCurrentCaptureConnectionV1 {
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
  async function captureConnection(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<JiraCurrentCaptureConnectionV1> {
    const { person, requirePerson } = actor(input.access_token); input.signal?.throwIfAborted();
    const stored = options.store.current(person);
    if (stored === undefined || !stored.active) jiraFailure('unauthorized');
    const binding = copyJiraBindingV1(stored.binding);
    const current = () => { requirePerson(); options.store.requireCurrent(binding); };
    current(); input.signal?.throwIfAborted();
    const transport = createJiraCloudTransportV1(authenticated(binding, stored.reference, tags(person, stored.attempt), current));
    return Object.freeze({ transport, require_current: current });
  }
  /** A bulk issue read with this person's own connection, of the distinct valid issue ids among `ticket_ids`; none reads nothing. */
  async function readTickets<T>(input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal },
    read: (transport: JiraCloudTransportV1, request: { readonly cloud_id: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }) => Promise<ReadonlyMap<string, T>>): Promise<ReadonlyMap<string, T>> {
    const ticket_ids = [...new Set(input.ticket_ids)].filter(id => JIRA_ID.test(id));
    if (ticket_ids.length === 0) return new Map();
    const { transport } = await captureConnection(input);
    return read(transport, { cloud_id: cloud, ticket_ids, signal: input.signal });
  }
  return Object.freeze({
    ...shared.application,
    projectRead: (input: { readonly access_token: string; readonly request: unknown }): JiraProjectMappingV1 =>
      access.read({ lifecycle: shared, validate: validateJiraProjectReadV1 }, input),
    /** A lead maps the ECHO project to one Jira project their own connection can read, saved by its stable id. */
    projectSet: (input: { readonly access_token: string; readonly request: unknown; readonly signal?: AbortSignal }): Promise<JiraProjectMappingV1> => access.set({
      lifecycle: shared, validate: validateJiraProjectSetV1, selection: request => request.jira_project,
      async resolve(project, connection, signal) {
        const transport = createJiraCloudTransportV1(connection.transport);
        const { origin } = await verifyJiraConnectionV1(transport, { expected_origin: connection.stored.site, signal });
        const selected = parseJiraProject(await transport.request({ path: `/ex/jira/${cloud}/rest/api/3/project/${project}`, query: { expand: 'projectKeys' }, signal }), origin, `https://api.atlassian.com/ex/jira/${cloud}`);
        if (!jiraProjectMatches(selected, project)) jiraFailure('invalid_output');
        return Object.freeze({ cloud_id: cloud, project_id: selected.id, project_key: selected.key });
      },
    }, input),
    /** Local-only preflight. Never starts consent, refreshes a token or changes the binding. */
    captureStatus(input: { readonly access_token: string }): Readonly<{ connected: boolean }> {
      const { person, requirePerson } = actor(input.access_token);
      const stored = options.store.current(person);
      if (stored !== undefined && stored.active) options.store.requireCurrent(stored.binding);
      requirePerson();
      return Object.freeze({ connected: stored?.active === true });
    },
    captureConnection,
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
    /** This person's Jira tickets as one request's audited live source; a project scope reads only its mapped Jira project. */
    source: (input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonTicketCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonTicketCitationV1> | undefined> => access.source({
      scope_id: cloud, validate: validateJiraProjectReadV1, lifecycle: shared, store: options.store,
      reader: ({ binding, fetch: authenticatedFetch, expected_origin, signal }, mapping) => createJiraPersonLiveEvidenceReaderV1({ binding, transport: createJiraCloudTransportV1(authenticatedFetch),
        expected_origin, signal, ...(mapping === undefined ? {} : { project: mapping.project_id }) }),
    }, input),
    /** The Jira projects the asker can browse, as tool containers (research tool contract v1); a project scope reads only its mapped one. */
    containerSource: (input: Parameters<typeof access.containerSource>[1]) => access.containerSource({
      scope_id: cloud, validate: validateJiraProjectReadV1, lifecycle: shared, store: options.store, containers: mapping => [mapping.project_id],
      reader: ({ fetch: authenticatedFetch, ...read }, mapping) => createJiraPersonLiveContainerReaderV1({ ...read, transport: createJiraCloudTransportV1(authenticatedFetch),
        ...(mapping === undefined ? {} : { project: mapping.project_id }) }),
    }, input),
  });
}
export type JiraPersonConnectionV1 = ReturnType<typeof createJiraPersonConnectionV1>;
