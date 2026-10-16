import { describe, expect, it } from 'vitest';
import { changesLogLine, hostGoneFailure, isWriteCall, MAIN_METHODS, noticeOf, remoteDebuggingRequested, rpcLogName, versionLine } from '../../src/shared/protocol.js';

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
  it('names a runs call by its operation, and how much it read, and nothing else', () => {
    expect(rpcLogName('runs', { request: { schema_version: 1, operation: 'home' } })).toBe('runs.home');
    expect(rpcLogName('runs', { request: { schema_version: 1, operation: 'home', read: 'rows' } })).toBe('runs.home rows');
    const id = 'sha256:' + '1'.repeat(64);
    expect(rpcLogName('runs', { request: { operation: 'items', scope: 'record', id, states: ['unsent', 'open'], cursor: 'c2', read: 'rows' } })).toBe('runs.items rows');
    expect(rpcLogName('runs', { request: { operation: 'items', scope: 'project', id, read: 'counts' } })).toBe('runs.items counts');
    expect(rpcLogName('runs', { request: { operation: 'item', item_id: 'itm_00000001' } })).toBe('runs.item');
    // Anything the page made up stays out of the log.
    expect(rpcLogName('runs', { request: { operation: 'ECHO-12 Pilot launch' } })).toBe('runs');
    expect(rpcLogName('runs', { request: { operation: 'item', item_id: 'itm_00000001', read: 'ECHO-12' } })).toBe('runs.item');
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

describe('a notification', () => {
  const item = 'itm_00000000-0000-4000-8000-000000000001';
  const project = 'prj_00000001-1111-4111-8111-111111111111';

  it('is a method main answers, beside the change check\'s log line', () => {
    expect(MAIN_METHODS).toContain('notice.show');
    expect(MAIN_METHODS).toContain('log.changes');
    expect(MAIN_METHODS).not.toContain('notify.followUps');
  });

  it('carries one line and what a click opens: an item, Follow-ups or a project', () => {
    expect(noticeOf({ text: 'Mina handed you Update the pricing page', target: { kind: 'item', item_id: item } }))
      .toEqual({ text: 'Mina handed you Update the pricing page', target: { kind: 'item', item_id: item } });
    expect(noticeOf({ text: '3 follow-ups changed', target: { kind: 'follow-ups' } })).toEqual({ text: '3 follow-ups changed', target: { kind: 'follow-ups' } });
    expect(noticeOf({ text: 'You were added to Comet', target: { kind: 'project', project_id: project } }))
      .toEqual({ text: 'You were added to Comet', target: { kind: 'project', project_id: project } });
    // Two titles of 200 characters fit: "Mina handed <title> to <name>".
    expect(noticeOf({ text: `Mina handed ${'😀'.repeat(200)} to ${'x'.repeat(200)}`, target: { kind: 'follow-ups' } })).not.toBeNull();
  });

  it.each([
    ['nothing', null],
    ['no target', { text: 'Hi' }],
    ['no text', { target: { kind: 'follow-ups' } }],
    ['an empty line', { text: '  ', target: { kind: 'follow-ups' } }],
    ['a line break', { text: 'Hi\nthere', target: { kind: 'follow-ups' } }],
    ['a line over the bound', { text: 'x'.repeat(521), target: { kind: 'follow-ups' } }],
    ['text that is not text', { text: 7, target: { kind: 'follow-ups' } }],
    ['an id not an item\'s', { text: 'Hi', target: { kind: 'item', item_id: '../etc/passwd' } }],
    ['an id not a project\'s', { text: 'Hi', target: { kind: 'project', project_id: 'prj_x' } }],
    ['a target of another kind', { text: 'Hi', target: { kind: 'url', url: 'https://example.com' } }],
    ['a key the target does not take', { text: 'Hi', target: { kind: 'follow-ups', item_id: item } }],
    ['a key it does not take', { text: 'Hi', target: { kind: 'follow-ups' }, url: 'https://example.com' }],
  ])('refuses %s', (_name, params) => {
    expect(noticeOf(params)).toBeNull();
  });
});

describe('the change check in desktop.log', () => {
  it('names the areas that moved, in the contract\'s order, or that the Authority has none', () => {
    expect(changesLogLine({ moved: ['follow_ups', 'projects'] })).toBe('changes moved projects,follow_ups');
    expect(changesLogLine({ moved: ['reviews'] })).toBe('changes moved reviews');
    expect(changesLogLine({ unsupported: true })).toBe('changes unsupported');
  });

  it.each([
    ['nothing', null], ['no area', { moved: [] }], ['an area not known', { moved: ['sha256:abc'] }], ['an area twice', { moved: ['projects', 'projects'] }],
    ['a digest beside it', { moved: ['projects'], projects: 'sha256:abc' }], ['unsupported said otherwise', { unsupported: 'yes' }],
  ])('refuses %s', (_name, params) => {
    expect(changesLogLine(params)).toBeNull();
  });
});
