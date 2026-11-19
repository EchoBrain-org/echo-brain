import { expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { PERSON_IMPACT_CARD_LIMITS_V1 } from '@echo-brain/organization-api';
import { impactCardLineV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { openItemsFixture } from './fixtures/open-items.js';
import { EMP_A, SHARED, T, meetingWorld } from './fixtures/person-meeting-world.js';

it('keeps every approved action as a draft when impact research fails', async () => {
  const fixture = await openItemsFixture({ meetingActions: Array.from({ length: 25 }, (_, i) => ({
    signal_id: `act-${i}`, text: `Prepare document ${i}`, owner: 'Mina Patel', due_at: '2026-11-20T17:00:00.000Z', due_on: '2026-11-20',
  })) });
  fixture.research.mockImplementation(() => ({ renderWithResearch: async () => { throw new Error('research unavailable'); } }));
  await fixture.app.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id: fixture.runId } });
  await vi.waitFor(() => expect(fixture.runs.read(fixture.person, fixture.runId)!.state).toBe('done'), { interval: 1 });
  expect(fixture.items.forRun(fixture.runId)).toHaveLength(25);
  await fixture.app.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id: fixture.runId } });
  const drafts = fixture.items.forRun(fixture.runId);
  expect(drafts).toHaveLength(25);
  expect(drafts.every(row => row.state === 'unsent')).toBe(true);
  expect(JSON.parse(fixture.runs.read(fixture.person, fixture.runId)!.result_json!).status).toBe('not_assessed');
  const item_id = drafts[0]!.item_id;
  const request = { schema_version: 1, operation: 'send', run_id: fixture.runId, command_id: 'send-selected', items: [{ item_id, include: true }] } as const;
  await fixture.app.send({ access_token: 'ari', request });
  await fixture.app.send({ access_token: 'ari', request });
  const recipient = await fixture.app.item({ access_token: 'mina', request: { schema_version: 1, operation: 'item', item_id } });
  // The line is the action's own words; its deadline is the card's due date, a day.
  expect(recipient.item).toMatchObject({ item_id, state: 'open', expected: expect.stringMatching(/^Prepare document \d+$/u), due_on: '2026-11-20' });
  expect(fixture.items.forRun(fixture.runId).filter(row => row.state === 'unsent')).toHaveLength(24);
});

it('tries an outage again before it settles for an unassessed card', async () => {
  const fixture = await openItemsFixture({ meetingActions: [{ signal_id: 'act-0', text: 'Prepare the document', owner: 'Mina Patel' }] });
  fixture.research.mockImplementation(() => ({ renderWithResearch: async () => { throw new AuthorityOperationError('unavailable', 'model provider is down'); } }));
  const start = () => fixture.app.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id: fixture.runId } });
  // The first two outages queue the run again with nothing written: research can still succeed.
  for (const attempts of [1, 2]) {
    await start();
    await vi.waitFor(() => expect(fixture.runs.read(fixture.person, fixture.runId)).toMatchObject({ state: 'pending', attempts }), { interval: 1 });
    expect(fixture.items.forRun(fixture.runId)).toEqual([]);
  }
  // The attempt that would have failed the run keeps the meeting's own action instead.
  await start();
  await vi.waitFor(() => expect(fixture.runs.read(fixture.person, fixture.runId)!.state).toBe('done'), { interval: 1 });
  expect(JSON.parse(fixture.runs.read(fixture.person, fixture.runId)!.result_json!).status).toBe('not_assessed');
  expect(fixture.items.forRun(fixture.runId)).toHaveLength(1);
});

