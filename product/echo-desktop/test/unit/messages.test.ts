import { describe, expect, it } from 'vitest';
import { message, toolMessage } from '../../src/renderer/messages.js';

describe('the renderer\'s words for a failure', () => {
  it('are its own even for a code that names an object property', () => {
    expect(message({ code: 'constructor', retryable: false })).toBe('Something went wrong. Try again.');
    expect(message({ code: 'toString', retryable: false })).toBe('Something went wrong. Try again.');
    expect(toolMessage('Jira', 'constructor', undefined)).toBe('Jira could not be connected. Try again.');
  });
});
