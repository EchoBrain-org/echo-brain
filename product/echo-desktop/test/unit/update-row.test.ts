// ADR-0035: the store behind the sidebar's one update row. Main owns the
// updater; the page shows its row and asks main to install what it shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../src/shared/protocol.js';
import { ACCOUNT, fail, flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const A = 'clean-v1-release-a';
const B = 'clean-v1-release-b';
const FRESH = project(99, 30, { name: 'Fresh' });
let held: Held;
/** What main's update.status answers. */
let row: UpdateState;
let install: () => unknown;
let membership: string;

/** The params of each call the page made to `name`, oldest first. */
const calls = (name: string) => rpc.mock.calls.filter(([method]) => method === name).map(([, params]) => params);
const installs = () => calls('update.install');

beforeEach(() => {
  vi.resetModules();
  stubWindow();
  held = new Held();
  row = { state: 'available', release: A };
  install = () => ok(null);
  membership = 'member';
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok({ signed_in: true, account: { ...ACCOUNT, membership_id: membership }, client_version: 'test' }),
    'update.status': () => ok(row),
    'update.install': () => install(),
    'account.signOut': () => ok({ signed_in: false, account: null, client_version: 'test' }),
    'dialog.openDocuments': () => ok({ files: [{ handle: 'h1', name: 'a.txt' }], refused: [] }),
    'projects.create': () => ok({ project_id: FRESH.project_id }),
    'projects.read': () => ok(FRESH),
    'documents.upload': params => ok({ request_id: params.request_id }),
    'writes.status': () => ok({ state: 'not_saved' }),
  }, () => ({ active: [], archived: [] })));
});

afterEach(() => { vi.unstubAllGlobals(); });

/** A note on its way: sign out, and so an update's restart, is held until it settles. */
async function saving(store: Awaited<ReturnType<typeof startStore>>) {
  store.openCompose();
  store.setComposeText('Kickoff moved');
  const reply = held.hold('notes.submit');
  void store.sendCompose();
  await flush();
  expect(store.signOutHeld()).toBe(true);
  return reply;
}

describe('the update row', () => {
  it('shows nothing until main says otherwise, then what main sends', async () => {
    const store = await startStore();
    expect(store.getState().update).toEqual({ state: 'none' });
    await store.readUpdate();
    expect(store.getState().update).toEqual({ state: 'available', release: A });
  });

  it('drops a status read that crossed a newer row from main', async () => {
    const store = await startStore();
    const reply = held.hold('update.status');
    const reading = store.readUpdate();
    store.updateChanged({ state: 'installing', release: A });
    reply(ok({ state: 'available', release: A }));
    await reading;
    expect(store.getState().update).toEqual({ state: 'installing', release: A });
  });

  it('keeps the row through sign out and a change of account: updates are not the account\'s', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    store.accountCommand('signout');
    await store.signOut();
    expect(store.getState().status?.signed_in).toBe(false);
    expect(store.getState().update).toEqual({ state: 'available', release: A });

    membership = 'someone-else';
    await store.refreshStatus();
    await flush();
    expect(store.getState().status?.account?.membership_id).toBe('someone-else');
    expect(store.getState().update).toEqual({ state: 'available', release: A });
  });
});