it("keeps a meeting action's whole line and gives its card the action's day, and none to an action without one", async () => {
  const long = `Prepare ${'the vendor contract and every annex '.repeat(4)}`.trim();
  const fixture = await openItemsFixture({ meetingActions: [
    { signal_id: 'act-0', text: long, owner: 'Mina Patel', due_at: '2026-11-20T12:00:00.000Z', due_on: '2026-11-20' },
    { signal_id: 'act-1', text: 'Book the pilot room', owner: 'Mina Patel' },
  ] });
  await fixture.finishImpactRun();
  const actions = fixture.items.forRun(fixture.runId).filter(row => row.pointer.kind === 'meeting_action').sort((left, right) => String(left.pointer.signal_id).localeCompare(String(right.pointer.signal_id)));
  expect(actions.map(row => [row.expected, row.due_on])).toEqual([[impactCardLineV1(long, PERSON_IMPACT_CARD_LIMITS_V1.expected_chars), '2026-11-20'], ['Book the pilot room', null]]);
  // What the impact card found carries no due date of its own.
  expect(fixture.items.forRun(fixture.runId).filter(row => row.pointer.kind !== 'meeting_action').every(row => row.due_on === null)).toBe(true);
});

/** One approved meeting whose actions are due at `due_at` (one action per entry), in a meeting held in `timezone` (none when undefined). */
async function dueWorld(due_at: string | readonly string[], timezone: string | undefined) {
  const dues = typeof due_at === 'string' ? [due_at] : due_at;
  return meetingWorld({ extra: [{ name: 'r9', approval_id: 'apr_r9', projects: [SHARED], final_approver: EMP_A,
    issued_at: T(9), signals: { decisions: 1, actions: dues.length },
    brief: brief => ({ ...brief, meeting: { ...brief.meeting, time: { actual_start_at: T(9), ...(timezone === undefined ? {} : { timezone }) } },
      actions: brief.actions.map((action, index) => ({ ...action, due_at: dues[index]! })) }) }] });
}

it('reads the deadline approved for a meeting action, and its day in the meeting\'s own time zone', async () => {
  const world = await dueWorld('2026-11-20T17:00:00.000Z', 'America/Los_Angeles');
  try {
    expect(world.route().recordActions({ access_token: 'emp_a', record_sha256: world.digest('r9') })).toMatchObject([{ due_at: '2026-11-20T17:00:00.000Z', due_on: '2026-11-20' }]);
  } finally { world.close(); }
});

it('keeps a date-only deadline on its day in a meeting held ahead of UTC', async () => {
  // Extraction stores "2026-11-20" as local noon in the meeting's zone: in Kiritimati (UTC+14) that is 22:00 on the 19th in
  // UTC, and still the 20th in the meeting.
  const world = await dueWorld('2026-11-19T22:00:00.000Z', 'Pacific/Kiritimati');
  try {
    expect(world.route().recordActions({ access_token: 'emp_a', record_sha256: world.digest('r9') })).toMatchObject([{ due_at: '2026-11-19T22:00:00.000Z', due_on: '2026-11-20' }]);
  } finally { world.close(); }
});

it('gives no day to a deadline whose day is not one the card can hold, and still gives the other actions theirs', async () => {
  // The record takes a year written with fewer than four digits in its local form; a card's day must never fail the run.
  const world = await dueWorld(['0999-11-20T12:00:00.000Z', '2026-11-20T12:00:00.000Z'], undefined);
  try {
    const actions = world.route().recordActions({ access_token: 'emp_a', record_sha256: world.digest('r9') });
    expect(actions.map(action => [action.due_at, action.due_on])).toEqual([['0999-11-20T12:00:00.000Z', undefined], ['2026-11-20T12:00:00.000Z', '2026-11-20']]);
  } finally { world.close(); }
});

it('reads a deadline in UTC when the meeting names no time zone, as extraction stored it', async () => {
  const world = await dueWorld('2026-11-20T12:00:00.000Z', undefined);
  try {
    expect(world.route().recordActions({ access_token: 'emp_a', record_sha256: world.digest('r9') })).toMatchObject([{ due_on: '2026-11-20' }]);
  } finally { world.close(); }
});
