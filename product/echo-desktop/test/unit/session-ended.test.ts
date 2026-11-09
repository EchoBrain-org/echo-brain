// Once a refresh ended the session (the weekly sign-in passed, or the Authority
// refused it), the sign-in page says why (never that the account changed) and
// goes straight back to Google for the same organization. Nothing says so a
// day ahead.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStatus } from '../../src/shared/protocol.js';
import { ACCOUNT, byTestId, fail, flush, Held, ok, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const signedIn: AppStatus = { signed_in: true, client_version: '1', account: ACCOUNT };
const signedOut: AppStatus = { signed_in: false, account: null, client_version: '1' };
const weekly = { reason: 'reauthentication_required', authority: ACCOUNT.authority } as const;

let status: AppStatus;
const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method);

storeLifecycle();
beforeEach(() => {
  status = signedIn;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    'app.status': () => ok(status),
    // Google signs the same person back in, with a new week.
    'signin.begin': () => { status = signedIn; return ok(status); },
  }, () => ({ active: [], archived: [] })));
});

describe('a refresh that ended the session', () => {
  it('reads the account again at once, and the sign-in page says why', async () => {
    const store = await startStore();
    const statusReads = calls('app.status').length;
    status = { ...signedOut, session_ended: weekly };
    rpc.mockImplementationOnce(async () => fail('reauthentication_required'));
    await store.loadProjects();
    await flush();
    expect(calls('app.status').length).toBe(statusReads + 1);
    expect(store.getState().status).toEqual({ ...signedOut, session_ended: weekly });
  });

  it.each([
    ['reauthentication_required', 'ECHO asks you to sign in once a week.'],
    ['sign_in_required', 'Your sign-in ended.'],
  ] as const)('%s: says why, and Sign in again goes straight to the same organization', async (reason, why) => {
    status = { ...signedOut, session_ended: { reason, authority: ACCOUNT.authority } };
    const store = await startStore();
    const { SignedOut } = await import('../../src/renderer/screens/signin.js');
    const tree = SignedOut({ state: store.getState() });
    expect(text(tree)).toContain('Sign in again to use ECHO');
    expect(text(byTestId(tree, 'signin-reason'))).toBe(why);
    expect(byTestId(tree, 'signin-open')).toEqual([]);
    const [again] = byTestId(tree, 'signin-again');
    expect(text(again)).toBe('Sign in again');
    (again!.props.onClick as () => void)();
    await flush();
    expect(calls('signin.begin')[0]![1]).toEqual({ authority_url: ACCOUNT.authority });
  });

  it('a plain sign-out keeps the usual page', async () => {
    status = signedOut;
    const store = await startStore();
    const { SignedOut } = await import('../../src/renderer/screens/signin.js');
    const tree = SignedOut({ state: store.getState() });
    expect(text(tree)).toContain('Sign in to use ECHO');
    expect(byTestId(tree, 'signin-reason')).toEqual([]);
    expect(text(byTestId(tree, 'signin-open'))).toBe('Sign in…');
  });
});
