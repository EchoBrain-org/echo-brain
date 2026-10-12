import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT, fail, flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const apollo = project(1, 30, { name: 'Apollo' });
const ann = { membership_id: 'mem_aaaaaaaa-1111-4111-8111-111111111111', display_name: 'Ann' };
let held: Held;
let signedIn: boolean;
let members: typeof ann[];
let directories: { query: string | undefined; cursor: string | undefined }[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  held = new Held();
  signedIn = true;
  members = [];
  directories = [];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok(signedIn ? { signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } }
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

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    await store.openOpenItems('project', apollo.project_id, 'Apollo');
    await store.openPeople();
    await flush();
    store.closeSheet();
    expect(store.openItemsShown()).not.toBeNull();
  });

  it('stays open after the project is renamed', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    await flush();
    await store.openOpenItems('project', apollo.project_id, 'Apollo');
    store.toggleProjectSettings(apollo, 'header');
    store.beginProjectRename();
    store.setProjectRename('Apollo 2');
    store.confirmProjectSetting();
    await flush();
    expect(store.getState().route).toMatchObject({ page: 'project', project: { name: 'Apollo 2' } });
    expect(store.openItemsShown()).not.toBeNull();
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
    expect(store.getState().compose).toMatchObject({ status: 'unknown', kept: true, readers: 'projects' });
    const requestId = store.getState().compose!.requestId;
    store.closeCompose();
    store.toggleProjectSettings(apollo, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    await flush();
    expect(store.getState().compose).toMatchObject({ status: 'unknown', kept: true, readers: 'projects', requestId, projects: [apollo] });
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
      'app.status': () => ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'someone-else', display_name: 'Else', role: 'employee' } }),
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
      'app.status': () => ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'someone-else', display_name: 'Else', role: 'employee' } }),
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
