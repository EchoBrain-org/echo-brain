import { describe, expect, it } from 'vitest';
import { message, toolMessage } from '../../src/renderer/messages.js';

describe('the renderer\'s words for a failure', () => {
  it('are its own even for a code that names an object property', () => {
    expect(message({ code: 'constructor', retryable: false })).toBe('Something went wrong. Try again.');
    expect(message({ code: 'toString', retryable: false })).toBe('Something went wrong. Try again.');
    expect(toolMessage('Jira', 'constructor', undefined)).toBe('Jira could not be connected. Try again.');
  });
  it('word every code a request can fail with, so only a truly unknown code reads as the generic line', () => {
    for (const code of [
      'question_empty', 'question_normalization', 'question_whitespace', 'question_controls', 'request_too_large',
      'query_empty', 'query_normalization', 'query_whitespace', 'query_controls', 'query_term_count', 'query_term_too_long',
      'invalid_limit', 'invalid_output', 'invalid_response', 'response_too_large', 'request_failed', 'internal', 'failed', 'busy', 'quota_exceeded',
      'timed_out', 'stalled', 'research_failed', 'no_access', 'forbidden', 'identity_not_bound', 'invalid_file', 'document_extraction_failed',
      'document_completion_failed', 'source_admission_failed', 'invalid_retained_text', 'update_changed',
    ]) expect(message({ code, retryable: false }), code).not.toBe('Something went wrong. Try again.');
    expect(message({ code: 'request_too_large', retryable: false })).toBe('That is more than ECHO can send in one request. Shorten it and try again.');
    expect(message({ code: 'never_heard_of', retryable: false })).toBe('Something went wrong. Try again.');
  });
});
