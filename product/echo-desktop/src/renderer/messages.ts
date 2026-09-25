import type { Failure } from '../shared/protocol.js';

// The renderer's own words for every failure code. No server or client text
// is ever shown.
const MESSAGES: Record<string, string> = {
  account_changed: 'Your account changed. Try again.',
  signed_out: 'You are signed out.',
  unavailable: 'ECHO is unavailable right now. Try again.',
  transport_failed: 'ECHO cannot be reached. Check your connection and try again.',
  timeout: 'That took too long. Try again.',
  rate_limited: 'Too many requests. Try again in a moment.',
  not_found: 'This is no longer available to you.',
  unauthorized: 'Your access changed. Sign in again.',
  stale_access_state: 'Your access changed. Sign in again.',
  sign_in_required: 'Sign in again to continue.',
  invalid_request: 'That cannot be sent.',
  unsupported_file: 'Choose a TXT, Markdown, PDF or Word file up to 25 MB.',
  host_restarted: 'ECHO restarted. Try again.',
  signin_failed: 'Sign-in did not finish. Try again.',
  conflict: 'That changed meanwhile. Refresh and try again.',
  not_saved: 'It was not saved. Send it again.',
};

export function message(failure: Failure): string {
  if (failure.mutation_outcome === 'unknown') return 'This may not have been sent.';
  return MESSAGES[failure.code] ?? 'Something went wrong. Try again.';
}
