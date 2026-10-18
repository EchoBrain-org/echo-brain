// How the person host tells a session that ended from an account that changed:
// why a refresh signed this computer out, whether the call that asked for the
// refresh is then made, and what a call that cannot run as the account the page
// shows says instead. The host process wires these in; they stay here so the
// decisions can be tested without one.
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

/** Why a call cannot run as the account the page shows: no one is signed in now, or someone else is. */
export function lost(current: AppStatus | null): 'signed_out' | 'account_changed' {
  return current?.signed_in === false ? 'signed_out' : 'account_changed';
}
