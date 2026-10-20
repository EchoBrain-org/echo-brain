import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
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
import type { PersonWorkspaceReleaseAuditV1, PersonWorkspaceReleaseV1 } from '../adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import type { ProjectContextApplicationV1, ProjectContextRepositoryV1, ProjectMembershipGrantV1 } from '../application/ports/project-context-v1.js';
import {
  createEvidenceCursorsV1, evidenceInvalidV1 as invalid, evidenceNotFoundV1 as notFound, evidencePageSizeV1, evidenceTermsV1, evidenceWordsV1, newestFirstV1,
} from './person-local-source-helpers-v1.js';

/**
 * The asker's workspace as three Ask sources (research tool contract v1): the projects they belong to, the people in their
 * organization, and their tools, each read as the asker through the project context application and the person tools
 * list. A request reads what its scope shows once, at its first call, and audits every release before it leaves.
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

export interface CreatePersonWorkspaceEvidenceSourcesV1Options {
  readonly sources: PersonWorkspaceSourcesV1;
  /** The asker's access token: every read is made as them. */
  readonly access_token: string;
  /** The asker's session now. The sources are bound to the person it names at creation; every call and check reads it again. */
  readonly authenticate: () => PersonAccessAuthorization;
  /** Never Mine: Mine reads only what the asker added. In a project, only that project and its members. */
  readonly scope: { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };
  /** One audit for the request, shared by the three sources (`SqlitePersonAgenticAskAuditV1.forWorkspaceRequest`). */
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
/** Projects and people: ECHO's own state, read synchronously, so the desk runs their checks with its final local ones. */
export interface PersonWorkspaceLocalSourceV1 extends PersonWorkspaceEvidenceSourceV1 {
  /**
   * Every item this source released since its last successful check (`incremental`), or every one (`full`, the default),
   * against the asker's grants and the organization's memberships now. Fails with `stale_access_state` when the session is
   * another person, the asker no longer holds the same grant for a released project or a project a released person's text
   * named, or a released person is no longer an active member. A project renamed, archived or re-roled meanwhile is not an
   * access change.
   */
  revalidate(input: Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>): void;
}
/** Tools: the person tools list is read through each tool's own store and fences, so the desk awaits its check. */
export interface PersonWorkspaceToolsSourceV1 extends PersonWorkspaceEvidenceSourceV1 {
  /**
   * As the local check, against the person tools list read again: fails with `stale_access_state` when a released tool's
   * connection changed (its status, availability, site or account) or the asker no longer sees the organization setup a
   * release named.
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
type Fields = Omit<EvidenceDeskItemV2, 'id' | 'receipt_sha256'>;
type Shaped = { readonly id: string; readonly kind: WorkspaceItemKind; readonly key: string; readonly fields: Fields; readonly release: Release };
type Ledger = { readonly released: Map<string, Release>; readonly unchecked: Set<string> };
type CheckInput = Pick<EvidenceDeskRevalidateInputV1, 'mode' | 'signal'>;
/**
 * How one source reads, from which `local` builds its search, list and open. By default a source refuses every date and
 * list filter, keeps every item and binds its cursors to no selection; only the tools list loads asynchronously.
 */
interface Reads<C, T> {
  readonly descriptor: WorkspaceSourceDescriptorV1;
  readonly dates?: (input: EvidenceDateFilterV1) => void;
  readonly filters?: (input: EvidenceDeskListInputV2) => void;
  readonly load?: (signal?: AbortSignal) => Promise<unknown>;
  /** What the request read for the source, the asker's session checked first; `all` is every item its scope shows. */
  readonly read: (signal?: AbortSignal) => C;
  readonly all: (read: C, signal?: AbortSignal) => readonly T[];
  readonly keyOf: (value: T) => string;
  /** The items a search's words find, best first. */
  readonly find: (read: C, terms: readonly string[], dates: EvidenceDateFilterV1, signal?: AbortSignal) => readonly T[];
  readonly keeps?: (value: T, input: EvidenceDeskListInputV2) => boolean;
  readonly selection?: (input: EvidenceDeskListInputV2) => string;
  /** The chosen items as rows, with the items they link to released beside them. */
  readonly shape: (read: C, chosen: readonly T[]) => { readonly rows: readonly Shaped[]; readonly linked: readonly Shaped[] };
}

const PROJECT_DATES: readonly EvidenceDateSelectionV1[] = Object.freeze(['created', 'any']);
/** The field each item kind's workspace citation names its item by. */
const CITATION_IDS = Object.freeze({ project: 'project_id', person: 'membership_id', tool: 'tool_id' } as const satisfies Record<WorkspaceItemKind, string>);
const TOOL_STATUS: Readonly<Record<OrganizationPersonToolV4['personal_status'], string>> = Object.freeze({ linked: 'connected', unlinked: 'not connected', revoked: 'connection revoked', unavailable: 'not available' });
const TOOL_SETUP: Readonly<Record<OrganizationToolSetupStatusV4, string>> = Object.freeze({ not_set_up: 'not set up', app_created: 'app created', connected: 'connected', needs_reinstall: 'needs reinstall' });

const stale = (): never => { throw new AuthorityOperationError('stale_access_state', 'A workspace item is no longer available to this person'); };

/** People and tools have no dates, so a date bound is refused rather than ignored. A time zone alone bounds nothing. */
function refuseDates(input: EvidenceDateFilterV1, source: string): void {
  if (input.since !== undefined || input.until !== undefined || input.date_field !== undefined) invalid(`${source} have no dates; leave out since, until and date_field`);
}
/** Refuses a filter of another source, or one this source does not take. */
function otherFilters(input: EvidenceDeskListInputV2, source: WorkspaceSourceIdV1, takes: readonly ('status' | 'role')[]): void {
  const kind = WORKSPACE_SOURCE_KINDS_V1[source];
  if (input.owner !== undefined || input.channel !== undefined || input.kinds?.some(value => value !== kind) ||
      (!takes.includes('status') && input.status !== undefined) || (!takes.includes('role') && input.role !== undefined)) {
    invalid(takes.length === 0 ? `${source} take no filters` : `${source} take only ${takes.join(' and ')}`);
  }
}
/** Names joined with ", ", then how many more; an attribute says only that there are more. */
function named(values: readonly string[], maximum: number, counted = true): string {
  return values.length <= maximum ? values.join(', ') : `${values.slice(0, maximum).join(', ')}, and ${counted ? `${values.length - maximum} ` : ''}more`;
}
/** Newest first, as the project list orders them; then by id. */
const newestFirst = newestFirstV1<ProjectSummaryV2>(project => project.project_id);
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
/** An item by its kind and key: its citation, then `fields`; none when its citation is refused. */
function item(kind: WorkspaceItemKind, key: string, release: Release, fields: Omit<Fields, 'kind' | 'citation'>): Shaped | undefined {
  const citation = cited({ kind, [CITATION_IDS[kind]]: key });
  return citation === undefined ? undefined : Object.freeze({ id: `${kind}_${key}`, kind, key, fields: Object.freeze({ kind, citation, ...fields }), release: Object.freeze(release) });
}
/** People or tools ranked by the query's words in their names, in their list's order. */
function findNamed<T>(values: readonly T[], terms: readonly string[], names: (value: T) => readonly string[]): readonly T[] {
  return values.map(value => { const words = evidenceWordsV1(names(value)); return { value, score: terms.filter(term => words.has(term)).length }; })
    .filter(entry => entry.score > 0).sort((left, right) => right.score - left.score).map(entry => entry.value);
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
  const cursors = createEvidenceCursorsV1<string>();

  /** The asker's session, still the person these sources were bound to. */
  const current = (signal?: AbortSignal): PersonAccessAuthorization => {
    signal?.throwIfAborted();
    const authorization = options.authenticate();
    if (authorization.organization_id !== bound.organization_id || authorization.principal_id !== bound.principal_id || authorization.membership_id !== bound.membership_id) stale();
    return authorization;
  };
  const inScope = (project_id: string) => scope.kind === 'global' || project_id === scope.project_id;
  const count = [...grantsOf(bound).keys()].filter(inScope).length;

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
    const roster = shown.members.get(value.project_id) ?? [];
    const leads = roster.filter(member => member.role === 'lead').map(member => member.display_name);
    const lines = [
      `Members: ${named(roster.map(member => `${member.display_name} (${member.role})`), PERSON_WORKSPACE_LIMITS_V1.names)}`,
      ...(shown.jira === undefined ? [] : [`Jira project: ${shown.jira.get(value.project_id) ?? 'none set'}`]),
      ...(shown.confluence === undefined ? [] : [`Confluence spaces: ${shown.confluence.get(value.project_id) ?? 'none set'}`]),
    ];
    return item('project', value.project_id, { kind: 'project', project_id: value.project_id, grant: shown.grants.get(value.project_id)! }, {
      ref: `project:${value.project_id}` as const, label: value.name,
      attributes: Object.freeze({ status: value.status, role: value.role, ...(leads.length === 0 ? {} : { leads: named(leads, PERSON_WORKSPACE_LIMITS_V1.leads, false) }) }),
      dates: Object.freeze({ created: value.created_at }), text: lines.join('\n'),
      ...(members === undefined ? {} : { links: Object.freeze({ members: Object.freeze([...members]) }) }),
      visibility: 'project' as const,
    });
  };
  const person = (shown: View, value: Person, projects?: readonly string[]): Shaped | undefined => {
    const shared = shown.memberships.get(value.membership_id) ?? [];
    const roles = named(shared.map(entry => `${entry.project.name} (${entry.role})`), PERSON_WORKSPACE_LIMITS_V1.names);
    const text = value.membership_id === bound.membership_id
      ? `This is you.\n${shared.length === 0 ? 'You belong to no project.' : `Your projects: ${roles}`}`
      : shared.length === 0 ? 'Shares no project with you.' : `Projects shared with you: ${roles}`;
    // The directory is the organization's; each shared project's roster is that project's.
    const visibility: EvidenceDeskVisibilityV1 = shared.length === 0 ? 'team' : shared.length === 1 ? 'project' : 'projects';
    return item('person', value.membership_id, { kind: 'person', membership_id: value.membership_id, projects: new Map(shared.map(entry => [entry.project.project_id, shown.grants.get(entry.project.project_id)!])) }, {
      label: value.display_name, text, ...(projects === undefined ? {} : { links: Object.freeze({ projects: Object.freeze([...projects]) }) }), visibility,
    });
  };
  const tool = (value: OrganizationPersonToolV4): Shaped | undefined => {
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
    return item('tool', value.tool_id, { kind: 'tool', tool_id: value.tool_id, connection: connectionOf(value), setup: value.organization_setup !== null }, {
      ref: `tool:${value.tool_id}` as const, label: name, attributes: Object.freeze({ status: TOOL_STATUS[state] }), text: lines.join('\n'), visibility: 'only_me' as const,
    });
  };

