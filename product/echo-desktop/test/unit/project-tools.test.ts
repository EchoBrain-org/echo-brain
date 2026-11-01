import { beforeEach, describe, expect, it, vi } from 'vitest';
import { byTestId, fail, flush, Held, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const apollo = project(1, 30, { name: 'Apollo' });
const revision = '00000000-0000-4000-8000-000000000001';
let held: Held;
let jira: string | null;
let spaces: string[];
const confluenceSets = () => rpc.mock.calls.filter(([method]) => method === 'projects.confluenceSet').map(([, params]) => (params as { space_ids: string[] | null }).space_ids);

storeLifecycle();
beforeEach(() => {
  held = new Held();
  jira = null;
  spaces = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'account.tools': () => ok({ tools: [{ tool_id: 'jira', name: 'Jira', status: 'linked' }, { tool_id: 'confluence', name: 'Confluence', status: 'linked' }] }),
    'projects.jiraRead': () => ok({ project_id: apollo.project_id, revision: jira ? revision : null, mapping: jira ? { project_id: '1', project_key: jira } : null }),
    'projects.confluenceRead': () => ok({ project_id: apollo.project_id, revision: spaces.length > 0 ? revision : null, mapping: spaces.length > 0 ? { space_ids: [...spaces] } : null }),
    'projects.confluenceSpaces': () => ok({ items: ['1', '2'].map(id => ({ id, name: `Space ${id}`, key: `S${id}` })), next_cursor: null }),
    'projects.jiraSet': params => { jira = params.jira_project as string | null; return ok({ project_id: apollo.project_id, revision, mapping: jira ? { project_id: '1', project_key: jira } : null }); },
    'projects.confluenceSet': params => { spaces = (params.space_ids as string[] | null) ?? []; return ok({ project_id: apollo.project_id, revision, mapping: spaces.length > 0 ? { space_ids: spaces } : null }); },
  }, () => ({ active: [apollo], archived: [] })));
});

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
    expect(store.getState().projectSettings?.tools).toBeDefined();
    expect(store.projectToolsSavable(store.getState().projectSettings!)).toBe(false);
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

describe('Tools and the project page\'s first reads', () => {
  it('keeps saved settings when the initial project reads finish after Save', async () => {
    jira = 'CURRENT';
    spaces = ['1', '2'];
    const store = await startStore();
    const tools = held.hold('account.tools');
    const jiraReply = held.hold('projects.jiraRead');
    const confluence = held.hold('projects.confluenceRead');
    await store.openProject(apollo);
    store.openProjectTools(apollo);
    await flush();
    store.setProjectJira('SAVED');
    await store.saveProjectTools();
    expect(store.getState().projectSettings).toBeNull();
    expect(store.getState().projectReads).toMatchObject({ jira: 'SAVED', confluence: 2 });
    tools(ok({ tools: [] }));
    jiraReply(ok({ mapping: { project_key: 'OLD' } }));
    confluence(ok({ mapping: { space_ids: ['old'] } }));
    await flush();
    expect(store.getState().projectReads).toMatchObject({ available: true, jira: 'SAVED', confluence: 2 });
  });
});


const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
const override = (method: string, reply: (params: Record<string, unknown>) => unknown) => {
  const fallback = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name, params) => name === method ? reply(params) : fallback(name, params));
};
const settingsView = async (store: Awaited<ReturnType<typeof startStore>>) => render((await import('../../src/renderer/screens/project-settings.js')).ProjectSettings({ state: store.getState() }));