describe('installUpdate', () => {
  it.each([
    { state: 'available', release: A },
    { state: 'restart', release: B },
    { state: 'failed', release: A, reason: 'failed' },
  ] as const)('asks main to install the release on the row: $state', async next => {
    const store = await startStore();
    store.updateChanged(next);
    await store.installUpdate();
    expect(installs()).toEqual([{ release: next.release }]);
    expect(store.getState().updateFailure).toBeNull();
  });

  it.each([
    { state: 'none' },
    { state: 'installing', release: A },
    { state: 'failed', release: A, reason: 'location' },
  ] as const)('asks nothing of a row that is not a control: $state', async next => {
    const store = await startStore();
    store.updateChanged(next);
    await store.installUpdate();
    expect(installs()).toEqual([]);
  });

  it('refuses here, as sign out does, while a save is on its way, and installs once it settles', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    const reply = await saving(store);
    await store.installUpdate();
    expect(installs()).toEqual([]);
    expect(store.getState().updateFailure).toMatchObject({ code: 'update_held' });
    expect(store.settleWords()).toBe('Finish the current save first.');

    reply(ok({}));
    await flush();
    expect(store.signOutHeld()).toBe(false);
    // Nothing is held now, so nothing says to settle it.
    expect(store.getState().updateFailure).toBeNull();
    await store.installUpdate();
    expect(installs()).toEqual([{ release: A }]);
  });

  it('names an unknown save in sign out\'s words, drops the line once it is checked, and never brings it back', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    const reply = await saving(store);
    reply(fail('transport_failed', { mutation_outcome: 'unknown' }));
    await flush();
    expect(store.getState().compose?.status).toBe('unknown');
    await store.installUpdate();
    expect(installs()).toEqual([]);
    expect(store.getState().updateFailure).toMatchObject({ code: 'update_held' });
    expect(store.settleWords()).toBe('A save may not have arrived. Check it in Capture first.');

    // Checked, it did not arrive: nothing is held, so the line goes rather than turn untrue.
    const checked = held.hold('writes.status');
    const checking = store.checkCompose();
    expect(store.getState().compose?.status).toBe('checking');
    expect(store.getState().updateFailure).toMatchObject({ code: 'update_held' });
    checked(ok({ state: 'not_saved' }));
    await checking;
    expect(store.getState().compose?.status).toBe('error');
    expect(store.signOutHeld()).toBe(false);
    expect(store.getState().updateFailure).toBeNull();

    // The next save on its way does not bring back a line for a click that was not made.
    held.hold('notes.submit');
    void store.sendCompose();
    await flush();
    expect(store.signOutHeld()).toBe(true);
    expect(store.getState().updateFailure).toBeNull();
  });

  it('shows main\'s held refusal only while work is held, work only main holds for included', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    install = () => fail('update_held', { retryable: true });
    // Settled by the time the refusal came: there is nothing to settle.
    await store.installUpdate();
    expect(store.getState().updateFailure).toBeNull();

    // New project's file whose save is unknown: main's quit guard holds for it; sign out does not.
    store.openNewProject();
    await flush();
    store.setNewProjectName('Fresh');
    await store.chooseFiles();
    await flush();
    const upload = held.hold('documents.upload');
    await store.createProject();
    await flush();
    upload(fail('transport_failed', { mutation_outcome: 'unknown' }));
    await flush();
    expect(store.getState().sheet).toMatchObject({ kind: 'new-project', files: [{ status: 'unknown' }] });
    expect(store.signOutHeld()).toBe(false);
    await store.installUpdate();
    expect(installs()).toEqual([{ release: A }, { release: A }]);
    expect(store.getState().updateFailure).toMatchObject({ code: 'update_held' });

    // Checked, it never arrived: nothing is held, so the line goes.
    const sheet = store.getState().sheet;
    await store.checkFile(sheet?.kind === 'new-project' ? sheet.files[0]!.id : -1);
    await flush();
    expect(store.getState().sheet).toMatchObject({ kind: 'new-project', files: [{ status: 'failed' }] });
    expect(store.getState().updateFailure).toBeNull();
  });

  it('reads the row again, quietly, when it changed under the click', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    install = () => fail('update_changed');
    row = { state: 'restart', release: B };
    await store.installUpdate();
    expect(calls('update.status')).toHaveLength(1);
    expect(store.getState().update).toEqual({ state: 'restart', release: B });
    expect(store.getState().updateFailure).toBeNull();
  });

  it('keeps any other refusal under the row until the next click or a new row', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'failed', release: A, reason: 'failed' });
    install = () => fail('invalid_request');
    await store.installUpdate();
    expect(store.getState().updateFailure).toMatchObject({ code: 'invalid_request' });

    const reply = held.hold('update.install');
    const clicking = store.installUpdate();
    expect(store.getState().updateFailure).toBeNull();
    reply(fail('invalid_request'));
    await clicking;
    expect(store.getState().updateFailure).toMatchObject({ code: 'invalid_request' });
    store.updateChanged({ state: 'installing', release: A });
    expect(store.getState().updateFailure).toBeNull();
  });

  it('drops a refusal for a row main has replaced meanwhile', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    const reply = held.hold('update.install');
    const clicking = store.installUpdate();
    store.updateChanged({ state: 'available', release: B });
    reply(fail('invalid_request'));
    await clicking;
    expect(store.getState().updateFailure).toBeNull();
  });
});
