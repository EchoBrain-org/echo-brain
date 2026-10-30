import { beforeEach, expect, it, vi } from 'vitest';
import type { AppStatus, Expect } from '../../src/shared/protocol.js';
import { ACCOUNT, byTestId, fileOf, flush, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text, timelineFiles } from './harness.js';
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
    // As the host does (ADR-0047): our own sign-out deletes the account's timeline, and reading one account's deletes every other's.
    'account.signOut': params => {
      if ((params as { again?: true }).again !== true) timelineFiles.delete(fileOf(params.expect as Expect));
      status = { signed_in: false, account: null, client_version: 'test' };
      return ok(status);
    },
    'timeline.read': params => {
      const own = fileOf(params.expect as Expect);
      for (const file of [...timelineFiles.keys()]) if (file !== own) timelineFiles.delete(file);
      return ok({ turns: structuredClone(timelineFiles.get(own) ?? []) });
    },
    'ask.run': () => ok({ text: 'Synthetic answer.', scope: { kind: 'global' }, sources: [], outcome: 'answered', parts: [] }),
  }, () => ({ active: [], archived: [] })));
});

it('keeps identical actions from different meetings distinguishable on Home, in its line and in their list', async () => {
  const store = await startStore();
  const { Home } = await import('../../src/renderer/screens/home.js');
  const one = followUp(1, { expected: 'Send the prototype' });
  const two = followUp(2, { expected: one.expected, decision: { ...one.decision!, title: 'Supplier review', record_sha256: 'sha256:' + '2'.repeat(64) } });
  const state = store.getState();
  const home = { ...state.home!, loading: false, reading: false, reviews: [], runs: [], failure: undefined,
    open: { send: [], items: [one, two], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false } };
  // At the top the two are one Update line, which names the newest by its qualified name.
  const top = render(Home({ state: { ...state, home } }));
  expect(text(byTestId(top, 'need-category')[0])).toMatch(/Send the prototype · from (Pilot planning|Supplier review)/);
  const rows = byTestId(render(Home({ state: { ...state, home, altitude: { ...state.altitude, category: 'update' } } })), 'need-row').map(text);
  expect(rows).toHaveLength(2);
  expect(new Set(rows).size, JSON.stringify(rows)).toBe(2);
});

it('forgets recent question text when explicit sign-out forgets the account, and its timeline with it', async () => {
  const store = await startStore();
  const question = 'What is the confidential acquisition plan?';
  await store.ask(question);
  store.closeAsk();
  expect(store.barSuggestions().map(suggestion => suggestion.question)).toContain(question);
  store.accountCommand('signout');
  await store.signOut();
  expect(store.getState().status?.signed_in).toBe(false);
  status = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions().map(suggestion => suggestion.question)).not.toContain(question);
});

it('keeps recent questions through an ordinary status refresh, and through an expired session signed in again', async () => {
  const store = await startStore();
  const question = 'What changed this week?';
  await store.ask(question);
  store.closeAsk();
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions().map(suggestion => suggestion.question)).toContain(question);
  // A session that merely ended keeps the file: the same person signing in again reads it back.
  status = { signed_in: false, account: null, client_version: 'test' };
  await store.refreshStatus();
  expect(store.getState().timeline.turns).toEqual([]);
  status = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions().map(suggestion => suggestion.question)).toContain(question);
});

it('forgets prior questions when another account signs in', async () => {
  const store = await startStore();
  const question = 'What is the confidential acquisition plan?';
  await store.ask(question);
  store.closeAsk();
  status = { signed_in: true, account: { ...ACCOUNT, membership_id: 'another-member' }, client_version: 'test' };
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions().map(suggestion => suggestion.question)).not.toContain(question);
  status = { signed_in: true, account: ACCOUNT, client_version: 'test' };
  await store.refreshStatus();
  await flush();
  expect(store.barSuggestions().map(suggestion => suggestion.question)).not.toContain(question);
});
