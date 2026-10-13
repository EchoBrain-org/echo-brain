// ADR-0035: the store behind the sidebar's one update row. Main owns the
// updater; the page shows its row and asks main to install what it shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../src/shared/protocol.js';
import { ACCOUNT, fail, flush, Held, ok, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const A = 'clean-v1-release-a';
const B = 'clean-v1-release-b';
let held: Held;
/** What main's update.status answers. */
let row: UpdateState;
let install: () => unknown;
let membership: string;

const installs = () => rpc.mock.calls.filter(([method]) => method === 'update.install').map(([, params]) => params);
const statusReads = () => rpc.mock.calls.filter(([method]) => method === 'update.status').length;

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
    for (const next of [
      { state: 'installing', release: A }, { state: 'failed', release: A, reason: 'failed' },
      { state: 'failed', release: A, reason: 'location' }, { state: 'restart', release: B }, { state: 'none' },
    ] as const) {
      store.updateChanged(next);
      expect(store.getState().update).toEqual(next);
    }
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
    await store.installUpdate();
    expect(installs()).toEqual([{ release: A }]);
    expect(store.getState().updateFailure).toBeNull();
  });

  it('names the save to settle when its outcome is unknown, in sign out\'s words', async () => {
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
  });

  it('shows main\'s held refusal the same way', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    install = () => fail('update_held', { retryable: true });
    await store.installUpdate();
    expect(installs()).toEqual([{ release: A }]);
    expect(store.getState().updateFailure).toMatchObject({ code: 'update_held' });
  });

  it('reads the row again, quietly, when it changed under the click', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'available', release: A });
    install = () => fail('update_changed');
    row = { state: 'restart', release: B };
    await store.installUpdate();
    expect(statusReads()).toBe(1);
    expect(store.getState().update).toEqual({ state: 'restart', release: B });
    expect(store.getState().updateFailure).toBeNull();
  });

  it('keeps any other refusal under the row until the next click or a new row', async () => {
    const store = await startStore();
    store.updateChanged({ state: 'failed', release: A, reason: 'failed' });
    install = () => fail('invalid_request');
    await store.installUpdate();
    expect(store.getState().updateFailure).toMatchObject({ code: 'invalid_request' });

    install = () => ok(null);
    const reply = held.hold('update.install');
    const clicking = store.installUpdate();
    expect(store.getState().updateFailure).toBeNull();
    reply(ok(null));
    await clicking;

    install = () => fail('invalid_request');
    await store.installUpdate();
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
