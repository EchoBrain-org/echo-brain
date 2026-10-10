import { validatePersonDiagnosticsResultV1, type PersonDiagnosticTargetV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonDiagnosticsV1, type CreatePersonDiagnosticsOptionsV1, type PersonDiagnosticsV1 } from '../src/composition/person-diagnostics-v1.js';

const applications: PersonDiagnosticsV1[] = [];
afterEach(() => { for (const application of applications.splice(0)) application.close(); });
const ask = { kind: 'ask' as const };
const run = { kind: 'trigger_run' as const, run_id: 'run_00000000-0000-4000-8000-000000000001' };
const actors = {
  owner: { organization_id: 'org-1', principal_id: 'person-1', membership_id: 'membership-1' },
  renewed: { organization_id: 'org-1', principal_id: 'person-1', membership_id: 'membership-1' },
  other: { organization_id: 'org-1', principal_id: 'person-2', membership_id: 'membership-2' },
  rejoined: { organization_id: 'org-1', principal_id: 'person-1', membership_id: 'membership-3' },
  organization: { organization_id: 'org-2', principal_id: 'person-1', membership_id: 'membership-1' },
};

function fixture(limits?: CreatePersonDiagnosticsOptionsV1['limits']) {
  let clock = Date.parse('2026-10-08T20:00:00.000Z');
  let clockFails = false;
  const revoked = new Set<string>();
  const application = createPersonDiagnosticsV1({
    sessions: { authenticateAccess({ access_token }) {
      const actor = actors[access_token as keyof typeof actors];
      if (actor === undefined || revoked.has(access_token)) throw new AuthorityOperationError('unauthorized', 'Session is not valid');
      return actor;
    } },
    now: () => { if (clockFails) throw new Error('broken diagnostic clock'); return clock; },
    ...(limits === undefined ? {} : { limits }),
  });
  applications.push(application);
  return {
    application,
    advance(ms: number) { clock += ms; },
    breakClock() { clockFails = true; },
    repairClock() { clockFails = false; },
    revoke(token: string) { revoked.add(token); },
    async prepare(target: PersonDiagnosticTargetV1 = ask, token = 'owner') {
      return validatePersonDiagnosticsResultV1('prepare', await application.prepare({ access_token: token, request: { schema_version: 1, operation: 'prepare', target } }));
    },
    async read(capture_id: `cap_${string}`, token = 'owner') {
      return validatePersonDiagnosticsResultV1('read', await application.read({ access_token: token, request: { schema_version: 1, operation: 'read', capture_id } }));
    },
  };
}

