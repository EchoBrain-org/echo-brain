import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1 } from '@echo-brain/organization-api';
import { reviewsView } from '../../src/host/views.js';
import { isWriteCall } from '../../src/shared/protocol.js';
import { fail, Held, ok, rpcFor, startStore, storeLifecycle } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const review = { approval_id: `apr_${'b'.repeat(64)}`, title: 'SYNTHETIC STAGING CANARY', project_ids: [], status: 'pending', decided_on: null,
  first_line: 'Verify the release.', action_count: 0, meeting_at: null, all_day: false, records: [] };
const proposal = { review, snapshot_sha256: `sha256:${'a'.repeat(64)}`, participants: [], suggested_projects: [], reasons: [], records: [],
  items: [{ signal_id: 's1', kind: 'decision', text: 'Verify the release.', subject: null, status: 'decided', due_at: null, due_on: null,
    quotes: ['Verify the release.'], owner: null, owner_editable: false, project_ids: [] }] };
let tools: unknown;

storeLifecycle();
beforeEach(() => {
  tools = ok({ tools: [] });
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    'account.tools': () => tools,
    reviews: params => {
      const request = params.request as { operation: string };
      if (request.operation === 'reviews') return ok({ reviews: [review] });
      if (request.operation === 'review_open') return ok(proposal);
      if (request.operation === 'review') return ok({ status: 'publishing', decided_on: 'desktop' });
      throw new Error(`Unexpected review operation: ${request.operation}`);
    },
  }, () => ({ active: [], archived: [] })));
});

const requests = () => rpc.mock.calls.filter(([method]) => method === 'reviews').map(([, params]) => params.request);

describe('personal reviews are independent of the connector catalog', () => {
  it.each(['empty', 'unavailable', 'failed'])('shows staging approvals when tools are %s', async mode => {
    tools = mode === 'failed' ? fail('transport_failed') : ok({ tools: mode === 'unavailable' ? [{ tool_id: 'granola', name: 'Granola', status: 'unavailable' }] : [] });
    const store = await startStore();
    expect(store.getState().home).toMatchObject({ reviews: [review], loading: false });
    expect(store.homeRows()).toMatchObject([{ kind: 'approve', review: { approval_id: review.approval_id } }]);
    expect(requests()).toEqual([{ schema_version: 1, operation: 'reviews' }]);
    expect(rpc.mock.calls.some(([method]) => method === 'account.tools')).toBe(false);
  });

  it('opens and decides an approval without selecting a meeting provider', async () => {
    const store = await startStore();
    await store.openDecision(review.approval_id);
    expect(store.getState().decision?.open?.review).toEqual(review);
    await store.decide('approve');
    expect(requests()).toContainEqual({ schema_version: 1, operation: 'review_open', approval_id: review.approval_id });
    expect(requests()).toContainEqual(expect.objectContaining({ schema_version: 1, operation: 'review', approval_id: review.approval_id, action: 'approve' }));
    expect(requests().every(request => !('tool_id' in request))).toBe(true);
    expect(rpc.mock.calls.some(([method]) => method === 'tools.meetings' || method === 'account.tools')).toBe(false);
  });

  it('treats review reads as reads and decisions as writes', () => {
    expect(isWriteCall('reviews', { request: { operation: 'reviews' } })).toBe(false);
    expect(isWriteCall('reviews', { request: { operation: 'review_open' } })).toBe(false);
    expect(isWriteCall('reviews', { request: { operation: 'review' } })).toBe(true);
  });
});

// The Authority answers the list a page at a time, each within one response's bound, and the client reads every page and
// prints them as one list (ADR-0055). The host reads that list whole: a reviewer with more reviews than one response
// holds still gets every Approve row on Home.
describe('the host reads the list of reviews the client printed, however long', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const printed = (result: unknown) => ({ ok: true, result });

  it('takes a list longer than one response, each row checked, and nothing that is not a list of reviews', () => {
    const reviews = Array.from({ length: 30 }, (_, index) => ({ ...review, approval_id: `apr_${String(index).padStart(64, '0')}`, title: 'T'.repeat(40_000) }));
    expect(bytes({ reviews })).toBeGreaterThan(PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1);
    expect(reviewsView('reviews', printed({ reviews }))).toEqual({ reviews });
    expect(() => reviewsView('reviews', printed({ reviews: [...reviews, { ...review, title: '' }] }))).toThrow();
    expect(() => reviewsView('reviews', printed({ reviews, tool_id: 'hidden' }))).toThrow();
    expect(() => reviewsView('reviews', { ok: false, error: 'Person Authority request failed' })).toThrow();
  });

  it('still holds an opened review and a decision to one response', () => {
    expect(reviewsView('review_open', printed(proposal))).toEqual(proposal);
    expect(reviewsView('review', printed({ status: 'publishing', decided_on: 'desktop' }))).toEqual({ status: 'publishing', decided_on: 'desktop' });
    const past = { ...proposal, participants: ['P'.repeat(PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1)] };
    expect(() => reviewsView('review_open', printed(past))).toThrow('exceeds its bound');
  });
});
