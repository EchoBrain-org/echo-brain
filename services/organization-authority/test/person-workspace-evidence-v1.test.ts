import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { EvidenceDeskItemV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import { PEOPLE_SOURCE_DESCRIPTOR_V1, PROJECTS_SOURCE_DESCRIPTOR_V1, TOOLS_SOURCE_DESCRIPTOR_V1 } from '@echo-brain/organization-authority-kernel/shared/workspace-evidence-v1';
import { SqliteOpenItemPeopleV1 } from '../src/adapters/persistence/sqlite/open-item-people-v1.js';
import { SqlitePersonAgenticAskAuditV1 } from '../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { createPersonWorkspaceEvidenceSourcesV1, personWorkspaceGrantsV1 } from '../src/composition/person-workspace-evidence-v1.js';
import { MEMBER, OWNER, addMembership, authorization, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close(); });

const CLOUD = '00000000-0000-4000-8000-0000000000c1';
const ARI = OWNER;
const MINA = MEMBER;
const RAFAEL: AuthorityPersonMembershipBinding = { organization_id: OWNER.organization_id, principal_id: 'prn_rafael', membership_id: 'mem_44444444-4444-4444-8444-444444444444', membership_type: 'employee' };
const OKAFOR: AuthorityPersonMembershipBinding = { organization_id: OWNER.organization_id, principal_id: 'prn_okafor', membership_id: 'mem_55555555-5555-4555-8555-555555555555', membership_type: 'employee' };
const PEOPLE = { ari: ARI, mina: MINA, rafael: RAFAEL, okafor: OKAFOR } as const;
type Name = keyof typeof PEOPLE;
type Scope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string };

const RECEIPT = expect.stringMatching(/^sha256:[0-9a-f]{64}$/);
const STALE = expect.objectContaining({ code: 'stale_access_state' });
const INVALID = expect.objectContaining({ code: 'invalid_request' });
const NOT_FOUND = expect.objectContaining({ code: 'not_found' });
const person = (binding: AuthorityPersonMembershipBinding) => `person_${binding.membership_id}`;
const labels = (items: readonly EvidenceDeskItemV2[] | undefined) => (items ?? []).map(item => item.label);
function requestId(value: number): string { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }

/** A tool as the person tools list (V4) carries it: a linked tool names its site and account, nothing else does. */
function tool(tool_id: string, display_name: string, personal_status: OrganizationPersonToolV4['personal_status'], extra: Partial<OrganizationPersonToolV4> = {}): OrganizationPersonToolV4 {
  const linked = personal_status === 'linked';
  return { tool_id, display_name, availability: personal_status === 'unavailable' ? 'unavailable' : 'enabled', personal_status,
    external_scope_id: linked ? CLOUD : null, external_subject_id: linked ? `acct-${tool_id}-ari` : null, organization_setup: null, ...extra };
}

/**
 * Ari's organization over a real Authority database (the project context fixture and application). Ari leads Atlas, with
 * Mina Patel and Rafael Moreno; Beacon, with Mina Patel as a second lead; and the archived Comet. Ari is a member of Mina's
 * Echo. Mina's Delta, with S. Okafor, is not Ari's.
 */
