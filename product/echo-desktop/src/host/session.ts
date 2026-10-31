// How the person host tells a session that ended from an account that changed:
// why a refresh signed this computer out, whether the call that asked for the
// refresh is then made, and what a call that cannot run as the account the page
// shows says instead, as status or the client's account pin says it. The host
// process wires these in; they stay here so the decisions can be tested without one.
import { SESSION_ENDED, type AppStatus, type SessionEnded } from '../shared/protocol.js';
import { lastJson, type CliRun } from './cli.js';
import { failureView } from './views.js';

/** Why a client run's refresh ended the session, as the client printed it; null for any other outcome. */
export function sessionEnded(run: CliRun): SessionEnded['reason'] | null {
  if (run.exit === 0 || run.overflow) return null;
  const { code } = failureView(lastJson(run.stderr), 'failed', false);
  return SESSION_ENDED.includes(code) ? code as SessionEnded['reason'] : null;
}

/**
 * After the gate's own refresh failed, whether the call that asked for it is not made and reports that refresh's
 * failure instead. A refresh that ended the session (the weekly sign-in passed, or the Authority refused it) left the
 * client signed out. One that never left the machine (no network yet) put the session back, still due: the call
 * would start with too little sign-in time left, and the next call tries the refresh again. After any other failure
 * the call runs, and its account check says signed out, or finds that another process refreshed meanwhile.
 */
export function refreshStops(refresh: CliRun, stillDue: boolean): boolean {
  return refresh.exit !== 0 && (sessionEnded(refresh) !== null || stillDue);
}

/** Why a call cannot run, or stand, as the account the page shows. */
export type Lost = SessionEnded['reason'] | 'signed_out' | 'account_changed';

/**
 * Why a call cannot run as the account the page shows: no one is signed in now (and why, when a refresh ended the
 * session), or someone else is.
 */
export function lost(current: AppStatus | null): Lost {
  if (current?.signed_in !== false) return 'account_changed';
  return current.session_ended?.reason ?? 'signed_out';
}

const LOST: readonly string[] = ['account_changed', 'signed_out', ...SESSION_ENDED];

/**
 * Why the client refused a run pinned to the page's account, as it printed it, and whether the run's request had
 * gone out (`sent`): refused before anything was sent, or under another account (or none) by the time it ended, its
 * output not for the page's. Null for any other outcome.
 */
export function pinRefusal(run: CliRun): { code: Lost; sent: boolean } | null {
  if (run.exit === 0) return null;
  const printed: unknown = lastJson(run.stderr);
  if (printed === null || typeof printed !== 'object') return null;
  const { code, sent } = printed as { code?: unknown; sent?: unknown };
  if (typeof sent !== 'boolean' || typeof code !== 'string' || !LOST.includes(code)) return null;
  return { code: code as Lost, sent };
}
