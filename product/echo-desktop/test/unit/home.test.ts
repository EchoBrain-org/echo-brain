import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonMeetingReviewV2, PersonRunV1 } from '@echo-brain/organization-api';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));

const approval = 'apr_' + 'a'.repeat(64);
let review: PersonMeetingReviewV2;
let run: PersonRunV1 | null;
let failNextList = false;

const impactRun = (state: PersonRunV1['state']): PersonRunV1 => ({
  run_id: 'run_00000000-0000-4000-8000-000000000020', trigger: 'approved_record', event_ref: approval, state,
  error_code: null, created_at: '2026-10-08T10:00:00.000Z', updated_at: '2026-10-08T10:05:00.000Z',
});
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const operations = () => rpc.mock.calls.filter(([method]) => method === 'runs').map(([, params]) => params.request.operation);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  review = { approval_id: approval, title: 'Private meeting', project_ids: [], status: 'pending', decided_on: null };
  run = null;
  failNextList = false;
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: { request?: { operation: string } }) => {
    const ok = (value: unknown) => ({ ok: true, value });
    switch (method) {
      case 'app.status': return ok({ signed_in: true, account: { authority: 'https://fixture.invalid', membership_id: 'member', display_name: 'Fixture', role: 'employee' } });
      case 'projects.list': return ok({ items: [], next_cursor: null });
      case 'app.setUnresolved': return ok(null);
      case 'account.tools': return ok({ tools: [{ tool_id: 'granola', status: 'linked' }] });
      case 'tools.meetings':
        if (params.request?.operation === 'reviews') return ok({ reviews: [{ ...review }] });
        if (params.request?.operation === 'review_open') return ok({ review: { ...review }, content: 'Private proposal text', suggested_projects: [], owners: [], snapshot_sha256: 'snapshot' });
        break;
      case 'runs':
        if (params.request?.operation === 'list') {
          if (failNextList) { failNextList = false; return { ok: false, failure: { code: 'unavailable', retryable: true } }; }
          return ok({ runs: run ? [{ ...run }] : [] });
        }
        if (params.request?.operation === 'start') { run = impactRun('running'); return ok({ state: 'running' }); }
        if (params.request?.operation === 'view') return ok({ status: 'assessed', decided: [], affected: [], unconfirmed: [], people: [], sources: [], hidden: 0, checked_at: '2026-10-08T10:05:00.000Z' });
    }
    throw new Error(`Unexpected request: ${method} ${params.request?.operation ?? ''}`);
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function start() {
  const store = await import('../../src/renderer/store.js');
  await store.refreshStatus();
  await flush();
  return store;
}

describe('Home decisions and impact checks', () => {
  it('covers meeting rows and a private decision when another app is in front', async () => {
    const store = await start();
    store.conceal();
    expect(store.pageCovered()).toBe(true);
    store.resume();
    await flush();
    await store.openDecision(store.getState().home!.rows[0]!);
    store.conceal();
    expect(store.pageCovered()).toBe(true);
  });

  it('keeps a publishing approval visible and discovers its run after publication', async () => {
    review = { ...review, status: 'publishing', decided_on: 'desktop' };
    const store = await start();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking', review: { status: 'publishing' } }]);
    expect(store.needsCount()).toBe(0);
    review = { ...review, status: 'approved' };
    run = impactRun('pending');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operations()).toContain('start');
    run = impactRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'impact', run: { state: 'done' } }]);
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
  });

  it('resumes a check after spending a polling interval in another app', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    store.conceal();
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
    store.resume();
    await flush();
    run = impactRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'impact', run: { state: 'done' } }]);
  });

  it('refreshes an open decision when its check finishes while the app is hidden', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    await store.openDecision(store.getState().home!.rows[0]!);
    store.conceal();
    await vi.advanceTimersByTimeAsync(5_000);
    run = impactRun('done');
    store.resume();
    await flush();
    expect(store.getState().decision?.run?.state).toBe('done');
    expect(store.getState().decision?.impact).toMatchObject({ status: 'assessed' });
  });

  it('keeps polling after one temporary runs-list failure', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    failNextList = true;
    await vi.advanceTimersByTimeAsync(5_000);
    run = impactRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'impact', run: { state: 'done' } }]);
  });

  it('reports an initial runs-list failure and recovers when Home is retried', async () => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    failNextList = true;
    const store = await start();
    expect(store.getState().home).toMatchObject({ loading: false, failure: { code: 'unavailable', retryable: true } });
    const requests = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.mock.calls).toHaveLength(requests);
    await store.loadHome();
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
  });

  it.each([false, true])('preserves and retries a failed resume with an open decision: %s', async (openCard) => {
    review = { ...review, status: 'approved', decided_on: 'desktop' };
    run = impactRun('running');
    const store = await start();
    if (openCard) await store.openDecision(store.getState().home!.rows[0]!);
    store.conceal();
    failNextList = true;
    store.resume();
    await flush();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'checking', run: { state: 'running' } }]);
    expect(store.getState().home?.failure).toMatchObject({ code: 'unavailable' });
    if (openCard) expect(store.getState().decision?.run?.state).toBe('running');
    // A second focus change must not strand the retry after stopping its timer.
    store.conceal();
    failNextList = true;
    store.resume();
    await flush();
    run = impactRun('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getState().home?.failure).toBeUndefined();
    expect(store.getState().home?.rows).toMatchObject([{ kind: 'impact', run: { state: 'done' } }]);
    if (openCard) {
      expect(store.getState().decision?.run?.state).toBe('done');
      expect(store.getState().decision?.impact).toMatchObject({ status: 'assessed' });
    }
  });
});
