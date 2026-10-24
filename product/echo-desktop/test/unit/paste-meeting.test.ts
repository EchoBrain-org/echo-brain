import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSON_HAND_IN_MEETING_MAX_BYTES_V1 } from '@echo-brain/organization-api';
import { isWriteCall, MAX_PASTED_MEETING_BYTES, type ConnectedTool } from '../../src/shared/protocol.js';
import { ACCOUNT, flush, Held, ok, rpcFor, startStore, storeLifecycle } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const granola = (status: ConnectedTool['status']): ConnectedTool => ({ tool_id: 'granola', name: 'Granola', status });
const PASTE: ConnectedTool = { tool_id: 'hand-in', name: 'Paste a meeting', status: 'linked' };
const review = { approval_id: `apr_${'b'.repeat(64)}`, title: 'Supplier sync', project_ids: [], status: 'pending', decided_on: null,
  first_line: 'Move the pilot to Friday.', action_count: 1, meeting_at: '2026-10-21T12:00:00.000Z', all_day: true, records: [] };
const meetingId = `hand-in-${'c'.repeat(64)}`;
let held: Held;
let tools: ConnectedTool[];

storeLifecycle();
beforeEach(() => {
  held = new Held();
  tools = [granola('unavailable'), PASTE];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'account.tools': () => ok({ tools }),
    'tools.meetings': params => {
      const request = params.request as { operation: string };
      if (request.operation === 'reviews') return ok({ reviews: [review] });
      throw new Error(`Unexpected meeting operation: ${request.operation}`);
    },
    'meetings.handIn': () => ok({ meeting_id: meetingId }),
  }, () => ({ active: [], archived: [] })));
});
/** The tool each reviews read went through. */
const reviewReads = () => rpc.mock.calls.filter(([method, params]) => method === 'tools.meetings' && params.request.operation === 'reviews').map(([, params]) => params.request.tool_id);

describe('Home reads meeting reviews through any meeting tool', () => {
  it('through Paste a meeting when Granola is not turned on', async () => {
    const store = await startStore();
    expect(store.getState().home).toMatchObject({ meetings: true, reviews: [review] });
    expect(store.homeRows()).toMatchObject([{ kind: 'approve', review: { approval_id: review.approval_id } }]);
    expect(reviewReads()).toEqual(['hand-in']);
  });

  it('through Granola when both are there, and through Paste a meeting once Granola goes', async () => {
    tools = [granola('linked'), PASTE];
    const store = await startStore();
    expect(reviewReads()).toEqual(['granola']);
    tools = [granola('unavailable'), PASTE];
    await store.loadHome();
    expect(reviewReads()).toEqual(['granola', 'hand-in']);
    expect(store.homeRows().map(row => row.kind)).toEqual(['approve']);
  });

  it('through none when no meeting tool is there', async () => {
    tools = [granola('unavailable')];
    const store = await startStore();
    expect(store.getState().home).toMatchObject({ meetings: false, reviews: [] });
    expect(reviewReads()).toEqual([]);
  });
});

describe('Paste a meeting', () => {
  it('is a write whose sheet stays up while it is on its way', async () => {
    const store = await startStore();
    expect(isWriteCall('meetings.handIn', { meeting: {} })).toBe(true);
    store.manageTool(PASTE);
    const release = held.hold('meetings.handIn');
    const meeting = { title: 'Supplier sync', notes: 'Move the pilot to Friday.', transcript: '', date: '2026-10-21' };
    const pasting = store.handInMeeting(meeting, null);
    await flush();
    expect(store.getState().sheet).toMatchObject({ kind: 'tool-manage', busy: true });
    // Escape and Close wait for it.
    store.closeSheet();
    expect(store.getState().sheet).toMatchObject({ kind: 'tool-manage', tool: PASTE });
    release(ok({ meeting_id: meetingId }));
    await expect(pasting).resolves.toEqual({ meeting_id: meetingId });
    expect(store.getState().sheet).toMatchObject({ kind: 'tool-manage', busy: false });
    expect(rpc.mock.calls.filter(([method]) => method === 'meetings.handIn').map(([, params]) => params))
      .toEqual([{ expect: { authority: ACCOUNT.authority, membership_id: ACCOUNT.membership_id }, meeting, project_id: null }]);
    store.closeSheet();
    expect(store.getState().sheet).toBeNull();
  });

  it('checks the meetings API\'s own bound before sending', () => {
    expect(MAX_PASTED_MEETING_BYTES).toBe(PERSON_HAND_IN_MEETING_MAX_BYTES_V1);
  });

});

