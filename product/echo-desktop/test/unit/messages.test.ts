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
    expect(message({ code: 'quota_exceeded', retryable: false })).toBe('Something went wrong. Try again.');
  });
});
