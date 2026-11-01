import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListItem } from '../../src/shared/protocol.js';
import { ACCOUNT, fail, flush, Held, ok, project, rpcFor, startStore, storeLifecycle } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
const apollo = project(1, 30, { name: 'Apollo' }), beacon = project(2, 29, { name: 'Beacon' });
const row = (title: string, extra: Partial<ListItem> = {}): ListItem => ({ ref: { kind: 'note', id: `ctx_${title}` }, title,
  added_at: '2026-10-20T10:00:00.000Z', visibility: 'only-me', projects: [], ...extra });
const note = row('Supplier call notes', { projects: ['Apollo'] });
const meeting = row('Pricing review', { ref: { kind: 'meeting', id: `sha256:${'7'.repeat(64)}` } });
let held: Held;
let signedIn: boolean;
storeLifecycle();
beforeEach(() => {
  held = new Held(); signedIn = true;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok(signedIn ? { signed_in: true, account: ACCOUNT } : { signed_in: false, account: null }),
    'projects.read': () => ok(apollo),
    'projects.rename': params => ok({ request_id: params.request_id, project_id: params.project_id, operation: 'rename' }),
    'list.page': () => ok({ items: [meeting, note], next_cursor: null, meetings_held: false }),
    'notes.submit': params => ok({ request_id: params.request_id, audience: params.audience }),
    'open.ref': () => ok({ kind: 'note', content: { context_id: note.ref.id, title: note.title, text: 'Supplier called.', received_at: note.added_at,
      audience: 'only-me', project_ids: [apollo.project_id] } }),
  }, () => ({ active: [apollo, beacon], archived: [] })));
});
const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
const override = (method: string, reply: (params: Record<string, unknown>) => unknown) => {
  const fallback = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name, params) => name === method ? reply(params) : fallback(name, params));
};

describe('Only me reads and changes', () => {
  it('renames a project in every loaded row without dropping the rows More read', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => row(`Note ${index}`, { added_at: new Date(Date.parse('2026-10-20T10:00:00Z') - index * 3600000).toISOString(), projects: index === 2 || index === 10 ? ['Apollo'] : [] }));
    override('projects.rename', params => {
      for (const index of [2, 10]) rows[index] = { ...rows[index]!, projects: ['Apollo 2'] };
      return ok({ request_id: params.request_id, project_id: params.project_id, operation: 'rename' });
    });
    override('list.page', params => ok({ items: params.cursor ? rows.slice(10) : rows.slice(0, 10), next_cursor: params.cursor ? null : 'c2', meetings_held: false }));
    const store = await startStore();
    await store.openOnlyMe(); await store.moreList(); await flush();
    expect(store.getState().list?.items).toHaveLength(11);
    store.toggleProjectSettings(apollo, 'sidebar'); store.beginProjectRename(); store.setProjectRename('Apollo 2'); store.confirmProjectSetting(); await flush();
    expect(store.getState().toast).toBe('Renamed to Apollo 2');
    expect(store.getState().route).toEqual({ page: 'only-me' });
    expect(store.getState().list?.items).toHaveLength(11);
    expect([2, 10].map(index => store.getState().list?.items[index]?.projects)).toEqual([['Apollo 2'], ['Apollo 2']]);
    expect(calls('list.page')).toHaveLength(3);
    expect(calls('list.page')[2]).not.toHaveProperty('cursor');
  });

  it('opens an item by ref, can file it elsewhere but cannot remove it from Only me, and keeps the list on Back', async () => {
    const store = await startStore(); await store.openOnlyMe(); await store.openListItem(note); await flush();
    const reader = store.getState().reader!;
    expect(reader.from).toEqual({ kind: 'only-me' });
    expect(calls('open.ref')[0].ref).toEqual(note.ref);
    expect(store.hasReaderMenu(reader)).toBe(true);
    expect(store.canFile(reader)).toBe(true);
    expect(store.removableFrom()).toBeNull();
    expect(store.projectChoices().map(project => project.name)).toEqual(['Beacon']);
    expect(store.hasReaderMenu({ ...reader, ref: meeting.ref })).toBe(false);
    store.closeReader();
    expect(store.getState().route).toEqual({ page: 'only-me' });
    expect(store.getState().list?.items).toEqual([meeting, note]);
  });

  it('signing out clears Only me and its reader; signing in again lands on Home', async () => {
    const store = await startStore(); await store.openOnlyMe(); await store.openListItem(note);
    signedIn = false; await store.refreshStatus(); await flush();
    expect(store.getState()).toMatchObject({ route: { page: 'home' }, list: null, reader: null, barScope: { kind: 'global' } });
    signedIn = true; await store.refreshStatus(); await flush();
    expect(store.getState()).toMatchObject({ route: { page: 'home' }, list: null, reader: null });
  });

  it('a quiet save read holds the old meetings until the index is ready', async () => {
    const responses = [
      { items: [meeting, note], next_cursor: null, meetings_held: false },
      { items: [row('Held notes'), note], next_cursor: null, meetings_held: true },
      { items: [row('Indexed notes'), row('Held notes'), meeting, note], next_cursor: null, meetings_held: false },
    ];
    override('list.page', () => ok(responses.shift()));
    const store = await startStore(); await store.openOnlyMe();
    store.openCompose(); store.setComposeText('Held notes'); await store.sendCompose(); await flush();
    expect(calls('list.page')).toHaveLength(2);
    expect(store.getState().list?.items).toEqual([meeting, note]);
    store.openCompose(); store.setComposeText('Indexed notes'); await store.sendCompose(); await flush();
    expect(store.getState().list?.items.map(row => row.title)).toEqual(['Indexed notes', 'Held notes', 'Pricing review', 'Supplier call notes']);
  });

  it('Try again reads an unavailable list again without signing out', async () => {
    let first = true;
    override('list.page', () => first ? (first = false, fail('unavailable', { retryable: true })) : ok({ items: [note], next_cursor: null, meetings_held: false }));
    const store = await startStore(); await store.openOnlyMe();
    expect(store.getState().list).toMatchObject({ failure: { code: 'unavailable' }, items: [] });
    await store.retryList(); await flush();
    expect(store.getState().list?.items).toEqual([note]);
    expect(store.getState().list?.failure).toBeUndefined();
    expect(calls('list.page')).toHaveLength(2);
    expect(store.getState().status?.signed_in).toBe(true);
  });

  it.each(['project', 'only-me'] as const)('a refused %s list checks the account once per visit and does not sign out the same account', async scope => {
    override('list.page', () => fail('unauthorized'));
    const store = await startStore(); const before = calls('app.status').length;
    if (scope === 'project') await store.openProject(apollo); else await store.openOnlyMe();
    await flush();
    expect(store.getState().list?.failure?.code).toBe(scope === 'project' ? 'not_found' : 'unauthorized');
    expect(store.getState().status?.signed_in).toBe(true);
    expect(calls('app.status')).toHaveLength(before + 1);
    if (scope === 'project') await store.retryList();
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(calls('app.status')).toHaveLength(before + 1);
  });
});
