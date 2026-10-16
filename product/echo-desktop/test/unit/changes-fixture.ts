// Shared by the change check's unit tests (desktop refresh and notifications
// v1): an Authority whose fingerprints follow what it holds, as the real one's
// do, so a change made "elsewhere" moves exactly the areas it touches.
import { vi } from 'vitest';
import type { OpenItemsView, OpenItemView, ProjectSummary } from '../../src/shared/protocol.js';
import { ACCOUNT, digest, fail, flush, ok } from './harness.js';

export const ME: { membership_id: string; name: string; active: boolean } = { membership_id: ACCOUNT.membership_id, name: ACCOUNT.display_name, active: true };
export const MINA = { membership_id: 'mem_00000000-0000-4000-8000-000000000011', name: 'Mina Patel', active: true };
export const RAFAEL = { membership_id: 'mem_00000000-0000-4000-8000-000000000012', name: 'Rafael Moreno', active: true };
type Person = typeof ME;

const decision = {
  approval_id: 'apr_' + 'a'.repeat(64), record_sha256: 'sha256:' + '1'.repeat(64), title: 'Pilot planning', first_line: null,
  approved_at: '2026-10-14T09:00:00.000Z', project_ids: [],
};
export const id = (n: number) => `itm_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** n minutes past ten on the 14th: later changes have higher n. */
export const at = (n: number) => new Date(Date.UTC(2026, 9, 14, 10, n)).toISOString();

/** A meeting's action Mina approved and sent to you ("member") at `at(n)`. */
export function followUp(n: number, extra: Partial<OpenItemView> = {}): OpenItemView {
  return {
    item_id: id(n), run_id: 'run_00000000-0000-4000-8000-000000000001', kind: 'action', decision, relation: 'needs_updating', expected: `Action ${n}`,
    approver: MINA, owner: { ...ME, match: 'name' }, waits_on: 'owner', state: 'open', created_at: '2026-10-14T09:05:00.000Z',
    sent_at: at(n), state_set_at: at(n), state_set_by: MINA, owner_set_at: null, owner_set_by: null,
    send_included: true, check: null, can: { set_state: true, assign: true }, reach: 'not_read', ...extra,
  };
}

/** One you sent ("member" approved it) to `owner`, at `at(n)`. */
export function sent(n: number, owner: Person, extra: Partial<OpenItemView> = {}): OpenItemView {
  return followUp(n, { approver: ME, state_set_by: ME, owner: { ...owner, match: 'name' }, ...extra });
}

/** The same item changed by `by`: its state set, or its owner set, at `at(n)`. */
export function stated(item: OpenItemView, state: OpenItemView['state'], by: Person, n: number): OpenItemView {
  return { ...item, state, state_set_at: at(n), state_set_by: by };
}
export function owned(item: OpenItemView, owner: Person, by: Person, n: number): OpenItemView {
  return { ...item, owner: { ...owner, match: 'reassigned' }, owner_set_at: at(n), owner_set_by: by };
}

const summary: OpenItemsView['summary'] = { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] };

/**
 * What the Authority holds now. `items`: every follow-up the caller may read;
 * the ones they are involved in (approver, owner, or the last to hand it on)
 * make the follow-ups fingerprint, as the real check's do.
 */
export const authority = {
  items: [] as OpenItemView[],
  active: [] as ProjectSummary[],
  archived: [] as ProjectSummary[],
  reviews: [] as string[],
  /** How `changes.read` answers: as the Authority does, failing, or not there (an older Authority). */
  changes: 'ok' as 'ok' | 'fails' | 'not_supported',
  seconds: 60,
  /** An Authority that refuses the `involved` scope. */
  noInvolved: false,
  reset(): void {
    Object.assign(authority, { items: [], active: [], archived: [], reviews: [], changes: 'ok', seconds: 60, noInvolved: false });
  },
};

const involved = (item: OpenItemView, me = ME.membership_id) =>
  item.approver.membership_id === me || item.owner.membership_id === me || item.owner_set_by?.membership_id === me;

/** The handlers `rpcFor` takes for the change check, the follow-ups reads it makes, and Home's. */
export function changesHandlers(): Record<string, (params: Record<string, unknown>) => unknown> {
  return {
    'changes.read': () => {
      if (authority.changes === 'not_supported') return fail('not_supported');
      if (authority.changes === 'fails') return fail('unavailable', { retryable: true });
      const tuples = authority.items.filter(item => involved(item))
        .map(item => [item.item_id, item.state, item.owner.membership_id, item.owner_set_at, item.state_set_at, item.sent_at]);
      return ok({ kind: 'echo-person-changes-v1', check_again_after_seconds: authority.seconds, areas: {
        projects: digest(JSON.stringify([authority.active, authority.archived])), follow_ups: digest(JSON.stringify(tuples)), reviews: digest(JSON.stringify(authority.reviews)),
      } });
    },
    'runs': params => {
      const request = params.request as { operation: string; scope?: string; read?: string; states?: string[]; cursor?: string; item_id?: string };
      if (request.operation === 'items' && request.read === 'rows' && (request.scope === 'involved' || request.scope === 'mine')) {
        if (request.scope === 'involved' && authority.noInvolved) return fail('invalid_request');
        const mine = (item: OpenItemView) => item.approver.membership_id === ME.membership_id || item.owner.membership_id === ME.membership_id;
        const rows = authority.items.filter(item => (request.scope === 'involved' ? involved(item) : mine(item)) && (!request.states || request.states.includes(item.state)));
        const from = Number(request.cursor ?? 0);
        return ok({ items: rows.slice(from, from + 50), next_cursor: from + 50 < rows.length ? String(from + 50) : null, stages: [], summary });
      }
      if (request.operation === 'item') {
        const found = authority.items.find(item => item.item_id === request.item_id);
        return found ? ok(found) : fail('not_found');
      }
      if (request.operation === 'home') {
        const items = authority.items.filter(item => item.state === 'open' && item.owner.membership_id === ME.membership_id).slice(0, 20);
        return ok({ send: [], items, landed: 0, waiting: 0, last_checked_at: null, sweep_due: false });
      }
      if (request.operation === 'list') return ok({ runs: [] });
      if (request.operation === 'items') return ok({ items: [], next_cursor: null, stages: [], summary });
      throw new Error(`Unexpected runs operation: ${request.operation}`);
    },
  };
}

/** The next check, at the server's pace. */
export async function nextCheck(seconds = authority.seconds): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  await flush();
}
