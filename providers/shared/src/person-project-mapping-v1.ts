import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type {
  PersonConnectorReadBindingV1, PersonLiveEvidenceAuditV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceSourceV1,
} from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { createPersonConnectionLifecycleV1, PersonConnectionAuthenticatedFetchV1 } from './person-connection-lifecycle-v1.js';
import type { PersonConnectionStoreV1 } from './person-connection-store-v1.js';
import { personProviderStorageNamespaceV1, type PersonProviderV1 } from './person-provider-v1.js';

interface ProjectMapping { readonly schema_version: 1; readonly project_id: string; readonly revision: string | null; readonly mapping: unknown }
/** Latest configuration only. Fixed SQL namespaces preserve existing stores; no tool content or history. */
export class PersonProjectMappingStoreV1<T extends ProjectMapping> {
  readonly provider: string;
  private readonly namespace: Readonly<{ table: string; label: string }>;
  constructor(private readonly db: Database.Database, descriptor: Pick<PersonProviderV1, 'id' | 'display_name' | 'storage_namespace'>, private readonly validate: (value: unknown) => T) {
    const { id, display_name, storage_namespace } = descriptor;
    this.provider = id;
    const namespace = personProviderStorageNamespaceV1(storage_namespace);
    this.namespace = Object.freeze({ table: `${namespace}_project_mapping_v1`, label: display_name });
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.namespace.table} (
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, body_json TEXT NOT NULL,
      command_sha256 TEXT NOT NULL, PRIMARY KEY(organization_id, project_id));`);
  }
  read(organization: string, project: string): T {
    const row = this.db.prepare(`SELECT body_json FROM ${this.namespace.table} WHERE organization_id=? AND project_id=?`).get(organization, project) as { body_json: string } | undefined;
    const result = this.validate(row === undefined ? { schema_version: 1, project_id: project, revision: null, mapping: null } : JSON.parse(row.body_json));
    if (result.project_id !== project) throw new AuthorityOperationError('invalid_output', `${this.namespace.label} project setting is invalid`);
    return result;
  }
  /** Configuration only; callers must filter project visibility before returning it to a person. */
  list(organization: string): readonly T[] {
    const rows = this.db.prepare(`SELECT body_json FROM ${this.namespace.table} WHERE organization_id=? ORDER BY project_id ASC`).all(organization) as readonly { body_json: string }[];
    return Object.freeze(rows.map(row => this.validate(JSON.parse(row.body_json))));
  }
  replay(organization: string, project: string, command: string): T | undefined {
    const row = this.db.prepare(`SELECT command_sha256 FROM ${this.namespace.table} WHERE organization_id=? AND project_id=?`).get(organization, project) as { command_sha256: string } | undefined;
    return row?.command_sha256 === command ? this.read(organization, project) : undefined;
  }
  /** Check before a provider lookup, and again inside the final atomic write. */
  prepare(organization: string, project: string, expected: string | null, command: string): T | undefined {
    const replay = this.replay(organization, project, command);
    if (replay !== undefined) return replay;
    if (this.read(organization, project).revision !== expected) throw new AuthorityOperationError('conflict', `${this.namespace.label} project setting changed; reload it`);
    return undefined;
  }
  set(organization: string, project: string, expected: string | null, command: string, mapping: T['mapping']): T {
    return this.db.transaction(() => {
      const replay = this.prepare(organization, project, expected, command);
      if (replay !== undefined) return replay;
      const result = this.validate({ schema_version: 1, project_id: project, revision: randomUUID(), mapping });
      this.db.prepare(`INSERT INTO ${this.namespace.table} VALUES(?,?,?,?) ON CONFLICT(organization_id, project_id) DO UPDATE SET body_json=excluded.body_json, command_sha256=excluded.command_sha256`).run(organization, project, canonicalJson(result), command);
      return result;
    }).immediate();
  }
}

export type PersonProjectAuthorizationV1 = (access_token: string, project_id: string) => Readonly<{ role: 'lead' | 'member'; authorization_sha256: Sha256Digest }>;
/** The current names of those of `project_ids` the asker can see; any other id is left out. Read locally. */
export type PersonProjectNamesV1 = (access_token: string, project_ids: readonly string[]) => ReadonlyMap<string, string>;

/** A saved mapping that names the provider site (cloud) it reads. */
interface ScopedProjectMapping extends ProjectMapping { readonly mapping: Readonly<{ cloud_id: string }> | null }

/** Snapshot ECHO project authorization independently of the provider's live permissions. */
export function createPersonProjectMappingAccessV1<T extends ScopedProjectMapping>(provider: Pick<PersonProviderV1, 'id' | 'failure'>, options: {
  readonly project_mappings?: PersonProjectMappingStoreV1<T>;
  readonly authorize_project?: PersonProjectAuthorizationV1;
  readonly project_names?: PersonProjectNamesV1;
}) {
  const failure: PersonProviderV1['failure'] = provider.failure;
  function projectAccess(token: string, projectId: string, lead = false) {
    const store = options.project_mappings, authorize = options.authorize_project;
    if (store === undefined || authorize === undefined) failure('unavailable');
    if (store.provider !== provider.id) failure('invalid_request');
    const grant = authorize(token, projectId);
    if (lead && grant.role !== 'lead') failure('unauthorized');
    const before = canonicalSha256(grant);
    return { store, current: () => {
      if (canonicalSha256(authorize(token, projectId)) !== before) failure('stale_access_state');
    } };
  }
  function mappingInput<R>(validate: () => R): R {
    try { return validate(); } catch { return failure('invalid_request'); }
  }
  return {
    projectAccess,
    mappingInput,
    /**
     * The project-scoped live read rule, once for every provider. Without a
     * project: undefined (global scope). An unmapped project: null, and the
     * caller reads nothing; it never falls back to the person's global
     * results. A mapping for another site is refused. `current` re-checks the
     * project grant and that the saved mapping has not changed.
     */
    projectScope(token: string, organizationId: string, projectId: string | undefined, scopeId: string, validate: (request: unknown) => { readonly project_id: string }) {
      if (projectId === undefined) return undefined;
      const project = mappingInput(() => validate({ schema_version: 1, project_id: projectId })).project_id;
      const access = projectAccess(token, project);
      const mapped = access.store.read(organizationId, project);
      const mapping = mapped.mapping;
      if (mapping === null) return null;
      if (mapping.cloud_id !== scopeId) failure('unauthorized');
      return { mapping: mapping as NonNullable<T['mapping']>, current: () => {
        access.current();
        if (access.store.read(organizationId, project).revision !== mapped.revision) failure('stale_access_state');
      } };
    },
    /**
     * The names of the ECHO projects mapped to each of the tool's containers that the asker can see (research tool
     * contract v1), by container id, pinned for one source: `containers` names the containers one mapping on this site
     * maps. A project the asker cannot see is left out, never named or counted; without the stores and names, nothing is.
     * The pin reads each mapped project's grant. `current` runs at every fence, several times per provider request, so it
     * reads the mappings once and asks for every mapped project's name at once, which names only the projects the asker
     * can see, never a grant per project. It refuses once that differs from the pin (a grant lost or gained, a mapping or
     * a name), so a container's released text is still what the asker may see at every fence, including the final
     * synchronous one.
     */
    containerProjects(token: string, organizationId: string, containers: (mapping: NonNullable<T['mapping']>) => readonly string[]) {
      const store = options.project_mappings, authorize = options.authorize_project, projectNames = options.project_names;
      if (store === undefined || authorize === undefined || projectNames === undefined) {
        return Object.freeze({ names: new Map() as ReadonlyMap<string, readonly string[]>, current: () => {} });
      }
      if (store.provider !== provider.id) failure('invalid_request');
      /** Each ECHO project mapped to containers on this site, with them. */
      const mapped = () => store.list(organizationId).flatMap(value => {
        const ids = value.mapping === null ? [] : containers(value.mapping as NonNullable<T['mapping']>);
        return ids.length === 0 ? [] : [[value.project_id, ids] as const];
      });
      /** By container id, the names of the projects mapped to it that `projectNames` named for `projects`. */
      const byContainer = (projects: readonly (readonly [string, readonly string[]])[]): ReadonlyMap<string, readonly string[]> => {
        const named = projects.length === 0 ? new Map<string, string>() : projectNames(token, projects.map(([project]) => project));
        const result = new Map<string, string[]>();
        for (const [project, ids] of projects) {
          const name = named.get(project);
          if (name === undefined) continue;
          for (const id of ids) result.set(id, [...result.get(id) ?? [], name]);
        }
        return new Map([...result].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([id, list]) => [id, Object.freeze([...new Set(list)].sort())]));
      };
      const names = byContainer(mapped().filter(([project]) => {
        try { authorize(token, project); return true; }
        catch (error) {
          if (error instanceof AuthorityOperationError && (error.code === 'unauthorized' || error.code === 'not_found')) return false;
          throw error;
        }
      }));
      const pinned = canonicalSha256([...names]);
      return Object.freeze({ names, current: () => { if (canonicalSha256([...byContainer(mapped())]) !== pinned) failure('stale_access_state'); } });
    },
  };
}

/** A tool's connection, project mappings and container reader, as `personToolContainerSourceV1` reads with them. */
export interface PersonToolContainerConnectionV1<M extends { readonly cloud_id: string }> {
  readonly provider: Pick<PersonProviderV1, 'id'>;
  /** The provider site (cloud) the connection reads. */
  readonly scope_id: string;
  readonly lifecycle: Pick<ReturnType<typeof createPersonConnectionLifecycleV1>, 'actor' | 'tags' | 'authenticated'>;
  readonly store: Pick<PersonConnectionStoreV1, 'current' | 'requireCurrent'>;
  /** `createPersonProjectMappingAccessV1`'s project scope and container names. */
  readonly access: {
    projectScope(token: string, organizationId: string, projectId: string | undefined, scopeId: string, validate: (request: unknown) => { readonly project_id: string }): { readonly mapping: M; current(): void } | null | undefined;
    containerProjects(token: string, organizationId: string, containers: (mapping: M) => readonly string[]): { readonly names: ReadonlyMap<string, readonly string[]>; current(): void };
  };
  /** The tool's project read request validator. */
  readonly validate: (request: unknown) => { readonly project_id: string };
  /** The containers one saved mapping on this site maps. */
  readonly containers: (mapping: M) => readonly string[];
  /** The tool's container reader over the asker's connection; in a project scope, pinned to the scope's saved mapping. */
  readonly reader: (input: {
    readonly binding: PersonConnectorReadBindingV1; readonly fetch: PersonConnectionAuthenticatedFetchV1; readonly expected_origin: string;
    readonly signal: AbortSignal | undefined; readonly echo_projects: () => ReadonlyMap<string, readonly string[]>;
  }, mapping: M | undefined) => Promise<PersonLiveEvidenceReaderV1<PersonToolContainerCitationV1>>;
}

/**
 * A connected tool's containers as one request's audited live source (research tool contract v1), each naming the ECHO
 * projects mapped to it that the asker can see. None without an active connection, or for an unmapped project; a project
 * scope reads only the containers its saved mapping names. Every read is fenced on the person, the connection, the scope's
 * mapping and grant, and the ECHO projects it named.
 */
export async function personToolContainerSourceV1<M extends { readonly cloud_id: string }>(tool: PersonToolContainerConnectionV1<M>, input: {
  readonly project_id?: string; readonly access_token: string; readonly audit: PersonLiveEvidenceAuditV1<PersonToolContainerCitationV1>; readonly signal?: AbortSignal;
}): Promise<PersonLiveEvidenceSourceV1<PersonToolContainerCitationV1> | undefined> {
  const { actor, tags, authenticated } = tool.lifecycle;
  const { person, requirePerson } = actor(input.access_token);
  const scope = tool.access.projectScope(input.access_token, person.organization_id, input.project_id, tool.scope_id, tool.validate);
  if (scope === null) return undefined;
  const stored = tool.store.current(person);
  if (stored === undefined || !stored.active) return undefined;
  const named = tool.access.containerProjects(input.access_token, person.organization_id, mapping => mapping.cloud_id === tool.scope_id ? tool.containers(mapping) : []);
  const current = () => { requirePerson(); tool.store.requireCurrent(stored.binding); scope?.current(); named.current(); };
  current();
  const reader = await tool.reader({ binding: stored.binding, fetch: authenticated(stored.binding, stored.reference, tags(person, stored.attempt), current),
    expected_origin: stored.site, signal: input.signal, echo_projects: () => named.names }, scope?.mapping);
  current();
  return createAuditedPersonLiveEvidenceSourceV1({ actor: person, read_grant_sha256: stored.binding.read_grant_sha256, reader, audit: input.audit, authorization: { assertCurrent: current },
    access: { tool_id: tool.provider.id, external_scope_id: tool.scope_id, external_subject_id: stored.binding.external_subject_id, identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'] } });
}
