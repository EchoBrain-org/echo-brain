import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT, byTestId, fail, flush, Held, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const apollo = project(1, 30, { name: 'Apollo' });
const ann = { membership_id: 'mem_aaaaaaaa-1111-4111-8111-111111111111', display_name: 'Ann' };
let held: Held;
let signedIn: boolean;
let members: typeof ann[];
let directories: { query: string | undefined; cursor: string | undefined }[];

storeLifecycle();
beforeEach(() => {
  held = new Held();
  signedIn = true;
  members = [];
  directories = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok(signedIn ? { signed_in: true, account: ACCOUNT }
      : { signed_in: false, account: null }),
    'projects.members': () => ok({ items: members, next_cursor: null }),
    'projects.read': () => ok(apollo),
    'projects.rename': params => ok({ request_id: params.request_id, project_id: params.project_id, operation: 'rename' }),
    'projects.leave': () => ok({}),
    'people.directory': params => {
      directories.push({ query: params.query as string | undefined, cursor: params.cursor as string | undefined });
      // Like the Authority, a cursor belongs to the query it was issued for.
      const query = ((params.query as string | undefined) ?? '').toLowerCase();
      if (params.cursor !== undefined && params.cursor !== `dir|${query}`) return fail('invalid_request');
      const people = Array.from({ length: 12 }, (_, i) => ({ membership_id: `mem_${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, display_name: `${query || 'p'}${i}` }));
      return ok(params.cursor === undefined ? { items: people.slice(0, 10), next_cursor: `dir|${query}` } : { items: people.slice(10), next_cursor: null });
    },
    'runs': params => (params.request as { operation: string }).operation === 'items'
      ? ok({ items: [], next_cursor: null, summary: { open: 0, last_checked_at: null }, stages: [] }) : fail('unavailable', { retryable: true }),
    'dialog.openDocument': () => ok({ handle: 'h1', name: 'brief.txt' }),
    'documents.retry': params => ok({ request_id: params.request_id }),
    'account.signOut': () => ok({ signed_in: false, account: null }),
  }, () => ({ active: [apollo], archived: [] })));
});

describe('a project\'s members', () => {
  it('are the latest read: an older reply does not replace a newer one', async () => {
    const store = await startStore();
    const first = held.hold('projects.members');
    await store.openProject(apollo);
    await flush();
    members = [ann];
    await store.openPeople();
    await flush();
    expect(store.getState().roster?.items).toEqual([ann]);
    first(ok({ items: [], next_cursor: null }));
    await flush();
    expect(store.getState().roster?.items).toEqual([ann]);
  });
});

describe('what is open over a project', () => {
  it('stays open after People read the project again', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    await store.openFollowUps('project', apollo.project_id, 'Apollo');
    await store.openPeople();
    await flush();
    store.closeSheet();
    expect(store.followUpShown()).toMatchObject({ kind: 'list', scope: 'project', id: apollo.project_id });
  });

  it('stays open after the project is renamed', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    await store.openFollowUps('project', apollo.project_id, 'Apollo');
    store.toggleProjectSettings(apollo, 'header');
    store.beginProjectRename();
    store.setProjectRename('Apollo 2');
    store.confirmProjectSetting();
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { name: 'Apollo 2' } });
    expect(store.followUpShown()).toMatchObject({ kind: 'list', scope: 'project' });
  });
});

describe('finding people', () => {
  it('More right after the name changed searches the new name afresh instead of paging the old one', async () => {
    const store = await startStore();
    store.openNewProject();
    await flush();
    store.setPickQuery('ann');
    await store.findPeople(true);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const sheet = store.getState().sheet as { directory: { items: { display_name: string }[]; failure?: unknown } | null };
    expect(sheet.directory?.failure).toBeUndefined();
    expect(sheet.directory?.items.map(person => person.display_name)).toEqual(Array.from({ length: 10 }, (_, i) => `ann${i}`));
    expect(directories.at(-1)).toEqual({ query: 'ann', cursor: undefined });
  });
});

describe('leaving a project', () => {
  it('leaves a capture whose save is unconfirmed as it was sent', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    store.openCompose();
    await store.attachFile();
    held.hold('documents.upload')(fail('timeout', { mutation_outcome: 'unknown' }));
    await store.sendCompose();
    await flush();
    expect(store.getState().compose).toMatchObject({ status: 'unknown', kept: true, place: 'projects' });
    const requestId = store.getState().compose!.requestId;
    store.closeCompose();
    store.toggleProjectSettings(apollo, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    await flush();
    expect(store.getState().compose).toMatchObject({ status: 'unknown', kept: true, place: 'projects', requestId, projects: [apollo] });
  });

  it('reads Home again, so a Home load dropped on the way there is not left busy', async () => {
    const homeTools = held.hold('account.tools');
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    homeTools(ok({ tools: [] }));
    await flush();
    expect(store.getState().home?.loading).toBe(true);
    store.toggleProjectSettings(apollo, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    await flush();
    expect(store.getState().route).toEqual({ page: 'home' });
    expect(store.getState().home?.loading).toBe(false);
  });
});

describe('leaving Ask while it answers', () => {
  it('cancels the host\'s Ask once, whichever way the thread is left', async () => {
    const store = await startStore();
    const sent = () => rpc.mock.calls.filter(([method]) => method === 'ask.run').map(([, params]) => params.cancel_id);
    const cancelled = () => rpc.mock.calls.filter(([method]) => method === 'ask.cancel').map(([, params]) => params.cancel_id);
    held.hold('ask.run');
    void store.ask('What changed?');
    await store.openProject(apollo);
    await flush();
    expect(cancelled()).toEqual(sent());
    held.hold('ask.run');
    void store.ask('And here?');
    store.closeAsk();
    store.goHome();
    expect(sent()).toHaveLength(2);
    expect(cancelled()).toEqual(sent());
  });
});

describe('signing out while the host restarts', () => {
  it('forgets the account once a status read shows no one signed in', async () => {
    const store = await startStore();
    store.openCompose();
    store.setComposeText('Private draft');
    store.closeCompose();
    store.accountCommand('signout');
    held.hold('account.signOut')(fail('host_restarted', { retryable: true }));
    await store.signOut();
    await flush();
    signedIn = false;
    await store.refreshStatus();
    await flush();
    expect(store.getState().status?.signed_in).toBe(false);
    signedIn = true;
    await store.refreshStatus();
    await flush();
    expect(store.getState().compose).toBeNull();
  });
});

describe('another account signing in', () => {
  it('requests retained-copy cleanup under the previous account, never the new account', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    store.openCompose();
    await store.attachFile();
    held.hold('documents.upload')(fail('timeout', { mutation_outcome: 'unknown' }));
    await store.sendCompose();
    await flush();
    expect(store.getState().compose).toMatchObject({ status: 'unknown', kept: true });
    const requestId = store.getState().compose!.requestId;
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account: { ...ACCOUNT, membership_id: 'someone-else', display_name: 'Else' } }),
      'documents.abandon': () => ok(null),
    }, () => ({ active: [], archived: [] })));
    await store.refreshStatus();
    await flush();
    expect(store.getState().compose).toBeNull();
    expect(rpc.mock.calls.filter(([method]) => method === 'documents.abandon').map(([, params]) => (params as { request_id: string }).request_id)).toEqual([requestId]);
    expect(rpc).toHaveBeenCalledWith('documents.abandon', { request_id: requestId, expect: { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id } });
  });

  it.each([false, true])('requests connection cancellation under the previous account, never the new account (project Tools: %s)', async projectTools => {
    const store = await startStore();
    rpc.mockImplementation(rpcFor(held, {
      'account.tools': () => ok({ tools: [{ tool_id: 'jira', name: 'Jira', status: 'unlinked' }] }),
      'tools.connect': () => ok({ attempt_id: 'att_1', expires_at: '2026-10-11T01:00:00.000Z' }),
      'tools.status': () => ok({ status: 'pending', failure_reason: null }),
      'tools.cancel': () => ok({ status: 'cancelled', failure_reason: null }),
    }, () => ({ active: [apollo], archived: [] })));
    if (projectTools) store.openProjectTools(apollo);
    else store.openTools();
    await flush();
    const tool = { tool_id: 'jira', name: 'Jira', status: 'unlinked' as const };
    const connecting = projectTools ? store.connectProjectTool(tool) : store.connectTool(tool);
    await flush();
    if (projectTools) expect(store.getState().projectSettings?.tools?.connect).toMatchObject({ phase: 'waiting' });
    else expect(store.getState().sheet).toMatchObject({ kind: 'tool-connect', phase: 'waiting' });
    rpc.mockImplementation(rpcFor(held, {
      'app.status': () => ok({ signed_in: true, account: { ...ACCOUNT, membership_id: 'someone-else', display_name: 'Else' } }),
      'tools.cancel': () => ok({ status: 'cancelled', failure_reason: null }),
      'tools.status': () => ok({ status: 'pending', failure_reason: null }),
    }, () => ({ active: [], archived: [] })));
    await store.refreshStatus();
    await flush();
    expect(store.getState().sheet).toBeNull();
    expect(rpc.mock.calls.filter(([method]) => method === 'tools.cancel').map(([, params]) => (params as { attempt_id: string }).attempt_id)).toEqual(['att_1']);
    expect(rpc).toHaveBeenCalledWith('tools.cancel', { tool_id: 'jira', attempt_id: 'att_1', expect: { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id } });
    await vi.advanceTimersByTimeAsync(2500);
    await connecting;
  });
});


describe('project permissions and dialogs', () => {
  it('a member sees who is in a project without being offered changes', async () => {
    const member = { ...apollo, role: 'member' as const };
    const store = await startStore();
    members = [ann];
    await store.openProject(member);
    held.hold('projects.read')(ok(member));
    await store.openPeople(); await flush();
    expect(directories).toEqual([]);
    expect(store.canManage()).toBe(false);
    const { People } = await import('../../src/renderer/screens/people.js');
    const shown = render(People({ state: store.getState(), sheet: store.findingSheet()! }));
    expect(text(byTestId(shown, 'member-row'))).toContain('Ann');
    for (const id of ['people-find', 'member-more', 'candidate-row']) expect(byTestId(shown, id)).toHaveLength(0);
  });

  it('People reads the role again: a new role empties the bar', async () => {
    const store = await startStore(); await store.openProject(apollo); store.setBarText('apollo');
    held.hold('projects.read')(ok({ ...apollo, role: 'member' }));
    await store.openPeople(); await flush();
    expect(store.getState()).toMatchObject({ barText: '', route: { page: 'project', project: { role: 'member' } } });
    expect(store.getState().projects.items[0]?.role).toBe('member');
    expect(store.findingSheet()?.project?.role).toBe('member');
    expect(directories).toEqual([]);
  });

  it('More people appends the next page with its cursor, excluding yourself and chosen people', async () => {
    const store = await startStore();
    held.hold('people.directory')(ok({ items: [{ membership_id: ACCOUNT.membership_id, display_name: 'You' }, ...Array.from({ length: 9 }, (_, i) => ({ membership_id: `person-${i}`, display_name: `Person ${i}` }))], next_cursor: 'dir|' }));
    store.openNewProject(); await flush();
    expect(store.pickable()).toHaveLength(9);
    await store.findPeople(true); await flush();
    expect(directories).toEqual([{ query: undefined, cursor: 'dir|' }]);
    expect(store.pickable()).toHaveLength(11);
    const last = store.pickable().at(-1)!; store.pickPerson(last);
    expect(store.pickable()).toHaveLength(10);
    expect(store.getState().sheet).toMatchObject({ kind: 'new-project', picks: [{ person: last }] });
  });

  it.each(['sidebar', 'header'] as const)('Capture or sign out dismisses the %s menu, and closing either does not restore it', async origin => {
    const store = await startStore(); await store.openProject(apollo);
    store.toggleProjectSettings(apollo, origin); expect(store.getState().projectSettings?.menu).toBe(true);
    store.openCapture(); expect(store.getState().compose?.hidden).toBe(false); expect(store.getState().projectSettings?.menu).toBeFalsy();
    store.closeCompose(); expect(store.getState().projectSettings?.menu).toBeFalsy();
    store.toggleProjectSettings(apollo, origin); store.accountCommand('signout');
    expect(store.getState().sheet?.kind).toBe('signout'); expect(store.getState().projectSettings?.menu).toBeFalsy();
    store.closeSheet(); expect(store.getState().sheet).toBeNull(); expect(store.getState().projectSettings?.menu).toBeFalsy();
    expect(rpc.mock.calls.filter(([method]) => ['projects.rename', 'projects.archive', 'projects.leave'].includes(method))).toHaveLength(0);
  });

  it('Rename and project Tools stay in front: Capture opens nothing under them', async () => {
    const store = await startStore(); await store.openProject(apollo);
    store.toggleProjectSettings(apollo, 'header'); store.beginProjectRename();
    expect(store.projectSettingsModal()).toBe(true); store.openCapture(); expect(store.getState().compose).toBeNull();
    store.cancelProjectSettingsAction(); expect(store.getState().projectSettings?.rename).toBeNull();
    expect(store.getState().route).toMatchObject({ page: 'project', project: apollo });
    store.openProjectTools(apollo); await flush(); store.openCapture();
    expect(store.getState().compose).toBeNull(); expect(store.getState().projectSettings?.tools).toBeDefined();
  });

  it('Rename sends nothing for an empty or unchanged name', async () => {
    const store = await startStore(); await store.openProject(apollo);
    expect(store.projectRenameValid('Apollo', 'Apollo')).toBe(false);
    expect(store.projectRenameValid('   ', 'Apollo')).toBe(false);
    expect(store.projectRenameValid(' Apollo 2 ', 'Apollo')).toBe(true);
    store.toggleProjectSettings(apollo, 'header'); store.beginProjectRename(); store.setProjectRename('   '); store.confirmProjectSetting(); await flush();
    expect(rpc.mock.calls.filter(([method]) => method === 'projects.rename')).toHaveLength(0);
    expect(store.getState().projectSettings?.rename).toBe('   ');
  });

  it('a last lead is told to promote another lead before leaving, and stays', async () => {
    const store = await startStore(); await store.openProject(apollo);
    held.hold('projects.leave')(fail('conflict', { mutation_outcome: 'not_submitted' }));
    store.toggleProjectSettings(apollo, 'header'); store.askProjectSetting('leave'); store.confirmProjectSetting(); await flush();
    expect(store.getState().projectSettings?.write).toMatchObject({ operation: 'leave', status: 'failed', failure: { code: 'conflict' } });
    const { ProjectSettings } = await import('../../src/renderer/screens/project-settings.js');
    expect(text(byTestId(render(ProjectSettings({ state: store.getState() })), 'project-settings-error'))).toBe('Promote another lead before leaving this project.');
    expect(store.getState().route).toMatchObject({ page: 'project', project: apollo });
    expect(store.getState().projects.items).toContainEqual(apollo);
  });
});
