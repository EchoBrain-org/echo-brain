import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignOutSheet } from '../../src/renderer/store.js';
import { ACCOUNT, byTestId, fail, flush, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

let held: Held;
let signedIn: boolean;
const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method);
storeLifecycle();
beforeEach(() => {
  held = new Held();
  signedIn = true;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok({ signed_in: signedIn, account: signedIn ? ACCOUNT : null }),
    'account.signOut': () => { signedIn = false; return ok({ signed_in: false, account: null }); },
    'writes.status': () => ok({ state: 'not_saved' }),
  }, () => ({ active: [], archived: [] })));
});

describe('signing out while another operation finishes', () => {
  it.each(['sending', 'unknown'] as const)('holds the sign-out sheet until a %s save is settled', async status => {
    const store = await startStore();
    store.openCompose();
    store.setComposeText('Kickoff moved');
    const reply = held.hold('notes.submit');
    void store.sendCompose();
    await flush();
    if (status === 'unknown') { reply(fail('transport_failed', { mutation_outcome: 'unknown' })); await flush(); }
    store.accountCommand('signout');
    const { ConfirmSignOut } = await import('../../src/renderer/screens/account.js');
    const shown = () => render(ConfirmSignOut({ state: store.getState(), sheet: store.getState().sheet as SignOutSheet }));
    expect(text(shown())).toContain(status === 'sending' ? 'Finish the current save first.' : 'A save may not have arrived. Check it in Capture first.');
    expect(byTestId(shown(), 'confirm-signout')[0]!.props.disabled).toBe(true);
    await store.signOut();
    expect(calls('account.signOut')).toHaveLength(0);
    if (status === 'sending') { reply(ok({})); await flush(); }
    else await store.checkCompose();
    expect(byTestId(shown(), 'confirm-signout')[0]!.props.disabled).toBe(false);
    await store.signOut();
    expect(calls('account.signOut')).toHaveLength(1);
    expect(store.getState().status?.signed_in).toBe(false);
  });

  it('forgets the draft even when a status read showed sign-in before sign-out finished', async () => {
    const store = await startStore();
    store.openCompose();
    store.setComposeText('Half a thought');
    store.closeCompose();
    store.accountCommand('signout');
    const reply = held.hold('account.signOut');
    const out = store.signOut();
    await flush();
    signedIn = false;
    await store.refreshStatus();
    expect(store.getState().status?.signed_in).toBe(false);
    reply(ok({ signed_in: false, account: null }));
    await out;
    signedIn = true;
    await store.refreshStatus();
    expect(store.getState().status?.signed_in).toBe(true);
    expect(store.getState().compose).toBeNull();
  });

  it('leaves a sign-in begun while sign-out finishes alone', async () => {
    const store = await startStore();
    store.accountCommand('switch');
    const outReply = held.hold('account.signOut');
    const out = store.signOut();
    await flush();
    signedIn = false;
    await store.refreshStatus();
    store.accountCommand('signin');
    expect(store.getState().signin).toMatchObject({ phase: 'idle', form: true });
    const inReply = held.hold('signin.begin');
    const signing = store.signIn('https://fixture.invalid');
    await flush();
    expect(store.getState().signin.phase).toBe('waiting');
    outReply(ok({ signed_in: false, account: null }));
    await out;
    store.accountCommand('signin');
    expect(store.getState().signin.phase).toBe('waiting');
    expect(calls('signin.begin')).toHaveLength(1);
    signedIn = true;
    inReply(ok({ signed_in: true, account: ACCOUNT }));
    await signing;
    expect(store.getState().status?.signed_in).toBe(true);
    expect(store.getState().signin.phase).toBe('idle');
  });
});
