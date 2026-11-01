import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Employee } from '../../src/shared/protocol.js';
import { ACCOUNT, byTestId, cover, fail, flush, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text, uncover } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const ANA: Employee = { email: 'ana@example.com', display_name: 'Ana', membership: 'active', invitation: 'redeemed' };
const RAJ: Employee = { email: 'raj@example.com', display_name: 'Raj Kumar', membership: 'active', invitation: 'pending' };
const LEE: Employee = { email: 'lee@example.com', display_name: 'Lee', membership: 'revoked', invitation: 'expired' };
let held: Held;
let roster: Employee[];
let lost: boolean;
const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
const result = () => lost ? fail('unavailable', { retryable: true, mutation_outcome: 'unknown' }) : ok({ expires_at: '2026-11-03T12:00:00Z' });
storeLifecycle();
beforeEach(() => {
  held = new Held();
  roster = [ANA, RAJ, LEE];
  lost = false;
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok({ signed_in: true, account: { ...ACCOUNT, role: 'owner' } }),
    'employees.list': () => ok({ items: structuredClone(roster) }),
    'dialog.saveInvitation': () => ok({ handle: 'h1', name: 'Invitation' }),
    'employees.invite': p => {
      roster.push({ email: String(p.email), display_name: String(p.name), membership: 'active', invitation: 'pending' });
      return result();
    },
    'employees.reissue': () => result(),
    'employees.revoke': p => {
      roster = roster.map(person => person.email === p.email ? { ...person, membership: 'revoked', invitation: 'expired' } : person);
      return result();
    },
  }, () => ({ active: [], archived: [] })));
});

async function open() {
  const store = await startStore();
  store.openOrganization();
  await flush();
  const { Organization } = await import('../../src/renderer/screens/organization.js');
  const page = () => store.getState().organization!;
  const shown = () => render(Organization({ state: store.getState(), page: page() }));
  return { store, page, shown };
}

describe('People & invites', () => {
  it('never calls a lost invite reply done, and settles it only by reading the roster again', async () => {
    const { store, page, shown } = await open();
    store.setOrganizationField('name', 'Kim Lee');
    store.setOrganizationField('email', 'kim@example.com');
    lost = true;
    await store.inviteEmployee();
    const notice = 'The invitation may already have been issued. Refresh before trying again.';
    expect(page()).toMatchObject({ notice, items: null, write: { action: 'invite', status: 'unknown' }, saved: null });
    expect(byTestId(shown(), 'employee-row')).toHaveLength(0);
    expect(byTestId(shown(), 'invite')[0]!.props.disabled).toBe(true);
    expect(byTestId(shown(), 'invitation-show')).toHaveLength(0);
    store.setOrganizationField('name', 'Kim');
    store.setOrganizationField('name', 'Kim Lee');
    expect(page().notice).toBe(notice);
    cover(store);
    await uncover(store);
    await flush();
    expect(page()).toMatchObject({ notice: null, write: null });
    expect(page().items).toHaveLength(4);
    expect(store.shownEmployees(page()).map(person => person.email)).toEqual(['kim@example.com']);
    await store.inviteEmployee();
    expect(page().notice).toBe('This employee already has an invitation. Reissue it from their ⋯ menu.');
    expect(calls('employees.invite')).toHaveLength(1);
    const before = calls('employees.list').length;
    await store.loadEmployees();
    expect(calls('employees.list')).toHaveLength(before + 1);
    lost = false;
    store.setOrganizationField('name', 'Sam Wu');
    store.setOrganizationField('email', 'sam@example.com');
    await store.inviteEmployee();
    expect(byTestId(shown(), 'invite-undo')).toHaveLength(1);
    cover(store);
    expect(page().saved).toBeNull();
    await uncover(store);
    expect(byTestId(shown(), 'invite-undo')).toHaveLength(0);
    expect(calls('employees.revoke')).toHaveLength(0);
  });

  it('never lets a list read sent before a change settle it, and keeps Refresh in reach', async () => {
    const { store, page, shown } = await open();
    const late = held.hold('employees.list');
    const refreshing = store.loadEmployees();
    lost = true;
    store.askRevoke(RAJ);
    store.confirmRevoke();
    await flush();
    const notice = 'Access may already have been revoked. Refresh before trying again.';
    expect(page()).toMatchObject({ notice, items: null });
    late(ok({ items: [ANA, RAJ, LEE] }));
    await refreshing;
    expect(page()).toMatchObject({ notice, items: null, loading: false });
    expect(byTestId(shown(), 'employees-refresh')[0]!.props.disabled).toBe(false);
    await store.loadEmployees();
    expect(page()).toMatchObject({ notice: null, write: null });
    expect(page().items?.find(person => person.email === RAJ.email)).toMatchObject({ membership: 'revoked', invitation: 'expired' });
  });

  it('offers only available employee actions, asks before revoking, and identifies a reissued invitation', async () => {
    const { store, page, shown } = await open();
    expect(byTestId(byTestId(shown(), 'employee-row')[2], 'employee-more')).toHaveLength(0);
    store.toggleEmployeeMenu(ANA.email);
    expect(byTestId(shown(), 'employee-revoke')).toHaveLength(1);
    expect(byTestId(shown(), 'employee-reissue')).toHaveLength(0);
    store.toggleEmployeeMenu(ANA.email);
    expect(page().menu).toBeNull();
    store.askRevoke(RAJ);
    expect(text(byTestId(shown(), 'revoke-confirm'))).toContain('Revoke access for Raj Kumar?');
    store.cancelRevoke();
    expect(page().confirm).toBeNull();
    expect(calls('employees.revoke')).toHaveLength(0);
    await store.reissueInvitation(RAJ);
    expect(calls('dialog.saveInvitation')).toEqual([{ name: 'Raj Kumar', reissue: true }]);
    expect(text(byTestId(shown(), 'org-saved'))).toContain('New invitation for Raj Kumar saved; the previous one no longer works.');
    expect(byTestId(shown(), 'invite-undo')).toHaveLength(0);
    store.askRevoke(RAJ);
    store.confirmRevoke();
    await flush();
    expect(page().notice).toBe('Access revoked.');
    expect(calls('employees.revoke').map(p => p.email)).toEqual([RAJ.email]);
  });
});
