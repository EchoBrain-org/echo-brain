import { describe, expect, it } from 'vitest';
import type { OpenItemView } from '../../src/shared/protocol.js';
import { byDecision, byOwner, byProject, needsAttention, rollup, unowned, waitedDays } from '../../src/renderer/altitude.js';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const person = (name: string) => ({ membership_id: `mem_${name.toLowerCase().replace(/\W/g, '')}`, name, active: true });
const decision = (title: string, approvedDaysAgo: number) => ({
  approval_id: `apr_${title}`, record_sha256: `sha256:${title}`, title, first_line: null, approved_at: ago(approvedDaysAgo), project_ids: ['prj_1'],
});

/** An open follow-up sent `sentDaysAgo` days ago to Mina, from Pilot planning, unless overridden. */
function item(overrides: Partial<OpenItemView> & { sentDaysAgo?: number } = {}): OpenItemView {
  const { sentDaysAgo = 0, ...rest } = overrides;
  return {
    item_id: `itm_${Math.random().toString(16).slice(2)}`, run_id: 'run_1', kind: 'action', decision: decision('Pilot planning', 5),
    relation: null, expected: 'Send the revised quote', approver: person('Ari'), owner: { ...person('Mina Patel'), match: 'name' },
    waits_on: 'owner', state: 'open', created_at: ago(sentDaysAgo), sent_at: ago(sentDaysAgo), state_set_at: ago(sentDaysAgo),
    state_set_by: person('Ari'), owner_set_at: null, owner_set_by: null, send_included: true, check: null,
    can: { set_state: true, assign: true }, reach: 'not_read', ...rest,
  };
}
const unsentItem = (createdDaysAgo: number, extra: Partial<OpenItemView> = {}) =>
  item({ state: 'unsent', created_at: ago(createdDaysAgo), sent_at: null, state_set_at: null, state_set_by: null, send_included: null, waits_on: 'approver', ...extra });

describe('needs attention', () => {
  it('flags a follow-up not sent for more than a day, and not one created hours ago', () => {
    expect(needsAttention(unsentItem(2), NOW)).toBe(true);
    expect(needsAttention(unsentItem(0.5), NOW)).toBe(false);
  });

  it('flags an open follow-up waiting more than three days since it was sent or last set', () => {
    expect(needsAttention(item({ sentDaysAgo: 4 }), NOW)).toBe(true);
    expect(needsAttention(item({ sentDaysAgo: 4, state_set_at: ago(1) }), NOW)).toBe(false);
    expect(needsAttention(item({ sentDaysAgo: 2 }), NOW)).toBe(false);
  });

  it('flags unsent work immediately after a day, without rounding away elapsed hours', () => {
    expect(needsAttention(unsentItem(1), NOW)).toBe(false);
    expect(needsAttention(unsentItem(1 + 1 / DAY), NOW)).toBe(true);
    expect(needsAttention(unsentItem(1.5), NOW)).toBe(true);
  });

  it('flags open work immediately after three days, while displaying only whole waiting days', () => {
    expect(needsAttention(item({ sentDaysAgo: 3 }), NOW)).toBe(false);
    expect(needsAttention(item({ sentDaysAgo: 3 + 1 / DAY }), NOW)).toBe(true);
    const waiting = item({ sentDaysAgo: 3.5 });
    expect(needsAttention(waiting, NOW)).toBe(true);
    expect(waitedDays(waiting, NOW)).toBe(3);
  });

  it('never flags a done or dismissed follow-up', () => {
    expect(needsAttention(item({ sentDaysAgo: 20, state: 'done' }), NOW)).toBe(false);
    expect(needsAttention(item({ sentDaysAgo: 20, state: 'not_relevant' }), NOW)).toBe(false);
  });

  it('flags a follow-up nobody can act on: ECHO fell back to the approver, or it waits on leads', () => {
    const fellBack = item({ owner: { ...person('Ari'), match: 'approver' } });
    expect(unowned(fellBack)).toBe(true);
    expect(needsAttention(fellBack, NOW)).toBe(true);
    expect(needsAttention(item({ waits_on: 'leads' }), NOW)).toBe(true);
    // An unsent follow-up waits on its approver as a matter of course: that is not "no owner".
    expect(unowned(unsentItem(0))).toBe(false);
  });

  it('counts whole days waited from when a follow-up last moved', () => {
    expect(waitedDays(item({ sentDaysAgo: 9.5 }), NOW)).toBe(9);
    expect(waitedDays(unsentItem(2), NOW)).toBe(2);
    expect(waitedDays(item({ state: 'done' }), NOW)).toBeNull();
  });
});