function world() {
  const database = projectContextDatabase(); databases.push(database);
  const rename = database.prepare('UPDATE authority_principals SET display_name = ? WHERE principal_id = ?');
  rename.run('Ari', ARI.principal_id); rename.run('Mina Patel', MINA.principal_id);
  addMembership(database, RAFAEL, 'Rafael Moreno', 'rafael@example.test');
  addMembership(database, OKAFOR, 'S. Okafor', 'okafor@example.test');
  let now = '2026-10-01T09:00:00.000Z';
  const repository = new SqliteProjectContextRepositoryV1(database, () => now);
  const sessions = new Map<string, PersonAccessAuthorization>(Object.entries(PEOPLE).map(([name, binding]) => [name, authorization(binding)]));
  const session = (token: string): PersonAccessAuthorization => {
    const found = sessions.get(token);
    if (found === undefined) throw new AuthorityOperationError('unauthorized', 'person authentication failed');
    return found;
  };
  const application = createProjectContextApplicationV1({ authenticate: session, repository });
  let request = 0;
  const create = (by: Name, name: string, at: string) => {
    now = at;
    return application.createProject(by, { schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(++request), name }).project_id;
  };
  const set = (by: Name, project_id: string, who: Name, role: 'lead' | 'member') => application.setMember(by, {
    schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(++request), project_id, membership_id: PEOPLE[who].membership_id, role });
  const atlas = create('ari', 'Atlas', '2026-10-01T09:00:00.000Z'); set('ari', atlas, 'mina', 'member'); set('ari', atlas, 'rafael', 'member');
  const beacon = create('ari', 'Beacon', '2026-10-05T09:00:00.000Z'); set('ari', beacon, 'mina', 'lead');
  const comet = create('ari', 'Comet', '2026-10-09T09:00:00.000Z');
  application.archiveProject('ari', { schema_version: 1, kind: 'echo-project-archive-v1', request_id: requestId(++request), project_id: comet, archived: true });
  const echo = create('mina', 'Echo', '2026-10-12T09:00:00.000Z'); set('mina', echo, 'ari', 'member');
  const delta = create('mina', 'Delta', '2026-10-14T09:00:00.000Z'); set('mina', delta, 'okafor', 'member');
  now = '2026-10-19T09:00:00.000Z';

  const tools: Record<string, OrganizationPersonToolV4[]> = {
    ari: [tool('jira', 'Jira', 'linked'), tool('confluence', 'Confluence', 'unlinked'), tool('granola', 'Granola', 'revoked'),
      tool('slack', 'Slack', 'unavailable', { organization_setup: 'not_set_up' })],
    mina: [tool('jira', 'Jira', 'unlinked')],
  };

  /** One request's workspace release witness, as `name`. */
  const auditFor = (name: Name, request_id: string) => new SqlitePersonAgenticAskAuditV1(database).forWorkspaceRequest({ authority_id: 'authority', state_lineage_id: 'lineage',
    organization_id: PEOPLE[name].organization_id, principal_id: PEOPLE[name].principal_id, membership_id: PEOPLE[name].membership_id, session_family_id: 'session-fixture', request_id });
  /** One Ask's workspace sources for `name`, with the audit rows of its request. */
  const sources = (name: Name = 'ari', options: { readonly scope?: Scope } = {}) => {
    const request_id = `ask_${randomUUID()}`;
    const audit = auditFor(name, request_id);
    const workspace = createPersonWorkspaceEvidenceSourcesV1({
      sources: {
        projects: application, grants: personWorkspaceGrantsV1(repository), people: new SqliteOpenItemPeopleV1(database),
        tools: async (token: string) => tools[token] ?? [],
      },
      access_token: name, authenticate: () => session(name), scope: options.scope ?? { kind: 'global' }, audit,
    });
    const audits = () => (database.prepare("SELECT row_sha256, body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").all() as { row_sha256: string; body_json: string }[])
      .map(row => ({ row_sha256: row.row_sha256, body: JSON.parse(row.body_json) as Record<string, unknown> }))
      .filter(row => row.body.kind === 'echo-person-workspace-release-audit-v1' && row.body.request_id === request_id)
      .sort((left, right) => (left.body.release_sequence as number) - (right.body.release_sequence as number));
    return { ...workspace, audits };
  };
  return {
    database, application, sources, auditFor, tools, atlas, beacon, comet, echo, delta,
    set, create,
    /** Adds an organization member to a project, as Ari. */
    join: (project_id: string, binding: AuthorityPersonMembershipBinding) => application.setMember('ari', {
      schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(++request), project_id, membership_id: binding.membership_id, role: 'member' }),
    leave: (who: Name, project_id: string) => application.leaveProject(who, { schema_version: 1, kind: 'echo-project-leave-v1', request_id: requestId(++request), project_id }),
    /** A person's session now belongs to another membership. */
    move: (who: Name, to: AuthorityPersonMembershipBinding) => { sessions.set(who, authorization(to)); },
    /** More people in the organization, in no project. */
    hire: (count: number) => Array.from({ length: count }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      const binding: AuthorityPersonMembershipBinding = { organization_id: OWNER.organization_id, principal_id: `prn_hire_${index}`, membership_id: `mem_66666666-6666-4666-8666-${suffix}`, membership_type: 'employee' };
      addMembership(database, binding, `Zed Hire ${String(index + 1).padStart(2, '0')}`, `hire-${index + 1}@example.test`);
      return binding;
    }),
  };
}

