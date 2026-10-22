import { beforeEach, expect, it, vi } from 'vitest';
import type { AppStatus } from '../../src/shared/protocol.js';
import { ACCOUNT, byTestId, flush, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';
import { followUp } from './changes-fixture.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

let status: AppStatus;
storeLifecycle();
beforeEach(() => {
  status = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    'app.status': () => ok(status),
    'account.signOut': () => { status = { signed_in: false, account: null, client_version: 'test' }; return ok(status); },
    'ask.run': () => ok({ text: 'Synthetic answer.', scope: { kind: 'global' }, sources: [], outcome: 'answered', parts: [] }),
  }, () => ({ active: [], archived: [] })));
});

it('keeps identical actions from different meetings distinguishable on Home', async () => {
  const store = await startStore();
  const { Home } = await import('../../src/renderer/screens/home.js');
  const one = followUp(1, { expected: 'Send the prototype' });
  const two = followUp(2, { expected: one.expected, decision: { ...one.decision!, title: 'Supplier review', record_sha256: 'sha256:' + '2'.repeat(64) } });
  const state = store.getState();
  const home = { ...state.home!, loading: false, reading: false, reviews: [], runs: [], failure: undefined,
    open: { send: [], items: [one, two], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false } };
  const rows = byTestId(render(Home({ state: { ...state, home } })), 'need-row').map(text);
  expect(rows).toHaveLength(2);
  expect(new Set(rows).size, JSON.stringify(rows)).toBe(2);
});

it('forgets recent question text when explicit sign-out forgets the account', async () => {
  const store = await startStore();
  const question = 'What is the confidential acquisition plan?';
  await store.ask(question);
  store.closeAsk();
  expect(store.barSuggestions()).toContain(question);
  store.accountCommand('signout');
  await store.signOut();
  expect(store.getState().status?.signed_in).toBe(false);
  status = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions()).not.toContain(question);
});

it('keeps recent questions through an ordinary status refresh', async () => {
  const store = await startStore();
  const question = 'What changed this week?';
  await store.ask(question);
  store.closeAsk();
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions()).toContain(question);
});

it('forgets prior questions when another account signs in', async () => {
  const store = await startStore();
  const question = 'What is the confidential acquisition plan?';
  await store.ask(question);
  store.closeAsk();
  status = { signed_in: true, account: { ...ACCOUNT, membership_id: 'another-member' }, client_version: 'test' };
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions()).not.toContain(question);
  status = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions()).not.toContain(question);
});
