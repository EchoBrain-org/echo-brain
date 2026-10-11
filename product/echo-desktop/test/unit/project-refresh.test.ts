import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../src/shared/protocol.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const project: ProjectSummary = {
  project_id: 'prj_11111111-1111-4111-8111-111111111111', name: 'Apollo', role: 'lead',
  created_at: '2026-10-01T00:00:00.000Z', status: 'active',
};
const ok = (value: unknown) => ({ ok: true, value });
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
let membership: string;
let projects: ProjectSummary[];
let jira: string;
let spaces: string[];
let held: Map<string, Promise<unknown>[]>;

/** Hold the next reply for this operation while later requests can complete. */
function hold(method: string): (value: unknown) => void {
  let reply!: (value: unknown) => void;
  const pending = new Promise(resolve => { reply = value => resolve(ok(value)); });
  held.set(method, [...(held.get(method) ?? []), pending]);
  return reply;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  membership = 'member';
  projects = [project];
  jira = 'CURRENT';
  spaces = ['one', 'two'];
  held = new Map();
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    const pending = held.get(method)?.shift();
    if (pending) return pending;
    switch (method) {
      case 'app.status': return ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: membership, display_name: 'Fixture', role: 'employee' } });
      case 'app.setUnresolved': return ok(null);
      case 'account.tools': return ok({ tools: [{ tool_id: 'jira', status: 'linked' }, { tool_id: 'confluence', status: 'linked' }] });
      case 'projects.list': {
        const rows = params.status === 'archived' ? [] : projects;
        // Like the Authority, the cursor follows a stable row, not an offset.
        const from = params.cursor ? rows.findIndex(row => `after:${row.project_id}` === params.cursor) + 1 : 0;
        const items = rows.slice(from, from + 10);
        return ok({ items, next_cursor: from + 10 < rows.length ? `after:${items.at(-1)!.project_id}` : null });
      }
      case 'projects.members': return ok({ items: [], next_cursor: null });
      case 'list.page': return ok({ items: [], next_cursor: null, meetings_held: false });
      case 'projects.jiraRead': return ok({ revision: 'jira-1', mapping: { project_key: jira } });
      case 'projects.confluenceRead': return ok({ revision: 'confluence-1', mapping: { space_ids: [...spaces] } });
      case 'projects.confluenceSpaces': return ok({ items: spaces.map(id => ({ id, name: id, key: id })), next_cursor: null });
      case 'projects.jiraSet': {
        jira = params.jira_project as string;
        return ok({ revision: 'jira-2', mapping: { project_key: jira } });
      }
      case 'runs': return { ok: false, failure: { code: 'unavailable', retryable: true } };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function start() {
  const store = await import('../../src/renderer/store.js');
  await store.refreshStatus();
  await flush();
  return store;
}

describe('project tool-read replies', () => {
  it('ignores the earlier opening of the same project, for tools and both mappings', async () => {
    const store = await start();
    const tools = hold('account.tools');
    const jiraReply = hold('projects.jiraRead');
    const confluence = hold('projects.confluenceRead');
    await store.openProject(project);
    await store.openProject(project);
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'CURRENT', confluence: 2 });
    tools({ tools: [] });
    jiraReply({ mapping: { project_key: 'OLD' } });
    confluence({ mapping: { space_ids: ['old'] } });
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'CURRENT', confluence: 2 });
  });

  it('keeps saved settings when the initial project reads finish after Save', async () => {
    const store = await start();
    const tools = hold('account.tools');
    const jiraReply = hold('projects.jiraRead');
    const confluence = hold('projects.confluenceRead');
    await store.openProject(project);
    store.openProjectTools(project);
    await flush();
    store.setProjectJira('SAVED');
    await store.saveProjectTools();
    expect(store.getState().projectSettings).toBeNull();
    expect(store.getState().projectReads).toMatchObject({ jira: 'SAVED', confluence: 2 });
    tools({ tools: [] });
    jiraReply({ mapping: { project_key: 'OLD' } });
    confluence({ mapping: { space_ids: ['old'] } });
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'SAVED', confluence: 2 });
  });

  it('forgets project reads when the account changes and drops the old replies', async () => {
    const store = await start();
    const jiraReply = hold('projects.jiraRead');
    await store.openProject(project);
    membership = 'someone-else';
    await store.refreshStatus();
    await flush();
    expect(store.getState().projectReads).toBeNull();
    jiraReply({ mapping: { project_key: 'PRIVATE' } });
    await flush();
    expect(store.getState().projectReads).toBeNull();
  });

  it('lets still-unknown tool fields finish after Save without replacing the saved field', async () => {
    const store = await start();
    const initialTools = hold('account.tools');
    const initialJira = hold('projects.jiraRead');
    const initialConfluence = hold('projects.confluenceRead');
    await store.openProject(project);
    const sheetTools = hold('account.tools');
    const sheetConfluence = hold('projects.confluenceRead');
    store.openProjectTools(project);
    await flush();
    store.setProjectJira('SAVED');
    await store.saveProjectTools();
    initialTools({ tools: [{ tool_id: 'jira', status: 'linked' }] });
    initialJira({ mapping: { project_key: 'OLD' } });
    initialConfluence({ mapping: { space_ids: ['one', 'two'] } });
    sheetTools({ tools: [] });
    sheetConfluence({ mapping: null });
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'SAVED', confluence: 2 });
  });
});

describe('project pagination on foreground refresh', () => {
  const numbered = (count: number) => Array.from({ length: count }, (_, index) => ({
    ...project, project_id: `prj_${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `Project ${index + 1}`,
  }));

  it.each([
    ['shown', 13], ['resume', 13], ['shown', 22], ['resume', 22],
  ] as const)('keeps the displaced row on %s with %i projects and preserves More', async (event, count) => {
    projects = numbered(count);
    const store = await start();
    await store.loadProjects(true);
    await store.openProject(projects[12]!);
    const previous = projects.slice(0, 20);
    const next = store.getState().projects.next;
    projects = [{ ...project, name: 'New', created_at: '2026-10-02T00:00:00.000Z' }, ...projects];
    if (event === 'shown') await store.windowShown();
    else { store.conceal(); store.resume(); await flush(); }
    expect(store.getState().projects.items.map(row => row.project_id)).toEqual([project.project_id, ...previous.map(row => row.project_id)]);
    expect(store.getState().projects.next).toBe(next);
    expect(store.getState().route.page).toBe('project');
    await store.loadProjects(true);
    expect(store.getState().projects.items).toEqual(projects);
    expect(store.getState().projects.next).toBeNull();
  });

  it('drops a removed row inside the refreshed boundary while retaining older loaded rows', async () => {
    projects = numbered(22);
    const store = await start();
    await store.loadProjects(true);
    await store.openProject(projects[0]!);
    const next = store.getState().projects.next;
    const removed = projects.splice(3, 1)[0]!;
    await store.windowShown();
    expect(store.getState().projects.items.map(row => row.name)).toEqual(projects.slice(0, 19).map(row => row.name));
    expect(store.getState().projects.items).not.toContainEqual(removed);
    expect(store.getState().projects.next).toBe(next);
  });

  it('replaces cached pages when the refreshed first page is the whole list', async () => {
    projects = numbered(13);
    const store = await start();
    await store.loadProjects(true);
    await store.openProject(projects[0]!);
    projects = projects.slice(0, 3);
    await store.windowShown();
    expect(store.getState().projects.items).toEqual(projects);
    expect(store.getState().projects.next).toBeNull();
  });
});
