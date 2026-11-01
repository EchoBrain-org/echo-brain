// The person host's side of a session that ends (the weekly sign-in, a refused
// refresh): what the call that asked for a refresh says, and that being signed
// out is never reported as another account.
import { describe, expect, it } from 'vitest';
import type { CliRun } from '../../src/host/cli.js';
import { lost, pinRefusal, refreshStops, sessionEnded } from '../../src/host/session.js';
import type { AppStatus } from '../../src/shared/protocol.js';

/** A failed `session-refresh`, its last stderr line as the person client prints it. */
const failed = (printed: Record<string, unknown>): CliRun =>
  ({ exit: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, action: 'session-refresh', ...printed })}\n`, overflow: false });

const WEEKLY = failed({ error: 'Person session requires authentication again', code: 'reauthentication_required' });
const REFUSED = failed({ error: 'Person session refresh was refused; sign in again', code: 'sign_in_required' });
/** Never left the machine: the client put the session back. */
const OFFLINE = failed({ error: 'Person Authority request failed', code: 'transport_failed', status: 0 });
/** May have reached the Authority: the client signed out, with no reason a sign-in would fix. */
const AMBIGUOUS = failed({ error: 'Person Authority request failed', code: 'unavailable', status: 503 });
/** The terminal CLI holds the refresh claim: its refresh decides. */
const ELSEWHERE = failed({ error: 'Person session refresh is already claimed; sign in again if it was interrupted' });

describe('a refresh the host ran before a call', () => {
  it('names the weekly sign-in and a refused refresh, and nothing else', () => {
    expect(sessionEnded(WEEKLY)).toBe('reauthentication_required');
    expect(sessionEnded(REFUSED)).toBe('sign_in_required');
    for (const run of [OFFLINE, AMBIGUOUS, ELSEWHERE]) expect(sessionEnded(run)).toBeNull();
    expect(sessionEnded({ exit: 0, stdout: '{"ok":true}\n', stderr: '', overflow: false })).toBeNull();
    // Output past the host's bound is not read.
    expect(sessionEnded({ ...WEEKLY, overflow: true })).toBeNull();
  });

  it('stops the call when it ended the session, though the client now reads as signed out and no longer due', () => {
    // The incident (2026-10-18): signed out by the weekly deadline, the call went on and said the account changed.
    expect(refreshStops(WEEKLY, false)).toBe(true);
    expect(refreshStops(REFUSED, false)).toBe(true);
  });

  it('stops the call when the session was put back still due, and lets it run otherwise', () => {
    expect(refreshStops(OFFLINE, true)).toBe(true);
    // Signed out after a refresh that may have reached the Authority: the call's account check says signed out.
    expect(refreshStops(AMBIGUOUS, false)).toBe(false);
    // Another process refreshes: the call waits it out through status.
    expect(refreshStops(ELSEWHERE, false)).toBe(false);
    expect(refreshStops({ exit: 0, stdout: '{"ok":true}\n', stderr: '', overflow: false }, false)).toBe(false);
  });
});

describe('a call that cannot run as the account the page shows', () => {
  const account = { authority: 'https://authority.example', membership_id: 'mem_2', display_name: 'Kim', role: 'employee' } as const;

  it('says why no one is signed in, and account changed only when someone else is', () => {
    const signedOut: AppStatus = { signed_in: false, account: null, client_version: '1' };
    expect(lost(signedOut)).toBe('signed_out');
    // A refresh ended the session (here or in another process): every call says so, not just the one that asked for it.
    expect(lost({ ...signedOut, session_ended: { reason: 'reauthentication_required', authority: 'https://authority.example' } })).toBe('reauthentication_required');
    expect(lost({ ...signedOut, session_ended: { reason: 'sign_in_required', authority: 'https://authority.example' } })).toBe('sign_in_required');
    expect(lost({ signed_in: true, account, client_version: '1' })).toBe('account_changed');
    // No status could be read: nothing says no one is signed in.
    expect(lost(null)).toBe('account_changed');
  });
});

describe('a call the client refused for the account it was pinned to', () => {
  /** A pinned run's refusal, as the person client prints it last on stderr. */
  const refusal = (code: string, sent: boolean): CliRun => ({ exit: 1, stdout: '', overflow: false,
    stderr: `${JSON.stringify({ ok: false, action: 'list', code, sent, error: 'Not signed in as the expected account; nothing was sent.' })}\n` });

  it('says why, and whether its request had gone out', () => {
    expect(pinRefusal(refusal('account_changed', false))).toEqual({ code: 'account_changed', sent: false });
    expect(pinRefusal(refusal('signed_out', false))).toEqual({ code: 'signed_out', sent: false });
    // A session that ended is told apart from an account that changed.
    expect(pinRefusal(refusal('reauthentication_required', false))).toEqual({ code: 'reauthentication_required', sent: false });
    expect(pinRefusal(refusal('sign_in_required', true))).toEqual({ code: 'sign_in_required', sent: true });
    expect(pinRefusal(refusal('account_changed', true))).toEqual({ code: 'account_changed', sent: true });
  });

  it('is nothing else the client prints: its own failures, a run that succeeded, or a code it never refuses with', () => {
    expect(pinRefusal(REFUSED)).toBeNull();
    expect(pinRefusal(failed({ error: 'Signed out', code: 'sign_in_required' }))).toBeNull();
    expect(pinRefusal(refusal('unavailable', false))).toBeNull();
    expect(pinRefusal({ ...refusal('account_changed', false), exit: 0 })).toBeNull();
    expect(pinRefusal({ exit: 1, stdout: '', stderr: 'not json\n', overflow: false })).toBeNull();
  });
});
