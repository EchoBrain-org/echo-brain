import { describe, expect, it } from 'vitest';
import { hostGoneFailure, isWriteCall, remoteDebuggingRequested } from '../../src/shared/protocol.js';

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
