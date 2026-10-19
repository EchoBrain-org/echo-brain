import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  PROJECT_PAGE_MAX_ITEMS,
  validatePersonWorkspaceCitationV1,
  type OrganizationDirectoryEntryV1,
  type OrganizationPersonToolV4,
  type OrganizationToolSetupStatusV4,
  type PersonWorkspaceCitationV1,
  type ProjectMemberV1,
  type ProjectRoleV1,
  type ProjectSummaryV2,
} from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskRevalidateInputV1, EvidenceDeskVisibilityV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v1';
import type { EvidenceDeskItemV2, EvidenceDeskListInputV2, EvidenceDeskResultV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import {
  matchesEvidenceDateV1,
  validateEvidenceDateFilterV1,
  type EvidenceDateFilterV1,
  type EvidenceDateSelectionV1,
} from '@echo-brain/organization-authority-kernel/shared/temporal-query-v1';
import {
  PEOPLE_SOURCE_DESCRIPTOR_V1,
  PROJECTS_SOURCE_DESCRIPTOR_V1,
  TOOLS_SOURCE_DESCRIPTOR_V1,
  WORKSPACE_SOURCE_KINDS_V1,
  type WorkspaceSourceDescriptorV1,
  type WorkspaceSourceIdV1,
} from '@echo-brain/organization-authority-kernel/shared/workspace-evidence-v1';
import type { SqliteOpenItemPeopleV1 } from '../adapters/persistence/sqlite/open-item-people-v1.js';
import { PERSON_QUERY_FUNCTION_WORDS_V1 } from '../adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import type { ProjectContextApplicationV1, ProjectContextRepositoryV1, ProjectMembershipGrantV1 } from '../application/ports/project-context-v1.js';

/**
 * The asker's workspace as three Ask sources (research tool contract v1, "Collections in ECHO" and "Permission rules"):
 * the projects they belong to, the people in their organization, and their tools. Who sees what is the project context
 * application's answer, read as the asker: their project list, each project's roster, the organization directory, and
 * each tool's project setting as the project's members read it. Nothing here restates a rule. A request reads what its
 * scope shows once, at its first call. Every release is audited without content before it leaves, and rechecked before
 * each model call (only what is new) and in full before the answer (ADR-0038).
 */

/** A tool's saved setting for a project, as that tool's project read returns it to the project's members. */
export interface PersonWorkspaceProjectSettingV1<M> {
  projectRead(input: { readonly access_token: string; readonly request: unknown }): { readonly mapping: M | null };
}

/** Where the workspace sources read. */
export interface PersonWorkspaceSourcesV1 {
  /** The asker's project list (V2), each project's roster and the organization directory: each read authorized and audited there. */
  readonly projects: Pick<ProjectContextApplicationV1, 'listProjectsV2' | 'listMembers' | 'searchOrganizationDirectory'>;
  /** The asker's project grants now, read without a release (`personWorkspaceGrantsV1`). The checks read them. */
  readonly grants: (person: PersonAccessAuthorization) => readonly Pick<ProjectMembershipGrantV1, 'project_id' | 'project_membership_id'>[];
  /** Whether each released person is still an active member of the organization. The checks read it. */
  readonly people: Pick<SqliteOpenItemPeopleV1, 'people'>;
  /** Jira's saved project for each project; absent where Jira is not set up. */
  readonly jira?: PersonWorkspaceProjectSettingV1<{ readonly project_key: string }>;
  /** Confluence's saved spaces for each project; absent where Confluence is not set up. */
  readonly confluence?: PersonWorkspaceProjectSettingV1<{ readonly space_ids: readonly string[] }>;
  /** The asker's tools, as the person tools list (`/v4/person/tools`) lists them, read locally with no provider call. */
  readonly tools: (access_token: string) => Promise<readonly OrganizationPersonToolV4[]>;
}

/**
 * One release of workspace items to an Ask: its source and operation, and for each item its kind, its id (a project id,
 * a membership id or a tool id), whether it was released beside the result, and a digest of the fields released. Never a
 * name, title or text.
 */
export interface PersonWorkspaceReleaseV1 {
  readonly source: WorkspaceSourceIdV1;
  readonly operation: 'search' | 'list' | 'open';
  readonly items: readonly { readonly kind: WorkspaceItemKind; readonly item_id: string; readonly linked: boolean; readonly released_fields_sha256: Sha256Digest }[];
}
export interface PersonWorkspaceReleaseAuditV1 {
  /** Commits the release before its bytes leave Layer 3 and returns its receipt. */
  record(release: PersonWorkspaceReleaseV1): Sha256Digest;
}

export interface CreatePersonWorkspaceEvidenceSourcesV1Options {
  readonly sources: PersonWorkspaceSourcesV1;
  /** The asker's access token: every read is made as them. */
  readonly access_token: string;
  /** The asker's session now. The sources are bound to the person it names at creation; every call and check reads it again. */
  readonly authenticate: () => PersonAccessAuthorization;
  /** Never Mine: Mine reads only what the asker added. In a project, only that project and its members. */
  readonly scope: { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };
  /** One audit for the request, shared by the three sources. */
  readonly audit: PersonWorkspaceReleaseAuditV1;
}

/** One workspace source; the request's desk dispatches to it by its selector. */
export interface PersonWorkspaceEvidenceSourceV1 {
  readonly descriptor: WorkspaceSourceDescriptorV1;
  search(input: EvidenceDateFilterV1 & { readonly query: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<EvidenceDeskResultV2>;
  list(input: EvidenceDeskListInputV2): Promise<EvidenceDeskResultV2>;
  /** An item of this source's kind that any of the three sources released in this request, as a row or beside one. */
  open(input: { readonly item: string; readonly signal?: AbortSignal }): Promise<EvidenceDeskResultV2>;
}
/** Projects and people: ECHO's own state, read synchronously. */
export interface PersonWorkspaceLocalSourceV1 extends PersonWorkspaceEvidenceSourceV1 {
  /**
   * Every item this source released since its last successful check (`incremental`), or every one (`full`, the default),
   * against the asker's grants and the organization's memberships now. Synchronous, so the desk runs it with the final
   * local checks. Fails with `stale_access_state` when the session is another person, the asker no longer belongs to a
   * released project or a project a released person's text named, or holds a new grant for it, or a released person is no
   * longer an active member. A project renamed, archived or re-roled meanwhile is not an access change.
   */
  revalidate(input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>): void;
}
/** Tools: the person tools list is read through each tool's own store and fences, so its check awaits it. */
export interface PersonWorkspaceToolsSourceV1 extends PersonWorkspaceEvidenceSourceV1 {
  /**
   * As the local check, against the person tools list read again: fails with `stale_access_state` when a released tool's
   * connection changed (its status, availability, site or account) or the asker no longer sees the organization setup a
   * release named. The desk awaits it with its live sources' checks, before the final synchronous ones.
   */
  revalidate(input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>): Promise<void>;
}
/** The three sources of one request, sharing what it released: one source opens an item another released beside its result. */
export interface PersonWorkspaceEvidenceSourcesV1 {
  readonly projects: PersonWorkspaceLocalSourceV1;
  readonly people: PersonWorkspaceLocalSourceV1;
  readonly tools: PersonWorkspaceToolsSourceV1;
}

/**
 * Per call: the hits one search returns, the rows one list page returns, the names one item's text names, the leads its
 * attribute names, and the items released beside one result.
 */
export const PERSON_WORKSPACE_LIMITS_V1 = Object.freeze({ search_hits: 10, list_page: 20, names: 50, leads: 10, linked: 100 });

/** The asker's project grants as the project repository holds them now, in a read transaction of their own with no release. */
export function personWorkspaceGrantsV1(repository: Pick<ProjectContextRepositoryV1, 'withReadTransaction'>): PersonWorkspaceSourcesV1['grants'] {
  return person => repository.withReadTransaction(transaction => transaction.captureAuthorization(person, { operation: 'project_list' }).grants);
}

type WorkspaceItemKind = (typeof WORKSPACE_SOURCE_KINDS_V1)[WorkspaceSourceIdV1];
type Person = Pick<OrganizationDirectoryEntryV1, 'membership_id' | 'display_name'>;
/** What the request read once, at its first call: the asker's projects in scope, newest first, and what each names. */
interface View {
  readonly projects: readonly ProjectSummaryV2[];
  /** The asker's grant for each project when it was read. */
  readonly grants: ReadonlyMap<string, string>;
  readonly members: ReadonlyMap<string, readonly ProjectMemberV1[]>;
  /** Each member's projects in scope, in the projects' order, with their role in each. */
  readonly memberships: ReadonlyMap<string, readonly { readonly project: ProjectSummaryV2; readonly role: ProjectRoleV1 }[]>;
  /** Each project's Jira key and Confluence space count; absent where that tool is not set up, null where the project has none. */
  readonly jira?: ReadonlyMap<string, string | null>;
  readonly confluence?: ReadonlyMap<string, number | null>;
}
/** What a release must still be at a check. */
type Release =
  | { readonly kind: 'project'; readonly project_id: string; readonly grant: string }
  /** The projects its text named, each with the asker's grant when it was read. */
  | { readonly kind: 'person'; readonly membership_id: string; readonly projects: ReadonlyMap<string, string> }
  | { readonly kind: 'tool'; readonly tool_id: string; readonly connection: string; readonly setup: boolean };
type Shaped = { readonly id: string; readonly kind: WorkspaceItemKind; readonly key: string; readonly fields: Omit<EvidenceDeskItemV2, 'id' | 'receipt_sha256'>; readonly release: Release };
type Ledger = { readonly released: Map<string, Release>; readonly unchecked: Set<string> };

const PROJECT_DATES: readonly EvidenceDateSelectionV1[] = Object.freeze(['created', 'any']);
const TOOL_STATUS: Readonly<Record<OrganizationPersonToolV4['personal_status'], string>> = Object.freeze({ linked: 'connected', unlinked: 'not connected', revoked: 'connection revoked', unavailable: 'not available' });
const TOOL_SETUP: Readonly<Record<OrganizationToolSetupStatusV4, string>> = Object.freeze({ not_set_up: 'not set up', app_created: 'app created', connected: 'connected', needs_reinstall: 'needs reinstall' });

const invalid = (message: string): never => { throw new AuthorityOperationError('invalid_request', message); };
const stale = (): never => { throw new AuthorityOperationError('stale_access_state', 'A workspace item is no longer available to this person'); };
const notFound = (): never => { throw new AuthorityOperationError('not_found', 'Evidence item is not available in this request'); };

function pageSize(limit: number | undefined, maximum: number): number {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) invalid('Evidence limit is invalid');
  return Math.min(limit ?? maximum, maximum);
}
/** People and tools have no dates, so a date bound is refused rather than ignored. A time zone alone bounds nothing. */
function refuseDates(input: EvidenceDateFilterV1, source: string): void {
  if (input.since !== undefined || input.until !== undefined || input.date_field !== undefined) invalid(`${source} have no dates; leave out since, until and date_field`);
}
/** A search's words: whole Unicode terms, lower case, without function words unless written as an acronym. */
function termsOf(query: string): readonly string[] {
  const terms = new Set<string>();
  for (const run of query.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase();
    if (!PERSON_QUERY_FUNCTION_WORDS_V1.has(term) || /^[A-Z]{2,}$/u.test(run)) terms.add(term);
  }
  return [...terms];
}
function wordsOf(values: readonly (string | null | undefined)[]): ReadonlySet<string> {
  return new Set(values.flatMap(value => (value ?? '').normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
}
/** Names joined with ", ", the rest counted. */
function named(values: readonly string[], maximum: number): string {
  return values.length <= maximum ? values.join(', ') : `${values.slice(0, maximum).join(', ')}, and ${values.length - maximum} more`;
}
/** A list attribute: names joined with ", ", ending ", and more" when there are more. */
function listed(values: readonly string[], maximum: number): string {
  return values.length <= maximum ? values.join(', ') : `${values.slice(0, maximum).join(', ')}, and more`;
}
/** Newest first, as the project list orders them; then by id. */
function newestFirst(left: ProjectSummaryV2, right: ProjectSummaryV2): number {
  return left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : left.project_id < right.project_id ? -1 : left.project_id > right.project_id ? 1 : 0;
}
/** Every page of one of the project application's lists. */
function everyPage<T>(read: (paging: { readonly limit: number; readonly cursor?: string }) => { readonly items: readonly T[]; readonly next_cursor: string | null }, signal?: AbortSignal): T[] {
  const all: T[] = [];
  for (let cursor: string | undefined; ;) {
    signal?.throwIfAborted();
    const page = read({ limit: PROJECT_PAGE_MAX_ITEMS, ...(cursor === undefined ? {} : { cursor }) });
    all.push(...page.items);
    if (page.next_cursor === null) return all;
    cursor = page.next_cursor;
  }
}
/** The connection a tool's release reflects: whether it is set up and linked, and to which site and account. */
function connectionOf(tool: OrganizationPersonToolV4): string {
  return canonicalJson({ availability: tool.availability, personal_status: tool.personal_status, external_scope_id: tool.external_scope_id, external_subject_id: tool.external_subject_id });
}
/** A citation the answer contract refuses leaves its item out: the asker sees less, never more. */
function cited(value: unknown): PersonWorkspaceCitationV1 | undefined {
  try { return validatePersonWorkspaceCitationV1(value); } catch { return undefined; }
}

export function createPersonWorkspaceEvidenceSourcesV1(options: CreatePersonWorkspaceEvidenceSourcesV1Options): PersonWorkspaceEvidenceSourcesV1 {
  const { sources, scope, access_token: token } = options;
  const bound = options.authenticate();
  const grantsOf = (person: PersonAccessAuthorization): ReadonlyMap<string, string> => new Map(sources.grants(person).map(grant => [grant.project_id, grant.project_membership_id]));
  /** Each item released in this request, by desk id, so that the source of its kind can open it. */
  const issued = new Map<string, { readonly kind: WorkspaceItemKind; readonly key: string }>();
  /** What each source released, and what it released since its last successful check (ADR-0038). */
  const ledger = (): Ledger => ({ released: new Map(), unchecked: new Set() });
  const ledgers: Readonly<Record<WorkspaceSourceIdV1, Ledger>> = Object.freeze({ projects: ledger(), people: ledger(), tools: ledger() });
  const cursors = new Map<string, { readonly source: WorkspaceSourceIdV1; readonly selection: string; readonly after: string }>();
  let cursorSequence = 0;

  /** The asker's session, still the person these sources were bound to. */
  const current = (signal?: AbortSignal): PersonAccessAuthorization => {
    signal?.throwIfAborted();
    const authorization = options.authenticate();
    if (authorization.organization_id !== bound.organization_id || authorization.principal_id !== bound.principal_id || authorization.membership_id !== bound.membership_id) stale();
    return authorization;
  };
  const inScope = (project_id: string) => scope.kind === 'global' || project_id === scope.project_id;
  const bindGrants = grantsOf(bound);
  const count = [...bindGrants.keys()].filter(inScope).length;

  let view: View | undefined;
  /** The asker's projects in scope, each project's roster and its tools' settings, read once a request at its first call. */
  const readView = (signal?: AbortSignal): View => {
    const authorization = current(signal);
    if (view !== undefined) return view;
    const read = (['active', 'archived'] as const).flatMap(status => everyPage(paging => sources.projects.listProjectsV2(token, { status, ...paging }), signal));
    // A project left between the two reads is not the asker's; one joined between them appears in the next request.
    const grants = grantsOf(authorization);
    const projects = Object.freeze(read.filter(project => grants.has(project.project_id) && inScope(project.project_id)).sort(newestFirst));
    const members = new Map(projects.map(project => [project.project_id, Object.freeze(everyPage(paging => sources.projects.listMembers(token, { project_id: project.project_id, ...paging }), signal))]));
    const memberships = new Map<string, { readonly project: ProjectSummaryV2; readonly role: ProjectRoleV1 }[]>();
    for (const project of projects) {
      for (const member of members.get(project.project_id)!) {
        const entries = memberships.get(member.membership_id) ?? [];
        entries.push(Object.freeze({ project, role: member.role }));
        memberships.set(member.membership_id, entries);
      }
    }
    const setting = <M, V>(reader: PersonWorkspaceProjectSettingV1<M> | undefined, value: (mapping: M) => V): ReadonlyMap<string, V | null> | undefined => {
      if (reader === undefined) return undefined;
      return new Map(projects.map(project => {
        signal?.throwIfAborted();
        const { mapping } = reader.projectRead({ access_token: token, request: { schema_version: 1, project_id: project.project_id } });
        return [project.project_id, mapping === null ? null : value(mapping)];
      }));
    };
    const jira = setting(sources.jira, mapping => mapping.project_key);
    const confluence = setting(sources.confluence, mapping => mapping.space_ids.length);
    view = Object.freeze({ projects, grants, members, memberships, ...(jira === undefined ? {} : { jira }), ...(confluence === undefined ? {} : { confluence }) });
    return view;
  };
  let directory: readonly Person[] | undefined;
  /** The people a scope shows: the organization directory, or in a project its roster. The directory is read once a request. */
  const readPeople = (shown: View, signal?: AbortSignal): readonly Person[] => {
    if (scope.kind === 'project') return shown.members.get(scope.project_id) ?? [];
    directory ??= Object.freeze(everyPage(paging => sources.projects.searchOrganizationDirectory(token, paging), signal));
    return directory;
  };
  let tools: readonly OrganizationPersonToolV4[] | undefined;
  const readTools = async (signal?: AbortSignal): Promise<readonly OrganizationPersonToolV4[]> => {
    current(signal);
    if (tools === undefined) {
      const read = await sources.tools(token);
      current(signal);
      tools = Object.freeze([...read]);
    }
    return tools;
  };

  const project = (shown: View, value: ProjectSummaryV2, members?: readonly string[]): Shaped | undefined => {
    const citation = cited({ kind: 'project', project_id: value.project_id });
    if (citation === undefined) return undefined;
    const roster = shown.members.get(value.project_id) ?? [];
    const leads = roster.filter(member => member.role === 'lead').map(member => member.display_name);
    const lines = [
      `Members: ${named(roster.map(member => `${member.display_name} (${member.role})`), PERSON_WORKSPACE_LIMITS_V1.names)}`,
      ...(shown.jira === undefined ? [] : [`Jira project: ${shown.jira.get(value.project_id) ?? 'none set'}`]),
      ...(shown.confluence === undefined ? [] : [`Confluence spaces: ${shown.confluence.get(value.project_id) ?? 'none set'}`]),
    ];
    return Object.freeze({
      id: `project_${value.project_id}`, kind: 'project', key: value.project_id,
      fields: Object.freeze({
        kind: 'project', citation, ref: `project:${value.project_id}` as const, label: value.name,
        attributes: Object.freeze({ status: value.status, role: value.role, ...(leads.length === 0 ? {} : { leads: listed(leads, PERSON_WORKSPACE_LIMITS_V1.leads) }) }),
        dates: Object.freeze({ created: value.created_at }), text: lines.join('\n'),
        ...(members === undefined ? {} : { links: Object.freeze({ members: Object.freeze([...members]) }) }),
        visibility: 'project' as const,
      }),
      release: Object.freeze({ kind: 'project', project_id: value.project_id, grant: shown.grants.get(value.project_id)! }),
    });
  };
  const person = (shown: View, value: Person, projects?: readonly string[]): Shaped | undefined => {
    const citation = cited({ kind: 'person', membership_id: value.membership_id });
    if (citation === undefined) return undefined;
    const shared = shown.memberships.get(value.membership_id) ?? [];
    const roles = named(shared.map(entry => `${entry.project.name} (${entry.role})`), PERSON_WORKSPACE_LIMITS_V1.names);
    const text = value.membership_id === bound.membership_id
      ? `This is you.\n${shared.length === 0 ? 'You belong to no project.' : `Your projects: ${roles}`}`
      : shared.length === 0 ? 'Shares no project with you.' : `Projects shared with you: ${roles}`;
    // The directory is the organization's; each shared project's roster is that project's.
    const visibility: EvidenceDeskVisibilityV1 = shared.length === 0 ? 'team' : shared.length === 1 ? 'project' : 'projects';
    return Object.freeze({
      id: `person_${value.membership_id}`, kind: 'person', key: value.membership_id,
      fields: Object.freeze({
        kind: 'person', citation, label: value.display_name, text,
        ...(projects === undefined ? {} : { links: Object.freeze({ projects: Object.freeze([...projects]) }) }),
        visibility,
      }),
      release: Object.freeze({ kind: 'person', membership_id: value.membership_id, projects: new Map(shared.map(entry => [entry.project.project_id, shown.grants.get(entry.project.project_id)!])) }),
    });
  };
  const tool = (value: OrganizationPersonToolV4): Shaped | undefined => {
    const citation = cited({ kind: 'tool', tool_id: value.tool_id });
    if (citation === undefined) return undefined;
    const name = value.display_name;
    const state = value.availability === 'unavailable' ? 'unavailable' : value.personal_status;
    const lines = [
      state === 'linked' ? `You have connected ${name} to ECHO.`
        : state === 'unlinked' ? `You have not connected ${name} to ECHO. You can connect it on the Tools page.`
          : state === 'revoked' ? `Your ${name} connection was revoked. You can connect it again on the Tools page.`
            : `${name} is not available in this organization.`,
      ...(value.organization_setup === null ? [] : [`Organization setup: ${TOOL_SETUP[value.organization_setup]}`]),
    ];
    // Never the site or account a connection names: the tools page shows them, research has no use for them.
    return Object.freeze({
      id: `tool_${value.tool_id}`, kind: 'tool', key: value.tool_id,
      fields: Object.freeze({
        kind: 'tool', citation, ref: `tool:${value.tool_id}` as const, label: name, attributes: Object.freeze({ status: TOOL_STATUS[state] }),
        text: lines.join('\n'), visibility: 'only_me' as const,
      }),
      release: Object.freeze({ kind: 'tool', tool_id: value.tool_id, connection: connectionOf(value), setup: value.organization_setup !== null }),
    });
  };

  /** Projects with their members linked, each member once beside the result; a link only to a person released here or before. */
  const withMembers = (shown: View, chosen: readonly ProjectSummaryV2[]) => {
    const rosters = new Map(chosen.map(value => [value.project_id, (shown.members.get(value.project_id) ?? []).slice(0, PERSON_WORKSPACE_LIMITS_V1.names)]));
    const beside = new Map<string, ProjectMemberV1>();
    for (const roster of rosters.values()) for (const member of roster) if (!beside.has(member.membership_id) && beside.size < PERSON_WORKSPACE_LIMITS_V1.linked) beside.set(member.membership_id, member);
    const linked = [...beside.values()].flatMap(member => person(shown, member) ?? []);
    const released = new Set(linked.map(value => value.id));
    const rows = chosen.flatMap(value => project(shown, value, rosters.get(value.project_id)!.map(member => `person_${member.membership_id}`).filter(id => released.has(id) || issued.has(id))) ?? []);
    return { rows, linked };
  };
  /** People with the projects they share with the asker linked, each project once beside the result. */
  const withProjects = (shown: View, chosen: readonly Person[]) => {
    const shares = new Map(chosen.map(value => [value.membership_id, (shown.memberships.get(value.membership_id) ?? []).slice(0, PERSON_WORKSPACE_LIMITS_V1.names)]));
    const beside = new Map<string, ProjectSummaryV2>();
    for (const entries of shares.values()) for (const { project: value } of entries) if (!beside.has(value.project_id) && beside.size < PERSON_WORKSPACE_LIMITS_V1.linked) beside.set(value.project_id, value);
    const linked = [...beside.values()].flatMap(value => project(shown, value) ?? []);
    const released = new Set(linked.map(value => value.id));
    const rows = chosen.flatMap(value => person(shown, value, shares.get(value.membership_id)!.map(entry => `project_${entry.project.project_id}`).filter(id => released.has(id) || issued.has(id))) ?? []);
    return { rows, linked };
  };

  /** Audits one call's items and the items beside them before they leave, then remembers each for `open` and the checks. */
  const release = (source: WorkspaceSourceIdV1, operation: PersonWorkspaceReleaseV1['operation'], rows: readonly Shaped[], beside: readonly Shaped[],
    page: { readonly truncated: boolean; readonly next_cursor?: string | undefined; readonly page_full?: boolean }): EvidenceDeskResultV2 => {
    const digest = (value: Shaped) => canonicalSha256({ id: value.id, ...value.fields });
    const receipt = options.audit.record({ source, operation, items: [
      ...rows.map(value => ({ kind: value.kind, item_id: value.key, linked: false, released_fields_sha256: digest(value) })),
      ...beside.map(value => ({ kind: value.kind, item_id: value.key, linked: true, released_fields_sha256: digest(value) })),
    ] });
    const ledger = ledgers[source];
    const out = (value: Shaped): EvidenceDeskItemV2 => {
      issued.set(value.id, Object.freeze({ kind: value.kind, key: value.key }));
      const previous = ledger.released.get(value.id);
      // A person released again keeps every project any of its releases named.
      ledger.released.set(value.id, previous?.kind === 'person' && value.release.kind === 'person'
        ? Object.freeze({ ...value.release, projects: new Map([...previous.projects, ...value.release.projects]) }) : value.release);
      ledger.unchecked.add(value.id);
      return Object.freeze({ id: value.id, ...value.fields, receipt_sha256: receipt });
    };
    const items = rows.map(out);
    const linked = beside.map(out);
    return Object.freeze({
      items: Object.freeze(items), truncated: page.truncated, receipt_digests: Object.freeze([receipt]),
      ...(linked.length === 0 ? {} : { linked: Object.freeze(linked) }),
      ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
      ...(page.page_full === undefined ? {} : { page_full: page.page_full }),
    });
  };
  /** One page of a list, after its cursor; the next cursor only when more match. */
  const paged = <T>(source: WorkspaceSourceIdV1, matching: readonly T[], keyOf: (value: T) => string, size: number, selection: string, cursor: string | undefined) => {
    let start = 0;
    if (cursor !== undefined) {
      const saved = cursors.get(cursor);
      if (saved === undefined || saved.source !== source || saved.selection !== selection) return invalid('Evidence list cursor is invalid');
      const index = matching.findIndex(value => keyOf(value) === saved.after);
      if (index < 0) return invalid('Evidence list cursor is invalid');
      start = index + 1;
    }
    const page = matching.slice(start, start + size);
    let next_cursor: string | undefined;
    if (start + page.length < matching.length) {
      next_cursor = `${source}_${++cursorSequence}`;
      cursors.set(next_cursor, Object.freeze({ source, selection, after: keyOf(page.at(-1)!) }));
    }
    return { page, next_cursor };
  };
  const query = (input: { readonly query: string }): readonly string[] => {
    if (typeof input.query !== 'string') invalid('query is required');
    return termsOf(input.query);
  };
  const otherFilters = (input: EvidenceDeskListInputV2, source: WorkspaceSourceIdV1, takes: readonly ('status' | 'role')[]) => {
    const kind = WORKSPACE_SOURCE_KINDS_V1[source];
    if (input.owner !== undefined || input.channel !== undefined || input.kinds?.some(value => value !== kind) ||
        (!takes.includes('status') && input.status !== undefined) || (!takes.includes('role') && input.role !== undefined)) {
      invalid(takes.length === 0 ? `${source} take no filters` : `${source} take only ${takes.join(' and ')}`);
    }
  };

  /** Projects ranked by the query's words in their names or Jira keys, then in their members' names; active, then newest, first. */
  const findProjects = (shown: View, terms: readonly string[], dated: EvidenceDateFilterV1) => shown.projects.flatMap(value => {
    if (!matchesEvidenceDateV1({ created: value.created_at }, dated, 'created')) return [];
    const own = wordsOf([value.name, shown.jira?.get(value.project_id)]);
    const members = wordsOf((shown.members.get(value.project_id) ?? []).map(member => member.display_name));
    const strong = terms.filter(term => own.has(term)).length;
    const weak = terms.filter(term => !own.has(term) && members.has(term)).length;
    return strong + weak === 0 ? [] : [{ value, score: 2 * strong + weak }];
  }).sort((left, right) => right.score - left.score || Number(left.value.status === 'archived') - Number(right.value.status === 'archived') || newestFirst(left.value, right.value))
    .map(entry => entry.value);
  /** People or tools ranked by the query's words in their names, in their list's order. */
  const findNamed = <T>(values: readonly T[], terms: readonly string[], names: (value: T) => readonly string[]) => values
    .map(value => { const words = wordsOf(names(value)); return { value, score: terms.filter(term => words.has(term)).length }; })
    .filter(entry => entry.score > 0).sort((left, right) => right.score - left.score).map(entry => entry.value);

  const projects: PersonWorkspaceLocalSourceV1 = Object.freeze({
    descriptor: Object.freeze({ ...PROJECTS_SOURCE_DESCRIPTOR_V1, capabilities: Object.freeze({ ...PROJECTS_SOURCE_DESCRIPTOR_V1.capabilities, count }) }),
    async search(input: Parameters<PersonWorkspaceEvidenceSourceV1['search']>[0]) {
      validateEvidenceDateFilterV1(input, PROJECT_DATES);
      const limit = pageSize(input.limit, PERSON_WORKSPACE_LIMITS_V1.search_hits);
      const terms = query(input);
      const shown = readView(input.signal);
      const hits = terms.length === 0 ? [] : findProjects(shown, terms, input);
      const { rows, linked } = withMembers(shown, hits.slice(0, limit));
      input.signal?.throwIfAborted();
      return release('projects', 'search', rows, linked, { truncated: hits.length > limit });
    },
    async list(input: EvidenceDeskListInputV2) {
      validateEvidenceDateFilterV1(input, PROJECT_DATES);
      otherFilters(input, 'projects', ['status', 'role']);
      if (input.status !== undefined && input.status !== 'active' && input.status !== 'archived') invalid('status must be "active" or "archived"');
      if (input.role !== undefined && input.role !== 'lead' && input.role !== 'member') invalid('role must be "lead" or "member"');
      const size = pageSize(input.limit, PERSON_WORKSPACE_LIMITS_V1.list_page);
      const selection = JSON.stringify({ status: input.status ?? null, role: input.role ?? null, since: input.since ?? null, until: input.until ?? null, date_field: input.date_field ?? null, time_zone: input.time_zone ?? null });
      const shown = readView(input.signal);
      // Filters apply before anything is released; the asker's role is their own in each project.
      const matching = shown.projects.filter(value => (input.status === undefined || value.status === input.status) && (input.role === undefined || value.role === input.role) &&
        matchesEvidenceDateV1({ created: value.created_at }, input, 'created'));
      const { page, next_cursor } = paged('projects', matching, value => value.project_id, size, selection, input.cursor);
      const { rows, linked } = withMembers(shown, page);
      input.signal?.throwIfAborted();
      // This source holds every project the asker can see, so a list's end is always confirmed (ADR-0041).
      return release('projects', 'list', rows, linked, { truncated: false, next_cursor, page_full: false });
    },
    async open(input: { readonly item: string; readonly signal?: AbortSignal }) {
      const found = issued.get(input.item);
      if (found === undefined || found.kind !== 'project') return notFound();
      const shown = readView(input.signal);
      const value = shown.projects.find(entry => entry.project_id === found.key) ?? notFound();
      const { rows, linked } = withMembers(shown, [value]);
      if (rows.length === 0) notFound();
      input.signal?.throwIfAborted();
      return release('projects', 'open', rows, linked, { truncated: false });
    },
    revalidate: (input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>) => check('projects', input),
  });

  const people: PersonWorkspaceLocalSourceV1 = Object.freeze({
    descriptor: PEOPLE_SOURCE_DESCRIPTOR_V1,
    async search(input: Parameters<PersonWorkspaceEvidenceSourceV1['search']>[0]) {
      refuseDates(input, 'people');
      const limit = pageSize(input.limit, PERSON_WORKSPACE_LIMITS_V1.search_hits);
      const terms = query(input);
      const shown = readView(input.signal);
      const hits = terms.length === 0 ? [] : findNamed(readPeople(shown, input.signal), terms, value => [value.display_name]);
      const { rows, linked } = withProjects(shown, hits.slice(0, limit));
      input.signal?.throwIfAborted();
      return release('people', 'search', rows, linked, { truncated: hits.length > limit });
    },
    async list(input: EvidenceDeskListInputV2) {
      refuseDates(input, 'people');
      otherFilters(input, 'people', []);
      const size = pageSize(input.limit, PERSON_WORKSPACE_LIMITS_V1.list_page);
      const shown = readView(input.signal);
      const { page, next_cursor } = paged('people', readPeople(shown, input.signal), value => value.membership_id, size, '{}', input.cursor);
      const { rows, linked } = withProjects(shown, page);
      input.signal?.throwIfAborted();
      return release('people', 'list', rows, linked, { truncated: false, next_cursor, page_full: false });
    },
    async open(input: { readonly item: string; readonly signal?: AbortSignal }) {
      const found = issued.get(input.item);
      if (found === undefined || found.kind !== 'person') return notFound();
      const shown = readView(input.signal);
      const value = readPeople(shown, input.signal).find(entry => entry.membership_id === found.key) ?? notFound();
      const { rows, linked } = withProjects(shown, [value]);
      if (rows.length === 0) notFound();
      input.signal?.throwIfAborted();
      return release('people', 'open', rows, linked, { truncated: false });
    },
    revalidate: (input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>) => check('people', input),
  });

  const toolsSource: PersonWorkspaceToolsSourceV1 = Object.freeze({
    descriptor: TOOLS_SOURCE_DESCRIPTOR_V1,
    async search(input: Parameters<PersonWorkspaceEvidenceSourceV1['search']>[0]) {
      refuseDates(input, 'tools');
      const limit = pageSize(input.limit, PERSON_WORKSPACE_LIMITS_V1.search_hits);
      const terms = query(input);
      const all = await readTools(input.signal);
      const hits = terms.length === 0 ? [] : findNamed(all, terms, value => [value.display_name, value.tool_id]);
      input.signal?.throwIfAborted();
      return release('tools', 'search', hits.slice(0, limit).flatMap(value => tool(value) ?? []), [], { truncated: hits.length > limit });
    },
    async list(input: EvidenceDeskListInputV2) {
      refuseDates(input, 'tools');
      otherFilters(input, 'tools', []);
      const size = pageSize(input.limit, PERSON_WORKSPACE_LIMITS_V1.list_page);
      const { page, next_cursor } = paged('tools', await readTools(input.signal), value => value.tool_id, size, '{}', input.cursor);
      input.signal?.throwIfAborted();
      return release('tools', 'list', page.flatMap(value => tool(value) ?? []), [], { truncated: false, next_cursor, page_full: false });
    },
    async open(input: { readonly item: string; readonly signal?: AbortSignal }) {
      const found = issued.get(input.item);
      if (found === undefined || found.kind !== 'tool') return notFound();
      const value = (await readTools(input.signal)).find(entry => entry.tool_id === found.key);
      const shaped = value === undefined ? undefined : tool(value);
      if (shaped === undefined) return notFound();
      input.signal?.throwIfAborted();
      return release('tools', 'open', [shaped], [], { truncated: false });
    },
    async revalidate(input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>) {
      input.signal?.throwIfAborted();
      const ledger = ledgers.tools;
      const ids = [...(input.mode === 'incremental' ? ledger.unchecked : ledger.released.keys())];
      if (ids.length === 0) return;
      current(input.signal);
      const now = new Map((await sources.tools(token)).map(value => [value.tool_id, value]));
      current(input.signal);
      for (const id of ids) {
        const released = ledger.released.get(id)!;
        if (released.kind !== 'tool') continue;
        const value = now.get(released.tool_id);
        if (value === undefined || connectionOf(value) !== released.connection || (released.setup && value.organization_setup === null)) stale();
      }
      for (const id of ids) ledger.unchecked.delete(id);
    },
  });

  /** A local source's check: the session, the asker's grants and each released person's membership, read now. */
  function check(source: 'projects' | 'people', input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>): void {
    input.signal?.throwIfAborted();
    const ledger = ledgers[source];
    const ids = [...(input.mode === 'incremental' ? ledger.unchecked : ledger.released.keys())];
    if (ids.length === 0) return;
    const grants = grantsOf(current(input.signal));
    const releases = ids.map(id => ledger.released.get(id)!);
    const members = releases.flatMap(value => (value.kind === 'person' ? [value.membership_id] : []));
    const active = members.length === 0 ? new Map<string, { readonly active: boolean }>() : sources.people.people(bound.organization_id, members);
    for (const value of releases) {
      // The same grant, not merely a grant: one left and joined again is a new grant.
      if (value.kind === 'project' && grants.get(value.project_id) !== value.grant) stale();
      if (value.kind === 'person') {
        if (active.get(value.membership_id)?.active !== true) stale();
        for (const [project_id, grant] of value.projects) if (grants.get(project_id) !== grant) stale();
      }
    }
    input.signal?.throwIfAborted();
    for (const id of ids) ledger.unchecked.delete(id);
  }

  return Object.freeze({ projects, people, tools: toolsSource });
}
