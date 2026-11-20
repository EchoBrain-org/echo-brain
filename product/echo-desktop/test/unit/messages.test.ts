import { describe, expect, it } from 'vitest';
import { meetingMessage, message, toolMessage } from '../../src/renderer/messages.js';

describe('the renderer\'s words for a failure', () => {
  it('are its own even for a code that names an object property', () => {
    expect(message({ code: 'constructor', retryable: false })).toBe('Something went wrong. Try again.');
    expect(message({ code: 'toString', retryable: false })).toBe('Something went wrong. Try again.');
    expect(toolMessage('Jira', 'constructor', undefined)).toBe('Jira could not be connected. Try again.');
  });
  it('name a meetings watch over its cap, and leave every other meetings failure in the common words', () => {
    expect(meetingMessage({ code: 'quota_exceeded', retryable: false, mutation_outcome: 'not_submitted' })).toBe('More than 200 meetings in 7 days. Choose one folder.');
    expect(meetingMessage({ code: 'quota_exceeded', retryable: false, mutation_outcome: 'unknown' })).toBe('This may not have been sent.');
    expect(meetingMessage({ code: 'unavailable', retryable: true })).toBe(message({ code: 'unavailable', retryable: true }));
    expect(message({ code: 'quota_exceeded', retryable: false })).toBe('Your organization reached its limit for this. Try again later, or ask your organization owner.');
  });
  it('word every code a request can fail with, so only a truly unknown code reads as the generic line', () => {
    for (const code of [
      'question_empty', 'question_normalization', 'question_whitespace', 'question_controls', 'question_too_long',
      'query_empty', 'query_normalization', 'query_whitespace', 'query_controls', 'query_too_long', 'query_term_count', 'query_term_too_long',
      'invalid_limit', 'invalid_output', 'invalid_response', 'response_too_large', 'request_failed', 'internal', 'failed', 'busy', 'quota_exceeded',
      'timed_out', 'research_failed', 'no_access', 'forbidden', 'identity_not_bound', 'invalid_file', 'document_extraction_failed',
      'document_completion_failed', 'source_admission_failed', 'invalid_retained_text', 'update_changed',
    ]) expect(message({ code, retryable: false }), code).not.toBe('Something went wrong. Try again.');
    expect(message({ code: 'question_too_long', retryable: false })).toBe('That question is over 4,000 characters. Shorten it and ask again.');
    expect(message({ code: 'never_heard_of', retryable: false })).toBe('Something went wrong. Try again.');
  });
});
