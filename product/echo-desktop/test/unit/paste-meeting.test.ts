import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSON_HAND_IN_MEETING_MAX_BYTES_V1, personHandInMeetingV1, personHandInTextV1 } from '@echo-brain/organization-api';
import { isWriteCall, MAX_PASTED_MEETING_BYTES, pastedMeetingAsSent, pastedText, type AppStatus, type ConnectedTool } from '../../src/shared/protocol.js';
import { ACCOUNT, cover, elements, flush, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text, type Node } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
// The sheet is called as a function: its effects never run, as when the privacy cover has it away.
vi.mock('preact/hooks', original => plainHooks(original));

const granola = (status: ConnectedTool['status']): ConnectedTool => ({ tool_id: 'granola', name: 'Granola', status });
const PASTE: ConnectedTool = { tool_id: 'hand-in', name: 'Paste a meeting', status: 'linked' };
const review = { approval_id: `apr_${'b'.repeat(64)}`, title: 'Supplier sync', project_ids: [], status: 'pending', decided_on: null,
  first_line: 'Move the pilot to Friday.', action_count: 1, meeting_at: '2026-10-21T12:00:00.000Z', all_day: true, records: [] };
const meetingId = `hand-in-${'c'.repeat(64)}`;
let held: Held;
let tools: ConnectedTool[];
let status: Pick<AppStatus, 'signed_in' | 'account'>;

storeLifecycle();
beforeEach(() => {
  held = new Held();
  tools = [granola('unavailable'), PASTE];
  status = { signed_in: true, account: ACCOUNT };
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'app.status': () => ok(status),
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

  it('measures the meeting as the client sends it: the API\'s canonical text, with its time', () => {
    for (const value of ['\ufeff  Café notes\r\nline two\rline three \n\n', 'Decision:\u000bmove\u000cthe\u0085pilot\u2028to\u2029Friday.',
      '\u0000Mina\u0007 sends\u001b the\u007f revised\u0080 quote\u009f.', '\tDecisions\n\t- Move the pilot.\u000c']) {
      expect(pastedText(value)).toBe(personHandInTextV1(value));
    }
    const zone = 'Pacific/Auckland';
    const text = { title: ' Supplier\u0007 sync ', notes: 'Decision:\u2028move the pilot.\r\n', transcript: '\u000cMina Patel: Friday works.' };
    expect(pastedMeetingAsSent({ ...text, date: '2026-10-21' }, zone)).toEqual(personHandInMeetingV1({ ...text, date: '2026-10-21' }));
    expect(pastedMeetingAsSent({ ...text, started_at: '2026-10-21T22:30:00.000Z' }, zone))
      .toEqual(personHandInMeetingV1({ ...text, started_at: '2026-10-21T22:30:00.000Z', time_zone: zone }));
    expect(pastedMeetingAsSent(text, zone)).toEqual(personHandInMeetingV1(text));
  });
});

describe('Paste a meeting\'s draft', () => {
  /** The sheet as it shows now, and its Title field. */
  const sheet = async () => render((await import('../../src/renderer/screens/paste-meeting.js')).PasteMeeting({ tool: PASTE }));
  const title = (tree: unknown): Node => elements(tree).find(node => node.type === 'input')!;
  const type = async (value: string) => { (title(await sheet()).props.onInput as (event: unknown) => void)({ currentTarget: { value } }); };

  it('stays under the privacy cover, and goes when another account signs in, under the cover too', async () => {
    const store = await startStore();
    store.manageTool(PASTE);
    await type('Supplier sync');
    cover(store);
    expect(title(await sheet()).props.value).toBe('Supplier sync');
    status = { signed_in: true, account: { ...ACCOUNT, membership_id: 'another-member' } };
    await store.refreshStatus();
    await flush();
    expect(store.getState().sheet).toBeNull();
    expect(title(await sheet()).props.value).toBe('');
  });

  it('is measured as sent: its time counts, and line endings the API drops do not', async () => {
    await startStore();
    const field = async (match: (node: Node) => boolean, value: string) => {
      (elements(await sheet()).find(match)!.props.onInput as (event: unknown) => void)({ currentTarget: { value } });
    };
    const notes = (value: string) => field(node => node.type === 'textarea', value);
    const shown = async () => { const tree = await sheet(); return { line: text(elements(tree).find(node => node.props.role === 'status')),
      add: elements(tree).find(node => node.type === 'button' && text(node) === 'Add')!.props.disabled }; };
    await type('Supplier sync');
    await field(node => node.type === 'input' && node.props.type === 'date', '2026-10-21');
    (elements(await sheet()).find(node => node.props.type === 'checkbox')!.props.onChange as (event: unknown) => void)({ currentTarget: { checked: true } });
    // The text alone is exactly the bound; the whole day it is sent with takes it over.
    const fill = MAX_PASTED_MEETING_BYTES - JSON.stringify({ title: 'Supplier sync', notes: '', transcript: '' }).length;
    await notes('n'.repeat(fill));
    expect(await shown()).toEqual({ line: 'Too long to add: up to 60 KB of text.', add: true });
    // Past the bound as typed, its Windows line endings are line feeds as sent, so it fits.
    const typed = `${'n'.repeat(30_000)}${'\r\n'.repeat(500)}${'n'.repeat(30_000)}`;
    expect(JSON.stringify({ title: 'Supplier sync', notes: typed, transcript: '' }).length).toBeGreaterThan(MAX_PASTED_MEETING_BYTES);
    await notes(typed);
    expect(await shown()).toEqual({ line: '', add: false });
  });

  it('goes when its account signs out, and does not come back with it', async () => {
    const store = await startStore();
    store.manageTool(PASTE);
    await type('Supplier sync');
    cover(store);
    status = { signed_in: false, account: null };
    await store.refreshStatus();
    await flush();
    expect(title(await sheet()).props.value).toBe('');
    status = { signed_in: true, account: ACCOUNT };
    await store.refreshStatus();
    await flush();
    expect(title(await sheet()).props.value).toBe('');
  });
});
