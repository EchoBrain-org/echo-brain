// The weekly sign-in: a day before it is due the sidebar says so and signs in
// again in one click; once a refresh ended the session, the sign-in page says
// why (never that the account changed) and goes straight back to Google for the
// same organization.
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStatus } from '../../src/shared/protocol.js';
import { ACCOUNT, Held, fail, flush, ok, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const HOUR = 60 * 60_000;
const DUE_AT = '2026-10-15T09:30:00.000Z';
/** Signed in, the weekly sign-in `left` away by the host's clock. */
const signedIn = (left: number): AppStatus => ({ signed_in: true, client_version: '1', account: { ...ACCOUNT, sign_in_due: { at: DUE_AT, in_ms: left } } });
const signedOut: AppStatus = { signed_in: false, account: null, client_version: '1' };
const weekly = { reason: 'reauthentication_required', authority: ACCOUNT.authority } as const;

let status: AppStatus;
const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method);
const order = () => rpc.mock.calls.map(([name]) => name as string).filter(name => name === 'account.signOut' || name === 'signin.begin');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  status = signedIn(30 * HOUR);
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    'app.status': () => ok(status),
    'account.signOut': () => { status = signedOut; return ok(status); },
    // Google signs the same person back in, with a new week.
    'signin.begin': () => { status = signedIn(7 * 24 * HOUR); return ok(status); },
  }, () => ({ active: [], archived: [] })));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Every node under a rendered component, depth first. */
function descendants(value: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as VNode<Record<string, unknown>>;
  return [node, ...descendants(node.props.children)];
}

/** A node's text, as it reads. */
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return text((value as VNode<{ children?: unknown }>).props.children);
}

const byTestId = (tree: VNode<Record<string, unknown>>[], id: string) => tree.find(node => node.props['data-testid'] === id);

describe('a day before the weekly sign-in', () => {
  it('says nothing earlier, and says so once that day starts with the window open all along', async () => {
    const store = await startStore();
    expect(store.getState().signInDue).toBeNull();
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(store.getState().signInDue).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().signInDue).toEqual({ at: DUE_AT });
  });

  it('says so at once when less than a day is left, and Sign in again ends this session, then signs the same person back in', async () => {
    status = signedIn(12 * HOUR);
    const store = await startStore();
    expect(store.getState().signInDue).toEqual({ at: DUE_AT });

    await store.signInAgain();
    await flush();
    expect(order()).toEqual(['account.signOut', 'signin.begin']);
    expect(calls('account.signOut')[0]![1]).toEqual({ expect: { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id } });
    expect(calls('signin.begin')[0]![1]).toEqual({ authority_url: ACCOUNT.authority });
    // A new week: nothing to say until its last day.
    expect(store.getState().status?.account?.membership_id).toBe(ACCOUNT.membership_id);
    expect(store.getState().signInDue).toBeNull();
    expect(store.getState().signin.phase).toBe('idle');
  });

  it('a sign-out that fails says why, and no sign-in starts', async () => {
    status = signedIn(12 * HOUR);
    const store = await startStore();
    rpc.mockImplementationOnce(async () => fail('unavailable', { retryable: true }));
    await store.signInAgain();
    await flush();
    expect(calls('signin.begin')).toHaveLength(0);
    expect(store.getState().status?.signed_in).toBe(true);
    expect(store.getState().signInDue).toEqual({ at: DUE_AT, failure: { code: 'unavailable', retryable: true } });
    expect(store.getState().signin.phase).toBe('idle');
  });

  it('the sidebar row names when, and says why in plain words', async () => {
    status = signedIn(12 * HOUR);
    const store = await startStore();
    const { SignInDueRow } = await import('../../src/renderer/screens/sidebar.js');
    const tree = descendants(SignInDueRow({ state: store.getState() }));
    expect(text(byTestId(tree, 'sidebar-sign-in-again'))).toMatch(/^Sign in again by .+ · Sign in$/);
    expect(text(byTestId(tree, 'sidebar-sign-in-note'))).toBe('ECHO asks you to sign in once a week.');
    // A save on its way is settled first, in the same words sign-out uses.
    const held = { ...store.getState(), signInDue: { at: DUE_AT, failure: { code: 'signout_held', retryable: true } } };
    expect(text(byTestId(descendants(SignInDueRow({ state: held })), 'sidebar-sign-in-note'))).toBe(store.settleWords(held));
    expect(SignInDueRow({ state: { ...store.getState(), signInDue: null } })).toBeNull();
  });
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
    const tree = descendants(SignedOut({ state: store.getState() }));
    expect(text(tree[0]!)).toContain('Sign in again to use ECHO');
    expect(text(byTestId(tree, 'signin-reason'))).toBe(why);
    expect(byTestId(tree, 'signin-open')).toBeUndefined();
    const again = byTestId(tree, 'signin-again')!;
    expect(text(again)).toBe('Sign in again');
    (again.props.onClick as () => void)();
    await flush();
    expect(calls('signin.begin')[0]![1]).toEqual({ authority_url: ACCOUNT.authority });
  });

  it('a plain sign-out keeps the usual page', async () => {
    status = signedOut;
    const store = await startStore();
    const { SignedOut } = await import('../../src/renderer/screens/signin.js');
    const tree = descendants(SignedOut({ state: store.getState() }));
    expect(text(tree[0]!)).toContain('Sign in to use ECHO');
    expect(byTestId(tree, 'signin-reason')).toBeUndefined();
    expect(text(byTestId(tree, 'signin-open'))).toBe('Sign in…');
  });
});
