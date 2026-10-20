import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../src/shared/protocol.js';
import { cover, flush, Held, keysetPage, moved, names, numbered, ok, ordered, project, rpcFor, show, startStore, storeLifecycle, uncover } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const apollo = project(1, 30, { name: 'Apollo' });
let membership: string;
let active: ProjectSummary[];
let archived: ProjectSummary[];
let jira: string;
let spaces: string[];
let held: Held;
/** Calls to `projects.list` for the active list, in order. */
const activeLists = () => rpc.mock.calls.filter(([method, params]) => method === 'projects.list' && (params as { status?: string }).status !== 'archived');

storeLifecycle();
beforeEach(() => {
  membership = 'member';
  active = [apollo];
  archived = [];
  jira = 'CURRENT';
  spaces = ['one', 'two'];
  held = new Held();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: membership, display_name: 'Fixture', role: 'employee' } }),
    'account.tools': () => ok({ tools: [{ tool_id: 'jira', status: 'linked' }, { tool_id: 'confluence', status: 'linked' }] }),
    'projects.jiraRead': () => ok({ revision: 'jira-1', mapping: { project_key: jira } }),
    'projects.confluenceRead': () => ok({ revision: 'confluence-1', mapping: { space_ids: [...spaces] } }),
    'projects.confluenceSpaces': () => ok({ items: spaces.map(id => ({ id, name: id, key: id })), next_cursor: null }),
    'projects.jiraSet': params => { jira = params.jira_project as string; return ok({ revision: 'jira-2', mapping: { project_key: jira } }); },
  }, () => ({ active, archived })));
});

describe('project tool-read replies', () => {
  it('ignores the earlier opening of the same project, for tools and both mappings', async () => {
    const store = await startStore();
    const tools = held.hold('account.tools');
    const jiraReply = held.hold('projects.jiraRead');
    const confluence = held.hold('projects.confluenceRead');
    await store.openProject(apollo);
    await store.openProject(apollo);
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'CURRENT', confluence: 2 });
    tools(ok({ tools: [] }));
    jiraReply(ok({ mapping: { project_key: 'OLD' } }));
    confluence(ok({ mapping: { space_ids: ['old'] } }));
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'CURRENT', confluence: 2 });
  });

  it('ignores the earlier opening while the later one still has its fields unknown', async () => {
    const store = await startStore();
    const first = ['account.tools', 'projects.jiraRead', 'projects.confluenceRead'].map(method => held.hold(method));
    await store.openProject(apollo);
    const second = ['account.tools', 'projects.jiraRead', 'projects.confluenceRead'].map(method => held.hold(method));
    await store.openProject(apollo);
    first[0]!(ok({ tools: [] }));
    first[1]!(ok({ revision: 'r', mapping: { project_key: 'OLD' } }));
    first[2]!(ok({ revision: 'r', mapping: { space_ids: ['9'] } }));
    await flush();
    expect(store.getState().projectReads).toEqual({ project_id: apollo.project_id, seq: expect.any(Number) });
    second[1]!(ok({ revision: 'r', mapping: { project_key: 'NEW' } }));
    await flush();
    expect(store.getState().projectReads).toMatchObject({ jira: 'NEW' });
    second[0]!(ok({ tools: [] }));
    second[2]!(ok({ revision: 'r', mapping: null }));
  });

  it('forgets project reads when the account changes and drops the old replies', async () => {
    const store = await startStore();
    const jiraReply = held.hold('projects.jiraRead');
    await store.openProject(apollo);
    membership = 'someone-else';
    await store.refreshStatus();
    await flush();
    expect(store.getState().projectReads).toBeNull();
    jiraReply(ok({ mapping: { project_key: 'PRIVATE' } }));
    await flush();
    expect(store.getState().projectReads).toBeNull();
  });

  it('lets still-unknown tool fields finish after Save without replacing the saved field', async () => {
    const store = await startStore();
    const initialTools = held.hold('account.tools');
    const initialJira = held.hold('projects.jiraRead');
    const initialConfluence = held.hold('projects.confluenceRead');
    await store.openProject(apollo);
    const sheetTools = held.hold('account.tools');
    const sheetConfluence = held.hold('projects.confluenceRead');
    store.openProjectTools(apollo);
    await flush();
    store.setProjectJira('SAVED');
    await store.saveProjectTools();
    initialTools(ok({ tools: [{ tool_id: 'jira', status: 'linked' }] }));
    initialJira(ok({ mapping: { project_key: 'OLD' } }));
    initialConfluence(ok({ mapping: { space_ids: ['one', 'two'] } }));
    sheetTools(ok({ tools: [] }));
    sheetConfluence(ok({ mapping: null }));
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'SAVED', confluence: 2 });
  });

  it('shows what the Authority has after a reload of a setting whose save was not confirmed', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    store.openProjectTools(apollo);
    await flush();
    store.setProjectJira('NEW');
    held.hold('projects.jiraSet')({ ok: false, failure: { code: 'timeout', retryable: true, mutation_outcome: 'unknown' } });
    jira = 'NEW';
    await store.saveProjectTools();
    expect(store.getState().projectSettings?.jira?.status).toBe('failed');
    store.reloadProjectTool('jira');
    await flush();
    store.cancelProjectSettingsAction();
    expect(store.getState().projectReads?.jira).toBe('NEW');
  });
});

