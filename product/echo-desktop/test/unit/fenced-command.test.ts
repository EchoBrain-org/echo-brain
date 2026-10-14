import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT, fail, flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const apollo = project(1, 30, { name: 'Apollo' });
const opened = { snapshot_sha256: `sha256:${'a'.repeat(64)}`, suggested_projects: [], owners: [], review: { status: 'pending' } };
let held: Held;
/** Status reads say signed out while set: the session ended elsewhere. */
let signedOut = false;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  held = new Held();
  signedOut = false;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok(signedOut ? { signed_in: false, account: null } : { signed_in: true, account: ACCOUNT }),
    'tools.meetings': params => {
      const request = params.request as { operation: string };
      if (request.operation === 'review_open') return ok(opened);
      if (request.operation === 'review') return ok({ status: 'approved', decided_on: 'desktop' });
      throw new Error(`Unexpected meeting operation: ${request.operation}`);
    },
  }, () => ({ active: [apollo], archived: [] })));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('a meeting command answered while another app is in front', () => {
  it('Approve that landed is shown as approved, not as a failure', async () => {
    const store = await startStore();
    await store.openDecision('apr_1');
    await flush();
    expect(store.getState().decision?.open).not.toBeNull();
    const review = held.hold('tools.meetings');
    const deciding = store.decide('approve');
    await flush();
    store.conceal();
    review(ok({ status: 'approved', decided_on: 'desktop' }));
    await deciding;
    store.resume();
    await flush();
    expect(store.getState().decision?.failure).toBeUndefined();
    expect(store.getState().route.page).toBe('home');
    expect(store.getState().toast).toBe('Approved · checking what it changes');
  });

  it('the decision read while away shows once ECHO is back', async () => {
    const store = await startStore();
    const open = held.hold('tools.meetings');
    const opening = store.openDecision('apr_1');
    await flush();
    store.conceal();
    open(ok(opened));
    await opening;
    store.resume();
    await flush();
    expect(store.getState().decision?.failure).toBeUndefined();
    expect(store.getState().decision?.open).not.toBeNull();
  });
});

describe('a write answered after the account changed', () => {
  // As the host says of a write it sent before a switch: it may have landed, unless the host says it never went.
  it.each([
    ['made', ok({ status: 'approved', decided_on: 'desktop' }), true, 'This may not have been sent.'],
    ['lost', fail('timeout', { retryable: true, mutation_outcome: 'unknown' }), true, 'This may not have been sent.'],
    ['never sent', fail('account_changed', { mutation_outcome: 'not_submitted' }), false, 'Your account changed. Try again.'],
  ])('Approve whose reply says it was %s is unknown only if it may have landed', async (_, reply, unknown, words) => {
    const store = await startStore();
    await store.openDecision('apr_1');
    await flush();
    const review = held.hold('tools.meetings');
    const deciding = store.decide('approve');
    await flush();
    signedOut = true;
    await store.refreshStatus();
    review(reply);
    await deciding;
    expect(store.getState().decision).toMatchObject({ busy: false, unknown, failure: words });
  });

  it('a read answered after the account changed is refused, with no outcome to settle', async () => {
    const store = await startStore();
    const open = held.hold('tools.meetings');
    const opening = store.openDecision('apr_1');
    await flush();
    signedOut = true;
    await store.refreshStatus();
    open(ok(opened));
    await opening;
    expect(store.getState().decision).toMatchObject({ loading: false, open: null, failure: 'Account changed.' });
    expect(store.getState().decision?.unknown).toBeUndefined();
  });
});

describe('the tray with another app in front', () => {
  it('Connected tools… opens Tools once ECHO comes forward', async () => {
    const store = await startStore();
    store.conceal();
    store.accountCommand('tools');
    store.resume();
    await flush();
    expect(store.getState().route.page).toBe('tools');
  });
});