  /**
   * Rows with what each links to (a project's members, a person's shared projects), each linked item released once beside
   * them, at most `linked` in all. A row links only to an item released here or before.
   */
  const withLinks = <R, L>(chosen: readonly R[], linksOf: (row: R) => readonly L[], idOf: (link: L) => string,
    beside: (link: L) => Shaped | undefined, row: (value: R, links: readonly string[]) => Shaped | undefined) => {
    const links = chosen.map(value => linksOf(value).slice(0, PERSON_WORKSPACE_LIMITS_V1.names));
    const kept = new Map<string, L>();
    for (const list of links) for (const link of list) if (!kept.has(idOf(link)) && kept.size < PERSON_WORKSPACE_LIMITS_V1.linked) kept.set(idOf(link), link);
    const linked = [...kept.values()].flatMap(link => beside(link) ?? []);
    const released = new Set(linked.map(value => value.id));
    const rows = chosen.flatMap((value, index) => row(value, links[index]!.map(idOf).filter(id => released.has(id) || issued.has(id))) ?? []);
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
  /** One page of a list, after its cursor; the next cursor only when more match. A cursor continues only its own list. */
  const paged = <T>(source: WorkspaceSourceIdV1, matching: readonly T[], keyOf: (value: T) => string, size: number, selection: string, cursor: string | undefined) => {
    const listed = `${source}:${selection}`;
    const after = cursor === undefined ? undefined : cursors.after(cursor, listed);
    const start = after === undefined ? 0 : matching.findIndex(value => keyOf(value) === after) + 1;
    if (after !== undefined && start === 0) invalid('Evidence list cursor is invalid');
    const page = matching.slice(start, start + size);
    const next_cursor = start + page.length < matching.length ? cursors.next(source, listed, keyOf(page.at(-1)!)) : undefined;
    return { page, next_cursor };
  };

  /** A source's search, list and open: its refusals first, then what its scope shows, then one audited release. */
  const local = <C, T>(reads: Reads<C, T>): PersonWorkspaceEvidenceSourceV1 => {
    const { descriptor } = reads;
    const source = descriptor.source_id;
    const dates = reads.dates ?? ((input: EvidenceDateFilterV1) => refuseDates(input, source));
    const filters = reads.filters ?? ((input: EvidenceDeskListInputV2) => otherFilters(input, source, []));
    return {
      descriptor,
      async search(input) {
        dates(input);
        const limit = evidencePageSizeV1(input.limit, PERSON_WORKSPACE_LIMITS_V1.search_hits);
        if (typeof input.query !== 'string') invalid('query is required');
        const terms = evidenceTermsV1(input.query);
        if (reads.load !== undefined) await reads.load(input.signal);
        const shown = reads.read(input.signal);
        const hits = terms.length === 0 ? [] : reads.find(shown, terms, input, input.signal);
        const { rows, linked } = reads.shape(shown, hits.slice(0, limit));
        input.signal?.throwIfAborted();
        return release(source, 'search', rows, linked, { truncated: hits.length > limit });
      },
      async list(input) {
        dates(input);
        filters(input);
        const size = evidencePageSizeV1(input.limit, PERSON_WORKSPACE_LIMITS_V1.list_page);
        if (reads.load !== undefined) await reads.load(input.signal);
        const shown = reads.read(input.signal);
        // Filters apply before anything is released.
        const matching = reads.all(shown, input.signal).filter(value => reads.keeps?.(value, input) ?? true);
        const { page, next_cursor } = paged(source, matching, reads.keyOf, size, reads.selection?.(input) ?? '{}', input.cursor);
        const { rows, linked } = reads.shape(shown, page);
        input.signal?.throwIfAborted();
        // This source holds every item the asker can see, so a list's end is always confirmed (ADR-0041).
        return release(source, 'list', rows, linked, { truncated: false, next_cursor, page_full: false });
      },
      async open(input) {
        const found = issued.get(input.item);
        if (found === undefined || found.kind !== descriptor.kind) return notFound();
        if (reads.load !== undefined) await reads.load(input.signal);
        const shown = reads.read(input.signal);
        const value = reads.all(shown, input.signal).find(entry => reads.keyOf(entry) === found.key) ?? notFound();
        const { rows, linked } = reads.shape(shown, [value]);
        if (rows.length === 0) notFound();
        input.signal?.throwIfAborted();
        return release(source, 'open', rows, linked, { truncated: false });
      },
    };
  };

  /** Projects ranked by the query's words in their names or Jira keys, then in their members' names; active, then newest, first. */
  const findProjects = (shown: View, terms: readonly string[], dated: EvidenceDateFilterV1) => shown.projects.flatMap(value => {
    if (!matchesEvidenceDateV1({ created: value.created_at }, dated, 'created')) return [];
    const own = evidenceWordsV1([value.name, shown.jira?.get(value.project_id)]);
    const members = evidenceWordsV1((shown.members.get(value.project_id) ?? []).map(member => member.display_name));
    const strong = terms.filter(term => own.has(term)).length;
    const weak = terms.filter(term => !own.has(term) && members.has(term)).length;
    return strong + weak === 0 ? [] : [{ value, score: 2 * strong + weak }];
  }).sort((left, right) => right.score - left.score || Number(left.value.status === 'archived') - Number(right.value.status === 'archived') || newestFirst(left.value, right.value))
    .map(entry => entry.value);

  const projects: PersonWorkspaceLocalSourceV1 = Object.freeze({
    ...local<View, ProjectSummaryV2>({
      descriptor: Object.freeze({ ...PROJECTS_SOURCE_DESCRIPTOR_V1, capabilities: Object.freeze({ ...PROJECTS_SOURCE_DESCRIPTOR_V1.capabilities, count }) }),
      dates: input => validateEvidenceDateFilterV1(input, PROJECT_DATES),
      filters: input => {
        otherFilters(input, 'projects', ['status', 'role']);
        if (input.status !== undefined && input.status !== 'active' && input.status !== 'archived') invalid('status must be "active" or "archived"');
        if (input.role !== undefined && input.role !== 'lead' && input.role !== 'member') invalid('role must be "lead" or "member"');
      },
      read: readView, all: shown => shown.projects, keyOf: value => value.project_id, find: findProjects,
      // The asker's role is their own in each project.
      keeps: (value, input) => (input.status === undefined || value.status === input.status) && (input.role === undefined || value.role === input.role) &&
        matchesEvidenceDateV1({ created: value.created_at }, input, 'created'),
      selection: input => JSON.stringify({ status: input.status ?? null, role: input.role ?? null, since: input.since ?? null, until: input.until ?? null, date_field: input.date_field ?? null, time_zone: input.time_zone ?? null }),
      shape: (shown, chosen) => withLinks(chosen, value => shown.members.get(value.project_id) ?? [], member => `person_${member.membership_id}`,
        member => person(shown, member), (value, members) => project(shown, value, members)),
    }),
    revalidate: (input: CheckInput) => check('projects', input),
  });

  const people: PersonWorkspaceLocalSourceV1 = Object.freeze({
    ...local<View, Person>({
      descriptor: PEOPLE_SOURCE_DESCRIPTOR_V1, read: readView, all: readPeople, keyOf: value => value.membership_id,
      find: (shown, terms, _dates, signal) => findNamed(readPeople(shown, signal), terms, value => [value.display_name]),
      shape: (shown, chosen) => withLinks(chosen, value => shown.memberships.get(value.membership_id) ?? [], entry => `project_${entry.project.project_id}`,
        entry => project(shown, entry.project), (value, shared) => person(shown, value, shared)),
    }),
    revalidate: (input: CheckInput) => check('people', input),
  });

  const toolsSource: PersonWorkspaceToolsSourceV1 = Object.freeze({
    ...local<readonly OrganizationPersonToolV4[], OrganizationPersonToolV4>({
      descriptor: TOOLS_SOURCE_DESCRIPTOR_V1, load: readTools, read: () => tools!, all: all => all, keyOf: value => value.tool_id,
      find: (all, terms) => findNamed(all, terms, value => [value.display_name, value.tool_id]),
      shape: (_, chosen) => ({ rows: chosen.flatMap(value => tool(value) ?? []), linked: [] }),
    }),
    async revalidate(input: CheckInput) {
      const due = pending('tools', input);
      if (due === undefined) return;
      current(input.signal);
      const now = new Map((await sources.tools(token)).map(value => [value.tool_id, value]));
      current(input.signal);
      for (const released of due.releases()) {
        if (released.kind !== 'tool') continue;
        const value = now.get(released.tool_id);
        if (value === undefined || connectionOf(value) !== released.connection || (released.setup && value.organization_setup === null)) stale();
      }
      due.checked();
    },
  });

  /** What a check of `source` rereads: what it released since its last successful check (`incremental`), or everything. */
  function pending(source: WorkspaceSourceIdV1, input: CheckInput) {
    input.signal?.throwIfAborted();
    const ledger = ledgers[source];
    const ids = [...(input.mode === 'incremental' ? ledger.unchecked : ledger.released.keys())];
    return ids.length === 0 ? undefined : {
      releases: () => ids.map(id => ledger.released.get(id)!),
      checked: () => { for (const id of ids) ledger.unchecked.delete(id); },
    };
  }
  /** A local source's check: the session, the asker's grants and each released person's membership, read now. */
  function check(source: 'projects' | 'people', input: CheckInput): void {
    const due = pending(source, input);
    if (due === undefined) return;
    const grants = grantsOf(current(input.signal));
    const releases = due.releases();
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
    due.checked();
  }

  return Object.freeze({ projects, people, tools: toolsSource });
}