describe('the project Tools sheet', () => {
  it('connects in the row, reads the spaces after connecting, and closes on Save', async () => {
    let linked = false, statuses = 0;
    override('account.tools', () => ok({ tools: [{ tool_id: 'confluence', name: 'Confluence', status: linked ? 'linked' : 'unlinked' }] }));
    override('tools.connect', () => ok({ attempt_id: 'att_1', expires_at: new Date(Date.now() + 1800000).toISOString() }));
    override('tools.status', () => { linked = ++statuses > 1; return ok({ status: linked ? 'complete' : 'pending', failure_reason: null }); });
    const store = await openTools();
    const connecting = store.connectProjectTool(store.projectToolEntry(store.getState().projectSettings!, 'confluence')!);
    await flush();
    expect(store.getState().projectSettings?.tools?.connect?.phase).toBe('waiting');
    expect(store.projectToolsSavable(store.getState().projectSettings!)).toBe(false);
    await vi.advanceTimersByTimeAsync(4000); await connecting; await flush();
    expect(store.getState().projectSettings?.tools?.connected).toBe('confluence');
    expect(calls('projects.confluenceSpaces')).toHaveLength(1);
    store.toggleProjectConfluenceSpace('1'); await store.saveProjectTools();
    expect(store.getState().toast).toBe('Apollo now reads 1 Confluence space');
    expect(store.readsWords(store.getState().projectReads!)).toEqual(['1 Confluence space']);
    expect(rpc.mock.calls.map(([method]) => method).filter(method => ['tools.connect', 'tools.status', 'projects.confluenceSpaces'].includes(method)))
      .toEqual(['tools.connect', 'tools.status', 'tools.status', 'projects.confluenceSpaces']);
  });

  it('closing Tools cancels a waiting connection and stops polling', async () => {
    override('account.tools', () => ok({ tools: [{ tool_id: 'jira', name: 'Jira', status: 'unlinked' }] }));
    override('tools.connect', () => ok({ attempt_id: 'att_1', expires_at: new Date(Date.now() + 1800000).toISOString() }));
    override('tools.status', () => ok({ status: 'pending', failure_reason: null }));
    override('tools.cancel', () => ok({ status: 'cancelled', failure_reason: null }));
    const store = await openTools();
    void store.connectProjectTool(store.projectToolEntry(store.getState().projectSettings!, 'jira')!); await flush();
    store.cancelProjectSettingsAction(); await flush();
    expect(store.getState().projectSettings?.tools).toBeUndefined();
    expect(calls('tools.cancel')[0]).toMatchObject({ tool_id: 'jira', attempt_id: 'att_1' });
    const before = calls('tools.status').length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls('tools.status')).toHaveLength(before);
  });

  it('members read saved mappings with no picker, Save or spaces read', async () => {
    spaces = ['1']; const member = { ...apollo, name: 'Beacon', role: 'member' as const };
    const store = await startStore(); await store.openProject(member); store.openProjectTools(member); await flush();
    const shown = await settingsView(store);
    for (const id of ['project-tools-save', 'project-jira-input', 'project-confluence-spaces']) expect(byTestId(shown, id)).toHaveLength(0);
    expect(byTestId(shown, 'project-tools-close')).toHaveLength(1);
    expect(text(shown)).toContain('A project lead can change what Beacon reads.');
    expect(text(byTestId(shown, 'project-confluence-current'))).toBe('Reads 1 space');
    expect(text(byTestId(shown, 'project-jira-current'))).toBe('Not set');
    expect(calls('projects.confluenceSpaces')).toHaveLength(0);
    store.setProjectJira('ECHO'); await store.saveProjectTools();
    expect(calls('projects.jiraSet')).toHaveLength(0);
  });

  it('a lead can stop a saved mapping while its space picker cannot be read', async () => {
    spaces = ['1']; override('projects.confluenceSpaces', () => fail('unavailable', { retryable: true }));
    const store = await openTools();
    expect(store.getState().projectSettings?.confluence?.pickerFailure?.code).toBe('unavailable');
    expect(store.projectToolsSavable(store.getState().projectSettings!)).toBe(false);
    expect(text(byTestId(await settingsView(store), 'project-confluence-picker-error'))).toContain('ECHO is unavailable right now. Try again.');
    store.clearProjectTool('confluence'); await store.saveProjectTools();
    expect(confluenceSets()).toEqual([null]); expect(store.getState().toast).toBe('Apollo no longer reads Confluence');
  });

  it('a stale change keeps Tools up and Reload reads it without resending', async () => {
    const store = await openTools(); store.toggleProjectConfluenceSpace('1');
    held.hold('projects.confluenceSet')(fail('conflict', { mutation_outcome: 'not_submitted' }));
    await store.saveProjectTools();
    expect(store.getState().projectSettings?.confluence).toMatchObject({ status: 'failed', writeFailed: true });
    expect(store.projectToolFailureWords(store.getState().projectSettings!, 'confluence', 'Confluence')).toBe('This setting changed. Reload it before editing.');
    expect(store.getState().projectSettings?.tools?.saving).toBe(false);
    expect(store.projectToolsSavable(store.getState().projectSettings!)).toBe(false);
    store.reloadProjectTool('confluence'); await flush();
    expect(store.getState().projectSettings?.confluence?.status).toBe('ready');
    expect(confluenceSets()).toHaveLength(1);
  });

  it('a pending save keeps Tools up, ignores Cancel, and closes on success', async () => {
    const store = await openTools(); store.setProjectJira('ECHO');
    const release = held.hold('projects.jiraSet'); const saving = store.saveProjectTools(); await flush();
    expect(store.getState().projectSettings?.tools?.saving).toBe(true); expect(store.projectSettingsBlocked()).toBe(true);
    store.cancelProjectSettingsAction();
    const shown = await settingsView(store);
    for (const id of ['project-tools-save', 'project-tools-cancel']) expect(byTestId(shown, id)[0]!.props.disabled).toBe(true);
    const { ProjectSettingsButton } = await import('../../src/renderer/screens/project-settings.js');
    expect(byTestId(render(ProjectSettingsButton({ state: store.getState() })), 'project-settings')[0]!.props.disabled).toBe(true);
    release(ok({ project_id: apollo.project_id, revision, mapping: { project_id: '1', project_key: 'ECHO' } })); await saving;
    expect(store.getState().projectSettings).toBeNull(); expect(store.getState().toast).toBe('Apollo now reads Jira ECHO');
  });
});