describe('roll-up', () => {
  it('is on track and empty with no follow-ups', () => {
    expect(rollup([], null, NOW)).toEqual({ done: 0, total: 0, needs: 0, health: 'on', oldest: null, faces: [] });
  });

  it('takes done and total from the counts when it has them', () => {
    const result = rollup([item()], { unsent: 1, open: 2, done: 3 }, NOW);
    expect(result.done).toBe(3);
    expect(result.total).toBe(6);
  });

  it('is at risk with one or two needing attention, off track with three', () => {
    expect(rollup([item({ sentDaysAgo: 4 })], null, NOW).health).toBe('risk');
    expect(rollup([item({ sentDaysAgo: 4 }), item({ sentDaysAgo: 5 })], null, NOW).health).toBe('risk');
    expect(rollup([item({ sentDaysAgo: 4 }), item({ sentDaysAgo: 5 }), unsentItem(2)], null, NOW).health).toBe('off');
  });

  it('is off track when one has waited more than seven days, and says how long the oldest waited', () => {
    const result = rollup([item({ sentDaysAgo: 8 }), item({ sentDaysAgo: 1 })], null, NOW);
    expect(result.health).toBe('off');
    expect(result.oldest).toBe(8);
    expect(result.needs).toBe(1);
  });

  it('goes off track immediately after seven days, while displaying seven whole waiting days', () => {
    expect(rollup([item({ sentDaysAgo: 7 })], null, NOW).health).toBe('risk');
    expect(rollup([item({ sentDaysAgo: 7 + 1 / DAY })], null, NOW).health).toBe('off');
    const result = rollup([item({ sentDaysAgo: 7.5 })], null, NOW);
    expect(result.health).toBe('off');
    expect(result.oldest).toBe(7);
  });

  it('shows each owner once, those needing attention first, and nobody for a follow-up with no owner', () => {
    const rafael = { ...person('Rafael Moreno'), match: 'name' as const };
    const result = rollup([
      item({ owner: rafael }), item({ sentDaysAgo: 5 }), item({ sentDaysAgo: 1 }),
      item({ owner: { ...person('Ari'), match: 'approver' } }),
    ], null, NOW);
    expect(result.faces).toEqual([
      { membership_id: 'mem_minapatel', name: 'Mina Patel', needs: true },
      { membership_id: 'mem_rafaelmoreno', name: 'Rafael Moreno', needs: false },
    ]);
  });
});

describe('groupings', () => {
  it('groups by owner, needing attention first, with no owner as its own group', () => {
    const rafael = { ...person('Rafael Moreno'), match: 'name' as const };
    const groups = byOwner([
      item({ owner: rafael }), item({ sentDaysAgo: 5 }), item({ owner: { ...person('Ari'), match: 'approver' } }),
      item({ state: 'done', owner: rafael }),
    ], NOW);
    expect(groups.map(group => [group.key, group.name, group.rows.length, group.done, group.total, group.needs])).toEqual([
      ['mem_minapatel', 'Mina Patel', 1, 0, 1, 1],
      ['none', 'No owner', 1, 0, 1, 1],
      ['mem_rafaelmoreno', 'Rafael Moreno', 2, 1, 2, 0],
    ]);
  });

  it('groups by decision, newest first, skipping follow-ups whose decision you cannot read', () => {
    const { decision: _hidden, ...unreadable } = item();
    const lines = byDecision([
      item({ decision: decision('Kickoff', 9) }), item({ state: 'done' }), item({ sentDaysAgo: 4 }), unreadable as OpenItemView,
    ], NOW);
    expect(lines.map(line => [line.title, line.done, line.total, line.needs])).toEqual([
      ['Pilot planning', 1, 2, 1],
      ['Kickoff', 0, 1, 0],
    ]);
  });

  it('keeps one owner’s follow-ups per project, in project order, leaving out projects with none', () => {
    const mina = item(), rafael = item({ owner: { ...person('Rafael Moreno'), match: 'name' } });
    const rows = new Map<string, readonly OpenItemView[]>([['prj_b', [rafael]], ['prj_a', [mina, rafael]], ['prj_c', [mina]]]);
    expect(byProject(rows, 'mem_minapatel')).toEqual([{ project_id: 'prj_a', rows: [mina] }, { project_id: 'prj_c', rows: [mina] }]);
  });
});
