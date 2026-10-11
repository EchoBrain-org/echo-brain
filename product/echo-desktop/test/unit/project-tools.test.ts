import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const apollo = project(1, 30, { name: 'Apollo' });
const revision = '00000000-0000-4000-8000-000000000001';
let held: Held;
let jira: string | null;
let spaces: string[];
let catalog: string[];
let confluenceRead: () => unknown;
const confluenceSets = () => rpc.mock.calls.filter(([method]) => method === 'projects.confluenceSet').map(([, params]) => (params as { space_ids: string[] | null }).space_ids);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  held = new Held();
  jira = null;
  spaces = [];
  catalog = ['1', '2'];
  confluenceRead = () => ok({ project_id: apollo.project_id, revision: spaces.length > 0 ? revision : null, mapping: spaces.length > 0 ? { space_ids: [...spaces] } : null });
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'account.tools': () => ok({ tools: [{ tool_id: 'jira', name: 'Jira', status: 'linked' }, { tool_id: 'confluence', name: 'Confluence', status: 'linked' }] }),
    'projects.jiraRead': () => ok({ project_id: apollo.project_id, revision: jira ? revision : null, mapping: jira ? { project_id: '1', project_key: jira } : null }),
    'projects.confluenceRead': () => confluenceRead(),
    'projects.confluenceSpaces': () => ok({ items: catalog.map(id => ({ id, name: `Space ${id}`, key: `S${id}` })), next_cursor: null }),
    'projects.jiraSet': params => { jira = params.jira_project as string | null; return ok({ project_id: apollo.project_id, revision, mapping: jira ? { project_id: '1', project_key: jira } : null }); },
    'projects.confluenceSet': params => { spaces = (params.space_ids as string[] | null) ?? []; return ok({ project_id: apollo.project_id, revision, mapping: spaces.length > 0 ? { space_ids: spaces } : null }); },
  }, () => ({ active: [apollo], archived: [] })));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function openTools() {
  const store = await startStore();
  await store.openProject(apollo);
  await flush();
  store.openProjectTools(apollo);
  await flush();
  return store;
}

describe('a Tools save the tool refused', () => {
  it('keeps the typed key to correct, says why, and leaves the bar alone', async () => {
    const store = await openTools();
    store.setBarText('what changed in KAN');
    store.setProjectJira('KANN');
    held.hold('projects.jiraSet')(fail('not_found', { mutation_outcome: 'not_submitted', request_id: 'x' }));
    await store.saveProjectTools();
    await flush();
    const setting = store.getState().projectSettings?.jira;
    expect(setting).toMatchObject({ status: 'ready', key: 'KANN', failure: { code: 'not_found' } });
    expect(setting?.writeFailed).not.toBe(true);
    expect(store.getState().barText).toBe('what changed in KAN');
    expect(store.getState().projectSettings?.tools?.saving).toBe(false);
    expect(store.projectToolsSavable(store.getState().projectSettings!)).toBe(true);
    expect(store.projectToolFailureWords(store.getState().projectSettings!, 'jira', 'Jira')).toBe('No Jira project with that key that you can see.');
  });

  it('still needs a reload when the outcome is unknown', async () => {
    const store = await openTools();
    store.setProjectJira('KAN');
    held.hold('projects.jiraSet')(fail('timeout', { mutation_outcome: 'unknown', request_id: 'x' }));
    await store.saveProjectTools();
    await flush();
    expect(store.getState().projectSettings?.jira).toMatchObject({ status: 'failed', writeFailed: true });
    expect(store.projectToolFailureWords(store.getState().projectSettings!, 'jira', 'Jira')).toBe('The change could not be confirmed. Reload the setting before editing again.');
  });
});

describe('a mapped Confluence space this lead cannot see', () => {
  it('is listed as selected and can be unticked', async () => {
    spaces = ['1', '77'];
    const store = await openTools();
    const confluence = store.getState().projectSettings!.confluence!;
    expect(confluence.spaces.map(space => space.id)).toEqual(['1', '2']);
    expect(store.hiddenSpaces(confluence)).toEqual(['77']);
    store.toggleProjectConfluenceSpace('77');
    expect(store.getState().projectSettings!.confluence!.selected).toEqual(['1']);
    await store.saveProjectTools();
    await flush();
    expect(confluenceSets()).toEqual([['1']]);
  });
});

describe('what Save says', () => {
  it('names only the tool it changed', async () => {
    jira = 'KAN';
    spaces = ['1', '2'];
    const store = await openTools();
    store.clearProjectTool('jira');
    await store.saveProjectTools();
    await flush();
    expect(store.getState().toast).toBe('Apollo no longer reads Jira');
    expect(store.readsWords(store.getState().projectReads!)).toEqual(['2 Confluence spaces']);
  });

  it('says what was set and what stopped, together', async () => {
    jira = 'KAN';
    const store = await openTools();
    store.clearProjectTool('jira');
    store.toggleProjectConfluenceSpace('2');
    await store.saveProjectTools();
    await flush();
    expect(store.getState().toast).toBe('Apollo now reads 1 Confluence space and no longer reads Jira');
  });
});

describe('your connections on Tools', () => {
  it('can be read again after the read failed', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    held.hold('account.tools')(fail('unavailable', { retryable: true }));
    store.openProjectTools(apollo);
    await flush();
    expect(store.getState().projectSettings?.tools).toMatchObject({ items: null, failure: { code: 'unavailable' } });
    store.reloadProjectToolList();
    await flush();
    expect(store.getState().projectSettings?.tools?.items).toHaveLength(2);
    expect(store.getState().projectSettings?.tools?.failure).toBeUndefined();
  });
});
