import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../src/shared/protocol.js';
import { fail, flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const other = project(7, 20, { name: 'Other' });
const fresh: ProjectSummary = { ...project(99, 30, { name: 'Fresh' }), created_at: '2026-10-05T00:00:00.000Z' };
const ann = { membership_id: 'mem_aaaaaaaa-1111-4111-8111-111111111111', display_name: 'Ann' };
const bob = { membership_id: 'mem_bbbbbbbb-1111-4111-8111-111111111111', display_name: 'Bob' };
let signedIn: boolean;
let active: ProjectSummary[];
let held: Held;
const told = () => rpc.mock.calls.filter(([method]) => method === 'app.setUnresolved').map(([, params]) => params);
const adds = () => rpc.mock.calls.filter(([method]) => method === 'projects.change').map(([, params]) => (params as { change: { membership_id: string } }).change.membership_id);
const uploads = () => rpc.mock.calls.filter(([method]) => method === 'documents.upload');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  signedIn = true;
  active = [other];
  held = new Held();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok(signedIn ? { signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } }
      : { signed_in: false, account: null }),
    'people.directory': () => ok({ items: [ann, bob], next_cursor: null }),
    'projects.create': () => ok({ project_id: fresh.project_id }),
    'projects.read': () => ok(fresh),
    'projects.change': () => ok({}),
    'projects.leave': () => ok({}),
    'dialog.openDocuments': () => ok({ files: [{ handle: 'h1', name: 'a.txt' }, { handle: 'h2', name: 'b.txt' }, { handle: 'h3', name: 'c.txt' }], refused: [] }),
    'documents.upload': params => ok({ request_id: params.request_id }),
    'documents.abandon': () => ok(null),
  }, () => ({ active, archived: [] })));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function startWithPeople() {
  const store = await startStore();
  store.openNewProject();
  await flush();
  store.setNewProjectName('Fresh');
  const [first, second] = store.pickable();
  store.pickPerson(first!);
  store.pickPerson(second!);
  return store;
}

async function startWithFiles() {
  const store = await startStore();
  store.openNewProject();
  await flush();
  store.setNewProjectName('Fresh');
  await store.chooseFiles();
  await flush();
  return store;
}

describe('New project working out of sight', () => {
  it('survives leaving another project: its adds go on', async () => {
    const store = await startWithPeople();
    const firstAdd = held.hold('projects.change');
    await store.createProject();
    await flush();
    expect(store.getState().sheet).toMatchObject({ kind: 'new-project', hidden: true });
    store.toggleProjectSettings(other, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    await flush();
    expect(store.getState().toast).toBe('Left Other');
    expect(store.getState().sheet).toMatchObject({ kind: 'new-project', hidden: true });
    firstAdd(ok({}));
    await flush();
    expect(adds()).toEqual([ann.membership_id, bob.membership_id]);
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().toast).toBe('Fresh is ready · 2 people');
  });

  it('ends when its own project is left, saying what may not have gone in', async () => {
    const store = await startWithPeople();
    const firstAdd = held.hold('projects.change');
    await store.createProject();
    await flush();
    store.toggleProjectSettings(fresh, 'sidebar');
    store.askProjectSetting('leave');
    store.confirmProjectSetting();
    await flush();
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().toast).toBe('Some people may not have been added.');
    expect(told().at(-1)).toEqual({ unresolved: false });
    firstAdd(ok({}));
    await flush();
    expect(adds()).toEqual([ann.membership_id]);
  });

  it('stays, with the quit guard, when a status read says no one is signed in', async () => {
    const store = await startWithFiles();
    const upload = held.hold('documents.upload');
    await store.createProject();
    await flush();
    expect(told().at(-1)).toEqual({ unresolved: true, file: true });
    signedIn = false;
    await store.refreshStatus();
    await flush();
    expect(store.getState().sheet?.kind).toBe('new-project');
    expect(told().at(-1)).toEqual({ unresolved: true, file: true });
    upload(fail('account_changed', { mutation_outcome: 'unknown' }));
    await flush();
    expect(store.getState().sheet).toMatchObject({ kind: 'new-project', files: [{ status: 'unknown' }, { status: 'waiting' }, { status: 'waiting' }] });
    signedIn = true;
    await store.refreshStatus();
    await flush();
    expect(store.getState().sheet?.kind).toBe('new-project');
  });

  it('comes back for a file that was refused, so its reason shows', async () => {
    const store = await startWithFiles();
    let sent = 0;
    rpc.mockImplementation(rpcFor(held, {
      'projects.create': () => ok({ project_id: fresh.project_id }),
      'projects.read': () => ok(fresh),
      'documents.upload': params => (sent += 1) === 2 ? fail('invalid_request', { mutation_outcome: 'not_submitted' }) : ok({ request_id: params.request_id }),
      'documents.abandon': () => ok(null),
    }, () => ({ active, archived: [] })));
    await store.createProject();
    await flush();
    expect(uploads()).toHaveLength(3);
    expect(store.getState().sheet).toMatchObject({ kind: 'new-project', hidden: false, files: [{ status: 'saved' }, { status: 'failed' }, { status: 'saved' }] });
    expect(store.getState().toast).toBeNull();
    store.closeSheet();
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().toast).toBe('Some files may not have been saved.');
  });

  it('shows the bar\'s live matches while it works', async () => {
    const store = await startWithFiles();
    const upload = held.hold('documents.upload');
    await store.createProject();
    await flush();
    store.setBarText('launch plan');
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(store.getState().matches).toMatchObject({ query: 'launch plan', loading: false });
    expect(store.matchesShown()).toBe(true);
    upload(ok({ request_id: 'x' }));
  });
});