/**
 * The window came forward, and the change check says your projects moved
 * (here, a list changed elsewhere moves them by itself, and `moved` moves them
 * by hand): the sidebar reads again as many pages as it shows, so what it
 * shows is what the Authority has now, in its order (creation time, newest
 * first; then project ID), and More goes on from the last row read.
 */
describe('project lists on foreground refresh', () => {
  /** Made after every numbered project. */
  const created = (name: string) => project(900, 30, { name, project_id: `prj_${name.toLowerCase().padEnd(8, '0')}-1111-4111-8111-111111111111`, created_at: '2026-10-01T00:00:00.000Z' });
  /** Three projects, and the window come forward with them moved: the refresh's list read is held. */
  async function refreshing() {
    active = numbered(3);
    const store = await startStore();
    const stale = held.hold('projects.list');
    moved.projects += 1;
    const done = show(store);
    await flush();
    return { store, stale, done };
  }

  it.each(['shown', 'resume'] as const)('with one page shown, a new project leads it and the displaced row waits behind More (%s)', async event => {
    active = numbered(13);
    const store = await startStore();
    await store.openProject(active[2]!);
    const before = activeLists().length;
    active = [created('New'), ...active];
    if (event === 'shown') await show(store);
    else { cover(store); uncover(store); await flush(); }
    expect(names(store.getState().projects.items)).toEqual(['New', ...names(numbered(9))]);
    // The change check's full read of every page (14 rows: two), which tells what you were added to, fills the sidebar's one page.
    expect(activeLists().length - before).toBe(2);
    expect(store.getState().route.page).toBe('project');
    await store.loadProjects(true);
    expect(names(store.getState().projects.items)).toEqual(['New', ...names(numbered(13))]);
    expect(store.getState().projects.next).toBeNull();
  });

  it('with one page shown, a row archived elsewhere leaves the active list and shows only under Archived', async () => {
    active = numbered(13);
    const store = await startStore();
    const tenth = active[9]!;
    archived = [{ ...tenth, status: 'archived' }];
    active = [created('New'), ...active.filter(row => row !== tenth)];
    await show(store);
    expect(names(store.getState().projects.items)).not.toContain('Project 10');
    expect(names(store.getState().archivedProjects.items)).toEqual(['Project 10']);
    await store.loadProjects(true);
    expect(names(store.getState().projects.items)).toEqual(['New', ...names(numbered(13)).filter(name => name !== 'Project 10')]);
  });

  it('with two pages shown, both are read again: the new project leads, the last row waits behind More', async () => {
    active = numbered(22);
    const store = await startStore();
    await store.loadProjects(true);
    expect(store.getState().projects.items).toHaveLength(20);
    await store.openProject(active[12]!);
    const before = activeLists().length;
    active = [created('New'), ...active];
    await show(store);
    expect(names(store.getState().projects.items)).toEqual(['New', ...names(numbered(19))]);
    // The full read of every page (23 rows: three), which fills the sidebar's two.
    expect(activeLists().length - before).toBe(3);
    expect(store.getState().route.page).toBe('project');
    await store.loadProjects(true);
    expect(names(store.getState().projects.items)).toEqual(['New', ...names(numbered(22))]);
    expect(store.getState().projects.next).toBeNull();
  });

  it.each([
    ['with two pages shown, rows archived elsewhere on the second page are dropped and the pages close up', 22,
      (rows: ProjectSummary[]) => { archived = rows.slice(10, 19).map(row => ({ ...row, status: 'archived' as const })); return [...rows.slice(0, 10), ...rows.slice(19)]; }],
    // Made at noon on the 16th: after Project 14 (the 17th), before Project 15 (midnight on the 16th).
    ['shows an older project you were added to, at its place inside the pages shown', 22,
      (rows: ProjectSummary[]) => [...rows, { ...project(500, 16, { name: 'Joined' }), created_at: '2026-09-16T12:00:00.000Z' }]],
    ['shows a row renamed elsewhere by its new name', 13, (rows: ProjectSummary[]) => rows.map(row => row.name === 'Project 12' ? { ...row, name: 'Project 12, renamed' } : row)],
    ['with everything shown, a new project joins the whole list', 13, (rows: ProjectSummary[]) => [created('New'), ...rows]],
  ])('%s', async (_, count, change) => {
    active = numbered(count);
    const store = await startStore();
    await store.loadProjects(true);
    active = change(active);
    await show(store);
    // What shows is what the Authority has, in its order, as far as the two pages shown reach; More goes on from there.
    const shown = Math.min(20, active.length);
    expect(names(store.getState().projects.items)).toEqual(names(ordered(active)).slice(0, shown));
    expect(store.getState().projects.next === null).toBe(active.length <= 20);
    expect(names(store.getState().archivedProjects.items)).toEqual(names(ordered(archived)));
  });

  it('breaks equal creation times by project ID, as the Authority does', async () => {
    active = numbered(22).map(row => ({ ...row, created_at: '2026-09-01T00:00:00.000Z' }));
    const store = await startStore();
    await store.loadProjects(true);
    active = [{ ...project(0, 1, { name: 'New' }), project_id: 'prj_00000000-0000-4000-8000-000000000000' }, ...active];
    await show(store);
    expect(names(store.getState().projects.items)).toEqual(['New', ...names(numbered(19))]);
  });

  it('a project made while the refresh was on its way stays in the sidebar', async () => {
    const { store, stale, done } = await refreshing();
    const fresh = created('Fresh');
    rpc.mockImplementation(rpcFor(held, {
      'projects.create': () => ok({ project_id: fresh.project_id }),
      'projects.read': () => ok(fresh),
    }, () => ({ active, archived })));
    store.openNewProject();
    store.setNewProjectName('Fresh');
    await store.createProject();
    await flush();
    expect(names(store.getState().projects.items)).toContain('Fresh');
    active = [fresh, ...active];
    stale(ok(keysetPage(numbered(3), undefined)));
    await done;
    await flush();
    expect(names(store.getState().projects.items)).toEqual(['Fresh', ...names(numbered(3))]);
  });

  it('a project left while the refresh was on its way stays gone', async () => {
    const { store, stale, done } = await refreshing();
    rpc.mockImplementation(rpcFor(held, { 'projects.leave': () => ok({}) }, () => ({ active, archived })));
    store.toggleProjectSettings(active[0]!, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    await flush();
    expect(names(store.getState().projects.items)).toEqual(['Project 2', 'Project 3']);
    const snapshot = keysetPage(active, undefined);
    active = active.slice(1);
    stale(ok(snapshot));
    await done;
    await flush();
    expect(names(store.getState().projects.items)).toEqual(['Project 2', 'Project 3']);
  });

  it('waits for a More on its way, then reads again over the pages it loaded', async () => {
    active = numbered(25);
    const store = await startStore();
    const more = held.hold('projects.list');
    const loading = store.loadProjects(true);
    await flush();
    active = [created('New'), ...active];
    await show(store);
    more(ok(keysetPage(numbered(25), `${numbered(25)[9]!.created_at}|${numbered(25)[9]!.project_id}`)));
    await loading;
    await flush();
    const shown = names(store.getState().projects.items);
    expect(shown).toEqual(['New', ...names(numbered(19))]);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('keeps the archived pages that were loaded', async () => {
    active = numbered(3);
    archived = numbered(15).map(row => ({ ...row, project_id: row.project_id.replace('prj_', 'prj_a'), name: `Archived ${row.name}`, status: 'archived' }));
    const store = await startStore();
    await store.loadArchivedProjects(true);
    expect(store.getState().archivedProjects.items).toHaveLength(15);
    moved.projects += 1;
    await show(store);
    await flush();
    expect(store.getState().archivedProjects.items).toHaveLength(15);
  });

  it('drops the reply for an account that changed meanwhile', async () => {
    const { store, stale, done } = await refreshing();
    membership = 'someone-else';
    active = [];
    await store.refreshStatus();
    await flush();
    stale(ok(keysetPage(numbered(3), undefined)));
    await done;
    await flush();
    expect(store.getState().projects).toMatchObject({ items: [], loading: false });
  });

  it('keeps what is shown when the refresh cannot reach ECHO, and shows the list once it can', async () => {
    active = numbered(3);
    const store = await startStore();
    held.hold('projects.list')({ ok: false, failure: { code: 'transport_failed', retryable: true } });
    moved.projects += 1;
    await show(store);
    expect(names(store.getState().projects.items)).toEqual(names(numbered(3)));
    expect(store.getState().projects.failure).toBeUndefined();
    rpc.mockImplementation(rpcFor(held, {}, () => ({ active, archived })));
    await store.loadProjects();
    expect(names(store.getState().projects.items)).toEqual(names(numbered(3)));
  });
});
