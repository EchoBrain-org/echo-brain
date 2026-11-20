import type { Failure, ToolStatus } from '../shared/protocol.js';

// The renderer's own words for every failure code. No server or client text
// is ever shown: each code a request can fail with has words a person can act
// on, and only a code truly unknown falls back to the generic line.
const MESSAGES: Record<string, string> = {
  account_changed: 'Your account changed. Try again.',
  signed_out: 'You are signed out.',
  unavailable: 'ECHO is unavailable right now. Try again.',
  transport_failed: 'ECHO cannot be reached. Check your connection and try again.',
  timeout: 'That took too long. Try again.',
  rate_limited: 'Too many requests. Try again in a moment.',
  not_found: 'This is no longer available to you.',
  unauthorized: 'Your access changed. Sign in again.',
  // The Authority also says this when what you acted on changed meanwhile, with the session still valid.
  stale_access_state: 'That changed meanwhile, or your access did. Refresh and try again.',
  sign_in_required: 'Sign in again to continue.',
  // The weekly sign-in passed: the session cannot be refreshed any more.
  reauthentication_required: 'Sign in again: ECHO asks you to sign in once a week.',
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
  invalid_email: 'Enter the employee’s name and email address.',
  invalid_name: 'Enter the employee’s name and email address.',
  invitation_output_invalid: 'The invitation could not be saved there. Choose another place and try again.',
  employee_already_exists: 'Already a member. Refresh to check whether to reissue or sign in.',
  employee_onboarding_complete: 'This employee has already onboarded. Ask them to sign in.',
  request_rejected: 'That was refused. Refresh and try again.',
  owner_access_required: 'Only an organization owner can manage people.',
  invitation_save_failed: 'The invitation was made, but its file could not be saved. Refresh, then reissue it into another folder.',
  outcome_unknown: 'That was not sent. Check your connection and try again.',
  // The Ask question rule (the Authority's validatePersonQuestionText).
  question_empty: 'Type a question first.',
  question_normalization: 'That question has characters ECHO cannot read. Retype it and ask again.',
  question_whitespace: 'Remove the spaces or line breaks at the start or end of the question.',
  question_controls: 'That question has hidden control characters. Retype it and ask again.',
  question_too_long: 'That question is over 4,000 characters. Shorten it and ask again.',
  // The keyword search rule (record search).
  query_empty: 'Type something to search for.',
  query_normalization: 'That search has characters ECHO cannot read. Retype it and try again.',
  query_whitespace: 'Remove the spaces at the start or end of the search.',
  query_controls: 'Keep the search to one line, without hidden characters.',
  query_too_long: 'Searches are up to 240 characters. Shorten it and try again.',
  query_term_count: 'Search for at least one word or number.',
  query_term_too_long: 'One word in that search is too long. Shorten it and try again.',
  invalid_limit: 'That asked for too many results at once. Try again with fewer.',
  // ECHO answered with something it could not use, or more than it can show.
  invalid_output: 'ECHO could not put that answer together. Try again.',
  invalid_response: 'ECHO sent back something this app could not read. Try again, or update the app.',
  response_too_large: 'That answer was too large to show. Ask about a narrower part.',
  request_failed: 'That did not go through. Try again.',
  internal: 'ECHO hit a problem on its side. Try again.',
  failed: 'That did not finish. Try again.',
  busy: 'ECHO is busy with another request. Try again in a moment.',
  quota_exceeded: 'Your organization reached its limit for this. Try again later, or ask your organization owner.',
  timed_out: 'That took too long. Try again.',
  research_failed: 'ECHO could not finish looking into that. Try again.',
  no_access: 'You do not have access to that.',
  forbidden: 'You do not have access to that.',
  identity_not_bound: 'Your account is not linked to a person in your organization yet. Ask your organization owner.',
  invalid_file: 'That file could not be read. Choose a TXT, Markdown, PDF or Word file up to 25 MB.',
  document_extraction_failed: 'ECHO could not read the text in that file. Try another copy, or paste the text as a note.',
  document_completion_failed: 'That file was not finished saving. Try again.',
  source_admission_failed: 'ECHO could not add that source. Try again.',
  invalid_retained_text: 'That file changed since you chose it. Choose it again.',
  update_changed: 'That changed meanwhile. Refresh and try again.',
};

export function message(failure: Failure): string {
  if (failure.mutation_outcome === 'unknown') return 'This may not have been sent.';
  return Object.hasOwn(MESSAGES, failure.code) ? MESSAGES[failure.code]! : 'Something went wrong. Try again.';
}

/** A meetings request's failure, worded as any other: a watch's window has no meeting count of its own. */
export function meetingMessage(failure: Failure): string {
  return message(failure);
}

/** Where you stand with a tool, in the renderer's words: on its row in Tools. */
export const TOOL_STATES: Readonly<Record<ToolStatus, string>> = {
  linked: 'Connected',
  unlinked: 'Not connected',
  revoked: 'Connection stopped. Reconnect to keep using it.',
  unavailable: 'Not turned on for your organization.',
};

/**
 * A tool step that did not finish, in the renderer's words. Every tool reports
 * from the same small set of reasons, so a new tool needs no new copy.
 */
const TOOL_REASONS: Record<string, (name: string) => string> = {
  provider_rejected: name => `${name} did not confirm the connection. Try again.`,
  provider_unavailable: name => `${name} is unavailable right now. Try again.`,
  identity_conflict: name => `This ${name} account is already connected to another ECHO person.`,
  account_mismatch: name => `That ${name} account does not match the one you connected before. Sign in with that account and try again.`,
  tool_unavailable: name => `${name} is not turned on for your organization.`,
  browser_unavailable: name => `The ${name} page could not be opened.`,
  expired: () => 'That took too long. Try again.',
  timed_out: () => 'That took too long. Try again.',
};

export function toolMessage(name: string, reason: string | undefined, failure: Failure | undefined): string {
  const code = reason ?? failure?.code;
  const words = code !== undefined && Object.hasOwn(TOOL_REASONS, code) ? TOOL_REASONS[code] : undefined;
  if (words) return words(name);
  return failure ? message(failure) : `${name} could not be connected. Try again.`;
}
