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
  not_saved: 'It was not saved. Try again.',
  unsupported_invitation: 'Choose the invitation folder your organization owner sent you.',
  invitation_failed: 'Sign-in did not finish. Try again, or ask your organization owner for a new invitation.',
  signout_failed: 'Sign-out did not finish. Try again.',
  file_exists: 'A file with that name is already there. Choose a new name.',
  too_many_files: 'Add up to 20 files.',
  invalid_email: 'Enter the employee’s name and email address.',
  invalid_name: 'Enter the employee’s name and email address.',
  invitation_output_invalid: 'The invitation could not be saved there. Choose another place and try again.',
  employee_already_exists: 'Already a member. Refresh to check whether to reissue or sign in.',
  employee_onboarding_complete: 'This employee has already onboarded. Ask them to sign in.',
  request_rejected: 'That was refused. Refresh and try again.',
  owner_access_required: 'Only an organization owner can manage people.',
  invitation_save_failed: 'The invitation was made, but its file could not be saved. Refresh, then reissue it into another folder.',
  outcome_unknown: 'That was not sent. Check your connection and try again.',
};

export function message(failure: Failure): string {
  if (failure.mutation_outcome === 'unknown') return 'This may not have been sent.';
  return MESSAGES[failure.code] ?? 'Something went wrong. Try again.';
}
