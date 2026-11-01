import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../src/shared/protocol.js';
import { ACCOUNT, byTestId, cover, fail, flush, Held, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text, uncover } from './harness.js';

const { rpc, dropFile } = vi.hoisted(() => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile }));
vi.mock('preact/hooks', original => plainHooks(original));

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

storeLifecycle();
beforeEach(() => {
  signedIn = true;
  active = [other];
  held = new Held();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok(signedIn ? { signed_in: true, account: ACCOUNT }
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

  it('goes on with the files that waited once the same person signs back in', async () => {
    const store = await startWithFiles();
    const upload = held.hold('documents.upload');
    await store.createProject();
    await flush();
    signedIn = false;
    await store.refreshStatus();
    await flush();
    upload(ok({ request_id: 'r1' }));
    await flush();
    expect(store.getState().sheet).toMatchObject({ files: [{ status: 'saved' }, { status: 'waiting' }, { status: 'waiting' }] });
    expect(uploads()).toHaveLength(1);
    signedIn = true;
    await store.refreshStatus();
    await flush();
    expect(uploads()).toHaveLength(3);
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().toast).toBe('Fresh is ready · 3 files');
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


const newProjectView = async (store: Awaited<ReturnType<typeof startStore>>) => {
  const sheet = store.getState().sheet;
  if (sheet?.kind !== 'new-project') throw new Error('Missing New project sheet');
  return render((await import('../../src/renderer/screens/new-project.js')).NewProject({ state: store.getState(), sheet }));
};

describe('New project before and after Create', () => {
  it('Cancel sends nothing and forgets picks; Create with no people or files closes without a toast', async () => {
    const store = await startWithPeople(); await store.chooseFiles(); store.closeSheet();
    expect(store.getState().sheet).toBeNull(); expect(store.getState().toast).toBeNull();
    expect(rpc.mock.calls.filter(([method]) => ['projects.create', 'projects.change', 'documents.upload', 'documents.abandon'].includes(method))).toHaveLength(0);
    store.openNewProject(); await flush();
    expect(store.getState().sheet).toMatchObject({ picks: [], files: [] });
    store.setNewProjectName('Fresh');
    const shown = await newProjectView(store);
    (byTestId(shown, 'new-project-name')[0]!.props.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault: vi.fn() });
    await flush();
    expect(store.getState()).toMatchObject({ route: { page: 'project', project: { name: 'Fresh' } }, sheet: null, toast: null });
    expect(rpc.mock.calls.filter(([method]) => method === 'projects.create')).toHaveLength(1);
  });

  it('an unknown member add holds back the rest, asks before closing, and retries the same request', async () => {
    const store = await startWithPeople(); await store.chooseFiles();
    held.hold('projects.change')(fail('unavailable', { retryable: true, mutation_outcome: 'unknown' }));
    await store.createProject(); await flush();
    const sheet = store.getState().sheet;
    if (sheet?.kind !== 'new-project') throw new Error('Missing New project sheet');
    expect(sheet.picks.map(pick => pick.status)).toEqual(['unknown', 'waiting']);
    expect(sheet.files.map(file => file.status)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(uploads()).toHaveLength(0); expect(adds()).toEqual([ann.membership_id]);
    store.closeSheet(); expect(store.getState().sheet).toMatchObject({ confirmClose: true });
    expect(text(await newProjectView(store))).toContain('Close? Someone may still have been added.');
    store.keepNewProject(); expect(store.getState().sheet).toMatchObject({ confirmClose: false });
    store.retryPick(sheet.picks[0]!.id); await flush();
    const requests = rpc.mock.calls.filter(([method]) => method === 'projects.change').map(([, params]) => params);
    expect(requests).toHaveLength(3); expect(requests[0]).toEqual(requests[1]);
    expect(requests[2].request_id).not.toBe(requests[0].request_id);
    expect(store.getState().sheet).toBeNull(); expect(store.getState().toast).toBe('Fresh is ready · 2 people, 3 files');
  });

  it('an unknown file holds back the rest; a cover hides people but accepts files, and Check status resumes', async () => {
    const store = await startWithFiles();
    held.hold('documents.upload')(fail('unavailable', { retryable: true, mutation_outcome: 'unknown' }));
    held.hold('writes.status')(ok({ state: 'saved' }));
    cover(store);
    const shown = await newProjectView(store);
    expect(byTestId(shown, 'member-row')).toHaveLength(0); expect(byTestId(shown, 'candidate-row')).toHaveLength(0);
    expect(byTestId(shown, 'new-project-file')).toHaveLength(3);
    dropFile.mockResolvedValue(ok({ handle: 'h9', name: 'A.txt' }));
    await store.dropFiles([new File(['a'], 'A.txt')]); await uncover(store);
    await store.createProject(); await flush();
    const sheet = store.getState().sheet;
    if (sheet?.kind !== 'new-project') throw new Error('Missing New project sheet');
    expect(sheet.files.map(file => file.status)).toEqual(['unknown', 'waiting', 'waiting', 'waiting']);
    expect(uploads()).toHaveLength(1); expect(sheet.hidden).toBe(false); expect(told().at(-1)).toEqual({ unresolved: true, file: true });
    store.closeSheet(); expect(store.getState().sheet).toMatchObject({ confirmClose: true }); store.keepNewProject();
    await store.checkFile(sheet.files[0]!.id); await flush();
    expect(uploads()).toHaveLength(4); expect(store.getState().sheet).toBeNull(); expect(store.getState().toast).toBe('Fresh is ready · 4 files');
  });
});
