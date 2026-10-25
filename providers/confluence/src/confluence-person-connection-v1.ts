import { createPersonConnectionLifecycleV1, type PersonConnectionAuthorizationV1 } from '@echo-brain/provider-runtime/person-connection-lifecycle-v1';
import { createPersonProjectMappingAccessV1, type PersonProjectAuthorizationV1, type PersonProjectNamesV1 } from '@echo-brain/provider-runtime/person-project-mapping-v1';
import { validateConfluenceProjectReadV1, validateConfluenceProjectSetV1, validateConfluenceProjectMappingsV1, validateConfluenceSpacesPageV1, type ConfluenceProjectMappingV1, type ConfluenceProjectMappingsV1, type ConfluenceSpacesPageV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import { randomUUID } from 'node:crypto';
import type { ConfluenceProjectMappingStoreV1 } from './confluence-project-mapping-store-v1.js';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonPageCitationV1 } from '@echo-brain/organization-api';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { ConfluenceConnectionStoreV1 } from './confluence-connection-store-v1.js';
import { createConfluenceCloudTransportV1, type ConfluenceCloudTransportV1 } from './confluence-cloud-transport-v1.js';
import { readConfluencePageSectionsV1, readConfluencePageVersionsV1 } from './confluence-page-check-v1.js';
import { createConfluencePersonLiveContainerReaderV1 } from './confluence-person-live-container-reader-v1.js';
import { createConfluencePersonLiveEvidenceReaderV1 } from './confluence-person-live-evidence-reader-v1.js';
import type { ConfluenceNangoV1 } from './confluence-nango-v1.js';
import { verifyConfluenceConnectionV1 } from './confluence-payload-v1.js';
import { CONFLUENCE_ID, CONFLUENCE_PERSON_PROVIDER_V1, confluenceArray, confluenceFailure, confluenceNextCursorV1, confluenceString, confluenceRecord } from './confluence-validation-v1.js';