describe('workspace projects as an Ask source (research tool contract v1)', () => {
  it("lists the asker's projects newest first, each with its status, the asker's role and its leads, and releases its members beside it", async () => {
    const w = world();
    const { projects } = w.sources();
    const result = await projects.list({ source: 'projects' });
    expect(labels(result.items)).toEqual(['Echo', 'Comet', 'Beacon', 'Atlas']);
    expect(result.items.map(item => item.attributes)).toEqual([
      { status: 'active', role: 'member', leads: 'Mina Patel' },
      { status: 'archived', role: 'lead', leads: 'Ari' },
      { status: 'active', role: 'lead', leads: 'Ari, Mina Patel' },
      { status: 'active', role: 'lead', leads: 'Ari' },
    ]);
    const atlas = result.items[3]!;
    expect(atlas).toEqual({
      id: `project_${w.atlas}`, kind: 'project', citation: { kind: 'project', project_id: w.atlas }, ref: `project:${w.atlas}`,
      label: 'Atlas', attributes: { status: 'active', role: 'lead', leads: 'Ari' }, dates: { created: '2026-10-01T09:00:00.000Z' },
      text: 'Members: Ari (lead), Mina Patel (member), Rafael Moreno (member)',
      links: { members: [person(ARI), person(MINA), person(RAFAEL)] }, visibility: 'project', receipt_sha256: RECEIPT,
    });
    expect(result.items[2]!.text).toBe('Members: Ari (lead), Mina Patel (lead)');
    // Each member once, released beside the page, without links of their own.
    expect(labels(result.linked)).toEqual(['Ari', 'Mina Patel', 'Rafael Moreno']);
    expect(result.linked!.find(item => item.label === 'Rafael Moreno')).toEqual({
      id: person(RAFAEL), kind: 'person', citation: { kind: 'person', membership_id: RAFAEL.membership_id },
      label: 'Rafael Moreno', text: 'Projects shared with you: Atlas (member)', visibility: 'project', receipt_sha256: atlas.receipt_sha256,
    });
    expect(result).toMatchObject({ truncated: false, page_full: false });
    expect(result.next_cursor).toBeUndefined();
    // Nothing of Delta, which is not Ari's.
    expect(JSON.stringify(result)).not.toMatch(/Delta|Okafor/);
  });

  it('filters by status and by the asker\'s role before anything is released', async () => {
    const w = world();
    const { projects, audits } = w.sources();
    expect(labels((await projects.list({ source: 'projects', status: 'archived' })).items)).toEqual(['Comet']);
    expect(labels((await projects.list({ source: 'projects', status: 'active' })).items)).toEqual(['Echo', 'Beacon', 'Atlas']);
    expect(labels((await projects.list({ source: 'projects', role: 'member' })).items)).toEqual(['Echo']);
    const leads = await projects.list({ source: 'projects', status: 'active', role: 'lead' });
    expect(labels(leads.items)).toEqual(['Beacon', 'Atlas']);
    expect(labels(leads.linked)).toEqual(['Ari', 'Mina Patel', 'Rafael Moreno']);
    expect((audits().at(-1)!.body.items as { item_id: string }[]).map(item => item.item_id)).toEqual([w.beacon, w.atlas, ARI.membership_id, MINA.membership_id, RAFAEL.membership_id]);
  });

  it('matches a window against when each project was created, in the asker\'s time zone, and refuses any other date or filter', async () => {
    const w = world();
    const { projects } = w.sources();
    const window = { since: '2026-10-05', until: '2026-10-09' };
    expect(labels((await projects.list({ source: 'projects', ...window })).items)).toEqual(['Comet', 'Beacon']);
    expect(labels((await projects.list({ source: 'projects', ...window, date_field: 'created' })).items)).toEqual(['Comet', 'Beacon']);
    expect(labels((await projects.list({ source: 'projects', since: '2026-10-10', date_field: 'any' })).items)).toEqual(['Echo']);
    // Atlas was created at 09:00 UTC on 1 October, which is still 30 September in Pago Pago.
    expect(labels((await projects.list({ source: 'projects', since: '2026-10-01', until: '2026-10-01' })).items)).toEqual(['Atlas']);
    expect((await projects.list({ source: 'projects', since: '2026-10-01', until: '2026-10-01', time_zone: 'Pacific/Pago_Pago' })).items).toEqual([]);
    expect(labels((await projects.search({ query: 'Atlas Beacon', since: '2026-10-02' })).items)).toEqual(['Beacon']);
    for (const refused of [{ since: '2026-10-01', date_field: 'occurred' as const }, { until: '2026-10-01', date_field: 'due' as const }, { owner: 'Ari' },
      { kinds: ['decision' as const] }, { status: 'open' as const }, { since: '2026-10-09', until: '2026-10-05' }]) {
      await expect(projects.list({ source: 'projects', ...refused })).rejects.toThrow(INVALID);
    }
    await expect(projects.search({ query: 'Atlas', since: '2026-10-01', date_field: 'approved' })).rejects.toThrow(INVALID);
  });

  it('pages with a cursor bound to its selection', async () => {
    const w = world();
    const { projects, people } = w.sources();
    const first = await projects.list({ source: 'projects', limit: 2 });
    expect(labels(first.items)).toEqual(['Echo', 'Comet']);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await projects.list({ source: 'projects', limit: 2, cursor: first.next_cursor! });
    expect(labels(second.items)).toEqual(['Beacon', 'Atlas']);
    expect(second.next_cursor).toBeUndefined();
    // Echo is first in both lists; a cursor after it still belongs to the list it came from.
    const one = await projects.list({ source: 'projects', limit: 1 });
    expect(labels(one.items)).toEqual(['Echo']);
    await expect(projects.list({ source: 'projects', limit: 1, role: 'member', cursor: one.next_cursor! })).rejects.toThrow(INVALID);
    await expect(projects.list({ source: 'projects', cursor: 'projects_99' })).rejects.toThrow(INVALID);
    await expect(people.list({ source: 'people', cursor: one.next_cursor! })).rejects.toThrow(INVALID);
    for (const limit of [0, 51, 1.5]) await expect(projects.list({ source: 'projects', limit })).rejects.toThrow(INVALID);
  });

  it('finds projects by the words of their names and their members\' names, best match first, and never one the asker is not in', async () => {
    const w = world();
    const { projects } = w.sources();
    expect(labels((await projects.search({ query: 'atlas' })).items)).toEqual(['Atlas']);
    expect(labels((await projects.search({ query: 'Rafael' })).items)).toEqual(['Atlas']);
    expect(labels((await projects.search({ query: 'Mina Beacon' })).items)).toEqual(['Beacon', 'Echo', 'Atlas']);
    // Equal matches: active projects first, newest first.
    const cut = await projects.search({ query: 'Ari', limit: 2 });
    expect(labels(cut.items)).toEqual(['Echo', 'Beacon']);
    expect(cut.truncated).toBe(true);
    for (const query of ['Delta', 'Okafor', 'Atla', 'the of']) expect((await projects.search({ query })).items).toEqual([]);
  });

  it("advertises the projects descriptor with how many projects the asker can see, and the other two as they are", () => {
    const w = world();
    const ari = w.sources('ari');
    expect(ari.projects.descriptor).toEqual({ ...PROJECTS_SOURCE_DESCRIPTOR_V1, capabilities: { ...PROJECTS_SOURCE_DESCRIPTOR_V1.capabilities, count: 4 } });
    expect(ari.people.descriptor).toEqual(PEOPLE_SOURCE_DESCRIPTOR_V1);
    expect(ari.tools.descriptor).toEqual(TOOLS_SOURCE_DESCRIPTOR_V1);
    expect(w.sources('okafor').projects.descriptor.capabilities.count).toBe(1);
    expect(w.sources('ari', { scope: { kind: 'project', project_id: w.atlas } }).projects.descriptor.capabilities.count).toBe(1);
    expect(w.sources('ari', { scope: { kind: 'project', project_id: w.delta } }).projects.descriptor.capabilities.count).toBe(0);
  });

  it("opens a released project with every member linked, and a member released beside it through the people source", async () => {
    const w = world();
    const { projects, people } = w.sources();
    await expect(projects.open({ item: `project_${w.atlas}` })).rejects.toThrow(NOT_FOUND);
    const found = await projects.search({ query: 'Atlas' });
    const opened = await projects.open({ item: found.items[0]!.id });
    expect(opened.items).toEqual([{ ...found.items[0], receipt_sha256: opened.receipt_digests[0] }]);
    expect(labels(opened.linked)).toEqual(['Ari', 'Mina Patel', 'Rafael Moreno']);
    const rafael = await people.open({ item: person(RAFAEL) });
    expect(rafael.items).toEqual([{
      id: person(RAFAEL), kind: 'person', citation: { kind: 'person', membership_id: RAFAEL.membership_id }, label: 'Rafael Moreno',
      text: 'Projects shared with you: Atlas (member)', links: { projects: [`project_${w.atlas}`] }, visibility: 'project', receipt_sha256: rafael.receipt_digests[0],
    }]);
    expect(labels(rafael.linked)).toEqual(['Atlas']);
    expect(rafael.linked![0]!.links).toBeUndefined();
    // Each source opens only its own kind, and only what this request released.
    await expect(projects.open({ item: person(RAFAEL) })).rejects.toThrow(NOT_FOUND);
    await expect(people.open({ item: person(OKAFOR) })).rejects.toThrow(NOT_FOUND);
  });

  it('names at most fifty members of a project, releases at most a hundred people beside one result, and links only people it released', async () => {
    const w = world();
    const hires = w.hire(177);
    // North, South and West each have Ari and 59 people of their own.
    for (const [index, name] of ['North', 'South', 'West'].entries()) {
      const id = w.create('ari', name, `2026-10-1${5 + index}T09:00:00.000Z`);
      for (const hire of hires.slice(index * 59, index * 59 + 59)) w.join(id, hire);
    }
    const { projects } = w.sources();
    const result = await projects.list({ source: 'projects' });
    expect(labels(result.items)).toEqual(['West', 'South', 'North', 'Echo', 'Comet', 'Beacon', 'Atlas']);
    const north = result.items[2]!;
    expect(north.text!.split('\n')[0]).toMatch(/^Members: Ari \(lead\), .+, and 10 more$/);
    expect(result.linked).toHaveLength(100);
    const released = new Set([...result.items, ...result.linked!].map(item => item.id));
    for (const item of result.items) for (const id of item.links!.members!) expect(released.has(id)).toBe(true);
    // West and South fill the hundred, so North links only what was released beside the page.
    expect(north.links!.members).toEqual([person(ARI), `person_${hires[0]!.membership_id}`]);
    // Opened on its own, North links every member it names.
    const opened = await projects.open({ item: north.id });
    expect(opened.items[0]!.links!.members).toHaveLength(50);
    expect(opened.linked).toHaveLength(50);
  });

  it("reads only the Ask's project in a project scope", async () => {
    const w = world();
    const { projects, people } = w.sources('ari', { scope: { kind: 'project', project_id: w.atlas } });
    expect(labels((await projects.list({ source: 'projects' })).items)).toEqual(['Atlas']);
    expect((await projects.search({ query: 'Beacon' })).items).toEqual([]);
    const members = await people.list({ source: 'people' });
    expect(members.items.map(item => [item.label, item.text, item.links])).toEqual([
      ['Ari', 'This is you.\nYour projects: Atlas (lead)', { projects: [`project_${w.atlas}`] }],
      ['Mina Patel', 'Projects shared with you: Atlas (member)', { projects: [`project_${w.atlas}`] }],
      ['Rafael Moreno', 'Projects shared with you: Atlas (member)', { projects: [`project_${w.atlas}`] }],
    ]);
    expect((await people.search({ query: 'Okafor' })).items).toEqual([]);
  });
});

