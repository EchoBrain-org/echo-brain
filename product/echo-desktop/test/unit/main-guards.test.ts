import { describe, expect, it } from 'vitest';
import { followUpsNotification, hostGoneFailure, isWriteCall, MAIN_METHODS, remoteDebuggingRequested, rpcLogName, versionLine } from '../../src/shared/protocol.js';

describe('remote debugging refusal', () => {
  const none = () => false;

  it('refuses every spelling Chromium accepts on the command line', () => {
    for (const argument of ['--remote-debugging-port=0', '-remote-debugging-port=0', '--remote-debugging-pipe', '-remote-allow-origins=*']) {
      expect(remoteDebuggingRequested(['/Applications/ECHO.app/Contents/MacOS/ECHO', argument, '--smoke'], none), argument).toBe(true);
    }
  });

  it('refuses a switch Chromium parsed even when argv does not show it', () => {
    const parsed = new Set(['remote-debugging-pipe']);
    expect(remoteDebuggingRequested(['/Applications/ECHO.app/Contents/MacOS/ECHO'], name => parsed.has(name))).toBe(true);
  });

  it('lets a clean launch through', () => {
    expect(remoteDebuggingRequested(['/Applications/ECHO.app/Contents/MacOS/ECHO', '--smoke'], none)).toBe(false);
  });
});

describe('a call no host answered', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';

  it('says a write no host took was never sent, so the caller can undo what it prepared', () => {
    expect(hostGoneFailure('host_restarted', true, requestId, false))
      .toEqual({ code: 'host_restarted', retryable: true, mutation_outcome: 'not_submitted', request_id: requestId });
    expect(hostGoneFailure('host_failed', true, undefined, false))
      .toEqual({ code: 'host_failed', retryable: true, mutation_outcome: 'not_submitted' });
  });

  it('says a write the host was holding may have landed', () => {
    expect(hostGoneFailure('host_restarted', true, requestId, true))
      .toEqual({ code: 'host_restarted', retryable: true, mutation_outcome: 'unknown', request_id: requestId });
  });

  it('gives a read no outcome, and drops a request id that is not a string', () => {
    expect(hostGoneFailure('host_restarted', false, 7, false)).toEqual({ code: 'host_restarted', retryable: true });
  });

  it('counts a read of runs or meetings as a read, and any other operation of them as a write', () => {
    expect(isWriteCall('runs', { request: { operation: 'items' } })).toBe(false);
    expect(isWriteCall('tools.meetings', { request: { operation: 'review_open' } })).toBe(false);
    expect(isWriteCall('runs', { request: { operation: 'send' } })).toBe(true);
    expect(isWriteCall('runs', { request: null })).toBe(true);
    expect(isWriteCall('projects.list', {})).toBe(false);
  });
});

describe('desktop.log and the Account menu', () => {
  it('names a runs call by its operation, and whether it read rows only or counts only, and nothing else', () => {
    expect(rpcLogName('runs', { request: { schema_version: 1, operation: 'home' } })).toBe('runs.home');
    expect(rpcLogName('runs', { request: { schema_version: 1, operation: 'home', rows_only: true } })).toBe('runs.home rows_only');
    const id = 'sha256:' + '1'.repeat(64);
    expect(rpcLogName('runs', { request: { operation: 'items', scope: 'record', id, states: ['unsent', 'open'], cursor: 'c2', rows_only: true } })).toBe('runs.items rows_only');
    expect(rpcLogName('runs', { request: { operation: 'items', scope: 'project', id, summary_only: true } })).toBe('runs.items summary_only');
    expect(rpcLogName('runs', { request: { operation: 'item', item_id: 'itm_00000001' } })).toBe('runs.item');
    // Anything the page made up stays out of the log.
    expect(rpcLogName('runs', { request: { operation: 'ECHO-12 Pilot launch' } })).toBe('runs');
    expect(rpcLogName('runs', { request: null })).toBe('runs');
    expect(rpcLogName('runs', null)).toBe('runs');
    expect(rpcLogName('projects.list', { request: { operation: 'home' } })).toBe('projects.list');
  });

  it('names the build beside the version, since releases share a version', () => {
    expect(versionLine('0.1.0-internal.1', { source_sha: '038f099aa4b1c2d3e4f5', dirty: false })).toBe('ECHO 0.1.0-internal.1 · 038f099');
    expect(versionLine('0.1.0-internal.1', { source_sha: '038f099aa4b1c2d3e4f5', dirty: true })).toBe('ECHO 0.1.0-internal.1 · 038f099 (modified)');
    expect(versionLine('0.1.0-internal.1', null)).toBe('ECHO 0.1.0-internal.1');
  });
});

describe('a follow-ups notification', () => {
  const id = (n: number) => `itm_00000000-0000-4000-8000-00000000000${n}`;

  it('is a method main answers', () => {
    expect(MAIN_METHODS).toContain('notify.followUps');
  });

  it('says who sent one follow-up and what it is, and counts several', () => {
    expect(followUpsNotification({ item_ids: [id(1)], from: 'Mina', title: 'Update the pricing page' }))
      .toEqual({ body: 'Mina sent you: Update the pricing page', item_id: id(1) });
    expect(followUpsNotification({ item_ids: [id(1), id(2), id(3)] })).toEqual({ body: '3 new follow-ups', item_id: null });
    expect(followUpsNotification({ item_ids: [id(1)], from: 'x'.repeat(200), title: '😀'.repeat(200) })).not.toBeNull();
  });

  it.each([
    ['nothing', null],
    ['no items', { item_ids: [] }],
    ['an id not an item\'s', { item_ids: ['../etc/passwd'], from: 'Mina', title: 'Hi' }],
    ['the same item twice', { item_ids: [id(1), id(1)] }],
    ['more than 50 items', { item_ids: Array.from({ length: 51 }, (_, n) => `itm_0000-${String(n).padStart(4, '0')}`) }],
    ['one item without who sent it', { item_ids: [id(1)], title: 'Hi' }],
    ['one item with an empty title', { item_ids: [id(1)], from: 'Mina', title: '  ' }],
    ['a title over 200 characters', { item_ids: [id(1)], from: 'Mina', title: 'x'.repeat(201) }],
    ['a line break', { item_ids: [id(1)], from: 'Mina', title: 'Hi\nthere' }],
    ['several with a title', { item_ids: [id(1), id(2)], title: 'Hi' }],
    ['a key it does not take', { item_ids: [id(1)], from: 'Mina', title: 'Hi', url: 'https://example.com' }],
    ['a name that is not text', { item_ids: [id(1)], from: 7, title: 'Hi' }],
  ])('refuses %s', (_name, params) => {
    expect(followUpsNotification(params)).toBeNull();
  });
});