export type ConfluencePersonAuthorizationV1 = PersonConnectionAuthorizationV1;
export function createConfluencePersonConnectionV1(options: {
  readonly store: ConfluenceConnectionStoreV1;
  readonly nango: ConfluenceNangoV1;
  readonly cloud_id: string;
  readonly fetch: typeof fetch;
  readonly project_mappings?: ConfluenceProjectMappingStoreV1;
  /** Current exact ECHO project grant, supplied only by Authority composition. */
  readonly authorize_project?: PersonProjectAuthorizationV1;
  /** Current names of the ECHO projects the asker can see; a space's container item names those mapped to it. */
  readonly project_names?: PersonProjectNamesV1;
  /** Existing ECHO session resolver, including current exact membership and session checks. */
  readonly authenticate: (access_token: string) => ConfluencePersonAuthorizationV1;
}) {
  const cloud = options.cloud_id;
  const shared = createPersonConnectionLifecycleV1({ ...options, scope_id: options.cloud_id, provider: CONFLUENCE_PERSON_PROVIDER_V1,
    verify: (authenticated, input) => verifyConfluenceConnectionV1(createConfluenceCloudTransportV1(authenticated), input),
  });
  const { actor, tags, authenticated } = shared;
  /** Request-local picker cursors, fenced to both person tenure and live grant. */
  const space_cursors = new Map<string, Readonly<{ person_sha256: Sha256Digest; grant_sha256: Sha256Digest; provider_cursor?: string }>>();
  const access = createPersonProjectMappingAccessV1(CONFLUENCE_PERSON_PROVIDER_V1, options);
  const { projectAccess, mappingInput, projectScope } = access;
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
  /** This person's own current connection, for the Ask source check; with none, `unauthorized`. */
  function checkTransport(input: { readonly access_token: string; readonly signal?: AbortSignal }): ConfluenceCloudTransportV1 {
    const { person, requirePerson } = actor(input.access_token);
    return createConfluenceCloudTransportV1(shared.open(person, requirePerson, input.signal).transport);
  }
  return Object.freeze({
    ...shared.application,
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
        return Object.freeze({ id: confluenceString(space.id, 128, CONFLUENCE_ID), key: confluenceString(space.key, 256), name: confluenceString(space.name, 256) });
      });
      if (new Set(results.map(space => space.id)).size !== results.length) confluenceFailure('invalid_output');
      const links = raw._links === undefined ? {} : confluenceRecord(raw._links);
      const provider_cursor = confluenceNextCursorV1(links.next, cloud, '/api/v2/spaces');
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
      const replay = access.store.prepare(person.organization_id, request.project_id, request.expected_revision, command);
      if (replay !== undefined) return replay;
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
    async source(input: { readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonPageCitationV1>; readonly signal?: AbortSignal }): Promise<PersonLiveEvidenceSourceV1<PersonPageCitationV1> | undefined> {
      const { person, requirePerson } = actor(input.access_token);
      const scope = projectScope(input.access_token, person.organization_id, input.project_id, cloud, validateConfluenceProjectReadV1);
      if (scope === null) return undefined;
      const stored = options.store.current(person);
      if (stored === undefined || !stored.active) return undefined;
      const current = () => { requirePerson(); options.store.requireCurrent(stored.binding); scope?.current(); };
      current();
      const reader = await createConfluencePersonLiveEvidenceReaderV1({
        binding: stored.binding,
        transport: createConfluenceCloudTransportV1(authenticated(stored.binding, stored.reference, tags(person, stored.attempt), current)),
        expected_origin: stored.site,
        signal: input.signal,
        ...(scope === undefined ? {} : { space_ids: scope.mapping.space_ids }),
      });
      current();
      return createAuditedPersonLiveEvidenceSourceV1({
        actor: person,
        read_grant_sha256: stored.binding.read_grant_sha256,
        reader,
        audit: input.audit,
        authorization: { assertCurrent: current },
        access: {
          tool_id: 'confluence', external_scope_id: cloud, external_subject_id: stored.binding.external_subject_id,
          identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'],
        },
      });
    },
    /**
     * The Ask source check's pages (Ask timeline v1, C1; ADR-0047): each page's current version by its id, read by id with this
     * person's own connection, at most 100 ids in two calls. A page they cannot read now, trashed or deleted included, is left out.
     */
    async pageVersions(input: { readonly access_token: string; readonly page_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, string>> {
      const page_ids = [...new Set(input.page_ids)].filter(id => CONFLUENCE_ID.test(id));
      if (page_ids.length === 0) return new Map();
      return readConfluencePageVersionsV1(checkTransport(input), { cloud_id: cloud, page_ids, signal: input.signal });
    },
    /**
     * The Ask source check's page bodies: the digest of each non-blank section of each page's current body, read with this
     * person's own connection, at most ten pages. A page they cannot read now is left out; one whose body is not text is null.
     */
    async pageSections(input: { readonly access_token: string; readonly page_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, readonly Sha256Digest[] | null>> {
      const page_ids = [...new Set(input.page_ids)].filter(id => CONFLUENCE_ID.test(id));
      if (page_ids.length === 0) return new Map();
      return readConfluencePageSectionsV1(checkTransport(input), { page_ids, signal: input.signal });
    },
    /** The Confluence spaces the asker can view, as tool containers (research tool contract v1); a project scope reads only its mapped ones. */
    containerSource: (input: Parameters<typeof access.containerSource>[1]) => access.containerSource({
      scope_id: cloud, validate: validateConfluenceProjectReadV1, lifecycle: shared, store: options.store, containers: mapping => mapping.space_ids,
      reader: ({ fetch: authenticatedFetch, ...read }, mapping) => createConfluencePersonLiveContainerReaderV1({ ...read, transport: createConfluenceCloudTransportV1(authenticatedFetch),
        ...(mapping === undefined ? {} : { space_ids: mapping.space_ids }) }),
    }, input),
  });
}
export type ConfluencePersonConnectionV1 = ReturnType<typeof createConfluencePersonConnectionV1>;
