import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, Held, ok, project, rpcFor, startStore, stubWindow } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const apollo = project(1, 30, { name: 'Apollo' });
const opened = { snapshot_sha256: `sha256:${'a'.repeat(64)}`, suggested_projects: [], owners: [], review: { status: 'pending' } };
let held: Held;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stubWindow();
  held = new Held();
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
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