describe('workspace people and tools as Ask sources (research tool contract v1)', () => {
  it("lists the organization's people by name, each with the projects they share with the asker and their role in each", async () => {
    const w = world();
    const { people } = w.sources();
    const result = await people.list({ source: 'people' });
    expect(labels(result.items)).toEqual(['Ari', 'Mina Patel', 'Rafael Moreno', 'S. Okafor']);
    const project = (id: string) => `project_${id}`;
    expect(result.items.map(item => [item.text, item.visibility, item.links])).toEqual([
      ['This is you.\nYour projects: Echo (member), Comet (lead), Beacon (lead), Atlas (lead)', 'projects', { projects: [project(w.echo), project(w.comet), project(w.beacon), project(w.atlas)] }],
      ['Projects shared with you: Echo (lead), Beacon (lead), Atlas (member)', 'projects', { projects: [project(w.echo), project(w.beacon), project(w.atlas)] }],
      ['Projects shared with you: Atlas (member)', 'project', { projects: [project(w.atlas)] }],
      ['Shares no project with you.', 'team', { projects: [] }],
    ]);
    expect(result.items[3]).toEqual({
      id: person(OKAFOR), kind: 'person', citation: { kind: 'person', membership_id: OKAFOR.membership_id }, label: 'S. Okafor',
      text: 'Shares no project with you.', links: { projects: [] }, visibility: 'team', receipt_sha256: RECEIPT,
    });
    expect(labels(result.linked)).toEqual(['Echo', 'Comet', 'Beacon', 'Atlas']);
    expect(result.linked!.every(item => item.kind === 'project' && item.links === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Delta');
  });

  it('pages the whole directory, each person once', async () => {
    const w = world();
    w.hire(21);
    const { people } = w.sources();
    const first = await people.list({ source: 'people' });
    expect(first.items).toHaveLength(20);
    const second = await people.list({ source: 'people', cursor: first.next_cursor! });
    expect(second.next_cursor).toBeUndefined();
    const names = labels([...first.items, ...second.items]);
    expect(names).toHaveLength(25);
    expect(new Set(names).size).toBe(25);
    expect(names.slice(0, 4)).toEqual(['Ari', 'Mina Patel', 'Rafael Moreno', 'S. Okafor']);
    expect(names.at(-1)).toBe('Zed Hire 21');
  });

  it('finds people by whole words of their names only', async () => {
    const w = world();
    const { people } = w.sources();
    expect(labels((await people.search({ query: 'patel' })).items)).toEqual(['Mina Patel']);
    expect(labels((await people.search({ query: 'Rafael Mina' })).items)).toEqual(['Mina Patel', 'Rafael Moreno']);
    for (const query of ['Atlas', 'Raf', 'member']) expect((await people.search({ query })).items).toEqual([]);
  });

  it("lists the asker's tools and whether they connected each, never a tool's site or account", async () => {
    const w = world();
    const { tools } = w.sources();
    const result = await tools.list({ source: 'tools' });
    const entry = (tool_id: string, label: string, status: string, text: string) => ({
      id: `tool_${tool_id}`, kind: 'tool', citation: { kind: 'tool', tool_id }, ref: `tool:${tool_id}`, label, attributes: { status }, text,
      visibility: 'only_me', receipt_sha256: RECEIPT,
    });
    expect(result.items).toEqual([
      entry('jira', 'Jira', 'connected', 'You have connected Jira to ECHO.'),
      entry('confluence', 'Confluence', 'not connected', 'You have not connected Confluence to ECHO. You can connect it on the Tools page.'),
      entry('granola', 'Granola', 'connection revoked', 'Your Granola connection was revoked. You can connect it again on the Tools page.'),
      entry('slack', 'Slack', 'not available', 'Slack is not available in this organization.\nOrganization setup: not set up'),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/acct-|00000000-0000-4000-8000-0000000000c1/);
    expect(labels((await tools.search({ query: 'confluence' })).items)).toEqual(['Confluence']);
    expect((await tools.search({ query: 'connected' })).items).toEqual([]);
    const opened = await tools.open({ item: 'tool_slack' });
    expect(labels(opened.items)).toEqual(['Slack']);
  });

  it('refuses the filters and dates people and tools do not have', async () => {
    const w = world();
    const { people, tools } = w.sources();
    for (const refused of [{ status: 'active' as const }, { role: 'lead' as const }, { owner: 'Ari' }, { since: '2026-10-01' }, { date_field: 'created' as const }, { kinds: ['project' as const] }]) {
      await expect(people.list({ source: 'people', ...refused })).rejects.toThrow(INVALID);
      await expect(tools.list({ source: 'tools', ...refused })).rejects.toThrow(INVALID);
    }
    await expect(people.search({ query: 'Mina', until: '2026-10-01' })).rejects.toThrow(INVALID);
    await expect(tools.search({ query: 'Jira', since: '2026-10-01' })).rejects.toThrow(INVALID);
  });
});

describe('workspace sources: checks and audit (research tool contract v1, ADR-0038)', () => {
  it('rechecks only what is new before a model call and everything at release, and refuses a project the asker left', async () => {
    const w = world();
    const { projects } = w.sources();
    projects.revalidate({ mode: 'full' });
    await projects.search({ query: 'Echo' });
    projects.revalidate({ mode: 'incremental' });
    w.leave('ari', w.echo);
    // Nothing was released since the last check.
    projects.revalidate({ mode: 'incremental' });
    expect(() => projects.revalidate({ mode: 'full' })).toThrow(STALE);
    expect(() => projects.revalidate({})).toThrow(STALE);
  });

  it("refuses a released project once the asker's membership in it changed, though they rejoined, but not when only their role changed", async () => {
    const w = world();
    const { projects } = w.sources();
    await projects.search({ query: 'Echo' });
    w.set('mina', w.echo, 'ari', 'lead');
    projects.revalidate({ mode: 'full' });
    w.set('mina', w.echo, 'ari', 'member');
    w.leave('ari', w.echo);
    w.set('mina', w.echo, 'ari', 'member');
    expect(() => projects.revalidate({ mode: 'full' })).toThrow(STALE);
  });

  it('refuses a released person who left the organization, and a person whose release named a project the asker has since left', async () => {
    const w = world();
    const { people } = w.sources();
    await people.search({ query: 'Rafael' });
    people.revalidate({ mode: 'full' });
    revokeMembership(w.database, RAFAEL);
    expect(() => people.revalidate({ mode: 'full' })).toThrow(STALE);

    const again = world();
    const fresh = again.sources();
    await fresh.people.search({ query: 'Mina' });
    again.leave('ari', again.echo);
    expect(() => fresh.people.revalidate({ mode: 'full' })).toThrow(STALE);
  });

  it('refuses the people a project released beside it, at the projects check', async () => {
    const w = world();
    const { projects } = w.sources();
    await projects.search({ query: 'Atlas' });
    revokeMembership(w.database, RAFAEL);
    expect(() => projects.revalidate({ mode: 'incremental' })).toThrow(STALE);
  });

  it('refuses a released tool whose connection changed, and never one it did not release', async () => {
    const w = world();
    const { tools } = w.sources();
    await tools.search({ query: 'Jira' });
    w.tools.ari![1] = tool('confluence', 'Confluence', 'linked');
    await tools.revalidate({ mode: 'incremental' });
    await tools.revalidate({ mode: 'full' });
    w.tools.ari![0] = { ...tool('jira', 'Jira', 'linked'), external_subject_id: 'acct-someone-else' };
    await expect(tools.revalidate({ mode: 'full' })).rejects.toThrow(STALE);
    w.tools.ari![0] = tool('jira', 'Jira', 'revoked');
    await expect(tools.revalidate({ mode: 'full' })).rejects.toThrow(STALE);
    // A release since the last successful check is checked before the next model call.
    await tools.search({ query: 'Granola' });
    w.tools.ari![2] = tool('granola', 'Granola', 'linked');
    await expect(tools.revalidate({ mode: 'incremental' })).rejects.toThrow(STALE);
  });

  it("refuses a tool released with its organization setup once the asker no longer sees that setup", async () => {
    const w = world();
    const { tools } = w.sources();
    await tools.search({ query: 'Slack' });
    w.tools.ari![3] = tool('slack', 'Slack', 'unavailable');
    await expect(tools.revalidate({ mode: 'full' })).rejects.toThrow(STALE);
  });

  it('refuses every call and check once the session is another membership', async () => {
    const w = world();
    const { projects, people, tools } = w.sources();
    await projects.search({ query: 'Atlas' });
    await tools.search({ query: 'Jira' });
    w.move('ari', MINA);
    await expect(people.list({ source: 'people' })).rejects.toThrow(STALE);
    // Even a search with no words to match, which releases nothing.
    for (const source of [projects, people, tools]) await expect(source.search({ query: 'the of' })).rejects.toThrow(STALE);
    expect(() => projects.revalidate({ mode: 'full' })).toThrow(STALE);
    await expect(tools.revalidate({ mode: 'full' })).rejects.toThrow(STALE);
  });

  it('audits every release before it leaves, with ids and digests only', async () => {
    const w = world();
    const { projects, tools, audits } = w.sources();
    const found = await projects.search({ query: 'Atlas' });
    const none = await projects.search({ query: 'Zeppelin' });
    await tools.list({ source: 'tools' });
    const rows = audits();
    expect(rows.map(row => [row.body.source, row.body.operation])).toEqual([['projects', 'search'], ['projects', 'search'], ['tools', 'list']]);
    const digest = expect.stringMatching(/^sha256:[0-9a-f]{64}$/);
    expect(rows[0]!.body.items).toEqual([
      { kind: 'project', item_id: w.atlas, linked: false, released_fields_sha256: digest },
      { kind: 'person', item_id: ARI.membership_id, linked: true, released_fields_sha256: digest },
      { kind: 'person', item_id: MINA.membership_id, linked: true, released_fields_sha256: digest },
      { kind: 'person', item_id: RAFAEL.membership_id, linked: true, released_fields_sha256: digest },
    ]);
    expect(rows[1]!.body.items).toEqual([]);
    expect(found.receipt_digests).toEqual([rows[0]!.row_sha256]);
    expect(none.receipt_digests).toEqual([rows[1]!.row_sha256]);
    expect([...found.items, ...found.linked!].every(item => item.receipt_sha256 === rows[0]!.row_sha256)).toBe(true);
    const bodies = JSON.stringify(rows.map(row => row.body));
    for (const word of ['Atlas', 'Ari', 'Mina', 'Rafael', 'ATL', 'Members', 'Jira', 'connected', 'acct-']) expect(bodies).not.toContain(word);
  });

  it('refuses an audit of anything but workspace items by their ids', () => {
    const w = world();
    const audit = w.auditFor('ari', 'ask_audit');
    const digest = `sha256:${'a'.repeat(64)}` as const;
    for (const release of [
      { source: 'projects', operation: 'list', items: [{ kind: 'project', item_id: 'Atlas', linked: false, released_fields_sha256: digest }] },
      { source: 'people', operation: 'search', items: [{ kind: 'person', item_id: 'Mina Patel', linked: false, released_fields_sha256: digest }] },
      { source: 'tools', operation: 'list', items: [{ kind: 'tool', item_id: 'Jira', linked: false, released_fields_sha256: digest }] },
      { source: 'projects', operation: 'list', items: [{ kind: 'project', item_id: w.atlas, linked: false, released_fields_sha256: 'Atlas' }] },
      { source: 'projects', operation: 'list', items: [
        { kind: 'project', item_id: w.atlas, linked: false, released_fields_sha256: digest }, { kind: 'project', item_id: w.atlas, linked: true, released_fields_sha256: digest }] },
      { source: 'projects', operation: 'write', items: [] },
      { source: 'documents', operation: 'list', items: [] },
    ]) expect(() => audit.record(release as never)).toThrow('Workspace release audit is invalid');
    expect(audit.record({ source: 'projects', operation: 'list', items: [] })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
