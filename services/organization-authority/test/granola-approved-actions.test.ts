import { expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { openItemsFixture } from './fixtures/open-items.js';
import { EMP_A, SHARED, T, meetingWorld } from './fixtures/person-meeting-world.js';

it('keeps every approved action as a draft when impact research fails', async () => {
  const fixture = await openItemsFixture({ meetingActions: Array.from({ length: 25 }, (_, i) => ({
    signal_id: `act-${i}`, text: `Prepare document ${i}`, owner: 'Mina Patel', due_at: '2026-11-20T17:00:00.000Z',
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
  expect(recipient.item).toMatchObject({ item_id, state: 'open', expected: expect.stringContaining('Due 2026-11-20T17:00:00.000Z') });
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

it('reads the deadline approved for a meeting action', async () => {
  const due_at = '2026-11-20T17:00:00.000Z';
  const world = await meetingWorld({ extra: [{ name: 'r9', approval_id: 'apr_r9', projects: [SHARED], final_approver: EMP_A,
    issued_at: T(9), signals: { decisions: 1, actions: 1 },
    brief: brief => ({ ...brief, actions: brief.actions.map(action => ({ ...action, due_at })) }) }] });
  try {
    expect(world.route().recordActions({ access_token: 'emp_a', record_sha256: world.digest('r9') })).toMatchObject([{ due_at }]);
  } finally { world.close(); }
});