describe('private diagnostics for product requests', () => {
  it('selects only the exact owner/source/meeting once and keeps failed grounding private behind the read fence', async () => {
    const f = fixture();
    const target = { kind: 'meeting_extraction' as const, source_key: `pms_${'a'.repeat(64)}`, meeting_id: 'meeting-1' };
    const receipt = await f.prepare(target);
    await expect(f.prepare(target)).rejects.toMatchObject({ code: 'conflict' });
    const fence = vi.fn(async () => undefined);
    for (const actor of [actors.other, actors.rejoined, actors.organization]) {
      expect(f.application.claimMeeting({ actor, target, fence })).toBeUndefined();
      await expect(f.read(receipt.capture_id, actor === actors.other ? 'other' : actor === actors.rejoined ? 'rejoined' : 'organization')).rejects.toMatchObject({ code: 'not_found' });
    }
    for (const wrong of [{ ...target, meeting_id: 'meeting-2' }, { ...target, source_key: `pms_${'b'.repeat(64)}` }]) {
      expect(f.application.claimMeeting({ actor: actors.owner, target: wrong, fence })).toBeUndefined();
    }
    expect(await f.read(receipt.capture_id)).toMatchObject({ status: 'prepared' });
    const handle = f.application.claimMeeting({ actor: actors.owner, target, fence })!;
    expect(f.application.claimMeeting({ actor: actors.owner, target, fence })).toBeUndefined();
    handle.record({ kind: 'lifecycle', stage: 'grounding', event: 'failed', data: { quote: 'PRIVATE QUOTE', source_text: 'PRIVATE SOURCE' } });
    handle.fail(new Error('provider private error'));
    expect(await f.read(receipt.capture_id, 'renewed')).toMatchObject({ status: 'failed', trace: { events: [{ data: { quote: 'PRIVATE QUOTE', source_text: 'PRIVATE SOURCE' } }] } });
    fence.mockRejectedValueOnce(new AuthorityOperationError('stale_access_state', 'Access changed'));
    const revoked = await f.read(receipt.capture_id);
    expect(revoked).not.toHaveProperty('trace');
    await expect(f.read(receipt.capture_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not claim expired or closed meeting selections, including a broken observation clock', async () => {
    const f = fixture({ ttl_ms: 20 });
    const target = { kind: 'meeting_extraction' as const, source_key: `pms_${'a'.repeat(64)}`, meeting_id: 'meeting-1' };
    const input = { actor: actors.owner, target, fence: async () => undefined };
    await f.prepare(target);
    f.breakClock(); expect(f.application.claimMeeting(input)).toBeUndefined(); f.repairClock();
    f.advance(21); expect(f.application.claimMeeting(input)).toBeUndefined();
    await f.prepare(target); f.application.close(); expect(f.application.claimMeeting(input)).toBeUndefined();
  });

  it('prepares without work, hides running content, and releases exact snapshots only after a fresh fence on every read', async () => {
    const f = fixture();
    const receipt = await f.prepare();
    expect(await f.read(receipt.capture_id)).toMatchObject({ status: 'prepared' });
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    const event = { kind: 'model_request', call_id: 1, input: { user_prompt: ' PVT gate\n\nlinked E4 → fixture \t', schema: { properties: { value: { type: 'string' } } } } };
    handle.record(event);
    event.input.user_prompt = 'changed after emission';
    expect(await f.read(receipt.capture_id)).toMatchObject({ status: 'running' });
    expect(await f.read(receipt.capture_id)).not.toHaveProperty('trace');
    const fence = vi.fn(async () => undefined);
    handle.bindFence(fence);
    handle.record({ kind: 'model_response', call_id: 1, value: { actions: [{ tool: 'open', args: { id: 'E4' } }] } });
    handle.complete();
    const result = await f.read(receipt.capture_id);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'completed', trace: { complete: true, dropped_events: 0, events: [
      { sequence: 1, input: { user_prompt: ' PVT gate\n\nlinked E4 → fixture \t' } }, { sequence: 2 },
    ] } });
    (result.trace!.events[0]!.input as { user_prompt: string }).user_prompt = 'changed by first reader';
    handle.record({ kind: 'model_error', call_id: 9, error_kind: 'late' });
    handle.fail(new Error('late observer failure'));
    expect(await f.read(receipt.capture_id, 'renewed')).toMatchObject({ status: 'completed', trace: { events: [
      { input: { user_prompt: ' PVT gate\n\nlinked E4 → fixture \t' } }, { sequence: 2 },
    ] } });
    expect(fence).toHaveBeenCalledTimes(2);
  });

  it('binds selection to the actor and exact target and permits exactly one claim', async () => {
    const f = fixture();
    const receipt = await f.prepare(run);
    for (const token of ['other', 'rejoined', 'organization']) {
      expect(() => f.application.claim({ access_token: token, capture_id: receipt.capture_id, target: run })).toThrow(expect.objectContaining({ code: 'not_found' }));
      await expect(f.read(receipt.capture_id, token)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(() => f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: { ...run, run_id: 'run_another' } })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(await f.read(receipt.capture_id)).toMatchObject({ status: 'prepared' });
    f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: run });
    expect(() => f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: run })).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('releases failed-operation payloads only with a retained valid fence and sanitized error labels', async () => {
    const f = fixture();
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    handle.record({ kind: 'model_request', call_id: 1, input: { user_prompt: 'Authorized source content' } });
    const fence = vi.fn(async () => undefined);
    handle.bindFence(fence);
    handle.fail(new Error('provider detail must not enter diagnostics error'));
    const result = await f.read(receipt.capture_id);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'unavailable' }, trace: { events: [{ kind: 'model_request' }] } });
    expect(JSON.stringify(result)).not.toContain('provider detail');
    expect(fence).toHaveBeenCalledTimes(1);
  });

  it.each(['unauthorized', 'stale_access_state'] as const)('erases gathered payload immediately after %s rather than reviving it with later access', async code => {
    const f = fixture();
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    handle.record({ kind: 'tool_response', result: { text: 'Previously readable' } });
    const fence = vi.fn(async () => undefined);
    handle.bindFence(fence);
    handle.fail(new AuthorityOperationError(code, 'source access detail'));
    expect(await f.read(receipt.capture_id)).toMatchObject({ status: 'failed', error: { code } });
    expect(await f.read(receipt.capture_id)).not.toHaveProperty('trace');
    expect(fence).not.toHaveBeenCalled();
  });

  it('does not release failed or incorrectly completed captures before a source fence exists', async () => {
    const f = fixture();
    for (const terminal of ['fail', 'complete'] as const) {
      const receipt = await f.prepare();
      const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
      handle.record({ kind: 'lifecycle', stage: 'run', event: 'started', data: { question: 'private' } });
      if (terminal === 'fail') handle.fail(new Error('before desk'));
      else handle.complete();
      const result = await f.read(receipt.capture_id);
      expect(result).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
      expect(result).not.toHaveProperty('trace');
    }
  });

  it('removes an invalidated capture before a concurrent successful check can release it', async () => {
    const f = fixture();
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    handle.record({ kind: 'model_response', value: 'private' });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const fence = vi.fn().mockImplementationOnce(() => waiting).mockRejectedValueOnce(new AuthorityOperationError('unauthorized', 'revoked'));
    handle.bindFence(fence);
    handle.complete();
    const first = f.read(receipt.capture_id);
    const second = await f.read(receipt.capture_id);
    expect(second).toMatchObject({ status: 'failed', error: { code: 'unauthorized' } });
    expect(second).not.toHaveProperty('trace');
    release();
    await expect(first).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.read(receipt.capture_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('expires prepared/running payloads and uses a non-extending terminal reread window', async () => {
    const f = fixture({ ttl_ms: 1_000, reread_ms: 100 });
    const unused = await f.prepare();
    f.advance(1_000);
    expect(() => f.application.claim({ access_token: 'owner', capture_id: unused.capture_id, target: ask })).toThrow(expect.objectContaining({ code: 'not_found' }));
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    handle.bindFence(async () => undefined);
    handle.record({ kind: 'model_response', value: 'private' });
    handle.complete();
    const first = await f.read(receipt.capture_id);
    f.advance(50);
    expect((await f.read(receipt.capture_id)).expires_at).toBe(first.expires_at);
    f.advance(50);
    await expect(f.read(receipt.capture_id)).rejects.toMatchObject({ code: 'not_found' });
    const active = await f.prepare();
    const activeHandle = f.application.claim({ access_token: 'owner', capture_id: active.capture_id, target: ask });
    f.advance(1_000);
    expect(() => activeHandle.record({ kind: 'model_response', value: 'late after TTL' })).not.toThrow();
    await expect(f.read(active.capture_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('checks the reading session again after the execution fence finishes', async () => {
    const f = fixture();
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    let release!: () => void;
    handle.bindFence(() => new Promise<void>(resolve => { release = resolve; }));
    handle.record({ kind: 'model_response', value: 'private' });
    handle.complete();
    const reading = f.read(receipt.capture_id, 'renewed');
    f.revoke('renewed');
    release();
    await expect(reading).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.read(receipt.capture_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('preserves a capture and its original expiry when the caller cancels a pending release fence', async () => {
    const f = fixture({ ttl_ms: 1_000, reread_ms: 100 });
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    const fence = vi.fn().mockImplementationOnce((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })).mockResolvedValue(undefined);
    handle.bindFence(fence);
    handle.record({ kind: 'model_response', value: 'private' });
    handle.complete();
    const controller = new AbortController();
    const reading = f.application.read({ access_token: 'owner', request: { schema_version: 1, operation: 'read', capture_id: receipt.capture_id }, signal: controller.signal });
    f.advance(200); // Past the reread window that must not begin before release.
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    const resumed = await f.read(receipt.capture_id);
    expect(resumed).toMatchObject({ status: 'completed', trace: { events: [{ value: 'private' }] } });
    expect(Date.parse(resumed.expires_at)).toBe(Date.parse(receipt.expires_at) - 700);
    expect(fence).toHaveBeenCalledTimes(2);
  });

  it.each(['unauthorized', 'stale_access_state', 'not_found'] as const)('erases a genuine %s fence denial even when the reading caller also aborts', async code => {
    const f = fixture();
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    let rejectFence!: (error: unknown) => void;
    handle.bindFence(() => new Promise<void>((_resolve, reject) => { rejectFence = reject; }));
    handle.record({ kind: 'model_response', value: 'private' });
    handle.complete();
    const controller = new AbortController();
    const reading = f.application.read({ access_token: 'owner', request: { schema_version: 1, operation: 'read', capture_id: receipt.capture_id }, signal: controller.signal });
    controller.abort();
    rejectFence(new AuthorityOperationError(code, 'A concrete source denial'));
    expect(await reading).toMatchObject({ status: 'failed', error: { code } });
    await expect(f.read(receipt.capture_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never revives a capture whose read fence finishes after expiry or close', async () => {
    for (const expire of [true, false]) {
      const f = fixture({ ttl_ms: 1_000, reread_ms: 100 });
      const receipt = await f.prepare();
      const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
      let release!: () => void;
      handle.bindFence(() => new Promise<void>(resolve => { release = resolve; }));
      handle.record({ kind: 'model_response', value: 'private' });
      handle.complete();
      const reading = f.read(receipt.capture_id);
      if (expire) f.advance(1_000);
      else f.application.close();
      release();
      await expect(reading).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('bounds reserved captures globally and per actor without evicting other readable captures', async () => {
    const f = fixture({ max_captures: 2, max_captures_per_actor: 1, ttl_ms: 1_000 });
    const first = await f.prepare();
    await expect(f.prepare()).rejects.toMatchObject({ code: 'quota_exceeded' });
    const other = await f.prepare(ask, 'other');
    await expect(f.prepare(ask, 'organization')).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(await f.read(first.capture_id)).toMatchObject({ status: 'prepared' });
    expect(await f.read(other.capture_id, 'other')).toMatchObject({ status: 'prepared' });
    f.advance(1_000);
    expect(await f.prepare(ask, 'organization')).toMatchObject({ status: 'prepared' });
  });

  it('keeps observer failure and late shutdown callbacks outside the product outcome', async () => {
    const f = fixture();
    const receipt = await f.prepare();
    const handle = f.application.claim({ access_token: 'owner', capture_id: receipt.capture_id, target: ask });
    f.breakClock();
    expect(() => handle.record({ kind: 'model_response', value: 'safe event' })).not.toThrow();
    expect(() => handle.complete()).not.toThrow();
    expect(() => handle.fail(new Error('observed error'))).not.toThrow();
    f.repairClock();
    await expect(f.read(receipt.capture_id)).rejects.toMatchObject({ code: 'not_found' });
    f.application.close();
    expect(() => handle.record({ kind: 'model_response', value: 'late response' })).not.toThrow();
    await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' });
  });

});
